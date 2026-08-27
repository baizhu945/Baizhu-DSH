import assert from 'node:assert/strict'
import test from 'node:test'

import {
  codeModePreview,
  codeModeSyntaxValid,
  directPatchContent,
  normalizeCodeModeSource,
  registerCodeModeAlias,
} from './codex-model-parity.mjs'
import { approvalReason, apply as applyApproval, patchApprovalPreview } from './codex-approval.mjs'

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
