import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn as nodeSpawn } from 'node:child_process';
import { EventEmitter, getEventListeners } from 'node:events';
import { readFile } from 'node:fs/promises';
import { PassThrough, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { CodexAppServer } from './codex-app-server.mjs';

// Entirely synthetic diagnostics: never read credentials or invoke Codex.
const SECRET = 'SYNTHETIC_PRIVATE_PAYLOAD_DO_NOT_LOG';
const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const initialized = { userAgent: 'fixture', codexHome: '/fixture', platformOs: 'linux' };

class FakeChild extends EventEmitter {
  constructor({ onWrite, autoInitialize = true, stopOnEnd = true,
    killStops = true, highWaterMark = 16384 } = {}) {
    super();
    this.pid = 12345;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.messages = [];
    this.killSignals = [];
    this.writeCalls = 0;
    this.held = [];
    this.holdWrites = false;
    this.exited = false;
    this.stdin = new Writable({
      highWaterMark,
      write: (chunk, encoding, callback) => {
        const message = JSON.parse(chunk.toString());
        this.messages.push(message);
        if (autoInitialize && message.method === 'initialize') {
          // Deliberately respond before the write callback (registration race).
          this.send({ id: message.id, result: initialized });
        }
        onWrite?.(message, this);
        if (this.holdWrites) this.held.push(callback);
        else callback();
      },
    });
    const write = this.stdin.write.bind(this.stdin);
    this.stdin.write = (...args) => { this.writeCalls++; return write(...args); };
    this.stdin.on('finish', () => { if (stopOnEnd) this.exit(0); });
    this.killStops = killStops;
  }

  send(message) { this.stdout.write(`${JSON.stringify(message)}\n`); }
  releaseWrite(error) { this.held.shift()?.(error); }
  kill(signal) {
    this.killSignals.push(signal);
    if (this.killStops) this.exit(null, signal);
    return true;
  }
  exit(code = 0, signal = null) {
    if (this.exited) return;
    this.exited = true;
    this.emit('exit', code, signal);
    this.stdout.end();
    this.stderr.end();
    this.emit('close', code, signal);
  }
}

function harness(t, callbacks = {}, childOptions = {}) {
  const child = new FakeChild(childOptions);
  const calls = [];
  const client = new CodexAppServer({ command: '/fixture/codex', ...callbacks,
    spawn: (...args) => { calls.push(args); return child; } });
  t.after(() => client.close());
  return { child, calls, client };
}

function safeError(error, code) {
  assert.equal(error.code, code);
  assert.ok(!String(error).includes(SECRET));
  assert.ok(!error.stack.includes(SECRET));
  assert.equal(error.data, undefined);
  assert.equal(error.cause, undefined);
  return true;
}

async function until(predicate) {
  const deadline = performance.now() + 2000;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await delay(2);
  }
  assert.fail('Fixture did not reach expected state');
}

test('official handshake, prefix args, injection, and concurrent start', async (t) => {
  const child = new FakeChild();
  const calls = [];
  const env = { FIXTURE: 'value' };
  const args = ['--config', 'fixture=true'];
  const client = new CodexAppServer({ command: '/fixture/codex', args, env, cwd: '/fixture',
    spawn: (...call) => { calls.push(call); return child; } });
  t.after(() => client.close());
  args.push('must-not-mutate');
  assert.equal(client.isClosed, false);
  assert.equal(client.stderr, '');
  assert.deepEqual(await Promise.all([client.start(), client.start()]), [initialized, initialized]);
  assert.deepEqual(calls, [['/fixture/codex',
    ['--config', 'fixture=true', 'app-server', '--listen', 'stdio://'],
    { env, cwd: '/fixture', stdio: ['pipe', 'pipe', 'pipe'], shell: false }]]);
  assert.deepEqual(child.messages, [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      clientInfo: { name: 'dsh_codex', version: '0.1.0' }, capabilities: { experimentalApi: true },
    } },
    { jsonrpc: '2.0', method: 'initialized' },
  ]);
  assert.deepEqual(await client.start(), initialized);
  assert.equal(calls.length, 1);
});

test('custom initialize capabilities and notification writes', async (t) => {
  const { client, child } = harness(t);
  const options = { clientInfo: { name: 'fixture', version: '2', title: 'Test' },
    capabilities: { experimentalApi: false, optOutNotificationMethods: ['noise'] } };
  await client.start(options);
  assert.deepEqual(child.messages[0].params, options);
  await client.notify('fixture/notify', { value: 7 });
  assert.deepEqual(child.messages.at(-1), {
    jsonrpc: '2.0', method: 'fixture/notify', params: { value: 7 },
  });
});

test('split UTF-8, multiple lines, CRLF, type-exact IDs and out-of-order correlation', async (t) => {
  const notifications = [];
  const { client, child } = harness(t, {
    onNotification: (method, params) => notifications.push([method, params]),
  });
  await client.start();
  const first = client.request('fixture/first', { value: 1 });
  const second = client.request('fixture/second', {});
  await until(() => child.messages.some((message) => message.method === 'fixture/second'));
  const a = child.messages.find((message) => message.method === 'fixture/first');
  const b = child.messages.find((message) => message.method === 'fixture/second');
  // A string ID must not accidentally settle the corresponding numeric ID.
  child.send({ id: String(a.id), result: 'wrong-type' });
  const text = Buffer.from(`\r\n${JSON.stringify({ jsonrpc: '2.0', method: 'fixture/event',
    params: { text: '猫🙂' } })}\r\n${JSON.stringify({ id: b.id, result: 'second' })}\n`
    + `${JSON.stringify({ jsonrpc: '2.0', id: a.id, result: 'first' })}\r\n`);
  const split = text.indexOf(Buffer.from('猫')) + 1;
  child.stdout.write(text.subarray(0, split));
  child.stdout.write(text.subarray(split, split + 2));
  child.stdout.write(text.subarray(split + 2));
  assert.deepEqual(await Promise.all([first, second]), ['first', 'second']);
  await tick();
  assert.deepEqual(notifications, [['fixture/event', { text: '猫🙂' }]]);
});

