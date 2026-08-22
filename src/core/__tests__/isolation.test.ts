/**
 * Guards the test harness itself (§12.1).
 *
 * These tests deliberately do not set up their own isolation: they assert that
 * `test/setup.ts` did it, so removing that file fails the suite loudly instead
 * of quietly handing the developer's real credentials to every other test.
 */

import { describe, expect, it } from 'vitest'
import { ISOLATED_CONFIG_MARKER } from '../../../test/setup.js'

describe('test configuration isolation', () => {
  it('points the config file layer at a throwaway directory', () => {
    const configHome = process.env['XDG_CONFIG_HOME']

    expect(configHome, 'test/setup.ts did not set XDG_CONFIG_HOME').toBeDefined()
    expect(configHome).toContain(ISOLATED_CONFIG_MARKER)
  })

  it('does not inherit any provider credential from the developer environment', () => {
    const leaked = Object.keys(process.env).filter((key) => key.endsWith('_API_KEY'))

    expect(leaked, `credentials leaked into the test environment: ${leaked.join(', ')}`).toEqual([])
  })

  it('does not inherit mediagen settings from the developer environment', () => {
    const leaked = Object.keys(process.env).filter((key) => key.startsWith('MEDIAGEN_'))

    expect(leaked, `settings leaked into the test environment: ${leaked.join(', ')}`).toEqual([])
  })
})
