import assert from 'node:assert/strict'
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { inspect } from 'node:util'
import { getEventListeners } from 'node:events'
import test from 'node:test'
import { createNativeAuth } from './codex-native-auth.mjs'

// All credentials, stores and OAuth providers in this suite are synthetic.
// Never import the web plugin, deployed CredentialFile, or real pi-ai OAuth.
const NOW = 1_700_000_000_000
const clock = () => NOW
const credential = (label, expires = NOW + 3_600_000) => ({
  type: 'oauth', access: `mock-access-${label}`, refresh: `mock-refresh-${label}`,
  expires, accountId: `account-${label}`,
})
const expired = () => credential('old', 0)
const jwt = claims => `mock-header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.mock-signature`
const claimsToken = (account = 'claim-account', plan = 'pro') => jwt({
  'https://api.openai.com/auth': { chatgpt_account_id: account, chatgpt_plan_type: plan },
})
const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

// Different instances share a document lock, mirroring CredentialFile's
// cross-process exclusion. read() is intentionally unlocked, as in DSH.
function memoryStore(initial) {
  const state = { providers: { ...(initial === undefined ? {} : { 'openai-codex': structuredClone(initial) }), other: credential('other') } }
  const stats = { reads: 0, modifies: 0, writes: 0, locked: false }
  let pending = Promise.resolve()
  const lock = operation => {
    const run = pending.then(async () => {
      assert.equal(stats.locked, false)
      stats.locked = true
      try { return await operation() } finally { stats.locked = false }
    })
    pending = run.then(() => undefined, () => undefined)
    return run
  }
  const instance = () => ({
    async read(provider) {
      assert.equal(provider, 'openai-codex')
      stats.reads++
      return structuredClone(state.providers[provider])
    },
    async modify(provider, fn) {
      assert.equal(provider, 'openai-codex')
      stats.modifies++
      return lock(async () => {
        const current = structuredClone(state.providers[provider])
        const replacement = await fn(current)
        if (replacement !== undefined && replacement !== current) {
          state.providers[provider] = structuredClone(replacement)
          stats.writes++
        }
        return structuredClone(state.providers[provider])
      })
    },
    async delete(provider) {
      assert.equal(provider, 'openai-codex')
      return lock(async () => { delete state.providers[provider] })
    },
  })
  return { state, stats, lock, stores: [instance(), instance()] }
}

function auth(store, refresh, extra = {}) {
  // Promise mocks exercise the public dependency-injection contract.
  return createNativeAuth({ dshHome: '/nonexistent/offline-dsh', store: Promise.resolve(store), oauth: Promise.resolve({ refresh }), clock, ...extra })
}
const unexpectedRefresh = () => { assert.fail('OAuth must not be invoked') }
const output = label => ({ accessToken: `mock-access-${label}`, chatgptAccountId: `account-${label}` })
function safeError(error, secrets = []) {
  assert.ok(error instanceof Error)
  assert.equal(error.cause, undefined)
  const printed = [String(error), error.stack, JSON.stringify(error), inspect(error)].join('\n')
  for (const secret of secrets) assert.ok(!printed.includes(secret), 'error must not contain synthetic secret material')
  return true
}

test('import and factory are dependency-lazy; fresh credentials never load OAuth', async () => {
  assert.doesNotThrow(() => createNativeAuth({ dshHome: '/nonexistent/native-auth-lazy', piAiRoot: '/nonexistent/pi-ai' }))
  const fixture = memoryStore(credential('fresh'))
  let oauthLoads = 0
  const lazyOAuth = { then() { oauthLoads++; throw new Error('must not load OAuth') } }
  const native = auth(fixture.stores[0], unexpectedRefresh, { oauth: lazyOAuth })
  assert.deepEqual(Object.keys(native), ['credentials'])
  assert.deepEqual(await native.credentials(), output('fresh'))
  assert.deepEqual(await native.credentials(), output('fresh'))
  assert.equal(oauthLoads, 0)
  assert.equal(fixture.stats.modifies, 2)
  assert.equal(fixture.stats.reads, 0)
  assert.equal(fixture.stats.writes, 0)
})

test('concurrent native/DSH store instances rotate an expiring token only once', async () => {
  const fixture = memoryStore(expired())
  const entered = deferred()
  const release = deferred()
  let count = 0
  const refresh = async (current, signal) => {
    count++
    assert.equal(fixture.stats.locked, true, 'refresh must run inside modify')
    assert.deepEqual(current, expired())
    assert.equal(signal, undefined)
    entered.resolve()
    await release.promise
    return credential('rotated')
  }
  const first = auth(fixture.stores[0], refresh).credentials()
  await entered.promise
  const second = auth(fixture.stores[1], refresh).credentials()
  const third = auth(fixture.stores[0], refresh).credentials()
  release.resolve()
  assert.deepEqual(await Promise.all([first, second, third]), [output('rotated'), output('rotated'), output('rotated')])
  assert.equal(count, 1)
  assert.equal(fixture.stats.writes, 1)
  assert.deepEqual(fixture.state.providers.other, credential('other'))
})

