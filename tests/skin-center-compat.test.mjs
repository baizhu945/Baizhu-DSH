import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, lstatSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import { PACKAGE, OLD_INJECT, migrateSkinCenter, configuredEntries } from '../scripts/migrate-skin-center.mjs';

const script = new URL('../scripts/migrate-skin-center.mjs', import.meta.url);
const realPackage = process.env.SKIN_CENTER_PACKAGE;
const release = process.env.SKIN_CENTER_RELEASE;
const runtimeDir = process.env.DSH_RUNTIME_DIR;
const manifest = (extra = {}) => ({ name: PACKAGE, version: '0.2.2', dsh: { client: { inject: [...OLD_INJECT], platform: 'web' } }, ...extra });
function writableDirs(dir) {
  chmodSync(dir, 0o700);
  for (const name of readdirSync(dir)) {
    const child = join(dir, name);
    if (lstatSync(child).isDirectory()) writableDirs(child);
  }
}
async function fixture(fn, real = false) {
  const profile = mkdtempSync(join(tmpdir(), 'skin-center-compat-'));
  const root = join(profile, 'node_modules', PACKAGE);
  mkdirSync(root, { recursive: true });
  if (real) {
    cpSync(realPackage, root, { recursive: true });
    writableDirs(root);
  }
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'skin-center-test', private: true, dependencies: {} }));
  writeFileSync(join(profile, 'cordis.yml'), '[]\n');
  writeFileSync(join(profile, 'cordis.patch.yml'), '[]\n');
  const put = pkg => { if (existsSync(join(root, 'package.json'))) chmodSync(join(root, 'package.json'), 0o600); writeFileSync(join(root, 'package.json'), JSON.stringify(pkg)); };
  try { return await fn({ profile, root, put }); } finally {
    writableDirs(profile); rmSync(profile, { recursive: true, force: true });
  }
}
function tree(root, prefix = '') {
  const rows = [];
  for (const name of readdirSync(root).sort()) {
    const file = join(root, name), stat = lstatSync(file), rel = `${prefix}/${name}`;
    if (stat.isSymbolicLink()) rows.push([rel, 'symlink']);
    else if (stat.isDirectory()) rows.push([rel, stat.mode], ...tree(file, rel));
    else rows.push([rel, stat.mode, createHash('sha256').update(readFileSync(file)).digest('hex')]);
  }
  return rows;
}

test('absent package skips without creating anything; absolute path required', () => fixture(async ({ profile }) => {
  assert.deepEqual(await migrateSkinCenter(join(profile, 'absent')), { status: 'skipped', reason: 'not-installed' });
  await assert.rejects(migrateSkinCenter('relative'), /ABSOLUTE_PROFILE_REQUIRED/);
}));

test('newer version is byte-preserving and is not declared compatible', () => fixture(async ({ profile, put, root }) => {
  put(manifest({ version: '0.4.19', userMetadata: { preserve: true } }));
  const before = tree(root);
  assert.equal((await migrateSkinCenter(profile)).reason, 'different-version');
  assert.deepEqual(tree(root), before);
}));

test('wrong identity, malformed JSON and unknown inject all fail closed', () => fixture(async ({ profile, root, put }) => {
  for (const [pkg, code] of [
    [manifest({ name: 'other' }), /PACKAGE_NAME_MISMATCH/],
    [manifest({ version: null }), /UNKNOWN_VERSION/],
    [manifest({ dsh: { client: { inject: OLD_INJECT.slice(1) } } }), /UNKNOWN_INJECT_SHAPE/],
    [manifest({ dsh: { client: { inject: [...OLD_INJECT, 'extra'] } } }), /UNKNOWN_INJECT_SHAPE/],
  ]) {
    put(pkg); const before = tree(root);
    await assert.rejects(migrateSkinCenter(profile), code); assert.deepEqual(tree(root), before);
  }
  writeFileSync(join(root, 'package.json'), '{"secret":"not-to-log",');
  await assert.rejects(migrateSkinCenter(profile), /^Error: skin-center compatibility: INVALID_MANIFEST_JSON$/);
}));