test('notifications and server requests are concurrent, callbacks can issue nested requests', async (t) => {
  const gate = deferred();
  const seen = [];
  let client;
  const h = harness(t, {
    onNotification: async (method) => { seen.push(method); await gate.promise; },
    onRequest: async (method, params) => {
      seen.push(method);
      if (method === 'fixture/slow') { await gate.promise; return { decision: 'decline' }; }
      return { answer: await client.request('fixture/nested', params) };
    },
  }, {
    onWrite: (message, child) => {
      if (message.method === 'fixture/nested') child.send({ id: message.id, result: 42 });
    },
  });
  ({ client } = h);
  await client.start();
  h.child.stdout.write([
    { method: 'fixture/notification' },
    { id: 'approval', method: 'fixture/slow' },
    { jsonrpc: '2.0', id: 777, method: 'fixture/fast', params: { question: 1 } },
  ].map((message) => JSON.stringify(message)).join('\n') + '\n');
  await until(() => h.child.messages.some((message) => message.id === 777));
  assert.deepEqual(seen, ['fixture/notification', 'fixture/slow', 'fixture/fast']);
  assert.deepEqual(h.child.messages.find((message) => message.id === 777), {
    jsonrpc: '2.0', id: 777, result: { answer: 42 },
  });
  assert.ok(!h.child.messages.some((message) => message.id === 'approval'));
  gate.resolve();
  await until(() => h.child.messages.some((message) => message.id === 'approval'));
  assert.deepEqual(h.child.messages.find((message) => message.id === 'approval').result,
    { decision: 'decline' });
});

test('server callbacks are registered during initialization', async (t) => {
  const seen = [];
  const { client, child } = harness(t, {
    onNotification: (method) => { seen.push(method); },
    onRequest: async (method) => { seen.push(method); return { decision: 'decline' }; },
  }, { autoInitialize: false,
    onWrite: (message, fake) => {
      if (message.method !== 'initialize') return;
      fake.send({ method: 'fixture/earlyNotification' });
      fake.send({ id: 'early', method: 'fixture/earlyRequest' });
      fake.send({ id: message.id, result: initialized });
    },
  });
  await client.start();
  await until(() => child.messages.some((message) => message.id === 'early'));
  assert.deepEqual(seen, ['fixture/earlyNotification', 'fixture/earlyRequest']);
});

test('numeric and string server IDs are distinct, even when a client ID overlaps', async (t) => {
  const { client, child } = harness(t, {}, { autoInitialize: false,
    onWrite: (message, fake) => {
      if (message.method !== 'initialize') return;
      fake.send({ id: message.id, method: 'fixture/unknown' });
      fake.send({ id: String(message.id), method: 'fixture/unknown' });
      fake.send({ id: message.id, result: initialized });
    },
  });
  await client.start();
  await until(() => child.messages.filter((message) => 'error' in message).length === 2);
  assert.deepEqual(child.messages.filter((message) => 'error' in message).map(({ id }) => id), [1, '1']);
  assert.equal(client.isClosed, false);
});

test('onRequest receives the exact numeric/string server ID as its third argument', async (t) => {
  const seen = [];
  const { client, child } = harness(t, { onRequest: async (method, params, id) => {
    seen.push([method, params, id]);
    return { decision: 'decline' };
  } });
  await client.start();
  child.send({ id: 12, method: 'fixture/request', params: { value: 1 } });
  child.send({ id: '12', method: 'fixture/request', params: { value: 2 } });
  await until(() => child.messages.filter((message) => 'result' in message).length === 2);
  assert.deepEqual(seen, [
    ['fixture/request', { value: 1 }, 12], ['fixture/request', { value: 2 }, '12'],
  ]);
  assert.deepEqual(child.messages.filter((message) => 'result' in message).map(({ id }) => id), [12, '12']);
});

test('unknown requests return method-not-found, never approval', async (t) => {
  const { client, child } = harness(t);
  await client.start();
  child.send({ id: 'unknown', method: 'item/commandExecution/requestApproval', params: {} });
  await until(() => child.messages.some((message) => message.id === 'unknown'));
  assert.deepEqual(child.messages.at(-1), {
    jsonrpc: '2.0', id: 'unknown', error: { code: -32601, message: 'Method not found' },
  });
  assert.equal(client.isClosed, false);
});

test('handled request failures and unserializable/undefined results are safe errors', async (t) => {
  const { client, child } = harness(t, { onRequest: async (method) => {
    if (method === 'throw') throw Object.assign(new Error(SECRET), { code: -32009, data: SECRET });
    if (method === 'cycle') { const value = {}; value.self = value; return value; }
    if (method === 'badGetter') throw { get code() { throw new Error(SECRET); } };
    if (method === 'function') return () => {};
    return undefined;
  } });
  await client.start();
  for (const method of ['throw', 'cycle', 'undefined', 'badGetter', 'function']) {
    child.send({ id: method, method });
  }
  await until(() => child.messages.filter((message) => 'error' in message).length === 5);
  for (const message of child.messages.filter((message) => 'error' in message)) {
    assert.deepEqual(message.error, {
      code: message.id === 'throw' ? -32009 : -32603, message: 'Request handler failed',
    });
    assert.ok(!JSON.stringify(message).includes(SECRET));
    assert.ok(!('result' in message));
  }
  assert.equal(client.isClosed, false);
});

