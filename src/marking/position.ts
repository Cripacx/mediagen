/**
 * Where the visible label sits.
 *
 * The Commission asks for the label to be "clearly perceivable" and placed
 * "where no overlaying elements exist". Which corner satisfies that depends on
 * the image, so the caller can name one — and `auto` works it out.
 */

import type sharpType from 'sharp'

export const LABEL_POSITIONS = [
  'bottom-right',
  'bottom-left',
  'top-right',
  'top-left',
  'auto',
] as const

export type LabelPosition = (typeof LABEL_POSITIONS)[number]

/** A named corner, once `auto` has been resolved to one. */
export type Corner = Exclude<LabelPosition, 'auto'>

/**
 * The default.
 *
 * Fixed rather than computed, because a disclosure that always appears in the
 * same place is one a viewer learns to look for, and a batch of images stays
 * consistent. Contrast has to adapt per image or the label becomes unreadable;
 * position does not.
 */
export const DEFAULT_POSITION: Corner = 'bottom-right'

/** How sharp names each corner when compositing. */
const GRAVITY: Record<Corner, 'southeast' | 'southwest' | 'northeast' | 'northwest'> = {
  'bottom-right': 'southeast',
  'bottom-left': 'southwest',
  'top-right': 'northeast',
  'top-left': 'northwest',
}

export function gravityFor(corner: Corner): (typeof GRAVITY)[Corner] {
  return GRAVITY[corner]
}

export function isLabelPosition(value: unknown): value is LabelPosition {
  return LABEL_POSITIONS.includes(value as LabelPosition)
}

/** The region of the image a label in this corner will cover. */
export function regionFor(
  corner: Corner,
  width: number,
  height: number,
): { left: number; top: number; width: number; height: number } {
  const sampleWidth = Math.max(1, Math.min(width, Math.round(width * 0.3)))
  const sampleHeight = Math.max(1, Math.min(height, Math.round(height * 0.2)))

  const left = corner.endsWith('right') ? Math.max(0, width - sampleWidth) : 0
  const top = corner.startsWith('bottom') ? Math.max(0, height - sampleHeight) : 0

  return { left, top, width: sampleWidth, height: sampleHeight }
}

/**
 * Picks the corner with the least going on in it.
 *
 * "Least going on" is the lowest standard deviation across the colour
 * channels: a flat area of sky or wall varies little, a face or a caption
 * varies a lot. That is a rough proxy for "no overlaying elements", but it is
 * the right rough proxy — it moves the label off the busy part of the image
 * without needing to know what the image contains.
 *
 * Ties go to the default, so a flat image still puts the label where one is
 * expected. An image that cannot be analysed does the same.
 */
export async function quietestCorner(
  sharp: typeof sharpType,
  original: Uint8Array,
  width: number,
  height: number,
): Promise<Corner> {
  const corners: Corner[] = ['bottom-right', 'bottom-left', 'top-right', 'top-left']

  let best: Corner = DEFAULT_POSITION
  let lowest = Number.POSITIVE_INFINITY

  for (const corner of corners) {
    const busyness = await busynessOf(sharp, original, regionFor(corner, width, height))
    if (busyness === undefined) return DEFAULT_POSITION

    // Strictly less, so an exact tie keeps whichever came first — and the
    // default is first.
    if (busyness < lowest) {
      lowest = busyness
      best = corner
    }
  }

  return best
}

async function busynessOf(
  sharp: typeof sharpType,
  original: Uint8Array,
  region: Region,
): Promise<number | undefined> {
  return (await regionStats(sharp, original, region))?.stdev
}

export interface Region {
  left: number
  top: number
  width: number
  height: number
}

export interface RegionStats {
  /** Mean brightness across the colour channels, 0–255. */
  readonly mean: number
  /** How much it varies — a proxy for how much is going on there. */
  readonly stdev: number
}

/**
 * Measures one region of an image.
 *
 * Computed from raw pixels rather than sharp's own `stats()`, which reads the
 * input image and ignores an `extract()` earlier in the pipeline — every
 * region of an image reports identically that way, which is silently wrong
 * rather than an error.
 */
export async function regionStats(
  sharp: typeof sharpType,
  original: Uint8Array,
  region: Region,
): Promise<RegionStats | undefined> {
  try {
    const { data, info } = await sharp(original)
      .extract(region)
      .raw()
      .toBuffer({ resolveWithObject: true })

    const colourChannels = Math.min(3, info.channels)
    if (colourChannels === 0) return undefined

    let sum = 0
    let sumSquares = 0
    let count = 0

    for (let index = 0; index < data.length; index += info.channels) {
      for (let channel = 0; channel < colourChannels; channel += 1) {
        // Alpha is neither brightness nor detail, so it is left out.
        const value = data[index + channel]!
        sum += value
        sumSquares += value * value
        count += 1
      }
    }

    if (count === 0) return undefined

    const mean = sum / count
    const variance = Math.max(0, sumSquares / count - mean * mean)
    return { mean, stdev: Math.sqrt(variance) }
  } catch {
    return undefined
  }
}
