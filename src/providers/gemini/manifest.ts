/**
 * Google Gemini.
 *
 * Spec §6.1 — pure data and validation only. The clients below are reached
 * through lazy factories, so importing this file costs nothing beyond the
 * catalogue and never loads the transport.
 */

import { findModel, validateAgainst } from '../../core/capabilities.js'
import { GEMINI_IMAGE_MODELS, GEMINI_TEXT_MODEL, defaultImageModel } from './models.js'
import type { ProviderManifest } from '../../types/provider.js'

export const geminiManifest = {
  id: 'gemini',
  label: 'Google Gemini',
  credential: {
    envVar: 'GEMINI_API_KEY',
    description: 'your Google AI API key',
    minLength: 10,
    signupUrl: 'https://aistudio.google.com/apikey',
  },
  kinds: ['image'],

  defaultModel(kind, quality) {
    if (kind !== 'image') {
      throw new Error(`gemini does not generate ${kind}`)
    }
    return defaultImageModel(quality)
  },

  listModels(kind) {
    return kind === 'image' ? GEMINI_IMAGE_MODELS : []
  },

  validate(request, model) {
    validateAgainst(request, model, findModel(GEMINI_IMAGE_MODELS, model))
  },

  clients: {
    image: async () => (await import('./imageClient.js')).createImageClient,
  },

  textClient: async () => (await import('./textClient.js')).createTextClient,
  textModel: GEMINI_TEXT_MODEL,
} as const satisfies ProviderManifest

/** Exported so key verification can name the model without loading the client. */
export { GEMINI_TEXT_MODEL }
