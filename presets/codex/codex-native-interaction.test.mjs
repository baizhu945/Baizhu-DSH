import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import {
  CODEX_NATIVE_PROFILES, nativePolicyFor, handleNativeRequest,
  handleNativeAsyncQuestions, nativeUserInput,
} from './codex-native-interaction.mjs'

// Exact current wire fields: Rust v2/item.rs (experimentalApi=true),
// v2/permissions.rs and protocol/src/items.rs. Do not use the experimental-
// filtered generated TS interface to remove availableDecisions/questions.
const commandMethod = 'item/commandExecution/requestApproval'
const fileMethod = 'item/fileChange/requestApproval'
const permissionMethod = 'item/permissions/requestApproval'
const userMethod = 'item/tool/requestUserInput'
const mcpMethod = 'mcpServer/elicitation/request'
// permissions.rs ExecPolicyAmendment has serde(transparent), hence argv.
const execAmendment = { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['curl', '--head'] } }
const networkAllow = { applyNetworkPolicyAmendment: { network_policy_amendment: { host: 'example.test', action: 'allow' } } }
const networkDeny = { applyNetworkPolicyAmendment: { network_policy_amendment: { host: 'example.test', action: 'deny' } } }
const allDecisions = ['accept', 'acceptForSession', execAmendment, networkAllow, networkDeny, 'decline', 'cancel']
const commandParams = () => ({
  kind: 'command', threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1',
  startedAtMs: 1700000000000, approvalId: null, environmentId: null,
  reason: 'Fetch response headers outside the network sandbox', command: 'curl --head https://example.test', cwd: '/workspace',
  networkApprovalContext: { host: 'example.test', protocol: 'https' },
  commandActions: [{ type: 'unknown', command: 'curl --head https://example.test' }],
  additionalPermissions: { network: { enabled: true }, fileSystem: null },
  proposedExecpolicyAmendment: ['curl', '--head'],
  proposedNetworkPolicyAmendments: [{ host: 'example.test', action: 'allow' }],
  availableDecisions: structuredClone(allDecisions),
})
const fileParams = () => ({
  threadId: 'thread-1', turnId: 'turn-1', itemId: 'file-1', startedAtMs: 1700000000000,
  reason: 'Update configuration outside the workspace', grantRoot: '/external/config',
})
const permissionParams = () => ({
  threadId: 'thread-1', turnId: 'turn-1', itemId: 'permissions-1', environmentId: null,
  startedAtMs: 1700000000000, cwd: '/workspace', reason: 'Read external input and write only one report',
  permissions: {
    network: { enabled: true },
    fileSystem: {
      read: ['/external/input'], write: ['/external/report.txt'], globScanMaxDepth: 3,
      entries: [
        { path: { type: 'path', path: '/external/input' }, access: 'read' },
        { path: { type: 'glob_pattern', pattern: '/external/*.txt' }, access: 'write' },
        { path: { type: 'special', value: { kind: 'project_roots', subpath: 'reports' } }, access: 'read' },
        { path: { type: 'path', path: '/external/private' }, access: 'deny' },
      ],
    },
  },
})
const questionParams = () => ({
  threadId: 'thread-1', turnId: 'turn-1', itemId: 'questions-1', isBlocking: true, autoResolutionMs: null,
  questions: [
    { id: 'environment', header: 'Target', question: 'Which environment?', isOther: false, isSecret: false, options: [
      { label: 'Staging', description: 'Test changes safely' }, { label: 'Production', description: 'Live environment' },
    ] },
    { id: '__proto__', header: 'Notes', question: 'Any notes?', isOther: true, isSecret: false, options: null },
  ],
})
const mcpParams = () => ({
  threadId: 'thread-1', turnId: null, serverName: 'demo', mode: 'form', _meta: null, message: 'Choose deployment settings',
  requestedSchema: {
    type: 'object', properties: {
      region: { type: 'string', enum: ['us', 'eu'], description: 'Hosting region' },
      tier: { type: 'string', oneOf: [{ const: 's', title: 'Small' }, { const: 'l', title: 'Large' }] },
    }, required: ['region', 'tier'],
  },
})
const agentOf = events => ({ session: { header: { cwd: '/workspace' }, events: events ?? [] } })
const choose = index => request => ({ answers: request.questions.map(question => ({ id: question.id, selected: [question.options[index].label] })) })
const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

// Small faithful same-process DSH seam: request uses this.effectivePolicy,
// borrows the request identity, races abort, and encloses it in the audit pair.
// No arbitrary model/HTTP calls, actual credentials, or global policy writes.
function host({ policy = 'ask', mode, outcome = 'allowed-once', answer = choose(0) } = {}) {
  const listeners = []
  const audit = []
  const questionCalls = []
  const approvalCalls = []
  const services = {}
  const ctx = {
    get: key => services[key],
    on(event, listener, options) {
      assert.equal(event, 'approval/request')
      assert.equal(options.prepend, true)
      listeners.unshift(listener)
      return () => { const index = listeners.indexOf(listener); if (index !== -1) listeners.splice(index, 1) }
    },
  }
  services.userQuestions = {
    async ask(request) { questionCalls.push(request); return await answer(request) },
  }
  services.approval = {
    config: { policy },
    effectivePolicy(session) { return session.events.findLast(event => event.type === 'approval/policy')?.data.policy ?? this.config.policy },
    async request(req) {
      approvalCalls.push({ req, receiver: this })
      audit.push({ type: 'approval/asked', toolName: req.toolName, reason: req.reason, callId: req.callId })
      let result
      if (req.signal?.aborted) result = 'cancelled'
      else if (this.effectivePolicy(req.agent.session) === 'never') result = 'rejected'
      else {
        const queue = [...listeners]
        const run = index => queue[index] ? queue[index](req, () => run(index + 1)) : Promise.resolve(outcome)
        const work = Promise.resolve().then(() => run(0)).then(value =>
          ['allowed-once', 'rejected', 'unavailable', 'cancelled'].includes(value) ? value : 'unavailable', () => 'unavailable')
        if (!req.signal) result = await work
        else {
          let abort
          const cancellation = new Promise(done => {
            abort = () => done('cancelled')
            req.signal.addEventListener('abort', abort, { once: true })
          })
          result = await Promise.race([work, cancellation])
          req.signal.removeEventListener('abort', abort)
        }
      }
      audit.push({ type: 'approval/decided', outcome: result })
      return result
    },
  }
  if (mode) services.sandboxPolicy = { defaultMode: mode, resolve: () => ({ mode, workspaceRoot: '/workspace' }) }
  return { ctx, services, listeners, audit, questionCalls, approvalCalls }
}
const request = (fixture, method, params, extra = {}) => handleNativeRequest({ ctx: fixture.ctx, agent: extra.agent ?? agentOf(), method, params, ...extra })

