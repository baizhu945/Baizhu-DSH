#!/usr/bin/env node
/** Genuine stdio MCP peer. No SDK mocks; an append-only ledger measures physical
 * process starts/calls/teardown across independent root-agent scopes. */
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
const ledger = process.env.REA_TEST_LEDGER
const mode = process.env.REA_TEST_MODE ?? 'healthy'
const record = (event, details = {}) => { if (ledger) appendFileSync(ledger, JSON.stringify({ event, pid: process.pid, mode, ...details }) + '\n') }
record('spawn')
process.on('exit', code => record('exit', { code }))
process.on('SIGTERM', () => { record('SIGTERM'); process.exit(0) })
process.on('SIGINT', () => { record('SIGINT'); process.exit(0) })
const names = ['binary_session', 'fixture_mutation', 'fixture_unknown', 'source_list', 'source_read', 'source_search', 'source_detect',
  ...Array.from({ length: 131 }, (_, index) => `fixture_read_${String(index).padStart(3, '0')}`)]
const catalog = names.map(name => ({
  name, description: `REA fixture ${name}`,
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  ...(name === 'fixture_unknown' ? {} : { annotations: { readOnlyHint: name !== 'fixture_mutation', destructiveHint: name === 'fixture_mutation' } }),
}))
function send(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n') }
const lines = createInterface({ input: process.stdin })
lines.on('close', () => { record('stdin-close'); process.exit(0) })
lines.on('line', line => {
  let message
  try { message = JSON.parse(line) } catch { return }
  if (!('id' in message)) return
  record(message.method, { id: message.id, name: message.params?.name })
  if (mode === 'fail') { process.exit(42); return }
  if ((mode === 'init-gated' && message.method === 'initialize') || (mode === 'list-gated' && message.method === 'tools/list')) return
  if (message.method === 'initialize') {
    send(message.id, { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'REA fixture', version: '6.1.0-test' }, instructions: 'REA fixture instructions only for the selected root agent.' })
  } else if (message.method === 'tools/list') {
    send(message.id, { tools: mode === 'malformed' ? [catalog[0], { name: 'broken', inputSchema: { type: 'string' } }] : catalog })
  } else if (message.method === 'tools/call') {
    send(message.id, { content: [{ type: 'text', text: JSON.stringify({ success: true, fixture: true, tool: message.params.name, pid: process.pid }) }] })
  } else if (message.method === 'ping') send(message.id, {})
  else process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'method not found' } }) + '\n')
})
