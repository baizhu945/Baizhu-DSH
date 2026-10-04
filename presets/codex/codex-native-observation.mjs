/**
 * HUMAN-ONLY observations of native response_items absent from ThreadItems.
 *
 * At upstream 86a54b0, CodeMode exec/wait outputs are persisted in the private
 * rollout, not represented by ThreadItems. Experimental raw notifications can
 * emit outputs, with capability-dependent media filtering. This reads ONLY the
 * supplied thread.path inside the supplied CODEX_HOME, including real media.
 * It never dispatches tools, writes history, or changes native/model payloads.
 *
 * createNativeObserver({ nativeHome, rolloutPath }).read() returns new item
 * snapshots: a call with completed:false/status:inProgress, then a result with
 * the SAME id and completed:true/status:completed|failed. exec uses
 * codeExecution/code (nativeToolArguments therefore preserves args.input and
 * nativeToolName aliases it to exec); other calls use functionCallOutput/tool.
 * Feed these exclusively to the human observer, NOT turn/start or model history.
 *
 * Reads start at byte zero once, then continue at the previous byte offset.
 * Each read consumes a fixed EOF snapshot in 64 KiB chunks, not a whole-file
 * read or a tail/watch. Incomplete lines are retained without waiting. Missing
 * files return []; this is NOT a completed/successful tool result. Native
 * recorder buffering may require another read after turn/completed. Complete
 * malformed records and non-response_items are ignored. Oversize lines,
 * call-state/batch limits and replaced/truncated sources fail explicitly,
 * permanently disable this reader, and never fabricate a result. Human output
 * is bounded and marked when truncated; native bytes are never modified.
 */
import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'

const CHUNK_BYTES = 64 * 1024
const MAX_LINE_BYTES = 64 * 1024 * 1024
// Hard ceilings fail HUMAN telemetry closed, never affect native execution.
const MAX_CALLS = 16_384
const MAX_STATE_BYTES = 16 * 1024 * 1024
const MAX_BATCH_ITEMS = 8192
const MAX_BATCH_BYTES = 16 * 1024 * 1024
const MAX_DISPLAY_CHARS = 1024 * 1024
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key)
const EXCLUDED = new Set([
  'exec_command', 'write_stdin', 'apply_patch', 'view_image',
  'web_search', 'webSearch', 'web_search_preview',
  'spawn_agent', 'send_input', 'resume_agent', 'close_agent', 'send_message',
  'followup_task', 'interrupt_agent', 'list_agents', 'wait_agent',
  'update_plan', 'sleep', 'imagegen', 'image_generation',
])

function failure(message, code = 'ERR_NATIVE_OBSERVATION_PATH') {
  return Object.assign(new Error(message), { code })
}
function inside(root, target) {
  const relative = path.relative(root, target)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}
function validRollout(root, target) {
  if (!inside(root, target)) throw failure('Native rollout must be inside the supplied nativeHome')
  const relative = path.relative(root, target).split(path.sep)
  if (!['sessions', 'archived_sessions'].includes(relative[0]) ||
      !/^rollout-[^/\\]+\.jsonl$/.test(path.basename(target))) {
    throw failure('Only an official sessions/archived_sessions rollout-*.jsonl may be observed')
  }
}
function parsed(value) {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch { return value }
}
function label(key) {
  key = key.length > 256 ? key.slice(0, 256) + '…' : key
  const value = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ')
  return value ? value[0].toUpperCase() + value.slice(1) : 'Value'
}

