/**
 * Keep host-added tools outside the Codex-compatible model surface.
 *
 * dsh-web-ui contributes optional SSH and image-description tools globally.
 * They are useful in the general Web profile but are not part of the OpenAI
 * Codex CLI tool contract. Restrict only names that exist in this deployment:
 * headless profiles without those plugins remain valid.
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
