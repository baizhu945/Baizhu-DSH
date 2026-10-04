import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { composeUserInstructions, mirrorUserInstructions } from './codex-native.mjs'

// Real-filesystem tests of the production instruction mirror: no native binary,
// no credentials, no model. Proves the user's DSH user-global AGENTS.md reaches
// the official core exactly as DSH itself would render it, and that nothing
// else leaks into the private home.

async function home(t, files = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-user-instructions-'))
  t.after(() => fs.rm(base, { recursive: true, force: true }))
  const roots = { dsh: path.join(base, 'dsh'), codex: path.join(base, 'codex'),
    native: path.join(base, 'preset', 'native-home'), explicit: path.join(base, 'explicit') }
  for (const directory of Object.values(roots)) await fs.mkdir(directory, { recursive: true })
  for (const [name, entries] of Object.entries(files)) {
    for (const [filename, body] of Object.entries(entries)) {
      await fs.writeFile(path.join(roots[name], filename), body)
    }
  }
  const read = async file => { try { return await fs.readFile(file, 'utf8') } catch { return undefined } }
  const mirror = options => mirrorUserInstructions({ nativeHome: roots.native, dshHome: roots.dsh,
    codexHome: roots.codex, ...options })
  const agents = path.join(roots.native, 'AGENTS.md')
  const override = path.join(roots.native, 'AGENTS.override.md')
  return { base, roots, read, mirror, agents, override }
}

test('composeUserInstructions concatenates in DSH order and collapses trimmed duplicates', () => {
  assert.equal(composeUserInstructions([]), '')
  assert.equal(composeUserInstructions([{ text: '  ' }, { text: undefined }, { text: null }]), '')
  assert.equal(composeUserInstructions([{ text: ' a \n' }, { text: 'a' }, { text: 'b' }]), 'a\nb\n')
  assert.equal(composeUserInstructions([{ text: 'a' }, { text: 'x'.repeat(1_048_576) }]), undefined)
})

test('DSH user-global AGENTS.md is mirrored into the private native home', async t => {
  const h = await home(t, { dsh: { 'AGENTS.md': 'USER_GLOBAL_MARKER\n' } })
  await h.mirror()
  assert.equal(await h.read(h.agents), 'USER_GLOBAL_MARKER\n')
  assert.equal(await h.read(h.override), undefined)
})

test('CLAUDE.md fallback and .local overlays concatenate exactly like DSH renders them', async t => {
  const h = await home(t, { dsh: { 'CLAUDE.md': 'SECOND\n', 'AGENTS.local.md': 'LOCAL\n', 'CLAUDE.local.md': 'LOCAL\n' } })
  await h.mirror()
  assert.equal(await h.read(h.agents), 'SECOND\nLOCAL\n')
})

test('base file precedes the .local overlay in DSH order', async t => {
  const h = await home(t, { dsh: { 'AGENTS.md': 'BASE\n', 'AGENTS.local.md': 'LOCAL\n' } })
  await h.mirror()
  assert.equal(await h.read(h.agents), 'BASE\nLOCAL\n')
})

test('removing the source removes the mirror instead of leaving a stale prompt', async t => {
  const h = await home(t, { dsh: { 'AGENTS.md': 'STALE_MARKER\n' } })
  await h.mirror()
  assert.equal(await h.read(h.agents), 'STALE_MARKER\n')
  await fs.unlink(path.join(h.roots.dsh, 'AGENTS.md'))
  await h.mirror()
  assert.equal(await h.read(h.agents), undefined)
})

test('Codex CLI global instructions are used only when DSH has none', async t => {
  const both = await home(t, { dsh: { 'AGENTS.md': 'DSH_WINS\n' }, codex: { 'AGENTS.md': 'CODEX_ONLY\n' } })
  await both.mirror()
  assert.equal(await both.read(both.agents), 'DSH_WINS\n')
  const codexOnly = await home(t, { codex: { 'AGENTS.override.md': 'CODEX_OVERRIDE\n' } })
  await codexOnly.mirror()
  assert.equal(await codexOnly.read(codexOnly.agents), 'CODEX_OVERRIDE\n')
})

test('an explicit Codex-style home is mirrored verbatim, including its override', async t => {
  const h = await home(t, { explicit: { 'AGENTS.md': 'BASE\n', 'AGENTS.override.md': 'OVERRIDE\n' },
    dsh: { 'AGENTS.md': 'DSH_IGNORED\n' } })
  await h.mirror({ explicit: h.roots.explicit })
  assert.equal(await h.read(h.override), 'OVERRIDE\n')
  assert.equal(await h.read(h.agents), 'BASE\n')
})

test('a symlinked instruction file is never mirrored out of the home directory', async t => {
  const h = await home(t)
  const outside = path.join(h.base, 'outside.md')
  await fs.writeFile(outside, 'ESCAPED\n')
  await fs.symlink(outside, path.join(h.roots.dsh, 'AGENTS.md'))
  await h.mirror()
  assert.equal(await h.read(h.agents), undefined)
})

test('oversized user-global instructions mirror nothing rather than a truncated prompt', async t => {
  const warnings = []
  const h = await home(t, { dsh: { 'AGENTS.md': 'x'.repeat(1_048_577) } })
  await h.mirror({ logger: { warn: message => warnings.push(message) } })
  assert.equal(await h.read(h.agents), undefined)
  assert.equal(warnings.length, 1)
})

test('only instruction files are mirrored; other host home state never is', async t => {
  const h = await home(t, { dsh: { 'AGENTS.md': 'ONLY_THIS\n', 'config.toml': 'SECRET=1\n', 'auth.json': '{"t":"x"}' },
    codex: { 'AGENTS.md': 'X\n', 'config.toml': 'nope = true\n' } })
  await h.mirror()
  assert.equal(await h.read(h.agents), 'ONLY_THIS\n')
  const names = (await fs.readdir(h.roots.native)).sort()
  assert.deepEqual(names, ['AGENTS.md'])
})