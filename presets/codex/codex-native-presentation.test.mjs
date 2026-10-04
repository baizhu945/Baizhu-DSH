import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, existsSync, mkdtempSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import {
  nativeToolName, nativeToolArguments, nativeCallPresentation,
  nativeResultContent, nativeResultPresentation, nativePresentationMeta,
} from './codex-native-presentation.mjs';

// Only local, pure presentation tests. No native process, credentials or SDK.
const text = blocks => blocks.map(block => {
  assert.equal(block.type, 'text');
  assert.equal(typeof block.text, 'string');
  return block.text;
}).join('\n');
const body = item => text(nativeResultContent(item));
const command = (overrides = {}) => ({
  type: 'commandExecution', id: 'cmd-1', pluginId: null, scriptPath: null,
  command: 'printf "hello\\nworld\\n"\npwd', cwd: '/work/project', processId: '42',
  source: 'agent', status: 'completed', commandActions: [{ type: 'unknown', command: 'printf' }],
  aggregatedOutput: 'hello\nworld\n/work/project\n', exitCode: 0, durationMs: 0, ...overrides,
});
const fileChange = (changes, overrides = {}) => ({ type: 'fileChange', id: 'patch-1', status: 'completed', changes, ...overrides });
const mcp = (overrides = {}) => ({
  type: 'mcpToolCall', id: 'mcp-1', server: 'docs', tool: 'lookup', status: 'completed',
  arguments: { query: 'NixOS', path: '/work/config.nix', limit: 0 }, appContext: null,
  mcpAppUi: null, pluginId: null, readOnlyHint: true, durationMs: 12,
  result: { content: [{ type: 'text', text: 'Found docs\nSee https://example.org' }], structuredContent: null, _meta: null },
  error: null, ...overrides,
});
const collab = (overrides = {}) => ({
  type: 'collabAgentToolCall', id: 'collab-1', tool: 'wait', status: 'completed',
  senderThreadId: 'parent', receiverThreadIds: ['agent-a', 'agent-b'], prompt: null,
  model: 'native-model', reasoningEffort: 'high', agentsStates: {
    'agent-a': { status: 'completed', message: 'Implemented\nTests passed' },
    'agent-b': { status: 'errored', message: 'Permission denied' },
  }, ...overrides,
});
const web = (overrides = {}) => ({
  type: 'webSearch', id: 'web-1', query: 'NixOS options',
  action: { type: 'search', query: 'NixOS options', queries: ['NixOS options', 'home-manager options'] },
  results: [{ url: 'https://example.org', title: 'Options', snippet: 'Declarative configuration', publishedAt: '2026-01-01' }],
  ...overrides,
});

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

function assertReadable(value) {
  assert.doesNotMatch(value, /\[object Object\]|"[\w_]+"\s*:/);
}

function assertNoUndefined(value) {
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      assert.notEqual(child, undefined, `undefined presentation field: ${key}`);
      assertNoUndefined(child);
    }
  }
}

test('non-tool messages are not registered or presented as tools', () => {
  for (const type of ['agentMessage', 'reasoning', 'userMessage', 'hookPrompt']) {
    const item = { type, id: 'message', text: 'hello', content: [] };
    assert.equal(nativeToolName(item), null);
    assert.equal(nativeToolArguments(item), null);
    assert.equal(nativePresentationMeta(item), null);
    assert.equal(nativeCallPresentation(item), undefined);
    assert.equal(nativeResultPresentation(item), undefined);
    assert.deepEqual(nativeResultContent(item), []);
  }
  for (const invalid of [null, undefined, {}, 'commandExecution', []]) {
    assert.equal(nativeToolName(invalid), null);
    assert.equal(nativeCallPresentation(invalid), undefined);
    assert.deepEqual(nativeResultContent(invalid), []);
  }
});

test('observations use standard names and retain native dynamic/MCP identities', () => {
  assert.equal(nativeToolName(command()), 'bash');
  assert.equal(nativeToolName(command({ id: 'different', command: 'pwd' })), nativeToolName(command()));
  assert.equal(nativeToolName(fileChange([])), 'apply_patch');
  assert.equal(nativeToolName({ type: 'imageView', path: '/image' }), 'view_image');
  assert.equal(nativeToolName({ type: 'plan', text: 'Plan' }), 'update_plan');
  assert.equal(nativeToolName(web()), 'web_search');
  assert.equal(nativeToolName(web({ action: { type: 'openPage', url: 'https://example.org' } })), 'web_fetch');
  assert.equal(nativeToolName(collab({ tool: 'spawnAgent' })), 'spawn_agent');
  assert.equal(nativeToolName(collab()), 'wait');
  assert.equal(nativeToolName({ type: 'codeExecution' }), 'exec');
  assert.equal(nativeToolName(mcp()), 'mcp__docs__lookup');
  assert.equal(nativeToolName({ type: 'dynamicToolCall', namespace: 'browser', tool: 'click' }), 'browser_click');
  assert.equal(nativeToolName({ type: 'futureTool-v3', id: 'new' }), 'future_tool-v3');
});

test('arguments and replay metadata contain detached, exact native snapshots', () => {
  const item = freeze(mcp({ future: { list: [null, false, 0, { native: 'unchanged' }] } }));
  const before = structuredClone(item);
  const args = nativeToolArguments(item);
  const meta = nativePresentationMeta({ item });
  assert.deepEqual(args.item, before);
  assert.deepEqual(meta, { item: before });
  assert.notEqual(args.item, item);
  assert.notEqual(meta.item, item);
  assert.equal(args.path, '/work/config.nix');
  assert.equal(args.query, 'NixOS');
  args.item.future.list[3].native = 'presentation-local';
  assert.deepEqual(item, before);
  assert.deepEqual(meta.item, before);
});

test('terminal call has exact command, cwd, and canonical cmd argument', () => {
  const item = command();
  assert.deepEqual(nativeCallPresentation(item), { card: 'terminal', title: item.command, cwd: item.cwd });
  assert.equal(nativeToolArguments(item).cmd, item.command);
  assert.equal(nativeToolArguments(item).cwd, item.cwd);
  assert.equal(nativeToolArguments(item).workdir, item.cwd);
  assert.equal(nativeToolArguments(item).command, item.command);
  assert.equal(nativeToolArguments(item).input, item.command);
  assert.equal(nativeToolArguments(item)._codex_native, true);
  assert.deepEqual(nativeCallPresentation(nativeToolArguments(item)), nativeCallPresentation(item));
});

