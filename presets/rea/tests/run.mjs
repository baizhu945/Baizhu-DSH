import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
assert(process.argv[2] && process.argv[3], 'usage: node run.mjs <dshRuntimeRoot> <installedReaPresetRoot> [realReaExe]')
const root = dirname(fileURLToPath(import.meta.url))
// Match the supplied deployment's node executable and Loader internals flag,
// not the arbitrary Node used to invoke this thin coordinator.
const launcher = readFileSync(join(process.argv[2], 'bin/dsh'), 'utf8')
const node = /^exec (\/\S+\/bin\/node) --expose-internals /m.exec(launcher)?.[1] ?? process.execPath
const scripts = ['host-smoke.mjs', 'fixture-smoke.mjs', 'import-guard.mjs', 'composition-tests.mjs', 'fixture-tests.mjs']
if (process.argv[4]) scripts.push('real-acceptance.mjs')
for (const script of scripts) {
  console.log(`\n===== ${script} =====`)
  const result = spawnSync(node, ['--expose-internals', join(root, script), ...process.argv.slice(2)], {
    stdio: 'inherit', env: { ...process.env, DSH_TELEMETRY_DISABLED: '1' }, timeout: script === 'real-acceptance.mjs' ? 1980000 : 240000,
  })
  if (result.error) console.error(result.error)
  if (result.status !== 0) process.exit(result.status ?? 1)
}
console.log('\nPASS all requested REA preset tests')
