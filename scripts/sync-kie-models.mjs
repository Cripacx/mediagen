#!/usr/bin/env node

/**
 * Regenerates the Kie AI model table from Kie's own documentation.
 *
 * Kie publishes a maintained index of every documentation page at
 * `/llms.txt`, and every model page embeds a complete OpenAPI specification.
 * That makes the model table derivable rather than something to hand-maintain,
 * which matters because a hand-written descriptor goes stale in both
 * directions: a model gains an aspect ratio and the frozen table starts
 * rejecting valid requests with a confident error.
 *
 * Usage:
 *   node scripts/sync-kie-models.mjs            regenerate the table
 *   node scripts/sync-kie-models.mjs --check    fail if the table has drifted
 *
 * The generated table is committed, so generating an image never depends on
 * the network or on Kie's documentation being reachable.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'

const DOCS_INDEX = 'https://docs.kie.ai/llms.txt'
const OUTPUT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'providers',
  'kie',
  'models.generated.ts',
)

/**
 * Ratios and sizes this tool knows how to express. A value outside these
 * sets is dropped with a log line rather than silently kept, so the table
 * never claims a shape the CLI cannot ask for.
 */
const KNOWN_ASPECT_RATIOS = new Set([
  '1:1',
  '1:4',
  '1:8',
  '2:3',
  '3:2',
  '3:4',
  '4:1',
  '4:3',
  '4:5',
  '5:4',
  '8:1',
  '9:16',
  '16:9',
  '21:9',
])
const KNOWN_RESOLUTIONS = new Set(['1K', '2K', '4K'])

/** How a model spells each of the formats this tool exposes. */
const OUTPUT_FORMAT_ALIASES = { png: 'png', jpg: 'jpeg', jpeg: 'jpeg' }

/** Route suffixes that mark one half of a model rather than a distinct model. */
const EDIT_SUFFIXES = ['-image-to-image', '/image-to-image', '-edit', '/edit']
const GENERATE_SUFFIXES = ['-text-to-image', '/text-to-image']

const CONCURRENCY = 5

function log(message) {
  process.stderr.write(`${message}\n`)
}

/**
 * Thrown when a page could not be retrieved at all, as opposed to retrieved
 * and not understood. The two mean opposite things: the first is a network
 * blip, the second is a documentation change.
 */
class UnreachableError extends Error {
  constructor(message) {
    super(message)
    this.name = 'UnreachableError'
  }
}

/** Retries only what is worth retrying: a transient failure, not a 404. */
const FETCH_ATTEMPTS = 3
const RETRY_BASE_MS = 500

async function fetchOnce(url) {
  let response
  try {
    response = await fetch(url, { headers: { 'user-agent': 'mediagen-model-sync' } })
  } catch (error) {
    throw new UnreachableError(`GET ${url} failed: ${error.message}`)
  }
  if (!response.ok) {
    // 5xx and 429 are the server having a bad moment; 404 means the page is
    // genuinely gone, which is a documentation change worth reflecting.
    if (response.status >= 500 || response.status === 429) {
      throw new UnreachableError(`GET ${url} responded ${response.status}`)
    }
    throw new Error(`GET ${url} responded ${response.status}`)
  }
  return response.text()
}

/**
 * Reading fifty pages over one connection produces the occasional dropped
 * request, and every one of those would otherwise shrink the table. Retrying
 * the transient ones is a better answer than reporting them.
 */
async function fetchText(url) {
  let last
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt += 1) {
    try {
      return await fetchOnce(url)
    } catch (error) {
      last = error
      if (!(error instanceof UnreachableError) || attempt === FETCH_ATTEMPTS) break
      await new Promise((resolve) => setTimeout(resolve, RETRY_BASE_MS * 2 ** (attempt - 1)))
    }
  }
  throw last
}

/**
 * Reads the documentation index and returns the model pages of one section
 * (`Image` or `Video`), skipping the translated mirrors and the non-model
 * pages under market/. Only market/ pages speak the createTask API this tool
 * uses; Veo and Runway have endpoints of their own and are not listed.
 */