// Profiles/policy must remain independent of mutable deployment permissions.
test('immutable native profile shapes have official sandbox/approvalPolicy and UI names', () => {
  assert.deepEqual(Object.keys(CODEX_NATIVE_PROFILES), ['codex-read-only', 'codex-on-request', 'codex-full-access'])
  assert.deepEqual(CODEX_NATIVE_PROFILES['codex-on-request'], { sandbox: 'workspace-write', approvalPolicy: 'on-request', name: 'Codex On Request' })
  assert.ok(Object.isFrozen(CODEX_NATIVE_PROFILES))
  for (const value of Object.values(CODEX_NATIVE_PROFILES)) assert.ok(Object.isFrozen(value))
  assert.throws(() => { CODEX_NATIVE_PROFILES['codex-read-only'].sandbox = 'danger-full-access' }, TypeError)
})

test('initial native default preserves standing read-only and never; full access requires both', () => {
  assert.equal(nativePolicyFor({}, agentOf()), CODEX_NATIVE_PROFILES['codex-read-only'])
  assert.equal(nativePolicyFor(host({ mode: 'read-only' }).ctx, agentOf()).sandbox, 'read-only')
  assert.equal(nativePolicyFor(host({ mode: 'danger-full-access' }).ctx, agentOf()).sandbox, 'workspace-write')
  assert.equal(nativePolicyFor(host({ mode: 'danger-full-access', policy: 'never' }).ctx, agentOf()), CODEX_NATIVE_PROFILES['codex-full-access'])
  assert.deepEqual(nativePolicyFor(host({ mode: 'read-only', policy: 'never' }).ctx, agentOf()), { sandbox: 'read-only', approvalPolicy: 'never', name: 'Codex Read Only' })
  assert.equal(nativePolicyFor(host({ policy: 'never' }).ctx, agentOf()).approvalPolicy, 'never')
})

test('session standing override outranks service defaults; explicit native profiles are independent', () => {
  const h = host({ mode: 'danger-full-access', policy: 'never' })
  const agent = agentOf([{ type: 'sandbox/mode', data: { mode: 'read-only' } }, { type: 'approval/policy', data: { policy: 'ask' } }])
  const before = structuredClone(agent.session.events)
  assert.equal(nativePolicyFor(h.ctx, agent).sandbox, 'read-only')
  agent.session.snapshotEvents = () => agent.session.events
  assert.equal(nativePolicyFor(h.ctx, agent, 'codex-read-only'), CODEX_NATIVE_PROFILES['codex-read-only'])
  assert.equal(nativePolicyFor(h.ctx, agent, 'codex-full-access'), CODEX_NATIVE_PROFILES['codex-full-access'])
  assert.throws(() => nativePolicyFor(h.ctx, agent, 'global-full-access'), /Unknown native/)
  assert.deepEqual(agent.session.events, before)
  assert.equal(h.services.approval.config.policy, 'never')
})

