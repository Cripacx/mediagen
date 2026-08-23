/**
 * AI content marking.
 *
 * The three that matter are all here: the metadata is written, provider
 * metadata survives, and a second pass does not double-mark.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import sharp from 'sharp'
import {
  TRAINED_ALGORITHMIC_MEDIA,
  hasDigitalSourceType,
  labelledPathFor,
  markFile,
} from '../mark.js'
import { ERROR_CODE } from '../../core/errors.js'

let directory: string

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'mediagen-mark-'))
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

/** A small real PNG, since sharp has to be able to decode it. */
async function makePng(name = 'image.png', width = 64, height = 64): Promise<string> {
  const filePath = path.join(directory, name)
  const data = await sharp({
    create: { width, height, channels: 3, background: { r: 20, g: 90, b: 160 } },
  })
    .png()
    .toBuffer()
  writeFileSync(filePath, data)
  return filePath
}

async function makeSolid(
  name: string,
  background: { r: number; g: number; b: number },
): Promise<string> {
  const filePath = path.join(directory, name)
  const data = await sharp({ create: { width: 600, height: 300, channels: 3, background } })
    .png()
    .toBuffer()
  writeFileSync(filePath, data)
  return filePath
}

/** Which half of the image the label's dark pixels fall in. */
async function darkBounds(filePath: string): Promise<{ right: boolean; bottom: boolean }> {
  const { data, info } = await sharp(filePath).raw().toBuffer({ resolveWithObject: true })

  let sumX = 0
  let sumY = 0
  let count = 0
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      if (data[(y * info.width + x) * info.channels]! < 100) {
        sumX += x
        sumY += y
        count += 1
      }
    }
  }

  if (count === 0) throw new Error('no label pixels found')
  return { right: sumX / count > info.width / 2, bottom: sumY / count > info.height / 2 }
}

/**
 * Counts pixels whose red channel matches, read from raw data.
 *
 * `stats()` reports differently once an image carries an alpha channel, which
 * compositing adds, so the raw buffer is the honest measure here.
 */
async function countPixels(filePath: string, matches: (value: number) => boolean): Promise<number> {
  const { data, info } = await sharp(filePath).raw().toBuffer({ resolveWithObject: true })

  let count = 0
  for (let index = 0; index < data.length; index += info.channels) {
    if (matches(data[index]!)) count += 1
  }
  return count
}

/** Applies a visible label to a copy and returns where it landed. */
async function label(
  filePath: string,
  options: Omit<Parameters<typeof markFile>[1], 'visibleLabel' | 'outputPath'> = {
    machineReadable: false,
  },
): Promise<string> {
  const result = await markFile(filePath, {
    ...options,
    visibleLabel: true,
    outputPath: labelledPathFor(filePath),
  })
  return result.filePath
}