test('RPC error responses do not expose message/data; stderr is a safe bounded summary', async (t) => {
  const { client, child } = harness(t);
  await client.start();
  child.stderr.write(SECRET.repeat(10000));
  const result = client.request('fixture/error', {});
  const rejected = assert.rejects(result, (error) => safeError(error, -32000));
  const id = child.messages.at(-1).id;
  child.send({ id, error: { code: -32000, message: SECRET, data: { token: SECRET } } });
  await rejected;
  assert.ok(client.stderr.length < 128);
  assert.match(client.stderr, /bytes received \(contents omitted\)/);
  assert.ok(!client.stderr.includes(SECRET));
  assert.equal(client.isClosed, false);
});

test('only exact native no-rollout RPC -32600 is classified, without retaining upstream diagnostics', async (t) => {
  const { client, child } = harness(t);
  await client.start();
  const threadId = '019a5ef4-6d22-7d73-a2b2-117f8adc9021';
  const exact = `no rollout found for thread id ${threadId}`;
  const cases = [
    [-32600, exact, 'THREAD_NOT_FOUND'],
    [-32600, `no rollout found for thread id ${SECRET}`, 'THREAD_NOT_FOUND'],
    [-32602, exact, undefined],
    [-32000, exact, undefined],
    [-32600, `${SECRET}: ${exact}`, undefined],
    [-32600, `${exact}: ${SECRET}`, undefined],
    [-32600, `${exact}\n`, undefined],
    [-32600, `${exact}\r\n`, undefined],
    [-32600, `${exact}\n${SECRET}`, undefined],
    [-32600, 'no rollout found for thread id ', undefined],
    [-32600, 'no rollout found for thread id /private/thread.json', undefined],
    [-32600, `No rollout found for thread id ${threadId}`, undefined],
    [-32600, `thread not found: ${threadId}`, undefined],
    [-32600, `no rollout found for thread id \"${threadId}\"`, undefined],
  ];
  for (const [code, message, reason] of cases) {
    const count = child.messages.length;
    const pending = client.request('thread/resume', { threadId }, { timeoutMs: 2500 });
    const rejected = assert.rejects(pending, error => {
      safeError(error, code);
      assert.equal(typeof error.code, 'number', 'transport codes must remain numeric for async turn-race recovery');
      assert.equal(error.rpcReason, reason);
      assert.ok(!String(error).includes(threadId));
      assert.ok(!error.stack.includes(message));
      assert.ok(!JSON.stringify(error).includes(SECRET));
      assert.ok(!JSON.stringify(error).includes(threadId));
      assert.ok(!Object.values(error).includes(message));
      return true;
    });
    await until(() => child.messages.length > count);
    child.send({ id: child.messages.at(-1).id, error: { code, message,
      data: { message: SECRET, rpcReason: 'THREAD_NOT_FOUND', threadId } } });
    await rejected;
  }
  assert.equal(client.isClosed, false, 'a failed resume does not poison a valid transport');
});

test('abort before dispatch, in flight, and late responses clean up listeners', async (t) => {
  const { client, child } = harness(t);
  await client.start();
  const already = new AbortController();
  already.abort(SECRET);
  const count = child.messages.length;
  await assert.rejects(client.request('fixture/notSent', {}, { signal: already.signal }),
    (error) => safeError(error, 'ABORT_ERR') && error.name === 'AbortError');
  assert.equal(child.messages.length, count);
  const controller = new AbortController();
  const request = client.request('fixture/abort', {}, { signal: controller.signal });
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
  const rejected = assert.rejects(request, (error) => safeError(error, 'ABORT_ERR'));
  const id = child.messages.at(-1).id;
  controller.abort(SECRET);
  await rejected;
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  child.send({ id, result: 'late' });
  assert.equal(client.isClosed, false);
  const succeeded = client.request('fixture/success', {}, { signal: controller.signal });
  await assert.rejects(succeeded, { name: 'AbortError' });
});

test('timeout and successful responses clean listeners without closing the connection', async (t) => {
  const { client, child } = harness(t);
  await client.start();
  const controller = new AbortController();
  const slow = client.request('fixture/timeout', {}, { signal: controller.signal, timeoutMs: 10 });
  const id = child.messages.at(-1).id;
  await assert.rejects(slow, (error) => safeError(error, 'ETIMEDOUT') && error.name === 'TimeoutError');
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  child.send({ id, result: 'too late' });
  const ok = client.request('fixture/ok', {}, { signal: controller.signal, timeoutMs: 0 });
  await until(() => child.messages.at(-1).method === 'fixture/ok');
  child.send({ id: child.messages.at(-1).id, result: null });
  assert.equal(await ok, null);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.equal(client.isClosed, false);
});

test('writes serialize under backpressure; queued aborts are never sent', async (t) => {
  const { client, child } = harness(t, {}, { highWaterMark: 1 });
  await client.start();
  child.holdWrites = true;
  const before = child.writeCalls;
  const first = client.notify('fixture/held', {});
  const second = client.notify('fixture/next', {});
  const controller = new AbortController();
  const aborted = client.request('fixture/queuedAbort', {}, { signal: controller.signal });
  const rejected = assert.rejects(aborted, { name: 'AbortError' });
  controller.abort();
  await rejected;
  assert.equal(child.writeCalls, before + 1);
  assert.equal(child.stdin.listenerCount('drain'), 1);
  child.releaseWrite();
  await first;
  await until(() => child.messages.at(-1).method === 'fixture/next');
  assert.equal(child.writeCalls, before + 2);
  child.releaseWrite();
  await second;
  assert.equal(child.stdin.listenerCount('drain'), 0);
  assert.ok(!child.messages.some((message) => message.method === 'fixture/queuedAbort'));
});

test('synchronous drain/write callbacks do not race write registration', async (t) => {
  const child = new FakeChild();
  child.stdin.write = (line, encoding, callback) => {
    const message = JSON.parse(line);
    child.messages.push(message);
    if (message.method === 'initialize') child.send({ id: message.id, result: initialized });
    callback();
    child.stdin.emit('drain');
    return false;
  };
  const client = new CodexAppServer({ command: 'fixture', spawn: () => child });
  t.after(() => client.close());
  await client.start();
  await Promise.all([client.notify('one'), client.notify('two')]);
  assert.deepEqual(child.messages.map((message) => message.method),
    ['initialize', 'initialized', 'one', 'two']);
  assert.equal(child.stdin.listenerCount('drain'), 0);
});

