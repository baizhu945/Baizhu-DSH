import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'
import { createNativeBridge } from './codex-native.mjs'
import { CodexAppServer } from './codex-app-server.mjs'
import { installedBinary, installedCatalog, installedDshRoot, requiredFixture, integrationOptions } from './codex-test-environment.mjs'

// node --test codex-native-integration.test.mjs
// Real pinned engine + real installed DSH helpers, not a simulated RPC server.
// Every model response is scripted by an HTTP/SSE server bound to 127.0.0.1.
// Overrides select local binaries/catalogs only; no npm, credentials or paid API.
const BINARY = process.env.DSH_CODEX_TEST_BINARY ?? installedBinary
const BARE_BINARY = requiredFixture('DSH_CODEX_TEST_BARE_BINARY')
const DSH = process.env.DSH_CODEX_TEST_DSH_ROOT ?? installedDshRoot()
const CATALOG = process.env.DSH_CODEX_TEST_CATALOG ?? installedCatalog
const OPTIONS = integrationOptions(BINARY)
const PRIVATE = 'DSH_PRIVATE_PROMPT_TOOL_HISTORY_SKILL_REMINDER_DO_NOT_FORWARD'
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=='
const text = value => ({ type: 'text', text: value })
const input = value => ({ type: 'text', text: value, text_elements: [] })
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const cleanups = new WeakMap()
function cleanup(t, action) {
  if (!cleanups.has(t)) {
    const actions = []
    cleanups.set(t, actions)
    t.after(async () => {
      const errors = []
      for (const dispose of actions.reverse()) {
        try { await dispose() } catch (error) { errors.push(error) }
      }
      if (errors.length) throw new AggregateError(errors, 'Integration cleanup failed')
    })
  }
  cleanups.get(t).push(action)
}

// These tiny SSE records follow core/tests/common/responses.rs at 86a54b0:
// ev_response_created, ev_custom_tool_call, ev_function_call,
// ev_assistant_message and ev_completed. No full upstream fixtures are loaded.
function response(number, items) {
  const id = `mock-response-${number}`
  return [
    { type: 'response.created', response: { id } },
    ...items.map(item => ({ type: 'response.output_item.done', item })),
    { type: 'response.completed', response: { id, usage: {
      input_tokens: 10, input_tokens_details: null, output_tokens: 3,
      output_tokens_details: null, total_tokens: 13,
    } } },
  ]
}
const answer = value => ({ type: 'message', role: 'assistant', id: 'mock-answer',
  content: [{ type: 'output_text', text: value }] })
const freeform = (call_id, name, code) => ({ type: 'custom_tool_call', call_id, name, input: code })
const functionCall = (call_id, name, args) => ({ type: 'function_call', call_id, name, arguments: JSON.stringify(args) })

async function mockResponses(t, script) {
  const requests = []
  const errors = []
  const sockets = new Set()
  const server = http.createServer(async (req, res) => {
    try {
      // Also a rejecting proxy sink: any accidental non-loopback request is
      // rejected instead of forwarding to an external host.
      assert.equal(req.method, 'POST')
      assert.equal(req.url, '/v1/responses')
      assert.equal(req.headers.authorization, undefined, 'Authless mock must never receive credentials')
      const chunks = []
      let bytes = 0
      for await (const chunk of req) {
        bytes += chunk.length
        assert.ok(bytes < 4 * 1024 * 1024, 'Unexpectedly large model request')
        chunks.push(chunk)
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const index = requests.length
      requests.push({ body, headers: { ...req.headers } })
      const items = await script(body, index)
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'close' })
      // Split writes at SSE event boundaries, exercising the actual streaming parser.
      for (const event of response(index, items)) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      res.end()
    } catch (error) {
      errors.push(error)
      res.writeHead(500, { 'content-type': 'application/json', connection: 'close' })
      res.end(JSON.stringify({ error: { message: 'Local integration fixture rejected request' } }))
    }
  })
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  server.requestTimeout = 5000
  server.headersTimeout = 5000
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  cleanup(t, async () => {
    for (const socket of sockets) socket.destroy()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  })
  const origin = `http://127.0.0.1:${server.address().port}`
  return { requests, errors, origin, baseUrl: `${origin}/v1` }
}

function isolatedEnv(home, codexHome, origin) {
  // Allowlist: never inherit OPENAI_*, auth, cloud credentials, DSH/PI context,
  // the user's HOME/CODEX_HOME, shell startup or configured proxy credentials.
  return { PATH: `${path.dirname(BINARY)}:/run/current-system/sw/bin:/usr/bin:/bin`,
    HOME: home, CODEX_HOME: codexHome, XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_CACHE_HOME: path.join(home, '.cache'), TMPDIR: path.join(home, 'tmp'),
    USER: 'codex-integration', LOGNAME: 'codex-integration', LANG: 'C.UTF-8', TZ: 'UTC',
    HTTP_PROXY: origin, HTTPS_PROXY: origin, ALL_PROXY: origin,
    http_proxy: origin, https_proxy: origin, all_proxy: origin,
    NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
    DO_NOT_TRACK: '1', OTEL_SDK_DISABLED: 'true' }
}

