/**
 * Provider-independent web search for the normal DSH Web profile.
 *
 * The shipped `web-search-deepseek` provider sends the chat model's
 * DEEPSEEK_API_KEY to a separate Anthropic Messages endpoint. That couples a
 * model-facing tool to one vendor and makes a non-DeepSeek chat route fail.
 * This provider keeps the model-facing `web_search` tool unchanged. The normal
 * Web profile always uses its local SearXNG Bing route, so search does not
 * depend on the selected chat model or that model vendor's search feature.
 * Exa MCP and Tavily remain outage fallbacks. Bing RSS is deliberately not
 * used: its RSS endpoint can return a successful but unrelated result set for
 * Chinese queries, which must never be treated as a valid search hit.
 *
 * This is intentionally a dependency-free host plugin. The only dsh import is
 * the provider-neutral WebError type, resolved from the same runtime tree as
 * the built-in web packages.
 */
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { WebError } from '@deepseek-ai/dsh-web'

export const name = 'dsh-web-search-keyless'
export const inject = ['web', 'credentials', 'agents', 'settings']
export const PROVIDER_ID = 'simple-search'

const TAVILY_SEARCH_URL = 'https://api.tavily.com/search'
const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses'
const OPENAI_SEARCH_MODEL = 'gpt-4.1-mini'
const OPENAI_PROVIDER_ID = 'openai'
const LLM_PI_AI_SETTINGS = 'llm-pi-ai'
const MIMO_PROVIDER_ID = 'xiaomi'
const MIMO_DEFAULT_BASE_URL = 'https://api.xiaomimimo.com/v1'
const MIMO_SEARCH_MODELS = new Set(['mimo-v2.5', 'mimo-v2.5-pro'])
const SEARXNG_SEARCH_URL = 'http://127.0.0.1:8765/search'
const EXA_MCP_URL = 'https://mcp.exa.ai/mcp?tools=web_search_exa'
const EXA_MCP_TOOL = 'web_search_exa'
// The dsh-tool-web search call has its own deadline. Keep backend attempts
// shorter so a slow optional backend can fall through to Bing before the
// model-facing tool is cancelled by its outer deadline.
const SEARCH_TIMEOUT_MS = 10_000
const DEFAULT_MAX_RESULTS = 5
const MAX_RESULTS = 20
const MAX_ERROR_CHARS = 240
const MAX_SNIPPET_CHARS = 4_000
const MAX_ANSWER_CHARS = 8_000

/**
 * A custom endpoint is useful for a self-hosted Tavily-compatible gateway, but
 * the built-in endpoint is pinned above so a copied configuration remains
 * reproducible and zero-config.
 */
function searchEndpoint() {
  const configured = process.env.DSH_WEB_SEARCH_ENDPOINT?.trim()
  const value = configured === undefined || configured === '' ? TAVILY_SEARCH_URL : configured
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    if (url.username !== '' || url.password !== '') return undefined
    return url.toString()
  } catch {
    return undefined
  }
}

function maxResults(value) {
  if (!Number.isFinite(value)) return DEFAULT_MAX_RESULTS
  return Math.max(1, Math.min(MAX_RESULTS, Math.floor(value)))
}

function requestSignal(signal) {
  const timeout = AbortSignal.timeout(SEARCH_TIMEOUT_MS)
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout])
}

function isAborted(error, signal) {
  return signal?.aborted === true
    || error?.code === 'WEB_ABORTED'
}

