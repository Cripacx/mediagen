/**
 * Google Gemini.
 *
 * Spec §6.1 — pure data and validation only. The clients below are reached
 * through lazy factories, so importing this file costs nothing beyond the
 * catalogue and never loads the transport.
 */

import { findModel, validateAgainst } from '../../core/capabilities.js'
import {
  GEMINI_IMAGE_MODELS,
  GEMINI_VIDEO_MODELS,
  defaultImageModel,
  defaultVideoModel,
} from './models.js'
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
  kinds: ['image', 'video'],

  defaultModel(kind, quality) {
    return kind === 'video' ? defaultVideoModel(quality) : defaultImageModel(quality)
  },

  listModels(kind) {
    return kind === 'video' ? GEMINI_VIDEO_MODELS : GEMINI_IMAGE_MODELS
  },

  validate(request, model) {
    const catalogue = request.kind === 'video' ? GEMINI_VIDEO_MODELS : GEMINI_IMAGE_MODELS
    validateAgainst(request, model, findModel(catalogue, model))
  },

  clients: {
    image: async () => (await import('./imageClient.js')).createImageClient,
    video: async () => (await import('./videoClient.js')).createVideoClient,
  },

  probe: async () => (await import('./probe.js')).probe,
} as const satisfies ProviderManifest