for (const [index, decision] of allDecisions.entries()) {
  test(`experimental command availableDecisions roundtrips exact wire choice ${index}: ${JSON.stringify(decision)}`, async () => {
    const h = host({ answer: choose(index) })
    const params = commandParams()
    const before = structuredClone(params)
    const controller = new AbortController()
    assert.deepEqual(await request(h, commandMethod, params, { signal: controller.signal, callId: 'dsh-call-1' }), { decision })
    assert.equal(h.approvalCalls[0].req.signal, controller.signal)
    assert.equal(h.approvalCalls[0].req.callId, 'dsh-call-1')
    assert.match(h.approvalCalls[0].req.reason, /curl --head/)
    assert.match(h.questionCalls[0].questions[0].question, /https:\/\/example.test/)
    assert.equal(h.questionCalls[0].questions[0].options.length, allDecisions.length)
    const description = h.questionCalls[0].questions[0].options[index].description
    assert.doesNotMatch(description, /^[\s]*[\[{]/, 'approval details must be human prose, not raw wire JSON')
    if (decision.acceptWithExecpolicyAmendment) assert.match(description, /Native command prefix: curl --head/)
    if (decision.applyNetworkPolicyAmendment) assert.match(description, /Native network rule: (?:allow|deny) example\.test/)
    assert.equal(h.listeners.length, 0)
    assert.deepEqual(h.audit.map(event => event.type), ['approval/asked', 'approval/decided'])
    assert.deepEqual(params, before)
  })
}

for (const [index, decision] of ['accept', 'acceptForSession', 'decline', 'cancel'].entries()) {
  test(`file-change approval is audited and maps only the explicit UI choice ${decision}`, async () => {
    const h = host({ answer: choose(index) })
    assert.deepEqual(await request(h, fileMethod, fileParams()), { decision })
    assert.match(h.approvalCalls[0].req.reason, /\/external\/config/)
    assert.equal(h.listeners.length, 0)
  })
}

test('older command approval accepts only allowed-once, never widens proposed prefixes', async () => {
  for (const outcome of ['allowed-once', 'rejected', 'cancelled', 'unavailable', 'allow-always', undefined]) {
    const h = host({ outcome, answer: () => { throw new Error('must not use question UI without availableDecisions') } })
    const params = commandParams()
    delete params.availableDecisions
    // Host helper defaults omitted outcomes to allowed-once; test rogue values explicitly.
    if (outcome === undefined) h.services.approval.request = async () => undefined
    assert.deepEqual(await request(h, commandMethod, params), { decision: outcome === 'allowed-once' ? 'accept' : 'decline' })
    assert.equal(h.questionCalls.length, 0)
    assert.equal(h.listeners.length, 0)
  }
})

test('native policy override is local; host never remains enforced after switching back', async () => {
  const h = host({ policy: 'never', mode: 'read-only' })
  const agent = agentOf([{ type: 'approval/policy', data: { policy: 'never' } }, { type: 'sandbox/mode', data: { mode: 'read-only' } }])
  const before = structuredClone(agent.session.events)
  const effectivePolicy = h.services.approval.effectivePolicy
  assert.deepEqual(await request(h, commandMethod, commandParams(), { agent }), { decision: 'decline' })
  assert.equal(h.questionCalls.length, 0)
  assert.deepEqual(await request(h, commandMethod, commandParams(), { agent, nativePolicy: CODEX_NATIVE_PROFILES['codex-on-request'] }), { decision: 'accept' })
  assert.notEqual(h.approvalCalls[1].receiver, h.services.approval)
  assert.equal(Object.getPrototypeOf(h.approvalCalls[1].receiver), h.services.approval)
  assert.equal(h.services.approval.effectivePolicy, effectivePolicy)
  assert.equal(h.services.approval.config.policy, 'never')
  assert.deepEqual(agent.session.events, before)
  assert.equal(await h.services.approval.request({ agent, toolName: 'standard-tool' }), 'rejected')
})

test('native never/granular rejection does not change shared host approval policy', async () => {
  const h = host()
  for (const approvalPolicy of ['never', { granular: { sandbox_approval: false, rules: false, skill_approval: false, request_permissions: false, mcp_elicitations: false } }]) {
    assert.deepEqual(await request(h, commandMethod, commandParams(), { nativePolicy: { approvalPolicy } }), { decision: 'decline' })
  }
  assert.equal(h.questionCalls.length, 0)
  assert.equal(h.services.approval.config.policy, 'ask')
  assert.equal(h.listeners.length, 0)
})

test('identity-filtered temporary answerers cannot capture unrelated/concurrent approvals', async () => {
  const entered = deferred()
  const pending = new Map()
  const h = host({ answer: questionRequest => {
    const id = questionRequest.questions[0].id
    const answer = deferred()
    pending.set(id, { answer, question: questionRequest.questions[0] })
    if (pending.size === 2) entered.resolve()
    return answer.promise
  } })
  const a = commandParams()
  const b = commandParams(); b.itemId = 'item-2'
  const first = request(h, commandMethod, a)
  const second = request(h, commandMethod, b)
  await entered.promise
  assert.equal(h.listeners.length, 2)
  assert.equal(await h.services.approval.request({ agent: agentOf(), toolName: 'unrelated' }), 'allowed-once')
  assert.equal(h.questionCalls.length, 2)
  for (const [id, { answer, question }] of pending) {
    const index = id.endsWith('item-1') ? 1 : 5
    answer.resolve({ answers: [{ id, selected: [question.options[index].label] }] })
  }
  assert.deepEqual(await first, { decision: 'acceptForSession' })
  assert.deepEqual(await second, { decision: 'decline' })
  assert.equal(h.listeners.length, 0)
})

test('missing approval/questions/event services and malformed choices fail closed', async () => {
  for (const missing of ['approval', 'userQuestions', 'on']) {
    const h = host()
    if (missing === 'on') delete h.ctx.on
    else delete h.services[missing]
    assert.deepEqual(await request(h, commandMethod, commandParams()), { decision: 'decline' })
    assert.deepEqual(await request(h, fileMethod, fileParams()), { decision: 'decline' })
    assert.equal(h.listeners.length, 0)
    if (missing !== 'approval') {
      assert.deepEqual(h.audit.filter(event => event.type === 'approval/decided').map(event => event.outcome), ['rejected', 'rejected'])
    }
  }
  for (const availableDecisions of [[], ['autoApproveAll'], [{ acceptWithExecpolicyAmendment: { execpolicy_amendment: { command: ['curl'], extra: true } } }]]) {
    const h = host()
    assert.deepEqual(await request(h, commandMethod, { ...commandParams(), availableDecisions }), { decision: 'decline' })
    assert.equal(h.questionCalls.length, 0)
  }
  for (const answer of [() => { throw new Error('UI unavailable') }, () => ({ answers: [] }), () => ({ answers: [{ id: 'native-approval:item-1', selected: [], custom: 'allow all' }] })]) {
    const h = host({ answer })
    assert.deepEqual(await request(h, commandMethod, commandParams()), { decision: 'decline' })
    assert.equal(h.listeners.length, 0)
    assert.equal(h.audit.at(-1).type, 'approval/decided')
  }
})

test('pre-abort and mid-ask abort decline after the audit; late session choices are discarded', async () => {
  const h = host()
  assert.deepEqual(await request(h, commandMethod, commandParams(), { signal: AbortSignal.abort() }), { decision: 'decline' })
  assert.equal(h.questionCalls.length, 0)
  const ready = deferred()
  const late = deferred()
  let question
  const pendingHost = host({ answer: req => { question = req.questions[0]; ready.resolve(); return late.promise } })
  const controller = new AbortController()
  const result = request(pendingHost, commandMethod, commandParams(), { signal: controller.signal })
  await ready.promise
  controller.abort()
  assert.deepEqual(await result, { decision: 'decline' })
  assert.equal(pendingHost.audit.at(-1).outcome, 'cancelled')
  assert.equal(pendingHost.listeners.length, 0)
  late.resolve({ answers: [{ id: question.id, selected: [question.options[1].label] }] })
  await Promise.resolve()
  assert.equal(pendingHost.audit.length, 2)
})

test('permissions return only exact detached requested scopes, and are turn-only', async () => {
  const h = host()
  const params = permissionParams()
  const expected = structuredClone(params.permissions)
  const result = await request(h, permissionMethod, params)
  assert.deepEqual(result, { permissions: expected, scope: 'turn' })
  assert.match(h.approvalCalls[0].req.reason, /not the session/)
  assert.match(h.approvalCalls[0].req.reason, /\/external\/private/)
  result.permissions.fileSystem.write.push('/unrequested')
  result.permissions.fileSystem.entries[0].path.path = '/unrequested'
  assert.deepEqual(params.permissions, expected)
  const scoped = permissionParams(); scoped.permissions.network = null
  assert.deepEqual((await request(h, permissionMethod, scoped)).permissions, { fileSystem: scoped.permissions.fileSystem })
  const network = permissionParams(); network.permissions.fileSystem = null
  assert.deepEqual((await request(h, permissionMethod, network)).permissions, { network: { enabled: true } })
})

test('pending permission request cannot be widened by mutating caller state', async () => {
  const wait = deferred()
  const seen = deferred()
  const h = host()
  h.services.approval.request = async () => { seen.resolve(); return wait.promise }
  const params = permissionParams()
  const expected = structuredClone(params.permissions)
  const response = request(h, permissionMethod, params)
  await seen.promise
  params.permissions.fileSystem.write.push('/')
  params.permissions.network.enabled = false
  wait.resolve('allowed-once')
  assert.deepEqual((await response).permissions, expected)
})

test('denial/never/abort/missing approval/bad permissions always return an empty native grant', async () => {
  const denied = { permissions: {}, scope: 'turn' }
  for (const outcome of ['rejected', 'cancelled', 'unavailable', 'always-allow']) {
    assert.deepEqual(await request(host({ outcome }), permissionMethod, permissionParams()), denied)
  }
  assert.deepEqual(await request(host({ policy: 'never' }), permissionMethod, permissionParams()), denied)
  assert.deepEqual(await request(host(), permissionMethod, permissionParams(), { signal: AbortSignal.abort() }), denied)
  const h = host(); delete h.services.approval
  assert.deepEqual(await request(h, permissionMethod, permissionParams()), denied)
  for (const permissions of [
    { network: null, file_system: { read: ['/'], write: null } },
    { network: { enabled: true, hosts: ['*'] }, fileSystem: null },
    { network: null, fileSystem: { read: null, write: ['/'], mode: 'danger-full-access' } },
    { network: null, fileSystem: { read: null, write: ['/'], globScanMaxDepth: 0 } },
    { network: null, fileSystem: { read: null, write: ['/'], entries: [{ path: { type: 'arbitrary' }, access: 'write' }] } },
  ]) {
    const malformed = host()
    assert.deepEqual(await request(malformed, permissionMethod, { ...permissionParams(), permissions }), denied)
    assert.equal(malformed.approvalCalls.length, 0)
  }
})

test('userQuestions preserves question IDs/options and produces official answer objects', async () => {
  const params = questionParams()
  const h = host({ answer: () => ({ answers: [{ id: 'environment', selected: ['Staging'] }, { id: '__proto__', selected: [], custom: 'Keep UTF-8: 测试' }] }) })
  const result = await request(h, userMethod, params, { callId: 'ask-1' })
  assert.deepEqual(result, { answers: Object.fromEntries([['environment', { answers: ['Staging'] }], ['__proto__', { answers: ['Keep UTF-8: 测试'] }]]) })
  assert.equal(Object.getPrototypeOf(result.answers), Object.prototype)
  assert.equal(h.questionCalls[0].questions[0].id, 'environment')
  assert.deepEqual(h.questionCalls[0].questions[0].options, params.questions[0].options)
  assert.deepEqual(h.questionCalls[0].wait, { callId: 'ask-1' })
  assert.deepEqual(await request(host({ answer: () => ({ answers: [] }) }), userMethod, params), { answers: Object.fromEntries(params.questions.map(question => [question.id, { answers: [] }])) })
})

test('input missing service, abort, unknown IDs, secret questions, and invented options fail closed', async () => {
  const missing = host(); delete missing.services.userQuestions
  await assert.rejects(request(missing, userMethod, questionParams()), error => error.code === 'user-questions-unavailable')
  await assert.rejects(request(host(), userMethod, questionParams(), { signal: AbortSignal.abort() }), error => error.code === 'request-aborted')
  for (const answers of [
    [{ id: 'unexpected', selected: [] }],
    [{ id: 'environment', selected: ['Not offered'] }],
    [{ id: 'environment', selected: [], custom: 'Not allowed' }],
    [{ id: 'environment', selected: ['Staging', 'Production'] }],
    [{ id: 'environment', selected: [] }, { id: 'environment', selected: [] }],
  ]) await assert.rejects(request(host({ answer: () => ({ answers }) }), userMethod, questionParams()))
  const secret = questionParams(); secret.questions[0].isSecret = true
  await assert.rejects(request(host(), userMethod, secret), /secret-input UI/)
})

test('MCP typed finite-enum form maps option labels to exact values, not arbitrary schemas', async () => {
  const h = host({ answer: req => ({ answers: req.questions.map(question => ({ id: question.id, selected: [question.options[0].label] })) }) })
  assert.deepEqual(await request(h, mcpMethod, mcpParams()), { action: 'accept', content: { region: 'us', tier: 's' }, _meta: null })
  assert.deepEqual(await request(host({ answer: () => ({ answers: [] }) }), mcpMethod, mcpParams()), { action: 'decline', content: null, _meta: null })
  assert.deepEqual(await request(host(), mcpMethod, mcpParams(), { signal: AbortSignal.abort() }), { action: 'cancel', content: null, _meta: null })
  for (const mode of ['url', 'openai/form', 'openaiForm']) {
    await assert.rejects(request(host(), mcpMethod, { ...mcpParams(), mode }), error => error.code === 'method-not-supported' && /dedicated elicitation UI/.test(error.message))
  }
  const arbitrary = mcpParams(); arbitrary.requestedSchema.properties.region = { type: 'string', format: 'email' }
  await assert.rejects(request(host(), mcpMethod, arbitrary), /unsupported/)
  const extra = mcpParams(); extra.requestedSchema.additionalProperties = true
  await assert.rejects(request(host(), mcpMethod, extra), /unsupported/)
})

test('async agentMessage.questions uses official stable identity and desktop reply envelope for turn/steer', async () => {
  const params = {
    threadId: 'thread-1', turnId: 'turn-1', completedAtMs: 1700000000000,
    item: { type: 'agentMessage', id: 'message-1', text: 'Waiting for choices', phase: 'commentary', memoryCitation: null, delivery: 'async', questions: [
      { title: 'Which environment?', options: ['Staging', 'Production'] }, { title: 'Any notes?', options: null },
    ] },
  }
  const ids = params.item.questions.map((_, index) => JSON.stringify(['request_user_input_async', 'message-1', index]))
  const h = host({ answer: () => ({ answers: [{ id: ids[0], selected: ['Staging'] }, { id: ids[1], selected: [], custom: 'Only test changes' }] }) })
  const signal = new AbortController().signal
  const result = await handleNativeAsyncQuestions({ ctx: h.ctx, agent: agentOf(), params, signal })
  assert.equal(result.length, 1)
  assert.deepEqual(result[0].text_elements, [])
  assert.match(result[0].text, /^<send_user_message_question_reply>\n/)
  const replies = JSON.parse(result[0].text.replace(/^<send_user_message_question_reply>\n|\n<\/send_user_message_question_reply>$/g, ''))
  assert.deepEqual(replies, [{ questionItemId: ids[0], question: 'Which environment?', answer: 'Staging' }, { questionItemId: ids[1], question: 'Any notes?', answer: 'Only test changes' }])
  assert.deepEqual(h.questionCalls[0].questions.map(question => question.id), ids)
  assert.deepEqual(await handleNativeAsyncQuestions({ ctx: h.ctx, params: { item: { type: 'commandExecution' } } }), [])
  assert.deepEqual(await handleNativeAsyncQuestions({ ctx: host({ answer: () => ({ answers: [] }) }).ctx, agent: agentOf(), params, signal }), [])
  await assert.rejects(handleNativeAsyncQuestions({ ctx: h.ctx, agent: agentOf(), params, signal: AbortSignal.abort() }), error => error.code === 'request-aborted')
})

test('unsupported native requests throw method-not-supported; legacy v1 denies with official union', async () => {
  for (const method of ['item/tool/call', 'attestation/generate', 'future/request']) {
    await assert.rejects(request(host(), method, {}), error => error.code === 'method-not-supported' && error.rpcCode === -32601)
  }
  for (const method of ['execCommandApproval', 'applyPatchApproval']) {
    const result = await request(host(), method, {})
    assert.equal(typeof result.decision.denied.rejection, 'string')
    assert.match(result.decision.denied.rejection, /no action was approved/)
  }
})

test('auth refresh is only an injected callback, produces exact official response, and obeys abort', async () => {
  const params = { reason: 'unauthorized', previousAccountId: 'fake-workspace' }
  const signal = new AbortController().signal
  let calls = 0
  const refreshAuth = (received, context) => {
    calls += 1; assert.equal(received, params); assert.equal(context.signal, signal)
    return { accessToken: 'fixture-token-not-real', chatgptAccountId: 'fixture-account', chatgptPlanType: null, extra: 'discarded' }
  }
  assert.deepEqual(await request(host(), 'account/chatgptAuthTokens/refresh', params, { refreshAuth, signal }), { accessToken: 'fixture-token-not-real', chatgptAccountId: 'fixture-account', chatgptPlanType: null })
  assert.equal(calls, 1)
  await assert.rejects(request(host(), 'account/chatgptAuthTokens/refresh', params), error => error.code === 'method-not-supported')
  await assert.rejects(request(host(), 'account/chatgptAuthTokens/refresh', params, { refreshAuth, signal: AbortSignal.abort() }), error => error.code === 'request-aborted')
  assert.equal(calls, 1)
})

test('installed DSH ApprovalService + Cordis preserve identity, audit, and host never on a local native facade', async t => {
  const anchor = '/nix/store/bd2xniw1ymxc545042qy39p67wzgax0a-dsh-0.2.0-rc.2/packages/interaction/user-approval/'
  let ApprovalService, Context
  try {
    ;({ ApprovalService } = await import(`${anchor}lib/types/index.js`))
    const require = createRequire(`${anchor}package.json`)
    ;({ Context } = await import(require.resolve('@deepseek-ai/cordis')))
  } catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND' || error.code === 'MODULE_NOT_FOUND') return t.skip('Installed DSH store path is unavailable on this machine')
    throw error
  }
  const ctx = new Context()
  const approval = new ApprovalService(ctx, { policy: 'never' })
  let asks = 0
  ctx.provide('userQuestions', { ask: async req => {
    asks += 1
    return choose(1)(req)
  } })
  const events = [{ type: 'turn/start', data: { turn: 1 } }, { type: 'approval/policy', data: { policy: 'never' } }]
  const session = {
    events, get seq() { return events.length }, eventAt(seq) { return events[seq] },
    append(type, data) { events.push({ type, data }) },
  }
  const agent = { session }
  const result = await handleNativeRequest({ ctx, agent, method: commandMethod, params: commandParams(), nativePolicy: CODEX_NATIVE_PROFILES['codex-on-request'] })
  assert.deepEqual(result, { decision: 'acceptForSession' })
  assert.equal(asks, 1)
  assert.equal(approval.config.policy, 'never')
  assert.deepEqual(events.filter(event => event.type === 'approval/policy'), [{ type: 'approval/policy', data: { policy: 'never' } }])
  assert.deepEqual(events.slice(2).map(event => event.type), ['approval/asked', 'approval/decided'])
  assert.equal(events[2].data.id, events[3].data.id)
  assert.equal(events[3].data.outcome, 'allowed-once')
  assert.equal(await approval.request({ agent, toolName: 'standard-tool' }), 'rejected')
  assert.equal(asks, 1)
  assert.equal(events.at(-1).data.outcome, 'rejected')
})

test('direct user conversion emits only official text/image/localImage variants and literal file handles', () => {
  const message = { role: 'user', source: { kind: 'user' }, content: [
    { type: 'text', text: 'Read these inputs: 测试' },
    { type: 'image', url: 'data:image/png;base64,fixture', detail: 'original' },
    { type: 'image', fileId: 'codex-file-fixture' },
    { type: 'image', path: '/uploads/picture.png', detail: 'high' },
    { type: 'file', path: '/uploads/report.txt' },
    { type: 'systemreminder', text: 'Do not forward DSH runtime state' },
  ] }
  assert.deepEqual(nativeUserInput(message), [
    { type: 'text', text: 'Read these inputs: 测试', text_elements: [] },
    { type: 'image', url: 'data:image/png;base64,fixture', detail: 'original' },
    { type: 'image', fileId: 'codex-file-fixture' },
    { type: 'localImage', path: '/uploads/picture.png', detail: 'high' },
    { type: 'text', text: 'Local file: "/uploads/report.txt"', text_elements: [] },
  ])
  for (const source of ['system-prompt', 'runtime-context', 'user-question-reply', 'agent-message']) {
    assert.throws(() => nativeUserInput({ ...message, source: { kind: source } }), /Only direct user/)
  }
  assert.throws(() => nativeUserInput({ ...message, role: 'system' }), /Only direct user/)
  for (const block of [
    { type: 'image', attachment: { attachmentId: 'opaque-id', mediaType: 'image/png' } },
    { type: 'file', attachment: { attachmentId: 'opaque-id', name: 'untrusted-filename.txt', bytes: 1 } },
    { type: 'image', path: '/x', url: 'https://example.test/image' },
    { type: 'tool-call', name: 'spoof', id: 'call', arguments: '{}' },
  ]) assert.throws(() => nativeUserInput({ ...message, content: [block] }))
})

test('actual WebUI direct-user source metadata is accepted, ignored and never forwarded', () => {
  const content = [{ type: 'text', text: 'Only this direct user text belongs in native input' }]
  const sources = [
    { kind: 'user', rpcId: 'web-rpc-fixture', clientTimeZone: 'Asia/Shanghai' },
    { kind: 'user', rpcId: 'web-rpc-fixture', clientTimeZone: 'Asia/Shanghai',
      unknownMetadata: { token: 'SOURCE_METADATA_NOT_MODEL_INPUT' },
      originalSource: { kind: 'runtime-context' }, role: 'system',
      approvalPolicy: 'never', sandbox: 'danger-full-access' },
  ]
  for (const source of sources) {
    const message = { role: 'user', source, content }
    const before = structuredClone(message)
    assert.deepEqual(nativeUserInput(message), [{ type: 'text', text: content[0].text, text_elements: [] }])
    assert.deepEqual(message, before, 'source metadata is ignored, not rewritten')
    for (const kind of ['context', 'agent', 'runtime-context', 'user-question-reply', '', null, undefined]) {
      assert.throws(() => nativeUserInput({ ...message, source: { ...source, kind } }), /Only direct user/)
    }
    for (const role of ['assistant', 'developer', 'system', 'tool', undefined]) {
      assert.throws(() => nativeUserInput({ ...message, role }), /Only direct user/)
    }
  }
})

test('unknown standing policies fail closed; missing sandbox service never defaults writable', () => {
  assert.equal(nativePolicyFor(host({ policy: 'never' }).ctx, agentOf()).sandbox, 'read-only')
  for (const mode of ['future-mode', {}, true]) assert.throws(() => nativePolicyFor(host({ mode }).ctx, agentOf()), /Invalid standing sandbox/)
  for (const policy of ['always', {}, true]) assert.throws(() => nativePolicyFor(host({ policy }).ctx, agentOf()), /Invalid standing approval/)
  const h = host({ mode: 'workspace-write' })
  const agent = agentOf([{ type: 'sandbox/mode', data: { mode: 'read-only' } }])
  // A request-time transient resolver must not outrank a standing session event.
  h.services.sandboxPolicy.resolve = () => ({ mode: 'danger-full-access' })
  assert.equal(nativePolicyFor(h.ctx, agent).sandbox, 'read-only')
  assert.throws(() => nativePolicyFor(h.ctx, agent, { toString: () => 'codex-full-access' }), /must be a string/)
})

test('exec amendment uses exact transparent argv and rejects legacy/camel-case/unrecognized decisions', async () => {
  const valid = { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['printf', '%s', ''] } }
  assert.deepEqual(await request(host(), commandMethod, { ...commandParams(), availableDecisions: [valid] }), { decision: valid })
  for (const decision of [
    { acceptWithExecpolicyAmendment: { execpolicy_amendment: { command: ['curl'] } } },
    { acceptWithExecpolicyAmendment: { execpolicyAmendment: ['curl'] } },
    { acceptWithExecpolicyAmendment: { execpolicy_amendment: [] } },
    { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['curl', 1] } },
    { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['curl\0'] } },
    { applyNetworkPolicyAmendment: { networkPolicyAmendment: { host: 'example.test', action: 'allow' } } },
    { applyNetworkPolicyAmendment: { network_policy_amendment: { host: 'example.test', action: 'allow', port: 443 } } },
    { applyNetworkPolicyAmendment: { network_policy_amendment: { host: 'example.test\nallow all', action: 'allow' } } },
    { futureApproval: true },
  ]) {
    const h = host()
    assert.deepEqual(await request(h, commandMethod, { ...commandParams(), availableDecisions: [decision] }), { decision: 'decline' })
    assert.equal(h.questionCalls.length, 0)
  }
  const h = host()
  assert.deepEqual(await request(h, fileMethod, { ...fileParams(), availableDecisions: ['accept'] }), { decision: 'decline' })
  assert.deepEqual(await request(h, commandMethod, { ...commandParams(), kind: 'future-execution' }), { decision: 'decline' })
  assert.equal(h.questionCalls.length, 0)
})

