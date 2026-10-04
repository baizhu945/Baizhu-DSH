import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { createNativeBridge, NATIVE_PROVIDER, OFFICIAL_RUNTIME_VERSION, nativeFailureCode } from './codex-native.mjs'
import { CodexAppServer } from './codex-app-server.mjs'
import { existsSync } from 'node:fs'
import http from 'node:http'
import { pathToFileURL } from 'node:url'
import { installedBinary, installedDshRoot, integrationOptions } from './codex-test-environment.mjs'
import * as nativePresentation from './codex-native-presentation.mjs'

// Offline boundary tests; the available compiled-engine regression below
// uses only an authless 127.0.0.1 SSE fixture and installed DSH helpers.
// Never read real auth/session stores. All native writes stay in mkdtemp.
// Wire assertions follow 86a54b0 Rust v2/{turn,thread,permissions,item}.rs.
// Stable generated TS omits collaborationMode and other experimental fields;
// do NOT use that filtering as a reason to remove them from these assertions.
const LOOP = Symbol('fixture-agent-loop-request')
const PRIVATE = 'DSH_PRIVATE_CONTEXT_MUST_NOT_ENTER_NATIVE_HISTORY'
const TEXT = text => ({ type: 'text', text })
const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const tick = () => new Promise(resolve => setImmediate(resolve))
const freeze = value => {
  if (value && typeof value === 'object' && (Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype)) {
    // AbortSignal and other native service objects maintain mutable internals.
    // Only freeze request records, not those opaque handles.
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}
const user = (id, text, extra = {}) => freeze({ id, role: 'user', source: { kind: 'user' }, content: [TEXT(text)], ...extra })
const inputText = text => ({ type: 'text', text, text_elements: [] })

async function bounded(work, explanation, milliseconds = 1200) {
  let timer
  try {
    return await Promise.race([work, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(explanation)), milliseconds)
    })])
  } finally { clearTimeout(timer) }
}

class MockClient {
  constructor(options, fixture) {
    this.options = options
    this.fixture = fixture
    this.calls = []
    this.isClosed = false
    this.closeCount = 0
    this.closedEvent = deferred()
    // This is a transport completion seam, not a notification pretending that
    // Codex sends turn/completed after a crashed subprocess.
    this.closed = this.closedEvent.promise
  }
  async start(params) {
    this.initialization = structuredClone(params)
    return { userAgent: 'offline-fixture' }
  }
  notify(method, params) { this.options.onNotification(method, structuredClone(params)) }
  async request(method, params, options = {}) {
    options.signal?.throwIfAborted()
    assert.equal(this.isClosed, false, `request ${method} used a closed client`)
    const call = { method, params: structuredClone(params), options }
    this.calls.push(call)
    if (method === 'account/login/start') return { type: 'chatgptAuthTokens' }
    if (method === 'thread/start' || method === 'thread/resume') {
      this.threadId = params.threadId ?? `native-thread-${++this.fixture.nextThread}`
      return { thread: { id: this.threadId } }
    }
    if (method === 'turn/start') {
      const turnId = `native-turn-${++this.fixture.nextTurn}`
      this.turnId = turnId
      queueMicrotask(() => {
        this.notify('turn/started', { threadId: this.threadId, turn: { id: turnId, status: 'inProgress' } })
        if (this.fixture.onTurn) this.fixture.onTurn(this, turnId, params)
        else if (this.fixture.autoComplete) complete(this, turnId)
        this.fixture.turnStarted.resolve({ client: this, turnId, params })
      })
      return { turn: { id: turnId, status: 'inProgress' } }
    }
    if (method === 'turn/steer') {
      this.fixture.steerStarted.resolve({ client: this, params })
      return { turnId: this.turnId }
    }
    if (method === 'thread/compact/start') {
      const turnId = `native-compaction-${++this.fixture.nextCompaction}`
      this.turnId = turnId
      queueMicrotask(() => {
        this.notify('turn/started', { threadId: this.threadId, turn: { id: turnId, status: 'inProgress' } })
        this.fixture.onCompact?.(this, turnId, params)
        this.fixture.compactStarted.resolve({ client: this, turnId, params })
      })
      return {}
    }
    if (method === 'turn/interrupt') return {}
    assert.fail(`Unexpected native request ${method}; do not invoke real services in this fixture`)
  }
  async close() {
    this.closeCount++
    if (this.isClosed) return
    this.isClosed = true
    const error = Object.assign(new Error('offline transport closed'), { code: 'ECLOSED' })
    this.closedEvent.resolve(error)
    this.options.onClose?.(error)
  }
}
function complete(client, turnId = client.turnId) {
  client.notify('item/completed', { threadId: client.threadId, turnId,
    item: { id: `answer-${turnId}`, type: 'agentMessage', text: 'native answer', phase: 'final_answer' } })
  client.notify('turn/completed', { threadId: client.threadId, turn: { id: turnId, status: 'completed', error: null } })
}

async function fixture(t, settings = {}) {
  const base = settings.base ?? await fs.mkdtemp(path.join(os.tmpdir(), 'codex-native-offline-'))
  if (!settings.base) t.after(() => fs.rm(base, { recursive: true, force: true }))
  const config = { dshHome: path.join(base, 'dsh'), presetRoot: path.join(base, 'preset'),
    globalInstructionsHome: path.join(base, 'global-instructions'), executable: '/offline/do-not-spawn-codex',
    ...settings.config }
  const cwd = path.join(base, 'workspace')
  await Promise.all([fs.mkdir(cwd, { recursive: true }), fs.mkdir(config.globalInstructionsHome, { recursive: true })])
  const handlers = new Map()
  const registrations = []
  const commands = new Map()
  const tools = new Map()
  const scopedAgents = new WeakSet()
  const scopedToolOverrides = new WeakMap()
  const calls = { next: 0, execute: 0, auth: [], helperResults: [], injected: [], toolGets: [], scopeDeactivations: [] }
  const services = {
    sandboxPolicy: { defaultMode: settings.sandbox ?? 'workspace-write', resolve: () => ({ mode: settings.sandbox ?? 'workspace-write' }) },
    approval: { config: { policy: 'ask' } },
    ...settings.services,
  }
  const ctx = {
    on(event, handler, options = {}) {
      const entry = { handler, options }
      const list = handlers.get(event) ?? []
      if (options.prepend) list.unshift(entry)
      else list.push(entry)
      handlers.set(event, list)
      registrations.push({ event, ...entry })
      return () => { const index = list.indexOf(entry); if (index !== -1) list.splice(index, 1) }
    },
    get: key => services[key],
    tools: {
      register(tool) { assert.ok(!tools.has(tool.name), `duplicate UI tool ${tool.name}`); tools.set(tool.name, tool) },
      get(name, agent) {
        calls.toolGets.push({ name, agent })
        if (!agent) return tools.get(name)
        if (!scopedAgents.has(agent)) return undefined
        const overrides = scopedToolOverrides.get(agent)
        return overrides?.has(name) ? overrides.get(name) : tools.get(name)
      },
      execute() { calls.execute++; assert.fail('Native Codex must NEVER call DSH tools.execute') },
    },
    inject(deps, callback) {
      assert.deepEqual(deps, ['commands'])
      callback({ commands: { register(command) {
        settings.commands?.register(command)
        assert.ok(!commands.has(command.name), `duplicate native command ${command.name}`)
        commands.set(command.name, command)
      } } })
    },
    run(event, args, terminal = () => undefined) {
      const list = [...(handlers.get(event) ?? [])]
      const next = index => list[index] ? list[index].handler(...args, () => next(index + 1)) : terminal()
      return next(0)
    },
  }
  let messageCounter = 0
  const helpers = {
    isAgentLoopRequest: options => options[LOOP] === true,
    createUserMessage: input => user(`background-${++messageCounter}`, '', input),
    createToolResultMessage(input) {
      calls.helperResults.push(structuredClone(input))
      return freeze({ id: `result-${++messageCounter}`, role: 'tool', source: { kind: 'tool', callId: input.callId },
        toolCallId: input.callId, content: structuredClone(input.content), isError: input.isError })
    },
    defineTool: tool => tool,
  }
  const f = { base, cwd, config, ctx, handlers, registrations, commands, tools, calls, services,
    helpers, clients: [], nextThread: 0, nextTurn: 0, nextCompaction: 0, autoComplete: settings.autoComplete !== false,
    onTurn: settings.onTurn, onCompact: settings.onCompact,
    turnStarted: deferred(), compactStarted: deferred(), steerStarted: deferred(), backgroundInjected: deferred() }
  f.deactivateScope = agent => { scopedAgents.delete(agent); calls.scopeDeactivations.push(agent) }
  f.overrideScopedTool = (agent, name, tool) => {
    const overrides = scopedToolOverrides.get(agent) ?? new Map()
    overrides.set(name, tool)
    scopedToolOverrides.set(agent, overrides)
  }
  const auth = settings.auth ?? {
    async credentials(options) {
      calls.auth.push(options)
      return { accessToken: 'SYNTHETIC_NOT_A_CREDENTIAL', chatgptAccountId: 'offline-fixture' }
    },
  }
  f.auth = auth
  const dependencies = { helpers, ...(settings.presentation ? { presentation: settings.presentation } : {}), auth, createClient(options) {
    const client = settings.createClient ? settings.createClient(options, f) : new MockClient(options, f)
    f.clients.push(client)
    return client
  } }
  f.makeAgent = (id = settings.sessionId ?? 'session-1', initialEvents = []) => {
    let seq = Math.max(0, ...initialEvents.map(event => event.seq ?? 0))
    const events = structuredClone(initialEvents)
    const session = { id, header: { cwd }, events, snapshotEvents: () => [...events],
      append(type, data, meta = {}) {
        const event = { seq: ++seq, type, data: structuredClone(data), ...structuredClone(meta) }
        events.push(event)
        return event
      } }
    const agent = { session, inject: message => { calls.injected.push(message); f.backgroundInjected.resolve(message) } }
    scopedAgents.add(agent)
    return agent
  }
  f.agent = f.makeAgent(settings.sessionId, settings.events)
  f.bridge = createNativeBridge(ctx, config, dependencies)
  t.after(() => f.bridge.dispose())
  f.pre = (messages, agent = f.agent, position = { turn: 1, step: 0 }) =>
    ctx.run('agent/pre-step', [{ agent, messages, ...position }], () => { calls.next++; return { kind: 'enter', messages } })
  f.options = (agent = f.agent, extra = {}) => {
    // NATIVE_PROVIDER is merely a fixture route. Real request ownership is the
    // exact preset-scoped observer identity, never a rewritten provider/header.
    const options = { sessionId: agent.session.id, provider: settings.provider ?? NATIVE_PROVIDER, model: 'gpt-5.4', reasoningEffort: 'high',
      messages: [freeze({ id: 'assembled-private', role: 'system', content: [TEXT(PRIVATE)] })],
      systemPrompt: PRIVATE, developerInstructions: PRIVATE, tools: [{ name: PRIVATE }],
      context: PRIVATE, ...extra }
    Object.defineProperty(options, LOOP, { value: true })
    return freeze(options)
  }
  f.request = (proposed, agent = f.agent, position = { turn: 1, step: 0 }) =>
    ctx.run('agent/request', [{ agent, ...position }], () => proposed)
  f.stream = options => ctx.run('llm/stream', [options ?? f.options()], () => { calls.next++; assert.fail('Native loop was delegated to the DSH provider') })
  f.collect = async options => { const chunks = []; for await (const chunk of f.stream(options)) chunks.push(chunk); return chunks }
  f.command = (name, rawInput = '', agent = f.agent) => commands.get(name).handler({ agent, rawInput })
  f.rpc = method => f.clients.flatMap(client => client.calls ?? []).filter(call => call.method === method)
  return f
}

function assertGrammar(chunks, expectedFinish = 'stop') {
  const open = new Map()
  const seen = new Set()
  let usage = 0
  let finish = 0
  for (const chunk of chunks) {
    assert.equal(finish, 0, 'nothing may be emitted after finish')
    if (chunk.type === 'block-start') {
      assert.ok(Number.isSafeInteger(chunk.index) && chunk.index >= 0)
      assert.ok(!seen.has(chunk.index), 'block indices must never be reopened')
      seen.add(chunk.index)
      open.set(chunk.index, { kind: chunk.blockType, text: '' })
    } else if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
      const block = open.get(chunk.index)
      assert.equal(block?.kind, chunk.type === 'text-delta' ? 'text' : 'reasoning')
      assert.equal(typeof chunk.text, 'string')
      block.text += chunk.text
    } else if (chunk.type === 'block-end') {
      const block = open.get(chunk.index)
      assert.equal(chunk.block.type, block?.kind)
      assert.equal(chunk.block.text, block.text, 'final block must agree with its emitted deltas')
      open.delete(chunk.index)
    } else if (chunk.type === 'usage') {
      usage++
      assert.ok(usage <= 1)
    } else if (chunk.type === 'finish') {
      finish++
      assert.equal(chunk.reason.kind, expectedFinish)
      assert.equal(open.size, 0, 'even interrupted partial blocks must close')
    } else assert.fail(`unexpected native chunk ${chunk.type}; tool pairs belong to the UI session, not LLM tool calls`)
  }
  assert.equal(finish, 1)
}
function assertObservationAdvertisements(log) {
  for (const call of log.filter(event => event.type === 'tool/call')) {
    const index = log.indexOf(call), advertisement = log[index - 2], shadow = log[index - 1]
    assert.equal(advertisement.type, 'assistant/message', 'Every observation must first advertise its actual native call')
    assert.deepEqual(advertisement.data.message.source, { kind: 'model', provider: NATIVE_PROVIDER,
      model: 'native-observation', privateNativeObservation: true })
    const block = { type: 'tool-call', id: call.data.callId, name: call.data.name, arguments: call.data.arguments }
    assert.deepEqual(advertisement.data.message.content, [block])
    assert.deepEqual(advertisement.data.stream.map(entry => entry.chunk), [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'block-end', index: 0, block }, { type: 'finish', reason: { kind: 'tool-calls' } },
    ])
    assert.equal(advertisement.surfaceOp, 'append')
    assert.equal(advertisement.sourceEventSeqs, undefined, 'Assistant streams cannot carry sourceEventSeqs')
    assert.equal(advertisement.data.turn, call.data.turn)
    assert.equal(advertisement.data.step, call.data.step)
    assert.equal(shadow.type, 'developer/message')
    assert.deepEqual(shadow.data.message.content, [])
    assert.deepEqual(shadow.surfaceOp, { op: 'replace', startSeq: advertisement.seq, endSeq: advertisement.seq })
    assert.deepEqual(shadow.sourceEventSeqs, [advertisement.seq])
  }
}

const journalFor = (f, id = f.agent.session.id) => path.join(f.config.presetRoot, 'threads', `${createHash('sha256').update(id).digest('hex')}.json`)
const journal = async (f, id) => JSON.parse(await fs.readFile(journalFor(f, id), 'utf8'))

const contaminants = () => [
  freeze({ id: 'sys', role: 'system', source: { kind: 'system-prompt' }, content: [TEXT(PRIVATE)] }),
  freeze({ id: 'dev', role: 'developer', source: { kind: 'plugin' }, content: [TEXT(PRIVATE)] }),
  freeze({ id: 'context', role: 'user', source: { kind: 'context' }, content: [TEXT(PRIVATE)] }),
  freeze({ id: 'agent', role: 'user', source: { kind: 'agent', agentId: 'foreign-agent' }, content: [TEXT(PRIVATE)] }),
  freeze({ id: 'missing-source', role: 'user', content: [TEXT(PRIVATE)] }),
  freeze({ id: 'mirror', role: 'tool', source: { kind: 'tool', callId: 'mirror-1' }, toolCallId: 'mirror-1', content: [TEXT(PRIVATE)] }),
  freeze({ id: 'assistant', role: 'assistant', source: { kind: 'model' }, content: [TEXT(PRIVATE)] }),
]

test('scoped pre-step admits ONLY direct user messages and short-circuits harness augmentation', async t => {
  const f = await fixture(t)
  const message = user('u1', 'direct user', { content: [TEXT('direct user'), { type: 'system-reminder', text: PRIVATE }] })
  const messages = freeze([...contaminants(), message])
  assert.equal(f.pre(messages).kind, 'enter')
  assert.deepEqual(f.bridge.states.get('session-1').admitted, [message])
  assert.equal(f.calls.next, 0)
  assert.equal(f.pre(freeze(contaminants())).kind, 'reject')
  assert.equal(f.calls.next, 0)
  for (const { event, options } of f.registrations) {
    assert.notEqual(options.global, true, `${event} must be registered only on this preset context`)
  }
  f.pre(messages)
  assertGrammar(await f.collect())
  assert.deepEqual(f.rpc('turn/start')[0].params.input, [inputText('direct user')])
})

test('actual WebUI direct-user metadata is not model input or native authority', async t => {
  const f = await fixture(t)
  const source = { kind: 'user', rpcId: 'web-rpc-fixture', clientTimeZone: 'Asia/Shanghai',
    unknownMetadata: PRIVATE, originalSource: { kind: 'runtime-context' },
    sandbox: 'danger-full-access', approvalPolicy: 'never' }
  const message = user('web-user', 'actual WebUI direct text', { source })
  const foreign = user('foreign', PRIVATE, { source: { ...source, kind: 'context' } })
  assert.equal(f.pre([foreign, ...contaminants(), message]).kind, 'enter')
  assertGrammar(await f.collect())
  assert.deepEqual(f.rpc('turn/start')[0].params.input, [inputText('actual WebUI direct text')])
  assert.equal(f.rpc('thread/start')[0].params.sandbox, 'workspace-write')
  assert.equal(f.rpc('turn/start')[0].params.approvalPolicy, 'on-request')
  assert.equal(f.rpc('turn/start')[0].params.sandboxPolicy.type, 'workspaceWrite')
  const modelRpcs = f.clients.flatMap(client => client.calls).filter(call => call.method !== 'account/login/start')
  for (const call of modelRpcs) {
    const wire = JSON.stringify(call.params)
    for (const forbidden of [PRIVATE, 'web-rpc-fixture', 'Asia/Shanghai', 'unknownMetadata', 'originalSource', 'clientTimeZone']) {
      assert.ok(!wire.includes(forbidden), `${forbidden} reached native RPC ${call.method}`)
    }
  }
  assert.deepEqual((await journal(f)).delivered, ['web-user'])
  assert.equal(f.pre([foreign]).kind, 'reject', 'ancillary fields cannot promote a non-user source')
})

