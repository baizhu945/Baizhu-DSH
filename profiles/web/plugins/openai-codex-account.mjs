/**
 * openai-codex-account.mjs — dsh OpenAI 账号登录插件
 *
 * 让 dsh 通过 OpenAI 账号（ChatGPT Plus/Pro 的 token plan）而不是 API key
 * 使用 OpenAI Codex 模型。底层复用 pi-ai 内置的 `openai-codex` provider 与
 * 其 OpenAI Codex OAuth（浏览器 / 设备码）流程，把得到的 OAuth 凭据存到
 * `~/.dsh/openai-codex-credentials.json`，并在每次请求前自动刷新 access token。
 *
 * 能力：
 *   - 注册 `openai-codex` LLM provider 路由（模型：GPT-5.x Codex 系列）
 *   - /openai-login    交互式 OpenAI 账号登录（浏览器或设备码）
 *   - /openai-logout   清除已保存的 OpenAI 账号凭据
 *   - /openai-status   查看登录状态与 token 有效期
 *
 * 说明：
 *   - 本插件必须作为真实文件部署到 `~/.dsh/profiles/web/plugins/`（不能是
 *     home.file 符号链接），否则 ESM 的 bare import 会 realpath 到 /nix/store，
 *     找不到 profile 层的 node_modules。
 *   - 只在 `ctx.llm` 存在时挂载；`commands` / `userQuestions` 通过 `ctx.get`
 *     按需使用，缺少时只降级为“不可交互登录”，不影响加载。
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { LlmError, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { builtinProviders, getBuiltinModels } from '@earendil-works/pi-ai/providers/all'

// pi-ai 的 openaiCodexOAuth 实现没有出现在 package exports 中，但就位于
// dist/auth/oauth/openai-codex.js。通过 import.meta.resolve 定位 pi-ai 根目录，
// 再以绝对 URL 导入，绕开 exports 白名单。
const PI_AI_ROOT = new URL('../', import.meta.resolve('@earendil-works/pi-ai'))
const { openaiCodexOAuth } = await import(new URL('dist/auth/oauth/openai-codex.js', PI_AI_ROOT).href)

const PI_AI_AUTH = {
  credentials: {
    read: async () => undefined,
    list: async () => [],
    modify: async (_providerId, mutate) => mutate(undefined),
    delete: async () => {},
  },
  authContext: {
    env: async () => undefined,
    fileExists: async () => false,
  },
}

export const name = 'openai-codex-account'
export const inject = ['llm']

const PROVIDER = 'openai-codex'
const DISPLAY_NAME = 'OpenAI (ChatGPT 账号)'
const STREAM_IDLE_TIMEOUT_MS = 300_000
const REFRESH_SKEW_MS = 60_000

/** 凭据文件路径：跟随 DSH_HOME，缺省 ~/.dsh。 */
const credentialFile = () => path.join(
  process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'),
  'openai-codex-credentials.json',
)

// ── 凭据存取 ─────────────────────────────────────────────────────────────