test('version alone never authorizes replacement of unaudited code', () => fixture(async ({ profile, root, put }) => {
  put(manifest()); mkdirSync(join(root, 'lib')); writeFileSync(join(root, 'lib/client.js'), 'unknown code');
  const before = tree(root);
  await assert.rejects(migrateSkinCenter(profile), /UNAUDITED_CODE/); assert.deepEqual(tree(root), before);
}));

test('symlink boundaries, package and manifest symlinks are refused', async () => {
  await fixture(async ({ profile, root, put }) => {
    put(manifest()); const alias = join(profile, 'alias'); symlinkSync(profile, alias);
    await assert.rejects(migrateSkinCenter(alias), /REFUSE_SYMLINK/);
    const target = join(profile, 'target.json'); writeFileSync(target, JSON.stringify(manifest()));
    rmSync(join(root, 'package.json')); symlinkSync(target, join(root, 'package.json'));
    await assert.rejects(migrateSkinCenter(profile), /REFUSE_SYMLINK/);
    assert.equal(JSON.parse(readFileSync(target)).name, PACKAGE);
  });
  await fixture(async ({ profile, root }) => {
    rmSync(root, { recursive: true }); symlinkSync('/nix/store', root);
    await assert.rejects(migrateSkinCenter(profile), /REFUSE_SYMLINK/);
  });
});

test('store paths and parent traversal are always refused', async () => {
  await assert.rejects(migrateSkinCenter('/nix/store/nonexistent'), /REFUSE_STORE/);
  await assert.rejects(migrateSkinCenter('/nix/store/../tmp'), /REFUSE_PARENT_TRAVERSAL/);
});

test('old real package COPY: metadata-only repair remains forbidden', { skip: !realPackage }, () => fixture(async ({ profile, root }) => {
  const before = tree(root);
  await assert.rejects(migrateSkinCenter(profile), /API_MIGRATION_REQUIRED/);
  assert.deepEqual(tree(root), before);
  let registration;
  vm.runInNewContext(readFileSync(join(root, 'lib/client.js'), 'utf8'), {
    window: { __ModuleLoader__: { load: row => { registration = row; } } },
  });
  const imports = [];
  const client = registration.factory(id => { imports.push(id); return {}; });
  assert.deepEqual(imports, ['react', 'react/jsx-runtime']); assert.ok(client.inject.includes('settingsScope'));
}, true));

const upstream = process.env.DSH_RC2_SOURCE;
test('rc2 evidence: old settings APIs absent; loader edges are not service injection', { skip: !upstream }, () => {
  const settings = readFileSync(join(upstream, 'packages/settings/settings/src/index.ts'), 'utf8');
  assert.doesNotMatch(settings, /\b(?:installSettingsSection|settingsNamespace)\b/);
  const loader = readFileSync(join(upstream, 'packages/client/modules/src/client/system.ts'), 'utf8');
  assert.match(loader, /for \(const packageName of row\.inject\)/);
  assert.match(loader, /if \(dependency !== undefined\) await this\.arriveDependency/);
});

