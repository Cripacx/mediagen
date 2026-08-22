/**
 * The output contract (§4.2, §4.3), exercised through the built binary.
 *
 * These run the real process rather than calling `main` in-process. The
 * contract is about what lands on the caller's stdout and what the shell sees
 * as an exit code, and an in-process test can pass while the shipped binary
 * writes a stray line or exits with the wrong number.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'

const run = promisify(execFile)

const BIN = fileURLToPath(new URL('../../../dist/bin.js', import.meta.url))

interface Outcome {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

async function mediagen(args: string[]): Promise<Outcome> {
  try {
    const { stdout, stderr } = await run(process.execPath, [BIN, ...args], {
      env: {
        ...process.env,
        // Nothing configured: a generation attempt must fail on configuration
        // rather than reach a provider. §12.1 — no test issues a live request.
        MEDIAGEN_PROVIDER: 'gemini',
      },
    })
    return { code: 0, stdout, stderr }
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string }
    return { code: failure.code ?? -1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' }
  }
}

beforeAll(() => {
  if (!existsSync(BIN)) {
    throw new Error('dist/bin.js is missing. Run `npm run build` before the suite.')
  }
}, 60_000)

describe('--json mode (§4.2)', () => {
  it('emits exactly one JSON object on stdout and nothing else', async () => {
    const { stdout } = await mediagen(['image', 'a cat', '--json'])

    // Not merely "parses": exactly one object, no log lines around it.
    const lines = stdout.trimEnd().split('\n')
    expect(lines).toHaveLength(1)
    expect(() => JSON.parse(lines[0]!) as unknown).not.toThrow()
  })

  it('shapes a failure as §4.2 specifies, with an actionable hint', async () => {
    const { stdout } = await mediagen(['image', 'a cat', '--json'])
    const payload = JSON.parse(stdout.trim()) as Record<string, unknown>

    expect(payload['success']).toBe(false)
    expect(payload['errorCode']).toBe('CONFIG_ERROR')
    expect(typeof payload['error']).toBe('string')
    // "An error that says only what went wrong is half an error."
    expect(String(payload['hint'])).toContain('mediagen config set')
  })

  it('keeps diagnostics off stdout when the arguments are unparseable', async () => {
    const { stdout } = await mediagen(['image', 'a cat', '--nonsense', '--json'])

    const lines = stdout.trimEnd().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!) as unknown).toMatchObject({ success: false })
  })
})

describe('human mode (§4.2)', () => {
  it('writes nothing to stdout on failure', async () => {
    // A caller reading the last stdout line to find the saved path must not
    // pick up an error message and treat it as a path.
    const { stdout, stderr } = await mediagen(['image', 'a cat'])

    expect(stdout).toBe('')
    expect(stderr).toContain('Error:')
    expect(stderr).toContain('Hint:')
  })

  it('prints help on stdout and exits zero', async () => {
    const { code, stdout } = await mediagen(['--help'])

    expect(code).toBe(0)
    expect(stdout).toContain('mediagen image <prompt>')
  })
})

describe('exit codes (§4.3)', () => {
  it('returns 2 for invalid input', async () => {
    expect((await mediagen(['image'])).code).toBe(2)
    expect((await mediagen(['image', 'a cat', '--quality', 'ludicrous'])).code).toBe(2)
    expect((await mediagen(['nonsense-command'])).code).toBe(2)
  })

  it('returns 3 when configuration or credentials are the problem', async () => {
    expect((await mediagen(['image', 'a cat'])).code).toBe(3)
  })

  it('returns 2 for an unsupported shape, before any network call (§6.3)', async () => {
    // Shape is checked before credentials, so this is 2 rather than 3 even
    // with nothing configured.
    const { code, stderr } = await mediagen([
      'image',
      'a cat',
      '--model',
      'gemini-3-pro-image',
      '--aspect-ratio',
      '13:7',
    ])

    expect(code).toBe(2)
    expect(stderr).toContain('13:7')
  })

  it('rejects an unknown provider by name and lists the real ones', async () => {
    const { code, stderr } = await mediagen(['image', 'a cat', '--provider', 'midjourney'])

    expect(code).toBe(2)
    expect(stderr).toContain('midjourney')
    expect(stderr).toContain('gemini')
  })

  it('refuses --duration on an image', async () => {
    expect((await mediagen(['image', 'a cat', '--duration', '5'])).code).toBe(2)
  })
})

describe('secret handling (§3.5)', () => {
  it('offers no way to pass an API key as an argument', async () => {
    // Keys on the command line land in shell history and the process list.
    const { stdout } = await mediagen(['--help'])

    expect(stdout).not.toMatch(/--api-key|--key\b|--token\b/)
    expect(stdout).toContain('never passed as arguments')
  })
})
