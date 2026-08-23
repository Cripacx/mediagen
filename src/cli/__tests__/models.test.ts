/**
 * `mediagen models`, through the built binary.
 */

import { execFile } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PROVIDER_IDS } from '../../providers/registry.js'

const run = promisify(execFile)
const BIN = fileURLToPath(new URL('../../../dist/bin.js', import.meta.url))

async function mediagen(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [BIN, ...args], { env })
    return { code: 0, stdout, stderr }
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string }
    return { code: failure.code ?? -1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' }
  }
}

describe('models', () => {
  it('reports the model a request would use and where the choice came from', async () => {
    const { code, stdout } = await mediagen(['models'])

    expect(code).toBe(0)
    expect(stdout).toMatch(/Would use: .+\s+\(provider default\)/)
  })

  it('covers every registered provider', async () => {
    const { stdout } = await mediagen(['models'])

    for (const id of PROVIDER_IDS) {
      expect(stdout, `${id} is missing`).toContain(id)
    }
  })

  it('says plainly that the list is not a gate', async () => {
    const { stdout } = await mediagen(['models'])

    expect(stdout).toContain('still sent to the provider')
  })

  it('emits exactly one JSON object with --json', async () => {
    const { stdout } = await mediagen(['models', '--json'])

    const lines = stdout.trimEnd().split('\n')
    expect(lines).toHaveLength(1)

    const payload = JSON.parse(lines[0]!) as {
      success: boolean
      providers: Array<{ provider: string; effectiveModel?: string; source?: string }>
    }
    expect(payload.success).toBe(true)
    expect(payload.providers.length).toBe(PROVIDER_IDS.length)
    for (const entry of payload.providers) {
      expect(entry.effectiveModel).toBeDefined()
      expect(entry.source).toBe('provider default')
    }
  })

  it('honours a configured model and says which layer set it', async () => {
    const { stdout } = await run(process.execPath, [BIN, 'models', '--provider', 'kie', '--json'], {
      env: { ...process.env, KIE_MODEL: 'flux-2/pro' },
    })

    const payload = JSON.parse(stdout.trim()) as {
      providers: Array<{ effectiveModel?: string; source?: string; configuredLayer?: string }>
    }
    expect(payload.providers[0]?.effectiveModel).toBe('flux-2/pro')
    expect(payload.providers[0]?.source).toBe('configuration')
    expect(payload.providers[0]?.configuredLayer).toBe('env')
  })

  it('limits to one provider on request', async () => {
    const { stdout } = await mediagen(['models', '--provider', 'openai', '--json'])
    const payload = JSON.parse(stdout.trim()) as { providers: Array<{ provider: string }> }

    expect(payload.providers).toHaveLength(1)
    expect(payload.providers[0]?.provider).toBe('openai')
  })

  it('rejects an unknown provider and an unknown kind', async () => {
    expect((await mediagen(['models', '--provider', 'nope'])).code).toBe(2)
    expect((await mediagen(['models', '--kind', 'audio'])).code).toBe(2)
  })

  it('reports that no provider generates video yet, rather than hiding them', async () => {
    const { stdout } = await mediagen(['models', '--kind', 'video'])

    expect(stdout).toContain('Does not generate video')
  })
})

/**
 * The fields the agent skill tells an agent to read.
 *
 * These are a contract, not an implementation detail: the skill instructs
 * agents to run this before generating and to decide what they may use from
 * what comes back. Renaming one of these silently is how an agent starts
 * choosing a provider the user has no key for.
 */
describe('the JSON an agent reads before generating', () => {
  /**
   * A config directory of its own, so the answer comes from this environment
   * and not from whatever the machine running the tests happens to have.
   */
  function isolated(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return {
      ...process.env,
      XDG_CONFIG_HOME: mkdtempSync(path.join(tmpdir(), 'mediagen-models-')),
      APPDATA: mkdtempSync(path.join(tmpdir(), 'mediagen-models-')),
      GEMINI_API_KEY: undefined,
      OPENAI_API_KEY: undefined,
      KIE_API_KEY: undefined,
      MEDIAGEN_PROVIDER: undefined,
      MEDIAGEN_PROVIDER_PRIORITY: undefined,
      ...overrides,
    }
  }

  it('names what a request with no --provider would use', async () => {
    const { stdout } = await mediagen(
      ['models', '--json'],
      isolated({ GEMINI_API_KEY: 'a-long-enough-key-value' }),
    )

    const result = JSON.parse(stdout) as { wouldUse: { provider: string; model: string } | null }
    expect(result.wouldUse?.provider).toBe('gemini')
    expect(result.wouldUse?.model).toEqual(expect.any(String))
  })

  it('lists only the providers that actually have a key', async () => {
    const { stdout } = await mediagen(
      ['models', '--json'],
      isolated({ GEMINI_API_KEY: 'a-long-enough-key-value' }),
    )

    const result = JSON.parse(stdout) as { usableProviders: string[] }
    expect(result.usableProviders).toEqual(['gemini'])
  })

  it('reports nothing usable rather than suggesting something that would fail', async () => {
    const { code, stdout } = await mediagen(['models', '--json'], isolated())

    // Not an error: "you have no keys" is an answer, and the caller needs the
    // fix hints that come with it.
    expect(code).toBe(0)
    const result = JSON.parse(stdout) as {
      wouldUse: unknown
      usableProviders: string[]
      providers: { provider: string; fix?: string }[]
    }
    expect(result.wouldUse).toBeNull()
    expect(result.usableProviders).toEqual([])
    for (const provider of result.providers) {
      expect(provider.fix, provider.provider).toContain('config set')
    }
  })

  it('keeps unusable providers in the list, marked', async () => {
    const { stdout } = await mediagen(
      ['models', '--json'],
      isolated({ GEMINI_API_KEY: 'a-long-enough-key-value' }),
    )

    const result = JSON.parse(stdout) as {
      providers: { provider: string; usable: boolean; configured: boolean }[]
    }

    expect(result.providers.map((entry) => entry.provider)).toEqual(
      expect.arrayContaining([...PROVIDER_IDS]),
    )
    expect(result.providers.find((entry) => entry.provider === 'openai')).toMatchObject({
      usable: false,
      configured: false,
    })
  })

  it('honours the configured order, and skips past what has no key', async () => {
    const { stdout } = await mediagen(
      ['models', '--json'],
      isolated({
        MEDIAGEN_PROVIDER_PRIORITY: 'openai,gemini',
        GEMINI_API_KEY: 'a-long-enough-key-value',
      }),
    )

    const result = JSON.parse(stdout) as {
      providerPriority: string[]
      wouldUse: { provider: string } | null
    }

    expect(result.providerPriority.slice(0, 2)).toEqual(['openai', 'gemini'])
    // Preferred, but unusable, so the request goes to the next one that works.
    expect(result.wouldUse?.provider).toBe('gemini')
  })

  it('will not offer a provider that cannot do the requested kind', async () => {
    const { stdout } = await mediagen(
      ['models', '--kind', 'video', '--json'],
      isolated({
        MEDIAGEN_PROVIDER_PRIORITY: 'openai',
        OPENAI_API_KEY: 'a-long-enough-key-value',
        GEMINI_API_KEY: 'a-long-enough-key-value',
      }),
    )

    const result = JSON.parse(stdout) as {
      usableProviders: string[]
      wouldUse: { provider: string } | null
    }

    expect(result.usableProviders).not.toContain('openai')
    expect(result.wouldUse?.provider).toBe('gemini')
  })
})
