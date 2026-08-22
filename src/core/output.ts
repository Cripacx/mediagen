/**
 * Where generated media lands.
 *
 * Spec §8. Two of its rules are easy to state and easy to get subtly wrong:
 *
 * - Traversal outside the intended directory is refused. The check is made on
 *   the resolved path, not the supplied one, because `a/../../b` only looks
 *   like traversal after resolution.
 * - A requested extension that disagrees with the real media type is
 *   corrected, and the correction is logged. Silently renaming leaves the user
 *   with a file they cannot find; silently keeping the wrong extension leaves
 *   them with one their viewer refuses to open.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { ERROR_CODE, MediagenError } from './errors.js'
import { extensionForMime, sniffMediaType } from './mediaType.js'
import type { Logger } from '../types/provider.js'

/** Spec §10 revisits this for video, which is orders of magnitude larger. */
export const MAX_OUTPUT_BYTES = 512 * 1024 * 1024

export interface SaveOptions {
  readonly outputDir: string
  /** The name the user asked for; its extension may select the format. */
  readonly outputName?: string
  /** Used when the user named no file. */
  readonly fallbackStem: string
  readonly mimeType: string
  readonly log: Logger
}

export interface SavedMedia {
  readonly filePath: string
  /** The type actually written, which may differ from what was requested. */
  readonly mimeType: string
}

export async function saveMedia(data: Uint8Array, options: SaveOptions): Promise<SavedMedia> {
  const { outputDir, outputName, fallbackStem, log } = options

  if (data.byteLength === 0) {
    throw new MediagenError(ERROR_CODE.API_ERROR, 'The provider returned no media.', {
      hint: 'Retry; if it persists, try another model with --model.',
    })
  }

  if (data.byteLength > MAX_OUTPUT_BYTES) {
    throw new MediagenError(
      ERROR_CODE.API_ERROR,
      `The provider returned ${Math.round(data.byteLength / 1024 / 1024)} MB, above the ${
        MAX_OUTPUT_BYTES / 1024 / 1024
      } MB limit.`,
      { hint: 'Request a smaller size with --size.' },
    )
  }

  // What the bytes are beats what the provider claimed they are.
  const actualMime = sniffMediaType(data)?.mimeType ?? options.mimeType
  const correctExtension = extensionForMime(actualMime)

  const directory = path.resolve(outputDir)
  const filePath = resolveOutputPath({
    directory,
    outputName,
    fallbackStem,
    correctExtension,
    log,
  })

  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, data)

  return { filePath, mimeType: actualMime }
}

interface PathOptions {
  readonly directory: string
  readonly outputName: string | undefined
  readonly fallbackStem: string
  readonly correctExtension: string
  readonly log: Logger
}

export function resolveOutputPath(options: PathOptions): string {
  const { directory, outputName, fallbackStem, correctExtension, log } = options

  const requested = outputName?.trim()
  const candidate =
    requested && requested.length > 0 ? requested : `${fallbackStem}${correctExtension}`

  const resolved = path.resolve(directory, candidate)

  // Resolution first, comparison second: `../` is only visible afterwards.
  if (!isInside(directory, resolved)) {
    throw new MediagenError(
      ERROR_CODE.VALIDATION_ERROR,
      `The output name "${candidate}" resolves outside the output directory.`,
      { hint: `Use a name inside ${directory}, or set --output-dir.` },
    )
  }

  const givenExtension = path.extname(resolved)
  if (givenExtension.toLowerCase() === correctExtension.toLowerCase()) {
    return resolved
  }

  if (givenExtension === '') {
    return `${resolved}${correctExtension}`
  }

  const corrected = `${resolved.slice(0, -givenExtension.length)}${correctExtension}`
  log.warn(
    `The media is ${correctExtension.slice(1).toUpperCase()}, not ${givenExtension
      .slice(1)
      .toUpperCase()}. Saving as ${path.basename(corrected)}.`,
  )
  return corrected
}

function isInside(directory: string, candidate: string): boolean {
  const relative = path.relative(directory, candidate)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

/** A stable, sortable stem for when the user named no file. */
export function defaultStem(kind: string, now: Date): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')
  return `${kind}-${stamp}`
}
