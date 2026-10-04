// Audited against openai/codex 86a54b051c08f34f373c507ae16a91915ab08700:
// protocol/src/protocol.rs: TokenUsageInfo::append_last_usage adds all six
// counters; app-server-protocol/src/protocol/v2/thread.rs forwards them unchanged.
// core/src/session/mod.rs: recompute_token_usage changes LAST, not TOTAL.
// fill_to_context_window is an exception: it replaces TOTAL with a context
// estimate and zeros the spending counters. Never bill that estimate.

export const NATIVE_USAGE_FIELD_METADATA = Object.freeze({
  source: 'Codex app-server thread/tokenUsage/updated',
  modelVisible: false, // Host/CLI telemetry only; never a prompt or tool result.
  inputTokens: 'Non-cached input: native inputTokens minus cachedInputTokens.',
  cacheReadTokens: 'Native cachedInputTokens; already included in native inputTokens.',
  outputTokens: 'Native outputTokens, including reasoningOutputTokens (not added again).',
  totalTokens: 'Reported native totalTokens only, including cached input; never inferred from other fields.',
  cacheWriteInputTokens: 'Retained in the native baseline; not added again to DSH inputTokens.',
  reasoningOutputTokens: 'Retained in the native baseline; a subset of outputTokens.',
})

const FIELDS = ['inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens',
  'outputTokens', 'reasoningOutputTokens', 'totalTokens']
const SPENDING_FIELDS = FIELDS.slice(0, -1)
const count = value => Number.isSafeInteger(value) && value >= 0
const zero = () => Object.fromEntries(FIELDS.map(field => [field, 0]))
const copy = value => value ? { ...value } : null
const fingerprint = value => JSON.stringify(value)

// Missing optional detail counters are zero (older native versions/mocks).
// Missing totalTokens is UNKNOWN, not input + output. Invalid supplied counts
// invalidate that breakdown rather than contaminating the persisted baseline.
function breakdown(value) {
  if (!value || typeof value !== 'object' || !count(value.inputTokens) || !count(value.outputTokens)) return null
  const result = {}
  for (const field of FIELDS) {
    if (field === 'totalTokens' && value[field] === undefined) continue
    const n = value[field] === undefined && field !== 'totalTokens' ? 0 : value[field]
    if (!count(n)) return null
    result[field] = n
  }
  if (result.cachedInputTokens > result.inputTokens || result.reasoningOutputTokens > result.outputTokens) return null
  return result
}

function realUsage(value) {
  return value && (SPENDING_FIELDS.some(field => value[field] > 0) || value.totalTokens === 0)
}

function subtract(after, before) {
  const delta = {}
  for (const field of SPENDING_FIELDS) {
    if (after[field] < before[field]) return null // Reset, not negative spending.
    delta[field] = after[field] - before[field]
  }
  if (after.totalTokens !== undefined && before.totalTokens !== undefined) {
    if (after.totalTokens < before.totalTokens) return null
    delta.totalTokens = after.totalTokens - before.totalTokens
  }
  if (delta.cachedInputTokens > delta.inputTokens || delta.reasoningOutputTokens > delta.outputTokens) return null
  return delta
}

/**
 * One DSH turn's usage, plus a JSON-safe baseline for the next turn/journal.
 *
 * baseline accepts a snapshot() or an app-server ThreadTokenUsage {total,last}.
 * Without a known baseline, the first TOTAL establishes one WITHOUT billing
 * past spending. For a proven fresh thread supply {total:{inputTokens:0,
 * cachedInputTokens:0,outputTokens:0,totalTokens:0}}. Recreate from snapshot()
 * at the DSH turn boundary, not between native tool calls/compaction/model changes.
 *
 * observe takes params.tokenUsage (not the notification envelope). LAST-only
 * sources are a conservative compatibility fallback: identical count vectors
 * cannot distinguish duplicate notifications from distinct equal-cost calls.
 * They are counted once. Cumulative TOTAL distinguishes those calls exactly.
 *
 * This cannot recover usage absent from ThreadTokenUsage. In the audited source,
 * remote-v2 compaction records raw response usage but does not append it to TOTAL;
 * its subsequent last.totalTokens context estimate is NOT spending.
 */
