/**
 * Codex-compatible end-tool surface for the dsh Code Mode presentation.
 *
 * The host remains authoritative for sandboxing, approval, filesystem access,
 * attachments, user interaction, persistence, and subagent providers. This
 * scoped adapter changes model-facing names and wire shapes only for sessions
 * selecting the Codex preset.
 */
const createRequire = process.getBuiltinModule('node:module').createRequire
const nodePath = process.getBuiltinModule('node:path')
const nodeFs = process.getBuiltinModule('node:fs/promises')
const dshHome = process.env.DSH_HOME ?? `${process.env.HOME ?? '/home/baizhu945'}/.dsh`
const requireFromDsh = createRequire(`${dshHome}/profiles/codex-surface.cjs`)
const toolsEntry = requireFromDsh.resolve('@deepseek-ai/dsh-tools')
const { defineTool } = await import(toolsEntry)
const sandboxEntry = requireFromDsh.resolve('@deepseek-ai/dsh-sandbox')
const { approveEscalation } = await import(sandboxEntry)
const { structuredPatch } = requireFromDsh('diff')
const DEFAULT_SHELL = '@bashPath@'.startsWith('@') ? 'bash' : '@bashPath@'
const SPAWN_AGENT_DESCRIPTION = (await nodeFs.readFile(
  nodePath.join(dshHome, '.agent-presets/codex/codex-subagent-v1-description.md'),
  'utf8',
)).trimEnd()

const IMAGE_EXTENSIONS = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

const HIDDEN_HOST_SECTIONS = new Set([
  'harness:identity',
  'harness:source',
  'app:web-surface',
  'tool:pty',
  // The host renders the same policy in dsh-flavored prose; the preset
  // re-expresses it inside <environment_context> in the upstream Codex shape.
  'sandbox:policy',
])

function humanLabel(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replaceAll('_', ' ')
    .replace(/\b\w/g, character => character.toUpperCase())
    .replace(/\bId\b/g, 'ID')
    .replace(/\bUrl\b/g, 'URL')
}

function humanScalar(value) {
  if (value === null || value === undefined) return 'none'
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  if (typeof value === 'string') return value === '' ? '(empty)' : value
  return String(value)
}

function humanLines(value, indent = '') {
  if (value === null || typeof value !== 'object') return [`${indent}${humanScalar(value)}`]
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${indent}(none)`]
    return value.flatMap(item => {
      const lines = humanLines(item, `${indent}  `)
      const first = lines[0]?.trimStart() ?? humanScalar(item)
      return [`${indent}- ${first}`, ...lines.slice(1)]
    })
  }
  const entries = Object.entries(value)
  if (entries.length === 0) return [`${indent}(none)`]
  return entries.flatMap(([key, child]) => {
    const label = humanLabel(key)
    if (child === null || typeof child !== 'object') return [`${indent}${label}: ${humanScalar(child)}`]
    return [`${indent}${label}:`, ...humanLines(child, `${indent}  `)]
  })
}

function humanizeValue(value, title) {
  const body = humanLines(value).join('\n')
  return title === undefined ? body : `${title}\n${body}`
}

function humanizeText(text) {
  const value = String(text)
  const trimmed = value.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value
  try {
    return humanizeValue(JSON.parse(trimmed))
  } catch {
    return value
  }
}

function humanizeBlocks(blocks) {
  return blocks.map(block => block.type === 'text' ? { ...block, text: humanizeText(block.text) } : block)
}

function genericToolCall(title, summary, kind = 'other') {
  return {
    card: 'generic',
    title,
    kind,
    ...(summary === undefined ? {} : { content: [{ type: 'text', text: summary }] }),
  }
}

function genericToolResult(title, result) {
  return { card: 'generic', title, content: humanizeBlocks(result.content) }
}

function genericToolError(title, result) {
  return genericToolResult(title, result)
}

/** Keep nested Code Mode results readable without changing canonical values. */
function registerReadableDispatchLog(ctx) {
  const rawOutputTools = new Set(['exec_command', 'write_stdin', 'web__run'])
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (rawOutputTools.has(exec.name) || decision.kind !== 'accept' || decision.value !== undefined) return decision
    const content = decision.content ?? result.content
    return { ...decision, content: humanizeBlocks(content) }
  })
  ctx.on('tools/code-dispatch-log', async (dispatch, next) => {
    const content = await next()
    return rawOutputTools.has(dispatch.name) ? content : humanizeBlocks(content)
  })
}

const textOutput = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: humanizeText(value) }],
}

/** Upstream Codex renders the sandbox boundary as a <filesystem> element. */
function filesystemElement(policy) {
  const root = xmlEscape(policy.workspaceRoot ?? '')
  switch (policy.mode) {
    case 'read-only':
      return `<filesystem><workspace_roots><root>${root}</root></workspace_roots>`
        + '<permission_profile type="managed"><file_system type="restricted" />'
        + '</permission_profile></filesystem>'
    case 'workspace-write':
      return `<filesystem><workspace_roots><root>${root}</root></workspace_roots>`
        + '<permission_profile type="managed"><file_system type="restricted">'
        + `<entry access="write"><path>${root}</path></entry>`
        + '</file_system></permission_profile></filesystem>'
    case 'danger-full-access':
      return '<filesystem><permission_profile type="disabled">'
        + '<file_system type="unrestricted" /></permission_profile></filesystem>'
    default:
      return undefined
  }
}

function agentOf(exec) {
  if (exec.agent === undefined) throw new Error('Codex tool requires a live agent')
  return exec.agent
}

function cwdOf(agent) {
  return agent.session.header.cwd ?? process.cwd()
}

function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function localDate() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date())
  const part = type => parts.find(entry => entry.type === type)?.value ?? '00'
  return `${part('year')}-${part('month')}-${part('day')}`
}

function permissionInstructions(policy, approval) {
  const network = 'enabled'
  const sandbox = policy.mode === 'danger-full-access'
    ? `Filesystem sandboxing defines which files can be read or written. sandbox_mode is danger-full-access: No filesystem sandboxing - all commands are permitted. Network access is ${network}.`
    : policy.mode === 'workspace-write'
      ? `Filesystem sandboxing defines which files can be read or written. sandbox_mode is workspace-write: The sandbox permits reading files, and editing files in cwd and writable_roots. Editing files in other directories requires approval. Network access is ${network}.`
      : `Filesystem sandboxing defines which files can be read or written. sandbox_mode is read-only: The sandbox only permits reading files. Network access is ${network}.`
  const approvals = approval === 'never'
    ? 'Approval policy is currently never. Do not provide sandbox_permissions for any reason; escalation requests will be rejected.'
    : policy.mode === 'danger-full-access'
      ? 'approval_policy is unless-trusted: the harness requires user approval before every exec_command or apply_patch call.'
      : 'Commands run inside the sandbox without prompting. After a real sandbox denial, retry the exact command with sandbox_permissions=require_escalated and a short justification; do not ask in chat first.'
  return `<permissions instructions>\n${sandbox}\n\n${approvals}\n</permissions instructions>`
}

/** Remove deployment/UI announcements while preserving tool, skill, plan, and Code Mode sections. */
function registerPromptBoundary(ctx) {
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembled = await next()
    const excluded = section => (
      !HIDDEN_HOST_SECTIONS.has(section.name)
      && !section.name.startsWith('plugin:')
    )
    return {
      ...assembled,
      sections: assembled.sections.filter(excluded),
      // The host's dsh-flavored sandbox policy is a dynamic context, not a
      // section; this preset re-expresses it in <environment_context> instead.
      contexts: assembled.contexts?.filter(excluded) ?? assembled.contexts,
    }
  })

  ctx.systemPrompt.context({
    name: 'codex:environment',
    order: -100,
    text: context => {
      const agent = context.agent
      if (agent === undefined) return ''
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
      const policy = ctx.get('sandboxPolicy')?.resolve({ session: agent.session })
      const filesystem = policy === undefined ? undefined : filesystemElement(policy)
      return [
        '<environment_context>',
        `  <cwd>${xmlEscape(cwdOf(agent))}</cwd>`,
        '  <shell>bash</shell>',
        `  <current_date>${localDate()}</current_date>`,
        `  <timezone>${xmlEscape(timezone)}</timezone>`,
        ...(filesystem !== undefined ? [`  ${filesystem}`] : []),
        '</environment_context>',
      ].join('\n')
    },
  })

  ctx.systemPrompt.context({
    name: 'codex:permissions',
    order: -90,
    text: context => {
      const agent = context.agent
      if (agent === undefined) return ''
      const policy = ctx.sandboxPolicy.resolve({ session: agent.session })
      return permissionInstructions(policy, effectiveApprovalPolicy(agent.session.events))
    },
  })
}

function shellWorkdir(agent, requested) {
  const base = cwdOf(agent)
  if (requested === undefined || requested.length === 0) return base
  return nodePath.isAbsolute(requested) ? requested : nodePath.resolve(base, requested)
}

function effectiveApprovalPolicy(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type === 'approval/policy') return event.data?.policy
  }
  return undefined
}

function pathIsWithin(root, candidate) {
  const relative = nodePath.relative(root, candidate)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${nodePath.sep}`) && !nodePath.isAbsolute(relative))
}

async function approvePolicy(ctx, exec, standingPolicy, requestedMode, justification, subject) {
  if (requestedMode === standingPolicy.mode) return standingPolicy
  const approvedMode = await approveEscalation(
    { requestedMode, justification, effectiveMode: standingPolicy.mode, subject },
    {
      approver: ctx.get('approval'),
      agent: exec.agent,
      callId: exec.callId,
      toolName: exec.name,
      signal: exec.signal,
    },
  )
  return { ...standingPolicy, mode: approvedMode }
}

