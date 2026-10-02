/** Focused native presenter seam + unchanged addon decision behavior. No browser/network required. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'

const runtime = process.env.DSH_DESKTOP_STORE
const require = createRequire(join(runtime, 'apps/cli/package.json'))
const { Context } = await import(require.resolve('@deepseek-ai/cordis'))
const addonSource = readFileSync(new URL('../profiles/web/node_modules/dsh-baizhu-approval/client.js', import.meta.url), 'utf8')
const nativeIndex = join(runtime, 'packages/client/ui-approval/src/client/index.ts')
console.log('native presenter source: ' + nativeIndex)
const nativeSource = readFileSync(nativeIndex, 'utf8')
const contractSource = readFileSync(join(runtime, 'packages/client/ui-approval/src/client/contract/slots.ts'), 'utf8')
const context = vm.createContext({ Promise, AbortController })
const element = (type, props, ...children) => ({ type, props: { ...props, children } })
function NativePanel() {}
async function synthetic(exports) {
  const module = new vm.SyntheticModule(Object.keys(exports), function () { for (const [key, value] of Object.entries(exports)) this.setExport(key, value) }, { context })
  await module.link(() => { throw new Error('unexpected import') })
  await module.evaluate()
  return module
}
const contract = new vm.SourceTextModule(stripTypeScriptTypes(contractSource, { mode: 'transform' }), { context })
await contract.link(() => { throw new Error('contract has a runtime import') })
await contract.evaluate()
const modules = {
  react: await synthetic({ createElement: element }),
  './ApprovalPanel.tsx': await synthetic({ ApprovalPanel: NativePanel }),
  './contract/slots.ts': contract,
  './locales.ts': await synthetic({ en: {}, zh: {} }),
}
const native = new vm.SourceTextModule(stripTypeScriptTypes(nativeSource, { mode: 'transform' }), { context })
await native.link(name => { if (!modules[name]) throw new Error('unexpected native import: ' + name); return modules[name] })
await native.evaluate()

function reactHarness() {
  let state = [], cursor = 0, pending = [], cleanups = []
  const listeners = new Map()
  const document = { createElement: () => ({}), head: { appendChild() {} },
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: (name, fn) => { if (listeners.get(name) === fn) listeners.delete(name) } }
  const React = {
    createElement: element,
    useState: initial => { const i = cursor++; if (!(i in state)) state[i] = initial; return [state[i], value => { state[i] = value }] },
    useRef: initial => { const i = cursor++; if (!(i in state)) state[i] = { current: initial }; return state[i] },
    useCallback: fn => fn,
    useEffect: fn => pending.push(fn), useLayoutEffect: fn => pending.push(fn),
  }
  return { React, document, listeners, render(component, props, fresh = false) {
    for (const cleanup of cleanups.splice(0)) cleanup?.()
    if (fresh) state = []
    cursor = 0; pending = []
    const tree = component(props)
    cleanups = pending.map(fn => fn())
    return tree
  } }
}
function addon(harness) {
  let bundle
  vm.runInNewContext(addonSource, { document: harness.document, window: { __ModuleLoader__: { load: value => { bundle = value } } } })
  assert.equal(bundle.id, 'dsh-baizhu-approval')
  return bundle.factory(name => name === 'react' ? harness.React : { Button: 'Button' })
}
async function nativeFixture() {
  const root = new Context()
  let registration, remoteListener, pending, removed = 0, registrations = 0
  root.provide('sessions', { scopeOf: owner => owner.sessionId })
  root.provide('remote', { $on: (name, fn) => { assert.equal(name, 'approval/request'); remoteListener = fn } })
  root.provide('uiSession', { registerPendingInteraction: () => value => { pending = value; return () => { removed++ } } })
  root.provide('slots', { inject: (_slot, setup) => setup(), register: (options, component) => { registrations++; registration = { options, component }; return () => {} } })
  const localize = key => ({ 'approval.reject': 'Reject', 'approval.allowOnce': 'Allow once', 'approval.alwaysAllow': 'Always allow' })[key] ?? key
  root.provide('locale', { register: () => () => {}, bind: () => localize, resolveText: value => value.en })
  const fiber = root.plugin({ inject: [...native.namespace.inject], apply: native.namespace.apply })
  await fiber.await()
  return { root, fiber, get registration() { return registration }, get pending() { return pending }, get registrations() { return registrations }, get removed() { return removed }, remote: (...args) => remoteListener.call(...args) }
}
function buttons(tree) {
  if (!tree || typeof tree !== 'object') return []
  return [ ...(tree.type === 'Button' ? [tree] : []), ...(tree.props?.children ?? []).flatMap(buttons) ]
}
const flush = async () => { await Promise.resolve(); await Promise.resolve() }

// Exact pinned-source/pre-repair comparisons prevent the infrastructure seam from
// rewriting the native waterfall or addon decision/keyboard code.
test('native waterfall and addon decision bodies are unchanged by the presenter repair', () => {
  const beforeAddon = readFileSync(process.env.DSH_APPROVAL_BEFORE, 'utf8')
  const body = source => source.slice(source.indexOf('      function ApprovalPanelOuter(props)'), source.indexOf('      /**', source.indexOf('      function ApprovalPanelOuter(props)')))
  assert.equal(body(addonSource), body(beforeAddon))
  const beforeNative = readFileSync(process.env.DSH_APPROVAL_NATIVE_BEFORE, 'utf8')
  const waterfall = source => source.slice(source.indexOf('async function answerApproval('), source.indexOf('/* jscpd:ignore-end */'))
  assert.equal(waterfall(nativeSource), waterfall(beforeNative))
  assert.equal(readFileSync(join(runtime, 'packages/client/ui-approval/src/client/contract/slots.ts'), 'utf8'), contractSource)
})

