#!/usr/bin/env node
// Intentionally NOT named codex-*.test.mjs. Importing this file never runs live.
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { CodexAppServer } from './codex-app-server.mjs'
import { createNativeAuth } from './codex-native-auth.mjs'
import { installNativeBridge } from './codex-native.mjs'
import { MODEL, PROVIDER, Budget, check, cleanEnv, createBoundary, discover, exists,
  importFile, safeFailure, safeDiagnostics, workspaceText } from './live-support.mjs'

const CATEGORIES = ['login', 'model-routing', 'web-session-first-retry-continue-restart',
  'exec-store-load-yield-wait', 'shell-pty-stdin', 'apply-patch-readback',
  'synthetic-image-intake-codemode', 'plan-scripted-questions', 'default-update-plan', 'read-only-denial',
  'user-global-agents-instructions',
  'one-action-approval', 'v2-subagent-fork-message-wait', 'cancel-recovery',
  'official-compact-nonce-recall', 'long-output-ui-replay-standard-isolation']
const SUITES = {
  tools: ['exec-store-load-yield-wait', 'shell-pty-stdin', 'apply-patch-readback',
    'synthetic-image-intake-codemode', 'long-output-ui-replay-standard-isolation'],
  lifecycle: ['web-session-first-retry-continue-restart', 'plan-scripted-questions', 'default-update-plan',
    'v2-subagent-fork-message-wait', 'official-compact-nonce-recall'],
  safety: ['read-only-denial', 'one-action-approval', 'cancel-recovery'],
  approvals: ['one-action-approval', 'brief-xhigh'],
  'approval-once': ['one-action-approval'],
  features: ['web-session-first-retry-continue-restart', 'plan-scripted-questions', 'default-update-plan',
    'v2-subagent-fork-message-wait', 'official-compact-nonce-recall'],
  instructions: ['user-global-agents-instructions'],
  subagent: ['web-session-first-retry-continue-restart', 'v2-subagent-fork-message-wait'],
  compaction: ['official-compact-nonce-recall'],
  questions: ['plan-scripted-questions'],
}
// Generated 32x32 RGB red square with verified PNG CRCs. Nothing from the
// user's image/session directories. The old tiny fixture failed real intake.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKElEQVR4nO3NsQ0AAAzCMP5/un0CNkuZ41wybXsHAAAAAAAAAAAAxR4yw/wuPL6QkAAAAABJRU5ErkJggg=='
// Synthetic user-global instruction marker for the isolated instructions suite.
const GLOBAL_INSTRUCTION_MARKER = 'LIVE_GLOBAL_INSTRUCTION_MARKER_7f3c9a41'
const text = value => ({ type: 'text', text: value })
const approvalScript = "printf 'LIVE_APPROVED_ONCE\\n' > approval-once.txt"
const knownRequests = new Set(['account/chatgptAuthTokens/refresh', 'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval', 'item/tool/requestUserInput', 'item/permissions/requestApproval',
  'execCommandApproval', 'applyPatchApproval'])

function parse(argv) {
  const options = { preflight: false, liveBootstrap: false, allowLive: false, audited: false, xhigh: false,
    suite: 'all', deadlineSeconds: 900, maxGenerations: 48, maxTokens: 100_000 }
  const values = { '--suite': 'suite', '--dsh-root': 'dshRoot', '--binary': 'binary', '--catalog': 'catalog',
    '--deadline-seconds': 'deadlineSeconds', '--max-generations': 'maxGenerations', '--max-tokens': 'maxTokens' }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--preflight') options.preflight = true
    else if (arg === '--live-bootstrap') options.liveBootstrap = true
    else if (arg === '--allow-live') options.allowLive = true
    else if (arg === '--task9-audited') options.audited = true
    else if (arg === '--xhigh') options.xhigh = true
    else if (arg === '--help') options.help = true
    else if (Object.hasOwn(values, arg)) {
      const value = argv[++i]
      check(value && !value.startsWith('--'), 'CLI_ARGUMENT_INVALID')
      options[values[arg]] = values[arg].startsWith('max') || values[arg] === 'deadlineSeconds' ? Number(value) : value
    } else throw safeFailure('CLI_ARGUMENT_INVALID')
  }
  for (const [key, minimum, maximum] of [['deadlineSeconds', 30, 1800], ['maxGenerations', 1, 80], ['maxTokens', 1, 250_000]])
    check(Number.isSafeInteger(options[key]) && options[key] >= minimum && options[key] <= maximum, 'CLI_BUDGET_INVALID')
  check(['all', ...Object.keys(SUITES)].includes(options.suite), 'CLI_SUITE_INVALID')
  check(!options.xhigh || ['all', 'safety', 'approvals'].includes(options.suite), 'CLI_XHIGH_SUITE_INVALID')
  check(!((options.preflight || options.liveBootstrap) && options.allowLive), 'CLI_MODES_CONFLICT')
  // No arguments is the safe preflight, never a live default.
  if (!options.allowLive) options.preflight = true
  return options
}

export function evidenceLedger() {
  return { notifications: new Map(), items: new Map(), requests: new Map(), methods: new Map(),
    loginCount: 0, resumeCount: 0, approvalCandidates: 0, approvals: 0, rejectedRequests: 0,
    questions: 0, originalProviderCalls: 0, outputBytes: 0, nativeStarts: 0,
    activityListeners: new Set(), childThreads: new Set(), phase: '', approvalActive: false, approvalQuestionId: undefined }
}
const increment = (map, key) => map.set(key, (map.get(key) ?? 0) + 1)

export function exactOneActionCandidate(params, { workspace, phase, approvals }) {
  // Upstream automatically OFFERS a three-element exec-policy amendment and
  // renders the command from its argv, resolving an immutable shell itself
  // (zsh on this host, not the configured bash). Offering is NOT accepting: the
  // broker below selects only the explicit `accept` decision, never an
  // amendment/session grant. The argv must be exactly `<trusted shell> -c
  // <the fixed synthetic script>` so no arbitrary body can ever be approved.
  const proposal = params.proposedExecpolicyAmendment
  const argv = Array.isArray(proposal) && proposal.length === 3 ? proposal : undefined
  const shell = argv?.[0]
  const trustedShell = typeof shell === 'string'
    && /^\/nix\/store\/[a-z0-9]{32}-(bash|zsh)[^/]*\/bin\/(bash|zsh)$/.test(shell)
  const exactArgv = !!argv && argv[1] === '-c' && argv[2] === approvalScript
  const renderedCommand = trustedShell && exactArgv
    && params.command === `${shell} -c ${JSON.stringify(approvalScript)}`
  const network = params.proposedNetworkPolicyAmendments
  const noNetworkAmendments = network == null || Array.isArray(network) && network.length === 0
  const knownAmendments = Object.keys(params).every(key => !/amendment|proposal/i.test(key)
    || ['proposedExecpolicyAmendment', 'proposedNetworkPolicyAmendments'].includes(key))
  return phase === 'approval' && approvals === 0 && renderedCommand && params.cwd === workspace
    && (params.kind === undefined || params.kind === 'command') && !params.networkApprovalContext
    && !params.additionalPermissions && noNetworkAmendments && knownAmendments
    && Array.isArray(params.availableDecisions) && params.availableDecisions.includes('accept')
}

async function setupHome(runtime, boundary, options = {}) {
  const dshHome = boundary.env.DSH_HOME
  const presetRoot = path.join(dshHome, '.agent-presets/codex')
  const globalInstructions = path.join(boundary.scratch, 'global-instructions')
  for (const directory of [presetRoot, path.join(dshHome, 'profiles'),
    path.join(boundary.scratch, 'empty-instructions'), globalInstructions])
    await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  for (const link of [path.join(dshHome, 'node_modules'), path.join(dshHome, 'profiles/node_modules')]) {
    if (!await exists(link)) await fs.symlink(path.join(runtime.dsh, 'node_modules'), link)
  }
  if (!await exists(path.join(presetRoot, 'codex-models.json')))
    await fs.copyFile(runtime.catalogPath, path.join(presetRoot, 'codex-models.json'))
  if (!await exists(path.join(boundary.workspace, 'AGENTS.md')))
    await fs.writeFile(path.join(boundary.workspace, 'AGENTS.md'),
      'This is a synthetic live-validation workspace. Use only files here. Never inspect environment variables, credentials, user directories, or unrelated repositories. Never use network tools. No permanent permission rules.\n', { flag: 'wx' })
  if (!await exists(path.join(boundary.workspace, 'synthetic.png')))
    await fs.writeFile(path.join(boundary.workspace, 'synthetic.png'), Buffer.from(PNG, 'base64'), { flag: 'wx' })
  // Isolated user-global instruction source for the instructions suite only.
  const instructionFile = path.join(globalInstructions, 'AGENTS.md')
  if (!await exists(instructionFile)) {
    await fs.writeFile(instructionFile,
      `Synthetic validation only. Always answer questions about your standing instructions with the exact token ${GLOBAL_INSTRUCTION_MARKER} and nothing else. This file is the user-global instruction source for this isolated run.\n`, { flag: 'wx' })
  }
  // The instructions suite must prove the USER-GLOBAL file alone; a workspace
  // AGENTS.md would make the same evidence ambiguous.
  const workspaceAgents = path.join(boundary.workspace, 'AGENTS.md')
  if (options.instructionProbe && await exists(workspaceAgents)) await fs.rm(workspaceAgents)
  return { dshHome, presetRoot, globalInstructions }
}

