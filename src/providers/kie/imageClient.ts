/**
 * Kie AI image generation.
 *
 * The first asynchronous provider here, and the one §6.2's shared polling loop
 * was written for: create a task, poll until it finishes, download the result.
 *
 * Three things this file is careful about:
 *
 * - **Terminal states.** A job that reports `fail` is finished. Polling it
 *   again would waste the timeout waiting for a result that will never come.
 * - **Content blocks.** Kie reports these as ordinary job failures, so they
 *   are recognised from the failure text and mapped to CONTENT_BLOCKED rather
 *   than reading to the user as a network problem.
 * - **Input media.** Kie takes URLs, not inline data, so a local file is
 *   uploaded to Kie's own store first and referenced (§6.4). The field name
 *   and whether it takes an array both vary per model, which is why the
 *   generated descriptors exist.
 */

import { ERROR_CODE, MediagenError } from '../../core/errors.js'
import { loadInputMedia } from '../../core/inputMedia.js'
import { pollUntilDone } from '../shared/polling.js'
import { resolveKieRequest } from './capabilities.js'
import {
  CREATE_TASK_PATH,
  RECORD_INFO_PATH,
  UPLOAD_DIRECTORY,
  UPLOAD_PATH,
  kieRequest,
  type CreateTaskData,
  type RecordInfoData,
  type UploadData,
} from './api.js'
import type { GenerationClient, GenerationClientFactory } from '../../types/provider.js'

/** Job states reported by recordInfo. */
const TERMINAL_SUCCESS = 'success'
const TERMINAL_FAILURE = 'fail'

/** Bound on the downloaded image, matching the input limit elsewhere (§8). */
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
      const source = await loadInputMedia(request.inputMedia)
      const url = await upload(options.apiKey, source.data, source.mimeType, options.signal)

      const field = resolved.model.imageInputField!
      input[field] = resolved.model.imageInputIsArray === true ? [url] : url
    }

    options.log.debug(`kie: creating task for ${resolved.modelId}`)

    const created = await kieRequest<CreateTaskData>(
      CREATE_TASK_PATH,
      options.apiKey,
      {
        method: 'POST',
        body: { model: resolved.modelId, input },
        ...(options.signal ? { signal: options.signal } : {}),
      },
      'task creation',
    )

    const taskId = created.taskId
    if (taskId === undefined) {
      throw new MediagenError(ERROR_CODE.API_ERROR, 'Kie AI accepted the job but returned no id.', {
        hint: 'Retry; if it persists, check the Kie AI dashboard.',
      })
    }

    const url = await pollUntilDone(
      async () => {
        const status = await kieRequest<RecordInfoData>(
          `${RECORD_INFO_PATH}?taskId=${encodeURIComponent(taskId)}`,
          options.apiKey,
          { method: 'GET', ...(options.signal ? { signal: options.signal } : {}) },
          'status check',
        )

        // Finished-and-failed is still finished (§6.2): throwing here ends the
        // loop rather than waiting out the timeout on a dead job.
        if (status.state === TERMINAL_FAILURE) {
          throw failureError(status)
        }

        if (status.state === TERMINAL_SUCCESS) {
          return { status: 'done', value: firstResultUrl(status.resultJson) }
        }

        return {
          status: 'pending',
          ...(status.progress === undefined ? {} : { progress: status.progress * 100 }),
        }
      },
      {
        log: options.log,
        label: `Generating with ${resolved.modelId}`,
        ...(options.signal ? { signal: options.signal } : {}),
      },
    )

    const data = await download(url, options.signal)

    return {
      data,
      // Sniffed downstream by saveMedia; this is only the provider's claim.
      mimeType: resolved.outputFormat === 'jpeg' ? 'image/jpeg' : 'image/png',
      requestId: taskId,
    }
  },
})

/**
 * Kie reports a content block as an ordinary job failure, so it has to be
 * recognised from the text. §6.2 requires it not to read as a network error.
 */
