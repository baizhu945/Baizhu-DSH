import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { synchronizeDesktopPlugins, bundleName } from '../scripts/sync-desktop-plugins.mjs'

const runtimeDir = process.env.DSH_DESKTOP_STORE
const require = createRequire(join(runtimeDir, 'apps/cli/package.json'))
const boot = await import(require.resolve('@deepseek-ai/dsh-app-boot'))
const artifacts = process.env.DSH_DESKTOP_ARTIFACTS
function text(path, content) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content) }
function json(path, content) { text(path, JSON.stringify(content, null, 2) + '\n') }
function hashes(dir) {
  return Object.fromEntries(readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const path = join(dir, entry.name)
    if (entry.isSymbolicLink()) return [[entry.name, 'link:' + readlinkSync(path)]]
    if (entry.isDirectory()) return Object.entries(hashes(path)).map(([name, hash]) => [entry.name + '/' + name, hash])
    return [[entry.name, createHash('sha256').update(readFileSync(path)).digest('hex')]]
  }))
}
function fixture() {
  mkdirSync(artifacts, { recursive: true })
  const root = mkdtempSync(join(artifacts, 'boundary-fixture-'))
  const home = join(root, 'dsh-home')
  const profileDir = join(home, 'profiles/desktop')
  const web = join(home, 'profiles/web')
  boot.initProfile(profileDir, boot.PROFILE_TEMPLATES.web.bundles)
  boot.initProfile(web, [...boot.PROFILE_TEMPLATES.web.bundles, '@boundary/portable'])
  const pkg = join(web, 'node_modules/@boundary/portable')
  json(join(pkg, 'package.json'), { name: '@boundary/portable', version: '1.0.0', type: 'module',
    dsh: { bundle: { patch: './cordis.patch.yml' } } })
  text(join(pkg, 'cordis.patch.yml'), '- insert: [{id: boundary-extension, name: "@boundary/portable"}]\n')
  text(join(pkg, 'index.mjs'), 'export function apply() {}\n')
  console.log('boundary fixture: ' + root)
  return { root, home, profileDir, web, pkg, sync: () => synchronizeDesktopPlugins({ runtimeDir, profileDir, home }) }
}

test('Desktop node_modules symlink is rejected before any source or Desktop write', async () => {
  const f = fixture()
  symlinkSync(join(f.web, 'node_modules'), join(f.profileDir, 'node_modules'), 'dir')
  const sourceBefore = hashes(f.web), desktopBefore = hashes(f.profileDir)
  await assert.rejects(f.sync(), /refusing user symlink boundary.*node_modules/)
  assert.deepEqual(hashes(f.web), sourceBefore)
  assert.deepEqual(hashes(f.profileDir), desktopBefore)
})
test('Desktop profile symlink is rejected before touching its source alias target', async () => {
  const f = fixture()
  const alias = join(f.root, 'desktop-alias')
  symlinkSync(f.web, alias, 'dir')
  const before = hashes(f.web)
  await assert.rejects(synchronizeDesktopPlugins({ runtimeDir, profileDir: alias, home: f.home }), /refusing user symlink boundary/)
  assert.deepEqual(hashes(f.web), before)
  assert.ok(!existsSync(join(f.web, '.desktop-plugin-inheritance.json')))
})
test('replaced scope symlink is never traversed for old owned-link deletion or new projection', async () => {
  const f = fixture()
  await f.sync()
  const scope = join(f.profileDir, 'node_modules/@boundary')
  const external = join(f.root, 'readonly-source-scope')
  renameSync(scope, external)
  symlinkSync(external, scope, 'dir')
  const before = hashes(external), sourceBefore = hashes(f.web)
  const report = await f.sync()
  assert.deepEqual(hashes(external), before)
  assert.deepEqual(hashes(f.web), sourceBefore)
  assert.equal(readlinkSync(join(external, 'portable')), f.pkg)
  assert.ok(report.skipped.some(row => row.name === '@boundary/portable' && /owned-link cleanup skipped/.test(row.reason)))
  assert.ok(!JSON.parse(readFileSync(join(f.profileDir, '.desktop-plugin-inheritance.json'))).projections['@boundary/portable'])
  assert.equal(lstatSync(scope).isSymbolicLink(), true)
})
test('a profile symlink alias resolving to Desktop is excluded from source discovery', async () => {
  const f = fixture()
  symlinkSync(f.profileDir, join(f.home, 'profiles/desktop-alias'), 'dir')
  const report = await f.sync()
  assert.ok(!report.sources.some(row => row.name === 'desktop-alias'))
  assert.ok(!report.inherited.some(row => row.source === 'desktop-alias'))
  assert.ok(report.skipped.some(row => row.source === 'desktop-alias' && /resolves to Desktop/.test(row.reason)))
})
test('native group config replacement child names keep each bundle patch origin and !!js literal', async () => {
  const f = fixture()
  const manifest = JSON.parse(readFileSync(join(f.pkg, 'package.json')))
  manifest.dsh.bundle.patch = ['./layers/insert.yml', './layers/nested/replacement.yml']
  json(join(f.pkg, 'package.json'), manifest)
  text(join(f.pkg, 'layers/insert.yml'), '- insert:\n    - id: source-group\n      name: cordis:group\n      group: true\n      config:\n        - id: replaced-child\n          name: ./old.mjs\n          disabled: true\n')
  text(join(f.pkg, 'layers/nested/replacement.yml'), '- id: source-group\n  config:\n    - id: replaced-child\n      name: ./child.mjs\n      config:\n        literal: !!js process.env.GROUP_SOURCE_LITERAL\n')
  text(join(f.pkg, 'layers/nested/child.mjs'), 'export function apply() {}\n')
  const before = hashes(f.web)
  await f.sync()
  const generated = boot.loadOverlayPatches('test', join(f.profileDir, 'node_modules', bundleName, 'cordis.patch.yml'))
  const group = boot.composeEntries([generated]).find(row => row.id === 'source-group')
  assert.equal(group.config[0].name, pathToFileURL(join(f.pkg, 'layers/nested/child.mjs')).href)
  assert.deepEqual(group.config[0].config.literal, { __jsExpr: 'process.env.GROUP_SOURCE_LITERAL' })
  assert.deepEqual(hashes(f.web), before)
})
test('group config in source user patch is anchored there, but top-level patch.name stays an assertion', async () => {
  const f = fixture()
  text(join(f.pkg, 'cordis.patch.yml'), '- insert: [{id: source-group, name: "cordis:group", group: true, config: []}]\n')
  text(join(f.web, 'plugins/user-child.mjs'), 'export function apply() {}\n')
  text(join(f.web, 'cordis.patch.yml'), '- id: source-group\n  config: [{id: user-child, name: ./plugins/user-child.mjs}]\n- id: source-group\n  name: ./ASSERTION-ONLY.mjs\n  config: []\n')
  await f.sync()
  const generated = boot.loadOverlayPatches('test', join(f.profileDir, 'node_modules', bundleName, 'cordis.patch.yml'))
  assert.equal(generated.find(row => row.name === './ASSERTION-ONLY.mjs').name, './ASSERTION-ONLY.mjs')
  const group = boot.composeEntries([generated]).find(row => row.id === 'source-group')
  assert.equal(group.config[0].name, pathToFileURL(join(f.web, 'plugins/user-child.mjs')).href)
})