for (const content of [
  [{ type: 'image', path: '/fixture/image.png', detail: 'unsupported-image-detail' }],
  [{ type: 'file', path: '/fixture/file\0' }],
  [{ type: 'tool-call', id: 'spoof', name: 'spoof', arguments: '{}' }],
]) {
  test(`initial invalid user input is rejected before spawn, auth or thread binding: ${content[0].type}`, async t => {
    const f = await fixture(t)
    f.pre([user('bad-user', 'invalid input', { content })])
    const chunks = await bounded(f.collect(), 'invalid input must terminate without native startup')
    assertGrammar(chunks, 'error')
    assert.equal(chunks.at(-1).reason.failure.code, content[0].type === 'tool-call' ? 'unsupported-user-input' : 'invalid-params')
    assert.equal(f.clients.length, 0, 'validation must precede client creation/spawn')
    assert.equal(f.calls.auth.length, 0, 'invalid input must never acquire credentials')
    assert.equal(f.bridge.states.get(f.agent.session.id).threadId, undefined)
    await assert.rejects(fs.stat(journalFor(f)), { code: 'ENOENT' })
    await assert.rejects(fs.stat(path.join(f.config.presetRoot, 'native-home')), { code: 'ENOENT' })
    f.pre([user('valid-user', 'valid retry')])
    assertGrammar(await f.collect())
    assert.equal(f.rpc('thread/resume').length, 0)
    assert.deepEqual((await journal(f)).delivered, ['valid-user'])
  })
}

test('first-turn numeric RPC rejection is a terminal string failure; unstarted retry never resumes the orphan', async t => {
  const entered = deferred(), rejectTurn = deferred()
  t.after(() => rejectTurn.resolve())
  let rejectedOnce = false
  class RejectFirstTurn extends MockClient {
    async request(method, params, options = {}) {
      if (method === 'turn/start' && !rejectedOnce) {
        rejectedOnce = true
        this.calls.push({ method, params: structuredClone(params), options })
        entered.resolve()
        await rejectTurn.promise
        throw Object.assign(new Error(PRIVATE), { code: -32602, data: { secret: PRIVATE } })
      }
      return super.request(method, params, options)
    }
  }
  const f = await fixture(t, { createClient: (options, fixture) => new RejectFirstTurn(options, fixture) })
  const message = user('u1', 'retry my direct message')
  f.pre([message])
  const work = f.collect()
  await bounded(entered.promise, 'first turn never reached the numeric rejection fixture')
  const orphan = f.bridge.states.get('session-1').threadId
  assert.equal(typeof orphan, 'string')
  await assert.rejects(fs.stat(journalFor(f)), { code: 'ENOENT' }, 'thread/start is not a durable first-turn ACK')
  rejectTurn.resolve()
  const chunks = await bounded(work, 'numeric rejection must produce exactly one terminal finish')
  assertGrammar(chunks, 'error')
  const failure = chunks.at(-1).reason.failure
  assert.equal(typeof failure.code, 'string')
  assert.ok(failure.code.length > 0)
  assert.equal(failure.code, nativeFailureCode({ code: -32602 }))
  assert.ok(!JSON.stringify(failure).includes(PRIVATE))
  await assert.rejects(fs.stat(journalFor(f)), { code: 'ENOENT' })
  assert.equal(f.bridge.states.get('session-1').delivered.size, 0)
  assert.equal(f.clients[0].isClosed, true)
  f.pre([message])
  assertGrammar(await bounded(f.collect(), 'retry after unacknowledged first turn must finish'))
  assert.equal(f.rpc('thread/resume').length, 0, 'no first-turn ACK means no orphan resume, even within this bridge')
  assert.equal(f.rpc('thread/start').length, 2)
  const saved = await journal(f)
  assert.notEqual(saved.threadId, orphan)
  assert.equal(saved.threadStarted, true)
  assert.deepEqual(saved.delivered, ['u1'])
  assert.deepEqual(f.rpc('turn/start').map(call => call.params.input), [[inputText('retry my direct message')], [inputText('retry my direct message')]])
})

test('an unacknowledged first turn leaves no binding for a restarted bridge to resume', async t => {
  class RejectTurn extends MockClient {
    async request(method, params, options = {}) {
      if (method === 'turn/start') {
        this.calls.push({ method, params: structuredClone(params), options })
        throw Object.assign(new Error(PRIVATE), { code: -32600 })
      }
      return super.request(method, params, options)
    }
  }
  const f = await fixture(t, { createClient: (options, fixture) => new RejectTurn(options, fixture) })
  const message = user('u1', 'retry after restart')
  f.pre([message])
  assertGrammar(await f.collect(), 'error')
  await assert.rejects(fs.stat(journalFor(f)), { code: 'ENOENT' })
  await f.bridge.dispose()
  const resumed = await fixture(t, { base: f.base })
  resumed.pre([message])
  assertGrammar(await resumed.collect())
  assert.equal(resumed.rpc('thread/resume').length, 0)
  assert.equal(resumed.rpc('thread/start').length, 1)
  assert.deepEqual((await journal(resumed)).delivered, ['u1'])
})

test('legacy empty journal recovers fresh only for the bounded THREAD_NOT_FOUND reason', async t => {
  class MissingLegacyThread extends MockClient {
    async request(method, params, options = {}) {
      if (method === 'thread/resume') {
        this.calls.push({ method, params: structuredClone(params), options })
        throw Object.assign(new Error('Sanitized native RPC failure'), { code: -32600, rpcReason: 'THREAD_NOT_FOUND' })
      }
      return super.request(method, params, options)
    }
  }
  const f = await fixture(t, { createClient: (options, fixture) => new MissingLegacyThread(options, fixture) })
  await fs.mkdir(path.dirname(journalFor(f)), { recursive: true })
  await fs.writeFile(journalFor(f), JSON.stringify({ version: 1, sessionId: 'session-1', threadId: 'legacy-empty-thread',
    delivered: [], observed: [], controls: [], asyncInput: [], profile: null, mode: null, persistent: false }))
  f.pre([user('u1', 'recover only this new direct message')])
  assertGrammar(await bounded(f.collect(), 'empty legacy journal must recover without replaying harness history'))
  assert.equal(f.rpc('thread/resume').length, 1)
  assert.equal(f.rpc('thread/resume')[0].params.threadId, 'legacy-empty-thread')
  assert.equal(f.rpc('thread/start').length, 1)
  assert.equal(f.rpc('thread/start')[0].params.experimentalRawEvents, true)
  assert.deepEqual(f.rpc('turn/start')[0].params.input, [inputText('recover only this new direct message')])
  const saved = await journal(f)
  assert.notEqual(saved.threadId, 'legacy-empty-thread')
  assert.equal(saved.threadStarted, true)
  assert.deepEqual(saved.delivered, ['u1'])
})

for (const scenario of [
  { name: 'explicitly started thread', threadStarted: true, delivered: [], observed: [], reason: 'THREAD_NOT_FOUND' },
  { name: 'legacy delivered user history', delivered: ['old-user'], observed: [], reason: 'THREAD_NOT_FOUND' },
  { name: 'legacy observed native history', delivered: [], observed: ['old-observation'], reason: 'THREAD_NOT_FOUND' },
  { name: 'false flag cannot discard delivered history', threadStarted: false, delivered: ['old-user'], observed: [], reason: 'THREAD_NOT_FOUND' },
  { name: 'false flag cannot discard observed history', threadStarted: false, delivered: [], observed: ['old-observation'], reason: 'THREAD_NOT_FOUND' },
  { name: 'empty journal but unclassified -32600', delivered: [], observed: [] },
  { name: 'empty journal but different RPC error', delivered: [], observed: [], code: -32602 },
]) {
  test(`missing native thread fails closed without discarding history: ${scenario.name}`, async t => {
    class MissingThread extends MockClient {
      async request(method, params, options = {}) {
        if (method === 'thread/resume') {
          this.calls.push({ method, params: structuredClone(params), options })
          throw Object.assign(new Error(PRIVATE), { code: scenario.code ?? -32600,
            ...(scenario.reason ? { rpcReason: scenario.reason } : {}) })
        }
        return super.request(method, params, options)
      }
    }
    const f = await fixture(t, { createClient: (options, fixture) => new MissingThread(options, fixture) })
    const saved = { version: 1, sessionId: 'session-1', threadId: 'native-history-thread',
      delivered: scenario.delivered, observed: scenario.observed, controls: [], asyncInput: [],
      ...(scenario.threadStarted === undefined ? {} : { threadStarted: scenario.threadStarted }) }
    await fs.mkdir(path.dirname(journalFor(f)), { recursive: true })
    await fs.writeFile(journalFor(f), JSON.stringify(saved))
    f.pre([user('old-user', 'never replay old native history'), user('u2', 'new direct user')])
    const chunks = await bounded(f.collect(), 'missing started/history-bearing thread must terminate')
    assertGrammar(chunks, 'error')
    assert.equal(typeof chunks.at(-1).reason.failure.code, 'string')
    assert.ok(!JSON.stringify(chunks).includes(PRIVATE))
    assert.equal(f.rpc('thread/resume').length, 1)
    assert.equal(f.rpc('thread/start').length, 0, 'never silently reset a started or unproven-missing native thread')
    assert.equal(f.rpc('turn/start').length, 0)
    const after = await journal(f)
    assert.equal(after.threadId, saved.threadId)
    assert.deepEqual(after.delivered, saved.delivered)
    assert.deepEqual(after.observed, saved.observed)
  })
}

const REGRESSION_BINARY = process.env.DSH_CODEX_TEST_BINARY ?? installedBinary

test('compiled native engine: rejected first turn leaves no rollout binding; WebUI retry starts fresh and DSH LlmError accepts failure',
  integrationOptions(REGRESSION_BINARY), async t => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-empty-first-turn-'))
    const requests = [], mockErrors = [], sockets = new Set()
    const server = http.createServer(async (req, res) => {
      try {
        assert.equal(req.method, 'POST', 'non-model egress is rejected by the loopback proxy sink')
        assert.equal(req.url, '/v1/responses')
        assert.equal(req.headers.authorization, undefined, 'authless fixture must never receive credentials')
        const chunks = []
        let size = 0
        for await (const chunk of req) {
          size += chunk.length
          assert.ok(size < 4 * 1024 * 1024)
          chunks.push(chunk)
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        requests.push(body)
        const id = `empty-first-turn-response-${requests.length}`
        const events = [
          { type: 'response.created', response: { id } },
          { type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: 'local-answer',
            content: [{ type: 'output_text', text: 'local fresh retry answer' }] } },
          { type: 'response.completed', response: { id, usage: { input_tokens: 10, output_tokens: 3,
            total_tokens: 13, input_tokens_details: null, output_tokens_details: null } } },
        ]
        res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' })
        for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
        res.end()
      } catch (error) {
        mockErrors.push(error)
        res.writeHead(500, { 'content-type': 'application/json', connection: 'close' })
        res.end(JSON.stringify({ error: { message: 'Local-only regression fixture rejected request' } }))
      }
    })
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
    server.requestTimeout = 5000
    server.headersTimeout = 5000
    let f
    t.after(async () => {
      await f?.bridge.dispose()
      await Promise.all((f?.clients ?? []).map(client => client.close()))
      for (const socket of sockets) socket.destroy()
      server.closeAllConnections()
      if (server.listening) await new Promise(resolve => server.close(resolve))
      await fs.rm(base, { recursive: true, force: true })
    })
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const origin = `http://127.0.0.1:${server.address().port}`
    const home = path.join(base, 'home'), nativeHome = path.join(base, 'preset/native-home')
    await fs.mkdir(path.join(home, 'tmp'), { recursive: true })
    const env = { PATH: `${path.dirname(REGRESSION_BINARY)}:/run/current-system/sw/bin:/usr/bin:/bin`,
      HOME: home, CODEX_HOME: nativeHome, XDG_CONFIG_HOME: path.join(home, '.config'),
      XDG_CACHE_HOME: path.join(home, '.cache'), TMPDIR: path.join(home, 'tmp'),
      USER: 'codex-local-fixture', LOGNAME: 'codex-local-fixture', LANG: 'C.UTF-8', TZ: 'UTC',
      HTTP_PROXY: origin, HTTPS_PROXY: origin, ALL_PROXY: origin,
      http_proxy: origin, https_proxy: origin, all_proxy: origin,
      NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
      DO_NOT_TRACK: '1', OTEL_SDK_DISABLED: 'true' }
    const nativeConfig = {
      'model_providers.mock': { name: 'Local authless regression mock', base_url: `${origin}/v1`,
        wire_api: 'responses', requires_openai_auth: false,
        request_max_retries: 0, stream_max_retries: 0, stream_idle_timeout_ms: 5000 },
      'web_search': 'disabled', 'analytics.enabled': false, 'feedback.enabled': false,
    }
    const dshRoot = process.env.DSH_CODEX_TEST_DSH_ROOT ?? installedDshRoot()
    assert.ok(existsSync(path.join(dshRoot, 'packages/llm/llm/lib/index.js')), 'installed DSH helper is required')
    const llm = await import(pathToFileURL(path.join(dshRoot, 'packages/llm/llm/lib/index.js')).href)
    const rpcCalls = [], threadIds = [], transportErrors = []
    let corruptFirstTurn = true
    f = await fixture(t, { base, config: { executable: REGRESSION_BINARY, authMode: 'native',
      modelProvider: 'mock', nativeConfig }, createClient(options) {
      const client = new CodexAppServer({ ...options, env })
      const request = client.request.bind(client)
      client.request = async (method, params, settings = {}) => {
        rpcCalls.push({ method, params: structuredClone(params) })
        if (method === 'turn/start' && corruptFirstTurn) {
          corruptFirstTurn = false
          try {
            // Real native serde validation rejects this before any model call;
            // this recreates the empty thread/start followed by first-turn RPC
            // rejection, rather than simulating the native lifecycle.
            return await request(method, { ...params, input: [{ type: 'fixture-invalid-native-input' }] },
              { timeoutMs: 6000, ...settings })
          } catch (error) { transportErrors.push(error); throw error }
        }
        const result = await request(method, params, { timeoutMs: 6000, ...settings })
        if (method === 'thread/start') threadIds.push(result.thread.id)
        return result
      }
      return client
    } })
    const message = llm.createUserMessage({ source: { kind: 'user', rpcId: 'compiled-web-rpc-fixture',
      clientTimeZone: 'Asia/Shanghai', unknownMetadata: PRIVATE }, content: [TEXT('local retry instruction')] })
    f.pre([message])
    const failed = await bounded(f.collect(f.options(f.agent, { model: 'gpt-5.5' })), 'real first-turn rejection hung', 8000)
    assertGrammar(failed, 'error')
    assert.equal(transportErrors.length, 1)
    assert.equal(typeof transportErrors[0].code, 'number', 'RPC error stays numeric inside transport')
    const failure = failed.at(-1).reason.failure
    assert.equal(typeof failure.code, 'string')
    assert.doesNotThrow(() => new llm.LlmError(failure.message, failure.code))
    assert.equal(f.calls.auth.length, 0)
    assert.equal(requests.length, 0, 'invalid first turn must not call the model')
    await assert.rejects(fs.stat(journalFor(f)), { code: 'ENOENT' })
    assert.equal(threadIds.length, 1)
    // A DIFFERENT app-server process cannot resume that thread: its rollout
    // never existed. Verify the exact real wire reason, still without model I/O.
    const probe = new CodexAppServer({ command: REGRESSION_BINARY, env, cwd: f.cwd })
    try {
      await probe.start()
      await assert.rejects(probe.request('thread/resume', { threadId: threadIds[0], model: 'gpt-5.5',
        modelProvider: 'mock', config: nativeConfig, cwd: f.cwd, approvalPolicy: 'never', sandbox: 'workspace-write' },
      { timeoutMs: 6000 }), error => error.code === -32600 && error.rpcReason === 'THREAD_NOT_FOUND' && !error.data)
    } finally { await probe.close() }
    f.pre([message])
    const retry = await bounded(f.collect(f.options(f.agent, { model: 'gpt-5.5' })), 'real fresh retry hung', 8000)
    assertGrammar(retry)
    assert.equal(retry.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''), 'local fresh retry answer')
    assert.equal(rpcCalls.filter(call => call.method === 'thread/resume').length, 0, 'bridge must not attempt orphan resume')
    assert.equal(threadIds.length, 2)
    assert.notEqual(threadIds[0], threadIds[1])
    const saved = await journal(f)
    assert.equal(saved.threadId, threadIds[1])
    assert.equal(saved.threadStarted, true)
    assert.deepEqual(saved.delivered, [message.id])
    assert.equal(requests.length, 1)
    assert.equal(mockErrors.length, 0, mockErrors[0]?.stack)
    for (const body of requests) {
      const wire = JSON.stringify(body)
      // Native Codex legitimately discovers the host's Asia/Shanghai timezone
      // independently of TZ. Assert transport keys/IDs/private metadata do not
      // cross the bridge, not absence of an incidental legitimate env value.
      for (const forbidden of [PRIVATE, 'compiled-web-rpc-fixture', 'clientTimeZone', 'unknownMetadata']) {
        assert.ok(!wire.includes(forbidden), `WebUI source metadata reached the actual model request: ${forbidden}`)
      }
    }
  })

