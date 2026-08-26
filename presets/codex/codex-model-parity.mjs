/*
 * Model-aware Codex surface, scoped to the Codex agent preset.
 *
 * The upstream Codex model catalog owns the model-facing facts: base
 * instructions, Code Mode selection, collaboration generation, image/search
 * support, Skills guidance, and default reasoning effort. DSH still owns the
 * actual execution services. This adapter projects the same facts at prompt
 * assembly time and enforces the projection with a scoped tool guard.
 */
const createRequire = process.getBuiltinModule('node:module').createRequire
const fs = process.getBuiltinModule('node:fs/promises')
const nodePath = process.getBuiltinModule('node:path')
const dshHome = process.env.DSH_HOME || ((process.env.HOME || '/home/baizhu945') + '/.dsh')
const requireFromDsh = createRequire(dshHome + '/profiles/codex-model-parity.cjs')
const toolsEntry = requireFromDsh.resolve('@deepseek-ai/dsh-tools')
const { defineTool, renderToolsSdk } = await import(toolsEntry)
const llmEntry = requireFromDsh.resolve('@deepseek-ai/dsh-llm')
const { createUserMessage } = await import(llmEntry)
const { structuredPatch } = requireFromDsh('diff')

const MODEL_CATALOG_PATH = nodePath.join(dshHome, '.agent-presets/codex/codex-models.json')
const FALLBACK_PROMPT_PATH = nodePath.join(dshHome, '.agent-presets/codex/codex-luna-prompt.md')
const RUN_CODE = 'run_code'
// DSH reserves run_code as its transport name. Keep that host-only name
// behind the Codex-scoped exec facade so the model sees the upstream name.
const CODE_MODE_TOOL = 'exec'
const WAIT_TOOL = 'wait'
const SKILL = 'skill'
const WEB_RUN = 'web__run'
const V1_PREFIX = 'multi_agent_v1__'
const V2_NAMES = new Set([
  'spawn_agent',
  'send_message',
  'followup_task',
  'wait_agent',
  'interrupt_agent',
  'list_agents',
])

// Only the preset-owned exec facade may dispatch the reserved transport. The
// set is intentionally short-lived so ordinary nested SDK calls cannot name
// run_code directly.
const INTERNAL_RUN_CODE_CALLS = new Set()
const SERIAL_ROOT_TAILS = new WeakMap()

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

function isPatchResult(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  if (!Array.isArray(value.files) || !Array.isArray(value.diffs)) return false
  return value.files.every(file => file !== null && typeof file === 'object' && typeof file.path === 'string' && typeof file.operation === 'string')
    && value.diffs.every(diff => diff !== null && typeof diff === 'object' && typeof diff.path === 'string' && typeof diff.newText === 'string')
}

function patchLineCount(text) {
  const value = String(text)
  if (value === '') return 0
  const lines = value.split(String.fromCharCode(10))
  return lines.at(-1) === '' ? lines.length - 1 : lines.length
}

function patchStats(diff) {
  const lines = Array.isArray(diff.lines) ? diff.lines : undefined
  if (lines !== undefined) {
    return lines.reduce((stats, line) => {
      if (line.startsWith('+')) stats.added++
      else if (line.startsWith('-')) stats.removed++
      return stats
    }, { added: 0, removed: 0 })
  }
  if (diff.oldText === null) return { added: patchLineCount(diff.newText), removed: 0 }
  const patch = structuredPatch('', '', diff.oldText, diff.newText, undefined, undefined, { context: 3 })
  return patch.hunks.reduce((stats, hunk) => {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) stats.added++
      else if (line.startsWith('-')) stats.removed++
    }
    return stats
  }, { added: 0, removed: 0 })
}

function patchOperationLabel(operation) {
  switch (operation) {
    case 'add': return 'Added'
    case 'delete': return 'Deleted'
    case 'move': return 'Moved'
    default: return 'Updated'
  }
}

function patchHeader(oldStart, oldLines, newStart, newLines) {
  return '@@ -' + String(oldStart) + ',' + String(oldLines)
    + ' +' + String(newStart) + ',' + String(newLines) + ' @@'
}

