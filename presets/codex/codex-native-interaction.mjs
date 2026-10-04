/**
 * Official Codex app-server interaction boundary; no DSH/global policy writes.
 * Profile sandbox/approvalPolicy are official thread-start fields, plus a UI name.
 * Experimental request fields follow Rust v2/item.rs, not the filtered TS schema.
 * The bridge owns JSON-RPC envelopes, turn lifetime, and attachment resolution.
 */
const freeze = value => {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

export const CODEX_NATIVE_PROFILES = freeze({
  'codex-read-only': { sandbox: 'read-only', approvalPolicy: 'on-request', name: 'Codex Read Only' },
  'codex-on-request': { sandbox: 'workspace-write', approvalPolicy: 'on-request', name: 'Codex On Request' },
  'codex-full-access': { sandbox: 'danger-full-access', approvalPolicy: 'never', name: 'Codex Full Access' },
})

function failure(code, message, rpcCode = -32602) {
  return Object.assign(new Error(message), { code, rpcCode })
}

function unsupported(method, explanation = '') {
  return failure('method-not-supported', `Codex request ${method} is unsupported${explanation ? `: ${explanation}` : ''}. No action was approved.`, -32601)
}

function service(ctx, name) {
  return typeof ctx?.get === 'function' ? ctx.get(name) : ctx?.[name]
}

function eventsOf(session) {
  return typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : (session?.events ?? [])
}

function lastValue(events, type, key) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i]?.type === type) return events[i].data?.[key]
  }
}

/**
 * An explicit native profile is a caller-authorized selection. Without one,
 * preserve the host's standing read-only policy; full access is selected only
 * for standing danger-full-access AND never. Never consult transient grants.
 * This reads policy only: no setPolicy(), setSandboxMode(), or config writes.
 */
export function nativePolicyFor(ctx, agent, profileName) {
  if (profileName !== undefined) {
    requireValue(typeof profileName === 'string', 'Native Codex profile must be a string')
    if (!Object.hasOwn(CODEX_NATIVE_PROFILES, profileName)) throw failure('invalid-params', `Unknown native Codex profile: ${profileName}`)
    return CODEX_NATIVE_PROFILES[profileName]
  }
  const events = eventsOf(agent?.session)
  const sandbox = service(ctx, 'sandboxPolicy')
  const approval = service(ctx, 'approval')
  const mode = lastValue(events, 'sandbox/mode', 'mode')
    ?? sandbox?.resolve?.({ session: agent?.session })?.mode
    ?? sandbox?.defaultMode
    ?? 'read-only'
  const policy = lastValue(events, 'approval/policy', 'policy')
    ?? approval?.overrideOf?.(agent?.session)
    ?? approval?.config?.policy
    ?? 'ask'
  requireValue(['read-only', 'workspace-write', 'danger-full-access'].includes(mode), 'Invalid standing sandbox mode')
  requireValue(['ask', 'never'].includes(policy), 'Invalid standing approval policy')
  const name = mode === 'read-only' ? 'codex-read-only'
    : mode === 'danger-full-access' && policy === 'never' ? 'codex-full-access'
      : 'codex-on-request'
  const profile = CODEX_NATIVE_PROFILES[name]
  return policy === 'never' && profile.approvalPolicy !== 'never'
    ? freeze({ ...profile, approvalPolicy: 'never' }) : profile
}

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const nonempty = value => typeof value === 'string' && value.trim() !== ''

function requireValue(condition, message) {
  if (!condition) throw failure('invalid-params', message)
}

function keysOnly(value, keys) {
  requireValue(record(value) && Object.keys(value).every(key => keys.includes(key)), 'Unsupported permission/schema fields')
}

function aborted() {
  return failure('request-aborted', 'Codex interaction was aborted; no answer or permission was granted.', -32000)
}

