/**
 * `mediagen config` — the only command that writes the config file.
 *
 * The layered resolver's provenance earns its keep here: `list` and `get`
 * show every value with the layer that produced it and warn when a lower layer
 * is being shadowed. A stale environment variable hiding the key someone just
 * configured is the most expensive failure this tool has, and it is invisible
 * unless the tool says so.
 */

import { Command } from 'commander'
import { ERROR_CODE, EXIT_CODE, MediagenError, type ExitCode } from '../../core/errors.js'
import { command } from '../../core/invocation.js'
import { configFilePath, readConfigFile, writeConfigFile } from '../../config/file.js'
import { LAYER_LABEL, loadConfigLayers, maskSecret } from '../../config/layers.js'
import { loadConfig } from '../../config/resolve.js'
import { verifyKey } from '../../config/verify.js'
import { PROVIDERS, PROVIDER_IDS, findProvider, requireProvider } from '../../providers/registry.js'
import { QUALITY_PRESETS, isQualityPreset } from '../../types/media.js'
import { readSecret } from '../secretInput.js'
import { reportError, writeDiagnostic, writeJson, writeLine, type Outcome } from '../output.js'
import type { ConfigFile, Resolved } from '../../types/config.js'

interface CommonOptions {
  json?: boolean
}

export function buildConfigCommand(outcome: Outcome): Command {
  const config = new Command('config')
    .description('Manage the per-machine config file')
    .exitOverride()
    .addHelpText(
      'after',
      `
Settable keys:
  <provider>            an API key, read from a hidden prompt or --stdin
  <provider>-model      the model that provider uses by default
  default-provider      one of: ${PROVIDER_IDS.join(', ')}
  output-dir            where generated media is written
  quality               one of: ${QUALITY_PRESETS.join(', ')}

API keys are never accepted as command arguments: they would land in shell
history and in the process list. Use the hidden prompt, or pipe the key in:

  echo "$KEY" | mediagen config set gemini --stdin

The file is written with owner-only permissions where the platform has them.
On Windows there are no POSIX mode bits and the profile ACL protects it instead.`,
    )

  const guard = (run: () => ExitCode | Promise<ExitCode>, json: boolean) => async () => {
    try {
      outcome.code = await run()
    } catch (error) {
      outcome.code = reportError(error, json)
    }
  }

  config
    .command('set')
    .description('Store an API key or a setting')
    .argument('<key>', 'a provider id, or a setting name')
    .argument('[value...]', 'the value; omitted when storing an API key')
    .option('--stdin', 'read the API key from stdin instead of prompting')
    .option('--json', 'emit exactly one JSON object on stdout')
    .exitOverride()
    .action(
      async (key: string, valueParts: string[], options: CommonOptions & { stdin?: boolean }) => {
        await guard(
          () => runSet([key, ...valueParts], options.stdin === true, options.json === true),
          options.json === true,
        )()
      },
    )

  config
    .command('get')
    .description('Show one value and the layer it came from')
    .argument('<key>')
    .option('--json', 'emit exactly one JSON object on stdout')
    .exitOverride()
    .action(async (key: string, options: CommonOptions) => {
      await guard(() => runGet([key], options.json === true), options.json === true)()
    })

  config
    .command('list')
    .description('Show every value, its layer, and any shadowing')
    .option('--json', 'emit exactly one JSON object on stdout')
    .exitOverride()
    .action(async (options: CommonOptions) => {
      await guard(() => runList(options.json === true), options.json === true)()
    })

  config
    .command('unset')
    .description('Remove a value from the config file')
    .argument('<key>')
    .option('--json', 'emit exactly one JSON object on stdout')
    .exitOverride()
    .action(async (key: string, options: CommonOptions) => {
      await guard(() => runUnset([key], options.json === true), options.json === true)()
    })

  config
    .command('path')
    .description('Print the config file path')
    .option('--json', 'emit exactly one JSON object on stdout')
    .exitOverride()
    .action(async (options: CommonOptions) => {
      await guard(() => runPath(options.json === true), options.json === true)()
    })

  return config
}

/* -------------------------------------------------------------------------- */

