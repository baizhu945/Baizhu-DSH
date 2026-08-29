/**
 * Standalone Codex-compatible web.run extension for the Codex preset.
 *
 * The `web__run` implementation deliberately calls the same
 * `/backend-api/codex/alpha/search` backend used by current Luna Code Mode,
 * using the preset's existing OpenAI Codex OAuth credential. Responses Lite
 * does not accept the hosted `web_search` tool declaration. For non-Lite
 * catalog rows, this module supplies a small `ctx.web`-backed `web_search`
 * fallback only when the host has not already registered the standard DSH
 * tool (the headless profile already provides it).
 */
const createRequire = process.getBuiltinModule('node:module').createRequire
const fs = process.getBuiltinModule('node:fs/promises')
const nodeDns = process.getBuiltinModule('node:dns')
const nodeHttps = process.getBuiltinModule('node:https')
const nodePath = process.getBuiltinModule('node:path')
const { randomUUID } = process.getBuiltinModule('node:crypto')
const { pathToFileURL } = process.getBuiltinModule('node:url')
const dshHome = process.env.DSH_HOME ?? `${process.env.HOME ?? '/home/baizhu945'}/.dsh`
const requireFromDsh = createRequire(`${dshHome}/profiles/codex-web-search.cjs`)
const toolsEntry = requireFromDsh.resolve('@deepseek-ai/dsh-tools')
const { defineTool } = await import(toolsEntry)

// Reuse only the OAuth token refresh implementation. No dsh web provider is
// loaded, and the token file remains owned by the existing account plugin.
const piAiRoot = pathToFileURL(nodePath.join(dshHome, 'profiles/node_modules/@earendil-works/pi-ai') + '/')
const { openaiCodexOAuth } = await import(new URL('dist/auth/oauth/openai-codex.js', piAiRoot).href)

const CODEX_SEARCH_URL = 'https://chatgpt.com/backend-api/codex/alpha/search'
const SEARCH_TIMEOUT_MS = 60_000
const SEARCH_RETRY_BACKOFF_MS = [250, 1_000]
const REFRESH_SKEW_MS = 60_000
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024
const credentialFile = nodePath.join(dshHome, 'openai-codex-credentials.json')
const HOSTED_WEB_SEARCH = 'web_search'
const HOSTED_WEB_SEARCH_MAX_RESULTS = 8
const HOSTED_WEB_SEARCH_MAX_QUERIES = 4
const WEB_RUN_DESCRIPTION = (await fs.readFile(
  nodePath.join(dshHome, '.agent-presets/codex/codex-web-run-description.md'),
  'utf8',
)).trimEnd()
let refreshChain = Promise.resolve()

async function readCredential() {
  try {
    const raw = await fs.readFile(credentialFile, 'utf8')
    const value = JSON.parse(raw)
    return value !== null && typeof value === 'object' ? value : undefined
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

async function writeCredential(value) {
  await fs.mkdir(nodePath.dirname(credentialFile), { recursive: true, mode: 0o700 })
  const temporary = `${credentialFile}.web-search.${process.pid}.${randomUUID()}.tmp`
  let installed = false
  try {
    await fs.writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 })
    await fs.rename(temporary, credentialFile)
    installed = true
  } finally {
    if (!installed) {
      try { await fs.unlink(temporary) } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
    }
  }
}

function decodeJwtPayload(token) {
  const parts = token.split('.')
  if (parts.length !== 3 || parts[1] === '') return undefined
  try {
    const padded = parts[1]
      .replaceAll('-', '+')
      .replaceAll('_', '/')
      .padEnd(Math.ceil(parts[1].length / 4) * 4, '=')
    const value = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'))
    return value !== null && typeof value === 'object' ? value : undefined
  } catch {
    return undefined
  }
}

function accountIdFromToken(token) {
  const auth = decodeJwtPayload(token)?.['https://api.openai.com/auth']
  if (auth === null || typeof auth !== 'object') return undefined
  const accountId = auth.chatgpt_account_id
  return typeof accountId === 'string' && accountId.trim() !== '' ? accountId.trim() : undefined
}

function redact(text, secret) {
  return secret === undefined ? text : text.split(secret).join('[redacted]')
}

