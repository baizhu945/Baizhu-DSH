/*
 * Model-aware Codex surface, scoped to the Codex agent preset.
 *
 * The upstream Codex model catalog owns the model-facing facts: base
 * instructions, Code Mode selection, collaboration generation, image/search
 * support, Skills guidance, and default reasoning effort. DSH still owns the
 * actual execution services. This adapter projects the same facts at prompt
 * assembly time and enforces the projection with a scoped tool guard.
 */
const nodeModule = process.getBuiltinModule('node:module')
const createRequire = nodeModule.createRequire
const stripTypeScriptTypes = nodeModule.stripTypeScriptTypes
const fs = process.getBuiltinModule('node:fs/promises')
const nodePath = process.getBuiltinModule('node:path')
const dshHome = process.env.DSH_HOME || ((process.env.HOME || '/home/baizhu945') + '/.dsh')
const requireFromDsh = createRequire(dshHome + '/profiles/codex-model-parity.cjs')
const toolsEntry = requireFromDsh.resolve('@deepseek-ai/dsh-tools')
const { defineTool, renderToolsSdk } = await import(toolsEntry)
const llmEntry = requireFromDsh.resolve('@deepseek-ai/dsh-llm')
const { structuredPatch } = requireFromDsh('diff')

const MODEL_CATALOG_PATH = nodePath.join(dshHome, '.agent-presets/codex/codex-models.json')
const FALLBACK_PROMPT_PATH = nodePath.join(dshHome, '.agent-presets/codex/codex-default-prompt.md')
const DEFAULT_MODE_PATH = nodePath.join(dshHome, '.agent-presets/codex/codex-default-mode.md')
// Upstream keeps the default-mode collaboration text in the client rather than
// the catalog. Ship it as a preset-owned copy instead of re-deriving it from the
// Plan template, so Default mode reads exactly like Codex Default mode.
const DEFAULT_MODE_TEMPLATE = await readText(DEFAULT_MODE_PATH, '')
const RUN_CODE = 'run_code'
// DSH reserves run_code as its transport name. Keep that host-only name
// behind the Codex-scoped exec facade so the model sees the upstream name.
const CODE_MODE_TOOL = 'exec'
const WAIT_TOOL = 'wait'
const GET_CONTEXT_REMAINING_TOOL = 'get_context_remaining'
const NEW_CONTEXT_TOOL = 'new_context'
const REQUEST_PERMISSIONS_TOOL = 'request_permissions'
const SKILL = 'skill'
const WEB_RUN = 'web__run'
const WEB_SEARCH = 'web_search'
const SEND_USER_MESSAGE_ASYNC = 'send_user_message_async'
const REQUEST_USER_INPUT_ASYNC = 'request_user_input_async'
// Upstream declares these inside a `clock` namespace object, so the wire name
// is a namespace plus a function. This transport can only declare plain
// function tools, and the Responses API rejects any name outside
// `^[a-zA-Z0-9_-]+$`, so a dot is not an option. `clock__*` is exactly the
// identifier Codex itself generates for these tools inside `exec`
// (`code_mode_name_for_tool_name`), so the model meets the same name either way.
const CLOCK_TIME = 'clock__curr_time'
const CLOCK_SLEEP = 'clock__sleep'
// Any tool name the Codex preset declares must satisfy the provider's pattern;
// a single rejected name fails the whole request rather than one tool.
const WIRE_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/
// DSH's subagent runtime bounds live children well below this; the hint exists
// so the model plans a fan-out it can actually finish.
const SUBAGENT_CONCURRENCY = 4
// Persistent mode is upstream's opt-in reasoning effort. DSH has no equivalent
// effort id, so track it per session behind the same on/off shape.
const persistentModes = new WeakMap()
// Match the selected official catalog row.  The preset still mounts the local
// skill provider so rows that opt in (for example GPT-5.4) work normally, but
// Luna/terra/sol do not receive an unadvertised local-Skills surface.
const INCLUDE_LOCAL_SKILLS = false
const V1_PREFIX = 'multi_agent_v1__'
const V1_NAMES = new Set([
  'multi_agent_v1__spawn_agent',
  'multi_agent_v1__send_input',
  'multi_agent_v1__resume_agent',
  'multi_agent_v1__wait_agent',
  'multi_agent_v1__close_agent',
])
const V2_NAMES = new Set([
  'collaboration__spawn_agent',
  'collaboration__send_message',
  'collaboration__followup_task',
  'collaboration__wait_agent',
  'collaboration__interrupt_agent',
  'collaboration__list_agents',
])
// dsh-native tool names that have no OpenAI Codex CLI equivalent. The Codex
// preset reaches the same capabilities through `exec_command`, `apply_patch`
// and the `collaboration__*` / `multi_agent_v1__*` shapes, so these must stay
// out of both the direct surface and the nested Code Mode SDK.
const DSH_NATIVE_TOOLS = new Set([
  'ask_user_question',
  'bash',
  'create_goal',
  'edit',
  'exit_plan_mode',
  'get_goal',
  'glob',
  'grep',
  'interrupt_agent',
  'job_kill',
  'job_list',
  'job_output',
  'list_agents',
  'list_subagent_models',
  'pwsh',
  'read',
  'read_image',
  'send_message',
  'str_replace_editor',
  'subagent',
  'subagent_fork',
  'terminal_close',
  'terminal_list',
  'terminal_open',
  'terminal_read',
  'terminal_send',
  'terminal_signal',
  'todo_write',
  'update_goal',
  'web_fetch',
  'workflow',
  'write',
])

// Only the preset-owned exec facade may dispatch the reserved transport. The
// map is intentionally short-lived so ordinary nested SDK calls cannot name
// run_code directly, and a call-id collision cannot cross agent/token scope.
const INTERNAL_RUN_CODE_CALLS = new Map()
const SERIAL_ROOT_TAILS = new WeakMap()
const V2_PATH_CACHES = new WeakMap()
const V2_PATH_RESERVATIONS = new WeakMap()
const TOKEN_BUDGET_STATES = new WeakMap()
// Official Code Mode keeps stored values in the session runtime. Preserve the
// same lifetime across DSH's otherwise independent run_code invocations.
const CODE_MODE_STORES = new WeakMap()
const V2_STEERED = Object.freeze({ kind: 'steered' })
const V2_WAIT_DEFAULT_MS = 30_000
const V2_WAIT_MIN_MS = 10_000
const V2_WAIT_MAX_MS = 3_600_000
const CODE_MODE_STRIP_PREFIX = 'async function __dsh_program__() {\n'
const CODE_MODE_STRIP_SUFFIX = '\n}'
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const PREVIEW_ESCAPED_TEMPLATE_MARKER = String.fromCharCode(0)

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
  // Model-owned instruction blocks. A catalog row that omits them keeps the
  // generic Codex prompt, exactly like `ModelInfo::default()` upstream.
  persistentInstructions: '',
  collaborationModeDefault: undefined,
  collaborationModePlan: undefined,
  multiAgentRoleRoot: undefined,
  multiAgentRoleSubagent: undefined,
  approvalMessages: null,
  permissionMessages: null,
  experimentalTools: Object.freeze([]),
  // Match Codex's model_info_from_slug fallback: an unknown model does not
  // positively advertise the model-specific patch surface.
  applyPatchToolType: 'none',
  shellType: 'unified_exec',
  supportsParallelToolCalls: true,
  useResponsesLite: false,
  includeSkillsUsageInstructions: false,
  includeAppsUsageInstructions: false,
  includePluginUsageInstructions: false,
  inputModalities: ['text'],
  supportsImageDetailOriginal: false,
  // Unknown slugs use the official fallback posture: do not advertise a
  // network search capability until the catalog positively enables it.
  supportsSearchTool: false,
  webSearchToolType: 'text',
  defaultReasoningLevel: undefined,
  contextWindow: 272_000,
  maxContextWindow: 272_000,
  effectiveContextWindowPercent: 95,
  autoCompactTokenLimit: undefined,
  tokenBudget: undefined,
  supportVerbosity: false,
  defaultVerbosity: undefined,
  reasoningSummaryFormat: undefined,
  defaultReasoningSummary: undefined,
  truncationPolicy: { mode: 'bytes', limit: 10_000 },
})

function officialRows(value) {
  if (Array.isArray(value)) return value
  if (value !== null && typeof value === 'object' && Array.isArray(value.models)) return value.models
  return []
}

function modelTokenBudget(row) {
  const value = row?.model_messages?.token_budget
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  // `ModelTokenBudgetConfig::enabled` is `#[serde(default)]`, so an absent key
  // means disabled, and upstream `Session::token_budget` returns before touching
  // any message field when the flag is false. Every catalog row currently ships
  // with token budgeting off, which is why Codex never shows the model
  // `get_context_remaining`, `new_context` or `<context_window_guidance>`.
  if (value.enabled !== true) return undefined
  if (!Number.isInteger(value.reminder_threshold_tokens) || value.reminder_threshold_tokens < 0) return undefined
  if (!Number.isInteger(value.auto_compact_fallback_buffer_tokens) || value.auto_compact_fallback_buffer_tokens < 0) return undefined
  if (typeof value.reminder_message_template !== 'string'
    || typeof value.guidance_message !== 'string'
    || typeof value.auto_compact_fallback_prompt !== 'string') return undefined
  return {
    reminderThresholdTokens: value.reminder_threshold_tokens,
    reminderMessageTemplate: value.reminder_message_template,
    guidanceMessage: value.guidance_message,
    autoCompactFallbackPrompt: value.auto_compact_fallback_prompt,
    autoCompactFallbackBufferTokens: value.auto_compact_fallback_buffer_tokens,
  }
}

function modelTruncationPolicy(row) {
  const value = row?.truncation_policy
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  if ((value.mode !== 'bytes' && value.mode !== 'tokens') || !Number.isInteger(value.limit) || value.limit <= 0) return undefined
  return { mode: value.mode, limit: value.limit }
}

function truncationByteLimit(policy) {
  if (policy === undefined) return undefined
  return policy.mode === 'bytes' ? policy.limit : policy.limit * 4
}

function truncateToolText(text, policy) {
  const limit = truncationByteLimit(policy)
  if (limit === undefined || Buffer.byteLength(text, 'utf8') <= limit) return text
  const marker = '\n[output truncated]'
  const bodyLimit = Math.max(0, limit - Buffer.byteLength(marker, 'utf8'))
  const body = Buffer.from(text, 'utf8').subarray(0, bodyLimit).toString('utf8')
  return body + marker
}

