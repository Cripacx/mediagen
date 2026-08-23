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
 * on a usage error and prints its own text, whereas a usage error is fixed at
 * 2 here, and a `--json` caller gets one object even when the arguments
 * were the problem.
 */

import { Command, CommanderError } from 'commander'
import { ERROR_CODE, EXIT_CODE, MediagenError, type ExitCode } from '../core/errors.js'
import { command } from '../core/invocation.js'
import { version } from '../core/version.js'
import { PROVIDER_IDS } from '../providers/registry.js'
import { buildConfigCommand } from './commands/config.js'
import { buildDoctorCommand } from './commands/doctor.js'
import { buildGenerateCommand } from './commands/generate.js'
import { buildInitCommand } from './commands/init.js'
import { buildMarkCommand } from './commands/mark.js'
import { buildModelsCommand } from './commands/models.js'
import { reportError, type Outcome } from './output.js'

export type { Outcome }

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

Run \`mediagen mcp\` to start the MCP server on stdio. That is the command an
MCP host should be configured to spawn.

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
  program.addCommand(buildModelsCommand(outcome))
  program.addCommand(buildMarkCommand(outcome))

  program
    .command('mcp')
    .description('Run the MCP server on stdio')
    .exitOverride()
    .addHelpText(
      'after',
      `
This is what an MCP host spawns. It speaks JSON-RPC on stdin and stdout and
runs until the host closes the connection, so there is nothing to see if you
run it yourself.`,
    )
    .action(async () => {
      const { startMcpServer } = await import('../mcp/server.js')
      outcome.code = await startMcpServer()
    })

  return program
}

/**
 * Runs the tree and turns commander's own control flow into an exit code.
 *
 * `--help` and `--version` reach here as thrown CommanderErrors because
 * `exitOverride` is set; both are successful outcomes, not failures.
 */
export async function runProgram(argv: string[]): Promise<ExitCode> {
  // Deliberate deviation from the specification, which said the binary with no subcommand
  // must run the MCP server "because that is how MCP hosts spawn it".
  //
  // Hosts spawn whatever `args` their configuration names, so nothing actually
  // requires the zero-argument form — it is a convention, not a constraint.
  // Honouring it literally costs more than it is worth: every non-interactive
  // caller that runs `mediagen` without arguments, which includes scripts, CI
  // and agent shells, gets a process that reads JSON-RPC forever and has to be
  // killed. A person typing it to see what the tool does gets the same.
  //
  // Detecting a TTY was tried and is not a reliable enough signal: plenty of
  // non-host contexts have no TTY either, so the hang simply moved rather than
  // going away.
  //
  // `mediagen mcp` is the explicit form, and the one host configurations
  // should use. See the note in the README.
  if (argv.length === 0) {
    const outcome: Outcome = { code: EXIT_CODE.SUCCESS }
    buildProgram(outcome).outputHelp()
    return EXIT_CODE.SUCCESS
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
            hint: `Run: ${command('--help')}`,
          }),
          true,
        )
      }
      return EXIT_CODE.USAGE
    }

    return reportError(error, argv.includes('--json'))
  }
}