test('persistent prefix descriptions preserve argv boundaries without raw wire JSON', async () => {
  const h = host()
  const amendment = { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['echo', 'a b', '', 'line\nbreak'] } }
  assert.deepEqual(await request(h, commandMethod, { ...commandParams(), availableDecisions: [amendment] }), { decision: amendment })
  const description = h.questionCalls[0].questions[0].options[0].description
  assert.equal(description, 'Native command prefix: echo "a b" "" "line\\nbreak"')
  assert.doesNotMatch(description, /[\r\n]/)
})

test('unvalidated additional command permissions never enter the human/audit surface', async () => {
  const h = host()
  assert.deepEqual(await request(h, commandMethod, {
    ...commandParams(), additionalPermissions: { network: null, fileSystem: null, accessToken: 'fixture-secret-not-real' },
  }), { decision: 'decline' })
  assert.equal(h.questionCalls.length, 0)
  assert.equal(h.audit.length, 0)
})

test('temporary answerer fails closed on broken disposer and cannot stay active after completion', async () => {
  for (const disposer of [undefined, true, 'not-a-disposer', () => { throw new Error('cleanup failed') }]) {
    const h = host()
    let listener
    h.ctx.on = (_event, incoming) => { listener = incoming; h.listeners.push(incoming); return disposer }
    assert.deepEqual(await request(h, commandMethod, commandParams()), { decision: 'decline' })
    const matching = h.approvalCalls[0]?.req
    // No callback was dispatched at all when registration has no valid disposer.
    if (matching) assert.equal(await listener(matching, () => assert.fail('matching request must not fall through')), 'rejected')
    assert.equal(h.questionCalls.length, typeof disposer === 'function' ? 1 : 0)
    assert.equal(await listener({ toolName: 'unrelated' }, async () => 'unavailable'), 'unavailable')
  }
})

