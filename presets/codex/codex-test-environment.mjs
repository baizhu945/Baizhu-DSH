/** Offline test inputs; never guess an obsolete store hash or a /tmp checkout. */
import { realpathSync, existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const home = process.env.HOME ?? homedir()
const preset = path.join(process.env.DSH_HOME ?? path.join(home, '.dsh'), '.agent-presets/codex')
export const installedBinary = path.join(preset, 'bin/codex')
export const installedCatalog = path.join(preset, 'codex-models.json')
export const requireIntegration = process.env.DSH_CODEX_REQUIRE_NATIVE_TESTS === '1'

/** Follow literal Nix launcher execs without executing shell code or guessing store hashes. */
export function dshRuntimeFromBinary(binary) {
  const visited = new Set()
  for (let depth = 0; depth < 8; depth++) {
    const resolved = realpathSync(binary)
    if (visited.has(resolved)) break
    visited.add(resolved)
    const root = path.dirname(path.dirname(resolved))
    if (existsSync(path.join(root, 'packages/core/agent-loop'))) return root
    const forwarded = /^exec\s+["']?(\/[^\s"']+\/bin\/dsh)["']?(?:\s|$)/m.exec(readFileSync(resolved, 'utf8'))?.[1]
    if (!forwarded) break
    binary = forwarded
  }
  throw new Error('DSH launcher does not identify a runtime directory')
}

export function installedDshRoot() {
  const candidates = [path.join(home, '.nix-profile/bin/dsh'), '/run/current-system/sw/bin/dsh',
    ...String(process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map(directory => path.join(directory, 'dsh'))]
  for (const binary of candidates) {
    try {
      return dshRuntimeFromBinary(binary)
    } catch {}
  }
  throw new Error('Cannot locate installed DSH. Supply DSH_CODEX_TEST_DSH_ROOT or run bash verify.sh with a DSH runtime directory.')
}

export function requiredFixture(variable) {
  const value = process.env[variable]
  if (!value || !existsSync(value)) throw new Error(`Missing ${variable}. Run bash verify.sh to build exact pinned verification inputs; no cached /tmp or store hash is assumed.`)
  return value
}

export function integrationOptions(binary, enabled = true) {
  if (requireIntegration && (!enabled || !existsSync(binary))) {
    throw new Error('Required native integration inputs are unavailable. Run bash verify.sh; required checks are never silently skipped.')
  }
  return { timeout: 20_000, skip: !enabled ? 'Native integration not explicitly enabled' : !existsSync(binary) ? 'Native runtime unavailable; run bash verify.sh.' : false }
}