function truncateToolContent(content, policy) {
  if (!Array.isArray(content) || policy === undefined) return content
  let changed = false
  const truncated = content.map(block => {
    if (block?.type !== 'text' || typeof block.text !== 'string') return block
    const text = truncateToolText(block.text, policy)
    if (text === block.text) return block
    changed = true
    return { ...block, text }
  })
  return changed ? truncated : content
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

/** Match the official model manager: longest slug prefix, then one safe namespace. */
function modelRowFor(model) {
  const value = String(model || '').trim()
  if (value === '') return undefined
  let best
  for (const row of catalogRows) {
    if (row === null || typeof row !== 'object' || typeof row.slug !== 'string') continue
    if (!value.startsWith(row.slug)) continue
    if (best === undefined || row.slug.length > best.slug.length) best = row
  }
  if (best !== undefined) return best
  const slash = value.indexOf('/')
  if (slash <= 0 || value.slice(slash + 1).includes('/')) return undefined
  const namespace = value.slice(0, slash)
  if (!/^[A-Za-z0-9_-]+$/.test(namespace)) return undefined
  const suffix = value.slice(slash + 1)
  for (const row of catalogRows) {
    if (row === null || typeof row !== 'object' || typeof row.slug !== 'string') continue
    if (!suffix.startsWith(row.slug)) continue
    if (best === undefined || row.slug.length > best.slug.length) best = row
  }
  return best
}

function modelInstructionsForRow(row) {
  const template = row?.model_messages?.instructions_template
  if (typeof template !== 'string') {
    return typeof row?.base_instructions === 'string' ? row.base_instructions : FALLBACK_INSTRUCTIONS
  }
  const variables = row.model_messages?.instructions_variables
  if (variables === null || typeof variables !== 'object' || Array.isArray(variables)) return template
  // DSH has no separate personality selector. Use the catalog's default
  // variable, which is the same value Codex uses when no personality is set.
  const personality = typeof variables.personality_default === 'string'
    ? variables.personality_default
    : ''
  return template.replaceAll('{{ personality }}', personality)
}

/**
 * Read one optional catalog text block.
 *
 * Upstream resolves these through the same chain everywhere: the catalog row
 * wins, and only a missing/blank entry falls back to a bundled default. Keep
 * that rule so a future upstream text change arrives with the catalog bump
 * instead of being silently masked by a local copy.
 */
function catalogText(row, key, fallback) {
  const value = row?.model_messages?.[key]
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return trimmed === '' ? fallback : value
}

/** `model_messages.collaboration_modes` is keyed per mode, not a single text. */
function catalogModeText(row, mode) {
  const value = row?.model_messages?.collaboration_modes?.[mode]
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/** `model_messages.multi_agent.role` carries the root and subagent persona text. */
function catalogMultiAgentRole(row, role) {
  const value = row?.model_messages?.multi_agent?.role?.[role]
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/**
 * Surface an unknown model id instead of silently serving the bundled
 * fallback prompt.
 *
 * A slug the pinned catalog does not know means the model runs on the legacy
 * generic Codex instructions with none of its per-model rows, so its tool mode,
 * collaboration generation and model-facing text blocks are all wrong. That is
 * a catalog-pin problem, not something the model can work around.
 */
const unknownModelWarnings = new Set()

function warnUnknownModel(model) {
  const id = String(model || '').trim()
  if (id === '' || unknownModelWarnings.has(id)) return
  unknownModelWarnings.add(id)
  process.emitWarning(
    `codex-model-parity: model "${id}" is not in the pinned official catalog; `
    + 'it is falling back to the generic Codex instructions and a default tool surface. '
    + 'Re-pin dsh-codex.nix if this model exists upstream.',
    'codex-model-parity:unknown-model',
  )
}

function normalizeShellType(value) {
  if (value === 'shell_command' || value === 'default' || value === 'local' || value === 'unified_exec') {
    return 'unified_exec'
  }
  if (value === 'disabled') return 'disabled'
  return value
}

function normalizeToolMode(value) {
  switch (value) {
    // Official Codex names this combined surface `code_mode`; `both` is kept
    // for older pinned catalogs that used the pre-release spelling.
    case 'code_mode':
    case 'both':
      return 'both'
    case 'code_mode_only':
      return 'code_mode_only'
    case 'direct':
    default:
      return 'native'
  }
}

function profileForModel(model) {
  const id = modelTail(model)
  const row = modelRowFor(model)
  if (row === undefined) {
    warnUnknownModel(model)
    return { ...DEFAULT_PROFILE, model: id, instructions: FALLBACK_INSTRUCTIONS }
  }
  const toolMode = normalizeToolMode(row.tool_mode)
  const multiAgentVersion = row.multi_agent_version === 'v1' || row.multi_agent_version === 'v2'
    ? row.multi_agent_version
    : 'none'
  return {
    ...DEFAULT_PROFILE,
    model: id,
    instructions: modelInstructionsForRow(row),
    persistentInstructions: catalogText(row, 'persistent_instructions', ''),
    collaborationModeDefault: catalogModeText(row, 'default', ''),
    collaborationModePlan: catalogModeText(row, 'plan', ''),
    multiAgentRoleRoot: catalogMultiAgentRole(row, 'root'),
    multiAgentRoleSubagent: catalogMultiAgentRole(row, 'subagent'),
    approvalMessages: row.model_messages?.approvals ?? null,
    permissionMessages: row.model_messages?.permissions ?? null,
    experimentalTools: Array.isArray(row.experimental_supported_tools)
      ? row.experimental_supported_tools.filter(name => typeof name === 'string')
      : [],
    toolMode,
    multiAgentVersion,
    applyPatchToolType: typeof row.apply_patch_tool_type === 'string' ? row.apply_patch_tool_type : 'freeform',
    shellType: normalizeShellType(typeof row.shell_type === 'string' ? row.shell_type : 'unified_exec'),
    supportsParallelToolCalls: row.supports_parallel_tool_calls !== false,
    useResponsesLite: row.use_responses_lite === true,
    includeSkillsUsageInstructions: INCLUDE_LOCAL_SKILLS || row.include_skills_usage_instructions !== false,
    includeAppsUsageInstructions: row.include_apps_usage_instructions !== false,
    includePluginUsageInstructions: row.include_plugin_usage_instructions !== false,
    inputModalities: Array.isArray(row.input_modalities) ? row.input_modalities : ['text'],
    supportsImageDetailOriginal: row.supports_image_detail_original === true,
    // The official model field defaults to false when absent; only an
    // explicit catalog opt-in should expose a network search tool.
    supportsSearchTool: row.supports_search_tool === true,
    webSearchToolType: typeof row.web_search_tool_type === 'string' ? row.web_search_tool_type : undefined,
    defaultReasoningLevel: typeof row.default_reasoning_level === 'string' ? row.default_reasoning_level : undefined,
    contextWindow: Number.isInteger(row.context_window) ? row.context_window : undefined,
    maxContextWindow: Number.isInteger(row.max_context_window) ? row.max_context_window : undefined,
    effectiveContextWindowPercent: Number.isInteger(row.effective_context_window_percent)
      && row.effective_context_window_percent > 0
      ? row.effective_context_window_percent
      : 95,
    autoCompactTokenLimit: Number.isInteger(row.auto_compact_token_limit) && row.auto_compact_token_limit > 0
      ? row.auto_compact_token_limit
      : undefined,
    tokenBudget: modelTokenBudget(row),
    supportVerbosity: row.support_verbosity === true,
    defaultVerbosity: typeof row.default_verbosity === 'string' ? row.default_verbosity : undefined,
    reasoningSummaryFormat: typeof row.reasoning_summary_format === 'string' ? row.reasoning_summary_format : undefined,
    defaultReasoningSummary: typeof row.default_reasoning_summary === 'string' ? row.default_reasoning_summary : undefined,
    truncationPolicy: modelTruncationPolicy(row),
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

function tokenBudgetStateFor(session, profile) {
  const generation = Number.isInteger(session?.surface?.replaceGeneration)
    ? session.surface.replaceGeneration
    : 0
  const route = profile.model
  let state = TOKEN_BUDGET_STATES.get(session)
  if (state === undefined || state.generation !== generation || state.route !== route) {
    state = { generation, route, reminderDelivered: false, fallbackDelivered: false }
    TOKEN_BUDGET_STATES.set(session, state)
  }
  return state
}

function tokenBudgetContextText(ctx, agent, selectedProfile) {
  const profile = selectedProfile ?? profileForModel(currentModel(agent))
  const budget = profile.tokenBudget
  const parts = []
  if (profile.supportVerbosity && profile.defaultVerbosity !== undefined) {
    parts.push('<model_response_preferences>\n'
      + 'Default response verbosity: ' + profile.defaultVerbosity + '. Match this level unless the user requests a different level.\n'
      + '</model_response_preferences>')
  }
  if (budget === undefined) return parts.join('\n\n')
  if (budget.guidanceMessage.trim() !== '') {
    parts.push('<context_window_guidance>\n' + budget.guidanceMessage + '\n</context_window_guidance>')
  }

  const baseWindowTokensRemaining = contextTokensRemaining(ctx, agent, profile)
  if (baseWindowTokensRemaining === undefined) return parts.join('\n\n')
  const state = tokenBudgetStateFor(agent.session, profile)
  if (baseWindowTokensRemaining <= budget.reminderThresholdTokens && !state.reminderDelivered) {
    state.reminderDelivered = true
    parts.push(budget.reminderMessageTemplate.replaceAll('{n_remaining}', String(baseWindowTokensRemaining)))
  }
  if (baseWindowTokensRemaining === 0
    && budget.autoCompactFallbackPrompt.trim() !== ''
    && !state.fallbackDelivered) {
    state.fallbackDelivered = true
    parts.push(budget.autoCompactFallbackPrompt)
  }
  return parts.join('\n\n')
}

/** Match Codex's model-callable remaining-context utility with the local meter. */
function contextTokensRemaining(ctx, agent, profile = profileForModel(currentModel(agent))) {
  const meter = (() => {
    try { return ctx.get('tokenMeter') } catch { return undefined }
  })()
  const contextWindow = profile.contextWindow ?? profile.maxContextWindow
  if (meter === undefined || typeof meter.measure !== 'function' || !Number.isInteger(contextWindow) || contextWindow <= 0) {
    return undefined
  }
  let measurement
  try {
    measurement = meter.measure(agent.session)
  } catch {
    return undefined
  }
  const effectiveLimit = Math.floor(contextWindow * profile.effectiveContextWindowPercent / 100)
  const derivedCompactLimit = Math.floor(contextWindow * 0.9)
  const compactLimit = Number.isInteger(profile.autoCompactTokenLimit)
    ? Math.min(profile.autoCompactTokenLimit, derivedCompactLimit)
    : derivedCompactLimit
  return Math.max(0, Math.min(effectiveLimit, compactLimit) - Math.max(0, measurement.totalTokens))
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

/**
 * CodeModeOnly hides only tools that have a Code Mode binding.  Codex keeps
 * DirectModelOnly tools visible beside exec/wait: request_user_input and, by
 * default, the V2 collaboration surface.  They deliberately stay out of the
 * nested SDK.
 */
function isCodeModeOnlyDirectTool(name, profile) {
  return name === CODE_MODE_TOOL
    || name === WAIT_TOOL
    || name === NEW_CONTEXT_TOOL
    || name === REQUEST_PERMISSIONS_TOOL
    || name === REQUEST_USER_INPUT_ASYNC
    || name === CLOCK_TIME
    || name === CLOCK_SLEEP
    || name === 'update_plan'
    || name === 'request_user_input'
    || (profile?.multiAgentVersion === 'v1' && V1_NAMES.has(name))
    || (profile?.multiAgentVersion === 'v2' && V2_NAMES.has(name))
}

/** Official catalog keys that unlock the async user-input tool. */
function asyncUserInputAdvertised(profile) {
  return profile.experimentalTools.includes(REQUEST_USER_INPUT_ASYNC)
    || profile.experimentalTools.includes(SEND_USER_MESSAGE_ASYNC)
}

function modelToolAllowed(ctx, profile, name, agent, nested, toolArguments) {
  if (DSH_NATIVE_TOOLS.has(name)) return false
  if (!nested && name === RUN_CODE) return false
  // Upstream registers these from `experimental_supported_tools` and marks them
  // DirectModelOnly, so they stay out of the nested Code Mode SDK.
  if (name === REQUEST_USER_INPUT_ASYNC) return asyncUserInputAdvertised(profile) && !nested
  if (name === CLOCK_TIME) return profile.experimentalTools.includes('clock')
  if (name === CLOCK_SLEEP) return profile.experimentalTools.includes('clock') && !nested
  if (!nested && profile.toolMode === 'code_mode_only' && !isCodeModeOnlyDirectTool(name, profile)) return false
  if (!nested && profile.toolMode === 'native' && (name === CODE_MODE_TOOL || name === WAIT_TOOL)) return false
  if (nested && (name === RUN_CODE || name === CODE_MODE_TOOL || name === WAIT_TOOL)) return false
  if ((name === 'exec_command' || name === 'write_stdin') && normalizeShellType(profile.shellType) !== 'unified_exec') return false
  if (name === 'apply_patch' && profile.applyPatchToolType === 'none') return false
  if (name === WEB_RUN && (!profile.useResponsesLite || !profile.supportsSearchTool)) return false
  if (name === WEB_SEARCH && (profile.useResponsesLite || !profile.supportsSearchTool)) return false
  if (name === WEB_RUN && profile.webSearchToolType === 'text' && toolArguments !== undefined
    && toolArguments !== null && typeof toolArguments === 'object' && toolArguments.image_query !== undefined) return false
  if (name === SKILL && !profile.includeSkillsUsageInstructions) return false
  if (name === 'view_image' && !isImageCapable(profile)) return false
  if (name === GET_CONTEXT_REMAINING_TOOL) {
    return profile.tokenBudget !== undefined && (nested || profile.toolMode !== 'code_mode_only')
  }
  if (name === NEW_CONTEXT_TOOL) {
    return profile.tokenBudget !== undefined && !nested
  }
  if (name === REQUEST_PERMISSIONS_TOOL) return !nested
  // DSH's update_plan implementation is safe to dispatch from Code Mode and
  // models commonly compose it beside their shell/edit calls. Keep it in the
  // nested SDK as well as the direct surface; Plan mode still owns its own
  // execution-time rejection.
  if (name === 'update_plan') return true
  if (name === 'request_user_input' && nested) return false
  if (name === 'request_user_input' && profile.toolMode !== 'code_mode_only' && !planModeActive(ctx, agent)) return false
  if (isV1Tool(name)) return profile.multiAgentVersion === 'v1' && !nested
  // Upstream's default MultiAgentV2 configuration is DirectModelOnly.  In a
  // CodeModeOnly row those controls remain direct siblings of exec/wait rather
  // than Code Mode SDK methods.
  if (V2_NAMES.has(name)) return profile.multiAgentVersion === 'v2' && !nested
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

function patchWebSearchSchema(schema, profile) {
  if (schema.name !== WEB_RUN || profile.webSearchToolType !== 'text') return schema
  const parameters = structuredClone(schema.parameters)
  if (parameters !== null && typeof parameters === 'object') {
    const properties = parameters.properties
    if (properties !== null && typeof properties === 'object') delete properties.image_query
  }
  return { ...schema, parameters }
}

function patchToolSchema(schema, profile) {
  return patchWebSearchSchema(patchImageSchema(schema, profile), profile)
}

function nativeSchemas(ctx, agent, profile) {
  return ctx.tools.schemas(agent)
    .filter(schema => modelToolAllowed(ctx, profile, schema.name, agent, false))
    .map(schema => patchToolSchema(schema, profile))
}

function sdkSchemas(ctx, agent, profile) {
  return ctx.tools.schemas(agent)
    .filter(schema => modelToolAllowed(ctx, profile, schema.name, agent, true))
    .map(schema => {
      const definition = ctx.tools.get(schema.name, agent)
      return {
        ...patchToolSchema(schema, profile),
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

const CODE_MODE_RUNTIME_GUIDANCE = [
  '## Codex Code Mode runtime',
  'Inside `exec`, write a raw JavaScript async-function body and use the declared `tools` SDK for every tool call.',
  'Use `text(value)` for textual output; do not use `console`, Node APIs, filesystem APIs, or network APIs directly.',
  '`image(value)`, `audio(value)`, `generatedImage(value)`, `store(key, value)`, `load(key)`, `notify(value)`, `yield_control()`, and `exit()` are available with their Codex meanings when supported by the selected route.',
  'The host keeps the official names and output contract, while long-running programs remain bounded by the host and may not provide a resumable cell.',
].join('\n')

function rewriteCodeModeSdk(text, profile) {
  const rewritten = rewriteCodeModeName(text, profile)
  if (profile.toolMode !== 'code_mode_only') return rewritten
  return [
    CODE_MODE_RUNTIME_GUIDANCE,
    rewritten.replace('`console.log(...)`', '`text(...)`'),
  ].join('\n\n')
}

function registerNewContextTool(ctx) {
  ctx.tools.register(defineTool({
    name: NEW_CONTEXT_TOOL,
    description: 'Start a new context window. Does not clear, reset, or otherwise affect environment state.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.status === 'started'
          ? 'Started a new Codex context window.'
          : 'A new Codex context window could not be started because no compactable context was available.',
      }],
    },
    async execute(_args, execution) {
      const agent = execution.agent
      const compaction = ctx.get('compaction')
      if (agent === undefined || compaction === undefined || typeof compaction.compactNow !== 'function') {
        return { status: 'unavailable' }
      }
      const result = await compaction.compactNow(agent, execution.signal)
      return { status: result === null ? 'unavailable' : 'started' }
    },
  }))
}

function registerContextBudgetTools(ctx) {
  ctx.tools.register(defineTool({
    name: GET_CONTEXT_REMAINING_TOOL,
    description: 'Get the remaining tokens in the current context window.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tokens_left: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.tokens_left === null
          ? 'You have unknown tokens left in this context window.'
          : `You have ${value.tokens_left} tokens left in this context window.`,
      }],
    },
    async execute(_args, execution) {
      const agent = execution.agent
      if (agent === undefined) return { tokens_left: null }
      const profile = profileForModel(currentModel(agent))
      return { tokens_left: contextTokensRemaining(ctx, agent, profile) ?? null }
    },
  }))
  registerNewContextTool(ctx)
}

function codeModeOnlyDirectToolNames(profileOrCodeModeOnly) {
  const names = [CODE_MODE_TOOL, WAIT_TOOL, NEW_CONTEXT_TOOL, REQUEST_PERMISSIONS_TOOL]
  if (profileOrCodeModeOnly !== null && typeof profileOrCodeModeOnly === 'object') {
    names.push('request_user_input')
    if (profileOrCodeModeOnly.multiAgentVersion === 'v1') names.push(...V1_NAMES)
    if (profileOrCodeModeOnly.multiAgentVersion === 'v2') names.push(...V2_NAMES)
  }
  return names
}

function quotedToolList(names) {
  const quoted = names.map(name => '`' + name + '`')
  if (quoted.length <= 1) return quoted[0] ?? ''
  if (quoted.length === 2) return quoted[0] + ' and ' + quoted[1]
  return quoted.slice(0, -1).join(', ') + ', and ' + quoted.at(-1)
}

function codeModeBoundary(profile) {
  if (profile.toolMode !== 'code_mode_only') return undefined
  const directBoundary = quotedToolList(codeModeOnlyDirectToolNames(profile))
  return [
    '<codex_code_mode_boundary>',
    `The selected Codex model uses Code Mode. ${directBoundary} are the only tools you can call directly.`,
    'Do not emit a top-level tool call naming any other tool, even if that name appears in general Codex instructions.',
    'Use `exec` with a JavaScript program, and call the other tools from inside that program through the provided `tools` SDK, for example `await tools.exec_command(...)` or `await tools.apply_patch(...)`.',
    profile.includeSkillsUsageInstructions
      ? 'The `skill` tool, when available, is also reached through the `tools` SDK.'
      : 'The `skill` tool is not available for this model; do not call it directly or through the `tools` SDK.',
    '</codex_code_mode_boundary>',
  ].join('\n')
}

/**
 * Upstream `CollaborationModeInstructions` wraps the active mode in
 * `<collaboration_mode>` markers and re-sends it whenever the mode changes.
 * Codex ships `default.md` and `plan.md`; a catalog row may override either.
 * The Plan template already reaches the model through dsh's `plan:policy`
 * section, so this only supplies Default mode; the assemble hook wraps the
 * Plan section in the same markers.
 */
function collaborationModeBlock(ctx, agent, profile) {
  if (planModeActive(ctx, agent)) return undefined
  const text = profile.collaborationModeDefault ?? DEFAULT_MODE_TEMPLATE
  if (typeof text !== 'string' || text.trim() === '') return undefined
  return ['<collaboration_mode>', text.trim(), '</collaboration_mode>'].join('\n')
}

/**
 * Upstream enables persistent mode only for `ReasoningEffort::Persistent`, so
 * the catalog text stays dormant by default. DSH has no matching effort id,
 * so the preset exposes it as an explicit opt-in that mirrors the official
 * "Persistent" entry in the reasoning-effort picker.
 */
function persistentModeBlock(profile, persistent) {
  const template = profile.persistentInstructions
  if (!persistent || typeof template !== 'string' || template.trim() === '') return undefined
  const channel = profile.experimentalTools.includes(SEND_USER_MESSAGE_ASYNC)
    ? ' via functions.send_user_message_async'
    : ''
  return [
    '<persistent_mode>',
    template.trim().replaceAll('{{ approval_request_channel }}', channel),
    '</persistent_mode>',
  ].join('\n')
}

function persistentModeEnabled(session) {
  return session !== undefined && persistentModes.get(session) === true
}

function multiAgentRoleBlock(profile) {
  const text = profile.multiAgentRoleRoot
  if (text === undefined) return undefined
  return ['<multi_agent_role>', text, '</multi_agent_role>'].join('\n')
}

/**
 * The bundled `multi_agent.usage_hint` upstream appends whenever a
 * collaboration surface is available. Two facts matter to the model and are
 * otherwise invisible: the concurrency ceiling, and that agents share one
 * filesystem rather than getting isolated checkouts.
 */
function multiAgentUsageHintBlock(profile) {
  if (profile.multiAgentVersion === 'none') return undefined
  const namespace = profile.multiAgentVersion === 'v2' ? 'collaboration' : 'multi_agent_v1'
  return [
    '<multi_agent_usage_hint>',
    `Note that collaboration tools cannot be called from inside \`exec\`. Call ${quotedToolList(profile.multiAgentVersion === 'v2' ? [...V2_NAMES] : [...V1_NAMES])} only as direct tool calls, since they are intentionally absent from the \`exec\` \`tools\` namespace.`,
    'All agents share the same directory. In detail:',
    '- All agents have access to the same container and filesystem as you.',
    '- All agents use the same current working directory.',
    '- As a result, edits made by one agent are immediately visible to all other agents.',
    `Give each delegated coding task a disjoint write set so parallel agents do not overwrite each other.`,
    `There are ${SUBAGENT_CONCURRENCY} available concurrency slots, meaning that up to ${SUBAGENT_CONCURRENCY} agents can be active at once, including you.`,
    `Spawned agents inherit your current model by default; prefer leaving \`model\` unset. This preset exposes the \`${namespace}\` namespace only.`,
    '</multi_agent_usage_hint>',
  ].join('\n')
}

/**
 * Upstream sends `<model_switch>` at the head of the developer bundle when the
 * selected model changes. DSH rebuilds the system prompt per request instead,
 * so the equivalent is a one-shot marker that re-anchors the model on the
 * freshly assembled instructions without duplicating them.
 */
function modelSwitchBlock(session, model) {
  const id = String(model || '').trim()
  if (id === '' || session === undefined) return undefined
  if (lastPromptedModel.get(session) === id) return undefined
  lastPromptedModel.set(session, id)
  return [
    '<model_switch>',
    `The user was previously using a different model. The model is now \`${id}\`, and the instructions that follow describe this model. Continue the conversation according to them.`,
    '</model_switch>',
  ].join('\n')
}

const lastPromptedModel = new WeakMap()

/** Add the upstream `<collaboration_mode>` envelope around a mode template. */
function wrapCollaborationMode(text) {
  if (typeof text !== 'string' || text.trim() === '') return text
  if (text.startsWith('<collaboration_mode>')) return text
  return ['<collaboration_mode>', text.trim(), '</collaboration_mode>'].join('\n')
}

function modelInstructions(profile, ctx, agent) {
  const base = typeof profile.instructions === 'string' ? profile.instructions.trim() : ''
  const session = agent?.session
  return [
    modelSwitchBlock(session, profile.model),
    base,
    codeModeBoundary(profile),
    collaborationModeBlock(ctx, agent, profile),
    persistentModeBlock(profile, session === undefined ? false : persistentModeEnabled(session)),
    multiAgentRoleBlock(profile),
    multiAgentUsageHintBlock(profile),
  ].filter(block => block !== undefined && block !== '').join('\n\n')
}

function rewriteCodeModeName(text, profileOrCodeModeOnly = false) {
  if (typeof text !== 'string') return text
  const codeModeOnly = typeof profileOrCodeModeOnly === 'object' && profileOrCodeModeOnly !== null
    ? profileOrCodeModeOnly.toolMode === 'code_mode_only'
    : profileOrCodeModeOnly === true
  const directBoundary = quotedToolList(codeModeOnlyDirectToolNames(profileOrCodeModeOnly))
    + ' are the only tools you can call directly'
  const rewritten = text
    .replaceAll(RUN_CODE, CODE_MODE_TOOL)
    .replace('`exec` is the only tool you can call directly', directBoundary)
  if (!codeModeOnly || rewritten.trim() !== '') return rewritten
  return directBoundary + ' — a tool call naming any other tool fails. Reach every tool the SDK declares below from inside the program.'
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

// Code Mode is a model-facing adapter, but its source is an implementation
// detail for people looking at a Codex run. These small, deliberately static
// readers extract the common argument shapes emitted by the model so the
// outer exec card can show the same kind of summary as a native tool card.
// They never execute source code: unresolved expressions are shown verbatim
// as Code Mode expressions instead of being hidden behind a vague placeholder.
function previewQuotedToken(text, start) {
  const quote = text[start]
  if (quote !== '"' && quote !== String.fromCharCode(39) && quote !== String.fromCharCode(96)) return undefined
  let escaped = false
  for (let index = start + 1; index < text.length; index++) {
    const character = text[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (character === String.fromCharCode(92)) {
      escaped = true
      continue
    }
    if (character === quote) return { token: text.slice(start, index + 1), end: index + 1 }
  }
  return undefined
}

function previewDecodeString(token, bindings = new Map(), resolving = new Set()) {
  const text = String(token).trim()
  const quote = text[0]
  if ((quote !== '"' && quote !== String.fromCharCode(39) && quote !== String.fromCharCode(96)) || text.at(-1) !== quote) return undefined
  const body = text.slice(1, -1)
  let output = ''
  for (let index = 0; index < body.length; index++) {
    const character = body[index]
    if (character !== String.fromCharCode(92)) {
      output += character
      continue
    }
    const escaped = body[++index]
    if (escaped === undefined) break
    if (quote === String.fromCharCode(96) && escaped === '$' && body[index + 1] === '{') {
      // Preserve an escaped template opener (`\${...}`), which is commonly
      // used for a literal shell parameter expansion. The marker prevents the
      // interpolation pass below from treating it as JavaScript.
      output += PREVIEW_ESCAPED_TEMPLATE_MARKER + '$'
      continue
    }
    switch (escaped) {
      case 'n': output += String.fromCharCode(10); break
      case 'r': output += String.fromCharCode(13); break
      case 't': output += String.fromCharCode(9); break
      case 'b': output += String.fromCharCode(8); break
      case 'f': output += String.fromCharCode(12); break
      case 'v': output += String.fromCharCode(11); break
      case '0': output += String.fromCharCode(0); break
      case 'x': {
        const hex = body.slice(index + 1, index + 3)
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
          output += String.fromCharCode(Number.parseInt(hex, 16))
          index += 2
        } else output += escaped
        break
      }
      case 'u': {
        if (body[index + 1] === '{') {
          const end = body.indexOf('}', index + 2)
          const hex = end < 0 ? '' : body.slice(index + 2, end)
          if (/^[0-9a-fA-F]+$/.test(hex)) {
            try { output += String.fromCodePoint(Number.parseInt(hex, 16)); index = end } catch { output += escaped }
          } else output += escaped
        } else {
          const hex = body.slice(index + 1, index + 5)
          if (/^[0-9a-fA-F]{4}$/.test(hex)) {
            output += String.fromCharCode(Number.parseInt(hex, 16))
            index += 4
          } else output += escaped
        }
        break
      }
      case String.fromCharCode(10):
      case String.fromCharCode(13):
        if (escaped === String.fromCharCode(13) && body[index + 1] === String.fromCharCode(10)) index++
        break
      default: output += escaped
    }
  }
  if (quote === String.fromCharCode(96)) {
    const expanded = output.replace(/\$\{([^{}]*)\}/g, (match, expression, offset, fullText) => {
      if (offset > 0 && fullText[offset - 1] === PREVIEW_ESCAPED_TEMPLATE_MARKER) return match
      // A raw `${name:-fallback}` is shell syntax, not a useful JavaScript
      // preview expression. The runtime normalizer escapes it before execution;
      // the card should still show the command the shell will receive.
      if (/^[A-Za-z_][A-Za-z0-9_]*:[-+?=]/.test(String(expression).trim())) return match
      const value = previewLiteral(expression, bindings, resolving)
      // Keep unresolved JavaScript expressions visible. Returning the original
      // `${...}` text gives the user a useful command preview instead of the
      // unhelpful `cmd (Code Mode expression)` fallback.
      if (value === undefined) return match
      if (value === null) return 'null'
      if (typeof value === 'string') return value
      if (typeof value === 'object') {
        try { return JSON.stringify(value) } catch { return String(value) }
      }
      return String(value)
    })
    return expanded.replaceAll(PREVIEW_ESCAPED_TEMPLATE_MARKER, '')
  }
  return output
}

function previewBalancedEnd(text, start) {
  const opening = text[start]
  const closing = opening === '(' ? ')' : opening === '[' ? ']' : opening === '{' ? '}' : undefined
  if (closing === undefined) return undefined
  let depth = 0
  let quote
  let escaped = false
  for (let index = start; index < text.length; index++) {
    const character = text[index]
    if (quote !== undefined) {
      if (escaped) escaped = false
      else if (character === String.fromCharCode(92)) escaped = true
      else if (character === quote) quote = undefined
      continue
    }
    if (character === '"' || character === String.fromCharCode(39) || character === String.fromCharCode(96)) {
      quote = character
      continue
    }
    if (character === opening) depth++
    else if (character === closing) {
      depth--
      if (depth === 0) return index
    }
  }
  return undefined
}

function previewExpressionEnd(text, start) {
  let depth = 0
  let quote
  let escaped = false
  for (let index = start; index < text.length; index++) {
    const character = text[index]
    if (quote !== undefined) {
      if (escaped) escaped = false
      else if (character === String.fromCharCode(92)) escaped = true
      else if (character === quote) quote = undefined
      continue
    }
    if (character === '"' || character === String.fromCharCode(39) || character === String.fromCharCode(96)) {
      quote = character
      continue
    }
    if (character === '(' || character === '[' || character === '{') {
      depth++
      continue
    }
    if (character === ')' || character === ']' || character === '}') {
      if (depth === 0) return text.slice(start, index).trim()
      depth--
      continue
    }
    if (depth === 0 && character === ',') return text.slice(start, index).trim()
  }
  return text.slice(start).trim()
}

function previewStatementExpression(text, start) {
  let depth = 0
  let quote
  let escaped = false
  let end = text.length
  for (let index = start; index < text.length; index++) {
    const character = text[index]
    if (quote !== undefined) {
      if (escaped) escaped = false
      else if (character === String.fromCharCode(92)) escaped = true
      else if (character === quote) quote = undefined
      continue
    }
    if (character === '"' || character === String.fromCharCode(39) || character === String.fromCharCode(96)) {
      quote = character
      continue
    }
    if (character === '(' || character === '[' || character === '{') {
      depth++
      continue
    }
    if (character === ')' || character === ']' || character === '}') {
      if (depth > 0) depth--
      continue
    }
    if (depth === 0 && (character === ';' || character === ',' || character === '\n' || character === '\r')) {
      end = index
      break
    }
  }
  return { expression: text.slice(start, end).trim(), end }
}

function previewTopLevelIndex(text, wanted) {
  let depth = 0
  let quote
  let escaped = false
  for (let index = 0; index < text.length; index++) {
    const character = text[index]
    if (quote !== undefined) {
      if (escaped) escaped = false
      else if (character === String.fromCharCode(92)) escaped = true
      else if (character === quote) quote = undefined
      continue
    }
    if (character === '"' || character === String.fromCharCode(39) || character === String.fromCharCode(96)) {
      quote = character
      continue
    }
    if (character === '(' || character === '[' || character === '{') {
      depth++
      continue
    }
    if (character === ')' || character === ']' || character === '}') {
      if (depth > 0) depth--
      continue
    }
    if (depth === 0 && character === wanted) return index
  }
  return -1
}

function previewSplitTopLevel(text, separator) {
  const parts = []
  let start = 0
  let depth = 0
  let quote
  let escaped = false
  for (let index = 0; index < text.length; index++) {
    const character = text[index]
    if (quote !== undefined) {
      if (escaped) escaped = false
      else if (character === String.fromCharCode(92)) escaped = true
      else if (character === quote) quote = undefined
      continue
    }
    if (character === '"' || character === String.fromCharCode(39) || character === String.fromCharCode(96)) {
      quote = character
      continue
    }
    if (character === '(' || character === '[' || character === '{') {
      depth++
      continue
    }
    if (character === ')' || character === ']' || character === '}') {
      if (depth > 0) depth--
      continue
    }
    if (depth === 0 && character === separator) {
      parts.push(text.slice(start, index).trim())
      start = index + 1
    }
  }
  parts.push(text.slice(start).trim())
  return parts
}

function previewKeyEscape(key) {
  return String(key).replace(/[^A-Za-z0-9_]/g, character => String.fromCharCode(92) + character)
}

function previewPropertyExpression(source, key) {
  const text = String(source)
  const escapedKey = previewKeyEscape(key)
  const keyPattern = '(?:' + escapedKey + '|["' + String.fromCharCode(39) + ']' + escapedKey + '["' + String.fromCharCode(39) + '])'
  const match = new RegExp('(?:^\\s*|[,{]\\s*)' + keyPattern + '\\s*:').exec(text)
  if (match !== null) {
    const colon = text.indexOf(':', match.index)
    return previewExpressionEnd(text, colon + 1)
  }
  const shorthand = new RegExp('(?:^\\s*|[,{]\\s*)' + escapedKey + '(?=\\s*(?:[,}]))').exec(text)
  return shorthand === null ? undefined : key
}

function previewPropertyExpressions(source, key) {
  const text = String(source)
  const escapedKey = previewKeyEscape(key)
  const keyPattern = '(?:' + escapedKey + '|["' + String.fromCharCode(39) + ']' + escapedKey + '["' + String.fromCharCode(39) + '])'
  const pattern = new RegExp('(?:^|[,{]\\s*)' + keyPattern + '\\s*:', 'g')
  const expressions = []
  let match
  while ((match = pattern.exec(text)) !== null) {
    const start = match.index + match[0].length
    const expression = previewExpressionEnd(text, start)
    if (expression.length > 0) expressions.push(expression)
    pattern.lastIndex = Math.max(pattern.lastIndex, start + Math.max(expression.length, 1))
  }
  return expressions
}

function previewObjectLiteral(text, bindings, resolving) {
  const end = previewBalancedEnd(text, 0)
  if (end !== text.length - 1) return undefined
  const inner = text.slice(1, -1).trim()
  if (inner === '') return {}
  const value = {}
  for (const part of previewSplitTopLevel(inner, ',')) {
    if (part === '') continue
    const colon = previewTopLevelIndex(part, ':')
    const keyText = colon < 0 ? part : part.slice(0, colon).trim()
    const keyToken = previewQuotedToken(keyText, 0)
    const key = keyToken !== undefined && keyToken.end === keyText.length
      ? previewDecodeString(keyToken.token, bindings, resolving)
      : /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(keyText) ? keyText : undefined
    if (key === undefined) return undefined
    const expression = colon < 0 ? keyText : part.slice(colon + 1)
    const item = previewLiteral(expression, bindings, resolving)
    if (item === undefined) return undefined
    value[key] = item
  }
  return value
}

function previewLiteral(expression, bindings = new Map(), resolving = new Set()) {
  if (expression === undefined) return undefined
  let text = String(expression).trim().replace(/;$/, '').trim()
  while (text.startsWith('await ')) text = text.slice(6).trim()
  if (text.startsWith('(')) {
    const end = previewBalancedEnd(text, 0)
    if (end === text.length - 1) return previewLiteral(text.slice(1, -1), bindings, resolving)
  }
  const assertion = /^([\s\S]+)\s+(?:as|satisfies)\s+(?:const|[A-Za-z_$][A-Za-z0-9_$]*(?:<[^<>]*>)?(?:\[\])?)$/.exec(text)
  if (assertion !== null) return previewLiteral(assertion[1], bindings, resolving)
  const quoted = previewQuotedToken(text, 0)
  if (quoted !== undefined && quoted.end === text.length) return previewDecodeString(quoted.token, bindings, resolving)
  if (text === 'true') return true
  if (text === 'false') return false
  if (text === 'null') return null
  if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) return Number(text)
  const identifier = /^([A-Za-z_$][A-Za-z0-9_$]*)$/.exec(text)
  if (identifier !== null && bindings.has(identifier[1])) {
    if (resolving.has(identifier[1])) return undefined
    const next = new Set(resolving)
    next.add(identifier[1])
    return previewLiteral(bindings.get(identifier[1]), bindings, next)
  }
  const member = /^([A-Za-z_$][A-Za-z0-9_$]*)(?:\.([A-Za-z_$][A-Za-z0-9_$]*))+$/.exec(text)
  if (member !== null && bindings.has(member[1])) {
    const base = previewLiteral(member[1], bindings, resolving)
    if (base === undefined || base === null || typeof base !== 'object') return undefined
    let value = base
    for (const property of text.slice(member[1].length + 1).split('.')) {
      if (!Object.prototype.hasOwnProperty.call(value, property)) return undefined
      value = value[property]
    }
    return value
  }
  const stringFunction = /^(String|Number)\(([\s\S]*)\)$/.exec(text)
  if (stringFunction !== null) {
    const end = previewBalancedEnd(text, text.indexOf('('))
    if (end === text.length - 1) {
      const item = previewLiteral(stringFunction[2], bindings, resolving)
      if (item !== undefined) return stringFunction[1] === 'String' ? String(item) : Number(item)
    }
  }
  const charFunction = /^String\.(fromCharCode|fromCodePoint)\(([\s\S]*)\)$/.exec(text)
  if (charFunction !== null) {
    const open = text.indexOf('(')
    const end = previewBalancedEnd(text, open)
    if (end === text.length - 1) {
      const parts = charFunction[2].trim() === '' ? [] : previewSplitTopLevel(charFunction[2], ',')
      const values = parts.map(item => previewLiteral(item, bindings, resolving))
      if (!values.some(item => item === undefined) && values.every(item => typeof item === 'number')) {
        try {
          return charFunction[1] === 'fromCharCode'
            ? String.fromCharCode(...values)
            : String.fromCodePoint(...values)
        } catch {
          return undefined
        }
      }
    }
  }
  if (text.startsWith('[')) {
    const arrayEnd = previewBalancedEnd(text, 0)
    if (arrayEnd === text.length - 1) {
      const inner = text.slice(1, -1).trim()
      if (inner === '') return []
      const parts = previewSplitTopLevel(inner, ',')
      if (parts.at(-1) === '') parts.pop()
      const values = parts.map(item => previewLiteral(item, bindings, resolving))
      return values.some(item => item === undefined) ? undefined : values
    }
    if (arrayEnd !== undefined && text.slice(arrayEnd + 1).trim().startsWith('.join')) {
      const tail = text.slice(arrayEnd + 1).trim()
      const open = tail.indexOf('(')
      const close = open < 0 ? -1 : previewBalancedEnd(tail, open)
      if (open >= 0 && close === tail.length - 1) {
        const joinArguments = tail.slice(open + 1, close).trim()
        const separator = joinArguments === '' ? ',' : previewLiteral(joinArguments, bindings, resolving)
        const arrayText = text.slice(1, arrayEnd).trim()
        const parts = arrayText === '' ? [] : previewSplitTopLevel(arrayText, ',')
        if (parts.at(-1) === '') parts.pop()
        const values = parts.map(item => previewLiteral(item, bindings, resolving))
        if (separator !== undefined && !values.some(item => item === undefined)) return values.join(String(separator))
      }
    }
  }
  if (text.startsWith('{')) {
    const object = previewObjectLiteral(text, bindings, resolving)
    if (object !== undefined) return object
  }
  const concatenated = previewSplitTopLevel(text, '+')
  if (concatenated.length > 1) {
    let value = previewLiteral(concatenated[0], bindings, resolving)
    if (value === undefined) return undefined
    for (const part of concatenated.slice(1)) {
      const next = previewLiteral(part, bindings, resolving)
      if (next === undefined) return undefined
      if (typeof value === 'string' || typeof next === 'string') value = String(value) + String(next)
      else if (typeof value === 'number' && typeof next === 'number') value += next
      else return undefined
    }
    return value
  }
  return undefined
}

function previewBindings(source) {
  const text = String(source)
  const bindings = new Map()
  // TypeScript annotations are stripped before execution but remain in the
  // model-authored source used for the pending-call card.
  const pattern = /\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::\s*[^=\n;]+)?\s*=/g
  let match
  while ((match = pattern.exec(text)) !== null) {
    const parsed = previewStatementExpression(text, pattern.lastIndex)
    if (parsed.expression !== '') bindings.set(match[1], parsed.expression)
    pattern.lastIndex = parsed.end < text.length ? parsed.end + 1 : text.length
  }
  // Also follow the common two-step form (`let cmd; cmd = ...`). Keep the
  // declaration pass above because it handles multiline initializers; this
  // narrow statement-boundary matcher avoids treating object properties as
  // variable assignments.
  const assignmentPattern = /(?:^|[;\n\r])\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*=/g
  while ((match = assignmentPattern.exec(text)) !== null) {
    const parsed = previewStatementExpression(text, assignmentPattern.lastIndex)
    if (parsed.expression !== '') bindings.set(match[1], parsed.expression)
    assignmentPattern.lastIndex = parsed.end < text.length ? parsed.end + 1 : text.length
  }
  return bindings
}

function previewValueText(value) {
  if (value !== null && typeof value === 'object') {
    try { return JSON.stringify(value) } catch { return String(value) }
  }
  return humanScalar(value)
}

function previewExpressionLabel(expression, fallback = '(not provided)') {
  if (expression === undefined) return fallback
  const compact = String(expression).replace(/\s+/g, ' ').trim()
  if (compact === '') return '(empty expression)'
  return compact.length > 180 ? compact.slice(0, 177) + '…' : compact
}

function previewExpressionSource(expression, bindings, resolving = new Set()) {
  if (expression === undefined) return undefined
  const text = String(expression).trim()
  const identifier = /^([A-Za-z_$][A-Za-z0-9_$]*)$/.exec(text)
  if (identifier === null || !bindings.has(identifier[1]) || resolving.has(identifier[1])) return text
  const next = new Set(resolving)
  next.add(identifier[1])
  return previewExpressionSource(bindings.get(identifier[1]), bindings, next) ?? text
}

function previewArgument(source, key, bindings) {
  const expression = previewPropertyExpression(source, key)
  if (expression !== undefined) return { expression: previewExpressionSource(expression, bindings), value: previewLiteral(expression, bindings) }
  const object = previewLiteral(source, bindings)
  if (object !== null && typeof object === 'object' && Object.prototype.hasOwnProperty.call(object, key)) {
    return { expression: previewExpressionLabel(source) + '.' + key, value: object[key] }
  }
  const sourceExpression = previewExpressionSource(source, bindings)
  if (sourceExpression !== undefined && /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/.test(sourceExpression)) {
    return { expression: sourceExpression + '.' + key, value: undefined }
  }
  return { expression: undefined, value: undefined }
}

function previewArgumentText(label, argument, missing = '(not provided)') {
  if (argument.value !== undefined) return label + ': ' + previewValueText(argument.value)
  if (argument.expression !== undefined) return label + ': ' + previewExpressionLabel(argument.expression) + ' (Code Mode expression)'
  return label + ': ' + missing
}

function previewPatchContent(value) {
  const source = String(value).replace(/\r\n?/g, '\n')
  const sourceLines = source.split('\n')
  const lines = []
  let added = 0
  let removed = 0
  let hasFile = false
  for (const line of sourceLines) {
    const control = line !== '' && [' ', '+', '-'].includes(line[0]) ? line : line.trim()
    const header = /^\*\*\* (Update|Add|Delete|Move) File:\s*(.*?)\s*$/.exec(control)
    if (header !== null) {
      hasFile = true
      lines.push('', header[1] + ' file: ' + header[2])
      continue
    }
    if (control === '*** Begin Patch' || control === '*** End Patch' || control === '*** End of File') continue
    if (control.startsWith('*** Environment ID:') || control.startsWith('*** Move to:')) {
      lines.push(control)
      continue
    }
    if (control === '@@' || control.startsWith('@@ ')) {
      lines.push(line)
      continue
    }
    if (line.startsWith('+')) {
      added++
      lines.push('+ ' + line.slice(1))
      continue
    }
    if (line.startsWith('-')) {
      removed++
      lines.push('- ' + line.slice(1))
      continue
    }
    if (line.startsWith(' ')) {
      lines.push('  ' + line.slice(1))
      continue
    }
    if (line === '') {
      lines.push('  ')
      continue
    }
    lines.push(line)
  }
  if (!hasFile) return undefined
  const maxLines = 180
  const visible = lines.slice(0, maxLines)
  if (lines.length > maxLines) visible.push('… (' + String(lines.length - maxLines) + ' more patch lines)')
  const summary = 'Patch preview: +' + String(added) + '/-' + String(removed)
  return { text: [summary, ...visible].join(String.fromCharCode(10)), added, removed }
}

function previewStringProperties(source, key, bindings) {
  return previewPropertyExpressions(source, key).flatMap(expression => {
    const value = previewLiteral(expression, bindings)
    if (typeof value === 'string') return [value]
    if (Array.isArray(value)) return value.filter(item => typeof item === 'string')
    return []
  })
}

function previewShortTitle(value, fallback) {
  if (typeof value !== 'string' || value.trim() === '') return fallback
  const compact = value.replace(/\s+/g, ' ').trim()
  return compact.length > 120 ? compact.slice(0, 117) + '…' : compact
}

function previewCodeCalls(source) {
  const text = String(source)
  const pattern = /\btools\.([A-Za-z0-9_]+)\s*\(/g
  const calls = []
  let match
  while ((match = pattern.exec(text)) !== null) {
    const open = text.indexOf('(', match.index)
    const close = previewBalancedEnd(text, open)
    if (close === undefined) continue
    calls.push({ name: match[1], arguments: text.slice(open + 1, close) })
    pattern.lastIndex = close + 1
  }
  return calls
}

function previewCodeToolCall(name, source, bindings) {
  const label = name === WEB_RUN ? 'web.run' : humanLabel(name)
  if (name === 'exec_command') {
    const command = previewArgument(source, 'cmd', bindings)
    const workdir = previewArgument(source, 'workdir', bindings)
    const tty = previewArgument(source, 'tty', bindings)
    const lines = [
      previewArgumentText('Command', command),
      previewArgumentText('Working directory', workdir, '(session working directory)'),
    ]
    if (tty.value === true) lines.push('Execution mode: PTY')
    else if (tty.value === false) lines.push('Execution mode: pipe')
    else if (tty.expression !== undefined) lines.push('Execution mode: ' + previewExpressionLabel(tty.expression) + ' (Code Mode expression)')
    else lines.push('Execution mode: pipe (default)')
    const titleValue = typeof command.value === 'string' ? command.value : command.expression
    return { title: previewShortTitle(titleValue, 'exec_command'), text: lines.join(String.fromCharCode(10)), kind: 'execute' }
  }
  if (name === WEB_RUN) {
    const queryExpressions = previewPropertyExpressions(source, 'q')
    const refExpressions = previewPropertyExpressions(source, 'ref_id')
    const urlExpressions = previewPropertyExpressions(source, 'url')
    const queries = previewStringProperties(source, 'q', bindings)
    const refs = previewStringProperties(source, 'ref_id', bindings)
    const urls = previewStringProperties(source, 'url', bindings)
    const lines = []
    if (queries.length > 0) lines.push('Search: ' + queries.join('; '))
    else if (queryExpressions.length > 0) lines.push('Search: ' + queryExpressions.map(previewExpressionLabel).join('; ') + ' (Code Mode expressions)')
    if (refs.length > 0) lines.push('Open: ' + refs.join('; '))
    else if (refExpressions.length > 0) lines.push('Open: ' + refExpressions.map(previewExpressionLabel).join('; ') + ' (Code Mode expressions)')
    if (urls.length > 0) lines.push('URL: ' + urls.join('; '))
    else if (urlExpressions.length > 0) lines.push('URL: ' + urlExpressions.map(previewExpressionLabel).join('; ') + ' (Code Mode expressions)')
    if (lines.length === 0) lines.push('Search arguments: ' + previewExpressionLabel(source, '(none)') + (String(source).trim() === '' ? '' : ' (Code Mode expression)'))
    const titleValue = queries[0] ?? refs[0] ?? urls[0] ?? queryExpressions[0] ?? refExpressions[0] ?? urlExpressions[0]
    return { title: previewShortTitle(titleValue, 'Search web'), text: lines.join(String.fromCharCode(10)), kind: 'search' }
  }
  if (name === 'apply_patch') {
    const input = previewArgument(source, 'input', bindings)
    const paths = typeof input.value === 'string'
      ? [...input.value.matchAll(/^\*\*\* (?:Update|Add|Delete|Move) File: (.+)$/gm)].map(item => item[1].trim())
      : []
    const patchPreview = typeof input.value === 'string' ? previewPatchContent(input.value) : undefined
    const text = patchPreview !== undefined
      ? patchPreview.text
      : input.value === ''
        ? 'Patch content: (empty)'
        : typeof input.value === 'string'
          ? 'Patch content: ' + previewShortTitle(input.value, '(provided)')
          : previewArgumentText('Patch input', input)
    return { title: paths.length === 1 ? 'Apply patch — ' + paths[0] : 'Apply patch', text, kind: 'edit' }
  }
  if (name === 'view_image') {
    const path = previewArgument(source, 'path', bindings)
    const titleValue = typeof path.value === 'string' ? path.value : path.expression
    return { title: previewShortTitle(titleValue, 'View image'), text: previewArgumentText('Image path', path), kind: 'read' }
  }
  if (name === 'write_stdin') {
    const session = previewArgument(source, 'session_id', bindings)
    const chars = previewArgument(source, 'chars', bindings)
    const lines = [previewArgumentText('Session', session)]
    lines.push(chars.value !== undefined || chars.expression !== undefined
      ? previewArgumentText('Input', chars)
      : 'Input: (empty by default)')
    const titleValue = typeof chars.value === 'string' ? chars.value : chars.expression
    return { title: previewShortTitle(titleValue, 'Poll exec session'), text: lines.join(String.fromCharCode(10)), kind: 'execute' }
  }
  if (name === 'wait') {
    const cell = previewArgument(source, 'cell_id', bindings)
    const cellText = cell.value !== undefined ? previewValueText(cell.value) : previewExpressionLabel(cell.expression)
    return { title: 'Wait on exec cell ' + cellText, text: previewArgumentText('Cell ID', cell) + '\nWait for the yielded exec cell to produce more output.', kind: 'other' }
  }
  if (name === 'update_plan') return { title: 'Update plan', text: 'Update the current execution plan.', kind: 'other' }
  if (name === 'request_user_input') return { title: 'Ask user', text: 'Request user input.', kind: 'other' }
  if (name.includes('spawn_agent')) {
    const message = previewArgument(source, 'message', bindings)
    return { title: 'Spawn sub-agent', text: previewArgumentText('Task', message), kind: 'execute' }
  }
  return { title: label, text: label + '\nArguments: ' + previewExpressionLabel(source, '(none)'), kind: 'other' }
}

function codeModePreview(source) {
  const directPatch = directPatchContent(source)
  if (directPatch !== undefined) {
    const patchPreview = previewPatchContent(directPatch)
    if (patchPreview !== undefined) {
      const paths = [...directPatch.matchAll(/^\*\*\* (?:Update|Add|Delete|Move) File:\s*(.+)$/gm)].map(item => item[1].trim())
      return { title: paths.length === 1 ? 'Apply patch — ' + paths[0] : 'Apply patch', text: patchPreview.text, kind: 'edit' }
    }
    return { title: 'Apply patch', text: 'Patch preview unavailable', kind: 'edit' }
  }
  const bindings = previewBindings(source)
  const calls = previewCodeCalls(source).map(call => previewCodeToolCall(call.name, call.arguments, bindings))
  if (calls.length === 0) return { title: codeModeDescription(source), text: 'Code Mode program (no direct tool call detected)', kind: 'execute' }
  if (calls.length === 1) return calls[0]
  const text = calls.map((call, index) => String(index + 1) + '. ' + call.text.replace(/^/gm, '  ')).join(String.fromCharCode(10) + String.fromCharCode(10))
  return { title: 'Code Mode — ' + String(calls.length) + ' tool calls', text, kind: 'execute' }
}

/**
 * Keep common shell snippets valid when a model writes them in a JavaScript
 * string. Node's erasable-TypeScript parser rejects literal line terminators in
 * single/double-quoted strings and treats Bash `${name:-fallback}` as a JS
 * interpolation. A valid program is left byte-for-byte unchanged.
 */
function normalizeLegacyCodeModeSource(source) {
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

function directPatchContent(source) {
  const text = String(source).trim()
  if (!text.startsWith('*** Begin Patch') || !text.endsWith('*** End Patch')) return undefined
  return text
}

/** Compile with the same wrapper and type-strip stage used by dsh's worker. */
function codeModeSyntaxError(source) {
  try {
    const wrapped = CODE_MODE_STRIP_PREFIX + String(source) + CODE_MODE_STRIP_SUFFIX
    const stripped = typeof stripTypeScriptTypes === 'function' ? stripTypeScriptTypes(wrapped) : wrapped
    const body = stripped.slice(CODE_MODE_STRIP_PREFIX.length, stripped.length - CODE_MODE_STRIP_SUFFIX.length)
    new AsyncFunction("'use strict';\n" + body)
    return undefined
  } catch (error) {
    return error
  }
}

function codeModeSyntaxValid(source) {
  return codeModeSyntaxError(source) === undefined
}

function codeModeQuoteIsEscaped(text, index) {
  let slashCount = 0
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === String.fromCharCode(92); cursor--) slashCount++
  return slashCount % 2 === 1
}

function codeModeStringFields(source) {
  const pattern = /(?:\b(?:cmd|input)\s*:\s*|["'](?:cmd|input)["']\s*:\s*|\b(?:const|let|var)\s+[A-Za-z_$][A-Za-z0-9_$]*\s*=\s*(String\.raw\s*)?)(["'`])/g
  const fields = []
  let match
  while ((match = pattern.exec(String(source))) !== null) {
    fields.push({
      valueStart: match.index + match[0].length,
      quote: match[2],
      property: !/\b(?:const|let|var)\s+/.test(match[0]),
      rawTemplate: match[1] !== undefined && match[2] === '`',
    })
  }
  return fields
}

function codeModeFieldBoundary(text, field, end) {
  let cursor = end + 1
  while (cursor < text.length && (text[cursor] === ' ' || text[cursor] === '\t')) cursor++
  const rest = text.slice(cursor)
  if (field.property) {
    if (/^,\s*(?:[A-Za-z_$][A-Za-z0-9_$]*|["'][^"']+["'])\s*:/.test(rest)) return true
    return /^(?:}[)\];,]|\)[;,]|$)/.test(rest)
  }
  return rest === '' || /^[;\n\r]/.test(rest)
}

