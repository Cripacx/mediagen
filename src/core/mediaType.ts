/**
 * Deciding what a byte stream actually is.
 *
 * Spec §8 requires the requested file extension to be reconciled with the
 * real media type and corrected when they disagree — and the correction to be
 * logged rather than done silently. That needs one place that can name a type
 * from its bytes, because a provider's declared MIME type is a claim, not a
 * fact, and a user's chosen extension is a preference.
 */

export interface MediaTypeInfo {
  readonly mimeType: string
  readonly extension: string
}

/** Magic-number prefixes, longest-first where prefixes overlap. */
const SIGNATURES: ReadonlyArray<{
  readonly mimeType: string
  readonly extension: string
  readonly test: (bytes: Uint8Array) => boolean
}> = [
  { mimeType: 'image/png', extension: '.png', test: (b) => starts(b, [0x89, 0x50, 0x4e, 0x47]) },
  { mimeType: 'image/jpeg', extension: '.jpg', test: (b) => starts(b, [0xff, 0xd8, 0xff]) },
  { mimeType: 'image/gif', extension: '.gif', test: (b) => starts(b, [0x47, 0x49, 0x46, 0x38]) },
  {
    mimeType: 'image/webp',
    extension: '.webp',
    test: (b) => starts(b, [0x52, 0x49, 0x46, 0x46]) && matchesAt(b, 8, [0x57, 0x45, 0x42, 0x50]),
  },
  {
    mimeType: 'video/mp4',
    extension: '.mp4',
    test: (b) => matchesAt(b, 4, [0x66, 0x74, 0x79, 0x70]),
  },
  {
    mimeType: 'video/webm',
    extension: '.webm',
    test: (b) => starts(b, [0x1a, 0x45, 0xdf, 0xa3]),
  },
]

const EXTENSION_BY_MIME: Readonly<Record<string, string>> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
}

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
}

function starts(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return matchesAt(bytes, 0, prefix)
}

function matchesAt(bytes: Uint8Array, offset: number, prefix: readonly number[]): boolean {
  if (bytes.length < offset + prefix.length) return false
  return prefix.every((byte, index) => bytes[offset + index] === byte)
}

/** What the bytes say they are, or undefined when nothing matches. */
export function sniffMediaType(bytes: Uint8Array): MediaTypeInfo | undefined {
  const match = SIGNATURES.find((signature) => signature.test(bytes))
  return match ? { mimeType: match.mimeType, extension: match.extension } : undefined
}

/** The conventional extension for a MIME type, `.bin` when unknown. */
export function extensionForMime(mimeType: string): string {
  const normalised = mimeType.split(';')[0]?.trim().toLowerCase() ?? ''
  return EXTENSION_BY_MIME[normalised] ?? '.bin'
}

/** The MIME type an extension implies, for input media whose bytes are ambiguous. */
export function mimeForExtension(extension: string): string | undefined {
  return MIME_BY_EXTENSION[extension.toLowerCase()]
}
