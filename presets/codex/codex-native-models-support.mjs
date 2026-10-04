// Standalone, bounded local fixtures; deliberately never import another test module.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'
import { createNativeBridge, OFFICIAL_RUNTIME_VERSION } from './codex-native.mjs'
import { CodexAppServer } from './codex-app-server.mjs'
import { installedBinary, installedCatalog, installedDshRoot, requiredFixture } from './codex-test-environment.mjs'

export const BINARY = process.env.DSH_CODEX_TEST_BINARY ?? installedBinary
const BARE_BINARY = requiredFixture('DSH_CODEX_TEST_BARE_BINARY')
export const OFFICIAL_CATALOG = requiredFixture('DSH_CODEX_TEST_OFFICIAL_CATALOG')
export const MANUAL_CATALOG = process.env.DSH_CODEX_TEST_CATALOG ?? installedCatalog
const DSH_ROOT = process.env.DSH_CODEX_TEST_DSH_ROOT ?? installedDshRoot()
export const PRIVATE = 'DSH_PRIVATE_MODEL_PARITY_PROMPT_TOOLS_HISTORY_NEVER_FORWARD'
const text = value => ({ type: 'text', text: value })
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const disposers = new WeakMap()
function cleanup(t, dispose) {
  if (!disposers.has(t)) {
    const actions = []
    disposers.set(t, actions)
    t.after(async () => {
      const errors = []
      for (const action of actions.reverse()) try { await action() } catch (error) { errors.push(error) }
      if (errors.length) throw new AggregateError(errors, 'Model parity cleanup failed')
    })
  }
  disposers.get(t).push(dispose)
}

export async function mockResponses(t) {
  const requests = [], errors = [], sockets = new Set()
  const server = http.createServer(async (req, res) => {
    try {
      // Proxy sink also rejects accidental external requests; it never forwards.
      assert.equal(req.method, 'POST')
      assert.equal(req.url, '/v1/responses')
      assert.equal(req.headers.authorization, undefined, 'No credentials in local mock')
      const chunks = []
      let size = 0
      for await (const chunk of req) {
        size += chunk.length
        assert.ok(size < 4 * 1024 * 1024, 'Model request exceeds fixture bound')
        chunks.push(chunk)
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      requests.push({ body, headers: { ...req.headers } })
      assert.ok(requests.length <= 2, 'At most one native and one bare-official model request; no retries')
      const id = 'local-model-parity-response'
      const events = [
        { type: 'response.created', response: { id } },
        { type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: 'local-answer',
          content: [{ type: 'output_text', text: 'LOCAL_MODEL_PARITY_OK' }] } },
        { type: 'response.completed', response: { id, usage: { input_tokens: 10,
          input_tokens_details: null, output_tokens: 3, output_tokens_details: null, total_tokens: 13 } } },
      ]
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'close' })
      for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      res.end()
    } catch (error) {
      errors.push(error)
      res.writeHead(500, { 'content-type': 'application/json', connection: 'close' })
      res.end(JSON.stringify({ error: { message: 'Local model parity fixture rejected request' } }))
    }
  })
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  server.requestTimeout = server.headersTimeout = 5000
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  cleanup(t, async () => {
    for (const socket of sockets) socket.destroy()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  })
  const origin = `http://127.0.0.1:${server.address().port}`
  return { origin, baseUrl: `${origin}/v1`, requests, errors }
}
function isolatedEnv(home, codexHome, origin) {
  return { PATH: `${path.dirname(BINARY)}:/run/current-system/sw/bin:/usr/bin:/bin`,
    HOME: home, CODEX_HOME: codexHome, XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_CACHE_HOME: path.join(home, '.cache'), TMPDIR: path.join(home, 'tmp'),
    USER: 'codex-model-parity', LOGNAME: 'codex-model-parity', LANG: 'C.UTF-8', TZ: 'UTC',
    HTTP_PROXY: origin, HTTPS_PROXY: origin, ALL_PROXY: origin,
    http_proxy: origin, https_proxy: origin, all_proxy: origin,
    NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
    DO_NOT_TRACK: '1', OTEL_SDK_DISABLED: 'true' }
}
function nativeConfig(mock) {
  return { 'model_providers.mock': { name: 'Local authless model parity mock', base_url: mock.baseUrl,
    wire_api: 'responses', requires_openai_auth: false, request_max_retries: 0,
    stream_max_retries: 0, stream_idle_timeout_ms: 5000 },
    'features.code_mode_host': { enabled: true, disable_in_process_fallback: true },
    web_search: 'disabled', 'analytics.enabled': false, 'feedback.enabled': false,
    'shell_environment_policy.inherit': 'all' }
}