function codeModeBoundaryScore(text, end) {
  let cursor = end + 1
  while (cursor < text.length && (text[cursor] === ' ' || text[cursor] === '\t')) cursor++
  const next = text[cursor]
  if (next === undefined || ',)}];'.includes(next)) return 0
  if (next === '\n' || next === '\r' || '.;:'.includes(next)) return 1
  return 2
}

function codeModeStringCandidates(text, field) {
  const candidates = []
  for (let index = field.valueStart + 1; index < text.length; index++) {
    if (text[index] === field.quote && !codeModeQuoteIsEscaped(text, index)) candidates.push(index)
  }
  // Prefer the quote that is followed by a real JavaScript property or
  // statement boundary. A shell command can contain many quote pairs (jq,
  // awk, `rg -F "..."`, and nested Node snippets); choosing the first quote
  // with a punctuation-shaped successor makes the search spend its repair
  // budget escaping one shell fragment at a time. The actual field boundary
  // lets one repair escape all inner quotes in one pass, including repeated
  // diagnostic strings such as `Expected ';', got 'string literal'`.
  candidates.sort((left, right) => (
    Number(!codeModeFieldBoundary(text, right)) - Number(!codeModeFieldBoundary(text, left))
    || codeModeBoundaryScore(text, left) - codeModeBoundaryScore(text, right)
    || left - right
  ))
  return candidates.slice(0, 96)
}

