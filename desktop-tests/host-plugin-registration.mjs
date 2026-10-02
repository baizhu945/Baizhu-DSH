/** Real isolated Desktop Host: configured sources, generic extension/preset and native IPC. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createPluginFixtures } from './plugin-fixtures.mjs'

const runtime = process.env.DSH_DESKTOP_STORE
const artifacts = process.env.DSH_DESKTOP_ARTIFACTS
mkdirSync(artifacts, { recursive: true })
const sandbox = mkdtempSync(join(artifacts, 'host-registration-'))
const fixture = createPluginFixtures(sandbox)
const environment = { ...process.env,
  HOME: fixture.home, DSH_HOME: fixture.dshHome,
  DSH_AUTH_CREDENTIALS: join(fixture.dshHome, 'dsh-auth/credentials.json'),
  XDG_CONFIG_HOME: join(fixture.home, '.config'), XDG_CACHE_HOME: join(fixture.home, '.cache'),
  XDG_DATA_HOME: join(fixture.home, '.local/share'), XDG_STATE_HOME: join(fixture.home, '.local/state'),
  DSH_DESKTOP_NIX: '1', DSH_WEB_FETCH_ALLOW_FAKE_IP: '0',
  DSH_CLIENT_VERSION: JSON.parse(readFileSync(join(runtime, 'apps/cli/package.json'))).version,
  DSH_CODEX_REQUIRE_ANCHOR: join(fixture.profile, 'package.json'),
  DSH_PI_AI_ROOT: join(runtime, 'packages/llm/llm-pi-ai/node_modules/@earendil-works/pi-ai'),
}
for (const key of Object.keys(environment)) if (/_API_KEY$|_ACCESS_TOKEN$|_AUTH_TOKEN$/.test(key)) delete environment[key]
const { DesktopProjectManager } = await import(join(runtime, 'apps/desktop/lib/types/project-manager.js'))
const { resolveDesktopPaths } = await import(join(runtime, 'apps/desktop/lib/types/paths.js'))
const manager = new DesktopProjectManager(resolveDesktopPaths(fixture.dshHome), { dsh: runtime })
const savedEnv = { ...process.env }
let passed = 0
try {
  Object.assign(process.env, environment)
  // Alias rejection must precede the profile lock and create/removeLinkProjections.
  const fs = await import('node:fs')
  const web = join(fixture.dshHome, 'profiles/web')
  const webManifest = readFileSync(join(web, 'package.json'), 'utf8')
  const alias = join(fixture.dshHome, 'desktop-source-alias')
  fs.symlinkSync(web, alias, 'dir')
  await assert.rejects(new DesktopProjectManager({ ...resolveDesktopPaths(fixture.dshHome), profile: alias }, { dsh: runtime }).applyRelease(), /refusing user symlink boundary/)
  assert.equal(fs.existsSync(join(web, 'lock')), false)
  assert.equal(readFileSync(join(web, 'package.json'), 'utf8'), webManifest)
  fs.symlinkSync(join(web, 'node_modules'), join(fixture.profile, 'node_modules'), 'dir')
  await assert.rejects(manager.applyRelease(), /refusing user symlink boundary/)
  assert.equal(fs.existsSync(join(fixture.profile, 'lock')), false)
  unlinkSync(join(fixture.profile, 'node_modules'))
  const lock = join(fixture.profile, 'lock')
  writeFileSync(lock, String(process.pid))
  await assert.rejects(manager.applyRelease(), /another profile operation is active/)
  unlinkSync(lock)
  await manager.applyRelease()
  passed++
  console.log('ok - native profile lock refuses concurrent sync and locked applyRelease prepares inheritance')
} finally {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key]
  Object.assign(process.env, savedEnv)
}
const main = readFileSync(join(runtime, 'apps/desktop/src/main.ts'), 'utf8')
assert.match(main, /const ownsDesktopInstance = claimDesktopSingleInstance/)
assert.match(main, /if \(ownsDesktopInstance\) void app\.whenReady\(\)\.then\(main\)/)
const managerSource = readFileSync(join(runtime, 'apps/desktop/src/project-manager.ts'), 'utf8')
assert.ok(managerSource.indexOf('removeLinkProjections(this.paths.profile)') < managerSource.indexOf("execFileSync(node, ['--expose-internals', sync"))
const hostSource = readFileSync(join(runtime, 'apps/desktop-host/src/index.ts'), 'utf8')
assert.ok(hostSource.indexOf('const { ctx } = await application') < hostSource.indexOf('await ctx.plugin(await import(pathToFileURL(registrar).href))'))
passed++
console.log('ok - sync is gated by Electron single-instance ownership; preset registration follows application settlement')

const host = spawn(process.env.DSH_DESKTOP_HOST_NODE, ['--expose-internals', join(runtime, 'apps/desktop-host/lib/index.js'),
  runtime, fixture.profile, join(process.env.DSH_DESKTOP_PAYLOAD, 'primary-runtime'),
  join(runtime, 'node_modules/pnpm/bin/pnpm.mjs'), process.env.DSH_DESKTOP_NODE_BIN],
{ env: environment, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
let output = ''
for (const stream of [host.stdout, host.stderr]) { stream.setEncoding('utf8'); stream.on('data', chunk => { output += chunk }) }
const events = []
const waiters = new Map()
host.on('message', message => {
  events.push(message)
  if (message?.type === 'fatal') for (const waiter of waiters.values()) waiter.reject(new Error(message.diagnostic ?? message.message))
  waiters.get(message?.type)?.resolve(message)
})
const exit = new Promise(resolve => host.once('exit', (code, signal) => resolve({ code, signal })))
function event(type, timeout = 60_000) {
  const found = events.find(message => message?.type === type)
  if (found) return Promise.resolve(found)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiters.delete(type); reject(new Error('Host timed out: ' + type + '\n' + output)) }, timeout)
    waiters.set(type, { resolve: value => { clearTimeout(timer); waiters.delete(type); resolve(value) }, reject: error => { clearTimeout(timer); waiters.delete(type); reject(error) } })
    host.once('exit', () => { if (waiters.has(type)) { clearTimeout(timer); waiters.delete(type); reject(new Error('Host exited before ' + type + '\n' + output)) } })
  })
}
function bounded(promise, label, timeout = 30_000) {
  return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(label + ' timed out')), timeout); promise.then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) }) })
}
try {
  const ready = await event('ready', 120_000)
  assert.match(ready.url, /^http:\/\/127\.0\.0\.1:/)
  const inspectionEvent = event('fixture-inspection')
  host.send({ type: 'fixture-inspect' })
  const response = await inspectionEvent
  assert.equal(response.error, undefined)
  const info = response.inspection
  writeFileSync(join(sandbox, 'host-inspection.json'), JSON.stringify(info, null, 2))
  for (const id of ['codex', 'generic']) {
    const preset = info.presets.find(row => row.id === id)
    assert.ok(preset, 'missing preset ' + id)
    assert.equal(preset.broken, undefined, 'broken preset ' + id + ': ' + preset.broken)
  }
  assert.ok(!info.presets.some(row => row.id === 'liangshen'))
  assert.ok(info.providers.some(row => row.provider === 'openai-codex'))
  assert.ok(info.providers.every(row => row.signedIn === false))
  for (const command of ['auth', 'provider', 'fixture-desktop']) assert.ok(info.commands.some(row => row.name === command), 'missing command ' + command)
  assert.ok(ready.injections.some(row => JSON.stringify(row).includes('dsh-baizhu-approval')), 'missing dual-face boot injection')
  assert.ok(info.rows.some(row => row.id === 'working-activity' && !row.disabled && row.state === 2), 'portable working activity must be active')
  for (const row of info.rows) assert.ok(!/^@deepseek-harness-tui\/dsh-tui(?:$|\/(scenes|workspaces|plugin-host|extensions|settings-sections|command-trees)$)/.test(row.name ?? ''), 'terminal frontdoor leaked: ' + row.name)
  assert.deepEqual(info.peers, info.desktopPeers)
  for (const path of Object.values(info.peers)) assert.ok(path.startsWith(runtime + '/'), 'duplicate runtime: ' + path)
  if (environment.DSH_PLUGIN_FIXTURE_OLD_RUNTIME) assert.ok(info.codexOptionalTool.startsWith(runtime + '/'), 'Codex imported an old shared terminal tool')
  assert.equal(realpathSync(info.piAi), info.configuredPiAi)
  assert.equal(realpathSync(info.oauthPiAi), info.configuredPiAi)
  assert.equal(info.samePiAiInstance, true)
  passed++
  console.log('ok - real Host lists healthy Codex + generic preset, OAuth providers/auth/provider/arbitrary commands, approval client and portable activity on identical runtime peers')
  console.log('inspection: ' + JSON.stringify(info))
  const ack = event('shutdown-complete')
  host.send({ type: 'shutdown' })
  await ack
  const result = await bounded(exit, 'Host exit')
  assert.deepEqual(result, { code: 0, signal: null })
  passed++
  console.log('ok - Host acknowledges shutdown and exits 0')
} finally {
  if (host.exitCode === null && host.signalCode === null) { host.kill('SIGTERM'); try { await bounded(exit, 'cleanup', 5_000) } catch { host.kill('SIGKILL'); await exit } }
  writeFileSync(join(sandbox, 'host-raw.log'), output)
  writeFileSync(join(sandbox, 'host-events.json'), JSON.stringify(events, null, 2))
  console.log('host registration artifacts: ' + sandbox)
}
console.log(`host-plugin-registration: ${passed}/4 passed`)
