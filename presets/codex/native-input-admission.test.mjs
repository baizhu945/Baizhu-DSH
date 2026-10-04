import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { installedDshRoot } from './codex-test-environment.mjs'
import { codexNativeInputAdmission } from './native-input-admission.mjs'
import { createNativeBridge, nativeFailureCode } from './codex-native.mjs'

// Offline: real pinned SessionController facade, model runtime and attachment
// store. Only the catalog adapter and native RPC transport are test doubles.
// Never spawn Codex, read auth/session homes, install dependencies or call models.
const DSH = process.env.DSH_CODEX_TEST_DSH_ROOT ?? installedDshRoot()
const require = createRequire(path.join(DSH, 'package.json'))
const { Context } = require('@deepseek-ai/cordis')
const { Session, SESSION_FORMAT_VERSION } = require('@deepseek-ai/dsh-session')
const { LlmRuntime, LlmAdapter, LlmError } = require('@deepseek-ai/dsh-llm')
const { default: ProjectionRegistry } = require('@deepseek-ai/dsh-session-projection')
const { default: LocalAttachments } = require('@deepseek-ai/dsh-attachment-local')
const work = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-input-admission-'))
const relative = 'packages/api/session-controller/src/commands.ts'
const original = await fs.readFile(path.join(DSH, relative), 'utf8')
const patch = await fs.readFile(new URL('./patches/codex-runtime-parity.patch', import.meta.url), 'utf8')
const section = patch.split(/(?=^diff --git )/m).find(part => part.startsWith(`diff --git a/${relative} `))
assert.ok(section, 'Owned runtime patch must contain the production admission seam')
await fs.mkdir(path.join(work, path.dirname(relative)), { recursive: true })
await fs.writeFile(path.join(work, relative), original)
// A built new derivative already contains the seam. Older installed derivatives
// get ONLY its exact commands.ts hunk in a disposable overlay, never store edits.
const alreadyApplied = original.includes("readonly codexNativeInputAdmission?")
const applied = spawnSync('patch', ['--batch', '--fuzz=0', '-p1', ...(alreadyApplied ? ['--reverse'] : [])],
  { cwd: work, input: section, encoding: 'utf8' })
assert.equal(applied.status, 0, applied.stdout + applied.stderr)
if (alreadyApplied) await fs.writeFile(path.join(work, relative), original)
await fs.symlink(path.join(DSH, 'node_modules'), path.join(work, 'node_modules'))
const overlay = await fs.readFile(path.join(work, relative), 'utf8')
const bundle = path.join(work, 'controller.mjs')
await require('esbuild').build({ entryPoints: [path.join(DSH, 'packages/api/session-controller/src/index.ts')],
  outfile: bundle, bundle: true, platform: 'node', target: 'node22', format: 'esm', packages: 'external', logLevel: 'silent',
  plugins: [{ name: 'exact-owned-admission-patch', setup(build) {
    build.onLoad({ filter: /\/session-controller\/src\/commands\.ts$/ }, () => ({
      contents: overlay, loader: 'ts', resolveDir: path.dirname(path.join(DSH, relative)),
    }))
  } }] })
const { SessionController } = await import(pathToFileURL(bundle).href)
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=='
const image = (extra = {}) => ({ type: 'image', mediaType: 'image/png', data: PNG, ...extra })
const text = value => ({ type: 'text', text: value })
let nextId = 0