function repairCodeModeStringField(text, field, end) {
  let output = text.slice(0, field.valueStart)
  for (let index = field.valueStart; index <= end; index++) {
    const character = text[index]
    if (index !== end && character === field.quote && !codeModeQuoteIsEscaped(text, index)) {
      output += field.rawTemplate ? '${String.fromCharCode(96)}' : String.fromCharCode(92) + character
    } else {
      output += character
    }
  }
  return output + text.slice(end + 1)
}

/**
 * Repair only a bounded set of malformed string boundaries. Every
 * candidate must compile before it can reach the runtime; valid source never
 * enters this path and is therefore never rewritten.
 */
function repairCodeModeStringBoundaries(source) {
  const visited = new Set()
  let attempts = 0
  function search(candidate, depth) {
    if (codeModeSyntaxValid(candidate)) return candidate
    // A single shell field may contain several quoted diagnostics or embedded
    // scripts. Boundary-first selection normally repairs it in one pass, but
    // keep enough depth for fallback combinations across several fields.
    if (depth >= 12 || attempts >= 4000 || visited.has(candidate)) return undefined
    visited.add(candidate)
    for (const field of codeModeStringFields(candidate)) {
      for (const end of codeModeStringCandidates(candidate, field)) {
        const repaired = repairCodeModeStringField(candidate, field, end)
        // A field whose first candidate is already its closing boundary needs
        // no repair. Only skip the remaining candidates when the following
        // token actually looks like a property/statement boundary; a shell
        // quote followed by a comma is still content and must remain eligible.
        if (repaired === candidate) {
          if (codeModeFieldBoundary(candidate, field, end)) break
          continue
        }
        attempts++
        const result = search(repaired, depth + 1)
        if (result !== undefined) return result
      }
    }
    return undefined
  }
  return search(String(source), 0)
}

