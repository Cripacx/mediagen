/**
 * `mediagen config edit` — the interactive way to change settings.
 *
 * `config set` is the scriptable path and stays exactly as it was. This is for
 * the case `set` handles badly: knowing that a setting exists, what it is
 * currently, and what the valid values are, without reading help first.
 *
 * It loops rather than exiting after one change, because someone opening this
 * usually has more than one thing to adjust. Each change is written as it is
 * made, so leaving mid-session never loses an earlier one or applies half of
 * a later one.
 */

import { Command } from 'commander'
import { ERROR_CODE, EXIT_CODE, MediagenError, type ExitCode } from '../../core/errors.js'
import { readConfigFile, writeConfigFile } from '../../config/file.js'
import { LAYER_LABEL, loadConfigLayers, maskSecret } from '../../config/layers.js'
import { loadConfig } from '../../config/resolve.js'
import { verifyKey } from '../../config/verify.js'
import { PROVIDERS, requireProvider } from '../../providers/registry.js'
import {
  PROVIDER_DEFAULT,
  pickMarking,
  pickModel,
  pickPriority,
  pickProvider,
  pickQuality,
} from '../prompts.js'
import { readSecret } from '../secretInput.js'
import { reportError, writeDiagnostic, writeLine, type Outcome } from '../output.js'
import type { ConfigFile } from '../../types/config.js'

export function buildConfigEditCommand(outcome: Outcome): Command {
  return new Command('edit')
    .description('Change settings interactively')
    .exitOverride()
    .addHelpText(
      'after',
      `
Requires a terminal. To change settings without one, use \`config set\`.`,
    )
    .action(async () => {
      if (!process.stdin.isTTY) {
        outcome.code = reportError(
          new MediagenError(ERROR_CODE.CONFIG_ERROR, 'config edit needs a terminal.', {
            hint: 'Without one, use: mediagen config set <key> <value>',
          }),
          false,
        )
        return
      }

      try {
        outcome.code = await editor()
      } catch (error) {
        // Ctrl-C during a prompt. Leaving is not a failure, and every change
        // up to that point was already written.
        if (error instanceof Error && error.name === 'ExitPromptError') {
          writeDiagnostic('Done.')
          outcome.code = EXIT_CODE.SUCCESS
          return
        }
        outcome.code = reportError(error, false)
      }
    })
}

type Action = 'provider' | 'model' | 'key' | 'output-dir' | 'quality' | 'marking' | 'done'

async function editor(): Promise<ExitCode> {
  const { select, input } = await import('@inquirer/prompts')

  for (;;) {
    // Re-read every round: a value may have just changed, and showing a stale
    // one would be worse than showing none.
    const config = loadConfig(loadConfigLayers())
    const file = readConfigFile()

    const action = await select<Action>({
      message: 'What would you like to change?',
      choices: [
        {
          name: `Provider priority  —  ${config.providerPriority.value.join(' > ')}  [${LAYER_LABEL[config.providerPriority.layer]}]`,
          value: 'provider',
        },
        { name: `Model for a provider${modelSummary(file)}`, value: 'model' },
        { name: `API key${keySummary()}`, value: 'key' },
        {
          name: `Output directory  —  ${config.outputDir.value}  [${LAYER_LABEL[config.outputDir.layer]}]`,
          value: 'output-dir',
        },
        {
          name: `Quality preset  —  ${config.quality.value}  [${LAYER_LABEL[config.quality.layer]}]`,
          value: 'quality',
        },
        {
          name: `AI marking by default  —  ${describeMarking(config.mark.value, config.visibleLabel.value)}`,
          value: 'marking',
        },
        { name: 'Done', value: 'done' },
      ],
    })

    if (action === 'done') {
      writeLine(writeConfigFile(readConfigFile()))
      return EXIT_CODE.SUCCESS
    }

    switch (action) {
      case 'provider': {
        const ordered = await pickPriority(
          PROVIDERS,
          config.providerPriority.value,
          (providerId: string) => config.apiKey(providerId) !== undefined,
        )

        // `defaultProvider` is what this replaced; leaving it would let a
        // stale value reappear if the order were later removed.
        const { defaultProvider: _replaced, ...current } = readConfigFile()
        writeConfigFile({ ...current, providerPriority: ordered })
        warnIfShadowed('MEDIAGEN_PROVIDER_PRIORITY', 'the provider priority')
        break
      }

      case 'model': {
        const providerId = await pickProvider(
          PROVIDERS,
          'Set the model for which provider?',
          config.providerPriority.value[0],
        )
        const provider = requireProvider(providerId)
        const chosen = await pickModel(provider, 'image', file.models?.[providerId])
        const current = readConfigFile()

        if (chosen === PROVIDER_DEFAULT) {
          const { [providerId]: _cleared, ...models } = current.models ?? {}
          writeConfigFile({ ...current, models })
          writeDiagnostic(`${provider.label} will use its own default again.`)
        } else {
          writeConfigFile({ ...current, models: { ...current.models, [providerId]: chosen } })
        }
        warnIfShadowed(`${providerId.toUpperCase()}_MODEL`, `the ${provider.label} model`)
        break
      }

      case 'key': {
        const providerId = await pickProvider(
          PROVIDERS,
          'Set the key for which provider?',
          undefined,
        )
        await setKey(providerId)
        break
      }

      case 'output-dir': {
        const chosen = await input({
          message: 'Where should generated media be saved?',
          default: config.outputDir.value,
        })
        if (chosen.trim().length === 0) {
          writeDiagnostic('Left unchanged.')
          break
        }
        writeConfigFile({ ...readConfigFile(), outputDir: chosen.trim() })
        warnIfShadowed('MEDIAGEN_OUTPUT_DIR', 'the output directory')
        break
      }

      case 'quality': {
        const chosen = await pickQuality(config.quality.value)
        writeConfigFile({ ...readConfigFile(), quality: chosen })
        warnIfShadowed('MEDIAGEN_QUALITY', 'the quality preset')
        break
      }

      case 'marking': {
        const chosen = await pickMarking({
          mark: config.mark.value,
          visibleLabel: config.visibleLabel.value,
        })
        writeConfigFile({
          ...readConfigFile(),
          mark: chosen.mark,
          visibleLabel: chosen.visibleLabel,
        })
        warnIfShadowed('MEDIAGEN_MARK', 'the marking default')
        warnIfShadowed('MEDIAGEN_VISIBLE_LABEL', 'the visible-label default')
        break
      }
    }
  }
}