function nativeConfig(mock) {
  return {
    'model_providers.mock': { name: 'Local authless integration mock', base_url: mock.baseUrl,
      wire_api: 'responses', requires_openai_auth: false,
      request_max_retries: 0, stream_max_retries: 0, stream_idle_timeout_ms: 5000 },
    'features.code_mode_host': { enabled: true, disable_in_process_fallback: true },
    'web_search': 'disabled',
    'analytics.enabled': false,
    'feedback.enabled': false,
    'shell_environment_policy.inherit': 'all',
  }
}

async function fixture(t, mock, { model = 'gpt-6-luna', legacy = false, realSession = false } = {}) {
  assert.ok(existsSync(BINARY), `Local binary not found: ${BINARY}`)
  assert.ok(existsSync(path.join(path.dirname(BINARY), 'codex-code-mode-host')), 'Exact companion CodeMode host must be adjacent to codex')
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-native-integration-'))
  // LIFO cleanup: close BOTH native children before deleting homes/workspace.
  cleanup(t, () => fs.rm(base, { recursive: true, force: true }))
  const cwd = path.join(base, 'workspace')
  const root = path.join(base, 'preset')
  const home = path.join(base, 'home')
  const global = path.join(base, 'empty-global-instructions')
  // A separate fresh thread in the SAME isolated Codex home gives identical
  // model-visible skill roots. Do not normalize these meaningful paths away.
  const bareHome = path.join(root, 'native-home')
  await Promise.all([cwd, root, home, global, bareHome, path.join(home, 'tmp')].map(p => fs.mkdir(p, { recursive: true })))
  await fs.writeFile(path.join(cwd, 'AGENTS.md'), 'PROJECT_MANUAL_CONTEXT: integration files only; do not contact external services.\n')
  // This Nix catalog is an official HEAD catalog with context fields patched to
  // 1.05M only. Never synthesize prompts, tool modes or model capabilities.
  const catalog = JSON.parse(await fs.readFile(CATALOG, 'utf8'))
  assert.equal(catalog.models.find(m => m.slug === 'gpt-6-luna')?.context_window, 1_050_000)
  await fs.copyFile(CATALOG, path.join(root, 'codex-models.json'))
  const llm = await import(pathToFileURL(path.join(DSH, 'packages/llm/llm/lib/index.js')).href)
  const tools = await import(pathToFileURL(path.join(DSH, 'packages/core/tools/lib/index.js')).href)
  const sessionLibrary = realSession ? await import(pathToFileURL(path.join(DSH, 'packages/core/session/lib/index.js')).href) : undefined
  const handlers = new Map(), definitions = new Map(), commands = new Map()
  let dshExecutions = 0, fallthrough = 0, seq = 0, nativeScope = true
  const events = legacy ? [
    { seq: ++seq, type: 'assistant/message', data: { message: llm.createAssistantMessage({ content: [text(PRIVATE)] }) } },
    { seq: ++seq, type: 'tool/call', data: { name: PRIVATE, arguments: PRIVATE } },
    { seq: ++seq, type: 'compaction/checkpoint', data: { text: PRIVATE } },
  ] : []
  const session = realSession ? sessionLibrary.Session.create(sessionLibrary.SessionId('real-native-integration'), undefined, {
    version: sessionLibrary.SESSION_FORMAT_VERSION, id: 'real-native-integration', createdAt: Date.now(),
    isSeeded: false, cwd, agentPreset: 'codex',
  }) : { id: 'real-native-integration', header: { cwd }, events,
    snapshotEvents: () => [...events], append(type, data, meta = {}) {
      const event = { seq: ++seq, type, data: structuredClone(data), ...structuredClone(meta) }
      events.push(event)
      return event
    } }
  if (realSession) session.append('system/message', { message: llm.createSystemMessage({ content: [text(PRIVATE)] }) }, { surfaceOp: 'append' })
  const agent = { session, inject() { assert.fail('No background DSH injection expected in this fixture') } }
  const services = { sandboxPolicy: { defaultMode: 'workspace-write', resolve: () => ({ mode: 'workspace-write' }) },
    approval: { config: { policy: 'never' } } }
  const ctx = { get: key => services[key], on(event, handler, options = {}) {
    const list = handlers.get(event) ?? []
    options.prepend ? list.unshift(handler) : list.push(handler)
    handlers.set(event, list)
    return () => { const index = list.indexOf(handler); if (index !== -1) list.splice(index, 1) }
  }, tools: {
    register(tool) { assert.ok(!definitions.has(tool.name)); definitions.set(tool.name, tool) },
    get: (name, owner) => owner && !nativeScope ? undefined : definitions.get(name),
    execute() { dshExecutions++; assert.fail('Official tools must never execute through DSH') },
  }, inject(_deps, callback) { callback({ commands: { register: command => commands.set(command.name, command) } }) } }
  const run = (event, args, terminal = () => undefined) => {
    const list = [...(handlers.get(event) ?? [])]
    const next = i => list[i] ? list[i](...args, () => next(i + 1)) : terminal()
    return next(0)
  }
  const clients = [], rpcs = []
  const config = { dshHome: path.join(base, 'dsh'), presetRoot: root, globalInstructionsHome: global,
    executable: BINARY, authMode: 'native', modelProvider: 'mock', nativeConfig: nativeConfig(mock) }
  const env = isolatedEnv(home, path.join(root, 'native-home'), mock.origin)
  const bridge = createNativeBridge(ctx, config, { helpers: {
    isAgentLoopRequest: llm.isAgentLoopRequest, createUserMessage: llm.createUserMessage,
    createToolResultMessage: llm.createToolResultMessage, createDeveloperMessage: llm.createDeveloperMessage,
    defineTool: tools.defineTool,
  }, auth: { credentials() { assert.fail('Native authless provider must not load DSH or real credentials') } },
  createClient(options) {
    const client = new CodexAppServer({ ...options, env })
    const request = client.request.bind(client)
    client.request = (method, params, settings) => {
      rpcs.push({ method, params: structuredClone(params) })
      return request(method, params, { timeoutMs: 6000, ...settings })
    }
    clients.push(client)
    return client
  } })
  cleanup(t, async () => {
    await bridge.dispose()
    await Promise.all(clients.map(client => client.close()))
  })
  let turn = 0
  const contaminated = () => [
    llm.createSystemMessage({ content: [text(PRIVATE)] }),
    llm.createDeveloperMessage({ content: [text(PRIVATE)] }),
    llm.createUserMessage({ source: { kind: 'context' }, content: [text(PRIVATE)] }),
    llm.createUserMessage({ source: { kind: 'agent', agentId: 'unrelated' }, content: [text(PRIVATE)] }),
    llm.createToolResultMessage({ callId: 'dsh-mirror', content: [text(PRIVATE)], isError: false }),
    llm.createAssistantMessage({ content: [text(PRIVATE)] }),
  ]
  async function collect(prompt, previous = []) {
    const user = llm.createUserMessage({ source: { kind: 'user' }, content: [text(prompt),
      { type: 'system-reminder', text: PRIVATE }] })
    const messages = [...contaminated(), ...previous, user]
    if (realSession) session.append('user/message', user, { surfaceOp: 'append' })
    const position = { turn: ++turn, step: 0 }
    assert.equal(run('agent/pre-step', [{ agent, messages, ...position }], () => {
      assert.fail('DSH compaction/context/skill pre-step must not run')
    }).kind, 'enter')
    const selected = await run('agent/request', [{ agent, ...position }], () => ({ provider: 'actual-dsh-provider', model, reasoningEffort: 'medium' }))
    assert.equal(selected.provider, 'actual-dsh-provider', 'Native interception must preserve the selected REAL provider')
    assert.equal(selected.model, model)
    if (realSession) session.append('request/header', { reason: turn === 1 ? 'initial' : 'change', header: { config: selected } })
    const options = llm.markAgentLoopRequest(Object.freeze({ sessionId: session.id,
      provider: 'actual-dsh-provider', model, reasoningEffort: 'medium', signal: t.signal,
      messages: [...messages, llm.createDeveloperMessage({ content: [text(PRIVATE)] })],
      systemPrompt: PRIVATE, developerInstructions: PRIVATE, tools: [{ name: PRIVATE }],
      context: PRIVATE, skillReminder: PRIVATE }))
    assert.equal(llm.isAgentLoopRequest(options), true)
    const stream = run('llm/stream', [options], () => { fallthrough++; assert.fail('No DSH model/provider fallback permitted') })
    const chunks = []
    for await (const chunk of stream) chunks.push(chunk)
    assert.deepEqual(chunks.at(-1)?.reason, { kind: 'stop' }, JSON.stringify(chunks.at(-1)))
    return { chunks, user }
  }
  return { base, cwd, root, home, bareHome, catalog, config, env, llm, ctx, bridge, agent, sessionLibrary,
    get events() { return session.snapshotEvents() },
    definitions, rpcs, collect, run, deactivateNativeScope: () => { nativeScope = false }, command: name => commands.get(name).handler({ agent, rawInput: 'confirm' }),
    assertBoundary() {
      assert.equal(dshExecutions, 0)
      assert.equal(fallthrough, 0)
      assert.ok(rpcs.every(call => call.method !== 'account/login/start'))
      assert.equal(rpcs.find(call => call.method === 'initialize')?.params.clientInfo.version, '0.162.0-alpha.11', 'App-server identity must match the compiled official CLI version')
      assert.ok(rpcs.filter(call => call.method === 'thread/start').every(call => !('dynamicTools' in call.params)))
      assert.equal(mock.errors.length, 0, mock.errors[0]?.stack)
      for (const { body } of mock.requests) assert.ok(!JSON.stringify(body).includes(PRIVATE), 'DSH private material reached model')
    } }
}

