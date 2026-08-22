/**
 * `mediagen image` and `mediagen video`.
 *
 * Spec §2.1 — kind is a dimension, not a fork. Both subcommands are this one
 * function with a different `kind`, so an option can never exist for images
 * and quietly not for video.
 */

import { parseArgs } from 'node:util'
import { ERROR_CODE, EXIT_CODE, MediagenError, type ExitCode } from '../../core/errors.js'
import { createLogger } from '../../core/logger.js'
import { generate } from '../../core/pipeline.js'
import { loadConfig } from '../../config/resolve.js'
import { PROVIDER_IDS } from '../../providers/registry.js'
import { QUALITY_PRESETS } from '../../types/media.js'
import { reportError, reportResult, writeLine } from '../output.js'
import type { GenerationRequest, MediaKind } from '../../types/media.js'

const OPTIONS = {
  provider: { type: 'string' },
  model: { type: 'string' },
  input: { type: 'string' },
  'aspect-ratio': { type: 'string' },
  size: { type: 'string' },
  duration: { type: 'string' },
  'output-name': { type: 'string' },
  'output-dir': { type: 'string' },
  quality: { type: 'string' },
  'no-enhance': { type: 'boolean' },
  purpose: { type: 'string' },
  'maintain-character': { type: 'boolean' },
  'blend-elements': { type: 'boolean' },
  'real-world-accuracy': { type: 'boolean' },
  mark: { type: 'boolean' },
  'visible-label': { type: 'boolean' },
  json: { type: 'boolean' },
  verbose: { type: 'boolean' },
  quiet: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const

function help(kind: MediaKind): string {
  const durationRow = kind === 'video' ? '  --duration <seconds>       Length of the clip\n' : ''

  return `
Generate ${kind === 'image' ? 'an image' : 'a video'} from a text prompt.

Usage:
  mediagen ${kind} <prompt> [options]

Options:
  --provider <name>          ${PROVIDER_IDS.join(', ')} (default: MEDIAGEN_PROVIDER)
  --model <id>               Model for the chosen provider (see: mediagen models)
  --input <path>             Source media to edit or transform
  --aspect-ratio <ratio>     e.g. 1:1, 16:9, 9:16
  --size <size>              e.g. 1K, 2K, 4K
${durationRow}  --output-name <name>       Output file name; its extension may select the format
  --output-dir <dir>         Directory to save into (default: MEDIAGEN_OUTPUT_DIR)
  --quality <preset>         ${QUALITY_PRESETS.join(', ')}
  --no-enhance               Send the prompt through unchanged
  --purpose <text>           Intended use; steers how the prompt is expanded
  --maintain-character       Keep a character's appearance consistent
  --blend-elements           Compose several elements into one coherent scene
  --real-world-accuracy      Prefer checkable detail over evocative language
  --mark                     Write the machine-readable AI-generated marker
  --visible-label            Composite a visible AI disclosure into the media
  --json                     Emit exactly one JSON object on stdout
  --verbose                  Diagnostics on stderr
  --quiet                    Suppress progress on stderr
  --help, -h                 Show this help

Exit codes:
  0 success   2 invalid input   3 configuration   4 generation or I/O failure

Examples:
  mediagen ${kind} "a red bicycle in the rain"
  mediagen ${kind} "a logo" --provider gemini --output-name logo.png
  mediagen ${kind} "a banner" --aspect-ratio 16:9 --json
`
}

export async function runGenerate(kind: MediaKind, argv: string[]): Promise<ExitCode> {
  // `--json` is read before parsing so that a parse failure is still reported
  // in the format the caller asked for.
  const wantsJson = argv.includes('--json')

  let values: Record<string, string | boolean | undefined>
  let positionals: string[]
  try {
    ;({ values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true }))
  } catch (error) {
    return reportError(
      new MediagenError(ERROR_CODE.VALIDATION_ERROR, (error as Error).message, {
        hint: `Run: mediagen ${kind} --help`,
      }),
      wantsJson,
    )
  }

  const json = values['json'] === true

  if (values['help'] === true) {
    writeLine(help(kind).trim())
    return EXIT_CODE.SUCCESS
  }

  try {
    const request = buildRequest(kind, values, positionals)

    const log = createLogger({
      verbose: values['verbose'] === true,
      // In `--json` mode the object on stdout is the whole answer, so progress
      // chatter on stderr is noise unless it was asked for.
      quiet: values['quiet'] === true || (json && values['verbose'] !== true),
    })

    const result = await generate(request, { config: loadConfig(), log })
    return reportResult(result, json)
  } catch (error) {
    return reportError(error, json)
  }
}

