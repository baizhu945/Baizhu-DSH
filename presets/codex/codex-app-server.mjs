import { spawn as nodeSpawn } from 'node:child_process';
import { addAbortListener } from 'node:events';

const MAX_LINE_CHARS = 16 * 1024 * 1024;
const MAX_TIMEOUT_MS = 2 ** 31 - 1;
const MAX_WORK_ITEMS = 1024;
const MAX_QUEUED_CHARS = 32 * 1024 * 1024;
const ignoreError = () => {};
const safeErrors = new WeakSet();
const has = (object, key) => Object.hasOwn(object, key);
const validId = (id) => typeof id === 'string' || Number.isSafeInteger(id);

function failure(message, code, name = 'CodexAppServerError') {
  const error = new Error(message);
  error.name = name;
  if (code !== undefined) error.code = code;
  safeErrors.add(error);
  return error;
}

function unhandledRequest() {
  throw failure('Method not found', -32601);
}

/**
 * Dependency-free, single-use Codex app-server stdio client (Node >=22).
 *
 * `args` are command-prefix arguments, followed by app-server --listen stdio://.
 * The official 86a54b0 transport rejects bare
 * `stdio`. Outbound messages include jsonrpc: '2.0'; inbound Codex messages may
 * omit it. IDs retain their string/number type; batches are not supported.
 *
 * start() returns the initialize result and is safe to call concurrently.
 * request() returns a result; notify() resolves once its serialized write has
 * completed, including backpressure. timeoutMs: 0 disables the request timer.
 * Cancellation is local: it does not approve requests or interrupt server turns.
 * onNotification(method, params, signal) and onRequest(method, params, id, signal)
 * may be async and run concurrently, including during startup. Active callback
 * signals abort on closure; request signals also abort on serverRequest/resolved.
 * Callbacks must cooperate to cancel their work; cancelled replies are dropped.
 * Server IDs preserve type. Pending work and outbound buffers are bounded.
 * An unhandled request is denied with -32601, never implicitly approved.
 * onClose(error) runs once after the closed state and pending cleanup are set,
 * for failure or explicit close. Its return value is not awaited; sync/async
 * callback failures are ignored and cannot affect shutdown.
 *
 * No untrusted message, data, callback exception, command, or stderr content is
 * copied into diagnostics. RPC failures expose only their numeric `code`.
 * stderr is a bounded, content-free byte-count summary. close() is idempotent,
 * rejects pending work immediately, then bounds EOF/SIGTERM/SIGKILL cleanup.
 * The built-in POSIX spawn owns a process group, including child subprocesses.
 * Injected spawn implementations own any subprocess cleanup themselves.
 */
export class CodexAppServer {
  #command;
  #args;
  #env;
  #cwd;
  #spawn;
  #onNotification;
  #onRequest;
  #onClose;
  #state = 'new';
  #child;
  #startPromise;
  #closePromise;
  #failure;
  #nextId = 1;
  #pending = new Map();
  #incoming = new Map();
  #incomingChars = 0;
  #writes = [];
  #queuedChars = 0;
  #activeWrite;
  #notifications = 0;
  #requestCallbacks = 0;
  #callbackAbort = new AbortController();
  #groupPid;
  #listeners = [];
  #decoder = new TextDecoder('utf-8', { fatal: true });
  #buffer = [];
  #bufferChars = 0;
  #stderrBytes = 0;
  #exited = false;
  #exitPromise;
  #resolveExit;

  constructor({ command, args = [], env = process.env, cwd,
    onNotification = () => {}, onRequest = unhandledRequest, onClose = () => {},
    spawn = nodeSpawn } = {}) {
    if (typeof command !== 'string' || !command || !Array.isArray(args)
      || !args.every((arg) => typeof arg === 'string')
      || typeof spawn !== 'function' || typeof onNotification !== 'function'
      || typeof onRequest !== 'function' || typeof onClose !== 'function') {
      throw failure('Invalid Codex app-server constructor options', 'EINVAL');
    }
    this.#command = command;
    this.#args = [...args];
    this.#env = env;
    this.#cwd = cwd;
    this.#spawn = spawn;
    this.#onNotification = onNotification;
    this.#onRequest = onRequest;
    this.#onClose = onClose;
  }

