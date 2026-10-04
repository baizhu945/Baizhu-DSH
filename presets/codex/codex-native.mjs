/**
 * Official Codex agent runtime, scoped to the Codex preset.
 *
 * DSH is an input/UI transport, NOT a model/provider/tool executor here. Never
 * forward a DSH prompt, checkpoint, schema or mirrored result to Codex. Only
 * admitted, direct user input crosses the boundary; Codex owns its own history.
 */
import fs from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { addAbortListener } from 'node:events'
import { CodexAppServer } from './codex-app-server.mjs'
import { createNativeAuth } from './codex-native-auth.mjs'
import { createNativeObserver } from './codex-native-observation.mjs'
import { createNativeUsageCounter } from './codex-native-usage.mjs'
import { codexNativeInputAdmission } from './native-input-admission.mjs'
import * as presentation from './codex-native-presentation.mjs'
import { CODEX_NATIVE_PROFILES, handleNativeAsyncQuestions, handleNativeRequest, nativePolicyFor, nativeUserInput } from './codex-native-interaction.mjs'

export const name = 'codex-native'
export const inject = ['llm', 'tools']
export const NATIVE_PROVIDER = 'codex-native'
export const OFFICIAL_REVISION = '260f9619e07037e307a09eab0ed1bfeee86e725d'
export const OFFICIAL_RUNTIME_VERSION = '0.162.0-alpha.11'

const DIRECT = message => message?.role === 'user' && message.source?.kind === 'user'
const NON_TOOLS = new Set(['userMessage', 'agentMessage', 'reasoning', 'hookPrompt', 'plan'])
const INTERACTIONS = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval',
  'item/permissions/requestApproval', 'item/tool/requestUserInput', 'mcpServer/elicitation/request',
  'execCommandApproval', 'applyPatchApproval'])
const EVENTS_WORTH_SHOWING = new Set(['item/started', 'item/completed', 'item/agentMessage/delta',
  'item/plan/delta', 'item/reasoning/summaryTextDelta', 'item/reasoning/textDelta',
  'item/reasoning/summaryPartAdded', 'item/commandExecution/outputDelta', 'item/fileChange/outputDelta',
  'item/fileChange/patchUpdated', 'turn/plan/updated', 'thread/compacted', 'rawResponseItem/completed'])

function sessionEvents(session) {
  return typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : session.events ?? []
}

function safeError(error) {
  // Do not copy arbitrary RPC error.data, request bodies, or stderr to the UI.
  return error?.code === 'CODEX_LEGACY_SESSION' || error?.code === 'CODEX_INPUT_UNSUPPORTED'
    || error?.code?.startsWith?.('CODEX_AUTH_') ? error.message
    : `Official Codex runtime failed${error?.code ? ` (${String(error.code)})` : ''}. Check the preset's native runtime and account login.`
}

export function nativeFailureCode(error) {
  const code = error?.code
  if (Number.isSafeInteger(code)) return `NATIVE_RPC_${code < 0 ? 'MINUS_' : ''}${Math.abs(code)}`
  return typeof code === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(code) ? code : 'NATIVE_CODEX_ERROR'
}

export function nativeSandboxPolicy(policy, cwd) {
  if (policy.sandbox === 'danger-full-access') return { type: 'dangerFullAccess' }
  if (policy.sandbox === 'read-only') return { type: 'readOnly', networkAccess: false }
  return { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false,
    excludeTmpdirEnvVar: false, excludeSlashTmp: false }
}

export function nativeTurnSettings(state, options) {
  const settings = { model: options.model, ...(options.reasoningEffort ? { effort: options.reasoningEffort } : {}) }
  if (state.persistent) settings.effort = 'persistent'
  if (state.mode) settings.collaborationMode = { mode: state.mode,
    settings: { model: options.model, reasoning_effort: settings.effort ?? null, developer_instructions: null } }
  return settings
}

class NotificationQueue {
  items = []
  waiters = []
  push(value) {
    const waiter = this.waiters.shift()
    if (waiter) waiter(value)
    else this.items.push(value)
  }
  next() {
    if (this.items.length) return Promise.resolve(this.items.shift())
    return new Promise(resolve => this.waiters.push(resolve))
  }
}

async function privateDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  const stat = await fs.lstat(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(directory) !== path.resolve(directory)) {
    throw Object.assign(new Error('Native state directory must not be symlinked.'), { code: 'CODEX_STATE_PATH' })
  }
  if (process.getuid && stat.uid !== process.getuid()) {
    throw Object.assign(new Error('Native state directory has a different owner.'), { code: 'CODEX_STATE_PATH' })
  }
  await fs.chmod(directory, 0o700)
}

// DSH user-global instruction candidates, in the exact precedence and
// concatenating semantics of @deepseek-ai/dsh-agent-instructions.
const DSH_INSTRUCTION_CANDIDATES = ['AGENTS.md', 'CLAUDE.md', 'AGENTS.local.md', 'CLAUDE.local.md']
// A mirror larger than this is refused rather than silently truncated.
const MAX_MIRRORED_INSTRUCTION_BYTES = 1_048_576

// Pure, testable composition of user-global instruction text. DSH concatenates
// every present candidate and collapses trimmed duplicates, so the native core
// must receive that same text instead of a Codex-style override.
export function composeUserInstructions(entries) {
  const seen = new Set()
  const parts = []
  let bytes = 0
  for (const { text } of entries) {
    const trimmed = String(text ?? '').trim()
    if (!trimmed || seen.has(trimmed)) continue
    const part = `${trimmed}\n`
    bytes += Buffer.byteLength(part)
    if (bytes > MAX_MIRRORED_INSTRUCTION_BYTES) return undefined
    seen.add(trimmed)
    parts.push(part)
  }
  return parts.join('')
}

async function readInstructionFile(filename) {
  try {
    const stat = await fs.lstat(filename)
    // Never follow a symlink out of the user's home: only regular files mirror.
    if (stat.isSymbolicLink() || !stat.isFile()) return { missing: true }
    if (stat.size > MAX_MIRRORED_INSTRUCTION_BYTES) return { tooLarge: true }
    return { text: await fs.readFile(filename, 'utf8') }
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ELOOP') return { missing: true }
    throw error
  }
}

