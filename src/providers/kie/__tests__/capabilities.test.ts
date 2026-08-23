/**
 * Kie capability resolution.
 *
 * Kie is the provider that makes the input-media problem concrete: the same model name
 * routes to different ids for generation and editing, and the field carrying
 * input URLs is named differently per model.
 */

import { describe, expect, it } from 'vitest'
import { resolveKieRequest } from '../capabilities.js'
import { GENERATED_KIE_MODELS } from '../models.generated.js'
import { DEFAULT_KIE_MODEL, LISTED_KIE_MODELS, getKieModel, listKieModels } from '../models.js'
import { ERROR_CODE } from '../../../core/errors.js'
import type { GenerationRequest } from '../../../types/media.js'

function request(overrides: Partial<GenerationRequest> = {}): GenerationRequest {
  return { prompt: 'a cat', kind: 'image', ...overrides }
}

/** A listed model that can both generate and edit. */
function editableModel(): string {
  const found = LISTED_KIE_MODELS.find((name) => {
    const model = getKieModel(name)
    return model?.textToImage !== undefined && model.imageToImage !== undefined
  })
  if (!found) throw new Error('the generated table lists no editable model')
  return found
}

describe('the generated table', () => {
  it('is not empty', () => {
    // The generator refuses to write an empty table; this catches one being
    // committed by some other route.
    expect(LISTED_KIE_MODELS.length).toBeGreaterThan(0)
  })

  it('lists the default model', () => {
    expect(LISTED_KIE_MODELS).toContain(DEFAULT_KIE_MODEL)
  })

  it('gives every edit-capable model an input field name', () => {
    // Knowing a model can edit is useless without knowing what to call the
    // field. A descriptor with one and not the other would fail at request
    // time, in a way that reads like a Kie bug.
    for (const [name, shape] of Object.entries(GENERATED_KIE_MODELS)) {
      const model = shape as { imageToImage?: string; imageInputField?: string }
      if (model.imageToImage !== undefined) {
        expect(model.imageInputField, `${name} can edit but names no input field`).toBeDefined()
      }
    }
  })

  it('describes every listed model as an image model', () => {
    for (const descriptor of listKieModels()) {
      expect(descriptor.kind).toBe('image')
    }
  })
})

describe('route selection', () => {
  it('sends the generation id when there is no input media', () => {
    const name = editableModel()
    const resolved = resolveKieRequest(name, request())

    expect(resolved.modelId).toBe(getKieModel(name)?.textToImage)
  })

  it('sends the editing id when there is input media', () => {
    const name = editableModel()
    const resolved = resolveKieRequest(name, request({ inputMedia: './a.png' }))

    expect(resolved.modelId).toBe(getKieModel(name)?.imageToImage)
  })

  it('refuses to edit with a listed model that cannot, in the shared wording', () => {
    // The shared capability check owns this message, so a user sees the same
    // sentence whichever provider refused them.
    const name = LISTED_KIE_MODELS.find(
      (candidate) => getKieModel(candidate)?.imageToImage === undefined,
    )
    if (!name) return

    expect(() => resolveKieRequest(name, request({ inputMedia: './a.png' }))).toThrow(
      /cannot take input media/,
    )
  })
})

describe('unlisted models', () => {
  it('passes an unknown id through rather than rejecting it', () => {
    const resolved = resolveKieRequest('some/model-released-tomorrow', request())

    expect(resolved.passthrough).toBe(true)
    expect(resolved.modelId).toBe('some/model-released-tomorrow')
  })

  it('does not validate a shape it knows nothing about', () => {
    expect(() =>
      resolveKieRequest('some/model-released-tomorrow', request({ aspectRatio: '99:1' })),
    ).not.toThrow()
  })

  it('refuses to edit with an unlisted model, because the field name is unknown', () => {
    // This is not a guess worth making: the field is called input_urls,
    // image_input, image_urls or reference_image_urls depending on the model.
    try {
      resolveKieRequest('some/model-released-tomorrow', request({ inputMedia: './a.png' }))
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error).toMatchObject({ code: ERROR_CODE.VALIDATION_ERROR })
      expect((error as Error).message).toMatch(/input-image field is not known/)
    }
  })
})

describe('parameters the model does not document', () => {
  it('omits an aspect ratio for a model with no such parameter', () => {
    const name = LISTED_KIE_MODELS.find(
      (candidate) => getKieModel(candidate)?.aspectRatios === undefined,
    )
    if (!name) return

    const resolved = resolveKieRequest(name, request({ aspectRatio: '1:1' }))

    // Sending a guessed parameter is how a request gets rejected for a field
    // the user never asked about.
    expect(resolved.aspectRatio).toBeUndefined()
  })

  it('passes through a ratio the model does document', () => {
    const name = LISTED_KIE_MODELS.find((candidate) => {
      const ratios = getKieModel(candidate)?.aspectRatios
      return ratios !== undefined && ratios.includes('1:1')
    })
    if (!name) return

    expect(resolveKieRequest(name, request({ aspectRatio: '1:1' })).aspectRatio).toBe('1:1')
  })

  it('rejects a ratio the model lists constraints for but does not include', () => {
    const name = LISTED_KIE_MODELS.find((candidate) => {
      const ratios = getKieModel(candidate)?.aspectRatios
      return ratios !== undefined && !ratios.includes('99:1')
    })
    if (!name) return

    expect(() => resolveKieRequest(name, request({ aspectRatio: '99:1' }))).toThrow(
      /does not support the aspect ratio 99:1/,
    )
  })
})

describe('prose-documented gaps', () => {
  it('rejects a combination the schema allows but the prose excludes', () => {
    const model = getKieModel('gpt-image-2')
    if (!model?.unavailable || model.unavailable.length === 0) return

    const gap = model.unavailable[0]!

    expect(() =>
      resolveKieRequest(
        'gpt-image-2',
        request({ aspectRatio: gap.aspectRatio, size: gap.resolution }),
      ),
    ).toThrow(new RegExp(gap.reason))
  })
})
