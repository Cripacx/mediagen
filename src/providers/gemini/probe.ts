/**
 * Proves a Gemini credential without spending anything.
 *
 * Listing models is authenticated but consumes no tokens and no generation
 * quota, so `doctor` can be run as often as it is useful. The previous probe
 * sent a one-token text interaction instead, which cost little but bought
 * nothing extra: a text call cannot show that a key may generate images
 * either, so both prove the same thing and only one is free.
 *
 * This matches what the OpenAI probe does, for the same reason.
 */

import { createGenAI, mapGeminiError } from './client.js'
import type { Probe } from '../../types/provider.js'

export const probe: Probe = async ({ apiKey, signal }) => {
  try {
    await createGenAI(apiKey).models.list({
      // One entry is enough to know the credential was accepted.
      config: { pageSize: 1, ...(signal ? { abortSignal: signal } : {}) },
    })
  } catch (error) {
    mapGeminiError(error)
  }
}
