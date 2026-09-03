import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  codeModePreview,
  codeModeSyntaxValid,
  contextTokensRemaining,
  directPatchContent,
  modelToolAllowed,
  modelInstructions,
  normalizeCodeModeSource,
  officialRuntimeProgram,
  normalizeToolMode,
  patchWebSearchSchema,
  profileForModel,
  modelRowFor,
  registerCodeModeAlias,
  registerV2Agents,
  rewriteCodeModeName,
  truncateToolContent,
  unwrapCodeModeResult,
  tokenBudgetContextText,
  v2FinalMessageId,
  v2Status,
  validateV2TaskName,
  waitForV2MailboxUpdate,
} from './codex-model-parity.mjs'
import { approvalReason, apply as applyApproval, patchApprovalPreview } from './codex-approval.mjs'
import {
  applyPatch,
  applyHunks,
  collabInputContent,
  collabPromptContent,
  directChildren,
  filesystemElement,
  outputFromOperation,
  outputTokenBudget,
  patchInput,
  patchEnvironmentId,
  parsePatchOperations,
  permissionInstructions,
  preflightPatch,
  pipeOutput,
  terminalOutputText,
  waitForTerminalOperation,
  registerAgents,
} from './codex-surface.mjs'
import { apply as applyCodexWebSearch, parseResponseBody, parseResponseEnvelope, requestCodexSearchForTest, searchCommands } from './codex-web-search.mjs'
import { apply as applyCodexPermissions, CODEX_PROFILES, commonDirectory, normalizePermissionRequest } from './codex-permissions.mjs'

const agentComposition = readFileSync(new URL('./agent.cordis.yml', import.meta.url), 'utf8')

const shellQuoteSplice = String.fromCharCode(39) + String.fromCharCode(34) + String.fromCharCode(39) + String.fromCharCode(34) + String.fromCharCode(39)
const directPatch = ['*** Begin Patch', '*** Add File: direct.txt', '+direct "quoted" line', '*** End Patch'].join('\n')
const backtick = String.fromCharCode(96)
const rawPatch = [
  '*** Begin Patch',
  '*** Add File: raw.txt',
  '+comments mention ' + backtick + 'run_code' + backtick + ' and ' + backtick + 'both' + backtick + '.',
  '*** End Patch',
].join('\n')
const rawPatchSource = [
  'const patch = String.raw' + backtick + rawPatch + backtick + ';',
  'return await tools.apply_patch({ patch });',
].join('\n')

const compatibilityCases = [
  ['unescaped shell double quotes', 'return await tools.exec_command({ cmd: "printf "hello" world" })'],
  ['shell quote splicing', 'return await tools.exec_command({ cmd: "rg ... ' + shellQuoteSplice + '@earendil-works/pi-ai|@deepseek-ai/dsh-llm' + shellQuoteSplice + ' ..." })'],
  ['literal multiline string', ['return await tools.exec_command({ cmd: "printf one', 'two" })'].join('\n')],
  ['patch content quotes', ['return await tools.apply_patch({ input: "*** Begin Patch', '*** Add File: quoted.txt', '+quoted "value"', '*** End Patch" })'].join('\n')],
  ['bash parameter expansion', 'return await tools.exec_command({ cmd: ' + String.fromCharCode(96) + 'printf ' + '$' + '{name:-fallback}' + String.fromCharCode(96) + ' })'],
  ['valid source', 'return await tools.exec_command({ cmd: "printf \\"hello\\"" })'],
]

test('malformed Code Mode strings compile after fallback repair', () => {
  for (const [name, source] of compatibilityCases) {
    const normalized = normalizeCodeModeSource(source)
    assert.equal(codeModeSyntaxValid(normalized), true, name)
    if (name === 'valid source') assert.equal(normalized, source)
  }
})

test('Code Mode repairs multiple malformed command fields after a valid command', async () => {
  const quote = String.fromCharCode(34)
  const source = [
    'const results = await Promise.all([',
    '  tools.exec_command({ cmd: ' + quote + 'printf dsh' + quote + ', workdir: ' + quote + '/tmp' + quote + ' }),',
    '  tools.exec_command({ cmd: ' + quote + 'for f in /tmp/a; do echo; echo ' + quote + '===== $f =====' + quote + '; nl -ba ' + quote + '$f' + quote + '; done' + quote + ', workdir: ' + quote + '/tmp' + quote + ' }),',
    '  tools.exec_command({ cmd: ' + quote + 'for g in /tmp/b; do echo ' + quote + '----- $g -----' + quote + '; done' + quote + ', workdir: ' + quote + '/tmp' + quote + ' }),',
    '  tools.exec_command({ cmd: ' + quote + 'printf dsh && readlink -f ' + quote + '$(command -v codex)' + quote + ' && file ' + quote + '$(command -v codex)' + quote + ' && true' + quote + ', workdir: ' + quote + '/tmp' + quote + ' }),',
    ']);',
    'return results;',
  ].join(String.fromCharCode(10))
  const normalized = normalizeCodeModeSource(source)
  assert.equal(codeModeSyntaxValid(source), false)
  assert.equal(codeModeSyntaxValid(normalized), true)
  const calls = []
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  const run = new AsyncFunction('tools', normalized)
  await run({ exec_command: async ({ cmd }) => { calls.push(cmd); return cmd } })
  assert.equal(calls.length, 4)
  assert.match(calls[1], /echo "===== \$f ====="/)
  assert.match(calls[2], /echo "----- \$g -----"/)
  assert.match(calls[3], /readlink -f "\$\(command -v codex\)"/)
})

test('Code Mode repairs nested jq and Node single-quote shell commands', async () => {
  const single = String.fromCharCode(39)
  const double = String.fromCharCode(34)
  const shell = [
    'file=/tmp/session.jsonl.zstd; zstdcat -- ' + double + '$file' + double + ' 2>/dev/null',
    '| jq -r ' + single + 'select(.type==' + double + 'tool-call' + double + ') | .data.arguments' + single,
    '| node --input-type=module -e ' + single + 'import fs from ' + double + 'node:fs' + double + '; console.log(fs.readFileSync(0,' + double + 'utf8' + double + '))' + single,
  ].join(' ')
  const source = 'const result = await tools.exec_command({ cmd: ' + single + shell + single + ' }); return result'
  const normalized = normalizeCodeModeSource(source)
  assert.equal(codeModeSyntaxValid(source), false)
  assert.equal(codeModeSyntaxValid(normalized), true)
  let received
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  const run = new AsyncFunction('tools', normalized)
  await run({ exec_command: async ({ cmd }) => { received = cmd; return cmd } })
  assert.equal(received, shell)
})

test('Code Mode repairs repeated shell diagnostics containing parser-error quotes', async () => {
  const single = String.fromCharCode(39)
  const double = String.fromCharCode(34)
  const diagnostics = [
    'Expected ' + single + ';' + single + ', got ' + single + 'string literal' + single,
    'Expected ' + single + ',' + single + ' got ' + single + ';' + single,
  ]
  const shell = [
    'file=/tmp/session.jsonl.zstd; zstdcat -- ' + double + '$file' + double + ' 2>/dev/null',
    '| rg -q -F ' + double + diagnostics[0] + double + ' || rg -q -F ' + double + diagnostics[1] + double + '; then',
    'zstdcat -- ' + double + '$file' + double + ' 2>/dev/null | rg -n -F ' + double + diagnostics[0] + double + ' -e ' + double + diagnostics[1] + double + ' -B5 -A5 | tail -50;',
    'fi',
  ].join(' ')
  const source = 'const result = await tools.exec_command({ cmd: ' + single + shell + single + ', workdir: ' + single + '/tmp' + single + ' }); return result'
  const normalized = normalizeCodeModeSource(source)
  assert.equal(codeModeSyntaxValid(source), false)
  assert.equal(codeModeSyntaxValid(normalized), true)
  let received
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  const run = new AsyncFunction('tools', normalized)
  await run({ exec_command: async args => { received = args; return args } })
  assert.deepEqual(received, { cmd: shell, workdir: '/tmp' })
})