function failureError(status: RecordInfoData): MediagenError {
  const detail = [status.failCode, status.failMsg].filter(Boolean).join(': ')

  if (/nsfw|safety|policy|blocked|sensitive|violat/i.test(detail)) {
    return new MediagenError(
      ERROR_CODE.CONTENT_BLOCKED,
      'Kie AI declined to generate this prompt on content-policy grounds.',
      { hint: 'Rephrase the prompt, or try another provider.', cause: detail },
    )
  }

  return new MediagenError(ERROR_CODE.API_ERROR, 'The Kie AI job failed.', {
    hint: 'Retry, or try another model with --model.',
    cause: detail,
  })
}

/** The result arrives as JSON encoded inside a JSON string field. */
function firstResultUrl(resultJson: string | undefined): string {
  if (resultJson === undefined) {
    throw new MediagenError(ERROR_CODE.API_ERROR, 'Kie AI reported success but returned no result.')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(resultJson)
  } catch {
    throw new MediagenError(
      ERROR_CODE.API_ERROR,
      'Kie AI returned a result this build cannot read.',
      {
        hint: 'Run again with --verbose, and report the output.',
        cause: resultJson,
      },
    )
  }

  const urls: unknown =
    typeof parsed === 'object' && parsed !== null
      ? (parsed as { resultUrls?: unknown }).resultUrls
      : undefined

  // Kie returns an array for most models and a bare string for a few.
  const first: unknown = Array.isArray(urls) ? urls[0] : urls

  if (typeof first !== 'string' || first.length === 0) {
    throw new MediagenError(ERROR_CODE.API_ERROR, 'Kie AI reported success but returned no image.')
  }

  return first
}

async function upload(
  apiKey: string,
  data: Uint8Array,
  mimeType: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  const extension = mimeType === 'image/jpeg' ? 'jpg' : mimeType === 'image/webp' ? 'webp' : 'png'

  const result = await kieRequest<UploadData>(
    UPLOAD_PATH,
    apiKey,
    {
      method: 'POST',
      body: {
        base64Data: `data:${mimeType};base64,${Buffer.from(data).toString('base64')}`,
        uploadPath: UPLOAD_DIRECTORY,
        fileName: `input.${extension}`,
      },
      ...(signal ? { signal } : {}),
    },
    'input image upload',
  )

  if (result.downloadUrl === undefined) {
    throw new MediagenError(
      ERROR_CODE.API_ERROR,
      'Kie AI accepted the upload but returned no URL.',
      {
        hint: 'Retry; if it persists, check the Kie AI dashboard.',
      },
    )
  }

  return result.downloadUrl
}

/**
 * Spec §8 — the limit is enforced from the declared length before the body is
 * read, so an oversized response is refused rather than buffered and then
 * rejected.
 */
async function download(url: string, signal: AbortSignal | undefined): Promise<Uint8Array> {
  const response = await fetch(url, signal ? { signal } : {})

  if (!response.ok) {
    throw new MediagenError(
      ERROR_CODE.NETWORK_ERROR,
      `Could not download the generated image (${response.status}).`,
      { hint: 'Retry; the link Kie returns is short-lived.' },
    )
  }

  const declared = Number(response.headers.get('content-length') ?? '0')
  if (declared > MAX_DOWNLOAD_BYTES) {
    throw new MediagenError(
      ERROR_CODE.API_ERROR,
      `Kie AI returned ${Math.round(declared / 1024 / 1024)} MB, above the ${
        MAX_DOWNLOAD_BYTES / 1024 / 1024
      } MB limit.`,
      { hint: 'Request a smaller size with --size.' },
    )
  }

  const buffer = new Uint8Array(await response.arrayBuffer())

  // A response with no content-length still has to be bounded, just later.
  if (buffer.byteLength > MAX_DOWNLOAD_BYTES) {
    throw new MediagenError(ERROR_CODE.API_ERROR, 'The downloaded image exceeded the size limit.', {
      hint: 'Request a smaller size with --size.',
    })
  }

  return buffer
}
