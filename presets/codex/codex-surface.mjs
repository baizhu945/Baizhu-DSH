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
const dshHome = process.env.DSH_HOME ?? `${process.env.HOME ?? '/home/baizhu945'}/.dsh`
const requireFromDsh = createRequire(`${dshHome}/profiles/codex-surface.cjs`)
const toolsEntry = requireFromDsh.resolve('@deepseek-ai/dsh-tools')
const { defineTool } = await import(toolsEntry)
const { structuredPatch } = requireFromDsh('diff')

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

const textOutput = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { text: { type: 'string', required: true } },
  },
  render: (_args, value) => [{ type: 'text', text: value.text }],
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
}

function shellWorkdir(agent, requested) {
  const base = cwdOf(agent)
  if (requested === undefined || requested.length === 0) return base
  return nodePath.isAbsolute(requested) ? requested : nodePath.resolve(base, requested)
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
  if (maxOutputTokens === undefined) return output
  const maxChars = Math.max(1, Math.floor(maxOutputTokens * 4))
  if (output.length <= maxChars) return output
  return `${output.slice(0, maxChars)}\n[output truncated]`
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
    wall_time_seconds: elapsedMs / 1000,
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

function wrappedCommand(command, marker) {
  const encoded = Buffer.from(String(command)).toString('base64')
  return `__codex_cmd=$(printf %s ${encoded} | base64 -d); eval "$__codex_cmd"; __codex_status=$?; printf '\\n${marker}%s\\n' "$__codex_status"`
}

function registerExecCommand(ctx) {
  ctx.systemPrompt.section({
    name: 'tool:exec',
    order: 105,
    text: 'Use exec_command for bounded or interactive shell work. It always runs through the host PTY and shared sandbox policy; use write_stdin with the returned session_id when a command needs more input or output.',
  })

  ctx.tools.register(defineTool({
    name: 'exec_command',
    description: 'Runs a command in a PTY, returning output or a session ID for ongoing interaction. The host always applies the selected sandbox and approval policy.',
    parameters: {
      cmd: { type: 'string', required: true, description: 'Shell command to execute.' },
      workdir: { type: 'string', description: 'Working directory for the command. Defaults to the turn cwd.' },
      tty: { type: 'boolean', description: 'Accepted for Codex schema compatibility; this host always uses its sandboxed PTY backend.' },
      yield_time_ms: { type: 'number', description: 'Wait before yielding output. Defaults to 10000 ms; effective range is 250-30000 ms.' },
      max_output_tokens: { type: 'number', description: 'Output token budget. Defaults to the host terminal bound.' },
      shell: { type: 'string', description: 'Accepted for schema compatibility; the preset uses its configured NixOS bash.' },
      login: { type: 'boolean', description: 'Accepted for schema compatibility; the preset controls shell startup flags.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          wall_time_seconds: { type: 'number', required: true },
          output: { type: 'string', required: true },
          exit_code: { type: 'number' },
          session_id: { type: 'number' },
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
      const id = ++nextExecSessionId
      const marker = `__DSH_CODEX_EXIT_${id}_${Date.now()}__`
      const command = wrappedCommand(args.cmd, marker)
      const spawned = await ctx.terminals.spawn(agent, {
        type: PTY_BACKEND,
        name: `codex-exec-${id}`,
        cwd: shellWorkdir(agent, args.workdir),
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
      const record = { id, owner: agent, ptyId: spawned.sessionId, operation, echoedInput: command, marker }
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
      if (result.isError) return undefined
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
      yield_time_ms: { type: 'number', description: 'Wait before yielding output. Non-empty writes default to 250 ms; empty polls default to 5000 ms.' },
      max_output_tokens: { type: 'number', description: 'Output token budget. Defaults to the host terminal bound.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          wall_time_seconds: { type: 'number', required: true },
          output: { type: 'string', required: true },
          exit_code: { type: 'number' },
          session_id: { type: 'number' },
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
      if (record.operation !== undefined) {
        const operation = record.operation
        const settled = await waitForTerminalOperation(operation, args.yield_time_ms ?? (chars === '' ? 5_000 : 250), exec.signal)
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
      const settled = await waitForTerminalOperation(operation, args.yield_time_ms ?? (chars === '' ? 5_000 : 250), exec.signal)
      return finishTerminalOperation(ctx, record, operation, startedAt, settled, args.max_output_tokens)
    },
    presentCall(args) {
      return { card: 'terminal', title: args.chars || '(poll session)', description: `Session ${args.session_id}` }
    },
  }))
}

function patchPath(header) {
  const match = /^(?:\*\*\* (?:Update|Add|Delete) File): (.+)$/.exec(header)
  if (match === null) throw new Error(`unsupported apply_patch header: ${header}`)
  return match[1]
}

function findBlock(lines, needle, start = 0) {
  for (let index = start; index <= lines.length - needle.length; index++) {
    if (needle.every((line, offset) => lines[index + offset] === line)) return index
  }
  return -1
}

function applyHunks(original, patchLines, path) {
  const hadTrailingNewline = original.endsWith('\n')
  const lines = original.split('\n')
  if (hadTrailingNewline) lines.pop()
  let cursor = 0
  let searchFrom = 0
  let changed = false
  while (cursor < patchLines.length) {
    if (!patchLines[cursor].startsWith('@@')) {
      cursor++
      continue
    }
    cursor++
    const hunk = []
    while (cursor < patchLines.length && !patchLines[cursor].startsWith('@@')) {
      const line = patchLines[cursor]
      if (line === '*** End of File') break
      if (![' ', '+', '-'].includes(line[0])) throw new Error(`invalid apply_patch hunk for ${path}`)
      hunk.push(line)
      cursor++
    }
    const oldLines = hunk.filter(line => line[0] !== '+').map(line => line.slice(1))
    const newLines = hunk.filter(line => line[0] !== '-').map(line => line.slice(1))
    const index = findBlock(lines, oldLines, searchFrom)
    if (index < 0) throw new Error(`apply_patch context did not match ${path}`)
    lines.splice(index, oldLines.length, ...newLines)
    searchFrom = index + newLines.length
    changed = true
  }
  if (!changed) throw new Error(`apply_patch contained no hunks for ${path}`)
  return lines.join('\n') + (hadTrailingNewline ? '\n' : '')
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
    })
  }
  return diffs
}

/** Build a pure approval-time preview from the patch text itself. */
/**
 * Strip the Begin/End Patch wrapper. Upstream requires the exact
 * "*** End Patch" terminator, but tolerates whitespace around markers; we add
 * a little more tolerance for trailing-asterisk variants (e.g.
 * "*** End Patch ***") from models that were not trained on the format.
 * Legitimate patch content never starts a bare line with the marker.
 */
function patchBody(patch) {
  return String(patch)
    .replace(/^[^\S\n]*\*\*\* Begin Patch[^\n]*\n?/, '')
    .split('\n')
    .filter(line => !/^\*\*\* End Patch/.test(line.trimStart()))
    .join('\n')
}

function previewPatchDiffs(patch) {
  const lines = patchBody(patch).split('\n')
  const diffs = []
  let cursor = 0
  while (cursor < lines.length) {
    const header = lines[cursor]
    if (!header.startsWith('*** ')) {
      cursor++
      continue
    }
    if (header === '*** End of File' || header.startsWith('*** Move to:')) {
      cursor++
      continue
    }
    const path = patchPath(header)
    cursor++
    const body = []
    while (cursor < lines.length && !lines[cursor].startsWith('*** ')) body.push(lines[cursor++])
    if (header.startsWith('*** Add File:')) {
      const newText = body.filter(line => line.startsWith('+')).map(line => line.slice(1)).join('\n') + '\n'
      diffs.push({ path, oldText: null, newText })
      continue
    }
    if (header.startsWith('*** Delete File:')) continue
    let hunkCursor = 0
    while (hunkCursor < body.length) {
      if (!body[hunkCursor].startsWith('@@')) {
        hunkCursor++
        continue
      }
      hunkCursor++
      const oldLines = []
      const newLines = []
      while (hunkCursor < body.length && !body[hunkCursor].startsWith('@@')) {
        const line = body[hunkCursor++]
        if (![' ', '+', '-'].includes(line[0])) continue
        const text = line.slice(1)
        if (line[0] !== '+') oldLines.push(text)
        if (line[0] !== '-') newLines.push(text)
      }
      diffs.push({
        path,
        oldText: oldLines.length > 0 ? oldLines.join('\n') : null,
        newText: newLines.join('\n'),
      })
    }
  }
  return diffs
}

async function writePatchedFile(ctx, exec, path, content, expectedVersion) {
  const agent = agentOf(exec)
  const target = await ctx.fs.resolve(path, { cwd: cwdOf(agent), signal: exec.signal })
  const sandboxPolicy = ctx.get('sandboxPolicy')?.resolve({ session: agent.session })
  const intent = await ctx.waterfall('fs/write-intent', target, exec, () => (
    expectedVersion === undefined ? undefined : { version: expectedVersion }
  ))
  const outcome = await ctx.fs.writeText(target, content, intent, exec.signal, sandboxPolicy)
  ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec)
  return { path: target.displayPath, operation: outcome.operation }
}

async function applyPatch(ctx, exec, patch) {
  const lines = patchBody(patch).split('\n')
  const results = []
  const diffs = []
  let cursor = 0
  while (cursor < lines.length) {
    if (!lines[cursor].startsWith('*** ')) {
      cursor++
      continue
    }
    const header = lines[cursor]
    if (header === '*** End of File') {
      cursor++
      continue
    }
    if (header.startsWith('*** Move to:')) {
      throw new Error('apply_patch move is unavailable because the host filesystem seam has no policy-preserving rename operation')
    }
    const path = patchPath(header)
    cursor++
    const body = []
    while (cursor < lines.length && !lines[cursor].startsWith('*** ')) body.push(lines[cursor++])
    if (header.startsWith('*** Add File:')) {
      const content = body.filter(line => line.startsWith('+')).map(line => line.slice(1)).join('\n') + '\n'
      results.push(await writePatchedFile(ctx, exec, path, content))
      diffs.push({ path, oldText: null, newText: content })
      continue
    }
    if (header.startsWith('*** Delete File:')) {
      throw new Error('apply_patch delete is unavailable because the host filesystem seam has no policy-preserving delete operation')
    }
    const agent = agentOf(exec)
    const target = await ctx.fs.resolve(path, { cwd: cwdOf(agent), signal: exec.signal })
    const info = await ctx.fs.stat(target, exec.signal)
    if (info === undefined || info.type !== 'file') throw new Error(`apply_patch target is not a regular file: ${path}`)
    const original = await ctx.fs.readText(target, exec.signal)
    ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)
    const next = applyHunks(original, body, target.displayPath)
    results.push(await writePatchedFile(ctx, exec, path, next, info.version))
    diffs.push(...computeHunkDiffs(target.displayPath, original, next))
  }
  if (results.length === 0) throw new Error('apply_patch contained no file operations')
  return { files: results, diffs }
}

function registerApplyPatch(ctx) {
  ctx.tools.register(defineTool({
    name: 'apply_patch',
    description: [
      'Apply a focused text patch. Pass standard *** Begin Patch / *** End Patch text in patch.',
      'Add File and Update File are supported. Delete File and Move to are unavailable on this host; to delete or move files, use the separately approved `exec_command` instead of bypassing apply_patch for ordinary content edits.',
    ].join('\n'),
    parameters: { patch: { type: 'string', required: true, description: 'Free-form patch text.' } },
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
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.files.map(file => `${file.operation} ${file.path}`).join('\n'),
      }],
      presentationMeta: (_args, value) => ({ diffs: value.diffs }),
    },
    async execute(args, exec) {
      return applyPatch(ctx, exec, args.patch)
    },
    presentCall(args) {
      const diffs = previewPatchDiffs(args.patch)
      if (diffs.length === 0) return { card: 'generic', title: 'Apply patch', kind: 'edit' }
      const locations = [...new Set(diffs.map(diff => diff.path))].map(path => ({ path }))
      return {
        card: 'diff',
        title: locations.length === 1 ? `Apply patch — ${locations[0].path}` : `Apply patch — ${locations.length} files`,
        diffs,
        locations,
      }
    },
    presentResult(_args, result) {
      if (result.isError) return undefined
      const diffs = narrowDiffs(result.meta)
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
  ))
  return valid ? diffs : undefined
}

