/**
 * The domain vocabulary, kept as a leaf module.
 *
 * Provider metadata, the layered config loader and the pipeline all refer to
 * these types, so they must not import any of them back. Everything here is
 * plain data with no behaviour attached.
 *
 * Spec §2.
 */

/**
 * Spec §2.1 — kind is a dimension, not a fork. A provider declares which kinds
 * it supports and everything downstream branches on that data.
 */
export const MEDIA_KINDS = ['image', 'video'] as const
export type MediaKind = (typeof MEDIA_KINDS)[number]

/** Spec §2.2 — trades speed and cost against fidelity. */
export const QUALITY_PRESETS = ['fast', 'balanced', 'quality'] as const
export type QualityPreset = (typeof QUALITY_PRESETS)[number]

/**
 * Spec §2.2. Every field beyond `prompt` and `kind` is an override: absent
 * means "resolve it from configuration", never "use the zero value".
 */
export interface GenerationRequest {
  /** What to generate. */
  readonly prompt: string
  readonly kind: MediaKind
  /** Overrides the configured default provider, per request. */
  readonly provider?: string
  /** Overrides the provider's configured or built-in model. */
  readonly model?: string
  /** Source media for editing or transformation. */
  readonly inputMedia?: string
  /** e.g. `1:1`, `16:9`, `9:16`. */
  readonly aspectRatio?: string
  /** e.g. `1K`, `2K`, `4K`. */
  readonly size?: string
  /** Video only, in seconds. */
  readonly duration?: number
  /** Output file name; its extension may select the format. */
  readonly outputName?: string
  readonly outputDir?: string
  readonly quality?: QualityPreset
  /** Defaults to on; see §5. */
  readonly enhancePrompt?: boolean
  /** Machine-readable AI marking (§9). */
  readonly mark?: boolean
  /** Visible AI disclosure (§9). */
  readonly visibleLabel?: boolean
}

/**
 * Spec §2.3. The pipeline returns this; each frontend renders it in its own
 * format. `revisedPrompt` and `requestId` are present only where the provider
 * returned one.
 */
export interface GenerationResult {
  readonly filePath: string
  readonly kind: MediaKind
  readonly provider: string
  readonly model: string
  readonly mimeType: string
  readonly revisedPrompt?: string
  readonly requestId?: string
}

export function isMediaKind(value: unknown): value is MediaKind {
  return MEDIA_KINDS.includes(value as MediaKind)
}

export function isQualityPreset(value: unknown): value is QualityPreset {
  return QUALITY_PRESETS.includes(value as QualityPreset)
}
