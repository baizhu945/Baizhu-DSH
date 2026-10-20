// Usage: node schema-portability.mjs <absolute runtimeRoot> <absolute rg>
// Live official MCP stdio catalog: no tool execution, credentials or providers.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { expectedToolNames } from './catalog.mjs';
const [root, rg] = process.argv.slice(2);
assert(root && isAbsolute(root) && rg && isAbsolute(rg));
const deadline = setTimeout(() => { console.error('Schema gate timed out'); process.exit(1); }, 120000);
deadline.unref();
const require = createRequire(join(root, 'package.json'));
const load = name => import(pathToFileURL(require.resolve(name)).href);
const compiled = name => import(pathToFileURL(join(root, 'dist', name)).href);
const { default: Ajv } = await load('ajv/dist/2020.js');
const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
const { TOOL_CONTRACTS } = await compiled('contracts/toolContracts.js');
const { TOOL_EFFECTS } = await compiled('contracts/toolEffects.js');
assert.equal(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version, '6.7.0');
assert.equal(expectedToolNames.length, 210);
assert.deepEqual(TOOL_CONTRACTS.map(t => t.name), expectedToolNames);
assert.deepEqual(Object.keys(TOOL_EFFECTS).sort(), [...expectedToolNames].sort());
const { Client } = await load('@modelcontextprotocol/client');
const { StdioClientTransport } = await load('@modelcontextprotocol/client/stdio');
const scratch = await mkdtemp(join(tmpdir(), 'dsh-rea-schema-'));
const client = new Client({ name: 'dsh-rea-schema', version: '1' });
const transport = new StdioClientTransport({
  command: process.execPath, args: [join(root, 'scripts/rea.mjs'), '--mcp'],
  cwd: scratch, stderr: 'pipe',
  env: { HOME: scratch, XDG_CONFIG_HOME: join(scratch, 'config'),
    XDG_CACHE_HOME: join(scratch, 'cache'), TMPDIR: scratch, PATH: '/nonexistent',
    REA_MCP_INPUT_SCHEMA_PROFILE: 'full' },
});
let stderr = '', tools;
transport.stderr?.on('data', chunk => { stderr += chunk; });
try {
  await client.connect(transport);
  tools = (await client.listTools()).tools;
  assert.deepEqual(tools.map(t => t.name).sort(), [...expectedToolNames].sort());
} finally { await client.close(); await transport.close(); }
assert.equal(stderr, '', 'Unexpected MCP stderr');
const tool = name => { const t = tools.find(t => t.name === name); assert(t, name); return t; };
const contract = name => TOOL_CONTRACTS.find(t => t.name === name);
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const maps = new Set(['properties', '$defs', 'definitions', 'patternProperties', 'dependentSchemas']);
const arrays = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
const singles = new Set(['not', 'if', 'then', 'else', 'propertyNames', 'additionalProperties',
  'unevaluatedProperties', 'items', 'additionalItems', 'contains', 'unevaluatedItems', 'contentSchema']);
const patterns = new Map(); let occurrences = 0;
function record(pattern, path) {
  assert.equal(typeof pattern, 'string', path); occurrences++;
  patterns.set(pattern, [...(patterns.get(pattern) ?? []), path]);
}
function visit(schema, path) {
  if (!object(schema)) return;
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'pattern') record(value, `${path}/pattern`);
    if (maps.has(key) && object(value)) {
      for (const [name, child] of Object.entries(value)) {
        if (key === 'patternProperties') record(name, `${path}/${key}/${name}`);
        visit(child, `${path}/${key}/${name}`);
      }
    } else if (arrays.has(key) || (singles.has(key) && Array.isArray(value))) {
      if (Array.isArray(value)) value.forEach((child, i) => visit(child, `${path}/${key}/${i}`));
    } else if (singles.has(key)) visit(value, `${path}/${key}`);
  }
}
for (const t of tools) { visit(t.inputSchema, `${t.name}/input`); visit(t.outputSchema, `${t.name}/output`); }
assert(occurrences > 0, 'empty pattern audit');
for (const [pattern, paths] of patterns) {
  new RegExp(pattern, 'u');
  const result = spawnSync(rg, ['--no-config', '--engine=default', '-q', '-e', pattern, '/dev/null'], {
    encoding: 'utf8', timeout: 10000, env: { PATH: '/nonexistent' },
  });
  assert.equal(result.error, undefined);
  assert(result.status === 0 || result.status === 1,
    `Rust rejected ${JSON.stringify(pattern)} at ${paths.join(', ')}: ${result.stderr}`);
}
// Resolve local shared definitions only at the inspected schema position.
function deref(schema, rootSchema) {
  if (!schema?.$ref) return schema;
  assert(schema.$ref.startsWith('#/'), 'unexpected external reference');
  const resolved = schema.$ref.slice(2).split('/').reduce((v, k) => v[k.replaceAll('~1', '/').replaceAll('~0', '~')], rootSchema);
  const { $ref: _, ...siblings } = schema;
  const base = deref(resolved, rootSchema);
  return { ...base, ...siblings,
    ...(Array.isArray(base.allOf) && Array.isArray(siblings.allOf)
      ? { allOf: [...base.allOf, ...siblings.allOf] } : {}) };
}
const native = tool('observe_native_calls').inputSchema;
const breakpoints = deref(deref(native.properties.breakpoints, native).items, native);
const variants = breakpoints.oneOf ?? breakpoints.anyOf;
const objc = variants.map(v => deref(v, native)).find(v => v.properties?.kind?.const === 'objc-method').properties;
const rootSchema = tool('trace_dylib_resolution').inputSchema;
const roots = deref(deref(rootSchema.properties.roots, rootSchema).items, rootSchema);
for (const key of ['selector', 'class_name']) {
  const schema = deref(objc[key], native);
  assert(JSON.stringify(schema).includes('x5b'), 'upstream ObjC fix missing');
}
function compare(name, schema, makeInput, values) {
  const rootSchema = tool(name).inputSchema;
  const validate = ajv.compile({ ...(rootSchema.$defs ? { $defs: rootSchema.$defs } : {}), ...schema });
  for (const value of values) assert.equal(validate(value), contract(name).inputSchema.safeParse(makeInput(value)).success,
    `${name}: ${JSON.stringify(value)}; ${JSON.stringify(validate.errors)}`);
}
const values = ['', 'name', 'setObject:forKey:', '[name]', 'name[', 'name]', 'a b', 'a\t', 'a\n', '\0', 'a\0b',
  'a\r', 'a\r\n', 'a\u2028', 'a\u2029', 'a\uFEFF', 'a\u0085', 'a\u00A0', 'a\u2003', '名字', '😀'];
