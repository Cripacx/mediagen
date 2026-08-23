/**
 * AI content marking.
 *
 * The three that matter are all here: the metadata is written, provider
 * metadata survives, and a second pass does not double-mark.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { TRAINED_ALGORITHMIC_MEDIA, hasDigitalSourceType, markFile } from '../mark.js'
import { ERROR_CODE } from '../../core/errors.js'

let directory: string

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'mediagen-mark-'))
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

/** A small real PNG, since sharp has to be able to decode it. */
async function makePng(name = 'image.png'): Promise<string> {
  const filePath = path.join(directory, name)
  const data = await sharp({
    create: { width: 64, height: 64, channels: 3, background: { r: 20, g: 90, b: 160 } },
  })
    .png()
    .toBuffer()
  writeFileSync(filePath, data)
  return filePath
}

async function xmpOf(filePath: string): Promise<string | undefined> {
  const metadata = await sharp(filePath).metadata()
  return metadata.xmp?.toString('utf-8')
}

describe('the machine-readable marker', () => {
  it('writes the IPTC DigitalSourceType', async () => {
    const file = await makePng()

    const result = await markFile(file, { machineReadable: true, visibleLabel: false })

    expect(result.machineReadableWritten).toBe(true)
    expect(await xmpOf(file)).toContain(TRAINED_ALGORITHMIC_MEDIA)
  })

  it('records the generating model alongside the marker', async () => {
    const file = await makePng()

    await markFile(
      file,
      { machineReadable: true, visibleLabel: false },
      { provider: 'gemini', model: 'gemini-3-pro-image' },
    )

    const xmp = await xmpOf(file)
    expect(xmp).toContain('gemini-3-pro-image')
  })

  it('does not double-mark on a second pass', async () => {
    const file = await makePng()

    await markFile(file, { machineReadable: true, visibleLabel: false })
    const second = await markFile(file, { machineReadable: true, visibleLabel: false })

    expect(second.alreadyMarked).toBe(true)
    expect(second.machineReadableWritten).toBe(false)

    const xmp = (await xmpOf(file)) ?? ''
    const occurrences = xmp.split('DigitalSourceType').length - 1
    // Opening and closing tag once each; more would mean a duplicated property.
    expect(occurrences).toBe(2)
  })

  it('leaves an existing declaration alone rather than overwriting it', async () => {
    const file = await makePng()
    const foreign =
      '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/"><Iptc4xmpExt:DigitalSourceType>http://cv.iptc.org/newscodes/digitalsourcetype/digitalCapture</Iptc4xmpExt:DigitalSourceType></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>'

    writeFileSync(file, await sharp(file).keepMetadata().withXmp(foreign).toBuffer())

    const result = await markFile(file, { machineReadable: true, visibleLabel: false })

    // A file that already says what it is does not get contradicted.
    expect(result.alreadyMarked).toBe(true)
    expect(await xmpOf(file)).toContain('digitalCapture')
  })

  it('adds to existing metadata rather than replacing it', async () => {
    const file = await makePng()
    const foreign =
      '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>Someone Else</dc:creator></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>'

    writeFileSync(file, await sharp(file).keepMetadata().withXmp(foreign).toBuffer())

    await markFile(file, { machineReadable: true, visibleLabel: false })

    const xmp = (await xmpOf(file)) ?? ''
    expect(xmp).toContain('Someone Else')
    expect(xmp).toContain(TRAINED_ALGORITHMIC_MEDIA)
  })

  it('writes no C2PA manifest', async () => {
    const file = await makePng()

    await markFile(file, { machineReadable: true, visibleLabel: false })

    // A manifest only carries provenance if it is signed, and a test-signed
    // one would look like provenance while carrying none.
    const metadata = await sharp(file).metadata()
    expect(JSON.stringify(metadata)).not.toMatch(/c2pa|jumb/i)
  })
})

describe('the visible label', () => {
  it('changes the pixels', async () => {
    const file = await makePng()
    const before = await sharp(file).raw().toBuffer()

    await markFile(file, { machineReadable: false, visibleLabel: true })

    const after = await sharp(file).raw().toBuffer()
    expect(Buffer.compare(before, after)).not.toBe(0)
  })

  it('is independent of the machine-readable marker', async () => {
    const file = await makePng()

    const result = await markFile(file, { machineReadable: false, visibleLabel: true })

    expect(result.visibleLabelWritten).toBe(true)
    expect(result.machineReadableWritten).toBe(false)
    expect(hasDigitalSourceType(await xmpOf(file))).toBe(false)
  })
})

describe('both switches off', () => {
  it('does nothing at all', async () => {
    const file = await makePng()
    const before = await sharp(file).raw().toBuffer()

    const result = await markFile(file, { machineReadable: false, visibleLabel: false })

    expect(result.machineReadableWritten).toBe(false)
    expect(result.visibleLabelWritten).toBe(false)
    expect(Buffer.compare(before, await sharp(file).raw().toBuffer())).toBe(0)
  })
})

describe('formats this build cannot mark', () => {
  it('refuses a video by name rather than silently leaving it unmarked', async () => {
    // Silently doing nothing would leave the caller believing a disclosure
    // duty had been met.
    const file = path.join(directory, 'clip.mp4')
    writeFileSync(file, Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0, 0, 0, 0]))

    try {
      await markFile(file, { machineReadable: true, visibleLabel: false })
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error).toMatchObject({ code: ERROR_CODE.VALIDATION_ERROR })
      expect((error as Error).message).toContain('video/mp4')
      expect((error as { hint?: string }).hint).toMatch(/different operation/)
    }
  })

  it('reports a missing file as a file error', async () => {
    await expect(
      markFile(path.join(directory, 'nope.png'), { machineReadable: true, visibleLabel: false }),
    ).rejects.toMatchObject({ code: ERROR_CODE.FILE_ERROR })
  })
})
