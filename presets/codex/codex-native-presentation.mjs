/**
 * Observational presenters for official Codex app-server ThreadItems.
 *
 * No tools are executed here. These bounded text projections are for DSH's HUMAN UI,
 * never for Codex's model-visible input/output. Keep the original ThreadItem in
 * arguments.item and value.item; nativePresentationMeta(value) persists the same
 * snapshot in DSH ToolResult.meta (including replay). Ordinary JSON is detached
 * losslessly; oversized graphs/unexpected JS values get JSON-safe placeholders.
 * Canonical top-level meta
 * fields (diffs, web sources, terminal output) also support raw Web UI cards.
 * Standard tool names are UI aliases ONLY (commandExecution uses bash). The
 * _codex_native: true argument marker gates raw Web UI projections for all names.
 * The bridge's observational execute must never execute these aliases or expose
 * them to the native model.
 *
 * All APIs accept either a ThreadItem or { item: ThreadItem }. presentResult also
 * accepts a final ThreadItem, { item }, { value: { item } }, or a DSH ToolResult
 * with meta: { item }. Final snapshots take precedence over pending arguments.
 * Non-tool messages return null names/arguments, undefined views, and [] content.
 *
 * Shapes target @deepseek-ai/dsh-tools' presentation.ts, not invented card types.
 * Native FileUpdateChange.diff is NOT a FileDiff before/after image. Only validated
 * structured before/after metadata produces a diff card; patches remain readable.
 * This module has no dependencies, filesystem access, or model/network calls.
 */

const NON_TOOLS = new Set(['agentMessage', 'reasoning', 'userMessage', 'hookPrompt']);
const LITERAL_FIELDS = new Set([
  'command', 'cmd', 'code', 'cwd', 'path', 'diff', 'patch', 'oldText', 'newText',
  'aggregatedOutput', 'stdout', 'stderr', 'prompt', 'revisedPrompt', 'review',
]);
const OUTPUT_FIELDS = new Set([
  'result', 'output', 'aggregatedOutput', 'stdout', 'stderr', 'exitCode', 'durationMs',
  'contentItems', 'agentsStates', 'results', 'error', 'failure', 'success',
]);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const MAX_DISPLAY_CHARS = 1024 * 1024;
const displayText = text => text.length > MAX_DISPLAY_CHARS
  ? text.slice(0, MAX_DISPLAY_CHARS) + '\n(human display truncated)' : text;
const textBlocks = text => [{ type: 'text', text: displayText(text) }];