// Real-filesystem mirror of user-global instructions into the private native
// home. Exported so the production path itself is testable offline.
export async function mirrorUserInstructions({ nativeHome, dshHome, codexHome, explicit, logger }) {
  const agents = path.join(nativeHome, 'AGENTS.md')
  const override = path.join(nativeHome, 'AGENTS.override.md')
  const write = async (file, text) => {
    if (text === undefined) {
      await fs.unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error })
      return
    }
    await atomicFile(file, text)
  }
  if (explicit) {
    // An explicitly configured Codex-style home is mirrored verbatim. Upstream
    // resolves AGENTS.override.md first, so both files may coexist unchanged.
    const overrideRead = await readInstructionFile(path.join(explicit, 'AGENTS.override.md'))
    const agentsRead = await readInstructionFile(path.join(explicit, 'AGENTS.md'))
    if (overrideRead.tooLarge || agentsRead.tooLarge) {
      logger?.warn('Configured global AGENTS instructions exceed the mirror budget; none were mirrored.')
      await write(override, undefined)
      await write(agents, undefined)
      return
    }
    await write(override, overrideRead.text)
    await write(agents, agentsRead.text)
    return
  }
  await write(override, undefined)
  if (dshHome) {
    const entries = []
    let oversized = false
    for (const candidate of DSH_INSTRUCTION_CANDIDATES) {
      const read = await readInstructionFile(path.join(dshHome, candidate))
      if (read.tooLarge) oversized = true
      if (read.text !== undefined) entries.push({ text: read.text })
    }
    if (oversized) {
      // Never silently drop user instructions, and never mirror a partial set.
      logger?.warn('A user-global AGENTS instruction file exceeds the mirror budget; none were mirrored.')
      await write(agents, undefined)
      return
    }
    if (entries.length) {
      const composed = composeUserInstructions(entries)
      if (composed === undefined) {
        logger?.warn('User-global AGENTS instructions exceed the mirror budget; none were mirrored.')
        await write(agents, undefined)
        return
      }
      await write(agents, composed)
      return
    }
  }
  // No DSH user-global file: fall back to the Codex CLI global instructions so
  // the preset still matches official CLI behavior when only that exists.
  const fallback = await readInstructionFile(path.join(codexHome, 'AGENTS.override.md'))
  const fallbackText = fallback.tooLarge ? undefined
    : fallback.text ?? (await readInstructionFile(path.join(codexHome, 'AGENTS.md'))).text
  await write(agents, fallbackText)
}

async function atomicFile(file, data) {
  await privateDirectory(path.dirname(file))
  try {
    if ((await fs.lstat(file)).isSymbolicLink()) throw Object.assign(new Error('Native state file must not be symlinked.'), { code: 'CODEX_STATE_PATH' })
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  const temporary = `${file}.${randomUUID()}.tmp`
  let handle
  try {
    handle = await fs.open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600)
    await handle.writeFile(data)
    await handle.sync()
    await handle.close()
    handle = undefined
    await fs.rename(temporary, file)
  } finally {
    await handle?.close()
    await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error })
  }
}

export async function atomicJson(file, value) {
  await atomicFile(file, JSON.stringify(value))
}

export async function resolveNativeInput(ctx, messages, signal) {
  const inputs = []
  for (const message of messages) {
    const content = []
    for (const block of message.content) {
      signal?.throwIfAborted()
      if ((block.type === 'image' || block.type === 'file') && block.attachment) {
        const attachments = ctx.get?.('attachments') ?? ctx.attachments
        if (!attachments) throw Object.assign(new Error('Codex input requires the attachment service.'), { code: 'CODEX_INPUT_UNSUPPORTED' })
        if (block.type === 'image') {
          // Native Codex performs its own image admission/encoding. No DSH
          // provider-specific resize or image-offload placeholder is forwarded.
          const localPath = attachments.imageHostPath(block.attachment)
          if (localPath) content.push({ type: 'image', path: localPath })
          else {
            const stored = await attachments.readImage(block.attachment, signal)
            content.push({ type: 'image', url: `data:${stored.ref.mediaType};base64,${Buffer.from(stored.data).toString('base64')}` })
          }
        } else {
          const localPath = attachments.fileHostPath(block.attachment)
          if (!localPath) throw Object.assign(new Error('Native Codex needs a host-backed path for this file attachment.'), { code: 'CODEX_INPUT_UNSUPPORTED' })
          content.push({ type: 'file', path: localPath })
        }
      } else content.push(block)
    }
    inputs.push(...nativeUserInput({ ...message, content }))
  }
  return inputs
}