async function execSandboxPolicy(ctx, args, exec) {
  const agent = agentOf(exec)
  const standing = ctx.sandboxPolicy.resolve({ session: agent.session })
  const requested = args.sandbox_permissions ?? 'use_default'
  if (requested === 'use_default') return standing
  if (requested !== 'require_escalated') throw new Error(`unsupported sandbox_permissions: ${String(requested)}`)
  if (typeof args.justification !== 'string' || args.justification.trim() === '') {
    throw new Error('justification is required with sandbox_permissions=require_escalated')
  }
  if (standing.mode === 'danger-full-access') {
    if (effectiveApprovalPolicy(agent.session.events) === 'never') {
      throw new Error('approval policy is never; escalated permissions cannot be requested')
    }
    // The confirm-only pre-execute gate already approved this unrestricted call.
    return standing
  }
  return approvePolicy(ctx, exec, standing, 'danger-full-access', args.justification, 'command')
}

async function patchSandboxPolicy(ctx, exec, targets) {
  const agent = agentOf(exec)
  const standing = ctx.sandboxPolicy.resolve({ session: agent.session })
  if (standing.mode === 'danger-full-access') return standing
  const processPaths = targets.map(target => ctx.fs.processPath(target))
  const insideWorkspace = processPaths.every(path => pathIsWithin(standing.workspaceRoot, path))
  const requestedMode = standing.mode === 'read-only' && insideWorkspace
    ? 'workspace-write'
    : insideWorkspace ? standing.mode : 'danger-full-access'
  if (requestedMode === standing.mode) return standing
  const scope = processPaths.length === 1 ? processPaths[0] : `${processPaths.length} files`
  return approvePolicy(ctx, exec, standing, requestedMode, `Apply patch to ${scope}`, 'patch')
}

function formatCollectedStream(stream) {
  const suffix = stream.truncated
    ? `\n[output truncated; full output: ${stream.spillPath ?? '(unavailable)'}]`
    : ''
  return `${stream.text}${suffix}`
}

function shellOutput(result) {
  const stdout = formatCollectedStream(result.stdout)
  const stderr = formatCollectedStream(result.stderr)
  const chunks = []
  if (stdout.length > 0) chunks.push(stdout)
  if (stderr.length > 0) chunks.push(`[stderr]\n${stderr}`)
  return chunks.length === 0 ? '(no output)' : chunks.join('\n')
}

function renderShellResult(value) {
  const markers = []
  if (value.timed_out) markers.push(`[timed out after ${value.timeout_ms}ms]`)
  if (value.signal !== null) markers.push(`[killed by signal: ${value.signal}]`)
  if (value.exit_code !== null) markers.push(`[exit code: ${value.exit_code}]`)
  return `${value.output}${markers.length > 0 ? `\n${markers.join('\n')}` : ''}`
}

function parseShellResult(text) {
  const lines = text.split('\n')
  let exitCode
  let signal
  while (lines.length > 0) {
    const last = lines.at(-1)
    const exit = /^\[exit code: (-?\d+)\]$/.exec(last)
    const killed = /^\[killed by signal: (.+)\]$/.exec(last)
    if (exit !== null) {
      exitCode = Number(exit[1])
      lines.pop()
      continue
    }
    if (killed !== null) {
      signal = killed[1]
      lines.pop()
      continue
    }
    break
  }
  return { output: lines.join('\n'), exitCode, signal }
}

function presentTerminalResult(result) {
  if (result.isError) return undefined
  const block = result.content.length === 1 ? result.content[0] : undefined
  if (block === undefined || block.type !== 'text') return undefined
  const parsed = parseShellResult(block.text)
  return {
    card: 'terminal',
    output: parsed.output,
    ...(parsed.exitCode !== undefined ? { exitCode: parsed.exitCode } : {}),
    ...(parsed.signal !== undefined ? { signal: parsed.signal } : {}),
  }
}

const PTY_BACKEND = 'shell'
const execSessions = new Map()
let nextExecSessionId = 0

function outputFromOperation(operation, echoedInput, marker) {
  try {
    const cleaned = cleanTerminalOutput(operation.readOutput().delta, echoedInput)
    if (typeof marker !== 'string') return { output: cleaned }
    const markerPattern = new RegExp(`(?:^|\\n)${marker}(-?\\d+)(?:\\n|$)`)
    const match = markerPattern.exec(cleaned)
    if (match === null) return { output: cleaned }
    return {
      output: cleaned.replace(match[0], ''),
      exitCode: Number(match[1]),
    }
  } catch {
    return { output: '' }
  }
}

function cleanTerminalOutput(text, echoedInput) {
  let cleaned = String(text)
    .replaceAll('\r', '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
  if (typeof echoedInput === 'string') {
    const echoPrefix = echoedInput.endsWith('\n') ? echoedInput : `${echoedInput}\n`
    if (cleaned.startsWith(echoPrefix)) cleaned = cleaned.slice(echoPrefix.length)
  }
  return cleaned.replace(/dsh> ?$/, '')
}

function boundedOutput(output, maxOutputTokens) {
  const maxChars = Math.max(1, Math.floor((maxOutputTokens ?? 10_000) * 4))
  if (output.length <= maxChars) return output
  return `${output.slice(0, maxChars)}\n[output truncated]`
}

function approximateTokens(output) {
  return Math.ceil(Buffer.byteLength(output, 'utf8') / 4)
}

async function waitForTerminalOperation(operation, yieldTimeMs, signal) {
  let timer
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => resolve({ kind: 'yield' }), yieldTimeMs)
  })
  try {
    return await Promise.race([
      operation.done.then(result => ({ kind: 'done', result })),
      timeout,
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    signal.throwIfAborted()
  }
}

function terminalOutputValue(record, output, elapsedMs, settled, maxOutputTokens, exitCode) {
  const value = {
    chunk_id: `${record.id}-${++record.chunk}`,
    wall_time_seconds: elapsedMs / 1000,
    original_token_count: approximateTokens(output),
    output: boundedOutput(output, maxOutputTokens),
  }
  if (typeof exitCode === 'number') return { ...value, exit_code: exitCode }
  if (settled.kind === 'yield') return { ...value, session_id: record.id }
  if (settled.result.sessionStatus.kind === 'running') {
    return { ...value, session_id: record.id }
  }
  if (typeof settled.result.sessionStatus.exitCode === 'number') {
    return { ...value, exit_code: settled.result.sessionStatus.exitCode }
  }
  return value
}

async function closeExecSession(ctx, record) {
  execSessions.delete(record.id)
  if (record.kind === 'pipe') {
    if (record.process.status === 'running') record.process.kill()
    return
  }
  try {
    await ctx.terminals.kill(record.owner, record.ptyId, 'Codex exec session settled')
  } catch {
    // The owner-scoped terminal service also cleans up on agent disposal.
  }
}

async function finishTerminalOperation(ctx, record, operation, startedAt, settled, maxOutputTokens) {
  const extracted = outputFromOperation(operation, record.echoedInput, record.marker)
  const output = extracted.output
  const exitCode = extracted.exitCode
  if (typeof exitCode === 'number') {
    record.echoedInput = undefined
    record.marker = undefined
    const value = terminalOutputValue(record, output, Date.now() - startedAt, settled, maxOutputTokens, exitCode)
    await closeExecSession(ctx, record)
    return value
  }
  if (settled.kind === 'yield' || settled.result.sessionStatus.kind === 'running') {
    record.operation = settled.kind === 'yield' ? operation : undefined
    return terminalOutputValue(record, output, Date.now() - startedAt, settled, maxOutputTokens)
  }
  const value = terminalOutputValue(record, output, Date.now() - startedAt, settled, maxOutputTokens)
  await closeExecSession(ctx, record)
  return value
}

function execYieldTime(args) {
  const value = args.yield_time_ms ?? 10_000
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`invalid yield_time_ms: expected a positive number, got ${String(value)}`)
  }
  return Math.min(30_000, Math.max(250, value))
}

function stdinYieldTime(chars, requested) {
  const defaultMs = chars === '' ? 5_000 : 250
  const maximumMs = chars === '' ? 300_000 : 30_000
  const value = requested ?? defaultMs
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`invalid yield_time_ms: expected a non-negative number, got ${String(value)}`)
  }
  return Math.min(maximumMs, value)
}

function wrappedCommand(command, marker) {
  const encoded = Buffer.from(String(command)).toString('base64')
  return `__codex_cmd=$(printf %s ${encoded} | base64 -d); eval "$__codex_cmd"; __codex_status=$?; printf '\\n${marker}%s\\n' "$__codex_status"`
}

function shellQuote(value) {
  const single = String.fromCharCode(39)
  return single + String(value).replaceAll(single, single + '"' + single + '"' + single) + single
}

function commandForShell(args) {
  const login = args.login !== false
  if (args.shell !== undefined) {
    return `${shellQuote(args.shell)} ${login ? '-lc' : '-c'} ${shellQuote(args.cmd)}`
  }
  return `${shellQuote(DEFAULT_SHELL)} ${login ? '-lc' : '-c'} ${shellQuote(args.cmd)}`
}

async function waitForPipeProcess(process, yieldTimeMs, signal) {
  let timer
  let onAbort
  try {
    signal.throwIfAborted()
    const timeout = new Promise(resolve => { timer = setTimeout(() => resolve('yield'), yieldTimeMs) })
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(signal.reason ?? new Error('tool call aborted'))
      signal.addEventListener('abort', onAbort, { once: true })
    })
    return await Promise.race([process.done.then(() => 'done'), timeout, aborted])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
  }
}