// Independent bare official stdio transport, deliberately not the bridge or
// CodexAppServer. Its thread/turn settings are hand-authored from the official
// v2 schema, never copied from bridge-captured RPCs.
async function bareOfficial(t, f, mock, model) {
  const env = isolatedEnv(f.home, f.bareHome, mock.origin)
  const child = spawn(BARE_BINARY, ['app-server', '--listen', 'stdio://'], { cwd: f.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
  const pending = new Map(), turns = new Map(), early = new Map()
  let id = 0
  const lines = createInterface({ input: child.stdout })
  child.stderr.resume()
  const fail = error => { for (const entry of [...pending.values(), ...turns.values()]) entry.reject(error) }
  child.on('error', fail)
  child.once('exit', () => fail(new Error('Bare official app-server exited')))
  lines.on('line', line => {
    try {
      const message = JSON.parse(line)
      if ('id' in message && !message.method) {
        const entry = pending.get(message.id)
        if (!entry) return
        pending.delete(message.id)
        message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result)
      } else if (message.method === 'turn/completed') {
        const result = message.params.turn
        const entry = turns.get(result.id)
        entry ? entry.resolve(result) : early.set(result.id, result)
      } else if ('id' in message && message.method) {
        child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: 'Unexpected interaction in authless fixture' } }) + '\n')
      }
    } catch (error) { fail(error) }
  })
  const exited = new Promise(resolve => child.once('exit', resolve))
  cleanup(t, async () => {
    fail(new Error('Integration cleanup'))
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
    const abort = () => aborted.reject(t.signal.reason ?? new Error('Integration test aborted'))
    t.signal.addEventListener('abort', abort, { once: true })
    try {
      t.signal.throwIfAborted()
      return await Promise.race([promise, aborted.promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Bare app-server exceeded 6s fixture deadline')), 6000)
      })])
    } finally { clearTimeout(timer); t.signal.removeEventListener('abort', abort) }
  }
  function rpc(method, params) {
    const entry = deferred(), requestId = ++id
    pending.set(requestId, entry)
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n')
    return bounded(entry.promise).finally(() => pending.delete(requestId))
  }
  await rpc('initialize', { clientInfo: { name: 'codex_cli_rs', version: '0.0.0' }, capabilities: { experimentalApi: true } })
  child.stdin.write('{"jsonrpc":"2.0","method":"initialized"}\n')
  const started = await rpc('thread/start', { model, modelProvider: 'mock', cwd: f.cwd,
    approvalPolicy: 'never', sandbox: 'workspace-write', config: nativeConfig(mock) })
  return { async collect(prompt) {
    const startedTurn = await rpc('turn/start', { threadId: started.thread.id, input: [input(prompt)],
      cwd: f.cwd, approvalPolicy: 'never', sandboxPolicy: { type: 'workspaceWrite', writableRoots: [f.cwd],
        networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }, model, effort: 'medium' })
    const turnId = startedTurn.turn.id
    let result = early.get(turnId)
    if (!result) {
      const entry = deferred()
      turns.set(turnId, entry)
      result = await bounded(entry.promise).finally(() => turns.delete(turnId))
    }
    early.delete(turnId)
    assert.equal(result.status, 'completed', JSON.stringify(result))
  } }
}