/** Injectable transport and message helpers keep all bridge tests offline. */
export function createNativeBridge(ctx, config = {}, dependencies = {}) {
  const dshHome = config.dshHome ?? process.env.DSH_HOME ?? path.join(process.env.HOME, '.dsh')
  const root = config.presetRoot ?? path.join(dshHome, '.agent-presets/codex')
  const nativeHome = path.join(root, 'native-home')
  const revision = config.revision ?? OFFICIAL_REVISION
  const states = new Map()
  const registeredTools = new Set()
  const makeClient = dependencies.createClient ?? (options => new CodexAppServer(options))
  const auth = dependencies.auth ?? createNativeAuth({ dshHome, piAiRoot: process.env.DSH_PI_AI_ROOT })
  const helpers = dependencies.helpers
  const view = dependencies.presentation ?? presentation
  // Exact definition identity proves current preset ownership even when this
  // standing plugin has seen the same session before a switch to standard.
  const marker = helpers?.defineTool?.({ name: 'codex_native_observer',
    description: 'Private native-runtime scope marker; not model-visible.', parameters: {},
    output: { schema: { type: 'object', additionalProperties: false, properties: {} }, render: () => [] },
    execute() { throw new Error('The native scope marker is not executable.') } })
  if (marker) ctx.tools.register(marker)
  const owns = state => !ctx.tools.get || ctx.tools.get('codex_native_observer', state.agent) === marker
  let disposed = false

  function stateFor(agent) {
    const id = String(agent.session.id)
    let state = states.get(id)
    if (state) return state
    const digest = createHash('sha256').update(id).digest('hex')
    state = { agent, id, journal: path.join(root, 'threads', `${digest}.json`), delivered: new Set(),
      admitted: [], controlIds: new Set(), queue: new NotificationQueue(), client: undefined,
      threadId: undefined, nativeTurnId: undefined, active: false, background: false, uncertain: new Set(),
      interactions: [], requests: new Map(), pendingRequests: 0, calls: new Map(), threads: new Set(), observed: new Set(),
      asyncQuestions: new Set(), lifetime: new AbortController(), epoch: 0,
      position: { turn: 0, step: 0 },
      profile: undefined, mode: undefined, persistent: false, loaded: false, fresh: false,
      saveTail: Promise.resolve(), steerTail: Promise.resolve() }
    states.set(id, state)
    return state
  }

  async function save(state) {
    // thread/start is memory-only until the first native turn. Binding an
    // unstarted thread durably creates an unrecoverable empty-thread ID.
    if (!state.threadStarted && !state.preferencesChanged) return
    state.saveTail = state.saveTail.catch(() => {}).then(() => atomicJson(state.journal, {
      version: 2, sessionId: state.id, revision,
      threadId: state.threadStarted ? state.threadId : null, threadStarted: state.threadStarted === true,
      accountFingerprint: state.accountFingerprint ?? null,
      delivered: [...state.delivered], uncertain: [...state.uncertain],
      controls: [...state.controlIds], observed: [...state.observed],
      profile: state.profile ?? null, mode: state.mode ?? null,
      persistent: state.persistent, usageBaseline: state.usageBaseline ?? null,
      compactPending: state.compactPending === true,
      asyncInput: state.asyncInput ?? [],
    }))
    await state.saveTail
  }

  async function load(state) {
    if (state.loaded) return
    try {
      const journalDirectory = path.dirname(state.journal)
      try {
        const parent = await fs.lstat(journalDirectory)
        if (!parent.isDirectory() || parent.isSymbolicLink() || await fs.realpath(journalDirectory) !== path.resolve(journalDirectory)) {
          throw Object.assign(new Error('Unsafe native journal directory.'), { code: 'CODEX_STATE_PATH' })
        }
      } catch (error) { if (error.code !== 'ENOENT') throw error }
      const handle = await fs.open(state.journal, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK)
      let saved
      try {
        const stat = await handle.stat()
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16 * 1024 * 1024
          || (process.getuid && stat.uid !== process.getuid())) throw Object.assign(new Error('Unsafe native journal file.'), { code: 'CODEX_STATE_PATH' })
        saved = JSON.parse(await handle.readFile('utf8'))
      } finally { await handle.close() }
      if (![1, 2].includes(saved.version) || saved.sessionId !== state.id
        || !((typeof saved.threadId === 'string' && saved.threadId.length > 0)
          || (saved.version === 2 && saved.threadId === null && saved.threadStarted === false))
        || (saved.profile !== undefined && saved.profile !== null && (typeof saved.profile !== 'string' || !Object.hasOwn(CODEX_NATIVE_PROFILES, saved.profile)))
        || (saved.mode !== undefined && saved.mode !== null && !['default', 'plan'].includes(saved.mode))
        || (saved.persistent !== undefined && typeof saved.persistent !== 'boolean')
        || (saved.threadStarted !== undefined && typeof saved.threadStarted !== 'boolean')
        || (saved.accountFingerprint !== undefined && saved.accountFingerprint !== null
          && (typeof saved.accountFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(saved.accountFingerprint)))
        || !Array.isArray(saved.delivered) || saved.delivered.some(id => typeof id !== 'string')
        || (saved.controls !== undefined && (!Array.isArray(saved.controls) || saved.controls.some(id => typeof id !== 'string')))
        || (saved.uncertain !== undefined && (!Array.isArray(saved.uncertain) || saved.uncertain.some(id => typeof id !== 'string')))
        || (saved.observed !== undefined && (!Array.isArray(saved.observed) || saved.observed.some(id => typeof id !== 'string')))
        || (saved.compactPending !== undefined && typeof saved.compactPending !== 'boolean')
        || (saved.asyncInput !== undefined && (!Array.isArray(saved.asyncInput) || saved.asyncInput.some(input =>
          input?.type !== 'text' || typeof input.text !== 'string' || !Array.isArray(input.text_elements)
          || input.text_elements.length !== 0 || Object.keys(input).some(key => !['type', 'text', 'text_elements'].includes(key)))))) {
        throw new Error('Invalid native thread journal')
      }
      state.threadId = saved.threadId ?? undefined
      if (!state.threadId && !state.fresh && sessionEvents(state.agent.session).some(event =>
        event.type === 'assistant/message' || event.type === 'tool/call' || event.type === 'compaction/checkpoint')) {
        throw Object.assign(new Error('Legacy model history requires explicit /codex-new-thread confirm; a preferences-only journal is not native history.'), { code: 'CODEX_LEGACY_SESSION' })
      }
      state.preferencesChanged = saved.version === 2 && saved.threadId === null
      state.accountFingerprint = saved.accountFingerprint ?? undefined
      state.threadStarted = saved.threadStarted ?? (saved.delivered.length > 0 || (saved.observed?.length ?? 0) > 0)
      state.delivered = new Set([...saved.delivered, ...state.delivered])
      state.uncertain = new Set(saved.uncertain ?? [])
      state.controlIds = new Set([...(saved.controls ?? []), ...state.controlIds])
      state.observed = new Set(saved.observed ?? [])
      state.profile ??= saved.profile ?? undefined
      state.mode ??= saved.mode ?? undefined
      state.persistent = saved.persistent === true
      state.usageBaseline = saved.usageBaseline ? createNativeUsageCounter({ baseline: saved.usageBaseline }).snapshot() : undefined
      state.compactPending ||= saved.compactPending === true
      state.asyncInput = [...(saved.asyncInput ?? []), ...(state.asyncInput ?? [])]
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      if (!state.fresh && sessionEvents(state.agent.session).some(event =>
        event.type === 'assistant/message' || event.type === 'tool/call' || event.type === 'compaction/checkpoint')) {
        throw Object.assign(new Error('This session contains legacy DSH/Codex-emulation history. Start a new Codex session, or explicitly use /codex-new-thread to keep the visible transcript but begin a fresh native model history. Legacy history is never silently converted into official Codex history.'), { code: 'CODEX_LEGACY_SESSION' })
      }
    }
    state.loaded = true
  }

  async function scheduleBackground(state) {
    if (disposed || states.get(state.id) !== state || !owns(state) || state.active || state.background || !helpers?.createUserMessage) return
    state.background = true
    const message = helpers.createUserMessage({ source: { kind: 'user' },
      content: [{ type: 'text', text: '(Native Codex background update)' }] })
    const id = String(message.id)
    state.controlIds.add(id)
    try {
      // Journal the non-model wakeup before publishing it to the durable inbox:
      // a restart must never turn this UI control message into native input.
      if (state.threadId) await save(state)
      if (!disposed && owns(state)) state.agent.inject(message)
    } catch {
      state.background = false
      ctx.logger?.warn('Native Codex background update could not be scheduled: preset journal unavailable.')
    }
  }

  function notify(state, method, params) {
    if (disposed || states.get(state.id) !== state) return
    if (!owns(state)) {
      void closeState(state).catch(() => {})
      return
    }
    if (method === 'serverRequest/resolved') {
      const pending = state.requests.get(params.requestId)
      const reason = new Error('Native request resolved')
      pending?.controller.abort(reason)
      pending?.reject(reason)
      return
    }
    if (method === 'thread/started') {
      const parent = params.thread?.source?.subagent?.thread_spawn?.parent_thread_id
      if (state.threads.has(parent)) state.threads.add(params.thread.id)
    }
    if (params.threadId && state.threadId && params.threadId !== state.threadId && !state.threads.has(params.threadId)) return
    if (method === 'thread/tokenUsage/updated' && params.threadId === state.threadId) {
      const counter = state.currentUsage ?? createNativeUsageCounter()
      // Idle/resume notifications establish the current native baseline without
      // charging historical spending to the next foreground DSH turn.
      counter.observe(params.tokenUsage)
      state.usageBaseline = counter.snapshot()
      if (!state.currentUsage && state.threadId) void save(state).catch(() => {})
    }
    if (method === 'thread/name/updated' && params.threadId === state.threadId) state.title = params.threadName ?? params.name
    if (method === 'turn/started' && params.threadId === state.threadId) state.nativeTurnId = params.turn.id
    if (!EVENTS_WORTH_SHOWING.has(method) && !['turn/started', 'turn/completed', 'error', 'thread/tokenUsage/updated'].includes(method)) return
    if (state.active || EVENTS_WORTH_SHOWING.has(method)) {
      // Raw result bytes are read from the confined rollout; retaining them
      // in this notification queue would duplicate large media/model payloads.
      state.queue.push({ method, params: method === 'rawResponseItem/completed' ? { threadId: params.threadId } : params })
      if (!state.active && EVENTS_WORTH_SHOWING.has(method)) void scheduleBackground(state)
    }
  }

  async function request(state, method, params, requestId, transportSignal) {
    if (states.get(state.id) !== state || !owns(state)) throw new Error('Native Codex scope is no longer active')
    if (params.threadId && params.threadId !== state.threadId && !state.threads.has(params.threadId)) throw new Error('Native request is outside the owned thread tree')
    if (method === 'account/chatgptAuthTokens/refresh') {
      return handleNativeRequest({ ctx, agent: state.agent, method, params,
        signal: transportSignal,
        refreshAuth: async (_params, { signal } = {}) => {
          const previousAccount = params.previousAccountId ?? state.accountId
          if (params.previousAccountId && state.accountId && params.previousAccountId !== state.accountId) {
            throw new Error('Native account identity changed; start a new authenticated thread.')
          }
          const credential = await auth.credentials({ forceRefresh: true, previousAccessToken: state.accessToken, signal })
          if (previousAccount && credential.chatgptAccountId !== previousAccount) {
            throw new Error('Host account changed; start a new authenticated thread.')
          }
          state.accessToken = credential.accessToken
          state.accountId = credential.chatgptAccountId
          return { ...credential, chatgptPlanType: credential.chatgptPlanType ?? null }
        } })
    }
    if (!INTERACTIONS.has(method)) return handleNativeRequest({ ctx, agent: state.agent, method, params })
    return new Promise((resolve, reject) => {
      const controller = new AbortController()
      let settled = false, cancellationSubscription
      const finish = (callback, value) => {
        if (settled) return
        settled = true
        cancellationSubscription?.[Symbol.dispose]()
        if (state.requests.get(requestId) === pending) state.requests.delete(requestId)
        const index = state.interactions.indexOf(pending)
        if (index !== -1) state.interactions.splice(index, 1)
        callback(value)
      }
      const pending = { method, params, requestId, controller,
        policy: structuredClone(state.turnPolicy ?? nativePolicyFor(ctx, state.agent, state.profile)),
        resolve: value => finish(resolve, value), reject: error => finish(reject, error) }
      const cancel = () => {
        const error = transportSignal?.reason ?? new Error('Native request cancelled')
        controller.abort(error)
        pending.reject(error)
        state.queue.push({ method: 'bridge/interaction-settled', params: {} })
      }
      state.requests.set(requestId, pending)
      if (transportSignal?.aborted) { cancel(); return }
      if (transportSignal) {
        try { cancellationSubscription = addAbortListener(transportSignal, cancel) }
        catch (error) { controller.abort(error); pending.reject(error); return }
      }
      state.interactions.push(pending)
      state.queue.push({ method: 'bridge/interaction', params: {} })
      if (!state.active) void scheduleBackground(state)
    })
  }

