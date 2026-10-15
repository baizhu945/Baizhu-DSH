import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { composeUserInstructions, mirrorUserInstructions, nativeWorkingDirectory, nativeWorkspaceRoot, assertNativeWorkingDirectory } from './codex-native.mjs'
import { installedDshRoot } from './codex-test-environment.mjs'

// Real-filesystem tests of the production instruction mirror: no native binary,
// no credentials, no model. Proves the user's DSH user-global AGENTS.md reaches
// the official core exactly as DSH itself would render it, and that nothing
// else leaks into the private home.

async function home(t, files = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-user-instructions-'))
  t.after(() => fs.rm(base, { recursive: true, force: true }))
  const roots = { dsh: path.join(base, 'dsh'), shared: path.join(base, 'shared'), codex: path.join(base, 'codex'),
    native: path.join(base, 'preset', 'native-home'), explicit: path.join(base, 'explicit') }
  for (const directory of Object.values(roots)) await fs.mkdir(directory, { recursive: true })
  for (const [name, entries] of Object.entries(files)) {
    for (const [filename, body] of Object.entries(entries)) {
      await fs.writeFile(path.join(roots[name], filename), body)
    }
  }
  const read = async file => { try { return await fs.readFile(file, 'utf8') } catch { return undefined } }
  const mirror = options => mirrorUserInstructions({ nativeHome: roots.native, dshHome: roots.dsh,
    agentsHome: roots.shared, codexHome: roots.codex, ...options })
  const agents = path.join(roots.native, 'AGENTS.md')
  const override = path.join(roots.native, 'AGENTS.override.md')
  return { base, roots, read, mirror, agents, override }
}

test('composeUserInstructions concatenates in DSH order and collapses trimmed duplicates', () => {
  assert.equal(composeUserInstructions([]), '')
  assert.equal(composeUserInstructions([{ text: '  ' }, { text: undefined }, { text: null }]), '')
  assert.equal(composeUserInstructions([{ text: ' a \n' }, { text: 'a' }, { text: 'b' }]), 'a\nb\n')
  assert.equal(composeUserInstructions([{ text: 'a' }, { text: 'x'.repeat(1_048_576) }]), undefined)
})

test('DSH user-global AGENTS.md is mirrored into the private native home', async t => {
  const h = await home(t, { dsh: { 'AGENTS.md': 'USER_GLOBAL_MARKER\n' } })
  await h.mirror()
  assert.equal(await h.read(h.agents), 'USER_GLOBAL_MARKER\n')
  assert.equal(await h.read(h.override), undefined)
})

test('project-only CLAUDE.md and .local candidates do not become user-global instructions', async t => {
  const h = await home(t, { dsh: { 'CLAUDE.md': 'SECOND\n', 'AGENTS.local.md': 'LOCAL\n', 'CLAUDE.local.md': 'LOCAL\n' } })
  await h.mirror()
  assert.equal(await h.read(h.agents), undefined)
})

test('harness AGENTS.md precedes shared agents AGENTS.md in DSH 0.2.1 order', async t => {
  const h = await home(t, { dsh: { 'AGENTS.md': 'BASE\n', 'AGENTS.local.md': 'IGNORED\n' },
    shared: { 'AGENTS.md': 'SHARED\n' } })
  await h.mirror()
  assert.equal(await h.read(h.agents), 'BASE\nSHARED\n')
})

test('shared AGENTS.md participates without a harness file and deduplicates trimmed content', async t => {
  const shared = await home(t, { shared: { 'AGENTS.md': 'SHARED_ONLY\n' }, codex: { 'AGENTS.md': 'CODEX_FALLBACK\n' } })
  await shared.mirror()
  assert.equal(await shared.read(shared.agents), 'SHARED_ONLY\n')
  const duplicate = await home(t, { dsh: { 'AGENTS.md': ' SAME\n' }, shared: { 'AGENTS.md': 'SAME\n' } })
  await duplicate.mirror()
  assert.equal(await duplicate.read(duplicate.agents), 'SAME\n')
})

