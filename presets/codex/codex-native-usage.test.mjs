import assert from 'node:assert/strict'
import test from 'node:test'
import { createNativeUsageCounter, NATIVE_USAGE_FIELD_METADATA } from './codex-native-usage.mjs'

const native = (inputTokens = 0, cachedInputTokens = 0, outputTokens = 0, extras = {}) => ({
  inputTokens, cachedInputTokens, outputTokens, totalTokens: inputTokens + outputTokens, ...extras,
})
const normalized = value => ({ ...value, cacheWriteInputTokens: value.cacheWriteInputTokens ?? 0,
  reasoningOutputTokens: value.reasoningOutputTokens ?? 0 })
const fresh = () => createNativeUsageCounter({ baseline: { total: native() } })
const append = (total, last) => Object.fromEntries(Object.keys(normalized(total))
  .map(field => [field, normalized(total)[field] + normalized(last)[field]]))
const expected = (inputTokens, cacheReadTokens, outputTokens, totalTokens) => ({ inputTokens,
  outputTokens, cacheReadTokens, ...(totalTokens === undefined ? {} : { totalTokens }) })

// These fixtures model native core element-wise addition, not a guessed billing
// formula. Custom totalTokens below deliberately differs from input + output.
test('metadata explicitly describes CLI-only native fields and inclusions', () => {
  assert.equal(NATIVE_USAGE_FIELD_METADATA.modelVisible, false)
  assert.match(NATIVE_USAGE_FIELD_METADATA.inputTokens, /minus cachedInputTokens/)
  assert.match(NATIVE_USAGE_FIELD_METADATA.outputTokens, /including reasoningOutputTokens/)
  assert.match(NATIVE_USAGE_FIELD_METADATA.totalTokens, /never inferred/)
  assert.equal(Object.isFrozen(NATIVE_USAGE_FIELD_METADATA), true)
})

test('unknown resume total establishes a baseline without billing historical last/total', () => {
  const counter = createNativeUsageCounter()
  assert.equal(counter.usage(), undefined)
  const past = native(9999, 8000, 1000, { reasoningOutputTokens: 100, cacheWriteInputTokens: 5 })
  const pastLast = native(240, 180, 20, { reasoningOutputTokens: 4 })
  assert.equal(counter.observe({ total: past, last: pastLast }), undefined)
  assert.deepEqual(counter.snapshot().total, normalized(past))
  const resumed = createNativeUsageCounter({ baseline: JSON.parse(JSON.stringify(counter.snapshot())) })
  assert.equal(resumed.observe({ total: past, last: pastLast }), undefined)
  const next = native(120, 70, 10, { reasoningOutputTokens: 2 })
  resumed.observe({ total: append(past, next), last: next })
  assert.deepEqual(resumed.usage(), expected(50, 70, 10, 130))
})

test('fresh zero baseline sums every model call, including identical-cost distinct calls', () => {
  const counter = fresh()
  let total = native()
  const calls = [native(100, 25, 10, { reasoningOutputTokens: 4, cacheWriteInputTokens: 5 }),
    native(240, 180, 20, { reasoningOutputTokens: 7 }), native(240, 180, 20, { reasoningOutputTokens: 7 })]
  for (const [index, last] of calls.entries()) {
    total = append(total, last)
    counter.observe({ total, last, modelContextWindow: index ? 1000000 : 272000 })
  }
  assert.deepEqual(counter.usage(), expected(195, 385, 50, 630))
  assert.deepEqual(counter.snapshot().total, normalized(total))
  assert.equal(counter.snapshot().total.reasoningOutputTokens, 18)
  assert.equal(counter.snapshot().total.cacheWriteInputTokens, 5)
})

test('raw prior info and full snapshots preserve all counters but not prior-turn usage', () => {
  const prior = native(1000, 500, 100, { totalTokens: 1107, cacheWriteInputTokens: 20, reasoningOutputTokens: 40 })
  const counter = createNativeUsageCounter({ baseline: { total: prior, last: native(1, 0, 1) } })
  const last = native(100, 80, 20, { totalTokens: 127, cacheWriteInputTokens: 3, reasoningOutputTokens: 4 })
  const info = { total: append(prior, last), last }
  counter.observe(info)
  assert.deepEqual(counter.usage(), expected(20, 80, 20, 127))
  const nextTurn = createNativeUsageCounter({ baseline: counter.snapshot() })
  assert.equal(nextTurn.observe(info), undefined)
  const next = native(10, 5, 2)
  nextTurn.observe({ total: append(info.total, next), last: next })
  assert.deepEqual(nextTurn.usage(), expected(5, 5, 2, 12))
})

