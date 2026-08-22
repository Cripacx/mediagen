/**
 * The CLI output contract, and the only module that writes to stdout.
 *
 * Spec §4.2 is the interface the skill and every script depend on:
 *
 * - Human mode: a short summary on stdout with the saved path as the **last
 *   line**. Diagnostics and logs go to stderr.
 * - `--json`: stdout carries **exactly one JSON object and nothing else**.
 *
 * Keeping every `process.stdout.write` here makes both properties something
 * one file guarantees rather than something every command has to remember.
 * The lint config enforces it: `no-console` is disabled only for this file.
 */

import {
  exitCodeFor,
  isMediagenError,
  toMediagenError,
  EXIT_CODE,
  type ExitCode,
} from '../core/errors.js'
import type { GenerationResult } from '../types/media.js'

/** Writes the single stdout JSON object. */
export function writeJson(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`)
}

/** Writes a human-facing line to stdout. */
export function writeLine(line = ''): void {
  process.stdout.write(`${line}\n`)
}

/** Writes a diagnostic to stderr, keeping stdout clean. */
export function writeDiagnostic(line: string): void {
  process.stderr.write(`${line}\n`)
}

/** The success object, exactly as §4.2 specifies it. */
export function reportResult(result: GenerationResult, json: boolean): ExitCode {
  if (json) {
    writeJson({
      success: true,
      filePath: result.filePath,
      kind: result.kind,
      provider: result.provider,
      model: result.model,
      mimeType: result.mimeType,
      ...(result.revisedPrompt === undefined ? {} : { revisedPrompt: result.revisedPrompt }),
      ...(result.requestId === undefined ? {} : { requestId: result.requestId }),
    })
    return EXIT_CODE.SUCCESS
  }

  writeLine(`Generated ${result.kind} with ${result.provider}/${result.model}`)
  // §4.2: the saved path is the last line, so `$(mediagen image …| tail -1)`
  // is a supported way to use this.
  writeLine(result.filePath)
  return EXIT_CODE.SUCCESS
}

/**
 * Renders a failure in the requested format and returns the exit code.
 *
 * In human mode nothing is written to stdout at all. A caller that reads the
 * last stdout line to find the saved path would otherwise pick up an error
 * message and treat it as a path.
 */
export function reportError(error: unknown, json: boolean): ExitCode {
  const mapped = isMediagenError(error) ? error : toMediagenError(error)

  if (json) {
    writeJson({
      success: false,
      errorCode: mapped.code,
      error: mapped.message,
      ...(mapped.hint === undefined ? {} : { hint: mapped.hint }),
    })
  } else {
    writeDiagnostic(`Error: ${mapped.message}`)
    if (mapped.hint !== undefined) {
      writeDiagnostic(`Hint: ${mapped.hint}`)
    }
  }

  if (mapped.cause !== undefined && process.env['MEDIAGEN_VERBOSE'] === '1') {
    writeDiagnostic(`Caused by: ${describeCause(mapped.cause)}`)
  }

  return exitCodeFor(mapped.code)
}

/**
 * Only ever reached under `--verbose`, and only on stderr. An upstream cause
 * is frequently a plain object, and the default stringification would print
 * `[object Object]` — which tells the user less than nothing.
 */
function describeCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  if (typeof cause === 'string') return cause
  try {
    return JSON.stringify(cause) ?? String(cause)
  } catch {
    return Object.prototype.toString.call(cause)
  }
}
