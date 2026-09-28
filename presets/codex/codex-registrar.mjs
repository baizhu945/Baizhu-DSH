// Register the user's Codex composition as direct declarative preset rows.
// A nested cordis:include here would add a scope in which several host
// services never start on dsh 0.1.7; the registry must mount these rows itself.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const name = 'codex-registrar'
export const inject = ['agentPresets']

export async function apply(ctx) {
  const require = createRequire(ctx.baseUrl ?? import.meta.url)
  const yaml = require('js-yaml')
  const expression = new yaml.Type('tag:yaml.org,2002:js', {
    kind: 'scalar', construct: value => ({ __jsExpr: value }),
  })
  const schema = yaml.JSON_SCHEMA.extend(expression)
  const path = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), '.agent-presets', 'codex', 'agent.cordis.yml')
  const rows = yaml.load(readFileSync(path, 'utf8'), { schema })
  if (!Array.isArray(rows)) throw new Error(`codex: invalid preset composition: ${path}`)
  const qualify = entries => entries.map(entry => ({
    ...entry,
    ...(typeof entry.name === 'string' && entry.name.startsWith('./')
      ? { name: pathToFileURL(join(dirname(path), entry.name)).href } : {}),
    ...(Array.isArray(entry.config) ? { config: qualify(entry.config) } : {}),
  }))
  const registry = ctx.get('agentPresets')
  if (registry === undefined) throw new Error('codex: preset registry unavailable')
  const dispose = await registry.register({
    id: 'codex', name: 'Codex Mode', order: 5,
    description: 'Codex-compatible local coding agent with model-specific tools and prompts.',
    plugins: qualify(rows),
  })
  // Cordis runs effect setup now; return the disposer instead of calling it.
  ctx.effect(() => dispose)
}