test('terminal result preserves output/newlines and zero exit code/duration', () => {
  const item = command();
  const view = nativeResultPresentation(item);
  assert.equal(view.card, 'terminal');
  assert.equal(view.output, 'hello\nworld\n/work/project\n');
  assert.equal(view.exitCode, 0);
  assert.ok(body(item).includes(item.aggregatedOutput));
  assert.match(body(item), /Exit Code: 0|Exit code: 0/);
  assert.match(body(item), /Duration Ms: 0/);
  assert.ok(body(item).includes(item.cwd));
  assertNoUndefined(view);
});

test('terminal empty output, signal, unknown exit, and failure are not fabricated', () => {
  assert.equal(nativeResultPresentation(command({ aggregatedOutput: '' })).output, '');
  const signaled = nativeResultPresentation(command({ status: 'failed', exitCode: null, signal: 'SIGTERM' }));
  assert.equal(signaled.signal, 'SIGTERM');
  assert.ok(!('exitCode' in signaled));
  assert.match(signaled.title, /failed/);
  const pending = nativeResultPresentation(command({ status: 'inProgress', aggregatedOutput: null, exitCode: null }));
  assert.ok(!('output' in pending));
  assert.ok(!('exitCode' in pending));
  assert.match(body(command({ status: 'declined', error: { message: 'Approval declined' } })), /Approval declined/);
});

test('terminal JSON-looking stdout is still exact terminal output', () => {
  const output = '{"count":0}\n[1,2]\n';
  const item = command({ aggregatedOutput: output });
  assert.equal(nativeResultPresentation(item).output, output);
  assert.ok(body(item).includes(output));
});

test('completed value/meta overrides the pending snapshot on live and replay paths', () => {
  const pending = command({ status: 'inProgress', aggregatedOutput: null, exitCode: null });
  const final = command({ aggregatedOutput: 'FINAL\n', exitCode: 23, status: 'failed' });
  const args = nativeToolArguments(pending);
  const expected = nativeResultPresentation(final);
  for (const result of [final, { item: final }, { value: { item: final } },
    { content: [], isError: false, meta: nativePresentationMeta(final) },
    { presentationMeta: nativePresentationMeta(final) }]) {
    assert.deepEqual(nativeResultPresentation(args, result), expected);
  }
  const result = { value: { item: final }, meta: { item: pending } };
  assert.deepEqual(nativeResultPresentation(args, result), expected);
});

test('bridge errors without final metadata are readable, not stale pending output', () => {
  const view = nativeResultPresentation(nativeToolArguments(command({ status: 'inProgress' })), {
    isError: true, content: [{ type: 'text', text: '{"message":"Native process disconnected","retry":false}' }],
  });
  assert.equal(view.card, 'generic');
  assert.match(view.title, /failed/);
  assert.match(text(view.content), /Message: Native process disconnected/);
  assert.match(text(view.content), /Retry: false/);
  assertReadable(text(view.content));
});

test('validated before/after images produce diff call/result cards', () => {
  const changes = [
    { path: '/work/a', kind: { type: 'update', move_path: null }, diff: '@@\n-old\n+new\n' },
    { path: '/work/b', kind: { type: 'add' }, diff: 'created\n' },
  ];
  const diffs = [
    { path: '/work/a', oldText: 'old\n', newText: 'new\n', future: 'retained' },
    { path: '/work/b', oldText: null, newText: 'created\n' },
  ];
  const item = fileChange(changes, { presentationMeta: { diffs } });
  assert.equal(nativeCallPresentation(item).card, 'diff');
  assert.deepEqual(nativeResultPresentation(item).diffs, diffs.map(({ path, oldText, newText }) => ({ path, oldText, newText })));
  assert.equal(nativeToolArguments(item).item.presentationMeta.diffs[0].future, 'retained');
  assert.equal(nativeResultPresentation(item).card, 'diff');
  assert.deepEqual(nativeToolArguments(item).paths, ['/work/a', '/work/b']);
  assert.deepEqual(nativePresentationMeta({ item }).diffs, nativeResultPresentation(item).diffs);
  assert.deepEqual(nativePresentationMeta({ item }).item, item);
});

test('diff metadata may be direct, meta, or structured changes including empty files', () => {
  const diffs = [{ path: '/empty', oldText: '', newText: '' }, { path: '/new', oldText: null, newText: '' }];
  for (const item of [fileChange([], { diffs }), fileChange([], { meta: { diffs } }), fileChange(diffs)]) {
    assert.deepEqual(nativeCallPresentation(item).diffs, diffs);
    assert.deepEqual(nativeResultPresentation(item).diffs, diffs);
  }
});

test('official native patch strings stay readable rather than pretend whole-file diffs', () => {
  const patch = '@@ -10,2 +10,2 @@\n context\n-old\n+new\n';
  const item = fileChange([
    { path: '/work/old', kind: { type: 'update', move_path: '/work/new' }, diff: patch },
    { path: '/work/add', kind: { type: 'add' }, diff: 'new content\n' },
    { path: '/work/delete', kind: { type: 'delete' }, diff: 'old content\n' },
  ]);
  assert.equal(nativeCallPresentation(item).card, 'generic');
  assert.equal(nativeResultPresentation(item).card, 'generic');
  assert.ok(body(item).includes(patch));
  assert.match(body(item), /Moved to: \/work\/new/);
  assert.match(body(item), /Add: \/work\/add/);
  assert.match(body(item), /Delete: \/work\/delete/);
  assert.equal(nativeCallPresentation(item).kind, 'edit');
  assert.deepEqual(nativeToolArguments(item).paths, ['/work/old', '/work/new', '/work/add', '/work/delete']);
  assert.equal(nativeToolArguments(item).input, body(item));
  assert.equal(nativePresentationMeta(item).diffs, undefined);
});

test('invalid/partial diff metadata never loses native patches', () => {
  const changes = [{ path: '/a', kind: { type: 'update' }, diff: '@@\n-a\n+b\n' },
    { path: '/b', kind: { type: 'add' }, diff: 'hello\n' }];
  for (const diffs of [[], [{ path: '/a', newText: 'b' }], [{ path: '/a', oldText: 3, newText: 'b' }],
    [{ path: '/a', oldText: 'a', newText: 'b' }], [{ path: '', oldText: null, newText: 'b' }]]) {
    const item = fileChange(changes, { diffs });
    const view = nativeResultPresentation(item);
    assert.equal(view.card, 'generic');
    assert.ok(text(view.content).includes(changes[0].diff));
    assert.ok(text(view.content).includes(changes[1].diff));
  }
});