function pipeOutput(record, elapsedMs, maxOutputTokens) {
  const read = record.process.readOutput()
  const markers = []
  if (read.lossy) markers.push('[output truncated by host collection bound]')
  if (record.process.sandbox?.denied === true) {
    markers.push(`[sandbox: file access denied under ${record.process.sandbox.mode} mode]`)
  }
  const output = [read.delta, ...markers].filter(Boolean).join('\n')
  const value = {
    chunk_id: `${record.id}-${++record.chunk}`,
    wall_time_seconds: elapsedMs / 1000,
    original_token_count: approximateTokens(output),
    output: boundedOutput(output, maxOutputTokens),
  }
  if (record.process.status === 'running') return { ...value, session_id: record.id }
  return { ...value, ...(typeof record.process.exitCode === 'number' ? { exit_code: record.process.exitCode } : {}) }
}

async function startPipeExec(ctx, args, exec, policy) {
  const agent = agentOf(exec)
  const id = ++nextExecSessionId
  const process = ctx.shell.start(ctx.shell.resolve({
    command: commandForShell(args),
    workdir: shellWorkdir(agent, args.workdir),
    dshEnv: ctx.shellEnv.collect(exec),
    sandboxPolicy: policy,
  }))
  const record = { kind: 'pipe', id, chunk: 0, owner: agent, process }
  execSessions.set(id, record)
  const startedAt = Date.now()
  try {
    await waitForPipeProcess(process, execYieldTime(args), exec.signal)
    const value = pipeOutput(record, Date.now() - startedAt, args.max_output_tokens)
    if (process.status !== 'running') execSessions.delete(id)
    return value
  } catch (error) {
    await closeExecSession(ctx, record)
    throw error
  }
}

function registerExecCommand(ctx) {
  ctx.systemPrompt.section({
    name: 'tool:exec',
    order: 105,
    text: 'Use exec_command for bounded shell work. Set tty=true only for interactive programs; use write_stdin with a returned session_id to poll or interact.',
  })

  ctx.tools.register(defineTool({
    name: 'exec_command',
    description: 'Runs a command in a PTY, returning output or a session ID for ongoing interaction. `cmd` is a plain shell-command string; the tool-call transport handles JSON quoting, so do not JSON-encode the command a second time.',
    parameters: {
      cmd: { type: 'string', required: true, description: 'Shell command to execute.' },
      workdir: { type: 'string', description: 'Working directory for the command. Defaults to the turn cwd.' },
      tty: { type: 'boolean', description: 'True allocates a PTY for the command; false or omitted uses plain pipes.' },
      yield_time_ms: { type: 'number', description: 'Wait before yielding output. Defaults to 10000 ms; effective range is 250-30000 ms.' },
      max_output_tokens: { type: 'number', description: 'Output token budget. Defaults to 10000 tokens; larger requests may be capped by policy.' },
      shell: { type: 'string', description: "Shell binary to launch. Defaults to the user's default shell." },
      login: { type: 'boolean', description: 'True runs the shell with -l/-i semantics; false disables them. Defaults to true.' },
      sandbox_permissions: {
        type: 'string',
        enum: ['use_default', 'require_escalated'],
        description: 'Per-command sandbox override. Defaults to use_default; use require_escalated for unsandboxed execution.',
      },
      justification: { type: 'string', description: 'User-facing approval question for require_escalated; omit otherwise.' },
      prefix_rule: {
        type: 'array',
        items: { type: 'string' },
        description: 'Reusable approval prefix suggestion for require_escalated. This host displays it but does not persist rules.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          chunk_id: { type: 'string' },
          wall_time_seconds: { type: 'number', required: true },
          output: { type: 'string', required: true },
          exit_code: { type: 'number' },
          session_id: { type: 'number' },
          original_token_count: { type: 'number' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.output }],
      presentationMeta: (_args, value) => ({
        ...(typeof value.exit_code === 'number' ? { exitCode: value.exit_code } : {}),
        ...(value.session_id !== undefined ? { sessionId: value.session_id } : {}),
      }),
    },
    async execute(args, exec) {
      const agent = agentOf(exec)
      if (typeof args.cmd !== 'string' || args.cmd.trim().length === 0) throw new Error('cmd must be a non-empty string')
      if (args.max_output_tokens !== undefined && (!Number.isFinite(args.max_output_tokens) || args.max_output_tokens <= 0)) {
        throw new Error(`invalid max_output_tokens: expected a positive number, got ${String(args.max_output_tokens)}`)
      }
      const policy = await execSandboxPolicy(ctx, args, exec)
      if (args.tty !== true) return startPipeExec(ctx, args, exec, policy)
      const id = ++nextExecSessionId
      const marker = `__DSH_CODEX_EXIT_${id}_${Date.now()}__`
      const command = wrappedCommand(commandForShell(args), marker)
      const spawned = await ctx.terminals.spawn(agent, {
        type: PTY_BACKEND,
        name: `codex-exec-${id}`,
        cwd: shellWorkdir(agent, args.workdir),
        sandboxPolicy: policy,
      }, exec.signal)
      let operation
      try {
        const setup = ctx.terminals.startSend(agent, spawned.sessionId, {
          text: 'stty -echo',
          submit: true,
          signal: exec.signal,
        })
        const setupResult = await setup.done
        setup.readOutput()
        if (setupResult.sessionStatus.kind === 'exited') throw new Error('PTY shell exited while disabling terminal echo')
        operation = ctx.terminals.startSend(agent, spawned.sessionId, {
          text: command,
          submit: true,
          signal: exec.signal,
        })
      } catch (error) {
        await ctx.terminals.kill(agent, spawned.sessionId, 'Codex exec setup failed')
        throw error
      }
      const record = { kind: 'pty', id, chunk: 0, owner: agent, ptyId: spawned.sessionId, operation, echoedInput: command, marker }
      execSessions.set(id, record)
      const startedAt = Date.now()
      try {
        const settled = await waitForTerminalOperation(operation, execYieldTime(args), exec.signal)
        return finishTerminalOperation(ctx, record, operation, startedAt, settled, args.max_output_tokens)
      } catch (error) {
        await closeExecSession(ctx, record)
        throw error
      }
    },
    presentCall(args) {
      return {
        card: 'terminal',
        title: args.cmd,
        ...(args.workdir !== undefined ? { cwd: args.workdir } : {}),
      }
    },
    presentResult(_args, result) {
      if (result.isError) return genericToolError('Command failed', result)
      return { card: 'terminal', output: result.content.filter(block => block.type === 'text').map(block => block.text).join('') }
    },
  }))
}

function registerWriteStdin(ctx) {
  ctx.tools.register(defineTool({
    name: 'write_stdin',
    description: 'Writes characters to an existing unified exec session and returns recent output.',
    parameters: {
      session_id: { type: 'number', required: true, description: 'Identifier of the running unified exec session.' },
      chars: { type: 'string', description: 'Bytes to write to stdin. Defaults to empty, which polls without writing.' },
      yield_time_ms: { type: 'number', description: 'Wait before yielding output. Non-empty writes default to 250 ms and cap at 30000 ms; empty polls wait 5000-300000 ms by default.' },
      max_output_tokens: { type: 'number', description: 'Output token budget. Defaults to 10000 tokens; larger requests may be capped by policy.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          chunk_id: { type: 'string' },
          wall_time_seconds: { type: 'number', required: true },
          output: { type: 'string', required: true },
          exit_code: { type: 'number' },
          session_id: { type: 'number' },
          original_token_count: { type: 'number' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.output }],
    },
    async execute(args, exec) {
      const agent = agentOf(exec)
      if (!Number.isSafeInteger(args.session_id) || args.session_id <= 0) throw new Error('session_id must be a positive integer')
      if (args.max_output_tokens !== undefined && (!Number.isFinite(args.max_output_tokens) || args.max_output_tokens <= 0)) {
        throw new Error(`invalid max_output_tokens: expected a positive number, got ${String(args.max_output_tokens)}`)
      }
      const record = execSessions.get(args.session_id)
      if (record === undefined || record.owner !== agent) throw new Error(`unknown exec session ${String(args.session_id)}`)
      const chars = args.chars ?? ''
      if (typeof chars !== 'string') throw new Error('chars must be a string')
      const startedAt = Date.now()
      if (record.kind === 'pipe') {
        if (chars !== '') {
          if (chars === '\u0003') record.process.kill()
          else throw new Error('stdin is closed for a non-TTY exec session; use tty=true for interactive input')
        }
        await waitForPipeProcess(record.process, stdinYieldTime(chars, args.yield_time_ms), exec.signal)
        const value = pipeOutput(record, Date.now() - startedAt, args.max_output_tokens)
        if (record.process.status !== 'running') execSessions.delete(record.id)
        return value
      }
      if (record.operation !== undefined) {
        const operation = record.operation
        const settled = await waitForTerminalOperation(operation, stdinYieldTime(chars, args.yield_time_ms), exec.signal)
        const value = await finishTerminalOperation(ctx, record, operation, startedAt, settled, args.max_output_tokens)
        if (!execSessions.has(args.session_id) || settled.kind === 'yield' || chars === '' || record.operation !== undefined) return value
      }
      const operation = ctx.terminals.startSend(agent, record.ptyId, {
        text: chars,
        submit: false,
        signal: exec.signal,
      })
      record.operation = operation
      record.echoedInput = chars
      const settled = await waitForTerminalOperation(operation, stdinYieldTime(chars, args.yield_time_ms), exec.signal)
      return finishTerminalOperation(ctx, record, operation, startedAt, settled, args.max_output_tokens)
    },
    presentCall(args) {
      return { card: 'terminal', title: args.chars || '(poll session)', description: `Session ${args.session_id}` }
    },
    presentResult(_args, result) {
      if (result.isError) return genericToolError('Terminal session failed', result)
      return { card: 'terminal', output: result.content.filter(block => block.type === 'text').map(block => block.text).join('') }
    },
  }))
}

