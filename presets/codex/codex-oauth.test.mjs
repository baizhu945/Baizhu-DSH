import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { refreshCodexCredential } from './codex-web-search.mjs'

// Run against the actual Nix-deployed TUI store, never the user's credentials.
const require = createRequire(join(process.env.DSH_HOME ?? join(process.env.HOME, '.dsh'), 'profiles/oauth-test.cjs'))
const manifest = require.resolve('@deepseek-harness-tui/dsh-tui/package.json')
const { CredentialFile } = await import(pathToFileURL(join(dirname(manifest), 'lib/types/dsh-adapter/oauth/credentials.js')).href)
const signal = () => new AbortController().signal
const token = (access, expires = Date.now() + 3600000) => ({ type: 'oauth', access, refresh: access + '-refresh', expires })
const expired = () => token('old', 0)
const fixture = () => {
  const path = join(mkdtempSync(join(tmpdir(), 'dsh-codex-oauth-')), 'credentials.json')
  return [new CredentialFile(path), new CredentialFile(path)]
}

test('parallel Codex/OAuth instances refresh a rotated token only once', async () => {
  const [codex, oauth] = fixture()
  await oauth.modify('openai-codex', async () => expired())
  let count = 0
  const refresh = async current => {
    count++
    assert.equal(current.refresh, 'old-refresh')
    await new Promise(resolve => setTimeout(resolve, 20))
    return token('rotated')
  }
  const results = await Promise.all([
    refreshCodexCredential(codex, refresh, signal()),
    refreshCodexCredential(oauth, refresh, signal()),
    refreshCodexCredential(codex, refresh, signal()),
  ])
  assert.equal(count, 1)
  assert.deepEqual(results.map(result => result.token), ['rotated', 'rotated', 'rotated'])
})

test('a newer login is preserved and a completed logout cannot be restored', async () => {
  const [codex, oauth] = fixture()
  await codex.modify('openai-codex', async () => expired())
  await oauth.modify('openai-codex', async () => token('new-login'))
  const unexpectedRefresh = () => { throw new Error('must not refresh the stale login') }
  assert.equal((await refreshCodexCredential(codex, unexpectedRefresh, signal())).token, 'new-login')
  await oauth.delete('openai-codex')
  await assert.rejects(refreshCodexCredential(codex, unexpectedRefresh, signal()), /credentials disappeared/)
  assert.equal(await oauth.read('openai-codex'), undefined)
})

test('logout during refresh waits for the lock and remains logged out', async () => {
  const [codex, oauth] = fixture()
  await oauth.modify('openai-codex', async () => expired())
  let release
  let entered
  const started = new Promise(resolve => { entered = resolve })
  const pending = refreshCodexCredential(codex, async () => {
    entered()
    await new Promise(resolve => { release = resolve })
    return token('rotated')
  }, signal())
  await started
  const logout = oauth.delete('openai-codex')
  release()
  await Promise.all([pending, logout])
  assert.equal(await codex.read('openai-codex'), undefined)
})

test('abort or incomplete refresh leaves the stored credential unchanged', async () => {
  const [codex] = fixture()
  await codex.modify('openai-codex', async () => expired())
  const controller = new AbortController()
  await assert.rejects(refreshCodexCredential(codex, async () => {
    controller.abort()
    return token('aborted')
  }, controller.signal), /aborted/)
  assert.equal((await codex.read('openai-codex')).access, 'old')
  await assert.rejects(refreshCodexCredential(codex, async () => ({ access: 'incomplete' }), signal()), /incomplete/)
  assert.equal((await codex.read('openai-codex')).access, 'old')
})
