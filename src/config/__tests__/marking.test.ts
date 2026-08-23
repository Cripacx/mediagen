/**
 * Marking defaults, and the precedence between a configured one and a flag.
 *
 * This is the setting where getting precedence wrong has consequences beyond
 * an unexpected file: a disclosure that silently stops happening, or one that
 * cannot be turned off for a single run.
 */

import { describe, expect, it } from 'vitest'
import { loadConfig, parseBoolean } from '../resolve.js'
import type { ConfigLayers } from '../layers.js'

function layers(overrides: Partial<ConfigLayers> = {}): ConfigLayers {
  return { env: {}, dotenv: {}, file: {}, dotenvPath: '/nowhere/.env', ...overrides }
}

describe('the defaults', () => {
  it('leaves both switches off when nothing is configured', () => {
    const config = loadConfig(layers())

    expect(config.mark.value).toBe(false)
    expect(config.visibleLabel.value).toBe(false)
    expect(config.mark.layer).toBe('default')
  })

  it('reads them from the config file', () => {
    const config = loadConfig(layers({ file: { mark: true, visibleLabel: true } }))

    expect(config.mark.value).toBe(true)
    expect(config.visibleLabel.value).toBe(true)
    expect(config.mark.layer).toBe('file')
  })

  it('lets the environment override the file, and says so', () => {
    const config = loadConfig(layers({ env: { MEDIAGEN_MARK: 'false' }, file: { mark: true } }))

    expect(config.mark.value).toBe(false)
    expect(config.mark.layer).toBe('environment')
    expect(config.mark.shadowed).toContain('file')
  })

  it('can be turned off in the file after being on in it', () => {
    // `false` in the file has to mean off, not "absent, so use the default" —
    // which would be the same thing today but not if the default ever changed.
    const config = loadConfig(layers({ file: { mark: false } }))

    expect(config.mark.value).toBe(false)
    expect(config.mark.layer).toBe('file')
  })
})

describe('parsing what people write', () => {
  it('accepts the usual spellings of yes and no', () => {
    for (const yes of ['1', 'true', 'TRUE', 'yes', 'on', ' true ']) {
      expect(parseBoolean(yes), yes).toBe(true)
    }
    for (const no of ['0', 'false', 'FALSE', 'no', 'off', ' off ']) {
      expect(parseBoolean(no), no).toBe(false)
    }
  })

  it('treats anything else as neither', () => {
    for (const nonsense of ['', 'maybe', 'sometimes', '2']) {
      expect(parseBoolean(nonsense), nonsense).toBeUndefined()
    }
  })

  it('skips a typo and uses the next layer rather than undoing it', () => {
    // "ture" must not quietly mean off. Turning a configured disclosure off
    // because someone mistyped a variable is the worse way to fail.
    const config = loadConfig(layers({ env: { MEDIAGEN_MARK: 'ture' }, file: { mark: true } }))

    expect(config.mark.value).toBe(true)
    expect(config.mark.layer).toBe('file')
  })

  it('falls back to the default when no layer holds a usable value', () => {
    const config = loadConfig(layers({ env: { MEDIAGEN_MARK: 'ture' } }))

    expect(config.mark.value).toBe(false)
    expect(config.mark.layer).toBe('default')
  })
})