test('unknown, unowned standard and ordinary one-shot/other auxiliary requests delegate exactly once untouched', async t => {
  const f = await fixture(t)
  f.pre([user('u1', 'hello')])
  await f.request(freeze({ provider: NATIVE_PROVIDER, model: 'gpt-5.4' }))
  const standard = f.makeAgent('standard-session')
  f.deactivateScope(standard)
  const aux = freeze({ sessionId: 'session-1', provider: NATIVE_PROVIDER, model: 'gpt-5.4', messages: contaminants(), tools: [{ name: 'standard-tool' }] })
  const cases = [f.options(f.agent, { sessionId: 'unknown-session' }), f.options(standard, { provider: 'standard' }), aux,
    freeze({ ...aux, purpose: 'plugin-summary' }),
    freeze({ ...aux, sessionId: 'unknown-session', purpose: 'session-title' }),
    freeze({ ...aux, sessionId: 'unknown-session', purpose: 'compaction' }),
    freeze({ ...aux, provider: 'standard', purpose: 'session-title' }),
    freeze({ ...aux, provider: 'standard', purpose: 'compaction' }),
  ]
  for (const options of cases) {
    const before = structuredClone(options)
    const response = { identity: 'same downstream object' }
    let count = 0
    assert.equal(f.ctx.run('llm/stream', [options], () => { count++; return response }), response,
      `${options.sessionId}/${options.provider}/${options.purpose ?? 'unmarked request'} must delegate unchanged`)
    assert.equal(count, 1)
    assert.deepEqual(structuredClone(options), before)
  }
  assert.equal(f.clients.length, 0)
  assert.equal(f.calls.auth.length, 0)
})

test('original provider/model survive native request headers and same-agent preset deactivation', async t => {
  const f = await fixture(t, { provider: 'original-provider' })
  const proposed = freeze({ provider: 'original-provider', model: 'gpt-5.4', reasoningEffort: 'low', maxTokens: 8192 })
  f.pre([user('u1', 'native on the original route')])
  const result = await f.request(proposed)
  assert.deepEqual(result, proposed)
  // Emulate DSH buildRequest's durable header using the waterfall result.
  f.agent.session.append('request/header', { header: { config: result }, reason: 'initial' })
  const options = f.options(f.agent, proposed)
  assertGrammar(await f.collect(options))
  const marker = f.tools.get('codex_native_observer')
  assert.ok(marker, 'register an inert preset-scoped tool sentinel, not a native provider')
  assert.ok(f.calls.toolGets.some(call => call.name === 'codex_native_observer' && call.agent === f.agent),
    'ownership must query the exact scoped agent, not the global tool name')
  assert.equal(f.ctx.tools.get('codex_native_observer', f.agent), marker)
  const headers = () => f.agent.session.events.filter(event => event.type === 'request/header')
  assert.deepEqual(headers()[0].data.header.config, proposed)
  const beforeEvents = structuredClone(f.agent.session.events)
  const beforeRpc = f.clients.flatMap(client => client.calls).length
  const beforeAuth = f.calls.auth.length
  f.deactivateScope(f.agent) // same Agent and Session; only the preset scope changed
  assert.equal(f.ctx.tools.get('codex_native_observer', f.agent), undefined)
  assert.deepEqual(f.calls.scopeDeactivations, [f.agent])
  const standard = freeze({ ...proposed, reasoningEffort: 'medium' })
  let requests = 0
  const afterSwitch = await f.ctx.run('agent/request', [{ agent: f.agent, turn: 2, step: 0 }], () => { requests++; return standard })
  assert.equal(requests, 1)
  assert.deepEqual(afterSwitch, standard, 'a stale bridge cannot poison the standard persisted route')
  for (const request of [f.options(f.agent, standard), freeze({ ...options, purpose: 'session-title' })]) {
    const before = structuredClone(request)
    const response = { identity: 'same standard downstream response' }
    let count = 0
    assert.equal(f.ctx.run('llm/stream', [request], () => { count++; return response }), response,
      'SAME session and original provider must delegate when its scoped sentinel disappears')
    assert.equal(count, 1)
    assert.deepEqual(structuredClone(request), before)
  }
  assert.deepEqual(f.agent.session.events, beforeEvents)
  assert.equal(f.clients.flatMap(client => client.calls).length, beforeRpc)
  assert.equal(f.calls.auth.length, beforeAuth)
})

test('same-name foreign observer is not the exact registered native ownership sentinel', async t => {
  const f = await fixture(t, { provider: 'original-provider' })
  f.pre([user('u1', 'native')])
  await f.request(freeze({ provider: 'original-provider', model: 'gpt-5.4' }))
  assertGrammar(await f.collect())
  const registeredMarker = f.tools.get('codex_native_observer')
  assert.ok(registeredMarker)
  const replacement = { ...registeredMarker }
  f.overrideScopedTool(f.agent, 'codex_native_observer', replacement)
  assert.notEqual(f.ctx.tools.get('codex_native_observer', f.agent), registeredMarker)
  assert.equal(f.ctx.tools.get('codex_native_observer', f.agent), replacement)
  const options = f.options()
  const before = structuredClone(options)
  const response = { identity: 'foreign preset response' }
  let count = 0
  assert.equal(f.ctx.run('llm/stream', [options], () => { count++; return response }), response)
  assert.equal(count, 1, 'checking mere sentinel existence or name would steal a foreign preset request')
  assert.deepEqual(structuredClone(options), before)
  assert.equal(f.rpc('turn/start').length, 1)
})

test('native effort is the explicit pre-prepareCall proposal, never a DSH adapter default', async t => {
  const f = await fixture(t, { provider: 'original-provider' })
  await f.command('codex-mode', 'plan')
  const cases = [
    { proposal: { provider: 'original-provider', model: 'gpt-5.4' }, effort: undefined },
    { proposal: { provider: 'original-provider', model: 'gpt-5.5', reasoningEffort: 'low' }, effort: 'low' },
    { proposal: { provider: 'original-provider', model: 'gpt-5.5' }, effort: undefined },
  ]
  for (const [index, { proposal, effort }] of cases.entries()) {
    const requested = freeze(proposal)
    f.pre([user(`u${index + 1}`, `effort turn ${index + 1}`)], f.agent, { turn: index + 1, step: 0 })
    assert.deepEqual(await f.request(requested, f.agent, { turn: index + 1, step: 0 }), requested)
    // Offline prepareCall stand-in: the registered adapter has a different
    // effective effort. Official Codex must receive the user's proposal only.
    const prepared = f.options(f.agent, { ...requested, reasoningEffort: 'high' })
    const before = structuredClone(prepared)
    assertGrammar(await f.collect(prepared))
    assert.deepEqual(structuredClone(prepared), before)
    const turn = f.rpc('turn/start')[index].params
    assert.equal(turn.model, requested.model)
    if (effort === undefined) assert.ok(!Object.hasOwn(turn, 'effort'), 'leave effort selection to official Codex, including after an explicit previous effort')
    else assert.equal(turn.effort, effort)
    assert.deepEqual(turn.collaborationMode.settings, { model: requested.model, reasoning_effort: effort ?? null, developer_instructions: null })
  }
  assert.equal(f.clients.length, 1, 'model/effort selection must not reset native history')
})

test('owned original-provider session-title auxiliary is deterministic without a provider/native turn', async t => {
  const f = await fixture(t, { provider: 'original-provider' })
  const first = user('u1', 'A short native title')
  f.agent.session.append('user/message', { turn: 1, step: 0, message: first })
  f.pre([first, user('u2', 'A later instruction must not replace the first title')])
  await f.request(freeze({ provider: 'original-provider', model: 'gpt-5.4' }))
  const options = freeze({ sessionId: 'session-1', provider: 'original-provider', model: 'gpt-5.4', purpose: 'session-title',
    messages: [...contaminants(), first], systemPrompt: PRIVATE, tools: [{ name: PRIVATE }] })
  let count = 0
  const before = structuredClone(options)
  const source = f.ctx.run('llm/stream', [options], () => { count++; assert.fail('owned native title must be served locally without a model request') })
  const chunks = []
  for await (const chunk of source) chunks.push(chunk)
  assertGrammar(chunks)
  assert.equal(chunks.filter(c => c.type === 'text-delta').map(c => c.text).join(''), 'A short native title')
  assert.deepEqual(structuredClone(options), before)
  assert.equal(count, 0)
  assert.equal(f.clients.length, 0)
  assert.equal(f.calls.auth.length, 0)
})

test('owned original-route compaction cannot call DSH summarizer; other auxiliaries remain untouched', async t => {
  const f = await fixture(t, { provider: 'original-provider' })
  f.pre([user('u1', 'native context')])
  await f.request(freeze({ provider: 'original-provider', model: 'gpt-5.4' }))
  const beforeEvents = structuredClone(f.agent.session.events)
  const options = freeze({ sessionId: 'session-1', provider: 'original-provider', purpose: 'compaction',
    messages: contaminants(), model: 'gpt-5.4' })
  const before = structuredClone(options)
  let count = 0
  const chunks = []
  for await (const chunk of f.ctx.run('llm/stream', [options], () => { count++; throw new Error('DSH summary must never dispatch') })) chunks.push(chunk)
  assert.equal(count, 0)
  assert.equal(chunks.at(-1).reason.kind, 'error')
  assert.equal(chunks.at(-1).reason.failure.code, 'NATIVE_COMPACTION_ONLY')
  assert.match(chunks.at(-1).reason.failure.message, /codex-compact/)
  assert.deepEqual(structuredClone(options), before)
  const ordinary = freeze({ ...options, purpose: 'plugin-summary' })
  const response = { identity: 'unchanged auxiliary response' }
  assert.equal(f.ctx.run('llm/stream', [ordinary], () => { count++; return response }), response)
  assert.equal(count, 1)
  assert.deepEqual(f.agent.session.events, beforeEvents)
  assert.equal(f.clients.length, 0)
  assert.equal(f.calls.auth.length, 0)
})

test('one native turn, no DSH execution, and no DSH prompt/context/tool/result forwarding', async t => {
  const f = await fixture(t)
  const message = user('u1', 'only this instruction')
  f.pre([...contaminants(), message])
  const assembled = freeze({ messages: contaminants(), tools: [{ name: 'dsh_tool', description: PRIVATE }] })
  let assembledCalls = 0
  const prompt = await f.ctx.run('system-prompt/assemble', [{}, {}], () => { assembledCalls++; return assembled })
  assert.equal(assembledCalls, 1)
  assert.deepEqual(prompt.tools, [])
  const proposed = freeze({ provider: 'original-provider', model: 'gpt-5.4', reasoningEffort: 'high', maxTokens: 4096 })
  const result = await f.request(proposed)
  assert.deepEqual(result, proposed, 'agent/request must never replace the persisted provider/model route')
  assert.equal(result.provider, 'original-provider')
  assert.equal(result.model, 'gpt-5.4')
  assertGrammar(await f.collect())
  assert.equal(f.rpc('turn/start').length, 1)
  assert.equal(f.rpc('thread/start').length, 1)
  assert.equal(f.calls.execute, 0)
  const allParams = JSON.stringify(f.clients.flatMap(client => client.calls.map(call => call.params)))
  assert.ok(!allParams.includes(PRIVATE), 'the UI transcript, schemas and harness context must stay outside native history')
  const start = f.rpc('thread/start')[0].params
  for (const forbidden of ['baseInstructions', 'developerInstructions', 'dynamicTools', 'history', 'messages', 'tools']) {
    assert.ok(!Object.hasOwn(start, forbidden), `thread/start leaked ${forbidden}`)
  }
  assert.equal(f.clients[0].initialization.capabilities.experimentalApi, true)
  assert.deepEqual(f.clients[0].initialization.clientInfo, { name: 'codex_cli_rs', version: OFFICIAL_RUNTIME_VERSION })
  assert.notEqual(OFFICIAL_RUNTIME_VERSION, '0.0.0', 'Source provenance does not replace a backend-compatible release version')
  assert.equal(f.pre([message]).kind, 'reject', 'already delivered user identity must not run a duplicate turn')
})

test('human-only standard-like tool pairs have JSON string arguments and result link sequence', async t => {
  const pending = { type: 'commandExecution', id: 'cmd:with:colons', command: 'printf offline', cwd: '/offline',
    processId: null, status: 'inProgress', commandActions: [{ type: 'unknown', command: 'printf offline' }],
    aggregatedOutput: '', exitCode: null, durationMs: null }
  const done = { ...pending, status: 'completed', aggregatedOutput: 'offline\n', exitCode: 0, durationMs: 3 }
  const f = await fixture(t, { onTurn(client, turnId) {
    const params = { threadId: client.threadId, turnId }
    client.notify('item/started', { ...params, item: pending })
    client.notify('item/completed', { ...params, item: done })
    client.notify('item/completed', { ...params, item: done }) // duplicate native notification
    complete(client, turnId)
  } })
  f.pre([user('u1', 'run it')], f.agent, { turn: 7, step: 2 })
  assertGrammar(await f.collect())
  const calls = f.agent.session.events.filter(event => event.type === 'tool/call')
  const results = f.agent.session.events.filter(event => event.type === 'tool/result')
  assert.equal(calls.length, 1)
  assert.equal(results.length, 1)
  assert.equal(calls[0].data.name, 'bash', 'native commands use the actual standard DSH presentation alias')
  assert.equal(typeof calls[0].data.arguments, 'string', 'DSH tool/call.arguments is serialized JSON, not an object')
  assert.deepEqual(JSON.parse(calls[0].data.arguments).item, pending)
  assert.equal(calls[0].data.turn, 7)
  assert.equal(calls[0].data.step, 2)
  assert.equal(results[0].data.message.toolCallId, calls[0].data.callId)
  assert.deepEqual(results[0].sourceEventSeqs, [calls[0].seq])
  assert.equal(results[0].surfaceOp, 'append')
  assert.equal(results[0].data.message.isError, false)
  assert.deepEqual(results[0].data.meta.item, done)
  assertObservationAdvertisements(f.agent.session.events)
  const nativeWire = JSON.stringify(f.clients.flatMap(client => client.calls.map(call => call.params)))
  assert.ok(!nativeWire.includes('native-observation'), 'UI provenance never enters native history')
  assert.ok(!nativeWire.includes(calls[0].data.callId), 'UI advertisement IDs never enter native RPC')
  const tool = f.tools.get('bash')
  assert.ok(tool.presentCall(JSON.parse(calls[0].data.arguments)))
  assert.ok(tool.presentResult(JSON.parse(calls[0].data.arguments), results[0].data))
  assert.throws(() => tool.execute(), /Native Codex owns/)
  assert.equal(f.calls.execute, 0)
})

test('stream closes text/reasoning blocks and counts uncached input separately from cached input', async t => {
  const f = await fixture(t, { onTurn(client, turnId) {
    const p = { threadId: client.threadId, turnId }
    client.notify('item/reasoning/summaryTextDelta', { ...p, itemId: 'r1', delta: 'think' })
    client.notify('item/agentMessage/delta', { ...p, itemId: 'a1', delta: 'hel' })
    client.notify('item/completed', { ...p, item: { type: 'reasoning', id: 'r1', summary: ['thinking'], content: [] } })
    client.notify('item/completed', { ...p, item: { type: 'agentMessage', id: 'a1', text: 'hello' } })
    client.notify('item/agentMessage/delta', { ...p, itemId: 'a1', delta: 'late duplicate must be ignored' })
    client.notify('item/completed', { ...p, item: { type: 'agentMessage', id: 'a2', text: 'second answer' } })
    client.notify('thread/tokenUsage/updated', { ...p, tokenUsage: {
      last: { inputTokens: 100, cachedInputTokens: 25, outputTokens: 10, totalTokens: 110 },
      total: { inputTokens: 100, cachedInputTokens: 25, outputTokens: 10, totalTokens: 110 },
    } })
    client.notify('thread/tokenUsage/updated', { ...p, tokenUsage: {
      last: { inputTokens: 240, cachedInputTokens: 180, outputTokens: 20, reasoningOutputTokens: 4, totalTokens: 260 },
      total: { inputTokens: 340, cachedInputTokens: 205, outputTokens: 30, reasoningOutputTokens: 4, totalTokens: 370 },
    } })
    client.notify('turn/completed', { ...p, turn: { id: turnId, status: 'completed', error: null } })
  } })
  f.pre([user('u1', 'stream')])
  const chunks = await f.collect()
  assertGrammar(chunks)
  assert.deepEqual(chunks.filter(c => c.type === 'block-end').map(c => c.block), [
    { type: 'reasoning', text: 'thinking' }, { type: 'text', text: 'hello' }, { type: 'text', text: 'second answer' },
  ])
  assert.deepEqual(chunks.find(c => c.type === 'usage').usage, { inputTokens: 135, cacheReadTokens: 205, outputTokens: 30, totalTokens: 370 },
    'DSH wraps the whole native turn, not only its last model request')
})

test('read-only turn/start follows official Rust sandbox fields, not legacy readOnly.access', async t => {
  const f = await fixture(t, { sandbox: 'read-only' })
  f.pre([user('u1', 'inspect')])
  assertGrammar(await f.collect())
  const params = f.rpc('turn/start')[0].params
  assert.equal(f.rpc('thread/start')[0].params.sandbox, 'read-only')
  assert.equal(params.approvalPolicy, 'on-request')
  assert.equal(params.sandboxPolicy.type, 'readOnly')
  // Rust's canonical serialized ReadOnly variant includes networkAccess;
  // #[serde(default)] is deserialization tolerance, not a different field name.
  assert.equal(params.sandboxPolicy.networkAccess, false)
  assert.ok(Object.keys(params.sandboxPolicy).every(key => ['type', 'networkAccess'].includes(key)))
  assert.equal(params.cwd, f.cwd)
  assert.equal(params.model, 'gpt-5.4')
  assert.equal(params.effort, 'high')
  assert.deepEqual(params.input, [inputText('inspect')])
  const allowed = ['threadId', 'input', 'cwd', 'approvalPolicy', 'sandboxPolicy', 'model', 'effort', 'collaborationMode']
  assert.ok(Object.keys(params).every(key => allowed.includes(key)), 'only deliberately mapped native options may enter turn/start')
})

test('same session resumes its mapped native thread and delivered IDs, never replays DSH history', async t => {
  const f = await fixture(t)
  const first = user('u1', 'first native instruction')
  f.pre([first])
  assertGrammar(await f.collect())
  const saved = await journal(f)
  assert.equal(saved.sessionId, 'session-1')
  assert.deepEqual(saved.delivered, ['u1'])
  assert.equal(saved.threadId, f.clients[0].threadId)
  assert.equal((await fs.stat(journalFor(f))).mode & 0o777, 0o600)
  await f.bridge.dispose()
  const resumed = await fixture(t, { base: f.base, events: [
    { seq: 1, type: 'assistant/message', data: { message: { content: [TEXT(PRIVATE)] } } },
    { seq: 2, type: 'tool/call', data: { arguments: PRIVATE } },
    { seq: 3, type: 'compaction/checkpoint', data: { summary: PRIVATE } },
  ] })
  const second = user('u2', 'second native instruction')
  resumed.pre([first, ...contaminants(), second])
  assertGrammar(await resumed.collect())
  assert.equal(resumed.rpc('thread/start').length, 0)
  assert.equal(resumed.rpc('thread/resume').length, 1)
  const params = resumed.rpc('thread/resume')[0].params
  assert.equal(params.threadId, saved.threadId)
  assert.equal(params.excludeTurns, true)
  assert.ok(!JSON.stringify(params).includes(PRIVATE))
  assert.ok(!Object.hasOwn(params, 'history'))
  assert.deepEqual(resumed.rpc('turn/start')[0].params.input, [inputText('second native instruction')])
  assert.deepEqual((await journal(resumed)).delivered, ['u1', 'u2'])
})

