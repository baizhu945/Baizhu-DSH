import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { existsSync, realpathSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { CodexAppServer } from './codex-app-server.mjs'
import { installedBinary, installedCatalog, requireIntegration } from './codex-test-environment.mjs'

const binary = process.env.DSH_CODEX_TEST_BINARY ?? installedBinary
const catalog = process.env.DSH_CODEX_TEST_CATALOG ?? installedCatalog
const available = existsSync(binary) && existsSync(catalog)
const knownScript = "printf 'FIXTURE_APPROVED_ONCE\\n' > approval-once.txt"
const sdkCoreModel = 'gpt-6-luna'

// No auth module import, credential refresh, inherited environment, or live inference.
// This fixture observes the native proposal; it does not change admission policy.
test('native wire proposes an execpolicy tuple; decline does not execute or persist approval', {
  timeout: 20_000,
  skip: !available && !requireIntegration ? 'Installed binary/catalog unavailable; supply DSH_CODEX_TEST_BINARY/CATALOG' : false,
}, async t => {
  assert.ok(available, 'Required native binary/catalog unavailable')
  const shellCandidate = process.env.DSH_CODEX_TEST_BASH ?? ['/run/current-system/sw/bin/bash', '/bin/bash'].find(existsSync)
  assert.ok(shellCandidate, 'A trusted bash executable is required')
  const trustedBash = realpathSync(shellCandidate)
  assert.equal(path.basename(trustedBash), 'bash')
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-approval-wire-'))
  const cwd = path.join(base, 'workspace')
  const home = path.join(base, 'home')
  const codexHome = path.join(home, 'codex')
  await Promise.all([cwd, codexHome, path.join(home, 'tmp')].map(p => fs.mkdir(p, { recursive: true })))
  let requests = 0
  let captured = 0
  let failure
  let settle
  const done = new Promise(resolve => { settle = resolve })
  const server = http.createServer(async (req, res) => {
    // This server is also the deny-all proxy sink. Never retain headers or bodies.
    if (req.method !== 'POST' || req.url !== '/v1/responses' || req.headers.authorization || requests >= 3) {
      req.resume(); res.writeHead(403); res.end(); return
    }
    try {
      let bytes = 0
      for await (const chunk of req) {
        bytes += chunk.length
        if (bytes > 1024 * 1024) { res.writeHead(413); res.end(); req.destroy(); return }
      }
      const id = `fixture-${++requests}`
      const item = requests === 1
        ? { type: 'custom_tool_call', call_id: 'fixture-exec', name: 'exec', input: `await tools.exec_command(${JSON.stringify({ cmd: knownScript, login: false, sandbox_permissions: 'require_escalated', justification: 'Synthetic approval fixture' })});` }
        : { type: 'message', role: 'assistant', id: 'fixture-answer', content: [{ type: 'output_text', text: 'Fixture completed.' }] }
      res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' })
      for (const event of [
        { type: 'response.created', response: { id } },
        { type: 'response.output_item.done', item },
        { type: 'response.completed', response: { id, usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 } } },
      ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      res.end()
    } catch { failure = new Error('Loopback fixture request failed'); settle() }
  })
  server.requestTimeout = 5000
  server.headersTimeout = 5000
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const env = {
    PATH: `${path.dirname(trustedBash)}:${path.dirname(binary)}`, HOME: home,
    CODEX_HOME: codexHome, XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_CACHE_HOME: path.join(home, '.cache'), TMPDIR: path.join(home, 'tmp'),
    LANG: 'C.UTF-8', SHELL: trustedBash, USER: 'fixture', LOGNAME: 'fixture',
    DO_NOT_TRACK: '1', OTEL_SDK_DISABLED: 'true', NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
  }
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) env[key] = origin
  const client = new CodexAppServer({ command: binary, cwd, env,
    onNotification(method) { if (method === 'turn/completed') settle() },
    onRequest(method, p) {
      if (method !== 'item/commandExecution/requestApproval') throw new Error('Unknown fixture request rejected')
      try {
        captured++
        assert.equal(captured, 1, 'Exactly one approval expected')
        assert.equal(p.cwd === cwd, true, 'Approval cwd must be synthetic workspace')
        assert.equal(p.kind === 'command', true, 'Expected command approval')
        const proposal = p.proposedExecpolicyAmendment
        // Boolean assertions deliberately avoid echoing arbitrary native values.
        assert.equal(Array.isArray(proposal) && proposal.length === 3, true, 'Expected three-element proposal')
        assert.equal(proposal[1] === '-c' && proposal[2] === knownScript, true, 'Proposal must contain the fixed script')
        assert.equal(typeof proposal[0] === 'string', true, 'Proposal shell must be a string')
        const resolvedShell = realpathSync(proposal[0])
        const shellStat = statSync(resolvedShell)
        const trustedCoreBash = /^\/nix\/store\/[a-z0-9]{32}-bash[^/]*\/bin\/bash$/.test(resolvedShell)
          && (shellStat.mode & 0o022) === 0 && (shellStat.mode & 0o111) !== 0
        const safeOtherShell = /^\/nix\/store\/[a-z0-9]{32}-zsh[^/]*\/bin\/zsh$/.test(resolvedShell)
          && (shellStat.mode & 0o022) === 0 && (shellStat.mode & 0o111) !== 0
        assert.equal(resolvedShell === trustedBash || trustedCoreBash || safeOtherShell, true, 'Proposal must use a trusted immutable shell')
        assert.equal(Array.isArray(p.availableDecisions) && p.availableDecisions.includes('accept'), true, 'One-time acceptance must be offered')
        // Display argv is not policy argv. Report only booleans rather than guessing
        // upstream quoting or disclosing an arbitrary command body.
        t.diagnostic(JSON.stringify({ proposalExactTuple: true, proposalUsesTrustedBash: resolvedShell === trustedBash || trustedCoreBash, proposalUsesSafeOtherShell: safeOtherShell, shellMatchesConfiguredBash: resolvedShell === trustedBash, commandIsPlainScript: p.command === knownScript,
          commandIsJsonQuotedArgv: p.command === `${proposal[0]} -c ${JSON.stringify(knownScript)}`,
          automaticProposalAccepted: false }))
      } catch (error) { failure = new Error(error.code === 'ERR_ASSERTION' ? error.message : 'Native approval tuple validation failed'); settle() }
      return { decision: 'decline' }
    },
  })
  let timer
  try {
    await client.start()
    const config = {
      'model_providers.localfixture': { name: 'Authless loopback fixture', base_url: `${origin}/v1`, wire_api: 'responses', requires_openai_auth: false, request_max_retries: 0, stream_max_retries: 0 },
      'features.code_mode_host': { enabled: true, disable_in_process_fallback: true },
      web_search: 'disabled', 'analytics.enabled': false, 'feedback.enabled': false, model_catalog_json: catalog,
    }
    const started = await client.request('thread/start', { model: sdkCoreModel, modelProvider: 'localfixture', cwd,
      approvalPolicy: 'on-request', sandbox: 'read-only', config }, { timeoutMs: 5000 })
    await client.request('turn/start', { threadId: started.thread.id, input: [{ type: 'text', text: 'Run the synthetic fixture once.', text_elements: [] }], model: sdkCoreModel }, { timeoutMs: 5000 })
    await Promise.race([done, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Bounded fixture timeout')), 10_000) })])
    if (failure) throw failure
    assert.equal(captured, 1, 'No native approval captured')
    assert.equal(existsSync(path.join(cwd, 'approval-once.txt')), false, 'Decline must not execute')
    const entries = await fs.readdir(codexHome, { recursive: true })
    assert.equal(entries.some(name => /(^|\/)rules(\/|$)|\.rules$/.test(name)), false, 'Decline must not persist policy rules')
  } finally {
    clearTimeout(timer)
    await client.close()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    // Keep no request bodies, credentials, native rollouts, or synthetic state.
    await fs.rm(base, { recursive: true, force: true })
  }
})