async function readCredential() {
  try {
    const raw = await fs.readFile(credentialFile(), 'utf8')
    const value = JSON.parse(raw)
    return value && typeof value === 'object' ? value : undefined
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

async function writeCredential(credential) {
  const file = credentialFile()
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.tmp`
  await fs.writeFile(tmp, JSON.stringify(credential, null, 2), { mode: 0o600 })
  await fs.rename(tmp, file)
}

async function deleteCredential() {
  await fs.rm(credentialFile(), { force: true })
}

/** 简单的进程内刷新串行化：同一时刻只有一个 refresh 在跑。 */
let refreshChain = Promise.resolve()

async function getAccessToken() {
  const credential = await readCredential()
  if (credential === undefined) {
    throw new LlmError(
      'openai-codex: 尚未登录 OpenAI 账号；请运行 /openai-login 完成登录',
      'MISSING_CREDENTIAL',
    )
  }
  if (typeof credential.access !== 'string' || typeof credential.refresh !== 'string') {
    throw new LlmError(
      'openai-codex: 保存的凭据格式无效；请运行 /openai-login 重新登录',
      'INVALID_CREDENTIAL',
    )
  }
  if (typeof credential.expires !== 'number' || credential.expires - Date.now() > REFRESH_SKEW_MS) {
    return credential.access
  }

  const refresh = async () => {
    const current = await readCredential()
    if (current === undefined) {
      throw new LlmError(
        'openai-codex: 尚未登录 OpenAI 账号；请运行 /openai-login 完成登录',
        'MISSING_CREDENTIAL',
      )
    }
    if (current.expires - Date.now() > REFRESH_SKEW_MS) return current.access
    const refreshed = await openaiCodexOAuth.refresh(current)
    if (!refreshed?.access || !refreshed.refresh) {
      throw new LlmError('openai-codex: OAuth refresh 返回了不完整的凭据', 'INVALID_CREDENTIAL')
    }
    await writeCredential(refreshed)
    return refreshed.access
  }

  const run = refreshChain.then(refresh, refresh)
  // 链式推进，让后续并发请求排队；各自的 run 会先读最新文件，避免重复刷新。
  refreshChain = run.then(() => undefined, () => undefined)
  return run
}

// ── pi-ai provider 构造 ───────────────────────────────────────────────────

/** 给 OAuth-only 的 openai-codex provider 补一个 api-key auth，使请求时传入的 access token 生效。 */
function harnessApiKeyAuth() {
  return {
    name: DISPLAY_NAME,
    resolve: async ({ credential }) => ({
      auth: credential?.key === undefined ? {} : { apiKey: credential.key },
      source: DISPLAY_NAME,
    }),
  }
}

function buildCodexProvider() {
  const catalog = builtinProviders().find(provider => provider.id === PROVIDER)
  if (catalog === undefined) {
    throw new Error(`openai-codex-account: pi-ai 内置目录中找不到 provider "${PROVIDER}"`)
  }
  const models = getBuiltinModels(PROVIDER)
  const auth = catalog.auth.apiKey !== undefined
    ? catalog.auth
    : { ...catalog.auth, apiKey: harnessApiKeyAuth() }
  return {
    id: PROVIDER,
    name: DISPLAY_NAME,
    ...catalog.baseUrl === undefined ? {} : { baseUrl: catalog.baseUrl },
    auth,
    getModels: () => models,
    // 委托给 catalog provider：API 实现（openai-codex-responses）与兼容行为完全保留。
    stream: (model, context, options) => catalog.stream(model, context, options),
    streamSimple: (model, context, options) => catalog.streamSimple(model, context, options),
  }
}

function buildProfile() {
  return new Map([[PROVIDER, {
    provider: PROVIDER,
    displayName: DISPLAY_NAME,
    streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
    retryPolicy: resolveRetryPolicy(undefined, `openai-codex-account: ${PROVIDER} retryPolicy`),
    configuredMaxTokens: new Map(),
    piProvider: buildCodexProvider(),
  }]])
}

// ── 登录交互 ──────────────────────────────────────────────────────────────

/**
 * 把 pi-ai 的 AuthInteraction 桥接到 dsh 的 userQuestions UI。
 * `notify` 中的 device_code 事件以 fire-and-forget 对话框展示设备码，
 * auth_url 则缓存在 `lastAuthUrl`，由随后的 manual_code 输入框带出。
 */
function makeInteraction(ctx, userQuestions, agent) {
  let lastAuthUrl
  const log = (...args) => ctx.logger?.info?.(...args)

  return {
    async prompt(prompt) {
      if (prompt.type === 'select') {
        const answer = await userQuestions.ask({
          agent,
          questions: [{
            id: 'openai-oauth-select',
            header: 'OpenAI 登录',
            question: prompt.message,
            options: prompt.options.map(option => ({
              label: option.label,
              ...option.description === undefined ? {} : { description: option.description },
            })),
          }],
        })
        const selected = answer.answers[0]?.selected?.[0]
        const option = prompt.options.find(candidate => candidate.label === selected)
        if (option === undefined) throw new Error('已取消 OpenAI 登录')
        return option.id
      }

      // text / secret / manual_code 都走自由文本输入
      const detail = prompt.type === 'manual_code' && lastAuthUrl !== undefined
        ? `请先打开此链接完成授权：\n${lastAuthUrl}`
        : undefined
      const answer = await userQuestions.ask({
        agent,
        questions: [{
          id: 'openai-oauth-input',
          header: 'OpenAI 登录',
          question: prompt.message,
          ...detail === undefined ? {} : { detail },
        }],
      })
      const custom = answer.answers[0]?.custom
      if (custom === undefined || custom.trim().length === 0) throw new Error('已取消 OpenAI 登录')
      return custom.trim()
    },
    notify(event) {
      if (event.type === 'auth_url') {
        lastAuthUrl = event.url
        log(`[openai-login] 请在浏览器打开：${event.url}`)
      } else if (event.type === 'device_code') {
        // 设备码流程不经过 prompt，这里用一个不阻塞的对话框把网址和设备码展示给用户。
        log(`[openai-login] 设备码 ${event.userCode} → ${event.verificationUri}`)
        void userQuestions.ask({
          agent,
          questions: [{
            id: 'openai-device-code',
            header: 'OpenAI 登录',
            question: `请在浏览器打开 ${event.verificationUri}，输入设备码：${event.userCode}。授权完成后可关闭此提示。`,
          }],
        }).catch(() => { /* 用户关闭/取消即可 */ })
      } else if (event.type === 'info') {
        log(`[openai-login] ${event.message}`)
      }
    },
  }
}

// ── 斜杠命令 ─────────────────────────────────────────────────────────────

function registerCommands(ctx) {
  const commands = ctx.get('commands')
  const userQuestions = ctx.get('userQuestions')
  if (commands === undefined) return

  commands.register({
    name: 'openai-login',
    description: '登录 OpenAI 账号（ChatGPT Plus/Pro token plan）以使用 openai-codex 模型',
    async handler(invocation) {
      if (userQuestions === undefined) {
        return { kind: 'error', text: 'OpenAI 登录需要 Web UI 的交互对话框，当前环境不可用。' }
      }
      try {
        const interaction = makeInteraction(ctx, userQuestions, invocation.agent)
        const credential = await openaiCodexOAuth.login(interaction)
        if (!credential?.access || !credential.refresh) {
          throw new Error('登录流程返回了不完整的凭据')
        }
        await writeCredential(credential)
        const account = credential.accountId ? ` (account ${credential.accountId})` : ''
        return {
          kind: 'success',
          text: `已登录 OpenAI 账号${account}。现在可以在模型选择器中选用 openai-codex 的模型（GPT-5.x Codex）。`,
        }
      } catch (error) {
        return { kind: 'error', text: `OpenAI 登录失败：${error?.message ?? String(error)}` }
      }
    },
  })

  commands.register({
    name: 'openai-logout',
    description: '清除已保存的 OpenAI 账号登录凭据',
    async handler() {
      try {
        await deleteCredential()
        return { kind: 'success', text: '已清除 OpenAI 账号凭据。' }
      } catch (error) {
        return { kind: 'error', text: `清除失败：${error?.message ?? String(error)}` }
      }
    },
  })

  commands.register({
    name: 'openai-status',
    description: '查看 OpenAI 账号登录状态',
    async handler() {
      try {
        const credential = await readCredential()
        if (credential === undefined) {
          return { kind: 'success', text: '未登录 OpenAI 账号。运行 /openai-login 完成登录。' }
        }
        const expires = new Date(credential.expires)
        const account = credential.accountId ? ` (account ${credential.accountId})` : ''
        return {
          kind: 'success',
          text: `已登录 OpenAI 账号${account}，token 有效期至 ${expires.toLocaleString()}。`,
        }
      } catch (error) {
        return { kind: 'error', text: `读取登录状态失败：${error?.message ?? String(error)}` }
      }
    },
  })
}

// ── 插件入口 ─────────────────────────────────────────────────────────────

export function apply(ctx) {
  try {
    // 静态 profile 只构造一次:PiAiAdapter 以 profiles 的引用身份判断快照,
    // 每次返回新 Map 会迫使每次请求重建 Models 集合,并破坏回放状态绑定。
    let cachedProfiles
    const profiles = () => {
      cachedProfiles ??= buildProfile()
      return cachedProfiles
    }
    const adapter = new PiAiAdapter({
      profiles,
      resolveApiKey: async () => getAccessToken(),
      auth: PI_AI_AUTH,
      resolveAttachments: () => ctx.get('attachments'),
    })
    try {
      ctx.llm.registerAdapter([PROVIDER], adapter)
    } catch (error) {
      // 另一个适配器（通常是 llm-pi-ai 的配置）已占用 openai-codex 路由。
      ctx.logger?.error?.(
        `openai-codex-account: 无法注册 provider "${PROVIDER}"（可能 llm-pi-ai 已配置同名的路由）。`
        + ' 登录命令仍可用，但请求不会经过本插件的账号凭据。',
      )
      ctx.logger?.error?.(error)
    }
  } catch (error) {
    ctx.logger?.error?.('openai-codex-account: 初始化失败，未注册账号 provider。')
    ctx.logger?.error?.(error)
  }

  registerCommands(ctx)
}