/**
 * Keep common shell snippets usable after a parser failure. The official
 * Code Mode contract remains raw JavaScript/TypeScript; this is a local
 * compatibility fallback for malformed model-authored strings.
 */
function normalizeCodeModeSource(source) {
  const text = String(source)
  if (codeModeSyntaxValid(text)) return text
  const legacy = normalizeLegacyCodeModeSource(text)
  if (codeModeSyntaxValid(legacy)) return legacy
  return repairCodeModeStringBoundaries(legacy) ?? legacy
}

// DSH's worker runtime only supplies `tools` and a console shim. Provide the
// official Code Mode helper names locally so the same model-authored program
// remains executable on this transport. Image/audio delivery and resumable
// yielding are represented textually because the host runtime has no matching
// output-item or cell protocol.
const CODE_MODE_RUNTIME_PRELUDE = [
  'const __dshCodexText = (value) => {',
  "  if (typeof value === 'string') return value;",
  "  if (value === undefined) return 'undefined';",
  '  try { const json = JSON.stringify(value); return json === undefined ? String(value) : json }',
  '  catch { return String(value) }',
  '};',
  'const text = (value) => console.log(__dshCodexText(value));',
  "const image = (_value) => console.log('[image output emitted by Codex compatibility runtime]');",
  "const audio = (_value) => console.log('[audio output emitted by Codex compatibility runtime]');",
  "const generatedImage = (_value) => console.log('[generated image output emitted by Codex compatibility runtime]');",
  'const __dshCodexStore = Object.create(null);',
  'const store = (key, value) => { __dshCodexStore[String(key)] = value; return value; };',
  'const load = (key) => __dshCodexStore[String(key)];',
  'const notify = (value) => text(value);',
  'const yield_control = () => undefined;',
  "const exit = () => { const error = new Error('Codex Code Mode exit'); error.__dshCodexExit = true; throw error; };",
].join('\n')