test('Code Mode repairs jq JSON quotes inside a double-quoted command field', async () => {
  const single = String.fromCharCode(39)
  const double = String.fromCharCode(34)
  const shell = [
    'file=/tmp/session.jsonl.zstd; zstdcat -- ' + double + '$file' + double + ' 2>/dev/null',
    '| jq -r ' + single + 'select(.type==' + double + 'request/header' + double + ') | .data.header.tools[]',
    '| jq -r ' + single + '[.name,((.description // ' + double + double + ')|contains(' + double + 'skill' + double + '))] | @tsv' + single,
  ].join(' ')
  const source = 'const result = await tools.exec_command({ cmd: ' + double + shell + double + ' }); return result'
  const normalized = normalizeCodeModeSource(source)
  assert.equal(codeModeSyntaxValid(source), false)
  assert.equal(codeModeSyntaxValid(normalized), true)
  let received
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  const run = new AsyncFunction('tools', normalized)
  await run({ exec_command: async ({ cmd }) => { received = cmd; return cmd } })
  assert.equal(received, shell)
})

test('Code Mode preview resolves typed command bindings and preserves shell interpolation', () => {
  const source = [
    'const cmd: string = [',
    '  "printf one",',
    '  `printf "${name:-fallback}"`,',
    '].join("\\n");',
    'return await tools.exec_command({ cmd, workdir: "/home/baizhu945" });',
  ].join('\n')
  const preview = codeModePreview(source)
  assert.match(preview.text, /Command: printf one\nprintf "\$\{name:-fallback\}"/)
  assert.doesNotMatch(preview.text, /Command: cmd \(Code Mode expression\)/)
})

test('Code Mode preview follows reassigned bindings and simple JavaScript helpers', () => {
  const cases = [
    'let cmd; cmd = "printf reassigned"; return await tools.exec_command({ cmd });',
    'const cmd = ["printf helper"].join(String.fromCharCode(10)) as string; return await tools.exec_command({ cmd });',
  ]
  for (const source of cases) {
    const preview = codeModePreview(source)
    assert.match(preview.text, /Command: printf (?:reassigned|helper)/)
    assert.doesNotMatch(preview.text, /Command: cmd \(Code Mode expression\)/)
  }
})

test('malformed String.raw patch templates preserve literal backticks', async () => {
  const normalized = normalizeCodeModeSource(rawPatchSource)
  assert.equal(codeModeSyntaxValid(normalized), true)
  let received
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  const run = new AsyncFunction('tools', normalized)
  await run({ apply_patch: async ({ patch }) => { received = patch; return patch } })
  assert.equal(received, rawPatch)
})

test('valid Code Mode source remains byte-identical', () => {
  const source = 'return await tools.exec_command({ cmd: "printf \\"hello\\"" })'
  assert.equal(normalizeCodeModeSource(source), source)
})

test('Code Mode injects the official helper names and catches exit()', async () => {
  const source = officialRuntimeProgram('text(\"hello\"); exit(); text(\"unreachable\");')
  assert.match(source, /const text =/)
  assert.match(source, /const store =/)
  assert.match(source, /__dshCodexExit/)
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  const logs = []
  const run = new AsyncFunction('console', source)
  await run({ log: value => logs.push(value) })
  assert.deepEqual(logs, ['hello'])
})

test('Code Mode seeds and returns session store state through its runtime envelope', async () => {
  const source = officialRuntimeProgram('store("answer", 42); return load("answer");', { answer: 7 })
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  const result = await new AsyncFunction('console', source)({ log: () => {} })
  assert.equal(result.__dshCodexEnvelope, true)
  assert.equal(result.__dshCodexResultPresent, true)
  assert.equal(result.__dshCodexResult, 42)
  assert.equal(result.__dshCodexStore.answer, 42)
})

test('Code Mode unwraps the host run_code envelope before exposing exec results', () => {
  const session = {}
  const envelope = {
    __dshCodexEnvelope: true,
    __dshCodexResultPresent: true,
    __dshCodexResult: 'visible result',
    __dshCodexStore: { answer: 42 },
  }
  assert.deepEqual(unwrapCodeModeResult({ logs: ['host log'], result: envelope }, session), {
    logs: ['host log'],
    result: 'visible result',
  })
})

test('raw freeform patch gets an edit preview', () => {
  assert.equal(directPatchContent(directPatch), directPatch)
  const preview = codeModePreview(directPatch)
  assert.equal(preview.kind, 'edit')
  assert.match(preview.text, /Patch preview: \+1\/-0/)
  assert.match(preview.text, /\+ direct "quoted" line/)
})

test('Code Mode routes a raw patch once through nested apply_patch', async () => {
  const registrations = []
  const calls = []
  const ctx = {
    tools: {
      register: tool => registrations.push(tool),
      execute: async request => {
        calls.push(request)
        return { isError: false, value: { files: [{ path: 'direct.txt', operation: 'add' }], diffs: [] } }
      },
    },
  }
  registerCodeModeAlias(ctx)
  const tool = registrations.find(item => item.name === 'exec')
  assert.ok(tool)
  const execution = { callId: 'outer', rootCallId: 'root', agent: { id: 'agent' }, token: 'parent-token' }
  const result = await tool.execute({ input: directPatch }, execution)
  assert.deepEqual(result.logs, [])
  assert.equal(result.result.files[0].path, 'direct.txt')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, 'apply_patch')
  assert.equal(calls[0].parent, execution.token)
  assert.equal(calls[0].arguments.input, directPatch)
})

test('approval reason contains patch summary and authored +/- lines', () => {
  const patch = ['*** Begin Patch', '*** Update File: demo.mjs', '@@', '-old line', '+new "quoted" line', ' context', '*** End Patch'].join('\n')
  const preview = patchApprovalPreview(patch)
  assert.match(preview, /Patch preview: \+1\/-1/)
  assert.match(preview, /\+ new "quoted" line/)
  assert.match(preview, /- old line/)
  const reason = approvalReason({ tools: { get: () => ({ presentCall: () => ({ title: 'Apply patch — demo.mjs' }) }) } }, {
    name: 'apply_patch',
    agent: { session: { events: [] } },
    arguments: { input: patch },
  })
  assert.match(reason, /Apply patch — demo\.mjs/)
  assert.match(reason, /\+ new "quoted" line/)
})

test('approval hook asks with the enriched patch reason', async () => {
  let preExecute
  applyApproval({
    on: (_event, handler) => { preExecute = handler },
    sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access' }) },
    permissionPresets: { current: () => undefined },
    tools: { get: () => undefined },
  })
  const patch = ['*** Begin Patch', '*** Add File: approval.txt', '+approved', '*** End Patch'].join('\n')
  const decision = await preExecute({
    name: 'apply_patch',
    agent: { session: { events: [{ type: 'approval/policy', data: { policy: 'ask' } }] } },
    arguments: { input: patch },
  }, () => ({ kind: 'continue' }))
  assert.equal(decision.kind, 'ask')
  assert.match(decision.reason, /Patch preview: \+1\/-0/)
  assert.match(decision.reason, /\+ approved/)
})

test('PTY output parser preserves split echo, prompt, and exit marker state', () => {
  const record = {
    id: 7,
    marker: '__M',
    echoedInput: 'echo hi',
    echoTail: '',
    protocolTail: '',
    truncated: false,
  }
  const newline = String.fromCharCode(10)
  const deltas = ['echo', ' hi' + newline + 'out' + newline + newline + '__M', '1' + newline + 'dsh> ']
  const values = deltas.map(delta => outputFromOperation(record, {
    readOutput: () => ({ delta, truncated: false }),
  }))
  assert.equal(values[0].output, '')
  assert.equal(values[1].output, 'out' + newline)
  assert.deepEqual(values[2], { output: '', exitCode: 1 })
})

test('terminal output exposes session metadata and pipe termination signals', () => {
  assert.equal(terminalOutputText({ output: 'ok', exit_code: 0 }), 'ok')
  assert.match(terminalOutputText({ output: 'hello', session_id: 3, exit_code: 2 }), /session ID: 3/)
  assert.match(terminalOutputText({ output: 'hello', session_id: 3, exit_code: 2 }), /exit code: 2/)
  const record = {
    id: 1,
    chunk: 0,
    process: {
      readOutput: () => ({ delta: 'bad', lossy: false }),
      status: 'killed',
      exitCode: null,
      signal: 'SIGTERM',
    },
  }
  const value = pipeOutput(record, 1_234, 10)
  assert.match(value.output, /killed by signal: SIGTERM/)
  assert.equal(value.wall_time_seconds, 1.234)
})

