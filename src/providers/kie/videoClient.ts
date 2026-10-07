/**
 * Kie AI video generation.
 *
 * The same createTask job as images, through the same `task.ts`; video only
 * changes the request body, which `resolveKieVideoRequest` builds per route,
 * and the bounds: renders take minutes and the files are far larger.
 */

import { resolveKieVideoRequest } from './capabilities.js'
import { download, runTask, uploadInputImage } from './task.js'
import type { GenerationClient, GenerationClientFactory } from '../../types/provider.js'

/** Matches the output bound `saveMedia` applies to video. */
const MAX_VIDEO_BYTES = 512 * 1024 * 1024

/** Long enough for a slow render, short enough to fail rather than hang. */
const VIDEO_TIMEOUT_MS = 900_000

export const createVideoClient: GenerationClientFactory = (): GenerationClient => ({
  async generate(request, options) {
    const resolved = resolveKieVideoRequest(options.model, request)

    if (resolved.passthrough) {
      options.log.warn(
        `"${options.model}" is not in the generated Kie catalogue; sending the prompt alone and letting Kie decide.`,
      )
    }

    const input: Record<string, unknown> = { ...resolved.input }
    const field = resolved.route.imageInputField

    if (request.inputMedia !== undefined && field !== undefined) {
      const url = await uploadInputImage(request.inputMedia, options.apiKey, options.signal)
      input[field] = resolved.route.imageInputIsArray === true ? [url] : url
    }

    options.log.progress('Starting video generation; this usually takes minutes.')

    const { taskId, resultUrl } = await runTask(resolved.route.model, input, options, {
      timeoutMs: VIDEO_TIMEOUT_MS,
      // Video is slow enough that checking every couple of seconds is waste.
      initialDelayMs: 5_000,
      maxDelayMs: 30_000,
    })

    const data = await download(resultUrl, options.signal, {
      maxBytes: MAX_VIDEO_BYTES,
      noun: 'video',
      smallerHint: 'Request a lower resolution with --size, or a shorter --duration.',
    })

    return {
      data,
      // Sniffed downstream by saveMedia; this is only the provider's claim.
      mimeType: 'video/mp4',
      requestId: taskId,
    }
  },
})