function buildRequest(
  kind: MediaKind,
  values: Record<string, string | boolean | undefined>,
  positionals: string[],
): GenerationRequest {
  const prompt = positionals.join(' ').trim()
  if (prompt.length === 0) {
    throw new MediagenError(ERROR_CODE.VALIDATION_ERROR, 'A prompt is required.', {
      hint: `Provide it as an argument: mediagen ${kind} "a red bicycle"`,
    })
  }

  return {
    prompt,
    kind,
    ...optionalString(values, 'provider', 'provider'),
    ...optionalString(values, 'model', 'model'),
    ...optionalString(values, 'input', 'inputMedia'),
    ...optionalString(values, 'aspect-ratio', 'aspectRatio'),
    ...optionalString(values, 'size', 'size'),
    ...optionalString(values, 'output-name', 'outputName'),
    ...optionalString(values, 'output-dir', 'outputDir'),
    ...quality(values),
    ...duration(values, kind),
    ...optionalString(values, 'purpose', 'purpose'),
    ...(values['no-enhance'] === true ? { enhancePrompt: false } : {}),
    ...(values['maintain-character'] === true ? { maintainCharacter: true } : {}),
    ...(values['blend-elements'] === true ? { blendElements: true } : {}),
    ...(values['real-world-accuracy'] === true ? { realWorldAccuracy: true } : {}),
    ...(values['mark'] === true ? { mark: true } : {}),
    ...(values['visible-label'] === true ? { visibleLabel: true } : {}),
  }
}

/**
 * An option present but empty is a mistake worth naming. `--output-dir ""`
 * silently meaning "the default" is how a file ends up somewhere the user
 * never looks.
 */
function optionalString<K extends string>(
  values: Record<string, string | boolean | undefined>,
  flag: string,
  field: K,
): Partial<Record<K, string>> {
  const raw = values[flag]
  if (typeof raw !== 'string') return {}

  if (raw.trim().length === 0) {
    throw new MediagenError(ERROR_CODE.VALIDATION_ERROR, `--${flag} cannot be empty.`, {
      hint: `Pass a value, or drop --${flag}.`,
    })
  }

  return { [field]: raw } as Partial<Record<K, string>>
}

function quality(values: Record<string, string | boolean | undefined>) {
  const raw = values['quality']
  if (typeof raw !== 'string') return {}

  const match = QUALITY_PRESETS.find((preset) => preset === raw)
  if (!match) {
    throw new MediagenError(ERROR_CODE.VALIDATION_ERROR, `Unknown quality preset "${raw}".`, {
      hint: `Use one of: ${QUALITY_PRESETS.join(', ')}.`,
    })
  }

  return { quality: match }
}

function duration(values: Record<string, string | boolean | undefined>, kind: MediaKind) {
  const raw = values['duration']
  if (typeof raw !== 'string') return {}

  if (kind !== 'video') {
    throw new MediagenError(ERROR_CODE.VALIDATION_ERROR, '--duration applies to video only.', {
      hint: 'Use: mediagen video "…" --duration 5',
    })
  }

  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new MediagenError(
      ERROR_CODE.VALIDATION_ERROR,
      `--duration must be a positive number of seconds, got "${raw}".`,
      {
        hint: 'For example: --duration 5',
      },
    )
  }

  return { duration: parsed }
}
