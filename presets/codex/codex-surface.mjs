/**
 * Codex-shaped model surface over dsh capability seams.
 *
 * This plugin is mounted only by the codex agent preset. It does not replace
 * dsh's host sandbox, approval, filesystem, persistence, skills, or subagent
 * providers. It only gives the model the names and argument shapes used by
 * OpenAI Codex where dsh already has an equivalent capability.
 *
 * Besides the model-facing surface, every tool carries `presentCall` /
 * `presentResult` presentation metadata so the Web UI renders Codex tool
 * calls as readable terminal / diff / plan / ask cards instead of raw JSON
 * argument blobs and raw text dumps. This mirrors how dsh's native tools
 * (bash, fs edit, todo) present themselves and keeps human consumption of
 * the transcript tractable.
 */
const createRequire = process.getBuiltinModule('node:module').createRequire
const dshHome = process.env.DSH_HOME ?? `${process.env.HOME ?? '/home/baizhu945'}/.dsh`
const requireFromDsh = createRequire(`${dshHome}/profiles/codex-surface.cjs`)
const toolsEntry = requireFromDsh.resolve('@deepseek-ai/dsh-tools')
const { defineTool } = await import(toolsEntry)

const sessions = new WeakMap()
const IMAGE_EXTENSIONS = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

const textOutput = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { text: { type: 'string', required: true } },
  },
  render: (_args, value) => [{ type: 'text', text: value.text }],
}

/**
 * Terminal presentation helpers shared by `exec_command` and `write_stdin`.
 * The model-facing text carries a trailing marker (mirroring the `[exit code:
 * N]` contract dsh's shell tools use) so a UI can split the body from the
 * exit-status pill at replay time without access to the structured result.
 */
function renderExecOutput(value) {
  const markers = []
  if (value.exit_code !== undefined && value.exit_code !== null) {
    markers.push(`[exit code: ${value.exit_code}]`)
  } else if (value.session_id !== undefined && value.session_id !== null) {
    markers.push(`[session still running; session_id: ${value.session_id}]`)
  }
  if (markers.length === 0) return value.output
  const body = value.output.length > 0 && !value.output.endsWith('\n') ? `${value.output}\n` : value.output
  return body + markers.join('\n')
}

/** Split a rendered exec/write_stdin result into its output body and markers. */
function parseExecOutput(text) {
  const lines = text.split('\n')
  const markers = []
  while (lines.length > 0) {
    const last = lines[lines.length - 1]
    const exit = /^\[exit code: (-?\d+)\]$/.exec(last)
    const session = /^\[session still running; session_id: (.+)\]$/.exec(last)
    if (exit !== null) {
      markers.push({ kind: 'exit', exitCode: Number(exit[1]) })
      lines.pop()
      continue
    }
    if (session !== null) {
      markers.push({ kind: 'session', sessionId: session[1] })
      lines.pop()
      continue
    }
    break
  }
  return { body: lines.join('\n'), markers }
}

/** Present a completed exec/write_stdin call as a terminal card. */
function presentTerminalResult(args, result) {
  if (result.isError) return undefined
  const block = result.content.length === 1 ? result.content[0] : undefined
  if (block === undefined || block.type !== 'text') return undefined
  const { body, markers } = parseExecOutput(block.text)
  const exit = markers.find(marker => marker.kind === 'exit')
  const session = markers.find(marker => marker.kind === 'session')
  if (exit !== undefined && exit.exitCode !== 0) {
    return { card: 'terminal', output: body, exitCode: exit.exitCode }
  }
  // Clean exit 0 or a still-running session: no error pill, but keep the
  // session hint in the output so the model-facing fact is not lost to the UI.
  const output = session !== undefined
    ? `${body}${body.length > 0 && !body.endsWith('\n') ? '\n' : ''}[session still running; session_id: ${session.sessionId}]`
    : body
  return { card: 'terminal', output }
}

function agentOf(exec) {
  if (exec.agent === undefined) throw new Error('Codex tool requires a live agent')
  return exec.agent
}

function cwdOf(agent) {
  return agent.session.header.cwd ?? process.cwd()
}

async function terminalOf(ctx, agent, cwd, signal) {
  const existing = sessions.get(agent)
  if (existing !== undefined) return existing
  const opened = await ctx.terminals.spawn(agent, { type: 'shell', cwd }, signal)
  const session = { id: opened.sessionId, cwd }
  sessions.set(agent, session)
  return session
}

