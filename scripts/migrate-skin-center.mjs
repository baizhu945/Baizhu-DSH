#!/usr/bin/env node
/** Narrow, offline 0.2.2 -> 0.4.18 upgrade. Never edits profile configuration.
 * The old build has real host/client API breaks, not merely a stale inject.
 * The replacement is the pinned prebuilt dsh-skins npm package (see skin-center.nix).
 * Only an installed, unconfigured/explicitly-disabled old package is eligible.
 * Preserve old skins byte-for-byte, unknown assets, and a complete old-package
 * backup; never touch ambient dependencies or $DSH_HOME/skins/settings/state.
 * Each directory rename is atomic; the two-rename commit has rollback on errors.
 * Run with dsh stopped. A process crash mid-commit requires manual inspection,
 * never silent deletion of a backup/lock. No plugin apply/lifecycle scripts run.
 */
import { constants, lstatSync, openSync, closeSync, fstatSync, readFileSync,
  readdirSync, cpSync, mkdirSync, mkdtempSync, renameSync, rmdirSync, rmSync, chmodSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const PACKAGE = '@linxin666/dsh-client-ui-skin-center';
export const VERSION = '0.4.18';
export const OLD_INJECT = Object.freeze([
  '@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-locale', '@deepseek-ai/dsh-client-ui-theme',
]);
export const AUDITED_HASHES = Object.freeze({
  'lib/client.js': '52e09b08ea5c56f62afb0cef2f50ff926d8672ffa94b8f86d29b7c78dc2d6aba',
  'lib/index.js': '3d8de3c4adc176a229b40868b6e5478b70750d03fff3265cc99d30b0523cf964',
});
const NEW_HASHES = Object.freeze({
  'package.json': '6dacae2f3b14573509f0a8a77eb97dfdc21c1bd61c9bb1522a04e4209b4d5a8e',
  'lib/client.js': '8b510cbf7bfc5cafa13831bc1792060c2ebb4d19fc861976f5abd223c4ba2f7f',
  'lib/index.js': '23d4c9415c91a24727cf0f955b66c7be56624c0d7150c100d580f159dd035299',
});
function fail(code) {
  const error = new Error(`skin-center compatibility: ${code}`);
  error.code = code;
  throw error;
}
function checkedStat(path) {
  if (path === '/nix/store' || path.startsWith('/nix/store/')) fail('REFUSE_STORE');
  let current = parse(path).root;
  const parts = path.slice(current.length).split('/').filter(Boolean);
  let stat;
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]);
    try { stat = lstatSync(current); } catch (error) {
      if (error.code === 'ENOENT') return undefined;
      fail('UNREADABLE_PATH');
    }
    if (stat.isSymbolicLink()) fail('REFUSE_SYMLINK');
    if (i < parts.length - 1 && !stat.isDirectory()) fail('INVALID_PATH');
  }
  return stat;
}
function readRegular(path) {
  const stat = checkedStat(path);
  if (!stat?.isFile() || stat.nlink !== 1) fail('REFUSE_NONREGULAR_OR_HARDLINK');
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (opened.dev !== stat.dev || opened.ino !== stat.ino) fail('PATH_CHANGED');
    return readFileSync(fd);
  } finally { if (fd !== undefined) closeSync(fd); }
}
function json(bytes) { try { return JSON.parse(bytes.toString('utf8')); } catch { fail('INVALID_MANIFEST_JSON'); } }
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function verifyOld(root) {
  const bytes = readRegular(join(root, 'package.json'));
  const pkg = json(bytes);
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) fail('UNKNOWN_MANIFEST');
  if (pkg.name !== PACKAGE) fail('PACKAGE_NAME_MISMATCH');
  if (typeof pkg.version !== 'string') fail('UNKNOWN_VERSION');
  if (pkg.version !== '0.2.2') return { skip: true };
  if (!Array.isArray(pkg.dsh?.client?.inject)
      || JSON.stringify(pkg.dsh.client.inject) !== JSON.stringify(OLD_INJECT)) fail('UNKNOWN_INJECT_SHAPE');
  for (const [file, expected] of Object.entries(AUDITED_HASHES)) {
    if (hash(readRegular(join(root, file))) !== expected) fail('UNAUDITED_CODE');
  }
  return { bytes };
}
// Full inventory guards custom assets and races. Never follow user symlinks.
function inventory(root, prefix = '') {
  const result = [];
  for (const name of readdirSync(root).sort()) {
    const file = join(root, name), rel = join(prefix, name), stat = checkedStat(file);
    if (stat.isDirectory()) result.push([rel, 'dir', stat.mode], ...inventory(file, rel));
    else result.push([rel, hash(readRegular(file)), stat.mode]);
  }
  return result;
}
export async function configuredEntries(runtimeDir, profileDir) {
  if (!runtimeDir || !isAbsolute(runtimeDir)) fail('ABSOLUTE_RUNTIME_REQUIRED');
  // Use only dsh's parser/composition API, never eval disabled expressions or
  // print configs/errors containing values. This includes bundle and overlay rows.
  try {
    const anchor = join(runtimeDir, 'apps/cli/package.json');
    const require = createRequire(anchor);
    const boot = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href);
    const loaded = boot.loadProfileDirectory('skin-center audit', profileDir, anchor);
    const layers = loaded.layers.map(layer => layer.patches);
    const overlay = join(profileDir, 'cordis.patch.yml');
    if (checkedStat(overlay)) layers.push(boot.loadOverlayPatches('skin-center audit', overlay));
    return boot.composeEntries(layers).map(entry => ({ name: entry.name,
      disabled: typeof entry.disabled === 'boolean' ? entry.disabled : entry.disabled === undefined ? false : 'dynamic' }));
  } catch { fail('CONFIG_PARSE_FAILED'); }
}
function assertInactive(entries) {
  if (entries.some(row => row.name === PACKAGE && row.disabled !== true)) fail('REFUSE_ENABLED_OR_DYNAMIC_PLUGIN');
}
function verifyReplacement(source) {
  if (!source || !isAbsolute(source)) fail('PINNED_REPLACEMENT_REQUIRED');
  // Source may be a trusted Nix store derivation; destinations may NEVER be.
  for (const [file, expected] of Object.entries(NEW_HASHES)) {
    if (hash(readFileSync(join(source, file))) !== expected) fail('INVALID_REPLACEMENT');
  }
  const pkg = json(readFileSync(join(source, 'package.json')));
  if (pkg.name !== PACKAGE || pkg.version !== VERSION || pkg.dsh.engines.dsh !== '>=0.2.2-rc.2') fail('INVALID_REPLACEMENT');
  for (const name of ['@deepseek-ai/schemastery', 'lightningcss']) {
    if (!lstatSync(join(source, 'node_modules', name)).isSymbolicLink()) fail('PRIVATE_HOST_DEPENDENCIES_REQUIRED');
  }
}
function writableDirs(root) {
  chmodSync(root, 0o700);
  for (const name of readdirSync(root)) {
    const child = join(root, name);
    if (lstatSync(child).isDirectory()) writableDirs(child);
  }
}
export async function migrateSkinCenter(profileDir, { replacementDir, runtimeDir } = {}) {
  if (typeof profileDir !== 'string' || !isAbsolute(profileDir)) fail('ABSOLUTE_PROFILE_REQUIRED');
  if (profileDir.split('/').includes('..')) fail('REFUSE_PARENT_TRAVERSAL');
  profileDir = resolve(profileDir);
  const root = join(profileDir, 'node_modules', PACKAGE);
  // Outside node_modules: package inventory must not discover the old build
  // as a second installed plugin with the same manifest name.
  const backup = join(profileDir, '.skin-center-backups', `0.2.2-before-${VERSION}`);
  if (!checkedStat(root)) {
    if (checkedStat(backup)) fail('INCOMPLETE_UPGRADE_BACKUP_PRESENT');
    return { status: 'skipped', reason: 'not-installed' };
  }
  const original = verifyOld(root);
  if (original.skip) return { status: 'skipped', reason: 'different-version' };
  if (!replacementDir) fail('API_MIGRATION_REQUIRED: provide pinned 0.4.18 replacement; manifest unchanged');
  verifyReplacement(replacementDir);
  assertInactive(await configuredEntries(runtimeDir, profileDir));
  // Unknown private dependencies must not be discarded or replaced silently.
  if (checkedStat(join(root, 'node_modules'))) fail('REFUSE_EXISTING_PRIVATE_DEPENDENCIES');
  if (checkedStat(backup)) fail('BACKUP_ALREADY_EXISTS');
  const before = JSON.stringify(inventory(root));
  const lock = `${root}.upgrade-lock`;
  if (checkedStat(lock)) fail('UPGRADE_LOCK_PRESENT');
  mkdirSync(lock, { mode: 0o700 });
  let stage, moved = false;
  try {
    stage = mkdtempSync(join(dirname(root), '.skin-center-stage-'));
    cpSync(replacementDir, stage, { recursive: true, dereference: false });
    writableDirs(stage);
    // Keep every legacy skin, including same-id custom edits. The pinned new
    // blue-fantasy remains available in the Nix source, not forced over user data.
    if (checkedStat(join(root, 'skins'))) {
      rmSync(join(stage, 'skins'), { recursive: true, force: true });
      cpSync(join(root, 'skins'), join(stage, 'skins'), { recursive: true });
    }
    // Preserve unknown files (e.g. locally added CSS), not the old executable.
    function carry(dir, dest) {
      for (const name of readdirSync(dir)) {
        if (name === 'skins' && dir === root) continue;
        const from = join(dir, name), to = join(dest, name), stat = checkedStat(from);
        let exists = false; try { lstatSync(to); exists = true; } catch {}
        if (!exists) cpSync(from, to, { recursive: true });
        else if (stat.isDirectory() && lstatSync(to).isDirectory()) carry(from, to);
      }
    }
    carry(root, stage);
    assertInactive(await configuredEntries(runtimeDir, profileDir));
    verifyOld(root);
    if (JSON.stringify(inventory(root)) !== before) fail('PACKAGE_CHANGED_DURING_UPGRADE');
    checkedStat(dirname(backup));
    mkdirSync(dirname(backup), { recursive: true, mode: 0o700 });
    if (checkedStat(backup)) fail('BACKUP_ALREADY_EXISTS');
    renameSync(root, backup); moved = true;
    try { renameSync(stage, root); stage = undefined; }
    catch (error) { renameSync(backup, root); moved = false; throw error; }
    return { status: 'upgraded', reason: `0.2.2-to-${VERSION}; inactive; original backup retained` };
  } finally {
    if (stage) { writableDirs(stage); rmSync(stage, { recursive: true, force: true }); }
    // Keep a crashed/failed rollback diagnosable, never delete user backup.
    if (!moved || checkedStat(root)) rmdirSync(lock);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 5) fail('USAGE: migrate-skin-center.mjs /absolute/profile /pinned/package /dsh/runtime');
    const result = await migrateSkinCenter(process.argv[2], { replacementDir: process.argv[3], runtimeDir: process.argv[4] });
    console.log(`skin-center compatibility: ${result.status} (${result.reason})`);
  } catch (error) {
    console.error(error.message?.startsWith('skin-center compatibility:') ? error.message : 'skin-center compatibility: IO_FAILURE (no configuration logged)');
    process.exitCode = 1;
  }
}