export async function fixture(t, mock, model, nativeOverrides = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-native-models-'))
  cleanup(t, () => fs.rm(base, { recursive: true, force: true }))
  const cwd = path.join(base, 'workspace'), root = path.join(base, 'preset'), home = path.join(base, 'home')
  const codexHome = path.join(root, 'native-home'), global = path.join(base, 'empty-global-instructions')
  await Promise.all([cwd, root, home, codexHome, global, path.join(home, 'tmp')].map(p => fs.mkdir(p, { recursive: true })))
  await fs.writeFile(path.join(cwd, 'AGENTS.md'), 'PROJECT_MANUAL_CONTEXT: local model parity fixture only; never contact external services.\n')
  await fs.copyFile(MANUAL_CATALOG, path.join(root, 'codex-models.json'))
  const llm = await import(pathToFileURL(path.join(DSH_ROOT, 'packages/llm/llm/lib/index.js')).href)
  const tools = await import(pathToFileURL(path.join(DSH_ROOT, 'packages/core/tools/lib/index.js')).href)
  const handlers = new Map(), definitions = new Map(), events = [], rpcs = [], clients = []
  let seq = 0, fallthrough = 0
  const session = { id: 'native-every-model-parity', header: { cwd }, events,
    snapshotEvents: () => [...events], append(type, data, meta = {}) {
      const event = { seq: ++seq, type, data: structuredClone(data), ...structuredClone(meta) }
      events.push(event)
      return event
    } }
  const agent = { session, inject() { assert.fail('Unexpected DSH background injection') } }
  const services = { sandboxPolicy: { defaultMode: 'workspace-write', resolve: () => ({ mode: 'workspace-write' }) },
    approval: { config: { policy: 'never' } } }
  const ctx = { get: key => services[key], on(event, handler, options = {}) {
    const list = handlers.get(event) ?? []
    options.prepend ? list.unshift(handler) : list.push(handler)
    handlers.set(event, list)
    return () => { const index = list.indexOf(handler); if (index !== -1) list.splice(index, 1) }
  }, tools: { register(tool) { assert.ok(!definitions.has(tool.name)); definitions.set(tool.name, tool) },
    get: name => definitions.get(name), execute() { assert.fail('No DSH tool execution permitted') } },
  inject(_deps, callback) { callback({ commands: { register() {} } }) } }
  const run = (event, args, terminal) => {
    const list = [...(handlers.get(event) ?? [])]
    const next = i => list[i] ? list[i](...args, () => next(i + 1)) : terminal()
    return next(0)
  }
  const bridge = createNativeBridge(ctx, { dshHome: path.join(base, 'dsh'), presetRoot: root,
    globalInstructionsHome: global, executable: BINARY, authMode: 'native', modelProvider: 'mock',
    nativeConfig: { ...nativeConfig(mock), ...nativeOverrides } }, { helpers: {
      isAgentLoopRequest: llm.isAgentLoopRequest, createUserMessage: llm.createUserMessage,
      createToolResultMessage: llm.createToolResultMessage, createDeveloperMessage: llm.createDeveloperMessage,
      defineTool: tools.defineTool,
    }, auth: { credentials() { assert.fail('No native or DSH credentials allowed') } },
    createClient(options) {
      const client = new CodexAppServer({ ...options, env: isolatedEnv(home, codexHome, mock.origin) })
      const request = client.request.bind(client)
      client.request = (method, params, settings) => {
        rpcs.push({ method, params: structuredClone(params) })
        return request(method, params, { timeoutMs: 6000, ...settings })
      }
      clients.push(client)
      return client
    } })
  cleanup(t, async () => { await bridge.dispose(); await Promise.all(clients.map(client => client.close())) })
  // Use the installed DSH schema compiler, not a permissive hand-written observer helper.
  const toolRenderJSONSchema = tools.valueSchemaSpecToJsonSchema
  const marker = definitions.get('codex_native_observer')
  assert.deepEqual(toolRenderJSONSchema(marker.output.schema), { type: 'object', additionalProperties: false, properties: {} })
  return { cwd, root, home, codexHome, bridge, rpcs, async collect(prompt) {
    const messages = [llm.createSystemMessage({ content: [text(PRIVATE)] }),
      llm.createDeveloperMessage({ content: [text(PRIVATE)] }),
      llm.createToolResultMessage({ callId: 'private-dsh-history', content: [text(PRIVATE)], isError: false }),
      llm.createAssistantMessage({ content: [text(PRIVATE)] }),
      llm.createUserMessage({ source: { kind: 'user' }, content: [text(prompt), { type: 'system-reminder', text: PRIVATE }] })]
    assert.equal(run('agent/pre-step', [{ agent, messages, turn: 1, step: 0 }], () => assert.fail('DSH context pre-step ran')).kind, 'enter')
    const selected = await run('agent/request', [{ agent, turn: 1, step: 0 }], () => ({ provider: 'real-dsh-provider', model, reasoningEffort: 'medium' }))
    assert.equal(selected.model, model)
    assert.equal(selected.provider, 'real-dsh-provider')
    const options = llm.markAgentLoopRequest(Object.freeze({ sessionId: session.id, provider: 'real-dsh-provider',
      model, reasoningEffort: 'medium', signal: t.signal, messages, systemPrompt: PRIVATE,
      developerInstructions: PRIVATE, tools: [{ name: PRIVATE }], context: PRIVATE, skillReminder: PRIVATE }))
    assert.ok(llm.isAgentLoopRequest(options))
    const chunks = []
    for await (const chunk of run('llm/stream', [options], () => { fallthrough++; assert.fail('Illegal DSH prompt/provider fallback') })) chunks.push(chunk)
    assert.equal(fallthrough, 0)
    assert.ok(rpcs.every(call => call.method !== 'account/login/start'))
    const thread = rpcs.find(call => call.method === 'thread/start')
    assert.equal(thread?.params.model, model, 'Bridge must not substitute Luna')
    assert.ok(!('dynamicTools' in thread.params), 'No bridge-synthesized model tools')
    const finish = chunks.at(-1)
    assert.equal(finish?.type, 'finish')
    return finish.reason.kind === 'stop'
      ? { status: 'completed', text: chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('') }
      : { status: 'failed', error: finish.reason.failure?.message }
  } }
}