function waitOutputText(value) {
  const output = typeof value?.output === 'string' && value.output.length > 0 ? value.output : '(no output)'
  const markers = []
  if (typeof value?.exit_code === 'number') markers.push(`[exit code: ${value.exit_code}]`)
  if (value?.session_id !== undefined) markers.push(`[session ID: ${value.session_id}]`)
  return markers.length === 0 ? output : `${output}\n${markers.join('\n')}`
}

/**
 * Codex exposes `wait` beside Code Mode `exec`. DSH has no resumable V8 cell
 * runtime, so this preset-scoped adapter accepts the official schema and maps
 * a cell_id to the string form of a local unified-exec session_id. That keeps
 * the direct model surface useful without changing the host scheduler.
 */
function registerWait(ctx) {
  // Do not reuse write_stdin.output.schema here. Once a tool is registered,
  // dsh stores the compiled JSON Schema there, while defineTool expects the
  // author-facing ValueSchemaSpec. Keeping a fresh, permissive result shape
  // also makes this adapter work when write_stdin is supplied by another
  // preset-scoped composition.
  const outputSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      chunk_id: { type: 'string' },
      wall_time_seconds: { type: 'number' },
      output: { type: 'string' },
      exit_code: { type: 'number' },
      session_id: { type: 'number' },
      original_token_count: { type: 'number' },
    },
  }
  ctx.tools.register(defineTool({
    name: 'wait',
    description: 'Waits on a yielded `exec` cell and returns new output or completion.\n- Use `wait` only after `exec` returns `Script running with cell ID ...`.\n- `cell_id` identifies the running `exec` cell to resume.\n- `yield_time_ms` controls how long to wait for output. Defaults to 10000 ms.\n- `max_tokens` limits how much new output this wait call returns. Defaults to 10000 tokens.\n- `terminate: true` stops the running `exec` cell; false or omitted waits for output.\n- `wait` returns only the new output since the last yield, or the final completion or termination result for that cell.\n- If the cell is still running, `wait` may yield again with the same `cell_id`.\n- If the cell has already finished, the completed result is returned and the cell closes.',
    parameters: {
      cell_id: { type: 'string', required: true, description: 'Identifier of the running exec cell.' },
      yield_time_ms: { type: 'number', description: 'Wait before yielding more output. Defaults to 10000 ms.' },
      max_tokens: { type: 'number', description: 'Output token budget for this wait call. Defaults to 10000 tokens.' },
      terminate: { type: 'boolean', description: 'True stops the running exec cell; false or omitted waits for output.' },
    },
    output: {
      schema: outputSchema,
      render: (_args, value) => [{ type: 'text', text: waitOutputText(value) }],
    },
    async execute(args, execution) {
      const sessionId = Number(args.cell_id)
      if (!Number.isSafeInteger(sessionId) || sessionId <= 0) {
        throw new Error('wait compatibility adapter expects cell_id to be a numeric unified-exec session ID')
      }
      if (args.max_tokens !== undefined && (!Number.isFinite(args.max_tokens) || args.max_tokens <= 0)) {
        throw new Error(`invalid max_tokens: expected a positive number, got ${String(args.max_tokens)}`)
      }
      const result = await ctx.tools.execute({
        callId: execution.callId + ':write_stdin',
        rootCallId: execution.rootCallId ?? execution.callId,
        name: 'write_stdin',
        arguments: {
          session_id: sessionId,
          chars: args.terminate === true ? '\u0003' : '',
          yield_time_ms: args.yield_time_ms ?? 10_000,
          ...(args.max_tokens === undefined ? {} : { max_output_tokens: args.max_tokens }),
        },
        agent: execution.agent,
        parent: execution.token,
        signal: execution.signal,
      })
      if (result.isError) {
        throw new Error(result.content.filter(block => block.type === 'text').map(block => block.text).join('\n') || 'wait failed')
      }
      if (result.value === undefined) throw new Error('wait returned no result')
      return result.value
    },
    presentCall(args) {
      return { card: 'generic', title: `Wait on exec cell ${args.cell_id}`, kind: 'other' }
    },
    presentResult(_args, result) {
      if (result.isError) return genericToolError('Wait failed', result)
      return { card: 'terminal', output: result.content.filter(block => block.type === 'text').map(block => block.text).join('') }
    },
  }))
}

function patchPath(header) {
  const normalized = String(header).trim()
  const match = /^\*\*\* (?:Update|Add|Delete) File:\s*(.*?)\s*$/.exec(normalized)
  if (match === null || match[1].trim() === '') throw new Error('unsupported apply_patch header: ' + String(header))
  return match[1].trim()
}

function patchControlLine(line) {
  return String(line).trim()
}

function isHunkHeader(line) {
  const normalized = patchControlLine(line)
  return normalized === '@@' || normalized.startsWith('@@ ')
}

function isPatchLine(line) {
  return line === '' || [' ', '+', '-'].includes(line[0])
}

function normalizedMatchLine(value, mode) {
  const text = String(value)
  if (mode === 'rstrip') return text.trimEnd()
  if (mode === 'trim') return text.trim()
  if (mode !== 'unicode') return text
  return text.trim().replace(/[\u2010-\u2015\u2212\u2018-\u201b\u201c-\u201f\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, character => {
    if ('‐‑‒–—―−'.includes(character)) return '-'
    if ('‘’‚‛'.includes(character)) return String.fromCharCode(39)
    if ('“”„‟'.includes(character)) return String.fromCharCode(34)
    return ' '
  })
}

function findBlock(lines, needle, start = 0, endOfFile = false) {
  if (needle.length === 0) return endOfFile ? lines.length : Math.min(start, lines.length)
  if (needle.length > lines.length) return -1
  const first = Math.max(0, start)
  const last = lines.length - needle.length
  if (first > last) return -1
  const starts = []
  if (endOfFile) starts.push(Math.max(first, last))
  for (let index = first; index <= last; index++) {
    if (!starts.includes(index)) starts.push(index)
  }
  for (const mode of ['exact', 'rstrip', 'trim', 'unicode']) {
    for (const index of starts) {
      if (needle.every((line, offset) => normalizedMatchLine(lines[index + offset], mode) === normalizedMatchLine(line, mode))) return index
    }
  }
  return -1
}

function splitSourceLines(text) {
  const value = String(text)
  const lines = []
  let preferredEnding
  let start = 0
  let cursor = 0
  while (cursor < value.length) {
    const character = value[cursor]
    let ending
    if (character === '\r') ending = value[cursor + 1] === '\n' ? '\r\n' : '\r'
    else if (character === '\n') ending = '\n'
    if (ending === undefined) {
      cursor++
      continue
    }
    lines.push({ text: value.slice(start, cursor), ending })
    preferredEnding ??= ending
    cursor += ending.length
    start = cursor
  }
  if (start < value.length) lines.push({ text: value.slice(start), ending: '' })
  return { lines, preferredEnding: preferredEnding ?? '\n' }
}

function applyHunks(original, patchLines, path) {
  const source = splitSourceLines(original)
  const lines = source.lines.slice()
  let cursor = 0
  let searchFrom = 0
  let changed = false
  while (cursor < patchLines.length) {
    const first = patchLines[cursor]
    if (patchControlLine(first) === '*** End of File') {
      cursor++
      continue
    }
    let context
    if (isHunkHeader(first)) {
      const normalized = patchControlLine(first)
      const suffix = normalized.slice(2).trim()
      if (suffix !== '' && !/^-[0-9].*\+[0-9]/.test(suffix)) context = suffix
      cursor++
    } else if (!isPatchLine(first)) {
      cursor++
      continue
    }
    const hunk = []
    let endOfFile = false
    while (cursor < patchLines.length) {
      const line = patchLines[cursor]
      const control = patchControlLine(line)
      if (isHunkHeader(line)) break
      if (control === '*** End of File') {
        endOfFile = true
        cursor++
        continue
      }
      if (!isPatchLine(line)) throw new Error('invalid apply_patch hunk for ' + path)
      hunk.push(line)
      cursor++
    }
    if (hunk.length === 0) throw new Error('apply_patch contained an empty hunk for ' + path)
    const oldLines = hunk.filter(line => line === '' || line[0] !== '+').map(line => line === '' ? '' : line.slice(1))
    let anchorStart = searchFrom
    if (context !== undefined) {
      const contextIndex = findBlock(lines.map(line => line.text), [context], searchFrom)
      if (contextIndex < 0) throw new Error('apply_patch context did not match ' + path + ': ' + context)
      anchorStart = contextIndex + 1
    }
    const insertionAtEnd = oldLines.length === 0 && context === undefined
    const index = findBlock(lines.map(line => line.text), oldLines, anchorStart, endOfFile || insertionAtEnd)
    if (index < 0) throw new Error('apply_patch context did not match ' + path)
    const replacement = []
    let oldOffset = 0
    for (const line of hunk) {
      if (line === '' || line[0] === ' ') {
        const originalLine = lines[index + oldOffset]
        if (originalLine === undefined) throw new Error('apply_patch context did not match ' + path)
        replacement.push(originalLine)
        oldOffset++
      } else if (line[0] === '-') {
        oldOffset++
      } else {
        replacement.push({ text: line.slice(1), ending: source.preferredEnding })
      }
    }
    lines.splice(index, oldLines.length, ...replacement)
    searchFrom = index + replacement.length
    changed = true
  }
  if (!changed) throw new Error('apply_patch contained no hunks for ' + path)
  for (const line of lines) line.ending ||= source.preferredEnding
  return lines.map(line => line.text + line.ending).join('')
}

/** Match dsh-tool-fs: one three-line-context FileDiff per applied hunk. */
function computeHunkDiffs(path, before, after) {
  const patch = structuredPatch('', '', before, after, undefined, undefined, { context: 3 })
  const diffs = []
  for (const hunk of patch.hunks) {
    const oldLines = []
    const newLines = []
    for (const line of hunk.lines) {
      if (line.startsWith('\\')) continue
      const text = line.slice(1)
      if (line.startsWith('-')) oldLines.push(text)
      else if (line.startsWith('+')) newLines.push(text)
      else {
        oldLines.push(text)
        newLines.push(text)
      }
    }
    diffs.push({
      path,
      oldText: oldLines.length > 0 ? oldLines.join('\n') : null,
      newText: newLines.join('\n'),
      oldStart: hunk.oldStart,
      oldLines: hunk.oldLines,
      newStart: hunk.newStart,
      newLines: hunk.newLines,
      lines: hunk.lines,
    })
  }
  return diffs
}

function lineCount(text) {
  const value = String(text)
  if (value === '') return 0
  const lines = value.split('\n')
  return lines.at(-1) === '' ? lines.length - 1 : lines.length
}

function diffHeader(oldStart, oldLines, newStart, newLines) {
  return '@@ -' + String(oldStart) + ',' + String(oldLines)
    + ' +' + String(newStart) + ',' + String(newLines) + ' @@'
}

function diffStats(diff) {
  if (diff.oldText === null) return { added: lineCount(diff.newText), removed: 0 }
  if (Array.isArray(diff.lines)) {
    return diff.lines.reduce((stats, line) => {
      if (line.startsWith('+')) stats.added++
      else if (line.startsWith('-')) stats.removed++
      return stats
    }, { added: 0, removed: 0 })
  }
  const patch = structuredPatch('', '', diff.oldText, diff.newText, undefined, undefined, { context: 3 })
  return patch.hunks.reduce((stats, hunk) => {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) stats.added++
      else if (line.startsWith('-')) stats.removed++
    }
    return stats
  }, { added: 0, removed: 0 })
}