test('distinct agents own isolated clients, thread IDs, admissions, commands and journals', async t => {
  const f = await fixture(t)
  const other = f.makeAgent('agent-2')
  assert.equal((await f.command('codex-mode', 'plan', other)).kind, 'success')
  f.pre([user('same-user-id', 'agent one')])
  f.pre([user('same-user-id', 'agent two')], other)
  const [one, two] = await Promise.all([f.collect(), f.collect(f.options(other))])
  assertGrammar(one)
  assertGrammar(two)
  assert.equal(f.clients.length, 2)
  const a = await journal(f)
  const b = await journal(f, 'agent-2')
  assert.notEqual(a.threadId, b.threadId)
  assert.equal(a.mode, null)
  assert.equal(b.mode, 'plan')
  assert.deepEqual(a.delivered, ['same-user-id'])
  assert.deepEqual(b.delivered, ['same-user-id'])
  assert.deepEqual(f.rpc('turn/start').map(c => c.params.input[0].text).sort(), ['agent one', 'agent two'])
  assert.equal(f.bridge.states.size, 2)
})

test('foreign thread notifications cannot create tool mirrors or contaminate this agent', async t => {
  const f = await fixture(t, { onTurn(client, turnId) {
    const foreign = { threadId: 'unrelated-native-thread', turnId: 'unrelated-turn', item: {
      type: 'commandExecution', id: 'foreign-command', command: PRIVATE, status: 'completed', aggregatedOutput: PRIVATE,
    } }
    client.notify('item/completed', foreign)
    client.notify('item/agentMessage/delta', { threadId: foreign.threadId, turnId: foreign.turnId, itemId: 'foreign-answer', delta: PRIVATE })
    complete(client, turnId)
  } })
  f.pre([user('u1', 'isolate')])
  const chunks = await f.collect()
  assertGrammar(chunks)
  assert.ok(!JSON.stringify(chunks).includes(PRIVATE))
  assert.equal(f.agent.session.events.filter(e => e.type === 'tool/call' || e.type === 'tool/result').length, 0,
    'ignore mismatched threadId before observe(); otherwise another native thread leaks into this session')
})

test('agent disposal removes only owned state; bridge disposal closes all clients and unregisters hooks', async t => {
  const f = await fixture(t)
  const other = f.makeAgent('agent-2')
  f.pre([user('u1', 'one')])
  f.pre([user('u2', 'two')], other)
  await Promise.all([f.collect(), f.collect(f.options(other))])
  const disposedClient = f.bridge.states.get('session-1').client
  const retainedClient = f.bridge.states.get('agent-2').client
  assert.notEqual(disposedClient, retainedClient)
  f.ctx.run('agent/disposed', [{ agent: f.agent }])
  await tick()
  assert.equal(f.bridge.states.has('session-1'), false)
  assert.equal(f.bridge.states.has('agent-2'), true)
  assert.equal(disposedClient.isClosed, true)
  assert.equal(retainedClient.isClosed, false)
  await f.bridge.dispose()
  assert.equal(f.bridge.states.size, 0)
  assert.ok(f.clients.every(client => client.isClosed))
  assert.ok([...f.handlers.values()].every(list => list.length === 0))
  let count = 0
  const passthrough = {}
  assert.equal(f.ctx.run('llm/stream', [f.options()], () => { count++; return passthrough }), passthrough)
  assert.equal(count, 1)
  await f.bridge.dispose() // idempotent
})

test('cancellation interrupts native, settles pending tool pairs and closes partial blocks', async t => {
  const controller = new AbortController()
  const ready = deferred()
  const f = await fixture(t, { autoComplete: false, onTurn(client, turnId) {
    client.notify('item/started', { threadId: client.threadId, turnId, item: {
      type: 'commandExecution', id: 'pending:colon:id', command: 'offline long command', status: 'inProgress', aggregatedOutput: '',
    } })
    client.notify('item/agentMessage/delta', { threadId: client.threadId, turnId, itemId: 'partial', delta: 'partial response' })
  } })
  t.after(() => controller.abort())
  f.pre([user('u1', 'cancel me')])
  const chunks = []
  const work = (async () => { for await (const chunk of f.stream(f.options(f.agent, { signal: controller.signal }))) {
    chunks.push(chunk)
    if (chunk.type === 'text-delta') ready.resolve()
  } })()
  await bounded(ready.promise, 'fixture did not receive partial native output')
  controller.abort(new Error('synthetic cancellation'))
  await bounded(work, 'abort must wake the notification pump and finish promptly')
  assertGrammar(chunks, 'aborted')
  assert.equal(f.rpc('turn/interrupt').length, 1)
  const interrupt = f.rpc('turn/interrupt')[0].params
  assert.equal(interrupt.threadId, f.clients[0].threadId)
  assert.equal(interrupt.turnId, f.clients[0].turnId)
  assert.equal(f.clients[0].isClosed, true)
  assert.equal(f.agent.session.events.filter(e => e.type === 'tool/call').length, 1,
    'settlePending must retain the original thread identity, not split colon-containing item IDs into a duplicate call')
  const result = f.agent.session.events.find(e => e.type === 'tool/result')
  assert.ok(result, 'settlePending must use the stored thread ID, not parse a colon-containing item ID')
  assert.equal(result.data.message.isError, true)
  assert.deepEqual(result.sourceEventSeqs, [f.agent.session.events.find(e => e.type === 'tool/call').seq])
})

test('inbox steering admits only new direct user messages into the existing native turn', async t => {
  const ready = deferred()
  const f = await fixture(t, { autoComplete: false, onTurn(client, turnId) {
    client.notify('item/agentMessage/delta', { threadId: client.threadId, turnId, itemId: 'answer', delta: 'working' })
  } })
  const controller = new AbortController()
  t.after(() => controller.abort())
  const first = user('u1', 'initial')
  const second = user('u2', 'direct steering')
  f.pre([first])
  const work = (async () => { const chunks = []; for await (const chunk of f.stream(f.options(f.agent, { signal: controller.signal }))) {
    chunks.push(chunk)
    if (chunk.type === 'text-delta') ready.resolve()
  } return chunks })()
  await bounded(ready.promise, 'native turn never reached its partial output')
  f.ctx.run('session/event', [f.agent.session, { type: 'agent/inbox/spliced', data: {
    inserted: [first, ...contaminants(), second],
  } }])
  await f.bridge.states.get('session-1').steerTail
  assert.equal(f.rpc('turn/start').length, 1)
  assert.equal(f.rpc('turn/steer').length, 1)
  assert.deepEqual(f.rpc('turn/steer')[0].params, { threadId: f.clients[0].threadId,
    expectedTurnId: f.clients[0].turnId, input: [inputText('direct steering')] })
  complete(f.clients[0])
  assertGrammar(await bounded(work, 'steering must not orphan the running turn'))
  assert.deepEqual((await journal(f)).delivered, ['u1', 'u2'])
  assert.equal(f.calls.execute, 0)
})

test('official compaction must complete before the next admitted user turn starts', async t => {
  const f = await fixture(t)
  const first = user('u1', 'before compaction')
  const second = user('u2', 'after compaction')
  f.pre([first])
  assertGrammar(await f.collect())
  const originalThread = f.clients[0].threadId
  const originalTurn = f.clients[0].turnId
  const visibleBefore = structuredClone(f.agent.session.events)
  assert.equal((await f.command('codex-compact')).kind, 'success')
  assert.equal(f.rpc('thread/compact/start').length, 0, 'the command queues work; it is not a DSH summary or a hidden native turn')
  const control = f.calls.injected.at(-1)
  assert.ok(control, 'queued compaction must wake an otherwise idle agent')
  assert.equal(f.pre([first, control, ...contaminants(), second], f.agent, { turn: 2, step: 0 }).kind, 'enter')
  const controller = new AbortController()
  t.after(() => controller.abort())
  const work = f.collect(f.options(f.agent, { signal: controller.signal }))
  try {
    const { client, turnId } = await bounded(f.compactStarted.promise, 'official compaction was never requested')
    assert.equal(client.threadId, originalThread)
    assert.deepEqual(f.rpc('thread/compact/start')[0].params, { threadId: originalThread })
    assert.equal(f.rpc('turn/start').length, 1, 'new user input must wait for the official compaction turn')
    assert.deepEqual((await journal(f)).delivered, ['u1'])
    client.notify('turn/completed', { threadId: originalThread, turn: { id: originalTurn, status: 'completed', error: null } })
    client.notify('thread/compacted', { threadId: originalThread, turnId })
    await tick()
    assert.equal(f.rpc('turn/start').length, 1, 'a stale completion or thread/compacted alone is not completion of the compaction turn')
    client.notify('turn/completed', { threadId: originalThread, turn: { id: turnId, status: 'completed', error: null } })
    assertGrammar(await bounded(work, 'the admitted user turn must start after compaction completes'))
    assert.equal(f.rpc('turn/start').length, 2)
    assert.deepEqual(f.rpc('turn/start')[1].params.input, [inputText('after compaction')])
    assert.equal(f.rpc('turn/start')[1].params.threadId, originalThread)
    assert.deepEqual(client.calls.filter(call => ['thread/compact/start', 'turn/start'].includes(call.method)).map(call => call.method),
      ['turn/start', 'thread/compact/start', 'turn/start'])
    assert.deepEqual((await journal(f)).delivered, ['u1', 'u2'])
    assert.deepEqual(f.agent.session.events, visibleBefore, 'official compaction never prunes the UI transcript or adds a DSH checkpoint')
    assert.equal(f.clients.length, 1)
    assert.equal(f.calls.execute, 0)
  } finally {
    controller.abort()
    await work.catch(() => {})
  }
})

test('callback-only /codex-compact performs official compaction without an empty user turn', async t => {
  const f = await fixture(t)
  const first = user('u1', 'compact an idle session')
  f.pre([first])
  assertGrammar(await f.collect())
  const visibleBefore = structuredClone(f.agent.session.events)
  assert.equal((await f.command('codex-compact')).kind, 'success')
  const control = f.calls.injected.at(-1)
  assert.ok(control)
  assert.equal(f.pre([first, control, ...contaminants()], f.agent, { turn: 2, step: 0 }).kind, 'enter')
  const controller = new AbortController()
  t.after(() => controller.abort())
  const work = f.collect(f.options(f.agent, { signal: controller.signal }))
  try {
    const { client, turnId } = await bounded(f.compactStarted.promise, 'callback-only compaction never reached the native core')
    assert.equal(f.rpc('turn/start').length, 1)
    client.notify('thread/compacted', { threadId: client.threadId, turnId })
    client.notify('turn/completed', { threadId: client.threadId, turn: { id: turnId, status: 'completed', error: null } })
    const chunks = await bounded(work, 'callback-only compaction must settle on its own native completion')
    assertGrammar(chunks)
    assert.ok(chunks.every(chunk => chunk.type !== 'text-delta'), 'no DSH compaction summary may become native/user input')
    assert.equal(f.rpc('thread/compact/start').length, 1)
    assert.equal(f.rpc('turn/start').length, 1, 'control wakeups must never produce turn/start with empty or synthetic input')
    assert.deepEqual((await journal(f)).delivered, ['u1'])
    assert.deepEqual(f.agent.session.events, visibleBefore)
    assert.equal(f.pre([first, control]).kind, 'reject', 'completed compaction cannot leave a callback-only loop spinning')
    assert.equal(f.calls.execute, 0)
  } finally {
    controller.abort()
    await work.catch(() => {})
  }
})

const asyncQuestionItem = () => ({ type: 'agentMessage', id: 'async-question-1', text: 'Waiting for your choices',
  phase: 'commentary', memoryCitation: null, delivery: 'async', questions: [
    { title: 'Which environment?', options: ['Staging', 'Production'] }, { title: 'Any notes?', options: null },
  ] })
const asyncQuestionIds = () => [0, 1].map(index => JSON.stringify(['request_user_input_async', 'async-question-1', index]))
const asyncAnswer = () => ({ answers: [
  { id: asyncQuestionIds()[0], selected: ['Staging'] }, { id: asyncQuestionIds()[1], selected: [], custom: 'Only offline tests' },
] })
const asyncReplyInput = () => [inputText(`<send_user_message_question_reply>\n${JSON.stringify([
  { questionItemId: asyncQuestionIds()[0], question: 'Which environment?', answer: 'Staging' },
  { questionItemId: asyncQuestionIds()[1], question: 'Any notes?', answer: 'Only offline tests' },
])}\n</send_user_message_question_reply>`)]

for (const timing of ['active-turn', 'after-completion']) {
  test(`async agentMessage.questions replies through native ${timing === 'active-turn' ? 'turn/steer' : 'queued next turn'}`, async t => {
    const asked = deferred()
    const answer = deferred()
    const partial = deferred()
    const questionCalls = []
    const f = await fixture(t, { autoComplete: false,
      services: { userQuestions: { ask(request) { questionCalls.push(request); asked.resolve(request); return answer.promise } } },
      onTurn(client, turnId, params) {
        if (params.input[0]?.text !== 'initial question turn') return complete(client, turnId)
        const p = { threadId: client.threadId, turnId, completedAtMs: 1700000000000, item: asyncQuestionItem() }
        client.notify('item/completed', p)
        client.notify('item/completed', p) // must not ask or reply twice
      },
    })
    const first = user('u1', 'initial question turn')
    f.pre([first])
    const controller = new AbortController()
    t.after(() => controller.abort())
    const work = (async () => {
      const chunks = []
      for await (const chunk of f.stream(f.options(f.agent, { signal: controller.signal }))) {
        chunks.push(chunk)
        if (chunk.type === 'text-delta' && chunk.text === 'still working') partial.resolve()
      }
      return chunks
    })()
    try {
      const request = await bounded(asked.promise,
        'Bridge BUG: handleNativeAsyncQuestions expects params.item; passing top-level item silently drops every async question')
      assert.equal(request.agent, f.agent)
      assert.deepEqual(request.questions, [
        { id: asyncQuestionIds()[0], question: 'Which environment?', multiSelect: false, options: [{ label: 'Staging' }, { label: 'Production' }] },
        { id: asyncQuestionIds()[1], question: 'Any notes?', multiSelect: false },
      ])
      const client = f.clients[0]
      const originalTurn = client.turnId
      client.notify('item/agentMessage/delta', { threadId: client.threadId, turnId: originalTurn, itemId: 'ongoing-answer', delta: 'still working' })
      await bounded(partial.promise, 'an unanswered async question must not block the native notification pump')
      if (timing === 'active-turn') {
        answer.resolve(asyncAnswer())
        await bounded(f.steerStarted.promise, 'an async answer must steer the still-active native turn')
        assert.equal(f.rpc('turn/start').length, 1)
        assert.deepEqual(f.rpc('turn/steer').map(call => call.params), [{
          threadId: client.threadId, expectedTurnId: originalTurn, input: asyncReplyInput(),
        }])
        complete(client, originalTurn)
        assertGrammar(await bounded(work, 'the steered native turn failed to settle'))
        assert.equal(f.calls.injected.length, 0, 'an active-turn answer must not also queue a new turn')
      } else {
        complete(client, originalTurn)
        assertGrammar(await bounded(work, 'native completion must not wait for an async UI answer'))
        answer.resolve(asyncAnswer())
        const control = await bounded(f.backgroundInjected.promise, 'an answer after completion must queue input and wake the next native turn')
        assert.equal(f.rpc('turn/steer').length, 0, 'never steer a completed native turn')
        assert.equal(f.pre([first, control, ...contaminants()], f.agent, { turn: 2, step: 0 }).kind, 'enter')
        assertGrammar(await bounded(f.collect(), 'queued async answer must enter a native turn without a new direct user message'))
        assert.equal(f.rpc('turn/start').length, 2)
        assert.deepEqual(f.rpc('turn/start')[1].params.input, asyncReplyInput(), 'only the official reply envelope enters history, not the DSH wakeup/context')
        assert.equal(f.rpc('turn/start')[1].params.threadId, client.threadId)
        assert.equal(f.pre([first, control]).kind, 'reject', 'queued answers are delivered exactly once')
      }
      assert.equal(questionCalls.length, 1, 'duplicate item/completed cannot repeat the asynchronous question')
      assert.equal(f.agent.session.events.filter(event => ['tool/call', 'tool/result'].includes(event.type)).length, 0,
        'async questions are native user replies, not DSH tool executions/results')
      assert.deepEqual((await journal(f)).delivered, ['u1'])
      assert.equal(f.calls.execute, 0)
    } finally {
      answer.resolve({ answers: [] })
      controller.abort()
      await work.catch(() => {})
    }
  })
}

// A real transport with a synthetic child catches bridge/transport contract
// bugs that a generous mock callback (onExit/onFailure) would hide.
class OfflineChild extends EventEmitter {
  constructor() {
    super()
    this.pid = 24680
    this.stdout = new PassThrough()
    this.stderr = new PassThrough()
    this.requests = []
    this.turnStarted = deferred()
    this.exited = false
    this.stdin = new Writable({ write: (buffer, _encoding, done) => {
      const message = JSON.parse(buffer.toString())
      this.requests.push(message)
      if (message.id !== undefined) {
        let result
        if (message.method === 'initialize') result = { userAgent: 'offline' }
        else if (message.method === 'account/login/start') result = { type: 'chatgptAuthTokens' }
        else if (message.method === 'thread/start') result = { thread: { id: 'stdio-thread' } }
        else if (message.method === 'turn/start') result = { turn: { id: 'stdio-turn', status: 'inProgress' } }
        else if (message.method === 'turn/interrupt') result = {}
        else assert.fail(`unexpected synthetic RPC ${message.method}`)
        this.send({ id: message.id, result })
        if (message.method === 'turn/start') {
          this.send({ method: 'turn/started', params: { threadId: 'stdio-thread', turn: result.turn } })
          this.turnStarted.resolve()
        }
      }
      done()
    } })
    this.stdin.on('finish', () => this.exit(0))
  }
  send(message) { this.stdout.write(`${JSON.stringify(message)}\n`) }
  kill() { this.exit(0); return true }
  exit(code = 17) {
    if (this.exited) return
    this.exited = true
    this.emit('exit', code)
    this.stdout.end()
    this.stderr.end()
    this.emit('close', code)
  }
}