function modelFacing(body) {
  const normalized = structuredClone(body)
  // Explicitly model-hidden fields only. In particular do NOT erase developer
  // roles/text, instructions, tool schemas/grammar, reasoning, images, context
  // window, or arbitrary IDs nested in tool definitions/arguments.
  delete normalized.client_metadata
  delete normalized.prompt_cache_key
  for (const item of normalized.input ?? []) {
    if (['message', 'additional_tools'].includes(item.type)) delete item.id // API item identity, not content.
  }
  return normalized
}
function toolDefinitions(body) {
  const tools = [...(body.tools ?? []), ...(body.input ?? []).filter(item => item.type === 'additional_tools').flatMap(item => item.tools ?? [])]
  return tools.flatMap(tool => tool.type === 'namespace' ? [tool, ...tool.tools] : [tool])
}
function assertNoNativeLeak(mock) {
  assert.equal(mock.errors.length, 0, mock.errors[0]?.stack)
  for (const { body } of mock.requests) assert.ok(!JSON.stringify(body).includes(PRIVATE))
}
function visible(chunks) { return chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('') }
function toolOutputs(body, callId) {
  return body.input.filter(item => ['custom_tool_call_output', 'function_call_output'].includes(item.type)
    && (!callId || item.call_id === callId)).map(item => item.output)
}