test('terminal operation wait rejects on abort and does not wait for its timer', async () => {
  let settle
  const operation = { done: new Promise(resolve => { settle = resolve }) }
  const controller = new AbortController()
  const waiting = waitForTerminalOperation(operation, 60_000, controller.signal)
  controller.abort(new Error('cancelled'))
  await assert.rejects(waiting, /cancelled/)
  settle({ sessionStatus: { kind: 'running' } })
})

test('apply_patch rejects empty before stat and duplicate operations like the official verifier', async () => {
  const newline = String.fromCharCode(10)
  const empty = ['*** Begin Patch', '*** End Patch'].join(newline)
  assert.deepEqual(parsePatchOperations(empty), [])
  let statCalls = 0
  const ctx = {
    fs: {
      resolve: async path => ({ targetKey: path, displayPath: path }),
      stat: async () => { statCalls++ },
    },
    emit: () => {},
  }
  const exec = { agent: { session: { header: { cwd: '/tmp' } } }, signal: new AbortController().signal }
  await assert.rejects(preflightPatch(ctx, exec, empty), /no file operations/)
  assert.equal(statCalls, 0)
  const foreignEnvironment = [
    '*** Begin Patch',
    '*** Environment ID: remote',
    '*** Add File: remote.txt',
    '+remote',
    '*** End Patch',
  ].join(newline)
  assert.equal(patchEnvironmentId(foreignEnvironment), 'remote')
  await assert.rejects(preflightPatch(ctx, exec, foreignEnvironment), /one local environment/)
  const duplicate = [
    '*** Begin Patch',
    '*** Add File: same.txt',
    '+old',
    '*** Update File: same.txt',
    '@@',
    '-old',
    '+new',
    '*** Update File: same.txt',
    '*** Move to: moved.txt',
    '@@',
    '-new',
    '+final',
    '*** End Patch',
  ].join(newline)
  await assert.rejects(preflightPatch(ctx, exec, duplicate), /multiple operations target same.txt/)
})

test('apply_patch Add File overwrites an existing regular file', async () => {
  const state = fakePatchContext({ 'existing.txt': 'old content\n' })
  const patch = [
    '*** Begin Patch',
    '*** Add File: existing.txt',
    '+new content',
    '*** End Patch',
  ].join('\n')
  await applyPatch(state.ctx, patchExecution(), patch)
  assert.equal(state.files.get('existing.txt')?.content, 'new content\n')
})

test('apply_patch accepts official padded operation markers and both object aliases', () => {
  const patch = ['*** Begin Patch', '  *** Update File: foo.txt', '@@', '-old', '+new', '*** End Patch'].join('\n')
  const operations = parsePatchOperations(patch)
  assert.equal(operations[0].path, 'foo.txt')
  assert.equal(patchInput({ input: patch }), patch)
  assert.equal(patchInput({ patch }), patch)
})

test('apply_patch tolerates the official trailing empty-line sentinel', () => {
  const patch = ['*** Begin Patch', '*** Update File: foo.txt', '@@', ' first', ' second', '+third', ' ', '*** End Patch'].join('\n')
  assert.equal(applyHunks('first\nsecond\n', parsePatchOperations(patch)[0].body, 'foo.txt'), 'first\nsecond\nthird\n')
})

test('legacy shell catalog rows retain unified exec and text-only web schemas are narrowed', () => {
  const daybreak = profileForModel('gpt-daybreak-blue-latest')
  assert.equal(daybreak.shellType, 'unified_exec')
  assert.equal(modelToolAllowed({}, daybreak, 'exec_command', {}, true), true)
  const spark = profileForModel('gpt-5.3-codex-spark')
  assert.equal(spark.toolMode, 'native')
  assert.equal(spark.applyPatchToolType, 'none')
  assert.equal(spark.contextWindow, 272_000)
  const schema = {
    name: 'web__run',
    parameters: { properties: { search_query: {}, image_query: {} } },
  }
  const narrowed = patchWebSearchSchema(schema, spark)
  assert.equal(narrowed.parameters.properties.image_query, undefined)
  assert.notEqual(schema.parameters.properties.image_query, undefined)
})

test('Codex skill visibility follows the selected official catalog row', () => {
  const luna = profileForModel('gpt-5.6-luna')
  assert.equal(luna.includeSkillsUsageInstructions, false)
  assert.equal(modelToolAllowed({}, luna, 'skill', {}, true), false)
  const legacy = profileForModel('gpt-5.4')
  assert.equal(legacy.includeSkillsUsageInstructions, true)
  assert.equal(modelToolAllowed({}, legacy, 'skill', {}, false), true)
})

test('CodeModeOnly retains official DirectModelOnly controls beside exec', () => {
  const luna = profileForModel('gpt-5.6-luna')
  assert.equal(modelToolAllowed({}, luna, 'request_user_input', {}, false), true)
  assert.equal(modelToolAllowed({}, luna, 'request_user_input', {}, true), false)
  assert.equal(modelToolAllowed({}, luna, 'new_context', {}, false), true)
  assert.equal(modelToolAllowed({}, luna, 'new_context', {}, true), false)
  assert.equal(modelToolAllowed({}, luna, 'update_plan', {}, false), true)
  assert.equal(modelToolAllowed({}, luna, 'update_plan', {}, true), true)
  assert.equal(modelToolAllowed({}, luna, 'multi_agent_v1__spawn_agent', {}, false), true)
  assert.equal(modelToolAllowed({}, luna, 'multi_agent_v1__spawn_agent', {}, true), false)
  assert.equal(modelToolAllowed({}, luna, 'collaboration__spawn_agent', {}, false), false)

  const terra = profileForModel('gpt-5.6-terra')
  assert.equal(modelToolAllowed({}, terra, 'collaboration__spawn_agent', {}, false), true)
  assert.equal(modelToolAllowed({}, terra, 'collaboration__spawn_agent', {}, true), false)
  assert.equal(modelToolAllowed({}, terra, 'collaboration__wait_agent', {}, false), true)
  assert.equal(modelToolAllowed({}, terra, 'collaboration__wait_agent', {}, true), false)
})

test('Codex scope hides dsh-native tool names for every selected provider', () => {
  const profile = profileForModel('vendor/custom-coder')
  for (const name of ['bash', 'read', 'write', 'edit', 'glob', 'grep', 'terminal_open', 'web_fetch']) {
    assert.equal(modelToolAllowed({}, profile, name, {}, false), false, name)
    assert.equal(modelToolAllowed({}, profile, name, {}, true), false, name)
  }
  assert.equal(modelToolAllowed({}, profile, 'request_permissions', {}, false), true)
  assert.equal(modelToolAllowed({}, profile, 'update_plan', {}, false), true)
  assert.equal(modelToolAllowed({}, profile, 'update_plan', {}, true), true)
})

test('unknown Codex model fallback matches official conservative metadata', () => {
  const unknown = profileForModel('vendor/custom-coder')
  assert.equal(unknown.includeSkillsUsageInstructions, false)
  assert.equal(unknown.includeAppsUsageInstructions, false)
  assert.equal(unknown.includePluginUsageInstructions, false)
  assert.equal(unknown.applyPatchToolType, 'none')
  assert.equal(unknown.contextWindow, 272_000)
  assert.deepEqual(unknown.truncationPolicy, { mode: 'bytes', limit: 10_000 })
})

test('Codex model lookup follows the official longest-prefix namespace rules', () => {
  const prefixed = profileForModel('vendor/gpt-5.6-sol-pro')
  assert.equal(modelRowFor('vendor/gpt-5.6-sol-pro')?.slug, 'gpt-5.6-sol')
  assert.equal(prefixed.toolMode, 'code_mode_only')
  assert.equal(prefixed.contextWindow, 1_050_000)
  assert.equal(prefixed.maxContextWindow, 1_050_000)
  assert.equal(modelRowFor('vendor/nested/gpt-5.6-sol'), undefined)
})

test('Codex permission aliases stay isolated and grants use a bounded common root', () => {
  assert.deepEqual(Object.keys(CODEX_PROFILES), ['codex-read-only', 'codex-on-request', 'codex-full-access'])
  assert.equal(commonDirectory(['/home/baizhu945/repo/a.txt', '/home/baizhu945/repo/b.txt']), '/home/baizhu945/repo')
  assert.equal(commonDirectory(['/tmp/a.txt', '/var/b.txt']), undefined)
  const normalized = normalizePermissionRequest(
    { session: { header: { cwd: '/home/baizhu945' } } },
    { file_system: { write: ['repo/a.txt'] } },
  )
  assert.deepEqual(normalized.write, ['/home/baizhu945/repo/a.txt'])
  assert.equal(normalized.writeRoot, '/home/baizhu945/repo')
})