function errorText(error) {
  const text = error instanceof Error ? error.message : String(error)
  return text.replaceAll(/\s+/g, ' ').trim().slice(0, MAX_ERROR_CHARS)
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

function optionalText(value, maxChars = MAX_SNIPPET_CHARS) {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (text === '') return undefined
  return text.length > maxChars ? `${text.slice(0, maxChars - 3)}...` : text
}

function withStatus(error, statusCode) {
  error.statusCode = statusCode
  return error
}

function statusCodeOf(error) {
  return typeof error?.statusCode === 'number' ? error.statusCode : undefined
}

function shouldFallback(error) {
  if (isAborted(error)) return false
  const status = statusCodeOf(error)
  return status === undefined || status === 408 || status === 429 || status >= 500
}

function hasExplicitTavilyRoute() {
  return (process.env.TAVILY_API_KEY?.trim() ?? '') !== ''
    || (process.env.DSH_WEB_SEARCH_ENDPOINT?.trim() ?? '') !== ''
}

function openAiEndpoint(baseURL) {
  const configured = process.env.DSH_WEB_SEARCH_OPENAI_ENDPOINT?.trim()
  const value = configured === undefined || configured === '' ? baseURL ?? OPENAI_RESPONSES_URL : configured
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    if (url.username !== '' || url.password !== '') return undefined
    const path = url.pathname.replace(/\/+$/, '')
    if (!path.endsWith('/responses')) {
      url.pathname = path === '' || path === '/' ? '/v1/responses' : `${path}/responses`
    }
    return url.toString()
  } catch {
    return undefined
  }
}

function openAiModel() {
  const configured = process.env.DSH_WEB_SEARCH_OPENAI_MODEL?.trim()
  return configured === undefined || configured === '' ? OPENAI_SEARCH_MODEL : configured
}

function activeAgent(ctx) {
  try {
    return ctx.get('agents')?.currentInitiator()
  } catch {
    return undefined
  }
}

function activeAgentRoute(ctx) {
  const agent = activeAgent(ctx)
  if (agent === undefined) return undefined
  // Agent.options is only the creation-time default. Once a session has
  // selected a model, dsh records the exact assembled route in its request
  // header; this is the same route that produced the current tool call.
  const routed = agent.session?.requestHeader?.()?.config
  const provider = routed?.provider ?? agent.options?.provider
  const model = routed?.model ?? agent.options?.model
  return typeof provider === 'string' && provider !== '' ? { provider, model } : undefined
}

function activeOpenAiProfile(ctx) {
  const route = activeAgentRoute(ctx)
  if (route?.provider !== OPENAI_PROVIDER_ID) return undefined
  let settings
  try {
    settings = ctx.get('settings')?.get(LLM_PI_AI_SETTINGS)
  } catch {
    settings = undefined
  }
  const profile = settings?.providers?.[route.provider]
  if (profile !== null && typeof profile === 'object' && profile.api !== undefined && profile.api !== 'openai-responses') {
    return undefined
  }
  const apiKeyEnv = profile !== null && typeof profile === 'object' && typeof profile.apiKeyEnv === 'string'
    && profile.apiKeyEnv.trim() !== '' ? profile.apiKeyEnv.trim() : 'OPENAI_API_KEY'
  const baseURL = profile !== null && typeof profile === 'object' && typeof profile.baseURL === 'string'
    && profile.baseURL.trim() !== '' ? profile.baseURL.trim() : undefined
  return { apiKeyEnv, baseURL, model: route.model }
}

async function resolveApiKey(ctx, apiKeyEnv, signal) {
  if (signal?.aborted === true) throw new WebError('web search aborted', 'WEB_ABORTED')
  try {
    const resolved = await ctx.get('credentials')?.resolve(credentialRef(apiKeyEnv))
    const value = resolved?.value?.trim()
    if (value !== undefined && value !== '') return value
  } catch {
    // A missing/unavailable credential service only disables this optional route.
  }
  const ambient = process.env[apiKeyEnv]?.trim()
  return ambient === undefined || ambient === '' ? undefined : ambient
}

async function activeOpenAiRoute(ctx, signal) {
  const profile = activeOpenAiProfile(ctx)
  if (profile === undefined) return undefined
  const apiKey = await resolveApiKey(ctx, profile.apiKeyEnv, signal)
  const endpoint = openAiEndpoint(profile.baseURL)
  if (apiKey === undefined || endpoint === undefined) return undefined
  return { apiKey, endpoint, model: openAiModel() }
}

