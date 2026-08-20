/**
 * Standalone Codex-compatible web_search for the Codex preset.
 *
 * This deliberately does not use dsh's ctx.web or @deepseek-ai/dsh-tool-web.
 * It calls the same hosted Responses web_search backend used by Codex-style
 * clients, using the preset's existing OpenAI Codex OAuth credential.
 */
const createRequire = process.getBuiltinModule('node:module').createRequire
const fs = process.getBuiltinModule('node:fs/promises')
const nodePath = process.getBuiltinModule('node:path')
const { pathToFileURL } = process.getBuiltinModule('node:url')
const dshHome = process.env.DSH_HOME ?? `${process.env.HOME ?? '/home/baizhu945'}/.dsh`
const requireFromDsh = createRequire(`${dshHome}/profiles/codex-web-search.cjs`)
const toolsEntry = requireFromDsh.resolve('@deepseek-ai/dsh-tools')
const { defineTool } = await import(toolsEntry)

// Reuse only the OAuth token refresh implementation. No dsh web provider is
// loaded, and the token file remains owned by the existing account plugin.
const piAiRoot = pathToFileURL(nodePath.join(dshHome, 'profiles/node_modules/@earendil-works/pi-ai') + '/')
const { openaiCodexOAuth } = await import(new URL('dist/auth/oauth/openai-codex.js', piAiRoot).href)

const CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses'
const CODEX_MODEL = 'gpt-5.6-luna'
const SEARCH_TIMEOUT_MS = 60_000
const MAX_RESULTS = 8
const REFRESH_SKEW_MS = 60_000
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024
const credentialFile = nodePath.join(dshHome, 'openai-codex-credentials.json')
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
  const temporary = `${credentialFile}.web-search.tmp`
  await fs.writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 })
  await fs.rename(temporary, credentialFile)
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
  if (signal.aborted) throw new Error('web_search was aborted')
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

function parseResponseBody(body) {
  const trimmed = body.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed)
    return Array.isArray(parsed) ? parsed : parsed.output ?? []
  }

  const output = []
  let completedResponse
  for (const line of body.split('\n')) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (payload === '' || payload === '[DONE]') continue
    try {
      const event = JSON.parse(payload)
      if (event.type === 'response.output_item.done' && event.item !== undefined) output.push(event.item)
      if ((event.type === 'response.done' || event.type === 'response.completed') && event.response !== undefined) {
        completedResponse = event.response
      }
    } catch {
      // Ignore non-JSON SSE comments and partial provider diagnostics.
    }
  }
  if (Array.isArray(completedResponse?.output) && completedResponse.output.length > 0) return completedResponse.output
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

async function searchCodex(query, signal) {
  const auth = await accessToken(signal)
  const headers = {
    Authorization: `Bearer ${auth.token}`,
    'Content-Type': 'application/json',
    'OpenAI-Beta': 'responses=experimental',
    originator: 'codex_cli_rs',
    ...(auth.accountId !== undefined ? { 'chatgpt-account-id': auth.accountId } : {}),
  }
  const response = await fetch(CODEX_RESPONSES_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: CODEX_MODEL,
      instructions: 'Search the web and return a concise answer grounded only in the web results. Include clickable source citations when possible.',
      input: [{ role: 'user', content: [{ type: 'input_text', text: query }] }],
      tools: [{ type: 'web_search' }],
      include: ['web_search_call.action.sources'],
      store: false,
      stream: true,
      tool_choice: 'required',
      parallel_tool_calls: true,
    }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(SEARCH_TIMEOUT_MS)]),
  })
  const body = await response.text()
  if (body.length > MAX_RESPONSE_BYTES) throw new Error('OpenAI Codex web search response exceeded the size limit')
  if (!response.ok) {
    throw new Error(`OpenAI Codex web search failed (HTTP ${response.status}): ${redact(body.slice(0, 400), auth.token)}`)
  }
  const output = parseResponseBody(body)
  const answer = extractAnswer(output)
  const allSources = extractSources(output)
  if (answer === '' && allSources.length === 0) throw new Error('OpenAI Codex web search returned no answer or sources')
  return {
    ...(answer !== '' ? { content: answer } : {}),
    sources: allSources.slice(0, MAX_RESULTS),
    truncated: allSources.length > MAX_RESULTS,
  }
}

