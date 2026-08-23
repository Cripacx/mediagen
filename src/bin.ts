#!/usr/bin/env node
/**
 * The binary entry point.
 *
 * Deliberately thin: it owns the process, and nothing else. Exit codes come
 * from the taxonomy and the last-resort handlers exist so that an
 * unexpected throw still leaves stdout obeying the output contract.
 */

import { runProgram } from './cli/program.js'
import { reportError } from './cli/output.js'

const argv = process.argv.slice(2)

// `--verbose` is read here as well as by the command, so that a failure thrown
// before parsing can still show what caused it.
if (argv.includes('--verbose')) {
  process.env['MEDIAGEN_VERBOSE'] = '1'
}

try {
  process.exitCode = await runProgram(argv)
} catch (error) {
  process.exitCode = reportError(error, argv.includes('--json'))
}

process.on('unhandledRejection', (reason: unknown) => {
  process.exitCode = reportError(reason, argv.includes('--json'))
})

process.on('uncaughtException', (error: unknown) => {
  process.exitCode = reportError(error, argv.includes('--json'))
})

// Nothing here calls process.exit(): a non-zero `process.exitCode` is honoured
// on a clean exit, whereas exiting outright can truncate a pending stdout
// write and cost the caller the JSON object it promises.
