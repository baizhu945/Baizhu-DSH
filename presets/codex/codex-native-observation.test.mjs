import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { createNativeObserver } from './codex-native-observation.mjs'
import { nativeToolArguments, nativeToolName, nativeResultContent } from './codex-native-presentation.mjs'

const line = payload => JSON.stringify({ timestamp: '2026-10-03T00:00:00Z', type: 'response_item', payload }) + '\n'
const custom = (call_id, name, input) => ({ type: 'custom_tool_call', call_id, name, input })
const call = (call_id, name, args, namespace) => ({ type: 'function_call', call_id, name, arguments: JSON.stringify(args), ...(namespace ? { namespace } : {}) })
const result = (call_id, output, extra = {}) => ({ type: 'custom_tool_call_output', call_id, output, ...extra })
const envelope = (body = '', status = 'Script completed') => `${status}\nWall time 0.123 seconds (code-mode 0.100 seconds; overhead 0.023 seconds)\nOutput:\n${body}`
const text = text => ({ type: 'input_text', text })
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=='
async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-native-observation-'))
  t.after(() => fs.rm(base, { recursive: true, force: true }))
  const nativeHome = path.join(base, 'native-home')
  const directory = path.join(nativeHome, 'sessions', '2026', '10', '03')
  await fs.mkdir(directory, { recursive: true })
  const rolloutPath = path.join(directory, 'rollout-test.jsonl')
  const observer = createNativeObserver({ nativeHome, rolloutPath })
  return { base, nativeHome, rolloutPath, observer,
    append: (...items) => fs.appendFile(rolloutPath, items.map(line).join('')) }
}

test('exec pairs preserve canonical script, UI alias and stable callId; never write native history', async t => {
  const f = await fixture(t)
  const script = 'text("真实输出 🐾");\n// Wall time: literal code\nconst x = `a\\nb`;'
  await f.append(custom('real-call-id', 'exec', script), result('real-call-id', [text(envelope('真实输出 🐾'))]))
  const before = await fs.readFile(f.rolloutPath)
  const items = await f.observer.read()
  assert.equal(items.length, 2)
  const [pending, final] = items
  assert.equal(pending.type, 'codeExecution')
  assert.equal(pending.code, script)
  assert.equal(nativeToolArguments(pending).input, script)
  assert.equal(nativeToolName(pending), 'exec')
  assert.equal(pending.completed, false)
  assert.equal(pending.status, 'inProgress')
  assert.equal(final.completed, true)
  assert.equal(final.status, 'completed')
  assert.equal(final.callId, 'real-call-id')
  assert.equal(final.id, pending.id)
  assert.ok(final.output.includes('真实输出 🐾'))
  assert.ok(!final.output.includes('Wall time'))
  assert.ok(nativeResultContent(final)[0].text.includes('真实输出 🐾'))
  assert.deepEqual(await f.observer.read(), [])
  assert.deepEqual(await fs.readFile(f.rolloutPath), before)
  // Mutating a human snapshot cannot alter pending observer state or native data.
  pending.code = 'MUTATED_UI_ONLY'
  assert.equal(final.code, script)
})

test('function exec parses input without reformating; wait, clock and helpers retain raw names and readable arguments', async t => {
  const f = await fixture(t)
  const script = '\ntext(`exact\\nscript`);\n'
  await f.append(call('exec-json', 'functions.exec', { input: script }), result('exec-json', envelope('ok')),
    call('wait', 'wait', { cell_id: '12', yield_time_ms: 1000 }),
    { ...result('wait', 'Wall time: 0.0010 seconds\nOutput: wait result'), type: 'function_call_output' },
    call('clock', 'clock', {}), { ...result('clock', { now: '2026-10-03', precision: 7 }), type: 'function_call_output' },
    custom('helper', 'load', 'integration-key'), result('helper', 'HELPER_REAL_OUTPUT'))
  const items = await f.observer.read()
  assert.equal(nativeToolArguments(items[0]).input, script)
  assert.equal(nativeToolName(items[0]), 'exec')
  assert.deepEqual(items.filter(item => !item.completed).map(nativeToolName), ['exec', 'wait', 'clock', 'load'])
  assert.equal(items[3].output, 'wait result')
  assert.equal(items[5].output, 'Now: 2026-10-03\nPrecision: 7')
  assert.equal(items[6].input, 'integration-key')
  assert.equal(items[7].output, 'HELPER_REAL_OUTPUT')
})

