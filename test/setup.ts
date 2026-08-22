/**
 * Isolates every test run from the machine's own configuration.
 *
 * Spec §12.1. Configuration resolves from the process environment, then
 * `.env`, then a per-machine config file. Without this, a developer who has
 * run `init` would see their real default provider and real API keys inside
 * the suite: tests would behave differently per machine and, worse, could
 * issue live billable requests.
 *
 * Credentials are cleared by pattern rather than from a list of names. A list
 * has to be updated whenever a provider is added, and the failure mode of
 * forgetting is silent — the new provider's key leaks in and nobody notices
 * until a test bills someone. `src/core/__tests__/isolation.test.ts` fails if
 * this file is removed or stops working.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const ISOLATED_CONFIG_MARKER = 'mediagen-test-config-'

const isolatedConfigHome = mkdtempSync(join(tmpdir(), ISOLATED_CONFIG_MARKER))

// The config file layer looks at XDG_CONFIG_HOME first, then APPDATA on win32.
process.env['XDG_CONFIG_HOME'] = isolatedConfigHome
process.env['APPDATA'] = isolatedConfigHome

// The remaining layer is a `.env` beside the working directory. It is read
// relative to process.cwd(), which the suite shares, so it cannot be
// redirected from here; the repository has none and .gitignore keeps it so.

for (const key of Object.keys(process.env)) {
  if (key.endsWith('_API_KEY') || key.endsWith('_MODEL') || key.startsWith('MEDIAGEN_')) {
    delete process.env[key]
  }
}

process.on('exit', () => {
  rmSync(isolatedConfigHome, { recursive: true, force: true })
})
