/**
 * The output contract, exercised through the built binary.
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
        // rather than reach a provider. No test issues a live request.
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

describe('--json mode', () => {
  it('emits exactly one JSON object on stdout and nothing else', async () => {
    const { stdout } = await mediagen(['image', 'a cat', '--json'])

    // Not merely "parses": exactly one object, no log lines around it.
    const lines = stdout.trimEnd().split('\n')
    expect(lines).toHaveLength(1)
    expect(() => JSON.parse(lines[0]!) as unknown).not.toThrow()
  })

  it('shapes a failure as the contract specifies, with an actionable hint', async () => {
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

describe('human mode', () => {
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
    // Every command the tool offers is reachable, including the ones that only
    // report that they are not built yet.
    for (const command of ['image', 'video', 'config', 'doctor', 'init', 'mark', 'models']) {
      expect(stdout, `${command} is missing from help`).toContain(command)
    }
  })
})

describe('exit codes', () => {
  it('returns 2 for invalid input', async () => {
    expect((await mediagen(['image'])).code).toBe(2)
    expect((await mediagen(['image', 'a cat', '--quality', 'ludicrous'])).code).toBe(2)
    expect((await mediagen(['nonsense-command'])).code).toBe(2)
  })

  it('returns 3 when configuration or credentials are the problem', async () => {
    expect((await mediagen(['image', 'a cat'])).code).toBe(3)
  })

  it('returns 2 for an unsupported shape, before any network call', async () => {
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

describe('video as a second kind, not a second product', () => {
  it('offers video with the same options as image', async () => {
    const [image, video] = await Promise.all([
      mediagen(['image', '--help']),
      mediagen(['video', '--help']),
    ])

    // Kind is a dimension. An option existing for one and not the
    // other would be the fork the specification forbids.
    const flags = (help: string) => [...help.matchAll(/^\s+(--[a-z-]+)/gm)].map((m) => m[1]!)
    for (const flag of flags(image.stdout)) {
      expect(flags(video.stdout), `${flag} is missing from video`).toContain(flag)
    }
  })

  it('accepts --duration on video, which image refuses', async () => {
    const { stdout } = await mediagen(['video', '--help'])

    expect(stdout).toContain('--duration')
  })

  it('routes a video request through the same configuration check', async () => {
    // Nothing configured, so this must fail on credentials exactly as the
    // image path does — same taxonomy, same exit code.
    const { code, stdout } = await mediagen(['video', 'a marble rolling', '--json'])

    expect(code).toBe(3)
    expect(JSON.parse(stdout.trim())).toMatchObject({ errorCode: 'CONFIG_ERROR' })
  })

  it('rejects an aspect ratio no video model offers, before any network call', async () => {
    const { code, stderr } = await mediagen(['video', 'x', '--aspect-ratio', '21:9'])

    expect(code).toBe(2)
    expect(stderr).toContain('16:9, 9:16')
  })

  it('reports that a provider without video cannot do it', async () => {
    const { code, stderr } = await mediagen(['video', 'x', '--provider', 'openai'])

    expect(code).toBe(2)
    expect(stderr).toMatch(/does not generate video/)
    expect(stderr).toContain('gemini')
  })
})

describe('interactive commands without a terminal', () => {
  it('refuses config edit and points at the scriptable path', async () => {
    // The suite has no TTY, which is the same situation CI and an agent shell
    // are in. Prompting there would hang forever waiting for input.
    const { code, stderr } = await mediagen(['config', 'edit'])

    expect(code).toBe(3)
    expect(stderr).toContain('needs a terminal')
    expect(stderr).toContain('config set')
  })

  it('refuses init and points at --stdin', async () => {
    const { code, stderr } = await mediagen(['init'])

    expect(code).toBe(3)
    expect(stderr).toMatch(/--stdin/)
  })

  it('offers config edit in the command list', async () => {
    const { stdout } = await mediagen(['config', '--help'])

    expect(stdout).toContain('edit')
    expect(stdout).toContain('interactively')
  })
})

describe('secret handling', () => {
  it('exposes no flag anywhere that takes an API key as an argument', async () => {
    // Keys on the command line land in shell history and in the process list,
    // so this checks every command's help rather than only the root's.
    const helps = await Promise.all(
      [
        ['--help'],
        ['image', '--help'],
        ['video', '--help'],
        ['config', '--help'],
        ['config', 'set', '--help'],
        ['doctor', '--help'],
        ['init', '--help'],
      ].map(async (args) => (await mediagen(args)).stdout),
    )

    for (const help of helps) {
      expect(help).not.toMatch(/--api-key|--key[ =<]|--token[ =<]|--secret[ =<]/)
    }
  })

  it('documents the two safe ways to supply a key', async () => {
    const { stdout } = await mediagen(['--help'])

    expect(stdout).toContain('never accepted as command arguments')
    expect(stdout).toContain('--stdin')
  })

  it('offers --stdin on config set', async () => {
    const { stdout } = await mediagen(['config', 'set', '--help'])

    expect(stdout).toContain('--stdin')
  })
})
