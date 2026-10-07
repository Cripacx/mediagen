/**
 * Kie capability resolution.
 *
 * Kie is the provider that makes the input-media problem concrete: the same model name
 * routes to different ids for generation and editing, and the field carrying
 * input URLs is named differently per model.
 */

import { describe, expect, it } from 'vitest'
import { resolveKieRequest, resolveKieVideoRequest } from '../capabilities.js'
import { GENERATED_KIE_MODELS } from '../models.generated.js'
import {
  DEFAULT_KIE_MODEL,
  DEFAULT_KIE_VIDEO_MODEL,
  LISTED_KIE_MODELS,
  LISTED_KIE_VIDEO_MODELS,
  getKieModel,
  getKieVideoModel,
  listKieModels,
  listKieVideoModels,
} from '../models.js'
import type { KieVideoRoute } from '../modelShape.js'
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

function videoRequest(overrides: Partial<GenerationRequest> = {}): GenerationRequest {
  return { prompt: 'a cat', kind: 'video', ...overrides }
}

/** The first listed video model whose chosen route satisfies the predicate. */
function videoModelWhere(
  route: 'textToVideo' | 'imageToVideo',
  predicate: (candidate: KieVideoRoute) => boolean = () => true,
): string | undefined {
  return LISTED_KIE_VIDEO_MODELS.find((name) => {
    const candidate = getKieVideoModel(name)?.[route]
    return candidate !== undefined && predicate(candidate)
  })
}

describe('the generated video table', () => {
  it('lists the default video model, with both routes', () => {
    const model = getKieVideoModel(DEFAULT_KIE_VIDEO_MODEL)

    expect(model?.textToVideo).toBeDefined()
    expect(model?.imageToVideo).toBeDefined()
  })

  it('gives every image-to-video route a starting-frame field', () => {
    for (const name of LISTED_KIE_VIDEO_MODELS) {
      const route = getKieVideoModel(name)?.imageToVideo
      if (route) expect(route.imageInputField, name).toBeDefined()
    }
  })

  it('describes every listed model as a video model', () => {
    for (const descriptor of listKieVideoModels()) {
      expect(descriptor.kind).toBe('video')
    }
  })
})

describe('video route selection', () => {
  it('sends the text-to-video id without input media, and the image-to-video id with it', () => {
    const name = LISTED_KIE_VIDEO_MODELS.find((candidate) => {
      const model = getKieVideoModel(candidate)
      return model?.textToVideo && model.imageToVideo && model.textToVideo !== model.imageToVideo
    })!
    const model = getKieVideoModel(name)!

    expect(resolveKieVideoRequest(name, videoRequest()).route).toBe(model.textToVideo)
    expect(resolveKieVideoRequest(name, videoRequest({ inputMedia: './a.png' })).route).toBe(
      model.imageToVideo,
    )
  })

  it('refuses a prompt alone for a model that only animates an image', () => {
    const name = LISTED_KIE_VIDEO_MODELS.find(
      (candidate) => getKieVideoModel(candidate)?.textToVideo === undefined,
    )
    if (!name) return

    expect(() => resolveKieVideoRequest(name, videoRequest())).toThrow(/only animates/)
  })

  it('refuses input media for a model without an image-to-video route, in the shared wording', () => {
    const name = LISTED_KIE_VIDEO_MODELS.find(
      (candidate) => getKieVideoModel(candidate)?.imageToVideo === undefined,
    )
    if (!name) return

    expect(() => resolveKieVideoRequest(name, videoRequest({ inputMedia: './a.png' }))).toThrow(
      /cannot take input media/,
    )
  })
})

describe('video request bodies', () => {
  it('spells the duration the way the route documents it', () => {
    const asString = videoModelWhere(
      'textToVideo',
      (route) => route.durationType === 'string' && route.durations?.includes(5) === true,
    )!
    const asNumber = videoModelWhere(
      'textToVideo',
      (route) => route.durationType === 'number' && route.durations?.includes(5) === true,
    )!

    expect(resolveKieVideoRequest(asString, videoRequest({ duration: 5 })).input['duration']).toBe(
      '5',
    )
    expect(resolveKieVideoRequest(asNumber, videoRequest({ duration: 5 })).input['duration']).toBe(
      5,
    )
  })

  it("uses the route's own field name for the resolution", () => {
    const name = videoModelWhere(
      'textToVideo',
      (route) => route.resolutionField !== undefined && route.resolutionField !== 'resolution',
    )
    if (!name) return
    const route = getKieVideoModel(name)!.textToVideo!
    const size = route.resolutions![0]!

    const { input } = resolveKieVideoRequest(name, videoRequest({ size }))

    expect(input[route.resolutionField!]).toBe(size)
    expect(input['resolution']).toBeUndefined()
  })

  it('sends documented defaults for required fields, and lets the request override them', () => {
    const name = videoModelWhere(
      'textToVideo',
      (route) => route.defaults?.['duration'] !== undefined,
    )!
    const route = getKieVideoModel(name)!.textToVideo!
    const other = route.durations!.find(
      (value) => String(value) !== String(route.defaults!['duration']),
    )!

    expect(resolveKieVideoRequest(name, videoRequest()).input['duration']).toBe(
      route.defaults!['duration'],
    )
    expect(
      String(resolveKieVideoRequest(name, videoRequest({ duration: other })).input['duration']),
    ).toBe(String(other))
  })

  it('rejects a duration the route lists constraints for but does not include', () => {
    const name = videoModelWhere(
      'textToVideo',
      (route) => route.durations !== undefined && !route.durations.includes(999),
    )!

    expect(() => resolveKieVideoRequest(name, videoRequest({ duration: 999 }))).toThrow(
      /does not support the duration 999/,
    )
  })
})

describe('unlisted video models', () => {
  it('sends the prompt alone, because no field name can be guessed', () => {
    const resolved = resolveKieVideoRequest(
      'some/video-model-released-tomorrow',
      videoRequest({ aspectRatio: '16:9', duration: 5 }),
    )

    expect(resolved.passthrough).toBe(true)
    expect(resolved.input).toEqual({ prompt: 'a cat' })
  })

  it('refuses image-to-video, because the starting-frame field is unknown', () => {
    expect(() =>
      resolveKieVideoRequest(
        'some/video-model-released-tomorrow',
        videoRequest({ inputMedia: './a.png' }),
      ),
    ).toThrow(/starting-frame field is not known/)
  })
})
