/**
 * Where a local input image goes before a Kie job can reference it.
 *
 * Kie serves its file API from its own host. Posting the upload to api.kie.ai
 * answers 404, which surfaced only as "Kie AI rejected the request (404)" on
 * every image-to-video and edit request — text-only requests never upload, so
 * they kept working and hid it.
 */

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { uploadInputImage } from '../task.js'

/** The eight-byte PNG signature is enough for the type sniffing. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the Kie input upload', () => {
  it('posts to the file host, not to the job API', async () => {
    const file = path.join(await mkdtemp(path.join(tmpdir(), 'mediagen-')), 'frame.png')
    await writeFile(file, PNG)
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ code: 200, data: { downloadUrl: 'https://files/x.png' } })),
      )
    vi.stubGlobal('fetch', fetchMock)

    const url = await uploadInputImage(file, 'test-key', undefined)

    expect(url).toBe('https://files/x.png')
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://kieai.redpandaai.co/api/file-base64-upload')
  })

  it('names the failing stage when Kie answers with a 4xx', async () => {
    const file = path.join(await mkdtemp(path.join(tmpdir(), 'mediagen-')), 'frame.png')
    await writeFile(file, PNG)
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 404 })),
    )

    await expect(uploadInputImage(file, 'test-key', undefined)).rejects.toThrow(
      'Kie AI rejected the request (404) during input image upload.',
    )
  })
})
