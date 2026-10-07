/**
 * Resolving a request against the selected Kie AI model.
 *
 * Kie routes generation and editing through *different model ids* for the same
 * model name, so resolution here does more than validate: it picks the id to
 * send. Getting that wrong is not a shape mismatch, it is a request to the
 * wrong endpoint.
 *
 * An unlisted model id has nothing to validate against, so the request goes
 * through and Kie decides.
 */

import { ERROR_CODE, MediagenError } from '../../core/errors.js'
import { validateAgainst } from '../../core/capabilities.js'
import {
  getKieModel,
  getKieVideoModel,
  passthroughModel,
  passthroughVideoRoute,
  suggestedKieModels,
  suggestedKieVideoModels,
  toDescriptor,
  toVideoDescriptor,
  type KieModel,
} from './models.js'
import type { KieVideoRoute } from './modelShape.js'
import type { GenerationRequest } from '../../types/media.js'

export interface ResolvedKieRequest {
  readonly model: KieModel
  /** Model id to send, already chosen for the generation or editing route. */
  readonly modelId: string
  readonly aspectRatio?: string
  readonly resolution?: string
  /** Already spelled the way this model expects it. */
  readonly outputFormat?: string
  /** True when the model id was not one of the listed descriptors. */
  readonly passthrough: boolean
}

export function resolveKieRequest(name: string, request: GenerationRequest): ResolvedKieRequest {
  const listed = getKieModel(name)
  const model = listed ?? passthroughModel(name)
  const passthrough = listed === undefined

  // The shared check first, so a bad ratio reads identically whichever
  // provider produced it.
  validateAgainst(request, name, listed ? toDescriptor(name, listed) : undefined)

  const wantsEdit = request.inputMedia !== undefined

  // For a listed model the shared check above has already refused an edit it
  // cannot do, using the same wording every provider uses. What is left is the
  // unlisted case, which the shared check deliberately says nothing about
  // but which cannot be edited regardless: the field carrying input
  // URLs is called input_urls, image_input, image_urls or
  // reference_image_urls depending on the model, and that is not a guess worth
  // making.
  if (wantsEdit && (model.imageToImage === undefined || model.imageInputField === undefined)) {
    throw new MediagenError(
      ERROR_CODE.VALIDATION_ERROR,
      `Editing is not available for the unlisted Kie model "${name}": the name of its input-image field is not known.`,
      { hint: `Models that can edit: ${suggestedKieModels()}.` },
    )
  }

  if (!wantsEdit && model.textToImage === undefined) {
    throw new MediagenError(
      ERROR_CODE.VALIDATION_ERROR,
      `The Kie model "${name}" only edits an existing image; it cannot generate from a prompt alone.`,
      { hint: 'Pass --input <path>, or choose another model.' },
    )
  }

  const modelId = wantsEdit ? model.imageToImage! : model.textToImage!

  // Prose-documented gaps the generated table cannot express.
  if (request.aspectRatio !== undefined && request.size !== undefined && model.unavailable) {
    const blocked = model.unavailable.find(
      (entry) => entry.aspectRatio === request.aspectRatio && entry.resolution === request.size,
    )
    if (blocked) {
      throw new MediagenError(
        ERROR_CODE.VALIDATION_ERROR,
        `The Kie model "${name}" does not offer ${request.size} at ${request.aspectRatio}: ${blocked.reason}.`,
        { hint: 'Choose another size or aspect ratio, or another model.' },
      )
    }
  }

  return {
    model,
    modelId,
    passthrough,
    // A parameter the model does not document is omitted rather than sent
    // with a guessed value; Kie rejects unknown fields on some routes.
    ...(request.aspectRatio !== undefined && model.aspectRatios
      ? { aspectRatio: request.aspectRatio }
      : {}),
    ...(request.size !== undefined && model.resolutions ? { resolution: request.size } : {}),
    ...outputFormat(model),
  }
}

/**
 * Kie spells the same format differently per model — `jpg` here, `jpeg`
 * there — so the descriptor carries the spelling and this picks it up rather
 * than assuming one.
 */
function outputFormat(model: KieModel): { outputFormat?: string } {
  if (!model.outputFormats) return {}
  const png = model.outputFormats['png']
  return png === undefined ? {} : { outputFormat: png }
}

export interface ResolvedKieVideoRequest {
  readonly route: KieVideoRoute
  /**
   * The createTask `input`, without the starting frame: that is uploaded by
   * the client and added under `route.imageInputField`.
   */
  readonly input: Readonly<Record<string, unknown>>
  /** True when the model id was not one of the listed descriptors. */
  readonly passthrough: boolean
}

/**
 * The video counterpart of `resolveKieRequest`: picks the text-to-video or
 * image-to-video route, validates against that route's own shape, and builds
 * the request body with each value under the field name and type the route
 * documents.
 */
export function resolveKieVideoRequest(
  name: string,
  request: GenerationRequest,
): ResolvedKieVideoRequest {
  const listed = getKieVideoModel(name)
  const wantsImage = request.inputMedia !== undefined

  if (!listed) {
    if (wantsImage) {
      throw new MediagenError(
        ERROR_CODE.VALIDATION_ERROR,
        `Image-to-video is not available for the unlisted Kie model "${name}": the name of its starting-frame field is not known.`,
        { hint: `Models that take a starting frame: ${suggestedKieVideoModels()}.` },
      )
    }
    return {
      route: passthroughVideoRoute(name),
      input: { prompt: request.prompt },
      passthrough: true,
    }
  }

  if (!wantsImage && listed.textToVideo === undefined) {
    throw new MediagenError(
      ERROR_CODE.VALIDATION_ERROR,
      `The Kie model "${name}" only animates an existing image; it cannot generate from a prompt alone.`,
      { hint: 'Pass --input <path>, or choose another model.' },
    )
  }

  // A request with --input against a text-only model falls through to the
  // text route, where the shared check refuses it in the shared wording.
  const route = (wantsImage ? listed.imageToVideo : undefined) ?? listed.textToVideo!
  validateAgainst(request, name, toVideoDescriptor(name, route, route === listed.imageToVideo))

  // Documented defaults first, so a required field the user left out is still
  // sent; then whatever the user asked for, under this route's field names. A
  // parameter the route does not document is omitted rather than guessed.
  const input: Record<string, unknown> = { ...route.defaults, prompt: request.prompt }
  if (request.aspectRatio !== undefined && route.aspectRatioField !== undefined) {
    input[route.aspectRatioField] = request.aspectRatio
  }
  if (request.size !== undefined && route.resolutionField !== undefined) {
    input[route.resolutionField] = request.size
  }
  if (request.duration !== undefined && route.durationType !== undefined) {
    input['duration'] =
      route.durationType === 'string' ? String(request.duration) : request.duration
  }

  return { route, input, passthrough: false }
}
