/**
 * The cheapest authenticated request OpenAI offers.
 *
 * Listing models costs nothing and no tokens, which is a better probe than a
 * one-token completion: it proves the key authenticates without billing for
 * the privilege.
 */

import { createOpenAI, mapOpenAIError } from './client.js'
import type { Probe } from '../../types/provider.js'

export const probe: Probe = async ({ apiKey, signal }) => {
  try {
    await createOpenAI(apiKey).models.list(signal ? { signal } : {})
  } catch (error) {
    mapOpenAIError(error)
  }
}