test('transport exit AFTER accepted turn/start must wake the stream, never hang without turn/completed', async t => {
  const child = new OfflineChild()
  const controller = new AbortController()
  const f = await fixture(t, { createClient: options => new CodexAppServer({ ...options, spawn: () => child }) })
  t.after(() => controller.abort())
  f.pre([user('u1', 'offline transport failure')])
  const work = f.collect(f.options(f.agent, { signal: controller.signal }))
  await bounded(child.turnStarted.promise, 'synthetic transport never accepted turn/start')
  await tick() // response is acknowledged; no request promise remains to reject
  child.exit()
  try {
    const chunks = await bounded(work,
      'Bridge BUG: subprocess exit leaves queue.next() pending. Observe transport closure and enqueue bridge/failure (also during disposal).')
    assertGrammar(chunks, 'error')
    assert.equal(f.clients[0].isClosed, true)
  } finally {
    controller.abort()
    await work.catch(() => {})
  }
})

test('disposing an active bridge settles its stream and pending UI tool pair', async t => {
  const controller = new AbortController()
  const ready = deferred()
  const f = await fixture(t, { autoComplete: false, onTurn(client, turnId) {
    client.notify('item/started', { threadId: client.threadId, turnId, item: {
      type: 'commandExecution', id: 'active-tool', command: 'offline', status: 'inProgress', aggregatedOutput: '',
    } })
    client.notify('item/agentMessage/delta', { threadId: client.threadId, turnId, itemId: 'active-answer', delta: 'partial' })
  } })
  t.after(() => controller.abort())
  f.pre([user('u1', 'dispose me')])
  const work = (async () => { const chunks = []; for await (const chunk of f.stream(f.options(f.agent, { signal: controller.signal }))) {
    chunks.push(chunk)
    if (chunk.type === 'text-delta') ready.resolve()
  } return chunks })()
  await bounded(ready.promise, 'synthetic turn did not start')
  await f.bridge.dispose()
  try {
    const chunks = await bounded(work, 'Bridge BUG: dispose must cancel active stream, wake its queue and settle pending tool pairs')
    assert.ok(['aborted', 'error'].includes(chunks.at(-1)?.reason.kind), 'disposal is not successful native completion')
    assertGrammar(chunks, chunks.at(-1).reason.kind)
    assert.equal(f.bridge.states.size, 0)
    assert.equal(f.agent.session.events.filter(e => e.type === 'tool/result').length, 1)
  } finally {
    controller.abort()
    await work.catch(() => {})
  }
})

test('model switch and native plan/persistent settings reach later turns without DSH instructions', async t => {
  const f = await fixture(t)
  f.pre([user('u1', 'initial')])
  assertGrammar(await f.collect())
  assert.equal((await f.command('codex-mode', 'plan')).kind, 'success')
  assert.equal((await f.command('codex-persistent', 'on')).kind, 'success')
  assert.equal((await f.command('codex-permission', 'codex-read-only')).kind, 'success')
  f.pre([user('u1', 'initial'), user('u2', 'plan on new model')], f.agent, { turn: 2, step: 0 })
  assertGrammar(await f.collect(f.options(f.agent, { model: 'gpt-5.5', reasoningEffort: 'low' })))
  assert.equal(f.clients.length, 1, 'model switch should keep native history, not create a replacement thread')
  const second = f.rpc('turn/start')[1].params
  assert.equal(second.model, 'gpt-5.5')
  assert.equal(second.effort, 'persistent')
  assert.deepEqual(second.collaborationMode, { mode: 'plan', settings: {
    model: 'gpt-5.5', reasoning_effort: 'persistent', developer_instructions: null,
  } })
  assert.equal(second.sandboxPolicy.type, 'readOnly')
  assert.deepEqual(second.input, [inputText('plan on new model')])
  const saved = await journal(f)
  assert.equal(saved.mode, 'plan')
  assert.equal(saved.persistent, true)
  assert.equal(saved.profile, 'codex-read-only')
  assert.equal((await f.command('codex-persistent', 'off')).kind, 'success')
  assert.equal((await f.command('codex-mode', 'default')).kind, 'success')
  f.pre([user('u3', 'normal turn')], f.agent, { turn: 3, step: 0 })
  assertGrammar(await f.collect(f.options(f.agent, { model: 'gpt-5.5', reasoningEffort: 'medium' })))
  const third = f.rpc('turn/start')[2].params
  assert.equal(third.effort, 'medium')
  assert.deepEqual(third.collaborationMode.settings, { model: 'gpt-5.5', reasoning_effort: 'medium', developer_instructions: null })
  assert.equal(third.collaborationMode.mode, 'default')
})

test('persisted native mode, effort and permission selections survive process/session resume', async t => {
  const f = await fixture(t)
  await f.command('codex-mode', 'plan')
  await f.command('codex-persistent', 'on')
  await f.command('codex-permission', 'codex-full-access')
  f.pre([user('u1', 'first')])
  await f.collect()
  await f.bridge.dispose()
  const resumed = await fixture(t, { base: f.base })
  resumed.pre([user('u1', 'first'), user('u2', 'resume')])
  assertGrammar(await resumed.collect())
  const start = resumed.rpc('thread/resume')[0].params
  assert.equal(start.sandbox, 'danger-full-access')
  assert.equal(start.approvalPolicy, 'never')
  const turn = resumed.rpc('turn/start')[0].params
  assert.deepEqual(turn.sandboxPolicy, { type: 'dangerFullAccess' })
  assert.equal(turn.effort, 'persistent')
  assert.equal(turn.collaborationMode.mode, 'plan')
})

for (const legacyType of ['assistant/message', 'tool/call', 'compaction/checkpoint']) {
  test(`legacy ${legacyType} history fails closed until explicit new-thread confirmation`, async t => {
    const f = await fixture(t, { events: [{ seq: 1, type: legacyType, data: { text: PRIVATE } }] })
    f.pre([user('u1', 'new instruction')])
    const chunks = await f.collect()
    assertGrammar(chunks, 'error')
    assert.equal(chunks.at(-1).reason.failure.code, 'CODEX_LEGACY_SESSION')
    assert.match(chunks.at(-1).reason.failure.message, /legacy|Legacy/)
    assert.match(chunks.at(-1).reason.failure.message, /codex-new-thread/)
    assert.equal(f.clients.length, 0, 'do not create an empty native thread while silently discarding legacy context')
    assert.equal(f.calls.auth.length, 0)
    assert.equal((await f.command('codex-new-thread')).kind, 'error')
    assert.equal((await f.command('codex-new-thread', 'confirm')).kind, 'success')
    f.pre([user('u2', 'explicitly fresh')])
    assertGrammar(await f.collect())
    assert.deepEqual(f.rpc('turn/start')[0].params.input, [inputText('explicitly fresh')])
    assert.equal(f.agent.session.events[0].type, legacyType, 'fresh native history must retain the human-visible legacy transcript')
  })
}

test('invalid native thread journal fails closed instead of silently creating a new thread', async t => {
  const f = await fixture(t)
  await fs.mkdir(path.dirname(journalFor(f)), { recursive: true })
  await fs.writeFile(journalFor(f), JSON.stringify({ version: 1, sessionId: 'someone-else', threadId: 'private-thread', delivered: [] }))
  f.pre([user('u1', 'do not lose history')])
  const chunks = await f.collect()
  assertGrammar(chunks, 'error')
  assert.equal(f.clients.length, 0)
  assert.equal(f.rpc('thread/start').length, 0)
})

test('only ordinary global AGENTS candidates are mirrored into preset native home', async t => {
  const f = await fixture(t)
  await fs.writeFile(path.join(f.config.globalInstructionsHome, 'AGENTS.md'), 'ordinary global instructions')
  await fs.writeFile(path.join(f.config.globalInstructionsHome, 'AGENTS.override.md'), 'ordinary override')
  for (const filename of ['auth.json', 'config.toml', 'memory.md']) {
    await fs.writeFile(path.join(f.config.globalInstructionsHome, filename), PRIVATE)
  }
  f.pre([user('u1', 'home isolation')])
  assertGrammar(await f.collect())
  const nativeHome = path.join(f.config.presetRoot, 'native-home')
  assert.equal(f.clients[0].options.env.CODEX_HOME, nativeHome)
  assert.equal(await fs.readFile(path.join(nativeHome, 'AGENTS.md'), 'utf8'), 'ordinary global instructions')
  assert.equal(await fs.readFile(path.join(nativeHome, 'AGENTS.override.md'), 'utf8'), 'ordinary override')
  assert.deepEqual((await fs.readdir(nativeHome)).sort(), ['AGENTS.md', 'AGENTS.override.md'])
  assert.ok(Object.keys(f.clients[0].options.env).every(key => !key.startsWith('DSH_') && !key.startsWith('PI_')))
  assert.equal((await fs.stat(nativeHome)).mode & 0o777, 0o700)
})

test('DSH UNKNOWN_MODEL cannot block official GPT aliases; temporary route is restored before standard reuse', async t => {
  const f = await fixture(t, { provider: 'original-provider' })
  const proposed = freeze({ provider: 'original-provider', model: 'gpt-6-future-alias', reasoningEffort: 'low' })
  f.ctx.llm = { resolveModelInfo: async () => { throw Object.assign(new Error('host catalog is older'), { code: 'UNKNOWN_MODEL' }) } }
  f.pre([user('u1', 'native manager owns this alias')])
  const routed = await f.request(proposed)
  assert.deepEqual(routed, { ...proposed, provider: NATIVE_PROVIDER })
  f.agent.session.requestHeader = () => ({ config: routed })
  assertGrammar(await f.collect(f.options(f.agent, { provider: NATIVE_PROVIDER, model: proposed.model })))
  assert.equal(f.rpc('thread/start')[0].params.model, proposed.model)
  assert.equal(f.rpc('turn/start')[0].params.model, proposed.model)
  const restoration = f.agent.session.events.filter(event => event.type === 'request/header').at(-1)
  assert.deepEqual(restoration.data.header.config, proposed)
  assert.deepEqual(f.agent.session.events.filter(event => event.type === 'request/context').at(-1).data,
    { provider: proposed.provider, model: proposed.model })
  f.deactivateScope(f.agent)
  const identity = { standard: 'unchanged' }
  assert.equal(f.ctx.run('llm/stream', [f.options(f.agent, { provider: proposed.provider })], () => identity), identity)
})

test('missing adapter is ordinary middleware admission; unrelated metadata errors are never bypassed', async t => {
  const f = await fixture(t, { provider: 'original-provider' })
  f.pre([user('u1', 'metadata error boundary')])
  const proposed = freeze({ provider: 'original-provider', model: 'gpt-5.4' })
  f.ctx.llm = { resolveModelInfo: async () => { throw Object.assign(new Error('no adapter'), { code: 'NO_ADAPTER' }) } }
  assert.equal(await f.request(proposed), proposed)
  f.ctx.llm.resolveModelInfo = async () => { throw Object.assign(new Error('invalid catalog'), { code: 'INVALID_CATALOG' }) }
  await assert.rejects(f.request(proposed), error => error.code === 'INVALID_CATALOG')
  assert.equal(f.clients.length, 0)
})

// Regression barriers use actual bridge/interaction lifetimes. A deferred UI
// deliberately ignores its AbortSignal, as a stale external UI callback can.
const answerFor = item => ({ answers: item.questions.map((question, index) => ({
  id: JSON.stringify(['request_user_input_async', item.id, index]),
  ...(question.options?.length ? { selected: [question.options[0]] } : { selected: [], custom: 'Only offline tests' }),
})) })
const replyFor = item => [inputText(`<send_user_message_question_reply>\n${JSON.stringify(item.questions.map((question, index) => ({
  questionItemId: JSON.stringify(['request_user_input_async', item.id, index]), question: question.title,
  answer: question.options?.[0] ?? 'Only offline tests',
})))}\n</send_user_message_question_reply>`)]
async function eventually(check, explanation) {
  let stopped = false
  try { await bounded((async () => { while (!stopped && !await check()) await tick() })(), explanation) }
  finally { stopped = true }
}

for (const boundary of ['new-thread', 'agent-disposed', 'bridge-disposed', 'client-failure']) {
  test(`late async question answer is invalidated by ${boundary}, never contaminating a fresh thread`, async t => {
    const asked = deferred(), answer = deferred()
    const f = await fixture(t, { autoComplete: false,
      services: { userQuestions: { ask(request) { asked.resolve(request); return answer.promise } } },
      onTurn(client, turnId, params) {
        if (params.input[0]?.text === 'old question') {
          client.notify('item/completed', { threadId: client.threadId, turnId, item: asyncQuestionItem() })
        }
      },
    })
    const controller = new AbortController()
    t.after(() => { answer.resolve(asyncAnswer()); controller.abort() })
    f.pre([user('old', 'old question')])
    const oldWork = f.collect(f.options(f.agent, { signal: controller.signal }))
    const question = await bounded(asked.promise, 'old async question was not presented')
    assert.ok(question.signal instanceof AbortSignal, 'async interaction must receive the state lifetime AbortSignal')
    const oldState = f.bridge.states.get('session-1')
    const oldEpoch = oldState.epoch
    complete(f.clients[0])
    assertGrammar(await bounded(oldWork, 'normal foreground completion must not wait for the UI'))
    assert.equal(question.signal.aborted, false, 'normal completion is NOT the async-question lifetime boundary')
    const oldThread = oldState.threadId
    if (boundary === 'bridge-disposed') {
      await bounded(f.bridge.dispose(), 'bridge disposal must complete promptly')
    } else {
      if (boundary === 'client-failure') await f.clients[0].close()
      if (boundary === 'agent-disposed') {
        f.ctx.run('agent/disposed', [{ agent: f.agent }])
        await eventually(() => !f.bridge.states.has('session-1'), 'agent disposal did not remove its owned state')
        f.agent = f.makeAgent('session-1')
      }
      assert.equal((await f.command('codex-new-thread', 'confirm')).kind, 'success')
    }
    assert.equal(question.signal.aborted, true, 'reset/disposal must abort the old async UI lifetime')
    assert.ok(oldState.epoch > oldEpoch, 'reset/disposal must advance the delivery epoch')
    assert.equal(f.clients[0].isClosed, true)
    const injectedBefore = f.calls.injected.length
    let freshWork
    if (boundary !== 'bridge-disposed') {
      f.turnStarted = deferred()
      f.pre([user('fresh', 'fresh input')])
      freshWork = f.collect(f.options(f.agent, { signal: controller.signal }))
      await bounded(f.turnStarted.promise, 'fresh native turn did not start')
      assert.notEqual(f.clients.at(-1).threadId, oldThread)
    }
    answer.resolve(asyncAnswer())
    // Drains the promise chain even when the answerer ignores cancellation.
    await tick(); await tick(); await tick()
    assert.equal(f.rpc('turn/steer').length, 0, 'a stale answer must never steer the new active turn')
    assert.equal(f.calls.injected.length, injectedBefore, 'a stale answer must not schedule another native turn')
    assert.deepEqual(oldState.asyncInput ?? [], [])
    if (freshWork) {
      const freshState = f.bridge.states.get('session-1')
      assert.deepEqual(freshState.asyncInput ?? [], [])
      complete(f.clients.at(-1))
      assertGrammar(await bounded(freshWork, 'fresh turn failed to finish'))
      assert.deepEqual(f.rpc('turn/start').at(-1).params.input, [inputText('fresh input')])
      assert.deepEqual((await journal(f)).asyncInput, [])
      assert.equal(f.pre([user('fresh', 'fresh input'), ...f.calls.injected]).kind, 'reject')
    } else assert.equal(f.bridge.states.size, 0)
  })
}

test('async turn/steer RPC -32602 after native completion retains the answer for exactly one next turn', async t => {
  const asked = deferred(), answer = deferred(), steering = deferred(), refused = deferred()
  const f = await fixture(t, { autoComplete: false,
    services: { userQuestions: { ask(request) { asked.resolve(request); return answer.promise } } },
    createClient(options, owner) {
      const client = new MockClient(options, owner)
      const request = client.request.bind(client)
      client.request = async (method, params, requestOptions = {}) => {
        if (method !== 'turn/steer') return request(method, params, requestOptions)
        client.calls.push({ method, params: structuredClone(params), options: requestOptions })
        steering.resolve()
        await refused.promise
        throw Object.assign(new Error('offline turn already completed'), { code: -32602 })
      }
      return client
    },
    onTurn(client, turnId, params) {
      if (params.input[0]?.text === 'question turn') {
        client.notify('item/completed', { threadId: client.threadId, turnId, item: asyncQuestionItem() })
      } else complete(client, turnId)
    },
  })
  const controller = new AbortController()
  t.after(() => { answer.resolve(asyncAnswer()); refused.resolve(); controller.abort() })
  const first = user('u1', 'question turn')
  f.pre([first])
  const work = f.collect(f.options(f.agent, { signal: controller.signal }))
  const question = await bounded(asked.promise, 'question was not presented')
  answer.resolve(asyncAnswer())
  await bounded(steering.promise, 'active answer did not attempt turn/steer')
  complete(f.clients[0])
  assertGrammar(await bounded(work, 'completion must not wait for a pending async steer RPC'))
  assert.equal(question.signal.aborted, false)
  refused.resolve()
  const control = await bounded(f.backgroundInjected.promise, 'explicit RPC rejection silently discarded the async answer')
  assert.deepEqual((await journal(f)).asyncInput, asyncReplyInput(), 'unacknowledged answer must be durable before waking the loop')
  f.pre([first, control], f.agent, { turn: 2, step: 0 })
  assertGrammar(await bounded(f.collect(), 'retained reply did not enter its next native turn'))
  assert.equal(f.rpc('turn/start').length, 2)
  assert.deepEqual(f.rpc('turn/start')[1].params.input, asyncReplyInput())
  assert.equal(f.rpc('turn/steer').length, 1)
  assert.deepEqual((await journal(f)).asyncInput, [])
  assert.equal(f.pre([first, control]).kind, 'reject', 'ACKed answer may not replay')
})

