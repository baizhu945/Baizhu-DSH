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

const MODEL_CATALOG_PATH = nodePath.join(dshHome, '.agent-presets/codex/codex-models.json')
const FALLBACK_PROMPT_PATH = nodePath.join(dshHome, '.agent-presets/codex/codex-luna-prompt.md')
const RUN_CODE = 'run_code'
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

const DEFAULT_PROFILE = Object.freeze({
  toolMode: 'native',
  multiAgentVersion: 'none',
  useResponsesLite: false,
  includeSkillsUsageInstructions: true,
  inputModalities: ['text'],
  supportsImageDetailOriginal: false,
  supportsSearchTool: true,
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
    return { slug: id, tool_mode: 'code_mode_only', multi_agent_version: 'v1', use_responses_lite: true, include_skills_usage_instructions: false, context_window: 272000, max_context_window: 872000, default_reasoning_level: 'medium', input_modalities: ['text', 'image'], supports_image_detail_original: true, supports_search_tool: true }
  }
  if (id === 'gpt-5.6-sol' || id === 'gpt-5.6-terra') {
    return { slug: id, tool_mode: 'code_mode_only', multi_agent_version: 'v2', use_responses_lite: true, include_skills_usage_instructions: false, context_window: 272000, max_context_window: 872000, default_reasoning_level: id.endsWith('sol') ? 'low' : 'medium', input_modalities: ['text', 'image'], supports_image_detail_original: true, supports_search_tool: true }
  }
  if (id === 'gpt-5.3-codex-spark') {
    return { slug: id, tool_mode: 'code_mode_only', multi_agent_version: 'v1', use_responses_lite: true, include_skills_usage_instructions: false, context_window: 128000, max_context_window: 128000, default_reasoning_level: 'medium', input_modalities: ['text'], supports_image_detail_original: false, supports_search_tool: true }
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
    useResponsesLite: row.use_responses_lite === true,
    includeSkillsUsageInstructions: row.include_skills_usage_instructions !== false,
    inputModalities: Array.isArray(row.input_modalities) ? row.input_modalities : ['text'],
    supportsImageDetailOriginal: row.supports_image_detail_original === true,
    supportsSearchTool: row.supports_search_tool !== false,
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
  if (!nested && profile.toolMode === 'code_mode_only' && name !== RUN_CODE) return false
  if (!nested && profile.toolMode !== 'code_mode_only' && name === RUN_CODE) return false
  if (nested && name === RUN_CODE) return false
  if (name === WEB_RUN && !profile.useResponsesLite) return false
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

function v2JsonOutput() {
  return {
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
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

function registerV2Agents(ctx) {
  ctx.tools.register(defineTool({
    name: 'spawn_agent',
    description: 'Spawns an agent to work on the specified task. Use a lowercase task_name with letters, digits, and underscores. The spawned agent inherits the current model and can spawn its own subagents. Only use this for a concrete, bounded subtask that can run independently alongside useful local work.',
    parameters: {
      task_name: { type: 'string', required: true, description: 'Task name for the new agent. Use lowercase letters, digits, and underscores.' },
      message: { type: 'string', required: true, description: 'Initial plain-text task for the new agent.' },
      fork_turns: { type: 'string', enum: ['none', 'all'], description: 'Use none for no surrounding context, or all to inherit completed parent history.' },
      agent_type: { type: 'string', description: 'Agent type override. Omit unless explicitly asked.' },
      model: { type: 'string', description: 'Model override for the new agent. Omit unless explicitly requested.' },
      reasoning_effort: { type: 'string', description: 'Reasoning effort override for the new agent. Omit unless explicitly requested.' },
      service_tier: { type: 'string', description: 'Service tier override for the new agent. Omit unless explicitly requested.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { task_name: { type: 'string', required: true, description: 'Durable task identifier for the spawned agent.' } },
      },
      ...v2JsonOutput(),
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
    output: { schema: { type: 'object', additionalProperties: false, properties: { submission_id: { type: 'string', required: true } } }, ...v2JsonOutput() },
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
    output: { schema: { type: 'object', additionalProperties: false, properties: { submission_id: { type: 'string', required: true } } }, ...v2JsonOutput() },
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
    output: { schema: { type: 'object', additionalProperties: false, properties: { message: { type: 'string', required: true }, timed_out: { type: 'boolean', required: true } } }, ...v2JsonOutput() },
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
    output: { schema: { type: 'object', additionalProperties: false, properties: { previous_status: { type: 'string', required: true } } }, ...v2JsonOutput() },
    async execute(args, execution) {
      const parent = v2AgentOf(execution)
      const rows = await v2Children(ctx, parent, execution.signal)
      if (!rows.some(row => row.id === args.target)) throw new Error('unknown subagent: ' + args.target)
      const previousStatus = v2Status(ctx, args.target)
      ctx.subagents.interrupt(args.target, { kind: 'ancestor', agent: parent })
      return { previous_status: typeof previousStatus === 'string' ? previousStatus : 'completed' }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'list_agents',
    description: 'List live agents in the current root thread tree. Optionally filter by task-path prefix.',
    parameters: { path_prefix: { type: 'string', description: 'Task-path prefix filter without a trailing slash. Omit to list all live agents.' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { agents: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } } } }, ...v2JsonOutput() },
    async execute(args, execution) {
      const parent = v2AgentOf(execution)
      const rows = await v2Children(ctx, parent, execution.signal)
      const prefix = typeof args.path_prefix === 'string' ? args.path_prefix : undefined
      return { agents: rows.filter(row => prefix === undefined || String(row.id).startsWith(prefix)).map(row => ({ agent_name: row.id, status: v2Status(ctx, row.id) })) }
    },
  }))
}

function registerModelParity(ctx) {
  ctx.tools.guard(execution => {
    const agent = execution.agent
    if (agent === undefined) return undefined
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

  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next()
    const agent = context.agent
    if (agent === undefined) return assembled
    const profile = profileForModel(currentModel(agent, assembled))
    const direct = profile.toolMode !== 'code_mode_only'
    const tools = profile.toolMode === 'code_mode_only'
      ? assembled.tools.filter(tool => tool.name === RUN_CODE)
      : direct
        ? nativeSchemas(ctx, agent, profile)
        : assembled.tools.filter(tool => modelToolAllowed(ctx, profile, tool.name, agent, false))
    const sections = assembled.sections
      .filter(section => direct || section.name !== 'tools:code-only')
      .filter(section => !direct || section.name !== 'tools:sdk')
      .map(section => {
        if (section.name === 'deployment:persona') return { ...section, text: profile.instructions }
        if (!direct && section.name === 'tools:sdk') return { ...section, text: dynamicSdk(ctx, agent, profile, section.text) }
        return section
      })
    return { ...assembled, sections, tools }
  })
}

export const name = 'codex-model-parity'
export const inject = ['tools', 'systemPrompt', 'subagents', 'agents']

export function apply(ctx) {
  registerV2Agents(ctx)
  registerModelParity(ctx)
}