async function runSet(args: string[], fromStdin: boolean, json: boolean): Promise<ExitCode> {
  const [key, ...valueParts] = args
  if (key === undefined) {
    throw new MediagenError(ERROR_CODE.VALIDATION_ERROR, 'config set needs a key.', {
      hint: `Run: ${command('config --help')}`,
    })
  }

  // A bare provider id means "store this provider's API key", which is the
  // one case that must never read its value from the argument list.
  const provider = findProvider(key)
  if (provider) {
    return await setApiKey(provider.id, fromStdin, json)
  }

  const value = valueParts.join(' ').trim()
  if (value.length === 0) {
    throw new MediagenError(ERROR_CODE.VALIDATION_ERROR, `config set ${key} needs a value.`, {
      hint: `Run: ${command('config --help')}`,
    })
  }

  const file = readConfigFile()
  const updated = applySetting(file, key, value)
  const path = writeConfigFile(updated)

  if (json) {
    writeJson({ success: true, key, value, filePath: path })
  } else {
    writeLine(`Set ${key} to ${value}`)
    writeLine(path)
  }
  return EXIT_CODE.SUCCESS
}

function applySetting(file: ConfigFile, key: string, value: string): ConfigFile {
  if (key === 'default-provider') {
    requireProvider(value)
    return { ...file, defaultProvider: value }
  }

  if (key === 'output-dir') {
    return { ...file, outputDir: value }
  }

  if (key === 'quality') {
    if (!isQualityPreset(value)) {
      throw new MediagenError(ERROR_CODE.VALIDATION_ERROR, `Unknown quality preset "${value}".`, {
        hint: `Use one of: ${QUALITY_PRESETS.join(', ')}.`,
      })
    }
    return { ...file, quality: value }
  }

  const modelMatch = /^(.+)-model$/.exec(key)
  if (modelMatch) {
    const provider = requireProvider(modelMatch[1]!)
    return { ...file, models: { ...file.models, [provider.id]: value } }
  }

  throw new MediagenError(ERROR_CODE.VALIDATION_ERROR, `Unknown config key "${key}".`, {
    hint: `Run: ${command('config --help')}`,
  })
}

async function setApiKey(providerId: string, fromStdin: boolean, json: boolean): Promise<ExitCode> {
  const provider = requireProvider(providerId)

  const key = await readSecret({
    fromStdin,
    prompt: `Enter ${provider.credential.description}`,
  })

  if (key.length === 0) {
    throw new MediagenError(
      ERROR_CODE.VALIDATION_ERROR,
      fromStdin ? 'No key was read from stdin.' : 'A key is required.',
      {
        hint: `Pipe it in instead: echo "$KEY" | ${command(`config set ${providerId} --stdin`)}`,
      },
    )
  }

  // Verified with one minimal live request before it is stored, so a
  // typo surfaces here rather than at first use.
  if (!json) writeDiagnostic(`Verifying the ${provider.label} key…`)
  const verification = await verifyKey(provider, key)

  if (verification.status === 'rejected') {
    throw new MediagenError(
      ERROR_CODE.CONFIG_ERROR,
      `${provider.label} rejected that key; it was not saved.`,
      { hint: verification.detail ?? 'Check the key and try again.' },
    )
  }

  const file = readConfigFile()
  const path = writeConfigFile({ ...file, apiKeys: { ...file.apiKeys, [provider.id]: key } })

  // A key stored in the file is still shadowed by an environment
  // variable, and saying nothing here is how someone loses an afternoon.
  const shadowing = shadowedBy(provider.credential.envVar)

  if (json) {
    writeJson({
      success: true,
      provider: provider.id,
      verification: verification.status,
      filePath: path,
      ...(shadowing ? { shadowedBy: shadowing } : {}),
    })
  } else {
    writeLine(
      verification.status === 'ok'
        ? `Saved and verified the ${provider.label} key (${maskSecret(key)}).`
        : `Saved the ${provider.label} key (${maskSecret(key)}); it could not be verified cheaply.`,
    )
    if (shadowing) {
      writeDiagnostic(
        `Warning: ${provider.credential.envVar} is set in ${shadowing} and takes priority over the file you just wrote.`,
      )
    }
    writeLine(path)
  }
  return EXIT_CODE.SUCCESS
}

/** Which higher-priority layer, if any, currently defines this variable. */
function shadowedBy(envVar: string): string | undefined {
  const layers = loadConfigLayers()
  if (typeof layers.env[envVar] === 'string' && layers.env[envVar].trim().length > 0) {
    return LAYER_LABEL.environment
  }
  if (typeof layers.dotenv[envVar] === 'string' && layers.dotenv[envVar].trim().length > 0) {
    return LAYER_LABEL.dotenv
  }
  return undefined
}

/* -------------------------------------------------------------------------- */

interface Row {
  readonly key: string
  readonly value: string
  readonly layer: string
  readonly shadowed: readonly string[]
  readonly secret: boolean
}