test('failed/declined file changes do not show a successfully applied diff card', () => {
  for (const status of ['failed', 'declined']) {
    const item = fileChange([{ path: '/a', oldText: 'a', newText: 'b' }], { status, error: { message: 'Cannot write' } });
    const view = nativeResultPresentation(item);
    assert.equal(view.card, 'generic');
    assert.match(view.title, new RegExp(status));
    assert.match(text(view.content), /Cannot write/);
  }
});

test('patch fences preserve code that itself contains backticks', () => {
  const patch = '@@\n+```javascript\n+const a = 1\n+```\n';
  const rendered = body(fileChange([{ path: '/doc', kind: { type: 'update' }, diff: patch }]));
  assert.ok(rendered.includes(patch));
  assert.match(rendered, /````diff\n/);
});

test('MCP arguments/results are human key-value text including parsed JSON strings', () => {
  const item = mcp({ arguments: '{"cmd":"pwd","path":"/work","flags":{"enabled":false}}', result: {
    content: [{ type: 'text', text: '{"answer":"yes","count":0,"nested":{"enabled":false}}' }],
    structuredContent: { extra: ['first', 'second'], empty: null }, _meta: { traceId: 'trace-1' },
  } });
  const call = nativeCallPresentation(item);
  assert.equal(call.card, 'generic');
  assert.equal(typeof call.rawInput, 'string');
  assert.match(call.rawInput, /Cmd: pwd/);
  assert.equal(nativeToolArguments(item).cmd, 'pwd');
  assert.equal(nativeToolArguments(item).path, '/work');
  const rendered = body(item);
  for (const expected of ['Answer: yes', 'Count: 0', 'Enabled: false', 'first', 'second', 'Trace Id: trace-1']) {
    assert.ok(rendered.includes(expected), expected);
  }
  assertReadable(rendered);
  assertReadable(call.rawInput);
  assert.deepEqual(nativeToolArguments(item).item, item);
});

test('MCP resources, images, audio, resource links and future content remain readable', () => {
  const item = mcp({ result: { content: [
    { type: 'resource', resource: { uri: 'file:///doc', mimeType: 'text/plain', text: 'line 1\nline 2' } },
    { type: 'image', mimeType: 'image/png', data: 'AAAA' },
    { type: 'audio', mimeType: 'audio/wav', data: 'BBBB', annotations: { label: 'clip' } },
    { type: 'resource_link', uri: 'https://example.org/resource', name: 'Reference' },
    { type: 'futureBlock', result: { count: 0, enabled: false } },
  ], structuredContent: null, _meta: null } });
  const rendered = body(item);
  for (const value of ['file:///doc', 'line 1', 'line 2', 'Image:', 'Audio:', '4 characters', 'Label: clip', 'https://example.org/resource', 'Reference', 'Count: 0', 'Enabled: false']) {
    assert.ok(rendered.includes(value), value);
  }
  assertReadable(rendered);
  assert.equal(nativeToolArguments(item).item.result.content[1].data, 'AAAA');
});

test('MCP error objects, UI context and future fields do not disappear', () => {
  const item = mcp({ status: 'failed', result: null,
    error: { message: 'Tool unavailable', nativeCode: 0, details: { retryable: false } },
    appContext: { appName: 'Docs', actionName: 'Lookup', resourceUri: 'ui://docs' },
    mcpAppUi: { resourceUri: 'ui://docs', future: { enabled: true } },
    futureResultField: { records: [1, 2] },
  });
  const view = nativeResultPresentation(item);
  assert.equal(view.card, 'generic');
  for (const expected of ['Tool unavailable', 'Native Code: 0', 'Retryable: false', 'ui://docs', 'Enabled: true', 'Records:']) {
    assert.ok(text(view.content).includes(expected), expected);
  }
  assertReadable(text(view.content));
});

test('dynamic tool content follows the actual inputText/inputImage/inputAudio schema', () => {
  const item = {
    type: 'dynamicToolCall', id: 'dynamic-1', namespace: 'browser', tool: 'open',
    arguments: { url: 'https://example.org' }, status: 'completed', success: true, durationMs: 3,
    contentItems: [
      { type: 'inputText', text: '{"title":"Page","links":["one","two"]}' },
      { type: 'inputImage', imageUrl: 'data:image/png;base64,AAAA' },
      { type: 'inputAudio', audioUrl: 'https://example.org/clip.wav' },
    ],
  };
  assert.equal(nativeCallPresentation(item).title, 'browser.open');
  assert.equal(nativeToolArguments(item).url, 'https://example.org');
  const rendered = body(item);
  assert.match(rendered, /Title: Page/);
  assert.match(rendered, /one/);
  assert.match(rendered, /Embedded image\/png/);
  assert.match(rendered, /https:\/\/example.org\/clip.wav/);
  assertReadable(rendered);
  assert.deepEqual(nativePresentationMeta(item).item.contentItems, item.contentItems);
});

test('native dynamic standard aliases keep canonical literal patch/code input and plan fields', () => {
  const patch = '*** Begin Patch\n*** Add File: /a\n+hello\n*** End Patch';
  const item = { type: 'dynamicToolCall', id: 'dynamic-patch', namespace: 'functions', tool: 'apply_patch',
    arguments: { input: patch }, status: 'completed', contentItems: [], success: true, durationMs: 0 };
  assert.equal(nativeToolName(item), 'apply_patch');
  assert.equal(nativeToolArguments(item).input, patch);
  const plan = { ...item, tool: 'update_plan', arguments: { explanation: 'Start', plan: [{ step: 'Inspect', status: 'in_progress' }] } };
  assert.equal(nativeToolName(plan), 'update_plan');
  assert.deepEqual(nativeToolArguments(plan).plan, plan.arguments.plan);
  assert.equal(nativeToolArguments(plan).explanation, 'Start');
});

test('dynamic failure with empty/null content still reports status and false success', () => {
  for (const contentItems of [[], null]) {
    const item = { type: 'dynamicToolCall', id: 'd', tool: 'lookup', namespace: null, arguments: {},
      status: 'failed', contentItems, success: false, durationMs: 0 };
    assert.match(body(item), /Success: false/);
    assert.match(nativeResultPresentation(item).title, /failed/);
    assert.match(body(item), /Duration Ms: 0/);
  }
});

test('web search uses the supported web result shape without fabricating sources', () => {
  const item = web();
  const call = nativeCallPresentation(item);
  assert.equal(call.card, 'generic');
  assert.equal(call.kind, 'search');
  const view = nativeResultPresentation(item);
  assert.deepEqual(view, { card: 'web', kind: 'search', title: 'Search web', sources: item.results, truncated: false });
  assert.deepEqual(nativeToolArguments(item).queries, ['NixOS options', 'home-manager options']);
  assert.deepEqual(nativePresentationMeta(item).sources, item.results);
  assert.equal(nativePresentationMeta(item).truncated, false);
  assert.deepEqual(nativePresentationMeta(item).item, item);
  assert.ok(body(item).includes('https://example.org'));
});

