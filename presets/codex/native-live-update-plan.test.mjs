import assert from 'node:assert/strict'
import test from 'node:test'
import { mockResponses, fixture } from './codex-native-models-support.mjs'

// Real compiled native core, authless loopback Responses only. Proves the
// upstream default and the documented opt-in exposure of update_plan: it is a
// NESTED CodeMode tool listed in the `exec` description, never a top-level
// function or namespace entry.
const flatten = body => {
  const declared = [...(body.tools ?? []), ...(body.input ?? [])
    .filter(item => item.type === 'additional_tools').flatMap(item => item.tools ?? [])]
  return declared.flatMap(tool => tool.type === 'namespace' ? [tool, ...tool.tools] : [tool])
}

test('update_plan stays absent by default and is documented as a nested exec tool when officially enabled',
  { timeout: 40_000, concurrency: false }, async t => {
    const capture = async overrides => {
      const mock = await mockResponses(t)
      const f = await fixture(t, mock, 'gpt-6-luna', overrides)
      await f.collect('Reply with the local fixture completion marker. Do not use tools.')
      const tools = flatten(mock.requests[0].body)
      const exec = tools.find(tool => tool.name === 'exec')
      assert.ok(exec, 'CodeMode exec must exist for a nested-tool assertion')
      return { names: tools.map(tool => tool.name), namespaces: tools.filter(t => t.type === 'namespace').map(t => t.name),
        description: exec.description ?? '' }
    }
    const defaults = await capture({})
    assert.ok(!defaults.names.includes('update_plan'), 'default must not invent a top-level update_plan')
    assert.ok(!defaults.description.includes('update_plan'), 'upstream default keeps update_plan disabled')
    const enabled = await capture({ 'tools.update_plan.enabled': true })
    assert.ok(!enabled.names.includes('update_plan'), 'update_plan must stay nested, never top-level')
    assert.ok(!enabled.namespaces.includes('update_plan'), 'update_plan must not become its own namespace')
    assert.ok(enabled.description.includes('update_plan'), 'opt-in config must document the nested update_plan call')
    assert.match(enabled.description, /in_progress/, 'the documented schema must include official step statuses')
    assert.ok(enabled.description.length > defaults.description.length)
  })