test('Codex permission grants are turn-scoped and never policy rejects without prompting', async () => {
  const events = [{ type: 'turn/start', data: { turn: 1 }, seq: 1 }]
  const agent = { session: { header: { cwd: '/repo' }, events } }
  let provided
  let asks = 0
  const ctx = {
    provide: (_name, value) => { provided = value },
    on: () => () => {},
    inject: () => {},
    get: name => name === 'approval' ? {
      effectivePolicy: () => 'ask',
      request: async () => { asks++; return 'allowed-once' },
    } : undefined,
  }
  applyCodexPermissions(ctx)
  const granted = await provided.request(
    agent,
    { callId: 'permissions-1', signal: new AbortController().signal },
    { file_system: { write: ['/repo/out.txt'] } },
    'write the output',
  )
  assert.deepEqual(granted, { granted: true })
  assert.equal(asks, 1)
  assert.equal(provided.policyFor(agent, { mode: 'read-only', workspaceRoot: '/repo' }).mode, 'workspace-write')
  events.push({ type: 'turn/start', data: { turn: 2 }, seq: 2 })
  assert.equal(provided.policyFor(agent, { mode: 'read-only', workspaceRoot: '/repo' }).mode, 'read-only')

  const neverCtx = {
    provide: (_name, value) => { provided = value },
    on: () => () => {},
    inject: () => {},
    get: name => name === 'approval' ? { effectivePolicy: () => 'never', request: async () => { throw new Error('must not ask') } } : undefined,
  }
  applyCodexPermissions(neverCtx)
  const rejected = await provided.request(agent, { callId: 'permissions-2' }, { network: { enabled: true } }, 'network')
  assert.equal(rejected.granted, false)
  assert.match(rejected.reason, /approval policy is never/)
})

test('Codex environment and never approval text retain official machine-readable facts', () => {
  const unrestricted = filesystemElement({ mode: 'danger-full-access', workspaceRoot: '/repo' })
  assert.match(unrestricted, /<workspace_roots><root>\/repo<\/root><\/workspace_roots>/)
  assert.match(unrestricted, /permission_profile type="disabled"/)
  const managed = filesystemElement({ mode: 'workspace-write', workspaceRoot: '/repo' })
  assert.match(managed, /<entry access="write"><path>\/repo<\/path><\/entry>/)
  assert.match(permissionInstructions({ mode: 'danger-full-access' }, 'never'), /`sandbox_permissions`/)
})

test('V1 collaboration target checks do not scan a conflicting global session catalog', async () => {
  const parent = { session: { id: 'parent' } }
  const child = {
    session: {
      header: {
        id: 'child',
        parentSession: 'parent',
        origin: 'subagent',
        seedLength: 1,
      },
    },
  }
  let listed = false
  const ctx = {
    agents: { get: id => id === 'child' ? child : undefined },
    get: name => name === 'sessionProjections' ? {
      snapshot: () => ({ values: { subagent: { mode: 'continuable', label: 'task', seq: 1 } } }),
    } : undefined,
    subagents: {
      listChildren: async () => {
        listed = true
        throw new Error('global catalog must not be read')
      },
    },
  }
  const rows = await directChildren(ctx, parent, new AbortController().signal, ['child'])
  assert.deepEqual(rows.map(row => row.id), ['child'])
  assert.equal(listed, false)
})

test('V1 collaboration target checks point-read cold children', async () => {
  const parent = { session: { id: 'parent' } }
  let disposed = false
  const observation = {
    header: {
      id: 'cold-child',
      parentSession: 'parent',
      origin: 'subagent',
      seedLength: 1,
    },
    projections: { values: { subagent: { mode: 'continuable', label: 'cold task', seq: 1 } } },
    [Symbol.dispose]() { disposed = true },
  }
  let listed = false
  const ctx = {
    agents: { get: () => undefined },
    get: name => name === 'sessionQuery' ? {
      observeSession: async () => observation,
    } : undefined,
    subagents: {
      listChildren: async () => {
        listed = true
        throw new Error('global catalog must not be read')
      },
    },
  }
  const rows = await directChildren(ctx, parent, new AbortController().signal, ['cold-child'])
  assert.deepEqual(rows.map(row => row.id), ['cold-child'])
  assert.equal(rows[0].activity, 'inactive')
  assert.equal(disposed, true)
  assert.equal(listed, false)
})

test('V1 send_input matches Codex and sends immediately after spawn', async () => {
  const registrations = []
  const parent = { id: 'parent', session: { id: 'parent', header: { id: 'parent' } } }
  let followed
  const ctx = {
    on: () => undefined,
    tools: { register: tool => registrations.push(tool) },
    agents: { get: () => undefined },
    get: () => undefined,
    subagents: {
      list: () => [],
      listChildren: async () => { throw new Error('send_input must not scan the global catalog') },
      interrupt: () => undefined,
      followup: async (...args) => {
        followed = args
        return 'submission-id'
      },
    },
  }
  registerAgents(ctx)
  const tool = registrations.find(item => item.name === 'multi_agent_v1__send_input')
  assert.ok(tool)
  assert.equal(tool.parameters.properties.target.description, 'Agent id to message (from spawn_agent).')
  assert.equal(tool.parameters.properties.message.description, 'Legacy plain-text message to send to the agent. Use either message or items.')
  assert.equal(tool.parameters.properties.items.description, 'Structured input items. Use this to pass explicit mentions (for example app:// connector paths).')
  assert.equal(tool.parameters.properties.items.items.properties.path.description, 'Path when type is local_image/local_audio/skill, or structured mention target such as app://<connector-id> or plugin://<plugin-name>@<marketplace-name> when type is mention.')
  assert.equal(tool.parameters.properties.interrupt.description, 'True interrupts the current task and handles this message immediately; false or omitted queues it.')
  const waitTool = registrations.find(item => item.name === 'multi_agent_v1__wait_agent')
  assert.deepEqual(waitTool.output.render({}, { status: { 'a-b-c': 'not_found' }, timed_out: false }), [
    { type: 'text', text: '{"status":{"a-b-c":"not_found"},"timed_out":false}' },
  ])
  const result = await tool.execute(
    { target: 'child-id', message: 'continue the task' },
    { agent: parent, signal: new AbortController().signal },
  )
  assert.deepEqual(result, { submission_id: 'submission-id' })
  assert.equal(followed[0], parent)
  assert.equal(followed[1], 'child-id')
  assert.deepEqual(followed[2], [{ type: 'text', text: 'continue the task' }])
})

test('V1 lifecycle controls use an established child without a catalog race', async () => {
  const registrations = []
  const parent = { id: 'parent', session: { id: 'parent', header: { id: 'parent' } } }
  const child = {
    id: 'child-id',
    status: 'idle',
    session: { id: 'child-id', header: { id: 'child-id', parentSession: 'parent', origin: 'subagent' } },
  }
  let live = false
  let globalCatalogCalls = 0
  const ctx = {
    on: () => undefined,
    tools: { register: tool => registrations.push(tool) },
    agents: { get: id => live && id === 'child-id' ? child : undefined },
    get: () => undefined,
    subagents: {
      list: () => ['spawn'],
      listChildren: async () => {
        globalCatalogCalls += 1
        throw new Error('lifecycle controls must not scan the global catalog')
      },
      startContinuable: async () => {
        live = true
        return { childId: 'child-id' }
      },
      followup: async () => 'unused',
      interrupt: () => undefined,
    },
  }
  registerAgents(ctx)
  const tool = name => registrations.find(item => item.name === name)
  const execution = { agent: parent, signal: new AbortController().signal }
  await tool('multi_agent_v1__spawn_agent').execute({ message: 'task' }, execution)
  const waited = await tool('multi_agent_v1__wait_agent').execute({ targets: ['child-id'], timeout_ms: 1 }, execution)
  const closed = await tool('multi_agent_v1__close_agent').execute({ target: 'child-id' }, execution)
  const resumed = await tool('multi_agent_v1__resume_agent').execute({ id: 'child-id' }, execution)
  assert.deepEqual(waited, { status: { 'child-id': { completed: null } }, timed_out: false })
  assert.deepEqual(closed, { previous_status: { completed: null } })
  assert.deepEqual(resumed, { status: { completed: null } })
  assert.equal(globalCatalogCalls, 0)
})

