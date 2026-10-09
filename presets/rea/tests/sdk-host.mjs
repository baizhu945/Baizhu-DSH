import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync, readdirSync, existsSync, mkdirSync, mkdtempSync, symlinkSync } from 'node:fs'
import { join, dirname, resolve, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

export const runtimeRoot = resolve(process.argv[2] ?? '')
export const presetRoot = resolve(process.argv[3] ?? '')
assert(process.argv[2] && process.argv[3], 'usage: node SCRIPT <dshRuntimeRoot> <installedReaPresetRoot> [realReaExe]')
// Desktop may use its independently deployed host peer graph. Honor the
// launcher's original anchor for every SDK import so a second Cordis is never
// created merely because this fixture was launched from the CLI store root.
export const hostPeerAnchor = process.env.DSH_CODEX_REQUIRE_ANCHOR || join(runtimeRoot, 'apps/cli/package.json')
export const require = createRequire(hostPeerAnchor)
export async function sdk(name) { return import(pathToFileURL(require.resolve(name)).href) }
export const { Context } = await sdk('@deepseek-ai/cordis')
export const { SessionId } = await sdk('@deepseek-ai/dsh-session')
export const { assembleContextFor } = await sdk('@deepseek-ai/dsh-agent')
export const { renderPrompt } = await sdk('@deepseek-ai/dsh-system-prompt')
export const { createUserMessage, LlmAdapter, ToolCallId } = await sdk('@deepseek-ai/dsh-llm')
export const { createScope, scopeTarget, scopeOf } = await sdk('@deepseek-ai/dsh-scope')
export const yaml = require('js-yaml')
const expression = new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: value => ({ __jsExpr: value }) })
export const yamlSchema = yaml.JSON_SCHEMA.extend(expression)
export const loadYaml = path => yaml.load(readFileSync(path, 'utf8'), { schema: yamlSchema })
export function qualify(rows, root) {
  return rows.map(row => ({ ...row,
    ...(row.name?.startsWith('./') ? { name: pathToFileURL(join(root, row.name)).href } : {}),
    ...(Array.isArray(row.config) ? { config: qualify(row.config, root) } : {}),
  }))
}
export function temporaryHome() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-rea-test-'))
  for (const name of ['home', 'workspace', '.agent-presets', 'profiles']) mkdirSync(join(root, name), { recursive: true })
  symlinkSync(join(dirname(hostPeerAnchor), 'node_modules'), join(root, 'profiles/node_modules'), 'dir')
  process.env.DSH_HOME = root
  process.env.HOME = join(root, 'home')
  process.env.DSH_TELEMETRY_DISABLED = '1'
  process.env.DSH_CODEX_REQUIRE_ANCHOR = hostPeerAnchor
  process.env.DSH_REA_REQUIRE_ANCHOR = hostPeerAnchor
  return root
}
export class CaptureAdapter extends LlmAdapter {
  requests = []
  async resolveModel(provider, model) { return { provider, id: model, name: model } }
  async *stream(options) {
    // Capture complete first request, not just a tools array. Stable projection is
    // applied only when comparing request IDs and AbortSignal identity.
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'fixture complete' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'fixture complete' } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Actual Cordis Loader, runtime services, preset registry and agent-loop; no
 * stub service injection, fake DI container, real credentials or model routes. */
export async function actualContext(root, { definitions = [], reaDefinition } = {}) {
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(hostPeerAnchor).href
  await ctx.plugin((await sdk('@deepseek-ai/cordis-plugin-loader')).default)
  ctx.loader.builtins.group = (await sdk('@deepseek-ai/cordis-plugin-group')).default
  const hostIds = new Set([
    'timer', 'llm', 'session', 'session-projection', 'agent', 'system-prompt', 'tools', 'agent-loop',
    'subprocess', 'jobs', 'sandbox', 'sandbox-policy', 'approval', 'shell-env', 'fs-sandbox',
    'fs-observation-policy', 'bash-sandbox', 'skill', 'commands', 'goal', 'subagent', 'ptc-runtime',
    'user-questions', 'web', 'mcp-resources', 'token-meter', 'permission',
  ])
  const base = loadYaml(join(runtimeRoot, 'packages/bundle/base/cordis.patch.yml')).flatMap(row => row.insert ?? [])
  const hostRows = base.filter(row => hostIds.has(row.id)).map(row => {
    if (row.id === 'sandbox-policy') return { ...row, config: { mode: 'workspace-write', workspaceRoot: join(root, 'workspace') } }
    if (row.id === 'fs-sandbox') return { ...row, config: { cwd: join(root, 'workspace') } }
    if (row.id === 'ptc-runtime') return { ...row, config: { tempDir: join(root, 'ptc') } }
    return row
  })
  hostRows.push(
    { id: 'subagent-model-settings', name: '@deepseek-ai/dsh-tool-subagent/model-selection-settings' },
    { id: 'cordis-host-runner', name: '@deepseek-ai/dsh-cordis-host-runner' },
    { id: 'cordis-inspect-providers', name: '@deepseek-ai/dsh-tool-cordis/host' },
  )
  await ctx.loader.root.update(hostRows)
  await ctx.plugin((await sdk('@deepseek-ai/dsh-agent-preset-registry')).default, { default: 'standard' })
  const capture = new CaptureAdapter()
  ctx.llm.registerAdapter(['fixture'], capture)
  for (const definition of [...definitions, ...(reaDefinition ? [reaDefinition] : [])]) {
    await ctx.plugin({ inject: ['agentPresets'], async *apply(owner) { yield await owner.agentPresets.register(definition) } })
  }
  return { ctx, capture, hostRows }
}

export function reaDefinition(overrides = {}) {
  const rows = qualify(loadYaml(join(presetRoot, 'agent.cordis.yml')), presetRoot)
  let found = false
  function patch(entries) {
    return entries.map(row => {
      if (row.name?.endsWith('/runtime/rea-runtime.mjs')) { found = true; return { ...row, config: { ...row.config, ...overrides } } }
      return Array.isArray(row.config) ? { ...row, config: patch(row.config) } : row
    })
  }
  const plugins = patch(rows)
  assert(found, 'installed REA composition must name ./runtime/rea-runtime.mjs')
  return { id: 'rea', plugins }
}
export function discoverNonReaDefinitions() {
  const found = new Map()
  const shipped = join(runtimeRoot, 'packages/bundle/web-app/presets')
  for (const name of readdirSync(shipped).filter(name => name.endsWith('.patch.yml')).sort()) {
    for (const row of loadYaml(join(shipped, name)).flatMap(patch => patch.insert ?? [])) {
      if (row.name === '@deepseek-ai/dsh-agent-preset' && row.config.id !== 'rea') found.set(row.config.id, { ...row.config, plugins: qualify(row.config.plugins, dirname(join(shipped, name))) })
    }
  }
  // Read every onsite preset directory, including unknown future user presets.
  // Only compositions/metadata are read; never credentials or live profiles.
  const roots = [basename(presetRoot) === 'rea' ? dirname(presetRoot) : undefined,
    process.env.DSH_REA_PRESETS_ROOT ?? '/home/baizhu945/.dsh/.agent-presets'].filter(Boolean)
  for (const root of new Set(roots)) {
    if (!existsSync(root)) continue
    for (const item of readdirSync(root, { withFileTypes: true })) {
      if (item.name.startsWith('.') || item.name === 'rea') continue
      const path = join(root, item.name, 'agent.cordis.yml')
      if (!existsSync(path)) continue
      found.set(item.name, { id: item.name, plugins: qualify(loadYaml(path), dirname(path)) })
    }
  }
  const profileRoot = process.env.DSH_REA_PROFILES_ROOT ?? '/home/baizhu945/.dsh/profiles'
  if (existsSync(profileRoot)) for (const profile of readdirSync(profileRoot, { withFileTypes: true })) {
    if (!profile.isDirectory()) continue
    for (const file of ['cordis.yml', 'cordis.patch.yml']) {
      const path = join(profileRoot, profile.name, file)
      if (!existsSync(path)) continue
      // Discover profile-only extra declarations without activating any profile,
      // provider rows, persistence, telemetry, HTTP frontend or user auth.
      const visit = rows => { for (const row of rows ?? []) {
        if (row?.name === '@deepseek-ai/dsh-agent-preset' && row.config?.id !== 'rea' && Array.isArray(row.config?.plugins) && !found.has(row.config.id)) {
          found.set(row.config.id, { ...row.config, plugins: qualify(row.config.plugins, dirname(path)) })
        }
        if (Array.isArray(row?.insert)) visit(row.insert)
        if (row?.group && Array.isArray(row.config)) visit(row.config)
      } }
      const rows = loadYaml(path)
      if (Array.isArray(rows)) visit(rows)
    }
  }
  for (const id of ['standard', 'ptc', 'minimal', 'cordis', 'codex']) assert(found.has(id), `mandatory preset missing: ${id}`)
  return [...found.values()]
}
export async function createAgent(ctx, id, preset, options = {}) {
  return ctx.agents.create({
    sessionId: SessionId(id), agentOptions: { provider: 'fixture', model: 'fixture' },
    meta: { cwd: join(process.env.DSH_HOME, 'workspace') },
    ...options,
    setup: async (agentCtx, agent) => {
      await ctx.agentPresets.mount(agentCtx, preset)
      await options.setup?.(agentCtx, agent)
    },
  })
}
export async function turn(agent) {
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'test only; reply once, do not call tools' }], source: { kind: 'user' } }))
  await agent.whenIdle()
}
export async function snapshot(ctx, agent) {
  const assembled = await ctx.systemPrompt.assemble(assembleContextFor(agent))
  // schemas() is an unordered registration view (async preset activation can
  // change insertion order even without REA). Preserve ALL fields, canonically
  // order that view only. Captured model requests retain their exact tool order.
  const schemas = ctx.tools.schemas(agent).sort((one, two) => one.name.localeCompare(two.name))
  const { renderToolsSdk, renderToolsSdkPy } = await sdk('@deepseek-ai/dsh-tools')
  const sdkRows = schemas.filter(row => row.name !== 'run_code').map(row => ({ ...row, output: ctx.tools.get(row.name, agent).output.schema }))
  return { schemas, prompt: renderPrompt(assembled), sections: assembled.sections, tsSdk: renderToolsSdk(sdkRows), pySdk: renderToolsSdkPy(sdkRows) }
}
export async function execute(ctx, agent, name, arguments_ = {}, signal = new AbortController().signal) {
  return ctx.tools.execute({ agent, name, arguments: arguments_, callId: ToolCallId(`fixture-${Date.now()}`), signal })
}
export function stableRequest(request) {
  return JSON.parse(JSON.stringify(request, function (key, value) {
    if (key === 'signal' && value instanceof AbortSignal) return undefined
    const messageEnvelope = typeof this?.role === 'string' && Array.isArray(this?.content)
    if (messageEnvelope && ['id', 'time', 'createdAt'].includes(key)) return undefined
    // Do not strip a schema/argument property merely because it is named id,
    // time or signal. Only actual opaque correlation values are normalized.
    if (['callId', 'attemptId'].includes(key) && typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value)) return '<opaque-correlation-id>'
    return value
  }))
}
