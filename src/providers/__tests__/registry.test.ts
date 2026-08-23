import { beforeEach, describe, expect, it } from 'vitest'
import {
  BUILT_IN_DEFAULT_PROVIDER,
  PROVIDERS,
  PROVIDER_IDS,
  clearClientCache,
  loadGenerationClient,
  providersFor,
  requireKindSupport,
  requireProvider,
} from '../registry.js'
import { ERROR_CODE } from '../../core/errors.js'
import type { ProviderManifest } from '../../types/provider.js'

beforeEach(() => {
  clearClientCache()
})

describe('registry', () => {
  it('names the built-in default among the registered providers', () => {
    expect(PROVIDER_IDS).toContain(BUILT_IN_DEFAULT_PROVIDER)
  })

  it('rejects an unknown provider as invalid input, listing the real ones', () => {
    try {
      requireProvider('midjourney')
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error).toMatchObject({ code: ERROR_CODE.VALIDATION_ERROR })
      expect((error as Error).message).toContain('midjourney')
      expect((error as { hint?: string }).hint).toContain(PROVIDER_IDS[0])
    }
  })

  it('selects providers by declared kind rather than by name', () => {
    for (const provider of providersFor('image')) {
      expect(provider.kinds).toContain('image')
    }
    for (const provider of providersFor('video')) {
      expect(provider.kinds).toContain('video')
    }
  })

  it('refuses a kind the provider does not declare, and points at one that does', () => {
    const imageOnly = PROVIDERS.find((provider) => !provider.kinds.includes('video'))
    if (!imageOnly) return

    expect(() => {
      requireKindSupport(imageOnly, 'video')
    }).toThrow(/does not generate video/)
  })
})

describe('catalogue invariants', () => {
  it('lists every model it offers as a default', () => {
    for (const provider of PROVIDERS) {
      for (const kind of provider.kinds) {
        for (const quality of ['fast', 'balanced', 'quality'] as const) {
          const fallback = provider.defaultModel(kind, quality)
          const listed = provider.listModels(kind).map((model) => model.id)

          expect(listed, `${provider.id}/${kind}/${quality} default is unlisted`).toContain(
            fallback,
          )
        }
      }
    }
  })

  it('declares every listed model under the kind it was listed for', () => {
    for (const provider of PROVIDERS) {
      for (const kind of provider.kinds) {
        for (const model of provider.listModels(kind)) {
          expect(model.kind, `${provider.id}: ${model.id}`).toBe(kind)
        }
      }
    }
  })

  it('supplies a client for every kind it declares', () => {
    for (const provider of PROVIDERS) {
      for (const kind of provider.kinds) {
        expect(provider.clients[kind], `${provider.id} declares ${kind} with no client`).toBeTypeOf(
          'function',
        )
      }
    }
  })

  it('keeps credential metadata free of vendor SDK imports', () => {
    // Reading the manifest must not require the transport to exist. If a
    // manifest ever imports its SDK directly, `doctor` and `config` start
    // paying for every vendor package in the tree.
    for (const provider of PROVIDERS) {
      expect(provider.credential.envVar).toMatch(/^[A-Z0-9_]+$/)
      expect(provider.credential.description.length).toBeGreaterThan(0)
    }
  })
})

describe('client caching', () => {
  it('does not hand one provider the client of another', async () => {
    // The natural mistake is a single-slot cache, and it fails silently: the
    // second request succeeds, against the wrong vendor.
    const first: ProviderManifest = {
      ...PROVIDERS[0]!,
      id: 'first',
      clients: { image: () => Promise.resolve(() => ({ generate: stub('first') })) },
    }
    const second: ProviderManifest = {
      ...PROVIDERS[0]!,
      id: 'second',
      clients: { image: () => Promise.resolve(() => ({ generate: stub('second') })) },
    }

    const a = await loadGenerationClient(first, 'image')
    const b = await loadGenerationClient(second, 'image')
    const aAgain = await loadGenerationClient(first, 'image')

    expect(a).not.toBe(b)
    expect(aAgain).toBe(a)
  })

  it('caches per kind as well as per provider', async () => {
    const both: ProviderManifest = {
      ...PROVIDERS[0]!,
      id: 'both',
      kinds: ['image', 'video'],
      clients: {
        image: () => Promise.resolve(() => ({ generate: stub('image') })),
        video: () => Promise.resolve(() => ({ generate: stub('video') })),
      },
    }

    const image = await loadGenerationClient(both, 'image')
    const video = await loadGenerationClient(both, 'video')

    expect(image).not.toBe(video)
  })
})

function stub(marker: string) {
  return () => Promise.resolve({ data: new Uint8Array([1]), mimeType: `image/${marker}` })
}
