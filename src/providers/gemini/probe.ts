/**
 * The cheapest authenticated request Google offers.
 *
 * A one-token text interaction is used rather than an image generation, so
 * verifying a key costs effectively nothing.
 */

import { createGenAI, mapGeminiError } from './client.js'
import { GEMINI_PROBE_MODEL } from './models.js'
import type { Probe } from '../../types/provider.js'

export const probe: Probe = async ({ apiKey, signal }) => {
  try {
    await createGenAI(apiKey).interactions.create({
      model: GEMINI_PROBE_MODEL,
      input: 'ping',
      ...(signal ? { signal } : {}),
    })
  } catch (error) {
    mapGeminiError(error)
  }
}