// RPC ThreadItems are JSON. Keep those lossless and detached, but do not let
// unexpected in-process values break JSON.stringify(session arguments/meta).
// No getters/toJSON hooks are invoked; binary JS objects are never enumerated.
function snapshot(value, context = { seen: new Set(), nodes: 0 }, depth = 0) {
  const unavailable = reason => ({ _native_snapshot_unavailable: reason });
  if (++context.nodes > 50_000 || depth > 64) return unavailable('snapshot truncated');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : unavailable('non-finite number');
  if (value === undefined) return unavailable('not provided');
  if (typeof value !== 'object') return unavailable(`unsupported ${typeof value}`);
  if (context.seen.has(value)) return unavailable('circular reference');
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return unavailable('non-JSON object');
  context.seen.add(value);
  const out = Array.isArray(value) ? [] : {};
  const keys = Array.isArray(value) ? Array.from({ length: Math.min(value.length, 50_000) }, (_, index) => String(index)) : Object.keys(value);
  for (const key of keys) {
    if (context.nodes >= 50_000) {
      if (Array.isArray(out)) out.push('(snapshot truncated)');
      else Object.defineProperty(out, '_snapshot_truncated', { value: true, enumerable: true });
      break;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    Object.defineProperty(out, key, { value: descriptor === undefined ? null : own(descriptor, 'value')
      ? snapshot(descriptor.value, context, depth + 1) : unavailable('accessor not evaluated'),
    writable: true, configurable: true, enumerable: true });
  }
  if (Array.isArray(value) && value.length > keys.length && context.nodes < 50_000) out.push('(snapshot truncated)');
  context.seen.delete(value);
  return out;
}

function unwrap(value) {
  if (!record(value)) return undefined;
  value = snapshot(value);
  if (typeof value.type === 'string') return value;
  if (record(value.item) && typeof value.item.type === 'string') return value.item;
  return undefined;
}

function toolItem(value) {
  const item = unwrap(value);
  return item && item.type && !NON_TOOLS.has(item.type) ? item : undefined;
}

function finalItem(input, result) {
  return unwrap(result?.value) ?? unwrap(result?.meta) ?? unwrap(result?.presentationMeta)
    ?? unwrap(result) ?? unwrap(input);
}

function label(key) {
  key = String(key);
  if (key.length > 256) key = key.slice(0, 256) + '…';
  const spaced = key.replace(/^_+/, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ');
  return spaced ? spaced[0].toUpperCase() + spaced.slice(1) : 'Value';
}

function parsedContainer(value) {
  if (typeof value !== 'string' || !/^[\s]*[\[{]/.test(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return parsed !== null && typeof parsed === 'object' ? parsed : value;
  } catch {
    return value;
  }
}

function indent(text, spaces = 2) {
  const prefix = ' '.repeat(spaces);
  return text.split('\n').map(line => prefix + line).join('\n');
}

function field(key, value, seen = new Set()) {
  const rendered = readable(value, seen, !LITERAL_FIELDS.has(key));
  return `${label(key)}:${rendered.includes('\n') ? '\n' + indent(rendered) : ' ' + rendered}`;
}

function mediaReference(value, depth = 0, context = { nodes: 0, remaining: MAX_DISPLAY_CHARS }) {
  if (++context.nodes > 10_000 || depth > 32 || context.remaining <= 0) return '(media display truncated)';
  const take = text => {
    const result = text.length > context.remaining ? text.slice(0, context.remaining) + '\n(media display truncated)' : text;
    context.remaining = Math.max(0, context.remaining - text.length);
    return result;
  };
  if (typeof value === 'string' && /^data:/i.test(value)) {
    const mime = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+)(?=[;,])/i.exec(value)?.[1];
    return take(`Embedded ${mime || 'media'} (${value.length} characters; native data retained)`);
  }
  if (typeof value === 'string' && /^[a-z0-9+/=_-]{128,}$/i.test(value)) return take(`Embedded media (${value.length} encoded characters; native data retained)`);
  if (Array.isArray(value) || record(value)) {
    const parts = [];
    for (const [key, entry] of Object.entries(value)) {
      const prefix = Array.isArray(value) ? '' : take(`${label(key)}: `);
      parts.push(prefix + (['data', 'blob', 'base64', 'bytes', 'b64_json'].includes(key)
        ? take(`${typeof entry === 'string' ? entry.length : 'unknown'} encoded characters (native data retained)`)
        : mediaReference(entry, depth + 1, context)));
      if (context.remaining <= 0 || context.nodes > 10_000) break;
    }
    return displayText(parts.join('\n'));
  }
  return take(readable(value));
}

/** Content blocks are rendered as text, including MCP resources and future keys. */
function contentBlock(block, seen) {
  const type = block.type;
  let summary;
  let consumed = [];
  if (['text', 'inputText', 'input_text'].includes(type) && typeof block.text === 'string') {
    summary = readable(block.text, seen);
    consumed = ['text'];
  } else if (['image', 'inputImage', 'input_image', 'audio', 'inputAudio', 'input_audio'].includes(type)) {
    const image = /image/i.test(type);
    const key = ['imageUrl', 'image_url', 'audioUrl', 'audio_url', 'url', 'file_id', 'image']
      .find(key => own(block, key));
    summary = `${image ? 'Image' : 'Audio'}: ${key ? mediaReference(block[key]) : 'embedded media'}`;
    consumed = key ? [key] : [];
    for (const encodedKey of ['data', 'blob', 'base64', 'bytes']) {
      if (!own(block, encodedKey)) continue;
      summary += `\nEncoded ${encodedKey}: ${typeof block[encodedKey] === 'string' ? block[encodedKey].length : 'unknown'} characters (native data retained)`;
      consumed.push(encodedKey);
    }
  } else if (type === 'encrypted_content') {
    summary = 'Encrypted content (native data retained)';
    consumed = ['encrypted_content', 'data', 'blob', 'ciphertext', 'base64', 'bytes'];
  } else if (type === 'resource' && record(block.resource)) {
    summary = `Resource\n${readable(block.resource, seen)}`;
    consumed = ['resource'];
  } else if (type === 'resource_link') {
    summary = `Resource link: ${mediaReference(block.uri)}`;
    consumed = ['uri'];
  } else {
    return undefined;
  }
  const rest = Object.entries(block).filter(([key]) => key !== 'type' && !consumed.includes(key));
  return [summary, ...rest.map(([key, value]) => field(key, value, seen))].join('\n');
}

/** No JSON serialization: nested objects become labeled fields and arrays lists. */
function readable(value, seen = new Set(), parse = true) {
  seen.nodes = (seen.nodes ?? 0) + 1;
  seen.remaining ??= MAX_DISPLAY_CHARS;
  if (seen.nodes > 10_000 || seen.size > 32 || seen.remaining <= 0) return '(human display truncated)';
  if (typeof value === 'string' && /^data:/i.test(value)) return mediaReference(value);
  if (parse) {
    if (typeof value === 'string' && value.length > MAX_DISPLAY_CHARS && /^[\s]*[\[{]/.test(value)) return '(structured human display too large)';
    value = parsedContainer(value);
  }
  if (value === null || value === undefined) return '(not provided)';
  if (typeof value === 'string') {
    const limit = seen.remaining;
    seen.remaining = Math.max(0, limit - value.length);
    return value === '' ? '(empty)' : value.length > limit ? value.slice(0, limit) + '\n(human display truncated)' : value;
  }
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '(circular reference)';
  seen.add(value);
  let rendered;
  if (Array.isArray(value)) {
    const parts = [];
    for (const [index, entry] of value.entries()) {
      const body = readable(entry, seen);
      parts.push(`${index + 1}. ${body.replace(/\n/g, '\n   ')}`);
      if (seen.remaining <= 0 || seen.nodes > 10_000) break;
    }
    rendered = parts.length ? parts.join('\n') : '(none)';
  } else {
    rendered = contentBlock(value, seen);
    if (rendered === undefined) {
      const entries = Object.entries(value), parts = [];
      const binary = /^(?:image|audio|video)\/|^application\/octet-stream$/i.test(value.mimeType ?? value.mime_type ?? '');
      for (const [key, entry] of entries) {
        parts.push(binary && ['data', 'blob', 'base64', 'bytes', 'b64_json'].includes(key)
          ? `${label(key)}: embedded media (${typeof entry === 'string' ? entry.length : 'unknown'} encoded characters; native data retained)`
          : field(key, entry, seen));
        if (seen.remaining <= 0 || seen.nodes > 10_000) break;
      }
      rendered = parts.length ? parts.join('\n') : '(no fields)';
    }
  }
  seen.delete(value);
  return displayText(rendered);
}

function fields(item, omitted = []) {
  const skip = new Set(['type', 'id', ...omitted]), seen = new Set(), parts = [];
  for (const [key, value] of Object.entries(item)) {
    if (skip.has(key)) continue;
    parts.push(field(key, value, seen));
    if (seen.remaining <= 0 || seen.nodes > 10_000) break;
  }
  return displayText(parts.join('\n'));
}

function fence(text, language = '') {
  const runs = String(text).match(/`+/g) ?? [];
  const marker = '`'.repeat(runs.reduce((max, run) => Math.max(max, run.length + 1), 3));
  return `${marker}${language}\n${text}${text.endsWith('\n') ? '' : '\n'}${marker}`;
}

function qualifiedTool(item) {
  return [item.server ?? item.namespace, item.tool ?? item.name].filter(value => typeof value === 'string' && value).join('.');
}

const STANDARD_NAMES = {
  commandExecution: 'bash', fileChange: 'apply_patch', imageView: 'view_image',
  imageGeneration: 'imagegen', plan: 'update_plan', contextCompaction: 'compact_context',
  codeExecution: 'exec', sleep: 'sleep', subAgentActivity: 'agent_activity',
  enteredReviewMode: 'enter_review_mode', exitedReviewMode: 'exit_review_mode',
};
const COLLAB_NAMES = {
  spawnAgent: 'spawn_agent', sendInput: 'send_input', resumeAgent: 'resume_agent',
  wait: 'wait', closeAgent: 'close_agent', sendMessage: 'send_message',
  followupTask: 'followup_task', interruptAgent: 'interrupt_agent', listAgents: 'list_agents',
};
const UI_NAMES = new Set([...Object.values(STANDARD_NAMES), ...Object.values(COLLAB_NAMES), 'exec_command', 'web_search', 'web_fetch', 'run_code']);
function safeName(name) {
  return (typeof name === 'string' ? name : 'native_tool').replace(/[^a-zA-Z0-9_-]/g, '_');
}
function snakeName(name) {
  return safeName((typeof name === 'string' ? name : 'nativeTool').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase());
}

const COLLAB_TITLES = {
  spawnAgent: 'Spawn agent', sendInput: 'Send input to agent', resumeAgent: 'Resume agent',
  wait: 'Wait for agents', closeAgent: 'Close agent', sendMessage: 'Message agent',
  followupTask: 'Assign follow-up task', interruptAgent: 'Interrupt agent', listAgents: 'List agents',
};

function title(item) {
  switch (item.type) {
    case 'commandExecution': return typeof item.command === 'string' && item.command ? item.command : 'Execute command';
    case 'fileChange': return `Change files${item.changes?.length ? ` (${item.changes.length})` : ''}`;
    case 'mcpToolCall': return `MCP · ${qualifiedTool(item) || 'Tool call'}`;
    case 'dynamicToolCall': return qualifiedTool(item) || 'Dynamic tool call';
    case 'functionCallOutput': return qualifiedTool(item) || 'Native tool output';
    case 'webSearch': {
      if (item.action?.type === 'openPage') return 'Open web page';
      if (item.action?.type === 'findInPage') return 'Find in web page';
      return 'Search web';
    }
    case 'imageView': return 'View image';
    case 'imageGeneration': return 'Generate image';
    case 'collabAgentToolCall': return COLLAB_TITLES[item.tool] ?? `Agent · ${label(item.tool ?? 'tool call')}`;
    case 'subAgentActivity': return `Agent activity · ${label(item.kind ?? 'activity')}`;
    case 'codeExecution': return `Execute code${item.language ? ` (${item.language})` : ''}`;
    case 'plan': return 'Update plan';
    case 'contextCompaction': return 'Compact context';
    case 'sleep': return 'Wait';
    case 'enteredReviewMode': return 'Enter review mode';
    case 'exitedReviewMode': return 'Finish review';
    default: return label(item.type);
  }
}

function resultTitle(item) {
  const state = item.status ?? (item.success === false ? 'failed' : undefined);
  return `${title(item)}${state ? ` — ${label(state).toLowerCase()}` : ''}`;
}

function locations(item) {
  const paths = item.type === 'fileChange'
    ? (Array.isArray(item.changes) ? item.changes.flatMap(change => record(change) ? [change.path, change.kind?.move_path] : []) : [])
    : [item.path ?? item.savedPath, ...(Array.isArray(item.commandActions) ? item.commandActions.map(action => action?.path) : [])];
  return [...new Set(paths.filter(path => typeof path === 'string' && path))].map(path => ({ path }));
}

/** Standard UI-recognized aliases; NOT model-callable/executable native tools. */
export function nativeToolName(input) {
  const item = toolItem(input);
  if (!item) return null;
  if (item.type === 'webSearch') return item.action?.type === 'openPage' ? 'web_fetch' : 'web_search';
  if (item.type === 'collabAgentToolCall') return COLLAB_NAMES[item.tool] ?? snakeName(item.tool ?? 'agent_tool');
  if (item.type === 'mcpToolCall') return `mcp__${safeName(item.server ?? 'server')}__${safeName(item.tool ?? 'tool')}`;
  if (item.type === 'dynamicToolCall' || item.type === 'functionCallOutput') {
    const local = item.tool ?? item.name;
    if (UI_NAMES.has(local)) return local;
    return safeName(qualifiedTool(item) || (item.type === 'functionCallOutput' ? 'tool_output' : 'dynamic_tool'));
  }
  return STANDARD_NAMES[item.type] ?? snakeName(item.type);
}

/** Lossless detached snapshot plus convenient, human-readable canonical inputs. */
export function nativeToolArguments(input) {
  const item = toolItem(input);
  if (!item) return null;
  const args = { _codex_native: true, description: title(item) };
  const nativeArgs = parsedContainer(item.arguments);
  const sources = [item, ...(record(nativeArgs) ? [nativeArgs] : [])];
  for (const key of ['cwd', 'workdir', 'path', 'query', 'url', 'code', 'language', 'prompt', 'tool', 'server', 'namespace']) {
    const source = sources.find(source => typeof source[key] === 'string');
    if (source) args[key] = source[key];
  }
  const command = sources.map(source => source.cmd ?? source.command).find(value => typeof value === 'string');
  if (command !== undefined) { args.cmd = command; args.command = command; }
  if (args.cwd !== undefined) args.workdir = args.cwd;
  else if (args.workdir !== undefined) args.cwd = args.workdir;
  const files = locations(item).map(location => location.path);
  if (files.length) {
    args.path ??= files[0];
    if (item.type === 'fileChange') args.paths = files;
  }
  if (item.type === 'webSearch') {
    if (typeof item.action?.url === 'string') args.url = item.action.url;
    if (typeof item.action?.pattern === 'string') args.pattern = item.action.pattern;
    const queries = item.action?.queries ?? [item.action?.query ?? item.query];
    args.queries = Array.isArray(queries) ? queries.filter(query => typeof query === 'string' && query.trim()) : [];
    if (!args.queries.length && typeof item.query === 'string' && item.query.trim()) args.queries = [item.query];
  }
  if (item.type === 'collabAgentToolCall') {
    if (Array.isArray(item.receiverThreadIds)) {
      args.ids = snapshot(item.receiverThreadIds);
      if (item.receiverThreadIds.length === 1) args.id = item.receiverThreadIds[0];
    }
    if (typeof item.prompt === 'string') args.message = item.prompt;
    if (typeof item.model === 'string') args.model = item.model;
    if (typeof item.reasoningEffort === 'string') args.reasoning_effort = item.reasoningEffort;
  }
  if (item.type === 'imageGeneration') {
    if (typeof item.savedPath === 'string') args.path = item.savedPath;
    if (typeof item.revisedPrompt === 'string') args.prompt = item.revisedPrompt;
  }
  // Human input is independent of registered presenters. No JSON object dump.
  if (item.type === 'commandExecution') args.input = item.command ?? title(item);
  else if (item.type === 'fileChange') args.input = fileChangeText(item);
  else if (item.type === 'plan') { args.input = item.text ?? title(item); args.explanation = args.input; }
  else if (item.type === 'codeExecution') args.input = item.code ?? fields(item, [...OUTPUT_FIELDS]);
  else if (['dynamicToolCall', 'mcpToolCall'].includes(item.type)) {
    const literalInput = record(nativeArgs) ? nativeArgs.input ?? nativeArgs.patch : undefined;
    args.input = typeof literalInput === 'string' && ['apply_patch', 'exec', 'run_code'].includes(item.tool)
      ? literalInput : readable(item.arguments);
    for (const key of ['queries', 'plan', 'ids', 'id', 'message', 'pattern', 'explanation']) {
      if (record(nativeArgs) && own(nativeArgs, key)) args[key] = snapshot(nativeArgs[key]);
    }
  }
  else args.input = fields(item, [...OUTPUT_FIELDS]) || title(item);
  if (typeof args.input !== 'string') args.input = readable(args.input);
  args.input = displayText(args.input);
  args.item = snapshot(item);
  return args;
}

/** Persist final native data plus canonical raw-card metadata on ToolResult.meta. */
export function nativePresentationMeta(input) {
  const item = toolItem(input);
  if (!item) return null;
  const meta = { item: snapshot(item) };
  if (item.type === 'fileChange') {
    const diffs = structuredDiffs(item);
    if (diffs) meta.diffs = diffs;
  } else if (item.type === 'commandExecution') {
    if (typeof item.aggregatedOutput === 'string') meta.output = item.aggregatedOutput;
    if (typeof item.exitCode === 'number' && Number.isInteger(item.exitCode)) meta.exitCode = item.exitCode;
    else if (typeof item.signal === 'string') meta.signal = item.signal;
  } else if (item.type === 'webSearch') {
    const view = webResult(item);
    if (view) {
      for (const key of ['sources', 'answer', 'url', 'statusCode', 'truncated']) {
        if (own(view, key)) meta[key] = snapshot(view[key]);
      }
    }
  }
  return meta;
}

function validDiff(diff) {
  return record(diff) && typeof diff.path === 'string' && diff.path.length > 0
    && own(diff, 'oldText') && (diff.oldText === null || typeof diff.oldText === 'string')
    && typeof diff.newText === 'string';
}

function structuredDiffs(item) {
  // Failed/declined changes must not masquerade as successfully applied diffs.
  if (['failed', 'declined', 'rejected', 'interrupted', 'cancelled'].includes(item.status) || item.success === false) return undefined;
  const candidates = [item.diffs, item.presentationMeta?.diffs, item.meta?.diffs, item.changes];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate) || !candidate.length || !candidate.every(validDiff)) continue;
    // A partial projection must not make the UI silently lose other changed files.
    if (Array.isArray(item.changes) && item.changes.length && !item.changes.every(change =>
      record(change) && candidate.some(diff => diff.path === change.path || diff.path === change.kind?.move_path))) continue;
    return candidate.map(({ path, oldText, newText }) => ({ path, oldText, newText }));
  }
  return undefined;
}

function fileChangeText(item) {
  const parts = [resultTitle(item)];
  if (Array.isArray(item.changes)) {
    for (const [index, change] of item.changes.entries()) {
      if (!record(change)) { parts.push(`Change ${index + 1}: ${readable(change)}`); continue; }
      const kind = typeof change.kind === 'string' ? change.kind : change.kind?.type;
      parts.push(`${label(kind || 'change')}: ${change.path ?? '(path not provided)'}`);
      if (change.kind?.move_path) parts.push(`Moved to: ${change.kind.move_path}`);
      if (typeof change.diff === 'string') parts.push(change.diff ? fence(change.diff, 'diff') : 'Patch: (empty)');
      const extra = fields(change, ['path', 'diff', 'kind']);
      if (extra) parts.push(extra);
      if (record(change.kind)) {
        const extraKind = fields(change.kind, ['move_path']);
        if (extraKind) parts.push(extraKind);
      }
    }
    if (!item.changes.length) parts.push('Changes: (none)');
  }
  const rest = fields(item, ['changes', 'status']);
  if (rest) parts.push(rest);
  return parts.join('\n\n');
}

function agentResultText(item) {
  const parts = [resultTitle(item), fields(item, ['status', 'agentsStates'])];
  if (record(item.agentsStates)) {
    const ids = [...new Set([...(Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds.filter(id => typeof id === 'string') : []), ...Object.keys(item.agentsStates)])];
    for (const id of ids) {
      const state = item.agentsStates[id];
      parts.push(`Agent ${id}: ${state?.status ? label(state.status).toLowerCase() : '(status not reported)'}`);
      if (record(state)) {
        const details = fields(state, ['status']);
        if (details) parts.push(details);
      } else if (state !== undefined) parts.push(readable(state));
    }
    if (!ids.length) parts.push('Agents: (none)');
  } else parts.push('Agent states: (not provided)');
  return parts.filter(Boolean).join('\n\n');
}

function imageGenerationText(item) {
  const parts = [resultTitle(item), fields(item, ['result', 'status'])];
  if (typeof item.result === 'string' && item.result) {
    // Official result is encoded image data, not a text/tool JSON response.
    parts.push(`Generated image: ${item.result.length} encoded characters (native data retained)`);
  } else parts.push(`Generated image: ${mediaReference(item.result)}`);
  return parts.filter(Boolean).join('\n\n');
}

/** Text-only human fallback; never feed this projection back into native Codex. */
export function nativeResultContent(input) {
  const item = toolItem(input);
  if (!item) return [];
  let body;
  switch (item.type) {
    case 'commandExecution': {
      const parts = [resultTitle(item)];
      if (own(item, 'aggregatedOutput')) {
        parts.push(typeof item.aggregatedOutput === 'string'
          ? `Output:\n${item.aggregatedOutput === '' ? '(empty)' : item.aggregatedOutput}`
          : 'Output: (not provided)');
      }
      const details = fields(item, ['command', 'status', 'aggregatedOutput']);
      if (details) parts.push(details);
      body = parts.join('\n\n');
      break;
    }
    case 'fileChange': body = fileChangeText(item); break;
    case 'collabAgentToolCall': body = agentResultText(item); break;
    case 'imageGeneration': body = imageGenerationText(item); break;
    case 'codeExecution': {
      const details = fields(item, ['code', 'output']);
      body = [resultTitle(item), typeof item.code === 'string' ? fence(item.code) : '', details,
        own(item, 'output') ? `Output:\n${typeof item.output === 'string' ? item.output : readable(item.output)}` : '']
        .filter(Boolean).join('\n\n');
      break;
    }
    default: body = [resultTitle(item), fields(item)].filter(Boolean).join('\n\n');
  }
  return textBlocks(body);
}

/** DSH pending-call intent. Generic rawInput is always text, never a JSON object. */
export function nativeCallPresentation(input) {
  const item = toolItem(input);
  if (!item) return undefined;
  if (item.type === 'commandExecution') {
    return { card: 'terminal', title: title(item), ...(typeof item.cwd === 'string' ? { cwd: item.cwd } : {}) };
  }
  if (item.type === 'fileChange') {
    const diffs = structuredDiffs(item);
    if (diffs) return { card: 'diff', title: title(item), diffs, locations: locations(item).length ? locations(item) : diffs.map(diff => ({ path: diff.path })) };
    return { card: 'generic', kind: 'edit', title: title(item), content: nativeResultContent(item), locations: locations(item) };
  }
  let kind = 'other';
  if (item.type === 'imageView') kind = 'read';
  else if (item.type === 'webSearch') kind = item.action?.type === 'openPage' ? 'fetch' : 'search';
  else if (['codeExecution', 'collabAgentToolCall', 'dynamicToolCall', 'mcpToolCall'].includes(item.type)) kind = 'execute';
  else if (/browser/i.test(item.type)) kind = 'fetch';
  let details;
  if (['mcpToolCall', 'dynamicToolCall'].includes(item.type)) {
    details = `Arguments:\n${readable(item.arguments)}`;
  } else if (item.type === 'codeExecution' && typeof item.code === 'string') {
    details = fence(item.code);
    const extra = fields(item, ['code', ...OUTPUT_FIELDS]);
    if (extra) details += `\n\n${extra}`;
  } else details = fields(item, [...OUTPUT_FIELDS]);
  const fileLocations = locations(item);
  return {
    card: 'generic', kind, title: title(item),
    ...(details ? { rawInput: displayText(details), content: textBlocks(details) } : {}),
    ...(fileLocations.length ? { locations: fileLocations } : {}),
  };
}

function webResult(item) {
  const action = item.action?.type;
  // Official openPage has no HTTP status: do not fabricate a fetch card/status.
  if (action === 'openPage' && typeof item.action.url === 'string' && Number.isInteger(item.statusCode) && item.statusCode >= 100 && item.statusCode <= 599 && !['failed', 'declined', 'interrupted', 'cancelled'].includes(item.status) && item.success !== false) {
    return { card: 'web', kind: 'fetch', title: resultTitle(item), url: item.action.url,
      statusCode: item.statusCode, truncated: item.truncated === true };
  }
  if (action === 'openPage' || action === 'findInPage') return undefined;
  const entries = item.sources ?? item.results;
  if (!Array.isArray(entries)) return undefined;
  const decoded = entries.map(parsedContainer);
  // Opaque/new result shapes get the readable fallback, not dropped sources.
  if (!decoded.every(entry => record(entry) && typeof entry.url === 'string' && entry.url)) return undefined;
  const sources = decoded.map(entry => {
    const source = { url: entry.url };
    for (const key of ['title', 'snippet', 'publishedAt']) {
      if (typeof entry[key] === 'string') source[key] = entry[key];
    }
    return source;
  });
  const view = { card: 'web', kind: 'search', title: resultTitle(item), sources, truncated: item.truncated === true };
  // The web card has no content slot. Keep opaque extra fields visible in answer.
  const extras = decoded.map((entry, index) => {
    const body = fields(entry, ['url', 'title', 'snippet', 'publishedAt']);
    return body ? `Source ${index + 1}\n${body}` : '';
  }).filter(Boolean);
  const extraItem = fields(item, ['query', 'action', 'sources', 'results', 'answer', 'truncated', 'status']);
  if (extraItem) extras.push(extraItem);
  const answer = [own(item, 'answer') && item.answer !== null ? readable(item.answer) : '', ...extras].filter(Boolean).join('\n\n');
  if (answer) view.answer = answer;
  return view;
}

/** DSH completed intent, using final metadata on both live and replay paths. */
export function nativeResultPresentation(input, result) {
  const item = toolItem(finalItem(input, result));
  if (!item) return undefined;
  // A bridge-level failure without a native final snapshot must stay visible.
  if (result?.isError === true && item.success !== false && !['failed', 'declined', 'rejected', 'interrupted', 'cancelled'].includes(item.status)) {
    return { card: 'generic', title: `${title(item)} — failed`, content: textBlocks(readable(result.content ?? 'Native observation failed')) };
  }
  if (item.type === 'commandExecution') {
    const view = { card: 'terminal', title: resultTitle(item) };
    if (typeof item.aggregatedOutput === 'string') view.output = item.aggregatedOutput;
    if (typeof item.exitCode === 'number' && Number.isInteger(item.exitCode)) view.exitCode = item.exitCode;
    else if (typeof item.signal === 'string') view.signal = item.signal;
    return view;
  }
  if (item.type === 'fileChange') {
    const diffs = structuredDiffs(item);
    if (diffs) return { card: 'diff', title: resultTitle(item), diffs };
  }
  if (item.type === 'webSearch') {
    const view = webResult(item);
    if (view) return view;
  }
  return { card: 'generic', title: resultTitle(item), content: nativeResultContent(item) };
}