test('audit failures before or after a native choice cannot authorize or leak the temporary listener', async () => {
  for (const afterChoice of [false, true]) {
    const h = host({ answer: choose(1) })
    h.services.approval.request = async req => {
      if (afterChoice) await h.listeners[0](req, () => assert.fail())
      throw new Error('Audit append failed')
    }
    assert.deepEqual(await request(h, commandMethod, commandParams()), { decision: 'decline' })
    assert.equal(h.listeners.length, 0)
  }
  const h = host({ answer: choose(1) })
  h.services.approval.request = async req => {
    await h.listeners[0](req, () => assert.fail())
    return 'unavailable'
  }
  assert.deepEqual(await request(h, commandMethod, commandParams()), { decision: 'decline' })
  assert.equal(h.listeners.length, 0)
})

test('temporary answerer only permits one ask even if a broken host dispatches the same identity twice', async () => {
  const h = host()
  h.services.approval.request = async req => {
    assert.equal(await h.listeners[0](req, () => assert.fail()), 'allowed-once')
    assert.equal(await h.listeners[0](req, () => assert.fail()), 'rejected')
    return 'allowed-once'
  }
  assert.deepEqual(await request(h, commandMethod, commandParams()), { decision: 'accept' })
  assert.equal(h.questionCalls.length, 1)
  assert.equal(h.listeners.length, 0)
})