test('turn/start refusal retains queued async input durably for a restarted native turn', async t => {
  const control = user('persisted-control', '(Native Codex background update)')
  const f = await fixture(t, { createClient(options, owner) {
    const client = new MockClient(options, owner), request = client.request.bind(client)
    client.request = async (method, params, requestOptions = {}) => {
      if (method !== 'turn/start') return request(method, params, requestOptions)
      client.calls.push({ method, params: structuredClone(params), options: requestOptions })
      throw Object.assign(new Error('offline explicit start refusal'), { code: -32602 })
    }
    return client
  } })
  await fs.mkdir(path.dirname(journalFor(f)), { recursive: true })
  await fs.writeFile(journalFor(f), JSON.stringify({ version: 1, sessionId: 'session-1', threadId: 'durable-answer-thread',
    delivered: ['u1'], controls: [control.id], observed: [], profile: null, mode: null, persistent: false,
    compactPending: false, asyncInput: asyncReplyInput() }))
  assert.equal(f.pre([control]).kind, 'enter')
  const rejected = await bounded(f.collect(), 'turn/start explicit refusal must settle promptly')
  assertGrammar(rejected, 'error')
  assert.equal(rejected.at(-1).reason.failure.code, nativeFailureCode({ code: -32602 }))
  assert.equal(typeof rejected.at(-1).reason.failure.code, 'string', 'DSH LlmError rejects numeric failure codes')
  assert.deepEqual(f.rpc('turn/start')[0].params.input, asyncReplyInput())
  assert.deepEqual((await journal(f)).asyncInput, asyncReplyInput(), 'a rejected start did NOT acknowledge queued native input')
  assert.deepEqual(f.bridge.states.get('session-1').asyncInput, asyncReplyInput())
  assert.equal(f.clients[0].isClosed, true)
  await f.bridge.dispose()
  const resumed = await fixture(t, { base: f.base })
  resumed.pre([control, ...f.calls.injected])
  assertGrammar(await bounded(resumed.collect(), 'restarted unacknowledged queued reply must be delivered'))
  assert.deepEqual(resumed.rpc('turn/start')[0].params.input, asyncReplyInput(), 'only the pending reply, not persisted control text, enters native history')
  assert.equal(resumed.rpc('thread/resume')[0].params.threadId, 'durable-answer-thread')
  assert.deepEqual((await journal(resumed)).asyncInput, [])
  assert.equal(resumed.pre([control, ...f.calls.injected]).kind, 'reject')
})

for (const includeNewUser of [false, true]) {
  test(`restart filters persisted control IDs and preserves queued compaction (${includeNewUser ? 'with new user' : 'callback only'})`, async t => {
    const f = await fixture(t)
    const first = user('u1', 'before restart')
    f.pre([first])
    assertGrammar(await bounded(f.collect(), 'initial native turn did not finish'))
    assert.equal((await f.command('codex-compact')).kind, 'success')
    const control = f.calls.injected.at(-1)
    const saved = await journal(f)
    assert.equal(saved.compactPending, true)
    assert.ok(saved.controls.includes(control.id))
    await f.bridge.dispose()
    const resumed = await fixture(t, { base: f.base, onCompact(client, turnId) {
      client.notify('turn/completed', { threadId: client.threadId, turn: { id: turnId, status: 'completed', error: null } })
    } })
    const messages = [first, control, ...(includeNewUser ? [user('u2', 'after restart')] : [])]
    assert.equal(resumed.pre(messages).kind, 'enter') // admission happens BEFORE lazy journal load
    assertGrammar(await bounded(resumed.collect(), 'restarted queued compaction must complete offline'))
    assert.equal(resumed.rpc('thread/resume').length, 1)
    assert.equal(resumed.rpc('thread/compact/start').length, 1, 'queued compaction intent was lost on restart')
    assert.deepEqual(resumed.clients[0].calls.filter(call => ['thread/compact/start', 'turn/start'].includes(call.method)).map(call => call.method),
      includeNewUser ? ['thread/compact/start', 'turn/start'] : ['thread/compact/start'])
    assert.deepEqual(resumed.rpc('turn/start').map(call => call.params.input), includeNewUser ? [[inputText('after restart')]] : [],
      'a persisted direct-user-shaped control wakeup may NEVER become model-visible input after load')
    assert.equal(resumed.pre(messages).kind, 'reject', 'a consumed compaction callback cannot spin the agent loop')
    assert.equal((await journal(resumed)).compactPending, false, 'completed compaction must not replay after another restart')
  })
}

test('queued async answers stay durable until turn/start ACK; concurrent new answers survive that ACK', async t => {
  const item1 = asyncQuestionItem(), item2 = { ...asyncQuestionItem(), id: 'concurrent-question-2' }
  const asked = [deferred(), deferred()], answers = [deferred(), deferred()]
  const awaitingAck = deferred(), ack = deferred()
  let questionCount = 0
  const f = await fixture(t, { autoComplete: false,
    services: { userQuestions: { ask(request) { const index = questionCount++; asked[index].resolve(request); return answers[index].promise } } },
    createClient(options, owner) {
      const client = new MockClient(options, owner), request = client.request.bind(client)
      client.request = async (method, params, requestOptions = {}) => {
        if (method === 'turn/start' && params.input.some(input => input.text?.includes('send_user_message_question_reply'))) {
          awaitingAck.resolve()
          await ack.promise
        }
        return request(method, params, requestOptions)
      }
      return client
    },
    onTurn(client, turnId, params) {
      if (params.input[0]?.text === 'two questions') {
        for (const item of [item1, item2]) client.notify('item/completed', { threadId: client.threadId, turnId, item })
      } else complete(client, turnId)
    },
  })
  const controller = new AbortController()
  t.after(() => { for (const answer of answers) answer.resolve({ answers: [] }); ack.resolve(); controller.abort() })
  const first = user('u1', 'two questions')
  f.pre([first])
  const initialWork = f.collect(f.options(f.agent, { signal: controller.signal }))
  await bounded(Promise.all(asked.map(request => request.promise)), 'both asynchronous questions must be offered without blocking the notification pump')
  complete(f.clients[0])
  assertGrammar(await bounded(initialWork, 'initial turn did not complete'))
  answers[0].resolve(answerFor(item1))
  const control = await bounded(f.backgroundInjected.promise, 'first answer was not queued')
  assert.deepEqual((await journal(f)).asyncInput, replyFor(item1))
  f.pre([first, control], f.agent, { turn: 2, step: 0 })
  const work = f.collect(f.options(f.agent, { signal: controller.signal }))
  await bounded(awaitingAck.promise, 'queued reply did not reach the turn/start ACK barrier')
  const state = f.bridge.states.get('session-1')
  assert.deepEqual(state.asyncInput, replyFor(item1), 'starting an RPC is NOT an ACK')
  assert.deepEqual((await journal(f)).asyncInput, replyFor(item1), 'restart before ACK must retain queued input')
  answers[1].resolve(answerFor(item2))
  await eventually(() => state.asyncInput?.length === 2, 'concurrent answer was not appended while turn/start awaited ACK')
  await state.saveTail
  assert.deepEqual((await journal(f)).asyncInput, [...replyFor(item1), ...replyFor(item2)])
  ack.resolve()
  assertGrammar(await bounded(work, 'accepted first queued reply did not settle'))
  await state.saveTail
  assert.deepEqual(f.rpc('turn/start')[1].params.input, replyFor(item1), 'RPC input must be an immutable batch snapshot')
  assert.deepEqual(state.asyncInput, replyFor(item2), 'ACK removes only its submitted batch, not a concurrently appended answer')
  assert.deepEqual((await journal(f)).asyncInput, replyFor(item2))
  await eventually(() => f.calls.injected.length === 2, 'remaining queued reply did not schedule the next native turn')
  f.pre([first, ...f.calls.injected], f.agent, { turn: 3, step: 0 })
  assertGrammar(await bounded(f.collect(), 'concurrent reply was never delivered'))
  assert.deepEqual(f.rpc('turn/start')[2].params.input, replyFor(item2))
  assert.deepEqual((await journal(f)).asyncInput, [])
  assert.equal(f.pre([first, ...f.calls.injected]).kind, 'reject')
})

for (const throwing of ['createToolResultMessage', 'presentation']) {
  test(`throwing ${throwing} during cancellation cannot skip transport closure, active=false or terminal finish`, async t => {
    const ready = deferred(), controller = new AbortController()
    const explode = () => { throw new Error(`offline ${throwing} settlement failure`) }
    const f = await fixture(t, { autoComplete: false,
      ...(throwing === 'presentation' ? { presentation: { ...nativePresentation, nativeResultContent: explode } } : {}),
      onTurn(client, turnId) {
        client.notify('item/started', { threadId: client.threadId, turnId, item: {
          type: 'commandExecution', id: 'pending:cleanup', command: 'offline', status: 'inProgress', aggregatedOutput: '',
        } })
        client.notify('item/agentMessage/delta', { threadId: client.threadId, turnId, itemId: 'partial', delta: 'partial' })
      },
    })
    if (throwing === 'createToolResultMessage') f.helpers.createToolResultMessage = explode
    t.after(() => controller.abort())
    f.pre([user('u1', 'cancel with bad telemetry')])
    const chunks = []
    const work = (async () => { for await (const chunk of f.stream(f.options(f.agent, { signal: controller.signal }))) {
      chunks.push(chunk)
      if (chunk.type === 'text-delta') ready.resolve()
    } })()
    await bounded(ready.promise, 'fixture did not start its pending tool/partial block')
    const state = f.bridge.states.get('session-1')
    assert.equal(state.calls.size, 1, 'throw must occur during pending-tool settlement, not initial observation')
    controller.abort(new Error('offline cancellation'))
    await bounded(work, 'a telemetry exception prevented the aborted stream from finishing')
    assertGrammar(chunks, 'aborted')
    assert.equal(state.active, false)
    assert.equal(state.signal, undefined)
    assert.equal(state.client, undefined)
    assert.equal(f.clients[0].isClosed, true)
    assert.equal(f.rpc('turn/interrupt').length, 1)
  })
}

for (const attack of ['native-home-directory', 'native-home-AGENTS.md', 'threads-directory']) {
  test(`private native writes never follow malicious ${attack} symlinks to overwrite an external sentinel`, async t => {
    const f = await fixture(t)
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-native-external-sentinel-'))
    t.after(() => fs.rm(outside, { recursive: true, force: true }))
    const nativeHome = path.join(f.config.presetRoot, 'native-home')
    await fs.mkdir(f.config.presetRoot, { recursive: true })
    await fs.writeFile(path.join(f.config.globalInstructionsHome, 'AGENTS.md'), 'ordinary safe global instructions')
    const sentinelName = attack === 'threads-directory' ? path.basename(journalFor(f)) : 'AGENTS.md'
    const sentinel = path.join(outside, sentinelName)
    // A VALID external journal prevents corruption handling from accidentally
    // masking directory-symlink traversal during the subsequent atomic save.
    const sentinelText = attack === 'threads-directory' ? JSON.stringify({ version: 1, sessionId: 'session-1',
      threadId: 'external-native-thread', delivered: [], controls: [], observed: [], profile: null, mode: null,
      persistent: false, compactPending: false, asyncInput: [] }) : 'EXTERNAL PRIVATE SENTINEL: never overwrite'
    await fs.writeFile(sentinel, sentinelText, { mode: 0o644 })
    await fs.chmod(outside, 0o755)
    if (attack === 'native-home-AGENTS.md') {
      await fs.mkdir(nativeHome, { mode: 0o700 })
      await fs.symlink(sentinel, path.join(nativeHome, 'AGENTS.md'))
    } else await fs.symlink(outside, attack === 'threads-directory' ? path.dirname(journalFor(f)) : nativeHome, 'dir')
    const beforeFile = await fs.stat(sentinel), beforeDirectory = await fs.stat(outside)
    f.pre([user('u1', 'confined home only')])
    const chunks = await bounded(f.collect(), 'unsafe home handling must fail promptly, not hang')
    assert.equal(await fs.readFile(sentinel, 'utf8'), sentinelText, 'native preparation/journaling followed a symlink and overwrote an external file')
    assert.equal((await fs.stat(sentinel)).mode, beforeFile.mode, 'external sentinel permissions must not be changed')
    assert.equal((await fs.stat(outside)).mode, beforeDirectory.mode, 'private-directory repair must not chmod an external symlink target')
    assert.deepEqual(await fs.readdir(outside), [sentinelName], 'atomic writes may not leave artifacts in the external directory')
    assertGrammar(chunks, chunks.at(-1).reason.kind)
    if (attack !== 'native-home-AGENTS.md') {
      assert.equal(chunks.at(-1).reason.kind, 'error', 'unsafe private directory links must fail closed')
      assert.equal(f.clients.length, 0)
      assert.equal(f.calls.auth.length, 0)
    }
  })
}

test('existing 0755 private native home and journal directory are repaired to 0700', async t => {
  const f = await fixture(t)
  const nativeHome = path.join(f.config.presetRoot, 'native-home'), threads = path.dirname(journalFor(f))
  for (const directory of [nativeHome, threads]) {
    await fs.mkdir(directory, { recursive: true })
    await fs.chmod(directory, 0o755)
  }
  f.pre([user('u1', 'repair private directory permissions')])
  assertGrammar(await bounded(f.collect(), 'private-directory repair must allow a native turn'))
  for (const directory of [nativeHome, threads]) assert.equal((await fs.stat(directory)).mode & 0o777, 0o700, directory)
})

test('corrupt persisted mode/profile/persistent/async fields fail closed before client or credential creation', async t => {
  const cases = [
    ['mode', 'execute'], ['mode', {}], ['profile', 'codex-unknown'], ['profile', '__proto__'], ['profile', 123],
    ['persistent', 'true'], ['persistent', null], ['asyncInput', {}], ['asyncInput', [null]],
    ['asyncInput', [{ type: 'image', image_url: PRIVATE }]],
    ['asyncInput', [{ type: 'text', text: 123, text_elements: [] }]],
    ['asyncInput', [{ type: 'text', text: PRIVATE, text_elements: null }]],
    ['asyncInput', [{ type: 'text', text: PRIVATE, text_elements: [123] }]],
    ['asyncInput', [{ type: 'text', text: PRIVATE, text_elements: [{ byteRange: { start: -1, end: 999 }, placeholder: null }] }]],
  ]
  for (const [index, [field, value]] of cases.entries()) await t.test(`${field} corruption ${index}`, async st => {
    const f = await fixture(st)
    await fs.mkdir(path.dirname(journalFor(f)), { recursive: true })
    const saved = { version: 1, sessionId: 'session-1', threadId: 'persisted-native-thread', delivered: [], controls: [], observed: [],
      mode: 'default', profile: 'codex-on-request', persistent: false, compactPending: false, asyncInput: [], [field]: value }
    const bytes = JSON.stringify(saved)
    await fs.writeFile(journalFor(f), bytes)
    f.pre([user('u1', 'preserve corrupt journal for explicit recovery')])
    const chunks = await bounded(f.collect(), `corrupt ${field} must be rejected promptly`)
    assertGrammar(chunks, 'error')
    assert.equal(f.clients.length, 0, `corrupt ${field} was admitted before validation`)
    assert.equal(f.calls.auth.length, 0)
    assert.equal(f.rpc('thread/start').length + f.rpc('thread/resume').length, 0)
    assert.equal(await fs.readFile(journalFor(f), 'utf8'), bytes, 'validation must not rewrite corrupt history')
  })
})

for (const [initialProfile, nextProfile] of [['codex-read-only', 'codex-full-access'], ['codex-full-access', 'codex-read-only']]) {
  test(`in-flight authority snapshot stays ${initialProfile}; ${nextProfile} applies only to the next turn`, async t => {
    const entered = deferred(), decision = deferred(), seen = []
    const approval = { config: { policy: 'ask' }, effectivePolicy() { return this.config.policy }, async request(request) {
      const snapshot = this.effectivePolicy(request.agent.session)
      const record = { before: snapshot }
      seen.push(record)
      if (seen.length === 1) { entered.resolve(); await decision.promise }
      record.after = this.effectivePolicy(request.agent.session)
      return snapshot === 'ask' ? 'allowed-once' : 'rejected'
    } }
    const f = await fixture(t, { autoComplete: false, services: { approval } })
    const controller = new AbortController()
    t.after(() => { decision.resolve(); controller.abort() })
    assert.equal((await f.command('codex-permission', initialProfile)).kind, 'success')
    f.pre([user('u1', 'first authority turn')])
    const work = f.collect(f.options(f.agent, { signal: controller.signal }))
    await bounded(f.turnStarted.promise, 'first native authority turn did not start')
    const state = f.bridge.states.get('session-1'), originalPolicy = structuredClone(state.turnPolicy)
    const client = f.clients[0]
    const permissions = { network: { enabled: true } }
    const params = itemId => ({ threadId: client.threadId, turnId: client.turnId, itemId, environmentId: null,
      reason: 'offline scoped permissions fixture', permissions: { ...permissions, fileSystem: null } })
    const firstRequest = client.options.onRequest('item/permissions/requestApproval', params('inflight'), 'rpc-inflight')
    await bounded(entered.promise, 'first authority request did not reach the borrowed approval facade')
    assert.equal((await f.command('codex-permission', nextProfile)).kind, 'success')
    assert.deepEqual(state.turnPolicy, originalPolicy, 'private profile command mutated the already-advertised turn authority')
    decision.resolve()
    const initialAsk = initialProfile === 'codex-read-only'
    const expected = initialAsk ? { permissions, scope: 'turn' } : { permissions: {}, scope: 'turn' }
    assert.deepEqual(await bounded(firstRequest, 'inflight authority request failed to settle'), expected)
    const secondRequest = client.options.onRequest('item/permissions/requestApproval', params('same-turn-after-command'), 'rpc-same-turn')
    assert.deepEqual(await bounded(secondRequest, 'same-turn authority request failed to settle'), expected,
      'even a request arriving AFTER the command still belongs to the original native turn authority')
    complete(client)
    assertGrammar(await bounded(work, 'first authority turn did not finish'))
    f.turnStarted = deferred()
    f.pre([user('u2', 'second authority turn')], f.agent, { turn: 2, step: 0 })
    const nextWork = f.collect(f.options(f.agent, { signal: controller.signal }))
    await bounded(f.turnStarted.promise, 'second authority turn did not start')
    const nextRequest = client.options.onRequest('item/permissions/requestApproval', params('next-turn'), 'rpc-next-turn')
    assert.deepEqual(await bounded(nextRequest, 'next-turn authority request failed to settle'),
      initialAsk ? { permissions: {}, scope: 'turn' } : { permissions, scope: 'turn' })
    const initialPolicy = initialAsk ? 'ask' : 'never', nextPolicy = initialAsk ? 'never' : 'ask'
    assert.deepEqual(seen, [{ before: initialPolicy, after: initialPolicy }, { before: initialPolicy, after: initialPolicy }, { before: nextPolicy, after: nextPolicy }])
    assert.equal(f.rpc('turn/start')[0].params.approvalPolicy, initialAsk ? 'on-request' : 'never')
    assert.equal(f.rpc('turn/start')[1].params.approvalPolicy, initialAsk ? 'never' : 'on-request')
    assert.deepEqual(approval.config, { policy: 'ask' }, 'private native profile may not mutate the host approval service')
    assert.equal(f.services.sandboxPolicy.defaultMode, 'workspace-write')
    complete(client)
    assertGrammar(await bounded(nextWork, 'second authority turn did not finish'))
  })
}