async function fixture(t, limits = {}) {
  const ctx = new Context()
  const root = path.join(work, `fixture-${++nextId}`)
  await fs.mkdir(root, { recursive: true })
  ctx.provide('typert', { lookups: { configure: () => () => {} }, contexts: { configureHost: () => () => {} } })
  const records = new Map()
  ctx.provide('agents', { get: id => records.get(id) })
  ctx.provide('sessions', { get: id => records.get(id)?.session })
  ctx.provide('workspaceRegistry', { get: () => undefined, list: () => [] })
  let model = 'native-alias-not-in-advisory-catalog'
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'offline', model }), saveSelection: async () => {} })
  new ProjectionRegistry(ctx)
  ctx.provide('sessionQuery', {})
  ctx.provide('fs', { resolve: () => assert.fail('Image admission must not resolve arbitrary client filesystem paths') })
  const receipts = new Map()
  let bound = 0
  ctx.provide('fileUploads', { registerAgentResolver: () => () => {}, resolve: (agent, receipt) => receipts.get(agent)?.get(receipt),
    bindPrompt: () => ({ commit: () => bound++, [Symbol.dispose]: () => {} }), retirePrompt: () => {} })
  // Real runtime UNKNOWN_MODEL with a local catalog-only adapter. No production
  // route/provider changes; stream cannot perform any I/O even if called.
  let lookups = 0
  class OfflineCatalog extends LlmAdapter {
    async listModels() { return [{ id: 'catalog-text-only', inputModalities: ['text'] }] }
    async resolveModel(provider, selected) {
      lookups++
      if (selected === 'catalog-text-only') return { provider, id: selected, name: selected, inputModalities: ['text'] }
      throw new LlmError(`Unknown model ${selected}`, 'UNKNOWN_MODEL')
    }
    async *stream() { assert.fail('No model calls permitted') }
  }
  const llm = new LlmRuntime(ctx)
  llm.registerAdapter(['offline'], new OfflineCatalog())
  new LocalAttachments(ctx, { dshHome: root, ...limits })
  const controller = new SessionController(ctx, { nativeOpen: false })
  const standardScope = ctx.extend()
  const nativeScope = ctx.isolate('codexNativeInputAdmission')
  const withdraw = nativeScope.provide('codexNativeInputAdmission', codexNativeInputAdmission)
  function agent(scope, name) {
    const id = `admission-${nextId}-${name}`
    const session = Session.create(id, undefined, { id, version: SESSION_FORMAT_VERSION, createdAt: 1, isSeeded: false, cwd: root })
    const value = { id: session.id, ctx: scope, session, status: 'idle', inbox: { nextTurn: [], nextStep: [] },
      followup(message) { value.inbox.nextTurn.push(message) }, steer(message) { value.inbox.nextStep.push(message) } }
    records.set(value.id, value)
    return value
  }
  const native = agent(nativeScope, 'native')
  const standard = agent(standardScope, 'standard')
  let request = 0
  const prompt = (agent, content = [image()], extra = {}) => controller.prompt({
    sessionId: agent.id, requestId: `rpc-${++request}`, mode: 'queue', content, ...extra,
  }, new AbortController().signal)
  t.after(() => ctx.fiber.dispose())
  return { ctx, root, controller, native, standard, prompt, withdraw, records, receipts,
    lookups: () => lookups, bound: () => bound, setModel: value => { model = value }, llm }
}

test('real SessionController: native alias admitted, standard retains UNKNOWN_MODEL and exact runtime identity', async t => {
  const f = await fixture(t)
  const resolve = f.llm.resolveModelInfo
  const beforeProviders = await f.llm.listProviders()
  assert.equal(f.ctx.get('codexNativeInputAdmission'), undefined)
  assert.equal(f.standard.ctx.get('codexNativeInputAdmission'), undefined)
  assert.equal(f.native.ctx.get('codexNativeInputAdmission'), codexNativeInputAdmission)
  assert.ok(Object.isFrozen(codexNativeInputAdmission))
  await assert.rejects(f.llm.resolveModelInfo('offline', 'native-alias-not-in-advisory-catalog'), { code: 'UNKNOWN_MODEL' })
  const before = f.lookups()
  assert.deepEqual(await f.prompt(f.native), { accepted: true })
  assert.equal(f.lookups(), before, 'Native model admission must not consult the advisory catalog')
  assert.equal(f.native.inbox.nextTurn[0].content[0].type, 'image')
  assert.ok(f.ctx.attachments.imageHostPath(f.native.inbox.nextTurn[0].content[0].attachment).startsWith(f.root))
  await assert.rejects(f.prompt(f.standard), error => error.code === 'session/agent-busy' && /Unknown model/.test(error.details.reason))
  assert.equal(f.standard.inbox.nextTurn.length, 0)
  assert.equal(f.llm.resolveModelInfo, resolve)
  assert.deepEqual(await f.llm.listProviders(), beforeProviders)
  t.diagnostic(JSON.stringify({ rootProof: f.ctx.get('codexNativeInputAdmission') ?? null,
    standardProof: f.standard.ctx.get('codexNativeInputAdmission') ?? null,
    nativeProof: f.native.ctx.get('codexNativeInputAdmission'),
    standardQueued: f.standard.inbox.nextTurn.length, nativeQueued: f.native.inbox.nextTurn.length,
    providersUnchanged: true, runtimeMethodUnchanged: true }))
})