async function accessToken(signal) {
  if (signal.aborted) throw new Error('web.run was aborted')
  const credential = await readCredential()
  if (credential === undefined) {
    throw new Error('OpenAI Codex web search requires an OpenAI account login; run /openai-login first')
  }
  if (typeof credential.access !== 'string' || typeof credential.refresh !== 'string') {
    throw new Error('OpenAI Codex web search found invalid credentials; run /openai-login again')
  }
  if (typeof credential.expires === 'number' && credential.expires - Date.now() > REFRESH_SKEW_MS) {
    return {
      token: credential.access,
      accountId: typeof credential.accountId === 'string' ? credential.accountId : accountIdFromToken(credential.access),
    }
  }

  const refresh = async () => {
    const current = await readCredential()
    if (current === undefined || typeof current.access !== 'string' || typeof current.refresh !== 'string') {
      throw new Error('OpenAI Codex web search credentials disappeared; run /openai-login again')
    }
    if (typeof current.expires === 'number' && current.expires - Date.now() > REFRESH_SKEW_MS) {
      return {
        token: current.access,
        accountId: typeof current.accountId === 'string' ? current.accountId : accountIdFromToken(current.access),
      }
    }
    const refreshed = await openaiCodexOAuth.refresh(current)
    if (refreshed?.access === undefined || refreshed.refresh === undefined) {
      throw new Error('OpenAI Codex web search OAuth refresh returned incomplete credentials')
    }
    await writeCredential(refreshed)
    return {
      token: refreshed.access,
      accountId: typeof refreshed.accountId === 'string' ? refreshed.accountId : accountIdFromToken(refreshed.access),
    }
  }

  const currentRefresh = refreshChain.then(refresh, refresh)
  refreshChain = currentRefresh.then(() => undefined, () => undefined)
  return currentRefresh
}

function parseResponseEnvelope(body) {
  const trimmed = String(body).trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed)
    if (Array.isArray(parsed)) {
      return { output: parsed, answer: extractAnswer(parsed), sources: extractStructuredSources(parsed) }
    }
    const output = Array.isArray(parsed?.output) ? parsed.output : []
    const answer = typeof parsed?.output === 'string'
      ? parsed.output.trim()
      : typeof parsed?.output_text === 'string'
        ? parsed.output_text.trim()
        : typeof parsed?.answer === 'string'
          ? parsed.answer.trim()
          : extractAnswer(output)
    return {
      output,
      answer,
      sources: extractStructuredSources([parsed?.results, parsed?.sources, parsed?.citations]),
    }
  }

  const output = []
  const textParts = []
  let completedResponse
  let completedAnswer = ''
  for (const line of String(body).split('\n')) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (payload === '' || payload === '[DONE]') continue
    try {
      const event = JSON.parse(payload)
      if (event.type === 'response.output_item.done' && event.item !== undefined) output.push(event.item)
      if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') textParts.push(event.delta)
      if (event.type === 'response.output_text.done' && typeof event.text === 'string') completedAnswer = event.text
      if ((event.type === 'response.done' || event.type === 'response.completed') && event.response !== undefined) {
        completedResponse = event.response
      }
    } catch {
      // Ignore non-JSON SSE comments and partial provider diagnostics.
    }
  }
  const completedOutput = mergeOutputItems(
    output,
    Array.isArray(completedResponse?.output) ? completedResponse.output : [],
  )
  const answer = typeof completedResponse?.output === 'string'
    ? completedResponse.output.trim()
    : extractAnswer(completedOutput) || completedAnswer.trim() || textParts.join('').trim()
  return {
    output: completedOutput,
    answer,
    sources: extractStructuredSources([
      completedResponse?.results,
      completedResponse?.sources,
      completedResponse?.citations,
    ]),
  }
}

function parseResponseBody(body) {
  return parseResponseEnvelope(body).output
}

function mergeOutputItems(...groups) {
  const output = []
  const seen = new Set()
  for (const group of groups) {
    if (!Array.isArray(group)) continue
    for (const item of group) {
      let key
      if (item !== null && typeof item === 'object' && typeof item.id === 'string') key = 'id:' + item.id
      else {
        try { key = JSON.stringify(item) } catch { key = undefined }
      }
      if (key !== undefined && seen.has(key)) continue
      if (key !== undefined) seen.add(key)
      output.push(item)
    }
  }
  return output
}

function cleanSourceUrl(rawUrl) {
  try {
    const url = new URL(rawUrl)
    if (url.searchParams.get('utm_source') === 'openai') url.searchParams.delete('utm_source')
    return url.toString()
  } catch {
    return rawUrl.replace(/[?&]utm_source=openai$/, '')
  }
}

