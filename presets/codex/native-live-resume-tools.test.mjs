import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { CodexAppServer } from './codex-app-server.mjs'
import { installedBinary, installedCatalog } from './codex-test-environment.mjs'

// Offline question: does an official `thread/resume` preserve the model-facing
// tool set, notably the `collaboration` namespace and `exec`? Real compiled
// alpha core, real app-server transport, authless loopback Responses only.
const catalog = await fs.realpath(installedCatalog)
const binary = await fs.realpath(installedBinary)
const flatten = body => {
  const declared = [...(body.tools ?? []), ...(body.input ?? [])
    .filter(item => item.type === 'additional_tools').flatMap(item => item.tools ?? [])]
  return declared.flatMap(tool => tool.type === 'namespace' ? [tool, ...tool.tools] : [tool])
}

test('resumed thread advertises the same collaboration namespace and exec surface as the original thread',
  { timeout: 60_000, concurrency: false }, async t => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-resume-tools-'))
    t.after(() => fs.rm(base, { recursive: true, force: true }))
    const cwd = path.join(base, 'workspace'), home = path.join(base, 'home')
    for (const directory of [cwd, home, path.join(home, 'tmp'), path.join(home, 'codex')]) {
      await fs.mkdir(directory, { recursive: true })
    }
    const requests = []
    const server = http.createServer(async (req, res) => {
      if (req.method !== 'POST' || req.url !== '/v1/responses') { res.writeHead(403); res.end(); return }
      let body = ''
      for await (const chunk of req) {
        body += chunk
        if (body.length > 4_000_000) { res.writeHead(413); res.end(); return }
      }
      requests.push(JSON.parse(body))
      const id = `fixture-${requests.length}`
      const item = { type: 'message', role: 'assistant', id: `answer-${requests.length}`,
        content: [{ type: 'output_text', text: 'ok' }] }
      res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' })
      for (const event of [{ type: 'response.created', response: { id } },
        { type: 'response.output_item.done', item },
        { type: 'response.completed', response: { id, usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } }]) {
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      }
      res.end()
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const origin = `http://127.0.0.1:${server.address().port}`
    const env = { PATH: path.dirname(binary), HOME: home, CODEX_HOME: path.join(home, 'codex'),
      XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'),
      TMPDIR: path.join(home, 'tmp'), LANG: 'C.UTF-8', USER: 'fixture', LOGNAME: 'fixture',
      DO_NOT_TRACK: '1', OTEL_SDK_DISABLED: 'true', NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' }
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) env[key] = origin
    const completed = []
    const client = new CodexAppServer({ command: binary, cwd, env,
      onNotification(method, params) { if (method === 'turn/completed') completed.push(params) } })
    t.after(async () => { await client.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
    await client.start()
    const config = { 'model_providers.resumefixture': { name: 'Resume fixture', base_url: `${origin}/v1`,
      wire_api: 'responses', requires_openai_auth: false, request_max_retries: 0, stream_max_retries: 0 },
      'features.code_mode_host': { enabled: true, disable_in_process_fallback: true },
      web_search: 'disabled', 'analytics.enabled': false, 'feedback.enabled': false, model_catalog_json: catalog }
    const started = await client.request('thread/start', { model: MODEL_SLUG, modelProvider: 'resumefixture',
      cwd, config }, { timeoutMs: 15_000 })
    let expected = 0
    const turn = async () => {
      expected += 1
      await client.request('turn/start', { threadId: started.thread.id,
        input: [{ type: 'text', text: 'Reply ok without tools.', text_elements: [] }],
        model: MODEL_SLUG }, { timeoutMs: 15_000 })
      for (let i = 0; i < 400; i++) {
        if (requests.length >= expected && completed.length >= expected) return
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      assert.fail(`turn did not complete: requests=${requests.length} completed=${completed.length} expected=${expected}`)
    }
    await turn()
    const first = flatten(requests[0]).map(tool => tool.name).sort()
    await client.request('thread/resume', { threadId: started.thread.id, model: MODEL_SLUG,
      modelProvider: 'resumefixture', cwd, config }, { timeoutMs: 15_000 })
    await turn()
    const second = flatten(requests[requests.length - 1]).map(tool => tool.name).sort()
    assert.ok(first.includes('collaboration'), 'baseline thread must advertise collaboration tools')
    assert.deepEqual(second, first, 'a resumed thread must advertise the identical tool set')
  })

const MODEL_SLUG = 'gpt-6-luna'