test('unmarked, false, root-leaked, re-composed and stale identities cannot borrow native admission', async t => {
  const f = await fixture(t)
  f.ctx.provide('codexNativeInputAdmission', Object.freeze({ usesNativeModelAdmission: true }))
  await assert.rejects(f.prompt(f.standard), { code: 'session/agent-busy' })
  assert.deepEqual(await f.prompt(f.native), { accepted: true }, 'Independent isolated proof remains authoritative')
  f.withdraw()
  await assert.rejects(f.prompt(f.native), { code: 'session/agent-busy' })
  const falseScope = f.ctx.isolate('codexNativeInputAdmission')
  falseScope.provide('codexNativeInputAdmission', Object.freeze({ usesNativeModelAdmission: false }))
  f.native.ctx = falseScope
  await assert.rejects(f.prompt(f.native), { code: 'session/agent-busy' })
  const proofScope = f.ctx.isolate('codexNativeInputAdmission')
  proofScope.provide('codexNativeInputAdmission', Object.freeze({ usesNativeModelAdmission: true }))
  f.native.ctx = proofScope
  // Pin the resolver result, then replace the registered identity before the
  // serialized admission starts. The stale object's marker is not authority.
  f.controller.agents.resolveAgent = async () => ({ agent: f.native })
  f.records.set(f.native.id, { ...f.native })
  await assert.rejects(f.prompt(f.native), { code: 'session/agent-busy' })
})

test('ordinary text and advisory text-only rejection remain unchanged; native does not manufacture capability metadata', async t => {
  const f = await fixture(t)
  assert.deepEqual(await f.prompt(f.standard, [text('plain')]), { accepted: true })
  assert.equal(f.lookups(), 0)
  f.setModel('catalog-text-only')
  await assert.rejects(f.prompt(f.standard), error => error.code === 'session/attachment-invalid'
    && error.details.reason === 'MODEL_DOES_NOT_SUPPORT_IMAGES')
  assert.deepEqual(await f.prompt(f.native), { accepted: true })
})

test('API addresses the current mounted preset service even when agent.ctx cannot see its private realm', async t => {
  const f = await fixture(t)
  f.withdraw()
  assert.equal(f.native.ctx.get('codexNativeInputAdmission'), undefined)
  const proofs = new WeakMap([[f.native, codexNativeInputAdmission]])
  // The public registry's serviceFor identity contract; the actual pinned
  // implementation resolves only fibers in standingMountFor(agent.ctx).
  f.ctx.provide('agentPresets', { serviceFor: (agent, name) => {
    assert.equal(name, 'codexNativeInputAdmission')
    return proofs.get(agent)
  } })
  assert.deepEqual(await f.prompt(f.native), { accepted: true })
  await assert.rejects(f.prompt(f.standard), { code: 'session/agent-busy' })
  proofs.delete(f.native)
  await assert.rejects(f.prompt(f.native), { code: 'session/agent-busy' })
})

test('typed image intake still enforces canonical bytes, media, count, aggregate and per-image sizes', async t => {
  for (const [limits, content, reason] of [
    [{}, [image({ data: 'not base64!' })], 'INVALID_IMAGE_BASE64'],
    [{}, [image({ mediaType: 'image/svg+xml' })], 'UNSUPPORTED_IMAGE_TYPE'],
    [{ maxImagesPerMessage: 1 }, [image(), image()], 'TOO_MANY_IMAGES'],
    [{ maxMessageImageBytes: 1 }, [image()], 'IMAGES_TOO_LARGE'],
    [{ maxImageBytes: 1 }, [image()], 'IMAGE_TOO_LARGE'],
    [{}, [image({ data: Buffer.from('not a raster').toString('base64') })], 'INVALID_IMAGE'],
  ]) {
    const f = await fixture(t, limits)
    await assert.rejects(f.prompt(f.native, content), error => error.code === 'session/attachment-invalid'
      && error.details.reason === reason, reason)
    assert.equal(f.native.inbox.nextTurn.length, 0)
    assert.equal(f.bound(), 0)
    assert.equal(f.lookups(), 0)
  }
})