const upgradeOptions = { replacementDir: release, runtimeDir };
const noRelease = !realPackage || !release || !runtimeDir;
test('real upgrade: 0.4.18, old backup, all skins and unknown CSS preserved; config/ambient deps unchanged', { skip: noRelease }, () => fixture(async ({ profile, root }) => {
  writeFileSync(join(root, 'my-user.css'), 'body { color: red }');
  const oldTree = tree(root), oldSkins = tree(join(root, 'skins'));
  const profileBefore = readFileSync(join(profile, 'package.json'), 'utf8');
  const configBefore = readFileSync(join(profile, 'cordis.patch.yml'), 'utf8');
  const other = join(profile, 'node_modules', 'untouched'); mkdirSync(other); writeFileSync(join(other, 'asset'), 'leave me');
  const otherBefore = tree(other);
  assert.equal((await migrateSkinCenter(profile, upgradeOptions)).status, 'upgraded');
  assert.equal(JSON.parse(readFileSync(join(root, 'package.json'))).version, '0.4.18');
  assert.deepEqual(tree(join(profile, '.skin-center-backups', '0.2.2-before-0.4.18')), oldTree);
  assert.deepEqual(tree(join(root, 'skins')), oldSkins);
  assert.equal(readFileSync(join(root, 'my-user.css'), 'utf8'), 'body { color: red }');
  assert.deepEqual(tree(other), otherBefore);
  assert.equal(readFileSync(join(profile, 'package.json'), 'utf8'), profileBefore);
  assert.equal(readFileSync(join(profile, 'cordis.patch.yml'), 'utf8'), configBefore);
  assert.equal((await configuredEntries(runtimeDir, profile)).some(row => row.name === PACKAGE), false);
  const upgraded = tree(root);
  assert.equal((await migrateSkinCenter(profile, upgradeOptions)).reason, 'different-version');
  assert.deepEqual(tree(root), upgraded);
  // Export materialization checks no unavailable client service remains; no apply.
  let registration;
  vm.runInNewContext(readFileSync(join(root, 'lib/client.js'), 'utf8'), { window: { __ModuleLoader__: { load: row => { registration = row; } } } });
  const client = registration.factory(() => ({}));
  assert.ok(client.inject.includes('configForms'));
  assert.ok(!client.inject.includes('settingsScope'));
}, true));

test('enabled or dynamic entries refuse upgrade; explicitly disabled entry stays disabled', { skip: noRelease }, async () => {
  for (const disabled of [false, true, { __jsExpr: "(() => { throw new Error('never evaluate disabled expressions') })()" }]) await fixture(async ({ profile, root }) => {
    const config = JSON.stringify([{ insert: [{ id: 'ui-skin-center', name: PACKAGE, disabled }] }]);
    writeFileSync(join(profile, 'cordis.patch.yml'), config);
    const before = tree(root);
    if (disabled === true) assert.equal((await migrateSkinCenter(profile, upgradeOptions)).status, 'upgraded');
    else { await assert.rejects(migrateSkinCenter(profile, upgradeOptions), /REFUSE_ENABLED_OR_DYNAMIC_PLUGIN/); assert.deepEqual(tree(root), before); }
    assert.equal(readFileSync(join(profile, 'cordis.patch.yml'), 'utf8'), config);
  }, true);
});

test('existing backup/private dependencies/asset symlink cause no destructive overwrite', { skip: noRelease }, async () => {
  for (const problem of ['backup', 'private', 'symlink']) await fixture(async ({ profile, root }) => {
    if (problem === 'backup') mkdirSync(join(profile, '.skin-center-backups', '0.2.2-before-0.4.18'), { recursive: true });
    if (problem === 'private') mkdirSync(join(root, 'node_modules'));
    if (problem === 'symlink') symlinkSync('/nix/store', join(root, 'user-assets'));
    const before = tree(root);
    await assert.rejects(migrateSkinCenter(profile, upgradeOptions), /BACKUP_ALREADY_EXISTS|REFUSE_EXISTING_PRIVATE_DEPENDENCIES|REFUSE_SYMLINK/);
    assert.deepEqual(tree(root), before);
  }, true);
});

test('CLI does not print malformed config values or credentials', { skip: noRelease }, () => fixture(async ({ profile, root }) => {
  writeFileSync(join(profile, 'cordis.patch.yml'), '[ secret-token-do-not-log: [');
  const before = tree(root);
  const result = spawnSync(process.execPath, [script.pathname, profile, release, runtimeDir], { encoding: 'utf8' });
  assert.equal(result.status, 1); assert.doesNotMatch(result.stderr + result.stdout, /secret-token-do-not-log/);
  assert.match(result.stderr, /CONFIG_PARSE_FAILED/); assert.deepEqual(tree(root), before);
}, true));