/** How far two encodings of the same image drift, averaged per channel value. */
async function meanPixelDifference(a: Uint8Array, b: Uint8Array): Promise<number> {
  const left = await sharp(a).raw().toBuffer()
  const right = await sharp(b).raw().toBuffer()

  let total = 0
  for (let index = 0; index < left.length; index += 1) {
    total += Math.abs(left[index]! - right[index]!)
  }
  return total / left.length
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

    const result = await markFile(file, {
      machineReadable: false,
      visibleLabel: true,
      outputPath: labelledPathFor(file),
    })

    // The original is untouched; the copy is what changed.
    expect(await sharp(file).raw().toBuffer()).toEqual(before)
    expect(Buffer.compare(before, await sharp(result.filePath).raw().toBuffer())).not.toBe(0)
  })

  it('refuses to overwrite the original with a labelled version', async () => {
    // A label placed badly can be redone from an untouched original and from
    // nothing else, so overwriting has to be asked for explicitly.
    const file = await makePng()

    await expect(
      markFile(file, { machineReadable: false, visibleLabel: true }),
    ).rejects.toMatchObject({ code: ERROR_CODE.VALIDATION_ERROR })
  })

  it('reports both paths so neither has to be guessed', async () => {
    const file = await makeSolid('both.png', { r: 250, g: 250, b: 250 })

    const result = await markFile(file, {
      machineReadable: true,
      visibleLabel: true,
      outputPath: labelledPathFor(file),
    })

    expect(result.sourcePath).toBe(file)
    expect(result.filePath).toBe(labelledPathFor(file))
    expect(result.filePath).not.toBe(result.sourcePath)
  })

  it('names the copy beside the original', () => {
    expect(labelledPathFor('/tmp/photo.png')).toBe('/tmp/photo.labelled.png')
    expect(labelledPathFor('photo.jpeg')).toBe('photo.labelled.jpeg')
    expect(labelledPathFor('noextension')).toBe('noextension.labelled')
  })

  it('fits on an image far smaller than the label is wide', async () => {
    // sharp refuses to composite something larger than its canvas, so an
    // unclamped label turns a request for a disclosure into an error.
    const tiny = await makePng('tiny.png', 40, 24)

    const marked = await markFile(tiny, {
      machineReadable: false,
      visibleLabel: true,
      outputPath: labelledPathFor(tiny),
    })
    expect(marked.visibleLabelWritten).toBe(true)

    const after = await sharp(marked.filePath).metadata()
    expect(after.width).toBe(40)
    expect(after.height).toBe(24)
  })

  it('leaves the image its original size', async () => {
    const file = await makePng('sized.png', 800, 400)

    const result = await markFile(file, {
      machineReadable: false,
      visibleLabel: true,
      outputPath: labelledPathFor(file),
    })

    const after = await sharp(result.filePath).metadata()
    expect(after.width).toBe(800)
    expect(after.height).toBe(400)
  })

  it('picks the light badge on a dark image and the dark badge on a light one', async () => {
    // The Commission ships both because neither is legible everywhere. The
    // proof is that the label contrasts with whatever it was placed on.
    const dark = await makeSolid('dark.png', { r: 8, g: 8, b: 10 })
    const light = await makeSolid('light.png', { r: 245, g: 245, b: 240 })

    const darkLabelled = await label(dark)
    const lightLabelled = await label(light)

    expect(await countPixels(darkLabelled, (value) => value > 150)).toBeGreaterThan(500)
    expect(await countPixels(lightLabelled, (value) => value < 100)).toBeGreaterThan(500)
  })

  it('defaults to the bottom-right corner', async () => {
    const file = await makeSolid('pos.png', { r: 250, g: 250, b: 250 })

    const result = await markFile(file, {
      machineReadable: false,
      visibleLabel: true,
      outputPath: labelledPathFor(file),
    })

    expect(result.labelPosition).toBe('bottom-right')
    expect(await darkBounds(result.filePath)).toMatchObject({ right: true, bottom: true })
  })

  it('puts the label where it is told', async () => {
    const file = await makeSolid('topleft.png', { r: 250, g: 250, b: 250 })

    const result = await markFile(file, {
      machineReadable: false,
      visibleLabel: true,
      labelPosition: 'top-left',
      outputPath: labelledPathFor(file),
    })

    expect(result.labelPosition).toBe('top-left')
    expect(await darkBounds(result.filePath)).toMatchObject({ right: false, bottom: false })
  })

  it('auto places the label in the calmest corner', async () => {
    // Busy on the right, flat on the left: the label belongs on the left.
    const file = path.join(directory, 'busy.png')
    const noise = Buffer.alloc(300 * 300 * 3)
    for (let index = 0; index < noise.length; index += 1) noise[index] = (index * 97) % 256
    const base = await sharp({
      create: { width: 600, height: 300, channels: 3, background: { r: 250, g: 250, b: 250 } },
    })
      .png()
      .toBuffer()
    writeFileSync(
      file,
      await sharp(base)
        .composite([
          { input: noise, raw: { width: 300, height: 300, channels: 3 }, left: 300, top: 0 },
        ])
        .png()
        .toBuffer(),
    )

    const result = await markFile(file, {
      machineReadable: false,
      visibleLabel: true,
      labelPosition: 'auto',
      outputPath: labelledPathFor(file),
    })

    expect(result.labelPosition?.endsWith('left')).toBe(true)
  })

  it('reports no position when no visible label was drawn', async () => {
    const file = await makePng('nolabel.png')

    const result = await markFile(file, { machineReadable: true, visibleLabel: false })

    expect(result.labelPosition).toBeUndefined()
  })

  it('uses the modified label when asked', async () => {
    // The two badges differ in width, which is the cheapest observable proof
    // that a different one was drawn.
    const generated = await makeSolid('gen.png', { r: 250, g: 250, b: 250 })
    const modified = await makeSolid('mod.png', { r: 250, g: 250, b: 250 })

    const a = await sharp(await label(generated))
      .raw()
      .toBuffer()
    const b = await sharp(await label(modified, { machineReadable: false, labelKind: 'modified' }))
      .raw()
      .toBuffer()

    expect(Buffer.compare(a, b)).not.toBe(0)
  })

  it('is independent of the machine-readable marker', async () => {
    const file = await makePng()

    const result = await markFile(file, {
      machineReadable: false,
      visibleLabel: true,
      outputPath: labelledPathFor(file),
    })

    expect(result.visibleLabelWritten).toBe(true)
    expect(result.machineReadableWritten).toBe(false)
    expect(hasDigitalSourceType(await xmpOf(result.filePath))).toBe(false)
  })
})

