/**
 * Layered resolution and its provenance.
 *
 * The shadowing cases are why provenance is tracked at all: a value that resolves
 * correctly but from an unexpected layer is the failure people lose hours to,
 * and it is invisible unless the resolver reports where the answer came from.
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fromDefault, maskSecret, resolve, type ConfigLayers } from '../layers.js'
import { configDirPath, configFilePath, readConfigFile, writeConfigFile } from '../file.js'
import { loadConfig, modelEnvVar, requireApiKey, assertSomeProviderUsable } from '../resolve.js'
import { ERROR_CODE } from '../../core/errors.js'
import { PROVIDERS, requireProvider } from '../../providers/registry.js'
import type { ConfigFile } from '../../types/config.js'

function layers(overrides: Partial<ConfigLayers> = {}): ConfigLayers {
  return { env: {}, dotenv: {}, file: {}, dotenvPath: '/nowhere/.env', ...overrides }
}

describe('resolution order', () => {
  it('prefers the environment over .env and the file', () => {
    const resolved = resolve(
      layers({ env: { A: 'from-env' }, dotenv: { A: 'from-dotenv' } }),
      'A',
      'from-file',
    )

    expect(resolved).toEqual({
      value: 'from-env',
      layer: 'environment',
      shadowed: ['dotenv', 'file'],
    })
  })

  it('prefers .env over the file', () => {
    const resolved = resolve(layers({ dotenv: { A: 'from-dotenv' } }), 'A', 'from-file')

    expect(resolved?.layer).toBe('dotenv')
    expect(resolved?.shadowed).toEqual(['file'])
  })

  it('reports no shadowing when only one layer answers', () => {
    const resolved = resolve(layers(), 'A', 'from-file')

    expect(resolved).toEqual({ value: 'from-file', layer: 'file', shadowed: [] })
  })

  it('returns undefined when nothing answers', () => {
    expect(resolve(layers(), 'A', undefined)).toBeUndefined()
  })

  it('treats an empty or placeholder value as absent', () => {
    // `FOO=` in a shell script, and the strings a careless template leaves
    // behind, are far more often a mistake than an intent to configure nothing.
    for (const value of ['', '   ', 'undefined', 'null']) {
      expect(resolve(layers({ env: { A: value } }), 'A', 'from-file')?.layer).toBe('file')
    }
  })

  it('marks a built-in default as coming from nowhere else', () => {
    expect(fromDefault('x')).toEqual({ value: 'x', layer: 'default', shadowed: [] })
  })
})

describe('secret masking', () => {
  it('shows enough to recognise a key and not enough to use it', () => {
    const masked = maskSecret('sk-abcdefghijklmnop')

    expect(masked).toBe('sk-a…op')
    expect(masked).not.toContain('defghijklmn')
  })

  it('reveals nothing at all about a short value', () => {
    expect(maskSecret('short')).toBe('*****')
  })
})

describe('the config file', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'mediagen-cfg-'))
    process.env['XDG_CONFIG_HOME'] = home
    process.env['APPDATA'] = home
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  it('round-trips what it wrote', () => {
    const file: ConfigFile = { defaultProvider: 'gemini', apiKeys: { gemini: 'sk-test' } }

    writeConfigFile(file)

    expect(readConfigFile()).toEqual(file)
  })

  it('resolves a malformed file to empty configuration rather than failing', () => {
    // A broken file must never block a run that has working env credentials.
    mkdirSync(configDirPath(), { recursive: true })
    writeFileSync(configFilePath(), '{ this is not json')

    expect(readConfigFile()).toEqual({})
  })

  it('resolves a missing file to empty configuration', () => {
    expect(readConfigFile()).toEqual({})
  })

  it('resolves a JSON array to empty configuration', () => {
    mkdirSync(configDirPath(), { recursive: true })
    writeFileSync(configFilePath(), '[1,2,3]')

    expect(readConfigFile()).toEqual({})
  })
})

describe('credential validation timing', () => {
  it('names the exact variable and the exact command when a key is missing', () => {
    const config = loadConfig(layers())
    const provider = PROVIDERS[0]!

    try {
      requireApiKey(config, provider)
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error).toMatchObject({ code: ERROR_CODE.CONFIG_ERROR })
      expect((error as Error).message).toContain(provider.credential.envVar)
      expect((error as { hint?: string }).hint).toContain(`mediagen config set ${provider.id}`)
    }
  })

  it('rejects a key too short to be plausible, naming where it came from', () => {
    const provider = PROVIDERS.find((candidate) => candidate.credential.minLength !== undefined)
    if (!provider) return

    const config = loadConfig(layers({ env: { [provider.credential.envVar]: 'ab' } }))

    expect(() => requireApiKey(config, provider)).toThrow(/from environment|too short/)
  })

  it('reports the default provider’s own error when no provider is usable', () => {
    const config = loadConfig(layers())

    expect(() => {
      assertSomeProviderUsable(config)
    }).toThrow(new RegExp(requireProvider(config.defaultProvider.value).credential.envVar))
  })

  it('runs when at least one provider is usable', () => {
    const provider = PROVIDERS[0]!
    const config = loadConfig(
      layers({ env: { [provider.credential.envVar]: 'a-long-enough-key-value' } }),
    )

    expect(() => {
      assertSomeProviderUsable(config)
    }).not.toThrow()
  })
})

describe('settings resolution', () => {
  it('derives the model variable per provider rather than listing them', () => {
    expect(modelEnvVar('gemini')).toBe('GEMINI_MODEL')
    expect(modelEnvVar('kie')).toBe('KIE_MODEL')
  })

  it('falls back to the documented defaults', () => {
    const config = loadConfig(layers())

    expect(config.outputDir.value).toBe('./output')
    expect(config.outputDir.layer).toBe('default')
    expect(config.quality.value).toBe('fast')
  })

  it('ignores a quality preset it does not recognise', () => {
    // Substituting silently would be one thing; accepting a value the pipeline
    // cannot use would be worse.
    const config = loadConfig(layers({ env: { MEDIAGEN_QUALITY: 'ludicrous' } }))

    expect(config.quality.value).toBe('fast')
    expect(config.quality.layer).toBe('default')
  })

  it('reports the layer that supplied each API key', () => {
    const provider = PROVIDERS[0]!
    const config = loadConfig(
      layers({
        env: { [provider.credential.envVar]: 'from-env-key-long' },
        file: { apiKeys: { [provider.id]: 'from-file-key' } },
      }),
    )

    const resolved = config.apiKey(provider.id)
    expect(resolved?.layer).toBe('environment')
    expect(resolved?.shadowed).toContain('file')
  })

  it('returns undefined for a provider that does not exist', () => {
    expect(loadConfig(layers()).apiKey('nope')).toBeUndefined()
  })
})