/** Race even an answerer that ignores the signal; discard its late result. */
async function cancellable(signal, work) {
  if (signal?.aborted) throw aborted()
  if (!signal) return await work()
  let onAbort
  const cancel = new Promise((_, reject) => {
    onAbort = () => reject(aborted())
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    const result = await Promise.race([Promise.resolve().then(() => {
      if (signal.aborted) throw aborted()
      return work()
    }), cancel])
    if (signal.aborted) throw aborted()
    return result
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

function nativeMayAsk(options, flag) {
  if (options.nativePolicy === undefined) return undefined
  const policy = options.nativePolicy?.approvalPolicy
  if (record(policy)) {
    keysOnly(policy, ['granular'])
    const granular = policy.granular
    keysOnly(granular, ['sandbox_approval', 'rules', 'skill_approval', 'request_permissions', 'mcp_elicitations'])
    requireValue(['sandbox_approval', 'rules', 'mcp_elicitations'].every(key => typeof granular[key] === 'boolean')
      && ['skill_approval', 'request_permissions'].every(key => granular[key] === undefined || typeof granular[key] === 'boolean'), 'Invalid native granular approval policy')
    return granular[flag] === true
  }
  requireValue(['on-request', 'untrusted', 'never'].includes(policy), 'Invalid native approval policy')
  return policy !== 'never'
}

function approvalFor(options, method) {
  const host = service(options.ctx, 'approval')
  const flag = method === 'item/permissions/requestApproval' ? 'request_permissions' : 'sandbox_approval'
  const ask = nativeMayAsk(options, flag)
  if (!host || ask === undefined) return host
  // The real DSH service calls this.effectivePolicy(). Shadow it only on a
  // borrowed facade; neither the shared service nor session policy is written.
  return Object.create(host, { effectivePolicy: { value: () => ask ? 'ask' : 'never' } })
}

async function allowOnce(options, toolName, reason) {
  const { agent, signal, callId } = options
  try {
    const approval = approvalFor(options, toolName)
    if (typeof approval?.request !== 'function') return false
    // DSH owns the abort race AND the matching audit append; await both before
    // returning so the bridge cannot close the host turn before its audit.
    const outcome = await approval.request({
      agent, toolName, reason, signal, ...(callId === undefined ? {} : { callId }),
    })
    return !signal?.aborted && outcome === 'allowed-once'
  } catch {
    // Unavailable service, aborted question, audit failure: all fail closed.
    return false
  }
}

function decisionOutcome(decision) {
  if (decision === 'cancel') return 'cancelled'
  if (decision === 'decline' || decision?.applyNetworkPolicyAmendment?.network_policy_amendment?.action === 'deny') return 'rejected'
  return 'allowed-once'
}

function validDecision(decision, command) {
  if (typeof decision === 'string') return ['accept', 'acceptForSession', 'decline', 'cancel'].includes(decision)
  if (!command || !record(decision) || Object.keys(decision).length !== 1) return false
  const exec = decision.acceptWithExecpolicyAmendment
  if (record(exec) && Object.keys(exec).length === 1) {
    // ExecPolicyAmendment is serde(transparent): the wire value is argv, NOT
    // { command: argv }. Keep the enum's nested field in snake_case.
    const amendment = exec.execpolicy_amendment
    return Array.isArray(amendment) && amendment.length > 0 && nonempty(amendment[0])
      && amendment.every(value => typeof value === 'string' && !value.includes('\0'))
  }
  const network = decision.applyNetworkPolicyAmendment
  if (record(network) && Object.keys(network).length === 1 && record(network.network_policy_amendment)) {
    const amendment = network.network_policy_amendment
    return Object.keys(amendment).length === 2 && nonempty(amendment.host)
      && !/[\s\u0000-\u001f\u007f]/u.test(amendment.host) && ['allow', 'deny'].includes(amendment.action)
  }
  return false
}

function humanFields(value, indentation = '') {
  if (Array.isArray(value)) return value.map(item => `${indentation}- ${typeof item === 'object' && item !== null ? '\n' + humanFields(item, indentation + '  ') : String(item)}`).join('\n')
  if (value !== null && typeof value === 'object') return Object.entries(value).map(([key, item]) => {
    const label = key.replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll('_', ' ')
    return item !== null && typeof item === 'object' ? `${indentation}${label}:\n${humanFields(item, indentation + '  ')}`
      : `${indentation}${label}: ${String(item)}`
  }).join('\n')
  return indentation + String(value)
}

function decisionDescription(decision) {
  if (decision === 'accept') return 'Approve only this native action.'
  if (decision === 'acceptForSession') return 'Authorize the upstream-defined scope for this native Codex session only.'
  if (decision === 'decline') return 'Do not authorize the requested action.'
  if (decision === 'cancel') return 'Reject the action and interrupt the native turn.'
  const command = decision.acceptWithExecpolicyAmendment?.execpolicy_amendment
  // Preserve argv boundaries without dumping a raw wire object. A plain join
  // hides empty arguments/spaces and can misrepresent a persistent rule.
  if (command) return `Native command prefix: ${command.map(arg => /^[a-zA-Z0-9_./:@=+-]+$/.test(arg) ? arg : JSON.stringify(arg)).join(' ')}`
  const network = decision.applyNetworkPolicyAmendment?.network_policy_amendment
  return network ? `Native network rule: ${network.action} ${network.host}` : humanFields(decision)
}

function decisionLabel(decision) {
  if (decision === 'accept') return 'Allow once'
  if (decision === 'acceptForSession') return 'Allow for this native Codex session'
  if (decision === 'decline') return 'Decline this action'
  if (decision === 'cancel') return 'Decline and interrupt the native turn'
  if (decision.acceptWithExecpolicyAmendment) return 'Allow and save this native command-prefix rule'
  return decision.applyNetworkPolicyAmendment.network_policy_amendment.action === 'allow'
    ? 'Save this native network allow rule' : 'Save this native network deny rule'
}

/**
 * Experimental availableDecisions are an authoritative list, not permission
 * to autoaccept. A temporary identity-filtered answerer supplies only this ask.
 * DSH retains the audit/abort boundary; only the official core applies the
 * explicitly selected native session grant/amendment. No host policy writes.
 */
async function nativeDecision(options, reason) {
  const { ctx, agent, params = {}, method, callId, signal } = options
  const command = method === 'item/commandExecution/requestApproval'
  const available = params.availableDecisions
  if (command && params.kind !== undefined && !['command', 'writeStdin'].includes(params.kind)) return 'decline'
  // FileChangeRequestApprovalParams has no decision-list extension.
  if (!command && available !== undefined) return 'decline'
  // Older command servers have no availableDecisions. Retain the conservative
  // one-action DSH approval UI rather than inventing persistent amendments.
  if (command && available == null) return await allowOnce(options, method, reason) ? 'accept' : 'decline'
  // File approvals have no availableDecisions field in Rust; their complete
  // official enum is safe to present, but only a real user choice may select it.
  const decisions = available ?? ['accept', 'acceptForSession', 'decline', 'cancel']
  if (!Array.isArray(decisions) || !decisions.length || !decisions.every(decision => validDecision(decision, command))) return 'decline'
  let dispose
  let active = true
  let claimed = false
  try {
    const approval = approvalFor(options, method)
    if (typeof approval?.request !== 'function') return 'decline'
    const questionsService = service(ctx, 'userQuestions')
    if (typeof ctx?.on !== 'function' || typeof questionsService?.ask !== 'function') {
      // Keep the real audit pair without letting a generic host "yes" become
      // a persistent native choice. This deny-only facade is request-local.
      const deniedApproval = Object.create(approval, { effectivePolicy: { value: () => 'never' } })
      await deniedApproval.request({
        agent, toolName: method, reason: `${reason}\nNative decision UI is unavailable; this request is denied.`, signal,
        ...(callId === undefined ? {} : { callId }),
      })
      return 'decline'
    }
    const snapshot = structuredClone(decisions)
    const labels = snapshot.map((decision, index) => `${index + 1}. ${decisionLabel(decision)}`)
    const question = {
      id: `native-approval:${params.approvalId ?? params.itemId ?? callId ?? 'decision'}`,
      header: 'Codex approval', question: reason, multiSelect: false,
      options: snapshot.map((decision, index) => ({ label: labels[index], description: decisionDescription(decision) })),
    }
    const req = { agent, toolName: method, reason, signal, ...(callId === undefined ? {} : { callId }) }
    let selected
    dispose = ctx.on('approval/request', async (incoming, next) => {
      if (incoming !== req) return next()
      if (!active || claimed || signal?.aborted) return 'rejected'
      claimed = true
      const response = await askQuestions(options, [question])
      const mapped = answerMap([question], response, () => false)[question.id].answers
      if (!active || mapped.length !== 1 || signal?.aborted) return 'rejected'
      selected = snapshot[labels.indexOf(mapped[0])]
      return decisionOutcome(selected)
    }, { prepend: true })
    requireValue(typeof dispose === 'function', 'Approval listener must provide a disposer')
    const outcome = await approval.request(req)
    if (signal?.aborted || selected === undefined || outcome !== decisionOutcome(selected)) return 'decline'
    return selected
  } catch {
    return 'decline'
  } finally {
    // Even a broken event host must not leave a live authorization callback.
    active = false
    if (typeof dispose === 'function') {
      try { dispose() } catch { return 'decline' }
    }
  }
}

function commandReason(params) {
  return [
    params.kind === 'writeStdin' ? 'Codex requests one-time input to a running terminal.' : 'Codex requests one-time command execution.',
    `Item: ${params.itemId ?? '(unknown)'}`,
    nonempty(params.reason) && `Reason: ${params.reason}`,
    nonempty(params.command) && `Command/input: ${params.command}`,
    nonempty(params.cwd) && `Working directory: ${params.cwd}`,
    params.networkApprovalContext && `Network: ${params.networkApprovalContext.protocol}://${params.networkApprovalContext.host}`,
    params.additionalPermissions && `Additional command permissions:\n${humanFields(permissionGrant(params.additionalPermissions))}`,
    'Native session grants or policy amendments require an explicit matching choice below; they never change DSH host permissions.',
  ].filter(Boolean).join('\n')
}

function fileReason(params) {
  return [
    'Codex requests approval of this one file-change item.',
    `Item: ${params.itemId ?? '(unknown)'}`,
    nonempty(params.reason) && `Reason: ${params.reason}`,
    nonempty(params.grantRoot) && `Requested native write root: ${params.grantRoot}`,
    'A native session grant requires an explicit session choice; DSH host permissions remain unchanged.',
  ].filter(Boolean).join('\n')
}

function pathList(value) {
  requireValue(value === null || (Array.isArray(value) && value.every(nonempty)), 'Permission paths must be strings or null')
  return value === null ? null : [...value]
}

function filesystemPath(value) {
  requireValue(record(value), 'Invalid filesystem permission path')
  if (value.type === 'path') {
    keysOnly(value, ['type', 'path'])
    requireValue(nonempty(value.path), 'Empty filesystem path')
    return { type: 'path', path: value.path }
  }
  if (value.type === 'glob_pattern') {
    keysOnly(value, ['type', 'pattern'])
    requireValue(nonempty(value.pattern), 'Empty filesystem glob')
    return { type: 'glob_pattern', pattern: value.pattern }
  }
  requireValue(value.type === 'special' && record(value.value), 'Invalid filesystem permission path type')
  const special = value.value
  if (['root', 'minimal', 'tmpdir', 'slash_tmp'].includes(special.kind)) {
    keysOnly(special, ['kind'])
  } else if (special.kind === 'project_roots' || special.kind === 'unknown') {
    keysOnly(special, special.kind === 'unknown' ? ['kind', 'path', 'subpath'] : ['kind', 'subpath'])
    requireValue(special.subpath === null || nonempty(special.subpath), 'Invalid special subpath')
    if (special.kind === 'unknown') requireValue(nonempty(special.path), 'Invalid special path')
  } else {
    throw failure('invalid-params', 'Unsupported filesystem special path')
  }
  keysOnly(value, ['type', 'value'])
  return { type: 'special', value: { ...special } }
}

/** Validate and detach RequestPermissionProfile -> GrantedPermissionProfile. */
function permissionGrant(request) {
  keysOnly(request, ['network', 'fileSystem'])
  requireValue(Object.hasOwn(request, 'network') && Object.hasOwn(request, 'fileSystem'), 'Expected official RequestPermissionProfile')
  const grant = {}
  if (request.network !== null) {
    keysOnly(request.network, ['enabled'])
    requireValue(request.network.enabled === null || typeof request.network.enabled === 'boolean', 'Invalid network permissions')
    grant.network = { enabled: request.network.enabled }
  }
  if (request.fileSystem !== null) {
    const fs = request.fileSystem
    keysOnly(fs, ['read', 'write', 'globScanMaxDepth', 'entries'])
    grant.fileSystem = { read: pathList(fs.read), write: pathList(fs.write) }
    if (fs.globScanMaxDepth !== undefined) {
      requireValue(Number.isSafeInteger(fs.globScanMaxDepth) && fs.globScanMaxDepth > 0, 'Invalid glob scan depth')
      grant.fileSystem.globScanMaxDepth = fs.globScanMaxDepth
    }
    if (fs.entries !== undefined) {
      requireValue(Array.isArray(fs.entries), 'Invalid filesystem entries')
      grant.fileSystem.entries = fs.entries.map(entry => {
        keysOnly(entry, ['path', 'access'])
        requireValue(['read', 'write', 'deny'].includes(entry.access), 'Invalid filesystem access mode')
        return { path: filesystemPath(entry.path), access: entry.access }
      })
    }
  }
  return grant
}

function nativeQuestions(params, method) {
  requireValue(Array.isArray(params.questions) && params.questions.length > 0, 'Codex user input requires questions')
  const ids = new Set()
  return params.questions.map(question => {
    requireValue(record(question) && nonempty(question.id) && !ids.has(question.id), 'Question IDs must be nonempty and unique')
    ids.add(question.id)
    requireValue(typeof question.header === 'string' && nonempty(question.question), 'Invalid question text/header')
    keysOnly(question, ['id', 'header', 'question', 'isOther', 'isSecret', 'options'])
    requireValue((question.isOther === undefined || typeof question.isOther === 'boolean')
      && (question.isSecret === undefined || typeof question.isSecret === 'boolean'), 'Invalid question flags')
    if (question.isSecret) throw unsupported(method, 'DSH has no secret-input UI; do not enter secrets into a normal question')
    requireValue(question.options === null || Array.isArray(question.options), 'Invalid question options')
    const options = question.options?.map(option => {
      keysOnly(option, ['label', 'description'])
      requireValue(nonempty(option.label) && typeof option.description === 'string', 'Invalid option label/description')
      return { label: option.label, description: option.description }
    })
    requireValue(!options || new Set(options.map(option => option.label)).size === options.length, 'Option labels must be unique')
    return {
      id: question.id, header: question.header, question: question.question,
      ...(options ? { options } : {}), multiSelect: false,
      // isOther is enforced when mapping the returned free text. It is not a
      // DSH UI field; do not invent one or append a fake "Other" option.
    }
  })
}

async function askQuestions(options, questions) {
  const questionsService = service(options.ctx, 'userQuestions')
  if (typeof questionsService?.ask !== 'function') throw failure('user-questions-unavailable', 'Codex needs user input, but the DSH userQuestions service is unavailable.', -32000)
  return await cancellable(options.signal, () => questionsService.ask({
    // The UI receives a detached copy; it cannot rewrite the private offered
    // labels/schema subsequently used to validate its answer.
    agent: options.agent, questions: structuredClone(questions), signal: options.signal,
    ...(options.callId === undefined ? {} : { wait: { callId: options.callId } }),
  }))
}

function answerMap(questions, response, allowCustom) {
  requireValue(record(response) && Array.isArray(response.answers), 'Invalid DSH question answer')
  const byId = new Map(questions.map(question => [question.id, question]))
  const answers = new Map()
  for (const answer of response.answers) {
    const question = byId.get(answer?.id)
    requireValue(question && !answers.has(answer.id), 'Unexpected or duplicate question answer ID')
    requireValue(Array.isArray(answer.selected) && answer.selected.every(value => typeof value === 'string'), 'Invalid selected answers')
    requireValue(answer.selected.every(value => question.options?.some(option => option.label === value)), 'Selected answer is not an offered option')
    requireValue(answer.selected.length <= 1, 'Codex questions are single-select')
    requireValue(answer.custom === undefined || typeof answer.custom === 'string', 'Invalid free-text answer')
    const custom = answer.custom === undefined || answer.custom === '' ? [] : [answer.custom]
    requireValue(answer.selected.length + custom.length <= 1, 'Codex questions cannot mix a selection and free text')
    requireValue(custom.length === 0 || allowCustom(question.id), 'Free-text answers are not supported for this question')
    answers.set(answer.id, { answers: [...answer.selected, ...custom] })
  }
  // fromEntries safely preserves even IDs like "__proto__" as own properties.
  return Object.fromEntries(questions.map(question => [question.id, answers.get(question.id) ?? { answers: [] }]))
}

/** Only typed form-mode finite single-select enums can be losslessly mapped. */
function elicitationQuestions(params, method) {
  const fail = () => { throw unsupported(method, 'DSH supports only form-mode required single-select enum fields; URL, openai forms, and other schemas need a dedicated elicitation UI') }
  if (params.mode !== 'form') fail()
  if (!nonempty(params.message) || !nonempty(params.serverName)) fail()
  const schema = params.requestedSchema
  if (!record(schema) || schema.type !== 'object' || !record(schema.properties)) fail()
  if (Object.keys(schema).some(key => !['$schema', 'type', 'properties', 'required'].includes(key))
    || (schema.$schema !== undefined && typeof schema.$schema !== 'string')) fail()
  const fields = Object.entries(schema.properties)
  if (!fields.length || !Array.isArray(schema.required) || schema.required.length !== fields.length
    || new Set(schema.required).size !== fields.length || !fields.every(([id]) => schema.required.includes(id))) fail()
  const choices = new Map()
  const questions = fields.map(([id, field]) => {
    if (!nonempty(id) || !record(field) || field.type !== 'string') fail()
    if (Object.keys(field).some(key => !['type', 'title', 'description', 'enum', 'enumNames', 'oneOf', 'default'].includes(key))) fail()
    if ((field.title !== undefined && typeof field.title !== 'string') || (field.description !== undefined && typeof field.description !== 'string')) fail()
    let values
    if (Array.isArray(field.enum) && field.oneOf === undefined && field.enum.every(nonempty)) {
      if (field.enumNames !== undefined && (!Array.isArray(field.enumNames) || field.enumNames.length !== field.enum.length
        || !field.enumNames.every(nonempty))) fail()
      values = field.enum.map((value, index) => ({ label: field.enumNames?.[index] ?? value, value }))
    } else if (Array.isArray(field.oneOf) && field.enum === undefined && field.enumNames === undefined && field.oneOf.every(option =>
      record(option) && Object.keys(option).every(key => ['const', 'title'].includes(key)) && nonempty(option.const) && nonempty(option.title))) {
      values = field.oneOf.map(option => ({ label: option.title, value: option.const }))
    } else fail()
    if (!values.length || new Set(values.map(option => option.label)).size !== values.length
      || new Set(values.map(option => option.value)).size !== values.length) fail()
    if (field.default !== undefined && !values.some(option => option.value === field.default)) fail()
    choices.set(id, new Map(values.map(option => [option.label, option.value])))
    return {
      id, header: field.title ?? id, question: params.message,
      detail: [`MCP server: ${params.serverName}`, field.description].filter(Boolean).join('\n'),
      options: values.map(option => ({ label: option.label })), multiSelect: false,
    }
  })
  return { questions, choices }
}

/** Returns the official response RESULT; the bridge supplies id/jsonrpc. */
export async function handleNativeRequest(options) {
  const { method, params = {}, signal, refreshAuth } = options
  switch (method) {
    case 'item/commandExecution/requestApproval': {
      // Never render arbitrary additionalPermissions objects (or unknown
      // fields containing credentials) into the human approval/audit prompt.
      let reason
      try { reason = commandReason(params) } catch { return { decision: 'decline' } }
      return { decision: await nativeDecision(options, reason) }
    }
    case 'item/fileChange/requestApproval':
      return { decision: await nativeDecision(options, fileReason(params)) }
    case 'item/permissions/requestApproval': {
      const denied = { permissions: {}, scope: 'turn' }
      let permissions
      try { permissions = permissionGrant(params.permissions) } catch { return denied }
      const reason = [
        'Codex requests exactly these additional permissions for this turn only (not the session).',
        nonempty(params.reason) && `Reason: ${params.reason}`,
        nonempty(params.cwd) && `Working directory: ${params.cwd}`,
        humanFields(permissions),
        'No host permission profile, command-prefix rule, or writable root will be changed.',
      ].filter(Boolean).join('\n')
      return await allowOnce(options, method, reason) ? { permissions, scope: 'turn' } : denied
    }
    case 'item/tool/requestUserInput': {
      const questions = nativeQuestions(params, method)
      const customIds = new Set(params.questions.filter(question => question.isOther || !question.options?.length).map(question => question.id))
      const response = await askQuestions(options, questions)
      return { answers: answerMap(questions, response, id => customIds.has(id)) }
    }
    case 'mcpServer/elicitation/request': {
      if (nativeMayAsk(options, 'mcp_elicitations') === false) return { action: 'decline', content: null, _meta: null }
      const { questions, choices } = elicitationQuestions(params, method)
      let mapped
      try {
        mapped = answerMap(questions, await askQuestions(options, questions), () => false)
      } catch (error) {
        if (signal?.aborted || error?.code === 'ASK_ABORTED' || error?.code === 'ASK_CANCELLED') {
          return { action: 'cancel', content: null, _meta: null }
        }
        throw error
      }
      if (Object.values(mapped).some(answer => answer.answers.length !== 1)) return { action: 'decline', content: null, _meta: null }
      return {
        action: 'accept',
        content: Object.fromEntries(questions.map(question => [question.id, choices.get(question.id).get(mapped[question.id].answers[0])])),
        _meta: null,
      }
    }
    case 'account/chatgptAuthTokens/refresh': {
      if (typeof refreshAuth !== 'function') throw unsupported(method, 'no host-managed auth refresh callback is available')
      const response = await cancellable(signal, () => refreshAuth(params, { signal }))
      requireValue(record(response) && nonempty(response.accessToken) && nonempty(response.chatgptAccountId)
        && (response.chatgptPlanType === null || typeof response.chatgptPlanType === 'string'), 'Invalid host auth-refresh response')
      return { accessToken: response.accessToken, chatgptAccountId: response.chatgptAccountId, chatgptPlanType: response.chatgptPlanType }
    }
    case 'execCommandApproval':
    case 'applyPatchApproval':
      return { decision: { denied: { rejection: 'Legacy Codex approvals are unsupported by this bridge; no action was approved.' } } }
    default:
      throw unsupported(method)
  }
}

/**
 * Handle item/completed agentMessage.questions (Rust AsyncUserInputQuestion).
 * Returns official UserInput[] for parent-owned turn/steer, NOT a JSON-RPC
 * server-request response. Parent deduplicates item IDs and supplies an active
 * question-lifetime signal (aborted on turn end/reset/dispose); this function
 * never sends or queues a turn. Parent checks the originating thread/turn again
 * immediately before turn/steer, including its expectedTurnId.
 * Reply identity/envelope matches the official desktop/TUI implementation.
 */
export async function handleNativeAsyncQuestions(options) {
  const item = options.params?.item
  if (item?.type !== 'agentMessage' || item.questions == null) return []
  requireValue(Array.isArray(item.questions), 'Invalid native async question list')
  if (!item.questions.length) return []
  requireValue(options.signal && typeof options.signal.addEventListener === 'function'
    && typeof options.signal.removeEventListener === 'function' && typeof options.signal.aborted === 'boolean', 'Native async questions require a cancellable lifetime')
  requireValue(item.delivery === 'async' && nonempty(item.id) && Array.isArray(item.questions), 'Invalid native async question item')
  const questions = item.questions.map((question, index) => {
    keysOnly(question, ['title', 'options'])
    requireValue(nonempty(question.title), 'Invalid async question title')
    requireValue(question.options === null || (Array.isArray(question.options) && question.options.every(nonempty)), 'Invalid async question options')
    const options = question.options?.map(label => ({ label }))
    requireValue(!options || new Set(options.map(option => option.label)).size === options.length, 'Async option labels must be unique')
    return {
      id: JSON.stringify(['request_user_input_async', item.id, index]),
      question: question.title, multiSelect: false, ...(options ? { options } : {}),
    }
  })
  const mapped = answerMap(questions, await askQuestions(options, questions), () => true)
  const boundedTitle = title => {
    let bytes = 0
    let result = ''
    for (const char of title) {
      bytes += Buffer.byteLength(char)
      if (bytes > 512) break
      result += char
    }
    return result.replace(/[\r\n]/g, ' ')
  }
  const replies = questions.flatMap(question => {
    const answer = mapped[question.id].answers.join('\n')
    if (!answer.trim()) return []
    requireValue(Buffer.byteLength(question.id) <= 512, 'Native async question identity exceeds the official reply-envelope budget')
    return [{ questionItemId: question.id, question: boundedTitle(question.question), answer }]
  })
  if (!replies.length) return []
  return [{
    type: 'text', text: `<send_user_message_question_reply>\n${JSON.stringify(replies)}\n</send_user_message_question_reply>`, text_elements: [],
  }]
}

/**
 * Convert ONLY a direct DSH user message (caller must also filter its stream).
 * No injected context/system-reminder, source reattribution, IO, or credential
 * access. The bridge must resolve opaque DSH attachment refs into explicit
 * image {path|url|fileId} / file {path} blocks first; IDs are NOT paths or Codex
 * file IDs. Generic local files are literal text handles: official UserInput
 * has no localFile variant (mention is for structured app/plugin mentions).
 */
export function nativeUserInput(message) {
  requireValue(message?.role === 'user' && message.source?.kind === 'user', 'Only direct user messages may become native Codex input')
  // source.kind establishes direct-user provenance. Web/TUI may also attach
  // transport-only metadata such as rpcId/clientTimeZone. It is neither native
  // input nor authority and is intentionally ignored, not rejected or forwarded.
  requireValue(Array.isArray(message.content), 'User message content must be blocks')
  const text = value => ({ type: 'text', text: value, text_elements: [] })
  return message.content.flatMap(block => {
    requireValue(record(block), 'Invalid user content block')
    switch (block.type) {
      case 'systemreminder':
      case 'system-reminder':
      case 'system_reminder':
        return []
      case 'text':
        requireValue(typeof block.text === 'string', 'Invalid user text')
        return [text(block.text)]
      case 'image':
      case 'localImage': {
        keysOnly(block, ['type', 'url', 'fileId', 'path', 'detail'])
        const sources = ['url', 'fileId', 'path'].filter(key => block[key] !== undefined)
        requireValue(sources.length === 1 && nonempty(block[sources[0]]) && !block[sources[0]].includes('\0'), 'Image attachment must be resolved by the bridge to exactly one explicit path, URL, or Codex fileId')
        requireValue(block.detail === undefined || ['auto', 'low', 'high', 'original'].includes(block.detail), 'Invalid image detail')
        const detail = block.detail === undefined ? {} : { detail: block.detail }
        return [sources[0] === 'path' ? { type: 'localImage', path: block.path, ...detail }
          : { type: 'image', [sources[0]]: block[sources[0]], ...detail }]
      }
      case 'file':
      case 'localFile':
        keysOnly(block, ['type', 'path'])
        requireValue(nonempty(block.path) && !block.path.includes('\0'), 'Local file attachment must be resolved by the bridge to an explicit path')
        return [text(`Local file: ${JSON.stringify(block.path)}`)]
      default:
        throw failure('unsupported-user-input', `Unsupported direct user content block: ${block.type}`)
    }
  })
}
