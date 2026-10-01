/**
 * Keep host-added tools outside the Codex-compatible model surface.
 *
 * Optional host tools such as SSH and image description are not part of the
 * OpenAI Codex CLI tool contract. Restrict only names that exist in this
 * deployment; headless profiles without those plugins remain valid.
 */
export const name = 'codex-tool-boundary'
export const inject = ['tools']

// Host-added tools that are not part of the OpenAI Codex CLI tool contract.
// They are denied on the direct surface here and again for the nested Code
// Mode SDK by codex-model-parity.mjs, so a Code Mode program cannot reach the
// dsh-native delegation, plan and workflow tools behind the Codex shapes.
const HOST_EXTRAS = [
  'describe_image',
  'ssh_cluster',
  'ssh_download',
  'ssh_exec',
  'ssh_list',
  'ssh_tunnel',
  'ssh_upload',
]

const DSH_NATIVE_TOOLS = [
  'ask_user_question',
  'bash',
  'create_goal',
  'edit',
  'exit_plan_mode',
  'get_goal',
  'glob',
  'grep',
  'interrupt_agent',
  'job_kill',
  'job_list',
  'job_output',
  'list_agents',
  'list_subagent_models',
  'pwsh',
  'read',
  'read_image',
  'send_message',
  'str_replace_editor',
  'subagent',
  'subagent_fork',
  'terminal_close',
  'terminal_list',
  'terminal_open',
  'terminal_read',
  'terminal_send',
  'terminal_signal',
  'todo_write',
  'update_goal',
  'web_fetch',
  'workflow',
  'write',
]

export function apply(ctx) {
  const available = new Set(ctx.tools.schemas().map(tool => tool.name))
  const deny = [...HOST_EXTRAS, ...DSH_NATIVE_TOOLS].filter(name => available.has(name))
  if (deny.length > 0) ctx.tools.restrict({ deny })
}
