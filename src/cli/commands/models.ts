/**
 * `mediagen models` — what can be used right now, and what would be.
 *
 * This is the call to make before generating anything. Per provider it answers
 * four things: whether it can do this kind of media, whether there is a key
 * for it, where it sits in the user's preference order, and which model a
 * request would actually use. With more than thirty models reachable through a
 * single aggregator, none of those stay answerable from memory.
 *
 * Providers that cannot be used are listed, not hidden. An agent that is told
 * OpenAI is unconfigured can suggest adding a key; an agent shown a list with
 * OpenAI missing concludes it does not exist. Hiding them also invites picking
 * a model that cannot run, which is the failure this command exists to
 * prevent.
 *
 * The model listing is not a menu of the only valid choices. An id absent from
 * it is still sent to the provider.
 */

import { Command } from 'commander'
import { ERROR_CODE, EXIT_CODE, MediagenError, type ExitCode } from '../../core/errors.js'
import { loadConfig, providerOrder, providerStandings } from '../../config/resolve.js'
import { LAYER_LABEL } from '../../config/layers.js'
import { command } from '../../core/invocation.js'
import { resolveModel } from '../../core/pipeline.js'
import { requireProvider } from '../../providers/registry.js'
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
  /** A key exists. Not a claim that it works — that is `mediagen doctor`. */
  readonly configured: boolean
  /** Configured and able to do this kind: safe to send a request to. */
  readonly usable: boolean
  /** Which layer supplied the key. */
  readonly keyLayer?: string
  /** Position in the preference order, 1 first. */
  readonly rank: number
  /** Named in the priority list rather than merely following it. */
  readonly preferred: boolean
  /** What to run to make an unconfigured provider usable. */
  readonly fix?: string
  readonly effectiveModel?: string
  readonly source?: string
  readonly configuredLayer?: string
  readonly listed: readonly ModelDescriptor[]
}

function report(options: ModelsOptions): ExitCode {
  const json = options.json === true
  const kind = resolveKind(options.kind)
  const config = loadConfig()

  // Preference order, so the first entry is the one a request would get.
  const standings = providerStandings(config, kind).filter(
    (standing) =>
      options.provider === undefined ||
      standing.provider.id === requireProvider(options.provider).id,
  )

  const reports: ProviderReport[] = standings.map((standing, index) => {
    const { provider } = standing
    const common = {
      provider: provider.id,
      label: provider.label,
      supportsKind: standing.supportsKind,
      configured: standing.configured,
      usable: standing.usable,
      ...(standing.keyLayer === undefined ? {} : { keyLayer: LAYER_LABEL[standing.keyLayer] }),
      rank: index + 1,
      preferred: standing.preferred,
      ...(standing.configured ? {} : { fix: command(`config set ${provider.id}`) }),
    }

    if (!standing.supportsKind) {
      return { ...common, listed: [] }
    }

    const { model, source } = resolveModel({ kind }, provider, config, config.quality.value)
    const configuredModel = config.model(provider.id)

    return {
      ...common,
      effectiveModel: model,
      source,
      ...(configuredModel === undefined
        ? {}
        : { configuredLayer: LAYER_LABEL[configuredModel.layer] }),
      listed: provider.listModels(kind),
    }
  })

  if (json) {
    const usable = reports.filter((entry) => entry.usable)
    writeJson({
      success: true,
      kind,
      // Stated outright so a caller does not have to derive it from the list.
      // This is the field that decides what an agent may actually run.
      wouldUse:
        usable[0] === undefined
          ? null
          : { provider: usable[0].provider, model: usable[0].effectiveModel },
      usableProviders: usable.map((entry) => entry.provider),
      providerPriority: providerOrder(config),
      providerPriorityLayer: LAYER_LABEL[config.providerPriority.layer],
      providers: reports,
    })
    return EXIT_CODE.SUCCESS
  }

  for (const entry of reports) {
    writeLine(`${entry.rank}. ${entry.label} (${entry.provider})${standingNote(entry)}`)

    if (!entry.supportsKind) {
      writeLine(`  Does not generate ${kind}.`)
      writeLine()
      continue
    }

    if (!entry.configured) {
      writeLine(`  No key configured, so requests to it fail. Fix: ${entry.fix}`)
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

  const usable = reports.filter((entry) => entry.usable)
  writeLine(
    usable[0] === undefined
      ? `Nothing can generate ${kind} right now: no configured provider supports it.`
      : `A request with no --provider uses ${usable[0].provider}/${usable[0].effectiveModel}.`,
  )
  writeLine('A model absent from these lists is still sent to the provider.')
  return EXIT_CODE.SUCCESS
}

/** Why a provider sits where it does, when that is not obvious. */
function standingNote(entry: ProviderReport): string {
  const notes: string[] = []
  if (entry.preferred) notes.push('preferred')
  if (!entry.configured) notes.push('no key')
  else if (entry.keyLayer !== undefined) notes.push(`key from ${entry.keyLayer}`)

  return notes.length === 0 ? '' : `  [${notes.join(', ')}]`
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