function readablePatchLines(value, indent) {
  const files = value.files
  const diffs = value.diffs
  const stats = diffs.reduce((total, diff) => {
    const current = patchStats(diff)
    return { added: total.added + current.added, removed: total.removed + current.removed }
  }, { added: 0, removed: 0 })
  const lines = [
    indent + 'Patch applied successfully.',
    indent + 'Summary: ' + String(files.length) + ' file(s), +' + String(stats.added) + ' line(s), -' + String(stats.removed) + ' line(s).',
    indent + '',
    indent + 'Files:',
    ...(files.length === 0 ? [indent + '(none)'] : files.map(file => indent + '- ' + patchOperationLabel(file.operation) + ': ' + file.path)),
  ]
  if (diffs.length === 0) return lines
  lines.push(indent + '', indent + 'Changes:')
  for (const diff of diffs) {
    const fallbackHunk = Array.isArray(diff.lines) || diff.oldText === null
      ? undefined
      : structuredPatch('', '', diff.oldText, diff.newText, undefined, undefined, { context: 3 }).hunks[0]
    const oldStart = Number.isInteger(diff.oldStart) ? diff.oldStart : (fallbackHunk?.oldStart ?? 0)
    const oldLines = Number.isInteger(diff.oldLines) ? diff.oldLines : (fallbackHunk?.oldLines ?? 0)
    const newStart = Number.isInteger(diff.newStart) ? diff.newStart : (fallbackHunk?.newStart ?? 1)
    const newLines = Number.isInteger(diff.newLines) ? diff.newLines : (fallbackHunk?.newLines ?? patchLineCount(diff.newText))
    let hunkLines = Array.isArray(diff.lines) ? diff.lines : fallbackHunk?.lines
    if (hunkLines === undefined && diff.oldText === null) {
      const added = diff.newText === '' ? [] : diff.newText.split(String.fromCharCode(10))
      if (added.at(-1) === '') added.pop()
      hunkLines = added.map(line => '+ ' + line)
    }
    lines.push(indent + '', indent + 'File: ' + diff.path, indent + patchHeader(oldStart, oldLines, newStart, newLines))
    for (const line of hunkLines ?? []) {
      if (line.startsWith(String.fromCharCode(92))) continue
      lines.push(indent + line[0] + ' ' + line.slice(1))
    }
  }
  return lines
}

function humanLines(value, indent = '') {
  if (value === null || typeof value !== 'object') return [indent + humanScalar(value)]
  if (isPatchResult(value)) return readablePatchLines(value, indent)
  if (Array.isArray(value)) {
    if (value.length === 0) return [indent + '(none)']
    return value.flatMap(item => {
      const lines = humanLines(item, indent + '  ')
      const first = lines[0]?.trimStart() ?? humanScalar(item)
      return [indent + '- ' + first, ...lines.slice(1)]
    })
  }
  const entries = Object.entries(value)
  if (entries.length === 0) return [indent + '(none)']
  return entries.flatMap(([key, child]) => {
    const label = humanLabel(key)
    if (child === null || typeof child !== 'object') return [indent + label + ': ' + humanScalar(child)]
    return [indent + label + ':', ...humanLines(child, indent + '  ')]
  })
}

function humanizeValue(value, title) {
  const body = humanLines(value).join('\n')
  return title === undefined ? body : title + '\n' + body
}

function humanizeText(text, title) {
  const value = String(text)
  const trimmed = value.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return humanizeValue(JSON.parse(trimmed), title)
    } catch {
      // Preserve non-JSON command or provider text verbatim.
    }
  }
  return title === undefined ? value : title + '\n' + value
}

function readableValue(value, title) {
  return typeof value === 'string' ? humanizeText(value, title) : humanizeValue(value, title)
}

const DEFAULT_PROFILE = Object.freeze({
  toolMode: 'native',
  multiAgentVersion: 'none',
  applyPatchToolType: 'freeform',
  shellType: 'unified_exec',
  supportsParallelToolCalls: true,
  useResponsesLite: false,
  includeSkillsUsageInstructions: true,
  includeAppsUsageInstructions: true,
  includePluginUsageInstructions: true,
  inputModalities: ['text'],
  supportsImageDetailOriginal: false,
  supportsSearchTool: true,
  webSearchToolType: undefined,
  defaultReasoningLevel: undefined,
  contextWindow: undefined,
  maxContextWindow: undefined,
})

