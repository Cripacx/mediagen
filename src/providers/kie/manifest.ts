/**
 * Kie AI.
 *
 * Spec §6.1 — pure data and validation; the fetch client loads lazily.
 *
 * `probe` is deliberately null. Kie exposes no endpoint cheap enough to verify
 * a key with: everything it offers starts a billable job. §4.5 has a name for
 * that outcome — `unverifiable` — and reporting it honestly is better than
 * either spending a generation behind the user's back or pretending the key
 * was checked.
 */

import { resolveKieRequest } from './capabilities.js'
import { defaultImageModel, listKieModels } from './models.js'
import type { ProviderManifest } from '../../types/provider.js'

export const kieManifest = {
  id: 'kie',
  label: 'Kie AI',
  credential: {
    envVar: 'KIE_API_KEY',
    description: 'your Kie AI API key',
    signupUrl: 'https://kie.ai/api-key',
  },
  kinds: ['image'],

  defaultModel(kind, quality) {
    if (kind !== 'image') {
      throw new Error(`kie does not generate ${kind}`)
    }
    return defaultImageModel(quality)
  },

  listModels(kind) {
    return kind === 'image' ? listKieModels() : []
  },

  validate(request, model) {
    // Kie resolves and validates in one step, because which model id to send
    // depends on whether this is a generation or an edit.
    resolveKieRequest(model, request)
  },

  clients: {
    image: async () => (await import('./imageClient.js')).createImageClient,
  },

  probe: null,
} as const satisfies ProviderManifest
