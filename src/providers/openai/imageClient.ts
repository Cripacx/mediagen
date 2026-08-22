/**
 * OpenAI image generation and editing.
 *
 * Two shapes rather than one: OpenAI splits generation and editing across
 * `images.generate` and `images.edit`, with different parameters. §6.4 warns
 * that this varies per provider and must be researched rather than assumed —
 * here the difference is the endpoint itself, not just a field name.
 */

import { ERROR_CODE, MediagenError } from '../../core/errors.js'
import { loadInputMedia } from '../../core/inputMedia.js'
import { createOpenAI, mapOpenAIError } from './client.js'
import { apiQuality, sizeTableFor } from './models.js'
import type { GenerationClient, GenerationClientFactory } from '../../types/provider.js'
import type { GenerationRequest } from '../../types/media.js'

interface ImageResponse {
  data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }>
  created?: number
}

export const createImageClient: GenerationClientFactory = (): GenerationClient => ({
  async generate(request, options) {
    const client = createOpenAI(options.apiKey)
    const size = resolveSize(request, options.model)
    const quality = apiQuality(options.model, request.quality ?? 'fast')

    options.log.debug(`openai: requesting ${options.model} at ${size ?? 'default size'}`)

    let response: ImageResponse
    try {
      if (request.inputMedia !== undefined) {
        const source = await loadInputMedia(request.inputMedia)
        response = await client.images.edit({
          model: options.model,
          prompt: request.prompt,
          image: await toUploadable(source.data, source.mimeType),
          ...(size === undefined ? {} : { size }),
          ...(options.signal ? { signal: options.signal } : {}),
        } as never)
      } else {
        response = await client.images.generate({
          model: options.model,
          prompt: request.prompt,
          ...(size === undefined ? {} : { size }),
          quality,
          ...(options.signal ? { signal: options.signal } : {}),
        } as never)
      }
    } catch (error) {
      mapOpenAIError(error)
    }

    const first = response.data?.[0]
    if (!first) {
      throw new MediagenError(ERROR_CODE.API_ERROR, 'OpenAI returned no image.', {
        hint: 'Retry; if it persists, try another model with --model.',
      })
    }

    const data = await decode(first, options.signal)

    return {
      data,
      // OpenAI defaults to PNG and the request does not select otherwise here;
      // saveMedia sniffs the bytes anyway and corrects this if it is wrong.
      mimeType: 'image/png',
      ...(first.revised_prompt === undefined ? {} : { revisedPrompt: first.revised_prompt }),
    }
  },
})

/**
 * Translates a requested aspect ratio into the pixel size OpenAI takes.
 *
 * An explicit `--size` wins, because the user named exactly what they wanted.
 * A ratio the table does not hold is not silently approximated: capability
 * validation (§6.3) has already rejected it before this runs, so reaching here
 * with an unknown ratio means the model was unlisted, and §7.3 says to send
 * the request rather than guess.
 */
function resolveSize(request: GenerationRequest, model: string): string | undefined {
  if (request.size !== undefined) return request.size
  if (request.aspectRatio === undefined) return undefined

  return sizeTableFor(model)[request.aspectRatio]
}

/** Where OpenAI returned a URL rather than bytes, fetch it. */
async function decode(
  entry: { b64_json?: string; url?: string },
  signal: AbortSignal | undefined,
): Promise<Uint8Array> {
  if (entry.b64_json !== undefined) {
    return Buffer.from(entry.b64_json, 'base64')
  }

  if (entry.url !== undefined) {
    const response = await fetch(entry.url, signal ? { signal } : {})
    if (!response.ok) {
      throw new MediagenError(
        ERROR_CODE.NETWORK_ERROR,
        `Could not download the generated image (${response.status}).`,
        { hint: 'Retry; the link OpenAI returns is short-lived.' },
      )
    }
    return new Uint8Array(await response.arrayBuffer())
  }

  throw new MediagenError(ERROR_CODE.API_ERROR, 'OpenAI returned neither image data nor a link.', {
    hint: 'Retry; if it persists, try another model with --model.',
  })
}

/** The SDK takes a web `File`; Node has had one globally since 20. */
async function toUploadable(data: Uint8Array, mimeType: string): Promise<File> {
  const { toFile } = await import('openai')
  return await toFile(Buffer.from(data), `input.${mimeType.split('/')[1] ?? 'png'}`, {
    type: mimeType,
  })
}