function officialRuntimeProgram(source, initialStore = {}) {
  let storeLiteral = '{}'
  try {
    const serialized = JSON.stringify(initialStore)
    if (serialized !== undefined) storeLiteral = serialized
  } catch {
    // Stored values are required to be JSON-compatible; an empty seed is the
    // safest fallback if a legacy caller supplies a lossy value.
  }
  const prelude = CODE_MODE_RUNTIME_PRELUDE.replace(
    'const __dshCodexStore = Object.create(null);',
    `const __dshCodexStore = Object.assign(Object.create(null), ${storeLiteral});`,
  )
  return prelude
    + '\nlet __dshCodexResult;\n'
    + 'let __dshCodexResultPresent = false;\n'
    + 'try {\n'
    + '  __dshCodexResult = await (async () => {\n'
    + String(source)
    + '\n  })();\n'
    + '  __dshCodexResultPresent = __dshCodexResult !== undefined;\n'
    + '} catch (__dshCodexExitError) {\n'
    + '  if (__dshCodexExitError?.__dshCodexExit !== true) throw __dshCodexExitError;\n'
    + '}\n'
    + 'return { __dshCodexEnvelope: true, __dshCodexResultPresent, __dshCodexResult: __dshCodexResult ?? null, __dshCodexStore };'
}

function codeModeEnvelope(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && value.__dshCodexEnvelope === true
    && value.__dshCodexStore !== null && typeof value.__dshCodexStore === 'object'
    && !Array.isArray(value.__dshCodexStore)
}

function unwrapCodeModeEnvelope(value, session) {
  if (!codeModeEnvelope(value)) return value
  CODE_MODE_STORES.set(session, structuredClone(value.__dshCodexStore))
  return value.__dshCodexResultPresent === true
    ? { logs: value.logs ?? [], result: value.__dshCodexResult }
    : { logs: value.logs ?? [] }
}

/** The host run_code tool wraps the worker value in its own logs/result object. */
function unwrapCodeModeResult(value, session) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
  const envelope = value.result
  if (!codeModeEnvelope(envelope)) return value
  const unwrapped = unwrapCodeModeEnvelope(envelope, session)
  return {
    logs: [
      ...(Array.isArray(value.logs) ? value.logs : []),
      ...(Array.isArray(unwrapped.logs) ? unwrapped.logs : []),
    ],
    ...(Object.hasOwn(unwrapped, 'result') ? { result: unwrapped.result } : {}),
  }
}

async function executeNestedCodeModeTool(ctx, execution, name, toolArguments) {
  const result = await ctx.tools.execute({
    callId: execution.callId + ':' + name,
    rootCallId: execution.rootCallId ?? execution.callId,
    name,
    arguments: toolArguments,
    agent: execution.agent,
    parent: execution.token,
    signal: execution.signal,
  })
  if (result.isError) throw new Error(codeModeErrorText(result) || name + ' execution failed')
  if (result.value === undefined) throw new Error(name + ' returned no result')
  return result.value
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
      'Execute raw JavaScript source in the Codex Code Mode runtime.',
      'The required input is the body of an async function, not a JSON object or fenced code block.',
      'For multiline shell commands, build cmd with ["line 1", "line 2"].join("\\n") instead of putting a literal newline inside a JavaScript quoted string.',
      'Nested tools.exec_command takes a JavaScript object such as { cmd: "printf hello" }; do not wrap that object in JSON.stringify or double-escape the cmd value.',
      'For shell commands containing single quotes (for example jq, awk, or parser diagnostics), prefer a double-quoted JavaScript string or an array joined with "\\n"; do not use a single-quoted JavaScript string around the whole command.',
      'Do not put Bash parameter expansions such as ${rc:-0} inside a JavaScript template literal; use an array of shell lines joined with "\\n".',
      'Call tools as await tools.<tool_name>(arguments), use text(value) for textual output, and return a JSON-serializable value.',
      'The host transport carries that source in the required input string property.',
    ].join(' '),
    parameters: {
      input: { type: 'string', required: true, description: 'Raw JavaScript/TypeScript function body. Build multiline shell commands with an array joined by "\\n"; for commands containing shell quotes, avoid wrapping the whole command in a JavaScript string with the same quote character.' },
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
    presentCall(args) {
      const preview = codeModePreview(args.input)
      return {
        card: 'generic',
        title: args.description?.trim() || preview.title,
        kind: preview.kind,
        content: [{ type: 'text', text: preview.text }],
      }
    },
    async execute(args, execution) {
      const description = args.description?.trim() || codeModeDescription(args.input)
      if (description.length === 0) throw new Error('invalid input: expected non-empty JavaScript source')
      const directPatch = directPatchContent(args.input)
      if (directPatch !== undefined) {
        const result = await executeNestedCodeModeTool(ctx, execution, 'apply_patch', { input: directPatch })
        return { logs: [], result }
      }
      const session = execution.agent?.session
      const initialStore = session === undefined ? {} : CODE_MODE_STORES.get(session) ?? {}
      const program = officialRuntimeProgram(normalizeCodeModeSource(args.input), initialStore)
      const callId = execution.callId + ':run_code'
      INTERNAL_RUN_CODE_CALLS.set(callId, { agent: execution.agent, parent: execution.token })
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
        return session === undefined ? result.value : unwrapCodeModeResult(result.value, session)
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

function v2Id(value) {
  return value === undefined || value === null ? undefined : String(value)
}

function isV2TaskName(value) {
  return typeof value === 'string'
    && value.length > 0
    && value !== 'root'
    && value !== '.'
    && value !== '..'
    && /^[a-z0-9_]+$/.test(value)
}

function validateV2TaskName(value) {
  if (typeof value !== 'string' || value.length === 0) throw new Error('task_name must not be empty')
  if (value === 'root' || value === '.' || value === '..') throw new Error('task_name ' + JSON.stringify(value) + ' is reserved')
  if (!/^[a-z0-9_]+$/.test(value)) throw new Error('task_name must use only lowercase letters, digits, and underscores')
  return value
}

function v2PathCache(ctx) {
  let cache = V2_PATH_CACHES.get(ctx)
  if (cache === undefined) {
    cache = new Map()
    V2_PATH_CACHES.set(ctx, cache)
  }
  return cache
}

function v2PathReservations(ctx) {
  let reservations = V2_PATH_RESERVATIONS.get(ctx)
  if (reservations === undefined) {
    reservations = new Set()
    V2_PATH_RESERVATIONS.set(ctx, reservations)
  }
  return reservations
}

function v2ReservationKey(rootId, path) {
  return String(rootId ?? '') + '\u0000' + path
}

function v2RootAgent(ctx, agent) {
  let current = agent
  const seen = new Set()
  while (current !== undefined && !seen.has(v2Id(current.id))) {
    seen.add(v2Id(current.id))
    const parentId = current.session?.header?.parentSession
    if (parentId === undefined) return current
    const parent = ctx.agents.get(parentId)
    if (parent === undefined) return current
    current = parent
  }
  return current ?? agent
}

function v2PathSegment(row) {
  if (isV2TaskName(row?.label)) return row.label
  const id = v2Id(row?.id) ?? 'agent'
  const suffix = id.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '')
  return 'agent_' + (suffix || 'unknown')
}

function v2SetPath(cache, row, parentPath) {
  const id = v2Id(row?.id)
  if (id === undefined || parentPath === undefined) return undefined
  const path = parentPath + '/' + v2PathSegment(row)
  cache.set(id, path)
  return path
}

async function v2Tree(ctx, parent, signal) {
  const root = v2RootAgent(ctx, parent)
  const cache = v2PathCache(ctx)
  const rootId = v2Id(root?.id)
  if (rootId !== undefined) cache.set(rootId, '/root')
  let rows
  if (typeof ctx.subagents.listDescendants === 'function' && rootId !== undefined) {
    rows = await ctx.subagents.listDescendants(rootId, signal)
  } else {
    rows = rootId === undefined ? [] : await ctx.subagents.listChildren(rootId, signal)
    rows = rows.map(row => ({ ...row, parentId: rootId, depth: 1 }))
  }
  for (const row of rows) {
    const parentId = v2Id(row?.parentId) ?? rootId
    v2SetPath(cache, row, cache.get(parentId))
  }
  return { root, rows, cache }
}

async function v2Children(ctx, parent, signal) {
  const rows = await ctx.subagents.listChildren(parent.session.id, signal)
  const children = rows.filter(row => row.kind === 'child' && row.mode === 'continuable')
  const cache = v2PathCache(ctx)
  const parentPath = cache.get(v2Id(parent.id)) ?? '/root'
  for (const row of children) v2SetPath(cache, row, parentPath)
  return children
}

async function v2Roster(ctx, parent, signal) {
  const tree = await v2Tree(ctx, parent, signal)
  const direct = typeof ctx.subagents.listDescendants === 'function'
    ? tree.rows.filter(row => row?.kind === 'child' && row?.mode === 'continuable'
      && v2Id(row.parentId) === v2Id(parent.id))
    : await v2Children(ctx, parent, signal)
  const byId = new Map()
  for (const row of tree.rows) {
    if (row?.kind !== 'child' || row?.mode !== 'continuable') continue
    byId.set(v2Id(row.id), row)
  }
  for (const row of direct) {
    const id = v2Id(row.id)
    if (id === undefined) continue
    const existing = byId.get(id)
    byId.set(id, existing === undefined
      ? { ...row, parentId: parent.id, depth: 1 }
      : { ...existing, ...row, parentId: v2Id(row.parentId) ?? v2Id(existing.parentId) ?? parent.id })
    v2SetPath(tree.cache, row, tree.cache.get(v2Id(parent.id)) ?? '/root')
  }
  return { ...tree, direct: direct.map(row => byId.get(v2Id(row.id)) ?? row), all: [...byId.values()] }
}

async function v2ResolveTarget(ctx, parent, reference, signal) {
  if (typeof reference !== 'string' || reference.length === 0) throw new Error('target must not be empty')
  const roster = await v2Roster(ctx, parent, signal)
  const rootId = v2Id(roster.root?.id)
  if (reference === '/root' && rootId !== undefined) {
    return { id: rootId, path: '/root', parentId: undefined, row: { kind: 'root', id: rootId }, roster }
  }
  const byId = new Map(roster.all.map(row => [v2Id(row.id), row]))
  let row = byId.get(reference)
  let path
  if (row !== undefined) {
    path = roster.cache.get(v2Id(row.id))
  } else {
    const currentPath = roster.cache.get(v2Id(parent.id)) ?? '/root'
    path = reference.startsWith('/') ? reference : currentPath + '/' + reference
    const matches = roster.all.filter(candidate => roster.cache.get(v2Id(candidate.id)) === path)
    if (matches.length > 1) throw new Error('ambiguous subagent target: ' + reference)
    row = matches[0]
    if (row === undefined && !reference.includes('/')) {
      const labelMatches = roster.direct.filter(candidate => candidate.label === reference)
      if (labelMatches.length > 1) throw new Error('ambiguous subagent target: ' + reference)
      row = labelMatches[0]
      if (row !== undefined) path = roster.cache.get(v2Id(row.id))
    }
  }
  if (row === undefined) throw new Error('unknown subagent: ' + reference)
  return { id: v2Id(row.id), path: path ?? roster.cache.get(v2Id(row.id)), parentId: v2Id(row.parentId), row, roster }
}

function v2MessageText(value) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error('Empty message cannot be sent to an agent')
  return value
}

function v2ForkProvider(value) {
  if (value === undefined || value === 'all') return 'fork'
  if (value === 'none') return 'spawn'
  if (/^[0-9]+$/.test(String(value)) && Number(value) > 0) {
    throw new Error('numeric fork_turns is not supported by DSH; use `none` or `all`')
  }
  throw new Error('fork_turns must be `none`, `all`, or a positive integer string')
}

function v2ResolvedPrefix(roster, parent, prefix) {
  if (prefix === undefined) return undefined
  if (typeof prefix !== 'string' || prefix.length === 0) throw new Error('path_prefix must not be empty')
  if (prefix.endsWith('/')) throw new Error('path_prefix must not end with `/`')
  const currentPath = roster.cache.get(v2Id(parent.id)) ?? '/root'
  const path = prefix.startsWith('/') ? prefix : currentPath + '/' + prefix
  const segments = path.split('/')
  if (segments.length < 2 || segments[0] !== '' || segments[1] !== 'root'
    || segments.slice(2).some(segment => !isV2TaskName(segment))) {
    throw new Error('path_prefix must be a canonical agent path or a relative task path')
  }
  return path
}