test('raw Web search metadata has canonical queries even with absent/empty action queries', () => {
  for (const action of [null, { type: 'search', query: null, queries: null }, { type: 'search', query: null, queries: [] }]) {
    const item = web({ action });
    assert.deepEqual(nativeToolArguments(item).queries, ['NixOS options']);
    assert.deepEqual(nativePresentationMeta({ item }).sources, item.results);
  }
});

test('web opaque/future results and null results use readable fallback', () => {
  for (const results of [null, [{ type: 'answer', data: { text: 'New result', count: 0 } }],
    [{ url: 'https://example.org' }, { future: 'Do not drop me' }]]) {
    const item = web({ results });
    const view = nativeResultPresentation(item);
    assert.equal(view.card, 'generic');
    assertReadable(text(view.content));
    if (results?.[1]?.future) assert.match(text(view.content), /Do not drop me/);
  }
  const empty = nativeResultPresentation(web({ results: [] }));
  assert.equal(empty.card, 'web');
  assert.deepEqual(empty.sources, []);
});

test('web structured sources retain extra result details in the web answer', () => {
  const item = web({ results: ['{"url":"https://example.org","title":"Docs","nativeRank":0,"details":{"fresh":true}}'],
    answer: 'Provider answer', truncated: true, futureField: 'native-extra' });
  const view = nativeResultPresentation(item);
  assert.equal(view.card, 'web');
  assert.equal(view.truncated, true);
  assert.match(view.answer, /Provider answer/);
  assert.match(view.answer, /Native Rank: 0/);
  assert.match(view.answer, /Fresh: true/);
  assert.match(view.answer, /native-extra/);
  assertReadable(view.answer);
});

test('future structured web answer objects remain visible as human fields', () => {
  const view = nativeResultPresentation(web({ answer: { summary: 'New answer', count: 0 } }));
  assert.match(view.answer, /Summary: New answer/);
  assert.match(view.answer, /Count: 0/);
  assertReadable(view.answer);
});

test('web open/find actions do not invent HTTP status or use invalid card kinds', () => {
  const item = web({ action: { type: 'openPage', url: 'https://example.org' }, results: null });
  assert.equal(nativeCallPresentation(item).kind, 'fetch');
  assert.equal(nativeResultPresentation(item).card, 'generic');
  assert.equal(nativeToolArguments(item).url, 'https://example.org');
  assert.deepEqual(nativeResultPresentation({ ...item, statusCode: 200, truncated: false }), {
    card: 'web', kind: 'fetch', title: 'Open web page', url: 'https://example.org', statusCode: 200, truncated: false,
  });
  const find = web({ action: { type: 'findInPage', url: 'https://example.org', pattern: 'configuration' } });
  assert.equal(nativeCallPresentation(find).kind, 'search');
  assert.equal(nativeResultPresentation(find).card, 'generic');
  assert.equal(nativeToolArguments(find).pattern, 'configuration');
  assert.match(body(find), /Pattern: configuration/);
});

test('image view/generation use generic cards, paths and readable failure details', () => {
  const viewImage = { type: 'imageView', id: 'view-1', path: '/work/screenshot.png' };
  assert.equal(nativeCallPresentation(viewImage).kind, 'read');
  assert.deepEqual(nativeCallPresentation(viewImage).locations, [{ path: viewImage.path }]);
  assert.match(body(viewImage), /screenshot\.png/);
  const generation = { type: 'imageGeneration', id: 'gen-1', status: 'completed', revisedPrompt: 'Draw a cat\nBlue background',
    result: 'AAAA', transparentBackground: false, failure: null, savedPath: '/work/cat.png' };
  assert.equal(nativeResultPresentation(generation).card, 'generic');
  assert.match(body(generation), /4 encoded characters/);
  assert.match(body(generation), /Draw a cat/);
  assert.match(body(generation), /Transparent Background: false/);
  assert.match(body(generation), /\/work\/cat\.png/);
  assert.equal(nativePresentationMeta(generation).item.result, 'AAAA');
  const failed = { ...generation, status: 'failed', result: '', failure: { type: 'usageLimitExceeded', limitId: 'image', resetsAt: 0 } };
  assert.match(body(failed), /UsageLimitExceeded|usageLimitExceeded/);
  assert.match(body(failed), /Resets At: 0/);
  assertReadable(body(failed));
});

test('collab result shows every target status/message and final states on replay', () => {
  const item = collab();
  const rendered = body(item);
  for (const expected of ['Agent agent-a: completed', 'Agent agent-b: errored', 'Implemented', 'Tests passed', 'Permission denied', 'native-model', 'Reasoning Effort: high']) {
    assert.ok(rendered.includes(expected), expected);
  }
  assertReadable(rendered);
  const pending = { ...item, status: 'inProgress', agentsStates: {} };
  const args = nativeToolArguments(pending);
  assert.deepEqual(nativeResultPresentation(args, { meta: nativePresentationMeta(item), content: [], isError: false }), nativeResultPresentation(item));
});

test('collab operations have readable labels and unknown/new statuses still display', () => {
  for (const tool of ['spawnAgent', 'sendInput', 'resumeAgent', 'wait', 'closeAgent', 'sendMessage', 'followupTask', 'interruptAgent', 'listAgents']) {
    assert.equal(nativeCallPresentation(collab({ tool })).card, 'generic');
    assert.notEqual(nativeCallPresentation(collab({ tool })).title, tool);
  }
  const item = collab({ agentsStates: {
    'agent-a': { status: 'pendingInit', message: null },
    'agent-b': { status: 'notFound', message: 'No thread', futureState: { retry: false } },
    'agent-c': { status: 'pausedByPolicy', message: 'Needs approval' },
  }, receiverThreadIds: ['agent-a', 'agent-b', 'agent-missing'] });
  for (const value of ['pending init', 'not found', 'paused by policy', 'No thread', 'Needs approval', 'Retry: false', 'Agent agent-missing: (status not reported)']) {
    assert.ok(body(item).includes(value), value);
  }
});

test('code execution displays code/output/newlines without claiming a shell terminal', () => {
  const item = { type: 'codeExecution', id: 'code-1', language: 'python', code: 'print("x")\nprint("y")\n',
    status: 'completed', output: 'x\ny\n', exitCode: 0, durationMs: 0, future: { resultCount: 0 } };
  assert.equal(nativeCallPresentation(item).card, 'generic');
  assert.equal(nativeCallPresentation(item).kind, 'execute');
  assert.ok(nativeCallPresentation(item).rawInput.includes(item.code));
  assert.equal(nativeResultPresentation(item).card, 'generic');
  assert.ok(body(item).includes(item.output));
  assert.match(body(item), /Result Count: 0/);
  assertReadable(body(item));
});

