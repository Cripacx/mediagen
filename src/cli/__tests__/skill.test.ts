/**
 * The agent skill (§11).
 *
 * A skill is documentation, so most of it cannot be tested. What can be
 * tested is that it does not contradict the tool: a skill that names a flag
 * the CLI does not have, or a provider that is not registered, sends an agent
 * down a path that fails. These check the claims that would rot.
 */

import { readFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PROVIDER_IDS } from '../../providers/registry.js'
import { ERROR_CODE } from '../../core/errors.js'

const run = promisify(execFile)
const BIN = fileURLToPath(new URL('../../../dist/bin.js', import.meta.url))
const SKILL = readFileSync(
  fileURLToPath(new URL('../../../skill/SKILL.md', import.meta.url)),
  'utf-8',
)

/** Prose is soft-wrapped, so sentence assertions match against one line. */
const PROSE = SKILL.replace(/\s+/g, ' ')

describe('what §11 requires of the skill', () => {
  it('tells the agent to invoke the CLI with the --json contract', () => {
    expect(PROSE).toMatch(/mediagen image "<prompt>" --json/)
  })

  it('names the MCP tool as the fallback when there is no shell', () => {
    expect(SKILL).toContain('generate_media')
    expect(PROSE).toMatch(/no shell|fallback/i)
  })

  it('recommends marking for photorealistic, published or professional output', () => {
    expect(PROSE).toMatch(/photorealistic, will be published, or is for professional use/)
  })

  it('never asks the user for an API key, and says so explicitly', () => {
    expect(SKILL).toContain('mediagen init')
    expect(PROSE).toMatch(/Do not ask the user to paste an API key/)
  })

  it('carries the prompt-writing guidance', () => {
    // §5's guidance lives here now rather than in the pipeline, so it has to
    // be complete: this is the only place it exists.
    for (const dimension of [
      'Subject',
      'Composition',
      'Light',
      'Camera',
      'Material',
      'Atmosphere',
    ]) {
      expect(SKILL, `${dimension} is missing from the prompt guidance`).toContain(dimension)
    }
  })

  it('says plainly that the tool does not rewrite the prompt', () => {
    // If an agent believes the tool will expand a short prompt, it will write
    // short prompts.
    expect(PROSE).toMatch(/does not expand, rewrite, or improve it/)
  })
})

describe('claims the skill makes about the tool', () => {
  it('names only registered providers', () => {
    const table = SKILL.slice(SKILL.indexOf('## Choosing a provider'))
    const named = [...table.matchAll(/`(gemini|openai|kie|midjourney|stability)`/g)].map(
      (match) => match[1]!,
    )

    expect(named.length).toBeGreaterThan(0)
    for (const provider of new Set(named)) {
      expect(PROVIDER_IDS, `the skill names "${provider}", which is not registered`).toContain(
        provider,
      )
    }
  })

  it('names only flags the CLI actually has', async () => {
    const { stdout } = await run(process.execPath, [BIN, 'image', '--help'])

    const block = SKILL.slice(
      SKILL.indexOf('## Options worth knowing'),
      SKILL.indexOf('## Marking'),
    )
    const flags = [...block.matchAll(/^--[a-z-]+/gm)].map((match) => match[0])

    expect(flags.length).toBeGreaterThan(5)
    for (const flag of flags) {
      expect(stdout, `the skill documents ${flag}, which the CLI does not have`).toContain(flag)
    }
  })

  it('lists every error code the tool can emit', () => {
    for (const code of Object.values(ERROR_CODE)) {
      expect(SKILL, `${code} is undocumented`).toContain(code)
    }
  })

  it('states the exit codes the tool actually uses', () => {
    expect(PROSE).toMatch(/`0` success, `2` invalid input, `3` configuration/)
  })

  it('is right that OpenAI cannot do 16:9', async () => {
    // The skill tells agents to use gemini for anything wider than 3:2. If
    // that ever stops being true the advice becomes wrong, not just stale.
    expect(PROSE).toMatch(/genuinely cannot do 16:9/)

    const failed = await run(process.execPath, [
      BIN,
      'image',
      'x',
      '--provider',
      'openai',
      '--model',
      'gpt-image-2',
      '--aspect-ratio',
      '16:9',
      '--json',
    ]).catch((error: { stdout?: string }) => error)

    const payload = JSON.parse(failed.stdout ?? '{}') as {
      errorCode?: string
    }
    expect(payload.errorCode).toBe('VALIDATION_ERROR')
  })
})