function rows(): Row[] {
  const config = loadConfig()

  const result: Row[] = [
    describe('default-provider', config.defaultProvider, false),
    describe('output-dir', config.outputDir, false),
    describe('quality', config.quality, false),
  ]

  for (const provider of PROVIDERS) {
    const key = config.apiKey(provider.id)
    result.push(
      key
        ? describe(provider.id, key, true)
        : { key: provider.id, value: '(not set)', layer: '—', shadowed: [], secret: true },
    )

    const model = config.model(provider.id)
    if (model) {
      result.push(describe(`${provider.id}-model`, model, false))
    }
  }

  return result
}

function describe<T>(key: string, resolved: Resolved<T>, secret: boolean): Row {
  const raw = String(resolved.value)
  return {
    key,
    value: secret ? maskSecret(raw) : raw,
    layer: LAYER_LABEL[resolved.layer],
    shadowed: resolved.shadowed.map((layer) => LAYER_LABEL[layer]),
    secret,
  }
}

function runList(json: boolean): ExitCode {
  const all = rows()

  if (json) {
    writeJson({ success: true, filePath: configFilePath(), settings: all })
    return EXIT_CODE.SUCCESS
  }

  const width = Math.max(...all.map((row) => row.key.length))
  for (const row of all) {
    writeLine(`${row.key.padEnd(width)}  ${row.value}  [${row.layer}]`)
  }

  const shadowed = all.filter((row) => row.shadowed.length > 0)
  for (const row of shadowed) {
    writeDiagnostic(
      `Warning: ${row.key} is also set in ${row.shadowed.join(' and ')}, shadowed by ${row.layer}.`,
    )
  }

  writeLine(configFilePath())
  return EXIT_CODE.SUCCESS
}

function runGet(args: string[], json: boolean): ExitCode {
  const key = args[0]
  if (key === undefined) {
    throw new MediagenError(ERROR_CODE.VALIDATION_ERROR, 'config get needs a key.', {
      hint: `Run: ${command('config list')}`,
    })
  }

  const row = rows().find((candidate) => candidate.key === key)
  if (!row) {
    throw new MediagenError(ERROR_CODE.VALIDATION_ERROR, `Unknown config key "${key}".`, {
      hint: `Run: ${command('config list')}`,
    })
  }

  if (json) {
    writeJson({ success: true, ...row })
  } else {
    writeLine(`${row.value}  [${row.layer}]`)
    if (row.shadowed.length > 0) {
      writeDiagnostic(
        `Warning: also set in ${row.shadowed.join(' and ')}, shadowed by ${row.layer}.`,
      )
    }
  }
  return EXIT_CODE.SUCCESS
}

function runUnset(args: string[], json: boolean): ExitCode {
  const key = args[0]
  if (key === undefined) {
    throw new MediagenError(ERROR_CODE.VALIDATION_ERROR, 'config unset needs a key.', {
      hint: `Run: ${command('config list')}`,
    })
  }

  const file = readConfigFile()
  const updated = removeSetting(file, key)
  const path = writeConfigFile(updated)

  if (json) {
    writeJson({ success: true, key, filePath: path })
  } else {
    // The file is the only thing this command owns; a value still coming from
    // the environment is not something `unset` can or should remove.
    writeLine(`Removed ${key} from the config file.`)
    const still = rows().find((row) => row.key === key && row.value !== '(not set)')
    if (still) {
      writeDiagnostic(
        `Note: ${key} is still set in ${still.layer}, which this command cannot edit.`,
      )
    }
    writeLine(path)
  }
  return EXIT_CODE.SUCCESS
}

function removeSetting(file: ConfigFile, key: string): ConfigFile {
  const provider = findProvider(key)
  if (provider) {
    const { [provider.id]: _removed, ...apiKeys } = file.apiKeys ?? {}
    return { ...file, apiKeys }
  }

  const modelMatch = /^(.+)-model$/.exec(key)
  if (modelMatch) {
    const target = requireProvider(modelMatch[1]!)
    const { [target.id]: _removed, ...models } = file.models ?? {}
    return { ...file, models }
  }

  switch (key) {
    case 'default-provider': {
      const { defaultProvider: _d, ...rest } = file
      return rest
    }
    case 'output-dir': {
      const { outputDir: _o, ...rest } = file
      return rest
    }
    case 'quality': {
      const { quality: _q, ...rest } = file
      return rest
    }
    default:
      throw new MediagenError(ERROR_CODE.VALIDATION_ERROR, `Unknown config key "${key}".`, {
        hint: `Run: ${command('config list')}`,
      })
  }
}

function runPath(json: boolean): ExitCode {
  const path = configFilePath()
  if (json) {
    writeJson({ success: true, filePath: path })
  } else {
    writeLine(path)
  }
  return EXIT_CODE.SUCCESS
}
