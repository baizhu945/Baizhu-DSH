#!/usr/bin/env node
// Linux, Node >=24, Python 3, util-linux unshare; no installs or real HOME access.
// node runtime-smoke.mjs DSH_RUNTIME_ROOT TUI_DERIVATION_ROOT [LAUNCHERS_LINKFARM]
// Optional linkfarm: dsh/bin/dsh + dsh-tui/bin/dsh-tui (or a merged bin/).
// In an already offline Nix sandbox set DSH_SMOKE_NETNS=1; otherwise unshare
// creates the network namespace. No tests are skipped.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, symlink, chmod, rm, access } from 'node:fs/promises';
import { tmpdir, networkInterfaces } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import net from 'node:net';

const self = fileURLToPath(import.meta.url);
const args = process.argv.slice(2);
if (args.length < 2 || args.length > 3) {
  console.error('Usage: node runtime-smoke.mjs DSH_RUNTIME_ROOT TUI_DERIVATION_ROOT [LAUNCHERS_LINKFARM]');
  process.exit(2);
}
const roots = args.map(p => resolve(p));
const children = new Set();
let home;
const watchdog = setTimeout(() => {
  console.error('FAIL global smoke deadline (220s)');
  cleanup().finally(() => process.exit(1));
}, 220000);
watchdog.unref();
const sleep = ms => new Promise(r => setTimeout(r, ms));
function start(command, argv, env, cwd) {
  const p = spawn(command, argv, { env, cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  p.output = '';
  for (const stream of [p.stdout, p.stderr]) stream.on('data', b => { p.output = (p.output + b).slice(-24000); });
  p.done = new Promise((res, rej) => { p.once('error', rej); p.once('exit', (code, signal) => res({ code, signal })); });
  // Attach immediately: an ENOENT must not become an unhandled rejection.
  p.done.catch(() => {});
  children.add(p);
  return p;
}
async function stop(p) {
  if (!p.pid) return;
  const kill = signal => { try { process.kill(-p.pid, signal); } catch (e) { if (e.code !== 'ESRCH') throw e; } };
  kill('SIGTERM');
  await Promise.race([p.done.catch(() => {}), sleep(1000)]);
  kill('SIGKILL');
  await p.done.catch(() => {});
  children.delete(p);
}
async function run(command, argv, env, cwd, timeout = 60000) {
  const p = start(command, argv, env, cwd);
  let timer;
  try {
    const result = await Promise.race([p.done, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timeout: ${command} ${argv.join(' ')}`)), timeout);
    })]);
    assert.equal(result.code, 0, `${command} ${argv.join(' ')}: ${JSON.stringify(result)}\n${p.output}`);
    return p.output;
  } catch (e) { throw new Error(e.message.includes(p.output) ? e.message : `${e.message}\n${p.output}`); }
  finally { clearTimeout(timer); await stop(p); }
}
async function cleanup() {
  await Promise.all([...children].map(stop));
  if (home) await rm(home, { recursive: true, force: true });
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  cleanup().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143));
});
const cleanEnv = {
  PATH: process.env.PATH, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TERM: 'xterm-256color',
};
try {
  // Kernel-enforced offline, also covering native libraries and spawned tools.
  // Bring only lo up using the Python stdlib (no iproute2 dependency).
  if (process.env.DSH_SMOKE_NETNS !== '1') {
    const bootstrap = `import os,socket,fcntl,struct,sys\ns=socket.socket(socket.AF_INET,socket.SOCK_DGRAM)\nfcntl.ioctl(s,0x8914,struct.pack('16sH14s',b'lo',0x49,b''))\ns.close()\nos.execv(sys.argv[1],sys.argv[1:])`;
    const report = await run('unshare', ['--user', '--map-root-user', '--net', 'python3', '-c', bootstrap,
      process.execPath, self, ...roots], { ...cleanEnv, DSH_SMOKE_NETNS: '1' }, '/tmp', 240000);
    process.stdout.write(report);
    console.log('PASS offline runtime smoke (network namespace, isolated HOME)');
  } else {
    assert.ok(Object.values(networkInterfaces()).flat().every(i => i.internal),
      'DSH_SMOKE_NETNS=1 requires an already isolated loopback-only network namespace');
    const [runtime, tui, launchers] = roots;
    home = await mkdtemp(join(tmpdir(), 'dsh-runtime-smoke-'));
    const dshHome = join(home, '.dsh');
    const bin = join(home, 'bin');
    const profile = join(dshHome, 'profiles/dsh-tui');
    const target = join(profile, 'node_modules/@deepseek-harness-tui/dsh-tui');
    await mkdir(bin, { recursive: true });
    await mkdir(profile, { recursive: true });
    // GNU cp behavior used by activation: dereference and make store dirs writable.
    // fs.cp's default mode copies read-only dirs, preventing nested dependency copy.
    const env = { ...cleanEnv, PATH: `${bin}:${cleanEnv.PATH}`, HOME: home, DSH_HOME: dshHome,
      XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'),
      XDG_DATA_HOME: join(home, '.local/share'), XDG_STATE_HOME: join(home, '.local/state'),
      TMPDIR: home, DSH_TELEMETRY_DISABLED: '1', DSH_TUI_LANG: 'en',
      DSH_TUI_UPDATE_ENGINE: '0', DSH_TUI_UPDATE_LAUNCHER: '0',
      DEEPSEEK_API_KEY: 'offline-smoke-fake-key', DEEPSEEK_BASE_URL: 'http://127.0.0.1:9',
      NO_COLOR: '1', PYTHONDONTWRITEBYTECODE: '1' };
    // The in-process official mock import gets the same credential-free HOME too.
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, env);
    await mkdir(dirname(target), { recursive: true });
    await run('cp', ['-rL', '--no-preserve=mode', join(tui, 'package'), target], env, home);
    await mkdir(join(target, 'node_modules'), { recursive: true });
    await run('cp', ['-rL', '--no-preserve=mode', `${tui}/node_modules/.`, `${target}/node_modules/`], env, home);
    const manifest = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'));
    // Assert published entry files, including the 0.20 CLI split; never fill holes
    // from the source checkout or manufacture the missing cli directory.
    for (const entry of Object.values(typeof manifest.bin === 'string' ? { bin: manifest.bin } : manifest.bin ?? {}))
      await access(join(target, entry));
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'offline-tui-smoke', private: true,
      type: 'module', dependencies: { [manifest.name]: `file:${tui}/package` },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', manifest.name], patchReload: 'startup' } } }));
    await writeFile(join(profile, 'cordis.patch.yml'), '[]\n');
    const shellPath = (await run('sh', ['-c', 'command -v sh'], env, home)).trim();
    assert.ok(shellPath.startsWith('/'), 'cannot locate an absolute POSIX shell');
    const shellQuote = s => `'${s.replaceAll("'", "'\\''")}'`;
    async function launcher(name) {
      const merged = join(launchers, 'bin', name);
      try { await access(merged); return merged; }
      catch { const split = join(launchers, name, 'bin', name); await access(split); return split; }
    }
    const dsh = launchers ? await launcher('dsh') : join(runtime, 'bin/dsh');
    const tuiCommand = launchers ? await launcher('dsh-tui') : join(bin, 'dsh-tui');
    await symlink(dsh, join(bin, 'dsh'));
    for (const [name, command] of (!launchers ? [['dsh-tui', `exec ${shellQuote(process.execPath)} --expose-internals ${shellQuote(join(tui, 'package/bin/dsh-tui.js'))} "$@"`]] : [])) {
      const path = join(bin, name);
      await writeFile(path, `#!${shellPath}\n${command}\n`); await chmod(path, 0o755);
    }
    // Refuse any accidental bootstrap/update installation, even while offline.
    for (const name of ['npm', 'npx', 'pnpm', 'yarn', 'bun', 'curl', 'wget']) {
      const path = join(bin, name);
      await writeFile(path, `#!${shellPath}\necho "smoke: package/network command forbidden" >&2\nexit 97\n`);
      await chmod(path, 0o755);
    }
    const expectedDsh = JSON.parse(await readFile(join(runtime, 'apps/cli/package.json'), 'utf8')).version;
    assert.match(await run(dsh, ['--version'], env, home), new RegExp(expectedDsh.replaceAll('.', '\\.')));
    assert.match(await run(dsh, ['--help'], env, home), /--profile/);
    assert.ok((await run(tuiCommand, ['--version'], env, home)).includes(manifest.version));
    assert.match(await run(tuiCommand, ['--help'], env, home), /dsh-tui/i);
    console.log('PASS versions/help + copied production TUI');
    // Absolute plugin fixture is actually mounted alongside official Web/TUI bundles.
    const marker = join(home, 'loaded');
    const plugin = join(home, 'probe.mjs');
    await writeFile(plugin, `import {writeFileSync} from 'node:fs';\nexport function apply(ctx) { ctx.loader.await().then(() => writeFileSync(${JSON.stringify(marker)}, 'settled')); }\n`);
    const patch = join(home, 'probe.yml');
    const overlay = JSON.stringify([{ insert: [{ id: 'offline-smoke-probe', name: pathToFileURL(plugin).href }] }]);
    await writeFile(patch, overlay);
    const port = await new Promise((res, rej) => {
      const server = net.createServer(); server.once('error', rej);
      server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => res(port)); });
    });
    const web = start(dsh, ['--profile', 'web', '--patch', patch, '--host', '127.0.0.1', '--port', String(port), '--no-open'], env, home);
    try {
      let html, cookie = ''; 
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        if (web.exitCode !== null || web.signalCode !== null) throw new Error(`Web exited early\n${web.output}`);
        try {
          const startupURL = web.output.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s\x1b]+/)?.[0];
          const r = await fetch(startupURL ?? `http://127.0.0.1:${port}/`, {
            redirect: 'manual', signal: AbortSignal.timeout(1500), headers: cookie ? { Cookie: cookie } : {} });
          const cookies = r.headers.getSetCookie();
          if (cookies.length) cookie = cookies.map(c => c.split(';')[0]).join('; ');
          if (r.status >= 300 && r.status < 400 && cookie) {
            const page = await fetch(`http://127.0.0.1:${port}/`, { headers: { Cookie: cookie }, signal: AbortSignal.timeout(1500) });
            if (page.ok) { html = await page.text(); break; }
          }
          if (r.ok) { html = await r.text(); break; }
        } catch {}
        await sleep(150);
      }
      assert.match(html ?? '', /<!doctype html|<html/i, `Web static HTML missing\n${web.output}`);
      const assets = [...html.matchAll(/(?:src|href)=["']([^"']+\.(?:js|css)(?:\?[^"']*)?)["']/g)].map(m => m[1]);
      assert.ok(assets.length, 'HTML references no JS/CSS assets');
      for (const asset of assets) {
        const url = new URL(asset, `http://127.0.0.1:${port}/`);
        assert.equal(url.origin, `http://127.0.0.1:${port}`, 'non-loopback static asset');
        const r = await fetch(url, { headers: { Cookie: cookie }, signal: AbortSignal.timeout(3000) });
        assert.equal(r.status, 200, `static asset ${url.pathname}`);
        assert.ok((await r.arrayBuffer()).byteLength > 0);
      }
      assert.equal(await readFile(marker, 'utf8'), 'settled');
      console.log('PASS Web HTTP HTML/assets + real plugin loader settled');
    } finally { await stop(web); }
    // Use only the runtime's shipped official mock server; never reimplement API.
    const require = createRequire(join(runtime, 'apps/cli/package.json'));
    const mock = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm-mock-server')).href);
    const server = await mock.startMockLlmServer({ sequence: ['reasoning_success'], apiKey: env.DEEPSEEK_API_KEY,
      reasoningText: 'Offline smoke reasoning.', successText: 'OFFLINE_SMOKE_OK' });
    try {
      const out = await run(dsh, ['--profile', 'headless', 'Answer offline smoke'],
        { ...env, DEEPSEEK_BASE_URL: server.baseURL }, home);
      assert.ok(out.includes('OFFLINE_SMOKE_OK'), out);
      assert.ok(server.requests.length > 0, 'official mock received no request');
      console.log('PASS official mock-backed headless request');
    } finally { await server.close(); }
    // PTY boot must exercise the copied bundle, not just the boot-free CLI help.
    await writeFile(join(profile, 'cordis.patch.yml'), overlay);
    await rm(marker, { force: true });
    const out = await run('python3', [join(dirname(self), 'tui-pty-smoke.py'), marker, tuiCommand], env, home, 75000);
    assert.match(out, /PASS PTY/);
    console.log(out.trim());
  }
} catch (e) {
  console.error(`FAIL ${e.stack ?? e}`);
  process.exitCode = 1;
} finally { clearTimeout(watchdog); await cleanup(); }