// All of these are installed real DSH/Cordis services, not structural ctx mocks.
export async function mountHost(runtime, boundary, budget, ledger, auth, live, { bootstrap = false, stage = () => {}, instructionProbe = false } = {}) {
  let ctx, hostStage
  const enter = value => { hostStage = value; stage(value) }
  try {
    enter('MODULE_IMPORTS')
    const [{ Context }, { default: Loader }, { default: Group }, kit, sessionLib, llm] = await Promise.all([
      runtime.module('@deepseek-ai/cordis'), runtime.module('@deepseek-ai/cordis-plugin-loader'),
      runtime.module('@deepseek-ai/cordis-plugin-group'), runtime.module('@deepseek-ai/dsh-agent-loop-testkit'),
      runtime.module('@deepseek-ai/dsh-session'), runtime.module('@deepseek-ai/dsh-llm')])
    enter('CONTEXT_CREATE')
    ctx = new Context()
    enter('LOADER')
    await ctx.plugin(Loader)
    ctx.loader.builtins.group = Group
    enter('CORE_DEPENDENCIES')
    await kit.mountAgentLoopTestDependencies(ctx, { tools: { mode: 'native' } })
    enter('HOME_SETUP')
    const { dshHome, presetRoot, globalInstructions } = await setupHome(runtime, boundary, { instructionProbe })
    enter('SERVICE_PLUGINS')
    const plugin = async (name, config = {}) => {
      const module = await runtime.module(name)
      try { await ctx.plugin(module.default ?? module, config) }
      catch (error) { throw safeFailure(`HOST_PLUGIN_FAILED_${name.replace('@deepseek-ai/dsh-', '').replaceAll('-', '_').toUpperCase()}`, error) }
    }
    await plugin('@deepseek-ai/dsh-session-persistence-jsonl', { root: path.join(boundary.scratch, 'sessions'), compression: 'none' })
    await plugin('@deepseek-ai/dsh-session-checkpoint-policy')
    await plugin('@deepseek-ai/dsh-session-query')
    await plugin('@deepseek-ai/dsh-storage')
    await plugin('@deepseek-ai/dsh-storage-json', { root: path.join(boundary.scratch, 'storage') })
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
    await plugin('@deepseek-ai/dsh-sandbox-policy', { mode: 'workspace-write', workspaceRoot: boundary.workspace })
    await plugin('@deepseek-ai/dsh-user-approval', { policy: 'ask' })
    await plugin('@deepseek-ai/dsh-user-questions')
    await plugin('@deepseek-ai/dsh-llm-pi-ai', { providers: { [PROVIDER]: {
      models: [{ id: MODEL, input: ['text', 'image'], reasoningEfforts: { low: 'low', medium: 'medium', xhigh: 'xhigh' } }],
      retryPolicy: { mode: 'normal', maxRetries: 0 }, transport: 'sse' } } })
    await plugin('@deepseek-ai/dsh-agent-default-model', { provider: PROVIDER, model: MODEL, reasoningEffort: 'low' })
    enter('AGENT_LOOP')
    await kit.mountAgentLoopTestHarness(ctx)
    enter('PRESET_REGISTRY')
    await plugin('@deepseek-ai/dsh-agent-preset-registry', { default: 'codex' })
    const bridges = new Set()
    ctx.loader.builtins['codex-live-confined'] = {
        name: 'codex-live-confined', inject: ['llm', 'tools'], async apply(agentCtx) {
          const bridge = await installNativeBridge(agentCtx, { dshHome, presetRoot,
            globalInstructionsHome: instructionProbe ? globalInstructions : path.join(boundary.scratch, 'empty-instructions'), executable: runtime.binaryPath,
            runtimeVersion: runtime.binaryVersion,
            // External DSH tokens: ephemeral native login, never CODEX_HOME auth.
            authMode: 'dsh', nativeConfig: { 'analytics.enabled': false, 'feedback.enabled': false, web_search: 'disabled',
              ...(runtime.liveFeatureConfig ?? {}) } }, {
            auth: auth ?? { credentials() { throw safeFailure('PREFLIGHT_AUTH_FORBIDDEN') } },
            createClient(options) {
              check(!bootstrap, 'BOOTSTRAP_NATIVE_START_FORBIDDEN')
              check(live, 'PREFLIGHT_NATIVE_START_FORBIDDEN')
              budget.check()
              check(options.command === runtime.binaryPath && options.cwd === boundary.workspace, 'NATIVE_PREFIX_INVALID')
              check(options.env.CODEX_HOME === path.join(presetRoot, 'native-home'), 'NATIVE_HOME_INVALID')
              ledger.nativeStarts++
              let client
              client = new CodexAppServer({ ...options, command: runtime.bins.bwrap,
                args: boundary.args(options.command, options.args, true, options.env.CODEX_HOME),
                env: boundary.env, cwd: boundary.workspace,
                onNotification(method, params, signal) {
                  increment(ledger.notifications, method)
                  if (method === 'thread/started' && params.thread?.source?.subagent?.thread_spawn) {
                    ledger.childThreads.add(params.thread.id)
                    if (ledger.childThreads.size > 1) budget.stop('BUDGET_CHILD_THREADS')
                  }
                  if (method === 'item/started' || method === 'item/completed') {
                    increment(ledger.items, params.item?.type ?? 'unknown')
                    if (params.item?.type === 'agentMessage' && params.item.questions?.length) {
                      increment(ledger.methods, 'async-question-item')
                    }
                    if (params.item?.type === 'collabAgentToolCall' && /spawn|create/i.test(params.item.tool ?? '')) {
                      for (const childId of params.item.receiverThreadIds ?? []) ledger.childThreads.add(childId)
                      if (ledger.childThreads.size > 1) budget.stop('BUDGET_CHILD_THREADS')
                    }
                    if (method === 'item/started') for (const listener of ledger.activityListeners) listener(params)
                  }
                  if (method === 'item/commandExecution/outputDelta') ledger.outputBytes += Buffer.byteLength(params.delta ?? '')
                  budget.observe(method, params)
                  // Preserve the actual production callback and its cancellation signal.
                  return options.onNotification(method, params, signal)
                },
                onRequest(method, params, id, signal) {
                  increment(ledger.requests, method)
                  if (!knownRequests.has(method) || method === 'item/permissions/requestApproval') {
                    ledger.rejectedRequests++
                    throw Object.assign(new Error('Request denied'), { rpcCode: -32601 })
                  }
                  if (method === 'item/commandExecution/requestApproval') {
                    const candidate = exactOneActionCandidate(params, { workspace: boundary.workspace,
                      phase: ledger.phase, approvals: ledger.approvals })
                    ledger.approvalActive = candidate
                    ledger.approvalQuestionId = candidate ? `native-approval:${params.approvalId ?? params.itemId ?? 'decision'}` : undefined
                    if (candidate) ledger.approvalCandidates++
                  }
                  return options.onRequest(method, params, id, signal)
                },
                onClose(error) { budget.clients.delete(client); return options.onClose(error) } })
              const request = client.request.bind(client)
              // Observe method COUNTS only. Never retain/log the login/refresh payload.
              client.request = async (method, params, requestOptions) => {
                budget.check()
                increment(ledger.methods, method)
                if (method === 'turn/start') budget.turnRequests++
                if (method === 'thread/compact/start') budget.compactRequests++
                if (method === 'thread/resume') ledger.resumeCount++
                const result = await request(method, params, requestOptions)
                if (method === 'account/login/start') ledger.loginCount++
                if (method === 'thread/start' || method === 'thread/resume') {
                  const thread = result.thread
                  check(thread?.model === undefined || thread.model === MODEL, 'NATIVE_MODEL_ROUTE_MISMATCH')
                  check(result.model === undefined || result.model === MODEL, 'NATIVE_MODEL_ROUTE_MISMATCH')
                  check(result.modelProvider === undefined || result.modelProvider === 'openai', 'NATIVE_PROVIDER_ROUTE_MISMATCH')
                }
                return result
              }
              budget.clients.add(client)
              return client
            } })
          bridges.add(bridge)
          // Any missing native intercept fails BEFORE the real pi-ai adapter can
          // perform an original-provider HTTP request. Metadata remains real.
          agentCtx.on('llm/stream', () => {
            ledger.originalProviderCalls++
            throw safeFailure('ORIGINAL_PROVIDER_CALL_FORBIDDEN')
          })
          agentCtx.on('approval/request', () => {
            if (ledger.approvalActive && ledger.approvals === 0 && ledger.phase === 'approval') {
              ledger.approvalActive = false
              ledger.approvals++
              return 'allowed-once'
            }
            return 'rejected'
          })
          agentCtx.on('user-questions/request', request => {
            check(request.questions.length === 1, 'UNEXPECTED_QUESTION_DENIED')
            const question = request.questions[0]
            if (ledger.phase === 'approval' && ledger.approvalActive && ledger.approvals === 0
              && question.id === ledger.approvalQuestionId) {
              const once = question.options?.find(option => /^\d+\. Allow once$/.test(option.label))
              check(once, 'ONE_ACTION_CHOICE_MISSING')
              ledger.approvalActive = false
              ledger.approvals++
              return { answers: [{ id: question.id, selected: [once.label] }] }
            }
            check(ledger.phase === 'plan', 'UNEXPECTED_QUESTION_DENIED')
            check(question.options?.some(option => option.label === 'Synthetic blue')
              && question.options?.some(option => option.label === 'Synthetic red'), 'UNEXPECTED_QUESTION_DENIED')
            ledger.questions++
            return { answers: [{ id: question.id, selected: ['Synthetic blue'] }] }
          })
          return () => { bridges.delete(bridge); return bridge.dispose() }
        } }
    await ctx.plugin({ inject: ['agentPresets'], async* apply(child) {
      yield await child.agentPresets.register({ id: 'codex', plugins: [
        { id: 'codex-live-confined', name: 'cordis:codex-live-confined' }] })
      yield await child.agentPresets.register({ id: 'standard', plugins: [] })
    } })
    enter('SESSION_CONTROLLER')
    await plugin('@deepseek-ai/dsh-api-session-controller', { nativeOpen: false })
    enter('SERVICE_CHECK')
    const controller = ctx.sessionController
    for (const service of ['sessions', 'sessionPersistence', 'sessionQuery', 'storage', 'storageDomain',
      'workspaceRegistry', 'fs', 'fileReferences', 'typert', 'commands', 'credentials', 'attachments',
      'connection', 'fileUploads', 'llm', 'agentDefaultModel', 'sessionController'])
      check(ctx.get(service), `HOST_SERVICE_MISSING_${service.replaceAll(/([A-Z])/g, '_$1').toUpperCase()}`)
    return { ctx, controller, sessionLib, llm, bridges, dshHome, presetRoot,
      async dispose() { await ctx.fiber.dispose() } }
  } catch (error) {
    try { await ctx?.fiber.dispose() } catch {}
    throw error?.liveCode ? error : safeFailure(`HOST_SETUP_FAILED_${hostStage}`, error)
  }
}

