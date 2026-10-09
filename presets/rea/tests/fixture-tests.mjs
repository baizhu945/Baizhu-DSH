import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, chmodSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { temporaryHome, actualContext, discoverNonReaDefinitions, createAgent, snapshot, turn,
  execute, stableRequest, reaDefinition, runtimeRoot, presetRoot, createScope, scopeTarget,
  assembleContextFor, sdk, loadYaml, SessionId, createUserMessage } from './sdk-host.mjs'

const root = temporaryHome()
const here = dirname(fileURLToPath(import.meta.url))
const ledger = join(root, 'fixture.jsonl')
const fixtureExe = join(root, 'rea-fixture')
writeFileSync(fixtureExe, `#!${process.execPath}\nimport ${JSON.stringify(pathToFileURL(join(here, 'fixture-stdio.mjs')).href)}\n`)
chmodSync(fixtureExe, 0o700)
const effectsPath = join(root, 'fixture-effects.json')
const readonlyEffect = { mutatesTarget: false, writesFilesystem: false, launchesProcess: false, accessesNetwork: false, changesUiState: false, mayDiscardData: false }
writeFileSync(effectsPath, JSON.stringify(Object.fromEntries([
  ['binary_session', readonlyEffect], ...['source_list', 'source_read', 'source_search', 'source_detect'].map(name => [name, readonlyEffect]),
  ['fixture_mutation', { ...readonlyEffect, mutatesTarget: true }],
])))
const overrides = mode => ({ command: fixtureExe, args: ['mcp'], env: { REA_TEST_LEDGER: ledger, REA_TEST_MODE: mode }, toolCallTimeoutMs: 600000,
  hostPackageJson: join(runtimeRoot, 'apps/cli/package.json'), effectsPath })