test('close rejects pending/queued/blocked writes and escalates to SIGKILL', async (t) => {
  const { client, child } = harness(t, {}, { stopOnEnd: false, killStops: false, highWaterMark: 1 });
  await client.start();
  child.holdWrites = true;
  const controller = new AbortController();
  const request = client.request('fixture/blocked', {}, { signal: controller.signal });
  const queued = client.notify('fixture/queued');
  const requestRejected = assert.rejects(request, (error) => safeError(error, 'ECLOSED'));
  const queuedRejected = assert.rejects(queued, (error) => safeError(error, 'ECLOSED'));
  const before = performance.now();
  const closed = client.close();
  assert.equal(client.isClosed, true);
  await Promise.all([requestRejected, queuedRejected, closed, client.close()]);
  assert.ok(performance.now() - before < 2000);
  assert.deepEqual(child.killSignals, ['SIGTERM', 'SIGKILL']);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.equal(child.stdin.listenerCount('drain'), 0);
  assert.equal(child.stdout.listenerCount('data'), 0);
  assert.equal(child.stderr.listenerCount('data'), 0);
  assert.equal(child.stdout.destroyed, true);
  child.releaseWrite(new Error(SECRET)); // Late callbacks/errors must stay harmless.
  child.emit('error', new Error(SECRET));
  child.stdin.emit('error', new Error(SECRET));
  await assert.rejects(client.start(), (error) => safeError(error, 'ECLOSED'));
  await assert.rejects(client.request('late'), (error) => safeError(error, 'ECLOSED'));
  await assert.rejects(client.notify('late'), (error) => safeError(error, 'ECLOSED'));
});

for (const mode of ['explicit', 'exit', 'EOF', 'protocol', 'notification']) {
  test(`onClose delivers one safe error after ${mode}, without an active request`, async (t) => {
    const errors = [];
    let client;
    const h = harness(t, {
      onClose: (error) => { assert.equal(client.isClosed, true); errors.push(error); },
      onNotification: () => { throw new Error(SECRET); },
    });
    ({ client } = h);
    await client.start();
    const expected = { explicit: 'ECLOSED', exit: 'EEXIT', EOF: 'EEOF',
      protocol: 'EPROTOCOL', notification: 'ECALLBACK' }[mode];
    if (mode === 'explicit') await client.close();
    if (mode === 'exit') h.child.exit(8);
    if (mode === 'EOF') h.child.stdout.end();
    if (mode === 'protocol') h.child.stdout.write(`invalid ${SECRET}\n`);
    if (mode === 'notification') h.child.send({ method: 'fixture/failure', params: SECRET });
    await until(() => errors.length > 0);
    assert.equal(errors.length, 1);
    safeError(errors[0], expected);
    await Promise.all([client.close(), client.close()]);
    h.child.emit('exit', 9);
    h.child.emit('error', new Error(SECRET));
    assert.equal(errors.length, 1);
    await assert.rejects(client.request('late'), (error) => error === errors[0]);
  });
}

for (const mode of ['throw', 'rejection', 'neverSettles', 'reentrant']) {
  test(`onClose ${mode} cannot affect closure or duplicate lifecycle delivery`, async (t) => {
    let calls = 0;
    let client;
    const h = harness(t, { onClose: () => {
      calls++;
      assert.equal(client.isClosed, true);
      if (mode === 'throw') throw new Error(SECRET);
      if (mode === 'rejection') return Promise.reject(new Error(SECRET));
      if (mode === 'neverSettles') return new Promise(() => {});
      return client.close();
    } });
    ({ client } = h);
    await client.start();
    await client.close();
    await tick();
    assert.equal(client.isClosed, true);
    assert.equal(calls, 1);
    await assert.rejects(client.request('late'), (error) => safeError(error, 'ECLOSED'));
  });
}

test('onClose delivers once for sync and async spawn failure and pre-start close', async () => {
  for (const mode of ['sync', 'async', 'preStartClose']) {
    const errors = [];
    const child = new FakeChild({ autoInitialize: false });
    child.pid = undefined;
    const client = new CodexAppServer({ command: SECRET,
      onClose: (error) => errors.push(error),
      spawn: () => { if (mode === 'sync') throw new Error(SECRET); return child; },
    });
    if (mode === 'preStartClose') await client.close();
    else {
      const started = client.start();
      const rejected = assert.rejects(started, (error) => safeError(error, 'ESPAWN'));
      if (mode === 'async') child.emit('error', new Error(SECRET));
      await rejected;
    }
    await client.close();
    assert.equal(client.isClosed, true);
    assert.equal(errors.length, 1);
    safeError(errors[0], mode === 'preStartClose' ? 'ECLOSED' : 'ESPAWN');
  }
});

test('normal EOF-driven close is idempotent and does not kill', async (t) => {
  const { client, child } = harness(t);
  await client.start();
  await client.close();
  await client.close();
  assert.equal(client.isClosed, true);
  assert.deepEqual(child.killSignals, []);
});

for (const asyncHandler of [false, true]) {
  test(`${asyncHandler ? 'async' : 'sync'} notification rejection fails connection and pending requests`, async (t) => {
    const onNotification = asyncHandler
      ? async () => { await tick(); throw new Error(SECRET); }
      : () => { throw new Error(SECRET); };
    const { client, child } = harness(t, { onNotification });
    await client.start();
    const controller = new AbortController();
    const pending = client.request('fixture/pending', {}, { signal: controller.signal });
    const rejected = assert.rejects(pending, (error) => safeError(error, 'ECALLBACK'));
    child.send({ method: 'fixture/event', params: SECRET });
    await rejected;
    assert.equal(client.isClosed, true);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    await client.close();
  });
}