function terminalResult(value, sessionId) {
  const status = value.sessionStatus
  return {
    output: value.viewport,
    ...status.kind === 'exited' ? { exit_code: status.exitCode ?? undefined } : { session_id: sessionId },
  }
}

function patchPath(header) {
  const match = /^(?:\*\*\* (?:Update|Add|Delete) File): (.+)$/.exec(header)
  if (match === null) throw new Error(`unsupported apply_patch header: ${header}`)
  return match[1]
}

function findBlock(lines, needle) {
  for (let index = 0; index <= lines.length - needle.length; index++) {
    if (needle.every((line, offset) => lines[index + offset] === line)) return index
  }
  return -1
}

function applyHunks(original, patchLines, path) {
  const hadTrailingNewline = original.endsWith('\n')
  const lines = original.split('\n')
  if (hadTrailingNewline) lines.pop()
  let cursor = 0
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
      if (line === '*** End of File') {
        // Trailing EOF marker terminates the hunk body; treat as context end.
        break
      }
      if (![' ', '+', '-'].includes(line[0])) throw new Error(`invalid apply_patch hunk for ${path}`)
      hunk.push(line)
      cursor++
    }
    const oldLines = hunk.filter(line => line[0] !== '+').map(line => line.slice(1))
    const newLines = hunk.filter(line => line[0] !== '-').map(line => line.slice(1))
    const index = findBlock(lines, oldLines)
    if (index < 0) throw new Error(`apply_patch context did not match ${path}`)
    lines.splice(index, oldLines.length, ...newLines)
    changed = true
  }
  if (!changed) throw new Error(`apply_patch contained no hunks for ${path}`)
  return lines.join('\n') + (hadTrailingNewline ? '\n' : '')
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
  const lines = patch.replace(/^\*\*\* Begin Patch\s*\n?/, '').replace(/\n?\*\*\* End Patch\s*$/, '').split('\n')
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
      // Optional trailing marker; skip it and continue with any following file.
      cursor++
      continue
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
      throw new Error(`apply_patch delete is not supported by the dsh filesystem seam: ${path}`)
    }
    const agent = agentOf(exec)
    const target = await ctx.fs.resolve(path, { cwd: cwdOf(agent), signal: exec.signal })
    const info = await ctx.fs.stat(target, exec.signal)
    if (info === undefined || info.type !== 'file') throw new Error(`apply_patch target is not a regular file: ${path}`)
    const original = await ctx.fs.readText(target, exec.signal)
    ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)
    const next = applyHunks(original, body, path)
    results.push(await writePatchedFile(ctx, exec, path, next, info.version))
    diffs.push({ path: target.displayPath, oldText: original, newText: next })
  }
  if (results.length === 0) throw new Error('apply_patch contained no file operations')
  return { files: results, diffs }
}

function registerExecCommand(ctx) {
  ctx.tools.register(defineTool({
    name: 'exec_command',
    description: 'Runs a command in a persistent PTY, returning output or a session id for ongoing interaction.',
    parameters: {
      cmd: { type: 'string', required: true, description: 'Shell command to execute.' },
      workdir: { type: 'string', description: 'Working directory for the command. Defaults to the turn cwd.' },
      tty: { type: 'boolean', description: 'True allocates a PTY for the command; false or omitted uses plain pipes.' },
      yield_time_ms: { type: 'number', description: 'Wait before yielding output. Defaults to 10000 ms; effective range is 250-30000 ms.' },
      max_output_tokens: { type: 'number', description: 'Output token budget. Defaults to 10000 tokens; larger requests may be capped by policy.' },
      shell: { type: 'string', description: 'Shell binary to launch. Defaults to the user\'s default shell.' },
      login: { type: 'boolean', description: 'True runs the shell with -l/-i semantics; false disables them.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          output: { type: 'string', required: true },
          exit_code: { type: 'integer' },
          session_id: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderExecOutput(value) }],
      presentationMeta: (_args, value) => ({
        exitCode: value.exit_code ?? undefined,
        sessionId: value.session_id ?? undefined,
      }),
    },
    async execute(args, exec) {
      const agent = agentOf(exec)
      const session = await terminalOf(ctx, agent, args.workdir ?? cwdOf(agent), exec.signal)
      const operation = ctx.terminals.startSend(agent, session.id, {
        text: args.cmd,
        submit: true,
        signal: exec.signal,
      })
      return terminalResult(await operation.done, session.id)
    },
    presentCall(args) {
      return {
        card: 'terminal',
        title: args.cmd,
        ...args.workdir !== undefined ? { cwd: args.workdir } : {},
      }
    },
    presentResult(args, result) {
      return presentTerminalResult(args, result)
    },
  }))
}

