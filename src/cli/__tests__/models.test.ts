/**
 * `mediagen models`, through the built binary.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PROVIDER_IDS } from '../../providers/registry.js'

const run = promisify(execFile)
const BIN = fileURLToPath(new URL('../../../dist/bin.js', import.meta.url))

async function mediagen(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [BIN, ...args], { env: process.env })
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