test('omitted native question flags follow Rust false defaults; single-select rejects mixed answers', async () => {
  const params = questionParams()
  delete params.questions[0].isSecret
  delete params.questions[0].isOther
  const h = host({ answer: () => ({ answers: [{ id: 'environment', selected: ['Staging'] }] }) })
  assert.deepEqual((await request(h, userMethod, params)).answers.environment, { answers: ['Staging'] })
  const other = questionParams(); other.questions[0].isOther = true
  await assert.rejects(request(host({ answer: () => ({ answers: [{ id: 'environment', selected: ['Staging'], custom: 'Production' }] }) }), userMethod, other), /cannot mix/)
  const unknown = questionParams(); unknown.questions[0].is_secret = true
  const secretHost = host()
  await assert.rejects(request(secretHost, userMethod, unknown), /Unsupported/)
  assert.equal(secretHost.questionCalls.length, 0)
})

test('legacy MCP enumNames map human labels to exact values and validate all supported schema fields', async () => {
  const params = mcpParams()
  params.requestedSchema.$schema = 'https://json-schema.org/draft/2020-12/schema'
  params.requestedSchema.properties.region.enumNames = ['United States', 'Europe']
  const h = host({ answer: choose(1) })
  assert.deepEqual(await request(h, mcpMethod, params), { action: 'accept', content: { region: 'eu', tier: 'l' }, _meta: null })
  assert.equal(h.questionCalls[0].questions[0].options[1].label, 'Europe')
  const bad = [
    value => { value.message = { accessToken: 'fixture-not-real' } },
    value => { value.serverName = {} },
    value => { value.requestedSchema.$schema = {} },
    value => { value.requestedSchema.properties.region.enumNames = ['only one'] },
    value => { value.requestedSchema.properties.region.enumNames = ['Same', 'Same'] },
    value => { value.requestedSchema.properties.region.enumNames = ['US', 1] },
    value => { value.requestedSchema.properties.tier.enumNames = ['Small', 'Large'] },
    value => { value.requestedSchema.properties.region.default = 'not-an-enum-value' },
    value => { value.requestedSchema.properties.region.isSecret = true },
    value => { value.requestedSchema.properties.region.type = 'array' },
  ]
  for (const mutate of bad) {
    const malformed = mcpParams(); mutate(malformed)
    const hostFixture = host()
    await assert.rejects(request(hostFixture, mcpMethod, malformed), error => error.code === 'method-not-supported')
    assert.equal(hostFixture.questionCalls.length, 0)
  }
})