function v2PathMatches(path, prefix) {
  return prefix === undefined || path === prefix || path.startsWith(prefix + '/')
}

function v2FinalStatus(info) {
  const text = info?.lastAssistantMessage
    ?.filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join(String.fromCharCode(10))
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

function v2Status(ctx, id, settlements, known = false, row) {
  const settled = v2FinalStatus(settlements.get(id)?.end)
  if (settled !== undefined) return settled
  const child = ctx.agents.get(id)
  if (child !== undefined) return child.status === 'running' ? 'running' : { completed: null }
  if (row?.activity === 'running') return 'pending_init'
  return known ? { completed: null } : 'not_found'
}

function v2FinalMessageId(message, targets) {
  const source = message?.source
  if (source?.kind !== 'subagent-settled' && source?.kind !== 'agent-message') return undefined
  const id = String(source.senderSessionId)
  return targets.has(id) ? id : undefined
}

function v2MailboxMessageId(message, targets) {
  const source = message?.source
  if (source?.kind !== 'agent-message' && source?.kind !== 'subagent-settled') return undefined
  const id = v2FinalMessageId(message, targets)
  if (id !== undefined) return id
  const sender = v2Id(source.senderSessionId)
  return sender !== undefined && targets.has(sender) ? sender : undefined
}

function v2ParentSteeringMessage(parent, message) {
  if (message === undefined || parent?.inbox?.nextStep?.some(item => item?.id === message.id) !== true) return false
  return message.source?.kind === 'user'
}

function v2PendingUpdate(parent, _live, targets) {
  for (const message of parent.inbox?.nextStep ?? []) {
    const id = v2MailboxMessageId(message, targets)
    if (id !== undefined) return { kind: 'mailbox', id }
    if (v2ParentSteeringMessage(parent, message)) return V2_STEERED
  }
  for (const message of parent.inbox?.nextTurn ?? []) {
    const id = v2MailboxMessageId(message, targets)
    if (id !== undefined) return { kind: 'mailbox', id }
  }
  return undefined
}

async function waitForV2MailboxUpdate(ctx, parent, live, targets, timeoutMs, signal) {
  signal.throwIfAborted()
  const immediate = v2PendingUpdate(parent, live, targets)
  if (immediate !== undefined) return immediate
  let timer
  let onAbort
  let finished = false
  let resolveWait
  let rejectWait
  const wait = new Promise((resolve, reject) => {
    resolveWait = resolve
    rejectWait = reject
  })
  const finish = value => {
    if (finished) return
    finished = true
    resolveWait(value)
  }
  const disposers = []
  try {
    disposers.push(ctx.on('agent/inbox/inserted', payload => {
      const agentId = v2Id(payload?.agent?.id)
      if (agentId !== v2Id(parent.id)) return
      const mailbox = v2MailboxMessageId(payload?.message, targets)
      if (mailbox !== undefined) finish({ kind: 'mailbox', id: mailbox })
      else if (v2ParentSteeringMessage(parent, payload?.message)) finish(V2_STEERED)
    }))
    disposers.push(ctx.on('subagent/end', info => {
      const id = info?.id === undefined ? undefined : String(info.id)
      if (id !== undefined && targets.has(id)) finish({ kind: 'mailbox', id })
    }))
    timer = setTimeout(() => finish(undefined), timeoutMs)
    onAbort = () => {
      if (finished) return
      finished = true
      rejectWait(signal.reason ?? new Error('tool call aborted'))
    }
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
    const afterRegistration = v2PendingUpdate(parent, live, targets)
    if (afterRegistration !== undefined) finish(afterRegistration)
    return await wait
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
    for (const dispose of disposers) dispose()
  }
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
  const settlements = new Map()
  const newSettlement = () => {
    let resolve
    const promise = new Promise(done => { resolve = done })
    return { promise, resolve, end: undefined, runId: undefined }
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
    if (existing === undefined || existing.end !== undefined || existing.runId !== info.runId) {
      const settlement = newSettlement()
      settlement.runId = info.runId
      settlements.set(info.id, settlement)
    }
  })
  ctx.on('subagent/end', info => {
    const settlement = settlementFor(info.id)
    settlement.runId = info.runId
    settlement.end = info
    settlement.resolve(info)
  })

  ctx.tools.register(defineTool({
    name: 'collaboration__spawn_agent',
    description: 'Spawns an agent to work on the specified task. Use a lowercase task_name with letters, digits, and underscores. The spawned agent inherits the current model and can spawn its own subagents. Only use this for a concrete, bounded subtask that can run independently alongside useful local work.',
    parameters: {
      task_name: { type: 'string', required: true, description: 'Task name for the new agent. Use lowercase letters, digits, and underscores.' },
      message: { type: 'string', required: true, description: 'Initial plain-text task for the new agent.' },
      fork_turns: { type: 'string', description: 'Use none for no surrounding context, or all to inherit completed parent history. Numeric last-N forks are not available in DSH.' },
      model: { type: 'string', description: 'Model override for the new agent. Omit unless explicitly requested.' },
      reasoning_effort: { type: 'string', description: 'Reasoning effort override is not exposed by DSH; omit this field.' },
      fork_context: { type: 'boolean', description: 'Legacy V1 option; rejected in MultiAgentV2. Use fork_turns instead.' },
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
      const taskName = validateV2TaskName(args.task_name)
      const message = v2MessageText(args.message)
      if (args.fork_context !== undefined) throw new Error('fork_context is not supported in MultiAgentV2; use fork_turns instead')
      if (args.reasoning_effort !== undefined) throw new Error('reasoning_effort overrides are not supported by the DSH subagent runtime')
      const provider = v2ForkProvider(args.fork_turns)
      if (!ctx.subagents.list().includes(provider)) throw new Error('subagent provider is unavailable: ' + provider)
      const roster = await v2Roster(ctx, parent, execution.signal)
      const parentPath = roster.cache.get(v2Id(parent.id)) ?? '/root'
      const canonicalPath = parentPath + '/' + taskName
      const reservations = v2PathReservations(ctx)
      const reservationKey = v2ReservationKey(v2Id(roster.root?.id), canonicalPath)
      if (roster.direct.some(row => row.label === taskName) || reservations.has(reservationKey)) {
        throw new Error('task path already exists: ' + canonicalPath)
      }
      reservations.add(reservationKey)
      try {
        const child = await ctx.subagents.startContinuable({
          provider,
          label: taskName,
          request: {
            parent,
            prompt: [{ type: 'text', text: message }],
            ...(args.model === undefined ? {} : { agentOptions: { model: args.model } }),
          },
          signal: execution.signal,
        })
        const childId = v2Id(child.childId)
        if (childId === undefined) throw new Error('subagent provider returned no child id')
        v2PathCache(ctx).set(childId, canonicalPath)
        return { task_name: canonicalPath }
      } finally {
        reservations.delete(reservationKey)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'collaboration__send_message',
    description: 'Send a message to an existing agent. The message is delivered promptly and does not trigger a new turn.',
    parameters: {
      target: { type: 'string', required: true, description: 'Relative or canonical task name, or the durable id returned by spawn_agent.' },
      message: { type: 'string', required: true, description: 'Message text to queue on the target agent.' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { submission_id: { type: 'string', required: true } } }, ...v2JsonOutput('Message queued') },
    async execute(args, execution) {
      const parent = v2AgentOf(execution)
      const targetText = v2MessageText(args.message)
      const resolved = await v2ResolveTarget(ctx, parent, args.target, execution.signal)
      const target = ctx.agents.get(resolved.id)
      if (target === undefined) throw new Error('subagent is not live; use followup_task to cold-resume it')
      if (resolved.id === v2Id(parent.id)) throw new Error('an agent cannot send a message to itself')
      const submissionId = await ctx.subagents.sendMessage(
        parent,
        resolved.id,
        [{ type: 'text', text: targetText }],
        { signal: execution.signal },
      )
      return { submission_id: submissionId }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'collaboration__followup_task',
    description: 'Send a follow-up task to an existing non-root agent and trigger a turn if it is idle. If it is already running, deliver the task at a message boundary.',
    parameters: {
      target: { type: 'string', required: true, description: 'Agent id or task name returned by spawn_agent.' },
      message: { type: 'string', required: true, description: 'Message text to send to the target agent.' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { submission_id: { type: 'string', required: true } } }, ...v2JsonOutput('Follow-up queued') },
    async execute(args, execution) {
      const parent = v2AgentOf(execution)
      const targetText = v2MessageText(args.message)
      const resolved = await v2ResolveTarget(ctx, parent, args.target, execution.signal)
      if (resolved.id === v2Id(resolved.roster.root?.id)) throw new Error("Follow-up tasks can't target the root agent")
      const submissionId = await ctx.subagents.sendMessage(
        parent,
        resolved.id,
        [{ type: 'text', text: targetText }],
        { signal: execution.signal },
      )
      return { submission_id: submissionId }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'collaboration__wait_agent',
    description: 'Wait for a mailbox update from any live agent, including queued messages and final-status notifications. Returns a summary without the agent final content, or a timeout summary.',
    parameters: { timeout_ms: { type: 'number', description: 'Timeout in milliseconds. Defaults to 30000; minimum 10000; maximum 3600000. Values below the minimum are clamped; values above the maximum are rejected.' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { message: { type: 'string', required: true }, timed_out: { type: 'boolean', required: true } } }, ...v2JsonOutput('Agent wait') },
    async execute(args, execution) {
      const parent = v2AgentOf(execution)
      const requestedTimeout = args.timeout_ms
      if (requestedTimeout !== undefined && (!Number.isFinite(requestedTimeout) || requestedTimeout < 0)) {
        throw new Error('invalid timeout_ms: expected a non-negative number, got ' + String(requestedTimeout))
      }
      if (requestedTimeout !== undefined && requestedTimeout > V2_WAIT_MAX_MS) {
        throw new Error('timeout_ms must be at most ' + String(V2_WAIT_MAX_MS))
      }
      const timeoutMs = requestedTimeout === undefined
        ? V2_WAIT_DEFAULT_MS
        : Math.max(V2_WAIT_MIN_MS, requestedTimeout)
      const clampNotice = requestedTimeout !== undefined && requestedTimeout < timeoutMs
        ? '\n\nRequested timeout of ' + String(requestedTimeout) + 'ms was clamped to the minimum of ' + String(timeoutMs) + 'ms.'
        : ''
      const rows = await v2Children(ctx, parent, execution.signal)
      const targets = new Set(rows.map(row => String(row.id)))
      const live = rows.map(row => ctx.agents.get(row.id)).filter(agent => agent !== undefined)
      const pending = v2PendingUpdate(parent, live, targets)
      if (pending === V2_STEERED) return { message: 'Wait interrupted by new input.' + clampNotice, timed_out: false }
      if (pending !== undefined) return { message: 'Wait completed.' + clampNotice, timed_out: false }
      const settled = rows.find(row => v2FinalStatus(settlements.get(row.id)?.end) !== undefined)
      if (settled !== undefined) return { message: 'Wait completed.' + clampNotice, timed_out: false }
      const winner = await waitForV2MailboxUpdate(ctx, parent, live, targets, timeoutMs, execution.signal)
      if (winner === undefined) return { message: 'Wait timed out.' + clampNotice, timed_out: true }
      if (winner === V2_STEERED) return { message: 'Wait interrupted by new input.' + clampNotice, timed_out: false }
      return { message: 'Wait completed.' + clampNotice, timed_out: false }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'collaboration__interrupt_agent',
    description: "Interrupt an agent's current turn, if any, and return its previous status. The agent remains available for messages and follow-up tasks.",
    parameters: { target: { type: 'string', required: true, description: 'Agent id or task name returned by spawn_agent.' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { previous_status: { ...v2AgentStatusSchema(), required: true } } }, ...v2JsonOutput('Agent interrupted') },
    async execute(args, execution) {
      const parent = v2AgentOf(execution)
      const resolved = await v2ResolveTarget(ctx, parent, args.target, execution.signal)
      if (resolved.id === v2Id(resolved.roster.root?.id)) throw new Error('root is not a spawned agent')
      if (resolved.id === v2Id(parent.id)) throw new Error('an agent cannot interrupt itself')
      const previousStatus = v2Status(ctx, resolved.id, settlements, true, resolved.row)
      const authority = resolved.parentId === undefined ? parent : (ctx.agents.get(resolved.parentId) ?? parent)
      ctx.subagents.interrupt(resolved.id, { kind: 'ancestor', agent: authority })
      return { previous_status: previousStatus }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'collaboration__list_agents',
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
      const roster = await v2Roster(ctx, parent, execution.signal)
      const prefix = v2ResolvedPrefix(roster, parent, args.path_prefix)
      const entries = []
      const root = roster.root
      const rootId = v2Id(root?.id)
      if (root !== undefined && rootId !== undefined && v2PathMatches('/root', prefix)) {
        entries.push({ agent_name: '/root', agent_status: root.status === 'running' ? 'running' : { completed: null } })
      }
      for (const row of roster.all) {
        const id = v2Id(row.id)
        const path = roster.cache.get(id)
        if (id === undefined || path === undefined || !v2PathMatches(path, prefix)) continue
        const live = ctx.agents.get(id)
        if (live === undefined) continue
        entries.push({ agent_name: path, agent_status: v2Status(ctx, id, settlements, true, row) })
      }
      entries.sort((left, right) => left.agent_name.localeCompare(right.agent_name))
      return { agents: entries }
    },
  }))
}

async function waitForSerialTurn(previous, signal) {
  signal.throwIfAborted()
  let onAbort
  try {
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(signal.reason ?? new Error('tool call aborted'))
      signal.addEventListener('abort', onAbort, { once: true })
    })
    await Promise.race([previous.catch(() => undefined), aborted])
    signal.throwIfAborted()
  } finally {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
  }
}

/**
 * The `clock` namespace upstream builds for a catalog row that advertises the
 * `"clock"` experimental tool. `curr_time` reads the clock; `sleep` waits and
 * ends early when new input arrives for the active turn.
 */
function registerClockTools(ctx) {
  const CLOCK_DESCRIPTION = 'Tools for reading and waiting on time.'
  const MAX_SLEEP_DURATION_MS = 12 * 60 * 60 * 1000

  ctx.tools.register(defineTool({
    name: CLOCK_TIME,
    description: CLOCK_DESCRIPTION + ' curr_time',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          current_time: { type: 'string', required: true, description: 'Current UTC time formatted as YYYY-MM-DD HH:MM:SS UTC.' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: 'It is ' + value.current_time + '.' }],
    },
    async execute(_args, execution) {
      return { current_time: formatUtc(new Date()) }
    },
    presentCall() {
      return { card: 'generic', title: 'Current time', kind: 'other' }
    },
    presentResult(_args, result) {
      return result.isError
        ? genericToolError('Time lookup failed', result)
        : { card: 'generic', title: 'Current time', content: result.content }
    },
  }))

  ctx.tools.register(defineTool({
    name: CLOCK_SLEEP,
    description: 'Pause execution for a specified duration. The sleep ends early when new input arrives for the active turn. Returns the elapsed wall-clock time.',
    parameters: {
      duration_ms: {
        type: 'number',
        required: true,
        description: `How long to sleep in milliseconds. Must be between 1 and ${MAX_SLEEP_DURATION_MS}.`,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          elapsed_ms: { type: 'number', required: true, description: 'Wall-clock milliseconds actually waited.' },
          interrupted: { type: 'boolean', required: true, description: 'True when new user input ended the sleep early.' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.interrupted
          ? `Slept ${value.elapsed_ms} ms before new input arrived.`
          : `Slept ${value.elapsed_ms} ms.`,
      }],
    },
    async execute(args, execution) {
      const requested = args.duration_ms
      if (!Number.isFinite(requested) || requested < 1 || requested > MAX_SLEEP_DURATION_MS) {
        throw new Error(`duration_ms must be between 1 and ${MAX_SLEEP_DURATION_MS}`)
      }
      const startedAt = Date.now()
      const interrupted = await sleepUntilInput(ctx, execution, Math.floor(requested))
      return { elapsed_ms: Date.now() - startedAt, interrupted }
    },
    presentCall(args) {
      return { card: 'generic', title: `Wait ${formatDuration(args.duration_ms)}`, kind: 'other' }
    },
    presentResult(_args, result) {
      return result.isError
        ? genericToolError('Wait failed', result)
        : { card: 'generic', title: 'Waited', content: result.content }
    },
  }))
}

function formatUtc(date) {
  const iso = date.toISOString()
  return iso.slice(0, 10) + ' ' + iso.slice(11, 19) + ' UTC'
}

function formatDuration(ms) {
  const seconds = Math.round(ms / 1000)
  return seconds >= 60 ? `${Math.round(seconds / 60)} minutes` : `${seconds} seconds`
}

/**
 * Wait for `durationMs`, returning early when the user steers new input into
 * the turn. dsh publishes a pending user question the same way Codex does, so
 * the caller can keep working instead of stalling the turn.
 */
function sleepUntilInput(ctx, execution, durationMs) {
  const signal = execution.signal
  return new Promise(resolve => {
    let timer
    let dispose
    const finish = interrupted => {
      clearTimeout(timer)
      if (dispose !== undefined) dispose()
      resolve(interrupted)
    }
    timer = setTimeout(() => finish(false), durationMs)
    const session = execution.agent?.session
    if (ctx !== undefined && ctx.on !== undefined && session !== undefined) {
      dispose = ctx.on('session/event', (subject, event) => {
        if (subject !== session || event.type !== 'user/message') return
        finish(true)
      })
    }
    if (signal !== undefined) {
      if (signal.aborted) { finish(true); return }
      signal.addEventListener('abort', () => finish(true), { once: true })
    }
  })
}

/**
 * `request_user_input_async` is registered by upstream for a catalog row that
 * advertises either the current or the legacy experimental key. It returns
 * immediately and the reply arrives later as a new user message, which is
 * exactly how dsh's user-question projection already delivers answers.
 */
function registerAsyncUserInput(ctx) {
  ctx.tools.register(defineTool({
    name: REQUEST_USER_INPUT_ASYNC,
    description: 'Ask the user one or more questions during ongoing work. Use this tool only to request missing information, preferences, constraints, clarification, or approval. The tool returns immediately without ending the turn or waiting for a reply; any reply arrives asynchronously as a new user message. Keep questions concise, self-contained, and easy to understand, using a level of detail appropriate to the user and task. The UI always allows a free-text answer, including when suggested options are provided. A preselected option is not submitted automatically.',
    parameters: {
      questions: {
        type: 'array',
        required: true,
        description: 'One or more self-contained questions to present together, in display order.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            options: {
              type: 'array',
              description: 'Suggested answers, in display order. Put the recommended answer first; the first option is preselected by default. The user can select one option or enter a free-text answer. Do not include an Other option or a free-text placeholder; the UI provides free-text input automatically. Omit options for a free-text-only question.',
              items: { type: 'string' },
            },
            title: { type: 'string', required: true, description: 'The complete question shown to the user, including any context needed to answer it.' },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { accepted: { type: 'boolean', required: true } },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.accepted ? 'Question sent to the user. Continue working; the reply arrives as a new message.' : 'The question could not be delivered.',
      }],
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('request_user_input_async requires a live agent')
      if (agent.session?.header?.parentSession !== undefined) {
        throw new Error('request_user_input_async can only be used by the root thread')
      }
      if (!Array.isArray(args.questions) || args.questions.length === 0) {
        throw new Error('request_user_input_async requires at least one question')
      }
      const questions = args.questions.map((question, index) => ({
        id: 'async_' + String(index + 1),
        question: question.title,
        ...Array.isArray(question.options) && question.options.length > 0
          ? { options: question.options.map(label => ({ label })) }
          : {},
      }))
      let ask
      try {
        ask = ctx.get('userQuestions')
      } catch {
        throw new Error('this session has no user-question service, so a non-blocking question cannot be delivered')
      }
      // Deliver without awaiting: the answer arrives as a later user message,
      // so the model keeps working instead of parking the turn.
      void ask.ask({ questions, agent }).catch(() => undefined)
      return { accepted: true }
    },
    presentCall(args) {
      return genericToolCall('Asked the user', args.questions?.[0]?.title, 'other')
    },
    presentResult(_args, result) {
      return result.isError ? genericToolError('Question failed', result) : genericToolResult('Question sent', result)
    },
  }))
}

