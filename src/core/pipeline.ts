/**
 * The one pipeline.
 *
 * Spec §1.2 — the CLI and the MCP server are thin adapters over this: they
 * translate input and format output and do nothing else. A behaviour that
 * exists in one and not the other is a defect, and the only way to keep that
 * true is for neither of them to contain any behaviour at all.
 *
 * The order of the steps below is load-bearing. §6.3 requires capability
 * validation to happen before any network call, and §3.3 requires credentials
 * to be checked when a provider is actually used rather than eagerly. Both are
 * satisfied by validating shape first, resolving the key second, and only then
 * loading a client.
 */

import { loadGenerationClient, requireKindSupport, requireProvider } from '../providers/registry.js'
import { requireApiKey } from '../config/resolve.js'
import { markFile } from '../marking/mark.js'
import { defaultStem, saveMedia } from './output.js'
import type { GenerationRequest, GenerationResult, QualityPreset } from '../types/media.js'
import type { Logger, ProviderManifest } from '../types/provider.js'
import type { ResolvedConfig } from '../types/config.js'

export interface PipelineOptions {
  readonly config: ResolvedConfig
  readonly log: Logger
  readonly signal?: AbortSignal
  /** Injected so output names are deterministic in tests. */
  readonly now?: () => Date
}

/** How a model was chosen, for `mediagen models` and for diagnostics (§7.2). */
export type ModelSource = 'request' | 'configuration' | 'provider default'

export interface ResolvedModel {
  readonly model: string
  readonly source: ModelSource
}

/**
 * Spec §7.1 — provider-neutral, and in this order: what the request asked for,
 * what is configured for that provider, then the provider's own default.
 */
export function resolveModel(
  request: Pick<GenerationRequest, 'model' | 'kind'>,
  provider: ProviderManifest,
  config: ResolvedConfig,
  quality: QualityPreset,
): ResolvedModel {
  if (request.model !== undefined) {
    return { model: request.model, source: 'request' }
  }

  const configured = config.model(provider.id)
  if (configured) {
    return { model: configured.value, source: 'configuration' }
  }

  return { model: provider.defaultModel(request.kind, quality), source: 'provider default' }
}

export async function generate(
  request: GenerationRequest,
  options: PipelineOptions,
): Promise<GenerationResult> {
  const { config, log } = options

  const provider = requireProvider(request.provider ?? config.defaultProvider.value)
  requireKindSupport(provider, request.kind)

  const quality = request.quality ?? config.quality.value
  const { model, source } = resolveModel(request, provider, config, quality)
  log.debug(`model ${model} (from ${source})`)

  // §6.3 — before anything is sent, and before a key is even needed.
  provider.validate(request, model)

  // §3.3 — validated here, where the provider is actually used.
  const apiKey = requireApiKey(config, provider)

  const client = await loadGenerationClient(provider, request.kind)

  const media = await client.generate(request, {
    apiKey,
    model,
    log,
    ...(options.signal ? { signal: options.signal } : {}),
  })

  const now = options.now ?? (() => new Date())
  const saved = await saveMedia(media.data, {
    outputDir: request.outputDir ?? config.outputDir.value,
    ...(request.outputName === undefined ? {} : { outputName: request.outputName }),
    fallbackStem: defaultStem(request.kind, now()),
    mimeType: media.mimeType,
    log,
  })

  // §9 — marking happens after the file exists and before the path is
  // reported, so a caller that reads the path always gets a marked file.
  // Both switches default to off.
  if (request.mark === true || request.visibleLabel === true) {
    const marking = await markFile(
      saved.filePath,
      { machineReadable: request.mark === true, visibleLabel: request.visibleLabel === true },
      { provider: provider.id, model },
    )

    if (marking.alreadyMarked && request.mark === true) {
      log.info(`${provider.label} already declared a digital source type; left as it was.`)
    }
  }

  return {
    filePath: saved.filePath,
    kind: request.kind,
    provider: provider.id,
    model,
    mimeType: saved.mimeType,
    // §2.3 — present only where the provider rewrote the prompt itself. This
    // tool no longer rewrites prompts; see the note on §5 in the README.
    ...(media.revisedPrompt === undefined ? {} : { revisedPrompt: media.revisedPrompt }),
    ...(media.requestId === undefined ? {} : { requestId: media.requestId }),
  }
}
