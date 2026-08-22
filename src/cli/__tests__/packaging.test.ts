/**
 * What has to be true before this can be published.
 *
 * Three files now carry the version and two carry the registry name, and the
 * failure mode is not a broken build — it is a rejected publish, or worse, a
 * registry entry pointing at a package version that does not exist. Those are
 * discovered at the worst possible moment, so they are checked here instead.
 */

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

function readJson<T>(relative: string): T {
  return JSON.parse(readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf-8')) as T
}

interface PackageJson {
  name: string
  version: string
  mcpName?: string
  bin?: Record<string, string>
  files?: string[]
  license?: string
  repository?: { url?: string }
  scripts?: Record<string, string>
}

interface ServerJson {
  name: string
  version: string
  packages?: Array<{ registryType?: string; identifier?: string; version?: string }>
}

const pkg = readJson<PackageJson>('../../../package.json')
const server = readJson<ServerJson>('../../../server.json')

describe('the npm package', () => {
  it('points its binary at a file the build actually produces', () => {
    const target = pkg.bin?.['mediagen']

    expect(target).toBe('dist/bin.js')
    expect(existsSync(fileURLToPath(new URL('../../../dist/bin.js', import.meta.url)))).toBe(true)
  })

  it('ships the skill and the registry manifest, not just dist', () => {
    // `npx skills add` reads the repository, but a user who npm-installs the
    // package should still find the skill in it.
    expect(pkg.files).toContain('skills')
    expect(pkg.files).toContain('server.json')
  })

  it('never ships the test config or source', () => {
    expect(pkg.files).not.toContain('src')
    expect(pkg.files).not.toContain('test')
  })

  it('states a licence and a repository', () => {
    expect(pkg.license).toBeDefined()
    expect(pkg.repository?.url).toContain('github.com')
  })

  it('ships the licence it claims', () => {
    // npm includes LICENSE automatically, but only if it exists. Declaring
    // MIT with no licence text is a claim with nothing behind it.
    const licence = fileURLToPath(new URL('../../../LICENSE', import.meta.url))

    expect(existsSync(licence), 'package.json declares a licence but LICENSE is missing').toBe(true)
    expect(readFileSync(licence, 'utf-8')).toContain('MIT License')
  })

  it('verifies before publishing', () => {
    // Without this, `npm publish` can ship a dist built from code that no
    // longer typechecks.
    expect(pkg.scripts?.['prepublishOnly']).toContain('verify')
  })
})

describe('the MCP registry manifest', () => {
  it('claims a version that matches the package', () => {
    // The registry hosts metadata only. A mismatch here points users at a
    // package version that was never published.
    expect(server.version).toBe(pkg.version)
    expect(server.packages?.[0]?.version).toBe(pkg.version)
  })

  it('names the npm package it is distributed as', () => {
    expect(server.packages?.[0]?.registryType).toBe('npm')
    expect(server.packages?.[0]?.identifier).toBe(pkg.name)
  })

  it('proves ownership through package.json', () => {
    // The registry checks that the npm package declares the same mcpName.
    // Without it the publish is rejected as unowned.
    expect(pkg.mcpName).toBe(server.name)
  })

  it('follows the reverse-DNS naming convention for GitHub auth', () => {
    expect(server.name).toMatch(/^io\.github\.[a-z0-9-]+\/[a-z0-9-]+$/)
  })

  it('declares stdio, which is what the binary starts with no subcommand', () => {
    expect(server.packages?.[0]).toMatchObject({ transport: { type: 'stdio' } })
  })
})

describe('the skill', () => {
  const skill = readFileSync(
    fileURLToPath(new URL('../../../skills/mediagen/SKILL.md', import.meta.url)),
    'utf-8',
  )

  it('lives where `npx skills add` looks for it', () => {
    // The discovery layout is skills/<name>/SKILL.md; a skill at skill/ or at
    // the repository root is silently not found.
    expect(
      existsSync(fileURLToPath(new URL('../../../skills/mediagen/SKILL.md', import.meta.url))),
    ).toBe(true)
  })

  it('carries the frontmatter the loader needs', () => {
    expect(skill.startsWith('---\n')).toBe(true)
    expect(skill).toMatch(/^name: mediagen$/m)
    expect(skill).toMatch(/^description: .{40,}/m)
  })

  it('leads with the npx form, since installing the skill installs no CLI', () => {
    expect(skill).toContain('npx -y mediagen image')
  })

  it('points a host at the explicit mcp command', () => {
    expect(skill).toContain('npx -y mediagen mcp')
  })

  it('tells the user to run init through npx too', () => {
    // The hint that sent them to a bare `mediagen` was the original bug: a
    // user who has only the skill has no such command.
    expect(skill).toContain('npx -y mediagen init')
  })
})