function registerViewImage(ctx) {
  ctx.tools.register(defineTool({
    name: 'view_image',
    description: 'View a local image file from the filesystem when visual inspection is needed. Use this for images already available on disk.',
    parameters: { path: { type: 'string', required: true, description: 'Local filesystem path to an image file.' } },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
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
      return { path: target.displayPath, image: ref }
    },
    presentCall(args) {
      return { card: 'generic', title: `View image ${args.path}`, kind: 'read', locations: [{ path: args.path }] }
    },
    presentResult(args, result) {
      if (result.isError) return undefined
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
      return { text: 'Plan updated' }
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
      if (result.isError) return undefined
      return { card: 'generic', title: 'Plan updated', content: result.content }
    },
  }))
}

function registerQuestions(ctx) {
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
    output: textOutput,
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
      const value = await ctx.userQuestions.ask({ questions: args.questions, agent, signal: exec.signal })
      return { text: JSON.stringify(value) }
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
      if (result.isError) return undefined
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

function renderJsonOutput() {
  return {
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
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
    // Upstream text: codex-rs/core/src/tools/handlers/multi_agents_spec.rs (V1).
    description: 'Spawn a sub-agent for a well-scoped task. Returns the spawned agent id plus the user-facing nickname when available. Sub-agents inherit your current model by default; do not set the `model` field unless the user explicitly asks for a different model or there is a clear task-specific reason.',
    parameters: {
      message: { type: 'string', required: true, description: 'Initial plain-text task for the new agent.' },
      fork_context: { type: 'boolean', description: 'True forks completed parent history; false or omitted starts from only the task.' },
      model: { type: 'string', description: 'Optional model override for the new agent.' },
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
    async execute(args, exec) {
      const parent = agentOf(exec)
      const provider = args.fork_context === true ? 'fork' : 'spawn'
      if (!ctx.subagents.list().includes(provider)) throw new Error(`subagent provider is unavailable: ${provider}`)
      const child = await ctx.subagents.startContinuable({
        provider,
        label: args.message.trim().slice(0, 80) || 'subagent',
        request: {
          parent,
          prompt: [{ type: 'text', text: args.message }],
          ...(args.model !== undefined ? {
            agentOptions: { model: args.model },
          } : {}),
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
  'userQuestions',
  'subagents',
  'agents',
  'fs',
  'attachments',
  'systemPrompt',
]

export function apply(ctx) {
  registerPromptBoundary(ctx)
  registerExecCommand(ctx)
  registerWriteStdin(ctx)
  registerApplyPatch(ctx)
  registerViewImage(ctx)
  registerPlan(ctx)
  registerQuestions(ctx)
  registerReportDelivery(ctx)
  registerAgents(ctx)
}