function officialRows(value) {
  if (Array.isArray(value)) return value
  if (value !== null && typeof value === 'object' && Array.isArray(value.models)) return value.models
  return []
}

async function readText(path, fallback) {
  try {
    return await fs.readFile(path, 'utf8')
  } catch {
    return fallback
  }
}

const FALLBACK_INSTRUCTIONS = await readText(FALLBACK_PROMPT_PATH, '')
let catalogRows = []
try {
  const raw = await fs.readFile(MODEL_CATALOG_PATH, 'utf8')
  catalogRows = officialRows(JSON.parse(raw))
} catch {
  catalogRows = []
}

const catalogById = new Map()
for (const row of catalogRows) {
  if (row === null || typeof row !== 'object' || typeof row.slug !== 'string') continue
  catalogById.set(row.slug, row)
}

function modelTail(model) {
  const value = String(model || '').trim()
  const slash = value.lastIndexOf('/')
  return slash >= 0 ? value.slice(slash + 1) : value
}

function heuristicRow(model) {
  const id = modelTail(model)
  if (id === 'gpt-5.6-luna') {
    return { slug: id, tool_mode: 'code_mode_only', multi_agent_version: 'v1', use_responses_lite: true, include_skills_usage_instructions: false, include_apps_usage_instructions: true, include_plugin_usage_instructions: true, web_search_tool_type: 'text_and_image', context_window: 272000, max_context_window: 872000, default_reasoning_level: 'medium', input_modalities: ['text', 'image'], supports_image_detail_original: true, supports_search_tool: true }
  }
  if (id === 'gpt-5.6-sol' || id === 'gpt-5.6-terra') {
    return { slug: id, tool_mode: 'code_mode_only', multi_agent_version: 'v2', use_responses_lite: true, include_skills_usage_instructions: false, include_apps_usage_instructions: true, include_plugin_usage_instructions: true, web_search_tool_type: 'text_and_image', context_window: 272000, max_context_window: 872000, default_reasoning_level: id.endsWith('sol') ? 'low' : 'medium', input_modalities: ['text', 'image'], supports_image_detail_original: true, supports_search_tool: true }
  }
  if (id === 'gpt-5.3-codex-spark') {
    return { slug: id, tool_mode: 'code_mode_only', multi_agent_version: 'v1', use_responses_lite: true, include_skills_usage_instructions: false, include_apps_usage_instructions: true, include_plugin_usage_instructions: true, web_search_tool_type: 'text', context_window: 128000, max_context_window: 128000, default_reasoning_level: 'medium', input_modalities: ['text'], supports_image_detail_original: false, supports_search_tool: true }
  }
  return undefined
}

function profileForModel(model) {
  const id = modelTail(model)
  const row = catalogById.get(String(model || '').trim()) || catalogById.get(id) || heuristicRow(id)
  if (row === undefined) return { ...DEFAULT_PROFILE, model: id, instructions: FALLBACK_INSTRUCTIONS }
  const toolMode = row.tool_mode === 'code_mode_only'
    ? 'code_mode_only'
    : row.tool_mode === 'both' ? 'both' : 'native'
  const multiAgentVersion = row.multi_agent_version === 'v1' || row.multi_agent_version === 'v2'
    ? row.multi_agent_version
    : 'none'
  return {
    ...DEFAULT_PROFILE,
    model: id,
    instructions: typeof row.base_instructions === 'string' ? row.base_instructions : FALLBACK_INSTRUCTIONS,
    toolMode,
    multiAgentVersion,
    applyPatchToolType: typeof row.apply_patch_tool_type === 'string' ? row.apply_patch_tool_type : 'freeform',
    shellType: typeof row.shell_type === 'string' ? row.shell_type : 'unified_exec',
    supportsParallelToolCalls: row.supports_parallel_tool_calls !== false,
    useResponsesLite: row.use_responses_lite === true,
    includeSkillsUsageInstructions: row.include_skills_usage_instructions !== false,
    includeAppsUsageInstructions: row.include_apps_usage_instructions !== false,
    includePluginUsageInstructions: row.include_plugin_usage_instructions !== false,
    inputModalities: Array.isArray(row.input_modalities) ? row.input_modalities : ['text'],
    supportsImageDetailOriginal: row.supports_image_detail_original === true,
    supportsSearchTool: row.supports_search_tool !== false,
    webSearchToolType: typeof row.web_search_tool_type === 'string' ? row.web_search_tool_type : undefined,
    defaultReasoningLevel: typeof row.default_reasoning_level === 'string' ? row.default_reasoning_level : undefined,
    contextWindow: Number.isInteger(row.context_window) ? row.context_window : undefined,
    maxContextWindow: Number.isInteger(row.max_context_window) ? row.max_context_window : undefined,
  }
}