test('search tool routing matches Responses Lite capability boundaries', () => {
  const luna = profileForModel('gpt-5.6-luna')
  const legacy = profileForModel('gpt-5.4')
  const unknown = profileForModel('codex-unknown-model')
  assert.equal(modelToolAllowed({}, luna, 'web__run', {}, true), true)
  assert.equal(modelToolAllowed({}, luna, 'web_search', {}, true), false)
  assert.equal(modelToolAllowed({}, legacy, 'web__run', {}, true), false)
  assert.equal(modelToolAllowed({}, legacy, 'web_search', {}, false), true)
  assert.equal(modelToolAllowed({}, unknown, 'web_search', {}, false), false)
})

test('model-owned token-budget messages follow remaining capacity and reset after compaction', () => {
  const session = { surface: { replaceGeneration: 0 } }
  const agent = { options: { model: 'gpt-5.6-luna' }, session }
  const meter = { measure: () => ({ totalTokens: 944_000 }) }
  const ctx = { get: name => name === 'tokenMeter' ? meter : undefined }
  const first = tokenBudgetContextText(ctx, agent)
  assert.match(first, /<context_window_guidance>/)
  assert.match(first, /only 1000 tokens remain/)
  assert.doesNotMatch(tokenBudgetContextText(ctx, agent), /only 1000 tokens remain/)
  session.surface.replaceGeneration = 1
  assert.match(tokenBudgetContextText(ctx, agent), /only 1000 tokens remain/)

  const exhausted = { options: { model: 'gpt-5.6-terra' }, session: { id: 'session-b', surface: { replaceGeneration: 0 } } }
  const exhaustedContext = tokenBudgetContextText(
    { get: () => ({ measure: () => ({ totalTokens: 945_000 }) }) },
    exhausted,
  )
  assert.match(exhaustedContext, /only 0 tokens remain/)
  assert.match(exhaustedContext, /current context window is exhausted/i)
})

test('Codex compaction stays automatic and leaves room for summary replay', () => {
  const compaction = agentComposition.match(/- id: compaction[\s\S]*?- id: command-compact/)?.[0] ?? ''
  assert.match(compaction, /thresholdRatio: 0\.8/)
  assert.match(compaction, /auto: true/)
  assert.doesNotMatch(compaction, /thresholdRatio: 0\.9/)
})