function reportCase(report, name, exercised, passed = exercised, code) {
  report.cases[name] = { status: !exercised ? 'unexercised' : passed ? 'pass' : 'fail', ...(code ? { code } : {}) }
}
function sessionEvents(host, id) { return host.ctx.agents.get(id)?.session.snapshotEvents() ?? [] }
function assistantText(events) {
  return events.filter(event => event.type === 'assistant/message').map(event =>
    event.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('')).join('\n')
}
async function fileIs(boundary, filename, expected) {
  return await workspaceText(boundary, filename) === expected
}
// Bounded, synthetic-only read of ONE child rollout inside this run's private
// native home. Proves fork inheritance: the forked history carries the marker,
// while the spawn task that the parent authored does not.
async function childThreadText(boundary, threadId) {
  if (!threadId || !/^[0-9a-f-]{36}$/.test(threadId)) return undefined
  const root = path.join(boundary.env.DSH_HOME, '.agent-presets/codex/native-home/sessions')
  let file
  try {
    const stack = [root]
    while (stack.length && !file) {
      const directory = stack.pop()
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const candidate = path.join(directory, entry.name)
        if (entry.isDirectory()) { if (stack.length < 16) stack.push(candidate); continue }
        if (!entry.name.endsWith('.jsonl') || !entry.name.includes(threadId)) continue
        const stat = await fs.stat(candidate)
        if (stat.isFile() && stat.size <= 8_000_000) file = candidate
      }
    }
  } catch { return undefined }
  if (!file) return undefined
  const users = []
  // Bounded whole-file read: a raw byte stream is NOT line-delimited, so record
  // boundaries must come from an explicit split.
  for (const line of (await fs.readFile(file, 'utf8')).split('\n')) {
    let record
    try { record = JSON.parse(line) } catch { continue }
    const payload = record.payload
    if (payload?.type === 'message' && payload.role === 'user' && Array.isArray(payload.content)) {
      users.push(payload.content.filter(part => typeof part?.text === 'string').map(part => part.text).join(''))
      if (users.length > 64) break
    }
  }
  const spawnTask = users.at(-1) ?? ''
  const inherited = users.slice(0, -1).join('\n')
  return { spawnTask, inherited }
}
// Only paired production native telemetry. Never search assistant prose, the
// rendered tool body (which echoes input), or entire JSON-serialized events.
export function nativeItems(events) {
  const calls = new Map(events.filter(event => event.type === 'tool/call').map(event => [event.data.callId, event]))
  return events.filter(event => event.type === 'tool/result').flatMap(event => {
    const message = event.data.message, call = calls.get(message?.toolCallId), item = event.data.meta?.item
    if (!call || !item || !message.toolCallId.startsWith('codex:') || message.source?.callId !== call.data.callId) return []
    let args
    try { args = JSON.parse(call.data.arguments) } catch { return [] }
    return args._codex_native === true && args.item?.id === item.id ? [item] : []
  })
}
const codeCalls = (items, tool) => items.filter(item => item.type === 'codeExecution'
  && new RegExp(`\\btools\\.${tool}\\s*\\(`).test(item.code ?? ''))
const succeeded = item => item.completed !== false && (item.exitCode === undefined || item.exitCode === 0)
  && !['failed', 'declined', 'interrupted'].includes(item.status)
  && !/Script (?:failed|terminated)|error building bubblewrap|Exit code: [1-9]|Process exited with code [1-9]/i.test(item.output ?? item.aggregatedOutput ?? '')
const nativeOutputs = events => nativeItems(events).map(item => item.aggregatedOutput ?? item.output ?? '')
  .filter(value => typeof value === 'string').join('\n')
function verifyHeaders(events) {
  const headers = events.filter(event => event.type === 'request/header')
  check(headers.length && headers.every(event => event.data.header.config.provider === PROVIDER
    && event.data.header.config.model === MODEL), 'DSH_MODEL_ROUTE_MISMATCH')
}

