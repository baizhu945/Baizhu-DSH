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
  const hashes = []
  for (const definition of definitions.filter(row => row.id === 'codex')) {
    for (const row of definition.plugins) {
      if (!row.name.startsWith('file:')) continue
      const nativeRoot = dirname(new URL(row.name).pathname)
      for (const file of readdirSync(nativeRoot).filter(file => /\.(mjs|js|json)$/.test(file))) {
        const path = join(nativeRoot, file)
        hashes.push({ path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') })
      }
    }
  }
  writeFileSync(join(root, 'codex-bytehashes.json'), JSON.stringify(hashes, null, 2) + '\n')
  console.log('PASS Web/TUI same metadata/composition, ordinary headless unchanged static constraints; Codex bytehashes:', join(root, 'codex-bytehashes.json'))
} finally {
  for (const handle of handles) await handle.dispose()
  await ctx.fiber.dispose()
}
