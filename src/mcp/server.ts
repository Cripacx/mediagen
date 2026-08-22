/**
 * The MCP server, the second adapter over the core (§1.2).
 *
 * Not built yet — §13 places it after configuration. Until then this reports
 * plainly rather than starting a server that answers nothing: an MCP host that
 * spawns the binary and gets silence is far harder to diagnose than one that
 * gets a message on stderr and a non-zero exit.
 */

import { ERROR_CODE, MediagenError, type ExitCode } from '../core/errors.js'
import { reportError } from '../cli/output.js'

export function startMcpServer(): Promise<ExitCode> {
  return Promise.resolve(
    reportError(
      new MediagenError(ERROR_CODE.CONFIG_ERROR, 'The MCP server is not built yet.', {
        hint: 'Use the CLI for now: mediagen image "…". See SPEC.md §13.',
      }),
      false,
    ),
  )
}
