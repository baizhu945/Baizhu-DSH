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
assert.equal(expectedToolNames.length, 138)
assert.deepEqual(TOOL_CONTRACTS.map(row => row.name), expectedToolNames)
assert.deepEqual(Object.keys(TOOL_EFFECTS).sort(), [...expectedToolNames].sort())
const { parseConfig } = await load('config.js')
const { GhidraProvider } = await load('ghidra/GhidraProvider.js')
const { GhidraClient } = await load('ghidra/GhidraClient.js')
const { DEFAULT_GHIDRA_STARTUP_TIMEOUT_MS } = await load('config/ghidraStartupTimeout.js')
const { silentLogger } = await load('logger.js')
const config = value => {
  const result = parseConfig(value === undefined ? {} : { REA_GHIDRA_STARTUP_TIMEOUT_MS: value })
  assert.equal(result.ok, true, `valid budget rejected: ${value}`)
  return result.value
}
const original = config(undefined)
assert.equal(original.ghidraStartupTimeoutMs, 330000)
assert.equal(DEFAULT_GHIDRA_STARTUP_TIMEOUT_MS, 330000)
// Upstream accepts positive safe timer delays and falls back for invalid input.
for (const value of ['1', '330000', '1800000', '86400000', '2147483647', '+1', '01', ' 1', '1 ', '1.0', '1e3']) assert.equal(config(value).ghidraStartupTimeoutMs, Number(value))
for (const value of ['', '0', '-1', 'NaN', 'Infinity', '2147483648', '9999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999']) {
  assert.equal(config(value).ghidraStartupTimeoutMs, 330000, `invalid budget must fall back: ${value}`)
}
const host = {
  platform: 'linux', architecture: 'x64', readText: () => 'application.version=12.1.4\n', executable: () => true,
  probeJava: () => ({ version: '21.0.11', major: 21, home: '/fixture/jdk', bits: 64, runtime: 'jdk' }),
}
const target = { path: '/fixture/native', sha256: 'a'.repeat(64), kind: 'executable', format: 'elf', architecture: 'x86_64', availableArchitectures: ['x86_64'] }
for (const value of [undefined, '1800000']) {
  let forwarded, launched = 0
  const ghidra = new GhidraProvider({ ...config(value), ghidraInstallDir: '/fixture/ghidra' }, silentLogger, host, options => {
    forwarded = options
    // Use the actual client for cancellation; a pre-aborted signal must never
    // touch the target or launch, independent of the selected startup budget.
    return new GhidraClient({ ...options, launcher: { launch: () => { launched++; throw new Error('unexpected launch') } } })
  })
  const resolved = await ghidra.resolveAnalysisProfile(target)
  assert.equal(resolved.ok, true)
  const client = ghidra.createClient(target, resolved.value.profile)
  assert(forwarded, 'production clientFactory was not reached')
  assert.equal(forwarded.startupTimeoutMs, value === undefined ? 330000 : Number(value))
  const controller = new AbortController()
  controller.abort(new Error('fixture cancellation'))
  const result = await client.execute('health', {}, { signal: controller.signal })
  assert.equal(result.ok, false)
  assert.equal(result.error._tag, 'AnalysisCancelledError')
  assert.equal(launched, 0)
  await client.close()
}
console.log('PASS DSH Ghidra startup budget: upstream default330000, custom/timer-max/invalid fallback, actual factory forwarding, real-client cancellation without launch')
