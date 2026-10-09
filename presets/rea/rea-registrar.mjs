// A roster declaration only. registry.register eagerly mounts child rows, so
// the composition contains an inert REA bootstrap, never a direct MCP row.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const name = 'rea-registrar'
export const inject = ['agentPresets', 'loader']

export async function readDefinition(ctx, config = {}) {
  // Activation supplies the immutable CLI anchor from _module.args.dsh. This
  // uses the host SDK, not a second Cordis installed alongside this plugin.
  const anchor = config.hostPackageJson
  if (typeof anchor !== 'string' || !anchor.endsWith('/apps/cli/package.json')) {
    throw new Error('rea: hostPackageJson must identify the deployed DSH CLI')
  }
  const require = createRequire(anchor)
  const yaml = require('js-yaml')
  const loader = ctx.get('loader')
  if (!loader?.internal?.import) throw new Error('rea: host loader unavailable')
  const { entryListSchema } = await loader.internal.import(
    '@deepseek-ai/cordis-plugin-include', pathToFileURL(anchor).href, {},
  )
  const root = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const composition = join(root, '.agent-presets', 'rea', 'agent.cordis.yml')
  const metadataPath = join(dirname(composition), 'preset.yml')
  const rows = yaml.load(readFileSync(composition, 'utf8'), { schema: entryListSchema })
  const metadata = yaml.load(readFileSync(metadataPath, 'utf8'), { schema: yaml.JSON_SCHEMA })
  if (!Array.isArray(rows)) throw new Error(`rea: expected entry list: ${composition}`)
  if (metadata?.id !== 'rea' || metadata.name !== 'REA' || metadata.order !== 6) {
    throw new Error(`rea: invalid preset metadata: ${metadataPath}`)
  }
  const qualify = entries => entries.map(entry => ({
    ...entry,
    ...(typeof entry.name === 'string' && entry.name.startsWith('./')
      ? { name: pathToFileURL(join(dirname(composition), entry.name)).href } : {}),
    ...(entry.group && Array.isArray(entry.config) ? { config: qualify(entry.config) } : {}),
  }))
  return {
    id: metadata.id, name: metadata.name, order: metadata.order,
    description: metadata.description,
    plugins: qualify(rows),
  }
}

export async function apply(ctx, config) {
  const registry = ctx.get('agentPresets')
  if (registry === undefined) throw new Error('rea: preset registry unavailable')
  const dispose = await registry.register(await readDefinition(ctx, config))
  // effect setup runs now; return the disposer, do not invoke it at load time.
  ctx.effect(() => dispose)
}
