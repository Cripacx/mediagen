/**
 * OpenAI's image models.
 *
 * The model ids, sizes and quality values come from the `openai` package's own
 * `ImageModel` and `ImageGenerateParams` declarations rather than from prose
 * documentation — the same reasoning as the Gemini catalogue, and the same
 * benefit: the vendor's types are versioned with the API.
 *
 * **OpenAI has no aspect-ratio parameter.** It takes pixel dimensions. So the
 * ratios listed here are exactly those its sizes actually produce, and the
 * client translates a requested ratio into the matching size. Listing 16:9
 * would be a lie: OpenAI's widest image is 1536×1024, which is 3:2, and
 * dall-e-3's 1792×1024, which is 7:4. Neither is 16:9, and a user who asked
 * for one shape and received another has been lied to by the tool.
 *
 * None of this is a gate. An unlisted model id is still sent.
 */

import type { ModelDescriptor } from '../../types/provider.js'
import type { QualityPreset } from '../../types/media.js'

/** Pixel sizes keyed by the ratio they actually are. */
export const GPT_IMAGE_SIZES: Readonly<Record<string, string>> = {
  '1:1': '1024x1024',
  '3:2': '1536x1024',
  '2:3': '1024x1536',
}

export const DALL_E_3_SIZES: Readonly<Record<string, string>> = {
  '1:1': '1024x1024',
  '7:4': '1792x1024',
  '4:7': '1024x1792',
}

export const DALL_E_2_SIZES: Readonly<Record<string, string>> = {
  '1:1': '1024x1024',
}

const GPT_IMAGE_SHAPE = {
  kind: 'image',
  aspectRatios: Object.keys(GPT_IMAGE_SIZES),
  sizes: Object.values(GPT_IMAGE_SIZES),
  acceptsInputMedia: true,
} as const

export const OPENAI_IMAGE_MODELS = [
  {
    id: 'gpt-image-2',
    ...GPT_IMAGE_SHAPE,
    note: 'Newest of the gpt-image family.',
  },
  {
    id: 'gpt-image-1.5',
    ...GPT_IMAGE_SHAPE,
    note: 'Strong instruction following.',
  },
  {
    id: 'gpt-image-1',
    ...GPT_IMAGE_SHAPE,
    note: 'Established, widely available.',
  },
  {
    id: 'gpt-image-1-mini',
    ...GPT_IMAGE_SHAPE,
    note: 'Cheapest and fastest of the family.',
  },
  {
    id: 'dall-e-3',
    kind: 'image',
    aspectRatios: Object.keys(DALL_E_3_SIZES),
    sizes: Object.values(DALL_E_3_SIZES),
    acceptsInputMedia: false,
    note: 'Older; cannot edit an input image.',
  },
  {
    id: 'dall-e-2',
    kind: 'image',
    aspectRatios: Object.keys(DALL_E_2_SIZES),
    sizes: ['256x256', '512x512', '1024x1024'],
    acceptsInputMedia: true,
    note: 'Legacy. Square only.',
  },
] as const satisfies readonly ModelDescriptor[]

/** Which size table a model uses; unlisted models get the modern one. */
export function sizeTableFor(model: string): Readonly<Record<string, string>> {
  if (model.startsWith('dall-e-3')) return DALL_E_3_SIZES
  if (model.startsWith('dall-e-2')) return DALL_E_2_SIZES
  return GPT_IMAGE_SIZES
}

/** Provider-internal, and does not leak into the shared interface. */
export function defaultImageModel(quality: QualityPreset): string {
  switch (quality) {
    case 'quality':
      return 'gpt-image-2'
    case 'balanced':
      return 'gpt-image-1.5'
    case 'fast':
      return 'gpt-image-1-mini'
  }
}

/**
 * The `quality` value the API takes. The gpt-image family and dall-e-3 use
 * different vocabularies for the same idea, which is exactly the sort of
 * vendor detail that must stay inside the provider.
 */
export function apiQuality(model: string, preset: QualityPreset): string {
  if (model.startsWith('dall-e-3')) {
    return preset === 'quality' ? 'hd' : 'standard'
  }
  if (model.startsWith('dall-e-2')) {
    return 'standard'
  }
  switch (preset) {
    case 'quality':
      return 'high'
    case 'balanced':
      return 'medium'
    case 'fast':
      return 'low'
  }
}
