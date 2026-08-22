/**
 * CLI subcommand router.
 *
 * Spec §4.1 — starting the binary with no subcommand runs the MCP server,
 * because that is how MCP hosts spawn it. Every other entry point is an
 * explicit subcommand.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ERROR_CODE, EXIT_CODE, MediagenError, type ExitCode } from '../core/errors.js'
import { PROVIDER_IDS } from '../providers/registry.js'
import { runGenerate } from './commands/generate.js'
import { reportError, writeLine } from './output.js'

/** Commands §4.1 names. Those not yet built say so rather than looking unknown. */
const UNBUILT: Readonly<Record<string, string>> = {
  mark: 'Content marking (§9) is not built yet.',
  models: 'Model listing (§7.2) is not built yet.',
  init: 'Guided setup (§4.6) is not built yet.',
  doctor: 'Diagnostics (§4.5) is not built yet.',
  config: 'Config management (§4.4) is not built yet.',
}

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

const HELP = `
mediagen — generate images and video from text prompts.

Usage:
  mediagen image <prompt> [options]     Generate an image
  mediagen video <prompt> [options]     Generate a video
  mediagen mark <file...> [options]     Mark existing media as AI-generated
  mediagen models [options]             Show each provider's models
  mediagen init                         Guided setup
  mediagen doctor [options]             Check keys and reachability
  mediagen config <action>              Manage the config file
  mediagen                              Start the MCP server on stdio

Providers:
  ${PROVIDER_IDS.join(', ')}

Credentials are never passed as arguments — they land in shell history and the
process list. Use \`mediagen config set <provider>\`, which prompts for the key
without echoing it, or pipe it in with --stdin.

Run \`mediagen <command> --help\` for a command's options.

Exit codes:
  0 success   2 invalid input   3 configuration   4 generation or I/O failure
`

export async function main(argv: string[]): Promise<ExitCode> {
  const [command, ...rest] = argv

  // §4.1: no subcommand means an MCP host spawned us.
  if (command === undefined) {
    return await runMcpServer()
  }

  if (command === '--help' || command === '-h' || command === 'help') {
    writeLine(HELP.trim())
    return EXIT_CODE.SUCCESS
  }

  if (command === '--version' || command === '-v') {
    writeLine(version())
    return EXIT_CODE.SUCCESS
  }

  if (command === 'image' || command === 'video') {
    return await runGenerate(command, rest)
  }

  const unbuilt = UNBUILT[command]
  if (unbuilt !== undefined) {
    return reportError(
      new MediagenError(ERROR_CODE.VALIDATION_ERROR, unbuilt, {
        hint: 'See SPEC.md §13 for the build order.',
      }),
      rest.includes('--json'),
    )
  }

  return reportError(
    new MediagenError(ERROR_CODE.VALIDATION_ERROR, `Unknown command "${command}".`, {
      hint: 'Run: mediagen --help',
    }),
    rest.includes('--json'),
  )
}

async function runMcpServer(): Promise<ExitCode> {
  // Loaded lazily so a plain `mediagen image` never pays for the MCP SDK.
  const { startMcpServer } = await import('../mcp/server.js')
  return await startMcpServer()
}