function snippetAround(text, start, end) {
  if (typeof start !== 'number' || typeof end !== 'number' || text === '') return ''
  const before = Math.max(0, start - 100)
  const after = Math.min(text.length, end + 100)
  const snippet = text.slice(before, after).replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim()
  return snippet.length > 300 ? `${snippet.slice(0, 297)}...` : snippet
}

function addSource(sources, byUrl, rawUrl, title, snippet = '') {
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') return
  const url = cleanSourceUrl(rawUrl)
  const existing = byUrl.get(url)
  if (existing !== undefined) {
    if (existing.title === undefined && typeof title === 'string' && title.trim() !== '') existing.title = title.trim()
    if (existing.snippet === undefined && snippet !== '') existing.snippet = snippet
    return
  }
  const source = {
    url,
    ...(typeof title === 'string' && title.trim() !== '' ? { title: title.trim() } : {}),
    ...(snippet !== '' ? { snippet } : {}),
  }
  byUrl.set(url, source)
  sources.push(source)
}

function extractAnswer(output) {
  const parts = []
  for (const item of output) {
    if (item?.type !== 'message' || !Array.isArray(item.content)) continue
    for (const part of item.content) {
      if (typeof part?.text === 'string' && part.text.trim() !== '') parts.push(part.text)
    }
  }
  return parts.join('\n').trim()
}

function extractSources(output) {
  const sources = []
  const byUrl = new Map()
  // Put URLs actually cited in the answer first, then fill the remainder with
  // the backend's search-source list. This matches Codex's user-facing order.
  for (const item of output) {
    if (item?.type !== 'message' || !Array.isArray(item.content)) continue
    for (const part of item.content) {
      if (!Array.isArray(part?.annotations) || typeof part.text !== 'string') continue
      for (const annotation of part.annotations) {
        if (annotation?.type !== 'url_citation') continue
        addSource(
          sources,
          byUrl,
          annotation.url,
          annotation.title,
          snippetAround(part.text, annotation.start_index, annotation.end_index),
        )
      }
    }
  }
  for (const item of output) {
    if (item?.type !== 'web_search_call') continue
    const action = item.action
    const groups = [action?.sources, item.sources, item.results]
    for (const group of groups) {
      if (!Array.isArray(group)) continue
      for (const source of group) {
        addSource(sources, byUrl, source?.url ?? source?.source_website_url, source?.title ?? source?.caption)
      }
    }
  }
  return sources
}

function extractStructuredSources(results) {
  const sources = []
  const byUrl = new Map()
  const visit = value => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    if (value === null || typeof value !== 'object') return
    const url = value.url ?? value.source_website_url ?? value.link
    if (typeof url === 'string') addSource(sources, byUrl, url, value.title ?? value.caption, value.snippet ?? value.description ?? '')
    for (const [key, child] of Object.entries(value)) {
      if (key === 'url' || key === 'source_website_url' || key === 'link' || key === 'title' || key === 'caption' || key === 'snippet' || key === 'description') continue
      visit(child)
    }
  }
  visit(results)
  return sources
}

function mergeSources(...groups) {
  const sources = []
  const byUrl = new Map()
  for (const group of groups) {
    if (!Array.isArray(group)) continue
    for (const source of group) addSource(sources, byUrl, source?.url, source?.title, source?.snippet ?? '')
  }
  return sources
}

function hostedSearchSource(source) {
  if (source === null || typeof source !== 'object' || Array.isArray(source) || typeof source.url !== 'string') return undefined
  return {
    url: source.url,
    ...(typeof source.title === 'string' ? { title: source.title } : {}),
    ...(typeof source.snippet === 'string' ? { snippet: source.snippet } : {}),
    ...(typeof source.publishedAt === 'string' ? { publishedAt: source.publishedAt } : {}),
  }
}

function hostedSearchOutput(result) {
  const parts = []
  if (typeof result.content === 'string' && result.content.length > 0) parts.push(result.content)
  if (result.sources.length > 0) {
    const lines = result.sources.map(source => {
      const label = sourceLabel(source)
      const metadata = []
      if (source.snippet !== undefined && source.snippet.length > 0) metadata.push(source.snippet)
      if (source.publishedAt !== undefined && source.publishedAt.length > 0) metadata.push(`(${source.publishedAt})`)
      return `- [${label}](${source.url})${metadata.length > 0 ? ` — ${metadata.join(' ')}` : ''}`
    })
    parts.push(`Sources:\n${lines.join('\n')}`)
  } else if (result.content === undefined || result.content.length === 0) {
    parts.push('No results found.')
  }
  if (result.truncated) parts.push(`(Showing the first ${result.sources.length} sources. Refine the query for more.)`)
  parts.push('Cite the relevant URLs above as markdown links in your answer.')
  return parts.join('\n\n')
}

