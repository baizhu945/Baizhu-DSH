/**
 * Keep host-added tools outside the Codex-compatible model surface.
 *
 * Optional host tools such as SSH and image description are not part of the
 * OpenAI Codex CLI tool contract. Restrict only names that exist in this
 * deployment; headless profiles without those plugins remain valid.
 */
export const name = 'codex-tool-boundary'
export const inject = ['tools']

const HOST_EXTRAS = [
  'describe_image',
  'ssh_cluster',
  'ssh_download',
  'ssh_exec',
  'ssh_list',
  'ssh_tunnel',
  'ssh_upload',
]

export function apply(ctx) {
  const available = new Set(ctx.tools.schemas().map(tool => tool.name))
  const deny = HOST_EXTRAS.filter(name => available.has(name))
  if (deny.length > 0) ctx.tools.restrict({ deny })
}
