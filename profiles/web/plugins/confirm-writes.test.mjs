import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from './confirm-writes.mjs'

function harness() {
  const handlers = new Map()
  let preset = 'confirm'
  let broken = false
  apply({
    on: (event, handler) => handlers.set(event, handler),
    permissionPresets: {
      current: () => {
        if (broken) throw new Error('permission state unavailable')
        return preset
      },
    },
  })
  const agent = { session: { id: 'test-session' } }
  const execute = (name, withAgent = true) => handlers.get('tools/pre-execute')(
    { name, ...(withAgent ? { agent } : {}) },
    async () => ({ kind: 'allow' }),
  )
  return { execute, setPreset: value => { preset = value }, breakLookup: () => { broken = true } }
}

test('confirm asks for writes/commands but not reads', async () => {
  const { execute } = harness()
  for (const name of ['write', 'edit', 'str_replace_editor', 'bash', 'pwsh', 'terminal_send']) {
    assert.equal((await execute(name)).kind, 'ask', name)
  }
  for (const name of ['read', 'read_image', 'fs_search']) {
    assert.equal((await execute(name)).kind, 'allow', name)
  }
})

test('stock permission presets retain upstream behavior', async () => {
  const { execute, setPreset } = harness()
  for (const preset of ['read-only', 'workspace-write', 'danger-full-access']) {
    setPreset(preset)
    assert.equal((await execute('write')).kind, 'allow', preset)
  }
})

test('missing agent or broken permission lookup never silently permits writes', async () => {
  const { execute, breakLookup } = harness()
  assert.equal((await execute('write', false)).kind, 'ask')
  breakLookup()
  assert.equal((await execute('bash')).kind, 'ask')
  assert.equal((await execute('read')).kind, 'allow')
})