test('plan, context compaction, sleep, review and sub-agent activity are readable observations', () => {
  for (const item of [
    { type: 'plan', id: 'plan', text: '1. Inspect\n2. Implement\n3. Test' },
    { type: 'contextCompaction', id: 'compact' },
    { type: 'sleep', id: 'wait', durationMs: 0 },
    { type: 'enteredReviewMode', id: 'review', review: 'Review changes\nDo not edit' },
    { type: 'exitedReviewMode', id: 'review-end', review: 'No issues found' },
    { type: 'subAgentActivity', id: 'activity', kind: 'threadStarted', agentThreadId: 'child', agentPath: 'parent/child' },
  ]) {
    assert.ok(nativeToolName(item));
    assert.equal(nativeCallPresentation(item).card, 'generic');
    assert.equal(nativeResultPresentation(item).card, 'generic');
    assert.ok(body(item).length > 0);
    assertReadable(body(item));
    assertNoUndefined(nativeResultPresentation(item));
  }
  assert.ok(body({ type: 'plan', id: 'plan', text: 'one\ntwo\n' }).includes('one\n  two\n'));
});

test('browser future operations stay within the actual generic DSH vocabulary', () => {
  const item = { type: 'browserOperation', id: 'browser-1', action: 'click', url: 'https://example.org',
    arguments: { selector: '#submit', coordinates: [0, 42] }, status: 'completed',
    result: '{"title":"Done","navigation":{"url":"https://example.org/done"}}' };
  assert.equal(nativeCallPresentation(item).card, 'generic');
  assert.equal(nativeCallPresentation(item).kind, 'fetch');
  assert.match(body(item), /Title: Done/);
  assert.match(body(item), /https:\/\/example.org\/done/);
  assertReadable(body(item));
  assert.deepEqual(nativePresentationMeta(item).item, item);
});

test('functionCallOutput supports actual native content items and JSON text bodies', () => {
  const item = { type: 'functionCallOutput', id: 'out-1', name: 'browser.click', namespace: null, output: [
    { type: 'input_text', text: '{"clicked":true}' },
    { type: 'input_image', image_url: 'https://example.org/screen.png', detail: 'high' },
    { type: 'input_audio', audio_url: 'https://example.org/clip.wav' },
    { type: 'encrypted_content', encrypted_content: 'opaque' },
  ] };
  const rendered = body(item);
  assert.match(rendered, /Clicked: true/);
  assert.match(rendered, /screen\.png/);
  assert.match(rendered, /clip\.wav/);
  assert.match(rendered, /Encrypted content/);
  assertReadable(rendered);
  assert.equal(nativeToolArguments(item).item.output[3].encrypted_content, 'opaque');
  assert.match(body({ ...item, output: '{"count":0,"ok":false}' }), /Count: 0/);
});

test('generic future objects show nested keys, arrays and falsy/empty values, not raw JSON', () => {
  const item = { type: 'futureTool', id: 'future-1',
    arguments: { settings: { enabled: false, count: 0, name: '', optional: null }, paths: ['/one', '/two'] },
    result: '{"records":[{"name":"alpha","value":0},{"name":"beta","value":false}],"emptyList":[],"emptyObject":{}}',
    error: { message: 'Future warning', code: 0 }, newField: { nested: { retained: 'all native data' } },
  };
  const rendered = body(item);
  for (const expected of ['Enabled: false', 'Count: 0', 'Name: (empty)', 'Optional: (not provided)', '/one', '/two', 'alpha', 'beta', 'Value: 0', 'Value: false', 'Empty List: (none)', 'Empty Object: (no fields)', 'Future warning', 'Code: 0', 'all native data']) {
    assert.ok(rendered.includes(expected), expected);
  }
  assertReadable(rendered);
  assertReadable(nativeCallPresentation(item).rawInput);
  assert.deepEqual(nativeToolArguments(item).item, item);
});

test('invalid JSON-like strings are preserved and repeated objects are not false cycles', () => {
  const shared = { answer: 'retained' };
  const item = { type: 'futureTool', id: 'future', arguments: { first: shared, second: shared }, result: '{not valid JSON}\nline two' };
  assert.equal((body(item).match(/Answer: retained/g) ?? []).length, 2);
  assert.match(body(item), /\{not valid JSON\}/);
  assert.match(body(item), /line two/);
});

test('a circular unexpected future object is readable and cannot hang the presenter', () => {
  const item = { type: 'futureTool', id: 'cycle', result: {} };
  item.result.self = item.result;
  assert.match(body(item), /circular reference/);
});

test('unexpected JS values yield JSON-safe detached snapshots without getters, mutation or fake diff images', () => {
  const data = { bigint: 7n, fn: () => {}, symbol: Symbol('hidden'), date: new Date(), bytes: new Uint8Array([1, 2]), infinite: Infinity };
  data.self = data;
  Object.defineProperty(data, 'getter', { enumerable: true, get() { throw new Error('must not be evaluated'); } });
  const item = { type: 'futureTool', id: 'safe-snapshot', result: data };
  for (const presenter of [nativeToolArguments, nativePresentationMeta, nativeCallPresentation, nativeResultPresentation]) {
    const result = presenter(item);
    assert.doesNotThrow(() => JSON.stringify(result));
    if (presenter !== nativeCallPresentation) assert.match(JSON.stringify(result), /circular reference/);
  }
  const args = nativeToolArguments(item);
  args.item.result.bigint._native_snapshot_unavailable = 'UI-only';
  assert.equal(data.bigint, 7n);
  assert.equal(data.self, data);
  const proto = JSON.parse('{"type":"futureTool","id":"proto","result":{"__proto__":{"polluted":true}}}');
  const clone = nativeToolArguments(proto).item;
  assert.equal(Object.getPrototypeOf(clone.result), Object.prototype);
  assert.equal(Object.hasOwn(clone.result, '__proto__'), true);
  assert.deepEqual(JSON.parse(JSON.stringify(clone)), proto);
  for (const oldText of [undefined, Infinity, () => {}, Symbol('invalid')]) {
    const invalid = fileChange([{ path: '/a', diff: '@@\n-old\n+new' }], { diffs: [{ path: '/a', oldText, newText: 'new' }] });
    assert.equal(nativeResultPresentation(invalid).card, 'generic');
    assert.equal(nativePresentationMeta(invalid).diffs, undefined);
  }
});

