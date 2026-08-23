/**
 * Output handling.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultStem, resolveOutputPath, saveMedia } from '../output.js'
import { ERROR_CODE } from '../errors.js'
import type { Logger } from '../../types/provider.js'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0])

let directory: string
let log: Logger
/** Held separately so assertions never read a method off the object. */
let warned: ReturnType<typeof vi.fn>

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'mediagen-output-'))
  warned = vi.fn()
  log = { debug: vi.fn(), info: vi.fn(), warn: warned, progress: vi.fn() }
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

describe('path safety', () => {
  it('refuses a name that resolves outside the output directory', () => {
    expect(() =>
      resolveOutputPath({
        directory,
        outputName: '../escaped.png',
        fallbackStem: 'image',
        correctExtension: '.png',
        log,
      }),
    ).toThrow(/outside the output directory/)
  })

  it('refuses traversal that only appears after resolution', () => {
    // `a/../../b` looks harmless until it is resolved, which is why the check
    // is made on the resolved path rather than the supplied one.
    expect(() =>
      resolveOutputPath({
        directory,
        outputName: 'a/../../b.png',
        fallbackStem: 'image',
        correctExtension: '.png',
        log,
      }),
    ).toThrow(/outside the output directory/)
  })

  it('refuses an absolute path pointing elsewhere', () => {
    expect(() =>
      resolveOutputPath({
        directory,
        outputName: path.join(tmpdir(), 'elsewhere.png'),
        fallbackStem: 'image',
        correctExtension: '.png',
        log,
      }),
    ).toThrow(/outside the output directory/)
  })

  it('allows a subdirectory inside the output directory', () => {
    const resolved = resolveOutputPath({
      directory,
      outputName: 'nested/image.png',
      fallbackStem: 'image',
      correctExtension: '.png',
      log,
    })

    expect(resolved.startsWith(directory)).toBe(true)
  })
})

describe('extension reconciliation', () => {
  it('corrects a mismatched extension and says so rather than doing it silently', async () => {
    const saved = await saveMedia(PNG, {
      outputDir: directory,
      outputName: 'picture.jpg',
      fallbackStem: 'image',
      mimeType: 'image/jpeg',
      log,
    })

    expect(path.extname(saved.filePath)).toBe('.png')
    expect(saved.mimeType).toBe('image/png')
    expect(warned).toHaveBeenCalledWith(expect.stringContaining('picture.png'))
  })

  it('believes the bytes over the provider’s declared type', async () => {
    const saved = await saveMedia(JPEG, {
      outputDir: directory,
      outputName: 'shot',
      fallbackStem: 'image',
      mimeType: 'image/png',
      log,
    })

    expect(saved.mimeType).toBe('image/jpeg')
    expect(path.extname(saved.filePath)).toBe('.jpg')
  })

  it('leaves a matching extension alone and warns about nothing', async () => {
    const saved = await saveMedia(PNG, {
      outputDir: directory,
      outputName: 'fine.png',
      fallbackStem: 'image',
      mimeType: 'image/png',
      log,
    })

    expect(path.basename(saved.filePath)).toBe('fine.png')
    expect(warned).not.toHaveBeenCalled()
  })

  it('writes the bytes it was given', async () => {
    const saved = await saveMedia(PNG, {
      outputDir: directory,
      fallbackStem: 'image',
      mimeType: 'image/png',
      log,
    })

    expect(new Uint8Array(readFileSync(saved.filePath))).toEqual(PNG)
  })
})

describe('bounds', () => {
  it('rejects an empty response rather than writing a zero-byte file', async () => {
    await expect(
      saveMedia(new Uint8Array(0), {
        outputDir: directory,
        fallbackStem: 'image',
        mimeType: 'image/png',
        log,
      }),
    ).rejects.toMatchObject({ code: ERROR_CODE.API_ERROR })
  })
})

describe('default naming', () => {
  it('produces a sortable stem', () => {
    const stem = defaultStem('image', new Date('2026-08-23T09:41:07.123Z'))

    expect(stem).toBe('image-20260823T094107Z')
  })
})
