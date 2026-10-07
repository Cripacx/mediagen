/**
 * Kie AI.
 *
 * Pure data and validation; the fetch client loads lazily.
 *
 * `probe` is deliberately null. Kie exposes no endpoint cheap enough to verify
 * a key with: everything it offers starts a billable job. There is a name for
 * that outcome — `unverifiable` — and reporting it honestly is better than
 * either spending a generation behind the user's back or pretending the key
 * was checked.
 */

import { resolveKieRequest, resolveKieVideoRequest } from './capabilities.js'
import {
  defaultImageModel,
  defaultVideoModel,
  listKieModels,
  listKieVideoModels,
} from './models.js'
import type { ProviderManifest } from '../../types/provider.js'

export const kieManifest = {
  id: 'kie',
  label: 'Kie AI',
  credential: {
    envVar: 'KIE_API_KEY',
    description: 'your Kie AI API key',
    signupUrl: 'https://kie.ai/api-key',
  },
  kinds: ['image', 'video'],

  defaultModel(kind, quality) {
    return kind === 'video' ? defaultVideoModel(quality) : defaultImageModel(quality)
  },

  listModels(kind) {
    return kind === 'video' ? listKieVideoModels() : listKieModels()
  },

  validate(request, model) {
    // Kie resolves and validates in one step, because which model id to send
    // depends on whether there is input media.
    if (request.kind === 'video') {
      resolveKieVideoRequest(model, request)
    } else {
      resolveKieRequest(model, request)
    }
  },

  clients: {
    image: async () => (await import('./imageClient.js')).createImageClient,
    video: async () => (await import('./videoClient.js')).createVideoClient,
  },

  probe: null,
} as const satisfies ProviderManifest
