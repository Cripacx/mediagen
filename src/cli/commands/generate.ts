/**
 * `mediagen image` and `mediagen video`.
 *
 * Kind is a dimension, not a fork. Both subcommands are built by
 * this one function with a different `kind`, so an option cannot exist for
 * images and quietly not for video.
 */

import { Command } from 'commander'
import { ERROR_CODE, MediagenError } from '../../core/errors.js'
import { createLogger } from '../../core/logger.js'
import { generate } from '../../core/pipeline.js'
import { loadConfig } from '../../config/resolve.js'
import { PROVIDER_IDS } from '../../providers/registry.js'
import { QUALITY_PRESETS, isQualityPreset } from '../../types/media.js'
import { reportError, reportResult, type Outcome } from '../output.js'
import type { GenerationRequest, MediaKind } from '../../types/media.js'

interface GenerateOptions {
  provider?: string
  model?: string
  input?: string
  aspectRatio?: string
  size?: string
  duration?: number
  outputName?: string
  outputDir?: string
  quality?: string
  json?: boolean
  verbose?: boolean
  quiet?: boolean
}

export function buildGenerateCommand(kind: MediaKind, outcome: Outcome): Command {
  const command = new Command(kind)
    .description(`Generate ${kind === 'image' ? 'an image' : 'a video'} from a text prompt`)
    .argument('<prompt...>', 'what to generate')
    .option('--provider <name>', `one of: ${PROVIDER_IDS.join(', ')}`)
    .option('--model <id>', 'model for the chosen provider (see: mediagen models)')
    .option('--input <path>', 'source media to edit or transform')
    .option('--aspect-ratio <ratio>', 'e.g. 1:1, 16:9, 9:16')
    .option('--size <size>', 'e.g. 1K, 2K, 4K')
    .option('--output-name <name>', 'output file name; its extension may select the format')
    .option('--output-dir <dir>', 'directory to save into')
    .option('--quality <preset>', `one of: ${QUALITY_PRESETS.join(', ')}`)
    .option('--json', 'emit exactly one JSON object on stdout')
    .option('--verbose', 'diagnostics on stderr')
    .option('--quiet', 'suppress progress on stderr')
    .exitOverride()

  if (kind === 'video') {
    command.option('--duration <seconds>', 'length of the clip', parsePositiveNumber)
  }

  command.addHelpText(
    'after',
    `
Examples:
  mediagen ${kind} "a red bicycle in the rain"
  mediagen ${kind} "a logo" --provider gemini --output-name logo.png
  mediagen ${kind} "a banner" --aspect-ratio 16:9 --json

The prompt is sent exactly as written. Writing a specific prompt — subject,
composition, light, camera or medium, materials, atmosphere — does far more
for the result than any flag here.

Generating does not mark. Run mediagen mark on the saved file to add the
AI-generated disclosure, once you can see where a visible label should go.`,
  )

  command.action(async (promptParts: string[], options: GenerateOptions) => {
    const json = options.json === true
    try {
      const request = buildRequest(kind, promptParts, options)

      const log = createLogger({
        verbose: options.verbose === true,
        // In `--json` mode the object on stdout is the whole answer, so
        // progress chatter on stderr is noise unless it was asked for.
        quiet: options.quiet === true || (json && options.verbose !== true),
      })

      const result = await generate(request, { config: loadConfig(), log })
      outcome.code = reportResult(result, json)
    } catch (error) {
      outcome.code = reportError(error, json)
    }
  })

  return command
}

function buildRequest(
  kind: MediaKind,
  promptParts: string[],
  options: GenerateOptions,
): GenerationRequest {
  const prompt = promptParts.join(' ').trim()
  if (prompt.length === 0) {
    throw new MediagenError(ERROR_CODE.VALIDATION_ERROR, 'A prompt is required.', {
      hint: `Provide it as an argument: mediagen ${kind} "a red bicycle"`,
    })
  }

  return {
    prompt,
    kind,
    ...nonEmpty('provider', options.provider, 'provider'),
    ...nonEmpty('model', options.model, 'model'),
    ...nonEmpty('input', options.input, 'inputMedia'),
    ...nonEmpty('aspect-ratio', options.aspectRatio, 'aspectRatio'),
    ...nonEmpty('size', options.size, 'size'),
    ...nonEmpty('output-name', options.outputName, 'outputName'),
    ...nonEmpty('output-dir', options.outputDir, 'outputDir'),
    ...quality(options.quality),
    ...(options.duration === undefined ? {} : { duration: options.duration }),
  }
}

/**
 * An option present but empty is a mistake worth naming. `--output-dir ""`
 * silently meaning "the default" is how a file ends up somewhere nobody looks.
 */
function nonEmpty<K extends string>(
  flag: string,
  value: string | undefined,
  field: K,
): Partial<Record<K, string>> {
  if (value === undefined) return {}

  if (value.trim().length === 0) {
    throw new MediagenError(ERROR_CODE.VALIDATION_ERROR, `--${flag} cannot be empty.`, {
      hint: `Pass a value, or drop --${flag}.`,
    })
  }

  return { [field]: value } as Partial<Record<K, string>>
}

function quality(value: string | undefined) {
  if (value === undefined) return {}

  if (!isQualityPreset(value)) {
    throw new MediagenError(ERROR_CODE.VALIDATION_ERROR, `Unknown quality preset "${value}".`, {
      hint: `Use one of: ${QUALITY_PRESETS.join(', ')}.`,
    })
  }

  return { quality: value }
}

function parsePositiveNumber(raw: string): number {
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new MediagenError(
      ERROR_CODE.VALIDATION_ERROR,
      `--duration must be a positive number of seconds, got "${raw}".`,
      { hint: 'For example: --duration 5' },
    )
  }
  return parsed
}
