/**
 * Prompt enhancement (§5).
 *
 * The behaviour that matters most here is the failure behaviour: enhancement
 * is an extra model call, and §5 forbids it from ever failing a generation.
 */

import { describe, expect, it, vi } from 'vitest'
import { enhancePrompt } from '../enhance.js'
import { clearClientCache } from '../../providers/registry.js'
import type { GenerationRequest } from '../../types/media.js'
import type { Logger, ProviderManifest, TextClient } from '../../types/provider.js'

function request(overrides: Partial<GenerationRequest> = {}): GenerationRequest {
  return { prompt: 'a red bicycle', kind: 'image', ...overrides }
}

function logger(): { log: Logger; warnings: string[]; debugs: string[] } {
  const warnings: string[] = []
  const debugs: string[] = []
  return {
    warnings,
    debugs,
    log: {
      debug: (message) => debugs.push(message),
      info: () => {},
      warn: (message) => warnings.push(message),
      progress: () => {},
    },
  }
}

function provider(overrides: Partial<ProviderManifest> = {}): ProviderManifest {
  return {
    id: `stub-${Math.random().toString(36).slice(2)}`,
    label: 'Stub',
    credential: { envVar: 'STUB_API_KEY', description: 'a stub key' },
    kinds: ['image'],
    defaultModel: () => 'stub-model',
    listModels: () => [],
    validate: () => {},
    clients: {},
    textClient: null,
    ...overrides,
  }
}

function textProvider(complete: TextClient['complete']): ProviderManifest {
  return provider({
    textClient: () => Promise.resolve(() => ({ complete })),
    textModel: 'stub-text',
  })
}

describe('enhancement (§5)', () => {
  it('returns the expanded prompt when the call succeeds', async () => {
    clearClientCache()
    const { log } = logger()
    const expanded = 'A red bicycle leaning on a wet brick wall, overcast afternoon light.'

    const result = await enhancePrompt(request(), {
      provider: textProvider(() => Promise.resolve(expanded)),
      apiKey: 'k',
      log,
    })

    expect(result).toBe(expanded)
  })

  it('generates with the original prompt when enhancement throws', async () => {
    clearClientCache()
    const { log, warnings } = logger()

    const result = await enhancePrompt(request(), {
      provider: textProvider(() => Promise.reject(new Error('upstream exploded'))),
      apiKey: 'k',
      log,
    })

    // Never fail a generation because enhancement failed.
    expect(result).toBe('a red bicycle')
    expect(warnings.join(' ')).toContain('generating with the original prompt')
  })

  it('generates with the original prompt when enhancement returns nothing', async () => {
    clearClientCache()
    const { log, warnings } = logger()

    const result = await enhancePrompt(request(), {
      provider: textProvider(() => Promise.resolve('   ')),
      apiKey: 'k',
      log,
    })

    expect(result).toBe('a red bicycle')
    expect(warnings).not.toHaveLength(0)
  })

  it('skips enhancement for a provider with no text model, without warning', async () => {
    clearClientCache()
    const { log, warnings } = logger()

    const result = await enhancePrompt(request(), { provider: provider(), apiKey: 'k', log })

    // Absent by design is not a fault, so it is debug output, not a warning.
    expect(result).toBe('a red bicycle')
    expect(warnings).toEqual([])
  })

  it('never asks a second provider for credentials', async () => {
    clearClientCache()
    const { log } = logger()
    const complete = vi.fn(() => Promise.resolve('expanded'))

    await enhancePrompt(request(), { provider: textProvider(complete), apiKey: 'the-key', log })

    // The key handed to the text model is the one already resolved for this
    // provider — enhancement must not turn one configured key into two.
    expect(complete).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ apiKey: 'the-key', model: 'stub-text' }),
    )
  })
})

describe('the instruction it sends', () => {
  it('carries the user prompt verbatim and forbids contradicting it', async () => {
    clearClientCache()
    const { log } = logger()
    let sent = ''

    await enhancePrompt(request({ prompt: 'a red bicycle' }), {
      provider: textProvider((instruction) => {
        sent = instruction
        return Promise.resolve('expanded')
      }),
      apiKey: 'k',
      log,
    })

    expect(sent).toContain('a red bicycle')
    expect(sent).toMatch(/do not contradict/i)
  })

  it('passes the feature hints through', async () => {
    clearClientCache()
    const { log } = logger()
    let sent = ''

    await enhancePrompt(
      request({
        purpose: 'a conference poster',
        maintainCharacter: true,
        blendElements: true,
        realWorldAccuracy: true,
      }),
      {
        provider: textProvider((instruction) => {
          sent = instruction
          return Promise.resolve('expanded')
        }),
        apiKey: 'k',
        log,
      },
    )

    expect(sent).toContain('a conference poster')
    expect(sent).toMatch(/recognisable/i)
    expect(sent).toMatch(/one scene/i)
    expect(sent).toMatch(/accurately/i)
  })

  it('asks for motion when the kind is video', async () => {
    clearClientCache()
    const { log } = logger()
    let sent = ''

    await enhancePrompt(request({ kind: 'video' }), {
      provider: textProvider((instruction) => {
        sent = instruction
        return Promise.resolve('expanded')
      }),
      apiKey: 'k',
      log,
    })

    expect(sent).toMatch(/camera movement/i)
  })
})

describe('cleaning the answer', () => {
  it('strips a label and matched quotes a model added despite being told not to', async () => {
    clearClientCache()
    const { log } = logger()

    const result = await enhancePrompt(request(), {
      provider: textProvider(() => Promise.resolve('Enhanced prompt: "A red bicycle in rain."')),
      apiKey: 'k',
      log,
    })

    expect(result).toBe('A red bicycle in rain.')
  })

  it('leaves an unquoted answer alone', async () => {
    clearClientCache()
    const { log } = logger()

    const result = await enhancePrompt(request(), {
      provider: textProvider(() => Promise.resolve('A red bicycle, "Raleigh" on the frame.')),
      apiKey: 'k',
      log,
    })

    expect(result).toBe('A red bicycle, "Raleigh" on the frame.')
  })
})