function hostedSearchMeta(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const sources = Array.isArray(value.sources) ? value.sources.map(hostedSearchSource) : []
  if (sources.some(source => source === undefined) || typeof value.truncated !== 'boolean') return undefined
  if (value.content !== undefined && typeof value.content !== 'string') return undefined
  return {
    sources,
    truncated: value.truncated,
    ...(typeof value.content === 'string' ? { answer: value.content } : {}),
  }
}

function hostedSearchResultMeta(meta) {
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return undefined
  const sources = Array.isArray(meta.sources) ? meta.sources.map(hostedSearchSource) : []
  if (sources.some(source => source === undefined) || typeof meta.truncated !== 'boolean') return undefined
  if (meta.answer !== undefined && typeof meta.answer !== 'string') return undefined
  return {
    sources,
    truncated: meta.truncated,
    ...(typeof meta.answer === 'string' ? { answer: meta.answer } : {}),
  }
}

function hostedSearchQueries(args) {
  const queries = args.queries
  if (!Array.isArray(queries) || queries.length === 0) throw new Error('queries must contain at least one query')
  if (queries.length > HOSTED_WEB_SEARCH_MAX_QUERIES) throw new Error('queries must contain at most four queries')
  if (queries.some(query => typeof query !== 'string' || query.trim() === '')) {
    throw new Error('each query must be a non-empty string')
  }
  return [...new Set(queries)]
}

function mergeHostedSearchResults(queries, results) {
  const seen = new Set()
  const sources = []
  const sourceRanks = Math.max(0, ...results.map(result => result.sources.length))
  let droppedSource = false
  merge: for (let rank = 0; rank < sourceRanks; rank++) {
    for (const result of results) {
      const source = hostedSearchSource(result.sources[rank])
      if (source === undefined || seen.has(source.url)) continue
      seen.add(source.url)
      if (sources.length === HOSTED_WEB_SEARCH_MAX_RESULTS) {
        droppedSource = true
        break merge
      }
      sources.push(source)
    }
  }
  const contents = results.flatMap((result, index) => (
    typeof result.content === 'string' && result.content.length > 0
      ? [`### ${queries[index]}\n\n${result.content}`]
      : []
  ))
  return {
    ...(contents.length > 0 ? { content: contents.join('\n\n') } : {}),
    sources,
    truncated: results.some(result => result.truncated === true) || droppedSource,
  }
}

async function hostedWebSearch(ctx, args, exec) {
  const web = ctx.get('web')
  if (web === undefined || typeof web.search !== 'function') throw new Error('web_search provider is unavailable')
  const queries = hostedSearchQueries(args)
  const controller = new AbortController()
  const signal = AbortSignal.any([exec.signal, controller.signal])
  let firstError
  const results = []
  const searches = queries.map(async (query, index) => {
    try {
      results[index] = await web.search({ query, maxResults: HOSTED_WEB_SEARCH_MAX_RESULTS }, signal)
    } catch (error) {
      firstError ??= error
      controller.abort(error)
    }
  })
  await Promise.all(searches)
  if (firstError !== undefined) throw firstError
  return mergeHostedSearchResults(queries, results)
}