// No credential/token fixture is supplied: authMode native + mock provider is
// the real official authless path, with both engines' homes isolated.
test('real bridge marker and observers satisfy the installed DSH defineTool contract', OPTIONS, async t => {
  const mock = await mockResponses(t, (_body, index) => index === 0
    ? [functionCall('strict-shell', 'exec_command', { cmd: 'printf STRICT_DSH_OBSERVER_MARKER', login: false })]
    : [answer('strict DSH definitions complete')])
  const f = await fixture(t, mock, { model: 'gpt-5.5' })
  await f.collect('Run the local observer contract probe.')
  f.assertBoundary()
  assert.ok(f.definitions.has('codex_native_observer'))
  assert.ok(f.definitions.has('bash'))
  assert.ok(JSON.stringify(f.events.filter(event => event.type === 'tool/result')).includes('STRICT_DSH_OBSERVER_MARKER'))
})

test('real gpt-6-luna ResponsesLite payload equals independent bare official across two turns; DSH augmentation/history never enters', OPTIONS, async t => {
  const bridgeMock = await mockResponses(t, (_body, index) => [answer(`native answer ${index}`)])
  const f = await fixture(t, bridgeMock, { legacy: true })
  assert.equal((await f.command('codex-new-thread')).kind, 'success')
  const first = await f.collect('Hello from direct user input.')
  assert.equal(visible(first.chunks), 'native answer 0')
  await f.collect('Continue without the DSH transcript.', [first.user])
  f.assertBoundary()
  assert.equal(bridgeMock.requests.length, 2)
  const firstBody = bridgeMock.requests[0].body
  assert.equal(firstBody.model, 'gpt-6-luna')
  assert.ok(firstBody.input.some(item => item.type === 'additional_tools' && item.role === 'developer'), 'Official ResponsesLite AdditionalTools developer prefix')
  assert.ok(firstBody.input.some(item => item.type === 'message' && item.role === 'developer'), 'Official developer instructions must remain developer-role')
  const exec = toolDefinitions(firstBody).find(tool => tool.name === 'exec')
  assert.equal(exec?.type, 'custom')
  assert.equal(exec?.format?.type, 'grammar')
  assert.equal(exec?.format?.syntax, 'lark')
  assert.ok(exec.description.includes('text('), 'Official CodeMode helpers are model-visible')
  await f.bridge.dispose()
  const bareMock = await mockResponses(t, (_body, index) => [answer(`native answer ${index}`)])
  const bare = await bareOfficial(t, f, bareMock, 'gpt-6-luna')
  await bare.collect('Hello from direct user input.')
  await bare.collect('Continue without the DSH transcript.')
  assertNoNativeLeak(bareMock)
  assert.equal(bareMock.requests.length, 2)
  for (let i = 0; i < 2; i++) assert.deepEqual(modelFacing(bridgeMock.requests[i].body), modelFacing(bareMock.requests[i].body), `Turn ${i + 1}: model-facing parity (no manual context differences)`)
})

