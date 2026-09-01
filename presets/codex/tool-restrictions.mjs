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

// The web profile keeps the standard dsh tool bundle mounted beside the
// preset. Codex exposes the equivalent unified-exec/fs surface instead, so
// hide the dsh-native names only in this agent scope.
const DSH_NATIVE_TOOLS = [
  'ask_user_question',
  'bash',
  'create_goal',
  'edit',
  'get_goal',
  'glob',
  'grep',
  'job_kill',
  'job_list',
  'job_output',
  'pwsh',
  'read',
  'read_image',
  'str_replace_editor',
  'terminal_close',
  'terminal_list',
  'terminal_open',
  'terminal_read',
  'terminal_send',
  'terminal_signal',
  'todo_write',
  'update_goal',
  'web_fetch',
  'write',
]

export function apply(ctx) {
  const available = new Set(ctx.tools.schemas().map(tool => tool.name))
  const deny = [...HOST_EXTRAS, ...DSH_NATIVE_TOOLS].filter(name => available.has(name))
  if (deny.length > 0) ctx.tools.restrict({ deny })
}
