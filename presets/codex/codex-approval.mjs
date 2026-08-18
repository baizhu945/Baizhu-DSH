/**
 * Preserve the current dsh permission preset for Codex-shaped tool names.
 *
 * The existing Web confirm-writes plugin knows dsh-native names. This scoped
 * companion applies the same `confirm` behavior to the Codex names without
 * changing the host permission table or affecting another preset.
 */
export const name = 'codex-approval-boundary'
export const inject = ['tools', 'permissionPresets']

const ASK_TOOLS = new Set([
  'exec_command',
  'write_stdin',
  'apply_patch',
])

export function apply(ctx) {
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (!ASK_TOOLS.has(exec.name)) return next()
    if (exec.agent === undefined) return { kind: 'deny', reason: 'Codex tool requires a live agent' }
    try {
      if (ctx.permissionPresets.current(exec.agent.session.events) !== 'confirm') return next()
    } catch {
      return next()
    }
    return { kind: 'ask', reason: `Codex tool "${exec.name}" requires your approval` }
  })
}
