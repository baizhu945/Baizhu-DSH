/** Shared locations and helpers for the DSH Desktop Nix regression tests. */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Immutable runtime tree built by agent/dsh/desktop.nix. */
export const runtimeDir = process.env.DSH_DESKTOP_STORE

/** The packaged Electron launcher output. */
export const desktopDir = process.env.DSH_DESKTOP_BIN

/** Primary runtime payload output: holds primary-runtime/ and office-skills/. */
export const payloadDir = process.env.DSH_DESKTOP_PAYLOAD

/** Absolute path of the primary runtime directory the Host reads. */
export const primaryRuntime = join(payloadDir, 'primary-runtime')

const created = []

/**
 * Create a temporary directory that is removed when the process exits.
 * @param label - Short name kept in the directory name.
 * @returns The absolute directory path.
 */
export function temporaryDirectory(label) {
  const directory = mkdtempSync(join(tmpdir(), `dsh-desktop-${label}-`))
  created.push(directory)
  return directory
}

/** Remove every temporary directory this process created. */
export function cleanup() {
  for (const directory of created.splice(0)) rmSync(directory, { recursive: true, force: true })
}

/**
 * Resolve once the given number of milliseconds have passed.
 * @param milliseconds - Delay.
 */
export function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

/**
 * Await a condition without polling forever.
 * @param probe - Returns truthy when the wait is over.
 * @param options - Timeout and poll interval.
 * @returns The probe's final truthy value.
 */
export async function waitFor(probe, { timeout = 60_000, interval = 250, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout
  for (;;) {
    const value = await probe()
    if (value) return value
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`)
    await delay(interval)
  }
}

/**
 * Run a child process and capture its output.
 * @param command - Executable.
 * @param args - Arguments.
 * @param options - Extra child-process options.
 * @returns Exit code, stdout, and stderr.
 */
export function run(command, args, options = {}) {
  return new Promise(resolve => {
    const child = spawnCapture(command, args, options, (code, stdout, stderr) => {
      resolve({ code, stdout, stderr })
    })
    void child
  })
}

import { spawn } from 'node:child_process'

function spawnCapture(command, args, options, done) {
  const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  child.on('close', code => done(code ?? -1, stdout, stderr))
  return child
}