// Strip transport headers ONLY from the leading native envelope. Status,
// cell IDs, errors, and any header-like text printed by the script survive.
function displayEnvelope(text) {
  const match = /^(?:(Script (?:completed|failed|terminated|running with cell ID [^\r\n]+))\r?\n)?(?:Chunk ID: [^\r\n]+\r?\n)?Wall time:? -?\d+(?:\.\d+)? seconds(?: \(code-mode -?\d+(?:\.\d+)? seconds; overhead -?\d+(?:\.\d+)? seconds\))?\r?\n(?:Process exited with code (-?\d+)\r?\n)?(?:Original token count: \d+\r?\n)?Output:(?:\r?\n| ?)/.exec(text)
  if (!match) return { text, failed: false }
  const status = match[1]
  const exitCode = match[2]
  const prefix = [status, exitCode !== undefined ? `Process exited with code ${exitCode}` : ''].filter(Boolean).join('\n')
  const body = text.slice(match[0].length)
  return {
    text: prefix && body ? `${prefix}\n\n${body}` : prefix || body,
    failed: status === 'Script failed' || status === 'Script terminated' || (exitCode !== undefined && exitCode !== '0'),
  }
}
function media(value, context, depth) {
  if (typeof value === 'string' && /^data:/i.test(value)) {
    const mime = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+)(?=[;,])/i.exec(value)?.[1] || 'media'
    return `embedded ${mime} (${value.length} characters)`
  }
  if (typeof value === 'string' && /^[a-z0-9+/=_-]{128,}$/i.test(value)) return `embedded media (${value.length} encoded characters)`
  if (record(value)) {
    if (depth > 32) return '(media display truncated)'
    return Object.entries(value).slice(0, 10_000).map(([key, entry]) => ['data', 'blob', 'base64', 'bytes', 'b64_json'].includes(key)
      ? `${label(key)}: embedded media (${typeof entry === 'string' ? entry.length : 'unknown'} encoded characters)`
      : `${label(key)}: ${media(entry, context, depth + 1)}`).join('\n').slice(0, MAX_DISPLAY_CHARS)
  }
  return readable(value, context, depth)
}
function readable(value, context = { nodes: 0, remaining: MAX_DISPLAY_CHARS }, depth = 0) {
  if (++context.nodes > 10_000 || depth > 32 || context.remaining <= 0) return '(human display truncated)'
  const take = text => {
    const result = text.length > context.remaining ? text.slice(0, context.remaining) + '\n(human display truncated)' : text
    context.remaining = Math.max(0, context.remaining - text.length)
    return result
  }
  if (typeof value === 'string') {
    if (/^data:/i.test(value)) return take(media(value, context, depth))
    if (/^[\s]*[\[{]/.test(value)) {
      if (value.length > MAX_DISPLAY_CHARS) return take('(structured human display too large)')
      const decoded = parsed(value)
      if (typeof decoded !== 'string') return readable(decoded, context, depth + 1)
    }
    return take(value)
  }
  if (value === null) return take('null')
  if (value === undefined) return take('(not provided)')
  if (Array.isArray(value)) {
    const parts = []
    for (const entry of value) {
      parts.push(readable(entry, context, depth + 1))
      if (context.remaining <= 0 || context.nodes > 10_000) break
    }
    return parts.join('\n')
  }
  if (!record(value)) return take(String(value))
  if (['input_text', 'inputText', 'text'].includes(value.type) && typeof value.text === 'string') return readable(value.text, context, depth + 1)
  if (['input_image', 'inputImage', 'image', 'input_audio', 'inputAudio', 'audio'].includes(value.type)) {
    const ref = value.image_url ?? value.imageUrl ?? value.audio_url ?? value.audioUrl ?? value.url ?? value.file_id ?? value.image
    const encoded = value.data !== undefined ? ` (${typeof value.data === 'string' ? value.data.length : 'unknown'} encoded characters)` : ''
    return take(`${/image/i.test(value.type) ? 'Image' : 'Audio'}: ${ref !== undefined ? media(ref, context, depth + 1) : 'embedded media'}${encoded}${typeof value.detail === 'string' ? ` (${value.detail})` : ''}`)
  }
  if (value.type === 'encrypted_content') return take('Encrypted content (not human-readable)')
  const binary = /^(?:image|audio|video)\/|^application\/octet-stream$/i.test(value.mimeType ?? value.mime_type ?? '')
  const parts = []
  for (const [key, entry] of Object.entries(value)) {
    const body = binary && ['data', 'blob', 'base64', 'bytes', 'b64_json'].includes(key)
      ? take(`embedded media (${typeof entry === 'string' ? entry.length : 'unknown'} encoded characters)`)
      : readable(entry, context, depth + 1)
    parts.push(`${label(key)}:${body.includes('\n') ? '\n' + body.split('\n').map(line => `  ${line}`).join('\n') : ' ' + body}`)
    if (context.remaining <= 0 || context.nodes > 10_000) break
  }
  return parts.join('\n')
}
function displayOutput(raw) {
  // Current upstream serializes FunctionCallOutputPayload.body directly.
  // Also accept the explicit internal payload shape without touching it.
  const body = record(raw.output) && own(raw.output, 'body') ? raw.output.body : raw.output
  const chunks = Array.isArray(body) ? body : [body]
  let failed = raw.success === false || raw.output?.success === false || raw.status === 'failed'
  const context = { nodes: 0, remaining: MAX_DISPLAY_CHARS }
  const parts = []
  for (const [index, chunk] of chunks.entries()) {
    const literal = typeof chunk === 'string' ? chunk :
      ['input_text', 'inputText', 'text'].includes(chunk?.type) && typeof chunk.text === 'string' ? chunk.text : undefined
    const envelope = literal !== undefined && index === 0 ? displayEnvelope(literal) : { text: literal, failed: false }
    failed ||= envelope.failed
    const text = readable(literal === undefined ? chunk : envelope.text, context)
    if (text !== '') parts.push(text)
    if (context.remaining <= 0 || context.nodes > 10_000) {
      parts.push('(human display truncated)')
      break
    }
  }
  return { text: parts.join('\n\n').slice(0, MAX_DISPLAY_CHARS + 64), failed }
}
function observedCall(raw) {
  if (!['custom_tool_call', 'function_call'].includes(raw.type) || typeof raw.call_id !== 'string' ||
      !raw.call_id || typeof raw.name !== 'string' || !raw.name ||
      (raw.type === 'custom_tool_call' && typeof raw.input !== 'string') ||
      (raw.type === 'function_call' && typeof raw.arguments !== 'string')) return undefined
  const local = raw.name.split('.').at(-1)
  const namespace = raw.namespace ?? (raw.name.includes('.') ? raw.name.slice(0, raw.name.lastIndexOf('.')) : '')
  const args = raw.type === 'custom_tool_call' ? raw.input : parsed(raw.arguments)
  if (EXCLUDED.has(local) || /^(?:(?:web|collab)(?:\.|$)|mcp(?:__|\.|$))/.test(namespace) || /^mcp__/.test(raw.name) ||
      (local === 'wait' && record(args) && (own(args, 'ids') || own(args, 'receiver_thread_ids')))) return undefined
  const input = raw.type === 'custom_tool_call' ? raw.input :
    record(args) && typeof args.input === 'string' ? args.input :
    record(args) && typeof args.code === 'string' ? args.code : readable(args)
  const common = {
    id: `native-rollout:${raw.call_id}`, callId: raw.call_id,
    status: 'inProgress', completed: false,
  }
  if (local === 'exec') return { ...common, type: 'codeExecution', language: 'javascript', code: input ?? '' }
  return { ...common, type: 'functionCallOutput', tool: local,
    ...(namespace ? { namespace } : {}), arguments: raw.arguments ?? raw.input, input }
}

export function createNativeObserver({ nativeHome, rolloutPath } = {}) {
  if (typeof nativeHome !== 'string' || !path.isAbsolute(nativeHome) ||
      typeof rolloutPath !== 'string' || !path.isAbsolute(rolloutPath) ||
      nativeHome.includes('\0') || rolloutPath.includes('\0')) {
    throw failure('nativeHome and rolloutPath must be absolute paths')
  }
  const root = path.resolve(nativeHome), target = path.resolve(rolloutPath)
  validRollout(root, target)
  let identity, directoryIdentity, fatalError, offset = 0, partialBytes = 0, stateBytes = 0
  let partial = [], queue = Promise.resolve()
  const calls = new Map()

  async function openRollout() {
    // Node has no openat API. On Linux, walk through pinned directory FDs using
    // procfs, with O_NOFOLLOW on EVERY new component. Never reopen a validated
    // string path: lstat/realpath followed by open has a parent-symlink TOCTOU.
    if (process.platform !== 'linux') throw failure('Safe native observation requires Linux procfs')
    const directories = [], identities = []
    let handle
    try {
      let component = path.parse(target).root
      const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK
      directories.push({ handle: await fs.open(component, flags), component })
      for (const name of path.relative(component, path.dirname(target)).split(path.sep).filter(Boolean)) {
        const parent = directories.at(-1).handle
        component = path.join(component, name)
        const directory = await fs.open(`/proc/self/fd/${parent.fd}/${name}`, flags)
        directories.push({ handle: directory, component })
      }
      const parent = directories.at(-1).handle
      handle = await fs.open(`/proc/self/fd/${parent.fd}/${path.basename(target)}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      for (const directory of directories) {
        if (await fs.realpath(`/proc/self/fd/${directory.handle.fd}`) !== directory.component) throw failure('Native rollout directory moved while opening')
        const stat = await directory.handle.stat()
        identities.push(`${stat.dev}:${stat.ino}`)
      }
      if (await fs.realpath(`/proc/self/fd/${handle.fd}`) !== target) throw failure('Native rollout changed while opening')
      const stat = await handle.stat()
      if (!stat.isFile() || stat.nlink !== 1) throw failure('Native rollout must be a regular, single-link file')
      const current = `${stat.dev}:${stat.ino}`, parents = identities.join('/')
      if ((identity && identity !== current) || (directoryIdentity && directoryIdentity !== parents) || stat.size < offset) {
        throw failure('Native rollout was replaced or truncated', 'ERR_NATIVE_OBSERVATION_SOURCE_CHANGED')
      }
      identity = current; directoryIdentity = parents
      return { handle, end: stat.size }
    } catch (error) {
      if (handle) await handle.close()
      if (['ELOOP', 'ENOTDIR'].includes(error.code)) throw failure('Symlinked or non-directory native rollout paths are not allowed')
      throw error
    } finally {
      await Promise.all(directories.map(directory => directory.handle.close()))
    }
  }
  function retain(item, items) {
    const bytes = Buffer.byteLength(JSON.stringify(item))
    items.bytes = (items.bytes ?? 0) + bytes
    if (items.length >= MAX_BATCH_ITEMS || items.bytes > MAX_BATCH_BYTES) throw failure('Native observation batch limit exceeded', 'ERR_NATIVE_OBSERVATION_LIMIT')
    items.push(structuredClone(item))
  }
  function consume(line, items) {
    let entry
    try { entry = JSON.parse(line) } catch { return }
    if (entry?.type !== 'response_item' || !record(entry.payload)) return
    const raw = entry.payload
    if (['custom_tool_call', 'function_call'].includes(raw.type)) {
      const item = observedCall(raw)
      if (!item || calls.has(raw.call_id)) return
      const bytes = Buffer.byteLength(JSON.stringify(item))
      stateBytes += bytes
      if (calls.size >= MAX_CALLS || stateBytes > MAX_STATE_BYTES) throw failure('Native observation call-state limit exceeded', 'ERR_NATIVE_OBSERVATION_LIMIT')
      calls.set(raw.call_id, { item, completed: false, bytes })
      retain(item, items)
    } else if (['custom_tool_call_output', 'function_call_output'].includes(raw.type) && own(raw, 'output')) {
      const call = calls.get(raw.call_id)
      if (!call || call.completed) return // No invented calls for orphan/excluded results.
      const output = displayOutput(raw)
      call.completed = true
      retain({ ...call.item, status: output.failed ? 'failed' : 'completed', completed: true, output: output.text }, items)
      stateBytes -= call.bytes
      stateBytes += Buffer.byteLength(raw.call_id)
      call.item = undefined // Keep bounded ID/completion markers to reject replay duplicates.
      call.bytes = 0
    }
  }
  async function read() {
    if (fatalError) throw fatalError
    let source
    try { source = await openRollout() } catch (error) {
      if (error.code === 'ENOENT' && !identity) return []
      if (error.code === 'ENOENT') throw failure('Native rollout disappeared', 'ERR_NATIVE_OBSERVATION_SOURCE_CHANGED')
      throw error
    }
    const { handle, end } = source, items = []
    try {
      while (offset < end) {
        const buffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, end - offset))
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
        if (!bytesRead) throw failure('Native rollout truncated during read', 'ERR_NATIVE_OBSERVATION_SOURCE_CHANGED')
        offset += bytesRead
        let start = 0
        while (start < bytesRead) {
          const newline = buffer.indexOf(10, start)
          const stop = newline < 0 || newline >= bytesRead ? bytesRead : newline
          const segment = buffer.subarray(start, stop)
          partialBytes += segment.length
          if (partialBytes > MAX_LINE_BYTES) throw failure('Native rollout record exceeds 64 MiB', 'ERR_NATIVE_OBSERVATION_LINE_TOO_LARGE')
          partial.push(segment)
          if (stop === bytesRead) break
          consume(Buffer.concat(partial, partialBytes).toString('utf8'), items)
          partial = []; partialBytes = 0
          start = stop + 1
        }
      }
      const finalStat = await handle.stat()
      if (finalStat.size < end || finalStat.nlink !== 1) throw failure('Native rollout changed during read', 'ERR_NATIVE_OBSERVATION_SOURCE_CHANGED')
      // Array bookkeeping is internal, not part of the public item contract.
      delete items.bytes
      return items
    } finally { await handle.close() }
  }
  return { read() {
    // Serialize concurrent notifications so offsets and call IDs cannot race.
    const next = queue.then(read).catch(error => {
      // Offsets may already have advanced: never resume from a half-processed
      // chunk after an error, silently lose events, or invent a completion.
      fatalError = error
      calls.clear(); partial = []; partialBytes = 0; stateBytes = 0
      throw error
    })
    queue = next.catch(() => {})
    return next
  } }
}