test('refresh threshold includes exactly 60 seconds, but not 60 seconds plus 1ms', async () => {
  for (const [remaining, expectedCount] of [[60_000, 1], [60_001, 0]]) {
    const fixture = memoryStore(credential('threshold', NOW + remaining))
    let count = 0
    await auth(fixture.stores[0], async () => { count++; return credential('rotated') }).credentials()
    assert.equal(count, expectedCount)
    assert.equal(fixture.stats.writes, expectedCount)
  }
})

test('forced refresh rotates a fresh token; overlapping force calls share the rotation', async () => {
  const fixture = memoryStore(credential('fresh'))
  const entered = deferred()
  const release = deferred()
  const secondRead = deferred()
  const otherStore = {
    ...fixture.stores[1],
    async read(provider) {
      const value = await fixture.stores[1].read(provider)
      secondRead.resolve()
      return value
    },
  }
  let count = 0
  const refresh = async current => {
    assert.equal(fixture.stats.locked, true)
    assert.equal(current.refresh, 'mock-refresh-fresh')
    count++
    entered.resolve()
    await release.promise
    return credential('rotated')
  }
  const first = auth(fixture.stores[0], refresh).credentials({ forceRefresh: true })
  await entered.promise
  const second = auth(otherStore, refresh).credentials({ forceRefresh: true })
  await secondRead.promise
  release.resolve()
  assert.deepEqual(await Promise.all([first, second]), [output('rotated'), output('rotated')])
  assert.equal(count, 1)
  assert.equal(fixture.stats.writes, 1)
  // A later, independent 401 still requests a fresh rotation.
  await auth(fixture.stores[0], async current => {
    assert.equal(current.refresh, 'mock-refresh-rotated')
    count++
    return credential('again')
  }).credentials({ forceRefresh: true })
  assert.equal(count, 2)
})

test('missing/invalid credentials reject without loading OAuth or writing', async () => {
  for (const value of [undefined, null, { ...expired(), type: 'api_key' }, { ...expired(), refresh: '' }, { ...expired(), access: ' ' }, { ...expired(), expires: NaN }]) {
    const fixture = memoryStore(value)
    const before = structuredClone(fixture.state)
    await assert.rejects(auth(fixture.stores[0], unexpectedRefresh).credentials(), error => {
      assert.match(error.message, /login|invalid/)
      return safeError(error)
    })
    assert.deepEqual(fixture.state, before)
    assert.equal(fixture.stats.writes, 0)
  }
})

test('JWT account/plan claims derive protocol fields; stored account ID works without JWT', async () => {
  const value = { ...credential('claims'), access: claimsToken(), accountId: undefined }
  const fixture = memoryStore(value)
  assert.deepEqual(await auth(fixture.stores[0], unexpectedRefresh).credentials(), {
    accessToken: value.access, chatgptAccountId: 'claim-account', chatgptPlanType: 'pro',
  })
  const known = { ...credential('known'), planType: 'team' }
  const knownFixture = memoryStore(known)
  assert.deepEqual(await auth(knownFixture.stores[0], unexpectedRefresh).credentials(), {
    ...output('known'), chatgptPlanType: 'team',
  })
  assert.equal(fixture.stats.writes, 0)
})

test('unknown/invalid account IDs are rejected, never guessed or included in errors', async () => {
  const candidates = [
    'mock-not-a-jwt', 'header.invalid-json.signature',
    jwt({ accountId: 'not-official', sub: 'not-an-account' }),
    jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 123 } }),
    jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: '  ' } }),
  ]
  for (const access of candidates) {
    const value = { ...credential('unknown'), accountId: undefined, access }
    const fixture = memoryStore(value)
    await assert.rejects(auth(fixture.stores[0], unexpectedRefresh).credentials(), error => {
      assert.equal(error.code, 'CODEX_AUTH_ACCOUNT_MISSING')
      return safeError(error, [value.access, value.refresh])
    })
    assert.equal(fixture.stats.writes, 0)
  }
})

test('returned protocol credentials contain no refresh token or store metadata', async () => {
  const value = { ...credential('secret'), metadata: { device: 'test' }, idToken: 'mock-id-token' }
  const fixture = memoryStore(value)
  const result = await auth(fixture.stores[0], unexpectedRefresh).credentials()
  assert.deepEqual(result, output('secret'))
  assert.ok(!JSON.stringify(result).includes(value.refresh))
  assert.equal(result.expires, undefined)
  assert.equal(result.idToken, undefined)
})

