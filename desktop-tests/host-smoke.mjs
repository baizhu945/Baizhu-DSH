/**
 * Isolated Desktop Host smoke.
 *
 * Drives the real private Host binary the Electron shell spawns — the same argv vector
 * host-process.ts builds — against a throwaway DSH_HOME and profile. It must reach
 * ready with boot injections, report no active work when asked to quit, expose
 * workspace dependencies without copying the payload into the harness home, and answer
 * shutdown before exiting 0. The invoking user's ~/.dsh, sessions, and credentials are
 * never read or written.
 */

import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  cleanup, delay, primaryRuntime, run, runtimeDir, temporaryDirectory, waitFor,
} from './lib.mjs'

const checks = []
function check(name, body) {
  checks.push({ name, body })
}

const sandbox = temporaryDirectory('host')
const dshHome = join(sandbox, 'dsh-home')
const userHome = join(sandbox, 'home')
const profile = join(dshHome, 'profiles', 'desktop')
const nodeBin = process.env.DSH_DESKTOP_NODE_BIN
const pnpmEntry = join(runtimeDir, 'node_modules/pnpm/bin/pnpm.mjs')
const node = process.env.DSH_DESKTOP_HOST_NODE

const hostEnvironment = {
  ...process.env,
  // Everything the Host reads or writes stays inside the sandbox.
  DSH_HOME: dshHome,
  HOME: userHome,
  XDG_CONFIG_HOME: join(userHome, '.config'),
  XDG_CACHE_HOME: join(userHome, '.cache'),
  XDG_DATA_HOME: join(userHome, '.local/share'),
  XDG_STATE_HOME: join(userHome, '.local/state'),
  // The Nix seam: the payload is consumed where it lies.
  DSH_DESKTOP_NIX: '1',
  DSH_WEB_FETCH_ALLOW_FAKE_IP: '0',
}

check('the Desktop profile initializes from the runtime descriptor', async () => {
  const projectManager = await import(join(runtimeDir, 'apps/desktop/lib/types/project-manager.js'))
  const paths = await import(join(runtimeDir, 'apps/desktop/lib/types/paths.js'))
  const resolved = paths.resolveDesktopPaths(dshHome)
  assert.equal(resolved.profile, profile)
  // applyRelease() validates desktop-runtime.json before preparing the profile, so a
  // descriptor the shell would reject fails here first.
  await new projectManager.DesktopProjectManager(resolved, { dsh: runtimeDir }).applyRelease()
  assert.ok(existsSync(join(profile, 'package.json')), 'profile package.json must exist')
  assert.ok(existsSync(join(profile, 'pnpm-workspace.yaml')), 'profile workspace file must exist')
  const manifest = JSON.parse(await import('node:fs').then(fs => fs.promises.readFile(join(profile, 'package.json'), 'utf8')))
  // createPluginProfile() owns the profile manifest: a private profile carrying the
  // desktop bundle set and no registry-pinned release packages.
  assert.equal(manifest.name, 'dsh-profile-desktop')
  assert.equal(manifest.private, true)
  assert.deepEqual(manifest.dependencies, {}, 'a fresh desktop profile pins nothing from a registry')
  assert.ok(Array.isArray(manifest.dsh?.profile?.bundles) && manifest.dsh.profile.bundles.length > 0,
    'the desktop bundle set must be recorded')
  assert.ok(existsSync(join(profile, 'cordis.patch.yml')), 'the profile patch must exist')
  // Nothing was installed into the harness home at initialization.
  assert.ok(!existsSync(join(dshHome, 'primary-runtime')),
    'the payload must not be copied under DSH_HOME')
})