test('known ThreadItem tools including collab wait are excluded, never emit duplicate human results', async t => {
  const f = await fixture(t)
  const excluded = ['exec_command', 'write_stdin', 'apply_patch', 'view_image', 'web_search', 'webSearch',
    'spawn_agent', 'send_input', 'resume_agent', 'close_agent', 'update_plan', 'sleep', 'mcp__server__tool']
  for (const name of excluded) await f.append(call(name, name, { cmd: 'MUST_NOT_EXECUTE' }), result(name, 'excluded'))
  await f.append(call('web', 'run', { search_query: [] }, 'web'), result('web', 'excluded'),
    call('collab', 'wait', { ids: ['thread-a'], timeout_ms: 1000 }), result('collab', 'excluded'),
    call('cell', 'wait', { cell_id: '1' }), result('cell', envelope('CELL_ONLY')),
    call('cell', 'wait', { cell_id: '1' }), result('cell', envelope('DUPLICATE')))
  const items = await f.observer.read()
  assert.equal(items.length, 2)
  assert.ok(items.every(item => item.callId === 'cell'))
  assert.ok(items[1].output.includes('CELL_ONLY'))
  assert.ok(!items[1].output.includes('DUPLICATE'))
})

test('structured content has readable images and nested fallback; only leading transport metadata is sanitized', async t => {
  const f = await fixture(t)
  const literal = 'Wall time: 99.9 seconds\nOutput:\nTHIS_IS_SCRIPT_TEXT\nChunk ID: printed\nOriginal token count: printed'
  const raw = [text(envelope()), text(literal), text('{"marker":"STORE_VALUE","nested":{"count":7}}'),
    { type: 'input_image', image_url: PNG, detail: 'original' },
    { type: 'future_result', details: { marker: 'FUTURE_VALUE' } }]
  await f.append(custom('structured', 'exec', 'image(...);'), result('structured', raw))
  const before = await fs.readFile(f.rolloutPath)
  const final = (await f.observer.read())[1]
  assert.ok(final.output.includes(literal), 'Printed header-looking body is not removed')
  assert.ok(!final.output.includes('code-mode 0.100 seconds'))
  assert.ok(final.output.includes('Marker: STORE_VALUE'))
  assert.ok(final.output.includes('Count: 7'))
  assert.ok(final.output.includes('Image: embedded image/png'))
  assert.ok(final.output.includes('(original)'))
  assert.ok(final.output.includes('FUTURE_VALUE'))
  assert.ok(!final.output.includes('iVBOR'), 'Human fallback is not a base64/JSON dump')
  assert.deepEqual(await fs.readFile(f.rolloutPath), before, 'Canonical native image/text bytes remain intact')
})

test('failed/terminated native envelopes stay failures, not placeholder successes', async t => {
  const f = await fixture(t)
  await f.append(custom('error', 'exec', 'throw new Error("REAL_ERROR")'),
    result('error', [text(envelope('', 'Script failed')), text('Script error:\nREAL_ERROR')]),
    custom('terminated', 'exec', 'text(1)'), result('terminated', envelope('', 'Script terminated')),
    call('explicit', 'clock', {}), result('explicit', { body: [text('DENIED')], success: false }),
    custom('literal', 'exec', 'text("Script failed")'), result('literal', [text(envelope()), text('Script failed')]))
  const finals = (await f.observer.read()).filter(item => item.completed)
  assert.deepEqual(finals.map(item => item.status), ['failed', 'failed', 'failed', 'completed'])
  assert.ok(finals[0].output.includes('REAL_ERROR'))
  assert.equal(finals[2].output, 'DENIED')
})