function genericToolCall(title, summary, kind = 'other') {
  return { card: 'generic', title, kind, ...(summary === undefined ? {} : { content: [{ type: 'text', text: summary }] }) }
}

function genericToolResult(title, result) {
  return { card: 'generic', title, content: result.content }
}

function genericToolError(title, result) {
  return genericToolResult(title, result)
}

function registerModelParity(ctx) {
  ctx.tools.guard(execution => {
    const agent = execution.agent
    if (agent === undefined) return undefined
    const internalRunCode = INTERNAL_RUN_CODE_CALLS.get(execution.callId)
    if (execution.name === RUN_CODE && internalRunCode?.agent === agent && internalRunCode.parent === execution.parent) return undefined
    const profile = profileForModel(currentModel(agent))
    const nested = execution.parent !== undefined
    if (modelToolAllowed(ctx, profile, execution.name, agent, nested, execution.arguments)) return undefined
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
    try {
      await waitForSerialTurn(previous, execution.signal)
      return await next()
    } finally {
      release()
      if (SERIAL_ROOT_TAILS.get(agent) === current) SERIAL_ROOT_TAILS.delete(agent)
    }
  })

  // Codex applies the selected model's truncation policy to direct tool
  // responses. Code Mode receives typed values and is intentionally exempt;
  // its program may inspect the complete result before the parent call logs
  // the model-facing projection.
  ctx.on('tools/post-execute', async (execution, result, next) => {
    const decision = await next()
    if (execution.parent !== undefined || result.isError || decision.kind !== 'accept') return decision
    if (Object.hasOwn(decision, 'value')) return decision
    const profile = profileForModel(currentModel(execution.agent))
    const content = decision.content ?? result.content
    const truncated = truncateToolContent(content, profile.truncationPolicy)
    return truncated === content ? decision : { ...decision, content: truncated }
  })

  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next()
    const agent = context.agent
    if (agent === undefined) return assembled
    const profile = profileForModel(currentModel(agent, assembled))
    // nativeSchemas already mirrors the official CodeModeOnly visibility rule,
    // including DirectModelOnly request_user_input and V2 collaboration tools.
    const tools = nativeSchemas(ctx, agent, profile)
    // dsh 0.1.7 renamed the persona and PTC-only prompt sections; retain the
    // older names for sessions/profile tests that still use pre-0.1.7 hosts.
    const isPtcOnly = name => name === 'tools:ptc-only' || name === 'tools:code-only'
    const sections = assembled.sections
      .filter(section => profile.toolMode !== 'native' || !isPtcOnly(section.name))
      .filter(section => profile.toolMode !== 'native' || section.name !== 'tools:sdk')
      .map(section => {
        if (section.name === 'deployment:persona-prefix' || section.name === 'deployment:persona') {
          // The catalog's instructions_template is literal text upstream: Codex
          // only substitutes `{{ personality }}` itself and never runs a
          // renderer over it. The GPT-6 templates contain braces that are not
          // prompt variables at all (for example the Apps connector syntax
          // `[$app-name](app://{{connector_id}})`), so the assembled text must
          // not be interpolated by the host.
          return { ...section, text: modelInstructions(profile, ctx, agent), interpolate: false }
        }
        if (section.name === 'plan:policy') {
          // Upstream wraps the active collaboration mode in these markers so a
          // model that saw Plan mode can recognize when Default resumes.
          return { ...section, text: wrapCollaborationMode(section.text) }
        }
        if (isPtcOnly(section.name)) {
          return { ...section, text: rewriteCodeModeName(section.text, profile) }
        }
        if (section.name === 'tool:web_search'
          && (profile.useResponsesLite || !profile.supportsSearchTool)) return undefined
        if (profile.toolMode !== 'native' && section.name === 'tools:sdk') {
          return { ...section, text: rewriteCodeModeSdk(dynamicSdk(ctx, agent, profile, section.text), profile) }
        }
        return section
      })
      .filter(section => section !== undefined)
    const contexts = (assembled.contexts ?? []).filter(context => context.name !== 'codex:token-budget')
    const tokenBudgetText = tokenBudgetContextText(ctx, agent, profile)
    if (tokenBudgetText !== '') contexts.push({ name: 'codex:token-budget', text: tokenBudgetText })
    return { ...assembled, sections, contexts, tools }
  })

  // Codex reaches persistent mode through a reasoning effort named
  // "Persistent". DSH's effort ids come from the provider adapter, so expose the
  // same opt-in as an explicit session toggle scoped to this preset.
  ctx.inject(['commands'], commandCtx => {
    commandCtx.commands.register({
      name: 'codex-persistent',
      description: 'Turn Codex persistent mode on or off for this session (upstream reasoning effort "Persistent")',
      input: { hint: '<on|off>' },
      handler: ({ agent, rawInput }) => {
        const requested = rawInput.trim().toLowerCase()
        if (requested === '') {
          const on = persistentModeEnabled(agent.session)
          return { kind: 'success', text: `Codex persistent mode is ${on ? 'on' : 'off'} (use \`/codex-persistent on\` or \`off\`)` }
        }
        if (requested !== 'on' && requested !== 'off') {
          return { kind: 'error', text: 'Persistent mode takes `on` or `off`.' }
        }
        const profile = profileForModel(currentModel(agent))
        if (requested === 'on' && profile.persistentInstructions === '') {
          return { kind: 'error', text: `Model ${profile.model} does not advertise persistent mode in the official catalog.` }
        }
        persistentModes.set(agent.session, requested === 'on')
        ctx.emit('system-prompt/change')
        return {
          kind: 'success',
          text: requested === 'on'
            ? 'Codex persistent mode on: the model now keeps working until the goal is handled.'
            : 'Codex persistent mode off.',
        }
      },
    })
  })
}

export const name = 'codex-model-parity'
// `userQuestions` stays a soft dependency: a profile that does not mount the
// question service still loads this preset, and the tool reports the missing
// capability only if the model actually calls it.
export const inject = ['tools', 'systemPrompt', 'subagents', 'agents']

export function apply(ctx) {
  registerContextBudgetTools(ctx)
  registerCodeModeAlias(ctx)
  registerClockTools(ctx)
  registerAsyncUserInput(ctx)
  registerV2Agents(ctx)
  registerModelParity(ctx)
  assertWireSafeToolNames(ctx)
}

/**
 * Fail loudly if the Codex preset ever declares a name the provider rejects.
 *
 * The Responses API pattern-matches every entry in `tools`, so one bad name
 * fails the entire request and the session cannot run at all. A dotted
 * `clock.curr_time` did exactly that during development; checking at load
 * turns that class of mistake into a preset error instead of a dead session.
 */
function assertWireSafeToolNames(ctx) {
  const unsafe = ctx.tools.schemas()
    .map(schema => schema.name)
    .filter(name => typeof name === 'string' && !WIRE_NAME_PATTERN.test(name))
  if (unsafe.length > 0) {
    throw new Error('codex-model-parity: tool names rejected by the provider pattern: '
      + unsafe.join(', '))
  }
}

export {
  codeModePreview,
  codeModeSyntaxValid,
  collaborationModeBlock,
  contextTokensRemaining,
  directPatchContent,
  modelTokenBudget,
  modelToolAllowed,
  modelInstructions,
  multiAgentUsageHintBlock,
  normalizeCodeModeSource,
  officialRuntimeProgram,
  normalizeShellType,
  normalizeToolMode,
  patchWebSearchSchema,
  persistentModeBlock,
  profileForModel,
  modelRowFor,
  registerCodeModeAlias,
  registerClockTools,
  registerModelParity,
  rewriteCodeModeSdk,
  registerV2Agents,
  rewriteCodeModeName,
  truncateToolContent,
  unwrapCodeModeResult,
  tokenBudgetContextText,
  v2FinalMessageId,
  v2PendingUpdate,
  v2Status,
  validateV2TaskName,
  waitForV2MailboxUpdate,
  wrapCollaborationMode,
}