test('native global instruction admission matches the actual DSH 0.2.1 group without copying workspace instructions', async t => {
  const h = await home(t, { dsh: { 'AGENTS.md': 'HARNESS_GLOBAL\n', 'CLAUDE.md': 'GLOBAL_CLAUDE_MUST_NOT_LOAD\n' },
    shared: { 'AGENTS.md': 'SHARED_GLOBAL\n' } })
  const workspace = path.join(h.base, 'workspace')
  await fs.mkdir(workspace)
  await fs.writeFile(path.join(workspace, 'AGENTS.md'), 'WORKSPACE_INSTRUCTION_OWNED_BY_NATIVE_DISCOVERY\n')
  const runtime = process.env.DSH_CODEX_TEST_DSH_ROOT ?? installedDshRoot()
  const require = createRequire(path.join(runtime, 'apps/cli/package.json'))
  const { loadBaselineInstructions } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-agent-instructions')).href)
  const rendered = await loadBaselineInstructions({ cwd: workspace, projectRoot: workspace,
    dshHome: h.roots.dsh, agentsHome: h.roots.shared, maxBytes: 65536 })
  assert.ok(rendered.text.indexOf('HARNESS_GLOBAL') < rendered.text.indexOf('SHARED_GLOBAL'))
  assert.equal(rendered.text.includes('GLOBAL_CLAUDE_MUST_NOT_LOAD'), false)
  assert.equal(rendered.text.split('WORKSPACE_INSTRUCTION_OWNED_BY_NATIVE_DISCOVERY').length - 1, 1)
  await h.mirror()
  assert.equal(await h.read(h.agents), 'HARNESS_GLOBAL\nSHARED_GLOBAL\n')
  assert.equal((await h.read(h.agents)).includes('WORKSPACE_INSTRUCTION_OWNED_BY_NATIVE_DISCOVERY'), false)
  await fs.writeFile(path.join(h.roots.shared, 'AGENTS.md'), ' HARNESS_GLOBAL\n')
  const duplicate = await loadBaselineInstructions({ cwd: workspace, projectRoot: workspace,
    dshHome: h.roots.dsh, agentsHome: h.roots.shared, maxBytes: 65536 })
  assert.equal(duplicate.text.split('HARNESS_GLOBAL').length - 1, 1)
  await h.mirror()
  assert.equal(await h.read(h.agents), 'HARNESS_GLOBAL\n')
})

test('removing the source removes the mirror instead of leaving a stale prompt', async t => {
  const h = await home(t, { dsh: { 'AGENTS.md': 'STALE_MARKER\n' } })
  await h.mirror()
  assert.equal(await h.read(h.agents), 'STALE_MARKER\n')
  await fs.unlink(path.join(h.roots.dsh, 'AGENTS.md'))
  await h.mirror()
  assert.equal(await h.read(h.agents), undefined)
})

test('Codex CLI global instructions are used only when DSH has none', async t => {
  const both = await home(t, { dsh: { 'AGENTS.md': 'DSH_WINS\n' }, codex: { 'AGENTS.md': 'CODEX_ONLY\n' } })
  await both.mirror()
  assert.equal(await both.read(both.agents), 'DSH_WINS\n')
  const codexOnly = await home(t, { codex: { 'AGENTS.override.md': 'CODEX_OVERRIDE\n' } })
  await codexOnly.mirror()
  assert.equal(await codexOnly.read(codexOnly.agents), 'CODEX_OVERRIDE\n')
})

test('an explicit Codex-style home is mirrored verbatim, including its override', async t => {
  const h = await home(t, { explicit: { 'AGENTS.md': 'BASE\n', 'AGENTS.override.md': 'OVERRIDE\n' },
    dsh: { 'AGENTS.md': 'DSH_IGNORED\n' } })
  await h.mirror({ explicit: h.roots.explicit })
  assert.equal(await h.read(h.override), 'OVERRIDE\n')
  assert.equal(await h.read(h.agents), 'BASE\n')
})

test('a symlinked instruction file is never mirrored out of the home directory', async t => {
  const h = await home(t)
  const outside = path.join(h.base, 'outside.md')
  await fs.writeFile(outside, 'ESCAPED\n')
  await fs.symlink(outside, path.join(h.roots.dsh, 'AGENTS.md'))
  await h.mirror()
  assert.equal(await h.read(h.agents), undefined)
})

test('Home Manager instruction symlinks into the immutable Nix store remain readable', async t => {
  const h = await home(t)
  const installed = path.join(process.env.DSH_CODEX_TEST_DSH_ROOT ?? installedDshRoot(), 'README.md')
  const target = await fs.realpath(installed)
  assert.match(target, /^\/nix\/store\/[0-9a-z]{32}-/)
  await fs.symlink(target, path.join(h.roots.dsh, 'AGENTS.md'))
  await h.mirror()
  assert.equal(await h.read(h.agents), composeUserInstructions([{ text: await fs.readFile(target, 'utf8') }]))
})