test('latest login inside the lock supersedes a stale forced snapshot', async () => {
  const fixture = memoryStore(expired())
  const held = deferred()
  const release = deferred()
  const read = deferred()
  const blocker = fixture.lock(async () => { held.resolve(); await release.promise })
  await held.promise
  const login = fixture.stores[1].modify('openai-codex', () => credential('new-login'))
  const store = {
    ...fixture.stores[0],
    async read(provider) {
      const current = await fixture.stores[0].read(provider)
      assert.deepEqual(current, expired())
      read.resolve()
      return current
    },
  }
  const pending = auth(store, unexpectedRefresh).credentials({ forceRefresh: true })
  await read.promise
  release.resolve()
  await Promise.all([blocker, login])
  assert.deepEqual(await pending, output('new-login'))
  assert.equal(fixture.stats.writes, 1, 'only the newer login writes')
})

test('logout before lock acquisition cannot be resurrected from a forced snapshot', async () => {
  const fixture = memoryStore(expired())
  const held = deferred()
  const release = deferred()
  const read = deferred()
  const blocker = fixture.lock(async () => { held.resolve(); await release.promise })
  await held.promise
  const logout = fixture.stores[1].delete('openai-codex')
  const store = {
    ...fixture.stores[0],
    async read(provider) {
      const current = await fixture.stores[0].read(provider)
      assert.deepEqual(current, expired())
      read.resolve()
      return current
    },
  }
  const pending = auth(store, unexpectedRefresh).credentials({ forceRefresh: true })
  const rejection = assert.rejects(pending, error => error.code === 'CODEX_AUTH_MISSING')
  await read.promise
  release.resolve()
  await Promise.all([blocker, logout, rejection])
  assert.equal(fixture.state.providers['openai-codex'], undefined)
  assert.equal(fixture.stats.writes, 0)
})

test('logout during refresh waits for the document lock and remains logged out', async () => {
  const fixture = memoryStore(expired())
  const entered = deferred()
  const release = deferred()
  const native = auth(fixture.stores[0], async () => {
    entered.resolve()
    await release.promise
    return credential('rotated')
  })
  const pending = native.credentials()
  await entered.promise
  const logout = fixture.stores[1].delete('openai-codex')
  assert.deepEqual(fixture.state.providers['openai-codex'], expired())
  release.resolve()
  assert.deepEqual(await pending, output('rotated'))
  await logout
  assert.equal(fixture.state.providers['openai-codex'], undefined)
  await assert.rejects(native.credentials(), error => error.code === 'CODEX_AUTH_MISSING')
  assert.equal(fixture.stats.writes, 1)
})

test('failed refresh preserves all DSH data, even if the provider mutates its input', async () => {
  const value = { ...expired(), metadata: { nested: ['preserve'] } }
  const fixture = memoryStore(value)
  const before = structuredClone(fixture.state)
  await assert.rejects(auth(fixture.stores[0], async current => {
    current.access = 'mock-mutated-access'
    current.refresh = 'mock-mutated-refresh'
    current.metadata.nested.push('mutated')
    throw new Error(`response body: ${value.access} ${value.refresh} mock-newly-issued-token`)
  }).credentials(), error => {
    assert.equal(error.code, 'CODEX_AUTH_REFRESH_FAILED')
    return safeError(error, [value.access, value.refresh, 'mock-newly-issued-token'])
  })
  assert.deepEqual(fixture.state, before)
  assert.equal(fixture.stats.writes, 0)
  // A failed attempt does not poison the store lock/queue.
  assert.deepEqual(await auth(fixture.stores[0], async () => credential('recovered')).credentials(), output('recovered'))
})

test('incomplete or expired refresh results are never persisted', async () => {
  for (const value of [undefined, null, { access: 'mock-incomplete' }, { ...credential('bad'), type: 'api_key' }, { ...credential('bad'), refresh: '' }, { ...credential('bad'), expires: Infinity }, credential('bad', 0)]) {
    const fixture = memoryStore(expired())
    const before = structuredClone(fixture.state)
    await assert.rejects(auth(fixture.stores[0], async () => value).credentials(), /incomplete|expired/)
    assert.deepEqual(fixture.state, before)
    assert.equal(fixture.stats.writes, 0)
  }
})

test('new JWT identity wins while unrelated metadata survives refresh', async () => {
  const old = { ...expired(), planType: 'old-plan', metadata: { preserve: true } }
  const fixture = memoryStore(old)
  const next = { ...credential('next'), access: claimsToken('new-account', 'team') }
  delete next.accountId
  assert.deepEqual(await auth(fixture.stores[0], async () => next).credentials(), {
    accessToken: next.access, chatgptAccountId: 'new-account', chatgptPlanType: 'team',
  })
  assert.equal(fixture.state.providers['openai-codex'].accountId, 'new-account')
  assert.deepEqual(fixture.state.providers['openai-codex'].metadata, { preserve: true })
})