function parseIndex(indexText, section) {
  const pages = []
  for (const line of indexText.split('\n')) {
    if (!line.startsWith(`- ${section}`)) continue

    const match = line.match(/\]\((https:\/\/docs\.kie\.ai\/market\/[^)]+\.md)\)/)
    if (!match) continue

    const url = match[1]
    if (url.includes('/cn/') || url.includes('/market/common/') || url.endsWith('/quickstart.md')) {
      continue
    }
    pages.push(url)
  }
  return [...new Set(pages)]
}

/** Extracts and parses the OpenAPI block a model page embeds. */
function extractSpec(markdown) {
  const start = markdown.indexOf('```yaml')
  if (start === -1) return undefined
  const bodyStart = markdown.indexOf('\n', start) + 1
  const end = markdown.indexOf('```', bodyStart)
  if (end === -1) return undefined
  try {
    return parseYaml(markdown.slice(bodyStart, end))
  } catch {
    return undefined
  }
}

/** Finds the createTask request schema inside the spec. */
function findRequestSchema(spec) {
  for (const methods of Object.values(spec?.paths ?? {})) {
    const schema = methods?.post?.requestBody?.content?.['application/json']?.schema
    if (schema?.properties?.model && schema.properties.input) {
      return schema.properties
    }
  }
  return undefined
}

function enumOf(property) {
  return Array.isArray(property?.enum) ? property.enum.map(String) : []
}

/**
 * Finds the property carrying input images, whatever it is called. Some models
 * take an array of URIs and others a single URI string, and sending the wrong
 * shape is as broken as sending the wrong name, so both are recorded.
 */
function findImageInput(inputProperties) {
  for (const [name, property] of Object.entries(inputProperties)) {
    if (!/image|input|url|reference/i.test(name)) continue

    if (property?.type === 'array' && property?.items?.format === 'uri') {
      return { imageInputField: name, imageInputIsArray: true }
    }
    // Not every model marks the string as `format: uri`, so a name that says
    // url is accepted too. `image_size` and friends do not match.
    if (property?.type === 'string' && (property?.format === 'uri' || /url/i.test(name))) {
      return { imageInputField: name, imageInputIsArray: false }
    }
  }
  return undefined
}

/** Reduces a model id to the key shared by its generate and edit routes. */
function baseKeyOf(modelId) {
  for (const suffix of [...EDIT_SUFFIXES, ...GENERATE_SUFFIXES]) {
    if (modelId.endsWith(suffix)) {
      return modelId.slice(0, -suffix.length)
    }
  }
  return modelId
}

function isEditRoute(modelId) {
  return EDIT_SUFFIXES.some((suffix) => modelId.endsWith(suffix))
}

/** Turns one documentation page into a partial descriptor. */
function describePage(url, markdown) {
  const spec = extractSpec(markdown)
  if (!spec) return undefined

  const properties = findRequestSchema(spec)
  if (!properties) return undefined

  const modelId = enumOf(properties.model)[0] ?? properties.model?.default
  const inputProperties = properties.input?.properties
  if (!modelId || !inputProperties?.prompt) {
    // Without a model id or a prompt this is not a prompt-driven image model.
    return undefined
  }

  const aspectRatios = enumOf(inputProperties.aspect_ratio).filter((value) =>
    KNOWN_ASPECT_RATIOS.has(value),
  )
  const resolutions = enumOf(inputProperties.resolution).filter((value) =>
    KNOWN_RESOLUTIONS.has(value),
  )

  const outputFormats = {}
  for (const value of enumOf(inputProperties.output_format)) {
    const canonical = OUTPUT_FORMAT_ALIASES[value.toLowerCase()]
    if (canonical) outputFormats[canonical] = value
  }

  return {
    url,
    modelId,
    ...findImageInput(inputProperties),
    aspectRatios,
    resolutions,
    outputFormats,
  }
}

