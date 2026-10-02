/** Register user-authored preset compositions after the Host Loader has settled.
 * No prompt/tool rewriting, Include scope, credentials, or directory materialization.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const name = 'desktop-user-presets'
export const inject = ['agentPresets']

export async function apply(ctx) {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const require = createRequire(process.env.DSH_CODEX_REQUIRE_ANCHOR ?? ctx.baseUrl ?? import.meta.url)
  const yaml = require('js-yaml')
  const expression = new yaml.Type('tag:yaml.org,2002:js', {
    kind: 'scalar', construct: value => ({ __jsExpr: value }),
  })
  const schema = yaml.JSON_SCHEMA.extend(expression)
  const registry = ctx.get('agentPresets')
  if (!registry) throw new Error('desktop presets: preset registry unavailable')
  // This plugin is installed only AFTER `await application`, never a pending
  // declarative Host Loader entry: list() may itself await Host Loader settlement.
  const registered = new Set((await registry.list()).map(row => row.id))
  const root = join(home, '.agent-presets')
  if (!existsSync(root)) return
  const directories = readdirSync(root, { withFileTypes: true }).filter(entry => !entry.name.startsWith('.')
    && (entry.isDirectory() || entry.isSymbolicLink())).sort((a, b) => a.name.localeCompare(b.name))
  for (const directory of directories) {
    const path = join(root, directory.name, 'agent.cordis.yml')
    if (!existsSync(path)) continue
    if (registered.has(directory.name)) {
      console.log(`desktop presets: ${directory.name} already registered; keeping existing declaration`)
      continue
    }
    try {
      const rows = yaml.load(readFileSync(path, 'utf8'), { schema })
      if (!Array.isArray(rows)) throw new Error('composition must be an entry list')
      // Exactly the existing registrar's transport pattern: qualify local names and
      // nested row lists, preserving all settings, prompts, and !!js expressions.
      const qualify = entries => entries.map(entry => entry === null || typeof entry !== 'object' ? entry : ({
        ...entry,
        ...(typeof entry.name === 'string' && entry.name.startsWith('./')
          ? { name: pathToFileURL(join(dirname(path), entry.name)).href } : {}),
        ...(Array.isArray(entry.config) ? { config: qualify(entry.config) } : {}),
      }))
      const metadataPath = join(dirname(path), 'preset.yml')
      const metadata = existsSync(metadataPath) ? yaml.load(readFileSync(metadataPath, 'utf8'), { schema }) : {}
      if (metadata !== undefined && (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata))) {
        throw new Error('preset.yml must be a metadata mapping')
      }
      const dispose = await registry.register({
        id: directory.name,
        ...(typeof metadata?.name === 'string' ? { name: metadata.name } : {}),
        ...(typeof metadata?.description === 'string' ? { description: metadata.description } : {}),
        ...(typeof metadata?.order === 'number' && Number.isFinite(metadata.order) ? { order: metadata.order } : {}),
        plugins: qualify(rows),
      })
      ctx.effect(() => dispose)
      registered.add(directory.name)
      console.log(`desktop presets: registered ${directory.name} from ${path}`)
    } catch (error) {
      console.error(`desktop presets: invalid ${path}: ${error instanceof Error ? error.stack : String(error)}`)
    }
  }
}