test('incremental byte reads handle partial JSON/UTF-8, concurrent notifications and large output without waiting', async t => {
  const f = await fixture(t)
  const encoded = Buffer.from(line(custom('partial', 'exec', 'text("🐾")')))
  const split = encoded.indexOf(Buffer.from('🐾')) + 2
  await fs.writeFile(f.rolloutPath, encoded.subarray(0, split))
  assert.deepEqual(await f.observer.read(), [])
  await fs.appendFile(f.rolloutPath, encoded.subarray(split, encoded.length - 1))
  assert.deepEqual(await f.observer.read(), [], 'Complete JSON without newline is not treated as a completed record')
  await fs.appendFile(f.rolloutPath, '\n')
  const pending = await f.observer.read()
  assert.equal(pending[0].code, 'text("🐾")')
  const body = 'LARGE_REAL_OUTPUT:' + '字'.repeat(100_000)
  await f.append(result('partial', envelope(body)))
  const reads = await Promise.all([f.observer.read(), f.observer.read(), f.observer.read()])
  assert.equal(reads.flat().length, 1)
  assert.equal(reads[0][0].output, `Script completed\n\n${body}`)
  assert.deepEqual(reads.slice(1), [[], []])
  const stats = await fs.stat(f.rolloutPath)
  await f.observer.read()
  assert.equal((await fs.stat(f.rolloutPath)).mtimeMs, stats.mtimeMs)
})

test('missing, malformed, unrelated and orphan records never invent successful calls/results', async t => {
  const f = await fixture(t)
  assert.deepEqual(await f.observer.read(), [])
  await fs.appendFile(f.rolloutPath, '{invalid}\n' + JSON.stringify({ type: 'event_msg', payload: { type: 'function_call', name: 'exec' } }) + '\n')
  await f.append(result('orphan', envelope('NOT_A_CALL')), { type: 'message', role: 'assistant', content: [] },
    { type: 'custom_tool_call', name: 'exec', call_id: 'no-input' },
    { type: 'function_call', name: 'clock', call_id: 'no-arguments' })
  assert.deepEqual(await f.observer.read(), [])
  await f.append(custom('only-call', 'exec', 'text("pending")'))
  const items = await f.observer.read()
  assert.equal(items.length, 1)
  assert.equal(items[0].completed, false)
  assert.equal(items[0].output, undefined)
})

test('only official rollout paths under the supplied private nativeHome are allowed', async t => {
  const f = await fixture(t)
  for (const rolloutPath of [path.join(f.base, 'rollout-outside.jsonl'), path.join(f.nativeHome, 'auth.json'),
    path.join(f.nativeHome, 'config.toml'), path.join(f.nativeHome, 'user.jsonl'), path.join(f.nativeHome, 'sessions', 'auth.json')]) {
    assert.throws(() => createNativeObserver({ nativeHome: f.nativeHome, rolloutPath }), { code: 'ERR_NATIVE_OBSERVATION_PATH' })
  }
  assert.throws(() => createNativeObserver({ nativeHome: '.', rolloutPath: f.rolloutPath }), { code: 'ERR_NATIVE_OBSERVATION_PATH' })
  assert.throws(() => createNativeObserver({ nativeHome: f.nativeHome, rolloutPath: null }), { code: 'ERR_NATIVE_OBSERVATION_PATH' })
})

test('file, directory and home symlinks and hardlinked user files are rejected before any read', async t => {
  const f = await fixture(t)
  const outside = path.join(f.base, 'outside')
  await fs.mkdir(outside)
  const privateFile = path.join(outside, 'auth.json')
  await fs.writeFile(privateFile, line(custom('PRIVATE_MUST_NOT_READ', 'exec', 'SECRET')))
  await fs.symlink(privateFile, f.rolloutPath)
  await assert.rejects(f.observer.read(), { code: 'ERR_NATIVE_OBSERVATION_PATH' })
  await fs.unlink(f.rolloutPath)
  await fs.link(privateFile, f.rolloutPath)
  await assert.rejects(f.observer.read(), { code: 'ERR_NATIVE_OBSERVATION_PATH' })
  const linkedDir = path.join(f.nativeHome, 'sessions', 'linked')
  await fs.symlink(outside, linkedDir)
  await assert.rejects(createNativeObserver({ nativeHome: f.nativeHome, rolloutPath: path.join(linkedDir, 'rollout-test.jsonl') }).read(), { code: 'ERR_NATIVE_OBSERVATION_PATH' })
  const linkedHome = path.join(f.base, 'linked-home')
  await fs.symlink(f.nativeHome, linkedHome)
  await assert.rejects(createNativeObserver({ nativeHome: linkedHome, rolloutPath: path.join(linkedHome, 'sessions', 'rollout-test.jsonl') }).read(), { code: 'ERR_NATIVE_OBSERVATION_PATH' })
})

