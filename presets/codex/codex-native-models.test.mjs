import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { BINARY, OFFICIAL_CATALOG, MANUAL_CATALOG, mockResponses, fixture,
  bareOfficial, modelFacing, toolDefinitions, assertBoundary } from './codex-native-models-support.mjs'

// node --test --test-concurrency=1 codex-native-models.test.mjs
// All GPT rows in the pinned official release, not a Luna-only synthetic catalog test.
// Actual native bridge + real DSH contracts versus independent bare official
// binary. Authless loopback Responses API only; every case is serial and <=20s.
const GPT_ROWS = [
  'gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna',
  'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna',
  'gpt-daybreak-blue-latest', 'gpt-daybreak-red-latest', 'gpt-5.5',
]
const CONTEXT_EXCEPTION_ROWS = new Set(GPT_ROWS.slice(0, 7))
const official = JSON.parse(await fs.readFile(OFFICIAL_CATALOG, 'utf8'))
const manual = JSON.parse(await fs.readFile(MANUAL_CATALOG, 'utf8'))
const historical = ['gpt-5.4', 'gpt-5.3-codex', 'gpt-5.2-codex', 'gpt-4.1', 'gpt-4o']
const alias = 'gpt-5.5-2026-10-03'
const namespaced = 'openai-codex/gpt-5.5'
const cases = [...GPT_ROWS, 'codex-auto-review', ...historical, alias, namespaced]
const fallbackPrompt = await fs.readFile(path.join(path.dirname(OFFICIAL_CATALOG), 'prompt.md'), 'utf8')
const prompt = 'Reply with the local fixture completion marker. Do not use tools or contact any external service.'

function capabilities(row) {
  // Record differences that must never be inherited from Luna by other models.
  const keys = ['tool_mode', 'use_responses_lite', 'apply_patch_tool_type', 'shell_type',
    'multi_agent_version', 'multi_agent_reasoning_effort', 'model_specialty',
    'default_verbosity', 'supports_parallel_tool_calls', 'node_repl_auto_review_required',
    'supports_reasoning_effort_updates', 'include_skills_usage_instructions',
    'include_apps_usage_instructions', 'include_plugin_usage_instructions',
    'experimental_supported_tools', 'input_modalities', 'supports_image_detail_original',
    'default_service_tier', 'context_window', 'max_context_window']
  return Object.fromEntries(keys.map(key => [key, row[key] ?? null]))
}

test('complete official release catalog; the only manual exception is seven context-window pairs', { timeout: 5000 }, () => {
  assert.ok(existsSync(BINARY), 'Exact pinned official binary is required (no simulated or skipped parity)')
  assert.ok(existsSync(path.join(path.dirname(BINARY), 'codex-code-mode-host')), 'Exact adjacent official V8 host is required')
  assert.deepEqual(official.models.filter(row => row.slug.startsWith('gpt-')).map(row => row.slug), GPT_ROWS)
  assert.deepEqual(official.models.map(row => row.slug), [...GPT_ROWS, 'codex-auto-review'])
  assert.deepEqual(manual.models.map(row => row.slug), official.models.map(row => row.slug))
  const normalizedManual = structuredClone(manual)
  for (const row of normalizedManual.models) {
    const upstream = official.models.find(candidate => candidate.slug === row.slug)
    if (CONTEXT_EXCEPTION_ROWS.has(row.slug)) {
      assert.equal(row.context_window, 1_050_000, `${row.slug}: documented manual context window`)
      assert.equal(row.max_context_window, 1_050_000, `${row.slug}: documented manual max context`)
      // Permission is exact and field-scoped; no prompt/tool/capability normalization.
      row.context_window = upstream.context_window
      row.max_context_window = upstream.max_context_window
    }
  }
  assert.deepEqual(normalizedManual, official, 'Any non-context catalog drift is forbidden')
  for (const model of historical) assert.ok(!official.models.some(row => row.slug === model), `${model} must exercise official unknown-model fallback`)
})