function renderDiffHunk(diff) {
  const oldText = diff.oldText
  const fallbackPatch = oldText === null
    ? undefined
    : structuredPatch('', '', oldText, diff.newText, undefined, undefined, { context: 3 })
  const fallbackHunk = fallbackPatch?.hunks[0]
  const oldStart = Number.isInteger(diff.oldStart) ? diff.oldStart : (fallbackHunk?.oldStart ?? 0)
  const oldLines = Number.isInteger(diff.oldLines) ? diff.oldLines : (fallbackHunk?.oldLines ?? 0)
  const newStart = Number.isInteger(diff.newStart) ? diff.newStart : (fallbackHunk?.newStart ?? 1)
  const newLines = Number.isInteger(diff.newLines) ? diff.newLines : (fallbackHunk?.newLines ?? lineCount(diff.newText))
  const header = diffHeader(oldStart, oldLines, newStart, newLines)
  if (oldText === null) {
    const added = diff.newText === '' ? [] : diff.newText.split('\n')
    if (added.at(-1) === '') added.pop()
    return [header, ...added.map(line => '+ ' + line)]
  }
  const hunks = Array.isArray(diff.lines)
    ? [{ oldStart, oldLines, newStart, newLines, lines: diff.lines }]
    : (fallbackPatch?.hunks ?? [])
  if (hunks.length === 0) return [header]
  return hunks.flatMap((hunk, index) => {
    const lines = hunk.lines
      .filter(line => !line.startsWith(String.fromCharCode(92)))
      .map(line => line[0] + ' ' + line.slice(1))
    return [index === 0 ? header : diffHeader(hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines), ...lines]
  })
}

function patchOperationLabel(operation) {
  switch (operation) {
    case 'add': return 'Added'
    case 'delete': return 'Deleted'
    case 'move': return 'Moved'
    default: return 'Updated'
  }
}

function patchResultText(value) {
  const files = Array.isArray(value.files) ? value.files : []
  const diffs = Array.isArray(value.diffs) ? value.diffs : []
  const stats = diffs.reduce((total, diff) => {
    const current = diffStats(diff)
    return { added: total.added + current.added, removed: total.removed + current.removed }
  }, { added: 0, removed: 0 })
  const lines = [
    'Patch applied successfully.',
    'Summary: ' + String(files.length) + ' file(s), +' + String(stats.added) + ' line(s), -' + String(stats.removed) + ' line(s).',
    '',
    'Files:',
    ...(files.length === 0 ? ['(none)'] : files.map(file => {
      const fileStats = diffs
        .filter(diff => diff.path === file.path)
        .reduce((total, diff) => {
          const current = diffStats(diff)
          return { added: total.added + current.added, removed: total.removed + current.removed }
        }, { added: 0, removed: 0 })
      return '- ' + patchOperationLabel(file.operation) + ': ' + file.path
        + ' (+' + String(fileStats.added) + '/-' + String(fileStats.removed) + ')'
    })),
  ]
  if (diffs.length === 0) return lines.join('\n')
  lines.push('', 'Changes:')
  for (const diff of diffs) {
    lines.push('', 'File: ' + diff.path, ...renderDiffHunk(diff))
  }
  return lines.join('\n')
}

/** Build a pure approval-time preview from the patch text itself. */
/** Strip the exact wrapper used by the upstream freeform apply_patch tool. */
function patchBody(patch) {
  let lines = String(patch).replace(/\r\n?/g, '\n').trim().split('\n')
  const heredoc = /^(?:apply_patch\s+)?<<(?:EOF|'EOF'|"EOF")$/.test(lines[0]?.trim() ?? '')
  if (heredoc && lines.length >= 4 && lines.at(-1).trim() === 'EOF') lines = lines.slice(1, -1).join('\n').trim().split('\n')
  if (lines.length < 2 || lines[0].trim() !== '*** Begin Patch') throw new Error('apply_patch must start with "*** Begin Patch"')
  if (lines.at(-1).trim() !== '*** End Patch') throw new Error('apply_patch must end with "*** End Patch"')
  return lines.slice(1, -1).join('\n')
}

function parsePatchOperations(patch) {
  const lines = patchBody(patch).split('\n')
  const operations = []
  let cursor = 0
  while (cursor < lines.length) {
    const header = lines[cursor]
    const normalizedHeader = patchControlLine(header)
    if (normalizedHeader === '') {
      cursor++
      continue
    }
    if (normalizedHeader.startsWith('*** Environment ID:')) {
      if (normalizedHeader.slice('*** Environment ID:'.length).trim() === '') throw new Error('apply_patch environment_id cannot be empty')
      cursor++
      continue
    }
    if (normalizedHeader === '*** End of File') {
      cursor++
      continue
    }
    const headerMatch = /^\*\*\* (Update|Add|Delete) File:\s*(.*?)\s*$/.exec(normalizedHeader)
    if (headerMatch === null) throw new Error('unsupported apply_patch hunk header: ' + header)
    const path = patchPath(normalizedHeader)
    const kind = headerMatch[1] === 'Add' ? 'add' : headerMatch[1] === 'Delete' ? 'delete' : 'update'
    cursor++
    let moveTo
    const moveHeader = cursor < lines.length ? patchControlLine(lines[cursor]) : ''
    const moveMatch = /^\*\*\* Move to:\s*(.*?)\s*$/.exec(moveHeader)
    if (moveMatch !== null) {
      if (kind !== 'update') throw new Error('apply_patch Move to is only valid after Update File: ' + path)
      moveTo = moveMatch[1].trim()
      if (moveTo === '') throw new Error('apply_patch move destination is empty for ' + path)
      cursor++
    }
    const body = []
    while (cursor < lines.length) {
      const line = lines[cursor]
      const control = patchControlLine(line)
      if (control === '*** End of File') {
        body.push(control)
        cursor++
        continue
      }
      if (/^\*\*\* (?:Update|Add|Delete) File:\s*/.test(control) || control.startsWith('*** Environment ID:') || control.startsWith('*** Move to:')) break
      body.push(line)
      cursor++
    }
    operations.push({ kind, path, moveTo, body })
  }
  return operations
}

function previewPatchDiffs(patch) {
  const diffs = []
  for (const operation of parsePatchOperations(patch)) {
    if (operation.kind === 'add') {
      const newText = operation.body.filter(line => line.startsWith('+')).map(line => line.slice(1)).join('\n') + '\n'
      diffs.push({ path: operation.path, oldText: null, newText })
      continue
    }
    if (operation.kind === 'delete') {
      diffs.push({ path: operation.path, oldText: null, newText: '' })
      continue
    }
    const hunks = []
    let hunk = []
    for (const line of operation.body) {
      if (isHunkHeader(line)) {
        if (hunk.length > 0) hunks.push(hunk)
        hunk = []
        continue
      }
      if (patchControlLine(line) === '*** End of File') continue
      if (isPatchLine(line)) hunk.push(line)
    }
    if (hunk.length > 0) hunks.push(hunk)
    for (const lines of hunks) {
      const oldLines = lines.filter(line => line === '' || line[0] !== '+').map(line => line === '' ? '' : line.slice(1))
      const newLines = lines.filter(line => line === '' || line[0] !== '-').map(line => line === '' ? '' : line.slice(1))
      diffs.push({
        path: operation.moveTo ?? operation.path,
        oldText: oldLines.length > 0 ? oldLines.join('\n') : null,
        newText: newLines.join('\n'),
      })
    }
  }
  return diffs
}

async function writePatchedFile(ctx, exec, target, content, expectedVersion, sandboxPolicy) {
  const intent = await ctx.waterfall('fs/write-intent', target, exec, () => (
    expectedVersion === undefined ? undefined : { version: expectedVersion }
  ))
  const outcome = await ctx.fs.writeText(target, content, intent, exec.signal, sandboxPolicy)
  ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec)
  return { path: target.displayPath, operation: outcome.operation }
}