test('Codex model parity is mounted at the preset root for first-turn filtering', () => {
  assert.match(agentComposition, /# Read the pinned official model catalog[\s\S]*?- id: codex-model-parity\n  name: '\.\/codex-model-parity\.mjs'/)
  assert.doesNotMatch(agentComposition, /- id: codex-pty-surface[\s\S]*?\n    - id: codex-model-parity/)
})

test('Codex permission service shares the isolated realm with its consumer', () => {
  const ptySurface = agentComposition.match(/- id: codex-pty-surface[\s\S]*?(?=\n- id: codex-model-parity)/)?.[0] ?? ''
  assert.match(ptySurface, /isolate:\s+terminals: true\s+codexPermissions: true/)
  assert.match(ptySurface, /- id: codex-permissions\s+name: '\.\/codex-permissions\.mjs'/)
  assert.match(ptySurface, /- id: codex-surface\s+name: '\.\/codex-surface\.mjs'/)
})

test('official remaining-context tool is available only on token-budget routes', () => {
  const luna = profileForModel('gpt-5.6-luna')
  const legacy = profileForModel('gpt-5.4')
  const ctx = { get: name => name === 'tokenMeter' ? { measure: () => ({ totalTokens: 1_000 }) } : undefined }
  const agent = { options: { model: 'gpt-5.6-luna' }, session: {} }
  assert.equal(modelToolAllowed(ctx, luna, 'get_context_remaining', agent, false), false)
  assert.equal(modelToolAllowed(ctx, luna, 'get_context_remaining', agent, true), true)
  assert.equal(modelToolAllowed(ctx, legacy, 'get_context_remaining', agent, true), false)
  assert.equal(contextTokensRemaining(ctx, agent, luna), 944_000)
})

test('Terra and Sol retain their catalog-owned response preferences', () => {
  for (const model of ['gpt-5.6-terra', 'gpt-5.6-sol']) {
    const profile = profileForModel(model)
    assert.equal(profile.contextWindow, 1_050_000)
    assert.equal(profile.maxContextWindow, 1_050_000)
    assert.equal(profile.supportVerbosity, true)
    assert.equal(profile.defaultVerbosity, 'low')
    assert.equal(profile.tokenBudget.reminderThresholdTokens, 6144)
    const context = tokenBudgetContextText(
      { get: () => undefined },
      { options: { model }, session: {} },
    )
    assert.match(context, /Default response verbosity: low/)
    assert.match(context, /<context_window_guidance>/)
  }
})

test('model truncation policy caps unified-exec output budgets', () => {
  const bytesModel = { options: { model: 'gpt-5.2' }, session: {} }
  const tokenModel = { options: { model: 'gpt-5.4' }, session: {} }
  assert.equal(outputTokenBudget(bytesModel, undefined), 2500)
  assert.equal(outputTokenBudget(bytesModel, 50_000), 2500)
  assert.equal(outputTokenBudget(tokenModel, undefined), 10_000)
  assert.equal(outputTokenBudget(tokenModel, 50_000), 10_000)
})

test('model truncation policy bounds direct tool text without touching typed blocks', () => {
  const content = [
    { type: 'text', text: '你'.repeat(100) },
    { type: 'image', data: 'opaque' },
  ]
  const result = truncateToolContent(content, { mode: 'bytes', limit: 40 })
  assert.ok(Buffer.byteLength(result[0].text, 'utf8') <= 40)
  assert.match(result[0].text, /output truncated/)
  assert.deepEqual(result[1], content[1])
})

test('DirectModelOnly request_user_input stays out of the nested Code Mode SDK', () => {
  const luna = profileForModel('gpt-5.6-luna')
  assert.equal(modelToolAllowed({}, luna, 'request_user_input', {}, true), false)
})

test('official tool_mode names preserve the combined Code Mode surface', () => {
  assert.equal(normalizeToolMode('direct'), 'native')
  assert.equal(normalizeToolMode('code_mode'), 'both')
  assert.equal(normalizeToolMode('code_mode_only'), 'code_mode_only')
  assert.equal(normalizeToolMode('both'), 'both')
  assert.equal(normalizeToolMode('unknown'), 'native')
})

test('CodeModeOnly prompt states the direct-tool boundary while combined mode stays quiet', () => {
  assert.equal(rewriteCodeModeName('', false), '')
  assert.match(rewriteCodeModeName('', true), /`exec`, `wait`, `new_context`, and `request_permissions` are the only tools you can call directly/)
  assert.match(rewriteCodeModeName('`run_code` is the only tool you can call directly', true), /`exec`, `wait`/)
  assert.match(rewriteCodeModeName('', profileForModel('gpt-5.6-luna')), /`request_user_input`/)
  const lunaBoundary = rewriteCodeModeName('', profileForModel('gpt-5.6-luna'))
  assert.match(lunaBoundary, /multi_agent_v1__spawn_agent/)
  const terraBoundary = rewriteCodeModeName('', profileForModel('gpt-5.6-terra'))
  assert.match(terraBoundary, /`collaboration__spawn_agent`/)
  assert.match(terraBoundary, /`collaboration__wait_agent`/)
})

test('CodeModeOnly persona overrides conflicting direct-tool instructions', () => {
  const luna = profileForModel('gpt-5.6-luna')
  const instructions = modelInstructions(luna)
  assert.match(instructions, /<codex_code_mode_boundary>/)
  assert.match(instructions, /`exec`, `wait`, `new_context`/)
  assert.match(instructions, /`request_user_input`/)
  assert.match(instructions, /top-level tool call naming any other tool/i)
  assert.match(instructions, /await tools\.exec_command\(\.\.\.\)/)
  assert.match(instructions, /`skill` tool is not available/i)
  assert.equal(modelInstructions(profileForModel('gpt-5.4')), profileForModel('gpt-5.4').instructions)
})

test('V2 task names and statuses follow the canonical path/runtime boundaries', () => {
  assert.equal(validateV2TaskName('build_worker_2'), 'build_worker_2')
  assert.throws(() => validateV2TaskName('BuildWorker'), /lowercase letters/)
  assert.throws(() => validateV2TaskName('root'), /reserved/)
  const running = { status: 'running' }
  const idle = { status: 'idle' }
  const agents = new Map([['running', running], ['idle', idle]])
  const ctx = { agents: { get: id => agents.get(id) } }
  const settlements = new Map()
  assert.equal(v2Status(ctx, 'running', settlements, true), 'running')
  assert.deepEqual(v2Status(ctx, 'idle', settlements, true), { completed: null })
  assert.equal(v2Status(ctx, 'pending', settlements, true, { activity: 'running' }), 'pending_init')
  assert.equal(v2FinalMessageId({ source: { kind: 'subagent-report', senderSessionId: 'child' } }, new Set(['child'])), 'child')
})

test('V2 collaboration tools resolve task names, return canonical spawn paths, and list live agents', async () => {
  const registrations = []
  const parent = { id: 'root', status: 'running', session: { id: 'root', header: {} }, inbox: { nextStep: [], nextTurn: [] } }
  const child = {
    id: 'child-id',
    status: 'running',
    session: { id: 'child-id', header: { parentSession: 'root' } },
    inbox: { nextStep: [], nextTurn: [] },
    injected: [],
    inject(message) { this.injected.push(message) },
  }
  const agents = new Map([['root', parent], ['child-id', child]])
  const row = { kind: 'child', id: 'child-id', mode: 'continuable', label: 'child_task', activity: 'running', hasChildren: false, parentId: 'root', depth: 1 }
  let started
  let followed
  const ctx = {
    on: () => () => {},
    agents: { get: id => agents.get(id) },
    tools: { register: tool => registrations.push(tool) },
    subagents: {
      list: () => ['spawn', 'fork'],
      listChildren: async () => [row],
      listDescendants: async () => [row],
      startContinuable: async spec => { started = spec; return { childId: 'new-id' } },
      followup: async (...args) => { followed = args; return 'submission' },
      interrupt: () => {},
    },
  }
  registerV2Agents(ctx)
  const tool = name => registrations.find(item => item.name === name)
  assert.equal(tool('collaboration__spawn_agent').parameters.agent_type, undefined)
  assert.equal(tool('collaboration__spawn_agent').parameters.service_tier, undefined)
  const execution = { agent: parent, signal: new AbortController().signal, callId: 'v2-test' }
  const spawned = await tool('collaboration__spawn_agent').execute({ task_name: 'new_task', message: 'work', fork_turns: 'none' }, execution)
  assert.deepEqual(spawned, { task_name: '/root/new_task' })
  assert.equal(started.provider, 'spawn')
  assert.deepEqual(started.request.prompt, [{ type: 'text', text: 'work' }])
  const sent = await tool('collaboration__send_message').execute({ target: 'child_task', message: 'ping' }, execution)
  assert.equal(sent.submission_id.length > 0, true)
  assert.equal(child.injected[0].content[0].text, 'ping')
  await tool('collaboration__followup_task').execute({ target: '/root/child_task', message: 'continue' }, execution)
  assert.equal(followed[0], parent)
  assert.equal(followed[1], 'child-id')
  assert.deepEqual(followed[2], [{ type: 'text', text: 'continue' }])
  const listed = await tool('collaboration__list_agents').execute({}, execution)
  assert.deepEqual(listed.agents.map(agent => agent.agent_name), ['/root', '/root/child_task'])
  parent.inbox.nextStep.push({ id: 'report', source: { kind: 'subagent-report', senderSessionId: 'child-id' } })
  const waited = await tool('collaboration__wait_agent').execute({ timeout_ms: 0 }, execution)
  assert.equal(waited.timed_out, false)
  assert.match(waited.message, /clamped to the minimum of 10000ms/)
  await assert.rejects(tool('collaboration__wait_agent').execute({ timeout_ms: -1 }, execution), /non-negative number/)
})

test('V2 task reservations do not collide across independent root sessions', async () => {
  const registrations = []
  const parentA = { id: 'root-a', status: 'running', session: { id: 'root-a', header: {} }, inbox: { nextStep: [], nextTurn: [] } }
  const parentB = { id: 'root-b', status: 'running', session: { id: 'root-b', header: {} }, inbox: { nextStep: [], nextTurn: [] } }
  const agents = new Map([['root-a', parentA], ['root-b', parentB]])
  let release
  const gate = new Promise(resolve => { release = resolve })
  let firstStarted
  const firstStartedPromise = new Promise(resolve => { firstStarted = resolve })
  let starts = 0
  const ctx = {
    on: () => () => {},
    agents: { get: id => agents.get(id) },
    tools: { register: tool => registrations.push(tool) },
    subagents: {
      list: () => ['spawn', 'fork'],
      listDescendants: async () => [],
      startContinuable: async () => {
        starts++
        if (starts === 1) firstStarted()
        await gate
        return { childId: 'child-' + String(starts) }
      },
    },
  }
  registerV2Agents(ctx)
  const spawn = registrations.find(item => item.name === 'collaboration__spawn_agent')
  const first = spawn.execute({ task_name: 'same_task', message: 'work', fork_turns: 'none' }, { agent: parentA, signal: new AbortController().signal })
  await firstStartedPromise
  const second = spawn.execute({ task_name: 'same_task', message: 'work', fork_turns: 'none' }, { agent: parentB, signal: new AbortController().signal })
  await Promise.resolve()
  release()
  assert.deepEqual(await Promise.all([first, second]), [
    { task_name: '/root/same_task' },
    { task_name: '/root/same_task' },
  ])
})

function fakePatchContext(initial, hooks = {}) {
  const files = new Map(Object.entries(initial).map(([path, content]) => [path, { content, version: path + ':1' }]))
  const nextVersions = new Map()
  const target = path => ({ targetKey: path, displayPath: path })
  const versionFor = path => {
    const next = (nextVersions.get(path) ?? 1) + 1
    nextVersions.set(path, next)
    return path + ':' + String(next)
  }
  const ctx = {
    fs: {
      resolve: async path => target(path),
      stat: async resolved => {
        const file = files.get(resolved.targetKey)
        return file === undefined ? undefined : { type: 'file', version: file.version }
      },
      readText: async resolved => files.get(resolved.targetKey)?.content,
      processPath: resolved => resolved.targetKey,
      writeText: async (resolved, content, intent, signal) => {
        if (signal?.aborted) throw new Error('write received an aborted signal')
        const path = resolved.targetKey
        const current = files.get(path)
        if (intent?.kind === 'createIfAbsent' && current !== undefined) throw new Error('create guard failed')
        if (intent?.kind === 'replaceIfVersion' && (current === undefined || current.version !== intent.version)) {
          throw new Error('replace guard failed')
        }
        if (hooks.failWrite?.(path, content, signal) === true) throw new Error('injected write failure for ' + path)
        const version = versionFor(path)
        files.set(path, { content, version })
        return { operation: current === undefined ? 'create' : 'update', version, before: current?.content ?? null, after: content }
      },
      deleteFile: async (resolved, expected, signal) => {
        const path = resolved.targetKey
        if (hooks.failDelete?.(path, signal) === true) throw new Error('injected delete failure for ' + path)
        const current = files.get(path)
        if (current === undefined || (expected !== undefined && current.version !== expected.version)) throw new Error('delete guard failed')
        files.delete(path)
      },
    },
    sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access' }) },
    waterfall: async (name, target, actor, next) => {
      hooks.waterfall?.(name, target, actor)
      return next()
    },
    emit: (...args) => hooks.emit?.(...args),
  }
  return { ctx, files }
}

function patchExecution(signal = new AbortController().signal) {
  return { agent: { session: { header: { cwd: '/tmp' } } }, signal }
}

test('multi-file apply_patch rolls back completed files when a later write fails', async () => {
  const { ctx, files } = fakePatchContext({ 'first.txt': 'one\n', 'second.txt': 'two\n' }, {
    failWrite: path => path === 'second.txt',
  })
  const patch = [
    '*** Begin Patch',
    '*** Update File: first.txt',
    '@@',
    '-one',
    '+one changed',
    '*** Update File: second.txt',
    '@@',
    '-two',
    '+two changed',
    '*** End Patch',
  ].join('\n')
  await assert.rejects(applyPatch(ctx, patchExecution(), patch), /injected write failure for second.txt/)
  assert.equal(files.get('first.txt')?.content, 'one\n')
  assert.equal(files.get('second.txt')?.content, 'two\n')
})

test('apply_patch preserves prefixed control-looking context and rejects malformed update lines', async () => {
  const { ctx, files } = fakePatchContext({ 'markers.txt': 'start\n*** End of File\n@@ literal\nend\n' })
  const patch = [
    '*** Begin Patch',
    '*** Update File: markers.txt',
    '@@',
    ' start',
    ' *** End of File',
    '-@@ literal',
    '+@@ changed',
    ' end',
    '*** End Patch',
  ].join('\n')
  await applyPatch(ctx, patchExecution(), patch)
  assert.equal(files.get('markers.txt')?.content, 'start\n*** End of File\n@@ changed\nend\n')

  const malformed = [
    '*** Begin Patch',
    '*** Update File: markers.txt',
    '@@',
    ' start',
    'malformed context without a diff prefix',
    '+replacement',
    '*** End Patch',
  ].join('\n')
  await assert.rejects(applyPatch(ctx, patchExecution(), malformed), /invalid apply_patch hunk/)

  const malformedEof = [
    '*** Begin Patch',
    '*** Update File: markers.txt',
    '@@',
    '+tail',
    '*** End of File',
    '+not allowed after EOF',
    '*** End Patch',
  ].join('\n')
  await assert.rejects(applyPatch(ctx, patchExecution(), malformedEof), /after an end-of-file marker/)
})

test('apply_patch records a write before a throwing observation and rolls back with a detached actor', async () => {
  const controller = new AbortController()
  const waterfallSignals = []
  let throwOnce = true
  const { ctx, files } = fakePatchContext({ 'observed.txt': 'before\n' }, {
    waterfall: (_name, _target, actor) => {
      waterfallSignals.push(actor.signal)
      if (actor.signal?.aborted) throw new Error('rollback received aborted signal')
    },
    emit: (_name, target, state) => {
      if (target.targetKey === 'observed.txt' && state.kind === 'present' && state.version === 'observed.txt:2' && throwOnce) {
        throwOnce = false
        controller.abort(new Error('cancelled after write'))
        throw new Error('observation listener failed')
      }
    },
  })
  const patch = [
    '*** Begin Patch',
    '*** Update File: observed.txt',
    '@@',
    '-before',
    '+after',
    '*** End Patch',
  ].join('\n')
  await assert.rejects(applyPatch(ctx, patchExecution(controller.signal), patch), /observation listener failed/)
  assert.equal(files.get('observed.txt')?.content, 'before\n')
  assert.ok(waterfallSignals.some(signal => signal instanceof AbortSignal && signal.aborted === false))
})

test('apply_patch handles CRLF, trailing blank lines, standard hunk context, and repeated operations', async () => {
  const crlf = fakePatchContext({
    'crlf.txt': 'one\r\ntwo\r\nthree\r\n',
    'trailing.txt': 'a\r\n\r\n',
    'functions.txt': 'function first\nold\nfunction second\nold\n',
  })
  await applyPatch(crlf.ctx, patchExecution(), [
    '*** Begin Patch',
    '*** Update File: crlf.txt',
    '@@',
    '-one',
    '+uno',
    '@@',
    ' two',
    '+between',
    ' three',
    '*** Update File: trailing.txt',
    '@@',
    '+new',
    '*** Update File: functions.txt',
    '@@ -3,1 +3,1 @@ function second',
    '-old',
    '+new',
    '*** End Patch',
  ].join('\n'))
  assert.equal(crlf.files.get('crlf.txt')?.content, 'uno\r\ntwo\r\nbetween\r\nthree\r\n')
  assert.equal(crlf.files.get('trailing.txt')?.content, 'a\r\n\r\nnew\r\n')
  assert.equal(crlf.files.get('functions.txt')?.content, 'function first\nold\nfunction second\nnew\n')
})

test('apply_patch guards and restores moves with an existing destination', async () => {
  const state = fakePatchContext({ 'source.txt': 'source\n', 'destination.txt': 'destination\n' })
  const patch = [
    '*** Begin Patch',
    '*** Update File: source.txt',
    '*** Move to: destination.txt',
    '@@',
    '-source',
    '+moved',
    '*** Update File: destination.txt',
    '@@',
    '-moved',
    '+updated',
    '*** End Patch',
  ].join('\n')
  await applyPatch(state.ctx, patchExecution(), patch)
  assert.equal(state.files.has('source.txt'), false)
  assert.equal(state.files.get('destination.txt')?.content, 'updated\n')
})

test('apply_patch rejects duplicate target mutations before writing', async () => {
  const state = fakePatchContext({}, { failWrite: path => path === 'moved.txt' })
  const patch = [
    '*** Begin Patch',
    '*** Add File: same.txt',
    '+old',
    '*** Update File: same.txt',
    '@@',
    '-old',
    '+new',
    '*** Update File: same.txt',
    '*** Move to: moved.txt',
    '@@',
    '-new',
    '+final',
    '*** End Patch',
  ].join('\n')
  await assert.rejects(applyPatch(state.ctx, patchExecution(), patch), /multiple operations target same.txt/)
  assert.equal(state.files.has('same.txt'), false)
  assert.equal(state.files.has('moved.txt'), false)
})

test('apply_patch preserves virtual destination history while rolling back a later move', async () => {
  const state = fakePatchContext({ 'source.txt': 'source\n', 'third.txt': 'third\n' }, {
    failWrite: path => path === 'third.txt',
  })
  const patch = [
    '*** Begin Patch',
    '*** Add File: destination.txt',
    '+base',
    '*** Update File: source.txt',
    '*** Move to: destination.txt',
    '@@',
    '-source',
    '+moved',
    '*** Update File: third.txt',
    '@@',
    '-third',
    '+changed',
    '*** End Patch',
  ].join('\n')
  await assert.rejects(applyPatch(state.ctx, patchExecution(), patch), /injected write failure for third.txt/)
  assert.equal(state.files.get('source.txt')?.content, 'source\n')
  assert.equal(state.files.has('destination.txt'), false)
})

test('cancelled move rolls back the published destination without the aborted signal', async () => {
  const controller = new AbortController()
  const deleteSignals = []
  const { ctx, files } = fakePatchContext({ 'source.txt': 'source\n' }, {
    failDelete: (path, signal) => {
      deleteSignals.push([path, signal])
      if (path !== 'source.txt') return false
      controller.abort(new Error('cancelled'))
      return true
    },
  })
  const patch = [
    '*** Begin Patch',
    '*** Update File: source.txt',
    '*** Move to: destination.txt',
    '@@',
    '-source',
    '+moved',
    '*** End Patch',
  ].join('\n')
  await assert.rejects(applyPatch(ctx, patchExecution(controller.signal), patch), /injected delete failure for source.txt/)
  assert.equal(files.get('source.txt')?.content, 'source\n')
  assert.equal(files.has('destination.txt'), false)
  assert.equal(deleteSignals.at(-1)?.[0], 'destination.txt')
  assert.equal(deleteSignals.at(-1)?.[1], undefined)
})

test('V2 mailbox wait resolves on a child report and ignores parent-to-child insertion', async () => {
  const listeners = new Map()
  const ctx = {
    on(name, listener) {
      listeners.set(name, listener)
      return () => listeners.delete(name)
    },
  }
  const parent = { inbox: { nextStep: [], nextTurn: [] } }
  parent.id = 'parent'
  const child = { id: 'child', inbox: { hasPending: false } }
  const pending = waitForV2MailboxUpdate(ctx, parent, [child], new Set(['child']), 60_000, new AbortController().signal)
  listeners.get('agent/inbox/inserted')({ agent: child, message: { source: { senderSessionId: 'parent' } } })
  listeners.get('agent/inbox/inserted')({
    agent: parent,
    message: { source: { kind: 'subagent-report', senderSessionId: 'child' }, id: 'report' },
  })
  assert.deepEqual(await pending, { kind: 'mailbox', id: 'child' })
  assert.equal(listeners.size, 0)
})

test('V2 mailbox wait reports parent steering separately from child mailbox activity', async () => {
  const listeners = new Map()
  const ctx = {
    on(name, listener) {
      listeners.set(name, listener)
      return () => listeners.delete(name)
    },
  }
  const parent = { id: 'parent', inbox: { nextStep: [], nextTurn: [] } }
  const child = { id: 'child', inbox: { hasPending: false } }
  const controller = new AbortController()
  const pending = waitForV2MailboxUpdate(ctx, parent, [child], new Set(['child']), 60_000, controller.signal)
  const message = { id: 'user-steer', source: { kind: 'user' } }
  parent.inbox.nextStep.push(message)
  listeners.get('agent/inbox/inserted')({ agent: parent, message })
  assert.deepEqual(await pending, { kind: 'steered' })
  assert.equal(listeners.size, 0)
})

test('web response helpers normalize JSON strings, arrays, and SSE output items', () => {
  const json = parseResponseEnvelope(JSON.stringify({
    output: 'json answer',
    results: [{ url: 'https://example.com/source', title: 'Source' }],
  }))
  assert.equal(json.answer, 'json answer')
  assert.equal(json.sources.length, 1)
  const mergedSources = parseResponseEnvelope(JSON.stringify({
    output: 'answer',
    results: [{ url: 'https://example.com/results' }],
    sources: [{ url: 'https://example.com/sources' }],
    citations: [{ url: 'https://example.com/citations' }],
  }))
  assert.deepEqual(mergedSources.sources.map(source => source.url), [
    'https://example.com/results',
    'https://example.com/sources',
    'https://example.com/citations',
  ])
  const array = parseResponseBody(JSON.stringify([{ type: 'message', content: [{ text: 'array answer' }] }]))
  assert.equal(array.length, 1)
  const sse = [
    'data: ' + JSON.stringify({ type: 'response.output_text.delta', delta: 'sse answer' }),
    'data: ' + JSON.stringify({ type: 'response.done', response: { output: [] } }),
  ].join(String.fromCharCode(10))
  assert.equal(parseResponseEnvelope(sse).answer, 'sse answer')
  assert.throws(() => searchCommands({ search_query: [{ q: '1' }, { q: '2' }, { q: '3' }, { q: '4' }, { q: '5' }] }), /at most four/)
})

test('Codex web-search fallback mirrors the hosted DSH result shape', async () => {
  const registrations = []
  const sections = []
  const calls = []
  const web = {
    search: async ({ query, maxResults }, signal) => {
      signal.throwIfAborted()
      calls.push({ query, maxResults })
      return {
        content: 'Answer for ' + query,
        sources: [
          { url: 'https://example.com/' + query, title: query, snippet: 'snippet', publishedAt: '2026-08-29' },
          { url: 'https://example.com/shared', title: 'Shared' },
        ],
        truncated: false,
      }
    },
  }
  const ctx = {
    get: name => name === 'web' ? web : undefined,
    systemPrompt: { section: section => { sections.push(section) } },
    tools: {
      get: () => undefined,
      register: tool => registrations.push(tool),
    },
  }
  applyCodexWebSearch(ctx)
  const tool = registrations.find(item => item.name === 'web_search')
  assert.ok(tool)
  const result = await tool.execute({ queries: ['first', 'second'] }, { signal: new AbortController().signal })
  assert.deepEqual(calls, [
    { query: 'first', maxResults: 8 },
    { query: 'second', maxResults: 8 },
  ])
  assert.deepEqual(result.sources.map(source => source.url), [
    'https://example.com/first',
    'https://example.com/second',
    'https://example.com/shared',
  ])
  assert.match(tool.output.render({}, result)[0].text, /Cite the relevant URLs above/)
  assert.equal(sections.some(section => section.name === 'tool:web_search'), true)
})

test('V1 collaboration input accepts text items and rejects unsupported rich items', () => {
  assert.deepEqual(collabInputContent(undefined, [{ type: 'text', text: 'structured task' }]), [{ type: 'text', text: 'structured task' }])
  assert.throws(() => collabInputContent('message', [{ type: 'text', text: 'item' }]), /either message or items/)
  assert.throws(() => collabInputContent(undefined, [{ type: 'image', image_url: 'https://example.com/a.png' }]), /only text items/)
})

test('V1 collaboration converts base64 image items into durable image blocks', async () => {
  const saved = []
  const ctx = {
    get: name => name === 'attachments' ? {
      imageLimits: { maxImageBytes: 1024, maxMessageImageBytes: 1024 },
      saveImage: async input => { saved.push(input); return { attachmentId: 'a1', mediaType: input.mediaType, bytes: input.data.length, width: 1, height: 1 } },
    } : undefined,
  }
  const agent = { session: { header: { cwd: '/tmp' } } }
  const content = await collabPromptContent(ctx, agent, undefined, [{ type: 'image', image_url: 'data:image/png;base64,aGVsbG8=' }], new AbortController().signal)
  assert.equal(content[0].type, 'image')
  assert.equal(content[0].attachment.attachmentId, 'a1')
  assert.equal(saved[0].mediaType, 'image/png')
})

test('web request cleans timer and abort listener when request.end throws synchronously', async () => {
  let added = 0
  let removed = 0
  let destroyed = false
  const signal = {
    aborted: false,
    addEventListener: () => { added++ },
    removeEventListener: () => { removed++ },
  }
  const requestFactory = (_url, _options, _onResponse) => ({
    on: () => {},
    end: () => { throw new Error('synchronous end failure') },
    destroy: () => { destroyed = true },
  })
  await assert.rejects(requestCodexSearchForTest('{}', {}, signal, requestFactory), /synchronous end failure/)
  assert.equal(added, 1)
  assert.equal(removed, 1)
  assert.equal(destroyed, true)
})

test('web request retries transient socket resets with a bounded fresh POST', async () => {
  let attempts = 0
  const optionsSeen = []
  const requestFactory = (_url, options, onResponse) => {
    attempts++
    optionsSeen.push(options)
    if (attempts === 1) {
      const requestHandlers = new Map()
      const request = {
        on(name, listener) { requestHandlers.set(name, listener); return request },
        end() {
          const error = new Error('socket hang up')
          error.code = 'ECONNRESET'
          queueMicrotask(() => requestHandlers.get('error')?.(error))
        },
        destroy() {},
      }
      return request
    }
    const requestHandlers = new Map()
    const response = {
      statusCode: 200,
      on(name, listener) {
        if (name === 'data') queueMicrotask(() => listener(Buffer.from('{}')))
        if (name === 'end') queueMicrotask(() => listener())
        return response
      },
    }
    const request = {
      on(name, listener) { requestHandlers.set(name, listener); return request },
      end() { queueMicrotask(() => onResponse(response)) },
      destroy() {},
    }
    return request
  }
  const body = JSON.stringify({ query: 'transient reset' })
  const result = await requestCodexSearchForTest(body, { Authorization: 'Bearer test' }, new AbortController().signal, requestFactory)
  assert.equal(result.statusCode, 200)
  assert.equal(attempts, 2)
  assert.equal(optionsSeen[1].agent, false)
  assert.equal(optionsSeen[1].headers['Content-Length'], Buffer.byteLength(body))
  assert.equal(optionsSeen[1].headers.Connection, 'close')
})

test('web request retries transient 5xx responses but leaves 4xx responses to the caller', async () => {
  let attempts = 0
  const requestFactory = (_url, _options, onResponse) => {
    attempts++
    const statusCode = attempts === 1 ? 503 : 200
    const response = {
      statusCode,
      on(name, listener) {
        if (name === 'data') queueMicrotask(() => listener(Buffer.from('{}')))
        if (name === 'end') queueMicrotask(() => listener())
        return response
      },
    }
    return {
      on: () => {},
      end: () => queueMicrotask(() => onResponse(response)),
      destroy: () => {},
    }
  }
  const result = await requestCodexSearchForTest('{}', {}, new AbortController().signal, requestFactory)
  assert.equal(result.statusCode, 200)
  assert.equal(attempts, 2)
  let clientAttempts = 0
  const clientError = await requestCodexSearchForTest('{}', {}, new AbortController().signal, (_url, _options, onResponse) => {
    clientAttempts++
    const response = {
      statusCode: 401,
      on(name, listener) {
        if (name === 'data') queueMicrotask(() => listener(Buffer.from('unauthorized')))
        if (name === 'end') queueMicrotask(() => listener())
        return response
      },
    }
    return { on: () => {}, end: () => queueMicrotask(() => onResponse(response)), destroy: () => {} }
  })
  assert.equal(clientError.statusCode, 401)
  assert.equal(clientAttempts, 1)
})