test('a late onClose from the old client cannot abort the replacement client lifetime or async question', async t => {
  const asked = deferred(), answer = deferred()
  const f = await fixture(t, { autoComplete: false,
    services: { userQuestions: { ask(request) { asked.resolve(request); return answer.promise } } },
    onTurn(client, turnId, params) {
      if (params.input[0]?.text === 'old turn') return complete(client, turnId)
      client.notify('item/completed', { threadId: client.threadId, turnId, item: asyncQuestionItem() })
    },
  })
  const controller = new AbortController()
  t.after(() => { answer.resolve(asyncAnswer()); controller.abort() })
  f.pre([user('old', 'old turn')])
  assertGrammar(await bounded(f.collect(), 'old native turn did not complete'))
  const oldClient = f.clients[0]
  assert.equal((await f.command('codex-new-thread', 'confirm')).kind, 'success')
  f.pre([user('fresh', 'fresh question')])
  const work = f.collect(f.options(f.agent, { signal: controller.signal }))
  const question = await bounded(asked.promise, 'fresh question was not presented')
  const state = f.bridge.states.get('session-1'), epoch = state.epoch, lifetime = state.lifetime
  const client = f.clients.at(-1)
  assert.notEqual(client, oldClient)
  oldClient.options.onClose(Object.assign(new Error('delayed old subprocess close'), { code: 'ECLOSED' }))
  await tick()
  assert.equal(state.epoch, epoch, 'obsolete-client close advanced the new thread delivery epoch')
  assert.equal(state.lifetime, lifetime)
  assert.equal(lifetime.signal.aborted, false, 'obsolete-client close aborted the fresh thread lifetime')
  assert.equal(question.signal.aborted, false)
  assert.equal(client.isClosed, false)
  answer.resolve(asyncAnswer())
  await bounded(f.steerStarted.promise, 'fresh async answer was invalidated by the old client close callback')
  assert.deepEqual(f.rpc('turn/steer')[0].params, { threadId: client.threadId, expectedTurnId: client.turnId, input: asyncReplyInput() })
  complete(client)
  assertGrammar(await bounded(work, 'new client stream was failed by the obsolete close callback'))
})

const rolloutLine = payload => JSON.stringify({ timestamp: '2026-10-03T00:00:00Z', type: 'response_item', payload }) + '\n'
test('observer journal dedup survives restart without suppressing a distinct late native ThreadItem completion', async t => {
  const recordedCall = { type: 'custom_tool_call', call_id: 'recorded-exec', name: 'exec', input: 'text("offline output")' }
  const recordedOutput = { type: 'custom_tool_call_output', call_id: 'recorded-exec', output: 'OFFLINE_RECORDED_OUTPUT' }
  const lateItem = { type: 'commandExecution', id: 'late-thread-item', command: 'offline native command',
    status: 'completed', aggregatedOutput: 'LATE_NATIVE_THREAD_ITEM_OUTPUT', exitCode: 0 }
  let rollout
  const createClient = (options, owner) => {
    const client = new MockClient(options, owner), request = client.request.bind(client)
    client.request = async (method, params, requestOptions) => {
      const response = await request(method, params, requestOptions)
      if (method === 'thread/start' || method === 'thread/resume') {
        rollout = path.join(owner.config.presetRoot, 'native-home', 'sessions', 'rollout-offline-dedup.jsonl')
        await fs.mkdir(path.dirname(rollout), { recursive: true })
        if (method === 'thread/start') await fs.writeFile(rollout, rolloutLine(recordedCall) + rolloutLine(recordedOutput))
        response.thread.path = rollout
      }
      return response
    }
    return client
  }
  const f = await fixture(t, { createClient })
  const first = user('u1', 'recorded native observation')
  f.pre([first])
  assertGrammar(await bounded(f.collect(), 'initial rollout observer turn did not finish'))
  const saved = await journal(f)
  assert.ok(saved.observed.includes(`${f.clients[0].threadId}:native-rollout:recorded-exec`))
  assert.equal(f.agent.session.events.filter(event => event.type === 'tool/call').length, 1)
  assert.equal(f.agent.session.events.filter(event => event.type === 'tool/result').length, 1)
  const originalRollout = await fs.readFile(rollout, 'utf8')
  const events = structuredClone(f.agent.session.events)
  await f.bridge.dispose()
  const resumed = await fixture(t, { base: f.base, events, createClient, onTurn(client, turnId) {
    client.notify('item/completed', { threadId: client.threadId, turnId, item: lateItem })
    client.notify('item/completed', { threadId: client.threadId, turnId, item: lateItem })
    complete(client, turnId)
  } })
  resumed.pre([first, user('u2', 'resume with native completion')])
  assertGrammar(await bounded(resumed.collect(), 'resumed observer/native notification turn did not finish'))
  const calls = resumed.agent.session.events.filter(event => event.type === 'tool/call')
  const results = resumed.agent.session.events.filter(event => event.type === 'tool/result')
  assert.equal(calls.length, 2, 'restart must not replay the persisted rollout tool call')
  assert.equal(results.length, 2, 'restart/duplicate notification must not replay the persisted rollout tool result')
  assert.ok(results[1].data.message.content.some(part => part.text?.includes('LATE_NATIVE_THREAD_ITEM_OUTPUT')),
    'dedup of rollout observations may not discard a distinct native ThreadItem completion')
  assert.deepEqual(results[1].sourceEventSeqs, [calls[1].seq])
  assert.deepEqual(resumed.rpc('turn/start')[0].params.input, [inputText('resume with native completion')])
  assert.equal(await fs.readFile(rollout, 'utf8'), originalRollout, 'human observer must never rewrite the canonical native rollout')
})

test('late real ThreadItem completion corrects a provisional interrupted UI result exactly once', async t => {
  const pendingItem = { type: 'commandExecution', id: 'late:real-completion', command: 'offline native command',
    status: 'inProgress', aggregatedOutput: '' }
  const finalItem = { ...pendingItem, status: 'completed', aggregatedOutput: 'REAL_LATE_NATIVE_OUTPUT', exitCode: 0 }
  const f = await fixture(t, { onTurn(client, turnId) {
    client.notify('item/started', { threadId: client.threadId, turnId, item: pendingItem })
    complete(client, turnId)
  } })
  const first = user('u1', 'native tool finishes after foreground completion')
  f.pre([first])
  assertGrammar(await bounded(f.collect(), 'initial tool observation turn did not complete'))
  const initialResults = f.agent.session.events.filter(event => event.type === 'tool/result')
  assert.equal(initialResults.length, 1)
  assert.equal(initialResults[0].data.message.isError, true, 'fixture must reach provisional interrupted settlement')
  const client = f.clients[0]
  for (let duplicate = 0; duplicate < 2; duplicate++) client.notify('item/completed', { threadId: client.threadId,
    turnId: client.turnId, item: finalItem })
  const control = await bounded(f.backgroundInjected.promise, 'late native completion did not schedule its human observation callback')
  assert.equal(f.pre([first, control], f.agent, { turn: 2, step: 0 }).kind, 'enter')
  assertGrammar(await bounded(f.collect(), 'late native completion observation callback did not finish'))
  const calls = f.agent.session.events.filter(event => event.type === 'tool/call')
  const results = f.agent.session.events.filter(event => event.type === 'tool/result')
  // Strict DSH invariants require one call/result pair per step. Correct the
  // old provisional row with a uniquely linked observational pair, not an
  // orphan second result for an already-settled call from a previous step.
  assert.equal(calls.length, 2, 'late completion must create exactly one linked corrective observation')
  assert.equal(results.at(-1).data.meta.correctsCallId, calls[0].data.callId)
  assert.equal(results.at(-1).data.message.isError, false, 'synthetic interruption may not permanently suppress a real native completion')
  assert.ok(results.at(-1).data.message.content.some(part => part.text?.includes('REAL_LATE_NATIVE_OUTPUT')))
  assert.equal(results.at(-1).data.meta.item.status, 'completed')
  assert.equal(results.length, 2, 'duplicate late completion may not produce repeated corrective results')
  assert.deepEqual(results.at(-1).sourceEventSeqs, [calls[1].seq])
  assertObservationAdvertisements(f.agent.session.events)
  assert.equal(f.rpc('turn/start').length, 1, 'human-only correction must never launch an empty/model-visible native turn')
  assert.equal(f.pre([first, control]).kind, 'reject')
})

test('RPC cancellation removes queued interactions before UI dispatch and old resolution cannot delete reused IDs', async t => {
  const f = await fixture(t, { services: { userQuestions: { ask() { assert.fail('cancelled question may not open UI') } } } })
  f.pre([user('u1', 'initialize owned native client')])
  assertGrammar(await f.collect())
  const client = f.clients[0], state = f.bridge.states.get('session-1')
  const params = { threadId: client.threadId, turnId: client.turnId, itemId: 'cancelled-question', questions: [] }
  const first = new AbortController()
  const work = client.options.onRequest('item/tool/requestUserInput', params, 'reused-request', first.signal)
  first.abort(new Error('server resolved the request'))
  await assert.rejects(work)
  assert.equal(state.requests.size, 0)
  assert.equal(state.interactions.length, 0)
  const second = new AbortController()
  const reused = client.options.onRequest('item/tool/requestUserInput', params, 'reused-request', second.signal)
  await tick()
  assert.equal(state.requests.size, 1)
  second.abort(new Error('resolved reused request'))
  await assert.rejects(reused)
  assert.equal(state.requests.size, 0)
  assert.equal(state.interactions.length, 0)
})

test('native auth refresh carries its rejected token and cancellation signal and refuses account mismatch', async t => {
  const f = await fixture(t, { config: { authMode: 'dsh-chatgpt' } })
  f.pre([user('u1', 'initialize synthetic host auth')])
  assertGrammar(await f.collect())
  const client = f.clients[0]
  const controller = new AbortController()
  const refreshed = await client.options.onRequest('account/chatgptAuthTokens/refresh',
    { previousAccountId: 'offline-fixture' }, 31, controller.signal)
  assert.equal(refreshed.accessToken, 'SYNTHETIC_NOT_A_CREDENTIAL')
  assert.equal(f.calls.auth.at(-1).previousAccessToken, 'SYNTHETIC_NOT_A_CREDENTIAL')
  assert.equal(f.calls.auth.at(-1).signal, controller.signal)
  const count = f.calls.auth.length
  await assert.rejects(client.options.onRequest('account/chatgptAuthTokens/refresh',
    { previousAccountId: 'different-account' }, 32, controller.signal))
  assert.equal(f.calls.auth.length, count, 'mismatched account may not rotate credentials')
})

// Mutable, entirely synthetic canonical-store seam. It deliberately keeps the
// client alive while logout/account/token changes happen between foregrounds.
function canonicalAuthFixture() {
  const initial = { accessToken: 'SYNTHETIC_CANONICAL_TOKEN_ONE', chatgptAccountId: 'synthetic-account-one' }
  let current = initial
  const calls = []
  return { initial, calls, set(value) { current = value }, async credentials(options) {
    calls.push(options)
    if (current instanceof Error) throw current
    return structuredClone(current)
  } }
}
const accountFingerprint = id => createHash('sha256').update(id).digest('hex')

function assertNoAuthMaterial(value, ...credentials) {
  const serialized = JSON.stringify(value)
  for (const credential of credentials) {
    for (const secret of [credential.accessToken, credential.chatgptAccountId]) {
      assert.ok(!serialized.includes(secret), 'raw synthetic account/token must not enter journals or UI history')
    }
  }
}

test('Task9: actual installed Commands registration rejects empty hints; hintless native commands omit input', async t => {
  const installedRuntime = process.env.DSH_CODEX_TEST_DSH_ROOT ?? installedDshRoot()
  const require = createRequire(path.join(installedRuntime, 'package.json'))
  const { Context } = require('@deepseek-ai/cordis')
  const { CommandRuntime: Commands } = require('@deepseek-ai/dsh-commands')
  const commandCtx = new Context()
  commandCtx.provide('typert', { lookups: { configure: () => () => {} }, contexts: { configureHost: () => () => {} } })
  t.after(() => commandCtx.fiber.dispose())
  const commands = new Commands(commandCtx)
  assert.throws(() => commands.register({ name: 'fixture-invalid-hint', description: 'Negative control',
    input: { hint: '' }, handler: () => ({ kind: 'success' }) }), /input hint must not be empty/)
  // The bridge itself registers into the actual runtime, not a permissive Map.
  // This would throw during fixture construction if it reinstated input.hint=''.
  const f = await fixture(t, { commands })
  const descriptors = commands.list(f.agent)
  assert.equal(descriptors.length, 6)
  for (const name of ['codex-compact', 'codex-runtime']) {
    const descriptor = descriptors.find(command => command.name === name)
    assert.ok(descriptor, `${name} must actually reach installed Commands`)
    assert.equal(Object.hasOwn(descriptor, 'input'), false)
    assert.equal(Object.hasOwn(f.commands.get(name), 'input'), false)
  }
  for (const name of ['codex-permission', 'codex-mode', 'codex-persistent', 'codex-new-thread']) {
    assert.ok(commands.find(f.agent, name).input.hint.trim().length > 0)
  }
  const execution = await commands.execute(f.agent, '/codex-runtime', [], new AbortController().signal)
  assert.equal(execution.result.kind, 'success')
  assert.match(execution.result.text, /not started/)
  assert.equal(f.clients.length, 0)
  assert.equal(f.calls.auth.length, 0)
})

test('Task9: logout between foreground turns closes the live client without another native turn', async t => {
  const auth = canonicalAuthFixture()
  const f = await fixture(t, { auth })
  const first = user('u1', 'before synthetic logout')
  f.pre([first])
  assertGrammar(await f.collect())
  const client = f.clients[0], before = await journal(f)
  assert.equal(client.isClosed, false)
  assert.equal(auth.calls.length, 1)
  auth.set(Object.assign(new Error('Synthetic canonical login missing; log in again.'), { code: 'CODEX_AUTH_MISSING' }))
  f.pre([first, user('u2', 'must not spend after logout')], f.agent, { turn: 2, step: 0 })
  const chunks = await bounded(f.collect(), 'canonical logout must settle the next foreground')
  assertGrammar(chunks, 'error')
  assert.equal(chunks.at(-1).reason.failure.code, 'CODEX_AUTH_MISSING')
  assert.equal(auth.calls.length, 2, 'a live client must not bypass the canonical credential read')
  assert.equal(client.isClosed, true)
  assert.equal(f.clients.length, 1, 'logout may not spawn a replacement client')
  assert.equal(f.rpc('turn/start').length, 1)
  assert.equal(f.rpc('account/login/start').length, 1)
  assert.deepEqual(await journal(f), before)
  assertNoAuthMaterial([chunks, before, f.agent.session.events], auth.initial)
})

for (const restart of [false, true]) {
  test(`Task9: account fingerprint rejects changed account ${restart ? 'on journal resume' : 'with a live client'} without cross-agent state leakage`, async t => {
    const auth = canonicalAuthFixture()
    const f = await fixture(t, { auth })
    const first = user('u1', 'ACCOUNT_ONE_NATIVE_HISTORY')
    f.pre([first])
    assertGrammar(await f.collect())
    const saved = await journal(f), client = f.clients[0]
    assert.equal(saved.version, 2)
    assert.equal(saved.accountFingerprint, accountFingerprint(auth.initial.chatgptAccountId))
    assert.match(saved.accountFingerprint, /^[a-f0-9]{64}$/)
    const changed = { accessToken: 'SYNTHETIC_ACCOUNT_TWO_TOKEN', chatgptAccountId: 'synthetic-account-two' }
    auth.set(changed)
    if (restart) await f.bridge.dispose()
    const target = restart ? await fixture(t, { base: f.base, auth }) : f
    // Real thread IDs are globally unique; preserve the mock allocator across
    // bridge recreation rather than manufacturing a cross-session collision.
    if (restart) target.nextThread = f.nextThread
    target.pre([first, user('u2', 'account two must not resume account one history')], target.agent, { turn: 2, step: 0 })
    const chunks = await bounded(target.collect(), 'changed canonical account must fail closed')
    assertGrammar(chunks, 'error')
    assert.equal(chunks.at(-1).reason.failure.code, 'CODEX_AUTH_ACCOUNT_CHANGED')
    assert.equal(auth.calls.length, 2)
    assert.equal(client.isClosed, true)
    assert.equal(target.clients.length, restart ? 0 : 1, 'resume mismatch must be detected before client creation')
    assert.equal(target.rpc('thread/resume').length, 0)
    assert.equal(target.rpc('turn/start').length, restart ? 0 : 1)
    assert.deepEqual(await journal(target), saved, 'account mismatch cannot rebind or erase the old account journal')
    const original = target.bridge.states.get('session-1')
    assert.equal(original.accountFingerprint, saved.accountFingerprint)
    assert.equal(original.threadId, saved.threadId)
    assert.deepEqual([...original.delivered], ['u1'])
    // A distinct session may use account two, but must not inherit account
    // one's fingerprint, thread, admissions, controls or human transcript.
    const other = target.makeAgent('account-two-session')
    target.pre([user('other-user', 'isolated account two instruction')], other)
    assertGrammar(await target.collect(target.options(other)))
    const otherSaved = await journal(target, other.session.id)
    assert.equal(otherSaved.accountFingerprint, accountFingerprint(changed.chatgptAccountId))
    assert.deepEqual(otherSaved.delivered, ['other-user'])
    assert.notEqual(otherSaved.threadId, saved.threadId)
    const otherClient = target.clients.at(-1)
    assert.deepEqual(otherClient.calls.find(call => call.method === 'turn/start').params.input,
      [inputText('isolated account two instruction')])
    assert.ok(!JSON.stringify([otherSaved, other.session.events, otherClient.calls]).includes('ACCOUNT_ONE_NATIVE_HISTORY'))
    assert.deepEqual(await journal(target), saved)
    assertNoAuthMaterial([saved, otherSaved, chunks, target.agent.session.events, other.session.events], auth.initial, changed)
  })
}

