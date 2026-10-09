import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { temporaryHome, actualContext, discoverNonReaDefinitions, createAgent, execute, sdk } from './sdk-host.mjs'
const root = temporaryHome(), ledger = join(root, 'fixture.jsonl')
const { ctx } = await actualContext(root, { definitions: discoverNonReaDefinitions() })
try {
  const peer = await sdk('@deepseek-ai/dsh-mcp-client')
  const handle = await createAgent(ctx, 'fixture-protocol-smoke', 'standard', { setup: async agentCtx => {
    // This checks the stdio fixture and installed SDK interoperability only;
    // it is NOT a claim that the new REA lazy bootstrap has passed.
    await agentCtx.plugin(peer, { transport: 'stdio', serverName: 'rea', command: process.execPath,
      args: [join(dirname(fileURLToPath(import.meta.url)), 'fixture-stdio.mjs')],
      env: { REA_TEST_LEDGER: ledger, REA_TEST_MODE: 'healthy' }, cwd: join(root, 'workspace'),
      toolCallTimeoutMs: 600000, failOnStartupError: true, reconnect: { enabled: false } })
  } })
  assert.equal(ctx.tools.schemas(handle.agent).filter(row => row.name.startsWith('mcp__rea__')).length, 138)
  const result = await execute(ctx, handle.agent, 'mcp__rea__binary_session')
  assert.equal(result.isError, false, JSON.stringify(result))
  assert(JSON.stringify(result).includes('fixture'))
  const events = readFileSync(ledger, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.equal(events.filter(row => row.event === 'initialize').length, 1)
  // This installed MCP SDK probes server/discover in a transient child before
  // falling back to MCP v1. Count live owners, not a misleading spawn total.
  const pid = events.find(row => row.event === 'initialize').pid
  await handle.dispose()
  let alive = true
  for (let i = 0; i < 100; i++) {
    try { process.kill(pid, 0) } catch (error) { if (error.code === 'ESRCH') { alive = false; break } throw error }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert(!alive, 'fixture peer survived owning agent disposal')
  console.log('PASS fixture only: actual installed MCP client stdio138, readonly ToolRuntime call, physical agent-scope teardown; new lazy bootstrap NOT exercised')
} finally { await ctx.fiber.dispose() }