test('nonregular rollout sources cannot hang and replacement/truncation cannot replay old history', async t => {
  const f = await fixture(t)
  await fs.mkdir(f.rolloutPath)
  await assert.rejects(f.observer.read(), { code: 'ERR_NATIVE_OBSERVATION_PATH' })
  await fs.rmdir(f.rolloutPath)
  await f.append(custom('a', 'exec', 'text(1)'), result('a', envelope('ONE')))
  // Unsafe-source failures are terminal for that observer. A new observer is
  // required, rather than resuming from potentially half-processed bytes.
  const reader = createNativeObserver({ nativeHome: f.nativeHome, rolloutPath: f.rolloutPath })
  await reader.read()
  await fs.truncate(f.rolloutPath, 0)
  await assert.rejects(reader.read(), { code: 'ERR_NATIVE_OBSERVATION_SOURCE_CHANGED' })
  const second = createNativeObserver({ nativeHome: f.nativeHome, rolloutPath: f.rolloutPath })
  await second.read()
  await fs.rename(f.rolloutPath, f.rolloutPath + '.old')
  await f.append(custom('b', 'exec', 'text(2)'))
  await assert.rejects(second.read(), { code: 'ERR_NATIVE_OBSERVATION_SOURCE_CHANGED' })
})

test('ancestor symlinks and deterministic parent-directory swap races never read escaped bytes', async t => {
  const f = await fixture(t)
  await f.append(custom('inside', 'exec', 'SAFE'))
  const linked = path.join(f.base, 'linked-parent')
  await fs.symlink(path.dirname(f.nativeHome), linked)
  await assert.rejects(createNativeObserver({ nativeHome: path.join(linked, 'native-home'),
    rolloutPath: path.join(linked, path.relative(f.base, f.rolloutPath)) }).read(), { code: 'ERR_NATIVE_OBSERVATION_PATH' })
  const originalOpen = fs.open.bind(fs), parent = path.dirname(f.rolloutPath)
  let reads = 0, swapped = false
  t.mock.method(fs, 'open', async (...args) => {
    if (!swapped && args[0].endsWith('/rollout-test.jsonl')) {
      swapped = true
      await fs.rename(parent, parent + '-moved')
      await fs.symlink(parent + '-moved', parent)
    }
    const handle = await originalOpen(...args)
    const read = handle.read.bind(handle)
    handle.read = (...args) => { reads++; return read(...args) }
    return handle
  })
  await assert.rejects(f.observer.read(), { code: 'ERR_NATIVE_OBSERVATION_PATH' })
  assert.equal(swapped, true)
  assert.equal(reads, 0, 'Checks precede any descriptor read, even when a checked parent moves')
})

test('root replacement with the same file inode, and disappearance after reads, fail closed', async t => {
  const f = await fixture(t)
  await f.append(custom('a', 'exec', 'SAFE'))
  await f.observer.read()
  const old = f.nativeHome + '-old'
  await fs.rename(f.nativeHome, old)
  await fs.mkdir(path.dirname(f.rolloutPath), { recursive: true })
  await fs.rename(path.join(old, path.relative(f.nativeHome, f.rolloutPath)), f.rolloutPath)
  await assert.rejects(f.observer.read(), { code: 'ERR_NATIVE_OBSERVATION_SOURCE_CHANGED' })
  const observer = createNativeObserver({ nativeHome: f.nativeHome, rolloutPath: f.rolloutPath })
  await observer.read()
  await fs.unlink(f.rolloutPath)
  await assert.rejects(observer.read(), { code: 'ERR_NATIVE_OBSERVATION_SOURCE_CHANGED' })
})

