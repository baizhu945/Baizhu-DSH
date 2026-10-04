/**
 * DSH-owned OAuth for native Codex. No private CODEX_HOME auth document,
 * background rotation, token cache, logging, or subprocess arguments.
 *
 * Send the returned object ONLY over nativeRPC's stdin: account/login/start uses
 * { type: 'chatgptAuthTokens', ...credentials }; a server-initiated
 * account/chatgptAuthTokens/refresh uses credentials({ forceRefresh: true })
 * and must supply chatgptPlanType: result.chatgptPlanType ?? null. When known,
 * pass previousAccessToken (the token that received 401) to scope forceRefresh;
 * a delayed 401 must not rotate a newer login/rotation that already replaced it.
 */
import { realpathSync } from 'node:fs'
import { addAbortListener } from 'node:events'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const PROVIDER = 'openai-codex'
const REFRESH_SKEW_MS = 60_000

// Upstream store/OAuth errors can contain token responses (including secrets).
// Never forward their message, stack, cause, or an AbortSignal's reason.
class NativeAuthError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
    if (code === 'ABORT_ERR') this.name = 'AbortError'
  }
}

function checkAbort(signal) {
  if (signal?.aborted) throw new NativeAuthError('ABORT_ERR', 'Native Codex authentication was aborted')
}

// Reject the caller promptly without releasing an in-progress store lock or
// starting a second rotation. The operation still checks abort before writes.
function withAbort(operation, signal) {
  if (!signal) return operation()
  return new Promise((resolve, reject) => {
    let listener
    let settled = false
    const finish = (settle, value) => {
      if (settled) return
      settled = true
      try { listener?.[Symbol.dispose]() } catch {}
      settle(value)
    }
    const abort = () => finish(reject,
      new NativeAuthError('ABORT_ERR', 'Native Codex authentication was aborted'))
    listener = addAbortListener(signal, abort)
    if (signal.aborted) { abort(); return }
    try { Promise.resolve(operation()).then(value => finish(resolve, value), error => finish(reject, error)) }
    catch (error) { finish(reject, error) }
  })
}

