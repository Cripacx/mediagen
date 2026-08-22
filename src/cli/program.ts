/**
 * The command tree.
 *
 * Built with commander so that help text is generated from the option
 * definitions rather than written beside them. The hand-rolled version kept
 * every flag in two places — an options object and a help template — which
 * drift apart the first time someone adds a flag in a hurry, and nothing
 * catches it.
 *
 * Commander's own process handling is overridden throughout: it exits with 1
 * on a usage error and prints its own text, whereas §4.3 fixes usage errors at
 * 2 and §4.2 says a `--json` caller gets one object even when the arguments
 * were the problem.
 */

import { Command, CommanderError } from 'commander'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ERROR_CODE, EXIT_CODE, MediagenError, type ExitCode } from '../core/errors.js'
import { PROVIDER_IDS } from '../providers/registry.js'
import { buildConfigCommand } from './commands/config.js'
import { buildDoctorCommand } from './commands/doctor.js'
import { buildGenerateCommand } from './commands/generate.js'
import { buildInitCommand } from './commands/init.js'
import { reportError, type Outcome } from './output.js'

export type { Outcome }

function version(): string {
  try {
    const packagePath = fileURLToPath(new URL('../../package.json', import.meta.url))
    const parsed: unknown = JSON.parse(readFileSync(packagePath, 'utf-8'))
    if (typeof parsed === 'object' && parsed !== null) {
      const value: unknown = (parsed as { version?: unknown }).version
      if (typeof value === 'string') return value
    }
  } catch {
    // A missing package.json is not worth failing a run over.
  }
  return '0.0.0'
}

export function buildProgram(outcome: Outcome): Command {
  const program = new Command()

  program
    .name('mediagen')
    .description('Generate images and video from text prompts across several providers.')
    .version(version(), '-v, --version')
    .addHelpText(
      'after',
      `
Providers: ${PROVIDER_IDS.join(', ')}

API keys are never accepted as command arguments — they would land in shell
history and in the process list. Use \`mediagen config set <provider>\`, which
prompts without echoing, or pipe the key in with --stdin.

Starting mediagen with no subcommand runs the MCP server on stdio, which is
how MCP hosts spawn it.

Exit codes:
  0 success   2 invalid input   3 configuration   4 generation or I/O failure`,
    )
    // Errors and help must not fight the output contract, and commander must
    // never call process.exit() out from under a pending stdout write.
    .exitOverride()
    .configureOutput({
      writeOut: (text) => process.stdout.write(text),
      writeErr: (text) => process.stderr.write(text),
    })
    .showHelpAfterError()

  program.addCommand(buildGenerateCommand('image', outcome))
  program.addCommand(buildGenerateCommand('video', outcome))
  program.addCommand(buildConfigCommand(outcome))
  program.addCommand(buildDoctorCommand(outcome))
  program.addCommand(buildInitCommand(outcome))

  // §4.1 names these; they are not built yet and say so rather than looking
  // like a typo the user made.
  for (const [name, description, note] of [
    ['mark', 'Mark existing media as AI-generated', 'Content marking (§9) is not built yet.'],
    ['models', "Show each provider's models", 'Model listing (§7.2) is not built yet.'],
  ] as const) {
    program
      .command(name)
      .description(`${description} (not built yet)`)
      .allowUnknownOption()
      .allowExcessArguments()
      .action(() => {
        outcome.code = reportError(
          new MediagenError(ERROR_CODE.VALIDATION_ERROR, note, {
            hint: 'See SPEC.md §13 for the build order.',
          }),
          process.argv.includes('--json'),
        )
      })
  }

  return program
}

/**
 * Runs the tree and turns commander's own control flow into an exit code.
 *
 * `--help` and `--version` reach here as thrown CommanderErrors because
 * `exitOverride` is set; both are successful outcomes, not failures.
 */
export async function runProgram(argv: string[]): Promise<ExitCode> {
  // §4.1: no subcommand means an MCP host spawned us. This is checked before
  // commander sees the arguments, because commander's answer to "no arguments"
  // is to print help.
  if (argv.length === 0) {
    const { startMcpServer } = await import('../mcp/server.js')
    return await startMcpServer()
  }

  const outcome: Outcome = { code: EXIT_CODE.SUCCESS }
  const program = buildProgram(outcome)

  try {
    await program.parseAsync(argv, { from: 'user' })
    return outcome.code
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.code === 'commander.helpDisplayed' || error.code === 'commander.help') {
        return EXIT_CODE.SUCCESS
      }
      if (error.code === 'commander.version') {
        return EXIT_CODE.SUCCESS
      }
      // Commander has already written its own message to stderr. In `--json`
      // mode that is not enough: stdout still owes the caller one object.
      if (argv.includes('--json')) {
        return reportError(
          new MediagenError(ERROR_CODE.VALIDATION_ERROR, error.message, {
            hint: 'Run: mediagen --help',
          }),
          true,
        )
      }
      return EXIT_CODE.USAGE
    }

    return reportError(error, argv.includes('--json'))
  }
}
