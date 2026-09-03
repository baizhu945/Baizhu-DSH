/**
 * Provider-independent web search for the normal DSH Web profile.
 *
 * This is the DSH adapter for OpenCode's local web-search design. The model
 * still calls DSH's native `web_search` tool; this plugin only implements the
 * provider behind `ctx.web`. Search is therefore independent of the chat
 * provider and never sends the selected model's API key to a second vendor.
 *
 * OpenCode selects one provider per session and calls its MCP HTTP endpoint:
 * Exa's `web_search_exa` or Parallel's `web_search`. Both endpoints work
 * without a key. Optional EXA_API_KEY/PARALLEL_API_KEY values are forwarded in
 * the same way as OpenCode when the user supplies them.
 */
import { WebError } from '@deepseek-ai/dsh-web'

export const name = 'dsh-web-search-keyless'
export const inject = ['web', 'agents']
export const PROVIDER_ID = 'simple-search'

export const EXA_MCP_URL = 'https://mcp.exa.ai/mcp'
export const PARALLEL_MCP_URL = 'https://search.parallel.ai/mcp'
export const EXA_PROVIDER = 'exa'
export const PARALLEL_PROVIDER = 'parallel'

const DEFAULT_MAX_RESULTS = 8
const MAX_RESULTS = 20
const SEARCH_TIMEOUT_MS = 25_000
const MAX_RESPONSE_BYTES = 256 * 1024
const MAX_ERROR_BYTES = 32 * 1024
const MAX_SNIPPET_CHARS = 4_000
const MAX_CONTENT_CHARS = 50_000
const USER_AGENT = 'deepseek-harness/0.1.2-alpha.3'

function errorText(error) {
  const text = error instanceof Error ? error.message : String(error)
  return text.replaceAll(/\s+/g, ' ').trim().slice(0, 240)
}

function optionalText(value, maxChars = MAX_SNIPPET_CHARS) {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (text === '') return undefined
  return text.length > maxChars ? `${text.slice(0, maxChars - 3)}...` : text
}

function sourceUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  try {
    const url = new URL(value.trim())
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    return url.toString()
  } catch {
    return undefined
  }
}

function maxResults(value) {
  if (!Number.isFinite(value)) return DEFAULT_MAX_RESULTS
  return Math.max(1, Math.min(MAX_RESULTS, Math.floor(value)))
}

function isTruthy(name) {
  return /^(1|true|yes|on)$/i.test(process.env[name]?.trim() ?? '')
}

function checksum(value) {
  if (typeof value !== 'string' || value === '') return undefined
  // This is OpenCode's checksum implementation: FNV-1a over UTF-16 code
  // units, rendered in base36. Keeping it identical makes provider choice
  // stable for a resumed session and comparable across the two applications.
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

/** Select the same stable, provider-independent route as OpenCode. */
export function selectSearchProvider(sessionId) {
  const override = process.env.DSH_WEB_SEARCH_BACKEND?.trim()
    || process.env.OPENCODE_WEBSEARCH_PROVIDER?.trim()
  if (override === EXA_PROVIDER || override === PARALLEL_PROVIDER) return override

  if (isTruthy('DSH_WEB_SEARCH_PREFER_PARALLEL')
    || isTruthy('OPENCODE_ENABLE_PARALLEL')
    || isTruthy('OPENCODE_EXPERIMENTAL_PARALLEL')) return PARALLEL_PROVIDER
  if (isTruthy('DSH_WEB_SEARCH_PREFER_EXA')
    || isTruthy('OPENCODE_ENABLE_EXA')
    || isTruthy('OPENCODE_EXPERIMENTAL_EXA')) return EXA_PROVIDER

  return Number.parseInt(checksum(sessionId) ?? '0', 36) % 2 === 0
    ? EXA_PROVIDER
    : PARALLEL_PROVIDER
}

function activeAgent(ctx) {
  try {
    return ctx.get('agents')?.currentInitiator()
  } catch {
    return undefined
  }
}

function activeSessionContext(ctx) {
  const agent = activeAgent(ctx)
  const sessionId = typeof agent?.id === 'string' && agent.id !== '' ? agent.id : 'dsh-anonymous'
  let route = agent?.options
  try {
    route = agent?.session?.requestHeader?.()?.config ?? route
  } catch {
    // An agentless/direct seam call has no request header; use its defaults.
  }
  return {
    sessionId,
    ...typeof route?.model === 'string' && route.model !== '' ? { modelName: route.model } : {},
  }
}

function exaUrl() {
  const url = new URL(EXA_MCP_URL)
  const apiKey = process.env.EXA_API_KEY?.trim()
  if (apiKey !== undefined && apiKey !== '') url.searchParams.set('exaApiKey', apiKey)
  return url.toString()
}

function parallelHeaders() {
  const headers = { 'User-Agent': USER_AGENT }
  const apiKey = process.env.PARALLEL_API_KEY?.trim()
  return apiKey === undefined || apiKey === ''
    ? headers
    : { ...headers, Authorization: `Bearer ${apiKey}` }
}

function jsonRpcRequest(tool, args) {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: tool, arguments: args },
  }
}

