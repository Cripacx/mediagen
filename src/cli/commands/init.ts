/**
 * `mediagen init` — guided setup (§4.6).
 *
 * Refuses to run without a TTY. Without one the key cannot be read without
 * echoing it, and §3.5 does not allow reading a secret in the clear just
 * because it would be convenient — so this points at the `--stdin` path
 * instead of quietly degrading.
 */

import { Command } from 'commander'
import { ERROR_CODE, EXIT_CODE, MediagenError, type ExitCode } from '../../core/errors.js'
import { command } from '../../core/invocation.js'
import { readConfigFile, writeConfigFile } from '../../config/file.js'
import { maskSecret } from '../../config/layers.js'
import { verifyKey } from '../../config/verify.js'
import { PROVIDERS } from '../../providers/registry.js'
import { readSecret } from '../secretInput.js'
import { reportError, writeDiagnostic, writeLine, type Outcome } from '../output.js'
import type { ConfigFile } from '../../types/config.js'

export function buildInitCommand(outcome: Outcome): Command {
  return new Command('init')
    .description('Set up mediagen interactively: choose providers, enter and verify each key')
    .exitOverride()
    .addHelpText(
      'after',
      `
Requires a terminal. To configure without one:
  echo "$KEY" | mediagen config set <provider> --stdin`,
    )
    .action(async () => {
      if (!process.stdin.isTTY) {
        outcome.code = reportError(
          new MediagenError(ERROR_CODE.CONFIG_ERROR, 'init needs a terminal.', {
            hint: `Without one, use: echo "$KEY" | ${command('config set <provider> --stdin')}`,
          }),
          false,
        )
        return
      }

      try {
        outcome.code = await wizard()
      } catch (error) {
        // The prompt library throws this when the user presses Ctrl-C.
        // Abandoning setup is not a failure worth a stack trace.
        if (error instanceof Error && error.name === 'ExitPromptError') {
          writeDiagnostic('Cancelled; nothing was written.')
          outcome.code = EXIT_CODE.SUCCESS
          return
        }
        outcome.code = reportError(error, false)
      }
    })
}

async function wizard(): Promise<ExitCode> {
  const { checkbox, select } = await import('@inquirer/prompts')

  writeDiagnostic('Setting up mediagen. Keys are never echoed and never stored in shell history.')
  writeDiagnostic('')

  const chosen = await checkbox({
    message: 'Which providers do you want to configure?',
    choices: PROVIDERS.map((provider) => ({
      name: `${provider.label} (${provider.id})`,
      value: provider.id,
      ...(provider.credential.signupUrl === undefined
        ? {}
        : { description: `Get a key at ${provider.credential.signupUrl}` }),
    })),
  })

  if (chosen.length === 0) {
    writeDiagnostic('No providers chosen; nothing was written.')
    return EXIT_CODE.SUCCESS
  }

  let file: ConfigFile = readConfigFile()
  const configured: string[] = []

  for (const providerId of chosen) {
    const provider = PROVIDERS.find((candidate) => candidate.id === providerId)
    if (!provider) continue

    if (provider.credential.signupUrl !== undefined) {
      writeDiagnostic(`\n${provider.label}: get a key at ${provider.credential.signupUrl}`)
    }

    const key = await readSecret({
      fromStdin: false,
      prompt: `Enter ${provider.credential.description}`,
    })

    if (key.length === 0) {
      writeDiagnostic(`Skipped ${provider.label}: no key entered.`)
      continue
    }

    // §4.6 — each key is verified with a live request as it is entered, so a
    // typo is caught here rather than during the first real generation.
    writeDiagnostic(`Verifying…`)
    const verification = await verifyKey(provider, key)

    if (verification.status === 'rejected') {
      writeDiagnostic(
        `${provider.label} rejected that key, so it was not saved. Run \`${command(`config set ${provider.id}`)}\` to try again.`,
      )
      continue
    }

    if (verification.status === 'unreachable') {
      writeDiagnostic(
        `Could not reach ${provider.label} to check the key; saving it anyway. Run \`${command('doctor')}\` once you are online.`,
      )
    } else if (verification.status === 'unverifiable') {
      writeDiagnostic(
        `${provider.label} offers no cheap way to verify a key, so it was saved untested.`,
      )
    } else {
      writeDiagnostic(`${provider.label} accepted the key (${maskSecret(key)}).`)
    }

    file = { ...file, apiKeys: { ...file.apiKeys, [provider.id]: key } }
    configured.push(provider.id)
  }

  if (configured.length === 0) {
    writeDiagnostic('\nNo keys were saved.')
    return EXIT_CODE.SUCCESS
  }

  const defaultProvider =
    configured.length === 1
      ? configured[0]!
      : await select({
          message: 'Which provider should be the default?',
          choices: configured.map((id) => ({ name: id, value: id })),
        })

  file = { ...file, defaultProvider }

  const path = writeConfigFile(file)

  writeDiagnostic('')
  writeDiagnostic(`Default provider: ${defaultProvider}`)
  writeDiagnostic(`Try it: ${command('image "a red bicycle in the rain"')}`)
  writeLine(path)

  return EXIT_CODE.SUCCESS
}
