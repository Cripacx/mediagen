/**
 * Polling for providers whose generation API is asynchronous.
 *
 * These providers accept a job and return an identifier; the media
 * only exists once the job finishes. Every such adapter needs the same loop,
 * so it lives here rather than being rewritten per provider. Video makes this
 * the normal path rather than the exception: it takes minutes.
 *
 * Four requirements shape the loop:
 *
 * - Exponential backoff with a ceiling, so a slow job does not become a
 *   thousand requests.
 * - An overall timeout that produces a clear error rather than a hang.
 * - Terminal states distinguished. A content block is not a network error,
 *   and reporting it as one sends the user to check their connection.
 * - Finished-and-failed is still finished. A failed job is never polled again
 *   in the hope it improves.
 *
 * The last two are the caller's part of the bargain: `check` reports progress
 * by returning and reports every terminal failure by throwing a mapped
 * `MediagenError`. There is no third option, which is what keeps a failed job
 * from being mistaken for a slow one.
 */

import { ERROR_CODE, MediagenError } from '../../core/errors.js'
import type { Logger } from '../../types/provider.js'

export interface PollingOptions {
  /** Give up after this long. */
  readonly timeoutMs?: number
  /** Delay before the first status check. */
  readonly initialDelayMs?: number
  /** Upper bound the backoff grows to. */
  readonly maxDelayMs?: number
  /** Multiplier applied to the delay after each check. */
  readonly backoffFactor?: number
  /** Progress goes to stderr, never stdout. */
  readonly log?: Logger
  /** What is being waited on, for the progress line. */
  readonly label?: string
  readonly signal?: AbortSignal
}

const DEFAULTS = {
  timeoutMs: 300_000,
  initialDelayMs: 2_000,
  maxDelayMs: 15_000,
  backoffFactor: 1.5,
} as const

/** One status check: the job finished, or it is still running. */
export type PollOutcome<T> =
  | { readonly status: 'done'; readonly value: T }
  | { readonly status: 'pending'; readonly progress?: number; readonly message?: string }

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new MediagenError(ERROR_CODE.API_ERROR, 'Cancelled.'))
      return
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)

    function onAbort(): void {
      clearTimeout(timer)
      reject(new MediagenError(ERROR_CODE.API_ERROR, 'Cancelled.'))
    }

    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Runs `check` until it reports completion or the timeout expires.
 *
 * Anything `check` throws propagates immediately and ends the loop, which is
 * how a provider-side failure, a content block or a cancellation each keep
 * their own identity instead of collapsing into "timed out".
 */
export async function pollUntilDone<T>(
  check: () => Promise<PollOutcome<T>>,
  options: PollingOptions = {},
): Promise<T> {
  const { timeoutMs, initialDelayMs, maxDelayMs, backoffFactor } = { ...DEFAULTS, ...options }
  const { log, label = 'Generating', signal } = options

  const started = Date.now()
  const deadline = started + timeoutMs
  let delay = initialDelayMs

  while (Date.now() < deadline) {
    await sleep(Math.min(delay, Math.max(0, deadline - Date.now())), signal)

    const outcome = await check()

    if (outcome.status === 'done') {
      return outcome.value
    }

    if (log) {
      const elapsed = Math.round((Date.now() - started) / 1000)
      const percent = outcome.progress === undefined ? '' : ` ${Math.round(outcome.progress)}%`
      const detail = outcome.message === undefined ? '' : ` — ${outcome.message}`
      log.progress(`${label}…${percent} (${elapsed}s)${detail}`)
    }

    delay = Math.min(delay * backoffFactor, maxDelayMs)
  }

  throw new MediagenError(
    ERROR_CODE.TIMEOUT,
    `The job did not finish within ${Math.round(timeoutMs / 1000)}s.`,
    {
      hint: 'The provider may still be working on it; retry, or choose a faster model.',
    },
  )
}
