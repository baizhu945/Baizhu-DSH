#!/usr/bin/env node
import { readFileSync, renameSync, writeFileSync } from 'node:fs'

const [target] = process.argv.slice(2)
if (!target) {
  console.error('usage: strip-codex-registrar.mjs <cordis.patch.yml>')
  process.exit(1)
}

const lines = readFileSync(target, 'utf8').split('\n')
const out = []

const topLevel = line => /^- /.test(line)
const insertEntry = line => /^    - /.test(line)

for (let index = 0; index < lines.length;) {
  const line = lines[index]

  if (/^- id: codex-registrar\s*$/.test(line)) {
    index += 1
    while (index < lines.length && !topLevel(lines[index])) index += 1
    continue
  }

  if (line.trim() === '- insert:') {
    const blockStart = index
    index += 1
    const entries = []
    while (index < lines.length && !topLevel(lines[index])) {
      if (insertEntry(lines[index])) {
        const entryLines = [lines[index]]
        index += 1
        while (index < lines.length && !topLevel(lines[index]) && !insertEntry(lines[index])) {
          entryLines.push(lines[index])
          index += 1
        }
        entries.push(entryLines)
      } else {
        index += 1
      }
    }
    const kept = entries.filter(entry => !/^    - id: codex-registrar\s*$/.test(entry[0]))
    if (kept.length > 0) {
      out.push(lines[blockStart])
      for (const entry of kept) out.push(...entry)
    }
    continue
  }

  out.push(line)
  index += 1
}

const text = out.join('\n')
const normalized = text.endsWith('\n') ? text : `${text}\n`
if (normalized !== `${readFileSync(target, 'utf8')}`) {
  writeFileSync(`${target}.tmp`, normalized, { mode: 0o644 })
  renameSync(`${target}.tmp`, target)
}
