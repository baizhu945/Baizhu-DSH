// Mount the exact declarative standard/ptc/minimal/cordis presets shipped by
// the pinned dsh Web bundle and the user Codex preset, without Web host services.
// dsh 0.1.7 no longer discovers ~/.dsh/.agent-presets on its own.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const name = 'headless-official-presets'
export const inject = ['agentPresets']

export async function apply(ctx) {
  const registry = ctx.get('agentPresets')
  if (registry === undefined) throw new Error('headless: preset registry unavailable')
  const require = createRequire(ctx.baseUrl ?? import.meta.url)
  const yaml = require('js-yaml')
  // Loader expressions must remain expression nodes until the owning preset
  // plugin evaluates them in its own isolate. Do not evaluate them in Host.
  const js = new yaml.Type('tag:yaml.org,2002:js', {
    kind: 'scalar',
    construct: value => ({ __jsExpr: value }),
  })
  const schema = yaml.JSON_SCHEMA.extend(js)

  for (const id of ['standard', 'ptc', 'minimal', 'cordis']) {
    const source = require.resolve(`@deepseek-ai/dsh-web-app/presets/${id}.patch.yml`)
    const patches = yaml.load(readFileSync(source, 'utf8'), { schema })
    const definition = patches?.[0]?.insert?.[0]?.config
    if (definition?.id !== id || !Array.isArray(definition.plugins)) {
      throw new Error(`headless: invalid shipped ${id} preset declaration: ${source}`)
    }
    const owner = ctx.extend({ baseUrl: pathToFileURL(source).href })
    const dispose = await registry.register(definition)
    // Cordis effects run their setup callback immediately: return the
    // registrar's disposer, do not invoke it while the Host starts.
    ctx.effect(() => dispose)
  }

  const codexFile = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), '.agent-presets', 'codex', 'agent.cordis.yml')
  const codexRows = yaml.load(readFileSync(codexFile, 'utf8'), { schema })
  if (!Array.isArray(codexRows)) throw new Error(`headless: invalid Codex composition: ${codexFile}`)
  // The registry mounts these as direct preset rows (not inside an Include's
  // extra scope). Their modules must resolve relative to the Codex directory,
  // rather than the profile patch which declares this registrar.
  const qualify = rows => rows.map(row => ({
    ...row,
    ...(typeof row.name === 'string' && row.name.startsWith('./')
      ? { name: pathToFileURL(join(dirname(codexFile), row.name)).href } : {}),
    ...(Array.isArray(row.config) ? { config: qualify(row.config) } : {}),
  }))
  const codex = {
    id: 'codex', name: 'Codex Mode',
    description: 'Codex-compatible local coding agent with model-specific tools and prompts.',
    order: 5, plugins: qualify(codexRows),
  }
  const disposeCodex = await registry.register(codex)
  ctx.effect(() => disposeCodex)
  // cc-connect-runner must not resolve or mount a preset before registration
  // has settled; the ordinary agentPresets service alone is not a barrier.
  ctx.provide('headlessPresetsReady', true)
}
