/**
 * The `@google/genai` client, shared by the image and text clients.
 *
 * Kept out of the manifest so that `doctor`, `config` and the
 * registry never load the SDK. It is reached only through the manifest's lazy
 * factories, at the moment Gemini is actually used.
 *
 * The SDK is used rather than a hand-rolled fetch because Google versions the
 * Interactions API by revision header, and tracking that is exactly the work
 * the SDK exists to do. It also ships the accepted aspect ratios and sizes as
 * types, which is a better catalogue source than the prose docs — see the note
 * in `models.ts`.
 */

import { GoogleGenAI } from '@google/genai'
import { ERROR_CODE, MediagenError } from '../../core/errors.js'
import { command } from '../../core/invocation.js'

export function createGenAI(apiKey: string): GoogleGenAI {
  return new GoogleGenAI({ apiKey })
}

/**
 * Maps the SDK's errors onto the shared taxonomy. The upstream
 * message is never forwarded: Google's 400s quote the request back, which can
 * echo the prompt.
 *
 * An error with no status is a transport failure rather than a rejection, and
 * is rethrown so `toMediagenError` can recognise the socket error underneath.
 */
export function mapGeminiError(error: unknown): never {
  const status = statusOf(error)

  if (status === 401 || status === 403) {
    throw new MediagenError(ERROR_CODE.CONFIG_ERROR, 'Google rejected the API key.', {
      hint: `Run: ${command('config set gemini')}`,
      cause: error,
    })
  }

  if (status === 429) {
    throw new MediagenError(ERROR_CODE.API_ERROR, 'Google rate-limited the request.', {
      hint: 'Wait and retry, or use --provider openai for this run.',
      cause: error,
    })
  }

  if (status === 400 && looksLikeSafetyRejection(error)) {
    throw new MediagenError(
      ERROR_CODE.CONTENT_BLOCKED,
      'Google declined to generate this prompt on safety grounds.',
      { hint: 'Rephrase the prompt, or try another provider.', cause: error },
    )
  }

  if (status !== undefined && status >= 500) {
    throw new MediagenError(ERROR_CODE.API_ERROR, `Google returned ${status}.`, {
      hint: 'This is upstream; retry shortly.',
      cause: error,
    })
  }

  if (status !== undefined) {
    throw new MediagenError(ERROR_CODE.API_ERROR, `Google rejected the request (${status}).`, {
      hint: 'Run again with --verbose to see the upstream detail.',
      cause: error,
    })
  }

  throw error
}

function statusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const candidate: unknown = (error as { status?: unknown }).status
  return typeof candidate === 'number' ? candidate : undefined
}

function looksLikeSafetyRejection(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /safety|blocked|prohibited|policy/i.test(message)
}
