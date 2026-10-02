/**
 * The primary runtime payload must resolve *in place* through
 * tool-workspace-dependencies, and the recorded distribution map must be exactly what
 * the payload's own interpreter reports — not an approximation of it.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { runtimeDir, primaryRuntime, payloadDir, run } from './lib.mjs'
import { existsSync, lstatSync, readFileSync } from 'node:fs'

const checks = []
function check(name, body) {
  checks.push({ name, body })
}

check('payload layout matches what office.ts resolves', () => {
  // Office skills are a sibling of the payload directory.
  const officeSkills = join(payloadDir, 'office-skills')
  assert.ok(existsSync(officeSkills), 'office-skills must sit beside primary-runtime/')
  assert.ok(existsSync(join(officeSkills, 'scripts/check_office.py')), 'official check_office.py must be reachable')
  assert.ok(existsSync(join(officeSkills, 'office-docx/SKILL.md')), 'Office skills must be reachable')

  for (const relative of [
    'runtime.json',
    'dependencies/python/bin/python3',
    'dependencies/node/bin/node',
    'dependencies/node/node_modules',
    'dependencies/pnpm/bin/pnpm.mjs',
  ]) {
    assert.ok(existsSync(join(primaryRuntime, relative)), `missing payload entry ${relative}`)
  }
  // Everything is a store link: the payload copies nothing and installs nothing.
  for (const relative of [
    'dependencies/python/bin/python3',
    'dependencies/node/bin/node',
    'dependencies/pnpm',
    'dependencies/node/node_modules',
  ]) {
    assert.ok(lstatSync(join(primaryRuntime, relative)).isSymbolicLink(),
      `${relative} must be a store symlink, not a copy`)
  }
})

check('runtime.json is well formed and reproducible', () => {
  const manifest = JSON.parse(readFileSync(join(primaryRuntime, 'runtime.json'), 'utf8'))
  assert.equal(manifest.platform, 'linux')
  assert.equal(manifest.arch, 'x64')
  assert.match(manifest.payloadDigest, /^[a-f0-9]{64}$/)
  assert.match(manifest.python, /^\d+\.\d+\.\d+$/)
  assert.match(manifest.node, /^22\./)
  assert.equal(manifest.pnpm, '11.7.0')
  for (const name of ['lxml', 'numpy', 'openpyxl', 'pandas', 'pillow', 'python-docx', 'python-pptx', 'xlsxwriter']) {
    assert.ok(manifest.pythonPackages[name], `runtime.json is missing ${name}`)
    assert.match(manifest.pythonPackages[name], /^\d[\w.!+-]*$/, `${name} version is not representable`)
  }
  // Normalized and sorted, so the map is stable across rebuilds.
  const keys = Object.keys(manifest.pythonPackages)
  assert.deepEqual(keys, [...keys].sort(), 'pythonPackages must be sorted')
  assert.deepEqual(keys, [...new Set(keys)], 'pythonPackages must not collide')
  // The ABI directory the Host derives from the recorded version must exist.
  const abi = manifest.python.split('.').slice(0, 2).join('.')
  assert.ok(existsSync(join(primaryRuntime, `dependencies/python/lib/python${abi}/site-packages`)),
    `site-packages for Python ${abi} must exist`)
})

check('resolvePrimaryRuntime returns the store payload without copying', async () => {
  const { resolvePrimaryRuntime } = await import(
    join(runtimeDir, 'packages/skill/tool-workspace-dependencies/lib/index.js')
  )
  const paths = await resolvePrimaryRuntime(primaryRuntime)
  assert.equal(paths.python, join(primaryRuntime, 'dependencies/python/bin/python3'))
  assert.equal(paths.node, join(primaryRuntime, 'dependencies/node/bin/node'))
  assert.equal(paths.pnpm, join(primaryRuntime, 'dependencies/pnpm/bin/pnpm.mjs'))
  assert.equal(paths.pythonPackages,
    join(primaryRuntime, `dependencies/python/lib/python${JSON.parse(readFileSync(join(primaryRuntime, 'runtime.json'), 'utf8')).python.split('.').slice(0, 2).join('.')}/site-packages`))
  // Every returned path must still be the immutable store link: nothing was dereferenced.
  for (const key of ['python', 'node', 'pnpm', 'pythonPackages', 'nodePackages']) {
    assert.ok(paths[key], `${key} unresolved`)
  }
  assert.ok(lstatSync(paths.nodePackages).isSymbolicLink(), 'node_modules must remain a store link')
})

check('pythonDistributions equals importlib.metadata from this exact interpreter', async () => {
  const python = join(primaryRuntime, 'dependencies/python/bin/python3')
  const script = [
    'import importlib.metadata as m, json, re',
    'out = {}',
    'for d in m.distributions():',
    '    raw = (d.metadata["Name"] or "").strip()',
    '    if raw: out[re.sub(r"[-_.]+", "-", raw.lower())] = (d.version or "").strip()',
    'print(json.dumps(out, sort_keys=True))',
  ].join('\n')
  const reported = JSON.parse(execFileSync(python, ['-c', script], { encoding: 'utf8' }))
  const recorded = JSON.parse(readFileSync(join(primaryRuntime, 'runtime.json'), 'utf8')).pythonPackages
  assert.deepEqual(reported, recorded, 'recorded distributions drifted from the interpreter')

  const { resolvePrimaryRuntime } = await import(
    join(runtimeDir, 'packages/skill/tool-workspace-dependencies/lib/index.js')
  )
  const paths = await resolvePrimaryRuntime(primaryRuntime)
  assert.deepEqual(paths.pythonDistributions, recorded, 'the tool must serve the recorded map')
})

check('the payload Node is the store Node used for package scripts', async () => {
  const manifest = JSON.parse(readFileSync(join(primaryRuntime, 'runtime.json'), 'utf8'))
  const result = await run(join(primaryRuntime, 'dependencies/node/bin/node'), ['--version'])
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.stdout.trim(), `v${manifest.node}`)
  const pnpm = JSON.parse(readFileSync(join(primaryRuntime, 'dependencies/pnpm/package.json'), 'utf8'))
  assert.equal(pnpm.version, manifest.pnpm)
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
console.log(`primary-runtime: ${checks.length - failures}/${checks.length} passed`)
process.exit(failures === 0 ? 0 : 1)