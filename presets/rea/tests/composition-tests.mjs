import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { temporaryHome, actualContext, discoverNonReaDefinitions, createAgent, snapshot, reaDefinition,
  presetRoot, runtimeRoot, loadYaml, yaml, yamlSchema, sdk } from './sdk-host.mjs'
const source = process.env.DSH_REA_SOURCE_ROOT ?? '/home/baizhu945/.config/home-manager/agent/dsh'
const root = temporaryHome()
const definitions = discoverNonReaDefinitions()
const { ctx } = await actualContext(root, { definitions })
const handles = []
const ledger = join(root, 'forbidden-spawn.jsonl')
try {
  const before = new Map()
  for (const definition of definitions) {
    const handle = await createAgent(ctx, `composition-${definition.id}`, definition.id)
    handles.push(handle); before.set(definition.id, await snapshot(ctx, handle.agent))
    assert(!JSON.stringify(definition.plugins).includes('mcp__rea__'))
    assert(!JSON.stringify(definition.plugins).includes('rea-runtime.mjs'))
    for (const row of definition.plugins) if (row.config?.nativeConfig) {
      assert(!JSON.stringify(row.config.nativeConfig).toLowerCase().includes('rea'))
    }
  }
  const installed = join(root, '.agent-presets/rea')
  mkdirSync(installed, { recursive: true })
  // Qualify the actual production runtime, while changing only executable/env
  // to a sentinel which creates a file if ANY eager bootstrap is attempted.
  const sentinel = join(root, 'forbidden-rea')
  writeFileSync(sentinel, `#!${process.execPath}\nimport { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(ledger)}, 'SPAWN'); process.exit(99)\n`, { mode: 0o700 })
  const definition = reaDefinition({ command: sentinel, args: ['mcp'], env: {}, toolCallTimeoutMs: 600000 })
  writeFileSync(join(installed, 'agent.cordis.yml'), yaml.dump(definition.plugins, { schema: yamlSchema, noRefs: true, lineWidth: -1 }))
  writeFileSync(join(installed, 'preset.yml'), readFileSync(join(presetRoot, 'preset.yml')))
  const registrarPath = join(source, 'scripts/register-desktop-presets.mjs')
  const generic = await import(pathToFileURL(registrarPath).href)
  const desktopFiber = ctx.plugin(generic)
  await desktopFiber
  const roster = await ctx.agentPresets.list()
  assert.equal(roster.filter(row => row.id === 'rea').length, 1)
  const metadata = loadYaml(join(presetRoot, 'preset.yml'))
  assert.equal(roster.find(row => row.id === 'rea').name, metadata.name)
  assert.equal(roster.find(row => row.id === 'rea').order, metadata.order)
  await ctx.agentPresets.remoteExportList(); await ctx.agentPresets.compositionInventory()
  const lease = await ctx.agentPresets.acquireScope('rea'); await lease[Symbol.asyncDispose]()
  assert(!existsSync(ledger), 'Desktop roster/acquisition spawned REA')
  for (const handle of handles) {
    const id = ctx.agentPresets.composedPreset(handle.agent.ctx)
    assert.deepEqual(await snapshot(ctx, handle.agent), before.get(id))
    console.log('PASS Desktop generic registration cannot alter', id)
  }
  // Profile frontends use a registrar instead of Desktop's generic discovery.
  // Exercise the actual module on the SAME host after the generic owner exits.
  await desktopFiber.dispose()
  const nativeRegistrarPath = join(source, 'presets/rea/rea-registrar.mjs')
  if (existsSync(nativeRegistrarPath)) {
    const registrar = await import(pathToFileURL(nativeRegistrarPath).href)
    await ctx.plugin(registrar, { hostPackageJson: join(runtimeRoot, 'apps/cli/package.json') })
    assert.equal((await ctx.agentPresets.list()).filter(row => row.id === 'rea').length, 1)
    assert(!existsSync(ledger))
    console.log('PASS profile registrar uses same inert roster declaration without spawn')
  }
  const composition = readFileSync(join(source, 'presets/rea/dsh-rea.nix'), 'utf8')
  assert(/for profile in [^\n]*web[^\n]*dsh-tui/.test(composition), 'Web and TUI need the shared registrar')
  assert(!/for profile in [^\n]*headless/.test(composition), 'ordinary headless has no preset registry and must not be changed for REA')
  assert(composition.includes('packages/bundle/web-app/presets/standard.patch.yml'))
  assert(!composition.includes('default = "rea"'))
} finally {
  for (const handle of handles) await handle.dispose()
  await ctx.fiber.dispose()
}

// The native preset must own its execution boundary even when the host's
// default is PTC, and global tools can be added after its standing bootstrap.
const { defineTool } = await sdk('@deepseek-ai/dsh-tools')
for (const hostToolMode of ['native', 'ptc']) {
  const { ctx: host } = await actualContext(root, { definitions, hostToolMode })
  let native, standard, unregister
  try {
    standard = await createAgent(host, `mask-standard-${hostToolMode}`, 'standard')
    const globals = host.tools.schemas().map(tool => tool.name)
    assert(globals.includes('working_directory'), 'schemas() must retain the global registration view under both host presentations')
    unregister = host.tools.register(defineTool({ name: 'future_host_tool', description: 'Late zero-cost host fixture.', parameters: {},
      output: { schema: { type: 'object', additionalProperties: false, properties: {} }, render: () => [] },
      execute() { throw new Error('The late host fixture must never be executed') } }))
    assert(host.tools.get('future_host_tool', standard.agent), 'Ordinary DSH scope retains later host tools')
    unregister(); unregister = undefined
    console.log(`PASS native boundary under ${hostToolMode} host presentation and late global registration/removal`)
  } finally {
    unregister?.()
    await native?.dispose(); await standard?.dispose(); await host.fiber.dispose()
  }
}
