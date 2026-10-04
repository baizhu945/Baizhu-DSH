import assert from 'node:assert/strict'
import test from 'node:test'
import { exactOneActionCandidate } from './live-native-host.mjs'

// Upstream resolves an immutable shell itself (zsh on this host) and renders the
// approval command from the automatically offered exec-policy amendment argv.
const script = "printf 'LIVE_APPROVED_ONCE\\n' > approval-once.txt"
const shell = '/nix/store/' + 'a'.repeat(32) + '-zsh-5.9-pub/bin/zsh'
const context = { workspace: '/synthetic/workspace', phase: 'approval', approvals: 0 }
const request = { kind: 'command', command: `${shell} -c ${JSON.stringify(script)}`,
  cwd: context.workspace, proposedExecpolicyAmendment: [shell, '-c', script],
  availableDecisions: ['accept', 'decline', { applyExecpolicyAmendment: [shell, '-c', script] }] }

test('exact live one-shot gate permits the offered exact argv, never amendment acceptance', () => {
  assert.equal(exactOneActionCandidate(request, context), true)
  // Without the offered argv there is nothing to verify the rendered command
  // against, so the gate fails closed rather than trusting `params.command`.
  assert.equal(exactOneActionCandidate({ ...request, proposedExecpolicyAmendment: null }, context), false)
  for (const changed of [
    { command: script }, { command: request.command + '; touch OTHER' },
    { proposedExecpolicyAmendment: [shell, '-c', script + '; touch OTHER'] },
    { proposedExecpolicyAmendment: [shell, '-lc', script] },
    { proposedExecpolicyAmendment: ['/bin/sh', '-c', script] },
    { proposedExecpolicyAmendment: ['/tmp/evil', '-c', script] },
    { proposedExecpolicyAmendment: ['/usr/bin/env', 'bash', '-c', script] },
    { kind: 'writeStdin' }, { cwd: '/other' },
    { networkApprovalContext: { host: 'example.invalid' } },
    { additionalPermissions: { network: { enabled: true } } },
    { proposedNetworkPolicyAmendments: [{ action: 'allow', host: 'example.invalid' }] },
    { unknownProposal: [] }, { availableDecisions: ['acceptForSession', 'decline'] },
    { availableDecisions: undefined },
  ]) assert.equal(exactOneActionCandidate({ ...request, ...changed }, context), false,
    `must refuse ${JSON.stringify(changed).slice(0, 90)}`)
  assert.equal(exactOneActionCandidate(request, { ...context, phase: 'denial' }), false)
  assert.equal(exactOneActionCandidate(request, { ...context, approvals: 1 }), false)
  // A command rendered from a DIFFERENT argv than the offered proposal is a
  // substitution attempt and must never be approved.
  assert.equal(exactOneActionCandidate({ ...request,
    command: `${'/nix/store/' + 'b'.repeat(32) + '-bash-5.3p15/bin/bash'} -c ${JSON.stringify(script)}` },
  context), false)
})