async function preflightPatch(ctx, exec, patch) {
  const agent = agentOf(exec)
  const operations = parsePatchOperations(patch)
  const prepared = []
  for (const operation of operations) {
    const target = await ctx.fs.resolve(operation.path, { cwd: cwdOf(agent), signal: exec.signal })
    if (operation.kind === 'add') {
      if (operation.body.length === 0 || operation.body.some(line => patchControlLine(line) === '*** End of File' || !line.startsWith('+'))) {
        throw new Error('invalid apply_patch Add File body for ' + operation.path)
      }
      const content = operation.body.map(line => line.slice(1)).join('\n') + '\n'
      prepared.push({ ...operation, target, content })
      continue
    }
    const info = await ctx.fs.stat(target, exec.signal)
    if (info === undefined || info.type !== 'file') {
      throw new Error(`apply_patch target is not a regular file: ${operation.path}`)
    }
    const original = await ctx.fs.readText(target, exec.signal)
    ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)
    if (operation.kind === 'delete') {
      if (operation.body.some(line => line.trim() !== '' && patchControlLine(line) !== '*** End of File')) {
        throw new Error('invalid apply_patch Delete File body for ' + operation.path)
      }
      prepared.push({ ...operation, target, info, original })
      continue
    }
    const content = applyHunks(original, operation.body, target.displayPath)
    const destination = operation.moveTo === undefined
      ? undefined
      : await ctx.fs.resolve(operation.moveTo, { cwd: cwdOf(agent), signal: exec.signal })
    prepared.push({ ...operation, target, destination, info, original, content })
  }
  return prepared
}

async function applyPatch(ctx, exec, patch) {
  const operations = await preflightPatch(ctx, exec, patch)
  if (operations.length === 0) return { files: [], diffs: [] }
  const policyTargets = operations.flatMap(operation => [
    operation.target,
    ...(operation.destination === undefined ? [] : [operation.destination]),
  ])
  const sandboxPolicy = await patchSandboxPolicy(ctx, exec, policyTargets)
  const results = []
  const diffs = []
  for (const operation of operations) {
    if (operation.kind === 'add') {
      results.push(await writePatchedFile(ctx, exec, operation.target, operation.content, undefined, sandboxPolicy))
      diffs.push({
        path: operation.target.displayPath,
        oldText: null,
        newText: operation.content,
        oldStart: 0,
        oldLines: 0,
        newStart: 1,
        newLines: lineCount(operation.content),
        lines: (operation.content === '' ? [] : operation.content.split('\n'))
          .filter((line, index, all) => !(index === all.length - 1 && line === ''))
          .map(line => '+ ' + line),
      })
      continue
    }
    if (operation.kind === 'delete') {
      await ctx.fs.deleteFile(operation.target, { version: operation.info.version }, exec.signal, sandboxPolicy)
      ctx.emit('fs/observed', operation.target, { kind: 'absent' }, exec)
      results.push({ path: operation.target.displayPath, operation: 'delete' })
      diffs.push({
        path: operation.target.displayPath,
        oldText: operation.original,
        newText: '',
        oldStart: 1,
        oldLines: lineCount(operation.original),
        newStart: 0,
        newLines: 0,
        lines: (operation.original === '' ? [] : operation.original.split('\n'))
          .filter((line, index, all) => !(index === all.length - 1 && line === ''))
          .map(line => '- ' + line),
      })
      continue
    }
    const written = await writePatchedFile(
      ctx, exec, operation.target, operation.content, operation.info.version, sandboxPolicy,
    )
    diffs.push(...computeHunkDiffs(
      operation.destination?.displayPath ?? operation.target.displayPath,
      operation.original,
      operation.content,
    ))
    if (operation.destination === undefined) {
      results.push(written)
      continue
    }
    const movedInfo = await ctx.fs.stat(operation.target, exec.signal)
    if (movedInfo === undefined) throw new Error(`apply_patch move source disappeared: ${operation.path}`)
    const outcome = await ctx.fs.moveFile(
      operation.target, operation.destination, { version: movedInfo.version }, exec.signal, sandboxPolicy,
    )
    ctx.emit('fs/observed', operation.target, { kind: 'absent' }, exec)
    ctx.emit('fs/observed', operation.destination, { kind: 'present', version: outcome.version }, exec)
    results.push({ path: operation.destination.displayPath, operation: 'move' })
  }
  return { files: results, diffs }
}

function registerApplyPatch(ctx) {
  ctx.tools.register(defineTool({
    name: 'apply_patch',
    description: 'The `apply_patch` tool can be used to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON or add a second JSON encoding. Because dsh currently exposes function tools only, pass the exact freeform patch as the required input string property. Add, Delete, Update, and Move operations are supported; relative paths resolve from the turn cwd and absolute paths are accepted.',
    parameters: { input: { type: 'string', required: true, description: 'The exact free-form patch text, including *** Begin Patch and *** End Patch.' } },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          files: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                operation: { type: 'string', required: true },
              },
            },
          },
          diffs: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                oldText: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
                newText: { type: 'string', required: true },
                oldStart: { type: 'integer' },
                oldLines: { type: 'integer' },
                newStart: { type: 'integer' },
                newLines: { type: 'integer' },
                lines: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: patchResultText(value) }],
      presentationMeta: (_args, value) => ({ diffs: value.diffs }),
    },
    async execute(args, exec) {
      return applyPatch(ctx, exec, args.input)
    },
    presentCall(args) {
      let diffs
      try {
        diffs = previewPatchDiffs(args.input)
      } catch (error) {
        // A malformed/absolute patch path must remain a tool error, but the
        // UI still needs the authored patch text instead of raw JSON while it
        // is reporting that error.
        return {
          card: 'generic',
          title: 'Apply patch',
          kind: 'edit',
          rawInput: args.input,
          content: [{ type: 'text', text: `Patch preview unavailable: ${String(error)}` }],
        }
      }
      if (diffs.length === 0) return { card: 'generic', title: 'Apply patch', kind: 'edit' }
      const locations = [...new Set(diffs.map(diff => diff.path))].map(path => ({ path }))
      return {
        card: 'diff',
        title: locations.length === 1 ? `Apply patch — ${locations[0].path}` : `Apply patch — ${locations.length} files`,
        diffs,
        locations,
      }
    },
    presentResult(args, result) {
      if (result.isError) return genericToolError('Patch failed', result)
      // A nested Code Mode result carries content/isError but not the native
      // tool/result metadata envelope. Rebuild the same exact preview from
      // the freeform input so the Web/Trajectory cards still show +/- lines.
      const preview = previewPatchDiffs(args.input)
      const diffs = narrowDiffs(result.meta) ?? (preview.length > 0 ? preview : undefined)
      return diffs === undefined ? undefined : { card: 'diff', title: 'Patch applied', diffs }
    },
  }))
}

function narrowDiffs(meta) {
  if (typeof meta !== 'object' || meta === null) return undefined
  const diffs = meta.diffs
  if (!Array.isArray(diffs) || diffs.length === 0) return undefined
  const valid = diffs.every(diff => (
    typeof diff === 'object' && diff !== null
    && typeof diff.path === 'string'
    && typeof diff.newText === 'string'
    && (diff.oldText === null || typeof diff.oldText === 'string')
    && (diff.oldStart === undefined || Number.isInteger(diff.oldStart))
    && (diff.oldLines === undefined || Number.isInteger(diff.oldLines))
    && (diff.newStart === undefined || Number.isInteger(diff.newStart))
    && (diff.newLines === undefined || Number.isInteger(diff.newLines))
    && (diff.lines === undefined || (Array.isArray(diff.lines) && diff.lines.every(line => typeof line === 'string')))
  ))
  return valid ? diffs : undefined
}

function registerViewImage(ctx) {
  ctx.tools.register(defineTool({
    name: 'view_image',
    description: 'View a local image file from the filesystem when visual inspection is needed. Use this for images already available on disk.',
    parameters: {
      path: { type: 'string', required: true, description: 'Local filesystem path to an image file.' },
      detail: { type: 'string', enum: ['high', 'original'], description: 'Image detail level. Defaults to high; use original to preserve exact resolution.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          detail: { type: 'string', required: true, enum: ['high', 'original'] },
          image: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              attachmentId: { type: 'string', required: true },
              mediaType: { type: 'string', required: true },
              bytes: { type: 'integer', required: true },
              width: { type: 'integer', required: true },
              height: { type: 'integer', required: true },
              name: { type: 'string' },
            },
          },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: `<path>${value.path}</path>\n<type>image</type>` },
        { type: 'image', attachment: value.image },
      ],
    },
    async execute(args, exec) {
      const agent = agentOf(exec)
      const extension = args.path.slice(args.path.lastIndexOf('.')).toLowerCase()
      const mediaType = IMAGE_EXTENSIONS[extension]
      if (mediaType === undefined) throw new Error(`view_image only accepts PNG/JPEG/WebP/GIF paths: ${args.path}`)
      const attachments = ctx.get('attachments')
      if (attachments === undefined) throw new Error('view_image requires a durable attachment service')
      const target = await ctx.fs.resolve(args.path, { cwd: cwdOf(agent), signal: exec.signal })
      const bytes = await ctx.fs.readBytes(target, exec.signal, Math.min(
        attachments.imageLimits.maxImageBytes,
        attachments.imageLimits.maxMessageImageBytes,
      ))
      const ref = await attachments.saveImage({ data: bytes, mediaType, name: target.displayPath.split('/').at(-1) })
      return { path: target.displayPath, detail: args.detail ?? 'high', image: ref }
    },
    presentCall(args) {
      return { card: 'generic', title: `View image ${args.path}`, kind: 'read', locations: [{ path: args.path }] }
    },
    presentResult(args, result) {
      if (result.isError) return genericToolError(`View image failed — ${args.path}`, result)
      const content = result.content.filter(block => block.type === 'text' || block.type === 'image')
      return { card: 'generic', title: `View image ${args.path}`, content: content.length > 0 ? content : undefined }
    },
  }))
}

