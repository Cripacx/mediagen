/**
 * Writes one version into every file that carries it.
 *
 * Three fields have to agree: `version` in package.json, and both `version`
 * and `packages[0].version` in server.json. The MCP registry hosts metadata
 * only, so a mismatch there does not fail loudly — it publishes a registry
 * entry pointing at an npm version that does not exist.
 *
 * `src/cli/__tests__/packaging.test.ts` asserts they agree; this is the thing
 * that keeps that true.
 *
 * Usage:
 *   node scripts/set-version.mjs 1.2.3      write an exact version
 *   node scripts/set-version.mjs patch      bump from the current one
 *   node scripts/set-version.mjs --check    exit non-zero if they disagree
 *
 * Prints the resulting version on stdout and nothing else, so a workflow can
 * capture it.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE_PATH = join(root, 'package.json')
const SERVER_PATH = join(root, 'server.json')

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/

function read(path) {
  return JSON.parse(readFileSync(path, 'utf-8'))
}

/** Preserves the two-space indentation and trailing newline both files use. */
function write(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8')
}

function bump(current, kind) {
  const match = SEMVER.exec(current)
  if (!match) {
    throw new Error(`Cannot bump "${current}": it is not a plain semver version.`)
  }

  const [major, minor, patch] = match.slice(1).map(Number)

  switch (kind) {
    case 'major':
      return `${major + 1}.0.0`
    case 'minor':
      return `${major}.${minor + 1}.0`
    case 'patch':
      return `${major}.${minor}.${patch + 1}`
    default:
      throw new Error(`Unknown bump "${kind}". Use major, minor, patch, or an exact version.`)
  }
}

function check() {
  const pkg = read(PACKAGE_PATH)
  const server = read(SERVER_PATH)
  const found = [
    ['package.json version', pkg.version],
    ['server.json version', server.version],
    ['server.json packages[0].version', server.packages?.[0]?.version],
  ]

  const disagreeing = found.filter(([, value]) => value !== pkg.version)
  if (disagreeing.length > 0) {
    for (const [where, value] of found) {
      process.stderr.write(`  ${where}: ${String(value)}\n`)
    }
    process.stderr.write('These must agree. Run: node scripts/set-version.mjs <version>\n')
    process.exit(1)
  }

  process.stdout.write(`${pkg.version}\n`)
}

function main() {
  const argument = process.argv[2]

  if (argument === undefined) {
    process.stderr.write(
      'Usage: node scripts/set-version.mjs <version|major|minor|patch|--check>\n',
    )
    process.exit(1)
  }

  if (argument === '--check') {
    check()
    return
  }

  const pkg = read(PACKAGE_PATH)
  const next = SEMVER.test(argument) ? argument : bump(pkg.version, argument)

  if (next === pkg.version) {
    // Publishing over an existing version is rejected by npm anyway; failing
    // here says why instead of leaving it to a confusing 403.
    process.stderr.write(`Version is already ${next}; nothing to do.\n`)
    process.exit(1)
  }

  write(PACKAGE_PATH, { ...pkg, version: next })

  const server = read(SERVER_PATH)
  write(SERVER_PATH, {
    ...server,
    version: next,
    packages: (server.packages ?? []).map((entry) => ({ ...entry, version: next })),
  })

  process.stdout.write(`${next}\n`)
}

main()
