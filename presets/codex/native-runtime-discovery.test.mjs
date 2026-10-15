import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { dshRuntimeFromBinary } from './codex-test-environment.mjs'

test('runtime discovery follows the private Nix launcher and symlinks without executing it', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-runtime-discovery-'))
  t.after(() => fs.rm(base, { recursive: true, force: true }))
  const runtime = path.join(base, 'runtime')
  const launcher = path.join(base, 'launcher', 'bin', 'dsh')
  const binary = path.join(runtime, 'bin', 'dsh')
  await fs.mkdir(path.join(runtime, 'packages', 'core', 'agent-loop'), { recursive: true })
  await fs.mkdir(path.dirname(binary), { recursive: true })
  await fs.mkdir(path.dirname(launcher), { recursive: true })
  await fs.writeFile(binary, '#!/bin/sh\nexit 99\n')
  await fs.writeFile(launcher, `#!/bin/sh\ntouch ${base}/MUST_NOT_EXECUTE\nexec ${binary} "$@"\n`)
  const profile = path.join(base, 'profile-dsh')
  await fs.symlink(launcher, profile)
  assert.equal(dshRuntimeFromBinary(profile), runtime)
  await assert.rejects(fs.stat(path.join(base, 'MUST_NOT_EXECUTE')), { code: 'ENOENT' })
})

test('runtime discovery rejects cyclic wrappers and dynamic unproven exec targets', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-runtime-cycle-'))
  t.after(() => fs.rm(base, { recursive: true, force: true }))
  const one = path.join(base, 'one', 'bin', 'dsh')
  const two = path.join(base, 'two', 'bin', 'dsh')
  for (const binary of [one, two]) await fs.mkdir(path.dirname(binary), { recursive: true })
  await fs.writeFile(one, `exec ${two} "$@"\n`)
  await fs.writeFile(two, `exec ${one} "$@"\n`)
  assert.throws(() => dshRuntimeFromBinary(one), /does not identify/)
  await fs.writeFile(one, 'exec "$MUTABLE_TARGET/bin/dsh" "$@"\n')
  assert.throws(() => dshRuntimeFromBinary(one), /does not identify/)
})