test('native composer owns selector/detail and falls back when no presenter is subscribed', async () => {
  const f = await nativeFixture()
  try {
    assert.equal(f.registrations, 1)
    assert.equal(f.registration.options.priority, 1)
    assert.equal(f.registration.options.children['conversation.approval.detail'].scope, 'session')
    assert.equal(f.registration.options.select({ pendingInteraction: { kind: 'approval' } }), null)
    const pending = new contract.namespace.PendingApproval('session-one', { toolName: 'bash' })
    assert.equal(f.registration.options.select({ pendingInteraction: pending }), pending)
    const props = { matched: pending, renderSlot() {}, resolveReason() {}, t() {} }
    const rendered = f.registration.component(props)
    assert.equal(rendered.type, NativePanel)
    assert.equal(rendered.props.matched, pending)
  } finally { await f.root.fiber.dispose() }
})
test('addon presenter receives native detail/locale props without registering slots; disposal restores fallback', async () => {
  const f = await nativeFixture(), harness = reactHarness()
  const plugin = f.root.plugin(addon(harness))
  await plugin.await()
  try {
    const pending = new contract.namespace.PendingApproval('session-one', { toolName: 'bash', callId: 'native-tool-call', reason: 'audit', displayReason: { en: 'Localized native reason' } })
    const calls = []
    const renderSlot = (slot, owner) => { calls.push({ slot, owner }); return 'NATIVE_TOOL_DETAIL' }
    const resolveReason = value => value.en
    const presented = f.registration.component({ matched: pending, renderSlot, resolveReason, t: () => 'native' })
    assert.notEqual(presented.type, NativePanel)
    assert.equal(presented.props.matched, pending)
    assert.equal(presented.props.renderSlot, renderSlot)
    assert.equal(presented.props.resolveReason, resolveReason)
    const flow = presented.type(presented.props)
    assert.equal(flow.props.reason, 'Localized native reason')
    const tree = harness.render(flow.type, flow.props, true)
    assert.equal(calls[0].slot, 'conversation.approval.detail')
    assert.equal(calls[0].owner.callId, 'native-tool-call')
    assert.equal(buttons(tree).length, 3)
    assert.equal(f.registrations, 1, 'addon must not register a composer or detail child')
    await plugin.dispose()
    assert.equal(f.registration.component({ matched: pending }).type, NativePanel)
  } finally { await f.root.fiber.dispose() }
})
test('real native approval waterfall remains owner-scoped, one-shot and cancelable', async () => {
  const f = await nativeFixture()
  try {
    let delegated = 0
    assert.equal(await f.remote({}, { toolName: 'bash' }, async () => { delegated++; return 'unavailable' }), 'unavailable')
    assert.equal(delegated, 1)
    const result = f.remote({ sessionId: 'session-one' }, { toolName: 'bash', callId: 'real-call' }, async () => 'unavailable')
    assert.equal(f.pending.sessionId, 'session-one')
    await f.pending.answer('rejected')
    assert.equal(await result, 'rejected')
    await assert.rejects(f.pending.answer('allowed-once'), /already settled/)
    const signal = new AbortController()
    const cancelled = f.remote({ sessionId: 'session-one' }, { toolName: 'bash', signal: signal.signal }, async () => 'unavailable')
    signal.abort(new Error('fixture cancellation'))
    await assert.rejects(cancelled, /fixture cancellation/)
    assert.equal(f.removed, 2)
  } finally { await f.root.fiber.dispose() }
})
test('Reject/once/keyboard decisions and always-allow remain fail-closed after failed answers', async () => {
  const harness = reactHarness()
  const plugin = addon(harness)
  let presenter
  plugin.apply({ effect: setup => setup(), on: (_event, handler) => { presenter = handler; return () => {} }, locale: { register: () => () => {}, bind: () => key => key } })
  const present = (wait, fresh = true) => {
    const outer = presenter({ matched: wait, renderSlot: () => 'detail' })
    const flow = outer.type(outer.props)
    return { flow, tree: harness.render(flow.type, flow.props, fresh) }
  }
  const decisions = []
  let fail = true
  const wait = { key: 'one', sessionId: 's', toolName: 'bash', answer: outcome => { decisions.push(outcome); return fail ? Promise.reject(new Error('rejected answer')) : Promise.resolve() } }
  let view = present(wait)
  buttons(view.tree).find(button => button.props.className === 'dba-alwaysAllow').props.onClick()
  await flush()
  const afterFailedAlways = []
  view = present({ ...wait, key: 'two', answer: outcome => { afterFailedAlways.push(outcome); return Promise.resolve() } })
  await flush()
  assert.equal(afterFailedAlways.length, 0, 'failed always-allow must not grant the next request')
  let prevented = 0
  harness.listeners.get('keydown')({ key: 'Escape', preventDefault: () => { prevented++ } })
  await flush()
  assert.equal(afterFailedAlways[0], 'rejected')
  assert.equal(prevented, 1)
  view = present({ ...wait, key: 'three', answer: outcome => { decisions.push(outcome); return Promise.resolve() } })
  harness.listeners.get('keydown')({ key: 'Enter', ctrlKey: true, shiftKey: false, preventDefault() {} })
  await flush()
  assert.equal(decisions.at(-1), 'allowed-once')
  fail = false
  view = present({ ...wait, key: 'four' })
  buttons(view.tree).find(button => button.props.className === 'dba-alwaysAllow').props.onClick()
  await flush()
  const automatic = []
  view = present({ ...wait, key: 'five', answer: outcome => { automatic.push(outcome); return Promise.reject(new Error('auto answer failed')) } })
  await flush()
  assert.equal(automatic[0], 'allowed-once')
  const recovered = harness.render(view.flow.type, view.flow.props)
  assert.equal(buttons(recovered).length, 3, 'failed auto-answer must restore visible approval controls')
})
