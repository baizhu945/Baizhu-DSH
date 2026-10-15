// Offline installed-package MCP smoke: native Node SQLite, no optional engine.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
const [root, processPath] = process.argv.slice(2);
assert(root && isAbsolute(root) && processPath && isAbsolute(processPath));
const require = createRequire(join(root, 'package.json'));
const load = name => import(pathToFileURL(require.resolve(name)).href);
const { Client } = await load('@modelcontextprotocol/client');
const { StdioClientTransport } = await load('@modelcontextprotocol/client/stdio');
const scratch = await mkdtemp(join(tmpdir(), 'dsh-rea-sqlite-'));
const path = join(scratch, 'offline.sqlite');
const db = new DatabaseSync(path, { limits: { length: 1048576, sqlLength: 1048576 } });
assert.equal(db.limits?.length, 1048576, 'REA SQLite requires Node 24.15+ DatabaseSync.limits');
assert.equal(db.limits?.sqlLength, 1048576);
db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);');
db.prepare('INSERT INTO settings VALUES (?, ?)').run('fixture', 'offline-only');
db.close();
const digest = async () => createHash('sha256').update(await readFile(path)).digest('hex');
const before = await digest();
const client = new Client({ name: 'dsh-rea-sqlite', version: '1' });
const transport = new StdioClientTransport({ command: process.execPath,
  args: [join(root, 'scripts/rea.mjs'), 'mcp'], cwd: scratch, stderr: 'pipe',
  env: { HOME: scratch, XDG_CONFIG_HOME: join(scratch, 'config'),
    XDG_CACHE_HOME: join(scratch, 'cache'), TMPDIR: scratch, PATH: processPath } });
try {
  await client.connect(transport);
  const result = await client.callTool({ name: 'inspect_sqlite_database',
    arguments: { path, table: 'settings', columns: ['value', 'key'], row_limit: 1 } });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  const report = result.structuredContent.normalized_result;
  assert.equal(report.artifact.sha256, before);
  assert.equal(report.schema.scope, 'selected_table');
  assert.equal(report.rows.returned_rows, 1);
  assert.deepEqual(report.rows.columns, ['value', 'key']);
  assert.deepEqual(report.rows.values[0].map(cell => cell.value), ['offline-only', 'fixture']);
  assert.equal(await digest(), before, 'source snapshot modified');
  assert(!(await readdir(scratch)).some(name => name === 'offline.sqlite-wal' || name === 'offline.sqlite-shm'), 'source sidecar created');
} finally { await client.close(); await transport.close(); }
console.log('PASS installed SQLite MCP: bounded selected-column sample, immutable input SHA-256, no targets/credentials/optional engines');