function chatCompletionsEndpoint(baseURL) {
  const value = baseURL ?? MIMO_DEFAULT_BASE_URL
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    if (url.username !== '' || url.password !== '') return undefined
    const path = url.pathname.replace(/\/+$/, '')
    if (!path.endsWith('/chat/completions')) {
      url.pathname = path === '' || path === '/' ? '/v1/chat/completions' : `${path}/chat/completions`
    }
    return url.toString()
  } catch {
    return undefined
  }
}

function activeMimoProfile(ctx) {
  const route = activeAgentRoute(ctx)
  if (route?.provider !== MIMO_PROVIDER_ID || !MIMO_SEARCH_MODELS.has(route.model)) return undefined
  let settings
  try {
    settings = ctx.get('settings')?.get(LLM_PI_AI_SETTINGS)
  } catch {
    settings = undefined
  }
  const profile = settings?.providers?.[MIMO_PROVIDER_ID]
  if (profile !== null && typeof profile === 'object' && profile.api !== undefined && profile.api !== 'openai-completions') {
    return undefined
  }
  const apiKeyEnv = profile !== null && typeof profile === 'object' && typeof profile.apiKeyEnv === 'string'
    && profile.apiKeyEnv.trim() !== '' ? profile.apiKeyEnv.trim() : 'XIAOMI_API_KEY'
  const baseURL = profile !== null && typeof profile === 'object' && typeof profile.baseURL === 'string'
    && profile.baseURL.trim() !== '' ? profile.baseURL.trim() : undefined
  return { apiKeyEnv, baseURL, model: route.model }
}

async function activeMimoRoute(ctx, signal) {
  const profile = activeMimoProfile(ctx)
  if (profile === undefined) return undefined
  const apiKey = await resolveApiKey(ctx, profile.apiKeyEnv, signal)
  const endpoint = chatCompletionsEndpoint(profile.baseURL)
  if (apiKey === undefined || endpoint === undefined) return undefined
  return { apiKey, endpoint, model: profile.model }
}

function cleanSourceUrl(value) {
  const rawUrl = sourceUrl(value)
  if (rawUrl === undefined) return undefined
  const url = new URL(rawUrl)
  if (url.searchParams.get('utm_source') === 'openai') url.searchParams.delete('utm_source')
  return url.toString()
}

function citationSnippet(text, start, end) {
  if (typeof text !== 'string' || text === '' || typeof start !== 'number' || typeof end !== 'number') return ''
  const snippet = text.slice(Math.max(0, start - 120), Math.min(text.length, end + 120))
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .trim()
  return snippet.length > 300 ? `${snippet.slice(0, 297)}...` : snippet
}