for (const event of ['exit', 'EOF', 'stdoutClose', 'stdinError', 'stdoutError', 'stderrError', 'writeError']) {
  test(`${event} rejects pending requests safely`, async (t) => {
    const { client, child } = harness(t);
    await client.start();
    const controller = new AbortController();
    if (event === 'writeError') child.holdWrites = true;
    const pending = client.request('fixture/pending', {}, { signal: controller.signal });
    const expected = event === 'exit' ? 'EEXIT' : ['EOF', 'stdoutClose'].includes(event) ? 'EEOF' : 'EIO';
    const rejected = assert.rejects(pending, (error) => safeError(error, expected));
    if (event === 'exit') child.exit(7);
    if (event === 'EOF') child.stdout.end();
    if (event === 'stdoutClose') child.stdout.destroy();
    if (event.endsWith('Error') && event !== 'writeError') {
      child[event.slice(0, -5)].emit('error', new Error(SECRET));
    }
    if (event === 'writeError') child.releaseWrite(new Error(SECRET));
    await rejected;
    assert.equal(client.isClosed, true);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  });
}

test('valid final response without newline is processed before EOF cleanup', async (t) => {
  const { client, child } = harness(t);
  await client.start();
  const response = client.request('fixture/final');
  child.stdout.end(JSON.stringify({ id: child.messages.at(-1).id, result: 'last' }));
  assert.equal(await response, 'last');
  assert.equal(client.isClosed, true);
});

for (const body of [
  `{bad json ${SECRET}`, '[]', 'null',
  JSON.stringify({ jsonrpc: '1.0', method: 'bad' }),
  JSON.stringify({ method: 'bad', id: null }),
  JSON.stringify({ method: 2 }),
  JSON.stringify({ id: 2, result: SECRET, error: { code: 2, message: SECRET } }),
  JSON.stringify({ id: 2, error: { code: 'wrong', message: SECRET } }),
  JSON.stringify({ id: {}, result: SECRET }),
  JSON.stringify({ id: 2 }),
]) {
  test('malformed protocol fails without leaking its payload', async (t) => {
    const { client, child } = harness(t);
    await client.start();
    const request = client.request('fixture/wait');
    const rejected = assert.rejects(request, (error) => safeError(error, 'EPROTOCOL'));
    child.stdout.write(body + '\n');
    await rejected;
    assert.equal(client.isClosed, true);
  });
}

test('duplicate active server request IDs fail rather than produce ambiguous approval', async (t) => {
  const gate = deferred();
  const { client, child } = harness(t, { onRequest: () => gate.promise });
  await client.start();
  const waiting = client.request('fixture/wait');
  const rejected = assert.rejects(waiting, { code: 'EPROTOCOL' });
  child.send({ id: 'duplicate', method: 'fixture/request' });
  await tick();
  child.send({ id: 'duplicate', method: 'fixture/request' });
  await rejected;
  gate.resolve({ decision: 'decline' });
  await tick();
  assert.ok(!child.messages.some((message) => message.id === 'duplicate'));
});

test('unterminated oversized input is bounded', async (t) => {
  const { client, child } = harness(t);
  await client.start();
  const request = client.request('fixture/wait');
  const rejected = assert.rejects(request, { code: 'EPROTOCOL' });
  child.stdout.write('x'.repeat(16 * 1024 * 1024 + 1));
  await rejected;
});

test('spawn exceptions and asynchronous errors are sanitized', async () => {
  const sync = new CodexAppServer({ command: SECRET, spawn: () => { throw new Error(SECRET); } });
  await assert.rejects(sync.start(), (error) => safeError(error, 'ESPAWN'));
  assert.equal(sync.isClosed, true);
  await sync.close();
  const child = new FakeChild({ autoInitialize: false });
  child.pid = undefined;
  const async = new CodexAppServer({ command: SECRET, spawn: () => child });
  const started = async.start();
  const rejected = assert.rejects(started, (error) => safeError(error, 'ESPAWN'));
  child.emit('error', new Error(SECRET));
  await rejected;
  await async.close();
  assert.equal(async.isClosed, true);
});

test('initialization RPC errors and exits reject start and clean up', async (t) => {
  for (const mode of ['RPC', 'exit']) {
    const { client } = harness(t, {}, { autoInitialize: false, onWrite: (message, child) => {
      if (message.method !== 'initialize') return;
      if (mode === 'RPC') child.send({ id: message.id, error: { code: -32600, message: SECRET } });
      else child.exit(9);
    } });
    await assert.rejects(client.start(), (error) => safeError(error, mode === 'RPC' ? -32600 : 'EEXIT'));
    await client.close();
    assert.equal(client.isClosed, true);
  }
});

test('invalid options and unserializable requests reject safely without breaking a ready client', async (t) => {
  assert.throws(() => new CodexAppServer({ command: '' }), { code: 'EINVAL' });
  const { client } = harness(t);
  await assert.rejects(client.request('early'), { code: 'ENOTSTARTED' });
  await client.start();
  for (const options of [{ timeoutMs: -1 }, { timeoutMs: Infinity }, { timeoutMs: 2 ** 31 },
    { timeoutMs: 0.5 }, { signal: {} }]) {
    await assert.rejects(client.request('fixture/badOptions', {}, options), { code: 'EINVAL' });
  }
  await assert.rejects(client.notify(''), { code: 'EINVAL' });
  const cyclic = {}; cyclic.value = cyclic;
  await assert.rejects(client.request('fixture/cycle', cyclic), { code: 'ESERIALIZE' });
  await assert.rejects(client.notify('fixture/toJSON', { toJSON() { throw new Error(SECRET); } }),
    (error) => safeError(error, 'ESERIALIZE'));
  assert.equal(client.isClosed, false);
});

