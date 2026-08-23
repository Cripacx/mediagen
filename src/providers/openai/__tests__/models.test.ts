/**
 * OpenAI's size vocabulary.
 *
 * OpenAI takes pixel dimensions where every other provider here takes an
 * aspect ratio, so this is the one provider whose catalogue has to make a
 * claim about geometry. These tests hold that claim to being true.
 */

import { describe, expect, it } from 'vitest'
import {
  DALL_E_3_SIZES,
  GPT_IMAGE_SIZES,
  OPENAI_IMAGE_MODELS,
  apiQuality,
  defaultImageModel,
  sizeTableFor,
} from '../models.js'
import { findModel, validateAgainst } from '../../../core/capabilities.js'
import type { GenerationRequest } from '../../../types/media.js'

function request(overrides: Partial<GenerationRequest> = {}): GenerationRequest {
  return { prompt: 'a cat', kind: 'image', ...overrides }
}

/** Ratio strings are exact; a size that is not that ratio is a false claim. */
function ratioOf(size: string): number {
  const [width, height] = size.split('x').map(Number)
  return width! / height!
}

function declared(ratio: string): number {
  const [width, height] = ratio.split(':').map(Number)
  return width! / height!
}

describe('every listed ratio is the ratio its size actually is', () => {
  it('holds for the gpt-image family', () => {
    for (const [ratio, size] of Object.entries(GPT_IMAGE_SIZES)) {
      expect(ratioOf(size), `${ratio} -> ${size}`).toBeCloseTo(declared(ratio), 5)
    }
  })

  it('holds for dall-e-3', () => {
    for (const [ratio, size] of Object.entries(DALL_E_3_SIZES)) {
      expect(ratioOf(size), `${ratio} -> ${size}`).toBeCloseTo(declared(ratio), 5)
    }
  })

  it('does not claim 16:9, which OpenAI cannot produce', () => {
    // Its widest images are 3:2 and 7:4. Listing 16:9 and quietly serving 3:2
    // is precisely the substitution capability validation forbids.
    for (const model of OPENAI_IMAGE_MODELS) {
      expect(model.aspectRatios, model.id).not.toContain('16:9')
    }
  })

  it('rejects 16:9 by name, listing what the model can do', () => {
    const model = findModel(OPENAI_IMAGE_MODELS, 'gpt-image-2')

    expect(() => {
      validateAgainst(request({ aspectRatio: '16:9' }), 'gpt-image-2', model)
    }).toThrow(/does not support the aspect ratio 16:9.*1:1, 3:2, 2:3/)
  })
})

describe('size table selection', () => {
  it('gives each model family its own table', () => {
    expect(sizeTableFor('dall-e-3')).toBe(DALL_E_3_SIZES)
    expect(sizeTableFor('gpt-image-2')).toBe(GPT_IMAGE_SIZES)
  })

  it('gives an unlisted model the modern table rather than failing', () => {
    expect(sizeTableFor('gpt-image-9-future')).toBe(GPT_IMAGE_SIZES)
  })
})

describe('quality vocabulary stays inside the provider', () => {
  it('translates the shared preset into each family’s own words', () => {
    expect(apiQuality('gpt-image-2', 'fast')).toBe('low')
    expect(apiQuality('gpt-image-2', 'quality')).toBe('high')
    // dall-e-3 spells the same idea differently, which is why this mapping is
    // the provider's business and not the pipeline's.
    expect(apiQuality('dall-e-3', 'quality')).toBe('hd')
    expect(apiQuality('dall-e-3', 'fast')).toBe('standard')
  })

  it('offers a default model for every preset, and lists it', () => {
    const listed = OPENAI_IMAGE_MODELS.map((model) => model.id)

    for (const preset of ['fast', 'balanced', 'quality'] as const) {
      expect(listed).toContain(defaultImageModel(preset))
    }
  })
})

describe('editing capability', () => {
  it('refuses input media for dall-e-3, which cannot edit', () => {
    const model = findModel(OPENAI_IMAGE_MODELS, 'dall-e-3')

    expect(() => {
      validateAgainst(request({ inputMedia: './a.png' }), 'dall-e-3', model)
    }).toThrow(/cannot take input media/)
  })

  it('accepts input media for the gpt-image family', () => {
    const model = findModel(OPENAI_IMAGE_MODELS, 'gpt-image-1')

    expect(() => {
      validateAgainst(request({ inputMedia: './a.png' }), 'gpt-image-1', model)
    }).not.toThrow()
  })
})