function registerWriteStdin(ctx) {
  ctx.tools.register(defineTool({
    name: 'write_stdin',
    description: 'Writes characters to an existing persistent PTY session and returns recent output.',
    parameters: {
      session_id: { type: 'string', required: true, description: 'Identifier of the running exec session.' },
      chars: { type: 'string', description: 'Bytes to write to stdin. Defaults to empty, which polls without writing.' },
      yield_time_ms: { type: 'number', description: 'Wait before yielding output. Non-empty writes default to 250 ms; empty polls wait a few seconds.' },
      max_output_tokens: { type: 'number', description: 'Output token budget. Defaults to 10000 tokens; larger requests may be capped by policy.' },
    },
    output: textOutput,
    async execute(args, exec) {
      const agent = agentOf(exec)
      const operation = ctx.terminals.startSend(agent, args.session_id, {
        text: args.chars ?? '',
        submit: false,
        signal: exec.signal,
      })
      return { text: (await operation.done).viewport }
    },
    presentCall(args) {
      return {
        card: 'terminal',
        title: args.chars || '(send input)',
        description: `Terminal session ${args.session_id}`,
      }
    },
    presentResult(_args, result) {
      return presentTerminalResult(_args, result)
    },
  }))
}

function registerViewImage(ctx) {
  ctx.tools.register(defineTool({
    name: 'view_image',
    description: 'View a local image file from the filesystem when visual inspection is needed.',
    parameters: { path: { type: 'string', required: true, description: 'Local image path.' } },
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
      const mediaType = IMAGE_EXTENSIONS[args.path.slice(args.path.lastIndexOf('.')).toLowerCase()]
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
      const image = result.content.find(block => block.type === 'image')
      const content = []
      const body = result.content.find(block => block.type === 'text')
      if (body !== undefined) content.push(body)
      if (image !== undefined) content.push(image)
      return {
        card: 'generic',
        title: `View image ${args.path}`,
        content: content.length > 0 ? content : undefined,
      }
    },
  }))
}

function registerPlan(ctx) {
  ctx.tools.register(defineTool({
    name: 'update_plan',
    description: 'Updates the task plan. Provide an optional explanation and a list of plan items, each with a step and status. At most one step can be in_progress at a time.',
    parameters: {
      explanation: { type: 'string', description: 'Optional explanation for this plan update.' },
      plan: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            step: { type: 'string', required: true },
            status: { type: 'string', required: true, enum: ['pending', 'in_progress', 'completed'] },
          },
        },
      },
    },
    output: textOutput,
    async execute(args, exec) {
      const todos = args.plan.map(item => ({ content: item.step, status: item.status }))
      agentOf(exec).session.append('todo/write', { todos })
      return { text: `Plan updated: ${todos.length} steps.` }
    },
    presentCall(args) {
      const active = args.plan.find(item => item.status === 'in_progress')
      return {
        card: 'generic',
        title: active ? `Update plan — ${active.step}` : 'Update plan',
        kind: 'other',
        content: [{
          type: 'text',
          text: args.plan.map(item => `- [${item.status}] ${item.step}`).join('\n'),
        }],
      }
    },
    presentResult(args, result) {
      if (result.isError) return undefined
      const block = result.content.length === 1 ? result.content[0] : undefined
      return {
        card: 'generic',
        title: 'Plan updated',
        content: block !== undefined ? [block] : [{ type: 'text', text: args.plan.map(item => `- [${item.status}] ${item.step}`).join('\n') }],
      }
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
              description: 'Provide 2-3 mutually exclusive choices. Put the recommended option first and suffix its label with "(Recommended)". Do not include an "Other" option; the client adds it automatically.',
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
      if (ctx.get('planMode')?.get(agent).active !== true) throw new Error('request_user_input is only available in Plan mode')
      const value = await ctx.userQuestions.ask({ questions: args.questions, agent, signal: exec.signal })
      return { text: JSON.stringify(value) }
    },
    presentCall(args) {
      return {
        card: 'generic',
        title: `Ask user${args.questions.length > 1 ? ` (${args.questions.length} questions)` : ''}`,
        kind: 'other',
        content: args.questions.map(q => ({
          type: 'text',
          text: `**${q.header}** — ${q.question}\n  ${q.options.map(o => o.label).join(' / ')}`,
        })),
      }
    },
    presentResult(args, result) {
      if (result.isError) return undefined
      const block = result.content.length === 1 ? result.content[0] : undefined
      return {
        card: 'generic',
        title: 'User answered',
        content: block !== undefined ? [block] : undefined,
      }
    },
  }))
}