function addOpenAiSource(sources, byUrl, rawUrl, rawTitle, rawSnippet, rawPublishedAt) {
  const url = cleanSourceUrl(rawUrl)
  if (url === undefined) return
  const title = optionalText(rawTitle, 500)
  const snippet = optionalText(rawSnippet, 1_000)
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

function mapMimoResponse(payload) {
  const root = payload !== null && typeof payload === 'object' ? payload : {}
  const message = root.choices?.[0]?.message
  const content = optionalText(message?.content ?? root.choices?.[0]?.content, MAX_ANSWER_CHARS)
  const sources = []
  const byUrl = new Map()
  const annotations = message?.annotations ?? root.choices?.[0]?.annotations
  if (Array.isArray(annotations)) {
    for (const annotation of annotations) {
      if (annotation === null || typeof annotation !== 'object') continue
      addOpenAiSource(
        sources,
        byUrl,
        annotation.url,
        annotation.title ?? annotation.site_name,
        annotation.summary,
        annotation.publish_time,
      )
    }
  }
  if (content === undefined && sources.length === 0) {
    throw new Error('MiMo web search returned no answer or sources')
  }
  return {
    ...content === undefined ? {} : { content },
    sources,
    truncated: false,
  }
}

function mapOpenAiResponse(payload) {
  const root = payload !== null && typeof payload === 'object' ? payload : {}
  const output = Array.isArray(root.output) ? root.output : []
  const sources = []
  const byUrl = new Map()
  const answerParts = []

  // Cited URLs in the answer come first and receive their title/snippet from
  // the annotation; action.sources fills any remaining search results.
  for (const item of output) {
    if (item?.type !== 'message' || !Array.isArray(item.content)) continue
    for (const part of item.content) {
      if (typeof part?.text === 'string' && part.text.trim() !== '') answerParts.push(part.text)
      if (!Array.isArray(part?.annotations)) continue
      for (const annotation of part.annotations) {
        if (annotation?.type !== 'url_citation') continue
        addOpenAiSource(
          sources,
          byUrl,
          annotation.url,
          annotation.title,
          citationSnippet(part.text, annotation.start_index, annotation.end_index),
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
        addOpenAiSource(
          sources,
          byUrl,
          source?.url ?? source?.source_website_url,
          source?.title ?? source?.caption,
          source?.snippet ?? source?.description,
        )
      }
    }
  }

  const content = optionalText(answerParts.join('\n').trim(), MAX_ANSWER_CHARS)
  if (content === undefined && sources.length === 0) {
    throw new Error('OpenAI web search returned no answer or sources')
  }
  return {
    ...content === undefined ? {} : { content },
    sources,
    truncated: false,
  }
}

async function searchOpenAi(request, signal, route) {
  const endpoint = route.endpoint
  if (endpoint === undefined) {
    throw new WebError('DSH_WEB_SEARCH_OPENAI_ENDPOINT must be an HTTP(S) URL', 'WEB_PROVIDER_ERROR')
  }

  let response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${route.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: route.model,
        instructions: 'Search the web and answer concisely using only current web results. Include source citations when available.',
        input: [{ role: 'user', content: [{ type: 'input_text', text: request.query }] }],
        tools: [{ type: 'web_search' }],
        include: ['web_search_call.action.sources'],
        store: false,
        tool_choice: 'required',
      }),
      signal: requestSignal(signal),
    })
  } catch (error) {
    if (isAborted(error, signal)) {
      throw new WebError('web search aborted', 'WEB_ABORTED', { cause: error })
    }
    throw new WebError(`OpenAI web search request failed: ${errorText(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
  }

  if (!response.ok) {
    let detail = `HTTP ${response.status}`
    try {
      const body = await response.text()
      const parsed = JSON.parse(body)
      detail = optionalText(parsed?.error?.message ?? parsed?.message, MAX_ERROR_CHARS) ?? detail
    } catch {
      // Keep the status as the stable diagnostic when the gateway body is not JSON.
    }
    throw withStatus(
      new WebError(`OpenAI web search failed: ${detail}`, 'WEB_PROVIDER_ERROR'),
      response.status,
    )
  }

  try {
    return mapOpenAiResponse(await response.json())
  } catch (error) {
    if (isAborted(error, signal)) {
      throw new WebError('web search aborted', 'WEB_ABORTED', { cause: error })
    }
    throw new WebError(`OpenAI web search returned invalid content: ${errorText(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
  }
}

async function searchMimo(request, signal, route) {
  let response
  try {
    response = await fetch(route.endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: {
        accept: 'application/json',
        'api-key': route.apiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: route.model,
        messages: [{ role: 'user', content: request.query }],
        tools: [{
          type: 'web_search',
          max_keyword: 3,
          force_search: true,
          limit: maxResults(request.maxResults),
          user_location: { type: 'approximate', country: 'China' },
        }],
        max_completion_tokens: 2_048,
        stream: false,
        thinking: { type: 'disabled' },
      }),
      signal: requestSignal(signal),
    })
  } catch (error) {
    if (isAborted(error, signal)) {
      throw new WebError('web search aborted', 'WEB_ABORTED', { cause: error })
    }
    throw new WebError(`MiMo web search request failed: ${errorText(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
  }

  if (!response.ok) {
    let detail = `HTTP ${response.status}`
    try {
      const body = await response.text()
      const parsed = JSON.parse(body)
      detail = optionalText(parsed?.error?.message ?? parsed?.message, MAX_ERROR_CHARS) ?? detail
    } catch {
      // Keep the status as the stable diagnostic when the gateway body is not JSON.
    }
    if (response.status === 400 && /webSearchEnabled\s+is\s+false/i.test(detail)) {
      detail += '; enable MiMo Web Search in Console → Plugin Management'
    }
    throw withStatus(
      new WebError(`MiMo web search failed: ${detail}`, 'WEB_PROVIDER_ERROR'),
      response.status,
    )
  }

  try {
    return mapMimoResponse(await response.json())
  } catch (error) {
    if (isAborted(error, signal)) {
      throw new WebError('web search aborted', 'WEB_ABORTED', { cause: error })
    }
    throw new WebError(`MiMo web search returned invalid content: ${errorText(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
  }
}

/** Map Tavily's response to dsh-web's stable provider-neutral result shape. */
export function mapTavilyResponse(payload) {
  const root = payload !== null && typeof payload === 'object' ? payload : {}
  const sources = []
  const seen = new Set()
  const hits = Array.isArray(root.results) ? root.results : []

  for (const hit of hits) {
    if (hit === null || typeof hit !== 'object') continue
    const url = sourceUrl(hit.url)
    if (url === undefined || seen.has(url)) continue
    seen.add(url)
    const title = optionalText(hit.title, 500)
    const snippet = optionalText(hit.content)
    const publishedAt = optionalText(hit.published_date, 120)
    sources.push({
      url,
      ...title === undefined ? {} : { title },
      ...snippet === undefined ? {} : { snippet },
      ...publishedAt === undefined ? {} : { publishedAt },
    })
  }

  const content = optionalText(root.answer, 8_000)
  return {
    ...content === undefined ? {} : { content },
    sources,
    truncated: false,
  }
}

async function parseErrorResponse(response) {
  try {
    const body = await response.text()
    if (body === '') return `HTTP ${response.status}`
    try {
      const parsed = JSON.parse(body)
      const detail = parsed?.detail ?? parsed?.message ?? parsed?.error
      return optionalText(detail, MAX_ERROR_CHARS) ?? `HTTP ${response.status}`
    } catch {
      return `HTTP ${response.status}: ${body.replaceAll(/\s+/g, ' ').slice(0, MAX_ERROR_CHARS)}`
    }
  } catch {
    return `HTTP ${response.status}`
  }
}

async function searchTavily(request, signal) {
  const endpoint = searchEndpoint()
  if (endpoint === undefined) {
    throw new WebError('DSH_WEB_SEARCH_ENDPOINT must be an HTTP(S) URL', 'WEB_PROVIDER_ERROR')
  }

  const apiKey = process.env.TAVILY_API_KEY?.trim()
  const headers = {
    accept: 'application/json',
    'content-type': 'application/json',
    ...apiKey === undefined || apiKey === ''
      ? { 'x-tavily-access-mode': 'keyless' }
      : { authorization: `Bearer ${apiKey}` },
  }

  let response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      redirect: 'error',
      headers,
      body: JSON.stringify({
        query: request.query,
        search_depth: 'basic',
        max_results: maxResults(request.maxResults),
        include_answer: false,
        include_raw_content: false,
        include_images: false,
      }),
      signal: requestSignal(signal),
    })
  } catch (error) {
    if (isAborted(error, signal)) {
      throw new WebError('web search aborted', 'WEB_ABORTED', { cause: error })
    }
    throw new WebError(`web search request failed: ${errorText(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
  }

  if (!response.ok) {
    const message = await parseErrorResponse(response)
    throw withStatus(
      new WebError(`web search failed: ${message}`, 'WEB_PROVIDER_ERROR'),
      response.status,
    )
  }

  try {
    return mapTavilyResponse(await response.json())
  } catch (error) {
    if (isAborted(error, signal)) {
      throw new WebError('web search aborted', 'WEB_ABORTED', { cause: error })
    }
    throw new WebError(`web search returned invalid JSON: ${errorText(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
  }
}

function mapSearxngResponse(payload) {
  const root = payload !== null && typeof payload === 'object' ? payload : {}
  const sources = []
  const seen = new Set()
  const hits = Array.isArray(root.results) ? root.results : []
  for (const hit of hits) {
    if (hit === null || typeof hit !== 'object') continue
    const url = sourceUrl(hit.url)
    if (url === undefined || seen.has(url)) continue
    seen.add(url)
    const title = optionalText(hit.title, 500)
    const snippet = optionalText(hit.content ?? hit.snippet)
    const publishedAt = optionalText(hit.publishedDate ?? hit.published_date, 120)
    sources.push({
      url,
      ...title === undefined ? {} : { title },
      ...snippet === undefined ? {} : { snippet },
      ...publishedAt === undefined ? {} : { publishedAt },
    })
  }
  const answers = Array.isArray(root.answers)
    ? root.answers.map(answer => optionalText(answer, 8_000)).filter(answer => answer !== undefined)
    : []
  return {
    ...answers.length === 0 ? {} : { content: answers.join('\n\n') },
    sources,
    truncated: false,
  }
}

async function searchSearxng(request, signal) {
  const url = new URL(SEARXNG_SEARCH_URL)
  url.searchParams.set('q', request.query)
  url.searchParams.set('format', 'json')
  // Do not use SearXNG's `auto` locale here. It leaves Bing's market
  // implicit, and the current Bing endpoint can answer with unrelated
  // default-market results. The deployment is mainland-China based, so pin
  // Bing's supported Chinese market explicitly.
  url.searchParams.set('language', 'zh-CN')
  url.searchParams.set('safesearch', '0')

  let response
  try {
    response = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: requestSignal(signal),
    })
  } catch (error) {
    if (isAborted(error, signal)) {
      throw new WebError('web search aborted', 'WEB_ABORTED', { cause: error })
    }
    throw new WebError(`local SearXNG request failed: ${errorText(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
  }

  if (!response.ok) {
    const message = await parseErrorResponse(response)
    throw withStatus(
      new WebError(`local SearXNG search failed: ${message}`, 'WEB_PROVIDER_ERROR'),
      response.status,
    )
  }

  try {
    const result = mapSearxngResponse(await response.json())
    if (result.sources.length === 0 && result.content === undefined) {
      throw new Error('local SearXNG returned no results')
    }
    return result
  } catch (error) {
    if (isAborted(error, signal)) {
      throw new WebError('web search aborted', 'WEB_ABORTED', { cause: error })
    }
    throw new WebError(`local SearXNG returned invalid content: ${errorText(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
  }
}

function parseExaResults(text) {
  const blocks = text.split(/(?=^Title: )/m).filter(block => block.trim() !== '')
  const sources = []
  const seen = new Set()

  for (const block of blocks) {
    const url = sourceUrl(block.match(/^URL: (.+)$/m)?.[1])
    if (url === undefined || seen.has(url)) continue
    seen.add(url)
    const title = optionalText(block.match(/^Title: (.+)$/m)?.[1], 500)
    const published = optionalText(block.match(/^Published: (.+)$/m)?.[1], 120)
    const publishedAt = published === undefined || published === 'N/A' ? undefined : published
    const highlight = block.match(/\nHighlights:\s*\n([\s\S]*)$/m)?.[1]
    const textContent = block.match(/\nText:\s*\n([\s\S]*)$/m)?.[1]
    const snippet = optionalText((textContent ?? highlight)?.replace(/\n---\s*$/, ''))
    sources.push({
      url,
      ...title === undefined ? {} : { title },
      ...snippet === undefined ? {} : { snippet },
      ...publishedAt === undefined ? {} : { publishedAt },
    })
  }

  return { sources, truncated: false }
}

function exaEnvelope(body) {
  const dataLines = body.split(/\r?\n/).filter(line => line.startsWith('data:'))
  for (const line of dataLines) {
    const value = line.slice(5).trim()
    if (value === '' || value === '[DONE]') continue
    try {
      const parsed = JSON.parse(value)
      if (parsed?.result !== undefined || parsed?.error !== undefined) return parsed
    } catch {
      // Ignore SSE comments and non-JSON diagnostics.
    }
  }

  try {
    return JSON.parse(body)
  } catch {
    return undefined
  }
}

async function searchExa(request, signal) {
  let response
  try {
    response = await fetch(EXA_MCP_URL, {
      method: 'POST',
      redirect: 'error',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'x-exa-source': 'dsh-web-search',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: EXA_MCP_TOOL,
          arguments: { query: request.query, numResults: maxResults(request.maxResults) },
        },
      }),
      signal: requestSignal(signal),
    })
  } catch (error) {
    if (isAborted(error, signal)) {
      throw new WebError('web search aborted', 'WEB_ABORTED', { cause: error })
    }
    throw new WebError(`fallback web search request failed: ${errorText(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
  }

  if (!response.ok) {
    const message = await parseErrorResponse(response)
    throw withStatus(
      new WebError(`fallback web search failed: ${message}`, 'WEB_PROVIDER_ERROR'),
      response.status,
    )
  }

  try {
    const envelope = exaEnvelope(await response.text())
    if (envelope === undefined) throw new Error('Exa MCP returned an empty response')
    if (envelope.error !== undefined) {
      throw new Error(envelope.error.message ?? 'Exa MCP returned an error')
    }
    if (envelope.result?.isError === true) {
      const message = envelope.result.content
        ?.find(item => item?.type === 'text' && typeof item.text === 'string')
        ?.text?.trim()
      throw new Error(message || 'Exa MCP returned an error')
    }
    const text = envelope.result?.content
      ?.find(item => item?.type === 'text' && typeof item.text === 'string' && item.text.trim() !== '')
      ?.text
    if (typeof text !== 'string') throw new Error('Exa MCP returned empty content')
    return parseExaResults(text)
  } catch (error) {
    if (isAborted(error, signal)) {
      throw new WebError('web search aborted', 'WEB_ABORTED', { cause: error })
    }
    throw new WebError(`fallback web search returned invalid content: ${errorText(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
  }
}

async function searchWithFallback(ctx, request, signal) {
  // Keep the normal Web profile's search backend independent of the selected
  // chat model. In particular, do not call a model-owned OpenAI/MiMo search
  // API here: the model is already the consumer of this tool, and those
  // optional routes can spend the whole tool deadline before Bing is tried.
  const routes = []
  // Bing through the local SearXNG service is the primary route for every
  // model. Exa/Tavily are only outage fallbacks and never the normal path.
  routes.push(...(hasExplicitTavilyRoute()
    ? [[searchTavily, false], [searchSearxng, false], [searchExa, false]]
    : [[searchSearxng, false], [searchExa, false], [searchTavily, false]]))
  const failures = []
  for (const [route, native] of routes) {
    try {
      return await route(request, signal)
    } catch (error) {
      if (isAborted(error, signal)) throw error
      failures.push(errorText(error))
      if (!native && !shouldFallback(error)) throw error
    }
  }
  throw new WebError(`web search failed: ${failures.join('; ')}`, 'WEB_PROVIDER_ERROR')
}

export function apply(ctx) {
  ctx.web.registerSearchProvider({
    id: PROVIDER_ID,
    // Keyless mode means search remains available regardless of the selected
    // chat provider or whether any model-specific API key is present.
    // The local Bing route does not depend on Tavily endpoint/key state.
    available: () => true,
    search: (request, signal) => searchWithFallback(ctx, request, signal),
  })
}
