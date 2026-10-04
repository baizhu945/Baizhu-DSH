// Live-only support. No import-time credential reads, model requests, or installs.
import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export const MODEL = 'gpt-6-luna'
export const PROVIDER = 'openai-codex'
export const safeFailure = (code, cause) => Object.assign(new Error('Live validation stopped', cause ? { cause } : undefined), { liveCode: code })
export const check = (value, code) => { if (!value) throw safeFailure(code) }
export const importFile = filename => import(pathToFileURL(filename).href)

// Diagnostics never copy exception text, paths, RPC details, or arbitrary stack
// symbols. These are public framework function names and fixed restore grammars.
const sourceFrames = new Set(['Relationships.tool', 'Relationships.accept', 'assertV4LifecycleRelationships',
  'assertReleasedV4Relationships', 'SessionLogScanner.finish', 'scanLog', 'Proxy.decodeStoredLog',
  'Proxy.requireStoredLog', 'Proxy.open', 'readColdSessionLog', 'mapPersistenceFailure',
  'SessionObservationReader.loadSource', 'SessionObservationReader.read', 'ApiSessionAgentController.resume',
  'ApiSessionAgentController.resumeObserved', 'AgentService.resume', 'Session.fromRestore',
  'installNativeBridge', 'mountHost', 'prompt', 'runLive', 'liveBootstrap'])
export function safeDiagnostics(error) {
  const frames = new Set(), restoreErrors = new Set(), seen = new Set()
  for (let current = error, depth = 0; current && depth < 8 && !seen.has(current); current = current.cause, depth++) {
    seen.add(current)
    for (const line of String(current.stack ?? '').split('\n').slice(1, 25)) {
      const name = /^\s+at (?:async )?([A-Za-z][A-Za-z0-9.$]*) \(/.exec(line)?.[1]
      if (sourceFrames.has(name)) frames.add(name)
    }
    const message = typeof current.message === 'string' ? current.message : ''
    // RPC wrapping loses the cause. Match only the complete public restore
    // grammar with harness-generated session/thread/call identifiers, then emit
    // a FIXED message (not even the matched identifiers). No payload substring.
    const unwrapped = message.replace(/^resume failed for session "(?:live|bootstrap|preflight)-[0-9a-f-]{36}": /, '')
    if (/^(?:SessionFormatError: |Error: )?tool\/(?:call|result) codex:[0-9a-f-]{36}:(?:native-rollout:call_[A-Za-z0-9_-]+|[A-Za-z0-9_-]+) has no advertised tool lifecycle$/.test(unwrapped))
      restoreErrors.add('native tool row has no advertised tool lifecycle')
    if (/^(?:seed assistant\/message at index \d+ (?:content|usage|replay state) disagrees with its embedded stream|invalid persisted inbox splice at session seq \d+)$/.test(message))
      restoreErrors.add(message)
  }
  return { ...(frames.size ? { errorSourceFrames: [...frames].slice(0, 16) } : {}),
    ...(restoreErrors.size ? { restoreErrors: [...restoreErrors] } : {}) }
}
const storeRoot = filename => {
  const match = filename.match(/^\/nix\/store\/[^/]+/)
  check(match, 'DEPENDENCY_NOT_IN_STORE')
  return match[0]
}
export async function exists(filename) {
  try { await fs.access(filename); return true } catch { return false }
}

export async function workspaceText(boundary, filename) {
  check(/^[a-zA-Z0-9_.-]+$/.test(filename), 'WORKSPACE_PROBE_INVALID')
  let handle
  try {
    handle = await fs.open(`/proc/self/fd/${boundary.workspaceHandle.fd}/${filename}`,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const stat = await handle.stat()
    check(stat.isFile() && stat.size <= 1_000_000, 'WORKSPACE_PROBE_INVALID')
    return await handle.readFile('utf8')
  } catch (error) {
    if (error?.liveCode) throw error
    return undefined
  } finally { await handle?.close() }
}

// Never include the inherited environment in a subprocess, including preflight.
export function cleanEnv(home, tmp, bins) {
  return { PATH: [...new Set(bins.map(filename => path.dirname(filename)))].join(':'),
    HOME: home, DSH_HOME: path.join(home, '.dsh'), CODEX_HOME: path.join(home, '.codex'),
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_DATA_HOME: path.join(home, '.local/share'), XDG_STATE_HOME: path.join(home, '.local/state'),
    TMPDIR: tmp, USER: 'dsh-live-validation', LOGNAME: 'dsh-live-validation',
    LANG: 'C.UTF-8', TZ: 'UTC', DO_NOT_TRACK: '1', OTEL_SDK_DISABLED: 'true' }
}

export async function localCommand(command, args, { cwd, env, timeout = 30_000, outputLimit = 2_000_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    const output = []
    let size = 0, settled = false
    const stop = () => { try { process.kill(-child.pid, 'SIGKILL') } catch {} }
    const timer = setTimeout(() => { stop(); finish(safeFailure('LOCAL_COMMAND_TIMEOUT')) }, timeout)
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      error ? reject(error) : resolve(value)
    }
    child.stdout.on('data', data => {
      size += data.length
      if (size > outputLimit) { stop(); finish(safeFailure('LOCAL_COMMAND_OUTPUT_LIMIT')); return }
      output.push(data)
    })
    // Deliberately discard stderr. It can contain inherited wrapper diagnostics.
    child.stderr.on('data', () => {})
    child.once('error', () => finish(safeFailure('LOCAL_COMMAND_SPAWN')))
    child.once('close', code => finish(undefined, { code, stdout: Buffer.concat(output).toString('utf8') }))
  })
}

