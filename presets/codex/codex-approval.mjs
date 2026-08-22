/**
 * Preserve the current dsh permission knobs for Codex-shaped tool names.
 *
 * The host's own confirm interception keys on dsh-native tool names
 * (`bash`, `write`, …), so this scoped companion applies the same behavior to
 * the Codex names (`shell_command`, `apply_patch`). The decision folds the
 * session's `sandbox/mode` + `approval/policy` knob events directly — the same
 * mathematics the host permission-presets table uses — so it works under any
 * profile naming: whenever the effective approval policy is `ask` (confirm,
 * read-only+ask, workspace-write+ask), every mutation asks first;
 * `never` (full access) never asks.
 */
export const name = 'codex-approval-boundary'
export const inject = ['tools', 'permissionPresets']

const ASK_TOOLS = new Set([
  // Code Mode itself is only an orchestration boundary. Approval remains on
  // the authority-bearing nested command/edit calls, exactly as in native mode.
  'shell_command',
  'apply_patch',
])

/** Last `approval/policy` payload, or undefined when the session has none. */
function effectiveApprovalPolicy(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type === 'approval/policy') return event.data?.policy
  }
  return undefined
}

export function apply(ctx) {
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (!ASK_TOOLS.has(exec.name)) return next()
    if (exec.agent === undefined) return { kind: 'deny', reason: 'Codex tool requires a live agent' }
    const events = exec.agent.session.events

    // Primary path: fold the session knobs directly (profile-independent).
    let policy
    try {
      policy = effectiveApprovalPolicy(events)
    } catch {
      policy = undefined
    }
    if (policy !== undefined) {
      if (policy === 'ask') {
        return { kind: 'ask', reason: `Codex tool "${exec.name}" requires your approval` }
      }
      return next()
    }

    // Fallback for sessions without explicit knob events: honor the host's
    // named preset table when it declares the deployment's confirm preset.
    try {
      if (ctx.permissionPresets.current(events) === 'confirm') {
        return { kind: 'ask', reason: `Codex tool "${exec.name}" requires your approval` }
      }
    } catch {
      // No permission-preset service in this scope: leave the decision to the host.
    }
    return next()
  })
}