async function setKey(providerId: string): Promise<void> {
  const provider = requireProvider(providerId)

  if (provider.credential.signupUrl !== undefined) {
    writeDiagnostic(`Get a key at ${provider.credential.signupUrl}`)
  }

  const key = await readSecret({
    fromStdin: false,
    prompt: `Enter ${provider.credential.description}`,
  })

  if (key.length === 0) {
    writeDiagnostic('Nothing entered; the existing key was left alone.')
    return
  }

  writeDiagnostic('Verifying…')
  const verification = await verifyKey(provider, key)

  if (verification.status === 'rejected') {
    writeDiagnostic(`${provider.label} rejected that key, so it was not saved.`)
    return
  }

  if (verification.status === 'unverifiable') {
    writeDiagnostic(`${provider.label} offers no cheap way to verify a key; saved untested.`)
  } else if (verification.status === 'unreachable') {
    writeDiagnostic(`Could not reach ${provider.label}; saved without checking.`)
  } else {
    writeDiagnostic(`${provider.label} accepted the key (${maskSecret(key)}).`)
  }

  const current = readConfigFile()
  writeConfigFile({ ...current, apiKeys: { ...current.apiKeys, [providerId]: key } })
  warnIfShadowed(provider.credential.envVar, `the ${provider.label} key`)
}

/**
 * The whole point of tracking provenance: a value written to the file that an
 * environment variable will override is worth saying out loud, immediately,
 * rather than leaving to be discovered during a generation.
 */
function warnIfShadowed(envVar: string, what: string): void {
  const layers = loadConfigLayers()

  const inEnv = layers.env[envVar]
  if (typeof inEnv === 'string' && inEnv.trim().length > 0) {
    writeDiagnostic(`Note: ${envVar} is set in your environment and overrides ${what}.`)
    return
  }

  const inDotenv = layers.dotenv[envVar]
  if (typeof inDotenv === 'string' && inDotenv.trim().length > 0) {
    writeDiagnostic(`Note: ${envVar} is set in .env and overrides ${what}.`)
  }
}

function modelSummary(file: ConfigFile): string {
  const pinned = Object.entries(file.models ?? {})
  if (pinned.length === 0) return '  —  none pinned'
  return `  —  ${pinned.map(([provider, model]) => `${provider}: ${model}`).join(', ')}`
}

function keySummary(): string {
  const config = loadConfig(loadConfigLayers())
  const configured = PROVIDERS.filter((provider) => config.apiKey(provider.id) !== undefined)

  if (configured.length === 0) return '  —  none configured'
  return `  —  ${configured.map((provider) => provider.id).join(', ')} configured`
}

function describeMarking(mark: boolean, visibleLabel: boolean): string {
  if (!mark && !visibleLabel) return 'off'
  return visibleLabel ? 'marker and visible label' : 'marker'
}
