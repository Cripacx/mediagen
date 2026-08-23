import { describe, expect, it } from 'vitest'
import { ERROR_CODE, EXIT_CODE, MediagenError, exitCodeFor, toMediagenError } from '../errors.js'

describe('error taxonomy', () => {
  it('maps every error code to an exit code', () => {
    for (const code of Object.values(ERROR_CODE)) {
      expect(Object.values(EXIT_CODE)).toContain(exitCodeFor(code))
    }
  })

  it('routes configuration failures to exit code 3', () => {
    const error = new MediagenError(ERROR_CODE.CONFIG_ERROR, 'no key', {
      hint: 'Run: mediagen init',
    })

    expect(error.exitCode).toBe(EXIT_CODE.CONFIG)
    expect(error.hint).toBe('Run: mediagen init')
  })

  it('routes invalid input to exit code 2 and generation failures to 4', () => {
    expect(exitCodeFor(ERROR_CODE.VALIDATION_ERROR)).toBe(EXIT_CODE.USAGE)
    expect(exitCodeFor(ERROR_CODE.API_ERROR)).toBe(EXIT_CODE.FAILURE)
    expect(exitCodeFor(ERROR_CODE.CONTENT_BLOCKED)).toBe(EXIT_CODE.FAILURE)
  })

  it('recognises a socket failure as a network error rather than an API error', () => {
    const cause = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })

    expect(toMediagenError(cause).code).toBe(ERROR_CODE.NETWORK_ERROR)
  })

  it('does not forward an unmapped upstream message to the user', () => {
    // Act: the raw text may echo the prompt or fragments of a key.
    const mapped = toMediagenError(new Error('Bad key sk-abc123 for prompt "a secret"'))

    // Assert
    expect(mapped.message).not.toContain('sk-abc123')
    expect(mapped.cause).toBeInstanceOf(Error)
  })

  it('passes an already-mapped error through unchanged', () => {
    const original = new MediagenError(ERROR_CODE.FILE_ERROR, 'nope')

    expect(toMediagenError(original)).toBe(original)
  })
})
