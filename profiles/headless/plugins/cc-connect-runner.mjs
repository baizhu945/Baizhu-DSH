/**
 * cc-connect-runner.mjs — headless 一次性会话运行器插件
 *
 * 替代内置的 `@deepseek-ai/dsh-headless`(在 headless profile 的
 * cordis.patch.yml 中禁用)。这是把 headless-cc-connect.patch 从"改 dsh 源码"
 * 迁移为插件后的完整实现,行为与补丁版逐行等价:
 *
 * - `--session-id`:create-once / resume-always(先 agents.resume,失败回退 create)
 * - `--provider`:本次运行的 provider route 覆盖
 * - `--model`:本次运行的模型覆盖
 * - `--reasoning-effort`:本次运行的思考强度覆盖
 * - `--mode`:任务运行前向会话日志追加 sandbox/mode + approval/policy 旋钮事件
 * - `--preset`:按 dsh 原生 roster mount 默认/恢复 preset，或在空白会话中
 *   recompose 并追加 agent-preset/selected 事件
 * - `--jsonl`:stdout 流式输出 text/thinking/tool/call/tool/result/approval/request/
 *   result/done JSONL 事件;stdin 读取 approval/response;confirm 模式下拦截
 *   写/执行工具并询问(web profile confirm-writes 插件的 headless 对应实现)
 * - `--list-models`:读取 dsh 运行时 LLM catalog 并以一行 JSON 输出，不创建 agent
 *
 * 导入的包(@deepseek-ai/dsh-agent 等)经 dsh 启动时维护的
 * `~/.dsh/profiles/node_modules` 扁平链接解析,与 profile 本地插件
 * `confirm-writes.mjs` 相同的零依赖加载方式。
 */

import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { resolveSessionPreset } from '@deepseek-ai/dsh-agent-presets'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'

/** Cordis 插件名。 */
export const name = 'cc-connect-runner'

/** 核心服务就绪(含 startup 插件提供的命令行参数)后才开始一次性回合。 */
export const inject = ['agentDefaultModel', 'agents', 'sessions']

/** 进程流;测试可替换(与补丁版 internals 相同)。 */
export const internals = {
  stdout: process.stdout,
  stderr: process.stderr,
  stdin: process.stdin,
}

/** confirm 模式需要先询问的工具(与 web confirm-writes 的 askTools 一致)。 */
const ASK_TOOLS = new Set(['write', 'edit', 'str_replace_editor', 'bash', 'pwsh', 'terminal_send'])

/** 用户可见权限模式 → 会话 sandbox/approval 旋钮。未知模式返回 undefined。 */
function modeToKnobs(mode) {
  switch (mode) {
    case 'read-only':
      return { sandbox: 'read-only', approval: 'ask' }
    case 'workspace-write':
      return { sandbox: 'workspace-write', approval: 'ask' }
    case 'danger-full-access':
      return { sandbox: 'danger-full-access', approval: 'never' }
    case 'confirm':
      return { sandbox: 'danger-full-access', approval: 'ask' }
    default:
      return undefined
  }
}

/**
 * 把权限模式固定为会话日志旋钮事件。事件类型由
 * @deepseek-ai/dsh-sandbox-policy / @deepseek-ai/dsh-user-approval 声明
 * (可扩展 SessionEventMap),headless bundle 不依赖它们,故经结构转型追加。
 * append 必须作为会话对象的方法调用(Session 实现读取 this.log)。
 */
function applyMode(session, mode) {
  const knobs = modeToKnobs(mode)
  if (knobs === undefined) return
  const appendable = session
  appendable.append('sandbox/mode', { mode: knobs.sandbox })
  appendable.append('approval/policy', { policy: knobs.approval })
}

/** A dsh session becomes preset-locked once its first turn starts. */
function isBlankSession(session) {
  return !session.events.some(event => event.type === 'turn/start')
}

/**
 * Compose the agent from its recorded preset, or apply a requested switch
 * while the session is still blank. The dsh roster owns validation and
 * persistence; this runner only supplies the session-specific lifecycle.
 */
async function applyAgentPreset(ctx, agentCtx, requested, defaultPreset) {
  const presets = ctx.get('agentPresets')
  if (presets === undefined) {
    if (requested !== undefined) throw new Error('agent presets are not enabled in the headless profile')
    return
  }

  const session = agentCtx.agent?.session
  if (session === undefined) throw new Error('headless agent setup has no session')
  const recorded = resolveSessionPreset(session)
  const target = requested ?? recorded ?? defaultPreset
  if (target === undefined) return

  if (requested !== undefined && requested !== recorded) {
    if (!isBlankSession(session)) {
      throw new Error(`session already has a turn; preset is locked at ${JSON.stringify(recorded)}`)
    }
    await presets.recompose(agentCtx, requested)
    session.append('agent-preset/selected', { agentPreset: requested })
    return
  }

  await presets.mount(agentCtx, target)
}

