/** Targeted real Electron smoke under an ACTUAL isolated Xvfb display.
 * Uses configured plugin fixtures, DevTools, and genuine WM_DELETE_WINDOW events.
 * No user's HOME/DSH_HOME, window, credentials or processes are touched.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { delay, desktopDir, runtimeDir, run, waitFor } from './lib.mjs'
import { createPluginFixtures } from './plugin-fixtures.mjs'

assert.equal(process.env.DSH_DESKTOP_TEST_XVFB, '1', 'invoke through xvfb-run -a, not the ambient desktop')
const require = createRequire(join(runtimeDir, 'apps/desktop/package.json'))
const WebSocket = require('ws')
const artifactsRoot = process.env.DSH_DESKTOP_ARTIFACTS
mkdirSync(artifactsRoot, { recursive: true })
const sandbox = mkdtempSync(join(artifactsRoot, 'gui-'))
const fixture = createPluginFixtures(sandbox)
const userData = join(sandbox, 'user-data')
const shots = join(sandbox, 'screenshots')
for (const dir of [userData, shots]) mkdirSync(dir, { recursive: true })
// A developer-tools-enabled local preference makes the preset picker visible.
// It is a fixture setting, never a production default or the real Desktop patch.
writeFileSync(join(fixture.profile, 'cordis.patch.yml'), `- id: ui-settings-account\n  config:\n    version: 1\n    step: done\n    usage: detailed\n    developerTools: true\n    purpose: null\n    process: standard\n    completion: api-key\n`)
const port = 39000 + (process.pid % 2000)
class Devtools {
  constructor(url) {
    this.socket = new WebSocket(url, { maxPayload: 256 * 1024 * 1024 })
    this.nextId = 1
    this.pending = new Map()
    this.socket.on('message', body => {
      const message = JSON.parse(String(body))
      const entry = this.pending.get(message.id)
      if (!entry) return
      this.pending.delete(message.id)
      clearTimeout(entry.timer)
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)))
      else entry.resolve(message.result)
    })
    this.socket.on('close', () => { for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('DevTools closed')) }; this.pending.clear() })
  }
  ready() { return new Promise((resolve, reject) => { this.socket.once('open', resolve); this.socket.once('error', reject) }) }
  send(method, params = {}, sessionId) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('DevTools timeout: ' + method)) }, 15_000)
      this.pending.set(id, { resolve, reject, timer })
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  }
  close() { this.socket.close() }
}
async function pageTarget(devtools, matcher) {
  const { targetInfos } = await devtools.send('Target.getTargets')
  const found = targetInfos.find(info => info.type === 'page' && matcher(info.url))
  if (!found) return undefined
  const { sessionId } = await devtools.send('Target.attachToTarget', { targetId: found.targetId, flatten: true })
  await devtools.send('Page.enable', {}, sessionId)
  await devtools.send('Runtime.enable', {}, sessionId)
  return { sessionId, targetId: found.targetId }
}
async function evaluate(devtools, sessionId, expression) {
  const result = await devtools.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
  return result.result.value
}
async function screenshot(devtools, sessionId, name) {
  const { data } = await devtools.send('Page.captureScreenshot', { format: 'png' }, sessionId)
  const path = join(shots, name)
  writeFileSync(path, Buffer.from(data, 'base64'))
  return path
}
const checks = []
const check = (name, body) => checks.push({ name, body })
const environment = { ...process.env,
  HOME: fixture.home, DSH_HOME: fixture.dshHome, DSH_DESKTOP_USER_DATA_DIR: userData,
  DSH_AUTH_CREDENTIALS: join(fixture.dshHome, 'dsh-auth/credentials.json'),
  XDG_CONFIG_HOME: join(fixture.home, '.config'), XDG_CACHE_HOME: join(fixture.home, '.cache'),
  XDG_DATA_HOME: join(fixture.home, '.local/share'), XDG_STATE_HOME: join(fixture.home, '.local/state'),
  XDG_RUNTIME_DIR: sandbox, WAYLAND_DISPLAY: '', ELECTRON_ENABLE_LOGGING: '1',
  DSH_WEB_FETCH_ALLOW_FAKE_IP: '0', DSH_DESKTOP_GUI_TEST: '1',
}
for (const key of Object.keys(environment)) if (/_API_KEY$|_ACCESS_TOKEN$|_AUTH_TOKEN$/.test(key)) delete environment[key]
const child = spawn(join(desktopDir, 'bin/dsh-desktop'), [
  '--ozone-platform=x11', `--remote-debugging-port=${port}`, '--remote-allow-origins=*',
], { env: environment, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
let output = ''
for (const stream of [child.stdout, child.stderr]) { stream.setEncoding('utf8'); stream.on('data', chunk => { output += chunk }) }
const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })))
let devtools, welcome, app
const artifacts = { sandbox, display: process.env.DISPLAY, shellPid: child.pid }
const visibleWindows = async () => (await run('xdotool', ['search', '--onlyvisible', '--pid', String(child.pid)])).stdout.trim().split('\n').filter(Boolean)
const closeWindow = async id => {
  const sent = await run('python3', [join(dirname(fileURLToPath(import.meta.url)), 'wm-close.py'), id])
  assert.equal(sent.code, 0, sent.stderr)
}
check('isolated launcher exposes DevTools', async () => {
  const version = await waitFor(async () => {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('launcher exited: ' + output)
    try { const response = await fetch(`http://127.0.0.1:${port}/json/version`); return response.ok ? response.json() : undefined } catch { return undefined }
  }, { timeout: 30_000, label: 'DevTools' })
  devtools = new Devtools(version.webSocketDebuggerUrl)
  await devtools.ready()
  assert.match(version['User-Agent'], /Electron/)
})
check('welcome window renders on the isolated display', async () => {
  welcome = await waitFor(() => pageTarget(devtools, url => url.includes('welcome.html')), { timeout: 30_000, label: 'welcome target' })
  const skip = await evaluate(devtools, welcome.sessionId, 'document.getElementById("skip-key")?.textContent')
  assert.ok(skip?.length > 0)
  artifacts.welcomeShot = await screenshot(devtools, welcome.sessionId, '01-welcome.png')
})
check('Set up later boots the actual sandboxed dsh application', async () => {
  await evaluate(devtools, welcome.sessionId, 'document.getElementById("skip-key").click()')
  app = await waitFor(() => pageTarget(devtools, url => url.startsWith('dsh-app://app')), { timeout: 45_000, label: 'dsh-app target' })
  const body = await waitFor(async () => {
    const text = await evaluate(devtools, app.sessionId, 'document.body?.innerText ?? ""')
    if (/already declared|Failed to boot|启动失败/.test(text)) throw new Error(text)
    return /DeepSeek|新任务|New task|设置|Settings|选择工作区|选择一个工作区|GUI Fixture/.test(text) ? text : undefined
  }, { timeout: 30_000, label: 'application content' })
  artifacts.body = body
  assert.ok(!/Failed to boot|启动失败/.test(body), body)
  const isolation = await evaluate(devtools, app.sessionId, '({hasRequire: typeof require !== "undefined", hasProcess: typeof process !== "undefined"})')
  assert.deepEqual(isolation, { hasRequire: false, hasProcess: false })
  artifacts.appShot = await screenshot(devtools, app.sessionId, '02-application.png')
})
check('inherited presets and arbitrary command are visible through the real client', async () => {
  // The actual hero preset picker is available before the first model request.
  const buttons = await evaluate(devtools, app.sessionId, `Array.from(document.querySelectorAll('button')).map(b => ({text:b.textContent, label:b.getAttribute('aria-label'), title:b.title}))`)
  artifacts.buttons = buttons
  const clicked = await evaluate(devtools, app.sessionId, `(() => { const b = Array.from(document.querySelectorAll('button')).find(b => /Agent.*预设|[Aa]gent.*[Pp]reset/.test([b.getAttribute('aria-label'),b.title].join(' '))); if (!b) return false; b.click(); return true })()`)
  assert.ok(clicked, 'no preset picker: ' + JSON.stringify(buttons))
  artifacts.presetText = await waitFor(async () => {
    const text = await evaluate(devtools, app.sessionId, 'document.body.innerText')
    return text.includes('Codex Mode') && text.includes('Generic Fixture') ? text : undefined
  }, { timeout: 15_000, label: 'inherited preset cards' })
  await devtools.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, app.sessionId)
  await devtools.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, app.sessionId)
  // Select the actual fixture workspace if the fresh client has not picked its only one.
  const needsWorkspace = await evaluate(devtools, app.sessionId, `!document.querySelector('[contenteditable="true"],textarea')`)
  if (needsWorkspace) {
    await evaluate(devtools, app.sessionId, `(() => { const b=Array.from(document.querySelectorAll('button')).find(b => /选择工作区|Select.*workspace/.test(b.textContent ?? '')); b?.click() })()`)
    await waitFor(async () => evaluate(devtools, app.sessionId, `(() => { const b=Array.from(document.querySelectorAll('button,[role="menuitem"]')).find(b => (b.textContent ?? '').includes('GUI Fixture')); if (!b) return false; b.click(); return true })()`), { timeout: 15_000, label: 'fixture workspace selection' })
  }
  await waitFor(async () => evaluate(devtools, app.sessionId, `Boolean(document.querySelector('[contenteditable="true"],textarea'))`), { timeout: 15_000, label: 'active workspace composer' })
  // Slash command discovery uses the real composer and command registry, not an IPC assertion.
  const editors = await evaluate(devtools, app.sessionId, `Array.from(document.querySelectorAll('textarea,[contenteditable="true"]')).map(e=>({tag:e.tagName,placeholder:e.getAttribute('placeholder')}))`)
  artifacts.editors = editors
  assert.ok(editors.length > 0, 'no composer for slash-command discovery')
  await evaluate(devtools, app.sessionId, `(() => { const e=document.querySelector('textarea,[contenteditable="true"]'); e.focus(); })()`)
  await devtools.send('Input.insertText', { text: '/fixture' }, app.sessionId)
  artifacts.commandText = await waitFor(async () => {
    const text = await evaluate(devtools, app.sessionId, 'document.body.innerText')
    return /fixture-desktop/.test(text) ? text : undefined
  }, { timeout: 15_000, label: 'inherited slash-command choice' })
  artifacts.inheritanceShot = await screenshot(devtools, app.sessionId, '03-inherited-plugins.png')

  // A test-only command logs a correlated Tool call and asks the REAL native approval
  // waterfall. No model/network or tool body executes. Native Chat must supply the
  // Tool detail through the native entry's bound renderSlot to the addon presenter.
  await devtools.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 }, app.sessionId)
  await devtools.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 }, app.sessionId)
  await devtools.send('Input.insertText', { text: '/fixture-approval' }, app.sessionId)
  await waitFor(async () => evaluate(devtools, app.sessionId, `(() => { const b=document.querySelector('button[aria-label="发送消息"],button[aria-label="Send message"]'); return b && !b.disabled })()`), { timeout: 15_000, label: 'fixture command send button' })
  await evaluate(devtools, app.sessionId, `document.querySelector('button[aria-label="发送消息"],button[aria-label="Send message"]').click()`)
  artifacts.approvalText = await waitFor(async () => evaluate(devtools, app.sessionId, `(() => { const panel=document.querySelector('.dba-root[data-approval-key]'); const detail=panel?.querySelector('.dba-body')?.innerText ?? ''; return panel?.querySelector('.dba-alwaysAllow') && detail.includes('DSH_TOOL_DETAIL_FIXTURE') ? detail : undefined })()`), { timeout: 15_000, label: 'enabled addon with native correlated Tool detail' })
  artifacts.approvalShot = await screenshot(devtools, app.sessionId, '04-approval-addon-native-tool-detail.png')
  await evaluate(devtools, app.sessionId, `document.querySelector('.dba-reject').click()`)
  artifacts.approvalResult = await waitFor(async () => {
    const text = await evaluate(devtools, app.sessionId, 'document.body.innerText')
    return text.includes('Fixture approval decision: rejected') ? text : undefined
  }, { timeout: 15_000, label: 'native rejected outcome' })
})
check('Cancel on close keeps the primary window visible', async () => {
  const initial = await visibleWindows()
  assert.ok(initial.length > 0)
  artifacts.primaryWindow = initial[0]
  await closeWindow(artifacts.primaryWindow)
  const dialog = await waitFor(async () => (await visibleWindows()).find(id => !initial.includes(id)), { timeout: 15_000, label: 'native quit confirmation' })
  artifacts.cancelDialog = dialog
  // Escape destroys the native dialog on key-down. Sending its key-up to that
  // destroyed X window is a harness BadWindow, not a failed Cancel action.
  const cancelled = await run('xdotool', ['keydown', '--window', dialog, 'Escape'])
  assert.equal(cancelled.code, 0, cancelled.stderr)
  await waitFor(async () => !(await visibleWindows()).includes(dialog), { timeout: 15_000, label: 'Cancel dismissed confirmation' })
  assert.equal(child.exitCode, null)
  assert.ok((await visibleWindows()).includes(artifacts.primaryWindow), 'Cancel stranded an invisible window')
})
check('confirmed window close exits the shell and its Host cleanly', async () => {
  const hosts = await run('pgrep', ['-P', String(child.pid), '-f', 'desktop-host'])
  artifacts.hostPids = hosts.stdout.trim().split('\n').filter(Boolean)
  assert.ok(artifacts.hostPids.length > 0)
  const initial = await visibleWindows()
  await closeWindow(artifacts.primaryWindow)
  const dialog = await waitFor(async () => (await visibleWindows()).find(id => !initial.includes(id)), { timeout: 15_000, label: 'quit confirmation' })
  artifacts.confirmDialog = dialog
  const approved = await run('xdotool', ['keydown', '--window', dialog, 'Return'])
  assert.equal(approved.code, 0, approved.stderr)
  const result = await Promise.race([exited, delay(30_000).then(() => 'timeout')])
  assert.notEqual(result, 'timeout', output)
  assert.deepEqual(result, { code: 0, signal: null })
  for (const pid of artifacts.hostPids) assert.notEqual((await run('kill', ['-0', pid])).code, 0, 'Host survived: ' + pid)
})
check('no fatal/preload/client startup failure was logged', () => {
  assert.deepEqual(output.split('\n').filter(line => /FATAL|SIGSEGV|SIGTRAP|Uncaught|Unable to load preload|Failed to boot/i.test(line)), [])
})
let passed = 0, failures = 0, executed = 0
try {
  for (const { name, body } of checks) {
    executed++
    try { await body(); passed++; console.log('ok - ' + name) }
    catch (error) { failures++; console.error('not ok - ' + name + '\n' + (error.stack ?? error)); break }
  }
} finally {
  if (devtools && app) {
    try { artifacts.finalDom = await evaluate(devtools, app.sessionId, 'document.documentElement.outerHTML') } catch {}
  }
  devtools?.close()
  if (child.exitCode === null && child.signalCode === null) {
    // Only this detached test group: never a name-based kill or the real desktop.
    try { process.kill(-child.pid, 'SIGTERM') } catch {}
    const result = await Promise.race([exited, delay(4_000).then(() => 'timeout')])
    if (result === 'timeout') { try { process.kill(-child.pid, 'SIGKILL') } catch {}; await exited }
  }
  writeFileSync(join(sandbox, 'electron-launcher.log'), output)
  writeFileSync(join(sandbox, 'electron-smoke-artifacts.json'), JSON.stringify(artifacts, null, 2))
  console.log('GUI artifacts: ' + sandbox)
}
console.log(`electron-smoke: ${passed}/${checks.length} passed; ${failures} failed; ${checks.length - executed} unexecuted`)
process.exit(failures === 0 && passed === checks.length ? 0 : 1)
