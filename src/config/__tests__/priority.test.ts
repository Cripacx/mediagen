/**
 * Provider preference: what the user wants, against what is possible.
 *
 * The setting is a preference and never a whitelist. Every case here exists
 * because the other reading — treating the list as the set of permitted
 * providers — fails work the tool could have done, which is the worse way to
 * be wrong about a preference.
 */

import { describe, expect, it } from 'vitest'
import { loadConfig, preferredProvider, providerOrder, providerStandings } from '../resolve.js'
import { PROVIDER_IDS } from '../../providers/registry.js'
import type { ConfigLayers } from '../layers.js'

function layers(overrides: Partial<ConfigLayers> = {}): ConfigLayers {
  return { env: {}, dotenv: {}, file: {}, dotenvPath: '/nowhere/.env', ...overrides }
}

/** A key long enough to be accepted by every provider's credential rule. */
const KEY = 'a-long-enough-key-value-for-any-provider'

function withKeys(...providerIds: string[]): ConfigLayers {
  return layers({ file: { apiKeys: Object.fromEntries(providerIds.map((id) => [id, KEY])) } })
}

describe('the order', () => {
  it('is the registry order when nothing is configured', () => {
    const config = loadConfig(layers())

    expect(providerOrder(config)).toEqual([...PROVIDER_IDS])
    expect(config.providerPriority.layer).toBe('default')
  })

  it('puts what was named first, and keeps the rest behind it', () => {
    const config = loadConfig(layers({ file: { providerPriority: ['openai'] } }))

    expect(providerOrder(config)[0]).toBe('openai')
    expect(providerOrder(config)).toHaveLength(PROVIDER_IDS.length)
  })

  it('separates what was chosen from what merely follows', () => {
    // Reporting the whole list as the setting would claim a preference for
    // providers nobody named.
    const config = loadConfig(layers({ file: { providerPriority: ['openai'] } }))

    expect(config.providerPriority.value).toEqual(['openai'])
    expect(providerOrder(config).length).toBeGreaterThan(1)
  })

  it('reads a lone defaultProvider as a one-entry order', () => {
    // The setting this replaced. A config file written before the list existed
    // has to keep meaning what it meant.
    const config = loadConfig(layers({ file: { defaultProvider: 'openai' } }))

    expect(config.providerPriority.value).toEqual(['openai'])
    expect(config.providerPriority.layer).toBe('file')
  })

  it('lets the environment state an order', () => {
    const config = loadConfig(layers({ env: { MEDIAGEN_PROVIDER_PRIORITY: 'openai,gemini' } }))

    expect(config.providerPriority.value).toEqual(['openai', 'gemini'])
    expect(config.providerPriority.layer).toBe('environment')
  })

  it('accepts spaces as well as commas, because both get typed', () => {
    const config = loadConfig(layers({ env: { MEDIAGEN_PROVIDER_PRIORITY: 'openai, gemini' } }))

    expect(config.providerPriority.value).toEqual(['openai', 'gemini'])
  })

  it('drops an unknown name without losing the rest of the list', () => {
    // One typo costs its own entry. Discarding the whole setting would move a
    // user's carefully ordered list back to the built-in order silently.
    const config = loadConfig(layers({ env: { MEDIAGEN_PROVIDER_PRIORITY: 'midjourney,openai' } }))

    expect(config.providerPriority.value).toEqual(['openai'])
  })

  it('falls back to the built-in order when nothing named is known', () => {
    const config = loadConfig(layers({ env: { MEDIAGEN_PROVIDER_PRIORITY: 'midjourney' } }))

    expect(config.providerPriority.value).toEqual([])
    // Not credited to the environment: it expressed no preference this tool
    // could act on.
    expect(config.providerPriority.layer).toBe('default')
    expect(providerOrder(config)).toEqual([...PROVIDER_IDS])
  })

  it('ignores a repeated name rather than ranking it twice', () => {
    const config = loadConfig(
      layers({ env: { MEDIAGEN_PROVIDER_PRIORITY: 'openai,gemini,openai' } }),
    )

    expect(config.providerPriority.value).toEqual(['openai', 'gemini'])
  })
})

describe('choosing a provider', () => {
  it('takes the most preferred one that has a key', () => {
    const config = loadConfig({
      ...withKeys('gemini'),
      file: { ...withKeys('gemini').file, providerPriority: ['gemini', 'openai'] },
    })

    expect(preferredProvider(config)?.id).toBe('gemini')
  })

  it('falls past a preferred provider with no key rather than failing', () => {
    // The whole point of an order. A missing OpenAI key must not stop a job
    // Gemini can do.
    const config = loadConfig({
      ...withKeys('gemini'),
      file: { ...withKeys('gemini').file, providerPriority: ['openai', 'gemini'] },
    })

    expect(preferredProvider(config)?.id).toBe('gemini')
  })

  it('skips a provider that cannot do this kind of media, however preferred', () => {
    const config = loadConfig({
      ...withKeys('openai', 'gemini'),
      file: { ...withKeys('openai', 'gemini').file, providerPriority: ['openai', 'gemini'] },
    })

    expect(preferredProvider(config, 'image')?.id).toBe('openai')
    // OpenAI generates no video, so preference cannot make it the answer.
    expect(preferredProvider(config, 'video')?.id).toBe('gemini')
  })

  it('still names something able when nothing is configured at all', () => {
    // So the error the caller then gets names a provider worth configuring,
    // rather than one that could not have done the job anyway.
    const config = loadConfig(layers())

    expect(preferredProvider(config, 'video')?.kinds).toContain('video')
  })
})

describe('what each provider is up against', () => {
  it('reports every provider, including the ones that cannot be used', () => {
    // An agent told OpenAI is unconfigured can suggest adding a key. An agent
    // shown a list without OpenAI concludes it does not exist.
    const standings = providerStandings(loadConfig(withKeys('gemini')), 'image')

    expect(standings.map((standing) => standing.provider.id)).toEqual(
      expect.arrayContaining([...PROVIDER_IDS]),
    )
  })

  it('separates "has a key" from "can do this job"', () => {
    const config = loadConfig({
      ...withKeys('openai'),
      file: { ...withKeys('openai').file, providerPriority: ['openai'] },
    })

    const openai = providerStandings(config, 'video').find(
      (standing) => standing.provider.id === 'openai',
    )

    expect(openai?.configured).toBe(true)
    expect(openai?.supportsKind).toBe(false)
    expect(openai?.usable).toBe(false)
  })

  it('says where a key came from, so a shadowing one is visible', () => {
    const config = loadConfig(layers({ env: { GEMINI_API_KEY: KEY } }))

    const gemini = providerStandings(config, 'image').find(
      (standing) => standing.provider.id === 'gemini',
    )

    expect(gemini?.keyLayer).toBe('environment')
  })

  it('marks only the providers the user actually named', () => {
    const config = loadConfig(layers({ file: { providerPriority: ['openai'] } }))
    const standings = providerStandings(config, 'image')

    expect(standings.filter((standing) => standing.preferred).map((s) => s.provider.id)).toEqual([
      'openai',
    ])
  })
})
