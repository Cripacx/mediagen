/**
 * Hints have to name a command the caller can actually run.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { command, invocationPrefix, setInvocationPrefixForTest } from '../invocation.js'

afterEach(() => {
  setInvocationPrefixForTest(undefined)
})

describe('invocation detection', () => {
  it('names the bare command for an installed binary', () => {
    setInvocationPrefixForTest('mediagen')

    expect(command('config set gemini')).toBe('mediagen config set gemini')
  })

  it('names the npx form when reached through npx', () => {
    // Someone who installed only the agent skill has no CLI on their PATH.
    // Telling them to run `mediagen …` is a hint that fails exactly the way
    // the missing configuration did.
    setInvocationPrefixForTest('npx -y mediagen')

    expect(command('config set gemini')).toBe('npx -y mediagen config set gemini')
  })

  it('detects npx from the cache path npm runs the binary from', () => {
    const original = process.argv[1] ?? ''
    try {
      process.argv[1] = '/home/u/.npm/_npx/2f3a/node_modules/mediagen/dist/bin.js'
      setInvocationPrefixForTest(undefined)

      expect(invocationPrefix()).toBe('npx -y mediagen')
    } finally {
      process.argv[1] = original
    }
  })

  it('detects npx on Windows, where the separator differs', () => {
    const original = process.argv[1] ?? ''
    try {
      process.argv[1] = String.raw`C:\Users\u\AppData\Local\npm-cache\_npx\2f3a\node_modules\mediagen\dist\bin.js`
      setInvocationPrefixForTest(undefined)

      expect(invocationPrefix()).toBe('npx -y mediagen')
    } finally {
      process.argv[1] = original
    }
  })

  it('falls back to the bare command for an ordinary global install', () => {
    const original = process.argv[1] ?? ''
    try {
      process.argv[1] = String.raw`C:\Users\u\AppData\Roaming\npm\node_modules\mediagen\dist\bin.js`
      setInvocationPrefixForTest(undefined)

      expect(invocationPrefix()).toBe('mediagen')
    } finally {
      process.argv[1] = original
    }
  })
})
