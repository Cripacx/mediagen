/**
 * The Kie AI transport.
 *
 * Kie has no SDK, so this is plain fetch. Its API is asynchronous throughout:
 *
 *   POST /api/v1/jobs/createTask     start a job, get a task id
 *   GET  /api/v1/jobs/recordInfo     ask whether it finished
 *   POST /api/file-base64-upload     stage a local input image
 *
 * The upload step exists because Kie takes input images as URLs rather than
 * inline data (§6.4), so a local file has to be put somewhere Kie can fetch it
 * before it can be referenced.
 *
 * Kie answers with HTTP 200 and an error code in the body more often than with
 * an HTTP error, so the envelope's `code` is checked as carefully as the
 * status.
 */

import { ERROR_CODE, MediagenError } from '../../core/errors.js'
import { command } from '../../core/invocation.js'

const API_BASE = 'https://api.kie.ai'
export const CREATE_TASK_PATH = '/api/v1/jobs/createTask'
export const RECORD_INFO_PATH = '/api/v1/jobs/recordInfo'
export const UPLOAD_PATH = '/api/file-base64-upload'

/** Directory the staged input images are written to in Kie's file store. */
export const UPLOAD_DIRECTORY = 'mediagen'

const REQUEST_TIMEOUT_MS = 60_000

export interface KieEnvelope<T> {
  code?: number
  msg?: string
  data?: T
}

export interface CreateTaskData {
  taskId?: string
}

export interface RecordInfoData {
  state?: string
  resultJson?: string
  failCode?: string
  failMsg?: string
  progress?: number
}

export interface UploadData {
  downloadUrl?: string
}

export interface RequestInit_ {
  readonly method: 'GET' | 'POST'
  readonly body?: unknown
  readonly signal?: AbortSignal
}

export async function kieRequest<T>(
  path: string,
  apiKey: string,
  init: RequestInit_,
  stage: string,
): Promise<T> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout

  const response = await fetch(`${API_BASE}${path}`, {
    method: init.method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    signal,
  })

  if (!response.ok) {
    throw httpError(response.status, stage)
  }

  const envelope = (await response.json()) as KieEnvelope<T>

  // Kie reports most failures inside a 200. Treating only HTTP status as
  // authoritative would make a rejected request look like a successful one
  // with missing data.
  if (envelope.code !== undefined && envelope.code !== 200) {
    throw envelopeError(envelope.code, envelope.msg, stage)
  }

  if (envelope.data === undefined) {
    throw new MediagenError(ERROR_CODE.API_ERROR, `Kie AI returned no data during ${stage}.`, {
      hint: 'Retry; if it persists, check the Kie AI dashboard.',
    })
  }

  return envelope.data
}

function httpError(status: number, stage: string): MediagenError {
  if (status === 401 || status === 403) {
    return new MediagenError(ERROR_CODE.CONFIG_ERROR, 'Kie AI rejected the API key.', {
      hint: `Run: ${command('config set kie')}`,
    })
  }
  if (status === 429) {
    return new MediagenError(ERROR_CODE.API_ERROR, 'Kie AI rate-limited the request.', {
      hint: 'Wait and retry, or use another provider for this run.',
    })
  }
  if (status >= 500) {
    return new MediagenError(ERROR_CODE.API_ERROR, `Kie AI returned ${status} during ${stage}.`, {
      hint: 'This is upstream; retry shortly.',
    })
  }
  return new MediagenError(ERROR_CODE.API_ERROR, `Kie AI rejected the request (${status}).`, {
    hint: 'Run again with --verbose to see the upstream detail.',
  })
}

/**
 * Spec §6.5 — the upstream message is not forwarded, because Kie echoes the
 * prompt back in validation errors. It is kept as `cause` for --verbose.
 */
function envelopeError(code: number, message: string | undefined, stage: string): MediagenError {
  if (code === 401 || code === 403) {
    return new MediagenError(ERROR_CODE.CONFIG_ERROR, 'Kie AI rejected the API key.', {
      hint: `Run: ${command('config set kie')}`,
      cause: message,
    })
  }

  if (code === 402) {
    return new MediagenError(ERROR_CODE.CONFIG_ERROR, 'The Kie AI account is out of credit.', {
      hint: 'Top up at https://kie.ai, or use another provider for this run.',
      cause: message,
    })
  }

  if (code === 422 || code === 400) {
    return new MediagenError(
      ERROR_CODE.VALIDATION_ERROR,
      `Kie AI rejected the request during ${stage}.`,
      {
        hint: 'Check the model id and the requested shape with: mediagen models',
        cause: message,
      },
    )
  }

  if (code === 429) {
    return new MediagenError(ERROR_CODE.API_ERROR, 'Kie AI rate-limited the request.', {
      hint: 'Wait and retry, or use another provider for this run.',
      cause: message,
    })
  }

  return new MediagenError(ERROR_CODE.API_ERROR, `Kie AI reported error ${code} during ${stage}.`, {
    hint: 'Check the Kie AI dashboard for job status and credit balance.',
    cause: message,
  })
}
