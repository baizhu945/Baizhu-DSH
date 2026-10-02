/**
 * Office skills must actually work through the Nix payload: the exact interpreter the
 * Host hands to a skill has to import every bundled library, round-trip a real
 * DOCX/PPTX/XLSX, pass the official structural checker, and — because upstream ships no
 * Linux LibreOfficeKit native package — convert through its own WASM fallback engine.
 * No system LibreOffice and no pip install are involved.
 */

import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { runtimeDir, primaryRuntime, payloadDir, run, temporaryDirectory, cleanup } from './lib.mjs'

const checks = []
function check(name, body) {
  checks.push({ name, body })
}

const work = temporaryDirectory('office')
const python = join(primaryRuntime, 'dependencies/python/bin/python3')
const checkOffice = join(payloadDir, 'office-skills/scripts/check_office.py')

check('bundled libraries import through the payload interpreter', async () => {
  const script = [
    'import docx, lxml.etree, numpy, openpyxl, pandas, PIL, pptx, xlsxwriter',
    'print("numpy", numpy.__version__)',
    'print("pandas", pandas.__version__)',
    'print("pillow", PIL.__version__)',
    'print("lxml", lxml.etree.LXML_VERSION)',
  ].join('\n')
  const result = await run(python, ['-c', script])
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /numpy \d/)
})

check('DOCX / PPTX / XLSX round-trip and pass the official checker', async () => {
  const script = join(work, 'roundtrip.py')
  writeFileSync(script, `
from docx import Document
from pptx import Presentation
from openpyxl import Workbook, load_workbook
import pandas as pd
from pathlib import Path

work = Path(${JSON.stringify(work)})

document = Document()
document.add_heading("DSH Desktop Nix", level=1)
document.add_paragraph("office payload round-trip")
document.save(work / "report.docx")

deck = Presentation()
slide = deck.slides.add_slide(deck.slide_layouts[1])
slide.shapes.title.text = "DSH Desktop Nix"
slide.placeholders[1].text = "office payload round-trip"
deck.save(work / "report.pptx")

book = Workbook()
sheet = book.active
sheet.title = "Summary"
sheet.append(["item", "value"])
sheet.append(["rows", 3])
book.save(work / "report.xlsx")

# Re-open each artifact through an independent reader, not the writer.
assert "office payload round-trip" in Document(work / "report.docx").paragraphs[1].text
assert Presentation(work / "report.pptx").slides[0].shapes.title.text == "DSH Desktop Nix"
reopened = load_workbook(work / "report.xlsx", data_only=False)
assert reopened["Summary"]["A2"].value == "rows"
assert reopened["Summary"]["B2"].value == 3
frame = pd.read_excel(work / "report.xlsx")
assert list(frame.columns) == ["item", "value"]
print("ROUNDTRIP OK")
`)
  const result = await run(python, [script])
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /ROUNDTRIP OK/)

  const docx = await run(python, [checkOffice, join(work, 'report.docx'), '--contains', 'office payload round-trip'])
  assert.equal(docx.code, 0, `check_office DOCX failed: ${docx.stderr}${docx.stdout}`)
  const docxReport = JSON.parse(docx.stdout)
  assert.equal(docxReport.format, 'docx')
  assert.equal(docxReport.verdict, 'pass')
  assert.equal(docxReport.summary.paragraphs, 2)

  const pptx = await run(python, [checkOffice, join(work, 'report.pptx'), '--count', '1', '--contains', 'DSH Desktop Nix'])
  assert.equal(pptx.code, 0, `check_office PPTX failed: ${pptx.stderr}${pptx.stdout}`)
  const pptxReport = JSON.parse(pptx.stdout)
  assert.equal(pptxReport.summary.slides, 1)

  const xlsx = await run(python, [checkOffice, join(work, 'report.xlsx'), '--count', '1', '--contains', 'rows'])
  assert.equal(xlsx.code, 0, `check_office XLSX failed: ${xlsx.stderr}${xlsx.stdout}`)
  const xlsxReport = JSON.parse(xlsx.stdout)
  assert.deepEqual(xlsxReport.summary.sheets.map(sheet => sheet.name), ['Summary'])
})

check('LibreOffice Kit falls back to its WASM engine on Linux and renders DOCX to PDF', async () => {
  const require = createRequire(join(runtimeDir, 'apps/desktop/package.json'))
  const kit = require('@deepseek-ai/libreoffice-kit')
  // Upstream publishes native engines for darwin/win32 only; Linux must take the WASM
  // fallback rather than silently reaching for a system LibreOffice.
  const engine = await kit.discoverRuntime()
  assert.equal(engine.backend, 'wasm', `expected the WASM fallback engine, got ${engine.backend}`)

  const output = join(work, 'report.pdf')
  // The font-metadata cache is disabled so an isolated smoke writes nothing under the
  // invoking user's cache directory.
  const converter = await kit.createConverter({
    fontMetadataCacheDirectory: false,
    timeoutMs: 300_000,
  })
  try {
    await converter.render({ inputPath: join(work, 'report.docx'), outputPath: output })
  } finally {
    await converter.dispose?.()
  }
  const pdf = readFileSync(output)
  assert.ok(pdf.length > 1024, 'rendered PDF is implausibly small')
  assert.equal(pdf.subarray(0, 5).toString('latin1'), '%PDF-', 'rendered file is not a PDF')
})

let failures = 0
for (const { name, body } of checks) {
  try {
    await body()
    console.log(`ok - ${name}`)
  } catch (error) {
    failures += 1
    console.error(`not ok - ${name}\n  ${error?.stack ?? error}`)
  }
}
cleanup()
console.log(`office: ${checks.length - failures}/${checks.length} passed`)
process.exit(failures === 0 ? 0 : 1)