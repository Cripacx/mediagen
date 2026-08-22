import { describe, expect, it, vi } from 'vitest'
import { findModel, validateAgainst } from '../capabilities.js'
import { ERROR_CODE } from '../errors.js'
import { generate } from '../pipeline.js'
import { silentLogger } from '../logger.js'
import type { GenerationRequest } from '../../types/media.js'
import type { ModelDescriptor } from '../../types/provider.js'
import type { ResolvedConfig } from '../../types/config.js'

const model: ModelDescriptor = {
  id: 'test-model',
  kind: 'image',
  aspectRatios: ['1:1', '16:9'],
  sizes: ['1K', '2K'],
  acceptsInputMedia: false,
}

function request(overrides: Partial<GenerationRequest> = {}): GenerationRequest {
  return { prompt: 'a cat', kind: 'image', ...overrides }
}

describe('capability validation (§6.3)', () => {
  it('names the reason and the supported values', () => {
    try {
      validateAgainst(request({ aspectRatio: '8:1' }), model.id, model)
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error).toMatchObject({ code: ERROR_CODE.VALIDATION_ERROR })
      expect((error as Error).message).toContain('8:1')
      expect((error as Error).message).toContain('1:1, 16:9')
    }
  })

  it('rejects an unsupported size', () => {
    expect(() => {
      validateAgainst(request({ size: '4K' }), model.id, model)
    }).toThrow(/does not support the size 4K/)
  })

  it('refuses input media for a model that cannot take it', () => {
    expect(() => {
      validateAgainst(request({ inputMedia: './a.png' }), model.id, model)
    }).toThrow(/cannot take input media/)
  })

  it('accepts a shape the model lists', () => {
    expect(() => {
      validateAgainst(request({ aspectRatio: '16:9', size: '2K' }), model.id, model)
    }).not.toThrow()
  })

  it('does not police a field the model declares no constraint for', () => {
    const unconstrained: ModelDescriptor = { id: 'loose', kind: 'image' }

    expect(() => {
      validateAgainst(request({ aspectRatio: '99:1' }), unconstrained.id, unconstrained)
    }).not.toThrow()
  })

  it('does not reject a model that is merely unlisted (§7.3)', () => {
    // A wrong rejection is worse than no opinion: it is a confident error the
    // user believes. With nothing known about the model there is nothing to
    // check, so the request goes to the provider.
    expect(() => {
      validateAgainst(request({ aspectRatio: '99:1' }), 'some-new-model', undefined)
    }).not.toThrow()
  })

  it('finds a listed model and returns undefined for an unlisted one', () => {
    expect(findModel([model], 'test-model')).toBe(model)
    expect(findModel([model], 'other')).toBeUndefined()
  })
})

describe('validation happens before any network call (§12.1)', () => {
  it('fails an unsupported shape without loading a client or reading a key', async () => {
    const apiKey = vi.fn(() => undefined)
    const config: ResolvedConfig = {
      defaultProvider: { value: 'gemini', layer: 'default', shadowed: [] },
      outputDir: { value: './output', layer: 'default', shadowed: [] },
      quality: { value: 'fast', layer: 'default', shadowed: [] },
      apiKey,
      model: () => undefined,
    }

    await expect(
      generate(request({ aspectRatio: '13:7', model: 'gemini-3-pro-image' }), {
        config,
        log: silentLogger,
      }),
    ).rejects.toMatchObject({ code: ERROR_CODE.VALIDATION_ERROR })

    // A key lookup here would mean the shape check ran too late to be the
    // guard §6.3 asks for.
    expect(apiKey).not.toHaveBeenCalled()
  })
})