/**
 * Parse the MCP response shape used by OpenCode. Exa normally answers as SSE,
 * while Parallel normally answers as one JSON document; accepting both is
 * important because either endpoint may switch transports at the edge.
 */
export function parseMcpResponse(body) {
  function parsePayload(payload) {
    const trimmed = payload.trim()
    if (!trimmed.startsWith('{')) return undefined
    let parsed
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      return undefined
    }
    if (parsed?.error !== undefined) {
      throw new Error(parsed.error?.message ?? 'MCP web search returned an error')
    }
    const content = parsed?.result?.content
    if (!Array.isArray(content)) return undefined
    return content.find(item => typeof item?.text === 'string' && item.text.trim() !== '')?.text
  }

  const direct = parsePayload(String(body).trim())
  if (direct !== undefined) return direct

  for (const line of String(body).split(/\r?\n/)) {
    if (!line.startsWith('data: ')) continue
    const data = parsePayload(line.slice(6))
    if (data !== undefined) return data
  }
  return undefined
}

async function readBoundedText(response, maxBytes) {
  if (response.body === null) {
    const text = await response.text()
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new Error(`response exceeded ${maxBytes} bytes`)
    }
    return text
  }

  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        throw new Error(`response exceeded ${maxBytes} bytes`)
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

function requestSignal(parentSignal) {
  const timeoutController = new AbortController()
  const timer = setTimeout(() => timeoutController.abort(), SEARCH_TIMEOUT_MS)
  const signal = parentSignal === undefined
    ? timeoutController.signal
    : AbortSignal.any([parentSignal, timeoutController.signal])
  return {
    signal,
    timedOut: () => timeoutController.signal.aborted,
    dispose: () => clearTimeout(timer),
  }
}

function withStatus(error, statusCode) {
  error.statusCode = statusCode
  return error
}

async function responseDetail(response) {
  try {
    const text = await readBoundedText(response, MAX_ERROR_BYTES)
    if (text.trim() === '') return `HTTP ${response.status}`
    try {
      const parsed = JSON.parse(text)
      return optionalText(parsed?.error?.message ?? parsed?.message ?? parsed?.detail, 240)
        ?? `HTTP ${response.status}`
    } catch {
      return `HTTP ${response.status}: ${text.replaceAll(/\s+/g, ' ').trim().slice(0, 240)}`
    }
  } catch {
    return `HTTP ${response.status}`
  }
}