function registerPlan(ctx) {
  ctx.tools.register(defineTool({
    name: 'update_plan',
    // Upstream text: codex-rs/core/src/tools/handlers/plan_spec.rs.
    description: 'Updates the task plan.\nProvide an optional explanation and a list of plan items, each with a step and status.\nAt most one step can be in_progress at a time.',
    parameters: {
      explanation: { type: 'string', description: 'Optional explanation for this plan update.' },
      plan: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            step: { type: 'string', required: true, description: 'Task step text.' },
            status: { type: 'string', required: true, enum: ['pending', 'in_progress', 'completed'], description: 'Step status.' },
          },
        },
      },
    },
    output: textOutput,
    async execute(args, exec) {
      const agent = agentOf(exec)
      if (ctx.get('planMode')?.get(agent)?.active === true) {
        throw new Error('update_plan is a TODO/checklist tool and is not allowed in Plan mode')
      }
      const active = args.plan.filter(item => item.status === 'in_progress')
      if (active.length > 1) throw new Error('at most one plan item may be in_progress')
      const todos = args.plan.map(item => ({ content: item.step, status: item.status }))
      agent.session.append('todo/write', { todos })
      return 'Plan updated'
    },
    presentCall(args) {
      const active = args.plan.find(item => item.status === 'in_progress')
      return {
        card: 'generic',
        title: active ? `Update plan — ${active.step}` : 'Update plan',
        kind: 'other',
        content: [{ type: 'text', text: args.plan.map(item => `- [${item.status}] ${item.step}`).join('\n') }],
      }
    },
    presentResult(_args, result) {
      if (result.isError) return genericToolError('Plan update failed', result)
      return { card: 'generic', title: 'Plan updated', content: result.content }
    },
  }))
}

function registerQuestions(ctx) {
  function normalizeQuestionResponse(value) {
    if (value === null || typeof value !== 'object' || !Array.isArray(value.answers)) {
      throw new Error('request_user_input returned an invalid answer payload')
    }
    const answers = {}
    for (const answer of value.answers) {
      if (answer === null || typeof answer !== 'object' || typeof answer.id !== 'string' || !Array.isArray(answer.selected)) {
        throw new Error('request_user_input returned an invalid answer item')
      }
      const selected = answer.selected.filter(item => typeof item === 'string')
      if (answer.custom !== undefined) selected.push(String(answer.custom))
      answers[answer.id] = { answers: selected }
    }
    return { answers }
  }

  const questionOutput = {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: { answers: { type: 'json', required: true } },
    },
    render: (_args, value) => {
      const answers = value && typeof value === 'object' && value.answers && typeof value.answers === 'object'
        ? value.answers
        : {}
      const rows = Object.entries(answers).map(([id, answer]) => {
        const selected = answer && Array.isArray(answer.answers) ? answer.answers : []
        return '- ' + id + ': ' + (selected.length > 0 ? selected.join(', ') : '(no selection)')
      })
      return [{ type: 'text', text: rows.length > 0 ? rows.join('\n') : 'No answers returned.' }]
    },
  }

  ctx.tools.register(defineTool({
    name: 'request_user_input',
    description: 'Request user input for one to three short questions and wait for the response. This tool is only available in Plan mode.',
    parameters: {
      questions: {
        type: 'array',
        required: true,
        // Upstream text: codex-rs/core/src/tools/handlers/request_user_input_spec.rs.
        description: 'Questions to show the user. Prefer 1 and do not exceed 3',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true, description: 'Stable identifier for mapping answers (snake_case).' },
            header: { type: 'string', required: true, description: 'Short header label shown in the UI (12 or fewer chars).' },
            question: { type: 'string', required: true, description: 'Single-sentence prompt shown to the user.' },
            options: {
              type: 'array',
              required: true,
              description: 'Provide 2-3 mutually exclusive choices. Put the recommended option first and suffix its label with "(Recommended)". Do not include an Other option.',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  label: { type: 'string', required: true, description: 'User-facing label (1-5 words).' },
                  description: { type: 'string', required: true, description: 'One short sentence explaining impact/tradeoff if selected.' },
                },
              },
            },
          },
        },
      },
    },
    output: questionOutput,
    async execute(args, exec) {
      const agent = agentOf(exec)
      if (ctx.get('planMode')?.get(agent)?.active !== true) {
        throw new Error('request_user_input is unavailable in Default mode')
      }
      if (args.questions.length < 1 || args.questions.length > 3) {
        throw new Error('request_user_input requires one to three questions')
      }
      if (args.questions.some(question => question.options.length < 2 || question.options.length > 3)) {
        throw new Error('request_user_input requires two to three options for every question')
      }
      const value = await ctx.userQuestions.ask({
        questions: args.questions.map(question => ({
          id: question.id,
          header: question.header,
          question: question.question,
          isOther: true,
          options: question.options.map(option => ({ label: option.label, description: option.description })),
        })),
        agent,
        signal: exec.signal,
      })
      return normalizeQuestionResponse(value)
    },
    presentCall(args) {
      return {
        card: 'generic',
        title: `Ask user${args.questions.length > 1 ? ` (${args.questions.length} questions)` : ''}`,
        kind: 'other',
        content: args.questions.map(question => ({
          type: 'text',
          text: `**${question.header}** — ${question.question}\n  ${question.options.map(option => option.label).join(' / ')}`,
        })),
      }
    },
    presentResult(_args, result) {
      if (result.isError) return genericToolError('User input failed', result)
      return { card: 'generic', title: 'User answered', content: result.content }
    },
  }))
}

function agentStatusSchema() {
  return {
    oneOf: [
      { type: 'string', enum: ['pending_init', 'running', 'interrupted', 'shutdown', 'not_found'] },
      {
        type: 'object',
        additionalProperties: false,
        properties: { completed: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] } },
      },
      {
        type: 'object',
        additionalProperties: false,
        properties: { errored: { type: 'string', required: true } },
      },
    ],
  }
}

function statusOf(ctx, id, known = false) {
  const child = ctx.agents.get(id)
  if (child === undefined) return known ? { completed: null } : 'not_found'
  return child.status === 'running' ? 'running' : { completed: null }
}

function sourceFor(parent) {
  return { kind: 'coordinator', form: 'relay', senderSessionId: parent.session.id }
}

async function directChildren(ctx, parent, signal) {
  const rows = await ctx.subagents.listChildren(parent.session.id, signal)
  return rows.filter(row => row.kind === 'child' && row.mode === 'continuable')
}

function renderJsonOutput(title) {
  return {
    render: (_args, value) => [{ type: 'text', text: humanizeValue(value, title) }],
  }
}

async function waitForIdle(ctx, target, signal) {
  const child = ctx.agents.get(target)
  if (child === undefined || child.status === 'idle') return target
  await child.whenIdle()
  if (signal.aborted) throw new Error('tool call aborted')
  return target
}

function timeoutPromise(timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(undefined), timeoutMs)
    const abort = () => {
      clearTimeout(timer)
      reject(new Error('tool call aborted'))
    }
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
}

/**
 * Match Codex V1 completion injection: a child report joins the parent's next
 * safe step instead of queueing a separate later parent turn.
 */
function registerReportDelivery(ctx) {
  const reportedChildren = new Set()

  // A resumed activation is a new unit of work: an earlier report must not
  // suppress this activation's fallback settlement notice.
  ctx.on('subagent/start', info => { reportedChildren.delete(info.id) })

  ctx.on('tools/execute', async (exec, next) => {
    if (exec.name !== 'report' || exec.agent?.session.header.parentSession === undefined) return next()
    const output = exec.arguments.output
    if (typeof output !== 'string' || output.trim().length === 0) {
      throw new Error('report output must be a non-empty string')
    }
    const messageId = await ctx.subagents.reportFrom(
      exec.agent,
      [{ type: 'text', text: output }],
      { delivery: 'quiet', signal: exec.signal },
    )
    reportedChildren.add(exec.agent.id)
    return { isError: false, value: { messageId }, content: [] }
  })

  // dsh also emits an unconditional settlement notice. Once a child delivered
  // its explicit final report, remove that redundant pending notice. A child
  // that crashed or never reported keeps the automatic fallback.
  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    const source = message.source
    if (source.kind !== 'subagent-settled') return
    if (!reportedChildren.delete(source.senderSessionId)) return
    agent.inbox.remove(message.id)
  })
}

