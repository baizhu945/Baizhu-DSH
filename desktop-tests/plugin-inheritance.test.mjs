import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { synchronizeDesktopPlugins, bundleName } from '../scripts/sync-desktop-plugins.mjs'
import { apply as registerPresets } from '../scripts/register-desktop-presets.mjs'

const runtimeDir = process.env.DSH_DESKTOP_STORE
const require = createRequire(join(runtimeDir, 'apps/cli/package.json'))
const boot = await import(require.resolve('@deepseek-ai/dsh-app-boot'))
const artifacts = process.env.DSH_DESKTOP_ARTIFACTS ?? '/tmp/dsh-desktop-plugin-evidence'
mkdirSync(artifacts, { recursive: true })
const root = mkdtempSync(join(artifacts, 'helper-fixture-'))
const home = join(root, 'dsh-home')
const desktop = join(home, 'profiles/desktop')
const web = join(home, 'profiles/web')
const headless = join(home, 'profiles/headless')
const tuiProfile = join(home, 'profiles/dsh-tui')
function text(path, content) { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, content) }
function json(path, value) { text(path, JSON.stringify(value, null, 2) + '\n') }
function pkg(profile, name, metadata = {}) {
  const dir = join(profile, 'node_modules', name)
  json(join(dir, 'package.json'), { name, version: '1.0.0', type: 'module', main: './index.mjs', ...metadata })
  text(join(dir, 'index.mjs'), 'export function apply() {}\n')
  return dir
}
function hashes(dir) {
  return Object.fromEntries(readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const path = join(dir, entry.name)
    if (entry.isSymbolicLink()) return [[entry.name, 'link:' + readlinkSync(path)]]
    if (entry.isDirectory()) return Object.entries(hashes(path)).map(([name, hash]) => [entry.name + '/' + name, hash])
    return [[entry.name, createHash('sha256').update(readFileSync(path)).digest('hex')]]
  }))
}
function entries() {
  const profile = boot.loadProfileDirectory('test', desktop, join(runtimeDir, 'apps/cli/package.json'))
  return boot.composeEntries([...profile.layers.map(layer => layer.patches), profile.patches])
}
boot.initProfile(desktop, boot.PROFILE_TEMPLATES.web.bundles)
boot.initProfile(web, [...boot.PROFILE_TEMPLATES.web.bundles, 'acme-host-bundle'])
boot.initProfile(headless, boot.PROFILE_TEMPLATES.headless.bundles)
boot.initProfile(tuiProfile, ['@deepseek-ai/dsh-base', '@deepseek-harness-tui/dsh-tui'])
const hostBundle = pkg(web, 'acme-host-bundle', { dsh: { bundle: { patch: './cordis.patch.yml' } }, peerDependencies: { '@deepseek-ai/dsh': '>=0.2.0-rc.1 <0.3.0' } })
text(join(hostBundle, 'cordis.patch.yml'), `- insert:\n    - id: arbitrary-host\n      name: acme-host-bundle\n      config: { old: remove, keep: before }\n    - id: disabled-row\n      name: acme-host-bundle\n      disabled: true\n- id: arbitrary-host\n  config:\n    expression: !!js process.env.FIXTURE_LITERAL\n    keep: after\n`)
pkg(web, 'acme-dual-face', { dsh: { client: { platform: 'web' } } })
pkg(web, 'acme-disabled-bundle', { dsh: { bundle: { patch: './cordis.patch.yml' } } })
text(join(web, 'node_modules/acme-disabled-bundle/cordis.patch.yml'), '- insert: [{ id: forbidden-auto-enable, name: acme-disabled-bundle }]\n')
pkg(web, 'acme-incompatible', { peerDependencies: { '@deepseek-ai/dsh': '>=99.0.0' } })
json(join(web, 'compatibility.json'), { 'acme-incompatible@1.0.0': ['0.2.0-rc.2'] })
pkg(web, 'acme-local', { dsh: { client: { platform: 'web' } } })
pkg(desktop, 'acme-local', { version: '2.0.0' })
const desktopManifest = JSON.parse(readFileSync(join(desktop, 'package.json')))
desktopManifest.dependencies['acme-local'] = '2.0.0'
json(join(desktop, 'package.json'), desktopManifest)
const desktopPatch = '# exact local bytes\n- insert: [{id: local-wins, name: acme-local}]\n- id: permission\n  disabled: true\n'
text(join(desktop, 'cordis.patch.yml'), desktopPatch)
text(join(web, 'plugins/file.mjs'), 'export function apply() {}\n')
text(join(web, 'cordis.patch.yml'), `- insert:\n    - {id: dual-face, name: acme-dual-face}\n    - {id: shared-id, name: './plugins/file.mjs', config: { winner: web }}\n    - {id: local-wins, name: acme-dual-face}\n    - {id: bad-peer, name: acme-incompatible}\n    - {id: auth-alias, name: '@deepseek-harness-tui/dsh-tui/oauth'}\n- id: permission\n  config: {defaultPreset: web-wins}\n`)
text(join(headless, 'plugins/file.mjs'), 'export function apply() {}\n')
text(join(headless, 'cordis.patch.yml'), `- insert: [{id: shared-id, name: './plugins/file.mjs', config: {winner: headless}}]\n- id: permission\n  config: {defaultPreset: headless-loses}\n`)
const tui = pkg(tuiProfile, '@deepseek-harness-tui/dsh-tui', { dsh: { bundle: { patch: './cordis.patch.yml' } } })
// Web also has the canonical package, like the declarative OAuth deployment.
mkdirSync(join(web, 'node_modules/@deepseek-harness-tui'))
symlinkSync(tui, join(web, 'node_modules/@deepseek-harness-tui/dsh-tui'), 'dir')
text(join(tui, 'cordis.patch.yml'), `- id: llm-deepseek\n  config: {persona: forbidden}\n- insert:\n    - {id: tui-root, name: '@deepseek-harness-tui/dsh-tui'}\n    - {id: tui-ui, name: '@deepseek-harness-tui/dsh-tui/scenes'}\n    - {id: tui-auth, name: '@deepseek-harness-tui/dsh-tui/oauth'}\n    - {id: activity, name: '@deepseek-harness-tui/dsh-tui/working-activity'}\n    - {id: tui-storage, name: '@deepseek-ai/dsh-storage'}\n- id: tui-ui\n  config: {never: applied}\n`)
const sourceHashes = Object.fromEntries([web, headless, tuiProfile].map(dir => [dir, hashes(dir)]))
const sync = () => synchronizeDesktopPlugins({ runtimeDir, profileDir: desktop, home })
let first

