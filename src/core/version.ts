/**
 * The package version, read once at runtime.
 *
 * Both frontends report it — the CLI as `--version`, the MCP server in its
 * handshake — and a hardcoded copy in either would drift from package.json
 * the first time someone releases without touching it.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

let cached: string | undefined

export function version(): string {
  if (cached !== undefined) return cached

  try {
    const packagePath = fileURLToPath(new URL('../../package.json', import.meta.url))
    const parsed: unknown = JSON.parse(readFileSync(packagePath, 'utf-8'))
    if (typeof parsed === 'object' && parsed !== null) {
      const value: unknown = (parsed as { version?: unknown }).version
      if (typeof value === 'string') {
        cached = value
        return cached
      }
    }
  } catch {
    // A missing package.json is not worth failing a run over.
  }

  cached = '0.0.0'
  return cached
}
