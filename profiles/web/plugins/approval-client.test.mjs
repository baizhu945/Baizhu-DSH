import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const source = readFileSync(new URL('../node_modules/dsh-baizhu-approval/client.js', import.meta.url), 'utf8')

test('Web approval client keeps the host composer and localized reason contract', () => {
  let bundle
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load: value => { bundle = value } } } })
  assert.equal(bundle.id, 'dsh-baizhu-approval')
  const fakeReact = { createElement: (type, props) => ({ type, props }) }
  const plugin = bundle.factory(name => name === 'react' ? fakeReact : { Button: () => {} })
  let registration
  const ctx = {
    effect() {},
    locale: { register() {}, resolveText: value => value.zh },
    slots: {
      inject: (_name, register) => register(),
      register: (options, component) => { registration = { options, component } },
    },
  }
  plugin.apply(ctx)
  assert.equal(registration.options.priority, 0.5)
  const reason = { en: 'Approval needed', zh: '需要审批' }
  assert.equal(registration.options.inject().resolveReason(reason), '需要审批')
  const panel = registration.component({
    matched: { key: '1', reason: 'audit text', displayReason: reason },
    resolveReason: value => value.zh,
    renderSlot() {},
    t() {},
  })
  assert.equal(panel.props.reason, '需要审批')
})
