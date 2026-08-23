/**
 * What the Gemini probe is allowed to cost, and where cancellation goes.
 *
 * Two things are pinned here because both failed silently before.
 *
 * The probe must not generate. Verifying a key runs on `init`, on every
 * `config set`, and on every `doctor` — a probe that produces tokens turns a
 * diagnostic into a billable action, and nobody expects `doctor` to spend
 * anything.
 *
 * And the abort signal must travel in the SDK's own options, not beside the
 * request. The SDK forwards what it does not recognise to Google as a request
 * field, and a request carrying `signal` comes back `400 Unknown parameter
 * 'signal'` — which the error mapping reads as a rejected credential. Every
 * Gemini key reported as broken that way, whatever it was.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

/** Only the shape the probe is allowed to use, so the assertions stay typed. */
interface ListParams {
  readonly config?: { readonly pageSize?: number; readonly abortSignal?: AbortSignal }
}

const list = vi.fn<(params: ListParams) => Promise<unknown>>().mockResolvedValue({ page: [] })
const create = vi.fn().mockResolvedValue({ status: 'completed' })

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = { list }
    interactions = { create }
  },
}))

afterEach(() => {
  list.mockClear()
  create.mockClear()
})

/** Imported lazily so the mock is in place first. */
async function runProbe(signal?: AbortSignal): Promise<void> {
  const { probe } = await import('../probe.js')
  await probe({ apiKey: 'test-key', ...(signal === undefined ? {} : { signal }) })
}

describe('the Gemini probe', () => {
  it('costs nothing: it lists models rather than generating', async () => {
    await runProbe()

    expect(list).toHaveBeenCalledOnce()
    expect(create).not.toHaveBeenCalled()
  })

  it('asks for one entry, since that already proves the key', async () => {
    await runProbe()

    expect(list.mock.calls[0]![0]).toMatchObject({ config: { pageSize: 1 } })
  })

  it('hands cancellation to the SDK as config, never as a request field', async () => {
    const signal = AbortSignal.timeout(1_000)
    await runProbe(signal)

    const [params] = list.mock.calls[0]!
    expect(params.config).toMatchObject({ abortSignal: signal })
    // The failure this guards against: `signal` reaching Google as a field.
    expect(params).not.toHaveProperty('signal')
  })

  it('omits the signal entirely when there is nothing to cancel', async () => {
    await runProbe()

    expect(list.mock.calls[0]![0].config).not.toHaveProperty('abortSignal')
  })
})
