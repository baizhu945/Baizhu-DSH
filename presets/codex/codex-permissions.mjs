/**
 * Codex-only permission profile and turn-scoped grant seam.
 *
 * The deployment-wide permission preset table deliberately remains untouched.
 * This plugin supplies Codex aliases and the smallest policy projection DSH
 * can enforce without inventing a second global sandbox service.
 */
const createRequire = process.getBuiltinModule('node:module').createRequire
const nodePath = process.getBuiltinModule('node:path')
const dshHome = process.env.DSH_HOME ?? `${process.env.HOME ?? '/home/baizhu945'}/.dsh`
const requireFromDsh = createRequire(`${dshHome}/profiles/codex-permissions.cjs`)
const sandboxPolicyEntry = requireFromDsh.resolve('@deepseek-ai/dsh-sandbox-policy')
const { setSandboxMode } = await import(sandboxPolicyEntry)

const CODEX_PROFILES = Object.freeze({
  'codex-read-only': Object.freeze({
    sandbox: 'read-only',
    approval: 'ask',
    name: 'Codex Read Only',
    description: 'Codex-compatible read-only sandbox with on-request approval.',
  }),
  'codex-on-request': Object.freeze({
    sandbox: 'workspace-write',
    approval: 'ask',
    name: 'Codex On Request',
    description: 'Codex-compatible workspace writes with on-request escalation.',
  }),
  'codex-full-access': Object.freeze({
    sandbox: 'danger-full-access',
    approval: 'never',
    name: 'Codex Full Access',
    description: 'Codex-compatible unrestricted file access without approval prompts.',
  }),
})

const grants = new WeakMap()

function effectiveApprovalPolicy(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type === 'approval/policy') return events[index].data?.policy
  }
  return undefined
}

function effectiveSandboxMode(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type === 'sandbox/mode') return events[index].data?.mode
  }
  return undefined
}

function turnKey(session) {
  for (let index = session.events.length - 1; index >= 0; index -= 1) {
    const event = session.events[index]
    if (event?.type === 'turn/start') return event.data?.turn ?? event.seq
  }
  return undefined
}

function pathIsWithin(root, candidate) {
  const relative = nodePath.relative(root, candidate)
  return relative === ''
    || (relative !== '..' && !relative.startsWith(`..${nodePath.sep}`) && !nodePath.isAbsolute(relative))
}

function commonDirectory(paths) {
  if (paths.length === 0) return undefined
  let root = nodePath.dirname(paths[0])
  while (root !== nodePath.dirname(root) && !paths.every(path => pathIsWithin(root, path))) {
    root = nodePath.dirname(root)
  }
  return root === nodePath.parse(root).root ? undefined : root
}

function normalizePermissionRequest(agent, permissions) {
  if (permissions === null || typeof permissions !== 'object' || Array.isArray(permissions)) {
    throw new Error('permissions must be an object')
  }
  const cwd = agent.session.header.cwd ?? process.cwd()
  const filesystem = permissions.file_system
  const read = Array.isArray(filesystem?.read)
    ? filesystem.read.map(path => {
        if (typeof path !== 'string' || path.trim() === '') throw new Error('file_system.read paths must be non-empty strings')
        return nodePath.resolve(cwd, path)
      })
    : []
  const write = Array.isArray(filesystem?.write)
    ? filesystem.write.map(path => {
        if (typeof path !== 'string' || path.trim() === '') throw new Error('file_system.write paths must be non-empty strings')
        return nodePath.resolve(cwd, path)
      })
    : []
  const network = permissions.network?.enabled === true
  if (!network && read.length === 0 && write.length === 0) {
    throw new Error('permissions must request network access or at least one filesystem path')
  }
  return { network, read, write, writeRoot: commonDirectory(write) }
}

function activeGrant(agent) {
  const grant = grants.get(agent)
  if (grant === undefined || grant.turn !== turnKey(agent.session)) {
    if (grant !== undefined) grants.delete(agent)
    return undefined
  }
  return grant
}

function policyFor(agent, standing) {
  const grant = activeGrant(agent)
  if (grant?.writeRoot === undefined || standing.mode === 'danger-full-access') return standing
  // DSH has one writable root rather than Codex's set of path entries. A
  // grant inside the standing workspace can safely widen read-only to the
  // existing workspace root; an external grant is handled only per target.
  if (pathIsWithin(standing.workspaceRoot, grant.writeRoot)) {
    return { ...standing, mode: 'workspace-write' }
  }
  return standing
}