test('native never and granular policies gate MCP elicitations without writing host policy', async () => {
  const h = host()
  const granular = { sandbox_approval: true, rules: true, request_permissions: false, skill_approval: false, mcp_elicitations: false }
  for (const approvalPolicy of ['never', { granular }]) {
    assert.deepEqual(await request(h, mcpMethod, mcpParams(), { nativePolicy: { approvalPolicy } }), { action: 'decline', content: null, _meta: null })
  }
  assert.equal(h.questionCalls.length, 0)
  assert.equal(h.services.approval.config.policy, 'ask')
  for (const approvalPolicy of [{ granular: { ...granular, futureGrant: true } }, { granular: { ...granular, rules: 'true' } }, { granular: {}, futurePolicy: true }]) {
    assert.deepEqual(await request(h, commandMethod, commandParams(), { nativePolicy: { approvalPolicy } }), { decision: 'decline' })
  }
  assert.equal(h.questionCalls.length, 0)
})

test('async questions require a cancellable lifetime, reject unknown fields, and discard late answers', async () => {
  const params = { item: { type: 'agentMessage', delivery: 'async', id: 'async-1', questions: [{ title: 'Choose?', options: ['Yes', 'No'] }] } }
  const h = host()
  await assert.rejects(handleNativeAsyncQuestions({ ctx: h.ctx, params }), /cancellable lifetime/)
  assert.equal(h.questionCalls.length, 0)
  const malformed = structuredClone(params); malformed.item.questions[0].isSecret = true
  await assert.rejects(handleNativeAsyncQuestions({ ctx: h.ctx, params: malformed, signal: new AbortController().signal }), /Unsupported/)
  const malformedList = structuredClone(params); malformedList.item.questions = { length: 0 }
  await assert.rejects(handleNativeAsyncQuestions({ ctx: h.ctx, params: malformedList }), /question list/)
  assert.equal(h.questionCalls.length, 0)
  const entered = deferred(), late = deferred(), controller = new AbortController()
  let question
  const pending = host({ answer: req => { question = req.questions[0]; entered.resolve(); return late.promise } })
  const result = handleNativeAsyncQuestions({ ctx: pending.ctx, params, signal: controller.signal })
  await entered.promise
  controller.abort()
  await assert.rejects(result, error => error.code === 'request-aborted')
  late.resolve({ answers: [{ id: question.id, selected: ['Yes'] }] })
  await Promise.resolve()
  assert.equal(pending.questionCalls[0].signal, controller.signal)
})