function registerHostedWebSearch(ctx) {
  if (ctx.tools.get(HOSTED_WEB_SEARCH) !== undefined || ctx.get('web') === undefined) return
  ctx.systemPrompt.section({
    name: 'tool:web_search',
    order: 110,
    text: 'Use the web_search tool to discover current information on the web. The required queries array accepts 1–4 non-empty search queries; use a one-item array for a single search. It returns an optional answer plus a list of source URLs. Cite the relevant URLs as markdown links.',
  })
  ctx.tools.register(defineTool({
    name: HOSTED_WEB_SEARCH,
    description: 'Search the web for current information. Provide 1–4 queries in the required queries array. Returns an optional summary answer and a list of source URLs.',
    parameters: {
      queries: {
        type: 'array',
        required: true,
        items: { type: 'string' },
        description: 'Required search queries; accepts 1–4 items and merges their results.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          content: { type: 'string' },
          sources: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                url: { type: 'string', required: true },
                title: { type: 'string' },
                snippet: { type: 'string' },
                publishedAt: { type: 'string' },
              },
            },
          },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: hostedSearchOutput(value) }],
      presentationMeta: (_args, value) => hostedSearchMeta(value),
    },
    timeoutMs: SEARCH_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      return hostedWebSearch(ctx, args, exec)
    },
    presentCall(args) {
      return { card: 'generic', title: args.queries.join(', '), kind: 'search', rawInput: args.queries.join(', ') }
    },
    presentResult(args, result) {
      if (result.isError) return undefined
      const meta = hostedSearchResultMeta(result.meta)
      if (meta === undefined) return undefined
      return {
        card: 'web',
        kind: 'search',
        title: args.queries.join(', '),
        sources: meta.sources,
        truncated: meta.truncated,
        ...(meta.answer === undefined ? {} : { answer: meta.answer }),
      }
    },
  }))
}

function searchCommands(args) {
  const commands = {}
  for (const key of [
    'search_query',
    'image_query',
    'open',
    'click',
    'find',
    'screenshot',
    'finance',
    'weather',
    'sports',
    'time',
    'response_length',
  ]) {
    if (args[key] !== undefined) commands[key] = args[key]
  }
  for (const key of ['search_query', 'image_query']) {
    if (Array.isArray(commands[key]) && commands[key].length > 4) {
      throw new Error(key + ' accepts at most four queries')
    }
  }
  return commands
}

function retryableSearchNetworkError(error) {
  const code = typeof error?.code === 'string' ? error.code : ''
  if (['ECONNRESET', 'ECONNABORTED', 'EPIPE', 'ETIMEDOUT', 'ENETRESET', 'EAI_AGAIN'].includes(code)) return true
  return /socket hang up|unexpected eof|network connection lost/i.test(String(error?.message ?? error))
}

function waitForSearchRetry(delayMs, signal) {
  if (delayMs <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    let timer
    let onAbort
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer)
      if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
    }
    const finish = (error) => {
      cleanup()
      if (error === undefined) resolve()
      else reject(error)
    }
    timer = setTimeout(() => finish(), delayMs)
    onAbort = () => finish(signal.reason ?? new Error('web.run was aborted'))
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * POST with a preset-local IPv4 lookup. Node's undici fetch may select the
 * unroutable IPv6 address on this host even though the same endpoint is
 * reachable over IPv4; using https.request keeps the workaround local to this
 * Codex web tool and does not mutate the dsh process-wide DNS policy.
 */