/** Merges the generate and edit pages of one model into a single descriptor. */
function mergeDescriptors(pages) {
  const byKey = new Map()

  for (const page of pages) {
    const key = baseKeyOf(page.modelId)
    const existing = byKey.get(key) ?? { key, sources: [] }
    existing.sources.push(page.url)

    if (isEditRoute(page.modelId)) {
      existing.imageToImage = page.modelId
      if (page.imageInputField) {
        existing.imageInputField = existing.imageInputField ?? page.imageInputField
        existing.imageInputIsArray = existing.imageInputIsArray ?? page.imageInputIsArray
      }
    } else {
      existing.textToImage = page.modelId
      // A model with one id for both routes advertises its image input here.
      if (page.imageInputField) {
        existing.imageToImage = existing.imageToImage ?? page.modelId
        existing.imageInputField = existing.imageInputField ?? page.imageInputField
        existing.imageInputIsArray = existing.imageInputIsArray ?? page.imageInputIsArray
      }
    }

    // The generate route defines the shape parameters; fall back to the edit route.
    const shapeSource =
      isEditRoute(page.modelId) && existing.aspectRatios?.length ? undefined : page
    if (shapeSource) {
      existing.aspectRatios = shapeSource.aspectRatios
      existing.resolutions = shapeSource.resolutions
      existing.outputFormats = shapeSource.outputFormats
    }

    byKey.set(key, existing)
  }

  // Stripping a route suffix from an edit-only model would invent a key that
  // is not a model, and would point generation at an editing endpoint. Such a
  // model keeps its own id as the key and is marked as unable to generate.
  const entries = [...byKey.values()].map((entry) =>
    entry.textToImage ? entry : { ...entry, key: entry.imageToImage },
  )

  // An edit route whose input field could not be identified cannot be built
  // into a valid request, so it is not offered rather than offered broken.
  for (const entry of entries) {
    if (entry.imageToImage && !entry.imageInputField) {
      log(`  ${entry.key}: dropping the edit route, no input image field found`)
      entry.imageToImage = undefined
    }
  }

  return entries
    .filter((entry) => entry.textToImage || entry.imageToImage)
    .sort((a, b) => a.key.localeCompare(b.key))
}

/**
 * Video pages are less uniform than image pages: the same idea is spelled
 * `aspect_ratio` or `ratio`, `resolution` or `quality`, and the starting frame
 * arrives as `first_frame_url`, `image_url`, `image_urls` or `input_urls`.
 * Each list is in order of preference. A reference image is deliberately not a
 * starting frame, so `reference_*` fields are never used for --input.
 */
const VIDEO_IMAGE_FIELDS = ['first_frame_url', 'image_url', 'image_urls', 'input_urls']
const VIDEO_ASPECT_FIELDS = ['aspect_ratio', 'ratio']
const VIDEO_RESOLUTION_FIELDS = ['resolution', 'quality']

const TEXT_TO_VIDEO_SUFFIXES = ['-text-to-video', '/text-to-video']
const IMAGE_TO_VIDEO_SUFFIXES = ['-image-to-video', '/image-to-video']

/**
 * Endpoints conditioned on reference media or a source video. Their schemas
 * often accept a prompt alone, but that is not what they are for, and --input
 * does not map onto a reference set.
 */
const NON_GENERATING_VIDEO_ROUTES = /(reference-to-video|transformation|r2v)$/

/** Used for a required ratio with no documented default, when the model offers it. */
const PREFERRED_ASPECT_RATIO = '16:9'

/** A duration range wider than this is left unpoliced rather than listed. */
const MAX_LISTED_DURATIONS = 60

/** Kie's documentation occasionally carries a trailing space in a field name. */
function trimKeys(properties) {
  return Object.fromEntries(Object.entries(properties).map(([name, value]) => [name.trim(), value]))
}

function endsWithAny(value, suffixes) {
  return suffixes.some((suffix) => value.endsWith(suffix))
}

/**
 * The durations a route accepts: its enum, or the integer range it documents
 * as minimum and maximum. Neither present means the value is not policed.
 */