test('real official shell and Freeform/Lark apply_patch run only in temp workspace; DSH sees readable observations', OPTIONS, async t => {
  const patch = '*** Begin Patch\n*** Add File: native-patch.txt\n+NATIVE_PATCH_MARKER\n*** End Patch\n'
  const mock = await mockResponses(t, (_body, index) => {
    if (index === 0) return [functionCall('shell-call', 'exec_command', {
      cmd: "printf 'NATIVE_SHELL_MARKER\\n' > native-shell.txt; printf 'NATIVE_SHELL_MARKER\\n'", yield_time_ms: 1000,
    })]
    if (index === 1) return [freeform('patch-call', 'apply_patch', patch)]
    assert.equal(index, 2, 'No unexpected model retries/tool loops')
    return [answer('native shell and patch complete')]
  })
  const f = await fixture(t, mock, { model: 'gpt-5.5' })
  const { chunks } = await f.collect('Run the local integration shell and patch operations.')
  assert.equal(visible(chunks), 'native shell and patch complete')
  f.assertBoundary()
  assert.equal(mock.requests.length, 3)
  assert.equal(await fs.readFile(path.join(f.cwd, 'native-shell.txt'), 'utf8'), 'NATIVE_SHELL_MARKER\n')
  assert.equal(await fs.readFile(path.join(f.cwd, 'native-patch.txt'), 'utf8'), 'NATIVE_PATCH_MARKER\n')
  const patchTool = toolDefinitions(mock.requests[0].body).find(tool => tool.name === 'apply_patch')
  assert.equal(patchTool?.type, 'custom')
  assert.equal(patchTool?.format?.syntax, 'lark')
  const calls = f.events.filter(event => event.type === 'tool/call')
  const results = f.events.filter(event => event.type === 'tool/result')
  assert.ok(calls.some(event => event.data.name === 'bash'))
  assert.ok(calls.some(event => event.data.name === 'apply_patch'))
  assert.equal(results.length, calls.length)
  assert.ok(JSON.stringify(results).includes('NATIVE_SHELL_MARKER'), 'Shell observation is readable')
  assert.ok(JSON.stringify(results).includes('native-patch.txt'), 'Patch observation is readable')
  assert.ok(results.every(event => event.data.message.role === 'tool' && event.data.message.isError === false), 'Real DSH createToolResultMessage produced successful UI observations')
  assert.ok(!chunks.some(chunk => chunk.blockType === 'tool-call' || chunk.block?.type === 'tool-call'), 'Observers must not become DSH executable model calls')
  await f.bridge.dispose()
  const bareMock = await mockResponses(t, () => [answer('control')])
  const bare = await bareOfficial(t, f, bareMock, 'gpt-5.5')
  await bare.collect('Run the local integration shell and patch operations.')
  assert.deepEqual(modelFacing(mock.requests[0].body), modelFacing(bareMock.requests[0].body), 'Shell/patch admission has exactly bare-official role/text/tool definitions')
})

test('real gpt-6-luna companion V8 executes text/store/load/image/yield/wait plus native shell/apply_patch', OPTIONS, async t => {
  const code = `store("integration", { marker: "V8_STORE_MARKER", count: 7 });
text("V8_TEXT_MARKER");
yield_control();
text((await tools.exec_command({ cmd: "sleep 0.05; printf V8_SHELL_MARKER > v8-shell.txt; printf V8_SHELL_MARKER", yield_time_ms: 1000 })).output);
text(JSON.stringify(await tools.apply_patch("*** Begin Patch\\n*** Add File: v8-patch.txt\\n+V8_PATCH_MARKER\\n*** End Patch\\n")));
text(JSON.stringify(load("integration")));
image(${JSON.stringify(PNG)});`
  const mock = await mockResponses(t, (body, index) => {
    if (index === 0) return [freeform('v8-exec', 'exec', code)]
    if (index === 1) {
      const cell = /Script running with cell ID (\d+)/.exec(JSON.stringify(toolOutputs(body, 'v8-exec')))?.[1]
      assert.ok(cell, 'Actual yield_control must expose a running cell')
      return [functionCall('v8-wait', 'wait', { cell_id: cell, yield_time_ms: 1000 })]
    }
    if (index === 2) return [freeform('v8-load', 'exec', 'text(JSON.stringify(load("integration")));')]
    assert.equal(index, 3, 'V8 execution must settle without retries')
    return [answer('V8 native integration complete')]
  })
  const f = await fixture(t, mock)
  const { chunks } = await f.collect('Exercise local CodeMode runtime helpers and native tools.')
  assert.equal(visible(chunks), 'V8 native integration complete')
  f.assertBoundary()
  assert.equal(mock.requests.length, 4)
  assert.equal(await fs.readFile(path.join(f.cwd, 'v8-shell.txt'), 'utf8'), 'V8_SHELL_MARKER')
  assert.equal(await fs.readFile(path.join(f.cwd, 'v8-patch.txt'), 'utf8'), 'V8_PATCH_MARKER\n')
  const output = JSON.stringify(toolOutputs(mock.requests.at(-1).body))
  for (const marker of ['V8_TEXT_MARKER', 'V8_STORE_MARKER', 'V8_SHELL_MARKER']) assert.ok(output.includes(marker), `${marker} must reach the model via official tool results`)
  assert.ok(output.includes('input_image') && output.includes('data:image/png;base64,'), 'Real image() must produce native image content')
  assert.ok(JSON.stringify(toolOutputs(mock.requests[3].body, 'v8-load')).includes('V8_STORE_MARKER'), 'Store/load persists across separate official V8 cells')
  const results = f.events.filter(event => event.type === 'tool/result')
  assert.ok(results.length > 0)
  assert.ok(JSON.stringify(results).includes('V8_SHELL_MARKER'), 'CodeMode nested shell observation exposes readable native output')
  assert.ok(JSON.stringify(results).includes('v8-patch.txt'), 'CodeMode nested patch observation exposes readable paths/diff')
  // The read-only private rollout observer supplies genuine direct cell
  // results missing from ThreadItems. Nothing is fabricated or re-executed.
  for (const marker of ['V8_TEXT_MARKER', 'V8_STORE_MARKER']) assert.ok(JSON.stringify(results).includes(marker), `${marker} must also be human-visible`)
  assert.ok(results.some(event => event.data.meta?.item?.type === 'codeExecution'), 'human UI includes an actual native Code Mode cell')
})