test('refresh with no known account ID is rejected before writing', async () => {
  const old = { ...expired(), accountId: undefined }
  const next = { ...credential('next'), accountId: undefined }
  const fixture = memoryStore(old)
  await assert.rejects(auth(fixture.stores[0], async () => next).credentials(), error => error.code === 'CODEX_AUTH_ACCOUNT_MISSING')
  assert.deepEqual(fixture.state.providers['openai-codex'], old)
  assert.equal(fixture.stats.writes, 0)
})

test('an already-aborted call loads no dependencies and never exposes its reason', async () => {
  const controller = new AbortController()
  const secret = 'mock-secret-abort-reason'
  controller.abort(new Error(secret))
  let loads = 0
  const lazy = { then() { loads++; throw new Error('dependency should not load') } }
  const native = createNativeAuth({ store: lazy, oauth: lazy, clock })
  await assert.rejects(native.credentials({ signal: controller.signal }), error => {
    assert.equal(error.name, 'AbortError')
    return safeError(error, [secret])
  })
  assert.equal(loads, 0)
})

test('abort while waiting for a promised store prevents lock acquisition', async () => {
  const fixture = memoryStore(expired())
  const promised = deferred()
  const controller = new AbortController()
  const pending = auth(promised.promise, unexpectedRefresh).credentials({ signal: controller.signal })
  controller.abort()
  promised.resolve(fixture.stores[0])
  await assert.rejects(pending, error => error.name === 'AbortError')
  assert.equal(fixture.stats.modifies, 0)
  assert.equal(fixture.stats.writes, 0)
})

test('abort while queued for the lock prevents OAuth and all writes', async () => {
  const fixture = memoryStore(expired())
  const held = deferred()
  const release = deferred()
  const queued = deferred()
  const blocker = fixture.lock(async () => { held.resolve(); await release.promise })
  await held.promise
  const store = {
    ...fixture.stores[0],
    modify(provider, fn) { queued.resolve(); return fixture.stores[0].modify(provider, fn) },
  }
  const controller = new AbortController()
  const pending = auth(store, unexpectedRefresh).credentials({ signal: controller.signal })
  await queued.promise
  controller.abort()
  release.resolve()
  await blocker
  await assert.rejects(pending, error => error.name === 'AbortError')
  assert.equal(fixture.stats.writes, 0)
})

test('abort while awaiting OAuth loading prevents refresh and writes', async () => {
  const fixture = memoryStore(expired())
  const loaded = deferred()
  const entered = deferred()
  const controller = new AbortController()
  const oauth = { then(resolve, reject) { entered.resolve(); loaded.promise.then(resolve, reject) } }
  const pending = auth(fixture.stores[0], unexpectedRefresh, { oauth }).credentials({ signal: controller.signal })
  await entered.promise
  controller.abort()
  loaded.resolve({ refresh: unexpectedRefresh })
  await assert.rejects(pending, error => error.name === 'AbortError')
  assert.equal(fixture.stats.writes, 0)
})

test('abort during refresh (even ignored by OAuth) prevents replacement writes', async () => {
  for (const reject of [false, true]) {
    const fixture = memoryStore(expired())
    const controller = new AbortController()
    const before = structuredClone(fixture.state)
    await assert.rejects(auth(fixture.stores[0], async (_, signal) => {
      assert.equal(signal, controller.signal)
      controller.abort('mock-secret-abort')
      if (reject) throw new Error('mock-secret-refresh-rejection')
      return credential('aborted')
    }).credentials({ signal: controller.signal }), error => {
      assert.equal(error.name, 'AbortError')
      return safeError(error, ['mock-secret-abort', 'mock-secret-refresh-rejection'])
    })
    assert.deepEqual(fixture.state, before)
    assert.equal(fixture.stats.writes, 0)
  }
})

test('arbitrary dependency/store/clock errors are sanitized without a cause', async () => {
  const secret = 'mock-raw-secret-in-stack-and-message'
  const fail = () => { throw new Error(secret) }
  const rejection = { then(_, reject) { reject(new Error(secret)) } }
  const cases = [
    createNativeAuth({ store: rejection, oauth: { refresh: fail }, clock }),
    auth({ modify: fail }, fail),
    auth({ read: fail, modify: fail }, fail),
    auth(memoryStore(expired()).stores[0], fail, { oauth: rejection }),
    auth(memoryStore(expired()).stores[0], fail, { clock: fail }),
  ]
  for (const [index, native] of cases.entries()) {
    await assert.rejects(native.credentials({ forceRefresh: index === 2 }), error => safeError(error, [secret]))
  }
})