async function prepareHome() {
  await privateDirectory(nativeHome)
  // Mirror ONLY user-global instructions. Native auth, config, memories,
  // plugins, sessions and settings from any host home are never copied, and
  // project AGENTS discovery stays entirely upstream (cwd upwards).
  await mirrorUserInstructions({ nativeHome, dshHome, codexHome: process.env.CODEX_HOME ?? path.join(process.env.HOME ?? '', '.codex'),
    explicit: config.globalInstructionsHome, logger: ctx.logger })
}

  async function ensureThread(state, options, signal) {
    await load(state)
    if (!state.client || state.client.isClosed) await prepareHome()
    let credential
    if (config.authMode !== 'native') {
      // A live child caches credentials. Recheck the canonical host store for
      // EVERY foreground turn so logout/account switches cannot silently keep
      // spending against the old account.
      credential = await auth.credentials({ signal })
      const fingerprint = createHash('sha256').update(credential.chatgptAccountId).digest('hex')
      if (state.accountFingerprint && state.accountFingerprint !== fingerprint) {
        throw Object.assign(new Error('OpenAI account changed. Start a new Codex session or explicitly reset this native thread.'), { code: 'CODEX_AUTH_ACCOUNT_CHANGED' })
      }
      state.accountFingerprint = fingerprint
    }
    if (state.client && !state.client.isClosed) {
      if (credential && credential.accessToken !== state.accessToken) {
        await state.client.request('account/login/start', { type: 'chatgptAuthTokens', ...credential }, { signal })
        state.accessToken = credential.accessToken
        state.accountId = credential.chatgptAccountId
      }
      return
    }
    const env = { ...process.env, CODEX_HOME: nativeHome }
    // Do not advertise unrelated harness internals to native command children.
    for (const key of Object.keys(env)) if (key.startsWith('DSH_') || key.startsWith('PI_')) delete env[key]
    // Upstream must keep its normal remote/bundled catalog behavior for ALL
    // GPT models. The private runtime carries only the user's window exception.
    const args = []
    if (config.authMode !== 'native') args.push('-c', 'cli_auth_credentials_store="ephemeral"')
    if (state.lifetime.signal.aborted) state.lifetime = new AbortController()
    const client = makeClient({ command: config.executable ?? path.join(root, 'bin/codex'), args, env,
      cwd: state.agent.session.header.cwd ?? process.cwd(),
      onNotification: (method, params) => notify(state, method, params),
      onRequest: (method, params, id, signal) => request(state, method, params, id, signal),
      onClose: error => {
        if (state.client !== client) return
        state.epoch++
        state.lifetime.abort(error)
        for (const pending of state.requests.values()) pending.controller.abort(error)
        if (state.active && state.client === client) state.queue.push({ method: 'bridge/failure', params: { error, client } })
      } })
    state.client = client
    try {
      await client.start({ clientInfo: { name: 'codex_cli_rs', version: config.runtimeVersion ?? OFFICIAL_RUNTIME_VERSION }, capabilities: { experimentalApi: true } })
      signal?.throwIfAborted()
      if (credential) {
        await client.request('account/login/start', { type: 'chatgptAuthTokens', ...credential }, { signal })
        state.accessToken = credential.accessToken
        state.accountId = credential.chatgptAccountId
      }
      const policy = nativePolicyFor(ctx, state.agent, state.profile)
      const params = { model: options.model, cwd: state.agent.session.header.cwd ?? process.cwd(),
        ...policy, ...(config.modelProvider ? { modelProvider: config.modelProvider } : {}),
        ...(config.nativeConfig ? { config: config.nativeConfig } : {}),
        ...(!state.threadId ? { experimentalRawEvents: true } : {}) }
      if (!state.threadId) state.usageBaseline = createNativeUsageCounter({ baseline: {
        total: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      } }).snapshot()
      let response
      try {
        response = await client.request(state.threadId ? 'thread/resume' : 'thread/start', {
          ...params, ...(state.threadId ? { threadId: state.threadId, excludeTurns: true } : {}) }, { signal })
      } catch (error) {
        if (!state.threadId || state.threadStarted || state.delivered.size || state.observed.size
          || error.rpcReason !== 'THREAD_NOT_FOUND') throw error
        // Legacy journals from failed first messages can contain an ID whose
        // native rollout never existed. Only this proven-empty case is fresh;
        // never reset a successfully started/history-bearing native thread.
        state.threadId = undefined
        response = await client.request('thread/start', { ...params, experimentalRawEvents: true }, { signal })
        ctx.logger?.warn('Recovered an unstarted native thread with no rollout; no model history was discarded.')
      }
      if (typeof response.thread?.id !== 'string') throw new Error('Native Codex returned no thread identity')
      state.threadId = response.thread.id
      state.threads.add(state.threadId)
      state.observer = undefined
      state.observationFailed = false
      try { state.observer = response.thread.path ? createNativeObserver({ nativeHome, rolloutPath: response.thread.path }) : undefined }
      catch {
        state.observationFailed = true
        ctx.logger?.warn('Unsafe/unavailable native observation path; native execution is unchanged.')
      }
      await save(state)
    } catch (error) {
      await client.close()
      state.client = undefined
      throw error
    }
  }

  function registerPresenter(item) {
    const toolName = view.nativeToolName(item)
    if (!toolName || toolName === marker?.name || registeredTools.has(toolName) || !helpers?.defineTool) return
    ctx.tools.register(helpers.defineTool({ name: toolName,
      description: 'Human-only observation of an official Codex tool. Never dispatched by DSH.',
      parameters: { item: { type: 'json', required: true } },
      output: { schema: { type: 'object', additionalProperties: false, properties: { item: { type: 'json', required: true } } },
        render: (_args, value) => view.nativeResultContent(value.item) },
      presentCall: args => view.nativeCallPresentation(args.item),
      presentResult: (args, result) => view.nativeResultPresentation(args.item, result),
      execute() { throw new Error('Native Codex owns this tool; DSH observations cannot execute it.') },
    }))
    registeredTools.add(toolName)
  }

  function shadowObservation(state, position, event) {
    // Replacement surfaces affect MODEL history only. Human append-origin
    // observations/cards remain available, including after disk cold restore.
    const empty = helpers.createDeveloperMessage ? helpers.createDeveloperMessage({
      source: { kind: 'tool-registry' }, content: [],
    }) : { role: 'developer', id: randomUUID(), source: { kind: 'tool-registry' }, content: [] }
    state.agent.session.append('developer/message', { ...position, message: empty }, {
      surfaceOp: { op: 'replace', startSeq: event.seq, endSeq: event.seq }, sourceEventSeqs: [event.seq],
    })
  }

  function observe(state, item, threadId, completed = false, provisional = false) {
    if (!item?.id || NON_TOOLS.has(item.type)) return
    if (threadId !== state.threadId && !state.threads.has(threadId)) return
    if (item.type === 'collabAgentToolCall') for (const id of item.receiverThreadIds ?? []) state.threads.add(id)
    const key = `${threadId}:${item.id}`
    let call = state.calls.get(key)
    let corrected
    if (call?.settled) {
      if (!completed || provisional || !call.provisional) return
      corrected = call
      call = undefined
    }
    if (!call) {
      registerPresenter(item)
      const toolName = view.nativeToolName(item)
      if (!toolName) return
      const callId = corrected ? `${corrected.callId}:native-final` : `codex:${key}`
      const args = view.nativeToolArguments(item)
      if (corrected) args.description = `Updated native result: ${args.description ?? toolName}`
      const argumentsJson = JSON.stringify(args)
      const block = { type: 'tool-call', id: callId, name: toolName, arguments: argumentsJson }
      // Released V4 requires an assistant/message advertisement BEFORE every
      // tool/call, even human-only native observations. This is a projection of
      // the actual native call, not a DSH model generation or executable request.
      // Its private provenance cannot masquerade as the configured DSH model.
      const source = { provider: NATIVE_PROVIDER, model: 'native-observation', privateNativeObservation: true }
      const message = helpers.createAssistantMessage ? helpers.createAssistantMessage({ source, content: [block] })
        : { role: 'assistant', id: randomUUID(), source: { kind: 'model', ...source }, content: [block] }
      const time = Date.now()
      const advertisement = state.agent.session.append('assistant/message', { ...state.position, message,
        stream: [
          { type: 'chunk', time, chunk: { type: 'block-start', index: 0, blockType: 'tool-call' } },
          { type: 'chunk', time, chunk: { type: 'block-end', index: 0, block } },
          { type: 'chunk', time, chunk: { type: 'finish', reason: { kind: 'tool-calls' } } },
        ] }, { surfaceOp: 'append' })
      // Neither advertisement nor result may survive into standard's provider
      // history. Shadow immediately, while retaining the canonical disk lifecycle.
      shadowObservation(state, state.position, advertisement)
      const event = state.agent.session.append('tool/call', { ...state.position, callId, name: toolName,
        arguments: argumentsJson })
      call = { callId, seq: event.seq, threadId, item: structuredClone(item), position: { ...state.position }, settled: false,
        ...(corrected ? { correctsCallId: corrected.callId } : {}) }
      state.calls.set(key, call)
    }
    if (call.settled) return
    call.item = structuredClone(item)
    if (!completed) return
    const isError = ['failed', 'declined', 'interrupted', 'cancelled'].includes(item.status) || item.success === false
    const message = helpers.createToolResultMessage({ callId: call.callId, content: view.nativeResultContent(item), isError })
    const projectedMeta = view.nativePresentationMeta?.(item)
    const meta = call.correctsCallId ? { ...projectedMeta, correctsCallId: call.correctsCallId } : projectedMeta
    const result = state.agent.session.append('tool/result', { ...call.position, message, ...(meta ? { meta } : {}) },
      { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
    // The result append has committed. A later projection failure must not
    // retry a second orphan result for the already-settled native observation.
    call.settled = true
    call.provisional = provisional
    // As with its advertisement, retain the human result but hide it from
    // model history. Ordinary user/assistant messages are never shadowed here.
    shadowObservation(state, call.position, result)
  }

  async function readObservations(state) {
    if (!state.observer || state.observationFailed) return
    try {
      let changed = false
      for (const item of await state.observer.read()) {
        const key = `${state.threadId}:${item.id}`
        if (state.observed.has(key)) continue
        observe(state, item, state.threadId, item.completed === true)
        if (item.completed === true) { state.observed.add(key); changed = true }
      }
      if (changed) await save(state)
    } catch {
      // Human telemetry failure must never change the native model/agent turn.
      // The observer fails closed on an unsafe path; do not retry/fabricate it.
      state.observationFailed = true
      ctx.logger?.warn('Native Codex direct-tool observation is unavailable; native execution is unchanged.')
    }
  }

  function settlePending(state) {
    for (const call of state.calls.values()) {
      if (call.settled) continue
      observe(state, { ...call.item, status: 'interrupted' }, call.threadId, true, true)
    }
  }

  async function handleInteractions(state, signal) {
    while (state.interactions.length) {
      const pending = state.interactions.shift()
      state.pendingRequests++
      // Do not await here: questions/approvals must not block the notification
      // pump or unrelated server requests. They still settle within this turn.
      const requestSignal = pending.params.isBlocking === false ? pending.controller.signal
        : AbortSignal.any([signal, pending.controller.signal])
      Promise.resolve(handleNativeRequest({ ctx, agent: state.agent, method: pending.method, params: pending.params,
        signal: requestSignal, callId: pending.params.itemId ? `codex:${pending.params.threadId}:${pending.params.itemId}` : undefined,
        nativePolicy: pending.policy ?? state.turnPolicy ?? nativePolicyFor(ctx, state.agent, state.profile) }))
        .then(pending.resolve, pending.reject).finally(() => {
          state.pendingRequests--
          state.queue.push({ method: 'bridge/interaction-settled', params: {} })
        }).catch(() => {})
    }
  }

  async function steer(state, messages) {
    const selected = messages.filter(message => DIRECT(message) && !state.controlIds.has(String(message.id))
      && !state.delivered.has(String(message.id)) && !state.uncertain.has(String(message.id))
      && !state.admitted.some(current => current.id === message.id))
    if (!selected.length || !state.nativeTurnId || !state.active) return
    const input = await resolveNativeInput(ctx, selected, state.signal)
    if (!input.length) return
    try {
      await state.client.request('turn/steer', { threadId: state.threadId, expectedTurnId: state.nativeTurnId, input }, { signal: state.signal })
    } catch (error) {
      if (!Number.isInteger(error.code)) {
        // Lost acknowledgement is not proof of non-admission. Do not replay
        // this ID into a later native turn; require an explicit new user retry.
        for (const message of selected) state.uncertain.add(String(message.id))
        await save(state)
        ctx.logger?.warn('Native steering delivery is uncertain; resend explicitly with a new request ID if required.')
      }
      throw error
    }
    for (const message of selected) {
      state.delivered.add(String(message.id))
      state.agent.session.append('user/message', message, { surfaceOp: 'append' })
    }
    await save(state)
  }

  async function* stream(state, options) {
    const blocks = new Map()
    let nextIndex = 0
    let usage
    let finished = false
    let running = false
    let failure
    const signal = options.signal
    const cancellation = new AbortController()
    let interruptPromise
    const interrupt = () => {
      if (!interruptPromise && state.client && state.nativeTurnId && !state.client.isClosed) {
        interruptPromise = state.client.request('turn/interrupt', {
          threadId: state.threadId, turnId: state.nativeTurnId }, { timeoutMs: 5000 }).catch(() => {})
      }
      return interruptPromise ?? Promise.resolve()
    }
    const abort = () => {
      cancellation.abort(signal?.reason)
      state.queue.push({ method: 'bridge/abort', params: {} })
      void interrupt()
    }
    const interactionSignal = signal ? AbortSignal.any([signal, cancellation.signal]) : cancellation.signal
    state.active = true
    state.background = false
    state.signal = interactionSignal
    state.nativeTurnId = undefined
    const abortSubscription = signal ? addAbortListener(signal, abort) : undefined
    const blockFor = (id, kind) => {
      let block = blocks.get(id)
      if (!block) {
        block = { index: nextIndex++, kind, text: '', closed: false }
        blocks.set(id, block)
        return [block, { type: 'block-start', index: block.index, blockType: kind }]
      }
      return [block, undefined]
    }
    try {
      signal?.throwIfAborted()
      const nativeOptions = state.requestedConfig ? { ...options, model: state.requestedConfig.model,
        reasoningEffort: state.requestedConfig.reasoningEffort } : options
      // Validate/resolve admitted UI input BEFORE login/thread creation. Bad
      // input must not leave a memory-only thread bound in the journal.
      const admittedInput = await resolveNativeInput(ctx, state.admitted, interactionSignal)
      await ensureThread(state, nativeOptions, interactionSignal)
      state.currentUsage = createNativeUsageCounter({ baseline: state.usageBaseline })
      const selected = state.admitted.filter(message => !state.delivered.has(String(message.id)) && !state.uncertain.has(String(message.id)) && !state.controlIds.has(String(message.id)))
      const queuedAnswers = [...(state.asyncInput ?? [])]
      const input = [...(selected.length === state.admitted.length ? admittedInput : await resolveNativeInput(ctx, selected, interactionSignal)), ...queuedAnswers]
      let compacting = state.compactPending === true
      const callbackOnly = input.length === 0 && !compacting
      const startUserTurn = async () => {
        const policy = nativePolicyFor(ctx, state.agent, state.profile)
        state.turnPolicy = structuredClone(policy)
        const response = await state.client.request('turn/start', { threadId: state.threadId, input,
          cwd: state.agent.session.header.cwd ?? process.cwd(), approvalPolicy: policy.approvalPolicy,
          sandboxPolicy: nativeSandboxPolicy(policy, state.agent.session.header.cwd ?? process.cwd()),
          ...nativeTurnSettings(state, nativeOptions) }, { signal: interactionSignal })
        state.nativeTurnId = response.turn?.id ?? state.nativeTurnId
        if (!state.nativeTurnId) throw new Error('Native Codex returned no turn identity')
        running = true
        state.threadStarted = true
        state.asyncInput = (state.asyncInput ?? []).slice(queuedAnswers.length)
        for (const message of selected) state.delivered.add(String(message.id))
        await save(state)
      }
      if (compacting) {
        await state.client.request('thread/compact/start', { threadId: state.threadId }, { signal: interactionSignal })
        state.compactPending = false
        running = true
      } else if (!callbackOnly) await startUserTurn()
      while (!finished) {
        await handleInteractions(state, interactionSignal)
        if (callbackOnly && !state.pendingRequests && !state.queue.items.length) break
        const { method, params } = await state.queue.next()
        if (method === 'bridge/abort') {
          signal?.throwIfAborted()
          throw new Error('Native Codex turn aborted')
        }
        if (method === 'bridge/failure') {
          if (params.client === state.client) throw params.error
          continue
        }
        if (method === 'rawResponseItem/completed') {
          await readObservations(state)
          continue
        }
        if (method === 'turn/completed') {
          if (params.threadId !== state.threadId || params.turn.id !== state.nativeTurnId) continue
          await readObservations(state)
          if (params.turn.status !== 'completed') {
            failure = { message: params.turn.error?.message ?? `Native Codex turn ${params.turn.status}`,
              code: 'NATIVE_CODEX_TURN_FAILED' }
          }
          running = false
          if (compacting) await save(state)
          if (compacting && !failure && input.length) {
            compacting = false
            state.nativeTurnId = undefined
            await startUserTurn()
          } else finished = true
          continue
        }
        if (method === 'error' && params.threadId === state.threadId && params.willRetry === false) {
          failure = { message: params.error?.message ?? 'Native Codex request failed', code: 'NATIVE_CODEX_REQUEST_FAILED' }
          continue
        }
        if (method === 'thread/tokenUsage/updated' && params.threadId === state.threadId) continue
        if (method === 'item/started' || method === 'item/completed') {
          const item = params.item
          const complete = method === 'item/completed'
          if (complete) await readObservations(state)
          if (!item) continue
          if (params.threadId !== state.threadId || !['agentMessage', 'reasoning', 'plan'].includes(item.type)) {
            observe(state, item, params.threadId, complete)
            continue
          }
          const kind = item.type === 'reasoning' ? 'reasoning' : 'text'
          const [block, start] = blockFor(item.id, kind)
          if (start) yield start
          if (complete && !block.closed) {
            const full = item.type === 'reasoning' ? (item.summary?.join('\n') || item.content?.join('\n') || block.text) : item.text ?? block.text
            if (full.startsWith(block.text) && full.length > block.text.length) {
              const delta = full.slice(block.text.length)
              yield { type: kind === 'text' ? 'text-delta' : 'reasoning-delta', index: block.index, text: delta }
            }
            block.text = full
            block.closed = true
            yield { type: 'block-end', index: block.index, block: { type: kind, text: full } }
            if (item.type === 'agentMessage' && item.delivery === 'async' && item.questions?.length && !state.asyncQuestions.has(item.id)) {
              state.asyncQuestions.add(item.id)
              const epoch = state.epoch, threadId = state.threadId, lifetime = state.lifetime
              void handleNativeAsyncQuestions({ ctx, agent: state.agent, params: { item }, signal: lifetime.signal }).then(async answer => {
                if (!answer?.length || disposed || lifetime.signal.aborted || state.epoch !== epoch
                  || state.threadId !== threadId || !owns(state)) return
                if (state.active && state.nativeTurnId && state.client && !state.client.isClosed) {
                  try {
                    await state.client.request('turn/steer', { threadId,
                      expectedTurnId: state.nativeTurnId, input: answer })
                    return
                  } catch (error) {
                    // An explicit RPC refusal (e.g. the turn just completed)
                    // did not admit the answer. Preserve it for the next turn.
                    // A transport failure has ambiguous delivery: do not replay
                    // automatically and risk duplicating model-visible input.
                    if (!Number.isInteger(error.code)) {
                      ctx.logger?.warn('Native Codex could not confirm async-answer delivery; retry the answer explicitly.')
                      return
                    }
                  }
                }
                if (lifetime.signal.aborted || state.epoch !== epoch || state.threadId !== threadId) return
                state.asyncInput = [...(state.asyncInput ?? []), ...answer]
                await save(state)
                await scheduleBackground(state)
              }).catch(() => {})
            }
          }
          continue
        }
        if (params.threadId === state.threadId && ['item/agentMessage/delta', 'item/plan/delta',
          'item/reasoning/summaryTextDelta', 'item/reasoning/textDelta'].includes(method)) {
          const kind = method.includes('/reasoning/') ? 'reasoning' : 'text'
          const [block, start] = blockFor(params.itemId, kind)
          if (start) yield start
          if (!block.closed && typeof params.delta === 'string') {
            block.text += params.delta
            yield { type: kind === 'text' ? 'text-delta' : 'reasoning-delta', index: block.index, text: params.delta }
          }
        }
      }
      await state.steerTail
    } catch (error) {
      failure = { message: safeError(error), code: nativeFailureCode(error) }
      if (!state.threadStarted && Number.isInteger(error.code)) {
        // A protocol refusal before the first turn ACK admitted no user/model
        // history. The memory-only thread must not be resumed on another try.
        state.threadId = undefined
        state.nativeTurnId = undefined
        state.threads.clear()
        state.observer = undefined
        state.observationFailed = false
      }
    } finally {
      abortSubscription?.[Symbol.dispose]()
      cancellation.abort()
      for (const request of state.interactions.splice(0)) request.reject(new Error('Native interaction cancelled'))
      try { settlePending(state) }
      catch (error) {
        failure ??= { message: safeError(error), code: 'NATIVE_OBSERVATION_FAILED' }
        ctx.logger?.warn('Native observation settlement failed; transport cleanup will still run.')
      }
      try { if (state.opaqueRoute) {
        const header = state.agent.session.requestHeader?.()
        if (header?.config?.provider === NATIVE_PROVIDER) {
          state.agent.session.append('request/header', { header: { ...header, config: state.requestedConfig }, reason: 'change' })
          state.agent.session.append('request/context', { provider: state.requestedConfig.provider,
            model: state.requestedConfig.model })
        }
      } } catch (error) {
        failure ??= { message: safeError(error), code: 'NATIVE_HEADER_RESTORE_FAILED' }
      }
      usage = state.currentUsage?.usage()
      if (state.currentUsage) state.usageBaseline = state.currentUsage.snapshot()
      state.currentUsage = undefined
      if (state.threadId) await save(state).catch(() => { ctx.logger?.warn('Native usage journal could not be saved.') })
      state.active = false
      state.signal = undefined
      if ((signal?.aborted || failure || running) && state.client) {
        const client = state.client
        await interrupt()
        await client.close()
        state.client = undefined
      }
      if (!disposed && owns(state) && ((state.asyncInput?.length ?? 0) > 0 || state.interactions.length)) {
        await scheduleBackground(state)
      }
    }
    for (const block of blocks.values()) if (!block.closed) {
      block.closed = true
      yield { type: 'block-end', index: block.index, block: { type: block.kind, text: block.text } }
    }
    if (usage) yield { type: 'usage', usage }
    yield { type: 'finish', reason: failure ? { kind: signal?.aborted ? 'aborted' : 'error', failure } : { kind: 'stop' } }
  }

  const stopPreStep = ctx.on('agent/pre-step', payload => {
    const state = stateFor(payload.agent)
    state.position = { turn: payload.turn, step: payload.step }
    state.admitted = payload.messages.filter(message => DIRECT(message) && !state.controlIds.has(String(message.id))
      && !state.delivered.has(String(message.id)) && !state.uncertain.has(String(message.id)))
    if (!state.admitted.length && !state.interactions.length && !state.queue.items.length && !state.compactPending && !state.asyncInput?.length) return { kind: 'reject' }
    // Short-circuit only this preset's pre-step: no DSH compaction, injected
    // runtime context, skills catalog, or persona participates in native input.
    return { kind: 'enter', messages: payload.messages }
  }, { prepend: true })

  const stopRequest = ctx.on('agent/request', async (payload, next) => {
    const result = await next()
    const state = stateFor(payload.agent)
    state.position = { turn: payload.turn, step: payload.step }
    state.requestedConfig = result
    state.opaqueRoute = false
    // DSH's advisory metadata catalog must not block GPT models/aliases that
    // the official manager supports. Only missing metadata takes the temporary
    // middleware-only route; its header is restored before leaving this step.
    if (ctx.llm?.resolveModelInfo) {
      try { await ctx.llm.resolveModelInfo(result.provider, result.model, payload.signal) }
      catch (error) {
        if (error.code === 'NO_ADAPTER') return result
        if (error.code !== 'UNKNOWN_MODEL') throw error
        state.opaqueRoute = true
        return { ...result, provider: NATIVE_PROVIDER }
      }
    }
    return result
  }, { prepend: true })

  const stopPrompt = ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const result = await next()
    return { ...result, tools: [] }
  }, { prepend: true })

  const stopStream = ctx.on('llm/stream', (options, next) => {
    const state = states.get(String(options.sessionId))
    if (!state || !owns(state) || (options.provider !== state.requestedConfig?.provider && options.provider !== NATIVE_PROVIDER)) return next()
    if (options.purpose === 'session-title') {
      const title = state.title ?? state.admitted.flatMap(message => message.content)
        .find(block => block.type === 'text')?.text.split('\n')[0].slice(0, 120) ?? 'Codex'
      return (async function* () {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: title }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: title } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    }
    if (options.purpose === 'compaction') return (async function* () {
      yield { type: 'finish', reason: { kind: 'error', failure: {
        code: 'NATIVE_COMPACTION_ONLY', message: 'Use /codex-compact; DSH summary calls cannot rewrite native Codex history.' } } }
    })()
    if (!helpers.isAgentLoopRequest(options)) return next()
    return stream(state, options)
  })

  const stopEvents = ctx.on('session/event', (session, event) => {
    const state = states.get(String(session.id))
    if (!state || !owns(state) || !state.active || event.type !== 'agent/inbox/spliced' || !state.nativeTurnId) return
    state.steerTail = state.steerTail.catch(() => {}).then(() => steer(state, event.data.inserted ?? [])).catch(() => {
      // A turn can finish before steer admission; leave unacknowledged input
      // in the DSH inbox for the next native turn. Never silently discard it.
    })
  })

  async function closeState(state) {
    // Withdraw routing ownership before waiting for durable IO/child shutdown.
    // A disposed agent must never remain eligible for another native request.
    if (states.get(state.id) === state) states.delete(state.id)
    const error = new Error('Codex session disposed')
    state.epoch++
    state.lifetime.abort(error)
    state.accessToken = undefined
    state.accountId = undefined
    for (const request of state.interactions.splice(0)) request.reject(error)
    for (const request of state.requests.values()) request.controller.abort(error)
    if (state.active) state.queue.push({ method: 'bridge/failure', params: { error, client: state.client } })
    await state.client?.close()
    await state.saveTail.catch(() => {})
    if (states.get(state.id) === state) states.delete(state.id)
  }
  const stopDisposed = ctx.on('agent/disposed', ({ agent }) => {
    const state = states.get(String(agent.session.id))
    if (state) void closeState(state).catch(() => {})
  })

  ctx.inject(['commands'], commandCtx => {
    const command = (commandName, hint, handler) => commandCtx.commands.register({ name: commandName,
      description: `Official Codex preset: ${commandName}`, ...(hint ? { input: { hint } } : {}), handler: async ({ agent, rawInput }) => {
        try { return await handler(stateFor(agent), rawInput.trim()) }
        catch (error) { return { kind: 'error', text: safeError(error) } }
      } })
    command('codex-permission', '<codex-read-only|codex-on-request|codex-full-access>', async (state, input) => {
      await load(state)
      if (input) {
        if (!Object.hasOwn(CODEX_NATIVE_PROFILES, input)) return { kind: 'error', text: `Choose ${Object.keys(CODEX_NATIVE_PROFILES).join(', ')}.` }
        state.profile = input
        state.preferencesChanged = true
        await save(state)
      }
      const policy = nativePolicyFor(ctx, state.agent, state.profile)
      return { kind: 'success', text: `Native Codex: ${policy.sandbox}; approval ${policy.approvalPolicy}. This selection is confined to this Codex session; host/standard permissions are unchanged.` }
    })
    command('codex-mode', '<default|plan>', async (state, input) => {
      await load(state)
      if (input && !['default', 'plan'].includes(input)) return { kind: 'error', text: 'Choose default or plan.' }
      if (input) { state.mode = input; state.preferencesChanged = true; await save(state) }
      return { kind: 'success', text: `Native Codex collaboration mode: ${state.mode ?? 'default'}. Official built-in instructions apply on the next turn.` }
    })
    command('codex-persistent', '<on|off>', async (state, input) => {
      await load(state)
      if (input && !['on', 'off'].includes(input)) return { kind: 'error', text: 'Choose on or off.' }
      if (input) { state.persistent = input === 'on'; state.preferencesChanged = true; await save(state) }
      return { kind: 'success', text: `Native Codex persistent effort: ${state.persistent ? 'on' : 'off'}.` }
    })
    command('codex-compact', '', async state => {
      await load(state)
      if (!state.threadId) return { kind: 'error', text: 'There is no native thread to compact yet.' }
      state.compactPending = true
      await save(state)
      await scheduleBackground(state)
      return { kind: 'success', text: 'Official Codex compaction queued. DSH summarization/pruning is not used.' }
    })
    command('codex-new-thread', '<confirm>', async (state, input) => {
      if (input !== 'confirm') return { kind: 'error', text: 'Use /codex-new-thread confirm to explicitly start fresh native model history; the visible DSH transcript is retained.' }
      if (state.active) return { kind: 'error', text: 'Stop the running turn before starting a new thread.' }
      state.epoch++
      state.lifetime.abort(new Error('Native thread reset'))
      state.lifetime = new AbortController()
      for (const pending of state.requests.values()) pending.controller.abort(new Error('Native thread reset'))
      for (const pending of state.interactions.splice(0)) pending.reject(new Error('Native thread reset'))
      await state.client?.close()
      state.client = undefined
      state.threadId = undefined
      state.threadStarted = false
      state.accessToken = undefined
      state.accountId = undefined
      state.accountFingerprint = undefined
      state.nativeTurnId = undefined
      state.turnPolicy = undefined
      state.usageBaseline = undefined
      state.currentUsage = undefined
      state.threads.clear()
      state.asyncQuestions.clear()
      state.asyncInput = []
      state.compactPending = false
      state.loaded = false
      state.fresh = true
      state.delivered.clear()
      state.uncertain.clear()
      state.queue = new NotificationQueue()
      state.calls.clear()
      state.observed.clear()
      state.observer = undefined
      state.observationFailed = false
      await fs.unlink(state.journal).catch(error => { if (error.code !== 'ENOENT') throw error })
      return { kind: 'success', text: 'The next user message starts a fresh official Codex thread. No legacy transcript will be injected.' }
    })
    command('codex-runtime', '', state => ({ kind: 'success', text: `Official Codex ${config.runtimeVersion ?? OFFICIAL_RUNTIME_VERSION} (${revision})\nNative home: ${nativeHome}\nThread: ${state.threadId ?? '(not started)'}\nOnly direct user input is forwarded; UI observations never re-enter model history.` }))
  })

  return { states, stream, stateFor, async dispose() {
    disposed = true
    for (const stop of [stopPreStep, stopRequest, stopPrompt, stopStream, stopEvents, stopDisposed]) stop?.()
    await Promise.all([...states.values()].map(closeState))
  } }
}

