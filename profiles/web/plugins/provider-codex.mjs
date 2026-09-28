// Web-facing /provider command for the OpenAI Codex Coding Plan subscription.
// dsh-auth owns credentials and the OAuth flow; this only routes a Web session
// command (and its exact live Agent) into the same API as TUI's /provider.
export const name = 'provider-codex-web'
export const inject = ['commands', 'dshAuth']

const ROUTE = 'openai-codex'
const USAGE = '用法：/provider [login|status|logout]（OpenAI Codex Coding Plan）'

export function createProviderHandler(resolveApi) {
  return async invocation => {
    const words = invocation.rawInput.trim().toLowerCase().split(/\s+/u).filter(Boolean)
    if (words.length > 1 || (words[0] !== undefined && !['login', 'status', 'logout'].includes(words[0]))) {
      return { kind: 'error', text: USAGE }
    }
    const api = resolveApi()
    if (api === undefined) return { kind: 'error', text: 'dsh-auth 尚未就绪，请稍后重试。' }
    const verb = words[0] ?? 'login'
    try {
      if (verb === 'status') {
        const row = (await api.providers()).find(provider => provider.provider === ROUTE)
        if (row === undefined) return { kind: 'error', text: 'dsh-auth 没有挂载 openai-codex 路由。' }
        const state = row.signedIn ? '已登录' : row.expired ? '凭据已过期' : '未登录'
        return { kind: 'success', text: `OpenAI Codex Coding Plan：${state}。` }
      }
      if (verb === 'logout') {
        const removed = await api.logout(ROUTE)
        return { kind: removed ? 'success' : 'error', text: removed ? '已退出 OpenAI Codex 账号。' : '尚未登录 OpenAI Codex。' }
      }
      // The Web question provider is session-scoped. dsh-auth's optional
      // third argument makes its OAuth prompts target this exact live Agent;
      // without it the browser declines agentless questions with NO_PROVIDER.
      const result = await api.login(ROUTE, invocation.signal, invocation.agent)
      return {
        kind: 'success',
        text: `已登录 ${result.oauthLabel}；可用 /model 选择 OpenAI Codex 模型。`,
      }
    } catch (error) {
      return { kind: 'error', text: `OpenAI Codex 登录操作失败：${error instanceof Error ? error.message : String(error)}` }
    }
  }
}

export function apply(ctx) {
  const commands = ctx.get('commands')
  if (commands === undefined) throw new Error('Web /provider requires commands')
  ctx.effect(() => commands.register({
    name: 'provider',
    description: '登录 OpenAI Codex Coding Plan 订阅账号（/provider [login|status|logout]）',
    handler: createProviderHandler(() => ctx.get('dshAuth')?.api),
  }))
}