function registerApplyPatch(ctx) {
  ctx.tools.register(defineTool({
    name: 'apply_patch',
    description: 'Apply a patch to edit files. Use the standard *** Begin Patch / *** End Patch format with *** Add File / *** Update File / *** Delete File headers.',
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
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                oldText: { oneOf: [{ type: 'string' }, { type: 'null' }] },
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
      presentationMeta: (_args, value) => ({ diffs: value.diffs ?? [] }),
    },
    async execute(args, exec) {
      const value = await applyPatch(ctx, exec, args.patch)
      return { files: value.files, diffs: value.diffs }
    },
    presentCall(args) {
      // Show the first file header lines as a readable preview of what will change.
      const headers = args.patch
        .split('\n')
        .filter(line => line.startsWith('*** '))
        .filter(line => line !== '*** Begin Patch' && line !== '*** End Patch')
      return {
        card: 'generic',
        title: headers.length > 0 ? `Apply patch — ${headers[0]}` : 'Apply patch',
        kind: 'edit',
        content: headers.length > 0 ? [{ type: 'text', text: headers.join('\n') }] : undefined,
      }
    },
    presentResult(args, result) {
      if (result.isError) return undefined
      const diffs = narrowDiffs(result.meta)
      if (diffs === undefined) return undefined
      return { card: 'diff', title: 'Patch applied', diffs }
    },
  }))
}

/** Narrow an opaque `presentationMeta` payload to valid FileDiff objects. */
function narrowDiffs(meta) {
  if (typeof meta !== 'object' || meta === null) return undefined
  const diffs = meta.diffs
  if (!Array.isArray(diffs) || diffs.length === 0) return undefined
  const valid = diffs.every(diff =>
    typeof diff === 'object' && diff !== null
    && typeof diff.path === 'string'
    && typeof diff.newText === 'string'
    && (diff.oldText === null || typeof diff.oldText === 'string')
  )
  return valid ? diffs : undefined
}

