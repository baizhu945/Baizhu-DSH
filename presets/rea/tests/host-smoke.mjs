import assert from 'node:assert/strict'
import { temporaryHome, actualContext, discoverNonReaDefinitions, createAgent, snapshot, turn, stableRequest } from './sdk-host.mjs'
const root = temporaryHome()
const definitions = discoverNonReaDefinitions()
const sample = 'Time sampled while preparing turn 1, step 1: 2026-10-13T10:24:59+00:00[UTC]\nBrowser time zone: fixed.\nElapsed: unchanged.'
const projected = stableRequest({ messages: [
  { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: sample }] },
  { role: 'user', source: { kind: 'time-context', sections: [{ name: 'time-context', text: sample }] }, content: [{ type: 'text', text: sample }] },
] })
assert.equal(projected.messages[0].content[0].text, sample, 'Do not normalize user-authored text that resembles the context clock')
assert.equal(projected.messages[1].content[0].text, sample.replace('2026-10-13T10:24:59+00:00[UTC]', '<sampled-request-time>'))
assert.equal(projected.messages[1].source.sections[0].text, projected.messages[1].content[0].text)
console.log('Actual installed SDK host; discovered every non-REA preset:', definitions.map(row => row.id).join(', '))
for (const definition of definitions) {
  const views = [], requests = []
  for (let iteration = 0; iteration < 2; iteration++) {
    const { ctx, capture } = await actualContext(root, { definitions })
    try {
      const roster = await ctx.agentPresets.list()
      assert(roster.every(row => !row.broken), JSON.stringify(roster))
      const handle = await createAgent(ctx, `smoke-${definition.id}`, definition.id)
      try {
        views.push(await snapshot(ctx, handle.agent))
        if (definition.id !== 'codex') {
          await turn(handle.agent)
          assert.equal(capture.requests.length, 1)
          requests.push(stableRequest(capture.requests[0]))
        }
      } finally { await handle.dispose() }
    } finally { await ctx.fiber.dispose() }
  }
  assert.deepEqual(views[0], views[1]); if (requests.length) assert.deepEqual(requests[0], requests[1])
  assert(!JSON.stringify(views[0]).includes('mcp__rea__'))
  console.log(`PASS ${definition.id}: repeat full tools/schema/prompt/TS+Python SDK equality; schemas=${views[0].schemas.length}; complete first requests=${requests.length}; no real auth/provider`)
}
