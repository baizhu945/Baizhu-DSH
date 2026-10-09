import assert from 'node:assert/strict'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { syncBuiltinESMExports } from 'node:module'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import cp from 'node:child_process'
assert(process.argv[2] && process.argv[3], 'usage: node import-guard.mjs <dshRuntimeRoot> <installedReaPresetRoot> [realReaExe]')
const root = resolve(process.argv[3])
const originals = []
const forbid = (object, names) => { for (const name of names) { const original = object[name]; if (typeof original !== 'function') continue; originals.push(() => { object[name] = original }); object[name] = function (...args) {
  // Node itself must resolve/read the module being tested. Its own ESM loader
  // operations are not plugin import-time package probes or application IO.
  const stack = new Error().stack ?? ''
  if (/at (?:finalizeResolution|defaultLoad|ModuleLoader\.load)|node:internal\/modules\/esm\/(?:resolve|load|get_format)/.test(stack)) return original.apply(this, args)
  throw new Error(`IMPORT-TIME IO FORBIDDEN: ${name}`)
} } }
forbid(fs, ['existsSync', 'readFileSync', 'readdirSync', 'statSync', 'lstatSync', 'realpathSync', 'accessSync', 'openSync', 'writeFileSync', 'mkdirSync'])
forbid(fsp, ['access', 'readFile', 'readdir', 'stat', 'lstat', 'realpath', 'open', 'writeFile', 'mkdir'])
forbid(cp, ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'])
syncBuiltinESMExports()
try {
  await import(pathToFileURL(join(root, 'runtime/rea-runtime.mjs')).href)
  console.log('PASS runtime import: no package probes, file IO or subprocesses')
  const source = process.env.DSH_REA_SOURCE_ROOT ?? '/home/baizhu945/.config/home-manager/agent/dsh'
  await import(pathToFileURL(join(source, 'presets/rea/rea-registrar.mjs')).href)
  console.log('PASS registrar import: no package probes, file IO or subprocesses')
} finally { for (const restore of originals.reverse()) restore(); syncBuiltinESMExports() }