  get isClosed() { return this.#state === 'closed'; }

  get stderr() {
    return this.#stderrBytes === 0 ? ''
      : `Codex app-server stderr: ${this.#stderrBytes} bytes received (contents omitted)`;
  }

  async start({ clientInfo = { name: 'dsh_codex', version: '0.1.0' },
    capabilities = { experimentalApi: true } } = {}) {
    if (this.isClosed) throw this.#failure;
    if (!this.#startPromise) {
      this.#state = 'starting';
      this.#startPromise = this.#initialize(clientInfo, capabilities);
    }
    return this.#startPromise;
  }

  async #initialize(clientInfo, capabilities) {
    try {
      try {
        this.#child = this.#spawn(this.#command,
          [...this.#args, 'app-server', '--listen', 'stdio://'],
          { env: this.#env, cwd: this.#cwd, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
            ...(this.#spawn === nodeSpawn && process.platform !== 'win32' ? { detached: true } : {}) });
      } catch {
        throw failure('Could not spawn Codex app-server', 'ESPAWN');
      }
      const child = this.#child;
      if (this.#spawn === nodeSpawn && process.platform !== 'win32'
        && Number.isSafeInteger(child?.pid) && child.pid > 0) this.#groupPid = child.pid;
      if (!child?.stdin?.write || !child?.stdout?.on || !child?.stderr?.on || !child?.on) {
        throw failure('Codex app-server requires piped stdio', 'ESPAWN');
      }
      this.#exitPromise = new Promise((resolve) => { this.#resolveExit = resolve; });
      // Install every listener before the first write. Responses may arrive
      // before write callbacks; server requests may arrive during initialize.
      this.#listen(child, 'error', () => {
        if (!child.pid) this.#markExited();
        this.#fail(failure('Codex app-server process error', 'ESPAWN'));
      });
      this.#listen(child, 'exit', (code) => {
        this.#markExited();
        const suffix = Number.isSafeInteger(code) ? ` (code ${code})` : '';
        this.#fail(failure(`Codex app-server exited${suffix}`, 'EEXIT'));
      });
      this.#listen(child, 'close', () => {
        this.#markExited();
        this.#fail(failure('Codex app-server process closed', 'EEXIT'));
      });
      this.#listen(child.stdout, 'data', (chunk) => this.#read(chunk));
      this.#listen(child.stdout, 'end', () => {
        if (this.isClosed) return;
        try {
          const line = this.#buffer.join('') + this.#decoder.decode();
          if (line.trim()) this.#parseLine(line);
        } catch { this.#protocolError(); return; }
        this.#fail(failure('Codex app-server stdout reached EOF', 'EEOF'));
      });
      this.#listen(child.stdout, 'close', () => {
        this.#fail(failure('Codex app-server stdout closed', 'EEOF'));
      });
      this.#listen(child.stderr, 'data', (chunk) => {
        const bytes = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
        this.#stderrBytes = Math.min(Number.MAX_SAFE_INTEGER, this.#stderrBytes + bytes);
      });
      for (const stream of [child.stdin, child.stdout, child.stderr]) {
        this.#listen(stream, 'error', () => {
          this.#fail(failure('Codex app-server stdio error', 'EIO'));
        });
      }
      this.#listen(child.stdin, 'close', () => {
        this.#fail(failure('Codex app-server stdin closed', 'EIO'));
      });
      const result = await this.request('initialize', { clientInfo, capabilities });
      await this.notify('initialized');
      if (this.isClosed) throw this.#failure;
      this.#state = 'ready';
      return result;
    } catch (caught) {
      // Only errors created here may retain their messages/codes.
      const error = this.#failure ?? (safeErrors.has(caught) ? caught
        : failure('Codex app-server initialization failed', 'EINIT'));
      this.#fail(error);
      throw error;
    }
  }

  async request(method, params, { signal, timeoutMs = 60000 } = {}) {
    this.#assertOpen();
    this.#validateMethod(method);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_TIMEOUT_MS
      || (signal !== undefined && !(signal instanceof AbortSignal))) {
      throw failure('Invalid Codex app-server request options', 'EINVAL');
    }
    if (signal?.aborted) throw this.#abortError();
    if (this.#pending.size >= MAX_WORK_ITEMS) {
      throw failure('Codex app-server has too much pending work', 'ENOBUFS');
    }
    if (!Number.isSafeInteger(this.#nextId)) {
      throw failure('Codex app-server request IDs exhausted', 'EID');
    }
    const id = this.#nextId++;
    const line = this.#encode({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, sent: false, timer: undefined, abort: undefined };
      // Correlation is registered before enqueueing a potentially synchronous write.
      this.#pending.set(id, entry);
      if (signal) {
        const abort = () => this.#settle(id, this.#abortError());
        try { entry.abort = addAbortListener(signal, abort); }
        catch { this.#settle(id, failure('Invalid Codex app-server abort signal', 'EINVAL')); }
        if (signal.aborted) abort();
      }
      if (!this.#pending.has(id)) return;
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => this.#settle(id,
          failure('Codex app-server request timed out', 'ETIMEDOUT', 'TimeoutError')), timeoutMs);
      }
      this.#enqueue(line, id).catch((error) => this.#settle(id, error));
    });
  }

  async notify(method, params) {
    this.#assertOpen();
    this.#validateMethod(method);
    await this.#enqueue(this.#encode({ jsonrpc: '2.0', method, params }));
  }

  async close() {
    await this.#finish(failure('Codex app-server connection closed', 'ECLOSED'));
  }

  #assertOpen() {
    if (this.isClosed) throw this.#failure;
    if (this.#state === 'new') throw failure('Codex app-server has not started', 'ENOTSTARTED');
  }

  #validateMethod(method) {
    if (typeof method !== 'string' || !method) {
      throw failure('Invalid Codex app-server method', 'EINVAL');
    }
  }

  #abortError() {
    // Abort reasons can contain secrets, too.
    return failure('Codex app-server request aborted', 'ABORT_ERR', 'AbortError');
  }

  #encode(message) {
    try {
      const line = JSON.stringify(message);
      if (line.length > MAX_LINE_CHARS
        || (has(message, 'result') && !has(JSON.parse(line), 'result'))) throw new Error();
      return `${line}\n`;
    } catch {
      throw failure('Codex app-server message could not be serialized', 'ESERIALIZE');
    }
  }

  #settle(id, error, result) {
    const entry = this.#pending.get(id);
    if (!entry) return;
    this.#pending.delete(id);
    clearTimeout(entry.timer);
    try { entry.abort?.[Symbol.dispose](); } catch {}
    const index = this.#writes.findIndex((write) => write.id === id);
    if (index !== -1) {
      const [write] = this.#writes.splice(index, 1);
      this.#queuedChars -= write.line.length;
      write.line = undefined;
      write.resolve();
    }
    if (error) entry.reject(error);
    else entry.resolve(result);
  }

  #enqueue(line, id, onSent, serverToken) {
    if (this.isClosed) return Promise.reject(this.#failure);
    if (this.#writes.length >= MAX_WORK_ITEMS
      || this.#queuedChars + line.length > MAX_QUEUED_CHARS) {
      return Promise.reject(failure('Codex app-server outbound buffer is full', 'ENOBUFS'));
    }
    return new Promise((resolve, reject) => {
      this.#queuedChars += line.length;
      this.#writes.push({ line, id, onSent, serverToken, resolve, reject });
      this.#pump();
    });
  }

  #pump() {
    if (this.isClosed || this.#activeWrite || this.#writes.length === 0) return;
    const write = this.#writes.shift();
    this.#queuedChars -= write.line.length;
    const stream = this.#child.stdin;
    let returned = false;
    let written = false;
    let blocked = false;
    let drained = false;
    let done = false;
    let timer;
    const finish = (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stream.removeListener('drain', onDrain);
      write.line = undefined;
      this.#activeWrite = undefined;
      if (error) write.reject(error);
      else write.resolve();
      queueMicrotask(() => this.#pump());
    };
    const check = () => {
      if (returned && written && (!blocked || drained)) finish();
    };
    const onDrain = () => { drained = true; check(); };
    this.#activeWrite = finish;
    stream.on('drain', onDrain);
    timer = setTimeout(() => this.#fail(
      failure('Codex app-server write timed out', 'ETIMEDOUT')), 60000);
    try {
      const entry = this.#pending.get(write.id);
      if (entry) entry.sent = true;
      write.onSent?.();
      blocked = !stream.write(write.line, 'utf8', (error) => {
        if (done) return;
        if (error) this.#fail(failure('Codex app-server write failed', 'EIO'));
        else { written = true; check(); }
      });
      returned = true;
      if (!blocked) stream.removeListener('drain', onDrain);
      check();
    } catch {
      this.#fail(failure('Codex app-server write failed', 'EIO'));
    }
  }

  #read(chunk) {
    if (this.isClosed) return;
    try {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      // Bound decoding/concatenation even if one data event is unusually huge.
      for (let offset = 0; !this.isClosed && offset < bytes.length; offset += 65536) {
        const text = this.#decoder.decode(bytes.subarray(offset, offset + 65536), { stream: true });
        let start = 0;
        let end;
        while (!this.isClosed && (end = text.indexOf('\n', start)) !== -1) {
          const tail = text.slice(start, end);
          if (this.#bufferChars + tail.length > MAX_LINE_CHARS) { this.#protocolError(); return; }
          const line = this.#buffer.join('') + tail;
          this.#buffer = [];
          this.#bufferChars = 0;
          this.#parseLine(line);
          start = end + 1;
        }
        if (!this.isClosed && start < text.length) {
          const tail = text.slice(start);
          this.#bufferChars += tail.length;
          if (this.#bufferChars > MAX_LINE_CHARS) { this.#protocolError(); return; }
          // Keep pieces until newline: rescanning/flattening a growing string
          // on each chunk makes a long, split line quadratic in CPU/allocation.
          const last = this.#buffer.length - 1;
          if (last >= 0 && this.#buffer[last].length < 4096) this.#buffer[last] += tail;
          else this.#buffer.push(tail);
        }
      }
    } catch {
      this.#protocolError();
    }
  }

  #parseLine(line) {
    if (line.length > MAX_LINE_CHARS) { this.#protocolError(); return; }
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); } catch { this.#protocolError(); return; }
    if (!message || typeof message !== 'object' || Array.isArray(message)
      || (has(message, 'jsonrpc') && message.jsonrpc !== '2.0')) {
      this.#protocolError(); return;
    }
    if (has(message, 'method')) {
      if (typeof message.method !== 'string' || !message.method
        || has(message, 'result') || has(message, 'error')) {
        this.#protocolError(); return;
      }
      const chars = line.length;
      if (this.#requestCallbacks + this.#notifications >= MAX_WORK_ITEMS
        || this.#incomingChars + chars > MAX_QUEUED_CHARS) {
        this.#fail(failure('Codex app-server has too much incoming work', 'ENOBUFS')); return;
      }
      if (has(message, 'id')) {
        if (!validId(message.id) || this.#incoming.has(message.id)) {
          this.#protocolError(); return;
        }
        this.#dispatchRequest(message, chars);
      } else {
        if (message.method === 'serverRequest/resolved' && validId(message.params?.requestId)) {
          const token = this.#incoming.get(message.params.requestId);
          if (token) this.#cancelIncoming(message.params.requestId, token);
        }
        this.#notifications++;
        this.#incomingChars += chars;
        Promise.resolve().then(() => {
          if (!this.isClosed) return this.#onNotification(message.method, message.params,
            this.#callbackAbort.signal);
        }).catch(() => this.#fail(
          failure('Codex app-server notification handler failed', 'ECALLBACK')))
          .finally(() => { this.#notifications--; this.#incomingChars -= chars; });
      }
      return;
    }
    const isError = has(message, 'error');
    if (!has(message, 'id') || !validId(message.id)
      || isError === has(message, 'result')
      || (isError && (!message.error || typeof message.error !== 'object'
        || !Number.isSafeInteger(message.error.code) || typeof message.error.message !== 'string'))) {
      this.#protocolError(); return;
    }
    // A peer cannot answer a request that is still queued behind backpressure.
    // Registering correlation before write is necessary, but is not dispatch.
    if (!this.#pending.get(message.id)?.sent) return;
    if (isError) {
      const error = failure(`Codex app-server RPC error (code ${message.error.code})`, message.error.code);
      // Preserve a bounded, non-secret reason for the known empty-thread
      // lifecycle case. Never expose arbitrary server message/data or tokens.
      if (message.error.code === -32600 && /^no rollout found for thread id [A-Za-z0-9_-]+$/.test(message.error.message)) {
        error.rpcReason = 'THREAD_NOT_FOUND';
      }
      this.#settle(message.id, error);
    } else {
      this.#settle(message.id, undefined, message.result);
    }
    // Valid unknown responses are normal after local cancellation/timeout.
  }

  #cancelIncoming(id, token) {
    this.#incoming.delete(id);
    const index = this.#writes.findIndex((write) => write.serverToken === token);
    if (index !== -1) {
      const [write] = this.#writes.splice(index, 1);
      this.#queuedChars -= write.line.length;
      write.line = undefined;
      write.resolve();
    }
    token.controller.abort(failure('Codex app-server request resolved', 'ECANCELLED'));
  }

  #dispatchRequest({ id, method, params }, chars) {
    this.#requestCallbacks++;
    this.#incomingChars += chars;
    const token = { controller: new AbortController() };
    this.#incoming.set(id, token);
    Promise.resolve().then(async () => {
      if (this.isClosed || this.#incoming.get(id) !== token) return;
      let line;
      try {
        const result = await this.#onRequest(method, params, id, token.controller.signal);
        // Undefined is not a JSON-RPC result and must never become approval.
        if (result === undefined) throw new Error();
        line = this.#encode({ jsonrpc: '2.0', id, result });
      } catch (error) {
        let code = -32603;
        // Even inspecting a thrown value can throw (a user-supplied getter).
        try {
          const requestedCode = error?.code;
          if (Number.isSafeInteger(requestedCode)) code = requestedCode;
        } catch {}
        line = this.#encode({ jsonrpc: '2.0', id,
          error: { code, message: code === -32601 ? 'Method not found' : 'Request handler failed' } });
      }
      if (!this.isClosed && this.#incoming.get(id) === token) {
        await this.#enqueue(line, undefined, () => {
          // The peer can receive this response before Node's write callback.
          // ID reuse after dispatch must not look like an active duplicate.
          if (this.#incoming.get(id) === token) this.#incoming.delete(id);
        }, token);
      }
    }).catch(() => this.#fail(failure('Codex app-server request dispatch failed', 'ECALLBACK')))
      .finally(() => {
        this.#requestCallbacks--;
        this.#incomingChars -= chars;
        if (this.#incoming.get(id) === token) this.#incoming.delete(id);
      });
  }

  #protocolError() {
    this.#fail(failure('Invalid Codex app-server JSON-RPC message', 'EPROTOCOL'));
  }

  #listen(target, event, listener) {
    target.on(event, listener);
    this.#listeners.push([target, event, listener]);
  }

  #markExited() {
    this.#exited = true;
    this.#resolveExit?.();
  }

  #fail(error) { void this.#finish(error); }

  #finish(error) {
    const didClose = !this.isClosed;
    if (didClose) {
      this.#state = 'closed';
      this.#failure = error;
      this.#buffer = [];
      this.#bufferChars = 0;
      const incoming = [...this.#incoming.values()];
      this.#incoming.clear();
      this.#activeWrite?.(error);
      for (const write of this.#writes.splice(0)) {
        write.line = undefined;
        write.reject(error);
      }
      this.#queuedChars = 0;
      for (const id of this.#pending.keys()) this.#settle(id, error);
      for (const token of incoming) token.controller.abort(error);
      this.#callbackAbort.abort(error);
    }
    // Defer shutdown so this promise exists even if end()/kill() synchronously
    // emits an error, exit, close, or EOF event.
    this.#closePromise ??= Promise.resolve().then(() => this.#stopChild());
    if (didClose) {
      // The promise and closed state exist before a reentrant onClose/close().
      // Lifecycle delivery is immediate, never blocked by callback completion.
      try { Promise.resolve(this.#onClose(this.#failure)).catch(ignoreError); } catch {}
    }
    return this.#closePromise;
  }

  async #waitForExit(ms) {
    if (this.#exited) return true;
    let timer;
    try {
      await Promise.race([this.#exitPromise,
        new Promise((resolve) => { timer = setTimeout(resolve, ms); })]);
    } finally { clearTimeout(timer); }
    return this.#exited;
  }

  #signalGroup(signal) {
    if (!this.#groupPid) return false;
    try { process.kill(-this.#groupPid, signal); return true; } catch { return false; }
  }

  async #waitForGroup(ms) {
    const deadline = performance.now() + ms;
    while (this.#signalGroup(0)) {
      if (performance.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return true;
  }

  async #stopChild() {
    const child = this.#child;
    if (!child) return;
    try {
      try { child.stdin?.end(); } catch {}
      if (!this.#exited && child.kill) {
        if (!this.#exitPromise) {
          // A broken injected spawn implementation still must not hang close.
          try { child.kill('SIGKILL'); } catch {}
        } else if (!await this.#waitForExit(500)) {
          if (!this.#signalGroup('SIGTERM')) { try { child.kill('SIGTERM'); } catch {} }
          if (!await this.#waitForExit(250)) {
            if (!this.#signalGroup('SIGKILL')) { try { child.kill('SIGKILL'); } catch {} }
            await this.#waitForExit(250);
          }
        }
      }
      // EOF/leader exit says nothing about its subprocesses. They can retain
      // pipes or ignore SIGTERM after the app-server has already been reaped.
      if (this.#signalGroup('SIGTERM') && !await this.#waitForGroup(250)) {
        this.#signalGroup('SIGKILL');
        await this.#waitForGroup(250);
      }
    } finally {
      // Retain only inert error guards for late EPIPE/spawn errors, not handlers
      // that capture the client or payloads. All owned listeners are removed.
      for (const target of new Set(this.#listeners.map(([target]) => target))) {
        target.on('error', ignoreError);
      }
      for (const [target, event, listener] of this.#listeners.splice(0)) {
        target.removeListener(event, listener);
      }
      for (const stream of [child.stdin, child.stdout, child.stderr]) {
        try { stream?.destroy(); } catch {}
      }
      this.#child = undefined;
      this.#groupPid = undefined;
      this.#resolveExit = undefined;
      this.#exitPromise = undefined;
    }
  }
}
