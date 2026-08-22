/**
 * Gemini video generation, over the Interactions API (§10).
 *
 * Video is the second media kind, not a second product: this file is short
 * because the pipeline, capability validation, output handling and the polling
 * loop are all the same ones images use. What genuinely differs:
 *
 * - **It is asynchronous.** Generation takes minutes, so §6.2's polling loop
 *   is the normal path here, and progress goes to stderr — never stdout,
 *   which belongs to the output contract (§4.2).
 * - **Delivery differs by size.** Google returns a video inline as base64 only
 *   when it is small; above roughly 4 MB it returns a URI to download.
 *   Requesting `uri` delivery outright avoids carrying a large clip through
 *   base64 twice over.
 *
 * Source: https://ai.google.dev/gemini-api/docs/interactions/omni.md.txt
 */

import { ERROR_CODE, MediagenError } from '../../core/errors.js'
import { loadInputMedia } from '../../core/inputMedia.js'
import { pollUntilDone } from '../shared/polling.js'
import { createGenAI, mapGeminiError } from './client.js'
import type { GenerationClient, GenerationClientFactory, Logger } from '../../types/provider.js'

/**
 * A video is orders of magnitude larger than a still, so §10 asks for the
 * bounds to be revisited rather than inherited. This is the download bound;
 * `saveMedia` applies its own before writing.
 */
const MAX_VIDEO_BYTES = 512 * 1024 * 1024

/** Long enough for a slow render, short enough to fail rather than hang. */
const VIDEO_TIMEOUT_MS = 900_000

type InputPart = { type: 'text'; text: string } | { type: 'image'; mime_type: string; data: string }

interface ContentPart {
  type?: string
  data?: string
  uri?: string
  mime_type?: string
}

export const createVideoClient: GenerationClientFactory = (): GenerationClient => ({
  async generate(request, options) {
    const client = createGenAI(options.apiKey)

    const input: InputPart[] = [{ type: 'text', text: request.prompt }]

    // §10: for image-to-video the source frame is supplied exactly as it is
    // for an image edit — inline, in the same input array.
    if (request.inputMedia !== undefined) {
      const source = await loadInputMedia(request.inputMedia)
      input.push({
        type: 'image',
        mime_type: source.mimeType,
        data: Buffer.from(source.data).toString('base64'),
      })
    }

    const responseFormat: Record<string, unknown> = { type: 'video', delivery: 'uri' }
    if (request.aspectRatio !== undefined) responseFormat['aspect_ratio'] = request.aspectRatio
    if (request.duration !== undefined) responseFormat['duration'] = `${request.duration}s`
    if (request.size !== undefined) responseFormat['resolution'] = request.size

    options.log.debug(`gemini: starting video interaction with ${options.model}`)
    options.log.progress('Starting video generation; this usually takes minutes.')

    let interaction: unknown
    try {
      interaction = await client.interactions.create({
        model: options.model,
        input: input,
        response_format: responseFormat,
      })
    } catch (error) {
      mapGeminiError(error)
    }

    const finished = await waitForCompletion(client, interaction, options)
    const part = videoPart(finished)

    if (!part) {
      // As with images, a text-only answer is how Gemini declines without an
      // HTTP error.
      throw new MediagenError(
        ERROR_CODE.CONTENT_BLOCKED,
        'Gemini returned no video for this prompt.',
        { hint: 'Rephrase the prompt, or shorten the requested duration.' },
      )
    }

    const data =
      part.data !== undefined
        ? Buffer.from(part.data, 'base64')
        : await download(part.uri!, options.apiKey, options.signal)

    const id = idOf(finished)

    return {
      data,
      mimeType: part.mime_type ?? 'video/mp4',
      ...(id === undefined ? {} : { requestId: id }),
    }
  },
})

/**
 * Waits for the interaction to reach a terminal state.
 *
 * A create call that already came back complete is not polled at all — §6.2's
 * "finished is finished" applies to a job that finished immediately just as
 * much as to one that failed.
 */