function sourceLabel(source) {
  if (source.title !== undefined && source.title !== '') return source.title
  try {
    return new URL(source.url).hostname
  } catch {
    return source.url
  }
}

function formatSearchOutput(value) {
  const parts = []
  if (value.content !== undefined && value.content !== '') parts.push(value.content)
  if (value.sources.length > 0) {
    parts.push(`Sources:\n${value.sources.map(source => {
      const metadata = []
      if (source.snippet !== undefined && source.snippet !== '') metadata.push(source.snippet)
      const suffix = metadata.length > 0 ? ` — ${metadata.join(' ')}` : ''
      return `- [${sourceLabel(source)}](${source.url})${suffix}`
    }).join('\n')}`)
  } else if (value.content === undefined || value.content === '') {
    parts.push('No results found.')
  }
  if (value.truncated) parts.push(`(Showing the first ${value.sources.length} sources. Refine the query for more.)`)
  parts.push('Cite the relevant URLs above as markdown links in your answer.')
  return parts.join('\n\n')
}

function projectSource(source) {
  return {
    url: source.url,
    ...(source.title !== undefined ? { title: source.title } : {}),
    ...(source.snippet !== undefined ? { snippet: source.snippet } : {}),
  }
}

function searchMeta(value) {
  return {
    sources: value.sources.map(projectSource),
    truncated: value.truncated,
    ...(value.content !== undefined ? { answer: value.content } : {}),
  }
}

function validMeta(meta) {
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return undefined
  const value = meta
  if (!Array.isArray(value.sources) || typeof value.truncated !== 'boolean') return undefined
  if (value.answer !== undefined && typeof value.answer !== 'string') return undefined
  const sources = value.sources.filter(source => (
    source !== null && typeof source === 'object' && typeof source.url === 'string'
    && (source.title === undefined || typeof source.title === 'string')
    && (source.snippet === undefined || typeof source.snippet === 'string')
  ))
  if (sources.length !== value.sources.length) return undefined
  return { sources, truncated: value.truncated, ...(value.answer !== undefined ? { answer: value.answer } : {}) }
}

function registerWebSearch(ctx) {
  // Shadow dsh's disabled/global guidance in this preset with the same concise
  // citation instruction used by Codex-style hosted web search.
  ctx.systemPrompt.section({
    name: 'tool:web_search',
    order: 110,
    text: 'Use the web_search tool to discover current information on the web. It returns a concise answer and source URLs from the live web. Cite relevant URLs as markdown links in your answer.',
  })

  ctx.tools.register(defineTool({
    name: 'web_search',
    description: 'Search the web for current information. Returns a concise answer and a list of source URLs.',
    parameters: {
      query: { type: 'string', required: true, description: 'The search query.' },
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
              },
            },
          },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatSearchOutput(value) }],
      presentationMeta: (_args, value) => searchMeta(value),
    },
    timeoutMs: SEARCH_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (typeof args.query !== 'string' || args.query.trim() === '') throw new Error('query must be a non-empty string')
      return searchCodex(args.query.trim(), exec.signal)
    },
    presentCall(args) {
      return { card: 'generic', title: args.query, kind: 'search', rawInput: args.query }
    },
    presentResult(args, result) {
      if (result.isError) return undefined
      const meta = validMeta(result.meta)
      if (meta === undefined) return undefined
      return {
        card: 'web',
        kind: 'search',
        title: args.query,
        sources: meta.sources,
        truncated: meta.truncated,
        ...(meta.answer !== undefined ? { answer: meta.answer } : {}),
      }
    },
  }))
}

export const name = 'codex-web-search'
export const inject = ['tools', 'systemPrompt']

export function apply(ctx) {
  registerWebSearch(ctx)
}
