/**
 * The shape of a generated Kie model descriptor.
 *
 * This lives apart from `models.ts` so the generated table can be typed
 * without importing the module that consumes it.
 *
 * Every list is of plain strings rather than a closed union. The generator
 * reads Kie's own documentation, and a vendor that adds an aspect ratio must
 * not turn a regenerated table into a compile error — the dangerous direction
 * for a stale table is upward.
 */

export interface KieModelShape {
  /**
   * Model id used when generating from a prompt alone; absent for the
   * editing-only endpoints, which cannot generate.
   */
  readonly textToImage?: string
  /** Model id used when editing; absent when the model cannot edit. */
  readonly imageToImage?: string
  /**
   * Request field carrying input image URLs. Kie names it differently per
   * model, which is the main reason these descriptors exist at all.
   */
  readonly imageInputField?: string
  /**
   * Whether that field takes an array of URLs or a single URL string. Sending
   * the wrong shape breaks the request as surely as the wrong name does.
   */
  readonly imageInputIsArray?: boolean
  /** Accepted aspect ratios; absent when the model has no such parameter. */
  readonly aspectRatios?: readonly string[]
  /** Accepted resolutions; absent when the model has no such parameter. */
  readonly resolutions?: readonly string[]
  /** How this model spells each output format; absent when it has no such parameter. */
  readonly outputFormats?: Readonly<Record<string, string>>
}

/**
 * One route of a video model: text-to-video or image-to-video.
 *
 * Video routes differ from each other more than image routes do — the
 * image-to-video half usually takes its ratio from the frame and drops the
 * parameter — so each route carries its own shape rather than sharing one.
 * Field names are recorded because Kie spells the same idea differently per
 * model: `aspect_ratio` or `ratio`, `resolution` or `quality`.
 */
export interface KieVideoRoute {
  /** Model id sent to createTask. */
  readonly model: string
  /** Request field carrying the starting frame; image-to-video only. */
  readonly imageInputField?: string
  readonly imageInputIsArray?: boolean
  /** Present when the route takes an aspect ratio. */
  readonly aspectRatioField?: string
  /** Accepted values; absent when the documentation lists none. */
  readonly aspectRatios?: readonly string[]
  /** Present when the route takes a resolution. */
  readonly resolutionField?: string
  readonly resolutions?: readonly string[]
  /**
   * Present when the route takes a duration. Some models want `"5"`, others
   * `5`, and the wrong type is rejected.
   */
  readonly durationType?: 'string' | 'number'
  /** Accepted durations in seconds; absent when the documentation lists none. */
  readonly durations?: readonly number[]
  /**
   * Values for fields the route requires, sent unless the request overrides
   * them: the documented default, a documented choice, or `false` for a switch.
   */
  readonly defaults?: Readonly<Record<string, string | number | boolean>>
}

export interface KieVideoModelShape {
  readonly textToVideo?: KieVideoRoute
  readonly imageToVideo?: KieVideoRoute
}