test('typed media aliases, nested references and binary MCP resources never dump encoded bodies', () => {
  const item = mcp({ result: { content: [
    { type: 'image', image: { data: 'RAW_IMAGE', url: 'DATA:image/png;base64,RAW_DATA_URL' } },
    { type: 'audio', blob: 'RAW_AUDIO' },
    { type: 'resource', resource: { mimeType: 'image/png', blob: 'RAW_RESOURCE', uri: 'resource://image' } },
    { type: 'encrypted_content', encrypted_content: 'RAW_ENCRYPTED', ciphertext: 'RAW_CIPHERTEXT' },
    { type: 'future', url: 'data:audio/wav;base64,RAW_FUTURE_DATA' },
  ] } });
  const rendered = body(item);
  assert.doesNotMatch(rendered, /RAW_IMAGE|RAW_DATA_URL|RAW_AUDIO|RAW_RESOURCE|RAW_ENCRYPTED|RAW_CIPHERTEXT|RAW_FUTURE_DATA/);
  assert.match(rendered, /resource:\/\/image/);
  assert.match(rendered, /image\/png/);
  assert.deepEqual(nativePresentationMeta(item).item, item, 'Canonical native data remains exact in replay metadata');
});

test('deep, sparse and huge fallback content is bounded; many backtick runs cannot overflow fence generation', () => {
  let deep = 'bottom';
  for (let index = 0; index < 300; index++) deep = { nested: deep };
  const sparse = []; sparse.length = 100_000_000;
  const item = { type: 'futureTool', id: 'bounded', result: { deep, sparse, text: 'x'.repeat(2 * 1024 * 1024) } };
  const rendered = body(item);
  assert.ok(rendered.length <= 1024 * 1024 + 64);
  assert.match(rendered, /truncated/);
  assert.ok(JSON.stringify(nativePresentationMeta(item)).length < 3 * 1024 * 1024);
  const code = { type: 'codeExecution', code: '`x` '.repeat(150_000) };
  assert.doesNotThrow(() => nativeResultContent(code));
});

test('bridge failures with stale pending metadata stay failures; cancelled/false changes and malformed actions cannot fabricate cards', () => {
  const pending = command({ status: 'inProgress', aggregatedOutput: 'STALE_OUTPUT', exitCode: 0 });
  const result = { isError: true, meta: { item: pending }, content: [{ type: 'text', text: 'Observation unavailable' }] };
  const view = nativeResultPresentation(pending, result);
  assert.equal(view.card, 'generic');
  assert.match(view.title, /failed/);
  assert.match(text(view.content), /Observation unavailable/);
  assert.doesNotMatch(text(view.content), /STALE_OUTPUT/);
  for (const overrides of [{ status: 'cancelled' }, { status: 'interrupted' }, { success: false }]) {
    const failed = fileChange([{ path: '/a', oldText: 'old', newText: 'new' }], overrides);
    assert.equal(nativeCallPresentation(failed).card, 'generic');
    assert.equal(nativeResultPresentation(failed).card, 'generic');
    assert.equal(nativePresentationMeta(failed).diffs, undefined);
  }
  assert.doesNotThrow(() => nativeToolArguments(fileChange([null, false, { path: '/a' }])));
  assert.doesNotThrow(() => nativeResultContent(collab({ receiverThreadIds: {} })));
  assert.equal(nativeResultPresentation(command({ exitCode: 1.5 })).exitCode, undefined);
  for (const statusCode of [-1, 0, 99, 600]) {
    assert.equal(nativeResultPresentation(web({ action: { type: 'openPage', url: 'https://example.org' }, statusCode })).card, 'generic');
  }
});

test('all presenters are deterministic and leave frozen native values unchanged', () => {
  for (const item of [command(), mcp(), collab(), web(), fileChange([{ path: '/a', kind: { type: 'add' }, diff: 'hello\n' }]),
    { type: 'futureTool', id: 'f', output: { ok: false, count: 0 } }]) {
    const before = structuredClone(item);
    freeze(item);
    for (const presenter of [nativeToolName, nativeToolArguments, nativePresentationMeta, nativeCallPresentation, nativeResultContent, nativeResultPresentation]) {
      assert.deepEqual(presenter(item), presenter(item));
    }
    assert.deepEqual(item, before);
    assertNoUndefined(nativeCallPresentation(item));
    assertNoUndefined(nativeResultPresentation(item));
  }
});

