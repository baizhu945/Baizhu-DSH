import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const startup = readFileSync(new URL('./cc-connect-startup.mjs', import.meta.url), 'utf8')
const runner = readFileSync(new URL('./cc-connect-runner.mjs', import.meta.url), 'utf8')
const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
const readme = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8')

const escapeRegExp = value => value.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')

// This is deliberately a source contract test. The runner imports dsh's
// installed dependency tree, so it cannot be loaded from this configuration
// repository without a built profile. The actual cc-connect adapter tests
// exercise the other side with a fake dsh process.
test('cc-connect startup keeps the adapter invocation flags', () => {
  const expected = [
    '--session-id <id>',
    '--provider <provider>',
    '--model <model>',
    '--reasoning-effort <effort>',
    '--mode <mode>',
    '--preset <name>',
    '--list-models',
    '--jsonl',
  ]
  for (const option of expected) {
    assert.match(startup, new RegExp(`\\.option\\('${escapeRegExp(option)}'`), option)
  }
  for (const field of ['sessionId', 'provider', 'model', 'reasoningEffort', 'mode', 'preset', 'listModels', 'jsonl']) {
    assert.match(startup, new RegExp(`opts\\.${field}\\b`), `startup does not publish ${field}`)
  }
})

test('cc-connect runner emits every JSONL envelope consumed by the adapter', () => {
  const envelopes = ['models', 'text', 'thinking', 'tool/call', 'tool/result', 'approval/request', 'result', 'done']
  for (const type of envelopes) {
    assert.match(runner, new RegExp(`type: '${type.replace('/', '\\/')}'`), `missing ${type} envelope`)
  }
  for (const field of ['callId', 'name', 'arguments', 'content', 'isError', 'toolName', 'reason', 'sessionId', 'success']) {
    assert.match(runner, new RegExp(`\\b${field}:`), `missing ${field} field`)
  }
  assert.match(runner, /msg\?\.type !== 'approval\/response'/)
  assert.match(runner, /msg\.outcome === 'allowed-once'/)
})

test('headless patch mounts the custom startup and runner together', () => {
  assert.match(patch, /- id: headless-startup\n  disabled: true/)
  assert.match(patch, /- id: headless-runner\n  disabled: true/)
  assert.match(patch, /- id: cc-connect-startup\n      name: '\.\/plugins\/cc-connect-startup\.mjs'/)
  assert.match(patch, /- id: cc-connect-runner\n      name: '\.\/plugins\/cc-connect-runner\.mjs'/)
  assert.match(patch, /inject: \[ccConnectStartup\]/)
})

test('README documents the private JSONL wire and its migration boundary', () => {
  for (const type of ['models', 'text', 'thinking', 'tool/call', 'tool/result', 'approval/request', 'result', 'done']) {
    assert.match(readme, new RegExp(type.replace('/', '\\/')), `README omits ${type}`)
  }
  assert.match(readme, /自定义 `--jsonl`/)
  assert.match(readme, /官方 `--json`/)
  assert.match(readme, /approval\/response/)
})
