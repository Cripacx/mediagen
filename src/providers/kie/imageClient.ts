/**
 * Kie AI image generation.
 *
 * The job itself — create, poll, download — lives in `task.ts`. What is
 * image-specific is the request body: the field name for input images, and
 * whether it takes an array, both vary per model, which is why the generated
 * descriptors exist.
 */

import { resolveKieRequest } from './capabilities.js'
import { download, runTask, uploadInputImage } from './task.js'
import type { GenerationClient, GenerationClientFactory } from '../../types/provider.js'

/** Bound on the downloaded image, matching the input limit elsewhere. */
const MAX_DOWNLOAD_BYTES = 32 * 1024 * 1024

export const createImageClient: GenerationClientFactory = (): GenerationClient => ({
  async generate(request, options) {
    const resolved = resolveKieRequest(options.model, request)

    if (resolved.passthrough) {
      options.log.warn(
        `"${options.model}" is not in the generated Kie catalogue; sending it anyway and letting Kie decide.`,
      )
    }

    const input: Record<string, unknown> = { prompt: request.prompt }
    if (resolved.aspectRatio !== undefined) input['aspect_ratio'] = resolved.aspectRatio
    if (resolved.resolution !== undefined) input['resolution'] = resolved.resolution
    if (resolved.outputFormat !== undefined) input['output_format'] = resolved.outputFormat

    if (request.inputMedia !== undefined) {
      const url = await uploadInputImage(request.inputMedia, options.apiKey, options.signal)

      const field = resolved.model.imageInputField!
      input[field] = resolved.model.imageInputIsArray === true ? [url] : url
    }

    const { taskId, resultUrl } = await runTask(resolved.modelId, input, options)

    const data = await download(resultUrl, options.signal, {
      maxBytes: MAX_DOWNLOAD_BYTES,
      noun: 'image',
      smallerHint: 'Request a smaller size with --size.',
    })

    return {
      data,
      // Sniffed downstream by saveMedia; this is only the provider's claim.
      mimeType: resolved.outputFormat === 'jpeg' ? 'image/jpeg' : 'image/png',
      requestId: taskId,
    }
  },
})
