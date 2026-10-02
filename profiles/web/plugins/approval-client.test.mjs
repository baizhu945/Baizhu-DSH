import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const source = readFileSync(new URL('../node_modules/dsh-baizhu-approval/client.js', import.meta.url), 'utf8')

test('Web approval presenter keeps native owned detail and localized reason without a second composer', () => {
  let bundle
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load: value => { bundle = value } } } })
  assert.equal(bundle.id, 'dsh-baizhu-approval')
  const fakeReact = { createElement: (type, props) => ({ type, props }) }
  const plugin = bundle.factory(name => name === 'react' ? fakeReact : { Button: () => {} })
  let presenter
  const disposers = []
  const ctx = {
    effect(setup) { disposers.push(setup()) },
    on(event, handler) {
      assert.equal(event, 'ui-approval/render')
      presenter = handler
      return () => { presenter = undefined }
    },
    locale: { register: () => () => {}, bind: () => key => key },
    // No slots API is supplied: presentation must not register/rename/bypass a slot.
  }
  plugin.apply(ctx)
  const reason = { en: 'Approval needed', zh: '需要审批' }
  const renderSlot = () => 'native tool detail'
  const resolveReason = value => value.zh
  const matched = { key: '1', reason: 'audit text', displayReason: reason }
  const element = presenter({ matched, resolveReason, renderSlot, t: () => 'native' })
  assert.equal(element.props.renderSlot, renderSlot)
  assert.equal(element.props.resolveReason, resolveReason)
  assert.equal(element.props.matched, matched)
  const panel = element.type(element.props)
  assert.equal(panel.props.reason, '需要审批')
  assert.equal(panel.props.renderSlot, renderSlot)
  for (const dispose of disposers.reverse()) dispose?.()
  assert.equal(presenter, undefined)
})