function requestHeaderConfig(agent) {
  try {
    const header = agent && agent.session && typeof agent.session.requestHeader === 'function'
      ? agent.session.requestHeader()
      : undefined
    return header && (header.config || (header.header && header.header.config))
  } catch {
    return undefined
  }
}

function currentModel(agent, assembly) {
  const assembled = assembly && assembly.variables && assembly.variables.model
  if (typeof assembled === 'string' && assembled.trim() !== '') return assembled
  const header = requestHeaderConfig(agent)
  if (header && typeof header.model === 'string' && header.model.trim() !== '') return header.model
  return agent && agent.options ? agent.options.model || '' : ''
}

function currentProvider(agent, assembly) {
  const assembled = assembly && assembly.variables && assembly.variables.provider
  if (typeof assembled === 'string' && assembled.trim() !== '') return assembled
  const header = requestHeaderConfig(agent)
  if (header && typeof header.provider === 'string' && header.provider.trim() !== '') return header.provider
  return agent && agent.options ? agent.options.provider || '' : ''
}

function planModeActive(ctx, agent) {
  try {
    return ctx.get('planMode')?.get(agent)?.active === true
  } catch {
    return false
  }
}

function isImageCapable(profile) {
  return profile.inputModalities.includes('image')
}

function isV1Tool(name) {
  return name.startsWith(V1_PREFIX)
}

function modelToolAllowed(ctx, profile, name, agent, nested) {
  if (!nested && name === RUN_CODE) return false
  if (!nested && profile.toolMode === 'code_mode_only' && name !== CODE_MODE_TOOL && name !== WAIT_TOOL) return false
  if (!nested && profile.toolMode === 'native' && (name === CODE_MODE_TOOL || name === WAIT_TOOL)) return false
  if (nested && (name === RUN_CODE || name === CODE_MODE_TOOL || name === WAIT_TOOL)) return false
  if ((name === 'exec_command' || name === 'write_stdin') && profile.shellType !== 'unified_exec') return false
  if (name === 'apply_patch' && profile.applyPatchToolType === 'none') return false
  if (name === WEB_RUN && (!profile.useResponsesLite || !profile.supportsSearchTool)) return false
  if (name === SKILL && !profile.includeSkillsUsageInstructions) return false
  if (name === 'view_image' && !isImageCapable(profile)) return false
  if (name === 'request_user_input' && profile.toolMode !== 'code_mode_only' && !planModeActive(ctx, agent)) return false
  if (isV1Tool(name)) return profile.multiAgentVersion === 'v1'
  if (V2_NAMES.has(name)) return profile.multiAgentVersion === 'v2'
  return true
}

function patchImageSchema(schema, profile) {
  if (schema.name !== 'view_image' || profile.supportsImageDetailOriginal) return schema
  const parameters = structuredClone(schema.parameters)
  if (parameters !== null && typeof parameters === 'object') {
    const properties = parameters.properties
    if (properties !== null && typeof properties === 'object') delete properties.detail
  }
  return { ...schema, parameters }
}

function nativeSchemas(ctx, agent, profile) {
  return ctx.tools.schemas(agent)
    .filter(schema => modelToolAllowed(ctx, profile, schema.name, agent, false))
    .map(schema => patchImageSchema(schema, profile))
}