test('real DSH Session keeps native tool observations human-visible, hides them from model/standard history, and preserves scoped provider routing', OPTIONS, async t => {
  const mock = await mockResponses(t, (_body, index) => {
    if (index === 0) return [functionCall('surface-shell', 'exec_command', { cmd: 'printf REAL_DSH_HUMAN_MARKER', login: false })]
    if (index === 1) return [freeform('surface-patch', 'apply_patch', '*** Begin Patch\n*** Add File: surface-native.txt\n+REAL_DSH_PATCH_MARKER\n*** End Patch\n')]
    assert.equal(index, 2)
    return [answer('native surface complete')]
  })
  const f = await fixture(t, mock, { model: 'gpt-5.5', realSession: true })
  const { chunks, user } = await f.collect('Keep these native observations in the human UI only.')
  f.assertBoundary()
  const { session } = f.agent
  const { Session, SessionLogOffset, deriveEventMessage, isAppendSurfaceEvent, isReplacementSurfaceEvent } = f.sessionLibrary
  // The real agent loop persists the final streamed native TEXT, never tool calls.
  session.append('assistant/message', { turn: 1, step: 0, stream: [], message: f.llm.createAssistantMessage({
    source: { kind: 'model', provider: 'actual-dsh-provider', model: 'gpt-5.5' }, content: [text(visible(chunks))],
  }) }, { surfaceOp: 'append' })
  const log = session.snapshotEvents()
  const mirrors = log.filter(event => event.type === 'tool/result')
  assert.equal(mirrors.length, 2, 'Real Session accepted both production observer results')
  for (const mirror of mirrors) {
    const index = log.findIndex(event => event.seq === mirror.seq)
    const replacement = log[index + 1]
    const call = log.find(event => event.seq === mirror.sourceEventSeqs[0])
    assert.equal(call.type, 'tool/call')
    assert.equal(call.data.callId, mirror.data.message.toolCallId)
    assert.equal(replacement.type, 'developer/message', 'Human mirror must be hidden immediately, before any unrelated append')
    assert.deepEqual(replacement.surfaceOp, { op: 'replace', startSeq: mirror.seq, endSeq: mirror.seq })
    assert.deepEqual(replacement.sourceEventSeqs, [mirror.seq], 'Replacement must cite every shadowed surface node')
    assert.equal(replacement.data.message.source.kind, 'tool-registry')
    assert.deepEqual(replacement.data.message.content, [])
    assert.equal(deriveEventMessage(replacement), null, 'Empty developer replacement produces NO model wire message')
    assert.ok(isReplacementSurfaceEvent(replacement))
    assert.ok(!isAppendSurfaceEvent(replacement))
    assert.ok(!session.surface.nodes.includes(mirror.seq))
    assert.ok(session.surface.nodes.includes(replacement.seq))
  }
  const human = log.filter(isAppendSurfaceEvent)
  assert.equal(human.filter(event => event.type === 'tool/result').length, 2)
  assert.ok(JSON.stringify(human).includes('REAL_DSH_HUMAN_MARKER'))
  assert.ok(JSON.stringify(human).includes('surface-native.txt'))
  assert.ok(human.every(event => !isReplacementSurfaceEvent(event)), 'Human transcript ignores model-only replacements')
  const modelHistory = session.deriveMessages()
  assert.deepEqual(modelHistory.map(message => message.role), ['system', 'user', 'assistant'])
  assert.equal(modelHistory[1].id, user.id, 'Raw user/message DATA survives unchanged')
  assert.equal(modelHistory[2].content[0].text, 'native surface complete')
  assert.ok(!JSON.stringify(modelHistory).includes('REAL_DSH_HUMAN_MARKER'))
  assert.ok(!JSON.stringify(modelHistory).includes('REAL_DSH_PATCH_MARKER'))
  assert.equal(session.surface.nodes[0], log[0].seq, 'Protected system root remains intact')

  // Replay through the actual Session validator, including standard-preset reuse.
  const standard = Session.fromRestore(session.id, log, { ...session.header, agentPreset: 'standard' }, SessionLogOffset(0), 'shared-frozen')
  standard.append('request/header', { reason: 'change', header: { config: { provider: 'standard-real-provider', model: 'standard-model' } } })
  assert.deepEqual(standard.deriveMessages(), modelHistory)
  assert.ok(standard.deriveMessages().every(message => message.role !== 'tool'), 'Standard cannot serialize an orphan function_call_output')
  assert.ok(standard.snapshotEvents().filter(isAppendSurfaceEvent).some(event => event.type === 'tool/result'), 'Restoration also retains the human observation')
  const beforeSwitch = f.rpcs.length
  f.deactivateNativeScope()
  const standardOptions = f.llm.markAgentLoopRequest({ sessionId: session.id, provider: 'actual-dsh-provider', model: 'gpt-5.5', messages: modelHistory })
  assert.equal(f.run('llm/stream', [standardOptions], () => 'standard-provider-owned-stream'), 'standard-provider-owned-stream', 'A reused REAL provider must not remain intercepted after native scope ends')
  assert.equal(f.rpcs.length, beforeSwitch, 'Standard route must not issue another native RPC')

  // These fail for the actual attribution/root rules, not hash/derivation noise.
  const firstReplacement = log.findIndex(isReplacementSurfaceEvent)
  const missingSource = structuredClone(log)
  delete missingSource[firstReplacement].sourceEventSeqs
  assert.throws(() => Session.fromRestore(session.id, missingSource, { ...session.header }, SessionLogOffset(0), 'detached'), /sourceEventSeqs must include every shadowed surface node/)
  const shadowedRoot = structuredClone(log)
  shadowedRoot[firstReplacement].surfaceOp = { op: 'replace', startSeq: log[0].seq, endSeq: log[0].seq }
  shadowedRoot[firstReplacement].sourceEventSeqs = [log[0].seq]
  assert.throws(() => Session.fromRestore(session.id, shadowedRoot, { ...session.header }, SessionLogOffset(0), 'detached'), /node 0 holds the system prompt/)
})

