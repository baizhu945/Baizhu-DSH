// Run: node --test codex-native-host.test.mjs
// Production Cordis Loader, preset registry, AgentLoop, strict Session and pi-ai.
// Only the loopback model HTTP service is scripted. No activation/install/auth.
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { installedBinary, installedCatalog, installedDshRoot } from './codex-test-environment.mjs'
import { installNativeBridge, NATIVE_PROVIDER } from './codex-native.mjs'

const DSH = process.env.DSH_NATIVE_HOST_ROOT ?? process.env.DSH_CODEX_TEST_DSH_ROOT ?? installedDshRoot()
const BINARY = process.env.DSH_NATIVE_HOST_BINARY ?? process.env.DSH_CODEX_TEST_BINARY ?? installedBinary
const CATALOG = process.env.DSH_NATIVE_HOST_CATALOG ?? process.env.DSH_CODEX_TEST_CATALOG ?? installedCatalog
const PRIVATE = 'DSH_HOST_PERSONA_MUST_NOT_REACH_NATIVE_MODEL'
const text = value => ({ type: 'text', text: value })
const answer = value => ({ type: 'message', role: 'assistant', id: 'mock-answer', status: 'completed',
  content: [{ type: 'output_text', text: value, annotations: [] }] })
const functionCall = (call_id, name, args) => ({ type: 'function_call', call_id, name, arguments: JSON.stringify(args) })
const patchCall = patch => ({ type: 'custom_tool_call', call_id: 'host-patch', name: 'apply_patch', input: patch })
const importFile = filename => import(pathToFileURL(filename).href)

