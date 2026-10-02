/** Isolated configured source fixtures. Never copies user runtime settings or credentials. */
import { cpSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const configRoot = dirname(dirname(fileURLToPath(import.meta.url)))
export function createPluginFixtures(sandbox) {
  const home = join(sandbox, 'home')
  const dshHome = join(sandbox, 'dsh-home')
  const profile = join(dshHome, 'profiles/desktop')
  for (const path of [home, profile]) mkdirSync(path, { recursive: true })
  const text = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value) }
  const json = (path, value) => text(path, JSON.stringify(value, null, 2) + '\n')
  const tuiRoot = process.env.DSH_TUI_STORE
  if (!tuiRoot) throw new Error('set DSH_TUI_STORE to the configured Nix dsh-tui derivation (not a user runtime copy)')
  for (const name of ['web', 'headless', 'dsh-tui']) {
    const dir = join(dshHome, 'profiles', name)
    json(join(dir, 'package.json'), { name: 'dsh-profile-' + name, private: true, dependencies: {}, dsh: { profile: { bundles: [
      '@deepseek-ai/dsh-base', name === 'web' ? '@deepseek-ai/dsh-web-app' : name === 'headless' ? '@deepseek-ai/dsh-headless' : '@deepseek-harness-tui/dsh-tui',
    ] } } })
    cpSync(join(tuiRoot, 'package'), join(dir, 'node_modules/@deepseek-harness-tui/dsh-tui'), { recursive: true })
    cpSync(join(tuiRoot, 'node_modules'), join(dir, 'node_modules/@deepseek-harness-tui/dsh-tui/node_modules'), { recursive: true })
    for (const [source, target] of [
      ['profiles/web/plugins/confirm-writes.mjs', 'confirm-writes.mjs'],
      ['presets/codex/codex-registrar.mjs', 'codex-registrar.mjs'],
      ['profiles/web/plugins/provider-codex.mjs', 'provider-codex.mjs'],
    ]) {
      text(join(dir, 'plugins', target), readFileSync(join(configRoot, source)))
    }
    if (name !== 'dsh-tui') cpSync(join(configRoot, 'profiles', name, 'cordis.patch.yml'), join(dir, 'cordis.patch.yml'))
    else text(join(dir, 'cordis.patch.yml'), `- insert:\n    - id: confirm-writes\n      name: ./plugins/confirm-writes.mjs\n      config:\n        preset: confirm\n        askTools: [write, edit, str_replace_editor, bash, pwsh, terminal_send]\n    - id: codex-registrar\n      name: ./plugins/codex-registrar.mjs\n      inject: [agentPresets]\n`)
  }
  cpSync(join(configRoot, 'profiles/web/node_modules/dsh-baizhu-approval'), join(dshHome, 'profiles/web/node_modules/dsh-baizhu-approval'), { recursive: true })
  if (!process.env.DSH_CODEX_FIXTURE_ROOT) throw new Error('set DSH_CODEX_FIXTURE_ROOT to the evaluated HM home.file Codex sources (templates must already be expanded)')
  cpSync(process.env.DSH_CODEX_FIXTURE_ROOT, join(dshHome, '.agent-presets/codex'), { recursive: true, dereference: true })
  text(join(dshHome, '.agent-presets/generic/agent.cordis.yml'), '- id: generic-preset-fixture\n  name: ./plugin.mjs\n')
  text(join(dshHome, '.agent-presets/generic/plugin.mjs'), 'export function apply() {}\n')
  text(join(dshHome, '.agent-presets/generic/preset.yml'), 'name: Generic Fixture\ndescription: Not a Codex allowlist\norder: 8\n')
  if (process.env.DSH_PLUGIN_FIXTURE_OLD_RUNTIME) {
    const scope = join(dshHome, 'profiles/node_modules/@deepseek-ai')
    mkdirSync(scope, { recursive: true })
    symlinkSync(join(process.env.DSH_PLUGIN_FIXTURE_OLD_RUNTIME, 'node_modules/@deepseek-ai/dsh-tool-terminal'), join(scope, 'dsh-tool-terminal'))
  }
  const arbitrary = join(dshHome, 'profiles/web/node_modules/acme-desktop-extension')
  json(join(arbitrary, 'package.json'), { name: 'acme-desktop-extension', version: '1.0.0', type: 'module', exports: './index.mjs',
    peerDependencies: { '@deepseek-ai/dsh': '>=0.2.0-rc.1 <0.3.0', '@deepseek-ai/cordis': '*' },
    dsh: { bundle: { patch: './cordis.patch.yml' } } })
  text(join(arbitrary, 'cordis.patch.yml'), '- insert:\n    - id: arbitrary-fixture\n      name: acme-desktop-extension\n      inject: [commands, jobs, workspaceRegistry, approval]\n')
  const webManifestPath = join(dshHome, 'profiles/web/package.json')
  const webManifest = JSON.parse(readFileSync(webManifestPath))
  webManifest.dsh.profile.bundles.push('acme-desktop-extension')
  webManifest.dependencies['acme-desktop-extension'] = 'file:' + arbitrary
  json(webManifestPath, webManifest)
  text(join(arbitrary, 'index.mjs'), `import { createRequire } from 'node:module'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
export async function apply(ctx) {
  const require = createRequire(import.meta.url)
  ctx.effect(() => ctx.get('commands').register({name: 'fixture-desktop', description: 'Arbitrary inherited extension', handler: () => ({kind: 'success', text: 'fixture'})}))
  // The GUI-only fixture creates a genuine unowned job, cancelled by registry teardown.
  // This tests the normal quit inspector and native Cancel/Confirm dialog without
  // changing production inspection results or requiring a model/network request.
  if (process.env.DSH_DESKTOP_GUI_TEST === '1') {
    await ctx.get('workspaceRegistry').create(process.env.HOME, 'GUI Fixture')
    let finish
    const done = new Promise(resolve => { finish = resolve })
    ctx.effect(() => ctx.get('jobs').attachController('desktop-gui-fixture'))
    ctx.get('jobs').start({kind: 'bash', label: 'Isolated quit confirmation fixture', run: () => ({done, cancel: () => finish({status: 'killed'})})})
    const { createToolResultMessage } = await import(require.resolve('@deepseek-ai/dsh-llm'))
    // Offline UI fixture: real Session/Tool correlation and native approval audit
    // waterfall, but no LLM request and no tool body or shell command is executed.
    ctx.effect(() => ctx.get('commands').register({
      name: 'fixture-approval', description: 'Native approval presenter/detail fixture',
      handler: async ({agent, signal}) => {
        const turn = 1, step = 1, callId = 'gui-native-detail-fixture'
        const command = "printf 'DSH_TOOL_DETAIL_FIXTURE'"
        agent.session.append('turn/start', {turn})
        agent.session.append('step/start', {turn, step})
        agent.session.append('tool/call', {turn, step, callId, name: 'bash', arguments: JSON.stringify({command})})
        try {
          const outcome = await ctx.get('approval').request({agent, callId, toolName: 'bash', reason: 'Native presentation fixture requires your approval', signal})
          agent.session.append('tool/result', {turn, step, message: createToolResultMessage({callId, content: [{type: 'text', text: 'No fixture tool body executed: ' + outcome}], isError: outcome !== 'allowed-once'})}, {surfaceOp: 'append'})
          return {kind: 'success', text: 'Fixture approval decision: ' + outcome}
        } finally {
          agent.session.append('step/end', {turn, step})
          agent.session.append('turn/end', {turn, reason: {kind: 'completed'}})
        }
      },
    }))
  }
  const onMessage = message => {
    if (message?.type !== 'fixture-inspect') return
    void (async () => {
      const peers = Object.fromEntries(['@deepseek-ai/cordis', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-llm-pi-ai', '@deepseek-ai/dsh-terminal', '@deepseek-ai/dsh-sandbox-policy', '@deepseek-ai/dsh-llm'].map(name => [name, require.resolve(name)]))
      const fromDesktop = createRequire(process.env.DSH_CODEX_REQUIRE_ANCHOR)
      const packages = ctx.get('pluginPackages')
      const oauthEntry = join(fromDesktop.resolve('@deepseek-harness-tui/dsh-tui/package.json'), '..', 'lib/types/oauth.js')
      const piAi = join(packages.packageOf('@earendil-works/pi-ai', pathToFileURL(peers['@deepseek-ai/dsh-llm-pi-ai']).href).dir, 'dist/index.js')
      const oauthPiAi = join(packages.packageOf('@earendil-works/pi-ai', pathToFileURL(oauthEntry).href).dir, 'dist/index.js')
      const inspection = {
        presets: await ctx.get('agentPresets').list(),
        providers: await ctx.get('dshAuth').api.providers(),
        commands: ctx.get('commands').list({ctx}),
        rows: [...ctx.get('loader').entries()].map(entry => ({id: entry.options.id, name: entry.options.name, disabled: entry.disabled, state: entry.fiber?.state})),
        peers, desktopPeers: Object.fromEntries(Object.keys(peers).map(name => [name, fromDesktop.resolve(name)])),
        codexOptionalTool: process.env.DSH_PLUGIN_FIXTURE_OLD_RUNTIME ? fromDesktop.resolve('@deepseek-ai/dsh-tool-terminal') : undefined,
        piAi, oauthPiAi,
        samePiAiInstance: await import(pathToFileURL(piAi).href) === await import(pathToFileURL(join(process.env.DSH_PI_AI_ROOT, 'dist/index.js')).href),
        configuredPiAi: realpathSync(join(process.env.DSH_PI_AI_ROOT, 'dist/index.js')),
      }
      process.send?.({type: 'fixture-inspection', inspection})
    })().catch(error => process.send?.({type: 'fixture-inspection', error: error.stack}))
  }
  process.on('message', onMessage)
  ctx.effect(() => () => process.off('message', onMessage))
}
`)
  return { home, dshHome, profile }
}
