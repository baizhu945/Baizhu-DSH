/**
 * confirm-writes.mjs — dsh 权限策略插件(第四模式"询问模式"的载体)
 *
 * 策略:仅在会话处于询问模式(默认 preset 名 `confirm`)时,
 *   - 读操作(read / read_image / fs_search / skill / web 等):放行
 *   - 写操作(write / edit / str_replace_editor)与命令执行(bash / pwsh /
 *     terminal_send):每次调用前发起 approval 询问(web UI 弹窗)
 * 其余三个 dsh 内置模式(Read Only / Workspace Write / Full Access)
 * 保持 dsh 原生行为,本插件不干预。
 *
 * 实现机制:监听 tools/pre-execute 瀑布;当 ctx.permissionPresets.current()
 * 等于询问模式名时,对写/执行类工具返回 { kind: 'ask' },dsh 工具管线
 * 会将其转交 ctx.approval;web UI 的 apiproxy 提供 human answerer,
 * 批准一次(allowed-once)才放行,拒绝/取消则工具收到拒绝结果。
 *
 * 零依赖纯 ESM:不 import 任何 dsh/cordis 包,由 loader 经相对路径加载。
 */
export const name = 'confirm-writes'
export const inject = ['tools', 'permissionPresets']

/** 默认需要询问的工具名单(文件写 + 命令执行)。 */
const DEFAULT_ASK_TOOLS = [
  // 文件写入
  'write', 'edit', 'str_replace_editor',
  // 命令执行
  'bash', 'pwsh', 'terminal_send',
]

/**
 * @param ctx    cordis 上下文(tools 服务、permissionPresets 服务等)
 * @param config 可选配置:
 *   - preset:   string   询问模式在预设表中的名字(默认 'confirm')
 *   - askTools: string[] 覆盖默认询问名单
 *   - reason:   string   询问理由模板(拼在工具名后)
 */
export function apply(ctx, config = {}) {
  const askPreset = config.preset ?? 'confirm'
  const askTools = new Set(config.askTools ?? DEFAULT_ASK_TOOLS)
  const reasonSuffix = config.reason ?? 'requires your approval (write/execute)'

  // 进程内"总是允许"会话集合(内存态,不持久):dsh 重启/插件重载后自动清空恢复询问
  const alwaysAllowSessions = new Set()
  // 注意:api-proxy 广播的参数是 sessionId 字符串本身(非对象),必须按字符串接收
  ctx.on('confirm-writes/always-allow', (sessionId) => {
    alwaysAllowSessions.add(sessionId)
  })

  ctx.on('tools/pre-execute', async (exec, next) => {
    // 模式感知:仅询问模式拦截;其他预设(含 dsh 三个内置模式)放行
    if (exec.agent) {
      let current
      try {
        current = ctx.permissionPresets?.current?.(exec.agent.session.events)
      } catch {
        return next() // 权限服务异常时安全降级为放行
      }
      if (current !== askPreset) return next()
      // 会话级 always-allow(审批弹窗选择"总是允许",api-proxy 广播后记录):
      // 本次运行中的对话所有写/执行默认放行;dsh 重启后自动恢复询问
      if (alwaysAllowSessions.has(exec.agent.session.id)) return next()
    }
    if (askTools.has(exec.name)) {
      return { kind: 'ask', reason: `tool "${exec.name}" ${reasonSuffix}` }
    }
    return next()
  })
}