function registerCurrentTime(ctx) {
  ctx.tools.register(defineTool({
    name: 'current_time',
    description: 'Return the current time in UTC.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          current_time: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.current_time }],
    },
    async execute(_args, exec) {
      const now = new Date()
      const pad = number => String(number).padStart(2, '0')
      const current_time = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())} ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())} UTC`
      return { current_time }
    },
    presentCall() {
      return { card: 'generic', title: 'Read current UTC time', kind: 'read' }
    },
    presentResult(_args, result) {
      if (result.isError) return undefined
      const block = result.content.length === 1 ? result.content[0] : undefined
      return {
        card: 'generic',
        title: 'Current UTC time',
        content: block !== undefined ? [block] : undefined,
      }
    },
  }))
}

function registerAgents(ctx) {
  const sourceFor = parent => ({ kind: 'coordinator', form: 'relay', senderSessionId: parent.session.id })
  const start = async (args, exec) => {
    const parent = agentOf(exec)
    const child = await ctx.subagents.startContinuable({
      provider: 'spawn',
      label: args.task_name,
      request: { parent, prompt: [{ type: 'text', text: args.message }] },
      signal: exec.signal,
    })
    return { text: `spawned agent ${child.childId}` }
  }
  ctx.tools.register(defineTool({
    name: 'spawn_agent',
    description: 'Spawn a background sub-agent for a concrete bounded task.',
    parameters: {
      task_name: { type: 'string', required: true, description: 'Task name.' },
      message: { type: 'string', required: true, description: 'Task instructions.' },
    },
    output: textOutput,
    execute: start,
    presentCall(args) {
      return { card: 'generic', title: `Spawn agent — ${args.task_name}`, kind: 'other', content: [{ type: 'text', text: args.message }] }
    },
    presentResult(_args, result) {
      if (result.isError) return undefined
      const block = result.content.length === 1 ? result.content[0] : undefined
      return { card: 'generic', title: 'Agent spawned', content: block !== undefined ? [block] : undefined }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'send_input',
    description: 'Send a message to an existing sub-agent.',
    parameters: {
      target: { type: 'string', required: true, description: 'Agent id.' },
      message: { type: 'string', required: true, description: 'Message text.' },
    },
    output: textOutput,
    async execute(args, exec) {
      const parent = agentOf(exec)
      await ctx.subagents.followup(parent, args.target, [{ type: 'text', text: args.message }], { source: sourceFor(parent), signal: exec.signal })
      return { text: `message queued for ${args.target}` }
    },
    presentCall(args) {
      return { card: 'generic', title: `Send input to ${args.target}`, kind: 'other', content: [{ type: 'text', text: args.message }] }
    },
    presentResult(_args, result) {
      if (result.isError) return undefined
      const block = result.content.length === 1 ? result.content[0] : undefined
      return { card: 'generic', title: 'Input queued', content: block !== undefined ? [block] : undefined }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'resume_agent',
    description: 'Resume an existing sub-agent with a follow-up task.',
    parameters: {
      target: { type: 'string', required: true, description: 'Agent id.' },
      message: { type: 'string', required: true, description: 'Follow-up task.' },
    },
    output: textOutput,
    async execute(args, exec) {
      const parent = agentOf(exec)
      await ctx.subagents.followup(parent, args.target, [{ type: 'text', text: args.message }], { source: sourceFor(parent), signal: exec.signal })
      return { text: `resumed agent ${args.target}` }
    },
    presentCall(args) {
      return { card: 'generic', title: `Resume ${args.target}`, kind: 'other', content: [{ type: 'text', text: args.message }] }
    },
    presentResult(_args, result) {
      if (result.isError) return undefined
      const block = result.content.length === 1 ? result.content[0] : undefined
      return { card: 'generic', title: 'Agent resumed', content: block !== undefined ? [block] : undefined }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'interrupt_agent',
    description: 'Interrupt a sub-agent current turn.',
    parameters: { target: { type: 'string', required: true, description: 'Agent id.' } },
    output: textOutput,
    async execute(args, exec) {
      ctx.subagents.interrupt(args.target, { kind: 'ancestor', agent: agentOf(exec) })
      return { text: `interrupt requested for ${args.target}` }
    },
    presentCall(args) {
      return { card: 'generic', title: `Interrupt ${args.target}`, kind: 'other' }
    },
    presentResult(_args, result) {
      if (result.isError) return undefined
      const block = result.content.length === 1 ? result.content[0] : undefined
      return { card: 'generic', title: 'Interrupt requested', content: block !== undefined ? [block] : undefined }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'list_agents',
    description: 'List active sub-agents.',
    parameters: {},
    output: textOutput,
    async execute(_args, exec) {
      const rows = await ctx.subagents.listChildren(agentOf(exec).session.id, exec.signal)
      return { text: rows.length === 0 ? '(no subagents)' : rows.map(row => `${row.id} [${row.status}] — ${row.label}`).join('\n') }
    },
    presentCall() {
      return { card: 'generic', title: 'List sub-agents', kind: 'other' }
    },
    presentResult(_args, result) {
      if (result.isError) return undefined
      const block = result.content.length === 1 ? result.content[0] : undefined
      return { card: 'generic', title: 'Sub-agents', content: block !== undefined ? [block] : undefined }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'wait_agent',
    description: 'Inspect sub-agent status; use this when waiting for delegated work.',
    parameters: { ids: { type: 'array', items: { type: 'string' } } },
    output: textOutput,
    async execute(_args, exec) {
      const rows = await ctx.subagents.listChildren(agentOf(exec).session.id, exec.signal)
      return { text: rows.length === 0 ? '(no subagents)' : rows.map(row => `${row.id} [${row.status}] — ${row.label}`).join('\n') }
    },
    presentCall() {
      return { card: 'generic', title: 'Wait for sub-agents', kind: 'other' }
    },
    presentResult(_args, result) {
      if (result.isError) return undefined
      const block = result.content.length === 1 ? result.content[0] : undefined
      return { card: 'generic', title: 'Sub-agent status', content: block !== undefined ? [block] : undefined }
    },
  }))
}

export const name = 'codex-surface'
export const inject = ['tools', 'terminals', 'userQuestions', 'subagents', 'fs', 'attachments']

export function apply(ctx) {
  registerExecCommand(ctx)
  registerWriteStdin(ctx)
  registerApplyPatch(ctx)
  registerViewImage(ctx)
  registerPlan(ctx)
  registerQuestions(ctx)
  registerCurrentTime(ctx)
  registerAgents(ctx)
}
