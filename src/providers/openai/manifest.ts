/**
 * OpenAI.
 *
 * Spec §6.1 — pure data and validation only; the SDK is reached through the
 * lazy factories below. Adding this provider touched exactly one other file,
 * the registry's manifest list, which is the acceptance criterion §6.1 sets.
 */

import { findModel, validateAgainst } from '../../core/capabilities.js'
import { OPENAI_IMAGE_MODELS, defaultImageModel } from './models.js'
import type { ProviderManifest } from '../../types/provider.js'

export const openaiManifest = {
  id: 'openai',
  label: 'OpenAI',
  credential: {
    envVar: 'OPENAI_API_KEY',
    description: 'your OpenAI API key',
    minLength: 20,
    signupUrl: 'https://platform.openai.com/api-keys',
  },
  kinds: ['image'],

  defaultModel(kind, quality) {
    if (kind !== 'image') {
      throw new Error(`openai does not generate ${kind}`)
    }
    return defaultImageModel(quality)
  },

  listModels(kind) {
    return kind === 'image' ? OPENAI_IMAGE_MODELS : []
  },

  validate(request, model) {
    validateAgainst(request, model, findModel(OPENAI_IMAGE_MODELS, model))
  },

  clients: {
    image: async () => (await import('./imageClient.js')).createImageClient,
  },

  probe: async () => (await import('./probe.js')).probe,
} as const satisfies ProviderManifest