test('installed DSH surface rejects missing replacement attribution and protected-root shadowing; empty developer nodes retain human originals', { timeout: 5000 }, async () => {
  const { Session, SessionId, deriveEventMessage, isAppendSurfaceEvent } = await import(pathToFileURL(path.join(DSH, 'packages/core/session/lib/index.js')).href)
  const llm = await import(pathToFileURL(path.join(DSH, 'packages/llm/llm/lib/index.js')).href)
  const session = Session.create(SessionId('native-empty-replacement-policy'))
  const root = session.append('system/message', { message: llm.createSystemMessage({ content: [text('standard system root')] }) }, { surfaceOp: 'append' })
  const user = llm.createUserMessage({ source: { kind: 'user' }, content: [text('direct user')] })
  session.append('user/message', user, { surfaceOp: 'append' })
  const call = session.append('tool/call', { turn: 1, step: 0, callId: 'native-observation', name: 'bash', arguments: '{}' })
  const result = session.append('tool/result', { turn: 1, step: 0, message: llm.createToolResultMessage({ callId: 'native-observation', content: [text('human-only native output')], isError: false }) }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
  const empty = { turn: 1, step: 0, message: llm.createDeveloperMessage({ source: { kind: 'tool-registry' }, content: [] }) }
  const before = session.snapshotEvents()
  assert.throws(() => session.append('developer/message', empty, { surfaceOp: { op: 'replace', startSeq: result.seq, endSeq: result.seq } }), /sourceEventSeqs must include every shadowed surface node/)
  assert.throws(() => session.append('developer/message', empty, { surfaceOp: { op: 'replace', startSeq: root.seq, endSeq: root.seq }, sourceEventSeqs: [root.seq] }), /node 0 holds the system prompt/)
  assert.deepEqual(session.snapshotEvents(), before, 'Invalid attribution/root transitions must be atomic')
  const hidden = session.append('developer/message', empty, { surfaceOp: { op: 'replace', startSeq: result.seq, endSeq: result.seq }, sourceEventSeqs: [result.seq] })
  assert.equal(deriveEventMessage(hidden), null)
  assert.deepEqual(session.deriveMessages().map(message => message.role), ['system', 'user'])
  assert.ok(session.snapshotEvents().filter(isAppendSurfaceEvent).includes(result))
  assert.ok(!session.snapshotEvents().filter(isAppendSurfaceEvent).includes(hidden))
  // User events are passed through verbatim by DSH. A wrapped payload is not
  // rejected at append; it instead derives a malformed object without a role.
  const malformed = Session.create(SessionId('wrapped-user-projection'))
  const wrapped = malformed.append('user/message', { turn: 1, step: 0, message: user }, { surfaceOp: 'append' })
  assert.equal(deriveEventMessage(wrapped).role, undefined, 'A wrapped user DATA envelope is NOT a usable model message')
  const raw = session.append('user/message', llm.createUserMessage({ source: { kind: 'user' }, content: [text('raw steer input')] }), { surfaceOp: 'append' })
  assert.equal(deriveEventMessage(raw).role, 'user')
  assert.equal(deriveEventMessage(raw).content[0].text, 'raw steer input')
})