test('identical repeated notifications, including older replay, never double count or regress baseline', () => {
  const counter = fresh()
  const a = { total: native(100, 25, 10), last: native(100, 25, 10) }
  const b = { total: native(340, 205, 30), last: native(240, 180, 20) }
  for (const info of [a, a, b, a, b, { ...b, modelContextWindow: 1000000 }]) counter.observe(info)
  assert.deepEqual(counter.usage(), expected(135, 205, 30, 370))
  assert.deepEqual(counter.snapshot().total, normalized(b.total))
})

test('local compaction response counts once; recomputed context last does not overwrite spending', () => {
  const counter = fresh()
  const first = native(100, 70, 10)
  const compact = native(50, 20, 5, { reasoningOutputTokens: 2 })
  let total = append(first, compact)
  counter.observe({ total: first, last: first })
  counter.observe({ total, last: compact })
  counter.observe({ total, last: native(0, 0, 0, { totalTokens: 42 }), modelContextWindow: 272000 })
  const followup = native(200, 140, 12)
  total = append(total, followup)
  counter.observe({ total, last: followup, modelContextWindow: 1000000 })
  assert.deepEqual(counter.usage(), expected(120, 230, 27, 377))
})

test('remote-v2 recompute without cumulative spend cannot fabricate compaction tokens', () => {
  const prior = native(1000, 700, 100)
  const counter = createNativeUsageCounter({ baseline: { total: prior } })
  counter.observe({ total: prior, last: native(0, 0, 0, { totalTokens: 91 }) })
  assert.deepEqual(counter.usage(), expected(0, 0, 0, 0))
  assert.equal(counter.snapshot().total.totalTokens, 1100)
  const actual = native(90, 70, 10)
  counter.observe({ total: append(prior, actual), last: actual })
  assert.deepEqual(counter.usage(), expected(20, 70, 10, 100))
})

test('fill_to_context_window counter reset rebases without billing a synthetic total estimate', () => {
  const counter = fresh()
  const first = native(100, 40, 10)
  counter.observe({ total: first, last: first })
  const filled = native(0, 0, 0, { totalTokens: 1000 })
  const fillInfo = { total: filled, last: native(0, 0, 0, { totalTokens: 890 }) }
  counter.observe(fillInfo)
  counter.observe(fillInfo)
  assert.deepEqual(counter.usage(), expected(60, 40, 10, 110))
  const next = native(25, 5, 4)
  counter.observe({ total: append(filled, next), last: next })
  assert.deepEqual(counter.usage(), expected(80, 45, 14, 139))
})

test('regressed totals use only explicit unseen last, then continue with the new epoch', () => {
  const counter = fresh()
  const first = native(100, 40, 10)
  const resetLast = native(20, 5, 3)
  counter.observe({ total: first, last: first })
  counter.observe({ total: resetLast, last: resetLast })
  counter.observe({ total: resetLast, last: resetLast })
  const next = native(10, 2, 1)
  counter.observe({ total: append(resetLast, next), last: next })
  assert.deepEqual(counter.usage(), expected(83, 47, 14, 144))
})

test('repeated explicit zero resets allow identical-cost completions in each new epoch', () => {
  const counter = fresh()
  const actual = native(100, 40, 10)
  const reset = { total: native(), last: native() }
  for (let epoch = 0; epoch < 3; epoch++) {
    counter.observe({ total: actual, last: actual })
    counter.observe({ total: actual, last: actual })
    counter.observe(reset)
    counter.observe(reset)
  }
  assert.deepEqual(counter.usage(), expected(180, 120, 30, 330))
})

test('reset without last rebases only; it does not pretend the reset total is new spending', () => {
  const counter = createNativeUsageCounter({ baseline: { total: native(1000, 700, 100) } })
  const reset = native(20, 10, 3)
  assert.equal(counter.observe({ total: reset }), undefined)
  const next = native(30, 10, 2)
  counter.observe({ total: append(reset, next), last: next })
  assert.deepEqual(counter.usage(), expected(20, 10, 2, 32))
})

test('last-only mocks sum distinct notifications, deduplicate repeats and persist fallback identities', () => {
  const counter = createNativeUsageCounter()
  const a = { last: native(100, 25, 10) }
  const b = { last: native(240, 180, 20, { reasoningOutputTokens: 4 }) }
  for (const info of [a, a, b, a, b]) counter.observe(info)
  assert.deepEqual(counter.usage(), expected(135, 205, 30, 370))
  assert.equal(counter.snapshot().total, null) // No fabricated cumulative total.
  const nextTurn = createNativeUsageCounter({ baseline: JSON.parse(JSON.stringify(counter.snapshot())) })
  assert.equal(nextTurn.observe(b), undefined)
  nextTurn.observe({ last: native(5, 0, 1) })
  assert.deepEqual(nextTurn.usage(), expected(5, 0, 1, 6))
})