function durationsOf(property) {
  const listed = enumOf(property).map(Number)
  if (listed.length) return listed

  const { minimum, maximum } = property
  if (Number.isInteger(minimum) && Number.isInteger(maximum) && maximum >= minimum) {
    if (maximum - minimum < MAX_LISTED_DURATIONS) {
      return Array.from({ length: maximum - minimum + 1 }, (_, offset) => minimum + offset)
    }
  }
  return []
}

/**
 * The value to send for a required field the user may not have supplied:
 * the documented default, else a documented choice, else off for a switch.
 * Undefined means the route needs something this tool cannot provide.
 */
function requiredValueFor(property, isAspectRatio) {
  const fallback = property?.default
  if (fallback !== undefined && fallback !== '' && !Array.isArray(fallback)) return fallback

  const choices = enumOf(property)
  if (choices.length) {
    if (isAspectRatio && choices.includes(PREFERRED_ASPECT_RATIO)) return PREFERRED_ASPECT_RATIO
    return property.type === 'string' ? choices[0] : Number(choices[0])
  }
  if (property?.type === 'boolean') return false
  if (Number.isFinite(property?.minimum)) return property.minimum
  return undefined
}

/**
 * Which half of a model a video page is: text-to-video, image-to-video, or
 * both when the starting frame is optional.
 */
function videoRouteKind(modelId, imageField, required) {
  if (endsWithAny(modelId, IMAGE_TO_VIDEO_SUFFIXES)) return 'imageToVideo'
  if (imageField && required.includes(imageField)) return 'imageToVideo'
  if (endsWithAny(modelId, TEXT_TO_VIDEO_SUFFIXES) || !imageField) return 'textToVideo'
  return 'both'
}

/** Turns one video documentation page into a route descriptor. */
function describeVideoPage(url, markdown) {
  const spec = extractSpec(markdown)
  if (!spec) return undefined

  const properties = findRequestSchema(spec)
  if (!properties) return undefined

  const modelId = enumOf(properties.model)[0] ?? properties.model?.default
  const input = trimKeys(properties.input?.properties ?? {})
  if (!modelId || !input.prompt) return undefined
  if (NON_GENERATING_VIDEO_ROUTES.test(modelId)) {
    log(`  ${modelId}: skipped, conditioned on reference media`)
    return undefined
  }
  const required = (properties.input.required ?? []).map((name) => name.trim())

  const imageField = VIDEO_IMAGE_FIELDS.find((name) =>
    ['string', 'array'].includes(input[name]?.type),
  )
  const kind = videoRouteKind(modelId, imageField, required)
  if (kind === 'imageToVideo' && !imageField) {
    log(`  ${modelId}: skipped, no starting-frame field found`)
    return undefined
  }

  const aspectRatioField = VIDEO_ASPECT_FIELDS.find((name) => input[name] !== undefined)
  const resolutionField = VIDEO_RESOLUTION_FIELDS.find((name) => input[name] !== undefined)
  const duration = input.duration

  const route = { model: modelId }
  if (imageField && kind !== 'textToVideo') {
    route.imageInputField = imageField
    route.imageInputIsArray = input[imageField].type === 'array'
  }
  if (aspectRatioField) {
    route.aspectRatioField = aspectRatioField
    route.aspectRatios = enumOf(input[aspectRatioField])
  }
  if (resolutionField) {
    route.resolutionField = resolutionField
    route.resolutions = enumOf(input[resolutionField])
  }
  if (duration) {
    route.durationType = duration.type === 'string' ? 'string' : 'number'
    route.durations = durationsOf(duration)
  }

  const defaults = {}
  for (const name of required) {
    if (name === 'prompt' || name === imageField) continue
    const value = requiredValueFor(input[name], name === aspectRatioField)
    if (value === undefined) {
      log(`  ${modelId}: skipped, required field "${name}" has no value this tool can supply`)
      return undefined
    }
    defaults[name] = value
  }
  if (Object.keys(defaults).length) route.defaults = defaults

  return { url, kind, route }
}

/** Reduces a video model id to the key shared by its two routes. */
function videoBaseKeyOf(modelId) {
  for (const suffix of [...TEXT_TO_VIDEO_SUFFIXES, ...IMAGE_TO_VIDEO_SUFFIXES]) {
    if (modelId.endsWith(suffix)) return modelId.slice(0, -suffix.length)
  }
  return modelId
}

