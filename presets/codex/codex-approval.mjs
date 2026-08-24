/**
 * Preserve dsh permission knobs while matching Codex on-request behavior.
 *
 * The host's own confirm interception keys on dsh-native tool names
 * (`bash`, `write`, …), so this scoped companion applies the same behavior to
 * the Codex names (`exec_command`, `apply_patch`). The decision folds the
 * session's `sandbox/mode` + `approval/policy` knob events directly — the same
 * mathematics the host permission-presets table uses. Confined `ask` modes run
 * normally inside their sandbox and request a one-shot escalation only when a
 * tool needs it. The unrestricted `confirm` shape still asks before every
 * mutation, preserving the existing fourth permission preset exactly.
 */
export const name = 'codex-approval-boundary'
export const inject = ['tools', 'permissionPresets', 'sandboxPolicy']

const ASK_TOOLS = new Set([
  // Code Mode itself is only an orchestration boundary. Approval remains on
  // the authority-bearing nested command/edit calls, exactly as in native mode.
  'exec_command',
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
        const sandbox = ctx.sandboxPolicy.resolve({ session: exec.agent.session })
        if (sandbox.mode === 'danger-full-access') {
          return { kind: 'ask', reason: `Codex tool "${exec.name}" requires your approval` }
        }
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