test('queued request timeouts remove unsent writes', async (t) => {
  const { client, child } = harness(t);
  await client.start();
  child.holdWrites = true;
  const held = client.notify('fixture/held');
  await assert.rejects(client.request('fixture/queuedTimeout', {}, { timeoutMs: 10 }),
    { code: 'ETIMEDOUT' });
  child.releaseWrite();
  await held;
  await tick();
  assert.ok(!child.messages.some((message) => message.method === 'fixture/queuedTimeout'));
});

test('long UTF-8 frames split into tiny chunks retain framing and the following response', async (t) => {
  const { client, child } = harness(t);
  await client.start();
  const first = client.request('fixture/first');
  const second = client.request('fixture/second');
  await until(() => child.messages.at(-1).method === 'fixture/second');
  const text = '猫🙂'.repeat(15000);
  const bytes = Buffer.from(JSON.stringify({ id: 2, result: text }) + '\n'
    + JSON.stringify({ id: 3, result: 'next' }) + '\r\n');
  for (let offset = 0; offset < bytes.length; offset += 13) child.stdout.write(bytes.subarray(offset, offset + 13));
  assert.deepEqual(await Promise.all([first, second]), [text, 'next']);
  assert.equal(client.isClosed, false);
});

test('unsolicited replies cannot settle a request that has not been written', async (t) => {
  const { client, child } = harness(t);
  await client.start();
  child.holdWrites = true;
  const held = client.notify('fixture/held');
  const response = client.request('fixture/queued');
  let settled = false;
  response.then(() => { settled = true; });
  // No peer has seen this ID yet. Neither a forged result nor error is a reply.
  child.send({ id: 2, result: 'unsolicited' });
  child.send({ id: 2, error: { code: -1, message: SECRET } });
  await tick();
  assert.equal(settled, false);
  child.releaseWrite();
  await held;
  await until(() => child.messages.at(-1).method === 'fixture/queued');
  child.send({ id: 2, result: 'real reply' });
  child.releaseWrite();
  assert.equal(await response, 'real reply');
  assert.equal(client.isClosed, false);
});