test('clock object injection works and invalid clocks do not refresh or write', async () => {
  const fixture = memoryStore(credential('fresh'))
  assert.deepEqual(await auth(fixture.stores[0], unexpectedRefresh, { clock: { now: clock } }).credentials(), output('fresh'))
  await assert.rejects(auth(fixture.stores[0], unexpectedRefresh, { clock: () => NaN }).credentials(), error => error.code === 'CODEX_AUTH_CLOCK')
  assert.equal(fixture.stats.writes, 0)
})

async function promptly(operation) {
  let timer
  try {
    return await Promise.race([operation, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Abort did not settle promptly')), 500)
    })])
  } finally { clearTimeout(timer) }
}
const tick = () => new Promise(resolve => setImmediate(resolve))

test('abort rejects promptly while a store dependency is still unresolved', async () => {
  const fixture = memoryStore(expired())
  const loaded = deferred()
  const controller = new AbortController()
  controller.signal.addEventListener('abort', event => event.stopImmediatePropagation(), { once: true })
  const pending = auth(loaded.promise, unexpectedRefresh).credentials({ signal: controller.signal })
  const rejected = assert.rejects(pending, error => error.name === 'AbortError' && safeError(error, ['mock-abort-secret']))
  controller.abort('mock-abort-secret')
  await promptly(rejected)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  loaded.resolve(fixture.stores[0])
  await tick()
  assert.equal(fixture.stats.modifies, 0)
});

test('abort rejects promptly while queued, without bypassing the store lock', async () => {
  const fixture = memoryStore(expired())
  const held = deferred()
  const release = deferred()
  const queued = deferred()
  const blocker = fixture.lock(async () => { held.resolve(); await release.promise })
  await held.promise
  const store = { ...fixture.stores[0], modify(provider, fn) {
    queued.resolve()
    return fixture.stores[0].modify(provider, fn)
  } }
  const controller = new AbortController()
  const pending = auth(store, unexpectedRefresh).credentials({ signal: controller.signal })
  const rejected = assert.rejects(pending, { name: 'AbortError' })
  await queued.promise
  controller.abort()
  await promptly(rejected)
  assert.equal(fixture.stats.locked, true)
  release.resolve()
  await blocker
  await tick()
  assert.equal(fixture.stats.writes, 0)
  assert.equal(fixture.stats.locked, false)
});

test('abort rejects promptly during ignored OAuth cancellation, retaining rotation exclusion', async () => {
  const fixture = memoryStore(expired())
  const entered = deferred()
  const release = deferred()
  const controller = new AbortController()
  const pending = auth(fixture.stores[0], async () => {
    entered.resolve()
    return release.promise
  }).credentials({ signal: controller.signal })
  const rejected = assert.rejects(pending, { name: 'AbortError' })
  await entered.promise
  controller.abort()
  await promptly(rejected)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  assert.equal(fixture.stats.locked, true)
  let rotations = 0
  const next = auth(fixture.stores[1], async () => { rotations++; return credential('recovered') }).credentials()
  await tick()
  assert.equal(rotations, 0)
  release.resolve(credential('aborted'))
  assert.deepEqual(await next, output('recovered'))
  assert.equal(rotations, 1)
  assert.equal(fixture.stats.writes, 1)
});

test('abort listeners are removed on success, store failure, and invalid signal rejection', async () => {
  const fixture = memoryStore(credential('fresh'))
  const controller = new AbortController()
  await auth(fixture.stores[0], unexpectedRefresh).credentials({ signal: controller.signal })
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  await assert.rejects(auth({ modify() { throw new Error('mock-store-secret') } }, unexpectedRefresh).credentials({ signal: controller.signal }),
    error => safeError(error, ['mock-store-secret']))
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  await assert.rejects(auth(fixture.stores[0], unexpectedRefresh).credentials({ signal: {} }), { code: 'CODEX_AUTH_INVALID' })
});

test('failed abort listener installation cannot start store access or rotation', async () => {
  const fixture = memoryStore(expired())
  const controller = new AbortController()
  controller.signal.addEventListener = () => { throw new Error('mock-listener-secret') }
  await assert.rejects(auth(fixture.stores[0], unexpectedRefresh).credentials({ signal: controller.signal }),
    error => safeError(error, ['mock-listener-secret']))
  await tick()
  assert.equal(fixture.stats.modifies, 0)
  assert.equal(fixture.stats.writes, 0)
});

test('whitespace/control-bearing access and refresh tokens are invalid before any write', async () => {
  for (const key of ['access', 'refresh']) {
    for (const token of [' mock-secret', 'mock-secret ', 'mock\u0000secret', 'mock\nsecret', 'mock\u007fsecret']) {
      const value = { ...credential('invalid'), [key]: token }
      const fixture = memoryStore(value)
      await assert.rejects(auth(fixture.stores[0], unexpectedRefresh).credentials(),
        error => error.code === 'CODEX_AUTH_INVALID' && safeError(error, [token]))
      const old = memoryStore(expired())
      await assert.rejects(auth(old.stores[0], async () => value).credentials(), { code: 'CODEX_AUTH_INVALID' })
      assert.equal(fixture.stats.writes, 0)
      assert.equal(old.stats.writes, 0)
    }
  }
});

