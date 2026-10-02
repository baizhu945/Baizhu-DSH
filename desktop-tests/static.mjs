/**
 * Static conformance of the Nix source seam, plus the runtime descriptor and the
 * Platform wire identity the Linux shell must report.
 *
 * These assert against the *built* store output, not against the working copy, so a
 * patch that stopped applying or a descriptor that stopped validating fails here.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { runtimeDir, desktopDir } from './lib.mjs'

const require = createRequire(join(runtimeDir, 'apps', 'desktop', 'package.json'))
const checks = []

function check(name, body) {
  checks.push({ name, body })
}

check('patched main.ts keeps the Nix gate and the untouched vanilla branches', () => {
  const source = readFileSync(join(runtimeDir, 'apps/desktop/src/main.ts'), 'utf8')
  assert.match(source, /const nixMode = process\.env\.DSH_DESKTOP_NIX === '1'/)
  // Every override is required, not defaulted.
  for (const variable of [
    'DSH_DESKTOP_HOST_NODE',
    'DSH_DESKTOP_NODE_BIN',
    'DSH_DESKTOP_PNPM_ENTRY',
    'DSH_DESKTOP_DSH_DIR',
    'DSH_DESKTOP_PRIMARY_RUNTIME_DIR',
  ]) {
    assert.ok(source.includes(`nixRuntimePath('${variable}')`), `${variable} is not a required Nix path`)
  }
  assert.match(source, /const development = !app\.isPackaged && !nixMode/)
  // Vanilla resolution stays reachable for Windows, macOS, and the dev tree.
  assert.match(source, /join\(process\.resourcesPath, 'runtime', 'bin'\)/)
  assert.match(source, /join\(app\.getAppPath\(\), '\.desktop-build', 'development', 'project'\)/)
  // Linux close quits instead of hiding a window with no tray to restore it.
  assert.match(source, /if \(nixMode && process\.platform === 'linux'\) \{\s*\n\s*event\.preventDefault\(\)\s*\n\s*app\.quit\(\)\s*\n\s*return/)
  // Linux reports the supported web identity rather than pretending to be macOS.
  assert.match(source, /process\.platform === 'darwin' \? 'darwin' : null\)/)
  // Updater row hidden, mandatory-update manifest untouched.
  assert.match(source, /\.\.\.\(nixMode \? \[\] : \[\{ label: currentDesktopLocale\(\)\.messages\.checkUpdatesMenu/)
  assert.ok(!source.includes('DSH_DESKTOP_MANDATORY_UPDATE_POLICY'), 'no mandatory-update manifest may be injected')
})

check('platform-view accepts a null platform', () => {
  const source = readFileSync(join(runtimeDir, 'apps/desktop/src/platform-view.ts'), 'utf8')
  assert.match(source, /private readonly platform: 'darwin' \| 'win32' \| null/)
})

check('Host office loader uses the Nix payload in place', () => {
  const source = readFileSync(join(runtimeDir, 'apps/desktop-host/src/office.ts'), 'utf8')
  assert.match(source, /nixMode \? \{ source: config\.source \} : config/)
  // Office skills and the LibreOfficeKit CLI are still reached.
  assert.match(source, /assetRoot: join\(dirname\(config\.source\), 'office-skills'\)/)
  assert.match(source, /cli: join\(packageRoot, 'lib', 'cli\.js'\)/)
})

check('readDesktopRuntime accepts the generated descriptor', async () => {
  const { readDesktopRuntime } = await import(
    join(runtimeDir, 'apps/desktop/lib/types/runtime-tree.js')
  )
  const descriptor = readDesktopRuntime(runtimeDir)
  assert.equal(descriptor.schemaVersion, 1)
  assert.equal(descriptor.platform, 'linux')
  assert.equal(descriptor.arch, 'x64')
  assert.deepEqual(descriptor.files, [], 'linked runtime representation uses Nix NAR verification, not portable ASAR inventory')
  assert.equal(descriptor.release.hostProtocolVersion, 4)
  assert.match(descriptor.release.nodeVersion, /^22\./)
  assert.equal(descriptor.release.pnpmVersion, '11.7.0')
  for (const name of ['@deepseek-ai/dsh', '@deepseek-ai/dsh-desktop-host']) {
    const entry = descriptor.sharedPackages.find(candidate => candidate.name === name)
    assert.ok(entry !== undefined, `${name} missing from sharedPackages`)
    assert.equal(entry.version, descriptor.release.version)
    assert.equal(entry.path, `node_modules/${name}`)
  }
})

check('platformClientHeaders(null) reports the web identity', () => {
  const { platformClientHeaders, desktopClientHeaders } = require('@deepseek-ai/dsh-deepseek-account')
  const client = { version: '0.2.0-rc.2', locale: 'en-US', timezoneOffsetSeconds: 0 }
  const headers = platformClientHeaders(null, client)
  assert.equal(headers['x-client-platform'], 'web')
  assert.equal(headers['x-client-bundle-id'], '')
  assert.equal(headers['x-client-version'], '0.2.0-rc.2')
  // A claimed desktop platform would invent an identity Linux does not have.
  assert.equal(desktopClientHeaders(null)['x-client-platform'], undefined)
  assert.equal(platformClientHeaders('darwin', client)['x-client-platform'], 'desktop-mac')
  assert.equal(platformClientHeaders('win32', client)['x-client-platform'], 'desktop-win')
})

check('private nodeBin runs store Node, never Electron', () => {
  const launcher = readFileSync(join(desktopDir, 'libexec/node-bin/node'), 'utf8')
  assert.match(launcher, /bin\/node --expose-internals "\$@"/)
  assert.ok(!launcher.includes('electron'), 'nodeBin must not reference Electron')
})

check('launcher unsets Node-mode variables and honours the session', () => {
  const wrapper = readFileSync(join(desktopDir, 'bin/dsh-desktop'), 'utf8')
  assert.match(wrapper, /unset ELECTRON_RUN_AS_NODE NODE_OPTIONS NODE_PATH/)
  assert.match(wrapper, /--user-data-dir="\$user_data_dir"/)
  assert.ok(!wrapper.includes('--no-sandbox'), 'sandbox must not be disabled globally')
  const entry = readFileSync(join(desktopDir, 'share/applications/dsh-desktop.desktop'), 'utf8')
  assert.match(entry, /^Exec=dsh-desktop %u$/m)
  assert.match(entry, /^Icon=dsh-desktop$/m)
  assert.match(entry, /^StartupWMClass=DeepSeek Harness$/m)
  assert.match(entry, /^MimeType=x-scheme-handler\/dsh;$/m)
})

let failures = 0
for (const { name, body } of checks) {
  try {
    await body()
    console.log(`ok - ${name}`)
  } catch (error) {
    failures += 1
    console.error(`not ok - ${name}\n  ${error?.message ?? error}`)
  }
}
console.log(`static: ${checks.length - failures}/${checks.length} passed`)
process.exit(failures === 0 ? 0 : 1)