/** 把一个会话事件映射成一行 JSONL(只输出驱动器能展示的事件)。 */
function emitSessionEvent(io, event, toolNames) {
  switch (event.type) {
    case 'assistant/chunk': {
      const chunk = event.data.chunk
      if (chunk.type === 'text-delta' && chunk.text !== '') {
        io.stdout.write(`${JSON.stringify({ type: 'text', text: chunk.text })}\n`)
      } else if (chunk.type === 'reasoning-delta' && chunk.text !== '') {
        io.stdout.write(`${JSON.stringify({ type: 'thinking', text: chunk.text })}\n`)
      }
      break
    }
    case 'tool/call': {
      toolNames.set(event.data.callId, event.data.name)
      io.stdout.write(`${JSON.stringify({
        type: 'tool/call',
        callId: event.data.callId,
        name: event.data.name,
        arguments: event.data.arguments,
      })}\n`)
      break
    }
    case 'tool/result': {
      const block = event.data.message.content[0]
      const callId = block?.toolCallId ?? ''
      const content = block?.content === undefined ? '' : toolResultText(block.content)
      io.stdout.write(`${JSON.stringify({
        type: 'tool/result',
        callId,
        name: toolNames.get(callId) ?? '',
        content,
        ...block?.isError === true ? { isError: true } : {},
      })}\n`)
      break
    }
    default:
      break
  }
}

/** 提取工具结果块的纯文本内容。 */
function toolResultText(content) {
  return content
    .filter(block => block.type === 'text' && block.text !== undefined)
    .map(block => block.text)
    .join('')
}

/**
 * 从 stdin 读取审批响应。先登记 pending 再输出 request 行:
 * 驱动器可能在流式输出到达的同一刻同步应答,stdin 响应必须能找到登记项。
 * 未知 id 的响应被忽略。
 */
function startStdinApprovalReader(pending, input) {
  const rl = createInterface({ input })
  rl.on('line', (line) => {
    if (line === '') return
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    if (msg?.type !== 'approval/response' || typeof msg.id !== 'string') return
    const resolve = pending.get(msg.id)
    if (resolve === undefined) return
    pending.delete(msg.id)
    resolve(msg.outcome === 'allowed-once' ? 'allowed-once' : 'rejected')
  })
  return { close: () => rl.close() }
}

/** 汇总最后一个助手文本与回合结局。 */
function summarize(events, firstSeq) {
  let started = false
  let text = ''
  let reason
  for (const event of events) {
    if (event.seq < firstSeq) continue
    if (event.type === 'turn/start') {
      started = true
      continue
    }
    if (!started) continue
    if (event.type === 'assistant/message') {
      const joined = event.data.message.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('')
      if (joined !== '') text = joined
    }
    if (event.type === 'turn/end') reason = event.data.reason
  }
  return { text, reason }
}

/** 报告直接驱动失败并请求失败退出。 */
function fail(io, error) {
  io.stderr.write(`dsh: ${error instanceof Error ? error.message : String(error)}\n`)
  io.exit(1)
}

/**
 * 运行一次性回合(创建或恢复 agent → 施加模式 → 接线 JSONL/审批 → followup)。
 * @param ctx - 携有 Agent/默认模型/会话/加载器与启动器 IO 服务的插件上下文
 * @param config - 经命令行解析的启动参数
 * @param io - 进程级副作用
 */