for (const key of ['selector', 'class_name']) compare('observe_native_calls', objc[key],
  value => ({ breakpoints: [{ kind: 'objc-method', selector: 'length', [key]: value }] }), values);
compare('observe_native_calls', deref(native.properties.arguments, native).items,
  value => ({ breakpoints: [{ kind: 'function', name: 'open' }], arguments: [value] }), values);
const environmentValues = [{}, { OK: '' }, { '': 'v' }, { 'A=B': 'v' }, { 'A\0B': 'v' }, { A: 'v\0' },
  { REA_PROCESS_RUN_ID: 'v' }, { 'REA_PROCESS_RUN_ID\n': 'v' }, { 'REA_PROCESS_RUN_ID\uFEFF': 'v' }];
compare('observe_native_calls', native.properties.environment,
  value => ({ breakpoints: [{ kind: 'function', name: 'open' }], environment: value }), environmentValues);
compare('capture_process_scenario', tool('capture_process_scenario').inputSchema.properties.environment,
  value => ({ executable: 'echo', environment: value }), environmentValues);
const rootValues = ['', '.', '..', 'a', 'a/b', '/a', 'a/', 'a//b', 'a/./b', 'a/../b', 'a\\b', 'a\0b',
  'a/\n', 'a\n/', 'a\n//b', 'a\n/../b', 'a\n/./b', 'a\n/b/', '.\n', '..\r\n', 'a\u2028//b', 'a\u2029/', 'a\u0085//b'];
compare('trace_dylib_resolution', roots, value => ({ roots: [value] }), rootValues);
// Upstream now enforces segment normalization across newlines. The archived
// patch intentionally preserved the old dot/lookahead newline loopholes.
for (const value of ['a\n//b', 'a\n/../b', 'a\n/./b', 'a\n/b/']) {
  assert.equal(contract('trace_dylib_resolution').inputSchema.safeParse({ roots: [value] }).success, false);
}
let strings = [''];
for (let length = 0; length < 4; length++) {
  strings = strings.flatMap(prefix => ['a', '.', '/', '\\', '\0', '\n', '\r', '\u2028', '\u2029', '\uFEFF', '\u0085'].map(c => prefix + c));
  compare('trace_dylib_resolution', roots, value => ({ roots: [value] }), strings);
}
const { toolInputSchemaWithMetadata, toolOutputSchemaWithMetadata } = await compiled('contracts/toolSchemaMetadata.js');
for (const name of ['observe_native_calls', 'capture_process_scenario', 'trace_dylib_resolution']) {
  const canonical = contract(name);
  for (const [io, wrap] of [['input', toolInputSchemaWithMetadata], ['output', toolOutputSchemaWithMetadata]]) {
    const advertised = wrap(canonical), options = { target: 'draft-2020-12' };
    const first = advertised['~standard'].jsonSchema[io](options);
    assert.strictEqual(first, advertised['~standard'].jsonSchema[io](options));
    for (const { input } of canonical.examples) if (io === 'input')
      assert.deepEqual(advertised.safeParse(input), canonical.inputSchema.safeParse(input));
  }
}
clearTimeout(deadline);
console.log(`Schema portability PASS: ${expectedToolNames.length} tools, ${occurrences} patterns, ${patterns.size} unique JS + Rust patterns; live canonical/AJV Unicode/newline fixtures passed.`);