test('arbitrary third-party rows, dual face, native replacement/!!js and disabled state inherit', async () => {
  first = await sync()
  const rows = entries()
  assert.ok(rows.some(row => row.id === 'arbitrary-host'))
  assert.ok(rows.some(row => row.id === 'dual-face'))
  assert.deepEqual(rows.find(row => row.id === 'arbitrary-host').config, { expression: { __jsExpr: 'process.env.FIXTURE_LITERAL' }, keep: 'after' })
  assert.equal(rows.find(row => row.id === 'disabled-row').disabled, true)
  assert.ok(!rows.some(row => row.id === 'forbidden-auto-enable'))
  assert.ok(existsSync(join(desktop, 'node_modules/acme-disabled-bundle/package.json')))
  assert.match(readFileSync(join(desktop, 'node_modules', bundleName, 'cordis.patch.yml'), 'utf8'), /!!js/)
})
test('web priority, desktop-local packages/IDs/disabled and source bytes remain intact', () => {
  const rows = entries()
  assert.equal(rows.find(row => row.id === 'shared-id').config.winner, 'web')
  assert.equal(rows.filter(row => row.id === 'shared-id').length, 1)
  assert.equal(rows.filter(row => row.id === 'local-wins').length, 1)
  assert.equal(rows.find(row => row.id === 'permission').disabled, true)
  assert.equal(rows.find(row => row.id === 'permission').config.defaultPreset, 'web-wins')
  assert.equal(JSON.parse(readFileSync(join(desktop, 'node_modules/acme-local/package.json'))).version, '2.0.0')
  assert.equal(JSON.parse(readFileSync(join(desktop, 'package.json'))).dependencies['acme-local'], '2.0.0')
  assert.equal(readFileSync(join(desktop, 'cordis.patch.yml'), 'utf8'), desktopPatch)
  for (const [dir, hashesBefore] of Object.entries(sourceHashes)) assert.deepEqual(hashes(dir), hashesBefore)
})
test('TUI portable host subpaths survive, UI/frontdoor/core overrides and duplicate auth do not', () => {
  const rows = entries()
  assert.ok(rows.some(row => row.id === 'activity'))
  assert.ok(rows.some(row => row.id === 'auth-alias'))
  for (const id of ['tui-root', 'tui-ui', 'tui-auth', 'tui-storage']) assert.ok(!rows.some(row => row.id === id), id)
  assert.ok(first.skipped.some(row => row.id === 'llm-deepseek' && /core bundle config/.test(row.reason)))
})
test('source grants are not copied and incompatible packages/rows are skipped', () => {
  assert.ok(!existsSync(join(desktop, 'compatibility.json')))
  assert.ok(!entries().some(row => row.id === 'bad-peer'))
  assert.ok(!existsSync(join(desktop, 'node_modules/acme-incompatible')))
  assert.ok(first.skipped.some(row => /incompatible.*dsh/.test(row.reason)))
})
test('second sync is deterministic and idempotent', async () => {
  const before = hashes(desktop)
  assert.deepEqual(await sync(), first)
  assert.deepEqual(hashes(desktop), before)
})
test('invalid source/bundle YAML preserves the entire previous generation', async () => {
  const before = hashes(desktop)
  const path = join(hostBundle, 'cordis.patch.yml')
  const saved = readFileSync(path)
  writeFileSync(path, 'not: [valid\n')
  await assert.rejects(sync(), /failed to parse overlay/)
  assert.deepEqual(hashes(desktop), before)
  writeFileSync(path, saved)
})
test('owned projections upgrade/remove without deleting user replacements', async () => {
  const old = join(web, 'node_modules/acme-dual-face')
  const upgraded = join(root, 'acme-dual-v2')
  renameSync(old, upgraded)
  symlinkSync(upgraded, old, 'dir')
  // Changing the declared path via node_modules keeps a valid source package.
  await sync()
  assert.equal(readlinkSync(join(desktop, 'node_modules/acme-dual-face')), old)
  const userReplacement = join(root, 'user-package')
  mkdirSync(userReplacement)
  json(join(userReplacement, 'package.json'), { name: 'acme-disabled-bundle', version: '3.0.0' })
  unlinkSync(join(desktop, 'node_modules/acme-disabled-bundle'))
  symlinkSync(userReplacement, join(desktop, 'node_modules/acme-disabled-bundle'))
  renameSync(join(web, 'node_modules/acme-disabled-bundle'), join(root, 'removed-disabled'))
  unlinkSync(old)
  // The unavailable dual-face row is diagnosed rather than linking stale source data.
  await sync()
  assert.equal(readlinkSync(join(desktop, 'node_modules/acme-disabled-bundle')), userReplacement)
  assert.ok(!lstatSync(join(desktop, 'node_modules/acme-dual-face'), { throwIfNoEntry: false }))
})
test('user removal of the generated bundle persists across restarts', async () => {
  const path = join(desktop, 'package.json')
  const manifest = JSON.parse(readFileSync(path))
  manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(name => name !== bundleName)
  json(path, manifest)
  const before = readFileSync(path, 'utf8')
  const report = await sync()
  assert.equal(report.enabled, false)
  assert.equal(readFileSync(path, 'utf8'), before)
})
test('all lexical profiles and shared metadata packages are discovered; only selected bundles activate', async () => {
  for (const name of ['z-extra', 'a-extra']) {
    const dir = join(home, 'profiles', name)
    boot.initProfile(dir, ['@deepseek-ai/dsh-base'])
    text(join(dir, 'plugins/entry.mjs'), 'export function apply() {}\n')
    text(join(dir, 'cordis.patch.yml'), `- insert: [{id: lexical-wins, name: './plugins/entry.mjs', config: {winner: ${name}}}]\n`)
  }
  pkg(join(home, 'profiles'), 'acme-shared-available', { dsh: { client: { platform: 'web' } } })
  const report = await sync()
  assert.ok(report.sources.some(row => row.name === 'a-extra'))
  assert.ok(report.sources.some(row => row.name === 'z-extra'))
  assert.equal(report.inherited.find(row => row.id === 'lexical-wins').source, 'a-extra')
  assert.ok(report.packages.some(row => row.name === 'acme-shared-available' && row.source === 'shared'))
  assert.ok(!report.inherited.some(row => row.name === 'acme-shared-available'))
})
test('Desktop-local selected bundle version owns relative patch declarations', async () => {
  const source = pkg(web, 'acme-local-bundle', { dsh: { bundle: { patch: './cordis.patch.yml' } } })
  text(join(source, 'cordis.patch.yml'), '- insert: [{id: local-bundle-version, name: ./index.mjs, config: {version: source}}]\n')
  const local = pkg(desktop, 'acme-local-bundle', { version: '2.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } })
  text(join(local, 'cordis.patch.yml'), '- insert: [{id: local-bundle-version, name: ./index.mjs, config: {version: desktop}}]\n')
  const sourceManifest = JSON.parse(readFileSync(join(web, 'package.json')))
  sourceManifest.dsh.profile.bundles.push('acme-local-bundle')
  json(join(web, 'package.json'), sourceManifest)
  await sync()
  const patches = boot.loadOverlayPatches('test', join(desktop, 'node_modules', bundleName, 'cordis.patch.yml'))
  const inherited = boot.composeEntries([patches]).find(row => row.id === 'local-bundle-version')
  assert.equal(inherited.config.version, 'desktop')
  assert.ok(inherited.name.includes('/profiles/desktop/node_modules/acme-local-bundle/'))
})
test('only pre-existing exact Desktop exemptions admit otherwise denied bundle versions', async () => {
  const deniedDir = join(home, 'profiles', 'exemption-fixture')
  boot.initProfile(deniedDir, ['@deepseek-ai/dsh-base', 'acme-granted'])
  const grant = pkg(deniedDir, 'acme-granted', { peerDependencies: { '@deepseek-ai/dsh': '>=99.0.0' }, dsh: { bundle: { patch: './cordis.patch.yml' } } })
  text(join(grant, 'cordis.patch.yml'), '- insert: [{id: exact-granted, name: acme-granted}]\n')
  const exemption = { 'acme-granted@1.0.0': ['0.2.0-rc.2'] }
  json(join(desktop, 'compatibility.json'), exemption)
  const bytes = readFileSync(join(desktop, 'compatibility.json'), 'utf8')
  const report = await sync()
  assert.ok(report.inherited.some(row => row.id === 'exact-granted'))
  assert.equal(readFileSync(join(desktop, 'compatibility.json'), 'utf8'), bytes)
  json(join(grant, 'package.json'), { ...JSON.parse(readFileSync(join(grant, 'package.json'))), version: '2.0.0' })
  const changed = await sync()
  assert.ok(!changed.inherited.some(row => row.id === 'exact-granted'))
  assert.equal(readFileSync(join(desktop, 'compatibility.json'), 'utf8'), bytes)
})
test('generic preset registration skips duplicates, transports rows and owns disposers', async () => {
  const presets = join(home, '.agent-presets')
  text(join(presets, 'generic/agent.cordis.yml'), '- id: arbitrary\n  name: ./plugin.mjs\n  config: {value: !!js process.env.UNEVALUATED}\n')
  text(join(presets, 'generic/preset.yml'), 'name: Generic fixture\ndescription: Generic metadata\norder: 7\n')
  text(join(presets, 'codex/agent.cordis.yml'), '[]\n')
  text(join(presets, 'invalid/agent.cordis.yml'), 'not: a list\n')
  const calls = []
  const effects = []
  const env = { DSH_HOME: process.env.DSH_HOME, DSH_CODEX_REQUIRE_ANCHOR: process.env.DSH_CODEX_REQUIRE_ANCHOR }
  process.env.DSH_HOME = home
  process.env.DSH_CODEX_REQUIRE_ANCHOR = join(runtimeDir, 'apps/cli/package.json')
  try {
    await registerPresets({ get: () => ({ list: async () => [{ id: 'codex' }], register: async definition => { calls.push(definition); return () => {} } }), effect: fn => effects.push(fn) })
  } finally {
    for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  }
  assert.deepEqual(calls.map(row => row.id), ['generic'])
  assert.equal(calls[0].name, 'Generic fixture')
  assert.equal(calls[0].order, 7)
  assert.ok(calls[0].plugins[0].name.startsWith('file:'))
  assert.deepEqual(calls[0].plugins[0].config, { value: { __jsExpr: 'process.env.UNEVALUATED' } })
  assert.equal(effects.length, 1)
})
console.log('helper fixture artifacts: ' + root)
