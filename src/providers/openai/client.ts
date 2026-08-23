/**
 * The `openai` client and its error mapping.
 *
 * Kept out of the manifest so `doctor` and `config` never load the SDK.
 */

import OpenAI from 'openai'
import { ERROR_CODE, MediagenError } from '../../core/errors.js'
import { command } from '../../core/invocation.js'

export function createOpenAI(apiKey: string): OpenAI {
  return new OpenAI({ apiKey })
}

/**
 * The upstream message is never forwarded: OpenAI's 400s quote the
 * prompt back, and its moderation refusals quote it in full.
 *
 * An error with no status is a transport failure rather than a rejection, and
 * is rethrown so `toMediagenError` can see the socket error underneath.
 */
export function mapOpenAIError(error: unknown): never {
  const status = statusOf(error)

  if (status === 401) {
    throw new MediagenError(ERROR_CODE.CONFIG_ERROR, 'OpenAI rejected the API key.', {
      hint: `Run: ${command('config set openai')}`,
      cause: error,
    })
  }

  if (status === 403) {
    throw new MediagenError(
      ERROR_CODE.CONFIG_ERROR,
      'OpenAI refused this key access to that model.',
      {
        hint: 'Image models need a verified organisation; check your account, or use --provider gemini.',
        cause: error,
      },
    )
  }

  if (status === 429) {
    throw new MediagenError(ERROR_CODE.API_ERROR, 'OpenAI rate-limited the request.', {
      hint: 'Wait and retry, or use --provider gemini for this run.',
      cause: error,
    })
  }

  if (isModerationRejection(error)) {
    throw new MediagenError(
      ERROR_CODE.CONTENT_BLOCKED,
      'OpenAI declined to generate this prompt on content-policy grounds.',
      { hint: 'Rephrase the prompt, or try another provider.', cause: error },
    )
  }

  if (status !== undefined && status >= 500) {
    throw new MediagenError(ERROR_CODE.API_ERROR, `OpenAI returned ${status}.`, {
      hint: 'This is upstream; retry shortly.',
      cause: error,
    })
  }

  if (status !== undefined) {
    throw new MediagenError(ERROR_CODE.API_ERROR, `OpenAI rejected the request (${status}).`, {
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

function isModerationRejection(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const code: unknown = (error as { code?: unknown }).code
  if (code === 'moderation_blocked' || code === 'content_policy_violation') return true

  const message = error instanceof Error ? error.message : ''
  return /safety system|content policy|moderation/i.test(message)
}
