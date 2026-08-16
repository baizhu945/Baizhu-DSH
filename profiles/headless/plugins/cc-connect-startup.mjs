/**
 * cc-connect-startup.mjs — headless 命令行 provider 插件
 *
 * 替代内置的 `@deepseek-ai/dsh-headless/startup`(在 headless profile 的
 * cordis.patch.yml 中禁用)。与内置版唯一区别:除 task 位置参数外,额外解析
 * `--session-id` / `--model` / `--mode` / `--jsonl` 四个选项,并通过
 * `ccConnectStartup` 服务提供给 cc-connect-runner 插件。
 *
 * 这是 dsh 官方文档给出的"surface bundle 自定义命令行"标准做法
 * (docs/user/develop/basic/publish.md):inject cmdlineArgs、用 commander +
 * parseCmdline 解析、在 action 中 ctx.provide 自己的服务。
 *
 * 零补丁:完全由 profile 的 cordis.patch.yml 插入本插件行。
 */

import { Command } from 'commander'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'

/** Cordis 插件名。 */
export const name = 'cc-connect-startup'

/** 需要启动器提供的命令行快照服务。 */
export const inject = ['cmdlineArgs']

/** 本插件提供的服务名(cc-connect-runner 通过它拿到本次运行的参数)。 */
export const CC_CONNECT_STARTUP_SERVICE = 'ccConnectStartup'

/**
 * 构造全新 commander 程序(与内置 startup 相同,便于测试中重复解析)。
 * @returns {Command} 全新程序实例
 */
function headlessCommand() {
  return new Command()
    .name('dsh --profile headless')
    .description('Answer one task, print the final assistant message, and exit.')
    .helpOption('-h, --help', 'show this help')
    .argument('[task...]', 'the task text; multiple words are joined by spaces')
    .option('--session-id <id>', 'explicit session id: resume the persisted session if it exists, otherwise create it')
    .option('--model <model>', 'override the default model for this run')
    .option('--mode <mode>', 'permission mode: read-only | workspace-write | danger-full-access | confirm')
    .option('--jsonl', 'stream JSONL events on stdout and read approval responses from stdin')
    .addHelpText('after', `
Examples:
  dsh --profile headless "run the tests"     answer one task and exit
  dsh --profile headless --session-id abc --model deepseek-v4-pro "run the tests"
  dsh --profile headless --session-id abc --mode confirm --jsonl "run the tests"
`)
}

/**
 * 解析并发布参数。task 为空是用法错误;`--help` 或解析失败时 action 不执行,
 * 服务不提供,cc-connect-runner 因此不会激活(与内置 startup/runner 行为一致)。
 * @param ctx - 插件上下文(cmdlineArgs 就绪)
 */
export function apply(ctx) {
  const program = headlessCommand()
  program.action(() => {
    const task = program.args.join(' ')
    if (task.trim() === '') program.error('error: a task is required, for example: dsh --profile headless "run the tests"')
    const opts = program.opts()
    const values = { task }
    if (typeof opts.sessionId === 'string' && opts.sessionId !== '') values.sessionId = opts.sessionId
    if (typeof opts.model === 'string' && opts.model !== '') values.model = opts.model
    if (typeof opts.mode === 'string' && opts.mode !== '') values.mode = opts.mode
    if (opts.jsonl === true) values.jsonl = true
    ctx.provide(CC_CONNECT_STARTUP_SERVICE, values)
  })
  parseCmdline(ctx, program)
}
