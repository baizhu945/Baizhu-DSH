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
  'request_permissions',
])

/** Last `approval/policy` payload, or undefined when the session has none. */
function effectiveApprovalPolicy(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type === 'approval/policy') return event.data?.policy
  }
  return undefined
}

/** Render authored patch changes into the approval reason without touching the filesystem. */
function patchApprovalPreview(input) {
  const source = String(input).replace(/\r\n?/g, '\n')
  const sourceLines = source.split('\n')
  const lines = []
  let added = 0
  let removed = 0
  let hasFile = false
  for (const line of sourceLines) {
    const control = line !== '' && [' ', '+', '-'].includes(line[0]) ? line : line.trim()
    const header = /^\*\*\* (Update|Add|Delete|Move) File:\s*(.*?)\s*$/.exec(control)
    if (header !== null) {
      hasFile = true
      lines.push('', header[1] + ' file: ' + header[2])
      continue
    }
    if (control === '*** Begin Patch' || control === '*** End Patch' || control === '*** End of File') continue
    if (control.startsWith('*** Environment ID:') || control.startsWith('*** Move to:')) {
      lines.push(control)
      continue
    }
    if (control === '@@' || control.startsWith('@@ ')) {
      lines.push(line)
      continue
    }
    if (line.startsWith('+')) {
      added++
      lines.push('+ ' + line.slice(1))
      continue
    }
    if (line.startsWith('-')) {
      removed++
      lines.push('- ' + line.slice(1))
      continue
    }
    if (line.startsWith(' ')) {
      lines.push('  ' + line.slice(1))
      continue
    }
    if (line === '') {
      lines.push('  ')
      continue
    }
    lines.push(line)
  }
  if (!hasFile) return undefined
  const maxLines = 180
  const visible = lines.slice(0, maxLines)
  if (lines.length > maxLines) visible.push('… (' + String(lines.length - maxLines) + ' more patch lines)')
  return ['Patch preview: +' + String(added) + '/-' + String(removed), ...visible].join('\n')
}

function approvalReason(ctx, exec) {
  const base = 'Codex tool "' + exec.name + '" requires your approval'
  const patch = exec.arguments?.input ?? exec.arguments?.patch
  if (exec.name !== 'apply_patch' || typeof patch !== 'string') return base
  const preview = patchApprovalPreview(patch)
  if (preview === undefined) return base
  let title
  try {
    const definition = ctx.tools.get(exec.name, exec.agent)
    const presentation = definition?.presentCall?.(exec.arguments)
    if (typeof presentation?.title === 'string' && presentation.title.trim() !== '') title = presentation.title.trim()
  } catch {
    title = undefined
  }
  return [base, title ?? 'Patch changes', preview].join('\n')
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
          return { kind: 'ask', reason: approvalReason(ctx, exec) }
        }
      }
      return next()
    }

    // Fallback for sessions without explicit knob events: honor the host's
    // named preset table when it declares the deployment's confirm preset.
    try {
      if (ctx.permissionPresets.current(events) === 'confirm') {
        return { kind: 'ask', reason: approvalReason(ctx, exec) }
      }
    } catch {
      // No permission-preset service in this scope: leave the decision to the host.
    }
    return next()
  })
}

export { approvalReason, patchApprovalPreview }