function requestCodexSearchAttempt(body, headers, signal, requestFactory, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false
    let timer
    let abort
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer)
      if (abort !== undefined) signal.removeEventListener('abort', abort)
    }
    const finish = (error, value) => {
      if (settled) return
      settled = true
      cleanup()
      if (error !== undefined) reject(error)
      else resolve(value)
    }
    const request = requestFactory(CODEX_SEARCH_URL, {
      method: 'POST',
      // Some gateways reset authenticated chunked POSTs. Make the body
      // length explicit and force a fresh connection so a stale keep-alive
      // socket cannot turn a transient reset into a tool failure.
      headers: {
        ...headers,
        'Content-Length': Buffer.byteLength(body),
        Connection: 'close',
      },
      agent: false,
      lookup(hostname, options, callback) {
        nodeDns.lookup(hostname, { ...options, family: 4 }, callback)
      },
    }, response => {
      const chunks = []
      let responseBytes = 0
      response.on('data', chunk => {
        const value = Buffer.from(chunk)
        responseBytes += value.byteLength
        if (responseBytes > MAX_RESPONSE_BYTES) {
          const error = new Error('OpenAI Codex web search response exceeded the size limit')
          response.destroy(error)
          finish(error)
          return
        }
        chunks.push(value)
      })
      response.on('error', error => finish(error))
      response.on('aborted', () => finish(new Error('OpenAI Codex web search response was aborted')))
      response.on('end', () => finish(undefined, {
        statusCode: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    request.on('error', error => finish(error))
    abort = () => {
      const reason = signal.reason
      const error = signal.aborted
        ? (reason instanceof Error ? reason : new Error(reason === undefined ? 'web.run was aborted' : String(reason)))
        : new Error('OpenAI Codex web search timed out')
      finish(error)
      try { request.destroy(error) } catch {
        // The request may already have synchronously closed while the abort
        // callback was racing its error event. `finish` owns the rejection.
      }
    }
    timer = setTimeout(abort, timeoutMs)
    if (signal.aborted) {
      abort()
      return
    }
    signal.addEventListener('abort', abort, { once: true })
    try {
      request.end(body)
    } catch (error) {
      finish(error)
      try { request.destroy(error) } catch {
        // Synchronous request implementations may throw before destroy.
      }
    }
  })
}

async function requestCodexSearch(body, headers, signal, requestFactory = nodeHttps.request) {
  const deadline = Date.now() + SEARCH_TIMEOUT_MS
  let attempt = 0
  const scheduleRetry = async () => {
    if (attempt >= SEARCH_RETRY_BACKOFF_MS.length) return false
    const remaining = deadline - Date.now()
    if (remaining <= 1) return false
    const delay = Math.min(SEARCH_RETRY_BACKOFF_MS[attempt], remaining - 1)
    attempt++
    await waitForSearchRetry(delay, signal)
    return true
  }
  while (true) {
    if (signal.aborted) throw signal.reason ?? new Error('web.run was aborted')
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error('OpenAI Codex web search timed out')
    try {
      const response = await requestCodexSearchAttempt(body, headers, signal, requestFactory, remaining)
      if (response.statusCode >= 500 && response.statusCode <= 599 && await scheduleRetry()) continue
      return response
    } catch (error) {
      if (!retryableSearchNetworkError(error) || !(await scheduleRetry())) throw error
    }
  }
}

async function searchCodex(commands, exec) {
  const agent = exec.agent
  if (agent === undefined) throw new Error('web.run requires a live agent')
  const auth = await accessToken(exec.signal)
  const headers = {
    Authorization: `Bearer ${auth.token}`,
    'Content-Type': 'application/json',
    'User-Agent': 'codex_cli_rs',
    originator: 'codex_cli_rs',
    ...(auth.accountId !== undefined ? { 'chatgpt-account-id': auth.accountId } : {}),
  }
  const response = await requestCodexSearch(JSON.stringify({
      id: String(agent.session.id ?? randomUUID()),
      model: agent.session.requestHeader?.()?.config?.model ?? agent.options.model ?? 'gpt-5.6-luna',
      commands,
      settings: {
        allowed_callers: ['direct'],
        external_web_access: true,
      },
      max_output_tokens: 10_000,
    }), headers, exec.signal)
  const body = response.body
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`OpenAI Codex web.run failed (HTTP ${response.statusCode}): ${redact(body.slice(0, 400), auth.token)}`)
  }
  let parsed
  try {
    parsed = parseResponseEnvelope(body)
  } catch (error) {
    throw new Error(`OpenAI Codex web.run returned invalid JSON: ${String(error)}`)
  }
  const answer = parsed.answer
  const allSources = mergeSources(extractSources(parsed.output), parsed.sources)
  if (answer === '' && allSources.length === 0) throw new Error('OpenAI Codex web search returned no answer or sources')
  if (answer !== '') return answer
  return allSources.map(source => `- [${sourceLabel(source)}](${source.url})`).join('\n')
}

function sourceLabel(source) {
  if (source.title !== undefined && source.title !== '') return source.title
  try {
    return new URL(source.url).hostname
  } catch {
    return source.url
  }
}

const SEARCH_QUERY = {
  type: 'object',
  additionalProperties: false,
  properties: {
    q: { type: 'string', required: true, description: 'Search query.' },
    recency: { type: 'integer', description: 'Whether to filter by recency, as a number of recent days.' },
    domains: { type: 'array', items: { type: 'string' }, description: 'Optional domain allowlist.' },
  },
}

const OPEN_OPERATION = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ref_id: { type: 'string', required: true, description: 'Reference id or URL to open.' },
    lineno: { type: 'integer', description: 'Line number to position the page at.' },
  },
}

const FINANCE_OPERATION = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ticker: { type: 'string', required: true, description: 'Ticker symbol to look up.' },
    type: { type: 'string', required: true, enum: ['equity', 'fund', 'crypto', 'index'], description: 'Asset type to look up.' },
    market: { type: 'string', description: 'ISO 3166-1 alpha-3 country code, OTC, or empty for cryptocurrency.' },
  },
}

