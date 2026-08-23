/**
 * The shared polling loop.
 */

import { describe, expect, it, vi } from 'vitest'
import { pollUntilDone, type PollOutcome } from '../polling.js'
import { ERROR_CODE, MediagenError } from '../../../core/errors.js'
import type { Logger } from '../../../types/provider.js'

const FAST = { initialDelayMs: 1, maxDelayMs: 4, backoffFactor: 2 } as const

function recordingLogger(): { log: Logger; progress: string[] } {
  const progress: string[] = []
  return {
    progress,
    log: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      progress: (message) => progress.push(message),
    },
  }
}

describe('completion', () => {
  it('returns the value once the job reports done', async () => {
    const check = vi
      .fn<() => Promise<PollOutcome<string>>>()
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'done', value: 'the-url' })

    await expect(pollUntilDone(check, FAST)).resolves.toBe('the-url')
    expect(check).toHaveBeenCalledTimes(2)
  })

  it('stops checking as soon as the job is done', async () => {
    const check = vi
      .fn<() => Promise<PollOutcome<number>>>()
      .mockResolvedValue({ status: 'done', value: 1 })

    await pollUntilDone(check, FAST)

    expect(check).toHaveBeenCalledTimes(1)
  })
})

describe('terminal failures', () => {
  it('does not keep polling a job that already failed', async () => {
    // Finished-and-failed is still finished. Continuing would spend the whole
    // timeout waiting for a result that will never arrive.
    const check = vi
      .fn<() => Promise<PollOutcome<string>>>()
      .mockResolvedValueOnce({ status: 'pending' })
      .mockRejectedValueOnce(new MediagenError(ERROR_CODE.API_ERROR, 'the job failed'))

    await expect(pollUntilDone(check, FAST)).rejects.toThrow('the job failed')
    expect(check).toHaveBeenCalledTimes(2)
  })

  it('lets a content block keep its own identity rather than becoming a timeout', async () => {
    const blocked = new MediagenError(ERROR_CODE.CONTENT_BLOCKED, 'declined')
    const check = vi.fn<() => Promise<PollOutcome<string>>>().mockRejectedValue(blocked)

    await expect(pollUntilDone(check, FAST)).rejects.toMatchObject({
      code: ERROR_CODE.CONTENT_BLOCKED,
    })
  })
})

describe('the timeout', () => {
  it('gives up with a clear error rather than hanging', async () => {
    const check = vi
      .fn<() => Promise<PollOutcome<string>>>()
      .mockResolvedValue({ status: 'pending' })

    await expect(pollUntilDone(check, { ...FAST, timeoutMs: 25 })).rejects.toMatchObject({
      code: ERROR_CODE.TIMEOUT,
    })
  })

  it('says how long it waited and what to do next', async () => {
    const check = vi
      .fn<() => Promise<PollOutcome<string>>>()
      .mockResolvedValue({ status: 'pending' })

    try {
      await pollUntilDone(check, { ...FAST, timeoutMs: 25 })
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as Error).message).toMatch(/did not finish within/)
      expect((error as { hint?: string }).hint).toBeDefined()
    }
  })
})

describe('backoff', () => {
  it('grows the delay but never past the ceiling', async () => {
    const delays: number[] = []
    let previous = Date.now()

    const check = vi.fn((): Promise<PollOutcome<string>> => {
      const now = Date.now()
      delays.push(now - previous)
      previous = now
      return Promise.resolve(
        delays.length < 5 ? { status: 'pending' } : { status: 'done', value: 'x' },
      )
    })

    await pollUntilDone(check, { initialDelayMs: 4, maxDelayMs: 12, backoffFactor: 2 })

    // Timing is not exact under load, so this asserts the ceiling rather than
    // each individual step.
    for (const delay of delays) {
      expect(delay).toBeLessThan(120)
    }
    expect(delays.length).toBe(5)
  })
})

describe('cancellation', () => {
  it('stops when the caller aborts', async () => {
    const controller = new AbortController()
    const check = vi.fn((): Promise<PollOutcome<string>> => {
      controller.abort()
      return Promise.resolve({ status: 'pending' })
    })

    await expect(pollUntilDone(check, { ...FAST, signal: controller.signal })).rejects.toThrow(
      /Cancelled/,
    )
  })

  it('does not start when the signal is already aborted', async () => {
    const check = vi.fn<() => Promise<PollOutcome<string>>>()

    await expect(pollUntilDone(check, { ...FAST, signal: AbortSignal.abort() })).rejects.toThrow(
      /Cancelled/,
    )
    expect(check).not.toHaveBeenCalled()
  })
})

describe('progress', () => {
  it('reports progress to the logger, which writes to stderr', async () => {
    const { log, progress } = recordingLogger()
    const check = vi
      .fn<() => Promise<PollOutcome<string>>>()
      .mockResolvedValueOnce({ status: 'pending', progress: 42 })
      .mockResolvedValueOnce({ status: 'done', value: 'x' })

    await pollUntilDone(check, { ...FAST, log, label: 'Rendering' })

    expect(progress).toHaveLength(1)
    expect(progress[0]).toContain('Rendering')
    expect(progress[0]).toContain('42%')
  })

  it('reports elapsed time even when the provider gives no percentage', async () => {
    const { log, progress } = recordingLogger()
    const check = vi
      .fn<() => Promise<PollOutcome<string>>>()
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'done', value: 'x' })

    await pollUntilDone(check, { ...FAST, log })

    expect(progress[0]).toMatch(/\(\d+s\)/)
  })
})