function policyForTargets(agent, standing, targets) {
  const grant = activeGrant(agent)
  if (grant?.writeRoot === undefined || standing.mode === 'danger-full-access') return standing
  const paths = targets.map(target => String(target))
  if (paths.length > 0 && paths.every(path => pathIsWithin(grant.writeRoot, path))) {
    return { ...standing, mode: 'workspace-write', workspaceRoot: grant.writeRoot }
  }
  return policyFor(agent, standing)
}

function currentProfile(agent, permissionPresets, sandboxPolicy, approval) {
  const current = permissionPresets?.current?.(agent.session)
  if (typeof current === 'string' && current !== 'custom' && CODEX_PROFILES[current] !== undefined) return CODEX_PROFILES[current].name
  const sandbox = effectiveSandboxMode(agent.session.events)
    ?? sandboxPolicy?.resolve?.({ session: agent.session })?.mode
  const policy = effectiveApprovalPolicy(agent.session.events)
    ?? approval?.config?.policy
  const match = Object.keys(CODEX_PROFILES).find(name => {
    const profile = CODEX_PROFILES[name]
    return profile.sandbox === sandbox && profile.approval === policy
  })
  return match === undefined ? 'custom' : CODEX_PROFILES[match].name
}

export const name = 'codex-permissions'
export const inject = ['approval', 'sandboxPolicy']

export function apply(ctx) {
  const api = {
    profiles: CODEX_PROFILES,
    current: agent => currentProfile(agent, ctx.get('permissionPresets'), ctx.get('sandboxPolicy'), ctx.get('approval')),
    policyFor,
    policyForTargets,
    clear: agent => grants.delete(agent),
    async request(agent, execution, permissions, reason) {
      const normalized = normalizePermissionRequest(agent, permissions)
      const approver = ctx.get('approval')
      const policy = effectiveApprovalPolicy(agent.session.events)
        ?? approver?.effectivePolicy?.(agent.session)
        ?? approver?.config?.policy
      if (policy === 'never') {
        return { granted: false, reason: 'approval policy is never; additional permissions were rejected' }
      }
      if (approver === undefined || typeof approver.request !== 'function') {
        return { granted: false, reason: 'permission approval service is unavailable' }
      }
      const outcome = await approver.request({
        agent,
        toolName: 'request_permissions',
        callId: execution.callId,
        reason: reason?.trim() || 'The command needs additional filesystem or network permissions.',
        signal: execution.signal,
      })
      if (outcome !== 'allowed-once') {
        return { granted: false, reason: `permission request ${outcome}` }
      }
      grants.set(agent, { ...normalized, turn: turnKey(agent.session) })
      return { granted: true }
    },
    applyProfile(agent, profileName) {
      const profile = CODEX_PROFILES[profileName]
      if (profile === undefined) throw new Error(`unknown Codex permission profile: ${profileName}`)
      setSandboxMode(agent.session, profile.sandbox)
      ctx.approval.setPolicy(agent, profile.approval)
      grants.delete(agent)
      return profile
    },
  }
  ctx.provide('codexPermissions', api)

  ctx.on('agent/disposed', ({ agent }) => { grants.delete(agent) })
  ctx.inject(['commands'], commandCtx => {
    commandCtx.commands.register({
      name: 'codex-permission',
      description: 'Apply a Codex-only permission profile without changing the global permission table',
      input: { hint: '<codex-read-only|codex-on-request|codex-full-access>' },
      handler: ({ agent, rawInput }) => {
        const profileName = rawInput.trim()
        if (profileName === '') {
          return { kind: 'success', text: `Codex permission profile: ${api.current(agent)} (available: ${Object.keys(CODEX_PROFILES).join(', ')})` }
        }
        try {
          const profile = api.applyProfile(agent, profileName)
          return { kind: 'success', text: `Codex permission profile ${profile.name} applied` }
        } catch (error) {
          return { kind: 'error', text: String(error) }
        }
      },
    })
  })
}

export { CODEX_PROFILES, commonDirectory, normalizePermissionRequest, policyFor, policyForTargets, turnKey }