async function binary(name, searchPath) {
  for (const dir of searchPath.split(':').filter(Boolean)) {
    try {
      // Preserve multicall basenames (nix-store, env, coreutils applets). A full
      // realpath of the leaf would accidentally execute `nix` or `coreutils`.
      let filename = path.join(await fs.realpath(dir), name)
      for (let i = 0; i < 16; i++) {
        let target
        try { target = await fs.readlink(filename) } catch { break }
        if (filename.startsWith('/nix/store/') && !path.isAbsolute(target)) break
        filename = path.resolve(path.dirname(filename), target)
      }
      await fs.access(filename)
      storeRoot(filename)
      return filename
    } catch {}
  }
  throw safeFailure('DEPENDENCY_MISSING')
}

export async function discover(options, original) {
  const bins = {}
  for (const name of ['dsh', 'bwrap', 'bash', 'env', 'printf', 'git', 'patch', 'sleep', 'head', 'test', 'nix-store'])
    bins[name] = await binary(name, original.PATH)
  bins.node = await fs.realpath(process.execPath)
  const dsh = await fs.realpath(options.dshRoot ?? path.dirname(path.dirname(bins.dsh)))
  const canonicalUserHome = path.resolve(original.HOME || os.homedir())
  const canonicalHome = path.resolve(original.DSH_HOME || path.join(canonicalUserHome, '.dsh'))
  // Canonical credential pathname is recorded only in memory, never stat/read in preflight.
  const credentialFile = path.resolve(original.DSH_AUTH_CREDENTIALS || path.join(canonicalHome, 'dsh-auth/credentials.json'))
  const binaryPath = await fs.realpath(options.binary ?? path.join(canonicalHome, '.agent-presets/codex/bin/codex'))
  const catalogPath = await fs.realpath(options.catalog ?? path.join(canonicalHome, '.agent-presets/codex/codex-models.json'))
  for (const filename of [dsh, binaryPath, catalogPath, ...Object.values(bins)]) storeRoot(filename)
  check(await exists(path.join(dsh, 'packages/core/agent-loop')), 'DSH_RUNTIME_MISSING')
  check(await exists(path.join(path.dirname(binaryPath), 'codex-code-mode-host')), 'CODEMODE_COMPANION_MISSING')
  // Pure local version query; no app-server/auth/network callback. An explicit
  // control --binary must not inherit the private build's initialize version.
  const version = await localCommand(binaryPath, ['--version'], { cwd: dsh,
    env: cleanEnv('/tmp/dsh-live-version-no-home', '/tmp', [binaryPath, ...Object.values(bins)]), outputLimit: 1024 })
  const binaryVersion = /^codex-cli (\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)\s*$/.exec(version.stdout)?.[1]
  check(version.code === 0 && binaryVersion, 'NATIVE_VERSION_INVALID')
  const catalog = JSON.parse(await fs.readFile(catalogPath, 'utf8'))
  const model = (catalog.models ?? catalog).find(row => (row.slug ?? row.id) === MODEL)
  check(model, 'CATALOG_MODEL_MISSING')
  const efforts = model.supported_reasoning_levels?.map(row => typeof row === 'string' ? row : row.effort) ?? []
  check(efforts.includes('medium') && efforts.includes('low'), 'CATALOG_EFFORT_MISSING')
  if (options.xhigh) check(efforts.includes('xhigh'), 'CATALOG_XHIGH_MISSING')
  const packages = new Map()
  for (const group of await fs.readdir(path.join(dsh, 'packages'), { withFileTypes: true })) {
    if (!group.isDirectory()) continue
    const directory = path.join(dsh, 'packages', group.name)
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const folder = path.join(directory, entry.name)
      try {
        const manifest = JSON.parse(await fs.readFile(path.join(folder, 'package.json'), 'utf8'))
        packages.set(manifest.name, { folder, entry: path.join(folder, manifest.main || 'lib/index.js') })
      } catch {}
    }
  }
  const require = createRequire(path.join(dsh, 'package.json'))
  // Pin one namespace per installed SDK package across preflight/live/cold
  // mounts. Never re-resolve a package through a later cwd or auth dependency
  // graph; contexts remain new, while module/class identity stays stable.
  const namespaces = new Map()
  const module = name => {
    if (!namespaces.has(name)) namespaces.set(name, (async () => {
      let entry
      try { entry = require.resolve(name) } catch { entry = packages.get(name)?.entry }
      check(entry && await exists(entry), 'HOST_PACKAGE_MISSING')
      return importFile(await fs.realpath(entry))
    })())
    return namespaces.get(name)
  }
  const anchor = path.join(canonicalHome, 'profiles/live-native-auth.cjs')
  // Dependency resolution is not a CredentialFile read. No TUI entry is imported.
  const authRequire = createRequire(anchor)
  let credentialPackage
  try { credentialPackage = authRequire.resolve('@deepseek-harness-tui/dsh-tui/package.json') }
  catch { throw safeFailure('AUTH_PACKAGE_MISSING') }
  const credentialModule = path.join(path.dirname(credentialPackage), 'lib/types/dsh-adapter/oauth/credentials.js')
  check(await exists(credentialModule), 'AUTH_PACKAGE_MISSING')
  const piAiRoot = await fs.realpath(path.join(packages.get('@deepseek-ai/dsh-llm-pi-ai').folder,
    'node_modules/@earendil-works/pi-ai'))
  return { bins, dsh, binaryPath, binaryVersion, catalogPath, model, efforts, canonicalHome, canonicalUserHome, credentialFile,
    credentialModule, piAiRoot, module, packages }
}