const events = () => existsSync(ledger) ? readFileSync(ledger, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
const started = () => events().filter(row => row.event === 'spawn')
const initialized = () => events().filter(row => row.event === 'initialize')
const alive = pid => { try { process.kill(pid, 0); return true } catch (error) { if (error.code === 'ESRCH') return false; throw error } }
async function until(check, label, ms = 5000) {
  const end = Date.now() + ms
  while (!check()) { if (Date.now() > end) throw new Error(`timeout: ${label}`); await new Promise(resolve => setTimeout(resolve, 10)) }
}
async function deadline(promise, label, ms = 15000) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => { console.error(`DEADLINE ${label} (${ms}ms); teardown will now be awaited`); reject(new Error(`timeout: ${label}`)) }, ms) })]) }
  finally { clearTimeout(timer) }
}
const reaTools = (ctx, agent) => ctx.tools.schemas(agent).filter(row => row.name.startsWith('mcp__rea__'))
const noRea = value => assert(!/mcp__rea__|rea-runtime\.mjs|\bREA fixture\b|rea_source_(?:read|list|search)|\"name\":\"rea_/i.test(JSON.stringify(value)), 'non-REA model surface leaked REA tool/helper/context')
const hash = text => createHash('sha256').update(text).digest('hex')
const definitions = discoverNonReaDefinitions()
const results = []
async function test(name, body) {
  if (process.env.REA_TEST_FILTER && !name.includes(process.env.REA_TEST_FILTER)) {
    results.push({ name, status: 'SKIP', reason: 'explicit debug filter' }); return
  }
  const before = Date.now()
  try { await body(); results.push({ name, status: 'PASS', ms: Date.now() - before }); console.log(`PASS ${name}`) }
  catch (error) { results.push({ name, status: 'FAIL', error: error.stack }); console.error(`FAIL ${name}: ${error.stack}`) }
  writeFileSync(join(root, 'partial-report.json'), JSON.stringify({ runtimeRoot, presetRoot, nonReaPresets: definitions.map(row => row.id), results, processLedger: events() }, null, 2) + '\n')
}
console.log('Runtime:', runtimeRoot, '\nInstalled REA preset:', presetRoot, '\nEvery non-REA preset:', definitions.map(row => row.id).join(', '), '\nTemporary DSH_HOME:', root)

await test('installed bootstrap configuration and immutable baseline metadata', async () => {
  const def = reaDefinition()
  const baseline = definitions.find(row => row.id === 'standard').plugins
  const bootstrap = def.plugins.filter(row => row.id === 'rea-bootstrap')
  assert.equal(bootstrap.length, 1)
  const config = bootstrap[0].config
  assert.equal(config.serverName, 'rea'); assert.deepEqual(config.args, ['mcp']); assert.equal(config.toolCallTimeoutMs, 1860000)
  assert.equal(config.env.REA_ANALYSIS_PROVIDER, 'ghidra')
  assert.equal(config.env.REA_GHIDRA_STARTUP_TIMEOUT_MS, '1800000')
  assert.equal(config.env.GHIDRA_HEADLESS_MAXMEM, '8G')
  assert(config.command.startsWith('/')); assert(config.env.GHIDRA_INSTALL_DIR.startsWith('/')); assert(config.env.JAVA_HOME.startsWith('/'))
  assert.deepEqual(def.plugins.filter(row => row.id !== 'rea-bootstrap'), baseline)
  assert(!JSON.stringify(def.plugins).includes('@deepseek-ai/dsh-mcp-client'), 'standing preset may not mount eager MCP')
})

// Deliberately run each preset with the entire real preset roster loaded, not
// a toy one-tool composition. A future onsite preset cannot be silently skipped.
for (const definition of definitions) await test(`non-REA ${definition.id}: complete tools/prompt/PTC SDK/schema/first-request identical`, async () => {
  const views = [], requests = [], inventories = []
  const count = started().length
  for (const enabled of [false, true]) {
    const { ctx, capture } = await actualContext(root, { definitions, ...(enabled ? { reaDefinition: reaDefinition(overrides('healthy')) } : {}) })
    try {
      assert.equal((await ctx.agentPresets.list()).some(row => row.id === 'rea'), enabled)
      await ctx.agentPresets.remoteExportList()
      await ctx.agentPresets.compositionInventory()
      if (enabled) {
        const lease = await ctx.agentPresets.acquireScope('rea')
        await lease[Symbol.asyncDispose]()
      }
      assert.equal(started().length, count, 'roster/read/acquireScope spawned MCP')
      const handle = await createAgent(ctx, `same-${definition.id}`, definition.id)
      try {
        const view = await snapshot(ctx, handle.agent)
        noRea(view); views.push(view)
        const rows = (await ctx.agentPresets.compositionInventory()).find(row => row.id === definition.id)
        inventories.push(rows)
        // Native Codex has its own request owner. Never call its model or auth:
        // compare composition/nativeConfig and the actual DSH assembly instead.
        if (definition.id !== 'codex') {
          await deadline(turn(handle.agent), `${definition.id} first request`)
          assert.equal(capture.requests.length, 1)
          requests.push(stableRequest(capture.requests[0])); noRea(capture.requests[0])
        }
        assert.equal(started().length, count, `unselected REA spawned from ${definition.id}`)
      } finally { await handle.dispose() }
    } finally { await ctx.fiber.dispose() }
  }
  assert.deepEqual(views[1], views[0])
  assert.deepEqual(inventories[1], inventories[0])
  if (requests.length) assert.deepEqual(requests[1], requests[0])
  assert(!views[0].schemas.some(row => /^(select|switch|set)_.*(preset|rea)$|^rea_(enable|select|switch)$/.test(row.name)), 'model has a preset-selection/REA-enabling tool')
  if (definition.id === 'codex') {
    assert(views[0].schemas.every(row => row.name === 'codex_native_observer'), 'Codex acquired DSH baseline tools')
    assert(!views[0].sections.some(row => /^(tool:|tools:|preset:)/.test(row.name)), 'Codex acquired DSH baseline prompt/PTC sections')
  }
  console.log(JSON.stringify({ preset: definition.id, tools: views[0].schemas.map(row => row.name), promptHash: hash(views[0].prompt), tsSdkHash: hash(views[0].tsSdk), pySdkHash: hash(views[0].pySdk), requestHash: requests.length ? hash(JSON.stringify(requests[0])) : null }))
})

await test('selected REA first pre-step only; MCP138; readonly call through actual ToolRuntime', async () => {
  const count = started().length
  const { ctx, capture } = await actualContext(root, { definitions, reaDefinition: reaDefinition(overrides('healthy')) })
  try {
    assert.equal(started().length, count)
    const handle = await createAgent(ctx, 'selected-rea', 'rea')
    assert.equal(started().length, count, 'create/mount may not spawn before first pre-step')
    assert.equal(reaTools(ctx, handle.agent).length, 0)
    await deadline(turn(handle.agent), 'selected REA bootstrap')
    const bootstrapStarts = started().length
    assert(bootstrapStarts > count)
    assert.equal(started().slice(count).filter(row => alive(row.pid)).length, 1, 'selected root owns one live MCP process (SDK discovery probes may have exited)')
    assert.equal(reaTools(ctx, handle.agent).length, 138)
    assert.equal(capture.requests.length, 1)
    assert.equal(capture.requests[0].tools.filter(row => row.name.startsWith('mcp__rea__')).length, 138)
    const view = await snapshot(ctx, handle.agent)
    assert(view.prompt.includes('REA fixture instructions'))
    assert(view.tsSdk.includes('mcp__rea__binary_session'))
    const result = await execute(ctx, handle.agent, 'mcp__rea__binary_session')
    assert(!result.isError, JSON.stringify(result)); assert(JSON.stringify(result).includes('fixture'))
    await turn(handle.agent); assert.equal(started().length, bootstrapStarts, 'second turn restarted MCP')
    const pid = initialized().at(-1).pid
    await handle.dispose()
    await until(() => !alive(pid), 'agent scope must release physical MCP process')
    assert.equal(ctx.tools.schemas().filter(row => row.name.startsWith('mcp__rea__')).length, 0)
  } finally { await ctx.fiber.dispose() }
})

await test('parallel selected roots own independent MCP; non-REA root stays clean', async () => {
  const count = started().length
  const { ctx } = await actualContext(root, { definitions, reaDefinition: reaDefinition(overrides('healthy')) })
  try {
    const [one, two, clean] = await Promise.all([createAgent(ctx, 'root-one', 'rea'), createAgent(ctx, 'root-two', 'rea'), createAgent(ctx, 'root-standard', 'standard')])
    await Promise.all([turn(one.agent), turn(two.agent), turn(clean.agent)])
    assert.equal(started().slice(count).filter(row => alive(row.pid)).length, 2)
    assert.equal(reaTools(ctx, one.agent).length, 138); assert.equal(reaTools(ctx, two.agent).length, 138)
    noRea(await snapshot(ctx, clean.agent))
    const pids = started().slice(count).map(row => row.pid)
    const r1 = await execute(ctx, one.agent, 'mcp__rea__binary_session'), r2 = await execute(ctx, two.agent, 'mcp__rea__binary_session')
    assert.notDeepEqual(r1.content, r2.content, 'roots shared the same physical process')
    await one.dispose()
    assert.equal(reaTools(ctx, two.agent).length, 138)
    assert(!(await execute(ctx, two.agent, 'mcp__rea__binary_session')).isError)
    await two.dispose(); await clean.dispose()
    await until(() => pids.every(pid => !alive(pid)), 'parallel root release')
  } finally { await ctx.fiber.dispose() }
})

await test('blank REA -> standard selection clears bootstrap/context; selection locks after first turn', async () => {
  const count = started().length
  const { ctx, capture } = await actualContext(root, { definitions, reaDefinition: reaDefinition(overrides('healthy')) })
  try {
    const handle = await createAgent(ctx, 'blank-switch', 'rea')
    await ctx.agentPresets.select(handle.agent, 'standard')
    await turn(handle.agent)
    assert.equal(started().length, count)
    noRea(await snapshot(ctx, handle.agent)); noRea(capture.requests[0])
    await assert.rejects(ctx.agentPresets.select(handle.agent, 'rea'), /already started/)
    await handle.dispose()
    // Stronger stale-context boundary: actual expert assembly while still
    // blank, then change preset. No turn/start is fabricated.
    const active = await createAgent(ctx, 'blank-with-bootstrap', 'rea')
    await snapshot(ctx, active.agent)
    assert.equal(reaTools(ctx, active.agent).length, 138)
    const pid = started().at(-1).pid
    await ctx.agentPresets.select(active.agent, 'standard')
    noRea(await snapshot(ctx, active.agent))
    await until(() => !alive(pid), 'blank recompose cleanup')
    await active.dispose()
  } finally { await ctx.fiber.dispose() }
})

await test('child cannot inherit REA or bypass public toolFilter; original global instructions are preserved', async () => {
  const count = started().length
  // Original user-global instructions/skills belong to the baseline, not REA.
  // Installing this preset must not silently remove them from child sessions.
  const globalSentinel = 'ORIGINAL_GLOBAL_CONTEXT_MUST_REMAIN_IN_CHILD'
  writeFileSync(join(root, 'AGENTS.md'), globalSentinel + '\n')
  mkdirSync(join(root, 'skills/global-sentinel'), { recursive: true })
  writeFileSync(join(root, 'skills/global-sentinel/SKILL.md'), `---\nname: global-sentinel\ndescription: ${globalSentinel}\n---\n${globalSentinel}\n`)
  const { ctx, capture } = await actualContext(root, { definitions, reaDefinition: reaDefinition(overrides('healthy')) })
  try {
    const parent = await createAgent(ctx, 'rea-parent', 'rea'); await turn(parent.agent)
    const parentStarts = started().length
    assert.equal(started().slice(count).filter(row => alive(row.pid)).length, 1)
    const { applyChildComposition, childSessionMeta, appendDelegatedPolicyOverrides, captureDelegatedPolicyOverrides } = await sdk('@deepseek-ai/dsh-subagent')
    async function delegated(id, toolFilter) {
      return ctx.agents.create({ sessionId: SessionId(id), parentAgent: parent.agent,
        meta: childSessionMeta(parent.agent, 1, false), agentOptions: { provider: 'fixture', model: 'fixture' },
        setup(childCtx, agent) {
          appendDelegatedPolicyOverrides(agent.session, captureDelegatedPolicyOverrides(parent.agent))
          applyChildComposition(childCtx, parent.agent, { toolFilter })
        },
      })
    }
    const child = await delegated('rea-child-default')
    await turn(child.agent)
    noRea(await snapshot(ctx, child.agent)); noRea(capture.requests.at(-1))
    writeFileSync(join(root, 'child-complete-first-request.json'), JSON.stringify(stableRequest(capture.requests.at(-1)), null, 2) + '\n')
    const adoptedGlobals = JSON.stringify(capture.requests.at(-1)).includes(globalSentinel)
    const denied = await execute(ctx, child.agent, 'mcp__rea__binary_session')
    assert(denied.isError || denied.error, 'child directly invoked parent REA tool')
    // Exercise the exported public child-composition toolFilter path, including
    // its own-layer exemption: a deferred bootstrap may not widen the filter.
    const explicit = await delegated('rea-child-filtered', { allow: [] })
    await turn(explicit.agent)
    assert.equal(reaTools(ctx, explicit.agent).length, 0)
    const filteredDenied = await execute(ctx, explicit.agent, 'mcp__rea__binary_session')
    assert(filteredDenied.isError)
    assert.equal(started().length, parentStarts, 'a child launched an additional MCP process')
    await explicit.dispose(); await child.dispose(); await parent.dispose()
    console.log('PASS child default MCP absence, public toolFilter denial and zero child process starts')
    assert(adoptedGlobals, 'REA installation removed original GLOBAL instructions/skills from the child')
  } finally {
    // Restore our temporary baseline sentinel before the remaining cases.
    writeFileSync(join(root, 'AGENTS.md'), '')
    writeFileSync(join(root, 'skills/global-sentinel/SKILL.md'), '')
    await ctx.fiber.dispose()
  }
})

for (const mode of ['fail', 'malformed']) await test(`${mode}: selected startup fail-closed, no partial tools/request/process leak`, async () => {
  const count = started().length
  const { ctx, capture } = await actualContext(root, { definitions, reaDefinition: reaDefinition(overrides(mode)) })
  try {
    const handle = await createAgent(ctx, `startup-${mode}`, 'rea')
    await deadline(turn(handle.agent), `${mode} bootstrap failure`)
    assert.equal(reaTools(ctx, handle.agent).length, 0)
    assert.equal(capture.requests.length, 0, 'model request escaped failed bootstrap')
    await handle.dispose()
    await until(() => started().slice(count).every(row => !alive(row.pid)), 'failed startup process release')
  } finally { await ctx.fiber.dispose() }
})
for (const mode of ['init-gated', 'list-gated']) await test(`${mode}: cancellation drains pending setup and blocks late publication`, async () => {
  const count = started().length
  const { ctx, capture } = await actualContext(root, { definitions, reaDefinition: reaDefinition(overrides(mode)) })
  try {
    const handle = await createAgent(ctx, `cancel-${mode}`, 'rea')
    const running = turn(handle.agent)
    await until(() => events().slice().some(row => row.mode === mode && row.event === (mode === 'init-gated' ? 'initialize' : 'tools/list')), 'fixture entered pending initialization')
    handle.agent.cancel({ kind: 'user' })
    await deadline(running, 'pending bootstrap cancellation', 5000)
    assert.equal(capture.requests.length, 0); assert.equal(reaTools(ctx, handle.agent).length, 0)
    await handle.dispose()
    await until(() => started().slice(count).every(row => !alive(row.pid)), 'canceled MCP physical exit')
  } finally { await ctx.fiber.dispose() }
})

await test('annotations/source helpers and actual approval pipeline coverage', async () => {
  const { ctx } = await actualContext(root, { definitions, reaDefinition: reaDefinition(overrides('healthy')) })
  try {
    const handle = await createAgent(ctx, 'approval-rea', 'rea'); await turn(handle.agent)
    const observed = []
    await ctx.plugin({ inject: ['tools'], apply(owner) {
      owner.on('tools/pre-execute', async (exec, next) => { observed.push(exec.name); return next() })
    } })
    for (const name of ['source_list', 'source_read', 'source_search', 'source_detect', 'binary_session']) {
      const tool = ctx.tools.get(`mcp__rea__${name}`, handle.agent)
      assert(tool, `source helper ${name} missing`)
      // The installed MCP bridge conservatively leaves all MCP tools exclusive;
      // readOnlyHint is not a host parallel-execution grant. Check source/read
      // authority through public effects + actual approval, not a fabricated
      // requirement to add an SDK isConcurrencySafe callback.
      const scheduling = ctx.tools.executionMode({ agent: handle.agent, name: tool.name, arguments: {} })
      assert(['exclusive', 'parallel'].includes(scheduling.kind))
      const result = await execute(ctx, handle.agent, `mcp__rea__${name}`)
      assert(!result.isError, JSON.stringify(result))
    }
    // Deny all approval requests through the real ApprovalService public event.
    const approval = []
    ctx.on('approval/request', async req => { approval.push(req.toolName); return 'rejected' })
    handle.agent.session.append('turn/start', { turn: 2 })
    const mutation = await execute(ctx, handle.agent, 'mcp__rea__fixture_mutation')
    const unknown = await execute(ctx, handle.agent, 'mcp__rea__fixture_unknown')
    assert(mutation.isError || mutation.error, 'destructive annotated call ran without approval')
    assert(unknown.isError || unknown.error, 'unannotated call ran without approval')
    assert(!events().some(row => row.event === 'tools/call' && ['fixture_mutation', 'fixture_unknown'].includes(row.name)), 'approval denial happened after dispatch')
    assert(observed.includes('mcp__rea__binary_session'), 'call bypassed DSH ToolRuntime policy pipeline')
    assert.deepEqual(approval, ['mcp__rea__fixture_mutation', 'mcp__rea__fixture_unknown'])
    const audit = handle.agent.session.snapshotEvents().filter(row => row.type.startsWith('approval/'))
    assert.equal(audit.filter(row => row.type === 'approval/asked').length, 2)
    assert.equal(audit.filter(row => row.type === 'approval/decided').length, 2)
    handle.agent.session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    await handle.dispose()
  } finally { await ctx.fiber.dispose() }
})

await test('consequential permissions: Read Only deny, Full allow, Workspace ask with real service', async () => {
  const { ctx } = await actualContext(root, { definitions, reaDefinition: reaDefinition(overrides('healthy')) })
  try {
    assert(ctx.get('permissionPresets'), 'real PermissionPresetService is absent')
    const handle = await createAgent(ctx, 'permissions-rea', 'rea'); await turn(handle.agent)
    const asked = []
    ctx.on('approval/request', async req => { asked.push(req.toolName); return 'rejected' })
    handle.agent.session.append('turn/start', { turn: 2 })
    ctx.permissionPresets.set(handle.agent.session, 'read-only')
    assert((await execute(ctx, handle.agent, 'mcp__rea__fixture_mutation')).isError)
    assert((await execute(ctx, handle.agent, 'mcp__rea__fixture_unknown')).isError)
    assert.equal(asked.length, 0, 'Read Only unexpectedly asked instead of denying')
    assert(!(await execute(ctx, handle.agent, 'mcp__rea__binary_session')).isError)
    ctx.permissionPresets.set(handle.agent.session, 'danger-full-access')
    assert(!(await execute(ctx, handle.agent, 'mcp__rea__fixture_mutation')).isError)
    assert(!(await execute(ctx, handle.agent, 'mcp__rea__fixture_unknown')).isError)
    assert.equal(asked.length, 0, 'Full Access unexpectedly asked')
    ctx.permissionPresets.set(handle.agent.session, 'workspace-write')
    assert((await execute(ctx, handle.agent, 'mcp__rea__fixture_mutation')).isError)
    assert.deepEqual(asked, ['mcp__rea__fixture_mutation'])
    handle.agent.session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    await handle.dispose()
  } finally { await ctx.fiber.dispose() }
})

const report = { runtimeRoot, presetRoot, root, nonReaPresets: definitions.map(row => row.id), results, processLedger: events() }
writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n')
console.log('Report:', join(root, 'report.json'))
if (results.some(row => row.status === 'FAIL')) process.exitCode = 1
if (process.env.REA_TEST_FILTER) console.log('DEBUG FILTER RUN: skipped cases are not acceptance passes')
