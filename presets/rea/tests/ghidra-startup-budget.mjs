// Independent DSH install gate: compiled package behavior, no Ghidra process,
// model, credentials, network, or imports from Pi.
import assert from 'node:assert/strict'
import { expectedToolNames } from './catalog.mjs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const root = resolve(process.argv[2])
const load = name => import(pathToFileURL(resolve(root, 'dist', name)).href)
const { TOOL_CONTRACTS } = await load('contracts/toolContracts.js')
const { TOOL_EFFECTS } = await load('contracts/toolEffects.js')
assert.equal(expectedToolNames.length, 210)
assert.deepEqual(TOOL_CONTRACTS.map(row => row.name), expectedToolNames)
assert.deepEqual(Object.keys(TOOL_EFFECTS).sort(), [...expectedToolNames].sort())
const { parseConfig } = await load('config/parseConfig.js')
const { GhidraProvider } = await load('ghidra/GhidraProvider.js')
const { GhidraClient } = await load('ghidra/GhidraClient.js')
const { DEFAULT_GHIDRA_STARTUP_TIMEOUT_MS } = await load('config/providerStartupTimeout.js')
const { ProviderStartupDeadline } = await load('process/ProviderDeadline.js')
const { silentLogger } = await load('logger.js')
const installationHost = {
  platform: 'linux',
  architecture: 'x64',
  readText: () => 'application.version=12.1.4\napplication.java.min=21\n',
  executable: () => true,
  probeJava: () => ({
    ok: true,
    value: {
      version: '21.0.11',
      major: 21,
      home: '/fixture/jdk',
      bits: 64,
      runtime: 'jdk',
      osArch: 'amd64',
      osName: 'Linux',
      vmName: 'OpenJDK 64-Bit Server VM',
    },
  }),
}
assert.equal(DEFAULT_GHIDRA_STARTUP_TIMEOUT_MS, 330000)
const baseline = parseConfig({ GHIDRA_INSTALL_DIR: '/fixture/ghidra' })
assert.equal(baseline.ok, true)
assert.equal(baseline.value.ghidraStartupTimeoutMs, 330000)
for (const value of ['1', '330000', '1800000', '2147483647']) {
  const parsed = parseConfig({ GHIDRA_INSTALL_DIR: '/fixture/ghidra', REA_GHIDRA_STARTUP_TIMEOUT_MS: value })
  assert.equal(parsed.ok, true, value)
  assert.equal(parsed.value.ghidraStartupTimeoutMs, Number(value))
  const { ghidraStartupTimeoutMs: _, ...rest } = parsed.value
  const { ghidraStartupTimeoutMs: __, ...expected } = baseline.value
  assert.deepEqual(rest, expected, 'no unrelated config changes')
}
for (const value of ['', '0', '-1', '1.5', '1e6', ' 1800000 ', '01', '+1', '2147483648', 'Infinity', 'not-a-number']) {
  const parsed = parseConfig({ GHIDRA_INSTALL_DIR: '/fixture/ghidra', REA_GHIDRA_STARTUP_TIMEOUT_MS: value })
  assert.equal(parsed.ok, false, value)
}
const target = {
  kind: 'executable',
  format: 'elf',
  path: '/fixture/never-launched',
  sha256: 'a'.repeat(64),
  architecture: 'x86_64',
  availableArchitectures: ['x86_64'],
}
for (const custom of [undefined, '1800000']) {
  const parsed = parseConfig(custom === undefined
    ? { GHIDRA_INSTALL_DIR: '/fixture/ghidra' }
    : { GHIDRA_INSTALL_DIR: '/fixture/ghidra', REA_GHIDRA_STARTUP_TIMEOUT_MS: custom })
  assert.equal(parsed.ok, true)
  assert.equal(parsed.value.ghidraStartupTimeoutMs, custom === undefined ? 330000 : Number(custom))
  let launched = 0
  let forwarded
  const ghidra = new GhidraProvider(parsed.value, silentLogger, {}, installationHost, options => {
    forwarded = options
    return new GhidraClient({
      ...options,
      launcher: { launch: () => { launched++; throw new Error('unexpected launch') } },
    })
  })
  const resolved = await ghidra.resolveAnalysisProfile(target)
  assert.equal(resolved.ok, true)
  const client = ghidra.createClient(target, resolved.value.profile)
  const controller = new AbortController()
  controller.abort(new Error('fixture cancellation'))
  const result = await client.execute('health', {}, { signal: controller.signal })
  assert.equal(result.ok, false)
  assert.equal(result.error._tag, 'AnalysisCancelledError')
  assert.equal(launched, 0, 'long budget cannot swallow cancellation or launch a provider')
  if (forwarded) assert.equal(forwarded.startupTimeoutMs, custom === undefined ? 330000 : Number(custom))
  await client.close()
}
const abort = new AbortController()
const deadline = new ProviderStartupDeadline(1800000, abort.signal)
assert(deadline.remainingMs() > 330000)
abort.abort('user cancellation')
assert.equal(deadline.interruption, 'cancelled')
assert.equal(await deadline.wait(1800000), 'aborted')
deadline.dispose()
console.log('PASS DSH Ghidra startup budget: default/strict decimal/timer bounds; provider resolve; real-client cancellation; no local patch')