export async function createBoundary(runtime, work) {
  const scratch = path.join(work, 'scratch')
  const workspace = path.join(scratch, 'workspace')
  const home = path.join(scratch, 'home')
  const tmp = path.join(scratch, 'tmp')
  const nativeUserHome = path.join(scratch, 'native-user-home')
  const nativeHome = path.join(home, '.dsh/.agent-presets/codex/native-home')
  const attachments = path.join(home, '.dsh/attachments/v1')
  for (const directory of [workspace, home, tmp, nativeUserHome, nativeHome, attachments])
    await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  const allowedBins = Object.values(runtime.bins).filter(value => !value.endsWith('/dsh') && !value.endsWith('/nix-store'))
  const env = cleanEnv(home, tmp, allowedBins)
  const nativeEnv = cleanEnv(nativeUserHome, tmp, allowedBins)
  const roots = [...new Set([runtime.dsh, runtime.binaryPath, ...Object.values(runtime.bins)].map(storeRoot))]
  const queried = await localCommand(runtime.bins['nix-store'], ['--query', '--requisites', ...roots], { env, cwd: work })
  check(queried.code === 0, 'CLOSURE_QUERY_FAILED')
  const closure = [...new Set(queried.stdout.trim().split('\n').filter(Boolean))]
  check(closure.length && closure.every(filename => /^\/nix\/store\/[^/]+$/.test(filename)), 'CLOSURE_INVALID')
  const prefix = ['--die-with-parent', '--new-session', '--unshare-all', '--cap-drop', 'ALL',
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--tmpfs', work, '--dir', '/etc', '--dir', '/nix/store']
  for (const filename of closure) prefix.push('--ro-bind', filename, filename)
  for (const filename of ['/etc/resolv.conf', '/etc/hosts', '/etc/localtime', '/etc/ssl/certs/ca-certificates.crt']) {
    if (await exists(filename)) prefix.push('--ro-bind', filename, filename)
  }
  // The host's isolated DSH session/config/browser-credential directories are
  // NOT exposed to native children either. Only native state, synthetic images,
  // the workspace, and temporary native HOME/TMP are mounted.
  for (const directory of [workspace, tmp, nativeHome, nativeUserHome]) prefix.push('--bind', directory, directory)
  prefix.push('--ro-bind', attachments, attachments, '--symlink', path.dirname(runtime.bins.bash), '/bin',
    '--dir', '/usr', '--symlink', path.dirname(runtime.bins.env), '/usr/bin', '--chdir', workspace,
    '--remount-ro', work, '--remount-ro', '/')
  const args = (command, commandArgs = [], network = false, codexHome = nativeHome) => [...prefix,
    ...(network ? ['--share-net'] : []), '--clearenv',
    ...Object.entries({ ...nativeEnv, CODEX_HOME: codexHome }).flatMap(([key, value]) => ['--setenv', key, value]), '--', command, ...commandArgs]
  const sentinel = path.join(work, 'outside-sentinel')
  await fs.writeFile(sentinel, 'SYNTHETIC_OUTSIDE_SENTINEL', { mode: 0o600 })
  const probes = [sentinel, runtime.canonicalHome, path.join(runtime.canonicalUserHome, '.codex'),
    path.join(runtime.canonicalUserHome, '.config'), path.join(home, '.dsh/.credentials.yaml'),
    path.join(scratch, 'sessions'), path.join(scratch, 'storage'), '/run/user', '/proc/1/root/home']
  // /tmp is a fresh writable tmpfs, NOT the host /tmp. Official nested
  // sandbox setup creates mount-target registries there even with custom TMPDIR.
  const probeCode = `const fs=require('node:fs'); const p=${JSON.stringify(probes)};
    if(p.some(x=>fs.existsSync(x)))process.exit(31);
    fs.mkdirSync('/tmp/codex-live-local-sandbox-probe',{recursive:true});
    fs.writeFileSync('/tmp/codex-live-local-sandbox-probe/writable','SYNTHETIC');
    fs.writeFileSync(${JSON.stringify(path.join(workspace, 'boundary-probe.txt'))},'BOUNDARY_OK');
    try{fs.writeFileSync(${JSON.stringify(sentinel)},'ESCAPED');process.exit(32)}catch{}
    process.stdout.write('BOUNDARY_OK');`
  const first = await localCommand(runtime.bins.bwrap, args(runtime.bins.node, ['-e', probeCode]), { env, cwd: workspace })
  check(first.code === 0 && first.stdout === 'BOUNDARY_OK', `OUTER_BOUNDARY_FAILED_${Number.isInteger(first.code) ? first.code : 'SIGNAL'}`)
  // A command with no inner native sandbox is still outer-confined (the effective
  // escalation case). Nested bwrap must not recover any unmounted host path either.
  const nested = [runtime.bins.bwrap, '--unshare-all', '--cap-drop', 'ALL', '--ro-bind', '/', '/',
    '--proc', '/proc', '--dev', '/dev', '--', runtime.bins.node, '-e',
    `const fs=require('node:fs');if(${JSON.stringify(probes)}.some(x=>fs.existsSync(x)))process.exit(33);process.stdout.write('NESTED_OK')`]
  const second = await localCommand(runtime.bins.bwrap, args(nested[0], nested.slice(1)), { env, cwd: workspace })
  check(second.code === 0 && second.stdout === 'NESTED_OK', 'NESTED_BOUNDARY_FAILED')
  check(await fs.readFile(sentinel, 'utf8') === 'SYNTHETIC_OUTSIDE_SENTINEL', 'SENTINEL_MODIFIED')
  // Probe the exact live network-sharing envelope too, still with a local command
  // only: no DNS, credential, auth-server, app-server, or model request.
  const liveEnvelope = await localCommand(runtime.bins.bwrap, args(runtime.bins.node, ['-e', probeCode], true), { env, cwd: workspace })
  check(liveEnvelope.code === 0 && liveEnvelope.stdout === 'BOUNDARY_OK', 'LIVE_ENVELOPE_BOUNDARY_FAILED')
  // Hold the workspace inode across native execution. Result probes never
  // follow a model-created symlink into a host credential/config directory.
  const workspaceHandle = await fs.open(workspace, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  return { scratch, workspace, home, tmp, env, args, sentinel, nativeHome, workspaceHandle,
    closureCount: closure.length, async dispose() { await workspaceHandle.close() } }
}

export class Budget {
  constructor({ deadlineSeconds, maxGenerations, maxTokens }) {
    this.until = Date.now() + deadlineSeconds * 1000
    this.maxGenerations = maxGenerations
    this.maxTokens = maxTokens
    this.generations = 0
    this.tokens = 0
    this.turnRequests = 0
    this.compactRequests = 0
    this.usageUpdates = 0
    this.lastUsage = new Map()
    this.clients = new Set()
    this.stopped = undefined
    this.timer = setTimeout(() => this.stop('BUDGET_DEADLINE'), deadlineSeconds * 1000)
  }
  stop(code) {
    this.stopped ??= code
    for (const client of this.clients) void client.close().catch(() => {})
  }
  check() {
    if (Date.now() >= this.until) this.stop('BUDGET_DEADLINE')
    if (this.stopped) throw safeFailure(this.stopped)
  }
  observe(method, params) {
    if (method !== 'thread/tokenUsage/updated') return
    const total = params.tokenUsage?.total
    if (!total) return
    const fields = ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens']
    const signature = fields.map(key => total[key] ?? 0).join(':')
    const previous = this.lastUsage.get(params.threadId)
    if (previous?.signature === signature) return
    const reported = total.totalTokens
    if (!Number.isSafeInteger(reported) || reported < 0) { this.stop('NATIVE_USAGE_INVALID'); return }
    this.lastUsage.set(params.threadId, { signature, reported })
    this.usageUpdates++
    // Native counters reset across compaction. Charge a reset's new total, never
    // subtract previously charged work. Child-thread counters are included.
    this.tokens += previous && reported >= previous.reported ? reported - previous.reported : reported
    if (reported > (previous?.reported ?? 0) || (previous && reported < previous.reported)) this.generations++
    if (this.generations >= this.maxGenerations || this.tokens >= this.maxTokens) this.stop('BUDGET_NATIVE_USAGE')
  }
  async wait(operation, seconds = 180) {
    this.check()
    let timer
    try {
      return await Promise.race([operation, new Promise((_, reject) => {
        timer = setTimeout(() => { this.stop('CASE_DEADLINE'); reject(safeFailure('CASE_DEADLINE')) },
          Math.min(seconds * 1000, Math.max(1, this.until - Date.now())))
      })])
    } finally { clearTimeout(timer); this.check() }
  }
  snapshot() { return { generations: this.generations, nativeTokens: this.tokens,
    nativeUsageUpdates: this.usageUpdates, nativeTurnRequests: this.turnRequests, compactRequests: this.compactRequests } }
  dispose() { clearTimeout(this.timer) }
}
