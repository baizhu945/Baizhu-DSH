import assert from 'node:assert/strict'
import { expectedToolNames } from './catalog.mjs'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { temporaryHome, actualContext, discoverNonReaDefinitions, createAgent, turn, execute,
  reaDefinition, snapshot, runtimeRoot, presetRoot, stableRequest } from './sdk-host.mjs'
const root = temporaryHome()
const definition = reaDefinition(process.argv[4] ? { command: process.argv[4] } : {})
const bootstrap = definition.plugins.find(row => row.id === 'rea-bootstrap')
assert(bootstrap, 'installed bootstrap metadata missing')
const config = bootstrap.config
assert.equal(config.toolCallTimeoutMs, 1860000)
assert.equal(config.env.REA_ANALYSIS_PROVIDER, 'ghidra')
assert.equal(config.env.REA_GHIDRA_STARTUP_TIMEOUT_MS, '1800000')
assert.equal(config.env.GHIDRA_HEADLESS_MAXMEM, '8G')
assert(config.toolCallTimeoutMs > Number(config.env.REA_GHIDRA_STARTUP_TIMEOUT_MS))
assert.equal(config.serverName, 'rea'); assert.deepEqual(config.args, ['mcp'])
assert(existsSync(config.command), `real REA executable missing: ${config.command}`)
for (const key of ['GHIDRA_INSTALL_DIR', 'JAVA_HOME', 'REA_EVM_PRLIMIT_COMMAND']) assert(existsSync(config.env[key]), `${key} missing from installed config or unavailable`)
console.log(JSON.stringify({ runtimeRoot, presetRoot, tempHome: root, executable: config.command, GHIDRA_INSTALL_DIR: config.env.GHIDRA_INSTALL_DIR, JAVA_HOME: config.env.JAVA_HOME, chromium: config.env.REA_BROWSER_EXECUTABLE }))
const { ctx, capture } = await actualContext(root, { definitions: discoverNonReaDefinitions(), reaDefinition: definition })
const calls = []
let handle
async function call(name, args = {}) {
  const start = Date.now()
  const result = await execute(ctx, handle.agent, `mcp__rea__${name}`, args)
  const record = { name, args, durationMs: Date.now() - start, result }
  calls.push(record)
  writeFileSync(join(root, `call-${calls.length}-${name}.json`), JSON.stringify(record, null, 2) + '\n')
  assert.equal(result.isError, false, JSON.stringify(result))
  console.log(`PASS ToolRuntime -> REA ${name} (${record.durationMs}ms)`)
  return result
}
try {
  handle = await createAgent(ctx, 'real-selected-rea', 'rea')
  assert.equal(ctx.tools.schemas(handle.agent).filter(row => row.name.startsWith('mcp__rea__')).length, 0, 'real MCP eagerly started before first pre-step')
  await turn(handle.agent)
  assert.equal(capture.requests.length, 1)
  const catalog = ctx.tools.schemas(handle.agent).filter(row => row.name.startsWith('mcp__rea__'))
  assert.equal(catalog.length, 138, 'REA 6.1 exact catalog changed')
  assert.deepEqual(catalog.map(row => row.name.slice('mcp__rea__'.length)).sort(), [...expectedToolNames].sort())
  writeFileSync(join(root, 'catalog.json'), JSON.stringify(catalog, null, 2) + '\n')
  writeFileSync(join(root, 'complete-first-request.json'), JSON.stringify(stableRequest(capture.requests[0]), null, 2) + '\n')
  // Missing/unknown public effects remain consequential and ask. This fixture
  // explicitly grants each ask through the genuine approval service, including
  // readonly operations whose deployed effects metadata may be absent.
  const approvals = []
  ctx.on('approval/request', async req => { approvals.push({ tool: req.toolName, reason: req.reason }); return 'allowed-once' })
  handle.agent.session.append('turn/start', { turn: 2 })
  const readonly = await call('binary_session')
  assert(JSON.stringify(readonly).includes('content'))
  const js = join(root, 'workspace/js-fixture')
  mkdirSync(js, { recursive: true })
  writeFileSync(join(js, 'package.json'), JSON.stringify({ name: 'rea-dsh-offline-fixture', version: '1.0.0', type: 'module', main: 'index.js' }) + '\n')
  writeFileSync(join(js, 'index.js'), 'export function reaStaticFixture(value) { return value + 7; }\n')
  const jsAnalysis = await call('analyze_javascript_application', { input_path: js, format: 'auto' })
  assert(JSON.stringify(jsAnalysis).includes('reaStaticFixture'), 'static JavaScript application graph omitted fixture symbol')

  const evmCarrier = join(root, 'workspace/runtime.hex')
  writeFileSync(evmCarrier, '0x60006000f3\n')
  const evm = await call('inspect_evm_interface', { path: evmCarrier, encoding: 'hex' })
  const evmData = evm.value?.structuredContent
  assert.equal(evmData.result.bytecode.hex, '60006000f3')
  assert.equal(evmData.result.runtime_execution, 'not-performed')
  assert.equal(evmData.result.evidence_kind, 'inferred')

  // All native operations still go through the REAL approval and tool pipeline.
  // The fixture test user explicitly grants each request, with durable audit.
  const nativeSource = join(root, 'workspace/native-fixture.c')
  const binary = join(root, 'workspace/native-fixture')
  writeFileSync(nativeSource, '__attribute__((noinline)) int rea_fixture_add(int a, int b) { return a + b + 7; }\nint main(void) { return rea_fixture_add(1, 2); }\n')
  execFileSync(process.env.CC ?? '/run/current-system/sw/bin/cc', ['-g', '-O0', '-fno-pie', '-no-pie', '-o', binary, nativeSource], { cwd: join(root, 'workspace'), timeout: 30000 })
  // Omit provider_id deliberately: the runtime's configured native default
  // must select Ghidra, not an ambient Hopper/IDA installation.
  await call('open_binary', { path: binary })
  // open_binary returns target metadata only; the first deep query's evidence
  // identifies the actual analysis provider after complete startup analysis.
  const procedures = await call('list_procedures')
  assert.equal(procedures.value?.structuredContent?.evidence?.provider?.id, 'ghidra', 'omitted provider_id did not select configured Ghidra')
  assert(JSON.stringify(procedures).includes('rea_fixture_add'), 'Ghidra did not recover native fixture function')
  const pseudo = await call('procedure_pseudo_code', { procedure: 'rea_fixture_add' })
  assert(JSON.stringify(pseudo).includes('7'), 'Ghidra decompilation missing constant 7')
  await call('close_binary')
  handle.agent.session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
  writeFileSync(join(root, 'approval-audit.json'), JSON.stringify({ approvals, events: handle.agent.session.snapshotEvents().filter(row => row.type.startsWith('approval/')) }, null, 2) + '\n')
  const clean = await createAgent(ctx, 'real-standard', 'standard')
  const cleanView = await snapshot(ctx, clean.agent)
  assert(!JSON.stringify(cleanView).includes('mcp__rea__'))
  await clean.dispose()
  console.log('PASS real catalog138 + static JavaScript + offline EVMole + Ghidra/JDK from Config through DSH tool pipeline; no paid model or real user auth')
  console.log('Artifacts:', root)
} finally {
  if (handle) await handle.dispose()
  await ctx.fiber.dispose()
  writeFileSync(join(root, 'acceptance-summary.json'), JSON.stringify({ runtimeRoot, presetRoot, config, calls: calls.map(({ name, durationMs, result }) => ({ name, durationMs, isError: result.isError })) }, null, 2) + '\n')
}