// Opt-in validation installs the SAME production helper/ownership path while
// injecting an in-memory auth broker and an outer confined transport. Secrets
// are never part of Loader configuration or the recorded model request.
export async function installNativeBridge(ctx, config = {}, dependencies = {}) {
  const dshHome = config.dshHome ?? process.env.DSH_HOME ?? path.join(process.env.HOME, '.dsh')
  const require = createRequire(path.join(dshHome, 'profiles/codex-native.cjs'))
  const llm = await import(require.resolve('@deepseek-ai/dsh-llm'))
  const tools = await import(require.resolve('@deepseek-ai/dsh-tools'))
  ctx.isolate('codexNativeInputAdmission').provide('codexNativeInputAdmission', codexNativeInputAdmission)
  const bridge = createNativeBridge(ctx, config, { ...dependencies, helpers: {
    isAgentLoopRequest: llm.isAgentLoopRequest, createUserMessage: llm.createUserMessage,
    createToolResultMessage: llm.createToolResultMessage, createDeveloperMessage: llm.createDeveloperMessage,
    defineTool: tools.defineTool,
  } })
  ctx.on('dispose', () => bridge.dispose())
  return bridge
}

export async function apply(ctx, config = {}) {
  const bridge = await installNativeBridge(ctx, config)
  return () => bridge.dispose()
}
