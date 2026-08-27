import assert from 'node:assert/strict'
import test from 'node:test'

import {
  codeModePreview,
  codeModeSyntaxValid,
  directPatchContent,
  modelToolAllowed,
  normalizeCodeModeSource,
  normalizeToolMode,
  patchWebSearchSchema,
  profileForModel,
  registerCodeModeAlias,
  registerV2Agents,
  v2FinalMessageId,
  v2Status,
  validateV2TaskName,
  waitForV2MailboxUpdate,
} from './codex-model-parity.mjs'
import { approvalReason, apply as applyApproval, patchApprovalPreview } from './codex-approval.mjs'
import {
  applyPatch,
  collabInputContent,
  outputFromOperation,
  parsePatchOperations,
  preflightPatch,
  pipeOutput,
  terminalOutputText,
  waitForTerminalOperation,
} from './codex-surface.mjs'
import { parseResponseBody, parseResponseEnvelope, requestCodexSearchForTest, searchCommands } from './codex-web-search.mjs'

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

test('apply_patch rejects empty before stat and supports ordered same-target operations', async () => {
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
  const sequential = [
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
  const sequentialState = fakePatchContext({})
  await applyPatch(sequentialState.ctx, exec, sequential)
  assert.equal(sequentialState.files.has('same.txt'), false)
  assert.equal(sequentialState.files.get('moved.txt')?.content, 'final\n')
})

test('legacy shell catalog rows retain unified exec and text-only web schemas are narrowed', () => {
  const daybreak = profileForModel('gpt-daybreak-blue-latest')
  assert.equal(daybreak.shellType, 'unified_exec')
  assert.equal(modelToolAllowed({}, daybreak, 'exec_command', {}, true), true)
  const spark = profileForModel('gpt-5.3-codex-spark')
  const schema = {
    name: 'web__run',
    parameters: { properties: { search_query: {}, image_query: {} } },
  }
  const narrowed = patchWebSearchSchema(schema, spark)
  assert.equal(narrowed.parameters.properties.image_query, undefined)
  assert.notEqual(schema.parameters.properties.image_query, undefined)
})

test('Codex local skill policy keeps the skill loader visible for hosted Code Mode rows', () => {
  const luna = profileForModel('gpt-5.6-luna')
  assert.equal(luna.includeSkillsUsageInstructions, true)
  assert.equal(modelToolAllowed({}, luna, 'skill', {}, true), true)
})

test('official tool_mode names preserve the combined Code Mode surface', () => {
  assert.equal(normalizeToolMode('direct'), 'native')
  assert.equal(normalizeToolMode('code_mode'), 'both')
  assert.equal(normalizeToolMode('code_mode_only'), 'code_mode_only')
  assert.equal(normalizeToolMode('both'), 'both')
  assert.equal(normalizeToolMode('unknown'), 'native')
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
  const execution = { agent: parent, signal: new AbortController().signal, callId: 'v2-test' }
  const spawned = await tool('spawn_agent').execute({ task_name: 'new_task', message: 'work', fork_turns: 'none' }, execution)
  assert.deepEqual(spawned, { task_name: '/root/new_task' })
  assert.equal(started.provider, 'spawn')
  assert.deepEqual(started.request.prompt, [{ type: 'text', text: 'work' }])
  const sent = await tool('send_message').execute({ target: 'child_task', message: 'ping' }, execution)
  assert.equal(sent.submission_id.length > 0, true)
  assert.equal(child.injected[0].content[0].text, 'ping')
  await tool('followup_task').execute({ target: '/root/child_task', message: 'continue' }, execution)
  assert.equal(followed[0], parent)
  assert.equal(followed[1], 'child-id')
  assert.deepEqual(followed[2], [{ type: 'text', text: 'continue' }])
  const listed = await tool('list_agents').execute({}, execution)
  assert.deepEqual(listed.agents.map(agent => agent.agent_name), ['/root', '/root/child_task'])
  const waited = await tool('wait_agent').execute({ timeout_ms: 0 }, execution)
  assert.deepEqual(waited, { message: 'Wait timed out.', timed_out: true })
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

test('apply_patch rolls back ordered mutations on one path with their latest versions', async () => {
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
  await assert.rejects(applyPatch(state.ctx, patchExecution(), patch), /injected write failure for moved.txt/)
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
  const array = parseResponseBody(JSON.stringify([{ type: 'message', content: [{ text: 'array answer' }] }]))
  assert.equal(array.length, 1)
  const sse = [
    'data: ' + JSON.stringify({ type: 'response.output_text.delta', delta: 'sse answer' }),
    'data: ' + JSON.stringify({ type: 'response.done', response: { output: [] } }),
  ].join(String.fromCharCode(10))
  assert.equal(parseResponseEnvelope(sse).answer, 'sse answer')
  assert.throws(() => searchCommands({ search_query: [{ q: '1' }, { q: '2' }, { q: '3' }, { q: '4' }, { q: '5' }] }), /at most four/)
})

test('V1 collaboration input accepts text items and rejects unsupported rich items', () => {
  assert.deepEqual(collabInputContent(undefined, [{ type: 'text', text: 'structured task' }]), [{ type: 'text', text: 'structured task' }])
  assert.throws(() => collabInputContent('message', [{ type: 'text', text: 'item' }]), /either message or items/)
  assert.throws(() => collabInputContent(undefined, [{ type: 'image', image_url: 'https://example.com/a.png' }]), /only text items/)
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
