import assert from 'node:assert/strict'
import test from 'node:test'
import { createProviderHandler } from './provider-codex.mjs'

const agent = { id: 'web-root', session: { id: 'web-session' } }
const signal = new AbortController().signal
const invocation = rawInput => ({ rawInput, agent, signal })

test('/provider defaults to the Codex subscription and forwards the Web agent', async () => {
  const calls = []
  const handler = createProviderHandler(() => ({
    login: async (...args) => {
      calls.push(args)
      return { provider: 'openai-codex', oauthLabel: 'OpenAI Codex', expiresAt: Date.now() + 60_000 }
    },
  }))
  assert.equal((await handler(invocation(''))).kind, 'success')
  assert.deepEqual(calls, [['openai-codex', signal, agent]])
  assert.equal((await handler(invocation('login'))).kind, 'success')
  assert.equal(calls.length, 2)
})

test('/provider status masks credentials and logout uses the shared route', async () => {
  let removed
  const handler = createProviderHandler(() => ({
    providers: async () => [{ provider: 'openai-codex', signedIn: true, expiresAt: Date.now() + 60_000 }],
    logout: async id => { removed = id; return true },
  }))
  assert.match((await handler(invocation('status'))).text, /已登录/)
  assert.equal((await handler(invocation('logout'))).kind, 'success')
  assert.equal(removed, 'openai-codex')
})

test('/provider rejects unrelated provider grammar and handles absent auth safely', async () => {
  assert.equal((await createProviderHandler(() => undefined)(invocation(''))).kind, 'error')
  assert.equal((await createProviderHandler(() => { throw Error('must not resolve API') })(invocation('login anthropic'))).kind, 'error')
})