test('Task9: same-account refreshed canonical token is logged in before the next turn on the existing client', async t => {
  const auth = canonicalAuthFixture()
  const f = await fixture(t, { auth })
  const first = user('u1', 'before synthetic token rotation')
  f.pre([first])
  assertGrammar(await f.collect())
  const client = f.clients[0], saved = await journal(f)
  const refreshed = { ...auth.initial, accessToken: 'SYNTHETIC_CANONICAL_TOKEN_TWO' }
  auth.set(refreshed)
  f.pre([first, user('u2', 'after synthetic token rotation')], f.agent, { turn: 2, step: 0 })
  const chunks = await bounded(f.collect(), 'token rotation must not reset native history')
  assertGrammar(chunks)
  assert.equal(auth.calls.length, 2)
  assert.equal(f.clients.length, 1)
  assert.equal(client.isClosed, false)
  assert.deepEqual(client.calls.map(call => call.method),
    ['account/login/start', 'thread/start', 'turn/start', 'account/login/start', 'turn/start'])
  assert.deepEqual(f.rpc('account/login/start').map(call => call.params),
    [{ type: 'chatgptAuthTokens', ...auth.initial }, { type: 'chatgptAuthTokens', ...refreshed }])
  assert.equal(f.rpc('turn/start')[1].params.threadId, saved.threadId)
  assert.deepEqual(f.rpc('turn/start')[1].params.input, [inputText('after synthetic token rotation')])
  const after = await journal(f)
  assert.equal(after.accountFingerprint, saved.accountFingerprint)
  assert.deepEqual(after.delivered, ['u1', 'u2'])
  assertNoAuthMaterial([after, chunks, f.agent.session.events], auth.initial, refreshed)
})

test('Task9: accepted ordinary inbox steer with a lost timeout ACK is durable uncertain and never replayed next turn or restart', async t => {
  let accepted = 0
  class LostSteerAck extends MockClient {
    async request(method, params, options = {}) {
      const response = await super.request(method, params, options)
      if (method === 'turn/steer') {
        accepted++ // Native admission succeeded; only the transport ACK is lost.
        throw Object.assign(new Error('synthetic lost steer acknowledgement'), { code: 'ETIMEDOUT' })
      }
      return response
    }
  }
  const ready = deferred()
  const f = await fixture(t, { autoComplete: false, createClient: (options, fixture) => new LostSteerAck(options, fixture),
    onTurn(client, turnId) {
      client.notify('item/agentMessage/delta', { threadId: client.threadId, turnId, itemId: 'partial-uncertain-answer', delta: 'working' })
    } })
  const first = user('u1', 'initial'), ambiguous = user('u2', 'already accepted steer; do not replay')
  const controller = new AbortController()
  t.after(() => controller.abort())
  f.pre([first])
  const work = (async () => {
    const chunks = []
    for await (const chunk of f.stream(f.options(f.agent, { signal: controller.signal }))) {
      chunks.push(chunk)
      if (chunk.type === 'text-delta') ready.resolve()
    }
    return chunks
  })()
  await bounded(ready.promise, 'ordinary steer fixture did not enter its acknowledged native turn')
  const client = f.clients[0]
  const splice = () => f.ctx.run('session/event', [f.agent.session, { type: 'agent/inbox/spliced', data: { inserted: [ambiguous] } }])
  splice()
  await bounded(f.bridge.states.get('session-1').steerTail, 'ambiguous steer timeout did not settle')
  const pending = await journal(f)
  assert.equal(accepted, 1)
  assert.deepEqual(pending.uncertain, ['u2'], 'uncertainty must be durable BEFORE a later turn or disposal')
  assert.deepEqual(pending.delivered, ['u1'], 'a lost ACK must not invent a confirmed delivery')
  assert.equal(f.bridge.states.get('session-1').uncertain.has('u2'), true)
  splice()
  await bounded(f.bridge.states.get('session-1').steerTail, 'duplicate inbox splice did not settle')
  assert.equal(f.rpc('turn/steer').length, 1, 'same uncertain ID must not be steered again in the active turn')
  complete(client)
  assertGrammar(await bounded(work, 'ambiguous steering must not orphan the completed foreground'))
  f.onTurn = undefined
  f.autoComplete = true
  const next = user('u3', 'genuinely new next turn')
  f.pre([first, ambiguous, next], f.agent, { turn: 2, step: 0 })
  assertGrammar(await bounded(f.collect(), 'next foreground after an ambiguous steer did not finish'))
  assert.deepEqual(f.rpc('turn/start')[1].params.input, [inputText('genuinely new next turn')])
  assert.deepEqual((await journal(f)).uncertain, ['u2'])
  await f.bridge.dispose()
  const resumed = await fixture(t, { base: f.base })
  resumed.pre([first, ambiguous, next, user('u4', 'new after restart')]) // lazy journal load must still filter u2
  assertGrammar(await bounded(resumed.collect(), 'restart after ambiguous steering did not finish'))
  assert.equal(resumed.rpc('thread/resume')[0].params.threadId, pending.threadId)
  assert.deepEqual(resumed.rpc('turn/start')[0].params.input, [inputText('new after restart')])
  assert.equal(resumed.rpc('turn/steer').length, 0)
  assert.equal(accepted, 1)
  assert.deepEqual((await journal(resumed)).uncertain, ['u2'])
  assert.deepEqual((await journal(resumed)).delivered, ['u1', 'u3', 'u4'])
})

for (const restart of [false, true]) {
  test(`Task9: explicit numeric ordinary steer refusal stays eligible for exactly one next turn ${restart ? 'after restart' : 'on the same bridge'}`, async t => {
    class RefuseSteer extends MockClient {
      async request(method, params, options = {}) {
        if (method === 'turn/steer') {
          this.calls.push({ method, params: structuredClone(params), options })
          throw Object.assign(new Error('explicit synthetic native non-admission'), { code: -32602 })
        }
        return super.request(method, params, options)
      }
    }
    const ready = deferred()
    const f = await fixture(t, { autoComplete: false, createClient: (options, fixture) => new RefuseSteer(options, fixture),
      onTurn(client, turnId) {
        client.notify('item/agentMessage/delta', { threadId: client.threadId, turnId, itemId: 'partial-refusal-answer', delta: 'working' })
      } })
    const controller = new AbortController()
    t.after(() => controller.abort())
    const first = user('u1', 'initial'), refused = user('u2', 'not admitted steer; send next turn')
    f.pre([first])
    const work = (async () => {
      const chunks = []
      for await (const chunk of f.stream(f.options(f.agent, { signal: controller.signal }))) {
        chunks.push(chunk)
        if (chunk.type === 'text-delta') ready.resolve()
      }
      return chunks
    })()
    // A streamed chunk proves first-turn ACK journaling has finished, unlike
    // turn/started, which can arrive before turn/start's response is processed.
    await bounded(ready.promise, 'numeric refusal fixture did not enter the acknowledged native turn')
    const client = f.clients[0]
    f.ctx.run('session/event', [f.agent.session, { type: 'agent/inbox/spliced', data: { inserted: [refused] } }])
    await bounded(f.bridge.states.get('session-1').steerTail, 'numeric ordinary steer refusal did not settle')
    assert.equal(f.rpc('turn/steer').length, 1)
    assert.deepEqual((await journal(f)).uncertain, [])
    assert.deepEqual((await journal(f)).delivered, ['u1'])
    complete(client)
    assertGrammar(await bounded(work, 'native completion after numeric refusal did not settle'))
    if (restart) await f.bridge.dispose()
    const target = restart ? await fixture(t, { base: f.base }) : f
    target.onTurn = undefined
    target.autoComplete = true
    const next = user('u3', 'later direct instruction')
    target.pre([first, refused, next], target.agent, { turn: 2, step: 0 })
    assertGrammar(await bounded(target.collect(), 'refused inbox input was not admitted on the next turn'))
    assert.deepEqual(target.rpc('turn/start').at(-1).params.input,
      [inputText('not admitted steer; send next turn'), inputText('later direct instruction')])
    assert.deepEqual((await journal(target)).delivered, ['u1', 'u2', 'u3'])
    target.pre([first, refused, next, user('u4', 'one more new instruction')], target.agent, { turn: 3, step: 0 })
    assertGrammar(await target.collect())
    assert.deepEqual(target.rpc('turn/start').at(-1).params.input, [inputText('one more new instruction')])
    assert.deepEqual((await journal(target)).uncertain, [])
  })
}

test('Task9: pre-first-turn read-only/mode/persistent choices survive bridge recreation without an empty native thread binding', async t => {
  const f = await fixture(t)
  for (const [name, input] of [['codex-permission', 'codex-read-only'], ['codex-mode', 'plan'], ['codex-persistent', 'on']]) {
    assert.equal((await f.command(name, input)).kind, 'success')
    const saved = await journal(f)
    assert.equal(saved.version, 2)
    assert.equal(saved.threadId, null)
    assert.equal(saved.threadStarted, false)
    assert.equal(saved.accountFingerprint, null)
    for (const field of ['delivered', 'uncertain', 'observed', 'asyncInput']) assert.deepEqual(saved[field], [])
  }
  const controls = await journal(f)
  assert.equal(controls.profile, 'codex-read-only')
  assert.equal(controls.mode, 'plan')
  assert.equal(controls.persistent, true)
  assert.equal(f.clients.length, 0)
  assert.equal(f.calls.auth.length, 0)
  await f.bridge.dispose()
  const resumed = await fixture(t, { base: f.base })
  assert.equal((await resumed.command('codex-permission')).kind, 'success') // load without starting a turn
  assert.equal(resumed.bridge.states.get('session-1').threadId, undefined)
  assert.equal(resumed.clients.length, 0)
  resumed.pre([user('u1', 'first turn after preferences restart')])
  assertGrammar(await resumed.collect())
  assert.equal(resumed.rpc('thread/resume').length, 0, 'controls-only journal is never an empty-thread resume')
  assert.equal(resumed.rpc('thread/start').length, 1)
  assert.equal(resumed.rpc('thread/start')[0].params.sandbox, 'read-only')
  const turn = resumed.rpc('turn/start')[0].params
  assert.deepEqual(turn.sandboxPolicy, { type: 'readOnly', networkAccess: false })
  assert.equal(turn.effort, 'persistent')
  assert.equal(turn.collaborationMode.mode, 'plan')
  const after = await journal(resumed)
  assert.equal(after.threadStarted, true)
  assert.equal(after.threadId, resumed.clients[0].threadId)
  assert.deepEqual(after.delivered, ['u1'])
})

test('Task9: a refused first turn with preselected read-only leaves only preferences, never a durable orphan thread ID', async t => {
  class RefuseFirstTurn extends MockClient {
    async request(method, params, options = {}) {
      if (method === 'turn/start') {
        this.calls.push({ method, params: structuredClone(params), options })
        throw Object.assign(new Error('synthetic first-turn non-admission'), { code: -32602 })
      }
      return super.request(method, params, options)
    }
  }
  const f = await fixture(t, { createClient: (options, fixture) => new RefuseFirstTurn(options, fixture) })
  assert.equal((await f.command('codex-permission', 'codex-read-only')).kind, 'success')
  const message = user('u1', 'retry first turn without an orphan resume')
  f.pre([message])
  const failed = await f.collect()
  assertGrammar(failed, 'error')
  assert.equal(failed.at(-1).reason.failure.code, nativeFailureCode({ code: -32602 }))
  const saved = await journal(f)
  assert.equal(saved.version, 2)
  assert.equal(saved.threadId, null)
  assert.equal(saved.threadStarted, false)
  assert.equal(saved.profile, 'codex-read-only')
  assert.deepEqual(saved.delivered, [])
  assert.deepEqual(saved.observed, [])
  assert.equal(f.bridge.states.get('session-1').threadId, undefined)
  await f.bridge.dispose()
  const resumed = await fixture(t, { base: f.base })
  resumed.pre([message])
  assertGrammar(await resumed.collect())
  assert.equal(resumed.rpc('thread/resume').length, 0)
  assert.equal(resumed.rpc('thread/start').length, 1)
  assert.equal(resumed.rpc('thread/start')[0].params.sandbox, 'read-only')
  assert.equal(resumed.rpc('turn/start')[0].params.sandboxPolicy.type, 'readOnly')
  assert.deepEqual(resumed.rpc('turn/start')[0].params.input, [inputText('retry first turn without an orphan resume')])
  const after = await journal(resumed)
  assert.equal(after.threadStarted, true)
  assert.equal(after.threadId, resumed.clients[0].threadId)
  assert.deepEqual(after.delivered, ['u1'])
})

for (const legacyType of ['assistant/message', 'tool/call', 'compaction/checkpoint']) {
  for (const controlsOnly of [false, true]) {
    test(`Task9: changing controls in legacy ${legacyType} history ${controlsOnly ? 'with a v2 controls-only journal' : 'without a journal'} cannot silently start fresh`, async t => {
      const f = await fixture(t, { events: [{ seq: 1, type: legacyType, data: { text: PRIVATE } }] })
      let saved
      if (controlsOnly) {
        saved = { version: 2, sessionId: 'session-1', threadId: null, threadStarted: false,
          accountFingerprint: null, delivered: [], uncertain: [], observed: [], controls: [], asyncInput: [],
          profile: 'codex-read-only', mode: 'plan', persistent: true }
        await fs.mkdir(path.dirname(journalFor(f)), { recursive: true })
        await fs.writeFile(journalFor(f), JSON.stringify(saved))
      }
      const before = structuredClone(f.agent.session.events)
      for (const [name, input] of [['codex-permission', 'codex-full-access'], ['codex-mode', 'default'], ['codex-persistent', 'off']]) {
        const result = await f.command(name, input)
        assert.equal(result.kind, 'error')
        assert.match(result.text, /legacy/i)
        assert.match(result.text, /codex-new-thread/)
      }
      if (controlsOnly) assert.deepEqual(await journal(f), saved, 'control commands must not overwrite unconverted legacy history')
      else await assert.rejects(fs.stat(journalFor(f)), { code: 'ENOENT' })
      f.pre([user('u1', 'do not silently discard legacy history')])
      const chunks = await f.collect()
      assertGrammar(chunks, 'error')
      assert.equal(chunks.at(-1).reason.failure.code, 'CODEX_LEGACY_SESSION')
      assert.equal(f.clients.length, 0)
      assert.equal(f.calls.auth.length, 0)
      assert.deepEqual(f.agent.session.events, before)
      assert.equal((await f.command('codex-new-thread', 'confirm')).kind, 'success')
      assert.equal((await f.command('codex-permission', 'codex-read-only')).kind, 'success')
      f.pre([user('u2', 'explicitly fresh history only')])
      assertGrammar(await f.collect())
      assert.deepEqual(f.rpc('turn/start')[0].params.input, [inputText('explicitly fresh history only')])
      assert.deepEqual(f.agent.session.events.slice(0, before.length), before, 'explicit reset retains the human transcript')
    })
  }
}

for (const version of [1, 2]) {
  test(`Task9: history-bearing v${version} native journals resume backward-compatibly without forwarding legacy UI model history`, async t => {
    const f = await fixture(t, { events: [{ seq: 1, type: 'assistant/message', data: { text: PRIVATE } }] })
    const saved = { version, sessionId: 'session-1', threadId: 'existing-native-history-thread',
      delivered: ['old-user'], observed: ['old-native-observation'], controls: [], asyncInput: [],
      profile: 'codex-read-only', mode: 'plan', persistent: true,
      ...(version === 2 ? { threadStarted: true, accountFingerprint: accountFingerprint('offline-fixture'), uncertain: ['ambiguous-user'] } : {}) }
    await fs.mkdir(path.dirname(journalFor(f)), { recursive: true })
    await fs.writeFile(journalFor(f), JSON.stringify(saved))
    f.pre([user('old-user', PRIVATE), ...(version === 2 ? [user('ambiguous-user', PRIVATE)] : []), user('new-user', 'new native instruction')])
    assertGrammar(await f.collect())
    assert.equal(f.rpc('thread/start').length, 0)
    assert.equal(f.rpc('thread/resume').length, 1)
    assert.equal(f.rpc('thread/resume')[0].params.threadId, saved.threadId)
    assert.deepEqual(f.rpc('turn/start')[0].params.input, [inputText('new native instruction')])
    assert.equal(f.rpc('turn/start')[0].params.sandboxPolicy.type, 'readOnly')
    for (const call of f.clients[0].calls) assert.ok(!JSON.stringify(call.params).includes(PRIVATE))
    const after = await journal(f)
    assert.equal(after.version, 2)
    assert.equal(after.accountFingerprint, accountFingerprint('offline-fixture'))
    assert.equal(after.threadId, saved.threadId)
    assert.equal(after.threadStarted, true)
    assert.deepEqual(after.delivered, ['old-user', 'new-user'])
    assert.deepEqual(after.observed, ['old-native-observation'])
    assert.deepEqual(after.uncertain, version === 2 ? ['ambiguous-user'] : [])
  })
}