const WEATHER_OPERATION = {
  type: 'object',
  additionalProperties: false,
  properties: {
    location: { type: 'string', required: true, description: 'Location in Country, Area, City format.' },
    start: { type: 'string', description: 'Start date in YYYY-MM-DD format. Defaults to today.' },
    duration: { type: 'integer', description: 'Number of days to return. Defaults to 7.' },
  },
}

const SPORTS_OPERATION = {
  type: 'object',
  additionalProperties: false,
  properties: {
    tool: { type: 'string', enum: ['sports'] },
    fn: { type: 'string', required: true, enum: ['schedule', 'standings'], description: 'Sports function to call.' },
    league: { type: 'string', required: true, enum: ['nba', 'wnba', 'nfl', 'nhl', 'mlb', 'epl', 'ncaamb', 'ncaawb', 'ipl'] },
    team: { type: 'string' },
    opponent: { type: 'string' },
    date_from: { type: 'string' },
    date_to: { type: 'string' },
    num_games: { type: 'integer' },
    locale: { type: 'string' },
  },
}

const TIME_OPERATION = {
  type: 'object',
  additionalProperties: false,
  properties: {
    utc_offset: { type: 'string', required: true, description: 'UTC offset formatted like +03:00.' },
  },
}

function webCallLabel(args) {
  return args.search_query?.[0]?.q
    ?? args.image_query?.[0]?.q
    ?? args.open?.[0]?.ref_id
    ?? 'web.run'
}

function webCallSummary(args) {
  const parts = []
  if (Array.isArray(args.search_query) && args.search_query.length > 0) parts.push(`Search: ${args.search_query.map(query => query.q).join(', ')}`)
  if (Array.isArray(args.image_query) && args.image_query.length > 0) parts.push(`Images: ${args.image_query.map(query => query.q).join(', ')}`)
  if (Array.isArray(args.open) && args.open.length > 0) parts.push(`Open: ${args.open.map(item => item.ref_id).join(', ')}`)
  if (Array.isArray(args.find) && args.find.length > 0) parts.push(`Find: ${args.find.map(item => `${item.ref_id} for ${item.pattern}`).join(', ')}`)
  if (args.response_length !== undefined) parts.push(`Response length: ${args.response_length}`)
  return parts.join('\n') || 'Internet search'
}

function registerWebSearch(ctx) {
  ctx.tools.register(defineTool({
    name: 'web__run',
    description: WEB_RUN_DESCRIPTION,
    parameters: {
      search_query: { type: 'array', items: SEARCH_QUERY, description: 'Search the internet for one to four queries.' },
      image_query: { type: 'array', items: SEARCH_QUERY, description: 'Search the internet for images.' },
      open: { type: 'array', items: OPEN_OPERATION, description: 'Open a URL or search reference.' },
      click: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ref_id: { type: 'string', required: true },
            id: { type: 'integer', required: true },
          },
        },
      },
      find: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ref_id: { type: 'string', required: true },
            pattern: { type: 'string', required: true },
          },
        },
      },
      screenshot: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ref_id: { type: 'string', required: true },
            pageno: { type: 'integer', required: true },
          },
        },
      },
      finance: { type: 'array', items: FINANCE_OPERATION },
      weather: { type: 'array', items: WEATHER_OPERATION },
      sports: { type: 'array', items: SPORTS_OPERATION },
      time: { type: 'array', items: TIME_OPERATION },
      response_length: { type: 'string', enum: ['short', 'medium', 'long'] },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs: SEARCH_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      return searchCodex(searchCommands(args), exec)
    },
    presentCall(args) {
      const label = webCallLabel(args)
      return { card: 'generic', title: label, kind: 'search', content: [{ type: 'text', text: webCallSummary(args) }] }
    },
    presentResult(_args, result) {
      const text = result.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('')
      return {
        card: 'generic',
        title: result.isError ? 'Web search failed' : 'Web search results',
        content: [{ type: 'text', text: text || (result.isError ? 'The web search failed without additional details.' : 'No web results returned.') }],
      }
    },
  }))
}

export const name = 'codex-web-search'
export const inject = ['tools', 'systemPrompt']

export function apply(ctx) {
  registerHostedWebSearch(ctx)
  registerWebSearch(ctx)
}

export { parseResponseBody, parseResponseEnvelope, searchCommands, requestCodexSearch as requestCodexSearchForTest }