test('native cwd follows the current session service while retaining old-host fallback', () => {
  const agent = { session: { header: { cwd: '/original-project' } } }
  const service = { get: session => { assert.equal(session, agent.session); return '/changed-directory' } }
  assert.equal(nativeWorkingDirectory({ get: name => name === 'workingDirectory' ? service : undefined }, agent), '/changed-directory')
  assert.equal(nativeWorkingDirectory({ workingDirectory: service }, agent), '/changed-directory')
  assert.equal(nativeWorkingDirectory({}, agent), '/original-project')
  assert.equal(nativeWorkspaceRoot({ workingDirectory: service }, agent), '/original-project', 'Changing cwd does not widen writable roots')
  assert.equal(nativeWorkspaceRoot({ sandboxPolicy: { resolve: request => {
    assert.equal(request.session, agent.session)
    return { workspaceRoot: '/host-authorized-root' }
  } } }, agent), '/host-authorized-root')
})

test('Workspace Write navigation cannot inherit Codex implicit cwd write grants outside host roots', async t => {
  const h = await home(t)
  const workspace = path.join(h.base, 'workspace')
  const child = path.join(workspace, 'child')
  const outside = await fs.realpath(process.env.DSH_CODEX_TEST_DSH_ROOT ?? installedDshRoot())
  await fs.mkdir(child, { recursive: true })
  const agent = { session: { header: { cwd: workspace } } }
  let cwd = child
  const ctx = { workingDirectory: { get: () => cwd } }
  assert.equal(assertNativeWorkingDirectory(ctx, agent, { sandbox: 'workspace-write' }), child)
  cwd = outside
  assert.throws(() => assertNativeWorkingDirectory(ctx, agent, { sandbox: 'workspace-write' }), { code: 'CODEX_WORKING_DIRECTORY_OUTSIDE_WORKSPACE' })
  assert.equal(assertNativeWorkingDirectory(ctx, agent, { sandbox: 'read-only' }), outside)
  assert.equal(assertNativeWorkingDirectory(ctx, agent, { sandbox: 'danger-full-access' }), outside)
  cwd = path.join(workspace, 'escaped-link')
  await fs.symlink(outside, cwd)
  assert.throws(() => assertNativeWorkingDirectory(ctx, agent, { sandbox: 'workspace-write' }), { code: 'CODEX_WORKING_DIRECTORY_OUTSIDE_WORKSPACE' })
  for (const name of ['.git', '.agents', '.codex', '.aws']) {
    cwd = path.join(workspace, name, 'nested')
    await fs.mkdir(cwd, { recursive: true })
    assert.throws(() => assertNativeWorkingDirectory(ctx, agent, { sandbox: 'workspace-write' }), { code: 'CODEX_WORKING_DIRECTORY_OUTSIDE_WORKSPACE' })
  }
  const gitdir = path.join(h.base, 'worktree-gitdir')
  await fs.mkdir(gitdir)
  const worktree = path.join(h.base, 'worktree')
  await fs.mkdir(worktree)
  await fs.writeFile(path.join(worktree, '.git'), 'gitdir: ../worktree-gitdir\n')
  cwd = gitdir
  const worktreeAgent = { session: { header: { cwd: worktree } } }
  assert.throws(() => assertNativeWorkingDirectory(ctx, worktreeAgent, { sandbox: 'workspace-write' }), { code: 'CODEX_WORKING_DIRECTORY_OUTSIDE_WORKSPACE' })
  cwd = '/tmp'
  assert.equal(assertNativeWorkingDirectory(ctx, agent, { sandbox: 'workspace-write' }), '/tmp')
})

test('oversized user-global instructions mirror nothing rather than a truncated prompt', async t => {
  const warnings = []
  const h = await home(t, { dsh: { 'AGENTS.md': 'x'.repeat(1_048_577) } })
  await h.mirror({ logger: { warn: message => warnings.push(message) } })
  assert.equal(await h.read(h.agents), undefined)
  assert.equal(warnings.length, 1)
})

test('only instruction files are mirrored; other host home state never is', async t => {
  const h = await home(t, { dsh: { 'AGENTS.md': 'ONLY_THIS\n', 'config.toml': 'SECRET=1\n', 'auth.json': '{"t":"x"}' },
    codex: { 'AGENTS.md': 'X\n', 'config.toml': 'nope = true\n' } })
  await h.mirror()
  assert.equal(await h.read(h.agents), 'ONLY_THIS\n')
  const names = (await fs.readdir(h.roots.native)).sort()
  assert.deepEqual(names, ['AGENTS.md'])
})
