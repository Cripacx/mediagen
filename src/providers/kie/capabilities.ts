/**
 * Resolving a request against the selected Kie AI model (§6.3).
 *
 * Kie routes generation and editing through *different model ids* for the same
 * model name, so resolution here does more than validate: it picks the id to
 * send. Getting that wrong is not a shape mismatch, it is a request to the
 * wrong endpoint.
 *
 * An unlisted model id has nothing to validate against, so the request goes
 * through and Kie decides (§7.3).
 */

import { ERROR_CODE, MediagenError } from '../../core/errors.js'
import { validateAgainst } from '../../core/capabilities.js'
import {
  getKieModel,
  passthroughModel,
  suggestedKieModels,
  toDescriptor,
  type KieModel,
} from './models.js'
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
  // (§7.3) but which cannot be edited regardless: the field carrying input
  // URLs is called input_urls, image_input, image_urls or
  // reference_image_urls depending on the model, and that is not a guess worth
  // making (§6.4).
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

  // Prose-documented gaps the generated table cannot express (§7.4).
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