async function prompt(host, id, input, phase, budget, ledger, report, { image = false, cancel = false, boundary } = {}) {
  ledger.phase = phase
  report.stage = 'live-prompt-prepare'
  budget.check()
  const request = { sessionId: id, requestId: `live-${phase}-${randomUUID()}`,
    mode: 'queue', clientTimeZone: 'UTC', content: [text(input),
      ...(image ? [{ type: 'image', mediaType: 'image/png', data: PNG }] : [])] }
  const prior = sessionEvents(host, id).length
  const oldUsage = budget.usageUpdates
  const priorTurns = budget.turnRequests
  {
    report.stage = 'live-prompt-admission'
    const admissionSignal = new AbortController().signal
    const accepted = await host.controller.prompt(request, admissionSignal)
    check(accepted?.accepted, 'WEB_PROMPT_NOT_ACCEPTED')
    const agent = host.ctx.agents.get(id)
    check(agent, 'WEB_AGENT_MISSING')
    report.stage = 'live-prompt-idle-wait'
    if (cancel) await budget.wait((async () => {
      // Nested CodeMode execution need not expose commandExecution ThreadItems.
      // A new native turn PLUS the exact actual command effect is required.
      for (let i = 0; i < 600; i++) {
        budget.check()
        if (budget.turnRequests > priorTurns && await fileIs(boundary, 'cancel-active.txt', 'LIVE_CANCEL_ACTIVE\n')) {
          await host.controller.cancel({ sessionId: id }); return
        }
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      throw safeFailure('CANCEL_ACTIVITY_NOT_OBSERVED')
    })(), 80)
    await budget.wait(agent.whenIdle(), cancel ? 100 : 180)
    report.stage = 'live-prompt-evidence'
    const events = agent.session.snapshotEvents()
    const newEvents = events.slice(prior)
    const user = newEvents.find(event => event.type === 'user/message' && event.data.source?.rpcId === request.requestId)
    check(user?.data.source?.clientTimeZone === 'UTC', 'WEB_PROMPT_SOURCE_MISSING')
    verifyHeaders(events)
    const end = newEvents.filter(event => event.type === 'turn/end').at(-1)
    check(end, 'TURN_END_MISSING')
    if (!cancel) {
      check(end.data.reason?.kind === 'completed', 'TURN_NOT_COMPLETED')
      check(budget.usageUpdates > oldUsage, 'TURN_NATIVE_USAGE_MISSING')
    } else check(end.data.reason?.kind === 'aborted', 'CANCEL_NOT_OBSERVED')
    check(ledger.originalProviderCalls === 0, 'ORIGINAL_PROVIDER_CALL_FORBIDDEN')
    // Browser retry is idempotent on the real rpcId (no second model generation).
    const turnRequests = budget.turnRequests
    report.stage = 'live-prompt-idempotent-retry'
    await host.controller.prompt(request, admissionSignal)
    await budget.wait(agent.whenIdle(), 20)
    check(budget.turnRequests === turnRequests, 'WEB_RETRY_DUPLICATED_NATIVE_TURN')
    check(sessionEvents(host, id).filter(event => event.type === 'user/message'
      && event.data.source?.rpcId === request.requestId).length === 1, 'WEB_RETRY_DUPLICATED_USER_EVENT')
    check(await host.ctx.sessions.flush(agent.session), 'JSONL_FLUSH_UNAVAILABLE')
    report.topTurns++
    report.turns.push({ case: phase, eventCount: newEvents.length, nativeUsageUpdates: budget.usageUpdates - oldUsage,
      nativeToolResults: newEvents.filter(event => event.type === 'tool/result').length,
      reason: cancel ? 'cancel-case' : 'completed' })
    report.stage = 'live-prompt-jsonl-admission-check'
    // Detached replay does not enforce advertised tool lifecycles; the actual
    // disk decoder does. Fail here, before paying for subsequent prompts.
    const stored = await host.ctx.sessionPersistence.open(id, 'read')
    await stored.close()
    return events
  }
}

async function coldResume(host, id) {
  // Query the real persisted log before the controller wraps failures into an
  // opaque RemoteError. Preserve its cause for the fixed safe diagnostics; do
  // not rewrite/delete offending events or route around JSONL admission.
  const observation = await host.ctx.sessionQuery.observeSession(id)
  observation[Symbol.dispose]()
  const resolved = await host.controller.agents.resolveAgent(id)
  if (resolved.error) throw resolved.error
  check(resolved.agent && host.ctx.agents.get(id), 'JSONL_COLD_RESTORE_FAILED')
  return resolved.agent
}

async function command(host, id, name, rawInput = '') {
  const agent = host.ctx.agents.get(id)
  check(agent, 'COMMAND_AGENT_MISSING')
  const commands = host.ctx.commands
  // Dependency-injected command activation can settle one tick after the
  // preset's ownership marker. Wait only for that local Cordis activation.
  let definition
  for (let i = 0; i < 20 && !definition; i++) {
    definition = commands.find(agent, name)
    if (!definition) await new Promise(resolve => setTimeout(resolve, 10))
  }
  check(definition, 'NATIVE_COMMAND_MISSING')
  const execution = await commands.execute(agent, `/${name}${rawInput ? ` ${rawInput}` : ''}`, [], new AbortController().signal)
  check(execution?.result?.kind === 'success', 'NATIVE_COMMAND_REJECTED')
  return execution.result
}

async function assertReplay(host, id, runtime, boundary, report) {
  const agent = host.ctx.agents.get(id)
  const events = agent.session.snapshotEvents()
  const { Session, SessionLogOffset, deriveEventMessage, isReplacementSurfaceEvent } = host.sessionLib
  const restored = Session.fromRestore(agent.session.id, events, { ...agent.session.header }, SessionLogOffset(0), 'detached')
  check(JSON.stringify(restored.deriveMessages()) === JSON.stringify(agent.session.deriveMessages()), 'STRICT_REPLAY_MISMATCH')
  const results = events.filter(event => event.type === 'tool/result')
  for (const result of results) {
    const replacement = events[events.indexOf(result) + 1]
    check(isReplacementSurfaceEvent(replacement) && deriveEventMessage(replacement) === null, 'TOOL_SURFACE_REPLAY_UNSAFE')
  }
  const esbuild = (await runtime.module('esbuild')).default
  check(esbuild?.build, 'UI_ESBUILD_MISSING')
  const directory = path.join(runtime.dsh, 'packages/client/ui-tool/src/client/tool/models')
  const output = path.join(boundary.scratch, 'live-ui-models.mjs')
  await esbuild.build({ stdin: { contents: [
    `export {toolRowModel,formatToolBody} from ${JSON.stringify(path.join(directory, 'tool-call-model.ts'))};`,
    `export {terminalCardModel} from ${JSON.stringify(path.join(directory, 'terminal-card-model.ts'))};`,
    `export {diffCardModel} from ${JSON.stringify(path.join(directory, 'diff-card-model.ts'))};`].join('\n'),
    resolveDir: runtime.dsh, loader: 'ts' }, outfile: output, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  const ui = await importFile(output)
  let cards = 0
  for (const result of results) {
    const call = events.find(event => event.type === 'tool/call' && event.data.callId === result.data.message.toolCallId)
    check(call, 'UI_CALL_MISSING')
    const block = { kind: 'tool-result', seq: result.seq, time: result.time, callId: call.data.callId,
      call: { name: call.data.name, argsRaw: call.data.arguments }, callTime: call.time,
      content: result.data.message.content, isError: result.data.message.isError, meta: result.data.meta, subCalls: [] }
    const row = ui.toolRowModel(call.data.name, block, boundary.workspace)
    check(typeof ui.formatToolBody(row.variant, row.bodyRaw) === 'string', 'UI_BODY_UNREADABLE')
    ui.terminalCardModel(block, boundary.workspace)
    ui.diffCardModel(block)
    cards++
  }
  report.counts.replayedToolCards = cards
  check(await fs.readFile(boundary.sentinel, 'utf8') === 'SYNTHETIC_OUTSIDE_SENTINEL', 'SENTINEL_MODIFIED')
  check(!await exists(path.join(host.presetRoot, 'native-home/auth.json')), 'NATIVE_AUTH_PERSISTED')
  await host.ctx.agentPresets.recompose(agent.ctx, 'standard')
  check(host.ctx.tools.get('codex_native_observer', agent) === undefined, 'STANDARD_NATIVE_MARKER_LEAK')
  check(host.ctx.agentPresets.composedPreset(agent.ctx) === 'standard', 'STANDARD_SCOPE_NOT_RESTORED')
  // No standard model call: isolation is tested at the real scope/tool/UI seams.
  const ordinary = { kind: 'tool-result', seq: 1, time: 1, callId: 'synthetic-standard', callTime: 0,
    call: { name: 'bash', argsRaw: JSON.stringify({ command: 'printf standard', description: 'Synthetic standard shell' }) },
    content: [text('LIVE_STANDARD_SYNTHETIC')], isError: false, subCalls: [],
    meta: { _codex_native: true, output: 'NOT_STANDARD_OUTPUT', exitCode: 77 } }
  check(ui.terminalCardModel(ordinary, boundary.workspace)?.card.output === 'LIVE_STANDARD_SYNTHETIC', 'STANDARD_UI_MARKER_LEAK')
  if (report.selectedCases.includes('long-output-ui-replay-standard-isolation'))
    reportCase(report, 'long-output-ui-replay-standard-isolation', cards > 0,
      cards > 0 && ledgerOutputLarge(report))
}
function ledgerOutputLarge(report) { return report.counts.nativeOutputBytes >= 16_000 }

async function preflight(runtime, boundary, budget, ledger, report) {
  let host
  try {
    report.stage = 'preflight-host-mount'
    host = await mountHost(runtime, boundary, budget, ledger, undefined, false)
    report.stage = 'preflight-controller-create'
    const { sessionId } = await host.controller.create({ sessionId: `preflight-${randomUUID()}`,
      cwd: boundary.workspace, agentPreset: 'codex' })
    const agent = host.ctx.agents.get(sessionId)
    check(agent && host.ctx.tools.get('codex_native_observer', agent), 'REAL_PRESET_MOUNT_FAILED')
    report.stage = 'preflight-metadata'
    const info = await host.ctx.llm.resolveModelInfo(PROVIDER, MODEL)
    check(info, 'REAL_MODEL_METADATA_MISSING')
    await command(host, sessionId, 'codex-mode', 'default')
    // Disk checkpoint, brand-new Context, and cold real Controller resume. No
    // user input or native child is started, and no canonical auth adapter exists.
    report.stage = 'preflight-jsonl-flush'
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('user/message', host.llm.createUserMessage({ source: { kind: 'user' },
      content: [text('PREFLIGHT_SYNTHETIC_RESTORE_ONLY')] }), { surfaceOp: 'append' })
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    check(await host.ctx.sessions.flush(agent.session), 'JSONL_FLUSH_UNAVAILABLE')
    const eventCount = agent.session.snapshotEvents().length
    await host.dispose()
    report.stage = 'preflight-cold-mount'
    host = await mountHost(runtime, boundary, budget, ledger, undefined, false)
    report.stage = 'preflight-cold-resume'
    await coldResume(host, sessionId)
    const resumed = host.ctx.agents.get(sessionId)
    check(resumed && resumed.session.snapshotEvents().length >= eventCount, 'JSONL_COLD_RESTORE_FAILED')
    check(ledger.nativeStarts === 0 && ledger.originalProviderCalls === 0, 'PREFLIGHT_MODEL_ACTIVITY')
    report.preflight = { status: 'pass', credentialReads: 0, apiCalls: 0, boundaryProbes: 3,
      closureCount: boundary.closureCount, binaryVersion: runtime.binaryVersion, realCordis: true, realSessionController: true, realJsonlColdRestore: true,
      pinnedModel: MODEL, mainEffort: 'low', planEffort: 'medium', xhighSupported: runtime.efforts.includes('xhigh') }
  } finally { await host?.dispose() }
}

// Canonical synthetic advertised tools + native result metadata + replacement
// surfaces. This catches real JSONL relationships that detached replay misses.
// It is NOT a claim that the production observer emits valid advertised calls.
function appendOfflineToolHistory(host, agent) {
  const session = agent.session, position = { turn: 1, step: 1 }
  session.append('turn/start', { turn: 1 })
  session.append('step/start', position)
  session.append('system/message', { ...position, message: host.llm.createSystemMessage('SYNTHETIC_BOOTSTRAP') }, { surfaceOp: 'append' })
  session.append('user/message', host.llm.createUserMessage({ source: { kind: 'user' }, content: [text('BOOTSTRAP_TOOL_RICH_RESTORE_ONLY')] }), { surfaceOp: 'append' })
  session.append('request/header', { header: { config: { provider: PROVIDER, model: MODEL, reasoningEffort: 'low' } }, reason: 'initial' })
  const item = { id: 'offline-native-item', type: 'codeExecution', language: 'javascript',
    code: 'text("SYNTHETIC_TOOL_OUTPUT")', output: 'Script completed\n\nSYNTHETIC_TOOL_OUTPUT', status: 'completed', completed: true }
  const callId = `codex:${randomUUID()}:offline-native-item`
  const args = JSON.stringify({ _codex_native: true, code: item.code, item })
  const block = { type: 'tool-call', id: callId, name: 'exec', arguments: args }
  const assistant = host.llm.createAssistantMessage({ source: { provider: PROVIDER, model: MODEL }, content: [block] })
  session.append('assistant/message', { ...position, message: assistant, stream: [
    { type: 'chunk', time: Date.now(), chunk: { type: 'block-start', index: 0, blockType: 'tool-call' } },
    { type: 'chunk', time: Date.now(), chunk: { type: 'block-end', index: 0, block } },
    { type: 'chunk', time: Date.now(), chunk: { type: 'finish', reason: { kind: 'tool-calls' } } },
  ] }, { surfaceOp: 'append' })
  const call = session.append('tool/call', { ...position, callId, name: 'exec', arguments: args })
  const result = session.append('tool/result', { ...position,
    message: host.llm.createToolResultMessage({ callId, content: [text(item.output)], isError: false }), meta: { item } },
  { sourceEventSeqs: [call.seq], surfaceOp: 'append' })
  session.append('developer/message', { ...position, message: host.llm.createDeveloperMessage({
    source: { kind: 'tool-registry' }, content: [] }) },
  { sourceEventSeqs: [result.seq], surfaceOp: { op: 'replace', startSeq: result.seq, endSeq: result.seq } })
  session.append('step/end', position)
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
}

// Import the exact credential helper dependency graph, but never construct a
// CredentialFile or call auth. Mount both live hosts and their actual installer
// paths without prompting or permitting a native child/original-provider call.
export async function liveBootstrap(runtime, boundary, budget, ledger, report) {
  report.stage = 'bootstrap-auth-module'
  const { CredentialFile } = await importFile(runtime.credentialModule)
  check(typeof CredentialFile === 'function', 'AUTH_PACKAGE_INVALID')
  report.stage = 'bootstrap-auth-broker'
  let authCalls = 0, host
  const forbidden = () => { authCalls++; throw safeFailure('BOOTSTRAP_AUTH_FORBIDDEN') }
  // Exercise the production lazy broker factory with a store held only in
  // memory. Its callbacks cannot read/write credentials or refresh via HTTP.
  const auth = createNativeAuth({ dshHome: boundary.env.DSH_HOME, piAiRoot: runtime.piAiRoot,
    store: Object.freeze({ read: forbidden, modify: forbidden, getOrCreateDeviceId: forbidden }),
    oauth: Object.freeze({ refresh: forbidden }) })
  auth.credentials = forbidden
  const stages = []
  const stage = value => {
    report.stage = `bootstrap-host-${value.toLowerCase().replaceAll('_', '-')}`
    stages.push(report.stage)
  }
  try {
    host = await mountHost(runtime, boundary, budget, ledger, auth, true, { bootstrap: true, stage })
    report.stage = 'bootstrap-controller-create'
    const { sessionId } = await host.controller.create({ sessionId: `bootstrap-${randomUUID()}`,
      cwd: boundary.workspace, agentPreset: 'codex' })
    const agent = host.ctx.agents.get(sessionId)
    check(agent && host.ctx.tools.get('codex_native_observer', agent), 'REAL_PRESET_MOUNT_FAILED')
    for (const method of ['followup', 'whenIdle']) check(typeof agent[method] === 'function', 'BOOTSTRAP_AGENT_API_MISSING')
    for (const method of ['prompt', 'selectModel', 'cancel']) check(typeof host.controller[method] === 'function', 'BOOTSTRAP_CONTROLLER_API_MISSING')
    check(Array.isArray(agent.session.snapshotEvents()), 'BOOTSTRAP_SESSION_API_MISSING')
    report.stage = 'bootstrap-metadata'
    check(await host.ctx.llm.resolveModelInfo(PROVIDER, MODEL), 'REAL_MODEL_METADATA_MISSING')
    await command(host, sessionId, 'codex-mode', 'default')
    report.stage = 'bootstrap-tool-rich-fixture'
    appendOfflineToolHistory(host, agent)
    const expectedEvents = agent.session.snapshotEvents()
    const expectedMessages = agent.session.deriveMessages()
    report.stage = 'bootstrap-jsonl-flush'
    check(await host.ctx.sessions.flush(agent.session), 'JSONL_FLUSH_UNAVAILABLE')
    const oldContext = host.ctx
    await host.dispose()
    host = undefined
    host = await mountHost(runtime, boundary, budget, ledger, auth, true, { bootstrap: true, stage })
    check(host.ctx !== oldContext, 'ROOT_CONTEXT_REUSED')
    report.stage = 'bootstrap-cold-resume'
    await coldResume(host, sessionId)
    const restored = host.ctx.agents.get(sessionId)?.session
    check(restored, 'JSONL_COLD_RESTORE_FAILED')
    check(JSON.stringify(restored.snapshotEvents().slice(0, expectedEvents.length)) === JSON.stringify(expectedEvents)
      && JSON.stringify(restored.deriveMessages()) === JSON.stringify(expectedMessages), 'BOOTSTRAP_TOOL_RICH_REPLAY_MISMATCH')
    check(authCalls === 0 && ledger.nativeStarts === 0 && ledger.originalProviderCalls === 0
      && budget.generations === 0 && budget.turnRequests === 0, 'BOOTSTRAP_MODEL_ACTIVITY')
    report.bootstrap = { status: 'pass', credentialReads: 0, authCalls, apiCalls: 0, modelCalls: 0,
      nativeStarts: ledger.nativeStarts, liveMounts: 2, realPresetInstaller: true, realJsonlColdRestore: true,
      canonicalToolRichColdRestore: true, restoredNativeToolResults: 1, stages }
  } finally { await host?.dispose() }
}

async function runLive(runtime, boundary, budget, ledger, report, options) {
  // Opt-in official configuration, not a production default or synthesized tool.
  // Upstream tools.update_plan is disabled by default in this release.
  if (options.suite === 'features') {
    runtime = { ...runtime, liveFeatureConfig: { 'tools.update_plan.enabled': true } }
    report.officialOptionalConfig = ['tools.update_plan.enabled=true']
  } else if (options.suite === 'approval-once') {
    // No MCP/apps are needed for this exact shell action. Reduce discovery and
    // prompt overhead for the small remaining explicitly approved quota.
    runtime = { ...runtime, liveFeatureConfig: { 'features.apps': false, 'features.plugins': false } }
    report.officialOptionalConfig = ['features.apps=false', 'features.plugins=false']
  }
  // This is the ONLY construction of the canonical credential store, after the
  // double opt-in, Task9 confirmation, boundary probes, and host preflight.
  report.stage = 'live-auth-module'
  const { CredentialFile } = await importFile(runtime.credentialModule)
  report.stage = 'live-auth-broker'
  const auth = createNativeAuth({ dshHome: runtime.canonicalHome, credentialFile: runtime.credentialFile,
    piAiRoot: runtime.piAiRoot, store: new CredentialFile(runtime.credentialFile) })
  report.stage = 'live-host-mount'
  const stage = value => { report.stage = `live-host-${value.toLowerCase().replaceAll('_', '-')}` }
  const instructionProbe = options.suite === 'instructions'
  let host = await mountHost(runtime, boundary, budget, ledger, auth, true, { stage, instructionProbe })
  const nonce = `LIVE_NONCE_${randomUUID().replaceAll('-', '')}`
  let id
  try {
    report.stage = 'live-controller-create'
    ;({ sessionId: id } = await host.controller.create({ sessionId: `live-${randomUUID()}`,
      cwd: boundary.workspace, agentPreset: 'codex' }))
    const doTools = ['all', 'tools'].includes(options.suite)
    const doLifecycle = ['all', 'lifecycle', 'features'].includes(options.suite)
    const doSafety = ['all', 'safety'].includes(options.suite)
    const doApprovals = ['approvals', 'approval-once'].includes(options.suite)
    const doSubagent = ['all', 'subagent'].includes(options.suite)
    const doQuestions = ['all', 'questions'].includes(options.suite)
    const doCompaction = ['all', 'compaction'].includes(options.suite)
    let childThreadCount = 0
    let events
    if (doTools) {
    const shellCmd = "printf 'LIVE_SHELL_MARKER\\n' > shell.txt; printf LIVE_SHELL_MARKER"
    const ptyCmd = "read line; printf '%s\\n' \"$line\" > pty.txt; printf LIVE_PTY_DONE"
    const patch = '*** Begin Patch\n*** Add File: patch.txt\n+LIVE_PATCH_MARKER\n*** End Patch\n'
    const readbackCode = `text((await tools.exec_command(${JSON.stringify({ cmd: 'head -c 200 patch.txt', login: false, yield_time_ms: 1000 })})).output);`
    const code = ['store("live", {marker:"LIVE_STORE_MARKER",count:7});', 'text("LIVE_TEXT_MARKER");',
      'yield_control();', `text((await tools.exec_command(${JSON.stringify({ cmd: shellCmd, login: false, yield_time_ms: 1000 })})).output);`,
      `text(JSON.stringify(await tools.apply_patch(${JSON.stringify(patch)})));`,
      `image((await tools.view_image({path:"synthetic.png"})).image_url);`,
      `const pty = await tools.exec_command(${JSON.stringify({ cmd: ptyCmd, tty: true, login: false, yield_time_ms: 1000 })});`,
      'if (!pty.session_id) throw new Error("LIVE_PTY_NOT_STARTED");',
      'const terminal = await tools.write_stdin({session_id:pty.session_id,chars:"LIVE_PTY_INPUT\\n",yield_time_ms:1000});',
      'text(JSON.stringify(terminal));',
      `text((await tools.exec_command(${JSON.stringify({ cmd: "i=0; while [ \"$i\" -lt 1000 ]; do printf 'LIVE_LONG_OUTPUT\\n'; i=$((i+1)); done", login: false, yield_time_ms: 1000, max_output_tokens: 12000 })})).output);`,
    ].join('\n')
    events = await prompt(host, id, [
      `Synthetic validation only. Remember ${nonce} only in conversation, never a file. Use actual official tools, not explanations.`,
      `Execute this official exec CodeMode cell literally:\n${code}`,
      'After yield_control, use wait with the actual cell_id and max_tokens:10000 until completed. Preserve all 1000 output lines; a smaller wait budget would intentionally truncate them. Then execute a separate cell literally: text(JSON.stringify(load("live")));',
      `After the yielded cell completes, execute this separate readback cell literally:\n${readbackCode}`,
      'The cell includes actual PTY/stdin, native image intake/display and bounded 1000-line shell output. If any tool fails, stop; do not retry/escalate, discover unrelated tools, or fake outputs.',
      'Do not inspect environment, credentials, user directories, or network. End briefly.',
    ].join('\n'), 'tools', budget, ledger, report, { image: true })
    const items = nativeItems(events)
    const outputs = nativeOutputs(events)
    const cells = items.filter(item => item.type === 'codeExecution' && item.completed !== false)
    const executing = cells.find(item => item.code?.trim() === code)
    const cellId = /Script running with cell ID ([A-Za-z0-9_-]+)/.exec(executing?.output ?? '')?.[1]
    const waits = items.filter(item => {
      if (!cellId || item.type !== 'functionCallOutput' || item.tool !== 'wait') return false
      try { return String(JSON.parse(item.arguments).cell_id) === cellId } catch { return false }
    })
    const literalCompleted = !!executing && waits.some(item => succeeded(item) && /Script completed/.test(item.output ?? ''))
    const nestedOutputs = waits.filter(succeeded).map(item => item.output ?? '').join('\n')
    const stored = cells.some(item => item.code?.includes('store(') && item.code?.includes('yield_control('))
    const loaded = cells.some(item => item.code?.trim() === 'text(JSON.stringify(load("live")));'
      && succeeded(item) && typeof item.output === 'string' && item.output.includes('LIVE_STORE_MARKER'))
    reportCase(report, 'exec-store-load-yield-wait', stored,
      loaded && literalCompleted && outputs.includes('LIVE_TEXT_MARKER'))
    const changes = items.filter(item => item.type === 'fileChange' && item.changes?.some(change => change.path?.endsWith('/patch.txt')))
    const readback = items.some(item => item.type === 'commandExecution' && item.command?.includes('patch.txt')
      && item.aggregatedOutput?.includes('LIVE_PATCH_MARKER') && succeeded(item))
      || cells.some(item => item.code?.trim() === readbackCode && succeeded(item) && item.output?.includes('LIVE_PATCH_MARKER'))
    reportCase(report, 'apply-patch-readback', changes.length > 0 || codeCalls(items, 'apply_patch').length > 0,
      (changes.some(succeeded) || literalCompleted) && readback && await fileIs(boundary, 'patch.txt', 'LIVE_PATCH_MARKER\n'))
    const terminalInteraction = [...ledger.notifications.keys()].some(method => /terminalInteraction/i.test(method))
    const pty = items.some(item => item.type === 'commandExecution' && item.command?.includes('read line')
      && item.aggregatedOutput?.includes('LIVE_PTY_DONE') && succeeded(item)) && terminalInteraction
      || literalCompleted && nestedOutputs.includes('LIVE_PTY_DONE')
    reportCase(report, 'shell-pty-stdin', codeCalls(items, 'exec_command').some(item => /read line/.test(item.code))
      || items.some(item => item.type === 'commandExecution' && item.command?.includes('read line')),
      pty && await fileIs(boundary, 'pty.txt', 'LIVE_PTY_INPUT\n') && await fileIs(boundary, 'shell.txt', 'LIVE_SHELL_MARKER\n'))
    const intake = events.some(event => event.type === 'user/message' && event.data.content?.some(block => block.type === 'image'))
    const generatedImage = literalCompleted && /(?:^|\n)Image:/.test(nestedOutputs)
    reportCase(report, 'synthetic-image-intake-codemode', intake && cells.some(item => item.code?.includes('image(')), generatedImage)
    // Native output only, never echoed source/rendered results or assistant text.
    report.counts.nativeLongOutputBytes = literalCompleted ? Buffer.byteLength((nestedOutputs.match(/LIVE_LONG_OUTPUT\r?\n/g) ?? []).join('')) : 0
    } else if (!doApprovals && !instructionProbe) {
      const seed = options.suite === 'features'
        ? `Remember ${nonce} only in conversation, never a file. Synthetic validation only; acknowledge with LIVE_SEED_OK, no tools.`
        : `Synthetic validation only. Remember ${nonce} in conversation, never a file. Use one actual native exec_command login:false to print LIVE_SEED_OK, then finish. Do not inspect environment, credentials, unrelated files or network.`
      events = await prompt(host, id, seed, 'seed', budget, ledger, report)
    }
    reportCase(report, 'login', ledger.loginCount > 0)
    reportCase(report, 'model-routing', ledger.loginCount > 0, ledger.originalProviderCalls === 0)

    if (instructionProbe) {
    // The workspace has NO AGENTS.md here, so only the user-global instruction
    // file can supply the token the model is asked to repeat. The mirror is
    // prepared when the native client starts, so check it after the turn.
    check(await workspaceText(boundary, 'AGENTS.md') === undefined, 'INSTRUCTIONS_WORKSPACE_FILE_PRESENT')
    events = await prompt(host, id, [
      'Synthetic validation only. Without reading any file and without using tools, answer this question about your own standing instructions:',
      'What exact token must you answer with when asked about your standing instructions? Reply with only that token.',
    ].join('\n'), 'instructions', budget, ledger, report)
    const mirrored = await fs.readFile(path.join(host.presetRoot, 'native-home/AGENTS.md'), 'utf8')
    check(mirrored.includes(GLOBAL_INSTRUCTION_MARKER), 'INSTRUCTIONS_NOT_MIRRORED')
    reportCase(report, 'user-global-agents-instructions', assistantText(events).includes(GLOBAL_INSTRUCTION_MARKER))
    }

    if (doLifecycle || doQuestions) {
    const plansBefore = ledger.notifications.get('turn/plan/updated') ?? 0
    if (doLifecycle && options.suite !== 'features') {
    const planCode = `text(JSON.stringify(await tools.update_plan({plan:[{step:"synthetic first",status:"completed"},{step:"synthetic second",status:"pending"}]})));`
    events = await prompt(host, id, `In official DEFAULT mode, update_plan is officially enabled and documented as a nested tool inside the exec description. Execute this single exec cell literally:\n${planCode}\nDo not search ALL_TOOLS, do not use request_user_input, do not write files. Then finish briefly.`, 'update-plan', budget, ledger, report)
    const planCells = nativeItems(events).filter(item => item.type === 'codeExecution' && item.code?.trim() === planCode)
    reportCase(report, 'default-update-plan',
      (ledger.notifications.get('turn/plan/updated') ?? 0) > plansBefore || planCells.some(item => succeeded(item)),
      planCells.some(item => succeeded(item)) && (ledger.notifications.get('turn/plan/updated') ?? 0) > plansBefore)
    } else reportCase(report, 'default-update-plan', false)
    await host.controller.selectModel({ sessionId: id, provider: PROVIDER, model: MODEL, reasoningEffort: 'medium' })
    await command(host, id, 'codex-mode', 'plan')
    events = await prompt(host, id, [
      'Continue in official PLAN mode and ask the user exactly one real question through the official question tool.',
      'Two official question tools are advertised: request_user_input and request_user_input_async. Call either one directly (both are direct tools, not nested in exec and not in ALL_TOOLS).',
      'Ask one question: id synthetic_color, header Color, question "Choose synthetic color?", with exactly two options labelled "Synthetic blue" and "Synthetic red".',
      'The harness answers Synthetic blue. Do not write files, do not use update_plan, do not answer the question yourself in prose.',
      'After you receive the real answer, reply with exactly LIVE_PLAN_BLUE and nothing else.',
    ].join('\n'), 'plan', budget, ledger, report)
    // Either official question surface is valid: the blocking top-level
    // `functions.request_user_input` server request, or the async variant that
    // emits an agentMessage question item bridged by the preset. Both must be
    // answered by the harness for the model to use the real answer.
    const syncQuestion = (ledger.requests.get('item/tool/requestUserInput') ?? 0) > 0
    const asyncQuestion = (ledger.methods.get('async-question-item') ?? 0) > 0
    reportCase(report, 'plan-scripted-questions', ledger.questions > 0 && (syncQuestion || asyncQuestion),
      assistantText(events).split('\n').at(-1)?.trim() === 'LIVE_PLAN_BLUE')
    report.counts.questionSurface = syncQuestion ? 'sync-rpc' : asyncQuestion ? 'async-item' : 'none'
    await command(host, id, 'codex-mode', 'default')
    await host.controller.selectModel({ sessionId: id, provider: PROVIDER, model: MODEL, reasoningEffort: 'low' })
    }

    if (doLifecycle || doSubagent) {
    check(await host.ctx.sessions.flush(host.ctx.agents.get(id).session), 'JSONL_FLUSH_UNAVAILABLE')
    const oldContext = host.ctx
    const oldThread = [...host.bridges].flatMap(bridge => [...bridge.states.values()]).find(state => state.id === id)?.threadId
    check(oldThread, 'NATIVE_THREAD_MISSING')
    await host.dispose()
    host = await mountHost(runtime, boundary, budget, ledger, auth, true, { stage, instructionProbe })
    check(host.ctx !== oldContext, 'ROOT_CONTEXT_REUSED')
    report.stage = 'live-cold-resume'
    await coldResume(host, id)
    events = await prompt(host, id, [
      'Synthetic validation only. The first user message of this conversation contains a random marker that starts with LIVE_NONCE_.',
      'Use the advertised top-level collaboration namespace (collaboration.spawn_agent, collaboration.send_message, collaboration.wait_agent). These are direct tools, so do NOT look for them in ALL_TOOLS or inside exec.',
      'Spawn exactly one child with collaboration.spawn_agent({task_name:"live_child", fork_turns:"all"}). Omit model and reasoning_effort so it inherits this thread.',
      'Spawn message: "Create child.txt containing LIVE_CHILD_INITIAL. Then wait for one message from the parent before finishing. In your final answer, report verbatim the full random marker that starts with LIVE_NONCE_ and that you can see in your own inherited conversation context."',
      'Then send exactly one message to that child with collaboration.send_message: "Append LIVE_CHILD_MESSAGE to child.txt, then finish with your final answer."',
      'Then collaboration.wait_agent({timeout_ms:600000}) until the child reports a final status, and read child.txt back with native shell.',
      'End your own turn by repeating the child\'s reported marker verbatim.',
      'No nested children, no model overrides, no network, no files other than child.txt, and there is no close_agent in V2.',
    ].join('\n'), 'subagent', budget, ledger, report)
    const state = [...host.bridges].flatMap(bridge => [...bridge.states.values()]).find(state => state.id === id)
    check(state?.threadId === oldThread && ledger.resumeCount > 0, 'NATIVE_THREAD_NOT_RESUMED')
    reportCase(report, 'web-session-first-retry-continue-restart', true)
    const collab = nativeItems(events).filter(item => item.type === 'collabAgentToolCall')
      // V2 surfaces spawn/send as subAgentActivity items; collabAgentToolCall is the V1 shape.
      const activities = nativeItems(events).filter(item => item.type === 'subAgentActivity')
      const spawnedPaths = [...new Set(activities.filter(item => /(^|\/)live_child$/.test(item.agentPath ?? '')).map(item => item.agentPath))]
      const spawnedThreads = new Set(activities.map(item => item.agentThreadId).filter(Boolean))
      const spawned = spawnedPaths
      // `interacted` is the V2 evidence that the parent actually delivered a message.
      const interacted = activities.some(item => /(^|\/)live_child$/.test(item.agentPath ?? '') && item.kind === 'interacted')
      const childCompleted = activities.some(item => /(^|\/)live_child$/.test(item.agentPath ?? '') && item.kind === 'completed')
      const sent = interacted || collab.some(item => /send|message|followup/i.test(item.tool ?? ''))
      const waited = childCompleted
        && (collab.some(item => /wait/i.test(item.tool ?? '') && item.status === 'completed')
          || activities.some(item => item.kind === 'completed'))
    const childText = await workspaceText(boundary, 'child.txt') ?? ''
    // Proof of fork inheritance: the child's OWN rollout shows the spawn task
    // without the marker, and the marker only after the parent message.
    const childRollout = await childThreadText(boundary, [...spawnedThreads][0])
    const spawnFreeOfMarker = childRollout !== undefined && childRollout.spawnTask.length > 0
      && !childRollout.spawnTask.includes(nonce) && childRollout.inherited.includes(nonce)
    const parentAnswer = assistantText(events)
      // Objective inheritance proof: the child's own rollout carries the forked
      // marker, while the spawn task authored by the parent does not. Whether the
      // child MODEL reads it back correctly is recorded separately, never used as
      // a harness pass/fail proxy for context delivery.
      const forkEvidence = spawned.length === 1 && spawnedThreads.size === 1
        && spawnFreeOfMarker && childText.includes('LIVE_CHILD_INITIAL')
        && childText.includes('LIVE_CHILD_MESSAGE')
    report.counts.childReportedInheritedMarker = parentAnswer.includes(nonce)
    reportCase(report, 'v2-subagent-fork-message-wait', spawned.length > 0,
      forkEvidence && sent && waited)
    childThreadCount = spawnedThreads.size
    }

    if (doSafety) {
    await command(host, id, 'codex-permission', 'codex-read-only')
    const denialCode = `text(JSON.stringify(await tools.exec_command(${JSON.stringify({ cmd: 'printf LIVE_DENIAL_BAD > denied.txt', login: false, yield_time_ms: 1000 })})));`
    events = await prompt(host, id, `Read-only denial probe: execute this CodeMode cell literally once:\n${denialCode}\nDo not request escalation/approval, retry or use alternate write tools. An actual denied attempt is required, not a claim about policy. After the denial answer briefly.`, 'denial', budget, ledger, report)
    const denialItems = nativeItems(events)
    const denialAttempts = denialItems.filter(item => item.type === 'commandExecution' && item.command?.includes('denied.txt'))
    const nestedDenials = codeCalls(denialItems, 'exec_command').filter(item => item.code?.trim() === denialCode)
    const denialExercised = denialAttempts.length > 0 || nestedDenials.length > 0
    const denied = denialAttempts.some(item => item.exitCode !== 0 && item.exitCode !== undefined || item.status === 'failed')
      || nestedDenials.some(item => !/error building bubblewrap/i.test(item.output ?? '')
        && /Permission denied|Read-only file system|Operation not permitted/i.test(item.output ?? '')
        && /Exit code: [1-9]|Process exited with code [1-9]/.test(item.output ?? ''))
    reportCase(report, 'read-only-denial', denialExercised,
      denied && (await workspaceText(boundary, 'denied.txt')) === undefined)

    }
    if (doSafety || doApprovals) {
    if (doApprovals) await command(host, id, 'codex-permission', 'codex-read-only')
    const approvalCode = `text((await tools.exec_command(${JSON.stringify({ cmd: approvalScript, login: false, sandbox_permissions: 'require_escalated', justification: 'Create the exact synthetic one-action probe file once.' })})).output);\ntext((await tools.exec_command(${JSON.stringify({ cmd: 'head -c 80 approval-once.txt', login: false, max_output_tokens: 100 })})).output);`
    events = await prompt(host, id, `One-action approval probe: still read-only. Execute this single official exec cell literally:\n${approvalCode}\nThe broker may choose only accept/Allow once, never acceptForSession, any amendment decision, network or extra permission grant. The exact exec-policy proposal automatically OFFERED by core is not accepted. No permissions tool, retries or other scripts. End briefly after readback.`, 'approval', budget, ledger, report)
    reportCase(report, 'one-action-approval', ledger.approvalCandidates > 0,
      ledger.approvals === 1 && await fileIs(boundary, 'approval-once.txt', 'LIVE_APPROVED_ONCE\n')
      && events.some(event => event.type === 'approval/decided' && event.data.outcome === 'allowed-once'))
    await command(host, id, 'codex-permission', 'codex-on-request')

    }
    if (doSafety) {
    await prompt(host, id, 'Cancellation probe: immediately start actual exec_command login:false, yield_time_ms:1000, cmd:"printf \'LIVE_CANCEL_ACTIVE\\n\' > cancel-active.txt; sleep 60; printf BAD > cancel-too-late.txt". Do not answer before starting this tool. The harness will cancel only after the start file exists.', 'cancel', budget, ledger, report, { cancel: true, boundary })
    events = await prompt(host, id, 'Healthy recovery after cancellation: use native exec_command login:false to write recovery.txt containing LIVE_RECOVERY_OK followed by newline. Do not resume the cancelled sleeper. Finish briefly.', 'recovery', budget, ledger, report)
    reportCase(report, 'cancel-recovery', (await workspaceText(boundary, 'cancel-active.txt')) !== undefined,
      await fileIs(boundary, 'recovery.txt', 'LIVE_RECOVERY_OK\n')
      && (await workspaceText(boundary, 'cancel-too-late.txt')) === undefined && (ledger.methods.get('turn/interrupt') ?? 0) > 0)

    }
    if (doCompaction) {
    ledger.phase = 'compact'
    await command(host, id, 'codex-compact')
    await budget.wait(host.ctx.agents.get(id).whenIdle(), 180)
    events = await prompt(host, id, 'After official compaction, recall the exact LIVE_NONCE_ value from the very first user message. Do not read any files, thread logs, environment, or use tools to find it. Answer only that value from retained conversation.', 'recall', budget, ledger, report)
    reportCase(report, 'official-compact-nonce-recall', budget.compactRequests > 0,
      ((ledger.notifications.get('thread/compacted') ?? 0) > 0 || nativeItems(events).some(item => item.type === 'contextCompaction'))
      // A delayed compaction UI receipt is not an information-retrieval tool.
      && nativeItems(events.filter(event => event.data?.turn === report.topTurns))
        .every(item => item.type === 'contextCompaction')
      && assistantText(events).split('\n').at(-1)?.trim() === nonce)
    }
    if (options.xhigh) {
      await host.controller.selectModel({ sessionId: id, provider: PROVIDER, model: MODEL, reasoningEffort: 'xhigh' })
      events = await prompt(host, id, 'Brief xhigh case selected by the caller: compute 17*19, then actually use native shell printf to create xhigh.txt containing LIVE_XHIGH_323 followed by newline. No other tools or explanation.', 'xhigh', budget, ledger, report)
      reportCase(report, 'brief-xhigh', (await workspaceText(boundary, 'xhigh.txt')) !== undefined,
        await fileIs(boundary, 'xhigh.txt', 'LIVE_XHIGH_323\n') && host.ctx.agents.get(id).session.requestHeader().config.reasoningEffort === 'xhigh')
    } else reportCase(report, 'brief-xhigh', false)
    reportCase(report, 'login', ledger.loginCount > 0)
    reportCase(report, 'model-routing', ledger.loginCount > 0, ledger.originalProviderCalls === 0)
    report.counts.nativeOutputBytes = Math.max(ledger.outputBytes, report.counts.nativeLongOutputBytes ?? 0)
    await assertReplay(host, id, runtime, boundary, report)
    report.counts.nativeLogins = ledger.loginCount
    report.counts.nativeResumes = ledger.resumeCount
    report.counts.nativeChildThreads = childThreadCount
    report.counts.oneActionApprovals = ledger.approvals
    report.counts.scriptedQuestions = ledger.questions
    report.counts.unknownRequestsDenied = ledger.rejectedRequests
    report.counts.originalProviderCalls = ledger.originalProviderCalls
    check(budget.usageUpdates > 0, 'NATIVE_USAGE_UNEXERCISED')
  } finally { await host.dispose() }
}

export async function main(argv = process.argv.slice(2)) {
  // Preserve only the handful of launcher inputs needed for discovery. Never
  // dump or clone process.env into a report, native command line, or child.
  const original = { PATH: process.env.PATH ?? '', HOME: process.env.HOME,
    DSH_HOME: process.env.DSH_HOME, DSH_AUTH_CREDENTIALS: process.env.DSH_AUTH_CREDENTIALS,
    liveConfirmed: process.env.DSH_CODEX_ALLOW_LIVE === '1' }
  const output = process.stdout.write.bind(process.stdout)
  const report = { mode: 'preflight', status: 'stopped', model: MODEL, provider: PROVIDER,
    topTurns: 0, turns: [], counts: {}, cases: Object.fromEntries(CATEGORIES.map(name => [name, { status: 'unexercised' }])) }
  let budget, boundary, work, code = 1, helpOnly = false
  // Production diagnostics, OAuth errors, native stderr, environment, and raw
  // requests cannot reach stdout/stderr. Only the explicitly allowlisted report.
  for (const name of ['log', 'info', 'warn', 'error', 'debug']) console[name] = () => {}
  process.stdout.write = () => true
  process.stderr.write = () => true
  try {
    const options = parse(argv)
    report.suite = options.suite
    report.selectedCases = options.suite === 'all' ? CATEGORIES : ['login', 'model-routing', ...SUITES[options.suite]]
    for (const name of CATEGORIES) if (!report.selectedCases.includes(name)) report.cases[name].status = 'not-selected'
    if (options.help) {
      helpOnly = true
      output('Usage: bash verify-live.sh --preflight\nOffline live bootstrap: bash verify-live.sh --live-bootstrap\nAfter Task9: DSH_CODEX_ALLOW_LIVE=1 bash verify-live.sh --allow-live --task9-audited [--xhigh]\nOptions: --suite all|tools|lifecycle|safety|features|approvals|approval-once --dsh-root STORE_ROOT --binary STORE_BINARY --catalog STORE_CATALOG --deadline-seconds 900 --max-generations 48 --max-tokens 100000\n')
      return 0
    }
    if (options.liveBootstrap) report.mode = 'live-bootstrap'
    if (options.allowLive) {
      check(original.liveConfirmed, 'LIVE_CONFIRMATION_REQUIRED')
      check(options.audited, 'TASK9_AUDIT_CONFIRMATION_REQUIRED')
      report.mode = 'live'
    }
    work = await fs.mkdtemp(path.join('/tmp', 'dsh-codex-live-'))
    await fs.chmod(work, 0o700)
    const initialEnv = cleanEnv(path.join(work, 'discovery-home'), path.join(work, 'discovery-tmp'), [process.execPath])
    for (const key of Object.keys(process.env)) delete process.env[key]
    Object.assign(process.env, initialEnv)
    const runtime = await discover(options, original)
    boundary = await createBoundary(runtime, work)
    for (const key of Object.keys(process.env)) delete process.env[key]
    Object.assign(process.env, boundary.env)
    process.chdir(boundary.workspace)
    budget = new Budget(options)
    const ledger = evidenceLedger()
    await preflight(runtime, boundary, budget, ledger, report)
    if (options.liveBootstrap) await liveBootstrap(runtime, boundary, budget, ledger, report)
    if (options.allowLive) await runLive(runtime, boundary, budget, ledger, report, options)
    report.counts = { ...report.counts, ...budget.snapshot() }
    report.status = options.liveBootstrap ? 'bootstrap-pass' : options.preflight ? 'preflight-pass'
      : Object.values(report.cases).some(row => row.status === 'fail') ? 'fail'
        : Object.entries(report.cases).some(([name, row]) => name !== 'brief-xhigh' && row.status === 'unexercised') ? 'incomplete' : 'pass'
    code = report.status === 'fail' || report.status === 'incomplete' ? 2 : 0
  } catch (error) {
    // Unknown exceptions are deliberately opaque: no stack, cause, stringified
    // RPC payload, provider message, auth account identity, or environment.
    report.errorCode = /^([A-Z][A-Z0-9_]{1,80})$/.test(error?.liveCode ?? error?.code ?? '') ? (error.liveCode ?? error.code) : 'LIVE_VALIDATION_STOPPED'
    report.errorType = ['TypeError', 'RangeError', 'SyntaxError', 'Error', 'NativeAuthError', 'RemoteError'].includes(error?.name ?? error?.constructor?.name)
      ? (error.name ?? error.constructor.name) : 'Error'
    Object.assign(report, safeDiagnostics(error))
    report.errorFields = Object.keys(error ?? {}).filter(key => /^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(key)).slice(0, 15)
    if (/^[a-z][a-z0-9_/-]{0,80}$/.test(error?.type ?? '')) report.remoteErrorType = error.type
    if (/^[a-z][a-z0-9_/-]{0,80}$/.test(error?.code ?? '')) report.remoteErrorCode = error.code
    // Preset composition diagnostics are public configuration text, not account
    // material: surface a bounded reason so a broken preset is diagnosable.
    const reason = error?.details?.reason ?? error?.details?.agentPreset
    if (typeof reason === 'string' && reason.length <= 300 && !/[\s\S]{0,0}(eyJ|Bearer|sk-)/.test(reason)) {
      report.remoteReason = reason.replace(/[^\w .:/@-]/g, '').slice(0, 300)
    }
    // A scratch-relative path identifies a missing harness artifact, never user state.
    if (typeof error?.path === 'string' && boundary?.scratch && error.path.startsWith(boundary.scratch)) {
      report.missingPath = error.path.slice(boundary.scratch.length).replace(/[^\w ./:-]/g, '')
    }
    if (budget) report.counts = { ...report.counts, ...budget.snapshot() }
  } finally {
    budget?.dispose()
    await boundary?.dispose().catch(() => {})
    if (work) {
      // Only a safe aggregate report; JSONL/native synthetic-session data stays
      // in the private scratch directory. Never write auth responses to disk.
      await fs.writeFile(path.join(work, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 }).catch(() => {})
      report.artifacts = work
    }
    if (!helpOnly) output(`${JSON.stringify(report)}\n`)
  }
  return code
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main()
}