for (const model of cases) {
  test(`real model payload parity: ${model}`, { timeout: 20_000, concurrency: false }, async t => {
    const nativeMock = await mockResponses(t)
    const f = await fixture(t, nativeMock, model)
    const nativeOutcome = await f.collect(prompt)
    const nativeRequests = [...nativeMock.requests]
    // End the native process before starting the independent official baseline.
    // Both fresh threads use the EXACT same cwd/home/catalog/prompt/config and
    // authless HTTP provider URL. Meaningful roots/text need no normalization.
    await f.bridge.dispose()
    const officialOutcome = await bareOfficial(t, f, nativeMock, model, prompt)
    const officialRequests = nativeMock.requests.slice(nativeRequests.length)
    assertBoundary(nativeMock)
    assert.equal(nativeOutcome.status, officialOutcome.status, `${model}: official success/rejection outcome`)
    assert.equal(nativeRequests.length, officialRequests.length, `${model}: same wire admission; no illegal prompt fallback`)
    if (officialOutcome.status !== 'completed') {
      assert.equal(nativeRequests.length, 0, 'Unsupported models must not secretly acquire a Luna prompt/model request')
      assert.equal(nativeOutcome.error, officialOutcome.error, 'Same official rejection, not a harness/provider fallback error')
      t.diagnostic(`${model}: same official rejection; zero model requests: ${officialOutcome.error}`)
      return
    }
    assert.equal(nativeOutcome.text, 'LOCAL_MODEL_PARITY_OK', `${model}: real SSE parser/bridge completed`)
    assert.equal(nativeRequests.length, 1)
    const nativeBody = nativeRequests[0].body
    const bareBody = officialRequests[0].body
    assert.equal(nativeBody.model, model, 'Requested model slug survives, never substituted with Luna')
    assert.equal(bareBody.model, model)
    assert.deepEqual(modelFacing(nativeBody), modelFacing(bareBody), `${model}: exact model-visible payload, including instructions/developer messages/tools/grammar/reasoning/service tier`)
    const metadata = official.models.find(row => row.slug === model)
      ?? ([alias, namespaced].includes(model) ? official.models.find(row => row.slug === 'gpt-5.5') : undefined)
    const tools = toolDefinitions(nativeBody)
    const additionalTools = nativeBody.input.some(item => item.type === 'additional_tools')
    if (metadata) {
      assert.equal(additionalTools, metadata.use_responses_lite, `${model}: official ResponsesLite capability`)
      if (metadata.tool_mode === 'code_mode_only') {
        const exec = tools.find(tool => tool.name === 'exec')
        assert.equal(exec?.type, 'custom')
        assert.equal(exec?.format?.syntax, 'lark', `${model}: actual official CodeMode grammar`)
      } else {
        assert.ok(tools.some(tool => tool.name === 'exec_command'), `${model}: actual legacy official shell admission`)
        assert.ok(tools.some(tool => tool.name === 'apply_patch'), `${model}: actual legacy patch admission`)
      }
      t.diagnostic(`${model}: PASS exact payload; metadata=${metadata.slug}; capabilities=${JSON.stringify(capabilities(metadata))}`)
    } else {
      assert.ok(historical.includes(model))
      assert.equal(additionalTools, false, `${model}: official unknown-model fallback is not Luna ResponsesLite`)
      // Upstream renders the fallback against enabled tools (e.g. removes
      // update_plan guidance when that tool is unavailable). The COMPLETE
      // rendered text is already byte-compared with bareBody above.
      assert.ok(nativeBody.instructions.startsWith(fallbackPrompt.split('## Planning')[0]), `${model}: official generic fallback prefix, never Luna`)
      assert.equal(nativeBody.instructions, bareBody.instructions, `${model}: exact upstream-rendered fallback instructions`)
      assert.doesNotMatch(nativeBody.instructions, /You are Codex, an agent based on GPT-6/)
      assert.ok(tools.some(tool => tool.name === 'exec_command'), `${model}: official fallback UnifiedExec`)
      t.diagnostic(`${model}: PASS exact payload; official unknown-model fallback (ResponsesLite=false, UnifiedExec, upstream tool-aware prompt.md rendering)`)
    }
  })
}