async function waitForCompletion(
  client: ReturnType<typeof createGenAI>,
  created: unknown,
  options: { apiKey: string; log: Logger; signal?: AbortSignal },
): Promise<unknown> {
  if (isTerminal(created)) return created

  const id = idOf(created)
  if (id === undefined) {
    throw new MediagenError(
      ERROR_CODE.API_ERROR,
      'Gemini accepted the video job but returned no id to follow it with.',
      { hint: 'Retry; if it persists, report it.' },
    )
  }

  return await pollUntilDone(
    async () => {
      let current: unknown
      try {
        current = await client.interactions.get(id)
      } catch (error) {
        mapGeminiError(error)
      }

      const status = statusOf(current)

      // §6.2: terminal states are distinguished. A cancellation is not a
      // provider failure, and telling the user to retry a job they stopped
      // would be nonsense.
      if (status === 'cancelled') {
        throw new MediagenError(ERROR_CODE.API_ERROR, 'The video job was cancelled.', {
          hint: 'Start it again if that was not intended.',
        })
      }

      if (status === 'failed') {
        throw new MediagenError(ERROR_CODE.API_ERROR, 'The video job failed.', {
          hint: 'Retry, or shorten the requested duration.',
        })
      }

      if (isTerminal(current)) return { status: 'done', value: current }

      return { status: 'pending' }
    },
    {
      timeoutMs: VIDEO_TIMEOUT_MS,
      // Video is slow enough that checking every couple of seconds is waste.
      initialDelayMs: 5_000,
      maxDelayMs: 30_000,
      log: options.log,
      label: 'Rendering video',
      ...(options.signal ? { signal: options.signal } : {}),
    },
  )
}

function statusOf(interaction: unknown): string | undefined {
  if (typeof interaction !== 'object' || interaction === null) return undefined
  const status: unknown = (interaction as { status?: unknown }).status
  return typeof status === 'string' ? status : undefined
}

/**
 * An interaction is finished when it says so, or when it already carries the
 * media. The second check matters because a fast render can come back complete
 * from `create` without a status field to say so.
 */
function isTerminal(interaction: unknown): boolean {
  const status = statusOf(interaction)
  if (status === 'completed' || status === 'succeeded') return true
  return videoPart(interaction) !== undefined
}

function videoPart(interaction: unknown): ContentPart | undefined {
  if (typeof interaction !== 'object' || interaction === null) return undefined
  const steps: unknown = (interaction as { steps?: unknown }).steps
  if (!Array.isArray(steps)) return undefined

  for (const step of steps as unknown[]) {
    if (typeof step !== 'object' || step === null) continue
    const content: unknown = (step as { content?: unknown }).content
    if (!Array.isArray(content)) continue

    for (const part of content as ContentPart[]) {
      if (part.type !== 'video') continue
      if (part.data !== undefined || part.uri !== undefined) return part
    }
  }

  return undefined
}

function idOf(interaction: unknown): string | undefined {
  if (typeof interaction !== 'object' || interaction === null) return undefined
  const id: unknown = (interaction as { id?: unknown }).id
  return typeof id === 'string' ? id : undefined
}

/**
 * The download URI is on Google's own API host and needs the key, so this
 * cannot be a bare fetch (§8: the bound is checked before the body is read).
 */
async function download(
  uri: string,
  apiKey: string,
  signal: AbortSignal | undefined,
): Promise<Uint8Array> {
  const response = await fetch(uri, {
    headers: { 'x-goog-api-key': apiKey },
    ...(signal ? { signal } : {}),
  })

  if (!response.ok) {
    throw new MediagenError(
      ERROR_CODE.NETWORK_ERROR,
      `Could not download the generated video (${response.status}).`,
      { hint: 'Retry; the link is short-lived.' },
    )
  }

  const declared = Number(response.headers.get('content-length') ?? '0')
  if (declared > MAX_VIDEO_BYTES) {
    throw new MediagenError(
      ERROR_CODE.API_ERROR,
      `The video is ${Math.round(declared / 1024 / 1024)} MB, above the ${
        MAX_VIDEO_BYTES / 1024 / 1024
      } MB limit.`,
      { hint: 'Request a shorter duration or a lower resolution.' },
    )
  }

  const buffer = new Uint8Array(await response.arrayBuffer())

  if (buffer.byteLength > MAX_VIDEO_BYTES) {
    throw new MediagenError(ERROR_CODE.API_ERROR, 'The downloaded video exceeded the size limit.', {
      hint: 'Request a shorter duration or a lower resolution.',
    })
  }

  return buffer
}
