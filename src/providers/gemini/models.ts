/**
 * Google's image models.
 *
 * Spec §7.3 — this is not a gate. An id absent from here is still sent to
 * Google; the list drives defaults, hints and `mediagen models`.
 *
 * The accepted values come from `@google/genai`'s own
 * `ImageResponseFormatAspectRatio` and `ImageResponseFormatImageSize`, not
 * from the prose documentation, which publishes no exhaustive table. Those
 * types end in `(string & {})` — the vendor itself treats the list as a hint
 * rather than a closed set, which is §7.3's position arrived at independently.
 *
 * Taking them from the SDK also caught a real error: the prose calls the
 * smallest size `512px`, the API calls it `512`. Hand-copying it would have
 * rejected a valid request with a confident wrong reason.
 *
 * Which model accepts which subset is still not documented per model, so the
 * per-model split below follows the prose (§7.4's drift check is the
 * mitigation, not a guessed-at longer list).
 *
 * Sources: https://ai.google.dev/gemini-api/docs/image-generation and the
 * type declarations shipped in @google/genai.
 */

import type { ModelDescriptor } from '../../types/provider.js'
import type { QualityPreset } from '../../types/media.js'

/** Documented for the Gemini image models generally. */
const BASE_ASPECT_RATIOS = [
  '1:1',
  '2:3',
  '3:2',
  '3:4',
  '4:3',
  '4:5',
  '5:4',
  '9:16',
  '16:9',
  '21:9',
] as const

/** Gemini 3.1 Flash Image adds these panoramic and column ratios. */
const EXTENDED_ASPECT_RATIOS = [...BASE_ASPECT_RATIOS, '1:4', '4:1', '1:8', '8:1'] as const

export const GEMINI_IMAGE_MODELS = [
  {
    id: 'gemini-3.1-flash-image',
    kind: 'image',
    aspectRatios: EXTENDED_ASPECT_RATIOS,
    sizes: ['512', '1K', '2K', '4K'],
    acceptsInputMedia: true,
    note: 'Nano Banana 2. Fast, high volume.',
  },
  {
    id: 'gemini-3-pro-image',
    kind: 'image',
    aspectRatios: BASE_ASPECT_RATIOS,
    sizes: ['1K', '2K', '4K'],
    acceptsInputMedia: true,
    note: 'Nano Banana Pro. Reasons about complex instructions; slower.',
  },
  {
    id: 'gemini-2.5-flash-image',
    kind: 'image',
    aspectRatios: BASE_ASPECT_RATIOS,
    sizes: ['1K', '2K', '4K'],
    acceptsInputMedia: true,
    note: 'Nano Banana. Low latency.',
  },
] as const satisfies readonly ModelDescriptor[]

/**
 * Spec §7.1 step 3. Deriving the default from the quality preset is a
 * provider-internal decision and does not leak into the shared interface.
 */
export function defaultImageModel(quality: QualityPreset): string {
  switch (quality) {
    case 'quality':
      return 'gemini-3-pro-image'
    case 'balanced':
    case 'fast':
      return 'gemini-3.1-flash-image'
  }
}

/** Used for prompt enhancement (§5), never for media. */
export const GEMINI_TEXT_MODEL = 'gemini-3.5-flash'
