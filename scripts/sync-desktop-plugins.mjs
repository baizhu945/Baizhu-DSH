/** Snapshot portable profile extensions for the next Desktop Host. Sources are read-only.
 * Called by DesktopProjectManager with the Desktop profile lock held, after Electron's
 * single-instance lock. No package manager, module evaluation or credential access.
 */
import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync,
  realpathSync, renameSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const bundleName = 'dsh-desktop-inherited-plugins'
const ownerFile = '.desktop-plugin-inheritance.json'
const validPackageName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i
const tui = '@deepseek-harness-tui/dsh-tui'
const frontdoors = new Set([
  '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-headless',
  '@deepseek-ai/dsh-acp-app', '@deepseek-ai/dsh-sdk-app', '@deepseek-ai/dsh-sdk-minimal',
  '@deepseek-ai/dsh-desktop-host', tui,
])
const terminal = new Set(['workspaces', 'command-trees', 'settings-sections', 'scenes', 'plugin-host', 'extensions'])
const transport = new Set([
  '@deepseek-ai/dsh-host-webserver', '@deepseek-ai/dsh-client-connection',
  '@deepseek-ai/dsh-host-connection', '@deepseek-ai/dsh-web-frontend',
  '@deepseek-ai/dsh-web-client', '@deepseek-ai/dsh-headless-runner',
  '@deepseek-ai/dsh-acp', '@deepseek-ai/dsh-sdk-jsonrpc-server',
])
const transportIds = new Set(['webserver', 'connection', 'web-frontend', 'headless-runner', 'acp', 'sdk-jsonrpc-server'])
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const stringify = value => JSON.stringify(value, null, 2) + '\n'
const stat = path => lstatSync(path, { throwIfNoEntry: false })
const allEntries = entries => entries.flatMap(entry => [entry,
  ...(entry.group && Array.isArray(entry.config) ? allEntries(entry.config) : [])])

function packageName(name) {
  if (typeof name !== 'string' || name.startsWith('.') || name.startsWith('/') || name.includes(':')) return undefined
  const parts = name.split('/')
  return name.startsWith('@') ? (parts.length >= 2 ? parts.slice(0, 2).join('/') : undefined) : parts[0]
}
function findPackage(name, anchor) {
  for (const root of createRequire(anchor).resolve.paths(name) ?? []) {
    const directory = join(root, name)
    if (existsSync(join(directory, 'package.json'))) return directory
  }
}
function packagesAt(root) {
  if (!existsSync(root)) return []
  return readdirSync(root).sort().filter(name => !name.startsWith('.')).flatMap(name => {
    if (name.startsWith('@')) return readdirSync(join(root, name)).sort().map(child => [name + '/' + child, join(root, name, child)])
    return [[name, join(root, name)]]
  }).filter(([, path]) => existsSync(join(path, 'package.json')))
}
function pluginMetadata(manifest) {
  return manifest.dsh?.bundle !== undefined || manifest.dsh?.client !== undefined
    || Object.keys(manifest.peerDependencies ?? {}).some(name => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))
}
function excluded(name, id) {
  const root = packageName(name)
  if (transportIds.has(id) || transport.has(name) || transport.has(root)
    || (root !== tui && frontdoors.has(root))) return 'surface transport/startup belongs to Desktop'
  if (frontdoors.has(name)) return 'surface frontdoor/core bundle belongs to Desktop'
  if (typeof name === 'string' && name.startsWith(tui + '/') && terminal.has(name.slice(tui.length + 1).split('/')[0])) {
    return 'terminal-only TUI UI subpath'
  }
}
function atomicText(path, text, mode = 0o600) {
  if (existsSync(path) && readFileSync(path, 'utf8') === text) return false
  writeFileSync(path + '.desktop-sync-tmp', text, { mode })
  renameSync(path + '.desktop-sync-tmp', path)
  return true
}