test('abort cannot be suppressed by a prior stopImmediatePropagation listener', async (t) => {
  const { client } = harness(t);
  await client.start();
  const controller = new AbortController();
  controller.signal.addEventListener('abort', event => event.stopImmediatePropagation(), { once: true });
  const request = client.request('fixture/abort', {}, { signal: controller.signal, timeoutMs: 0 });
  const rejected = assert.rejects(request, (error) => safeError(error, 'ABORT_ERR'));
  controller.abort(SECRET);
  await rejected;
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('throwing abort listener installation rejects safely without dangling work', async (t) => {
  const { client, child } = harness(t);
  await client.start();
  const controller = new AbortController();
  controller.signal.addEventListener = () => { throw new Error(SECRET); };
  const before = child.messages.length;
  await assert.rejects(client.request('fixture/abort', {}, { signal: controller.signal }),
    (error) => safeError(error, 'EINVAL'));
  assert.equal(child.messages.length, before);
  assert.equal(client.isClosed, false);
});

test('outbound queue count and pending request count are bounded', async (t) => {
  const { client, child } = harness(t);
  await client.start();
  child.holdWrites = true;
  const writes = Array.from({ length: 1025 }, () => client.notify('fixture/held').catch(error => error));
  await assert.rejects(client.notify('fixture/overflow'), (error) => safeError(error, 'ENOBUFS'));
  const requests = Array.from({ length: 1024 }, () => client.request('fixture/wait', {}, { timeoutMs: 0 }).catch(error => error));
  // The full outbound queue rejects these too, without retaining their entries.
  assert.ok((await Promise.all(requests)).every(error => error.code === 'ENOBUFS'));
  await client.close();
  assert.ok((await Promise.all(writes)).every(error => error.code === 'ECLOSED'));
});

test('sent but unanswered requests cannot grow the pending map without bound', async (t) => {
  const { client } = harness(t);
  await client.start();
  const requests = Array.from({ length: 1024 }, () => client.request('fixture/wait', {}, { timeoutMs: 0 }).catch(error => error));
  await assert.rejects(client.request('fixture/overflow'), (error) => safeError(error, 'ENOBUFS'));
  await client.close();
  assert.ok((await Promise.all(requests)).every(error => error.code === 'ECLOSED'));
});

test('outbound byte capacity is bounded independently of queue count', async (t) => {
  const { client, child } = harness(t);
  await client.start();
  child.holdWrites = true;
  const payload = 'x'.repeat(12 * 1024 * 1024);
  const writes = [client.notify('fixture/held'), client.notify('fixture/large', payload),
    client.notify('fixture/large', payload)].map(promise => promise.catch(error => error));
  await assert.rejects(client.notify('fixture/overflow', payload), (error) => safeError(error, 'ENOBUFS'));
  await client.close();
  assert.ok((await Promise.all(writes)).every(error => error.code === 'ECLOSED'));
});

for (const kind of ['request', 'notification']) {
  test(`incoming ${kind} callback backlog is bounded and fails closed`, async (t) => {
    const gate = deferred();
    let calls = 0;
    const callback = () => { calls++; return gate.promise; };
    const { client, child } = harness(t, { onRequest: callback, onNotification: callback });
    await client.start();
    const pending = client.request('fixture/wait');
    const rejected = assert.rejects(pending, (error) => safeError(error, 'ENOBUFS'));
    for (let i = 0; i < 1024; i++) {
      child.send({ method: 'fixture/backlog', ...(kind === 'request' ? { id: `server-${i}` } : {}) });
    }
    await tick();
    assert.equal(calls, 1024);
    child.send({ method: 'fixture/overflow', ...(kind === 'request' ? { id: 'overflow' } : {}) });
    await rejected;
    gate.resolve({ decision: 'accept' });
    await tick();
    assert.ok(!child.messages.some(message => typeof message.id === 'string'));
  });
}

test('server ID reuse after a sent response does not wait for the local write callback', async (t) => {
  let calls = 0;
  const { client, child } = harness(t, { onRequest: () => ++calls });
  await client.start();
  child.holdWrites = true;
  child.send({ id: 'reusable', method: 'fixture/request' });
  await until(() => child.messages.at(-1).id === 'reusable');
  assert.equal(child.messages.at(-1).result, 1);
  child.send({ id: 'reusable', method: 'fixture/request' });
  await tick();
  assert.equal(client.isClosed, false);
  assert.equal(calls, 2);
  child.releaseWrite();
  await until(() => child.messages.at(-1).result === 2);
  child.releaseWrite();
  await tick();
  assert.equal(client.isClosed, false);
});

test('incoming callback payload capacity is bounded independently of callback count', async (t) => {
  const gate = deferred();
  const { client, child } = harness(t, { onRequest: () => gate.promise,
    onNotification: () => gate.promise });
  await client.start();
  const pending = client.request('fixture/wait');
  const rejected = assert.rejects(pending, (error) => safeError(error, 'ENOBUFS'));
  const params = 'x'.repeat(12 * 1024 * 1024);
  child.send({ id: 'large-request', method: 'fixture/large', params });
  child.send({ method: 'fixture/large', params });
  assert.equal(client.isClosed, false);
  child.send({ method: 'fixture/overflow', params });
  await rejected;
  gate.resolve({ decision: 'accept' });
  await tick();
  assert.ok(!child.messages.some(message => message.id === 'large-request'));
});

test('server-resolved requests are not dispatched if cancellation precedes their callback', async (t) => {
  let calls = 0;
  const { client, child } = harness(t, { onRequest: () => { calls++; return { decision: 'accept' }; } });
  await client.start();
  child.stdout.write(JSON.stringify({ id: 'approval', method: 'fixture/approval' }) + '\n'
    + JSON.stringify({ method: 'serverRequest/resolved', params: { requestId: 'approval' } }) + '\n');
  await tick();
  assert.equal(calls, 0);
  assert.ok(!child.messages.some(message => message.id === 'approval'));
  assert.equal(client.isClosed, false);
});

test('server-resolved request IDs preserve type and suppress even an ignored late approval', async (t) => {
  const gate = deferred();
  let signal;
  const { client, child } = harness(t, { onRequest: (_method, _params, _id, lifetime) => {
    signal = lifetime;
    return gate.promise;
  } });
  await client.start();
  child.send({ id: '4', method: 'fixture/approval' });
  await tick();
  child.send({ method: 'serverRequest/resolved', params: { requestId: 4 } });
  assert.equal(signal.aborted, false);
  child.send({ method: 'serverRequest/resolved', params: { requestId: '4' } });
  assert.equal(signal.aborted, true);
  safeError(signal.reason, 'ECANCELLED');
  gate.resolve({ decision: 'accept' });
  await tick();
  assert.ok(!child.messages.some(message => message.id === '4'));
  assert.equal(client.isClosed, false);
});

test('server cancellation removes an already-queued approval and permits safe ID reuse', async (t) => {
  let calls = 0;
  const signals = [];
  const { client, child } = harness(t, { onRequest: (_method, _params, _id, signal) => {
    signals.push(signal);
    return { decision: ++calls === 1 ? 'accept' : 'decline' };
  } });
  await client.start();
  child.holdWrites = true;
  const held = client.notify('fixture/held');
  child.send({ id: 'approval', method: 'fixture/approval' });
  await tick();
  child.send({ method: 'serverRequest/resolved', params: { requestId: 'approval' } });
  assert.equal(signals[0].aborted, true);
  child.send({ id: 'approval', method: 'fixture/approval' });
  await tick();
  assert.equal(calls, 2);
  child.releaseWrite();
  await held;
  await until(() => child.messages.at(-1).id === 'approval');
  assert.deepEqual(child.messages.at(-1).result, { decision: 'decline' });
  child.releaseWrite();
  await tick();
  assert.equal(child.messages.filter(message => message.id === 'approval').length, 1);
  assert.equal(client.isClosed, false);
});

test('cancelled callbacks that ignore abort remain included in the work limit', async (t) => {
  const gate = deferred();
  const { client, child } = harness(t, { onRequest: () => gate.promise });
  await client.start();
  const pending = client.request('fixture/wait');
  const rejected = assert.rejects(pending, { code: 'ENOBUFS' });
  for (let i = 0; i < 1000; i++) {
    child.send({ id: `cancelled-${i}`, method: 'fixture/approval' });
    await tick();
    child.send({ method: 'serverRequest/resolved', params: { requestId: `cancelled-${i}` } });
    await tick();
  }
  assert.equal(client.isClosed, false);
  for (let i = 0; i < 25; i++) child.send({ id: `overflow-${i}`, method: 'fixture/approval' });
  await rejected;
  gate.resolve({ decision: 'accept' });
  await tick();
  assert.ok(!child.messages.some(message => typeof message.id === 'string'));
});

test('callback lifetime signals abort on closure and cannot send a late approval', async (t) => {
  const signals = [];
  const waitForClose = signal => {
    signals.push(signal);
    return new Promise(resolve => signal.addEventListener('abort', () => resolve({ decision: 'accept' }), { once: true }));
  };
  const { client, child } = harness(t, {
    onNotification: (_method, _params, signal) => waitForClose(signal),
    onRequest: (_method, _params, _id, signal) => waitForClose(signal),
  });
  await client.start();
  child.send({ method: 'fixture/notification' });
  child.send({ id: 'approval', method: 'fixture/approval' });
  await tick();
  assert.equal(signals.length, 2);
  assert.ok(signals.every(signal => signal instanceof AbortSignal && !signal.aborted));
  await client.close();
  await tick();
  assert.ok(signals.every(signal => signal.aborted && safeError(signal.reason, 'ECLOSED')));
  assert.ok(!child.messages.some(message => message.id === 'approval'));
});

for (const incomplete of [false, true]) {
  test(`invalid ${incomplete ? 'truncated' : 'malformed'} UTF-8 is a safe protocol failure`, async (t) => {
    const { client, child } = harness(t);
    await client.start();
    const pending = client.request('fixture/wait');
    const rejected = assert.rejects(pending, (error) => safeError(error, 'EPROTOCOL'));
    if (incomplete) child.stdout.end(Buffer.from([0xf0, 0x9f]));
    else child.stdout.write(Buffer.concat([
      Buffer.from('{"id":2,"result":"'), Buffer.from([0xc0, 0xaf]), Buffer.from('"}\n'),
    ]));
    await rejected;
  });
}

test('close before start does not spawn and cannot be restarted', async () => {
  const client = new CodexAppServer({ command: 'fixture', spawn: () => assert.fail('must not spawn') });
  await client.close();
  await assert.rejects(client.start(), { code: 'ECLOSED' });
});

// A real Node child validates OS pipe behavior with no model, credentials,
// temporary fixture files, package installs, or network requests.
const fixture = `
  import { createInterface } from 'node:readline';
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
  let ready = false;
  lines.on('line', (line) => {
    const message = JSON.parse(line);
    if (message.method === 'initialize') send({ id: message.id, result: { fixture: true } });
    else if (message.method === 'initialized') {
      ready = true;
      send({ method: 'fixture/ready', params: {} });
      send({ id: 'approval', method: 'fixture/approval' });
    } else if (message.method === 'fixture/echo') {
      send({ id: message.id, result: { ready, params: message.params,
        args: process.argv.slice(1), cwd: process.cwd() } });
    } else if (message.id === 'approval') send({ method: 'fixture/decision', params: message.error });
  });
  lines.on('close', () => process.exit(0));
`;

test('real Node stdio subprocess: handshake, echo, notifications, denied request, cleanup', async (t) => {
  const seen = [];
  const client = new CodexAppServer({ command: process.execPath,
    args: ['--input-type=module', '--eval', fixture, '--'], env: {}, cwd: '/tmp',
    onNotification: (method, params) => seen.push([method, params]) });
  t.after(() => client.close());
  assert.deepEqual(await client.start(), { fixture: true });
  const result = await client.request('fixture/echo', { text: '猫🙂' });
  assert.deepEqual(result, { ready: true, params: { text: '猫🙂' },
    args: ['app-server', '--listen', 'stdio://'], cwd: '/tmp' });
  await until(() => seen.some(([method]) => method === 'fixture/decision'));
  assert.deepEqual(seen, [
    ['fixture/ready', {}], ['fixture/decision', { code: -32601, message: 'Method not found' }],
  ]);
  await client.close();
  assert.equal(client.isClosed, true);
});

for (const mode of ['close', 'exit']) {
  test(`owned POSIX process group stops subprocesses after leader ${mode}`,
    { timeout: 5000, skip: process.platform !== 'linux' }, async (t) => {
      const leafSource = `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); process.send('ready');`;
      const source = `
        import { spawn } from 'node:child_process';
        import { createInterface } from 'node:readline';
        const send = message => process.stdout.write(JSON.stringify(message) + '\\n');
        const leaf = spawn(process.execPath, ['--eval', ${JSON.stringify(leafSource)}], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
        let ready;
        const started = new Promise(resolve => { ready = resolve; });
        leaf.once('message', () => { send({ method: 'fixture/pids', params: { leader: process.pid, leaf: leaf.pid } }); ready(); });
        const lines = createInterface({ input: process.stdin });
        lines.on('line', async line => {
          const message = JSON.parse(line);
          if (message.method === 'initialize') { await started; send({ id: message.id, result: {} }); }
          if (message.method === 'fixture/exit') process.exit(0);
        });
        lines.on('close', () => process.exit(0));
      `;
      let pids;
      const client = new CodexAppServer({ command: process.execPath,
        args: ['--input-type=module', '--eval', source, '--'], env: {},
        onNotification: (_method, params) => { pids = params; } });
      t.after(async () => {
        await client.close();
        if (pids) { try { process.kill(-pids.leader, 'SIGKILL'); } catch {} }
      });
      await client.start();
      assert.ok(pids?.leader > 0 && pids.leaf > 0);
      if (mode === 'exit') {
        await client.notify('fixture/exit');
        await until(() => client.isClosed);
      }
      await client.close();
      const running = async pid => {
        try {
          const status = await readFile(`/proc/${pid}/stat`, 'utf8');
          return !/^\d+ \(.*\) [ZX] /u.test(status);
        } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
      };
      assert.equal(await running(pids.leader), false);
      assert.equal(await running(pids.leaf), false);
    });
}

test('real uncooperative Node child is killed and reaped on close', { timeout: 5000 }, async (t) => {
  const resistant = `
    import { createInterface } from 'node:readline';
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
    createInterface({ input: process.stdin }).on('line', (line) => {
      const message = JSON.parse(line);
      if (message.method === 'initialize') {
        process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + '\\n');
      }
    });
  `;
  let child;
  const client = new CodexAppServer({ command: process.execPath,
    args: ['--input-type=module', '--eval', resistant, '--'], env: {},
    spawn: (...args) => { child = nodeSpawn(...args); return child; } });
  t.after(async () => {
    await client.close();
    if (child && child.signalCode === null && child.exitCode === null) child.kill('SIGKILL');
  });
  await client.start();
  await client.close();
  assert.equal(client.isClosed, true);
  assert.equal(child.signalCode, 'SIGKILL');
  assert.equal(child.stdout.destroyed, true);
});