test('header-unsafe stored/JWT account metadata is not forwarded', async () => {
  for (const accountId of ['bad\naccount', 'bad\u0000account', 'bad\taccount']) {
    for (const claims of [false, true]) {
      const value = { ...credential('invalid'), ...(claims
        ? { accountId: undefined, access: claimsToken(accountId) } : { accountId }) }
      await assert.rejects(auth(memoryStore(value).stores[0], unexpectedRefresh).credentials(),
        error => error.code === 'CODEX_AUTH_ACCOUNT_MISSING' && safeError(error, [accountId]))
    }
  }
  const fixture = memoryStore({ ...credential('fresh'), planType: 'bad\nplan' })
  assert.deepEqual(await auth(fixture.stores[0], unexpectedRefresh).credentials(), output('fresh'))
});

test('expired or near-expiry JWT exp cannot be masked by a fresh store expiry', async () => {
  for (const seconds of [-1, 60, 61]) {
    const value = { ...credential('claims'), access: jwt({ exp: NOW / 1000 + seconds,
      'https://api.openai.com/auth': { chatgpt_account_id: 'claim-account' } }), accountId: undefined }
    const fixture = memoryStore(value)
    let count = 0
    const result = await auth(fixture.stores[0], async () => { count++; return credential('rotated') }).credentials()
    assert.equal(count, seconds <= 60 ? 1 : 0)
    assert.equal(result.accessToken, seconds <= 60 ? 'mock-access-rotated' : value.access)
  }
});

test('invalid JWT expiry and noncanonical account payloads cannot supply credentials', async () => {
  for (const exp of [null, '9999999999', {}, []]) {
    const fixture = memoryStore({ ...credential('invalid'), access: jwt({ exp }) })
    await assert.rejects(auth(fixture.stores[0], unexpectedRefresh).credentials(), { code: 'CODEX_AUTH_INVALID' })
    assert.equal(fixture.stats.writes, 0)
  }
  for (const suffix of ['!', '=']) {
    const parts = claimsToken().split('.')
    parts[1] += suffix // Node's permissive Buffer decoder used to accept these.
    const fixture = memoryStore({ ...credential('invalid'), access: parts.join('.'), accountId: undefined })
    await assert.rejects(auth(fixture.stores[0], unexpectedRefresh).credentials(), { code: 'CODEX_AUTH_ACCOUNT_MISSING' })
  }
});

test('JWT account claims with malformed UTF-8 are not silently repaired', async () => {
  const payload = Buffer.concat([Buffer.from('{"https://api.openai.com/auth":{"chatgpt_account_id":"'),
    Buffer.from([0xff]), Buffer.from('"}}')]).toString('base64url')
  const fixture = memoryStore({ ...credential('invalid'), accountId: undefined,
    access: `mock-header.${payload}.mock-signature` })
  await assert.rejects(auth(fixture.stores[0], unexpectedRefresh).credentials(), { code: 'CODEX_AUTH_ACCOUNT_MISSING' })
});

test('refresh expiry is checked against the clock after asynchronous work, not its start', async () => {
  const fixture = memoryStore(expired())
  let now = NOW
  await assert.rejects(auth(fixture.stores[0], async () => {
    now += 120_000
    return credential('already-expired', NOW + 100_000)
  }, { clock: () => now }).credentials(), { code: 'CODEX_AUTH_INVALID' })
  assert.equal(fixture.stats.writes, 0)
  assert.deepEqual(fixture.state.providers['openai-codex'], expired())
});

test('refresh with an expired JWT is rejected even with a future expires field', async () => {
  const fixture = memoryStore(expired())
  const value = { ...credential('invalid'), access: jwt({ exp: NOW / 1000 - 1 }) }
  await assert.rejects(auth(fixture.stores[0], async () => value).credentials(), { code: 'CODEX_AUTH_INVALID' })
  assert.equal(fixture.stats.writes, 0)
});

test('credentials that expire while store.modify completes are never returned', async () => {
  for (const refresh of [false, true]) {
    const fixture = memoryStore(refresh ? expired() : credential('fresh'))
    let now = NOW
    const store = { ...fixture.stores[0], async modify(provider, fn) {
      const value = await fixture.stores[0].modify(provider, fn)
      now = value.expires + 1
      return value
    } }
    await assert.rejects(auth(store, async () => credential('rotated'), { clock: () => now }).credentials(), { code: 'CODEX_AUTH_INVALID' })
    assert.equal(fixture.stats.writes, refresh ? 1 : 0)
  }
});