test('last-only to first total bills only the explicit new last, not unrelated historical total', () => {
  const counter = createNativeUsageCounter()
  const a = native(100, 25, 10)
  const b = native(240, 180, 20)
  counter.observe({ last: a })
  const historical = native(9999, 8000, 1000)
  counter.observe({ total: historical, last: b })
  counter.observe({ total: historical, last: b })
  const c = native(20, 10, 3)
  counter.observe({ total: append(historical, c), last: c })
  assert.deepEqual(counter.usage(), expected(145, 215, 33, 393))
})

test('fallback increments reconcile exactly with later cumulative data, including snapshot resume', () => {
  const prior = native(1000, 500, 100)
  const counter = createNativeUsageCounter({ baseline: { total: prior } })
  const a = native(100, 25, 10)
  const b = native(240, 180, 20)
  counter.observe({ last: a })
  const resumed = createNativeUsageCounter({ baseline: counter.snapshot() })
  const total = append(append(prior, a), b)
  resumed.observe({ total, last: b })
  assert.deepEqual(resumed.usage(), expected(60, 180, 20, 260))
  counter.observe({ total, last: b })
  assert.deepEqual(counter.usage(), expected(135, 205, 30, 370))
})

test('inconsistent fallback/cumulative data rebases and trusts only explicit last, not arbitrary subtraction', () => {
  const counter = fresh()
  const a = native(100, 25, 10)
  counter.observe({ last: a })
  const b = native(5, 1, 1)
  counter.observe({ total: native(10, 2, 2), last: b })
  assert.deepEqual(counter.usage(), expected(79, 26, 11, 116))
})

test('missing native totals stay unknown; cached/reasoning counts are not added again', () => {
  const counter = createNativeUsageCounter()
  const a = native(100, 40, 20, { reasoningOutputTokens: 5, cacheWriteInputTokens: 7 })
  delete a.totalTokens
  counter.observe({ last: a })
  counter.observe({ last: native(10, 5, 2) })
  assert.deepEqual(counter.usage(), expected(65, 45, 22))
  assert.equal(Object.hasOwn(counter.usage(), 'totalTokens'), false)
})

test('native authoritative totals are not replaced by invented input/output arithmetic', () => {
  const counter = fresh()
  const last = native(100, 40, 20, { totalTokens: 137 })
  counter.observe({ total: last, last })
  assert.deepEqual(counter.usage(), expected(60, 40, 20, 137))
})

test('negative, fractional, nonnumeric, nonfinite and unsafe counters are ignored', () => {
  for (const bad of [-1, 1.5, '10', null, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    for (const field of ['inputTokens', 'outputTokens', 'cachedInputTokens', 'reasoningOutputTokens', 'cacheWriteInputTokens', 'totalTokens']) {
      const counter = fresh()
      const invalid = native(100, 40, 20, { [field]: bad })
      assert.equal(counter.observe({ total: invalid, last: invalid }), undefined, `${field}: ${bad}`)
      assert.deepEqual(counter.snapshot().total, normalized(native()))
    }
  }
  for (const invalid of [native(10, 11, 2), native(10, 0, 2, { reasoningOutputTokens: 3 }), {}, null, undefined]) {
    assert.equal(fresh().observe({ total: invalid, last: invalid }), undefined)
  }
})

test('invalid baseline is unknown rather than silently zero and historical spend is not charged', () => {
  const counter = createNativeUsageCounter({ baseline: { total: native(-1), pending: native(1) } })
  assert.equal(counter.observe({ total: native(9999, 8000, 1000), last: native(240, 180, 20) }), undefined)
})

test('aggregate overflow cannot produce unsafe, infinite or negative output', () => {
  const counter = createNativeUsageCounter()
  counter.observe({ last: native(Number.MAX_SAFE_INTEGER, 0, 0, { totalTokens: Number.MAX_SAFE_INTEGER }) })
  counter.observe({ last: native(1, 0, 1) })
  assert.deepEqual(counter.usage(), expected(Number.MAX_SAFE_INTEGER, 0, 0, Number.MAX_SAFE_INTEGER))
  assert.equal(Object.values(counter.usage()).every(value => Number.isSafeInteger(value) && value >= 0), true)
})

test('counter does not mutate caller data and returned objects do not alias internal state', () => {
  const counter = fresh()
  const info = { total: Object.freeze(native(100, 25, 10)), last: Object.freeze(native(100, 25, 10)) }
  counter.observe(Object.freeze(info))
  const snapshot = counter.snapshot()
  snapshot.total.inputTokens = -100
  snapshot.last.inputTokens = -100
  snapshot.lastOnly[0].inputTokens = -100
  snapshot.seen[0].total.inputTokens = -100
  const usage = counter.usage()
  usage.inputTokens = -100
  assert.deepEqual(counter.usage(), expected(75, 25, 10, 110))
  assert.equal(counter.snapshot().total.inputTokens, 100)
})
