/**
 * Diagnostics, which always go to stderr.
 *
 * Spec §4.2 gives stdout to the output contract alone: in `--json` mode it
 * carries exactly one object and nothing else, and in human mode the saved
 * path must be the last line. Any log written to stdout breaks both. Routing
 * every log through this module makes that a property of one file rather than
 * a rule everyone has to remember.
 */

import type { Logger } from '../types/provider.js'

export interface LoggerOptions {
  /** Emits `debug` as well; set by `--verbose`. */
  readonly verbose?: boolean
  /** Silences everything but warnings; set by `--quiet`. */
  readonly quiet?: boolean
}

function write(line: string): void {
  process.stderr.write(`${line}\n`)
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const { verbose = false, quiet = false } = options
  return {
    debug(message) {
      if (verbose) write(`debug: ${message}`)
    },
    info(message) {
      if (!quiet) write(message)
    },
    warn(message) {
      write(`warning: ${message}`)
    },
    progress(message) {
      if (!quiet) write(message)
    },
  }
}

/** For tests and for the MCP server, which has no stderr contract to honour. */
export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  progress() {},
}
