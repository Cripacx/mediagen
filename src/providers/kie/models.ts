/**
 * The Kie AI model table.
 *
 * Kie aggregates around a hundred models and offers no discovery endpoint;
 * their documentation states that each model has unique parameters and
 * capabilities. That is literally true, and the differences are not cosmetic:
 * the field carrying input image URLs is called `input_urls`, `image_input`,
 * `image_urls` or `reference_image_urls` depending on the model, some models
 * have no aspect-ratio or resolution parameter at all, and the output format
 * is spelled `jpg` by one model and `jpeg` by another.
 *
 * The descriptors are therefore generated from Kie's own documentation rather
 * than hand-maintained — see `scripts/sync-kie-models.mjs`. Hand
 * maintenance goes stale in both directions, and the dangerous direction is
 * upward: when a model gains an aspect ratio, a frozen table starts rejecting
 * valid requests with a confident error.
 *
 * This module adds what the generated table cannot express: the default, and
 * the constraints Kie documents in prose rather than in the schema.
 */

import { GENERATED_KIE_MODELS, GENERATED_KIE_VIDEO_MODELS } from './models.generated.js'
import type { KieModelShape, KieVideoModelShape, KieVideoRoute } from './modelShape.js'
import type { ModelDescriptor } from '../../types/provider.js'
import type { QualityPreset } from '../../types/media.js'

/** A shape combination the model documents as unavailable. */
export interface UnavailableCombination {
  readonly aspectRatio: string
  readonly resolution: string
  readonly reason: string
}

export interface KieModel extends KieModelShape {
  readonly unavailable?: readonly UnavailableCombination[]
}

/**
 * Constraints Kie documents in prose, which therefore cannot appear in the
 * OpenAPI schema the table is generated from. Hence the separation: generated
 * data in one file, hand-written exceptions in another, clearly marked. Keyed by model name.
 */
const UNAVAILABLE_COMBINATIONS: Readonly<Record<string, readonly UnavailableCombination[]>> = {
  'gpt-image-2': [
    { aspectRatio: '1:1', resolution: '4K', reason: 'this model has no 4K route at 1:1' },
  ],
}

/**
 * Chosen because it maps onto every parameter this tool exposes: all of its
 * aspect ratios, every resolution, and an output format.
 */
export const DEFAULT_KIE_MODEL = 'nano-banana-2'

export const LISTED_KIE_MODELS = Object.keys(GENERATED_KIE_MODELS)

/**
 * The descriptor for a model, or undefined when it is not in the generated
 * table and should be passed through to Kie as-is.
 */
export function getKieModel(name: string): KieModel | undefined {
  const generated = (GENERATED_KIE_MODELS as Record<string, KieModelShape | undefined>)[name]
  if (!generated) return undefined

  const unavailable = UNAVAILABLE_COMBINATIONS[name]
  return unavailable ? { ...generated, unavailable } : generated
}

/**
 * The descriptor used for a model id absent from the generated table: only the
 * parameters every documented image model shares, and no editing, because the
 * name of the input-image field cannot be guessed.
 */
export function passthroughModel(name: string): KieModel {
  return { textToImage: name }
}

/**
 * Kie's shape translated into the shared vocabulary, so capability validation is
 * the same code here as everywhere else.
 */
export function toDescriptor(name: string, model: KieModel): ModelDescriptor {
  return {
    id: name,
    kind: 'image',
    ...(model.aspectRatios ? { aspectRatios: model.aspectRatios } : {}),
    ...(model.resolutions ? { sizes: model.resolutions } : {}),
    acceptsInputMedia: model.imageToImage !== undefined && model.imageInputField !== undefined,
  }
}

/** What `mediagen models` lists for Kie. */
export function listKieModels(): readonly ModelDescriptor[] {
  return LISTED_KIE_MODELS.map((name) =>
    toDescriptor(name, getKieModel(name) ?? passthroughModel(name)),
  )
}

/**
 * Kie is an aggregator: the quality preset does not map onto
 * a speed tier the way it does at a single vendor, so the default is the same
 * model throughout and the preset is left to select nothing.
 */
export function defaultImageModel(_quality: QualityPreset): string {
  return DEFAULT_KIE_MODEL
}

/** A short, stable list for error messages, which must not print a hundred. */
export function suggestedKieModels(): string {
  return ['nano-banana-2', 'nano-banana-pro', 'gpt-image-2']
    .filter((name) => LISTED_KIE_MODELS.includes(name))
    .join(', ')
}

/**
 * Seedance 2 serves text-to-video and image-to-video under one id, with ratios
 * and resolutions for both, so every flag `mediagen video` offers maps onto it.
 */
export const DEFAULT_KIE_VIDEO_MODEL = 'bytedance/seedance-2'

export const LISTED_KIE_VIDEO_MODELS = Object.keys(GENERATED_KIE_VIDEO_MODELS)

/** The video descriptor for a model, or undefined when it is not in the generated table. */
export function getKieVideoModel(name: string): KieVideoModelShape | undefined {
  return (GENERATED_KIE_VIDEO_MODELS as Record<string, KieVideoModelShape | undefined>)[name]
}

/**
 * The route used for a video model absent from the generated table: the prompt
 * alone, because neither the field names nor their types can be guessed.
 */
export function passthroughVideoRoute(name: string): KieVideoRoute {
  return { model: name }
}

/**
 * One route in the shared vocabulary. Listing describes the text-to-video
 * route where there is one, since that is what a request without --input uses.
 */
export function toVideoDescriptor(
  name: string,
  route: KieVideoRoute,
  acceptsInputMedia: boolean,
): ModelDescriptor {
  return {
    id: name,
    kind: 'video',
    ...(route.aspectRatios?.length ? { aspectRatios: route.aspectRatios } : {}),
    ...(route.resolutions?.length ? { sizes: route.resolutions } : {}),
    ...(route.durations?.length ? { durations: route.durations } : {}),
    acceptsInputMedia,
  }
}

/** What `mediagen models --kind video` lists for Kie. */
export function listKieVideoModels(): readonly ModelDescriptor[] {
  return LISTED_KIE_VIDEO_MODELS.map((name) => {
    const model = getKieVideoModel(name)!
    const descriptor = toVideoDescriptor(
      name,
      (model.textToVideo ?? model.imageToVideo)!,
      model.imageToVideo !== undefined,
    )
    return model.textToVideo
      ? descriptor
      : { ...descriptor, note: 'Image-to-video only; needs --input.' }
  })
}

export function defaultVideoModel(_quality: QualityPreset): string {
  return DEFAULT_KIE_VIDEO_MODEL
}

/** A short, stable list of video models for error messages. */
export function suggestedKieVideoModels(): string {
  return [DEFAULT_KIE_VIDEO_MODEL, 'kling-2.6', 'wan/2-6']
    .filter((name) => LISTED_KIE_VIDEO_MODELS.includes(name))
    .join(', ')
}