/** Luna's upstream catalog selects the V1 collaboration surface. */
function registerAgents(ctx) {
  // Codex V1 close/resume semantics over dsh's durable continuable sessions.
  const closedAgents = new Set()
  const settlements = new Map()

  const newSettlement = () => {
    let resolve
    const promise = new Promise(done => { resolve = done })
    return { promise, resolve, end: undefined }
  }
  const settlementFor = id => {
    let settlement = settlements.get(id)
    if (settlement === undefined) {
      settlement = newSettlement()
      settlements.set(id, settlement)
    }
    return settlement
  }
  ctx.on('subagent/start', info => {
    const existing = settlements.get(info.id)
    if (existing === undefined || existing.end !== undefined) settlements.set(info.id, newSettlement())
  })
  ctx.on('subagent/end', info => {
    const settlement = settlementFor(info.id)
    settlement.end = info
    settlement.resolve(info)
  })

  const finalStatus = info => {
    const text = info?.lastAssistantMessage
      ?.filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n')
      .trim() || null
    switch (info?.stopReason) {
      case 'completed': return { completed: text }
      case 'aborted': return 'interrupted'
      case 'error': return { errored: text ?? 'subagent failed' }
      case 'max-tokens': return { errored: text ?? 'subagent reached its token limit' }
      case 'refusal': return { errored: text ?? 'subagent declined the task' }
      default: return undefined
    }
  }
  const visibleStatus = (id, known = false) => {
    if (closedAgents.has(id)) return 'shutdown'
    const settled = finalStatus(settlements.get(id)?.end)
    return settled ?? statusOf(ctx, id, known)
  }
  const waitForFinal = async (id, signal) => {
    const settlement = settlements.get(id)
    if (settlement?.end !== undefined) return id
    if (settlement !== undefined) {
      await settlement.promise
      signal.throwIfAborted()
      return id
    }
    return waitForIdle(ctx, id, signal)
  }

  ctx.tools.register(defineTool({
    name: 'multi_agent_v1__spawn_agent',
    description: SPAWN_AGENT_DESCRIPTION,
    parameters: {
      message: { type: 'string', required: true, description: 'Initial plain-text task for the new agent.' },
      fork_context: { type: 'boolean', description: 'True forks completed parent history; false or omitted starts from only the task.' },
      model: { type: 'string', description: 'Optional model override for the new agent.' },
      reasoning_effort: { type: 'string', description: 'Reasoning effort override for the new agent. Omit to inherit the parent effort.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          agent_id: { type: 'string', required: true },
          nickname: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
        },
      },
      ...renderJsonOutput('Agent spawned'),
    },
    presentCall(args) {
      return genericToolCall('Spawn sub-agent', args.message, 'execute')
    },
    presentResult(_args, result) {
      return genericToolResult('Agent spawned', result)
    },
    async execute(args, exec) {
      const parent = agentOf(exec)
      const provider = args.fork_context === true ? 'fork' : 'spawn'
      if (!ctx.subagents.list().includes(provider)) throw new Error(`subagent provider is unavailable: ${provider}`)
      const agentOptions = {
        ...(args.model !== undefined ? { model: args.model } : {}),
        ...(args.reasoning_effort !== undefined ? { reasoningEffort: args.reasoning_effort } : {}),
      }
      const child = await ctx.subagents.startContinuable({
        provider,
        label: args.message.trim().slice(0, 80) || 'subagent',
        request: {
          parent,
          prompt: [{ type: 'text', text: args.message }],
          ...(Object.keys(agentOptions).length > 0 ? { agentOptions } : {}),
        },
        signal: exec.signal,
      })
      closedAgents.delete(child.childId)
      return { agent_id: child.childId, nickname: null }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'multi_agent_v1__send_input',
    // Upstream text: multi_agents_spec.rs send_input V1.
    description: 'Send a message to an existing agent. Use interrupt=true to redirect work immediately. You should reuse the agent by send_input if you believe your assigned task is highly dependent on the context of a previous task.',
    parameters: {
      target: { type: 'string', required: true, description: 'Exact agent_id returned by spawn_agent. Never invent a placeholder id.' },
      message: { type: 'string', required: true, description: 'Plain-text message to send to the agent.' },
      interrupt: { type: 'boolean', description: 'True interrupts the current turn before queueing this message.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { submission_id: { type: 'string', required: true } },
      },
      ...renderJsonOutput('Input queued'),
    },
    presentCall(args) {
      return genericToolCall(`Message sub-agent ${args.target}`, args.message, 'execute')
    },
    presentResult(_args, result) {
      return genericToolResult('Input queued', result)
    },
    async execute(args, exec) {
      const parent = agentOf(exec)
      const rows = await directChildren(ctx, parent, exec.signal)
      if (!rows.some(row => row.id === args.target)) {
        throw new Error(`unknown subagent "${args.target}"; use the exact agent_id returned by spawn_agent`)
      }
      if (closedAgents.has(args.target)) {
        throw new Error(`subagent "${args.target}" is closed; call resume_agent before send_input`)
      }
      if (args.interrupt === true) {
        ctx.subagents.interrupt(args.target, { kind: 'ancestor', agent: parent })
      }
      const submissionId = await ctx.subagents.followup(
        parent,
        args.target,
        [{ type: 'text', text: args.message }],
        { source: sourceFor(parent), signal: exec.signal },
      )
      return { submission_id: submissionId }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'multi_agent_v1__resume_agent',
    // Upstream text: multi_agents_spec.rs resume_agent V1, plus this host's
    // automatic cold-resume behavior so the model is not surprised by it.
    description: 'Resume a previously closed agent by id so it can receive send_input and wait_agent calls. This host also cold-resumes an agent automatically when input is sent to it.',
    parameters: { id: { type: 'string', required: true, description: 'Exact agent_id returned by spawn_agent.' } },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { status: { ...agentStatusSchema(), required: true } },
      },
      ...renderJsonOutput('Agent ready'),
    },
    presentCall(args) {
      return genericToolCall(`Resume sub-agent ${args.id}`, undefined, 'execute')
    },
    presentResult(_args, result) {
      return genericToolResult('Agent ready', result)
    },
    async execute(args, exec) {
      const parent = agentOf(exec)
      const rows = await directChildren(ctx, parent, exec.signal)
      if (!rows.some(row => row.id === args.id)) return { status: 'not_found' }
      closedAgents.delete(args.id)
      const live = ctx.agents.get(args.id)
      return { status: live?.status === 'running' ? 'running' : { completed: null } }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'multi_agent_v1__wait_agent',
    // Upstream text: multi_agents_spec.rs wait_agent V1.
    description: "Wait for agents to reach a final status. Completed statuses may include the agent's final message. Returns empty status when timed out. Once the agent reaches a final status, a notification message will be received containing the same completed status.",
    parameters: {
      targets: { type: 'array', required: true, items: { type: 'string' }, description: 'Exact agent_id values returned by spawn_agent. Multiple ids wait for whichever finishes first.' },
      timeout_ms: { type: 'number', description: 'Timeout in milliseconds. Defaults to 30000; maximum 3600000.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: {
            type: 'object',
            required: true,
            additionalProperties: true,
          },
          timed_out: { type: 'boolean', required: true },
        },
      },
      ...renderJsonOutput('Agent status'),
    },
    presentCall(args) {
      return genericToolCall('Wait for sub-agents', args.targets.join(', '), 'other')
    },
    presentResult(_args, result) {
      return genericToolResult('Agent status', result)
    },
    async execute(args, exec) {
      const parent = agentOf(exec)
      if (args.targets.length === 0) throw new Error('wait_agent requires at least one target')
      const timeoutMs = Math.min(3_600_000, Math.max(0, args.timeout_ms ?? 30_000))
      const rows = await directChildren(ctx, parent, exec.signal)
      const known = new Set(rows.map(row => row.id))
      const unknown = args.targets.filter(target => !known.has(target))
      if (unknown.length > 0) {
        return { status: Object.fromEntries(unknown.map(target => [target, 'not_found'])), timed_out: false }
      }
      const alreadyClosed = args.targets.find(target => closedAgents.has(target))
      if (alreadyClosed !== undefined) {
        return { status: { [alreadyClosed]: 'shutdown' }, timed_out: false }
      }
      const winner = await Promise.race([
        ...args.targets.map(target => waitForFinal(target, exec.signal)),
        timeoutPromise(timeoutMs, exec.signal),
      ])
      if (winner === undefined) return { status: {}, timed_out: true }
      return { status: { [winner]: visibleStatus(winner, true) }, timed_out: false }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'multi_agent_v1__close_agent',
    // Upstream phrasing (multi_agents_spec.rs close_agent V1) with this
    // host's durable-session fact kept explicit.
    description: "Close an agent and its current turn when it is no longer needed, and return its previous status before shutdown was requested. Don't keep agents open for too long if they are not needed anymore; a later send_input to the same id resumes its durable session.",
    parameters: { target: { type: 'string', required: true, description: 'Exact agent_id returned by spawn_agent.' } },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { previous_status: { ...agentStatusSchema(), required: true } },
      },
      ...renderJsonOutput('Agent stopped'),
    },
    presentCall(args) {
      return genericToolCall(`Close sub-agent ${args.target}`, undefined, 'execute')
    },
    presentResult(_args, result) {
      return genericToolResult('Agent stopped', result)
    },
    async execute(args, exec) {
      const parent = agentOf(exec)
      const rows = await directChildren(ctx, parent, exec.signal)
      if (!rows.some(row => row.id === args.target)) {
        throw new Error(`unknown subagent "${args.target}"; use the exact agent_id returned by spawn_agent`)
      }
      const previousStatus = visibleStatus(args.target, true)
      ctx.subagents.interrupt(args.target, { kind: 'ancestor', agent: parent })
      closedAgents.add(args.target)
      return { previous_status: previousStatus }
    },
  }))
}

export const name = 'codex-surface'
export const inject = [
  'tools',
  'terminals',
  'shell',
  'shellEnv',
  'sandboxPolicy',
  'approval',
  'userQuestions',
  'subagents',
  'agents',
  'fs',
  'attachments',
  'systemPrompt',
]

export function apply(ctx) {
  registerPromptBoundary(ctx)
  registerReadableDispatchLog(ctx)
  registerExecCommand(ctx)
  registerWriteStdin(ctx)
  registerWait(ctx)
  registerApplyPatch(ctx)
  registerViewImage(ctx)
  registerPlan(ctx)
  registerQuestions(ctx)
  registerReportDelivery(ctx)
  registerAgents(ctx)
}
