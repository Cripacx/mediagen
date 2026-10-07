/**
 * One Kie AI job, from input upload to downloaded result.
 *
 * Images and video go through the same three steps — create a task, poll
 * until it finishes, download the result — so both clients share this file
 * and differ only in the request body they build and the bounds they apply.
 *
 * Three things this file is careful about:
 *
 * - **Terminal states.** A job that reports `fail` is finished. Polling it
 *   again would waste the timeout waiting for a result that will never come.
 * - **Content blocks.** Kie reports these as ordinary job failures, so they
 *   are recognised from the failure text and mapped to CONTENT_BLOCKED rather
 *   than reading to the user as a network problem.
 * - **Input media.** Kie takes URLs, not inline data, so a local file is
 *   uploaded to Kie's own store first and referenced.
 */

import { ERROR_CODE, MediagenError } from '../../core/errors.js'
import { loadInputMedia } from '../../core/inputMedia.js'
import { pollUntilDone, type PollingOptions } from '../shared/polling.js'
import {
  CREATE_TASK_URL,
  RECORD_INFO_URL,
  UPLOAD_DIRECTORY,
  UPLOAD_URL,
  kieRequest,
  type CreateTaskData,
  type RecordInfoData,
  type UploadData,
} from './api.js'
import type { Logger } from '../../types/provider.js'

/** Job states reported by recordInfo. */
const TERMINAL_SUCCESS = 'success'
const TERMINAL_FAILURE = 'fail'

export interface TaskOptions {
  readonly apiKey: string
  readonly log: Logger
  readonly signal?: AbortSignal | undefined
}

export interface FinishedTask {
  readonly taskId: string
  /** Short-lived link to the result. */
  readonly resultUrl: string
}

/** Starts a job and waits for it to finish. */
export async function runTask(
  modelId: string,
  input: Readonly<Record<string, unknown>>,
  options: TaskOptions,
  polling: Pick<PollingOptions, 'timeoutMs' | 'initialDelayMs' | 'maxDelayMs'> = {},
): Promise<FinishedTask> {
  const signal = options.signal ? { signal: options.signal } : {}

  options.log.debug(`kie: creating task for ${modelId}`)

  const created = await kieRequest<CreateTaskData>(
    CREATE_TASK_URL,
    options.apiKey,
    { method: 'POST', body: { model: modelId, input }, ...signal },
    'task creation',
  )

  const taskId = created.taskId
  if (taskId === undefined) {
    throw new MediagenError(ERROR_CODE.API_ERROR, 'Kie AI accepted the job but returned no id.', {
      hint: 'Retry; if it persists, check the Kie AI dashboard.',
    })
  }

  const resultUrl = await pollUntilDone(
    async () => {
      const status = await kieRequest<RecordInfoData>(
        `${RECORD_INFO_URL}?taskId=${encodeURIComponent(taskId)}`,
        options.apiKey,
        { method: 'GET', ...signal },
        'status check',
      )

      // Finished-and-failed is still finished: throwing here ends the
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
    { ...polling, log: options.log, label: `Generating with ${modelId}`, ...signal },
  )

  return { taskId, resultUrl }
}

/**
 * Kie reports a content block as an ordinary job failure, so it has to be
 * recognised from the text, so that it does not read as a network error.
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
    throw new MediagenError(ERROR_CODE.API_ERROR, 'Kie AI reported success but returned no file.')
  }

  return first
}

/** Stages a local input image in Kie's file store and returns its URL. */
export async function uploadInputImage(
  path: string,
  apiKey: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  const { data, mimeType } = await loadInputMedia(path)
  const extension = mimeType === 'image/jpeg' ? 'jpg' : mimeType === 'image/webp' ? 'webp' : 'png'

  const result = await kieRequest<UploadData>(
    UPLOAD_URL,
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

export interface DownloadLimits {
  readonly maxBytes: number
  /** What the file is called in messages: "image" or "video". */
  readonly noun: string
  /** How to ask for a smaller result. */
  readonly smallerHint: string
}

/**
 * The limit is enforced from the declared length before the body is
 * read, so an oversized response is refused rather than buffered and then
 * rejected.
 */
export async function download(
  url: string,
  signal: AbortSignal | undefined,
  limits: DownloadLimits,
): Promise<Uint8Array> {
  const response = await fetch(url, signal ? { signal } : {})

  if (!response.ok) {
    throw new MediagenError(
      ERROR_CODE.NETWORK_ERROR,
      `Could not download the generated ${limits.noun} (${response.status}).`,
      { hint: 'Retry; the link Kie returns is short-lived.' },
    )
  }

  const declared = Number(response.headers.get('content-length') ?? '0')
  if (declared > limits.maxBytes) {
    throw new MediagenError(
      ERROR_CODE.API_ERROR,
      `Kie AI returned ${Math.round(declared / 1024 / 1024)} MB, above the ${
        limits.maxBytes / 1024 / 1024
      } MB limit.`,
      { hint: limits.smallerHint },
    )
  }

  const buffer = new Uint8Array(await response.arrayBuffer())

  // A response with no content-length still has to be bounded, just later.
  if (buffer.byteLength > limits.maxBytes) {
    throw new MediagenError(
      ERROR_CODE.API_ERROR,
      `The downloaded ${limits.noun} exceeded the size limit.`,
      { hint: limits.smallerHint },
    )
  }

  return buffer
}