test('account/workspace replacement with identical tokens supersedes a forced snapshot', async () => {
  const value = credential('fresh')
  const fixture = memoryStore(value)
  const held = deferred()
  const release = deferred()
  const observed = deferred()
  const blocker = fixture.lock(async () => { held.resolve(); await release.promise })
  await held.promise
  const changed = { ...value, accountId: 'new-workspace', planType: 'team' }
  const login = fixture.stores[1].modify('openai-codex', () => changed)
  const store = { ...fixture.stores[0], async read(provider) {
    const result = await fixture.stores[0].read(provider)
    observed.resolve()
    return result
  } }
  const pending = auth(store, unexpectedRefresh).credentials({ forceRefresh: true })
  await observed.promise
  release.resolve()
  await Promise.all([blocker, login])
  assert.deepEqual(await pending, { accessToken: value.access, chatgptAccountId: 'new-workspace', chatgptPlanType: 'team' })
  assert.equal(fixture.stats.writes, 1)
});

test('a delayed forced refresh is scoped to the access token that actually received 401', async () => {
  const fixture = memoryStore(credential('fresh'))
  let count = 0
  const native = auth(fixture.stores[0], async current => {
    count++
    return credential(current.access === 'mock-access-fresh' ? 'rotated' : 'again')
  })
  const options = { forceRefresh: true, previousAccessToken: 'mock-access-fresh' }
  assert.deepEqual(await native.credentials(options), output('rotated'))
  // The second server's 401 can arrive after the first already saved rotation.
  assert.deepEqual(await native.credentials(options), output('rotated'))
  assert.equal(count, 1)
  assert.equal(fixture.stats.reads, 0, 'known rejected revision does not need an unlocked snapshot')
  assert.deepEqual(await native.credentials({ forceRefresh: true, previousAccessToken: 'mock-access-rotated' }), output('again'))
  assert.equal(count, 2)
});

test('a rejected old token cannot force a newer login, but logout still fails closed', async () => {
  const fixture = memoryStore(credential('new-login'))
  const native = auth(fixture.stores[0], unexpectedRefresh)
  const options = { forceRefresh: true, previousAccessToken: 'mock-access-old' }
  assert.deepEqual(await native.credentials(options), output('new-login'))
  assert.equal(fixture.stats.writes, 0)
  await fixture.stores[1].delete('openai-codex')
  await assert.rejects(native.credentials(options), { code: 'CODEX_AUTH_MISSING' })
  for (const previousAccessToken of ['', ' mock-secret-token', {}, null]) {
    await assert.rejects(native.credentials({ forceRefresh: true, previousAccessToken }),
      error => error.code === 'CODEX_AUTH_INVALID' && safeError(error, ['mock-secret-token']))
  }
});

test('a broken store cannot silently return undefined authentication', async () => {
  await assert.rejects(auth({ async modify() {} }, unexpectedRefresh).credentials(), { code: 'CODEX_AUTH_STORE' })
});

// Synthetic package fixtures exercise lazy resolution without reading ANY
// credential file or importing ANY deployed TUI/pi-ai code. Heavy entry points
// deliberately throw; only the small store/OAuth mock modules may be loaded.
async function resolverFixture(t, { hideLlmManifest = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'codex-native-auth-mock-'))
  const home = join(root, 'dsh-home')
  const profile = join(home, 'profiles')
  const key = `native-auth-mock:${root}`
  const state = { paths: [], credential: expired(), source: undefined }
  globalThis[key] = state
  t.after(() => { delete globalThis[key] })
  const file = async (path, content) => {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content)
  }
  const pkg = async (path, name, exports) => {
    await file(join(path, 'package.json'), JSON.stringify({ name, type: 'module', exports }))
    await file(join(path, 'index.js'), 'throw new Error("heavy package entry must not be loaded")\n')
  }
  const tui = join(profile, 'node_modules/@deepseek-harness-tui/dsh-tui')
  await pkg(tui, '@deepseek-harness-tui/dsh-tui', { '.': './index.js', './package.json': './package.json' })
  await file(join(tui, 'lib/types/dsh-adapter/oauth/credentials.js'), `
    const state = globalThis[${JSON.stringify(key)}]
    export class CredentialFile {
      constructor(path) { state.paths.push(path) }
      async read() { return structuredClone(state.credential) }
      async modify(provider, fn) {
        if (provider !== 'openai-codex') throw new Error('wrong mock provider')
        const next = await fn(structuredClone(state.credential))
        if (next !== undefined) state.credential = structuredClone(next)
        return state.credential
      }
    }
  `)
  const llm = join(root, 'current-runtime/packages/llm/llm-pi-ai')
  await pkg(llm, '@deepseek-ai/dsh-llm-pi-ai', hideLlmManifest ? { '.': './index.js' } : { '.': './index.js', './package.json': './package.json' })
  const linkedLlm = join(profile, 'node_modules/@deepseek-ai/dsh-llm-pi-ai')
  await mkdir(dirname(linkedLlm), { recursive: true })
  await symlink(llm, linkedLlm)
  const pi = async (path, source) => {
    await pkg(path, '@earendil-works/pi-ai', { '.': { import: './index.js' } })
    await file(join(path, 'dist/auth/oauth/openai-codex.js'), `
      const state = globalThis[${JSON.stringify(key)}]
      export const openaiCodexOAuth = {
        async refresh(current) {
          state.source = ${JSON.stringify(source)}
          return { ...current, access: 'mock-${source}-access', refresh: 'mock-${source}-refresh', expires: ${NOW + 3_600_000} }
        }
      }
    `)
  }
  const owned = join(llm, 'node_modules/@earendil-works/pi-ai')
  await pi(owned, 'owned')
  await pi(join(profile, 'node_modules/@earendil-works/pi-ai'), 'stale-shared')
  const envPi = join(root, 'env-pi')
  const explicitPi = join(root, 'explicit-pi')
  await pi(envPi, 'env')
  await pi(explicitPi, 'explicit')
  const saved = {}
  for (const name of ['DSH_HOME', 'DSH_CODEX_REQUIRE_ANCHOR', 'DSH_PI_AI_ROOT', 'DSH_AUTH_CREDENTIALS']) saved[name] = process.env[name]
  process.env.DSH_HOME = home
  process.env.DSH_CODEX_REQUIRE_ANCHOR = join(profile, 'mock-auth.cjs')
  delete process.env.DSH_PI_AI_ROOT
  delete process.env.DSH_AUTH_CREDENTIALS
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })
  return { root, home, state, envPi, explicitPi }
}

