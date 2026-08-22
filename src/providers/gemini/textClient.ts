/**
 * Gemini text completion, used only to verify a credential cheaply (§4.5).
 */

import { ERROR_CODE, MediagenError } from '../../core/errors.js'
import { createGenAI, mapGeminiError } from './client.js'
import type { TextClient, TextClientFactory } from '../../types/provider.js'

export const createTextClient: TextClientFactory = (): TextClient => ({
  async complete(instruction, options) {
    let interaction: unknown
    try {
      interaction = await createGenAI(options.apiKey).interactions.create({
        model: options.model,
        input: instruction,
      })
    } catch (error) {
      mapGeminiError(error)
    }

    const text = collectText(interaction).trim()

    if (text.length === 0) {
      throw new MediagenError(ERROR_CODE.API_ERROR, 'Gemini returned no text.')
    }

    return text
  },
})

function collectText(interaction: unknown): string {
  if (typeof interaction !== 'object' || interaction === null) return ''

  // The SDK exposes a convenience accessor; walking the steps is the fallback
  // for when the shape is not what this version expects.
  const direct: unknown = (interaction as { text?: unknown }).text
  if (typeof direct === 'string') return direct

  const steps: unknown = (interaction as { steps?: unknown }).steps
  if (!Array.isArray(steps)) return ''

  return steps
    .flatMap((step: unknown): unknown[] => {
      if (typeof step !== 'object' || step === null) return []
      const content: unknown = (step as { content?: unknown }).content
      return Array.isArray(content) ? content : []
    })
    .map((part: unknown): string => {
      if (typeof part !== 'object' || part === null) return ''
      const value: unknown = (part as { text?: unknown }).text
      return typeof value === 'string' ? value : ''
    })
    .join('')
}
