/**
 * `mediagen models` (§7.2).
 *
 * Three things per provider: the model a request would use *right now*, where
 * that choice came from, and what is listed. The middle one is the reason this
 * command exists at all — with more than thirty models reachable through a
 * single aggregator, "which model did I just use, and why" stops being
 * answerable from memory.
 *
 * The listing is not a menu of the only valid choices (§7.3). An id absent
 * from it is still sent to the provider.
 */

import { Command } from 'commander'
import { ERROR_CODE, EXIT_CODE, MediagenError, type ExitCode } from '../../core/errors.js'
import { loadConfig } from '../../config/resolve.js'
import { LAYER_LABEL } from '../../config/layers.js'
import { resolveModel } from '../../core/pipeline.js'
import { PROVIDERS, requireProvider } from '../../providers/registry.js'
import { MEDIA_KINDS, isMediaKind } from '../../types/media.js'
import { reportError, writeJson, writeLine, type Outcome } from '../output.js'
import type { MediaKind } from '../../types/media.js'
import type { ModelDescriptor } from '../../types/provider.js'

interface ModelsOptions {
  provider?: string
  kind?: string
  all?: boolean
  json?: boolean
}

export function buildModelsCommand(outcome: Outcome): Command {
  return new Command('models')
    .description("Show each provider's models, and which one a request would use")
    .option('--provider <name>', 'limit to one provider')
    .option('--kind <kind>', `one of: ${MEDIA_KINDS.join(', ')}`, 'image')
    .option('--all', 'list every model, not just a sample')
    .option('--json', 'emit exactly one JSON object on stdout')
    .exitOverride()
    .addHelpText(
      'after',
      `
A model absent from these lists is still sent to the provider. The lists drive
the defaults, the error hints, and this output — they are not a gate.`,
    )
    .action((options: ModelsOptions) => {
      try {
        outcome.code = report(options)
      } catch (error) {
        outcome.code = reportError(error, options.json === true)
      }
    })
}

/** How many to print per provider before summarising, unless --all. */
const SAMPLE = 12

interface ProviderReport {
  readonly provider: string
  readonly label: string
  readonly supportsKind: boolean
  readonly effectiveModel?: string
  readonly source?: string
  readonly configuredLayer?: string
  readonly listed: readonly ModelDescriptor[]
}

function report(options: ModelsOptions): ExitCode {
  const json = options.json === true
  const kind = resolveKind(options.kind)
  const config = loadConfig()

  const providers = options.provider === undefined ? PROVIDERS : [requireProvider(options.provider)]

  const reports: ProviderReport[] = providers.map((provider) => {
    if (!provider.kinds.includes(kind)) {
      return {
        provider: provider.id,
        label: provider.label,
        supportsKind: false,
        listed: [],
      }
    }

    const quality = config.quality.value
    const { model, source } = resolveModel({ kind }, provider, config, quality)
    const configured = config.model(provider.id)

    return {
      provider: provider.id,
      label: provider.label,
      supportsKind: true,
      effectiveModel: model,
      source,
      ...(configured === undefined ? {} : { configuredLayer: LAYER_LABEL[configured.layer] }),
      listed: provider.listModels(kind),
    }
  })

  if (json) {
    writeJson({ success: true, kind, providers: reports })
    return EXIT_CODE.SUCCESS
  }

  for (const entry of reports) {
    writeLine(`${entry.label} (${entry.provider})`)

    if (!entry.supportsKind) {
      writeLine(`  Does not generate ${kind}.`)
      writeLine()
      continue
    }

    const from =
      entry.configuredLayer === undefined
        ? entry.source
        : `${entry.source} — ${entry.configuredLayer}`
    writeLine(`  Would use: ${entry.effectiveModel}  (${from})`)

    const shown = options.all === true ? entry.listed : entry.listed.slice(0, SAMPLE)
    for (const model of shown) {
      writeLine(`    ${describe(model)}`)
    }

    const hidden = entry.listed.length - shown.length
    if (hidden > 0) {
      writeLine(`    … and ${hidden} more (--all to list them)`)
    }

    writeLine()
  }

  writeLine('A model absent from these lists is still sent to the provider.')
  return EXIT_CODE.SUCCESS
}

function describe(model: ModelDescriptor): string {
  const facts: string[] = []
  if (model.aspectRatios) {
    const count = model.aspectRatios.length
    facts.push(`${count} ratio${count === 1 ? '' : 's'}`)
  }
  if (model.sizes) facts.push(model.sizes.join('/'))
  if (model.acceptsInputMedia === true) facts.push('edits')
  if (model.note !== undefined) facts.push(model.note)

  return facts.length > 0 ? `${model.id}  — ${facts.join(', ')}` : model.id
}

function resolveKind(raw: string | undefined): MediaKind {
  if (raw === undefined) return 'image'
  if (isMediaKind(raw)) return raw

  throw new MediagenError(ERROR_CODE.VALIDATION_ERROR, `Unknown media kind "${raw}".`, {
    hint: `Use one of: ${MEDIA_KINDS.join(', ')}.`,
  })
}