if (process.env.DSH_NATIVE_HOST_ISOLATED !== '1') {
  test('configured DSH native host smoke in an allowlisted isolated process', { timeout: 120_000 }, async t => {
    const work = process.env.DSH_NATIVE_HOST_OUTPUT ?? await fs.mkdtemp(path.join(os.tmpdir(), 'codex-native-host-run-'))
    assert.ok(work.startsWith('/tmp/'), 'Logs and isolation must stay under /tmp')
    const home = path.join(work, 'home')
    const tmp = path.join(work, 'tmp')
    await fs.mkdir(home, { recursive: true })
    await fs.mkdir(tmp, { recursive: true })
    const env = { PATH: `${path.dirname(process.execPath)}:/run/current-system/sw/bin:/usr/bin:/bin`,
      HOME: home, DSH_HOME: path.join(home, '.dsh'), CODEX_HOME: path.join(home, '.codex'),
      XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'),
      TMPDIR: tmp, USER: 'dsh-local-host-test', LOGNAME: 'dsh-local-host-test', LANG: 'C.UTF-8', TZ: 'UTC',
      DO_NOT_TRACK: '1', OTEL_SDK_DISABLED: 'true', DSH_NATIVE_HOST_ISOLATED: '1',
      DSH_NATIVE_HOST_ROOT: DSH, DSH_NATIVE_HOST_BINARY: BINARY, DSH_NATIVE_HOST_CATALOG: CATALOG,
      DSH_NATIVE_HOST_OUTPUT: work }
    const child = spawn(process.execPath, ['--test', fileURLToPath(import.meta.url)], { cwd: work, env,
      stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks = [], errors = []
    child.stdout.on('data', data => chunks.push(data))
    child.stderr.on('data', data => errors.push(data))
    const timer = setTimeout(() => child.kill('SIGTERM'), 100_000)
    try {
      const [code, signal] = await new Promise((resolve, reject) => {
        child.once('error', reject)
        child.once('exit', (code, signal) => resolve([code, signal]))
      })
      const stdout = Buffer.concat(chunks).toString('utf8'), stderr = Buffer.concat(errors).toString('utf8')
      await fs.writeFile(path.join(work, 'smoke.stdout'), stdout)
      await fs.writeFile(path.join(work, 'smoke.stderr'), stderr)
      t.diagnostic(`Isolated logs: ${work}`)
      assert.equal(code, 0, `Isolated smoke failed (${signal ?? ''})\n${stdout}\n${stderr}`)
      t.diagnostic(stdout.trim())
    } finally { clearTimeout(timer) }
  })
} else {
  test('real AgentLoop native turns, strict replay, gated UI and original-provider standard reuse', { timeout: 90_000 }, async t => {
    const work = process.env.DSH_NATIVE_HOST_OUTPUT
    const cwd = path.join(work, 'workspace')
    const root = path.join(process.env.DSH_HOME, '.agent-presets', 'codex')
    const emptyInstructions = path.join(work, 'empty-global-instructions')
    for (const dir of [cwd, root, emptyInstructions, path.join(process.env.DSH_HOME, 'profiles')])
      await fs.mkdir(dir, { recursive: true })
    await fs.symlink(path.join(DSH, 'node_modules'), path.join(process.env.DSH_HOME, 'node_modules'))
    await fs.copyFile(CATALOG, path.join(root, 'codex-models.json'))
    await fs.writeFile(path.join(cwd, 'AGENTS.md'), 'LOCAL_PROJECT_INSTRUCTION: operate only in this temporary workspace.\n')
    process.chdir(cwd)
    const require = createRequire(path.join(DSH, 'package.json'))
    const module = name => importFile(require.resolve(name))
    const [{ Context }, { default: Loader }, { default: Group }, kit, llm, sessionLib,
      { default: Presets }, piAi, { default: SandboxPolicy }, { default: Approval }] = await Promise.all([
      module('@deepseek-ai/cordis'), module('@deepseek-ai/cordis-plugin-loader'), module('@deepseek-ai/cordis-plugin-group'),
      module('@deepseek-ai/dsh-agent-loop-testkit'), module('@deepseek-ai/dsh-llm'), module('@deepseek-ai/dsh-session'),
      module('@deepseek-ai/dsh-agent-preset-registry'), module('@deepseek-ai/dsh-llm-pi-ai'),
      module('@deepseek-ai/dsh-sandbox-policy'), module('@deepseek-ai/dsh-user-approval'),
    ])
    const { Session, SessionId, SessionLogOffset, deriveEventMessage, isAppendSurfaceEvent, isReplacementSurfaceEvent } = sessionLib
    const requests = [], mockErrors = [], sockets = new Set()
    let nativeCount = 0, standardCount = 0, standardAllowed = false
    const patch = '*** Begin Patch\n*** Add File: host-native-patch.txt\n+HOST_NATIVE_PATCH_FILE\n*** End Patch\n'
    const server = http.createServer(async (req, res) => {
      try {
        assert.equal(req.method, 'POST', 'No external model/catalog/telemetry traffic is allowed')
        const route = req.url
        assert.ok(['/native/v1/responses', '/standard/v1/responses'].includes(route), `Unexpected request: ${route}`)
        const chunks = []
        let size = 0
        for await (const chunk of req) { size += chunk.length; assert.ok(size < 4 * 1024 * 1024); chunks.push(chunk) }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        // Capture model body and harmless provenance, never raw authorization.
        requests.push({ route, body, headers: { host: req.headers.host, 'user-agent': req.headers['user-agent'] } })
        let items
        if (route === '/native/v1/responses') {
          assert.equal(req.headers.authorization, undefined, 'Authless official mock must receive no credentials')
          const index = nativeCount++
          assert.ok(!JSON.stringify(body).includes(PRIVATE), 'No DSH persona in official model body')
          assert.ok(!JSON.stringify(body).includes('codex_native_observer'), 'Private marker cannot become a model tool')
          if (index === 0) items = [functionCall('host-shell', 'exec_command', {
            cmd: "printf 'HOST_NATIVE_SHELL_OUTPUT\\n' > host-native-shell.txt; printf 'HOST_NATIVE_SHELL_OUTPUT\\n'",
            login: false, yield_time_ms: 1000,
          })]
          else if (index === 1) items = [patchCall(patch)]
          else if (index === 2) items = [answer('HOST_NATIVE_FIRST_COMPLETE')]
          else { assert.equal(index, 3); items = [answer('HOST_NATIVE_FOLLOWUP_COMPLETE')] }
        } else {
          assert.ok(standardAllowed, 'Native middleware must prevent original provider HTTP')
          assert.equal(req.headers.authorization, 'Bearer local-mock-only-not-a-real-key')
          standardCount++
          assert.equal(standardCount, 1)
          assert.ok(JSON.stringify(body).includes(PRIVATE), 'Standard still uses original DSH prompt assembly')
          assert.ok(!JSON.stringify(body).includes('HOST_NATIVE_SHELL_OUTPUT'), 'No orphan observational native outputs')
          assert.ok(!JSON.stringify(body).includes('HOST_NATIVE_PATCH_FILE'), 'No native patch results leak on switch')
          assert.ok(!JSON.stringify(body).includes('function_call_output'), 'No orphan native tool-result wire records')
          items = [answer('HOST_STANDARD_ORIGINAL_PROVIDER_COMPLETE')]
        }
        const id = `host-mock-${requests.length}`
        const base = { id, object: 'response', status: 'in_progress', model: 'gpt-5.5', output: [] }
        const events = [{ type: 'response.created', response: base }]
        for (const [output_index, item] of items.entries()) {
          if (route === '/standard/v1/responses') events.push({ type: 'response.output_item.added', output_index,
            item: { ...item, content: [] } })
          if (route === '/standard/v1/responses' && item.type === 'message') {
            events.push({ type: 'response.content_part.added', item_id: item.id, output_index, content_index: 0,
              part: { type: 'output_text', text: '', annotations: [] } })
            events.push({ type: 'response.output_text.delta', item_id: item.id, output_index, content_index: 0,
              delta: item.content[0].text })
          }
          events.push({ type: 'response.output_item.done', output_index, item })
        }
        events.push({ type: 'response.completed', response: { ...base, status: 'completed', output: items,
          usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 3,
            output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 13 } } })
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'close' })
        for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
        res.end()
      } catch (error) {
        mockErrors.push(error)
        res.writeHead(500, { 'content-type': 'application/json', connection: 'close' })
        res.end(JSON.stringify({ error: { message: 'Local host fixture rejected request' } }))
      }
    })
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
    server.requestTimeout = 5000
    server.headersTimeout = 5000
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const origin = `http://127.0.0.1:${server.address().port}`
    // A non-forwarding proxy sink catches accidental external requests from native children.
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) process.env[key] = origin
    process.env.NO_PROXY = process.env.no_proxy = '127.0.0.1,localhost'
    const ctx = new Context()
    t.after(async () => {
      delete process.env.OPENAI_API_KEY
      try { await ctx.fiber.dispose() } finally {
        for (const socket of sockets) socket.destroy()
        server.closeAllConnections()
        await new Promise(resolve => server.close(resolve))
      }
    })
    await ctx.plugin(Loader)
    ctx.loader.builtins.group = Group
    await kit.mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: PRIVATE }, tools: { mode: 'native' } })
    await ctx.plugin(SandboxPolicy, { mode: 'workspace-write', workspaceRoot: cwd })
    await ctx.plugin(Approval, { policy: 'never' })
    // Native phase: real openai adapter configured with metadata/loopback endpoint only,
    // NO key, credential seam, or fake adapter. Native middleware owns generation.
    const originalProviderConfig = { providers: { openai: { baseURL: `${origin}/standard/v1`, api: 'openai-responses',
      models: [{ id: 'gpt-5.5' }], retryPolicy: { mode: 'normal', maxRetries: 0 }, transport: 'sse', streamIdleTimeoutMs: 5000 } } }
    await ctx.plugin(piAi, originalProviderConfig)
    await kit.mountAgentLoopTestHarness(ctx)
    await ctx.plugin(Presets, { default: 'codex' })
    await ctx.plugin({ inject: ['agentPresets'], async* apply(child) {
      yield await child.agentPresets.register({ id: 'codex', plugins: [{ id: 'codex-native',
        name: new URL('./codex-native.mjs', import.meta.url).href,
        config: { dshHome: process.env.DSH_HOME, presetRoot: root, globalInstructionsHome: emptyInstructions,
          executable: BINARY, authMode: 'native', modelProvider: 'localMock', nativeConfig: {
            'model_providers.localMock': { name: 'Loopback authless native host mock', base_url: `${origin}/native/v1`,
              wire_api: 'responses', requires_openai_auth: false, request_max_retries: 0, stream_max_retries: 0,
              stream_idle_timeout_ms: 5000 },
            web_search: 'disabled', 'analytics.enabled': false, 'feedback.enabled': false,
          } } }] })
      yield await child.agentPresets.register({ id: 'standard', plugins: [] })
    } })
    assert.deepEqual((await ctx.agentPresets.list()).map(row => ({ id: row.id, broken: row.broken })),
      [{ id: 'codex', broken: undefined }, { id: 'standard', broken: undefined }])
    const handle = await ctx.agents.create({ sessionId: SessionId('real-native-host-session'),
      meta: { cwd, agentPreset: 'codex' }, agentOptions: { provider: 'openai', model: 'gpt-5.5' },
      setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, 'codex') } })
    const { agent } = handle
    const marker = ctx.tools.get('codex_native_observer', agent)
    assert.ok(marker, 'Actual scoped marker must exist')
    const headersBefore = structuredClone(originalProviderConfig)
    const turn = async (input, expected) => {
      agent.followup(llm.createUserMessage({ source: { kind: 'user' }, content: [text(input)] }))
      await agent.whenIdle()
      assert.deepEqual(mockErrors, [])
      const events = agent.session.snapshotEvents()
      await fs.writeFile(path.join(work, 'session-events.json'), JSON.stringify(events, null, 2))
      await fs.writeFile(path.join(work, 'requests.json'), JSON.stringify(requests, null, 2))
      const failures = events.filter(event => event.type === 'turn/end' && event.data.reason?.kind !== 'completed')
      assert.deepEqual(failures, [], `Agent turn failed: ${JSON.stringify(failures)}`)
      const assistant = events.filter(event => event.type === 'assistant/message').at(-1)
      assert.equal(assistant?.data.message.content.filter(block => block.type === 'text').map(block => block.text).join(''), expected)
      assert.equal(agent.session.requestHeader().config.provider, 'openai', 'Original provider remains in request header')
      assert.equal(agent.session.requestHeader().config.model, 'gpt-5.5')
    }
    await turn('Perform the scripted local shell and patch operations, then answer.', 'HOST_NATIVE_FIRST_COMPLETE')
    assert.equal(nativeCount, 3)
    assert.equal(standardCount, 0, 'No original-provider HTTP in native scope')
    assert.equal(await fs.readFile(path.join(cwd, 'host-native-shell.txt'), 'utf8'), 'HOST_NATIVE_SHELL_OUTPUT\n')
    assert.equal(await fs.readFile(path.join(cwd, 'host-native-patch.txt'), 'utf8'), 'HOST_NATIVE_PATCH_FILE\n')
    await turn('Follow up on the same official native thread.', 'HOST_NATIVE_FOLLOWUP_COMPLETE')
    assert.equal(nativeCount, 4)
    assert.equal(standardCount, 0)
    assert.ok(JSON.stringify(requests[3].body).includes('HOST_NATIVE_FIRST_COMPLETE'), 'Official native thread preserves its own history')
    const log = agent.session.snapshotEvents()
    const results = log.filter(event => event.type === 'tool/result')
    assert.equal(results.length, 2)
    for (const result of results) {
      const replacement = log[log.indexOf(result) + 1]
      assert.equal(replacement.type, 'developer/message')
      assert.ok(isReplacementSurfaceEvent(replacement))
      assert.deepEqual(replacement.surfaceOp, { op: 'replace', startSeq: result.seq, endSeq: result.seq })
      assert.deepEqual(replacement.sourceEventSeqs, [result.seq])
      assert.deepEqual(replacement.data.message.content, [])
      assert.equal(deriveEventMessage(replacement), null)
      assert.ok(isAppendSurfaceEvent(result), 'Human UI/replay retains append-origin observation')
    }
    assert.ok(!agent.session.deriveMessages().some(message => message.role === 'tool'))
    const replay = Session.fromRestore(agent.session.id, log, { ...agent.session.header }, SessionLogOffset(0), 'detached')
    assert.deepEqual(replay.deriveMessages(), agent.session.deriveMessages(), 'Strict restored surface is identical')
    const firstReplacement = log.findIndex(isReplacementSurfaceEvent)
    const invalid = structuredClone(log)
    delete invalid[firstReplacement].sourceEventSeqs
    assert.throws(() => Session.fromRestore(agent.session.id, invalid, { ...agent.session.header }, SessionLogOffset(0), 'detached'),
      /sourceEventSeqs must include every shadowed surface node/)
    const invalidRoot = structuredClone(log)
    const rootSeq = log.find(event => event.type === 'system/message').seq
    invalidRoot[firstReplacement].surfaceOp = { op: 'replace', startSeq: rootSeq, endSeq: rootSeq }
    invalidRoot[firstReplacement].sourceEventSeqs = [rootSeq]
    assert.throws(() => Session.fromRestore(agent.session.id, invalidRoot, { ...agent.session.header }, SessionLogOffset(0), 'detached'),
      /holds the system prompt/)
    await checkReadableUi(require, work, cwd, log, results)

    // Public select intentionally forbids changing a started Session. Exercise the
    // real trusted recompose seam without weakening that host invariant.
    await assert.rejects(ctx.agentPresets.select(agent, 'standard'), error => error.code === 'agent-preset/locked')
    await ctx.agentPresets.recompose(agent.ctx, 'standard')
    agent.session.append('agent-preset/selected', { agentPreset: 'standard' })
    assert.equal(ctx.tools.get('codex_native_observer', agent), undefined, 'Native marker no longer belongs to switched scope')
    assert.equal(ctx.agentPresets.composedPreset(agent.ctx), 'standard')
    standardAllowed = true
    // Synthetic loopback-only key introduced AFTER native turns. Never read any credential file.
    process.env.OPENAI_API_KEY = 'local-mock-only-not-a-real-key'
    await turn('Continue under the original standard openai provider.', 'HOST_STANDARD_ORIGINAL_PROVIDER_COMPLETE')
    assert.equal(nativeCount, 4, 'Switched standard scope must not call native runtime')
    assert.equal(standardCount, 1, 'Unchanged original pi-ai provider performs the standard request')
    assert.deepEqual(originalProviderConfig, headersBefore, 'Native plugin did not mutate original provider config')
    await fs.writeFile(path.join(work, 'requests.json'), JSON.stringify(requests, null, 2))
    await fs.writeFile(path.join(work, 'session-events.json'), JSON.stringify(agent.session.snapshotEvents(), null, 2))
    await fs.writeFile(path.join(work, 'summary.json'), JSON.stringify({ dsh: DSH, binary: BINARY,
      nativeRequests: nativeCount, standardRequests: standardCount, nativeResults: results.length,
      strictReplay: true, officialPromptIsolation: true, standardScopeRestored: true, publicSelectLocked: true,
      unmarkedUiEqualsPreGate: true }, null, 2))
    t.diagnostic(`Production host smoke artifacts: ${work}`)
    await handle.dispose()
  })

  test('production observer advertisements survive released-V4 JSONL cold SessionController restore without model leakage', { timeout: 45_000 }, async t => {
    const work = path.join(process.env.DSH_NATIVE_HOST_OUTPUT, 'observer-cold-restore')
    const cwd = path.join(work, 'workspace'), dshHome = path.join(work, 'dsh-home')
    const root = path.join(dshHome, '.agent-presets/codex'), emptyInstructions = path.join(work, 'empty-instructions')
    for (const directory of [cwd, root, emptyInstructions, path.join(dshHome, 'profiles')])
      await fs.mkdir(directory, { recursive: true })
    await fs.symlink(path.join(DSH, 'node_modules'), path.join(dshHome, 'node_modules'))
    await fs.symlink(path.join(DSH, 'node_modules'), path.join(dshHome, 'profiles/node_modules'))
    await fs.copyFile(CATALOG, path.join(root, 'codex-models.json'))
    const require = createRequire(path.join(DSH, 'package.json'))
    const namespaces = new Map()
    const module = name => {
      if (!namespaces.has(name)) namespaces.set(name, importFile(require.resolve(name)))
      return namespaces.get(name)
    }
    const [{ Context }, { default: Loader }, { default: Group }, kit] = await Promise.all([
      module('@deepseek-ai/cordis'), module('@deepseek-ai/cordis-plugin-loader'),
      module('@deepseek-ai/cordis-plugin-group'), module('@deepseek-ai/dsh-agent-loop-testkit')])
    const requests = [], clients = []
    let providerCalls = 0
    const mount = async () => {
      const ctx = new Context()
      try {
        await ctx.plugin(Loader)
        ctx.loader.builtins.group = Group
        await kit.mountAgentLoopTestDependencies(ctx, { tools: { mode: 'native' } })
        const plugin = async (name, config = {}) => {
          const value = await module(name)
          await ctx.plugin(value.default ?? value, config)
        }
        await plugin('@deepseek-ai/dsh-session-persistence-jsonl', { root: path.join(work, 'sessions'), compression: 'none' })
        await plugin('@deepseek-ai/dsh-session-query')
        await plugin('@deepseek-ai/dsh-storage')
        await plugin('@deepseek-ai/dsh-storage-json', { root: path.join(work, 'storage') })
        await plugin('@deepseek-ai/dsh-storage-domain', { backend: 'json' })
        await plugin('@deepseek-ai/dsh-workspace')
        await plugin('@deepseek-ai/dsh-fs-local')
        await plugin('@deepseek-ai/dsh-file-reference-local')
        await plugin('@deepseek-ai/dsh-typert-registry')
        await plugin('@deepseek-ai/dsh-commands')
        await plugin('@deepseek-ai/dsh-credentials-local', { dshHome, watch: false })
        await plugin('@deepseek-ai/dsh-attachment-local', { dshHome, maxMessageImageBytes: 1_000_000 })
        await plugin('@deepseek-ai/dsh-client-connection')
        await plugin('@deepseek-ai/dsh-client-file-upload')
        await plugin('@deepseek-ai/dsh-llm-pi-ai', { providers: { openai: { models: [{ id: 'gpt-5.5' }],
          retryPolicy: { mode: 'normal', maxRetries: 0 }, transport: 'sse' } } })
        await plugin('@deepseek-ai/dsh-agent-default-model', { provider: 'openai', model: 'gpt-5.5' })
        await kit.mountAgentLoopTestHarness(ctx)
        await plugin('@deepseek-ai/dsh-agent-preset-registry', { default: 'codex' })
        ctx.loader.builtins['native-observer-offline'] = { name: 'native-observer-offline', inject: ['llm', 'tools'],
          async apply(agentCtx) {
            const bridge = await installNativeBridge(agentCtx, { dshHome, presetRoot: root,
              globalInstructionsHome: emptyInstructions, executable: '/offline/forbidden-native-process', authMode: 'native' }, {
              auth: { credentials() { assert.fail('No account/auth callback is permitted') } },
              createClient(options) {
                const client = {
                  isClosed: false,
                  async start() { return { userAgent: 'offline-production-observer' } },
                  async request(method, params) {
                    requests.push({ method, params: structuredClone(params) })
                    if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: 'offline-native-thread' } }
                    assert.equal(method, 'turn/start', 'No native process, auth, or other server operation is permitted')
                    const turnId = 'offline-native-turn'
                    queueMicrotask(() => {
                      const p = { threadId: params.threadId, turnId }
                      options.onNotification('turn/started', { threadId: params.threadId, turn: { id: turnId, status: 'inProgress' } })
                      const pending = { id: 'offline-shell', type: 'commandExecution', command: 'printf HOST_NATIVE_SHELL_OUTPUT',
                        cwd, status: 'inProgress', aggregatedOutput: '', exitCode: null }
                      options.onNotification('item/started', { ...p, item: pending })
                      const done = { ...pending, status: 'completed', aggregatedOutput: 'HOST_NATIVE_SHELL_OUTPUT\n', exitCode: 0 }
                      options.onNotification('item/completed', { ...p, item: done })
                      options.onNotification('item/completed', { ...p, item: done })
                      // Completion-only delivery must advertise exactly once too.
                      options.onNotification('item/completed', { ...p, item: { id: 'offline-patch', type: 'fileChange', status: 'completed',
                        changes: [{ path: path.join(cwd, 'host-native-patch.txt'), kind: { type: 'add' }, diff: 'HOST_NATIVE_PATCH_FILE\n' }] } })
                      options.onNotification('item/completed', { ...p, item: { id: 'offline-answer', type: 'agentMessage',
                        text: 'OFFLINE_OBSERVER_COMPLETE', phase: 'final_answer' } })
                      options.onNotification('turn/completed', { threadId: params.threadId, turn: { id: turnId, status: 'completed', error: null } })
                    })
                    return { turn: { id: turnId, status: 'inProgress' } }
                  },
                  async close() { client.isClosed = true },
                }
                clients.push(client)
                return client
              },
            })
            agentCtx.on('llm/stream', () => { providerCalls++; assert.fail('Original-provider HTTP is forbidden') })
            return () => bridge.dispose()
          } }
        await ctx.plugin({ inject: ['agentPresets'], async* apply(child) {
          yield await child.agentPresets.register({ id: 'codex', plugins: [{ id: 'native-observer-offline', name: 'cordis:native-observer-offline' }] })
          yield await child.agentPresets.register({ id: 'standard', plugins: [] })
        } })
        await plugin('@deepseek-ai/dsh-api-session-controller', { nativeOpen: false })
        for (const service of ['agentDefaultModel', 'agents', 'attachments', 'fileUploads', 'fs', 'llm', 'sessions',
          'sessionProjections', 'sessionQuery', 'typert', 'workspaceRegistry', 'sessionController'])
          assert.ok(ctx.get(service), `Real offline controller dependency missing: ${service}`)
        return ctx
      } catch (error) { await ctx.fiber.dispose(); throw error }
    }
    let ctx = await mount()
    t.after(() => ctx.fiber.dispose())
    const { sessionId } = await ctx.sessionController.create({ sessionId: 'offline-native-observer-cold', cwd, agentPreset: 'codex' })
    const accepted = await ctx.sessionController.prompt({ sessionId, requestId: 'offline-native-observer-rpc', mode: 'queue',
      clientTimeZone: 'UTC', content: [text('Observe the scripted offline native shell and patch.')] }, new AbortController().signal)
    assert.equal(accepted.accepted, true)
    let timer
    try {
      await Promise.race([ctx.agents.get(sessionId).whenIdle(), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Offline observer controller did not become idle')), 10_000)
      })])
    } finally { clearTimeout(timer) }
    const agent = ctx.agents.get(sessionId), log = agent.session.snapshotEvents()
    assert.equal(log.filter(event => event.type === 'turn/end').at(-1).data.reason.kind, 'completed')
    const calls = log.filter(event => event.type === 'tool/call'), results = log.filter(event => event.type === 'tool/result')
    const ads = log.filter(event => event.type === 'assistant/message' && event.data.message.source.privateNativeObservation)
    assert.equal(calls.length, 2)
    assert.equal(results.length, 2)
    assert.equal(ads.length, 2, 'Duplicate notifications must not duplicate advertisements')
    for (const call of calls) {
      const advertisement = ads.find(event => event.data.message.content[0].id === call.data.callId)
      assert.deepEqual(advertisement.data.message.source, { kind: 'model', provider: NATIVE_PROVIDER,
        model: 'native-observation', privateNativeObservation: true })
      assert.deepEqual(advertisement.data.message.content[0], { type: 'tool-call', id: call.data.callId,
        name: call.data.name, arguments: call.data.arguments })
      assert.ok(advertisement.seq < call.seq)
      const shadow = log[log.indexOf(advertisement) + 1]
      assert.deepEqual(shadow.surfaceOp, { op: 'replace', startSeq: advertisement.seq, endSeq: advertisement.seq })
      assert.deepEqual(shadow.sourceEventSeqs, [advertisement.seq])
    }
    const expectedMessages = agent.session.deriveMessages()
    const assertNoModelLeak = messages => {
      assert.ok(!messages.some(message => message.role === 'tool' || message.source?.privateNativeObservation
        || message.content.some(block => block.type === 'tool-call')))
      assert.ok(!JSON.stringify(messages).includes('HOST_NATIVE_SHELL_OUTPUT'))
      assert.ok(!JSON.stringify(messages).includes('HOST_NATIVE_PATCH_FILE'))
    }
    assertNoModelLeak(expectedMessages)
    assert.ok(await ctx.sessions.flush(agent.session))
    // This is the actual released-V4 disk decoder, not detached Session replay.
    // Before the production fix it rejects the first orphan tool/call here.
    const disk = await ctx.sessionPersistence.open(sessionId, 'read')
    await disk.close()
    await checkReadableUi(require, work, cwd, log, results)
    const originalContext = ctx
    await ctx.fiber.dispose()
    ctx = await mount()
    assert.notEqual(ctx, originalContext)
    const resolved = await ctx.sessionController.agents.resolveAgent(sessionId)
    assert.equal(resolved.error, undefined)
    const restored = ctx.agents.get(sessionId)
    assert.ok(restored)
    assert.deepEqual(restored.session.snapshotEvents().slice(0, log.length), log)
    assert.deepEqual(restored.session.deriveMessages(), expectedMessages)
    assertNoModelLeak(restored.session.deriveMessages())
    assert.equal(restored.session.snapshotEvents().filter(event => event.type === 'tool/result').length, 2)
    await ctx.agentPresets.recompose(restored.ctx, 'standard')
    assert.equal(ctx.tools.get('codex_native_observer', restored), undefined)
    assertNoModelLeak(restored.session.deriveMessages())
    assert.equal(clients.length, 1, 'Cold restore mounts real production scope without starting any new native client')
    assert.equal(providerCalls, 0)
    const wire = JSON.stringify(requests)
    for (const forbidden of ['native-observation', 'privateNativeObservation', 'codex:offline-native-thread', 'HOST_NATIVE_SHELL_OUTPUT'])
      assert.ok(!wire.includes(forbidden), `UI projection leaked into native wire: ${forbidden}`)
    await fs.writeFile(path.join(work, 'observer-summary.json'), JSON.stringify({
      nativeProcessSpawns: 0, realApiCalls: 0, providerCalls, fakeNativeClients: clients.length,
      observations: calls.length, advertisedObservations: ads.length, releasedV4DiskAdmission: true,
      realSessionControllerColdRestore: true, modelHistoryShadowed: true,
    }, null, 2))
    t.diagnostic(`Production observer JSONL cold-restore artifacts: ${work}`)
  })
}