async function run(ctx, config, io) {
  // 等待 loader 全部就绪,避免 agent 创建时工具/适配器尚未组装完成。
  await ctx.get('loader')?.await()

  if (config.listModels === true) {
    const llm = ctx.get('llm')
    const defaultModel = ctx.get('agentDefaultModel')
    const selection = defaultModel?.currentSelection()
    if (selection !== undefined) {
      if (config.provider !== undefined && config.provider !== '') selection.provider = config.provider
      if (config.model !== undefined && config.model !== '') selection.model = config.model
    }
    const models = []
    let reasoningEfforts
    if (llm !== undefined) {
      for (const provider of llm.listProviders()) {
        try {
          models.push(...await llm.listModels(provider.id))
        } catch {
          // One provider's catalog must not hide the other configured routes.
        }
      }
      if (selection !== undefined) {
        try {
          const resolved = await llm.resolveModelInfo(selection.provider, selection.model)
          reasoningEfforts = resolved.reasoning?.efforts?.map(effort => effort.id)
        } catch {
          // The selected route may not be mounted in headless (for example,
          // an OAuth-only Web provider); callers retain a safe union fallback.
        }
      }
    }
    io.stdout.write(`${JSON.stringify({
      type: 'models',
      models,
      ...reasoningEfforts === undefined ? {} : { reasoningEfforts },
    })}\n`)
    io.exit(0)
    return
  }

  const agents = ctx.get('agents')
  const defaultModel = ctx.get('agentDefaultModel')
  const sessions = ctx.get('sessions')
  if (agents === undefined || defaultModel === undefined || sessions === undefined) return

  const presets = ctx.get('agentPresets')
  const requestedPreset = config.preset
  // Resolve the default before creating a session so the immutable dsh header
  // records the same composition that setup mounts. Resume setup instead reads
  // the session's recorded selection and only uses this value for a blank
  // session explicitly requested by cc-connect.
  const defaultPreset = presets === undefined
    ? undefined
    : (await presets.resolve(requestedPreset)).id

  const selection = defaultModel.currentSelection()
  if (config.provider !== undefined && config.provider !== '') {
    selection.provider = config.provider
  }
  if (config.model !== undefined && config.model !== '') {
    selection.model = config.model
  }
  if (config.reasoningEffort !== undefined && config.reasoningEffort !== '') {
    selection.reasoningEffort = config.reasoningEffort
  }
  const sessionId = SessionId(config.sessionId !== undefined && config.sessionId !== '' ? config.sessionId : `session-${randomUUID()}`)
  const agentOptions = { provider: selection.provider, model: selection.model }
  const setup = async (agentCtx) => {
    const selected = { current: selection, assembled: undefined }
    installModelSelection(agentCtx, selected)
    await applyAgentPreset(ctx, agentCtx, requestedPreset, defaultPreset)
  }

  let agent
  if (config.sessionId !== undefined && config.sessionId !== '') {
    // create-once / resume-always:恢复失败(如损坏日志)才回退为同 id 新建。
    try {
      ({ agent } = await agents.resume({ resumeSessionId: sessionId, agentOptions, setup }))
    } catch {
      ({ agent } = await agents.create({
        sessionId,
        meta: {
          cwd: process.cwd(),
          ...defaultPreset === undefined ? {} : { agentPreset: defaultPreset },
        },
        agentOptions,
        setup,
      }))
    }
  } else {
    ({ agent } = await agents.create({
      sessionId,
      meta: {
        cwd: process.cwd(),
        ...defaultPreset === undefined ? {} : { agentPreset: defaultPreset },
      },
      agentOptions,
      setup,
    }))
  }

  if (config.mode !== undefined && config.mode !== '') {
    applyMode(agent.session, config.mode)
  }

  // JSONL 流式输出 + 审批接线,在提交任务前注册,保证不漏事件/请求。
  const jsonl = config.jsonl === true
  const pendingApprovals = new Map()
  const toolNames = new Map()
  let stdinReader
  if (jsonl) {
    ctx.on('session/event', (session, event) => {
      if (session.id !== agent.session.id) return
      emitSessionEvent(io, event, toolNames)
    })

    // 唯一终局应答者:sandbox 升级与 confirm 模式工具询问都经 ctx.approval。
    ctx.on('approval/request', (req) => {
      const id = randomUUID()
      return new Promise((resolve) => {
        // 先登记再输出:驱动器可能同步应答。
        pendingApprovals.set(id, resolve)
        req.signal?.addEventListener('abort', () => {
          if (pendingApprovals.delete(id)) resolve('cancelled')
        }, { once: true })
        io.stdout.write(`${JSON.stringify({
          type: 'approval/request',
          id,
          toolName: req.toolName,
          ...req.reason === undefined ? {} : { reason: req.reason },
          ...req.callId === undefined ? {} : { callId: req.callId },
        })}\n`)
      })
    })

    // confirm 模式:写/执行工具先问人(web confirm-writes 插件的 headless 版)。
    if (config.mode === 'confirm') {
      ctx.on('tools/pre-execute', (exec, next) => {
        if (ASK_TOOLS.has(exec.name)) {
          return { kind: 'ask', reason: `tool "${exec.name}" requires your approval (write/execute)` }
        }
        return next()
      })
    }

    stdinReader = startStdinApprovalReader(pendingApprovals, internals.stdin)
  }

  await agent.whenIdle()
  const firstSeq = agent.session.seq
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: config.task }],
    source: { kind: 'user' },
  }))
  await agent.whenIdle()
  await sessions.flush(agent.session)
  const outcome = summarize(agent.session.events, firstSeq)
  if (jsonl) {
    io.stdout.write(`${JSON.stringify({ type: 'result', text: outcome.text })}\n`)
    io.stdout.write(`${JSON.stringify({ type: 'done', success: outcome.reason?.kind === 'completed', sessionId: String(sessionId) })}\n`)
  } else {
    io.stdout.write(outcome.text + '\n')
  }
  // 审批 readline 会阻止事件循环退出;驱动器保持 stdin 打开时须显式关闭。
  stdinReader?.close()
  if (outcome.reason?.kind === 'error') {
    io.stderr.write(`dsh: ${outcome.reason.error.code}: ${outcome.reason.error.message}\n`)
  }
  io.exit(outcome.reason?.kind === 'completed' ? 0 : 1)
}

/**
 * 挂载一次性运行器。
 * @param ctx - 插件上下文(启动参数来自注入的 ccConnectStartup 服务)
 */
export function apply(ctx) {
  const exit = ctx.get('appExit')
  if (exit === undefined) {
    throw new Error('cc-connect-runner: the launcher must provide ctx.appExit before the tree mounts')
  }
  const io = { stdout: internals.stdout, stderr: internals.stderr, exit }
  const config = ctx.get('ccConnectStartup')
  void run(ctx, config, io).catch((error) => { fail(io, error) })
}