function sdkSchemas(ctx, agent, profile) {
  return ctx.tools.schemas(agent)
    .filter(schema => modelToolAllowed(ctx, profile, schema.name, agent, true))
    .map(schema => {
      const definition = ctx.tools.get(schema.name, agent)
      return {
        ...patchImageSchema(schema, profile),
        output: definition?.output?.schema ?? { type: 'string' },
      }
    })
}

function dynamicSdk(ctx, agent, profile, fallback) {
  try {
    return renderToolsSdk(sdkSchemas(ctx, agent, profile))
  } catch {
    return fallback
  }
}

function rewriteCodeModeName(text) {
  if (typeof text !== 'string') return text
  return text
    .replaceAll(RUN_CODE, CODE_MODE_TOOL)
    .replace('`exec` is the only tool you can call directly', '`exec` and `wait` are the only tools you can call directly')
}

function codeModeErrorText(result) {
  if (!Array.isArray(result?.content)) return ''
  return result.content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join(String.fromCharCode(10))
    .trim()
}

function codeModeDescription(input) {
  const firstLine = String(input)
    .split(String.fromCharCode(10))
    .map(line => line.trim())
    .find(line => line.length > 0)
  if (firstLine === undefined) return 'Execute Code Mode program'
  return firstLine.length > 120 ? firstLine.slice(0, 117) + '…' : firstLine
}

/**
 * Keep common shell snippets valid when a model writes them in a JavaScript
 * string. Node's erasable-TypeScript parser rejects literal line terminators in
 * single/double-quoted strings and treats Bash `${name:-fallback}` as a JS
 * interpolation. A valid program is left byte-for-byte unchanged.
 */
function normalizeCodeModeSource(source) {
  const text = String(source)
  let output = ''
  let quote
  let escaped = false
  for (let index = 0; index < text.length; index++) {
    const character = text[index]
    if (quote === undefined) {
      output += character
      if (character === "'" || character === '"' || character === '`') quote = character
      continue
    }
    if (escaped) {
      if ((quote === "'" || quote === '"') && (character === '\n' || character === '\r')) {
        if (character === '\r' && text[index + 1] === '\n') index++
        output += 'n'
      } else {
        output += character
      }
      escaped = false
      continue
    }
    if (character === String.fromCharCode(92)) {
      output += character
      escaped = true
      continue
    }
    if (character === quote) {
      output += character
      quote = undefined
      continue
    }
    if ((quote === "'" || quote === '"') && (character === '\n' || character === '\r')) {
      if (character === '\r' && text[index + 1] === '\n') index++
      output += '\\n'
      continue
    }
    if (quote === '`' && character === '$' && text[index + 1] === '{') {
      const end = text.indexOf('}', index + 2)
      const expression = end < 0 ? undefined : text.slice(index + 2, end)
      if (expression !== undefined && /^[A-Za-z_][A-Za-z0-9_]*:[-+?=]/.test(expression)) {
        output += String.fromCharCode(92) + '${' + expression + '}'
        index = end
        continue
      }
    }
    output += character
  }
  return output
}

/**
 * Present DSH's function-shaped Code Mode under Codex's exec name. DSH's
 * core still owns the actual reserved transport; the nested parent token is
 * required so the dispatch is accepted as the facade's child call.
 */