test('resolved attachments reject ambiguous opaque sources/NULs and never forward source metadata', () => {
  const message = { role: 'user', source: { kind: 'user' }, content: [] }
  for (const block of [
    { type: 'image', path: '/x', attachment: { attachmentId: 'opaque' } },
    { type: 'image', path: '/x', source: { kind: 'runtime-context' } },
    { type: 'image', fileId: 'opaque', detail: 'future-detail' },
    { type: 'file', path: '/x', attachment: { attachmentId: 'opaque' } },
    { type: 'file', path: '/x\0' },
    { type: 'image', path: '/x\0' },
  ]) assert.throws(() => nativeUserInput({ ...message, content: [block] }))
  assert.deepEqual(nativeUserInput({ ...message, source: { kind: 'user', originalSource: { kind: 'runtime-context' } },
    content: [{ type: 'text', text: 'Direct text' }] }), [{ type: 'text', text: 'Direct text', text_elements: [] }],
  'ancillary source fields are not authority and are never serialized into native input')
  const inputs = nativeUserInput({ ...message, content: [{ type: 'text', text: 'Hi', source: { kind: 'anything' } }] })
  assert.deepEqual(inputs, [{ type: 'text', text: 'Hi', text_elements: [] }])
})

test('an answerer cannot mutate private offered labels to invent a native answer', async () => {
  const h = host({ answer: req => {
    const question = req.questions[0]
    question.options.push({ label: 'Invented answer' })
    return { answers: [{ id: question.id, selected: ['Invented answer'] }] }
  } })
  await assert.rejects(request(h, userMethod, questionParams()), /not an offered option/)
  assert.deepEqual(await request(h, commandMethod, commandParams()), { decision: 'decline' })
  await assert.rejects(request(h, mcpMethod, mcpParams()), /not an offered option/)
  assert.equal(h.listeners.length, 0)
})

test('installed DSH UserQuestionService enforces exact live root and cancellation stays bounded even if answerer ignores it', async t => {
  const anchor = '/nix/store/bd2xniw1ymxc545042qy39p67wzgax0a-dsh-0.2.0-rc.2/packages/interaction/user-questions/'
  let UserQuestionService, Context
  try {
    ;({ UserQuestionService } = await import(`${anchor}lib/types/index.js`))
    const require = createRequire(`${anchor}package.json`)
    ;({ Context } = await import(require.resolve('@deepseek-ai/cordis')))
  } catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND' || error.code === 'MODULE_NOT_FOUND') return t.skip('Installed DSH store path is unavailable on this machine')
    throw error
  }
  const ctx = new Context()
  const agent = { id: 'fixture-agent', session: {} }
  ctx.provide('agents', { get: id => id === agent.id ? agent : undefined, roots: () => [agent] })
  new UserQuestionService(ctx)
  const listener = ctx.on('user-questions/request', async req => ({ answers: req.questions.map(question => ({
    id: question.id, selected: question.options?.length ? [question.options[0].label] : [],
  })) }))
  const response = await handleNativeRequest({ ctx, agent, method: userMethod, params: questionParams() })
  assert.deepEqual(response.answers.environment, { answers: ['Staging'] })
  await assert.rejects(handleNativeRequest({ ctx, agent: { ...agent }, method: userMethod, params: questionParams() }), error => error.code === 'CALLER_NOT_LIVE')
  listener()
  const ready = deferred(), late = deferred(), controller = new AbortController()
  let question
  const dispose = ctx.on('user-questions/request', async req => { question = req.questions[0]; ready.resolve(); return await late.promise })
  const result = handleNativeRequest({ ctx, agent, method: userMethod, params: questionParams(), signal: controller.signal })
  await ready.promise
  controller.abort()
  await assert.rejects(result, error => error.code === 'request-aborted')
  late.resolve({ answers: [{ id: question.id, selected: ['Staging'] }] })
  dispose()
})