// Independent raw official stdio client: no bridge or CodexAppServer, and no
// captured bridge RPCs are reused to construct these hand-authored parameters.
export async function bareOfficial(t, f, mock, model, prompt) {
  const child = spawn(BARE_BINARY, ['app-server', '--listen', 'stdio://'], { cwd: f.cwd,
    env: isolatedEnv(f.home, f.codexHome, mock.origin), stdio: ['pipe', 'pipe', 'pipe'] })
  const pending = new Map(), completed = new Map(), waiters = new Map()
  let id = 0
  const lines = createInterface({ input: child.stdout })
  child.stderr.resume()
  const fail = error => { for (const entry of [...pending.values(), ...waiters.values()]) entry.reject(error) }
  child.on('error', fail)
  child.once('exit', () => fail(new Error('Bare official app-server exited')))
  lines.on('line', line => {
    try {
      const message = JSON.parse(line)
      if ('id' in message && !message.method) {
        const entry = pending.get(message.id)
        if (!entry) return
        pending.delete(message.id)
        message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result)
      } else if (message.method === 'turn/completed') {
        const turn = message.params.turn
        completed.set(turn.id, turn)
        waiters.get(turn.id)?.resolve(turn)
      } else if ('id' in message && message.method) {
        child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: 'Unexpected interaction in local fixture' } }) + '\n')
      }
    } catch (error) { fail(error) }
  })
  const exited = new Promise(resolve => child.once('exit', resolve))
  cleanup(t, async () => {
    fail(new Error('Model parity cleanup'))
    child.stdin.end()
    for (const signal of ['SIGTERM', 'SIGKILL']) {
      if (child.exitCode !== null || child.signalCode !== null) break
      await Promise.race([exited, delay(200)])
      if (child.exitCode === null && child.signalCode === null) child.kill(signal)
    }
    await Promise.race([exited, delay(500)])
    lines.close()
    for (const stream of [child.stdin, child.stdout, child.stderr]) stream.destroy()
  })
  async function bounded(promise) {
    let timer
    const aborted = deferred()
    const abort = () => aborted.reject(t.signal.reason ?? new Error('Model case aborted'))
    t.signal.addEventListener('abort', abort, { once: true })
    try {
      t.signal.throwIfAborted()
      return await Promise.race([promise, aborted.promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Bare official operation exceeded 6s')), 6000)
      })])
    } finally { clearTimeout(timer); t.signal.removeEventListener('abort', abort) }
  }
  function rpc(method, params) {
    const requestId = ++id, entry = deferred()
    pending.set(requestId, entry)
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n')
    return bounded(entry.promise).finally(() => pending.delete(requestId))
  }
  try {
    await rpc('initialize', { clientInfo: { name: 'codex_cli_rs', version: OFFICIAL_RUNTIME_VERSION }, capabilities: { experimentalApi: true } })
    child.stdin.write('{"jsonrpc":"2.0","method":"initialized"}\n')
    const started = await rpc('thread/start', { model, modelProvider: 'mock', cwd: f.cwd,
      approvalPolicy: 'never', sandbox: 'workspace-write', config: nativeConfig(mock) })
    const { turn } = await rpc('turn/start', { threadId: started.thread.id,
      input: [{ type: 'text', text: prompt, text_elements: [] }], cwd: f.cwd,
      approvalPolicy: 'never', sandboxPolicy: { type: 'workspaceWrite', writableRoots: [f.cwd],
        networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }, model, effort: 'medium' })
    let result = completed.get(turn.id)
    if (!result) {
      const entry = deferred()
      waiters.set(turn.id, entry)
      result = await bounded(entry.promise).finally(() => waiters.delete(turn.id))
    }
    return { status: result.status, ...(result.error ? { error: result.error.message } : {}) }
  } catch (error) {
    // Infrastructure/deadline failures are NOT accepted as model rejections.
    if (/exceeded 6s|exited|abort/i.test(error.message) || t.signal.aborted) throw error
    return { status: 'failed', error: error.message }
  }
}

export function modelFacing(body) {
  const result = structuredClone(body)
  // These are API cache/caller bookkeeping, never model-visible content.
  delete result.client_metadata
  delete result.prompt_cache_key
  for (const item of result.input ?? []) if (['message', 'additional_tools'].includes(item.type)) delete item.id
  // Do NOT normalize text, roles, instructions, schemas, grammar, tool arguments,
  // model slug, reasoning, service tier, images or context-window fields.
  return result
}
export function toolDefinitions(body) {
  const tools = [...(body.tools ?? []), ...(body.input ?? []).filter(item => item.type === 'additional_tools').flatMap(item => item.tools ?? [])]
  return tools.flatMap(tool => tool.type === 'namespace' ? [tool, ...tool.tools] : [tool])
}
export function assertBoundary(mock) {
  assert.equal(mock.errors.length, 0, mock.errors[0]?.stack)
  for (const { body } of mock.requests) assert.ok(!JSON.stringify(body).includes(PRIVATE), 'DSH prompt/tool/history contamination reached model')
}