function registerCodeModeAlias(ctx) {
  ctx.tools.register(defineTool({
    name: CODE_MODE_TOOL,
    description: [
      'Execute raw JavaScript/TypeScript source in the Codex Code Mode runtime.',
      'The required input is the body of an async function, not a JSON object or fenced code block; Node parses it with its erasable TypeScript parser.',
      'For multiline shell commands, build cmd with ["line 1", "line 2"].join("\\n") instead of putting a literal newline inside a JavaScript quoted string.',
      'Do not put Bash parameter expansions such as ${rc:-0} inside a JavaScript template literal; use an array of shell lines joined with "\\n".',
      'Call tools as await tools.<tool_name>(arguments) and return a JSON-serializable value.',
      'The dsh compatibility transport carries that source in the required input string property.',
    ].join(' '),
    parameters: {
      input: { type: 'string', required: true, description: 'Raw JavaScript/TypeScript function body. Build multiline shell commands with an array joined by "\\n"; do not wrap it in JSON or markdown fences.' },
      description: { type: 'string', description: 'Optional short summary of what the program does.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          logs: { type: 'array', required: true, items: { type: 'string' } },
          result: { type: 'json' },
        },
      },
      render: (_args, value) => {
        const parts = [value.logs.map(log => humanizeText(log)).join(String.fromCharCode(10))]
        if (value.result !== undefined) parts.push(readableValue(value.result))
        const text = parts.filter(part => part.length > 0).join(String.fromCharCode(10))
        return [{ type: 'text', text: text.length > 0 ? text : '(exec completed with no output)' }]
      },
    },
    presentCall: args => ({
      card: 'generic',
      title: args.description?.trim() || codeModeDescription(args.input),
      kind: 'execute',
      rawInput: args.input,
    }),
    async execute(args, execution) {
      const description = args.description?.trim() || codeModeDescription(args.input)
      if (description.length === 0) throw new Error('invalid input: expected non-empty JavaScript source')
      const program = normalizeCodeModeSource(args.input)
      const callId = execution.callId + ':run_code'
      INTERNAL_RUN_CODE_CALLS.add(callId)
      try {
        const result = await ctx.tools.execute({
          callId,
          rootCallId: execution.rootCallId ?? execution.callId,
          name: RUN_CODE,
          arguments: { code: program, description },
          agent: execution.agent,
          parent: execution.token,
          signal: execution.signal,
        })
        if (result.isError) throw new Error(codeModeErrorText(result) || 'Code Mode execution failed')
        if (result.value === undefined) throw new Error('Code Mode returned no result')
        return result.value
      } finally {
        INTERNAL_RUN_CODE_CALLS.delete(callId)
      }
    },
  }))
}

function v2JsonOutput(title) {
  return {
    render: (_args, value) => [{ type: 'text', text: readableValue(value, title) }],
  }
}

function v2AgentOf(execution) {
  if (execution.agent === undefined) throw new Error('Codex V2 collaboration requires an owning agent')
  return execution.agent
}

function v2SourceFor(parent) {
  return { kind: 'coordinator', form: 'relay', senderSessionId: parent.session.id }
}

async function v2Children(ctx, parent, signal) {
  const rows = await ctx.subagents.listChildren(parent.session.id, signal)
  return rows.filter(row => row.kind === 'child' && row.mode === 'continuable')
}

function v2Status(ctx, id) {
  const child = ctx.agents.get(id)
  if (child === undefined) return 'not_found'
  return child.status === 'running' ? 'running' : { completed: null }
}