// Offline integration: evaluate just pure TS functions extracted from small
// source fragments, never import the DSH application or edit a source tree.
test('pinned raw Web UI patch: strict marker gates, standard equivalence, live/replay cards', async t => {
  const source = process.env.DSH_NATIVE_UI_SOURCE ?? '/nix/store/i3xj6bb8j9qr18a7b39wb870vljg8p2w-source';
  const installed = process.env.DSH_NATIVE_UI_INSTALLED ?? '/nix/store/bd2xniw1ymxc545042qy39p67wzgax0a-dsh-0.2.0-rc.2';
  const tsPath = process.env.DSH_NATIVE_UI_TYPESCRIPT ?? join(installed, 'node_modules/typescript/lib/typescript.js');
  if (!existsSync(source) || !existsSync(tsPath)) {
    if (process.env.DSH_CODEX_REQUIRE_NATIVE_TESTS === '1') {
      assert.ok(existsSync(source), `Required unpatched DSH UI source is missing: ${source}; supply DSH_NATIVE_UI_SOURCE`);
      assert.ok(existsSync(tsPath), `Required DSH TypeScript fixture is missing: ${tsPath}; supply DSH_NATIVE_UI_TYPESCRIPT/DSH_NATIVE_UI_INSTALLED`);
    }
    t.skip('Optional pinned DSH source/TypeScript not present; pure presenter tests still run');
    return;
  }
  const ts = createRequire(import.meta.url)(tsPath);
  const patch = readFileSync(new URL('./patches/codex-readable-tools.patch', import.meta.url), 'utf8');
  const marker = '\n# Native observations only: apply these hunks after the existing Codex UI patch.\n';
  const cut = patch.indexOf(marker);
  assert.ok(cut > 0, 'native additions must be separable from the unchanged existing patch');
  const baselinePatch = patch.slice(0, cut);
  const dsh = fileURLToPath(new URL('../../', import.meta.url));
  const nix = readFileSync(join(dsh, 'dsh.nix'), 'utf8');
  const patchList = /\bpatches\s*=\s*\[([\s\S]*?)\];/.exec(nix)?.[1];
  assert.ok(patchList, 'Read the actual declarative DSH source-patch chain');
  const chain = [...patchList.matchAll(/\.\/([\w/.-]+\.patch)\b/g)].map(match => ({ path: match[1], body: readFileSync(join(dsh, match[1]), 'utf8') }));
  assert.equal(chain.filter(entry => entry.path.endsWith('/codex-readable-tools.patch')).length, 1);
  const root = mkdtempSync(join(tmpdir(), 'codex-native-ui-test-'));
  const tool = 'packages/client/ui-tool/src/client/tool/models/';
  const layout = 'packages/client/ui-trajectory/src/client/layout.ts';
  const files = [...new Set(chain.flatMap(entry => [...entry.body.matchAll(/^--- a\/(.+)$/gm)].map(match => match[1])))];
  files.push(tool + 'raw-tool-call.ts');
  const trees = {};
  try {
    for (const [label, appliedPatch] of [['baseline', baselinePatch], ['native', patch]]) {
      const tree = join(root, label);
      for (const file of files) {
        const target = join(tree, file);
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(join(source, file), target);
      }
      for (const entry of chain) {
        const input = entry.path.endsWith('/codex-readable-tools.patch') ? appliedPatch : entry.body;
        const log = execFileSync('patch', ['--batch', '--fuzz=0', '-p1'], { cwd: tree, input, encoding: 'utf8' });
        assert.doesNotMatch(log, /FAILED|fuzz|malformed/);
      }
      trees[label] = tree;
    }
    t.diagnostic(`patch --fuzz=0 passed for all ${chain.length} declarative DSH source patches against pinned 639ed015`);

    function evaluate(tree, file, names, constants = [], support = '') {
      const path = join(tree, file);
      const sourceText = readFileSync(path, 'utf8');
      const ast = ts.createSourceFile(path, sourceText, ts.ScriptTarget.Latest, true);
      const fragments = ast.statements.flatMap(node => {
        if (ts.isFunctionDeclaration(node)) return [node.getText(ast).replace(/^export\s+/, '')];
        if (ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => constants.includes(declaration.name.getText(ast)))) {
          return [node.getText(ast).replace(/^export\s+/, '')];
        }
        return [];
      });
      const script = support + '\n' + fragments.join('\n') + `\nresult = { ${names.join(', ')} };`;
      const js = ts.transpileModule(script, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } });
      const context = { result: undefined, resolveWorkspacePath: (_cwd, path) => path, hasSpillNotice: () => false };
      runInNewContext(js.outputText, context, { timeout: 2000 });
      return { ...context.result, sourceText };
    }
    const raw = readFileSync(join(source, tool + 'raw-tool-call.ts'), 'utf8');
    const rawAst = ts.createSourceFile('raw.ts', raw, ts.ScriptTarget.Latest, true);
    const rawFunctions = rawAst.statements.filter(node => ts.isFunctionDeclaration(node))
      .map(node => node.getText(rawAst).replace(/^export\s+/, '')).join('\n');
    const rawSupport = 'const parsedCalls = new WeakMap();\n' + rawFunctions;
    const models = Object.fromEntries(Object.entries(trees).map(([label, tree]) => [label, {
      row: evaluate(tree, tool + 'tool-call-model.ts', ['deriveSummary', 'formatToolBody', 'variants: Object.keys(SUMMARY_KEYS)'], ['SUMMARY_KEYS']),
      trajectory: evaluate(tree, layout, ['summarizeCall']),
      diff: evaluate(tree, tool + 'diff-card-model.ts', ['diffCardModel'], [], rawSupport),
      terminal: evaluate(tree, tool + 'terminal-card-model.ts', ['terminalCardModel', 'shellCall', 'parseExitStatus'], [], rawSupport),
    }]));
    const before = models.baseline;
    const after = models.native;
    const bytes = value => JSON.stringify(value);
    await t.test('presentations satisfy the actual installed DSH Card union contracts', () => {
      const items = [command(), mcp(), collab(), web(), fileChange([{ path: '/a', oldText: null, newText: 'new' }]),
        { type: 'imageView', path: '/image' }, { type: 'codeExecution', code: 'text(1)', output: '1' },
        { type: 'futureTool', result: { hello: 'world' } }];
      const contract = join(installed, 'packages/core/tools/src/presentation.ts');
      assert.ok(existsSync(contract), 'Check the real installed contract, not invented card shapes');
      const generated = join(root, 'card-contract.ts');
      writeFileSync(generated, `import type { ToolCallView, ToolResultView } from ${JSON.stringify(contract)};\n`
        + `const calls: ToolCallView[] = ${JSON.stringify(items.map(nativeCallPresentation))};\n`
        + `const results: ToolResultView[] = ${JSON.stringify(items.map(item => nativeResultPresentation(item)))};\n`);
      const program = ts.createProgram([generated], { noEmit: true, skipLibCheck: true, strict: true,
        target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
        allowImportingTsExtensions: true, types: [], paths: { '*': [join(installed, 'node_modules/*')] } });
      const errors = ts.getPreEmitDiagnostics(program).filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error);
      assert.equal(errors.length, 0, errors.map(error => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n'));
    });
    const resultBlock = (name, args, meta, content = [{ type: 'text', text: 'Readable fallback' }]) => ({
      kind: 'tool/result', call: { name, argsRaw: JSON.stringify(args) }, isError: false, meta, content,
    });

    await t.test('all generic variants and async/future names show only marked human input', () => {
      const args = { _codex_native: true, description: 'Human title\ncontinued', input: 'Human details\nsecond line',
        item: { type: 'requestUserInput', private: 'NATIVE_SNAPSHOT_NOT_DISPLAYED', questions: [{ question: 'Choose?', options: ['A', 'B'] }] } };
      const encoded = JSON.stringify(args);
      for (const variant of after.row.variants) {
        assert.equal(after.row.deriveSummary(variant, encoded), 'Human title');
        assert.equal(after.row.formatToolBody(variant, encoded), args.input);
      }
      for (const name of ['bash', 'apply_patch', 'exec', 'web_search', 'view_image', 'spawn_agent', 'request_user_input', 'ask_user_question', 'async_user_input', 'mcp__docs__lookup', 'browser_click', 'future_tool']) {
        const view = after.trajectory.summarizeCall(name, encoded);
        assert.equal(view.text, 'Human title\ncontinued');
        assert.equal(view.previewMarkdown, args.input);
        assert.equal(view.toolName, name);
        assert.doesNotMatch(bytes(view), /NATIVE_SNAPSHOT_NOT_DISPLAYED|private|questions/);
      }
      const future = { type: 'requestUserInput', id: 'q', questions: [{ question: 'Which option?', answers: ['A', 'B'] }] };
      const projection = nativeToolArguments(future);
      assert.equal(projection._codex_native, true);
      assert.match(after.row.formatToolBody('generic', JSON.stringify(projection)), /Which option\?/);
      assertReadable(after.row.formatToolBody('generic', JSON.stringify(projection)));
    });

    await t.test('strict true gate never leaks snapshots when human inputs are missing', () => {
      const encoded = JSON.stringify({ _codex_native: true, item: { private: 'DO_NOT_RENDER' } });
      for (const variant of after.row.variants) {
        assert.equal(after.row.formatToolBody(variant, encoded), null);
        assert.equal(after.row.deriveSummary(variant, encoded), 'Native tool observation');
      }
      const view = after.trajectory.summarizeCall('unknown', encoded);
      assert.equal(view.text, 'unknown');
      assert.ok(!('previewMarkdown' in view));
      assert.doesNotMatch(bytes(view), /DO_NOT_RENDER/);
    });

    await t.test('unmarked/false/string markers preserve existing summary/body/trajectory bytes', () => {
      const payloads = ['', 'partial {', 'null', '[]', '"text"', '{}', ...[
        { description: 'Standard', command: 'pwd', input: 'tools.exec_command({cmd:"pwd"})' },
        { queries: ['first', 'second'], item: { remains: 'unchanged' } },
        { code: 'print(1)', input: '*** Begin Patch\n*** Add File: /a\n+hi\n*** End Patch' },
        ...[false, 'true', 1, null].map(_codex_native => ({ _codex_native, description: 'Standard', input: 'native-like input', item: { private: 'UNCHANGED' } })),
      ].map(JSON.stringify)];
      for (const encoded of payloads) {
        for (const variant of after.row.variants) {
          assert.equal(bytes(after.row.formatToolBody(variant, encoded)), bytes(before.row.formatToolBody(variant, encoded)));
          assert.equal(bytes(after.row.deriveSummary(variant, encoded)), bytes(before.row.deriveSummary(variant, encoded)));
        }
        for (const name of ['bash', 'exec', 'apply_patch', 'exec_command', 'web_search', 'ask_user_question', 'future']) {
          assert.equal(bytes(after.trajectory.summarizeCall(name, encoded)), bytes(before.trajectory.summarizeCall(name, encoded)));
        }
      }
    });

    await t.test('marked file changes use validated result metadata only, never parse fallback patches', () => {
      const diffs = [{ path: '/a', oldText: 'old\n', newText: 'new\n' }];
      const item = fileChange([{ path: '/a', kind: { type: 'update' }, diff: '@@\n-old\n+new\n' }], { diffs });
      const args = nativeToolArguments(item);
      const block = resultBlock('apply_patch', args, nativePresentationMeta({ item }), nativeResultContent({ item }));
      assert.equal(bytes(after.diff.diffCardModel(block)?.card.diffs), bytes(diffs));
      assert.equal(bytes(after.diff.diffCardModel(JSON.parse(JSON.stringify(block)))), bytes(after.diff.diffCardModel(block)));
      assert.equal(after.diff.diffCardModel({ ...block, isError: true }), null);
      for (const meta of [undefined, { diffs: [] }, { diffs: [{ path: '/a', newText: 'new' }] },
        { diffs: [{ path: '', oldText: null, newText: 'new' }] },
        ...['failed', 'declined', 'rejected', 'interrupted', 'cancelled'].map(status => ({ diffs, item: { status } })),
        { diffs, item: { success: false } }]) {
        assert.equal(after.diff.diffCardModel({ ...block, meta }), null);
      }
      const patch = '*** Begin Patch\n*** Add File: /a\n+hello\n*** End Patch';
      const marked = resultBlock('apply_patch', { _codex_native: true, input: patch }, undefined);
      assert.equal(after.diff.diffCardModel(marked), null);
      const standard = resultBlock('apply_patch', { input: patch }, undefined);
      assert.equal(bytes(after.diff.diffCardModel(standard)), bytes(before.diff.diffCardModel(standard)));
      assert.ok(after.diff.diffCardModel(standard));
    });

    await t.test('bash alias uses unchanged shell parser; marked results preserve exact terminal metadata', () => {
      const output = 'line one\nline two\n[exit code: 99]';
      const item = command({ aggregatedOutput: output, exitCode: 0 });
      const args = nativeToolArguments(item);
      assert.equal(nativeToolName(item), 'bash');
      const block = resultBlock(nativeToolName(item), args, nativePresentationMeta({ item }), nativeResultContent({ item }));
      const view = after.terminal.terminalCardModel(block);
      assert.equal(bytes(after.terminal.terminalCardModel(JSON.parse(JSON.stringify(block)))), bytes(view));
      assert.equal(view.card.output, output);
      assert.equal(view.card.exitCode, 0);
      assert.equal(view.card.cwd, item.cwd);
      assert.equal(view.copy.command, item.command);
      for (const meta of [{ output: '' }, { output, exitCode: -1 }, { output, signal: 'SIGTERM' }]) {
        const card = after.terminal.terminalCardModel({ ...block, meta }).card;
        assert.equal(card.output, meta.output);
        assert.equal(card.exitCode, meta.exitCode);
        assert.equal(card.signal, meta.signal);
      }
      assert.equal(after.terminal.terminalCardModel({ ...block, meta: undefined }), null);
      const pending = { name: 'bash', argsRaw: block.call.argsRaw, phase: 'dispatched' };
      assert.equal(bytes(after.terminal.terminalCardModel(pending)), bytes(before.terminal.terminalCardModel(pending)));
      assert.equal(after.terminal.terminalCardModel(pending).card.running, true);
      // The shell name/argument parser and marker parser themselves are byte-identical.
      assert.equal(after.terminal.shellCall.toString(), before.terminal.shellCall.toString());
      assert.equal(after.terminal.parseExitStatus.toString(), before.terminal.parseExitStatus.toString());
    });

    await t.test('unmarked terminal metadata never changes standard result semantics', () => {
      for (const mark of [undefined, false, 'true', 1]) {
        const args = { command: 'pwd', description: 'Run pwd', workdir: '/work', ...(mark === undefined ? {} : { _codex_native: mark }) };
        for (const output of ['standard\n', 'standard\n[exit code: 7]', 'standard\n[killed by signal: SIGTERM]']) {
          const block = resultBlock('bash', args, { output: 'must not replace standard stdout', exitCode: 42 }, [{ type: 'text', text: output }]);
          assert.equal(bytes(after.terminal.terminalCardModel(block)), bytes(before.terminal.terminalCardModel(block)));
        }
      }
    });
  } finally {
    execFileSync('remove-without-permission', ['-rf', root]);
  }
});