test('mid-read truncation is terminal; queued reads cannot silently skip lost records', async t => {
  const f = await fixture(t)
  await f.append(custom('a', 'exec', 'SAFE'), result('a', 'x'.repeat(100_000)))
  const originalOpen = fs.open.bind(fs)
  let truncated = false
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await originalOpen(...args)
    if (args[0].endsWith('/rollout-test.jsonl')) {
      const read = handle.read.bind(handle)
      handle.read = async (...args) => {
        const result = await read(...args)
        if (!truncated) { truncated = true; await fs.truncate(f.rolloutPath, 0) }
        return result
      }
    }
    return handle
  })
  const reads = await Promise.allSettled([f.observer.read(), f.observer.read()])
  assert.ok(reads.every(entry => entry.status === 'rejected' && entry.reason.code === 'ERR_NATIVE_OBSERVATION_SOURCE_CHANGED'))
  await f.append(custom('b', 'exec', 'NOT_REPLAYED'))
  await assert.rejects(f.observer.read(), { code: 'ERR_NATIVE_OBSERVATION_SOURCE_CHANGED' })
})

test('bounded batches, pending state and line buffers fail explicitly, never resume half a batch', async t => {
  const f = await fixture(t)
  const calls = Array.from({ length: 4097 }, (_, index) => [custom(`a-${index}`, 'exec', 'x'), result(`a-${index}`, 'x')]).flat()
  await f.append(...calls)
  await assert.rejects(f.observer.read(), { code: 'ERR_NATIVE_OBSERVATION_LIMIT' })
  await fs.writeFile(f.rolloutPath, line(custom('after-error', 'exec', 'NOT_REPLAYED')))
  await assert.rejects(f.observer.read(), { code: 'ERR_NATIVE_OBSERVATION_LIMIT' })
  const pending = createNativeObserver({ nativeHome: f.nativeHome, rolloutPath: f.rolloutPath })
  await fs.writeFile(f.rolloutPath, line(custom('large-a', 'exec', 'x'.repeat(8 * 1024 * 1024))) + line(custom('large-b', 'exec', 'x'.repeat(8 * 1024 * 1024))))
  await assert.rejects(pending.read(), { code: 'ERR_NATIVE_OBSERVATION_LIMIT' })
  const oversized = createNativeObserver({ nativeHome: f.nativeHome, rolloutPath: f.rolloutPath })
  await fs.writeFile(f.rolloutPath, '')
  await fs.truncate(f.rolloutPath, 64 * 1024 * 1024 + 1)
  await assert.rejects(oversized.read(), { code: 'ERR_NATIVE_OBSERVATION_LINE_TOO_LARGE' })
})

test('deduplication survives multiple reads and resume reconstruction; terminal ID storage is bounded', async t => {
  const f = await fixture(t)
  for (let batch = 0; batch < 8; batch++) {
    await f.append(...Array.from({ length: 2048 }, (_, index) => {
      const id = `batch-${batch}-${index}`
      return [custom(id, 'exec', 'x'), result(id, 'x')]
    }).flat())
    assert.equal((await f.observer.read()).length, 4096)
  }
  await f.append(custom('batch-0-0', 'exec', 'DUPLICATE'), result('batch-0-0', 'DUPLICATE'))
  assert.deepEqual(await f.observer.read(), [])
  await f.append(custom('over-cap', 'exec', 'x'))
  await assert.rejects(f.observer.read(), { code: 'ERR_NATIVE_OBSERVATION_LIMIT' })
  const small = await fixture(t)
  await small.append(custom('old', 'exec', 'old'), result('old', 'old'))
  const resumed = createNativeObserver({ nativeHome: small.nativeHome, rolloutPath: small.rolloutPath })
  assert.equal((await resumed.read()).length, 2, 'Historical IDs are deterministic for bridge resume filtering')
  await small.append(custom('old', 'exec', 'DUPLICATE'), result('old', 'DUPLICATE'), custom('new', 'exec', 'new'))
  const newItems = await resumed.read()
  assert.deepEqual(newItems.map(item => item.id), ['native-rollout:new'])
})