function v2AgentStatusSchema() {
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

function registerV2Agents(ctx) {
  ctx.tools.register(defineTool({
    name: 'spawn_agent',
    description: 'Spawns an agent to work on the specified task. Use a lowercase task_name with letters, digits, and underscores. The spawned agent inherits the current model and can spawn its own subagents. Only use this for a concrete, bounded subtask that can run independently alongside useful local work.',
    parameters: {
      task_name: { type: 'string', required: true, description: 'Task name for the new agent. Use lowercase letters, digits, and underscores.' },
      message: { type: 'string', required: true, description: 'Initial plain-text task for the new agent.' },
      fork_turns: { type: 'string', enum: ['none', 'all'], description: 'Use none for no surrounding context, or all to inherit completed parent history.' },
      model: { type: 'string', description: 'Model override for the new agent. Omit unless explicitly requested.' },
      reasoning_effort: { type: 'string', description: 'Reasoning effort override for the new agent. Omit unless explicitly requested.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { task_name: { type: 'string', required: true, description: 'Durable task identifier for the spawned agent.' } },
      },
      ...v2JsonOutput('Agent spawned'),
    },
    async execute(args, execution) {
      const parent = v2AgentOf(execution)
      const provider = args.fork_turns === 'none' ? 'spawn' : 'fork'
      if (!ctx.subagents.list().includes(provider)) throw new Error('subagent provider is unavailable: ' + provider)
      const agentOptions = {
        ...(args.model === undefined ? {} : { model: args.model }),
        ...(args.reasoning_effort === undefined ? {} : { reasoningEffort: args.reasoning_effort }),
      }
      const child = await ctx.subagents.startContinuable({
        provider,
        label: args.task_name,
        request: {
          parent,
          prompt: [{ type: 'text', text: args.message }],
          ...(Object.keys(agentOptions).length === 0 ? {} : { agentOptions }),
        },
        signal: execution.signal,
      })
      return { task_name: child.childId }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'send_message',
    description: 'Send a message to an existing agent. The message is delivered promptly and does not trigger a new turn.',
    parameters: {
      target: { type: 'string', required: true, description: 'Relative or canonical task name, or the durable id returned by spawn_agent.' },
      message: { type: 'string', required: true, description: 'Message text to queue on the target agent.' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { submission_id: { type: 'string', required: true } } }, ...v2JsonOutput('Message queued') },
    async execute(args, execution) {
      const parent = v2AgentOf(execution)
      const rows = await v2Children(ctx, parent, execution.signal)
      if (!rows.some(row => row.id === args.target)) throw new Error('unknown subagent: ' + args.target)
      const target = ctx.agents.get(args.target)
      if (target === undefined) throw new Error('subagent is not live; use followup_task to cold-resume it')
      const message = createUserMessage({ content: [{ type: 'text', text: args.message }], source: v2SourceFor(parent) })
      target.inject(message)
      return { submission_id: message.id }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'followup_task',
    description: 'Send a follow-up task to an existing non-root agent and trigger a turn if it is idle. If it is already running, deliver the task at a message boundary.',
    parameters: {
      target: { type: 'string', required: true, description: 'Agent id or task name returned by spawn_agent.' },
      message: { type: 'string', required: true, description: 'Message text to send to the target agent.' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { submission_id: { type: 'string', required: true } } }, ...v2JsonOutput('Follow-up queued') },
    async execute(args, execution) {
      const parent = v2AgentOf(execution)
      const rows = await v2Children(ctx, parent, execution.signal)
      if (!rows.some(row => row.id === args.target)) throw new Error('unknown subagent: ' + args.target)
      const submissionId = await ctx.subagents.followup(parent, args.target, [{ type: 'text', text: args.message }], { source: v2SourceFor(parent), signal: execution.signal })
      return { submission_id: submissionId }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'wait_agent',
    description: 'Wait for a mailbox update from any live agent, including queued messages and final-status notifications. Returns a summary without the agent final content, or a timeout summary.',
    parameters: { timeout_ms: { type: 'number', description: 'Timeout in milliseconds. Defaults to 30000; maximum 3600000.' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { message: { type: 'string', required: true }, timed_out: { type: 'boolean', required: true } } }, ...v2JsonOutput('Agent wait') },
    async execute(args, execution) {
      const parent = v2AgentOf(execution)
      const rows = await v2Children(ctx, parent, execution.signal)
      const timeoutMs = Math.min(3_600_000, Math.max(0, args.timeout_ms ?? 30_000))
      const live = rows.map(row => ctx.agents.get(row.id)).filter(agent => agent !== undefined)
      if (live.length === 0) return { message: 'No live agents have a mailbox update.', timed_out: false }
      const timeout = new Promise(resolve => setTimeout(() => resolve(undefined), timeoutMs))
      const update = Promise.race(live.map(agent => agent.whenIdle().then(() => agent.id)))
      const winner = await Promise.race([update, timeout])
      execution.signal.throwIfAborted()
      if (winner === undefined) return { message: 'Timed out waiting for a mailbox update.', timed_out: true }
      return { message: 'Agent ' + winner + ' has a mailbox update or final-status notification.', timed_out: false }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'interrupt_agent',
    description: "Interrupt an agent's current turn, if any, and return its previous status. The agent remains available for messages and follow-up tasks.",
    parameters: { target: { type: 'string', required: true, description: 'Agent id or task name returned by spawn_agent.' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { previous_status: { ...v2AgentStatusSchema(), required: true } } }, ...v2JsonOutput('Agent interrupted') },
    async execute(args, execution) {
      const parent = v2AgentOf(execution)
      const rows = await v2Children(ctx, parent, execution.signal)
      if (!rows.some(row => row.id === args.target)) throw new Error('unknown subagent: ' + args.target)
      const previousStatus = v2Status(ctx, args.target)
      ctx.subagents.interrupt(args.target, { kind: 'ancestor', agent: parent })
      return { previous_status: previousStatus }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'list_agents',
    description: 'List live agents in the current root thread tree. Optionally filter by task-path prefix.',
    parameters: { path_prefix: { type: 'string', description: 'Task-path prefix filter without a trailing slash. Omit to list all live agents.' } },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          agents: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                agent_name: { type: 'string', required: true },
                agent_status: { ...v2AgentStatusSchema(), required: true },
              },
            },
          },
        },
      },
      ...v2JsonOutput('Agents'),
    },
    async execute(args, execution) {
      const parent = v2AgentOf(execution)
      const rows = await v2Children(ctx, parent, execution.signal)
      const prefix = typeof args.path_prefix === 'string' ? args.path_prefix : undefined
      return { agents: rows.filter(row => prefix === undefined || String(row.id).startsWith(prefix)).map(row => ({ agent_name: row.id, agent_status: v2Status(ctx, row.id) })) }
    },
  }))
}