/** Plan completely before any writes, so a malformed source never removes the last good generation. */
export async function synchronizeDesktopPlugins({ runtimeDir, profileDir, home = process.env.DSH_HOME ?? join(homedir(), '.dsh') }) {
  runtimeDir = resolve(runtimeDir)
  profileDir = resolve(profileDir)
  home = resolve(home)
  const installAnchor = join(runtimeDir, 'apps/cli/package.json')
  const require = createRequire(installAnchor)
  const boot = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href)
  const yaml = require('js-yaml')
  const expression = new yaml.Type('tag:yaml.org,2002:js', {
    kind: 'scalar', construct: value => ({ __jsExpr: value }),
    predicate: value => value !== null && typeof value === 'object' && typeof value.__jsExpr === 'string',
    represent: value => value.__jsExpr,
  })
  const schema = yaml.JSON_SCHEMA.extend(expression)
  const modules = join(profileDir, 'node_modules')
  const assertDesktopBoundary = () => {
    for (const path of [profileDir, modules]) {
      if (stat(path)?.isSymbolicLink()) throw new Error(`desktop plugins: refusing user symlink boundary ${path}`)
    }
  }
  assertDesktopBoundary()
  const desktopRealPath = realpathSync(profileDir)
  const scopeSymlink = name => name.startsWith('@') && stat(dirname(join(modules, name)))?.isSymbolicLink()
  const patchRecords = files => files.flatMap(file => boot.loadOverlayPatches('desktop plugins', file)
    .map(patch => ({ patch, origin: file })))
  const ownershipPath = join(profileDir, ownerFile)
  const previous = existsSync(ownershipPath) ? readJson(ownershipPath) : undefined
  if (previous && (previous.schemaVersion !== 1 || previous.owner !== bundleName)) {
    throw new Error(`desktop plugins: refusing unknown ownership document ${ownershipPath}`)
  }
  const manifestPath = join(profileDir, 'package.json')
  const manifest = readJson(manifestPath)
  const exemptions = boot.readProfileVersionExemptions(profileDir)
  const version = boot.getDshRuntimeVersion()
  const installation = await boot.createRuntimeResolution({ installAnchor, home })
  const installationNames = new Set(installation.entries.map(entry => entry.name))
  const desktop = boot.loadProfileDirectory('desktop plugins', profileDir, installAnchor)
  // Keep the previous generated layer out of the baseline and of local reservations.
  const ownLayers = desktop.layers.filter(layer => layer.packageName !== bundleName)
  const baselineLayers = ownLayers.filter(layer => frontdoors.has(layer.packageName))
  const baseline = boot.composeEntries(baselineLayers.map(layer => layer.patches))
  const baselineIds = new Set(allEntries(baseline).map(entry => entry.id).filter(Boolean))
  const baselineNames = new Set(allEntries(baseline).map(entry => entry.name))
  const localIds = new Set([
    ...ownLayers.filter(layer => !frontdoors.has(layer.packageName)).flatMap(layer => layer.patches),
    ...desktop.patches,
  ].flatMap(patch => allEntries(patch.insert ?? [])).map(entry => entry.id).filter(Boolean))
  const report = { schemaVersion: 1, runtimeVersion: version, sources: [], inherited: [], packages: [], skipped: [] }
  const skip = (source, id, reason, name) => report.skipped.push({ source, ...(id ? { id } : {}), ...(name ? { name } : {}), reason })
  const selectedPackages = new Map()
  const oldLinks = previous?.projections ?? {}
  for (const [name, target] of Object.entries(oldLinks)) {
    if (!validPackageName.test(name) || typeof target !== 'string' || !isAbsolute(target)) {
      throw new Error(`desktop plugins: invalid owned projection ${name} in ${ownershipPath}`)
    }
  }
  const compatible = (path, source, id) => {
    const pkg = readJson(join(path, 'package.json'))
    const issue = boot.evaluatePluginCompatibility(pkg, exemptions, version)
    if (issue && !issue.exempted) {
      skip(source, id, boot.pluginCompatibilityWarning(issue), pkg.name)
      return false
    }
    return true
  }
  const proposePackage = (name, path, source) => {
    if (!path || name === bundleName || installationNames.has(name)) return
    if (!validPackageName.test(name)) throw new Error(`desktop plugins: invalid dependency name ${name}`)
    const target = join(modules, name)
    if (scopeSymlink(name)) {
      skip(source, undefined, 'Desktop scope directory is a user symlink; no projection writes allowed', name)
      return
    }
    const existing = stat(target)
    const isOwned = existing?.isSymbolicLink() && oldLinks[name] === readlinkSync(target)
    if ((existing && !isOwned) || Object.hasOwn(manifest.dependencies ?? {}, name)) {
      // Desktop-local package selection wins, including an uninstalled declared dependency.
      if (!selectedPackages.has(name)) selectedPackages.set(name, { name, path: target, local: true, source: 'desktop' })
      skip(source, undefined, 'Desktop-local package/dependency takes precedence', name)
      return
    }
    if (selectedPackages.has(name)) return
    // Some optional runtime modules (e.g. terminal tools used by user presets) are
    // hoisted but outside the CLI's declared peer closure. If they are available in
    // this runtime, project THAT exact instance, never a stale shared-profile copy.
    const runtimePackage = join(runtimeDir, 'node_modules', name)
    const fromRuntime = existsSync(join(runtimePackage, 'package.json'))
    const selectedPath = fromRuntime ? runtimePackage : path
    if (!compatible(selectedPath, source)) return
    selectedPackages.set(name, { name, path: resolve(selectedPath), local: false, source: fromRuntime ? 'desktop-runtime' : source })
  }
  const profilesRoot = join(home, 'profiles')
  const names = existsSync(profilesRoot) ? readdirSync(profilesRoot, { withFileTypes: true })
    .filter(entry => !entry.name.startsWith('.') && !['desktop', 'node_modules'].includes(entry.name)
      && resolve(join(profilesRoot, entry.name)) !== profileDir && (entry.isDirectory() || entry.isSymbolicLink())
      && existsSync(join(profilesRoot, entry.name, 'package.json')))
    .map(entry => entry.name).filter(name => {
      if (realpathSync(join(profilesRoot, name)) !== desktopRealPath) return true
      skip(name, undefined, 'source profile resolves to Desktop; symlink alias excluded')
      return false
    }) : []
  const priority = name => ({ web: 0, headless: 1, 'dsh-tui': 2 })[name] ?? 3
  names.sort((left, right) => priority(left) - priority(right) || left.localeCompare(right))
  const sources = names.map(name => {
    const dir = join(profilesRoot, name)
    const loaded = boot.loadProfileDirectory('desktop plugins', dir, installAnchor)
    const sourceManifest = readJson(join(dir, 'package.json'))
    // loadProfileDirectory deliberately contains bundle errors. Re-parse readable selected
    // bundle files here: invalid YAML is fatal to synchronization, not a removal signal.
    for (const failed of loaded.skippedBundles) {
      let path
      try { path = boot.resolveBundleDir('desktop plugins', failed.packageName, installAnchor, dir) } catch {}
      if (path) {
        const pkg = readJson(join(path, 'package.json'))
        if (pkg.dsh?.bundle) {
          const patchPaths = boot.bundlePatchPaths(path, pkg.dsh.bundle)
          const patches = patchPaths.flatMap(file => boot.loadOverlayPatches('desktop plugins', file))
          // The source reader uses SOURCE grants. Admission here uses only Desktop's
          // already-existing exact grants, even if the source profile denied its bundle.
          if (compatible(path, name)) {
            loaded.layers.push({ packageName: failed.packageName, packageDir: path, patchPaths, patches })
            continue
          }
        }
      }
      skip(name, undefined, failed.reason, failed.packageName)
    }
    const bundleOrder = sourceManifest.dsh?.profile?.bundles ?? []
    loaded.layers.sort((left, right) => bundleOrder.indexOf(left.packageName) - bundleOrder.indexOf(right.packageName))
    report.sources.push({ name, directory: dir, bundles: bundleOrder })
    for (const dependency of Object.keys(sourceManifest.dependencies ?? {}).sort()) {
      proposePackage(dependency, findPackage(dependency, join(dir, 'package.json')), name)
    }
    for (const [dependency, path] of packagesAt(join(dir, 'node_modules'))) {
      const pkg = readJson(join(path, 'package.json'))
      if (pluginMetadata(pkg)) proposePackage(dependency, path, name)
    }
    return { name, dir, loaded }
  })
  for (const [name, path] of packagesAt(join(profilesRoot, 'node_modules'))) {
    if (pluginMetadata(readJson(join(path, 'package.json')))) proposePackage(name, path, 'shared')
  }
  const claimed = new Map([
    ...[...baselineIds].map(id => [id, 'desktop-core']),
    ...[...localIds].map(id => [id, 'desktop']),
  ])
  const targetClaims = new Map()
  const canonicalNames = new Set(baselineNames)
  const patches = []
  for (const source of sources) {
    const { name: sourceName, dir, loaded } = source
    const candidates = []
    for (const layer of loaded.layers) {
      if (baselineLayers.some(own => own.packageName === layer.packageName)) {
        skip(sourceName, undefined, 'Desktop already supplies core/surface bundle', layer.packageName)
        continue
      }
      let patchDirectory = layer.packageDir
      let patchPaths = layer.patchPaths
      if (!frontdoors.has(layer.packageName)) {
        proposePackage(layer.packageName, layer.packageDir, sourceName)
        const selected = selectedPackages.get(layer.packageName)
        if (selected?.local) {
          if (!existsSync(join(selected.path, 'package.json'))) {
            skip(sourceName, undefined, 'Desktop-local bundle dependency is not installed', layer.packageName)
            continue
          }
          const localManifest = readJson(join(selected.path, 'package.json'))
          if (!localManifest.dsh?.bundle) {
            skip(sourceName, undefined, 'Desktop-local package declares no bundle; source bundle not substituted', layer.packageName)
            continue
          }
          patchDirectory = selected.path
          patchPaths = boot.bundlePatchPaths(patchDirectory, localManifest.dsh.bundle)
        }
      }
      if (!compatible(patchDirectory, sourceName)) continue
      for (const { patch, origin } of patchRecords(patchPaths)) {
        // A foreign core bundle may contribute portable host INSERT rows, never its
        // persona, model, sandbox, prompt or frontdoor config overrides.
        if (frontdoors.has(layer.packageName) && !patch.insert) {
          skip(sourceName, patch.id, 'foreign core bundle config override', patch.name)
          continue
        }
        candidates.push({ patch, origin, builtin: frontdoors.has(layer.packageName), anchor: join(patchDirectory, 'package.json') })
      }
    }
    candidates.push(...patchRecords(existsSync(loaded.patchPath) ? [loaded.patchPath] : [])
      .map(record => ({ ...record, builtin: false, anchor: join(dir, 'package.json') })))
    const admitted = new Set(baselineIds)
    const rejected = new Set()
    const sourcePatches = []
    const filterEntry = (entry, builtin, anchor, origin, replacing = new Set()) => {
      // Native parsing anchors INSERT names. A group's config replacement also
      // carries entry rows; qualify only those child names beside their source file.
      // Top-level patch.name remains an assertion and never passes through here.
      if (typeof entry.name === 'string' && (isAbsolute(entry.name)
        || entry.name.startsWith('./') || entry.name.startsWith('../'))) {
        entry = { ...entry, name: pathToFileURL(resolve(dirname(origin), entry.name)).href }
      }
      const reason = excluded(entry.name, entry.id)
        ?? (localIds.has(entry.id) ? 'Desktop-local insertion id takes precedence' : undefined)
        ?? (entry.id && claimed.has(entry.id) && !replacing.has(entry.id) ? `duplicate insertion id; ${claimed.get(entry.id)} takes precedence` : undefined)
        ?? (builtin && canonicalNames.has(entry.name) ? 'host module already supplied by Desktop/higher-priority source' : undefined)
      if (reason) { rejected.add(entry.id); skip(sourceName, entry.id, reason, entry.name); return undefined }
      const dependency = packageName(entry.name)
      if (dependency && !installationNames.has(dependency)) {
        const original = findPackage(dependency, anchor)
        proposePackage(dependency, original, sourceName)
        const selected = selectedPackages.get(dependency)
        if (!selected || !existsSync(join(selected.path, 'package.json')) || !compatible(selected.path, sourceName, entry.id)) {
          rejected.add(entry.id)
          skip(sourceName, entry.id, 'referenced package unavailable or incompatible in Desktop', entry.name)
          return undefined
        }
      } else if (typeof entry.name === 'string' && entry.name.startsWith('file:')) {
        // Local files resolve beside the original patch. Find their owning manifest
        // for the same native peer check; do not import/evaluate the module.
        let parent = dirname(fileURLToPath(entry.name))
        while (parent !== dirname(parent) && !existsSync(join(parent, 'package.json'))) parent = dirname(parent)
        if (existsSync(join(parent, 'package.json')) && !compatible(parent, sourceName, entry.id)) {
          rejected.add(entry.id)
          return undefined
        }
      }
      const next = structuredClone(entry)
      if (next.group && Array.isArray(next.config)) next.config = next.config.map(child => filterEntry(child, builtin, anchor, origin, replacing)).filter(Boolean)
      if (entry.id) { claimed.set(entry.id, sourceName); admitted.add(entry.id) }
      canonicalNames.add(entry.name)
      report.inherited.push({ source: sourceName, id: entry.id, name: entry.name, ...(entry.disabled !== undefined ? { disabled: entry.disabled } : {}) })
      return next
    }
    for (const { patch, builtin, anchor, origin } of candidates) {
      if (patch.insert) {
        if (patch.id && (!admitted.has(patch.id) || rejected.has(patch.id))) {
          skip(sourceName, patch.id, 'insert target unavailable after surface filtering', patch.name)
          continue
        }
        const insert = patch.insert.map(entry => filterEntry(entry, builtin, anchor, origin)).filter(Boolean)
        if (insert.length) sourcePatches.push({ ...structuredClone(patch), insert })
      } else {
        const reason = excluded(patch.name, patch.id)
          ?? (rejected.has(patch.id) || !admitted.has(patch.id) ? 'patch target unavailable after filtering' : undefined)
          ?? (localIds.has(patch.id) ? 'Desktop-local insertion takes precedence' : undefined)
          ?? (targetClaims.has(patch.id) && targetClaims.get(patch.id) !== sourceName ? `higher-priority ${targetClaims.get(patch.id)} target config/disabled state wins` : undefined)
        if (reason) { skip(sourceName, patch.id, reason, patch.name); continue }
        targetClaims.set(patch.id, sourceName)
        const next = structuredClone(patch)
        if (Array.isArray(next.config)) {
          const target = allEntries(boot.composeEntries([...baselineLayers.map(layer => layer.patches), sourcePatches]))
            .find(entry => entry.id === patch.id)
          if (target?.group || patch.group) {
            const replacing = new Set(allEntries(Array.isArray(target?.config) ? target.config : []).map(entry => entry.id))
            next.config = next.config.map(entry => filterEntry(entry, builtin, anchor, origin, replacing)).filter(Boolean)
          }
        }
        sourcePatches.push(next)
      }
    }
    patches.push(...sourcePatches)
  }
  // Compose using the native replacement/disabled/group semantics for inventory and
  // diagnostics, not a recursive config merge or an evaluation of !!js expressions.
  const effective = allEntries(boot.composeEntries([...baselineLayers.map(layer => layer.patches), patches],
    message => skip('composition', undefined, message)))
  for (const row of report.inherited) {
    const final = effective.find(entry => entry.id === row.id)
    if (final?.disabled !== undefined) row.disabled = final.disabled
  }
  const dependencies = {}
  const projections = {}
  for (const item of [...selectedPackages.values()].sort((left, right) => left.name.localeCompare(right.name))) {
    if (item.local) continue
    dependencies[item.name] = 'file:' + item.path
    projections[item.name] = item.path
    report.packages.push({ name: item.name, source: item.source, path: item.path })
  }
  const generatedManifest = { name: bundleName, version: '1.0.0', private: true, dependencies,
    dsh: { bundle: { patch: './cordis.patch.yml' } } }
  const bundleDir = join(modules, bundleName)
  if (stat(bundleDir) && !previous?.initialized) throw new Error(`desktop plugins: refusing unowned bundle ${bundleDir}`)
  if (stat(bundleDir)?.isSymbolicLink()) throw new Error(`desktop plugins: generated bundle is a user symlink: ${bundleDir}`)
  const nextManifest = structuredClone(manifest)
  if (!previous?.initialized) {
    nextManifest.dsh ??= {}
    nextManifest.dsh.profile ??= {}
    const bundles = nextManifest.dsh.profile.bundles ?? []
    // Insert above the base/Web shell, below every existing local extra layer.
    const index = bundles.findIndex(name => !frontdoors.has(name))
    nextManifest.dsh.profile.bundles = bundles.includes(bundleName) ? bundles
      : [...bundles.slice(0, index < 0 ? bundles.length : index), bundleName, ...bundles.slice(index < 0 ? bundles.length : index)]
  }
  report.enabled = (nextManifest.dsh?.profile?.bundles ?? []).includes(bundleName)
  const owner = { schemaVersion: 1, owner: bundleName, initialized: true, projections }
  const yamlText = yaml.dump(patches, { schema, noRefs: true, lineWidth: -1, sortKeys: false })
  // All discovery and parsing has succeeded. Recheck boundaries before writes and
  // never walk a user-replaced scope link, even to remove a previously owned link.
  assertDesktopBoundary()
  mkdirSync(modules, { recursive: true })
  for (const [name, target] of Object.entries(oldLinks)) {
    if (scopeSymlink(name)) {
      skip('desktop', undefined, 'scope directory is a user symlink; owned-link cleanup skipped', name)
      continue
    }
    const link = join(modules, name)
    if (stat(link)?.isSymbolicLink() && readlinkSync(link) === target && projections[name] !== target) unlinkSync(link)
  }
  for (const [name, target] of Object.entries(projections)) {
    if (scopeSymlink(name)) {
      skip('desktop', undefined, 'scope directory is a user symlink; projection creation skipped', name)
      delete projections[name]
      delete dependencies[name]
      report.packages = report.packages.filter(item => item.name !== name)
      continue
    }
    const link = join(modules, name)
    mkdirSync(dirname(link), { recursive: true })
    if (!stat(link)) symlinkSync(target, link, 'dir')
  }
  mkdirSync(bundleDir, { recursive: true })
  atomicText(join(bundleDir, 'cordis.patch.yml'), yamlText)
  atomicText(join(bundleDir, 'package.json'), stringify(generatedManifest))
  atomicText(manifestPath, JSON.stringify(nextManifest) === JSON.stringify(manifest) ? readFileSync(manifestPath, 'utf8') : stringify(nextManifest))
  atomicText(ownershipPath, stringify(owner))
  atomicText(join(profileDir, '.desktop-plugin-inheritance-report.json'), stringify(report))
  for (const row of report.skipped) console.error(`desktop plugins: skip ${row.source}${row.id ? '/' + row.id : ''}${row.name ? ' (' + row.name + ')' : ''}: ${row.reason}`)
  console.log(`desktop plugins: ${report.inherited.length} inherited rows, ${report.packages.length} available packages; bundle ${report.enabled ? 'enabled' : 'disabled by Desktop user'}`)
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [runtimeDir, profileDir] = process.argv.slice(2)
  if (!runtimeDir || !profileDir || !isAbsolute(runtimeDir) || !isAbsolute(profileDir)) throw new Error('usage: sync-desktop-plugins.mjs /absolute/runtime /absolute/desktop-profile')
  await synchronizeDesktopPlugins({ runtimeDir, profileDir })
}