test('deep/large human content and media bodies are bounded without mutating native bytes', async t => {
  const f = await fixture(t)
  let deep = 'bottom'
  for (let i = 0; i < 100; i++) deep = { nested: deep }
  const output = [text(envelope()), { type: 'input_audio', data: 'RAW_AUDIO_NOT_DISPLAYED' },
    { mimeType: 'image/png', blob: 'RAW_BLOB_NOT_DISPLAYED' }, { url: PNG }, deep, text('x'.repeat(2 * 1024 * 1024))]
  await f.append(custom('bounded', 'exec', 'SAFE'), result('bounded', output))
  const before = await fs.readFile(f.rolloutPath)
  const final = (await f.observer.read())[1]
  assert.doesNotMatch(final.output, /RAW_AUDIO_NOT_DISPLAYED|RAW_BLOB_NOT_DISPLAYED|iVBOR/)
  assert.match(final.output, /human display truncated/)
  assert.ok(final.output.length <= 1024 * 1024 + 64)
  assert.deepEqual(await fs.readFile(f.rolloutPath), before)
})

test('observer implementation has no native-history writes, model dispatch, subprocesses or tool execution', async () => {
  const source = await fs.readFile(fileURLToPath(new URL('./codex-native-observation.mjs', import.meta.url)), 'utf8')
  assert.deepEqual([...source.matchAll(/^import .+ from '([^']+)'/gm)].map(match => match[1]), ['node:fs/promises', 'node:fs', 'node:path'])
  assert.ok(!/\bfs\.(?:writeFile|appendFile|truncate|rename|unlink|copyFile|mkdir|rm)\s*\(/.test(source))
  assert.ok(!/\b(?:spawn|execFile|dispatch|fetch)\s*\(/.test(source))
  assert.ok(source.includes('constants.O_RDONLY'))
})

// Opt-in real pinned native engine + local authless Responses SSE fixture.
// No user HOME/auth/config, no external services, no shell/apply_patch calls.
// DSH_CODEX_OBSERVATION_INTEGRATION=1 node --test codex-native-observation.test.mjs
const installedPresetRoot = path.join(process.env.HOME ?? os.homedir(), '.dsh', '.agent-presets', 'codex')
const BINARY = process.env.DSH_CODEX_TEST_BINARY ?? path.join(installedPresetRoot, 'bin', 'codex')
const CATALOG = process.env.DSH_CODEX_TEST_CATALOG ?? path.join(installedPresetRoot, 'codex-models.json')
const REQUIRE_NATIVE = process.env.DSH_CODEX_REQUIRE_NATIVE_TESTS === '1'
const NATIVE_ENABLED = REQUIRE_NATIVE || process.env.DSH_CODEX_OBSERVATION_INTEGRATION === '1'
test('real native V8 rollout exposes exec/wait/text/store/load/image while model payloads remain untouched', {
  timeout: 20_000, skip: !NATIVE_ENABLED ? 'Set DSH_CODEX_OBSERVATION_INTEGRATION=1 for the isolated native fixture' :
    !REQUIRE_NATIVE && (!existsSync(BINARY) || !existsSync(CATALOG)) ? 'Installed native binary/catalog unavailable; supply DSH_CODEX_TEST_BINARY/DSH_CODEX_TEST_CATALOG' : false,
}, async t => {
  assert.ok(existsSync(BINARY), `Required native observation binary is missing: ${BINARY}; supply DSH_CODEX_TEST_BINARY`)
  assert.ok(existsSync(CATALOG), `Required native observation catalog is missing: ${CATALOG}; supply DSH_CODEX_TEST_CATALOG`)
  const f = await fixture(t)
  const home = path.join(f.base, 'isolated-home'), cwd = path.join(f.base, 'workspace')
  await Promise.all([fs.mkdir(path.join(home, 'tmp'), { recursive: true }), fs.mkdir(cwd)])
  const catalogPath = path.join(f.base, 'catalog.json')
  await fs.copyFile(CATALOG, catalogPath)
  const code = `store("observation", { marker: "OBS_STORE_REAL", count: 7 });\ntext("OBS_TEXT_REAL");\nyield_control();\ntext(JSON.stringify(load("observation")));\nimage(${JSON.stringify(PNG)});`
  const requests = [], serverErrors = [], notifications = [], sockets = new Set()
  const outputs = (body, id) => (body.input ?? []).filter(item => ['custom_tool_call_output', 'function_call_output'].includes(item.type) && (!id || item.call_id === id))
  const server = http.createServer(async (req, res) => {
    try {
      assert.equal(req.method, 'POST'); assert.equal(req.url, '/v1/responses'); assert.equal(req.headers.authorization, undefined)
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')), index = requests.length
      requests.push(body)
      let item
      if (index === 0) item = custom('v8-exec-real', 'exec', code)
      else if (index === 1) {
        const cell = /Script running with cell ID (\d+)/.exec(JSON.stringify(outputs(body, 'v8-exec-real')))?.[1]
        assert.ok(cell, 'Actual native yield must return a cell ID')
        item = call('v8-wait-real', 'wait', { cell_id: cell, yield_time_ms: 1000 })
      } else if (index === 2) item = custom('v8-load-real', 'exec', 'text(JSON.stringify(load("observation")));')
      else {
        assert.equal(index, 3, 'Native fixture must settle without retries or observer dispatch')
        item = { type: 'message', id: 'answer', role: 'assistant', content: [{ type: 'output_text', text: 'DONE_REAL' }] }
      }
      const response = { id: `observation-response-${index}`, usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13, input_tokens_details: null, output_tokens_details: null } }
      res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' })
      for (const event of [{ type: 'response.created', response: { id: response.id } }, { type: 'response.output_item.done', item }, { type: 'response.completed', response }]) {
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      }
      res.end()
    } catch (error) {
      serverErrors.push(error)
      if (!res.headersSent) res.writeHead(500)
      res.end('Fixture rejected request')
    }
  })
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)) })
  const env = { PATH: `${path.dirname(BINARY)}:/run/current-system/sw/bin:/usr/bin:/bin`, HOME: home, CODEX_HOME: f.nativeHome,
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'), TMPDIR: path.join(home, 'tmp'),
    USER: 'observation-test', LOGNAME: 'observation-test', LANG: 'C.UTF-8', TZ: 'UTC',
    HTTP_PROXY: origin, HTTPS_PROXY: origin, ALL_PROXY: origin, http_proxy: origin, https_proxy: origin, all_proxy: origin,
    NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost', DO_NOT_TRACK: '1', OTEL_SDK_DISABLED: 'true' }
  const child = spawn(BINARY, ['-c', `model_catalog_json=${JSON.stringify(catalogPath)}`, 'app-server', '--listen', 'stdio://'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
  child.stderr.resume()
  const pending = new Map(), lines = createInterface({ input: child.stdout })
  let nextId = 0, completeResolve, completeReject
  const completed = new Promise((resolve, reject) => { completeResolve = resolve; completeReject = reject })
  const fail = error => { completeReject(error); for (const entry of pending.values()) entry.reject(error) }
  child.on('error', fail)
  child.on('exit', () => fail(new Error('Native app-server exited')))
  lines.on('line', line => {
    try {
      const message = JSON.parse(line)
      if (message.method) {
        notifications.push(message)
        if (message.method === 'turn/completed') completeResolve(message.params.turn)
        if ('id' in message) {
          child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: 'Unexpected fixture interaction' } }) + '\n')
        }
      } else if ('id' in message) {
        const entry = pending.get(message.id)
        if (entry) { pending.delete(message.id); message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result) }
      }
    } catch (error) { fail(error) }
  })
  t.after(async () => {
    lines.close(); child.stdin.end()
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve))
      child.kill('SIGTERM')
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 500))])
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
    for (const stream of [child.stdin, child.stdout, child.stderr]) stream.destroy()
  })
  async function bounded(promise) {
    let timer
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Native fixture exceeded 6 seconds')), 6000) })]) }
    finally { clearTimeout(timer) }
  }
  function rpc(method, params) {
    const id = ++nextId
    return bounded(new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })).finally(() => pending.delete(id))
  }
  await rpc('initialize', { clientInfo: { name: 'codex_cli_rs', version: '0.0.0' }, capabilities: { experimentalApi: true } })
  child.stdin.write('{"jsonrpc":"2.0","method":"initialized"}\n')
  const config = { 'model_providers.mock': { name: 'Local observation fixture', base_url: `${origin}/v1`, wire_api: 'responses',
    requires_openai_auth: false, request_max_retries: 0, stream_max_retries: 0, stream_idle_timeout_ms: 5000 },
    'features.code_mode_host': { enabled: true, disable_in_process_fallback: true }, 'web_search': 'disabled',
    'analytics.enabled': false, 'feedback.enabled': false }
  const started = await rpc('thread/start', { model: 'gpt-6-luna', modelProvider: 'mock', cwd,
    approvalPolicy: 'never', sandbox: 'workspace-write', config, experimentalRawEvents: true })
  assert.ok(started.thread.path, 'The official native thread must provide a real private rollout path')
  const observer = createNativeObserver({ nativeHome: f.nativeHome, rolloutPath: started.thread.path })
  await rpc('turn/start', { threadId: started.thread.id, input: [{ type: 'text', text: 'Exercise local V8 observation helpers only.', text_elements: [] }],
    cwd, model: 'gpt-6-luna', effort: 'medium', approvalPolicy: 'never',
    sandboxPolicy: { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false } })
  assert.equal((await bounded(completed)).status, 'completed')
  const items = [], deadline = Date.now() + 3000
  do {
    items.push(...await observer.read())
    if (items.filter(item => item.completed).length === 3) break
    await new Promise(resolve => setTimeout(resolve, 20))
  } while (Date.now() < deadline)
  assert.equal(serverErrors.length, 0, serverErrors[0]?.stack)
  assert.equal(requests.length, 4)
  assert.equal(items.length, 6, 'Real native calls and outputs must all be observed, no placeholder results')
  assert.deepEqual(items.filter(item => !item.completed).map(nativeToolName), ['exec', 'wait', 'exec'])
  assert.equal(nativeToolArguments(items[0]).input, code)
  const human = items.filter(item => item.completed).map(item => item.output).join('\n')
  assert.ok(human.includes('OBS_TEXT_REAL')); assert.ok(human.includes('OBS_STORE_REAL')); assert.ok(human.includes('Image: embedded image/png'))
  const modelOutputs = outputs(requests.at(-1))
  assert.ok(JSON.stringify(modelOutputs).includes(PNG), 'Native model image remains the original full data URL')
  const history = await fs.readFile(started.thread.path), modelBefore = structuredClone(requests)
  const nativeOutputs = history.toString('utf8').trim().split('\n').map(line => JSON.parse(line))
    .filter(entry => entry.type === 'response_item' && ['custom_tool_call_output', 'function_call_output'].includes(entry.payload.type)).map(entry => entry.payload)
  for (const output of modelOutputs) {
    const rolloutOutput = nativeOutputs.find(item => item.call_id === output.call_id)
    assert.ok(rolloutOutput, 'Full output has a real native rollout source')
    // Official model transport itself omits image detail on this model; that
    // upstream normalization predates our read. Compare exact native text and
    // full image references, not an observer-invented model-output encoding.
    const visiblePayload = body => Array.isArray(body) ? body.map(item => {
      if (item.type === 'input_image') return { type: item.type, image_url: item.image_url }
      return item
    }) : body
    assert.deepEqual(visiblePayload(rolloutOutput.output), visiblePayload(output.output), 'All native text and image references come from actual model-visible output')
  }
  assert.deepEqual(await observer.read(), [])
  assert.deepEqual(await fs.readFile(started.thread.path), history, 'Observer does not write native history')
  assert.deepEqual(requests, modelBefore, 'Observer does not dispatch model requests')
  const raw = notifications.filter(event => event.method === 'rawResponseItem/completed')
  assert.ok(raw.length > 0, 'Experimental native raw events were actually enabled')
  const rawOutputs = raw.filter(event => ['custom_tool_call_output', 'function_call_output'].includes(event.params?.item?.type))
  const rawImages = rawOutputs.flatMap(event => Array.isArray(event.params.item.output) ? event.params.item.output : [])
    .filter(item => item.type === 'input_image')
  t.diagnostic(`Native raw events: ${raw.length} (${rawOutputs.length} tool outputs, ${rawImages.length} output images); native rollout observations: ${items.length}. Full V8 text/image results came from the real private rollout.`)
})
