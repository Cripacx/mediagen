/**
 * The one pipeline.
 *
 * The CLI and the MCP server are thin adapters over this: they
 * translate input and format output and do nothing else. A behaviour that
 * exists in one and not the other is a defect, and the only way to keep that
 * true is for neither of them to contain any behaviour at all.
 *
 * The order of the steps below is load-bearing. Capability validation has to
 * happen before any network call, and credentials have to be checked when a
 * provider is actually used rather than eagerly. Both are
 * satisfied by validating shape first, resolving the key second, and only then
 * loading a client.
 */

import {
  BUILT_IN_DEFAULT_PROVIDER,
  loadGenerationClient,
  requireKindSupport,
  requireProvider,
} from '../providers/registry.js'
import { preferredProvider, requireApiKey } from '../config/resolve.js'
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

/** How a model was chosen, for `mediagen models` and for diagnostics. */
export type ModelSource = 'request' | 'configuration' | 'provider default'

export interface ResolvedModel {
  readonly model: string
  readonly source: ModelSource
}

/**
 * Provider-neutral, and in this order: what the request asked for,
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

  // Naming a provider overrides everything. Otherwise the configured order
  // decides, skipping any provider that has no key — a missing key for a
  // preferred provider should cost that preference, not the request.
  const provider =
    request.provider === undefined
      ? (preferredProvider(config, request.kind) ?? requireProvider(BUILT_IN_DEFAULT_PROVIDER))
      : requireProvider(request.provider)

  requireKindSupport(provider, request.kind)

  const quality = request.quality ?? config.quality.value
  const { model, source } = resolveModel(request, provider, config, quality)
  log.debug(`model ${model} (from ${source})`)

  // Before anything is sent, and before a key is even needed.
  provider.validate(request, model)

  // Validated here, where the provider is actually used.
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

  // Generating does not mark. Marking is `mediagen mark`, run afterwards on
  // the file this returns.
  //
  // Both markers want something a generation cannot give them. The visible one
  // has to go where the subject is not, which only the finished image can
  // say. The machine-readable one is not free either: adding metadata means
  // decoding and re-encoding, so a lossy generation is marked at the cost of a
  // second encode — worth paying deliberately, not as a side effect of asking
  // for an image.
  //
  // Keeping them out of here also means one thing produces media and another
  // changes it, so a generation is never quietly a rewrite as well.

  return {
    filePath: saved.filePath,
    kind: request.kind,
    provider: provider.id,
    model,
    mimeType: saved.mimeType,
    // Present only where the provider rewrote the prompt itself. This
    // tool no longer rewrites prompts; see the note in the README.
    ...(media.revisedPrompt === undefined ? {} : { revisedPrompt: media.revisedPrompt }),
    ...(media.requestId === undefined ? {} : { requestId: media.requestId }),
  }
}