export function createNativeUsageCounter({ baseline } = {}) {
  let total = breakdown(baseline?.total)
  let last = breakdown(baseline?.last)
  let pending = baseline?.version === 1 ? breakdown(baseline.pending) : null
  const seenLast = new Set()
  const seenInfo = new Set()
  if (baseline?.version === 1) {
    for (const value of Array.isArray(baseline.lastOnly) ? baseline.lastOnly : []) {
      const parsed = breakdown(value)
      if (parsed) seenLast.add(fingerprint(parsed))
    }
    for (const value of Array.isArray(baseline.seen) ? baseline.seen : []) {
      const parsedTotal = breakdown(value?.total)
      const parsedLast = breakdown(value?.last)
      if (parsedTotal) seenInfo.add(fingerprint([parsedTotal, parsedLast]))
    }
  }
  if (last) seenLast.add(fingerprint(last))
  if (total) seenInfo.add(fingerprint([total, last]))
  let sum = zero()
  let observed = false
  let totalKnown = true

  function add(value) {
    if (!realUsage(value)) return false // Exclude synthetic context estimates.
    if (!FIELDS.every(field => Number.isSafeInteger(sum[field] + (value[field] ?? 0)))) return false
    for (const field of FIELDS) sum[field] += value[field] ?? 0
    totalKnown &&= value.totalTokens !== undefined
    observed = true
    return true
  }

  function addLast(value, trackPending = false) {
    if (!value || seenLast.has(fingerprint(value))) return
    seenLast.add(fingerprint(value))
    if (!add(value) || !trackPending) return
    const next = pending ?? zero()
    if (!FIELDS.every(field => Number.isSafeInteger(next[field] + (value[field] ?? 0)))) {
      // Insufficient evidence to reconcile a later cumulative update safely.
      total = null
      pending = null
      return
    }
    const reportedTotal = next.totalTokens !== undefined && value.totalTokens !== undefined
    for (const field of FIELDS) next[field] = (next[field] ?? 0) + (value[field] ?? 0)
    if (!reportedTotal) delete next.totalTokens
    pending = next
  }

  function usage() {
    if (!observed) return undefined
    return { inputTokens: sum.inputTokens - sum.cachedInputTokens,
      outputTokens: sum.outputTokens, cacheReadTokens: sum.cachedInputTokens,
      ...(totalKnown ? { totalTokens: sum.totalTokens } : {}) }
  }

  function observe(info) {
    const next = breakdown(info?.total)
    const latest = breakdown(info?.last)
    if (!next) {
      addLast(latest, true)
      if (latest) last = latest
      return usage()
    }
    const key = fingerprint([next, latest])
    // A zero-spending reset marker may recur after a new epoch has spent tokens.
    // It still must rebase; an old positive-spending replay is only a duplicate.
    const resetMarker = total && !SPENDING_FIELDS.some(field => next[field] > 0)
      && SPENDING_FIELDS.some(field => total[field] > 0)
    if (seenInfo.has(key) && !resetMarker) return usage()
    let delta = total ? subtract(next, total) : null
    if (total && !delta) {
      // New epoch: a later equal-cost response is not a duplicate from before
      // the reset. Preserve already accumulated DSH-turn usage, not dedup keys.
      seenInfo.clear()
      seenLast.clear()
    }
    seenInfo.add(key)
    if (!total) {
      // A fallback already observed live completions. Count only the explicit
      // new LAST here; an unrelated/past cumulative total proves no increment.
      if (pending) addLast(latest)
    } else {
      if (delta && pending) {
        const remainder = subtract(delta, pending)
        // No guessing about overlapping epochs/partial notifications. If the
        // explicit fallback does not fit the cumulative increment, rebase and
        // use only an unseen LAST rather than fabricate a large total delta.
        delta = remainder
      }
      if (delta) add(delta)
      else addLast(latest)
    }
    total = next
    pending = null
    if (latest) {
      last = latest
      seenLast.add(fingerprint(latest))
    }
    return usage()
  }

  function snapshot() {
    return { version: 1, total: copy(total), last: copy(last), pending: copy(pending),
      lastOnly: [...seenLast].map(value => JSON.parse(value)),
      seen: [...seenInfo].map(value => {
        const [total, last] = JSON.parse(value)
        return { total, last }
      }) }
  }

  return { observe, usage, snapshot }
}