test('file receipt/session authority and image read authorization remain intact', async t => {
  const f = await fixture(t)
  const file = { attachmentId: 'offline-file', name: 'data.bin', bytes: 3 }
  f.receipts.set(f.standard, new Map([['standard-receipt', file]]))
  await assert.rejects(f.prompt(f.native, [image(), { type: 'file', receiptId: 'standard-receipt', path: '/etc/passwd' }]),
    error => error.code === 'session/attachment-invalid' && error.details.reason === 'FILE_NOT_STAGED')
  assert.equal(f.native.inbox.nextTurn.length, 0)
  f.receipts.set(f.native, new Map([['native-receipt', file]]))
  assert.deepEqual(await f.prompt(f.native, [image(), { type: 'file', receiptId: 'native-receipt' }]), { accepted: true })
  assert.deepEqual(f.native.inbox.nextTurn[0].content[1], { type: 'file', attachment: file })
  const ref = f.native.inbox.nextTurn[0].content[0].attachment
  await assert.rejects(f.controller.attachment({ sessionId: f.standard.id, attachmentId: ref.attachmentId }),
    error => error.code === 'session/attachment-invalid' && error.details.reason === 'ATTACHMENT_NOT_REFERENCED')
})

test('native unsupported-image RPC refusal remains an error, never a fabricated successful model completion', async t => {
  const f = await fixture(t)
  assert.deepEqual(await f.prompt(f.native), { accepted: true }, 'API acceptance acknowledges queue intake only')
  const handlers = new Map()
  let marker
  const officialError = { code: -32602, message: 'Image inputs are not supported for this model.' }
  const nativeCtx = { get: name => f.ctx.get(name),
    on: (event, handler) => { handlers.set(event, handler); return () => handlers.delete(event) },
    tools: { register: tool => { if (tool.name === 'codex_native_observer') marker = tool },
      get: (_name, agent) => agent === f.native ? marker : undefined },
    inject: () => {} }
  const rpc = []
  const bridge = createNativeBridge(nativeCtx, { presetRoot: path.join(f.root, 'preset'), dshHome: f.root,
    globalInstructionsHome: path.join(f.root, 'empty'), executable: '/offline/do-not-spawn' }, {
    helpers: { isAgentLoopRequest: () => true, defineTool: tool => tool },
    auth: { credentials: async () => ({ accessToken: 'offline-synthetic', chatgptAccountId: 'offline' }) },
    createClient: () => ({ closed: new Promise(() => {}), start: async () => ({}), close: async () => {},
      async request(method, params) {
        rpc.push({ method, params })
        if (method === 'account/login/start') return {}
        if (method === 'thread/start') return { thread: { id: 'offline-thread' } }
        if (method === 'turn/start') throw Object.assign(new Error(officialError.message), officialError)
        assert.fail(`Unexpected RPC ${method}`)
      } }),
  })
  t.after(() => bridge.dispose())
  await fs.mkdir(path.join(f.root, 'empty'), { recursive: true })
  const messages = f.native.inbox.nextTurn
  handlers.get('agent/pre-step')({ agent: f.native, messages, turn: 1, step: 0 })
  const options = { sessionId: f.native.id, provider: 'offline', model: 'native-text-only-model', messages: [], tools: [] }
  await handlers.get('agent/request')({ agent: f.native, turn: 1, step: 0 }, async () => options)
  const chunks = []
  for await (const chunk of handlers.get('llm/stream')(options, () => assert.fail('No DSH fallback'))) chunks.push(chunk)
  const input = rpc.find(call => call.method === 'turn/start')?.params.input
  assert.ok(input.some(part => part.type === 'localImage'), 'Durable image reaches official native intake')
  assert.equal(chunks.at(-1).reason.kind, 'error')
  // The existing privacy-safe bridge deliberately sanitizes raw RPC wording;
  // retain its native error/code, not a fabricated capability success/class.
  assert.match(chunks.at(-1).reason.failure.message, /Official Codex runtime failed.*-32602/)
  assert.equal(chunks.at(-1).reason.failure.code, nativeFailureCode(officialError))
  assert.equal(chunks.some(chunk => chunk.type === 'finish' && chunk.reason.kind === 'stop'), false)
})

test.after(() => fs.rm(work, { recursive: true, force: true }))