/** Merges the text-to-video and image-to-video pages of one model. */
function mergeVideoRoutes(pages) {
  const byKey = new Map()

  for (const page of pages) {
    const key = videoBaseKeyOf(page.route.model)
    const entry = byKey.get(key) ?? { key }
    const slots = page.kind === 'both' ? ['textToVideo', 'imageToVideo'] : [page.kind]

    for (const slot of slots) {
      // A page dedicated to one route is more specific than one serving both.
      if (page.kind === 'both' && entry[slot]) continue
      // The text-to-video half never sends a starting frame.
      const { imageInputField: _field, imageInputIsArray: _isArray, ...withoutImage } = page.route
      entry[slot] = slot === 'textToVideo' ? withoutImage : page.route
    }
    byKey.set(key, entry)
  }

  // As with images: an image-only model keeps its own id rather than a key
  // invented by stripping the suffix.
  return [...byKey.values()]
    .map((entry) => (entry.textToVideo ? entry : { ...entry, key: entry.imageToVideo.model }))
    .sort((a, b) => a.key.localeCompare(b.key))
}

async function mapWithConcurrency(items, limit, worker) {
  const results = []
  let index = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = index++
      results[current] = await worker(items[current])
    }
  })
  await Promise.all(runners)
  return results
}

function renderList(values) {
  return `[${values.map((value) => `'${value}'`).join(', ')}]`
}

function renderEntry(entry) {
  const lines = [`  '${entry.key}': {`]
  if (entry.textToImage) lines.push(`    textToImage: '${entry.textToImage}',`)
  if (entry.imageToImage) lines.push(`    imageToImage: '${entry.imageToImage}',`)
  if (entry.imageInputField) {
    lines.push(`    imageInputField: '${entry.imageInputField}',`)
    lines.push(`    imageInputIsArray: ${entry.imageInputIsArray === true},`)
  }
  if (entry.aspectRatios?.length) {
    lines.push(`    aspectRatios: ${renderList(entry.aspectRatios)},`)
  }
  if (entry.resolutions?.length) {
    lines.push(`    resolutions: ${renderList(entry.resolutions)},`)
  }
  const formats = Object.entries(entry.outputFormats ?? {})
  if (formats.length) {
    const rendered = formats.map(([key, value]) => `${key}: '${value}'`).join(', ')
    lines.push(`    outputFormats: { ${rendered} },`)
  }
  lines.push('  },')
  return lines.join('\n')
}

function renderValue(value) {
  return typeof value === 'string' ? `'${value}'` : String(value)
}

function renderVideoRoute(slot, route) {
  const lines = [`    ${slot}: {`, `      model: '${route.model}',`]
  if (route.imageInputField) {
    lines.push(`      imageInputField: '${route.imageInputField}',`)
    lines.push(`      imageInputIsArray: ${route.imageInputIsArray === true},`)
  }
  if (route.aspectRatioField) {
    lines.push(`      aspectRatioField: '${route.aspectRatioField}',`)
    if (route.aspectRatios.length)
      lines.push(`      aspectRatios: ${renderList(route.aspectRatios)},`)
  }
  if (route.resolutionField) {
    lines.push(`      resolutionField: '${route.resolutionField}',`)
    if (route.resolutions.length) lines.push(`      resolutions: ${renderList(route.resolutions)},`)
  }
  if (route.durationType) {
    lines.push(`      durationType: '${route.durationType}',`)
    if (route.durations.length) lines.push(`      durations: [${route.durations.join(', ')}],`)
  }
  const defaults = Object.entries(route.defaults ?? {})
  if (defaults.length) {
    const rendered = defaults.map(([key, value]) => `${key}: ${renderValue(value)}`).join(', ')
    lines.push(`      defaults: { ${rendered} },`)
  }
  lines.push('    },')
  return lines
}

