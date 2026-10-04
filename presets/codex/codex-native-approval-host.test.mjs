// Offline production interaction proof: real Cordis + SessionController +
// ApprovalService + UserQuestionService. Only the native RPC peer is fake.
// No native process, API/model endpoint, auth, or personal credential access.
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { installedCatalog, installedDshRoot } from './codex-test-environment.mjs'
import { installNativeBridge } from './codex-native.mjs'

const DSH = process.env.DSH_CODEX_TEST_DSH_ROOT ?? installedDshRoot()
const CATALOG = process.env.DSH_CODEX_TEST_CATALOG ?? installedCatalog
const SCRIPT = "printf 'LIVE_APPROVED_ONCE\\n' > approval-once.txt"
// Exact synthetic live audit rendering. This is a comparison fixture, not a
// shell parser or executable: neither script nor interpreter is ever run.
const SHELL = '/nix/store/1mv3qz005gkbalxfghk4y3s8ayv4d2dl-bash-interactive-5.3p15/bin/bash'
const RENDERED = `${SHELL} -c ${JSON.stringify(SCRIPT)}`
const METHOD = 'item/commandExecution/requestApproval'
const importFile = filename => import(pathToFileURL(filename).href)

if (process.env.DSH_CODEX_APPROVAL_HOST_ISOLATED !== '1') {
  test('offline real host native approval in an allowlisted isolated process', { timeout: 60_000 }, async t => {
    const work = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-native-approval-host-'))
    const home = path.join(work, 'home'), tmp = path.join(work, 'tmp')
    await fs.mkdir(home)
    await fs.mkdir(tmp)
    const env = { PATH: `${path.dirname(process.execPath)}:/run/current-system/sw/bin:/usr/bin:/bin`,
      HOME: home, DSH_HOME: path.join(home, '.dsh'), CODEX_HOME: path.join(home, '.codex'),
      XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'), TMPDIR: tmp,
      USER: 'offline-native-approval', LOGNAME: 'offline-native-approval', LANG: 'C.UTF-8', TZ: 'UTC',
      DO_NOT_TRACK: '1', OTEL_SDK_DISABLED: 'true', DSH_CODEX_APPROVAL_HOST_ISOLATED: '1',
      DSH_CODEX_APPROVAL_HOST_WORK: work, DSH_CODEX_TEST_DSH_ROOT: DSH, DSH_CODEX_TEST_CATALOG: CATALOG }
    const child = spawn(process.execPath, ['--test', fileURLToPath(import.meta.url)], { cwd: work, env,
      stdio: ['ignore', 'pipe', 'pipe'] })
    const output = [], errors = []
    child.stdout.on('data', data => output.push(data))
    child.stderr.on('data', data => errors.push(data))
    const timer = setTimeout(() => child.kill('SIGTERM'), 50_000)
    try {
      const [code, signal] = await new Promise((resolve, reject) => {
        child.once('error', reject)
        child.once('exit', (code, signal) => resolve([code, signal]))
      })
      const stdout = Buffer.concat(output).toString('utf8'), stderr = Buffer.concat(errors).toString('utf8')
      await fs.writeFile(path.join(work, 'stdout'), stdout)
      await fs.writeFile(path.join(work, 'stderr'), stderr)
      assert.equal(code, 0, `Offline approval host failed (${signal ?? ''})\n${stdout}\n${stderr}`)
      t.diagnostic(stdout.trim())
      t.diagnostic(`Offline evidence: ${work}`)
    } finally { clearTimeout(timer) }
  })
} else {
  test('real scoped approval identity, exact once selection, and harness failure reproduction', { timeout: 40_000 }, async t => {
    const work = process.env.DSH_CODEX_APPROVAL_HOST_WORK
    const cwd = path.join(work, 'workspace'), dshHome = process.env.DSH_HOME
    const root = path.join(dshHome, '.agent-presets/codex'), emptyInstructions = path.join(work, 'empty-instructions')
    for (const directory of [cwd, root, emptyInstructions, path.join(dshHome, 'profiles')])
      await fs.mkdir(directory, { recursive: true })
    await fs.symlink(path.join(DSH, 'node_modules'), path.join(dshHome, 'node_modules'))
    await fs.symlink(path.join(DSH, 'node_modules'), path.join(dshHome, 'profiles/node_modules'))
    await fs.copyFile(CATALOG, path.join(root, 'codex-models.json'))
    await fs.writeFile(path.join(cwd, 'AGENTS.md'), 'Synthetic offline approval fixture; never execute any script.\n')
    process.chdir(cwd)
    const require = createRequire(path.join(DSH, 'package.json'))
    const namespaces = new Map()
    const module = name => {
      if (!namespaces.has(name)) namespaces.set(name, importFile(require.resolve(name)))
      return namespaces.get(name)
    }
    const [{ Context }, { default: Loader }, { default: Group }, kit, scope] = await Promise.all([
      module('@deepseek-ai/cordis'), module('@deepseek-ai/cordis-plugin-loader'),
      module('@deepseek-ai/cordis-plugin-group'), module('@deepseek-ai/dsh-agent-loop-testkit'),
      module('@deepseek-ai/dsh-scope')])
    let scenario, activeAgentCtx, providerCalls = 0, nativeClients = 0, activeTrace
    const results = [], rpcCalls = []
    const ctx = new Context()
    t.after(() => ctx.fiber.dispose())
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
    await plugin('@deepseek-ai/dsh-sandbox-policy', { mode: 'read-only', workspaceRoot: cwd })
    await plugin('@deepseek-ai/dsh-user-approval', { policy: 'ask' })
    await plugin('@deepseek-ai/dsh-user-questions')
    await plugin('@deepseek-ai/dsh-llm-pi-ai', { providers: { openai: { models: [{ id: 'gpt-5.5' }],
      retryPolicy: { mode: 'normal', maxRetries: 0 }, transport: 'sse' } } })
    await plugin('@deepseek-ai/dsh-agent-default-model', { provider: 'openai', model: 'gpt-5.5' })
    await kit.mountAgentLoopTestHarness(ctx)
    await plugin('@deepseek-ai/dsh-agent-preset-registry', { default: 'codex' })

    const unrelatedScope = scope.createScope(ctx, {})
    t.after(() => unrelatedScope.dispose())
    // Instrument the REAL service dispatch, forwarding the exact args and this.
    // No listener is supplied by instrumentation, and no request is replaced.
    {
      const waterfall = ctx.waterfall
      ctx.waterfall = function (...args) {
        const [carrier, event, req] = args
        if (event === 'approval/request' || event === 'user-questions/request') {
          assert.equal(scope.isScopeCarrier(carrier), true)
          assert.notEqual(carrier, req)
          assert.equal(scope.carrierKeyOf(carrier), req.agent, 'Actual SDK scope key is the exact agent')
          assert.equal(req.agent, ctx.agents.get(req.agent.id), 'Exact live root, not a proxy or routing carrier')
          assert.equal(carrier[Context.filter](activeAgentCtx), true, 'Actual scoped listener is admitted')
          assert.equal(carrier[Context.filter](unrelatedScope.ctx), false, 'Unrelated agent scope is excluded')
          if (event === 'approval/request') { activeTrace.approvalRequest = req; activeTrace.approvalDispatches++ }
          else { activeTrace.questionDispatches++; activeTrace.questionRequest = req }
        }
        return waterfall.apply(this, args)
      }
    }
    ctx.loader.builtins['native-approval-offline'] = { name: 'native-approval-offline', inject: ['llm', 'tools'],
      async apply(agentCtx) {
        activeAgentCtx = agentCtx
        // Observe the identity reaching the production request-local answerer.
        const on = agentCtx.on
        agentCtx.on = function (event, listener, options) {
          if (event === 'approval/request' && options?.prepend === true) {
            const nativeListener = listener
            listener = function (incoming, next) {
              assert.equal(incoming, activeTrace.approvalRequest)
              activeTrace.nativeListenerCalls++
              return nativeListener.call(this, incoming, next)
            }
          }
          return on.call(this, event, listener, options)
        }
        const bridge = await installNativeBridge(agentCtx, { dshHome, presetRoot: root,
          globalInstructionsHome: emptyInstructions, executable: '/offline/forbidden-native-process', authMode: 'native' }, {
          auth: { credentials() { assert.fail('No auth or account callback is permitted') } },
          createClient(options) {
            nativeClients++
            const client = { isClosed: false,
              async start() { return { userAgent: 'offline-native-approval' } },
              async request(method, params) {
                rpcCalls.push(method)
                if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: 'offline-approval-thread' } }
                assert.equal(method, 'turn/start', 'No process, auth, or other native operations')
                const turnId = `offline-turn-${results.length}`
                queueMicrotask(async () => {
                  try {
                    const p = { threadId: params.threadId, turnId }
                    options.onNotification('turn/started', { threadId: params.threadId, turn: { id: turnId, status: 'inProgress' } })
                    // Official experimental RPC shape, based on native-interaction.test.
                    const approval = { ...p, kind: 'command', itemId: 'offline-command',
                      startedAtMs: 1700000000000, approvalId: null, environmentId: null,
                      reason: 'Create exactly the synthetic one-action marker', command: scenario.command ?? RENDERED, cwd,
                      commandActions: [{ type: 'unknown', command: scenario.command ?? RENDERED }],
                      networkApprovalContext: null, additionalPermissions: null,
                      proposedExecpolicyAmendment: null, proposedNetworkPolicyAmendments: null,
                      availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'], ...scenario.params }
                    const noPolicy = !approval.networkApprovalContext && !approval.additionalPermissions
                      && !approval.proposedExecpolicyAmendment && !approval.proposedNetworkPolicyAmendments
                    const exact = scenario.rawGate ? approval.command === SCRIPT : approval.command === RENDERED
                    activeTrace.candidate = exact && approval.kind === 'command' && approval.cwd === cwd && noPolicy
                      && activeTrace.approvals === 0
                    activeTrace.active = activeTrace.candidate
                    activeTrace.questionId = `native-approval:${approval.approvalId ?? approval.itemId ?? 'decision'}`
                    const response = await options.onRequest(METHOD, approval, 'offline-rpc-approval', new AbortController().signal)
                    const result = { name: scenario.name, response, trace: activeTrace }
                    results.push(result)
                    if (scenario.repeat) {
                      activeTrace.active = false // Global once grant remains consumed.
                      result.repeatResponse = await options.onRequest(METHOD, approval, 'offline-rpc-repeat', new AbortController().signal)
                    }
                    options.onNotification('item/completed', { ...p, item: { id: 'offline-answer', type: 'agentMessage',
                      text: 'OFFLINE_APPROVAL_COMPLETE', phase: 'final_answer' } })
                    options.onNotification('turn/completed', { threadId: params.threadId,
                      turn: { id: turnId, status: 'completed', error: null } })
                  } catch (error) {
                    activeTrace.error = error
                    options.onNotification('turn/completed', { threadId: params.threadId,
                      turn: { id: turnId, status: 'failed', error: { message: error.message } } })
                  }
                })
                return { turn: { id: turnId, status: 'inProgress' } }
              },
              async close() { client.isClosed = true },
            }
            return client
          },
        })
        agentCtx.on('llm/stream', () => { providerCalls++; assert.fail('Original provider/model calls are forbidden') })
        agentCtx.on('approval/request', () => { activeTrace.genericApprovalCalls++; return 'rejected' })
        agentCtx.on('user-questions/request', request => {
          activeTrace.answererCalls++
          assert.equal(request, activeTrace.questionRequest, 'Real userQuestions waterfall payload reaches the scoped answerer')
          assert.equal(request.questions.length, 1)
          const question = request.questions[0]
          if (!activeTrace.active || activeTrace.approvals !== 0 || question.id !== activeTrace.questionId) {
            throw new Error('UNEXPECTED_QUESTION_DENIED')
          }
          const once = question.options.find(option => /^\d+\. Allow once$/.test(option.label))
          assert.ok(once)
          activeTrace.active = false
          activeTrace.approvals++
          if (scenario.mutateOptions) question.options[0].label = 'UNAUTHORIZED_REWRITE'
          return { answers: [{ id: question.id, selected: [once.label], ...(scenario.badCustom ? { custom: [] } : {}) }] }
        })
        return () => bridge.dispose()
      } }
    await ctx.plugin({ inject: ['agentPresets'], async* apply(child) {
      yield await child.agentPresets.register({ id: 'codex', plugins: [{ id: 'native-approval-offline', name: 'cordis:native-approval-offline' }] })
    } })
    await plugin('@deepseek-ai/dsh-api-session-controller', { nativeOpen: false })
    const { sessionId } = await ctx.sessionController.create({ sessionId: 'offline-real-native-approval', cwd, agentPreset: 'codex' })
    const agent = ctx.agents.get(sessionId)
    assert.ok(ctx.agents.roots().includes(agent))
    const cases = [
      { name: 'raw-exact-script-control', command: SCRIPT, rawGate: true, expected: 'accept', outcome: 'allowed-once' },
      { name: 'live-rendered-command-raw-gate-fails', rawGate: true, expected: 'decline', outcome: 'unavailable' },
      { name: 'exact-rendered-command-bad-custom-array-fails', badCustom: true, expected: 'decline', outcome: 'unavailable' },
      { name: 'exact-rendered-command-correct-answer-once', expected: 'accept', outcome: 'allowed-once' },
      { name: 'second-exact-request-cannot-reuse-once-grant', repeat: true, expected: 'accept', outcome: 'allowed-once' },
      { name: 'broad-offered-decisions-still-select-only-once', params: { availableDecisions: ['accept', 'acceptForSession',
        { acceptWithExecpolicyAmendment: { execpolicy_amendment: [SHELL, '-c'] } },
        { applyNetworkPolicyAmendment: { network_policy_amendment: { host: 'example.test', action: 'allow' } } },
        'decline', 'cancel'] }, expected: 'accept', outcome: 'allowed-once' },
      { name: 'mismatched-script-denied', command: RENDERED + '; echo EXTRA', expected: 'decline', outcome: 'unavailable' },
      { name: 'mismatched-cwd-denied', params: { cwd: '/outside' }, expected: 'decline', outcome: 'unavailable' },
      { name: 'network-context-denied', params: { networkApprovalContext: { host: 'example.test', protocol: 'https' } }, expected: 'decline', outcome: 'unavailable' },
      { name: 'exec-amendment-denied', params: { proposedExecpolicyAmendment: [SHELL, '-c'] }, expected: 'decline', outcome: 'unavailable' },
      { name: 'network-amendment-denied', params: { proposedNetworkPolicyAmendments: [{ host: 'example.test', action: 'allow' }] }, expected: 'decline', outcome: 'unavailable' },
      { name: 'permission-profile-denied', params: { additionalPermissions: { network: { enabled: true }, fileSystem: null } }, expected: 'decline', outcome: 'unavailable' },
      { name: 'unknown-decision-denied', params: { availableDecisions: ['accept', { newDecisionType: true }] }, expected: 'decline', noAudit: true },
      { name: 'unknown-network-action-denied', params: { availableDecisions: ['accept',
        { applyNetworkPolicyAmendment: { network_policy_amendment: { host: 'example.test', action: 'future' } } }] }, expected: 'decline', noAudit: true },
      { name: 'unknown-kind-denied', params: { kind: 'new-kind' }, expected: 'decline', noAudit: true },
      { name: 'stdin-kind-not-a-command-denied', params: { kind: 'writeStdin' }, expected: 'decline', outcome: 'unavailable' },
      { name: 'detached-options-cannot-authorize-rewrite', mutateOptions: true, expected: 'decline', outcome: 'unavailable' },
      { name: 'standing-never-denied', never: true, expected: 'decline', outcome: 'rejected' },
    ]
    for (scenario of cases) {
      activeTrace = { approvalDispatches: 0, questionDispatches: 0, nativeListenerCalls: 0,
        answererCalls: 0, genericApprovalCalls: 0, approvals: 0 }
      // Fixture-local config only; real policyFor must carry never into the native thread.
      ctx.approval.config.policy = scenario.never ? 'never' : 'ask'
      const start = agent.session.seq
      const accepted = await ctx.sessionController.prompt({ sessionId, requestId: `rpc-${scenario.name}`, mode: 'queue',
        clientTimeZone: 'UTC', content: [{ type: 'text', text: `Synthetic offline case: ${scenario.name}` }] }, new AbortController().signal)
      assert.equal(accepted.accepted, true)
      let timer
      try {
        await Promise.race([agent.whenIdle(), new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Offline approval timed out: ${scenario.name}`)), 5000)
        })])
      } finally { clearTimeout(timer) }
      assert.equal(activeTrace.error, undefined)
      const result = results.at(-1)
      assert.equal(result.name, scenario.name)
      assert.deepEqual(result.response, { decision: scenario.expected }, scenario.name)
      if (scenario.repeat) assert.deepEqual(result.repeatResponse, { decision: 'decline' })
      const log = agent.session.snapshotEvents().slice(start)
      assert.equal(log.filter(event => event.type === 'turn/end').at(-1).data.reason.kind, 'completed')
      assert.equal(log.some(event => event.type === 'approval/policy' || event.type === 'sandbox/mode'), false,
        'A native choice must never append host permission/policy changes')
      const audit = log.filter(event => event.type === 'approval/asked' || event.type === 'approval/decided')
      assert.equal(audit.length, scenario.noAudit ? 0 : scenario.repeat ? 4 : 2, scenario.name)
      for (let i = 0; i < audit.length; i += 2) {
        assert.equal(audit[i].data.id, audit[i + 1].data.id)
        assert.equal(audit[i + 1].data.outcome, i === 0 ? scenario.outcome : 'unavailable', scenario.name)
        assert.ok(log.findIndex(event => event.type === 'turn/start') < log.indexOf(audit[i]))
        assert.ok(log.indexOf(audit[i + 1]) < log.findIndex(event => event.type === 'turn/end'))
      }
      assert.equal(activeTrace.genericApprovalCalls, 0, 'Native identity-filtered listener must own only its request')
      if (!scenario.noAudit && !scenario.never) {
        const asks = scenario.repeat ? 2 : 1
        assert.equal(activeTrace.approvalDispatches, asks)
        assert.equal(activeTrace.nativeListenerCalls, asks)
        assert.equal(activeTrace.questionDispatches, asks)
        assert.equal(activeTrace.answererCalls, asks)
      } else assert.equal(activeTrace.questionDispatches, 0)
      if (scenario.expected === 'accept') assert.equal(activeTrace.approvals, 1)
      t.diagnostic(`${scenario.name}: ${scenario.expected} / ${scenario.outcome ?? 'no audit'}`)
    }
    assert.equal(providerCalls, 0)
    assert.equal(nativeClients, 1, 'All RPCs use only the fake native client')
    assert.ok(!rpcCalls.some(method => /account|auth|login/.test(method)))
    assert.deepEqual(await fs.readdir(cwd), ['AGENTS.md'], 'No script, native execution, or write occurred')
    await ctx.sessions.flush(agent.session)
    const disk = await ctx.sessionPersistence.open(sessionId, 'read')
    await disk.close()
    const summary = { dsh: DSH, nativeProcessSpawns: 0, modelApiCalls: providerCalls, authCalls: 0,
      realSessionController: true, realScopedServices: true, realV4DiskAdmission: true,
      requestIdentityPreserved: true, renderedCommand: RENDERED,
      cases: results.map(({ name, response, repeatResponse, trace }) => ({ name, decision: response.decision,
        ...(repeatResponse ? { repeatDecision: repeatResponse.decision } : {}),
        candidate: trace.candidate, approvals: trace.approvals, answererCalls: trace.answererCalls })) }
    await fs.writeFile(path.join(work, 'summary.json'), JSON.stringify(summary, null, 2))
  })
}