async function checkReadableUi(require, work, cwd, log, results) {
  // Bundle the built derivative's PURE UI models, not fabricated copies. All
  // compilation output stays in /tmp; existing store esbuild needs no install.
  const esbuild = require('esbuild')
  const models = path.join(DSH, 'packages/client/ui-tool/src/client/tool/models')
  const bundle = path.join(work, 'ui-models.mjs')
  await esbuild.build({ stdin: { contents: [
    `export { toolRowModel, formatToolBody } from ${JSON.stringify(path.join(models, 'tool-call-model.ts'))};`,
    `export { terminalCardModel } from ${JSON.stringify(path.join(models, 'terminal-card-model.ts'))};`,
    `export { diffCardModel } from ${JSON.stringify(path.join(models, 'diff-card-model.ts'))};`,
  ].join('\n'), resolveDir: DSH, loader: 'ts' }, outfile: bundle, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  const ui = await importFile(bundle)
  const cards = []
  for (const result of results) {
    const call = log.find(event => event.type === 'tool/call' && event.data.callId === result.data.message.toolCallId)
    const block = { kind: 'tool-result', seq: result.seq, time: result.time, callId: call.data.callId,
      call: { name: call.data.name, argsRaw: call.data.arguments }, callTime: call.time,
      content: result.data.message.content, isError: result.data.message.isError, meta: result.data.meta, subCalls: [] }
    const row = ui.toolRowModel(call.data.name, block, cwd)
    const terminal = ui.terminalCardModel(block, cwd)
    const diff = ui.diffCardModel(block)
    const body = ui.formatToolBody(row.variant, row.bodyRaw)
    assert.ok(typeof body === 'string')
    assert.ok(!body.includes('"item":'), 'Expanded native UI uses human projection rather than raw protocol JSON')
    cards.push({ name: call.data.name, block, row, body, terminal, diff })
    await fs.writeFile(path.join(work, 'ui-cards.json'), JSON.stringify({ native: cards }, null, 2))
    if (call.data.name === 'bash') {
      assert.ok(terminal, 'Real native command observation yields a terminal UI card')
      assert.equal(terminal.card.exitCode, 0)
      assert.ok(terminal.card.output.includes('HOST_NATIVE_SHELL_OUTPUT'))
      assert.ok(JSON.stringify(row).includes('HOST_NATIVE_SHELL_OUTPUT'))
    } else {
      assert.equal(call.data.name, 'apply_patch')
      // Upstream supplies a kind + raw diff, not canonical before/after fields.
      // Honest generic UI fallback is required; do not invent a before-image.
      if (diff) {
        assert.ok(JSON.stringify(diff).includes('host-native-patch.txt'))
        assert.ok(JSON.stringify(diff).includes('HOST_NATIVE_PATCH_FILE'))
      } else {
        assert.ok(row.filePath.endsWith('host-native-patch.txt'))
        assert.ok(row.output.includes('HOST_NATIVE_PATCH_FILE'), 'Raw official file change remains human-readable')
        assert.equal(row.state, 'ok')
      }
    }
  }
  // Unmarked standard functions keep their original semantics: a plain shell
  // result uses its text rather than Codex meta, plain patch has no native diff.
  const standard = { kind: 'tool-result', seq: 1, time: 1, callId: 'standard', callTime: 0,
    call: { name: 'bash', argsRaw: JSON.stringify({ command: 'printf standard', description: 'Standard shell' }) },
    content: [text('standard output')], isError: false, subCalls: [],
    meta: { _codex_native: true, exitCode: 77, output: 'native metadata must not win' } }
  const standardCard = ui.terminalCardModel(standard, cwd)
  assert.equal(standardCard.card.output, 'standard output')
  assert.notEqual(standardCard.card.exitCode, 77)
  assert.equal(ui.diffCardModel({ ...standard, call: { name: 'apply_patch', argsRaw: '{}' } }), null)
  await fs.writeFile(path.join(work, 'ui-cards.json'), JSON.stringify({ native: cards, standard: standardCard }, null, 2))
  await checkUnmarkedUiParity(esbuild, ui, work, cwd)
}

async function checkUnmarkedUiParity(esbuild, ui, work, cwd) {
  // Reconstruct ONLY pre-gate pure-model files in /tmp. Reverse the exact native
  // gate hunks, leaving existing compatibility patches intact; never touch store
  // source or live configuration. Compare complete return values, not snapshots
  // hand-written from our expectations.
  const beforeRoot = path.join(work, 'pre-native-ui-gate')
  const relativeModels = 'packages/client/ui-tool/src/client/tool/models'
  const previousModels = path.join(beforeRoot, relativeModels)
  await fs.mkdir(previousModels, { recursive: true })
  await fs.symlink(path.join(DSH, 'node_modules'), path.join(beforeRoot, 'node_modules'))
  for (const filename of ['tool-call-model.ts', 'diff-card-model.ts', 'terminal-card-model.ts', 'raw-tool-call.ts'])
    await fs.copyFile(path.join(DSH, relativeModels, filename), path.join(previousModels, filename))
  const patch = await fs.readFile(new URL('./patches/codex-readable-tools.patch', import.meta.url), 'utf8')
  const gateStart = patch.lastIndexOf('diff --git a/packages/client/ui-tool/src/client/tool/models/diff-card-model.ts')
  assert.ok(gateStart > 0, 'Pinned patch must separate native-only gate additions')
  const gate = patch.slice(gateStart).split(/(?=^diff --git )/m)
    .filter(section => section.startsWith('diff --git a/packages/client/ui-tool/src/client/tool/models/')).join('')
  const child = spawn('patch', ['--batch', '--reverse', '--fuzz=0', '-p1', '--directory', beforeRoot],
    { stdio: ['pipe', 'pipe', 'pipe'] })
  const output = []
  child.stdout.on('data', chunk => output.push(chunk))
  child.stderr.on('data', chunk => output.push(chunk))
  child.stdin.end(gate)
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
  await fs.writeFile(path.join(work, 'pre-native-ui-gate.patch.log'), Buffer.concat(output))
  assert.equal(code, 0, 'The derivative must contain the exact native gate patch (no fuzzy reverse)')
  const bundle = path.join(work, 'ui-models-before-native-gate.mjs')
  await esbuild.build({ stdin: { contents: [
    `export { toolRowModel, formatToolBody } from ${JSON.stringify(path.join(previousModels, 'tool-call-model.ts'))};`,
    `export { terminalCardModel } from ${JSON.stringify(path.join(previousModels, 'terminal-card-model.ts'))};`,
    `export { diffCardModel } from ${JSON.stringify(path.join(previousModels, 'diff-card-model.ts'))};`,
  ].join('\n'), resolveDir: beforeRoot, loader: 'ts' }, outfile: bundle, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  const before = await importFile(bundle)
  const calls = [
    ['bash', { command: 'printf standard', description: 'Standard shell' }],
    ['pwsh', { command: 'Write-Output standard', description: 'Standard pwsh' }],
    ['terminal_send', { terminal_id: 'standard-terminal', text: 'echo unchanged', submit: true }],
    ['exec', { input: 'text(await tools.read({path: "unchanged.txt"}))', description: 'Unmarked old facade' }],
    ['apply_patch', { input: '*** Begin Patch\n*** Add File: unchanged.txt\n+unchanged\n*** End Patch\n' }],
    ['write', { path: 'unchanged.txt', content: 'unchanged' }],
    ['edit', { path: 'unchanged.txt', old_text: 'before', new_text: 'after' }],
    ['read', { path: 'unchanged.txt' }],
    ['grep', { pattern: 'unchanged', path: '.' }],
    ['run_code', { code: 'print("unchanged")', description: 'Unmarked code' }],
    ['unrelated_tool', { input: 'untouched', description: 'Unmarked unrelated', _codex_native: false }],
  ]
  let cases = 0
  for (const [name, args] of calls) {
    const argsRaw = JSON.stringify(args)
    const running = { phase: 'start', callId: 'standard-parity', name, argsRaw, turn: 1, step: 1, time: 1, subCalls: [] }
    const settled = { kind: 'tool-result', seq: 1, time: 2, callId: 'standard-parity', callTime: 1,
      call: { name, argsRaw }, content: [text('plain standard output')], isError: false, subCalls: [],
      // Native-looking result metadata alone must NOT turn on the args marker gate.
      meta: { _codex_native: true, output: 'must not override plain output', exitCode: 77 } }
    for (const block of [running, settled, { ...settled, isError: true }]) {
      assert.deepEqual(ui.toolRowModel(name, block, cwd), before.toolRowModel(name, block, cwd), `Unmarked row unchanged: ${name}`)
      assert.deepEqual(ui.terminalCardModel(block, cwd), before.terminalCardModel(block, cwd), `Unmarked terminal unchanged: ${name}`)
      assert.deepEqual(ui.diffCardModel(block), before.diffCardModel(block), `Unmarked diff unchanged: ${name}`)
      const row = ui.toolRowModel(name, block, cwd)
      assert.deepEqual(ui.formatToolBody(row.variant, row.bodyRaw), before.formatToolBody(row.variant, row.bodyRaw), `Unmarked expansion unchanged: ${name}`)
      cases++
    }
  }
  await fs.writeFile(path.join(work, 'unmarked-ui-parity.json'), JSON.stringify({ comparedAgainstExactPreGateModels: true,
    cases, projectionsPerCase: ['row', 'terminal', 'diff', 'expandedBody'] }, null, 2))
}
