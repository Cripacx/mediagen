/**
 * Capability validation, shared by every provider.
 *
 * Spec §6.3 — providers differ in the shapes they accept, and a request that
 * cannot succeed must fail before it is sent, naming the reason and the
 * supported values. Never silently substitute a different shape: a user who
 * asked for 21:9 and received 1:1 without being told has been lied to.
 *
 * This is data-driven off `ModelDescriptor` so a provider declares its
 * constraints rather than reimplementing the checks (§6.1).
 *
 * Two absences mean different things and are treated differently:
 *
 * - The model is not in the catalogue at all. §7.3 says send it anyway; with
 *   nothing known about it there is nothing to validate.
 * - The model is listed but declares no constraint for a field. The vendor
 *   documents no such parameter, so the field is not ours to police.
 */

import { ERROR_CODE, MediagenError } from './errors.js'
import type { GenerationRequest } from '../types/media.js'
import type { ModelDescriptor } from '../types/provider.js'

function reject(field: string, value: string, model: string, allowed: readonly string[]): never {
  throw new MediagenError(
    ERROR_CODE.VALIDATION_ERROR,
    `The model "${model}" does not support the ${field} ${value}. Use one of: ${allowed.join(', ')}.`,
    {
      hint: `Retry with --${field === 'aspect ratio' ? 'aspect-ratio' : field} ${allowed[0] ?? ''}`.trim(),
    },
  )
}

/**
 * Validates a request against one catalogue entry.
 *
 * `descriptor` is undefined for a model outside the catalogue, which is not an
 * error — see §7.3 and the note above.
 */
export function validateAgainst(
  request: GenerationRequest,
  model: string,
  descriptor: ModelDescriptor | undefined,
): void {
  if (!descriptor) return

  const { aspectRatio, size, duration, inputMedia } = request

  if (
    aspectRatio !== undefined &&
    descriptor.aspectRatios &&
    !descriptor.aspectRatios.includes(aspectRatio)
  ) {
    reject('aspect ratio', aspectRatio, model, descriptor.aspectRatios)
  }

  if (size !== undefined && descriptor.sizes && !descriptor.sizes.includes(size)) {
    reject('size', size, model, descriptor.sizes)
  }

  if (duration !== undefined && descriptor.durations) {
    if (!descriptor.durations.includes(duration)) {
      reject('duration', String(duration), model, descriptor.durations.map(String))
    }
  }

  if (inputMedia !== undefined && descriptor.acceptsInputMedia === false) {
    throw new MediagenError(
      ERROR_CODE.VALIDATION_ERROR,
      `The model "${model}" cannot take input media; it generates from a prompt alone.`,
      { hint: 'Choose an editing-capable model, or drop --input.' },
    )
  }

  if (duration !== undefined && descriptor.kind !== 'video') {
    throw new MediagenError(
      ERROR_CODE.VALIDATION_ERROR,
      `Duration applies to video; "${model}" generates ${descriptor.kind}.`,
      { hint: 'Drop --duration, or use `mediagen video`.' },
    )
  }
}

/** Finds a catalogue entry by id, or undefined when the model is unlisted (§7.3). */
export function findModel(
  models: readonly ModelDescriptor[],
  id: string,
): ModelDescriptor | undefined {
  return models.find((model) => model.id === id)
}
