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
])

const textOutput = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { text: { type: 'string', required: true } },
  },
  render: (_args, value) => [{ type: 'text', text: value.text }],
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
    return {
      ...assembled,
      sections: assembled.sections.filter(section => (
        !HIDDEN_HOST_SECTIONS.has(section.name)
        && !section.name.startsWith('plugin:')
      )),
    }
  })

  ctx.systemPrompt.context({
    name: 'codex:environment',
    order: -100,
    text: context => {
      const agent = context.agent
      if (agent === undefined) return ''
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
      return [
        '<environment_context>',
        `  <cwd>${xmlEscape(cwdOf(agent))}</cwd>`,
        '  <shell>bash</shell>',
        `  <current_date>${localDate()}</current_date>`,
        `  <timezone>${xmlEscape(timezone)}</timezone>`,
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

/** Upstream Luna uses a fresh shell_command process rather than a persistent PTY. */
function registerShellCommand(ctx) {
  ctx.tools.register(defineTool({
    name: 'shell_command',
    description: 'Runs a shell command and returns its output. Always set workdir when it matters; do not use cd unless necessary.',
    parameters: {
      command: { type: 'string', required: true, description: 'Shell script to run in the configured Bash execution environment.' },
      workdir: { type: 'string', description: 'Working directory for the command. Defaults to the turn cwd.' },
      timeout_ms: { type: 'number', description: 'Maximum command runtime. Defaults to the host shell policy.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          output: { type: 'string', required: true },
          exit_code: {
            required: true,
            oneOf: [{ type: 'integer' }, { type: 'null' }],
          },
          signal: {
            required: true,
            oneOf: [{ type: 'string' }, { type: 'null' }],
          },
          timed_out: { type: 'boolean', required: true },
          timeout_ms: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderShellResult(value) }],
      presentationMeta: (_args, value) => ({
        ...(value.exit_code !== null ? { exitCode: value.exit_code } : {}),
        ...(value.signal !== null ? { signal: value.signal } : {}),
      }),
    },
    async execute(args, exec) {
      const agent = agentOf(exec)
      if (typeof args.command !== 'string' || args.command.trim().length === 0) {
        throw new Error('invalid command: expected a non-empty string')
      }
      if (args.timeout_ms !== undefined && (!Number.isFinite(args.timeout_ms) || args.timeout_ms <= 0)) {
        throw new Error(`invalid timeout_ms: expected a positive number, got ${String(args.timeout_ms)}`)
      }
      const sandboxPolicy = ctx.get('sandboxPolicy')?.resolve({ session: agent.session })
      const result = await ctx.shell.run(ctx.shell.resolve({
        command: args.command,
        workdir: shellWorkdir(agent, args.workdir),
        ...(args.timeout_ms !== undefined ? { timeoutMs: args.timeout_ms } : {}),
        signal: exec.signal,
        ...(sandboxPolicy !== undefined ? { sandboxPolicy } : {}),
      }))
      if (result.aborted) throw new Error('tool call aborted')
      return {
        output: shellOutput(result),
        exit_code: result.exitCode,
        signal: result.signal,
        timed_out: result.timedOut,
        timeout_ms: result.timeoutMs,
      }
    },
    presentCall(args) {
      return {
        card: 'terminal',
        title: args.command,
        ...(args.workdir !== undefined ? { cwd: args.workdir } : {}),
      }
    },
    presentResult(_args, result) {
      return presentTerminalResult(result)
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
function previewPatchDiffs(patch) {
  const lines = patch
    .replace(/^\*\*\* Begin Patch\s*\n?/, '')
    .replace(/\n?\*\*\* End Patch\s*$/, '')
    .split('\n')
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
  const lines = patch
    .replace(/^\*\*\* Begin Patch\s*\n?/, '')
    .replace(/\n?\*\*\* End Patch\s*$/, '')
    .split('\n')
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
    description: 'Apply a focused text patch. Pass standard *** Begin Patch / *** End Patch text in patch. Add and Update are supported; policy-preserving Delete and Move are unavailable on this host filesystem seam.',
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
    description: 'Updates the task plan. Provide an optional explanation and a list of plan items. At most one step can be in_progress at a time.',
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
        description: 'Questions to show the user. Prefer 1 and do not exceed 3.',
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

function registerCurrentTime(ctx) {
  ctx.tools.register(defineTool({
    name: 'clock__curr_time',
    description: 'Return the current time in UTC.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { current_time: { type: 'string', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: value.current_time }],
    },
    async execute() {
      const now = new Date()
      const pad = number => String(number).padStart(2, '0')
      return {
        current_time: `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())} ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())} UTC`,
      }
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

function statusOf(ctx, id) {
  const child = ctx.agents.get(id)
  if (child === undefined) return 'not_found'
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

/** Luna's upstream catalog selects the V1 collaboration surface. */
function registerAgents(ctx) {
  ctx.tools.register(defineTool({
    name: 'spawn_agent',
    description: 'Spawn a background agent for a concrete bounded task. Spawned agents inherit the current model by default.',
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
      return { agent_id: child.childId, nickname: null }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'send_input',
    description: 'Send a message to an existing agent. Use interrupt=true to redirect its current work immediately.',
    parameters: {
      target: { type: 'string', required: true, description: 'Agent id to message (from spawn_agent).' },
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
    name: 'resume_agent',
    description: 'Make a previously created agent available for later send_input calls. dsh cold-resumes it automatically when input is sent.',
    parameters: { id: { type: 'string', required: true, description: 'Agent id to resume.' } },
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
      const live = ctx.agents.get(args.id)
      return { status: live?.status === 'running' ? 'running' : { completed: null } }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'wait_agent',
    description: 'Wait for agents to become idle. Returns empty status on timeout; completion content also arrives through the runtime settlement notice.',
    parameters: {
      targets: { type: 'array', required: true, items: { type: 'string' }, description: 'Agent ids to wait on. Multiple ids wait for whichever becomes idle first.' },
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
      const winner = await Promise.race([
        ...args.targets.map(target => waitForIdle(ctx, target, exec.signal)),
        timeoutPromise(timeoutMs, exec.signal),
      ])
      if (winner === undefined) return { status: {}, timed_out: true }
      return { status: { [winner]: statusOf(ctx, winner) }, timed_out: false }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'close_agent',
    description: 'Stop an agent current turn when it is no longer needed. Its durable session remains available for an explicit later follow-up.',
    parameters: { target: { type: 'string', required: true, description: 'Agent id to stop.' } },
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
      const previousStatus = statusOf(ctx, args.target)
      ctx.subagents.interrupt(args.target, { kind: 'ancestor', agent: parent })
      return { previous_status: previousStatus }
    },
  }))
}

export const name = 'codex-surface'
export const inject = [
  'tools',
  'shell',
  'userQuestions',
  'subagents',
  'agents',
  'fs',
  'attachments',
  'systemPrompt',
]

export function apply(ctx) {
  registerPromptBoundary(ctx)
  registerShellCommand(ctx)
  registerApplyPatch(ctx)
  registerViewImage(ctx)
  registerPlan(ctx)
  registerQuestions(ctx)
  registerCurrentTime(ctx)
  registerAgents(ctx)
}