async function callMcp({ url, tool, args, headers = {}, signal }) {
  const request = requestSignal(signal)
  try {
    let response
    try {
      response = await fetch(url, {
        method: 'POST',
        redirect: 'error',
        headers: {
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
          ...headers,
        },
        body: JSON.stringify(jsonRpcRequest(tool, args)),
        signal: request.signal,
      })
    } catch (error) {
      if (signal?.aborted === true) {
        throw new WebError('web search aborted', 'WEB_ABORTED', { cause: error })
      }
      if (request.timedOut()) {
        throw new WebError(`${tool} request timed out after ${SEARCH_TIMEOUT_MS / 1000} seconds`, 'WEB_PROVIDER_ERROR', { cause: error })
      }
      throw new WebError(`${tool} search request failed: ${errorText(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }

    if (!response.ok) {
      throw withStatus(
        new WebError(`${tool} search failed: ${await responseDetail(response)}`, 'WEB_PROVIDER_ERROR'),
        response.status,
      )
    }

    const body = await readBoundedText(response, MAX_RESPONSE_BYTES)
    const text = parseMcpResponse(body)
    if (text === undefined) throw new Error('MCP response contained no text result')
    return text
  } catch (error) {
    if (signal?.aborted === true) {
      throw new WebError('web search aborted', 'WEB_ABORTED', { cause: error })
    }
    if (error instanceof WebError) throw error
    if (request.timedOut()) {
      throw new WebError(`${tool} request timed out after ${SEARCH_TIMEOUT_MS / 1000} seconds`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
    throw new WebError(`${tool} search returned invalid content: ${errorText(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
  } finally {
    request.dispose()
  }
}

function addSource(sources, byUrl, rawUrl, rawTitle, rawSnippet, rawPublishedAt) {
  const url = sourceUrl(rawUrl)
  if (url === undefined) return
  const title = optionalText(rawTitle, 500)
  const snippet = optionalText(rawSnippet)
  const publishedAt = optionalText(rawPublishedAt, 120)
  const existing = byUrl.get(url)
  if (existing !== undefined) {
    if (existing.title === undefined && title !== undefined) existing.title = title
    if (existing.snippet === undefined && snippet !== undefined) existing.snippet = snippet
    if (existing.publishedAt === undefined && publishedAt !== undefined) existing.publishedAt = publishedAt
    return
  }
  const source = {
    url,
    ...title === undefined ? {} : { title },
    ...snippet === undefined ? {} : { snippet },
    ...publishedAt === undefined ? {} : { publishedAt },
  }
  byUrl.set(url, source)
  sources.push(source)
}

function result(sources, content) {
  return {
    ...content === undefined ? {} : { content },
    sources,
    truncated: false,
  }
}

function labelledSection(block, label) {
  const lines = block.split(/\r?\n/)
  const index = lines.findIndex(line => line.trim() === `${label}:`)
  if (index === -1) return undefined
  const end = lines.slice(index + 1).findIndex(line => /^---\s*$/.test(line) || /^Title:\s/.test(line))
  const body = end === -1 ? lines.slice(index + 1) : lines.slice(index + 1, index + 1 + end)
  return body.join('\n').trim() || undefined
}

/** Convert Exa's textual MCP result into DSH's structured source shape. */
export function mapExaText(text) {
  const sources = []
  const byUrl = new Map()
  const blocks = String(text).split(/(?=^Title:\s)/m).filter(block => block.trim() !== '')
  for (const block of blocks) {
    addSource(
      sources,
      byUrl,
      block.match(/^URL:\s*(.+)$/m)?.[1],
      block.match(/^Title:\s*(.+)$/m)?.[1],
      labelledSection(block, 'Text') ?? labelledSection(block, 'Highlights'),
      block.match(/^Published:\s*(.+)$/m)?.[1],
    )
  }
  return result(sources, sources.length === 0 ? optionalText(text, MAX_CONTENT_CHARS) : undefined)
}

/** Convert Parallel's JSON-in-MCP-text result into DSH's structured shape. */
export function mapParallelText(text) {
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    return undefined
  }
  if (payload === null || typeof payload !== 'object') return undefined

  const sources = []
  const byUrl = new Map()
  const hits = Array.isArray(payload.results) ? payload.results : []
  for (const hit of hits) {
    if (hit === null || typeof hit !== 'object') continue
    const excerpts = Array.isArray(hit.excerpts)
      ? hit.excerpts.filter(item => typeof item === 'string').join('\n\n')
      : undefined
    addSource(
      sources,
      byUrl,
      hit.url ?? hit.link,
      hit.title,
      excerpts ?? hit.snippet ?? hit.description,
      hit.publish_date ?? hit.publishedAt,
    )
  }
  const content = optionalText(
    typeof payload.answer === 'string'
      ? payload.answer
      : typeof payload.summary === 'string'
        ? payload.summary
        : typeof payload.content === 'string' ? payload.content : undefined,
    MAX_CONTENT_CHARS,
  )
  if (sources.length === 0 && content === undefined && !Array.isArray(payload.results)) return undefined
  return result(sources, content)
}

/** Map either OpenCode search backend's inner MCP text to the DSH seam. */
export function mapSearchText(text) {
  const parallel = mapParallelText(text)
  if (parallel !== undefined) return parallel
  return mapExaText(text)
}

async function searchExa(request, signal) {
  const text = await callMcp({
    url: exaUrl(),
    tool: 'web_search_exa',
    args: {
      query: request.query,
      type: 'auto',
      numResults: maxResults(request.maxResults),
      livecrawl: 'fallback',
    },
    signal,
  })
  return mapSearchText(text)
}

async function searchParallel(request, signal, context) {
  const text = await callMcp({
    url: PARALLEL_MCP_URL,
    tool: 'web_search',
    args: {
      objective: request.query,
      search_queries: [request.query],
      session_id: context.sessionId,
      ...context.modelName === undefined ? {} : { model_name: context.modelName },
    },
    headers: parallelHeaders(),
    signal,
  })
  return mapSearchText(text)
}

async function search(request, signal, ctx) {
  const context = activeSessionContext(ctx)
  const provider = selectSearchProvider(context.sessionId)
  // OpenCode intentionally selects exactly one route per session. Do not make
  // backend order a hidden priority chain: a failure is surfaced as the
  // provider error, while the next tool call can be retried by the model.
  return provider === EXA_PROVIDER
    ? searchExa(request, signal)
    : searchParallel(request, signal, context)
}

export function apply(ctx) {
  ctx.web.registerSearchProvider({
    id: PROVIDER_ID,
    // Both MCP services have a keyless public route, so availability must not
    // be coupled to the selected chat model or any vendor-specific key.
    available: () => true,
    search: (request, signal) => search(request, signal, ctx),
  })
}
