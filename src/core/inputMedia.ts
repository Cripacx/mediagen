/**
 * Reading the source file for an edit or transformation.
 *
 * Spec §8 sets three rules that all apply before a single byte is decoded:
 * bound how much is read into memory, follow symlinks safely, and refuse
 * anything that is not a regular file. The order matters — checking the size
 * after reading is not a bound, and a size check on the link rather than its
 * target checks the wrong file.
 */

import { open, stat } from 'node:fs/promises'
import * as path from 'node:path'
import { ERROR_CODE, MediagenError } from './errors.js'
import { mimeForExtension, sniffMediaType } from './mediaType.js'

/**
 * Spec §10 asks for these to be revisited for video, where a source frame is
 * still an image but the output is not. This bounds the input only.
 */
export const MAX_INPUT_BYTES = 32 * 1024 * 1024

export interface LoadedMedia {
  readonly data: Uint8Array
  readonly mimeType: string
  readonly path: string
}

export async function loadInputMedia(
  filePath: string,
  maxBytes: number = MAX_INPUT_BYTES,
): Promise<LoadedMedia> {
  const resolved = path.resolve(filePath)

  // `stat` follows symlinks, so this describes the file that will actually be
  // read rather than the link pointing at it.
  const stats = await stat(resolved).catch(() => undefined)

  if (!stats) {
    throw new MediagenError(ERROR_CODE.FILE_ERROR, `No such file: ${filePath}`, {
      hint: 'Check the path passed to --input.',
    })
  }

  if (!stats.isFile()) {
    throw new MediagenError(
      ERROR_CODE.FILE_ERROR,
      `Input media must be a regular file: ${filePath}`,
      { hint: 'Directories, sockets and devices cannot be used as input.' },
    )
  }

  if (stats.size > maxBytes) {
    throw new MediagenError(
      ERROR_CODE.VALIDATION_ERROR,
      `Input media is ${formatBytes(stats.size)}; the limit is ${formatBytes(maxBytes)}.`,
      { hint: 'Downscale the file before passing it to --input.' },
    )
  }

  if (stats.size === 0) {
    throw new MediagenError(ERROR_CODE.VALIDATION_ERROR, `Input media is empty: ${filePath}`, {
      hint: 'Check that the file finished being written.',
    })
  }

  const handle = await open(resolved, 'r')
  try {
    // Sized from the stat above, so a file that grew between the two cannot
    // read past the bound we already accepted.
    const buffer = Buffer.allocUnsafe(stats.size)
    const { bytesRead } = await handle.read(buffer, 0, stats.size, 0)
    const data = new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead)

    const sniffed = sniffMediaType(data)
    const mimeType = sniffed?.mimeType ?? mimeForExtension(path.extname(resolved))

    if (!mimeType) {
      throw new MediagenError(
        ERROR_CODE.VALIDATION_ERROR,
        `Cannot tell what kind of media ${filePath} is.`,
        { hint: 'Supported input: PNG, JPEG, WebP, GIF, MP4, WebM.' },
      )
    }

    return { data, mimeType, path: resolved }
  } finally {
    await handle.close()
  }
}

function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024)
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`
}