function registerModelParity(ctx) {
  ctx.tools.guard(execution => {
    const agent = execution.agent
    if (agent === undefined) return undefined
    if (execution.name === RUN_CODE && INTERNAL_RUN_CODE_CALLS.has(execution.callId)) return undefined
    const profile = profileForModel(currentModel(agent))
    const nested = execution.parent !== undefined
    if (modelToolAllowed(ctx, profile, execution.name, agent, nested)) return undefined
    return 'Codex model capability policy hides tool ' + JSON.stringify(execution.name)
  })

  ctx.on('agent/request', async (payload, next) => {
    const resolved = await next()
    if (resolved.reasoningEffort !== undefined) return resolved
    const profile = profileForModel(resolved.model || (payload?.agent?.options?.model || ''))
    if (profile.defaultReasoningLevel === undefined) return resolved
    return { ...resolved, reasoningEffort: profile.defaultReasoningLevel }
  })

  // Some official catalog rows explicitly disable parallel tool calls. DSH's
  // scheduler is shared and has no per-model request flag, so serialize only
  // direct Codex calls for those rows. Nested Code Mode dispatches retain the
  // runtime's own scheduler and are deliberately not placed behind this lock.
  ctx.on('tools/execute', async (execution, next) => {
    const agent = execution.agent
    if (agent === undefined || execution.parent !== undefined) return next()
    const profile = profileForModel(currentModel(agent))
    if (profile.supportsParallelToolCalls) return next()
    const previous = SERIAL_ROOT_TAILS.get(agent) ?? Promise.resolve()
    let release
    const current = new Promise(resolve => { release = resolve })
    SERIAL_ROOT_TAILS.set(agent, current)
    await previous.catch(() => {})
    try {
      return await next()
    } finally {
      release()
      if (SERIAL_ROOT_TAILS.get(agent) === current) SERIAL_ROOT_TAILS.delete(agent)
    }
  })

  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next()
    const agent = context.agent
    if (agent === undefined) return assembled
    const profile = profileForModel(currentModel(agent, assembled))
    const tools = nativeSchemas(ctx, agent, profile)
      .filter(tool => profile.toolMode !== 'code_mode_only' || tool.name === CODE_MODE_TOOL || tool.name === WAIT_TOOL)
    const sections = assembled.sections
      .filter(section => profile.toolMode !== 'native' || section.name !== 'tools:code-only')
      .filter(section => profile.toolMode !== 'native' || section.name !== 'tools:sdk')
      .map(section => {
        if (section.name === 'deployment:persona') return { ...section, text: profile.instructions }
        if (section.name === 'tools:code-only') return { ...section, text: rewriteCodeModeName(section.text) }
        if (profile.toolMode !== 'native' && section.name === 'tools:sdk') {
          return { ...section, text: rewriteCodeModeName(dynamicSdk(ctx, agent, profile, section.text)) }
        }
        return section
      })
    return { ...assembled, sections, tools }
  })
}

export const name = 'codex-model-parity'
export const inject = ['tools', 'systemPrompt', 'subagents', 'agents']

export function apply(ctx) {
  registerCodeModeAlias(ctx)
  registerV2Agents(ctx)
  registerModelParity(ctx)
}