test('default loader uses the canonical store module and existing dsh-auth path', async t => {
  const fixture = await resolverFixture(t)
  const native = createNativeAuth({ clock })
  assert.deepEqual(fixture.state.paths, [], 'construction does not load the store')
  fixture.state.credential = credential('fresh')
  assert.deepEqual(await native.credentials(), output('fresh'))
  assert.deepEqual(fixture.state.paths, [join(fixture.home, 'dsh-auth/credentials.json')])
  assert.equal(fixture.state.source, undefined, 'fresh credentials never import OAuth')
  process.env.DSH_AUTH_CREDENTIALS = join(fixture.root, 'mock-env-credentials.json')
  await createNativeAuth({ clock }).credentials()
  assert.equal(fixture.state.paths.at(-1), process.env.DSH_AUTH_CREDENTIALS)
  const explicit = join(fixture.root, 'mock-explicit-credentials.json')
  await createNativeAuth({ credentialFile: explicit, clock }).credentials()
  assert.equal(fixture.state.paths.at(-1), explicit)
})

test('pi-ai fallback resolves the real current adapter, not a stale shared link', async t => {
  const fixture = await resolverFixture(t)
  const result = await createNativeAuth({ clock }).credentials()
  assert.equal(result.accessToken, 'mock-owned-access')
  assert.equal(fixture.state.source, 'owned')
})

test('pi-ai owner resolution also works when the adapter hides its manifest', async t => {
  const fixture = await resolverFixture(t, { hideLlmManifest: true })
  assert.equal((await createNativeAuth({ clock }).credentials()).accessToken, 'mock-owned-access')
  assert.equal(fixture.state.source, 'owned')
})

test('missing launcher dependency environment still resolves the current owner tree', async t => {
  const fixture = await resolverFixture(t)
  delete process.env.DSH_CODEX_REQUIRE_ANCHOR
  assert.equal((await createNativeAuth({ clock }).credentials()).accessToken, 'mock-owned-access')
  assert.equal(fixture.state.source, 'owned')
});

test('an explicit missing OAuth runtime fails safely instead of choosing another version', async t => {
  const fixture = await resolverFixture(t)
  await assert.rejects(createNativeAuth({ piAiRoot: join(fixture.root, 'mock-missing-secret-root'), clock }).credentials(),
    error => error.code === 'CODEX_AUTH_DEPENDENCY' && safeError(error, ['mock-missing-secret-root']))
  assert.equal(fixture.state.source, undefined)
  assert.deepEqual(fixture.state.credential, expired())
});

test('launcher pi-ai root is preferred, with an explicit root taking precedence', async t => {
  const fixture = await resolverFixture(t)
  process.env.DSH_PI_AI_ROOT = fixture.envPi
  assert.equal((await createNativeAuth({ clock }).credentials()).accessToken, 'mock-env-access')
  fixture.state.credential = expired()
  assert.equal((await createNativeAuth({ piAiRoot: fixture.explicitPi, clock }).credentials()).accessToken, 'mock-explicit-access')
})