describe('asking for both markers at once', () => {
  /**
   * The case that matters most, and the one that was silently wrong: the
   * unlabelled original is the file callers are told to keep and the one a
   * script is most likely to publish. If the marker follows the label into
   * the copy, that file goes out declaring nothing.
   */
  it('marks the original too, not only the labelled copy', async () => {
    const file = await makeSolid('both-marked.png', { r: 40, g: 40, b: 40 })

    const result = await markFile(file, {
      machineReadable: true,
      visibleLabel: true,
      outputPath: labelledPathFor(file),
    })

    expect(hasDigitalSourceType(await xmpOf(result.sourcePath!))).toBe(true)
    expect(hasDigitalSourceType(await xmpOf(result.filePath))).toBe(true)
  })

  it('leaves the pixels of the original alone while doing it', async () => {
    const file = await makeSolid('both-pixels.png', { r: 40, g: 40, b: 40 })
    const before = await sharp(file).raw().toBuffer()

    const result = await markFile(file, {
      machineReadable: true,
      visibleLabel: true,
      outputPath: labelledPathFor(file),
    })

    // Metadata added, no label drawn.
    expect(await sharp(result.sourcePath).raw().toBuffer()).toEqual(before)
    expect(Buffer.compare(before, await sharp(result.filePath).raw().toBuffer())).not.toBe(0)
  })

  it('records the same provenance in both files', async () => {
    const file = await makeSolid('both-provenance.png', { r: 40, g: 40, b: 40 })

    const result = await markFile(
      file,
      { machineReadable: true, visibleLabel: true, outputPath: labelledPathFor(file) },
      { provider: 'gemini', model: 'gemini-3-pro-image' },
    )

    for (const written of [result.sourcePath!, result.filePath]) {
      const xmp = await xmpOf(written)
      expect(xmp, written).toContain(TRAINED_ALGORITHMIC_MEDIA)
      expect(xmp, written).toContain('gemini-3-pro-image')
    }
  })
})

describe('marking a lossy format', () => {
  /**
   * sharp cannot add metadata without rewriting the file, so marking a JPEG
   * costs a re-encode. Left to its defaults that is quality 80 with subsampled
   * colour, which took a real 4K generation from 8.4 MB to 1.4 MB — a
   * significant loss, paid silently, for adding a line of metadata.
   */
  it('does not fall back to the encoder default quality', async () => {
    const filePath = path.join(directory, 'photo.jpg')
    // Noise, not a flat colour: a solid image survives any quality setting
    // and would hide the difference entirely.
    const noise = Buffer.alloc(400 * 400 * 3)
    for (let index = 0; index < noise.length; index += 1) {
      noise[index] = (index * 2654435761) % 256
    }
    const source = await sharp(noise, { raw: { width: 400, height: 400, channels: 3 } })
      .jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
      .toBuffer()
    writeFileSync(filePath, source)

    await markFile(filePath, { machineReadable: true, visibleLabel: false })

    expect(hasDigitalSourceType(await xmpOf(filePath))).toBe(true)

    // Measured on this image: about 5 at the quality marking uses, about 62 if
    // the encoder is left to its defaults. The threshold sits between them
    // rather than against either, so a modest encoder change does not fail it
    // but a fallback to the defaults does.
    expect(await meanPixelDifference(source, readFileSync(filePath))).toBeLessThan(25)
  })

  it('keeps the format it was given', async () => {
    const filePath = path.join(directory, 'keep.jpg')
    const source = await sharp({
      create: { width: 64, height: 64, channels: 3, background: { r: 90, g: 30, b: 30 } },
    })
      .jpeg()
      .toBuffer()
    writeFileSync(filePath, source)

    await markFile(filePath, { machineReadable: true, visibleLabel: false })

    expect((await sharp(readFileSync(filePath)).metadata()).format).toBe('jpeg')
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