function text(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function identityText(value) {
  const identity = text(value)
  return identity && !/[\s\x00-\x1f\x7f]/u.test(identity) ? identity : undefined
}

function validateCredential(credential, refreshed = false) {
  if (credential === undefined && !refreshed) {
    throw new NativeAuthError('CODEX_AUTH_MISSING', 'Native Codex requires a DSH OpenAI login; run /auth login openai-codex first')
  }
  if (credential === null || typeof credential !== 'object' || credential.type !== 'oauth'
    || !text(credential.access) || !text(credential.refresh)
    || /[\s\x00-\x1f\x7f]/u.test(credential.access)
    || /[\s\x00-\x1f\x7f]/u.test(credential.refresh)
    || !Number.isFinite(credential.expires)) {
    throw new NativeAuthError('CODEX_AUTH_INVALID', refreshed
      ? 'Native Codex OAuth refresh returned incomplete credentials'
      : 'Native Codex found invalid DSH OAuth credentials; run /auth login openai-codex again')
  }
}

function tokenPayload(access) {
  try {
    const parts = access.split('.')
    if (parts.length !== 3 || !/^[A-Za-z0-9_-]+$/u.test(parts[1])) return undefined
    const bytes = Buffer.from(parts[1], 'base64url')
    if (bytes.toString('base64url') !== parts[1]) return undefined
    const payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    return payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? payload : undefined
  } catch {
    return undefined
  }
}

function accountClaims(access) {
  const claims = tokenPayload(access)?.['https://api.openai.com/auth']
  return claims !== null && typeof claims === 'object' && !Array.isArray(claims) ? claims : undefined
}

function credentialExpiry(credential) {
  const exp = tokenPayload(credential.access)?.exp
  if (exp === undefined) return credential.expires
  if (typeof exp !== 'number' || !Number.isFinite(exp * 1000)) {
    throw new NativeAuthError('CODEX_AUTH_INVALID', 'Native Codex found an invalid OAuth token expiry')
  }
  // The store's expiry must not make an already-expired JWT usable.
  return Math.min(credential.expires, exp * 1000)
}

function nativeCredentials(credential) {
  // Claims are metadata extraction from an existing DSH credential, not JWT
  // signature verification. Never guess an account from unrelated JWT fields.
  const claims = accountClaims(credential.access)
  const chatgptAccountId = identityText(credential.accountId) ?? identityText(claims?.chatgpt_account_id)
  if (!chatgptAccountId) {
    throw new NativeAuthError('CODEX_AUTH_ACCOUNT_MISSING', 'Native Codex could not determine the ChatGPT account ID; run /auth login openai-codex again')
  }
  const chatgptPlanType = identityText(credential.planType) ?? identityText(claims?.chatgpt_plan_type)
  return {
    accessToken: credential.access,
    chatgptAccountId,
    ...(chatgptPlanType ? { chatgptPlanType } : {}),
  }
}

function sameRevision(a, b) {
  return a != null && b != null
    && a.access === b.access && a.refresh === b.refresh && a.expires === b.expires
    && a.accountId === b.accountId && a.planType === b.planType
}

function piAiFromLlm(requireFromDsh, home) {
  const anchors = [requireFromDsh]
  // CLI modules can be resolved dynamically by DSH rather than linked into
  // profiles/node_modules. Resolve from the running host too, never from a
  // guessed shared pi-ai link. Launcher DSH_PI_AI_ROOT takes priority below.
  if (process.argv[1]) {
    try { anchors.push(createRequire(realpathSync(process.argv[1]))) } catch { /* no host entry */ }
  }
  for (const profile of ['desktop', 'dsh-tui', 'headless', 'web']) {
    anchors.push(createRequire(join(home, 'profiles', profile, 'package.json')))
  }
  for (const anchor of anchors) {
    let llmEntry
    try {
      try { llmEntry = anchor.resolve('@deepseek-ai/dsh-llm-pi-ai/package.json') }
      catch { llmEntry = anchor.resolve('@deepseek-ai/dsh-llm-pi-ai') }
      llmEntry = realpathSync(llmEntry)
    } catch { continue }
    // Realpath FIRST: a symlinked profile package must use its own runtime's
    // dependency tree, not an older pi-ai in the shared profile directory.
    const fromLlm = createRequire(llmEntry)
    // pi-ai exposes import-only exports and hides package.json. Walking this
    // owner's Node search paths also works with pnpm links and hoisted npm.
    for (const directory of fromLlm.resolve.paths('@earendil-works/pi-ai') ?? []) {
      try { return realpathSync(join(directory, '@earendil-works/pi-ai')) } catch { /* next owner path */ }
    }
    // A resolved current adapter with a broken dependency must not silently
    // select another profile's adapter/version.
    break
  }
  throw new NativeAuthError('CODEX_AUTH_DEPENDENCY', 'Native Codex could not resolve the DSH pi-ai OAuth runtime')
}

/**
 * Dependency-lazy factory; neither construction nor import reads credentials.
 * store and oauth accept objects OR promises of objects. store is the canonical
 * CredentialFile read/modify interface; oauth is { refresh(credential, signal) }.
 * clock is a function returning epoch milliseconds (or an object with now()).
 * Inject both dependencies for offline tests. Only dependency promises are
 * cached: every call obtains the current credential under the store's lock.
 */
export function createNativeAuth({ dshHome, piAiRoot, credentialFile, store, oauth, clock = Date.now } = {}) {
  const home = resolve(dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'))
  const file = credentialFile ?? text(process.env.DSH_AUTH_CREDENTIALS) ?? join(home, 'dsh-auth', 'credentials.json')
  const piRoot = text(piAiRoot) ?? text(process.env.DSH_PI_AI_ROOT)
  const anchor = process.env.DSH_CODEX_REQUIRE_ANCHOR || join(home, 'profiles', 'codex-native-auth.cjs')
  let requireFromDsh
  let storePromise
  let oauthPromise
  const runtimeRequire = () => requireFromDsh ??= createRequire(anchor)
  const readClock = () => {
    const now = typeof clock === 'function' ? clock() : clock.now()
    if (!Number.isFinite(now)) throw new NativeAuthError('CODEX_AUTH_CLOCK', 'Native Codex authentication requires a valid clock')
    return now
  }

  const getStore = () => storePromise ??= (async () => {
    try {
      if (store !== undefined) return await store
      const manifest = runtimeRequire().resolve('@deepseek-harness-tui/dsh-tui/package.json')
      // Import the store only: the public TUI/OAuth entry mounts heavy peers.
      const { CredentialFile } = await import(pathToFileURL(join(dirname(manifest), 'lib/types/dsh-adapter/oauth/credentials.js')).href)
      return new CredentialFile(file)
    } catch {
      throw new NativeAuthError('CODEX_AUTH_DEPENDENCY', 'Native Codex could not load the DSH OAuth credential store')
    }
  })()

  const getOAuth = () => oauthPromise ??= (async () => {
    try {
      if (oauth !== undefined) return await oauth
      const root = piRoot ?? piAiFromLlm(runtimeRequire(), home)
      const { openaiCodexOAuth } = await import(pathToFileURL(join(root, 'dist/auth/oauth/openai-codex.js')).href)
      return openaiCodexOAuth
    } catch {
      throw new NativeAuthError('CODEX_AUTH_DEPENDENCY', 'Native Codex could not load the DSH pi-ai OAuth refresh implementation')
    }
  })()

  return {
    async credentials({ signal, forceRefresh = false, previousAccessToken } = {}) {
      try {
        if (signal !== undefined && !(signal instanceof AbortSignal)) {
          throw new NativeAuthError('CODEX_AUTH_INVALID', 'Native Codex authentication requires a valid abort signal')
        }
        if (previousAccessToken !== undefined && (typeof previousAccessToken !== 'string'
          || !previousAccessToken || /[\s\x00-\x1f\x7f]/u.test(previousAccessToken))) {
          throw new NativeAuthError('CODEX_AUTH_INVALID', 'Native Codex authentication requires a valid previous access token')
        }
        checkAbort(signal)
        return await withAbort((async () => {
          const credentialStore = await getStore()
          checkAbort(signal)
          // A forced 401 refresh is scoped to the observed revision. Concurrent
          // clients should reuse a rotation/new login that won the lock, not
          // rotate it again. This snapshot is NEVER used to refresh or return.
          const observed = forceRefresh && previousAccessToken === undefined
            ? await credentialStore.read(PROVIDER) : undefined
          checkAbort(signal)
          let result
          let expires
          await credentialStore.modify(PROVIDER, async current => {
            checkAbort(signal)
            validateCredential(current)
            const now = readClock()
            expires = credentialExpiry(current)
            const nearExpiry = expires - now <= REFRESH_SKEW_MS
            const forceCurrent = forceRefresh && (previousAccessToken === undefined
              ? sameRevision(current, observed) : current.access === previousAccessToken)
            if (!nearExpiry && !forceCurrent) {
              result = nativeCredentials(current)
              return undefined // Canonical modify: leave the entire file unchanged.
            }
            const provider = await getOAuth()
            checkAbort(signal)
            let refreshed
            try {
              // Defend the current document against even a mutating/rejected
              // mock/provider. No refresh occurs outside CredentialFile.modify.
              refreshed = await provider.refresh(structuredClone(current), signal)
            } catch {
              checkAbort(signal)
              throw new NativeAuthError('CODEX_AUTH_REFRESH_FAILED', 'Native Codex OAuth refresh failed; retry or run /auth login openai-codex again')
            }
            checkAbort(signal)
            validateCredential(refreshed, true)
            expires = credentialExpiry(refreshed)
            if (expires <= readClock()) {
              throw new NativeAuthError('CODEX_AUTH_INVALID', 'Native Codex OAuth refresh returned expired credentials')
            }
            // Preserve unrelated DSH metadata, but prefer identity from the new
            // credential/token over an old account ID or subscription plan.
            const claims = accountClaims(refreshed.access)
            const replacement = { ...current, ...refreshed }
            const accountId = identityText(refreshed.accountId) ?? identityText(claims?.chatgpt_account_id)
            const planType = identityText(refreshed.planType) ?? identityText(claims?.chatgpt_plan_type)
            if (accountId) replacement.accountId = accountId
            if (planType) replacement.planType = planType
            else delete replacement.planType
            result = nativeCredentials(replacement) // Validate before committing.
            checkAbort(signal)
            return replacement
          })
          checkAbort(signal)
          if (!result) throw new NativeAuthError('CODEX_AUTH_STORE', 'Native Codex credential store did not provide credentials')
          if (expires <= readClock()) {
            throw new NativeAuthError('CODEX_AUTH_INVALID', 'Native Codex OAuth credentials expired before they could be returned')
          }
          return result
        }), signal)
      } catch (error) {
        if (signal instanceof AbortSignal) checkAbort(signal)
        if (error instanceof NativeAuthError) throw error
        throw new NativeAuthError('CODEX_AUTH_STORE', 'Native Codex could not access the DSH OAuth credential store')
      }
    },
  }
}