function renderVideoEntry(entry) {
  const lines = [`  '${entry.key}': {`]
  if (entry.textToVideo) lines.push(...renderVideoRoute('textToVideo', entry.textToVideo))
  if (entry.imageToVideo) lines.push(...renderVideoRoute('imageToVideo', entry.imageToVideo))
  lines.push('  },')
  return lines.join('\n')
}

function renderModule(imageEntries, videoEntries) {
  return `/**
 * Generated from Kie AI's documentation. Do not edit by hand.
 *
 * Regenerate with:
 *   npm run sync:kie-models
 *
 * Source: https://docs.kie.ai/llms.txt and the OpenAPI specification embedded
 * in each model's documentation page. ${imageEntries.length} image models, ${videoEntries.length} video models.
 */

import type { KieModelShape, KieVideoModelShape } from './modelShape.js'

export const GENERATED_KIE_MODELS = {
${imageEntries.map(renderEntry).join('\n')}
} as const satisfies Record<string, KieModelShape>

export const GENERATED_KIE_VIDEO_MODELS = {
${videoEntries.map(renderVideoEntry).join('\n')}
} as const satisfies Record<string, KieVideoModelShape>
`
}

/**
 * Fetches and describes every page of one section. A page that cannot be
 * reached is recorded rather than dropped, see below.
 */
async function describeAll(pageUrls, describe, unreachable) {
  const described = await mapWithConcurrency(pageUrls, CONCURRENCY, async (url) => {
    try {
      return describe(url, await fetchText(url))
    } catch (error) {
      if (error instanceof UnreachableError) {
        unreachable.push(url)
        log(`  unreachable ${url}: ${error.message}`)
      } else {
        log(`  skipped ${url}: ${error.message}`)
      }
      return undefined
    }
  })
  return described.filter(Boolean)
}

async function main() {
  const checkOnly = process.argv.includes('--check')

  log(`Reading ${DOCS_INDEX}`)
  const index = await fetchText(DOCS_INDEX)
  const imageUrls = parseIndex(index, 'Image')
  const videoUrls = parseIndex(index, 'Video')
  log(`Found ${imageUrls.length} image and ${videoUrls.length} video model pages`)

  const unreachable = []

  const imagePages = await describeAll(imageUrls, describePage, unreachable)
  const imageEntries = mergeDescriptors(imagePages)
  log(`Parsed ${imagePages.length} image specifications into ${imageEntries.length} models`)

  const videoPages = await describeAll(videoUrls, describeVideoPage, unreachable)
  const videoEntries = mergeVideoRoutes(videoPages)
  log(`Parsed ${videoPages.length} video specifications into ${videoEntries.length} models`)

  if (imageEntries.length === 0 || videoEntries.length === 0) {
    log('Refusing to write an empty table; the documentation format may have changed.')
    process.exit(1)
  }

  // A page that could not be fetched would silently shrink the table, and a
  // shorter table reads exactly like full coverage of a shorter catalogue.
  // The model would still work — an unlisted id is passed through —
  // but it would lose its editing route, because the name of its input-image
  // field is only known from the page that failed to load.
  if (unreachable.length > 0 && !process.argv.includes('--allow-partial')) {
    log('')
    log(`${unreachable.length} page(s) could not be fetched, so this run is incomplete.`)
    log('Refusing to act on a partial reading. Retry, or pass --allow-partial to override.')
    process.exit(1)
  }

  const rendered = renderModule(imageEntries, videoEntries)

  if (checkOnly) {
    let current = ''
    try {
      current = readFileSync(OUTPUT_PATH, 'utf-8')
    } catch {
      log('No generated table found. Run: npm run sync:kie-models')
      process.exit(1)
    }
    if (current !== rendered) {
      log('The Kie model table has drifted from the documentation.')
      log('Run: npm run sync:kie-models')
      process.exit(1)
    }
    log('The Kie model table matches the documentation.')
    return
  }

  writeFileSync(OUTPUT_PATH, rendered, 'utf-8')
  log(`Wrote ${OUTPUT_PATH}`)
}

main().catch((error) => {
  log(`Sync failed: ${error.message}`)
  process.exit(1)
})