check('the Host reaches ready and then shuts down cleanly', async () => {
  const { spawn } = await import('node:child_process')
  // The shell spawns `node --expose-internals <entry> ...`, not a bare fork.
  const spawned = spawn(
    node,
    ['--expose-internals', join(runtimeDir, 'apps/desktop-host/lib/index.js'),
      runtimeDir, profile, primaryRuntime, pnpmEntry, nodeBin],
    { env: hostEnvironment, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
  )
  const events = []
  const exit = new Promise(resolve => spawned.on('exit', (code, signal) => resolve({ code, signal })))
  spawned.on('message', message => { events.push(message) })
  let stdout = ''
  let stderr = ''
  spawned.stdout.setEncoding('utf8')
  spawned.stderr.setEncoding('utf8')
  spawned.stdout.on('data', chunk => { stdout += chunk })
  spawned.stderr.on('data', chunk => { stderr += chunk })

  try {
    const ready = await waitFor(
      () => events.find(event => event?.type === 'ready'),
      { timeout: 180_000, label: 'Host ready event' },
    )
    assert.match(ready.url, /^http:\/\/127\.0\.0\.1:\d+/,
      `unexpected Host URL ${ready.url}`)
    assert.notEqual(ready.injections, undefined, 'Host must supply boot injections')
    assert.ok(Array.isArray(ready.injections))

    // A fresh Host has nothing running, so quit inspection must report that clearly.
    const inspected = await new Promise((resolve, reject) => {
      const onMessage = message => {
        if (message?.type === 'quit-inspection' && message.requestId === 1) {
          spawned.off('message', onMessage)
          resolve(message)
        }
      }
      spawned.on('message', onMessage)
      spawned.send({ type: 'quit-inspection', requestId: 1 })
      setTimeout(() => reject(new Error('quit-inspection timed out')), 30_000).unref()
    })
    assert.equal(inspected.error, undefined, `inspection failed: ${inspected.error}`)
    assert.equal(inspected.activeTasks, false, 'a fresh Host has no active tasks')
    assert.equal(inspected.scheduledTasks, false, 'a fresh Host has no scheduled tasks')

    // load_workspace_dependencies must serve the store payload in place.
    const { resolvePrimaryRuntime } = await import(
      join(runtimeDir, 'packages/skill/tool-workspace-dependencies/lib/index.js')
    )
    const dependencies = await resolvePrimaryRuntime(primaryRuntime)
    assert.ok(dependencies.pythonPackages.includes('/dependencies/python/lib/python'))
    assert.ok(!existsSync(join(dshHome, 'primary-runtime')),
      'resolving the payload must not copy it under DSH_HOME')

    const acknowledged = new Promise((resolve, reject) => {
      const onMessage = message => {
        if (message?.type === 'shutdown-complete') {
          spawned.off('message', onMessage)
          resolve(true)
        }
      }
      spawned.on('message', onMessage)
      spawned.send({ type: 'shutdown' })
      setTimeout(() => reject(new Error('shutdown acknowledgement timed out')), 60_000).unref()
    })
    spawned.send({ type: 'shutdown' })
    assert.equal(await acknowledged, true, 'Host must acknowledge shutdown before exiting')

    const result = await Promise.race([exit, delay(60_000).then(() => 'timeout')])
    assert.notEqual(result, 'timeout', 'Host must exit after acknowledging shutdown')
    assert.equal(result.code, 0, `Host exited with ${JSON.stringify(result)}: ${stderr}`)
  } finally {
    if (spawned.exitCode === null && spawned.signalCode === null) spawned.kill('SIGKILL')
    await Promise.race([exit, delay(5_000)])
  }

  // The sandbox, not the user's home, is the only thing that changed.
  const created = existsSync(dshHome) ? readdirSync(dshHome) : []
  assert.ok(!created.includes('sessions'), 'no session data may be written by a smoke run')
})

let failures = 0
for (const { name, body } of checks) {
  try {
    await body()
    console.log(`ok - ${name}`)
  } catch (error) {
    failures += 1
    console.error(`not ok - ${name}\n  ${error?.stack ?? error}`)
  }
}
cleanup()
console.log(`host-smoke: ${checks.length - failures}/${checks.length} passed`)
process.exit(failures === 0 ? 0 : 1)