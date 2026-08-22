/**
 * The shape of a generated Kie model descriptor.
 *
 * This lives apart from `models.ts` so the generated table can be typed
 * without importing the module that consumes it.
 *
 * Every list is of plain strings rather than a closed union. The generator
 * reads Kie's own documentation, and a vendor that adds an aspect ratio must
 * not turn a regenerated table into a compile error — §7.3's dangerous
 * direction is upward.
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
   * model, which is the main reason these descriptors exist at all (§6.4).
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
