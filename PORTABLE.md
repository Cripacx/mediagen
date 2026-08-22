# mediagen — portable Bausteine

Alle Dateien aus der bisherigen Arbeit, die du ins neue Projekt übernehmen
darfst, weil sie in dieser Session neu entstanden sind und nicht von
shinpr/mcp-image abgeleitet sind.

**Die Regel beim Portieren:** Die Dateien selbst gehören dir. Was sie
importieren, oft nicht. Abschnitt B nennt pro Datei, welche Fundamente du
darunter neu schreiben musst — kopiere die alten nicht mit, sonst hast du
nichts gewonnen.

Nicht enthalten und bewusst ausgelassen: `src/providers/registry.ts` ist zu
45 % shinprs ursprüngliche Registry. Bau sie nach Spec §6.1 neu.

## Inhalt

- **A. Wörtlich übernehmbar** — 5 Dateien, 713 Zeilen
- **B. Deine Logik, Fundamente neu schreiben** — 23 Dateien, 3503 Zeilen
- **C. Tests** — 13 Dateien, 1732 Zeilen

---

# A. Wörtlich übernehmbar

Keine Abhängigkeit auf fremden Code. Kopieren, fertig.

## `scripts/sync-kie-models.mjs`

357 Zeilen

````js
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

/** Kept in step with ASPECT_RATIO_VALUES and IMAGE_SIZE_VALUES in src/types/mcp.ts. */
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

async function fetchText(url) {
  const response = await fetch(url, { headers: { 'user-agent': 'mcp-image-model-sync' } })
  if (!response.ok) {
    throw new Error(`GET ${url} responded ${response.status}`)
  }
  return response.text()
}

/**
 * Reads the documentation index and returns the image model pages, skipping
 * the translated mirrors and the non-model pages under market/.
 */
function parseIndex(indexText) {
  const pages = []
  for (const line of indexText.split('\n')) {
    if (!line.startsWith('- Image')) continue

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

function renderModule(entries) {
  return `/**
 * Generated from Kie AI's documentation. Do not edit by hand.
 *
 * Regenerate with:
 *   npm run sync:kie-models
 *
 * Source: https://docs.kie.ai/llms.txt and the OpenAPI specification embedded
 * in each model's documentation page. ${entries.length} models.
 */

import type { KieModelShape } from './modelShape.js'

export const GENERATED_KIE_MODELS = {
${entries.map(renderEntry).join('\n')}
} as const satisfies Record<string, KieModelShape>
`
}

async function main() {
  const checkOnly = process.argv.includes('--check')

  log(`Reading ${DOCS_INDEX}`)
  const pageUrls = parseIndex(await fetchText(DOCS_INDEX))
  log(`Found ${pageUrls.length} image model pages`)

  const described = await mapWithConcurrency(pageUrls, CONCURRENCY, async (url) => {
    try {
      return describePage(url, await fetchText(url))
    } catch (error) {
      log(`  skipped ${url}: ${error.message}`)
      return undefined
    }
  })

  const pages = described.filter(Boolean)
  log(`Parsed ${pages.length} model specifications`)

  const entries = mergeDescriptors(pages)
  log(`Merged into ${entries.length} models`)

  if (entries.length === 0) {
    log('Refusing to write an empty table; the documentation format may have changed.')
    process.exit(1)
  }

  const rendered = renderModule(entries)

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
````

## `src/providers/kie/models.generated.ts`

256 Zeilen

```ts
/**
 * Generated from Kie AI's documentation. Do not edit by hand.
 *
 * Regenerate with:
 *   npm run sync:kie-models
 *
 * Source: https://docs.kie.ai/llms.txt and the OpenAPI specification embedded
 * in each model's documentation page. 32 models.
 */

import type { KieModelShape } from './modelShape.js'

export const GENERATED_KIE_MODELS = {
  'bytedance/seedream': {
    textToImage: 'bytedance/seedream',
  },
  'bytedance/seedream-v4': {
    textToImage: 'bytedance/seedream-v4-text-to-image',
    imageToImage: 'bytedance/seedream-v4-edit',
    imageInputField: 'image_urls',
    imageInputIsArray: true,
  },
  'flux-2/flex': {
    textToImage: 'flux-2/flex-text-to-image',
    imageToImage: 'flux-2/flex-image-to-image',
    imageInputField: 'input_urls',
    imageInputIsArray: true,
    aspectRatios: ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3'],
    resolutions: ['1K', '2K'],
  },
  'flux-2/pro': {
    textToImage: 'flux-2/pro-text-to-image',
    imageToImage: 'flux-2/pro-image-to-image',
    imageInputField: 'input_urls',
    imageInputIsArray: true,
    aspectRatios: ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3'],
    resolutions: ['1K', '2K'],
  },
  'google/imagen4': {
    textToImage: 'google/imagen4',
    aspectRatios: ['1:1', '16:9', '9:16', '3:4', '4:3'],
  },
  'google/imagen4-fast': {
    textToImage: 'google/imagen4-fast',
    aspectRatios: ['1:1', '16:9', '9:16', '3:4', '4:3'],
  },
  'google/imagen4-ultra': {
    textToImage: 'google/imagen4-ultra',
    aspectRatios: ['1:1', '16:9', '9:16', '3:4', '4:3'],
  },
  'google/nano-banana': {
    textToImage: 'google/nano-banana',
    imageToImage: 'google/nano-banana-edit',
    imageInputField: 'image_urls',
    imageInputIsArray: true,
    aspectRatios: ['1:1', '9:16', '16:9', '3:4', '4:3', '3:2', '2:3', '5:4', '4:5', '21:9'],
    outputFormats: { png: 'png', jpeg: 'jpeg' },
  },
  'gpt-image-2': {
    textToImage: 'gpt-image-2-text-to-image',
    imageToImage: 'gpt-image-2-image-to-image',
    imageInputField: 'input_urls',
    imageInputIsArray: true,
    aspectRatios: ['1:1', '3:2', '2:3', '4:3', '3:4', '5:4', '4:5', '16:9', '9:16', '21:9'],
    resolutions: ['1K', '2K', '4K'],
  },
  'gpt-image/1.5': {
    textToImage: 'gpt-image/1.5-text-to-image',
    imageToImage: 'gpt-image/1.5-image-to-image',
    imageInputField: 'input_urls',
    imageInputIsArray: true,
    aspectRatios: ['1:1', '2:3', '3:2'],
  },
  'grok-imagine': {
    textToImage: 'grok-imagine/text-to-image',
    imageToImage: 'grok-imagine/image-to-image',
    imageInputField: 'image_urls',
    imageInputIsArray: true,
    aspectRatios: ['2:3', '3:2', '1:1', '16:9', '9:16'],
  },
  'grok-imagine-image-2-0': {
    textToImage: 'grok-imagine-image-2-0/text-to-image',
    aspectRatios: ['1:1', '2:3', '3:2', '16:9', '9:16'],
  },
  'grok-imagine-image-2-0/image-edit': {
    imageToImage: 'grok-imagine-image-2-0/image-edit',
    imageInputField: 'image_urls',
    imageInputIsArray: true,
    aspectRatios: ['1:1', '2:3', '3:2', '16:9', '9:16'],
  },
  'ideogram/character': {
    textToImage: 'ideogram/character',
    imageToImage: 'ideogram/character-edit',
    imageInputField: 'image_url',
    imageInputIsArray: false,
  },
  'ideogram/character-remix': {
    textToImage: 'ideogram/character-remix',
    imageToImage: 'ideogram/character-remix',
    imageInputField: 'image_url',
    imageInputIsArray: false,
  },
  'ideogram/v3': {
    textToImage: 'ideogram/v3-text-to-image',
    imageToImage: 'ideogram/v3-edit',
    imageInputField: 'image_url',
    imageInputIsArray: false,
  },
  'ideogram/v3-remix': {
    textToImage: 'ideogram/v3-remix',
    imageToImage: 'ideogram/v3-remix',
    imageInputField: 'image_url',
    imageInputIsArray: false,
  },
  'nano-banana-2': {
    textToImage: 'nano-banana-2',
    imageToImage: 'nano-banana-2',
    imageInputField: 'image_input',
    imageInputIsArray: true,
    aspectRatios: [
      '1:1',
      '2:3',
      '3:2',
      '1:4',
      '4:1',
      '3:4',
      '4:3',
      '4:5',
      '5:4',
      '1:8',
      '8:1',
      '9:16',
      '16:9',
      '21:9',
    ],
    resolutions: ['1K', '2K', '4K'],
    outputFormats: { png: 'png', jpeg: 'jpg' },
  },
  'nano-banana-2-lite': {
    textToImage: 'nano-banana-2-lite',
    imageToImage: 'nano-banana-2-lite',
    imageInputField: 'image_urls',
    imageInputIsArray: true,
    aspectRatios: [
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
    ],
  },
  'nano-banana-pro': {
    textToImage: 'nano-banana-pro',
    imageToImage: 'nano-banana-pro',
    imageInputField: 'image_input',
    imageInputIsArray: true,
    aspectRatios: ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'],
    resolutions: ['1K', '2K', '4K'],
    outputFormats: { png: 'png', jpeg: 'jpg' },
  },
  qwen: {
    textToImage: 'qwen/text-to-image',
    imageToImage: 'qwen/image-to-image',
    imageInputField: 'image_url',
    imageInputIsArray: false,
    outputFormats: { png: 'png', jpeg: 'jpeg' },
  },
  'qwen/image-edit': {
    imageToImage: 'qwen/image-edit',
    imageInputField: 'image_url',
    imageInputIsArray: false,
    outputFormats: { jpeg: 'jpeg', png: 'png' },
  },
  'qwen2/image-edit': {
    imageToImage: 'qwen2/image-edit',
    imageInputField: 'image_url',
    imageInputIsArray: false,
    outputFormats: { jpeg: 'jpeg', png: 'png' },
  },
  qwen3: {
    textToImage: 'qwen3/text-to-image',
    imageToImage: 'qwen3/image-to-image',
    imageInputField: 'image_urls',
    imageInputIsArray: true,
    resolutions: ['1K', '2K'],
    outputFormats: { png: 'png', jpeg: 'jpeg' },
  },
  'qwen3/pro': {
    textToImage: 'qwen3/pro-text-to-image',
    imageToImage: 'qwen3/pro-image-to-image',
    imageInputField: 'image_urls',
    imageInputIsArray: true,
    resolutions: ['1K', '2K'],
    outputFormats: { png: 'png', jpeg: 'jpeg' },
  },
  'seedream/4.5': {
    textToImage: 'seedream/4.5-text-to-image',
    imageToImage: 'seedream/4.5-edit',
    imageInputField: 'image_urls',
    imageInputIsArray: true,
    aspectRatios: ['1:1', '4:3', '3:4', '16:9', '9:16', '2:3', '3:2', '21:9'],
  },
  'seedream/5-lite': {
    textToImage: 'seedream/5-lite-text-to-image',
    imageToImage: 'seedream/5-lite-image-to-image',
    imageInputField: 'image_urls',
    imageInputIsArray: true,
    aspectRatios: ['1:1', '4:3', '3:4', '16:9', '9:16', '2:3', '3:2', '21:9'],
    outputFormats: { png: 'png', jpeg: 'jpeg' },
  },
  'seedream/5-pro': {
    textToImage: 'seedream/5-pro-text-to-image',
    imageToImage: 'seedream/5-pro-image-to-image',
    imageInputField: 'image_urls',
    imageInputIsArray: true,
    aspectRatios: ['1:1', '4:3', '3:4', '16:9', '9:16', '2:3', '3:2', '21:9'],
    outputFormats: { png: 'png', jpeg: 'jpeg' },
  },
  'seedream/5-pro-layer-decomposition': {
    textToImage: 'seedream/5-pro-layer-decomposition',
    imageToImage: 'seedream/5-pro-layer-decomposition',
    imageInputField: 'image_url',
    imageInputIsArray: false,
    outputFormats: { png: 'png', jpeg: 'jpeg' },
  },
  'wan/2-7-image': {
    textToImage: 'wan/2-7-image',
    imageToImage: 'wan/2-7-image',
    imageInputField: 'input_urls',
    imageInputIsArray: true,
    aspectRatios: ['1:1', '16:9', '4:3', '21:9', '3:4', '9:16', '8:1', '1:8'],
    resolutions: ['1K', '2K', '4K'],
  },
  'wan/2-7-image-pro': {
    textToImage: 'wan/2-7-image-pro',
    imageToImage: 'wan/2-7-image-pro',
    imageInputField: 'input_urls',
    imageInputIsArray: true,
    aspectRatios: ['1:1', '16:9', '4:3', '21:9', '3:4', '9:16', '8:1', '1:8'],
    resolutions: ['1K', '2K', '4K'],
  },
  'z-image': {
    textToImage: 'z-image',
    aspectRatios: ['1:1', '4:3', '3:4', '16:9', '9:16'],
  },
} as const satisfies Record<string, KieModelShape>
```

## `src/cli/secretInput.ts`

46 Zeilen

```ts
/**
 * Reading a secret without echoing it.
 *
 * Two paths only: an interactive hidden prompt, or stdin for scripting
 * (the `docker login --password-stdin` pattern). There is deliberately no
 * flag that takes a key as an argument, because arguments land in shell
 * history and in the process list.
 */

export interface ReadSecretOptions {
  fromStdin: boolean
  prompt: string
}

/** Consumes all of stdin and returns it with surrounding whitespace removed. */
async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk))
  }
  // Stop reading, but leave the handle for the runtime to close: destroying it
  // here and then calling process.exit trips a libuv assertion on Windows.
  process.stdin.pause()
  return Buffer.concat(chunks).toString('utf-8').trim()
}

/**
 * Prompts on the TTY without echoing, so the key never appears on screen and
 * stdout stays clean for `--json`.
 */
async function promptHidden(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    // Without a TTY the echo cannot be suppressed; require --stdin instead of
    // silently reading the key in the clear.
    return ''
  }

  const { password } = await import('@inquirer/prompts')
  return password({ message: prompt.replace(/:\s*$/, ''), mask: true })
}

export async function readSecret(options: ReadSecretOptions): Promise<string> {
  const value = options.fromStdin ? await readAllStdin() : await promptHidden(options.prompt)
  return value.trim()
}
```

## `.github/workflows/kie-models.yml`

31 Zeilen

```yaml
name: Kie model table

# Deliberately not part of the main CI job: that would make every pull request
# depend on docs.kie.ai being reachable. Drift is something to learn about on a
# schedule, not something that should block an unrelated change.
on:
  schedule:
    # Weekly, Monday 06:00 UTC.
    - cron: '0 6 * * 1'
  workflow_dispatch:

jobs:
  check:
    runs-on: ubuntu-latest

    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 22.x
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Compare the committed model table against Kie's documentation
        run: npm run check:kie-models
```

## `src/types/config.ts`

23 Zeilen

```ts
/**
 * Resolved runtime configuration.
 *
 * This lives beside the other leaf types so that provider metadata and the
 * layered config loader can both refer to it without importing each other.
 */

import type { ImageProvider, ImageQuality } from './mcp.js'

export interface Config {
  imageProvider: ImageProvider
  geminiApiKey: string
  openaiApiKey: string
  arkApiKey: string
  kieApiKey: string
  higgsfieldApiKey: string
  /** Model configured per provider; a request may still override it. */
  imageModels: Partial<Record<ImageProvider, string>>
  imageOutputDir: string
  skipPromptEnhancement: boolean // Skip prompt enhancement for direct control
  imageQuality: ImageQuality
}
```

---

# B. Deine Logik, Fundamente neu schreiben

Die Logik gehört dir. Pro Datei steht darunter, welche Importe auf fremden Code zeigen und ersetzt werden müssen.

## `src/cli/main.ts`

98 Zeilen

**Neu zu schreiben:** mcp

```ts
/**
 * CLI subcommand router.
 *
 * The MCP server remains the default behaviour when the binary is started
 * without a subcommand, which is how MCP clients spawn it.
 */

import { getProviderCredential } from '../providers/credentials.js'
import { DEFAULT_KIE_MODEL } from '../providers/kie/models.js'
import { IMAGE_PROVIDER_VALUES } from '../types/mcp.js'
import { EXIT_CODE, type ExitCode, writeLine } from './output.js'

/** Derived from the provider list so a new provider cannot go undocumented. */
const PROVIDER_LIST = IMAGE_PROVIDER_VALUES.join(', ')
const PROVIDER_KEY_ROWS = IMAGE_PROVIDER_VALUES.map((provider) => {
  const { envVar, description } = getProviderCredential(provider)
  return `  ${envVar.padEnd(21)}Required for ${provider}; ${description.replace(/^your /, '')}`
}).join('\n')

const HELP = `
mcp-image - generate images from the command line or as an MCP server

Usage:
  mcp-image                                Start the MCP server on stdio
  mcp-image generate <prompt> [options]    Generate an image
  mcp-image mark <file...>                 Mark existing images as AI-generated
  mcp-image init                           Set up providers on this machine
  mcp-image doctor                         Check keys and reachability
  mcp-image models                         List the models each provider offers
  mcp-image config <action>                Manage the per-machine config file
  mcp-image skills install --path <path>   Install the Claude skill
  mcp-image --help                         Show this help

Run "mcp-image <command> --help" for command-specific options.

Configuration is read from three layers, highest priority first:
  1. environment variables   per invocation, and what CI sets
  2. .env in this directory  per project
  3. the config file         per machine, written by init and config set

Environment:
  IMAGE_PROVIDER       Default provider: ${PROVIDER_LIST}
${PROVIDER_KEY_ROWS}
  IMAGE_OUTPUT_DIR     Output directory (default: ./output)
  IMAGE_QUALITY        fast (default), balanced or quality
  <PROVIDER>_MODEL     Model for that provider, e.g. KIE_MODEL=${DEFAULT_KIE_MODEL}
`

/** Subcommands handled by the CLI rather than by the MCP server entry point. */
const CLI_COMMANDS = ['generate', 'mark', 'models', 'init', 'doctor', 'config'] as const

export function isCliCommand(arg: string | undefined): boolean {
  return typeof arg === 'string' && (CLI_COMMANDS as readonly string[]).includes(arg)
}

export function isHelpRequest(arg: string | undefined): boolean {
  return arg === '--help' || arg === '-h'
}

export async function runCli(argv: string[]): Promise<ExitCode> {
  const [command, ...rest] = argv

  if (isHelpRequest(command)) {
    writeLine(HELP.trim())
    return EXIT_CODE.ok
  }

  switch (command) {
    case 'generate': {
      const { runGenerate } = await import('./generate.js')
      return runGenerate(rest)
    }
    case 'mark': {
      const { runMark } = await import('./mark.js')
      return runMark(rest)
    }
    case 'models': {
      const { runModels } = await import('./models.js')
      return runModels(rest)
    }
    case 'init': {
      const { runInit } = await import('./init.js')
      return runInit(rest)
    }
    case 'doctor': {
      const { runDoctor } = await import('./doctor.js')
      return runDoctor(rest)
    }
    case 'config': {
      const { runConfig } = await import('./config.js')
      return runConfig(rest)
    }
  }

  writeLine(HELP.trim())
  return EXIT_CODE.validation
}
```

## `src/cli/output.ts`

97 Zeilen

**Neu zu schreiben:** errors

```ts
/**
 * CLI output contract.
 *
 * Human output is the default. With `--json`, stdout carries exactly one
 * JSON object and nothing else; diagnostics and logs stay on stderr so the
 * output stays machine-readable when piped.
 */

import { BaseError } from '../utils/errors.js'

/**
 * Process exit codes. Callers and CI can branch on these without parsing text.
 */
export const EXIT_CODE = {
  /** Completed successfully. */
  ok: 0,
  /** Usage or input validation rejected the request. */
  validation: 2,
  /** Configuration or credentials are missing or invalid. */
  config: 3,
  /** Generation, network or file I/O failed at runtime. */
  runtime: 4,
} as const

export type ExitCode = (typeof EXIT_CODE)[keyof typeof EXIT_CODE]

const UNKNOWN_ERROR_CODE = 'UNKNOWN_ERROR'

const EXIT_CODE_BY_ERROR_CODE: Record<string, ExitCode> = {
  INPUT_VALIDATION_ERROR: EXIT_CODE.validation,
  SECURITY_ERROR: EXIT_CODE.validation,
  CONFIG_ERROR: EXIT_CODE.config,
}

function errorCodeOf(error: Error): string {
  return error instanceof BaseError ? error.code : UNKNOWN_ERROR_CODE
}

function exitCodeOf(error: Error): ExitCode {
  return EXIT_CODE_BY_ERROR_CODE[errorCodeOf(error)] ?? EXIT_CODE.runtime
}

function hintOf(error: Error): string | undefined {
  return error instanceof BaseError ? error.suggestion : undefined
}

/**
 * The single JSON object written to stdout in `--json` mode when a command fails.
 */
interface JsonError {
  success: false
  errorCode: string
  error: string
  hint?: string
}

function toJsonError(error: Error): JsonError {
  const hint = hintOf(error)
  return {
    success: false,
    errorCode: errorCodeOf(error),
    error: error.message,
    ...(hint ? { hint } : {}),
  }
}

/** Writes the single stdout JSON object. */
export function writeJson(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`)
}

/** Writes a human-facing line to stdout. */
export function writeLine(line = ''): void {
  process.stdout.write(`${line}\n`)
}

/** Writes a diagnostic line to stderr, keeping stdout clean. */
export function writeDiagnostic(line: string): void {
  process.stderr.write(`${line}\n`)
}

/**
 * Renders a failure in the requested format and returns the process exit code.
 */
export function reportError(error: Error, json: boolean): ExitCode {
  if (json) {
    writeJson(toJsonError(error))
  } else {
    writeDiagnostic(`Error: ${error.message}`)
    const hint = hintOf(error)
    if (hint) {
      writeDiagnostic(`Hint: ${hint}`)
    }
  }
  return exitCodeOf(error)
}
```

## `src/cli/generate.ts`

188 Zeilen

**Neu zu schreiben:** config, errors, mcp, result

```ts
/**
 * `generate` subcommand: runs the core image pipeline from a shell.
 */

import { parseArgs } from 'node:util'
import { createImageGenerator } from '../core/imageGenerator.js'
import type {
  AspectRatio,
  GenerateImageParams,
  ImageProvider,
  ImageQuality,
  ImageSize,
} from '../types/mcp.js'
import { IMAGE_PROVIDER_VALUES } from '../types/mcp.js'
import { Ok } from '../types/result.js'
import { getConfig } from '../utils/config.js'
import { InputValidationError } from '../utils/errors.js'
import { EXIT_CODE, type ExitCode, reportError, writeJson, writeLine } from './output.js'

const HELP = `
Generate an image from a text prompt.

Usage:
  mcp-image generate <prompt> [options]

Options:
  --provider <name>          ${IMAGE_PROVIDER_VALUES.join(', ')} (default: IMAGE_PROVIDER)
  --file-name <name>         Output file name; .png/.jpg selects the format
  --input-image <path>       Source image to edit or transform
  --aspect-ratio <ratio>     e.g. 1:1, 16:9, 9:16
  --image-size <size>        1K, 2K or 4K
  --quality <preset>         fast, balanced or quality
  --purpose <text>           Intended use, guides prompt enhancement
  --output-dir <dir>         Directory to save into (default: IMAGE_OUTPUT_DIR)
  --blend-images             Blend multiple visual elements coherently
  --maintain-character       Keep character appearance consistent
  --use-world-knowledge      Use real-world knowledge for accurate context
  --use-google-search        Google Search grounding (Gemini only)
  --model <id>               Model for the chosen provider (see: mcp-image models)
  --no-enhance               Send the prompt through unchanged
  --eu-ai-act-marking        Write the machine-readable AI-generated marker
  --visible-label            Burn a visible "AI-generated" label into the image
  --json                     Emit one JSON object on stdout
  --help, -h                 Show this help

Exit codes:
  0 success   2 invalid input   3 configuration   4 generation or I/O failure

Examples:
  mcp-image generate "a red bicycle in the rain"
  mcp-image generate "a logo" --provider openai --file-name logo.png
  mcp-image generate "a banner" --aspect-ratio 16:9 --json
`

const OPTIONS = {
  provider: { type: 'string' },
  'file-name': { type: 'string' },
  'input-image': { type: 'string' },
  'aspect-ratio': { type: 'string' },
  'image-size': { type: 'string' },
  quality: { type: 'string' },
  purpose: { type: 'string' },
  'output-dir': { type: 'string' },
  'blend-images': { type: 'boolean' },
  'maintain-character': { type: 'boolean' },
  'use-world-knowledge': { type: 'boolean' },
  'use-google-search': { type: 'boolean' },
  model: { type: 'string' },
  'no-enhance': { type: 'boolean' },
  'eu-ai-act-marking': { type: 'boolean' },
  'visible-label': { type: 'boolean' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const

/**
 * Values that the shared validator checks are passed through as-is; the cast
 * keeps the CLI from duplicating the enum lists that inputValidator owns.
 */
function buildParams(
  values: Record<string, string | boolean | undefined>,
  prompt: string,
): GenerateImageParams {
  return {
    prompt,
    ...(values['provider'] && { provider: values['provider'] as ImageProvider }),
    ...(values['model'] && { model: values['model'] as string }),
    ...(values['file-name'] && { fileName: values['file-name'] as string }),
    ...(values['input-image'] && { inputImagePath: values['input-image'] as string }),
    ...(values['aspect-ratio'] && { aspectRatio: values['aspect-ratio'] as AspectRatio }),
    ...(values['image-size'] && { imageSize: values['image-size'] as ImageSize }),
    ...(values['quality'] && { quality: values['quality'] as ImageQuality }),
    ...(values['purpose'] && { purpose: values['purpose'] as string }),
    ...(values['blend-images'] === true && { blendImages: true }),
    ...(values['maintain-character'] === true && { maintainCharacterConsistency: true }),
    ...(values['use-world-knowledge'] === true && { useWorldKnowledge: true }),
    ...(values['use-google-search'] === true && { useGoogleSearch: true }),
    ...(values['eu-ai-act-marking'] === true && { euAiActMarking: true }),
    ...(values['visible-label'] === true && { visibleLabel: true }),
  }
}

export async function runGenerate(argv: string[]): Promise<ExitCode> {
  let values: Record<string, string | boolean | undefined>
  let positionals: string[]
  try {
    ;({ values, positionals } = parseArgs({
      args: argv,
      options: OPTIONS,
      allowPositionals: true,
    }))
  } catch (error) {
    // parseArgs rejects unknown flags and missing values.
    return reportError(
      new InputValidationError(
        (error as Error).message,
        'Run "mcp-image generate --help" for the supported options',
      ),
      argv.includes('--json'),
    )
  }

  const json = values['json'] === true

  if (values['help'] === true) {
    writeLine(HELP.trim())
    return EXIT_CODE.ok
  }

  const prompt = positionals.join(' ').trim()
  if (!prompt) {
    return reportError(
      new InputValidationError(
        'A prompt is required',
        'Provide the prompt as an argument: mcp-image generate "a red bicycle"',
      ),
      json,
    )
  }

  const outputDir = values['output-dir']
  if (typeof outputDir === 'string' && outputDir.trim().length === 0) {
    return reportError(
      new InputValidationError('--output-dir cannot be empty', 'Pass a directory path'),
      json,
    )
  }

  const generator = createImageGenerator({
    loadConfig: () => {
      const loaded = getConfig()
      if (!loaded.success) {
        return loaded
      }
      return Ok({
        ...loaded.data,
        ...(typeof outputDir === 'string' && { imageOutputDir: outputDir }),
        ...(values['no-enhance'] === true && { skipPromptEnhancement: true }),
      })
    },
  })

  const result = await generator.generate(buildParams(values, prompt))

  if (!result.success) {
    return reportError(result.error, json)
  }

  const { filePath, generation } = result.data
  if (json) {
    writeJson({
      success: true,
      filePath,
      provider: generation.metadata.provider ?? values['provider'] ?? null,
      model: generation.metadata.model,
      mimeType: generation.metadata.mimeType,
      ...(generation.metadata.revisedPrompt && {
        revisedPrompt: generation.metadata.revisedPrompt,
      }),
    })
  } else {
    writeLine(`Generated with ${generation.metadata.model}`)
    writeLine(filePath)
  }

  return EXIT_CODE.ok
}
```

## `src/cli/mark.ts`

117 Zeilen

**Neu zu schreiben:** errors

```ts
/**
 * `mark` subcommand: applies EU AI Act marking to images that already exist.
 *
 * Useful for files generated before marking was switched on, or produced by
 * another tool entirely.
 */

import { parseArgs } from 'node:util'
import { type MarkingResult, markImage } from '../core/imageMarker.js'
import { InputValidationError } from '../utils/errors.js'
import { EXIT_CODE, type ExitCode, reportError, writeJson, writeLine } from './output.js'

const HELP = `
Mark existing images as AI-generated.

Usage:
  mcp-image mark <file...> [options]

Options:
  --visible-label     Also burn a visible "AI-generated" label into the image
  --no-metadata       Skip the machine-readable marker (only with --visible-label)
  --json              Emit one JSON object on stdout
  --help, -h          Show this help

Files are modified in place. A file that already declares a digital source
type is left untouched, so a provider's own marking is never overwritten.

Examples:
  mcp-image mark ./output/image.png
  mcp-image mark ./output/*.png --visible-label
`

export async function runMark(argv: string[]): Promise<ExitCode> {
  let values: Record<string, boolean | undefined>
  let positionals: string[]
  try {
    ;({ values, positionals } = parseArgs({
      args: argv,
      options: {
        'visible-label': { type: 'boolean' },
        'no-metadata': { type: 'boolean' },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: true,
    }))
  } catch (error) {
    return reportError(
      new InputValidationError(
        (error as Error).message,
        'Run "mcp-image mark --help" for the supported options',
      ),
      argv.includes('--json'),
    )
  }

  const json = values['json'] === true

  if (values['help'] === true) {
    writeLine(HELP.trim())
    return EXIT_CODE.ok
  }

  if (positionals.length === 0) {
    return reportError(
      new InputValidationError(
        'At least one file is required',
        'Run: mcp-image mark ./output/image.png',
      ),
      json,
    )
  }

  const machineReadable = values['no-metadata'] !== true
  const visibleLabel = values['visible-label'] === true

  if (!machineReadable && !visibleLabel) {
    return reportError(
      new InputValidationError(
        '--no-metadata leaves nothing to write',
        'Combine it with --visible-label, or drop it to write the machine-readable marker',
      ),
      json,
    )
  }

  const marked: MarkingResult[] = []
  const failures: Array<{ filePath: string; error: string }> = []

  for (const filePath of positionals) {
    const result = await markImage(filePath, { machineReadable, visibleLabel })
    if (result.success) {
      marked.push(result.data)
    } else {
      failures.push({ filePath, error: result.error.message })
    }
  }

  if (json) {
    writeJson({ success: failures.length === 0, marked, failures })
  } else {
    for (const entry of marked) {
      const notes = [
        entry.alreadyMarked ? 'already marked, metadata left as is' : null,
        entry.machineReadableWritten ? 'metadata written' : null,
        entry.visibleLabelWritten ? 'visible label added' : null,
      ].filter(Boolean)
      writeLine(`${entry.filePath}: ${notes.join(', ')}`)
    }
    for (const failure of failures) {
      writeLine(`${failure.filePath}: ${failure.error}`)
    }
  }

  return failures.length === 0 ? EXIT_CODE.ok : EXIT_CODE.runtime
}
```

## `src/cli/models.ts`

131 Zeilen

**Neu zu schreiben:** config, errors, mcp

```ts
/**
 * `models` subcommand: shows which model each provider will use and which
 * ones it is known to offer.
 *
 * Necessary because the known ids are no longer a short list anyone can hold
 * in their head: Kie alone contributes over thirty.
 */

import { parseArgs } from 'node:util'
import { loadConfigLayers, resolveSetting } from '../config/layers.js'
import { getProviderModels, modelEnvVar } from '../providers/models.js'
import { IMAGE_PROVIDER_VALUES, type ImageProvider, type ImageQuality } from '../types/mcp.js'
import { getConfig } from '../utils/config.js'
import { InputValidationError } from '../utils/errors.js'
import { EXIT_CODE, type ExitCode, reportError, writeJson, writeLine } from './output.js'

const HELP = `
List the models each provider offers.

Usage:
  mcp-image models [options]

Options:
  --provider <name>   Show only this provider
  --json              Emit one JSON object on stdout
  --help, -h          Show this help

Every provider accepts an id outside its listed set; the id is sent to the
provider rather than rejected, because this project cannot keep an
authoritative catalogue of five vendors' offerings.

Select a model per request with --model, or configure one per provider:
  mcp-image config set <provider>-model <id>
`

interface ProviderModelReport {
  provider: ImageProvider
  /** The model a request would use right now. */
  active: string
  /** Where the active choice comes from. */
  source: string
  known: readonly string[]
  note?: string
}

export async function runModels(argv: string[]): Promise<ExitCode> {
  let values: Record<string, string | boolean | undefined>
  try {
    ;({ values } = parseArgs({
      args: argv,
      options: {
        provider: { type: 'string' },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: false,
    }))
  } catch (error) {
    return reportError(
      new InputValidationError(
        (error as Error).message,
        'Run "mcp-image models --help" for the supported options',
      ),
      argv.includes('--json'),
    )
  }

  const json = values['json'] === true
  if (values['help'] === true) {
    writeLine(HELP.trim())
    return EXIT_CODE.ok
  }

  const only = values['provider']
  if (typeof only === 'string' && !(IMAGE_PROVIDER_VALUES as readonly string[]).includes(only)) {
    return reportError(
      new InputValidationError(
        `Unknown provider: "${only}"`,
        `Valid providers: ${IMAGE_PROVIDER_VALUES.join(', ')}`,
      ),
      json,
    )
  }

  const layers = loadConfigLayers()
  const loaded = getConfig(layers)
  // Configuration may be unusable while still telling us the quality preset.
  const quality: ImageQuality = loaded.success ? loaded.data.imageQuality : 'fast'

  const providers = IMAGE_PROVIDER_VALUES.filter(
    (provider) => typeof only !== 'string' || provider === only,
  )

  const reports: ProviderModelReport[] = providers.map((provider) => {
    const catalogue = getProviderModels(provider)
    const configured = resolveSetting(
      layers,
      modelEnvVar(provider),
      layers.stored.models?.[provider],
    )
    return {
      provider,
      active: configured?.value ?? catalogue.defaultFor(quality),
      source: configured?.source ?? 'built-in default',
      known: catalogue.known,
      ...(catalogue.note ? { note: catalogue.note } : {}),
    }
  })

  if (json) {
    writeJson({ success: true, providers: reports })
    return EXIT_CODE.ok
  }

  for (const report of reports) {
    writeLine(`${report.provider}`)
    writeLine(`  active: ${report.active}  (${report.source})`)
    if (report.note) {
      writeLine(`  note:   ${report.note}`)
    }
    writeLine(`  known:  ${report.known.length}`)
    for (const id of report.known) {
      writeLine(`    ${id === report.active ? '*' : ' '} ${id}`)
    }
    writeLine()
  }

  writeLine('Any other id is passed through to the provider.')
  return EXIT_CODE.ok
}
```

## `src/cli/config.ts`

484 Zeilen

**Neu zu schreiben:** config, errors, mcp

```ts
/**
 * `config` subcommand: manages the per-machine config file.
 *
 * The CLI owns exactly one file. Environment variables and `.env` files are
 * read as higher-priority layers but never written, so this command can never
 * surprise a user by editing files they manage themselves.
 *
 * API keys are never accepted as command arguments — they would land in shell
 * history and the process list. They are read from a hidden prompt, or from
 * stdin with `--stdin` for scripted setup.
 */

import { parseArgs } from 'node:util'
import {
  configFilePath,
  readStoredConfig,
  type StoredConfig,
  writeStoredConfig,
} from '../config/file.js'
import {
  loadConfigLayers,
  maskSecret,
  resolveProviderKey,
  resolveSetting,
} from '../config/layers.js'
import { verifyProviderCredential } from '../config/verify.js'
import { getProviderCredential } from '../providers/credentials.js'
import { getProviderModels, modelEnvVar } from '../providers/models.js'
import type { ImageProvider } from '../types/mcp.js'
import { IMAGE_PROVIDER_VALUES, IMAGE_QUALITY_VALUES } from '../types/mcp.js'

/** Used only to show which model a provider would pick by default. */
const DEFAULT_QUALITY = 'fast' as const

import { createEmptyConfig, getConfig } from '../utils/config.js'
import { ConfigError, InputValidationError } from '../utils/errors.js'
import {
  EXIT_CODE,
  type ExitCode,
  reportError,
  writeDiagnostic,
  writeJson,
  writeLine,
} from './output.js'
import { readSecret } from './secretInput.js'

const HELP = `
Manage the per-machine config file.

Usage:
  mcp-image config set <provider>              Store an API key (hidden prompt)
  mcp-image config set <provider> --stdin      Read the key from stdin
  mcp-image config set default-provider <p>    Set the default provider
  mcp-image config set output-dir <dir>        Set the output directory
  mcp-image config set quality <preset>        Set the quality preset
  mcp-image config set <provider>-model <id>    Set a provider's model
  mcp-image config get <key>                   Show one resolved value
  mcp-image config list                        Show all values and their source
  mcp-image config unset <key>                 Remove a value from the file
  mcp-image config path                        Print the config file path

Keys: ${IMAGE_PROVIDER_VALUES.join(', ')}, default-provider, output-dir, quality
      ${IMAGE_PROVIDER_VALUES.map((p) => `${p}-model`).join(', ')}

Options:
  --stdin     Read the API key from stdin instead of prompting
  --json      Emit one JSON object on stdout
  --help, -h  Show this help

API keys are never taken as an argument, so they cannot leak into shell
history or the process list.

Examples:
  mcp-image config set gemini
  echo "$MY_KEY" | mcp-image config set openai --stdin
  mcp-image config list
`

/** Non-secret settings and how they map onto the stored config. */
const SETTINGS = {
  'default-provider': {
    envVar: 'IMAGE_PROVIDER',
    field: 'defaultProvider',
    allowed: IMAGE_PROVIDER_VALUES as readonly string[],
  },
  'output-dir': { envVar: 'IMAGE_OUTPUT_DIR', field: 'outputDir' },
  quality: {
    envVar: 'IMAGE_QUALITY',
    field: 'quality',
    allowed: IMAGE_QUALITY_VALUES as readonly string[],
  },
} as const satisfies Record<
  string,
  { envVar: string; field: keyof StoredConfig; allowed?: readonly string[] }
>

type SettingName = keyof typeof SETTINGS

/** `<provider>-model` keys live in the nested models map, not a flat field. */
function modelKey(provider: ImageProvider): string {
  return `${provider}-model`
}

function providerOfModelKey(name: string): ImageProvider | undefined {
  return IMAGE_PROVIDER_VALUES.find((provider) => modelKey(provider) === name)
}

function isProvider(name: string): name is ImageProvider {
  return (IMAGE_PROVIDER_VALUES as readonly string[]).includes(name)
}

function isSetting(name: string): name is SettingName {
  return name in SETTINGS
}

function unknownKeyError(name: string): InputValidationError {
  const keys = [
    ...IMAGE_PROVIDER_VALUES,
    ...Object.keys(SETTINGS),
    ...IMAGE_PROVIDER_VALUES.map(modelKey),
  ]
  return new InputValidationError(`Unknown config key: "${name}"`, `Valid keys: ${keys.join(', ')}`)
}

/** Model ids are not constrained: an id this project does not list may still exist. */
function setProviderModel(
  provider: ImageProvider,
  value: string | undefined,
  json: boolean,
): ExitCode {
  if (!value || value.trim().length === 0) {
    return reportError(
      new InputValidationError(
        `A model id is required for ${modelKey(provider)}`,
        `Run: mcp-image config set ${modelKey(provider)} <id>, or see: mcp-image models`,
      ),
      json,
    )
  }

  const stored = readStoredConfig()
  const filePath = writeStoredConfig({
    ...stored,
    models: { ...stored.models, [provider]: value },
  })

  if (json) {
    writeJson({ success: true, key: modelKey(provider), value, stored: filePath })
  } else {
    writeLine(`Set ${modelKey(provider)} = ${value} in ${filePath}`)
  }
  return EXIT_CODE.ok
}

async function setProviderKey(
  provider: ImageProvider,
  fromStdin: boolean,
  json: boolean,
): Promise<ExitCode> {
  const credential = getProviderCredential(provider)
  const key = await readSecret({
    fromStdin,
    prompt: `${credential.envVar} (${credential.description}): `,
  })

  if (!key) {
    return reportError(
      new InputValidationError(
        'No API key was provided',
        fromStdin
          ? `Pipe the key in: echo "$KEY" | mcp-image config set ${provider} --stdin`
          : 'Paste the key at the prompt',
      ),
      json,
    )
  }

  const stored = readStoredConfig()
  const updated: StoredConfig = { ...stored, apiKeys: { ...stored.apiKeys, [provider]: key } }

  // Verify against the live API before persisting, so a typo is caught here
  // rather than on the first generation.
  const probeConfig = { ...getConfigForProbe(provider, key) }
  const verification = await verifyProviderCredential(probeConfig, provider)

  if (verification.status === 'rejected') {
    return reportError(
      new ConfigError(
        `${credential.envVar} was rejected by the provider`,
        verification.detail ?? 'Check that you pasted the whole key',
      ),
      json,
    )
  }

  const filePath = writeStoredConfig(updated)

  if (json) {
    writeJson({ success: true, key: provider, stored: filePath, verified: verification.status })
    return EXIT_CODE.ok
  }

  writeLine(`Stored ${credential.envVar} in ${filePath}`)
  if (verification.status !== 'ok') {
    writeDiagnostic(
      `Warning: could not confirm the key with a live request (${verification.status}). ${verification.detail ?? ''}`.trim(),
    )
  }
  return EXIT_CODE.ok
}

/**
 * Builds a Config carrying only the key under test, so verification does not
 * silently pass because a different layer supplies a working key.
 */
function getConfigForProbe(provider: ImageProvider, key: string) {
  const base = getConfig()
  const credential = getProviderCredential(provider)
  const config = base.success ? base.data : createEmptyConfig(provider)
  return { ...config, [credential.configField]: key }
}

function setSetting(name: SettingName, value: string | undefined, json: boolean): ExitCode {
  const setting = SETTINGS[name]

  if (!value || value.trim().length === 0) {
    return reportError(
      new InputValidationError(
        `A value is required for ${name}`,
        `Run: mcp-image config set ${name} <value>`,
      ),
      json,
    )
  }

  const allowed = 'allowed' in setting ? setting.allowed : undefined
  if (allowed && !allowed.includes(value)) {
    return reportError(
      new InputValidationError(
        `Invalid value for ${name}: "${value}"`,
        `Valid values: ${allowed.join(', ')}`,
      ),
      json,
    )
  }

  const stored = readStoredConfig()
  const filePath = writeStoredConfig({ ...stored, [setting.field]: value })

  if (json) {
    writeJson({ success: true, key: name, value, stored: filePath })
  } else {
    writeLine(`Set ${name} = ${value} in ${filePath}`)
  }
  return EXIT_CODE.ok
}

interface ResolvedEntry {
  key: string
  value: string | null
  masked: boolean
  source: string | null
  shadowed: string[]
}

function describeEntries(): ResolvedEntry[] {
  const layers = loadConfigLayers()
  const entries: ResolvedEntry[] = []

  for (const provider of IMAGE_PROVIDER_VALUES) {
    const resolved = resolveProviderKey(layers, provider)
    entries.push({
      key: provider,
      value: resolved ? maskSecret(resolved.value) : null,
      masked: true,
      source: resolved?.source ?? null,
      shadowed: resolved?.shadowed ?? [],
    })
  }

  for (const provider of IMAGE_PROVIDER_VALUES) {
    const resolved = resolveSetting(layers, modelEnvVar(provider), layers.stored.models?.[provider])
    entries.push({
      key: modelKey(provider),
      value: resolved?.value ?? getProviderModels(provider).defaultFor(DEFAULT_QUALITY),
      masked: false,
      source: resolved?.source ?? 'built-in default',
      shadowed: resolved?.shadowed ?? [],
    })
  }

  for (const [name, setting] of Object.entries(SETTINGS)) {
    const storedValue = layers.stored[setting.field]
    const resolved = resolveSetting(
      layers,
      setting.envVar,
      typeof storedValue === 'string' ? storedValue : undefined,
    )
    entries.push({
      key: name,
      value: resolved?.value ?? null,
      masked: false,
      source: resolved?.source ?? null,
      shadowed: resolved?.shadowed ?? [],
    })
  }

  return entries
}

function renderEntry(entry: ResolvedEntry): void {
  if (entry.value === null) {
    writeLine(`${entry.key.padEnd(18)} (not set)`)
    return
  }
  const shadow = entry.shadowed.length > 0 ? `  [shadows: ${entry.shadowed.join(', ')}]` : ''
  writeLine(`${entry.key.padEnd(18)} ${entry.value}  (${entry.source})${shadow}`)
}

function listConfig(json: boolean): ExitCode {
  const entries = describeEntries()
  if (json) {
    writeJson({ success: true, configFile: configFilePath(), entries })
    return EXIT_CODE.ok
  }

  writeLine(`Config file: ${configFilePath()}`)
  writeLine()
  for (const entry of entries) {
    renderEntry(entry)
  }

  const shadowed = entries.filter((entry) => entry.shadowed.length > 0)
  if (shadowed.length > 0) {
    writeLine()
    for (const entry of shadowed) {
      const plural = entry.shadowed.length > 1
      writeDiagnostic(
        `Note: ${entry.key} comes from ${entry.source}; ${entry.shadowed.join(' and ')} ${plural ? 'also define it and are' : 'also defines it and is'} ignored.`,
      )
    }
  }
  return EXIT_CODE.ok
}

function getConfigValue(name: string | undefined, json: boolean): ExitCode {
  if (!name) {
    return reportError(
      new InputValidationError('A config key is required', 'Run: mcp-image config get <key>'),
      json,
    )
  }
  if (!isProvider(name) && !isSetting(name) && !providerOfModelKey(name)) {
    return reportError(unknownKeyError(name), json)
  }

  const entry = describeEntries().find((candidate) => candidate.key === name)
  if (!entry) {
    return reportError(unknownKeyError(name), json)
  }

  if (json) {
    writeJson({ success: true, ...entry })
  } else {
    renderEntry(entry)
  }
  return EXIT_CODE.ok
}

function unsetConfigValue(name: string | undefined, json: boolean): ExitCode {
  if (!name) {
    return reportError(
      new InputValidationError('A config key is required', 'Run: mcp-image config unset <key>'),
      json,
    )
  }

  const stored = readStoredConfig()
  let updated: StoredConfig

  if (isProvider(name)) {
    const { [name]: _removed, ...remaining } = stored.apiKeys ?? {}
    updated = { ...stored, apiKeys: remaining }
  } else if (isSetting(name)) {
    const { [SETTINGS[name].field]: _removed, ...remaining } = stored
    updated = remaining
  } else if (providerOfModelKey(name)) {
    const provider = providerOfModelKey(name) as ImageProvider
    const { [provider]: _removed, ...remaining } = stored.models ?? {}
    updated = { ...stored, models: remaining }
  } else {
    return reportError(unknownKeyError(name), json)
  }

  const filePath = writeStoredConfig(updated)
  if (json) {
    writeJson({ success: true, key: name, stored: filePath })
  } else {
    writeLine(`Removed ${name} from ${filePath}`)
    writeDiagnostic('Environment variables and .env files are not touched by this command.')
  }
  return EXIT_CODE.ok
}

export async function runConfig(argv: string[]): Promise<ExitCode> {
  let values: Record<string, boolean | undefined>
  let positionals: string[]
  try {
    ;({ values, positionals } = parseArgs({
      args: argv,
      options: {
        stdin: { type: 'boolean' },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: true,
    }))
  } catch (error) {
    return reportError(
      new InputValidationError(
        (error as Error).message,
        'Run "mcp-image config --help" for the supported options',
      ),
      argv.includes('--json'),
    )
  }

  const json = values['json'] === true
  const [action, name, value] = positionals

  if (values['help'] === true || !action) {
    writeLine(HELP.trim())
    return values['help'] === true ? EXIT_CODE.ok : EXIT_CODE.validation
  }

  switch (action) {
    case 'path':
      if (json) {
        writeJson({ success: true, configFile: configFilePath() })
      } else {
        writeLine(configFilePath())
      }
      return EXIT_CODE.ok

    case 'list':
      return listConfig(json)

    case 'get':
      return getConfigValue(name, json)

    case 'unset':
      return unsetConfigValue(name, json)

    case 'set': {
      if (!name) {
        return reportError(
          new InputValidationError('A config key is required', 'Run: mcp-image config set <key>'),
          json,
        )
      }
      if (isProvider(name)) {
        return setProviderKey(name, values['stdin'] === true, json)
      }
      if (isSetting(name)) {
        return setSetting(name, value, json)
      }
      const modelProvider = providerOfModelKey(name)
      if (modelProvider) {
        return setProviderModel(modelProvider, value, json)
      }
      return reportError(unknownKeyError(name), json)
    }

    default:
      return reportError(
        new InputValidationError(
          `Unknown config action: "${action}"`,
          'Valid actions: set, get, list, unset, path',
        ),
        json,
      )
  }
}
```

## `src/cli/doctor.ts`

156 Zeilen

**Neu zu schreiben:** config, errors, mcp

```ts
/**
 * `doctor` subcommand: reports, per provider, where the key comes from and
 * whether it actually works, with a command the user can run to fix it.
 */

import { parseArgs } from 'node:util'
import { configFilePath } from '../config/file.js'
import { loadConfigLayers, maskSecret, resolveProviderKey } from '../config/layers.js'
import { type VerificationStatus, verifyProviderCredential } from '../config/verify.js'
import { getProviderCredential } from '../providers/credentials.js'
import { IMAGE_PROVIDER_VALUES, type ImageProvider } from '../types/mcp.js'
import { getConfig } from '../utils/config.js'
import { InputValidationError } from '../utils/errors.js'
import { EXIT_CODE, type ExitCode, reportError, writeJson, writeLine } from './output.js'

const HELP = `
Check that each provider is configured and reachable.

Usage:
  mcp-image doctor [options]

Options:
  --offline   Skip the live requests and only report key sources
  --json      Emit one JSON object on stdout
  --help, -h  Show this help
`

const STATUS_LABEL: Record<VerificationStatus, string> = {
  ok: 'ok',
  rejected: 'key rejected',
  unreachable: 'unreachable',
  missing: 'not configured',
  unverifiable: 'set, not probeable',
}

interface ProviderReport {
  provider: ImageProvider
  envVar: string
  configured: boolean
  key: string | null
  source: string | null
  shadowed: string[]
  status: VerificationStatus | 'unchecked'
  detail?: string
  hint?: string
}

export async function runDoctor(argv: string[]): Promise<ExitCode> {
  let values: Record<string, boolean | undefined>
  try {
    ;({ values } = parseArgs({
      args: argv,
      options: {
        offline: { type: 'boolean' },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: false,
    }))
  } catch (error) {
    return reportError(
      new InputValidationError(
        (error as Error).message,
        'Run "mcp-image doctor --help" for the supported options',
      ),
      argv.includes('--json'),
    )
  }

  const json = values['json'] === true
  if (values['help'] === true) {
    writeLine(HELP.trim())
    return EXIT_CODE.ok
  }

  const layers = loadConfigLayers()
  const loaded = getConfig(layers)
  const reports: ProviderReport[] = []

  for (const provider of IMAGE_PROVIDER_VALUES) {
    const credential = getProviderCredential(provider)
    const resolved = resolveProviderKey(layers, provider)

    const report: ProviderReport = {
      provider,
      envVar: credential.envVar,
      configured: Boolean(resolved),
      key: resolved ? maskSecret(resolved.value) : null,
      source: resolved?.source ?? null,
      shadowed: resolved?.shadowed ?? [],
      status: 'unchecked',
    }

    if (!resolved) {
      report.status = 'missing'
      report.hint = `Run: mcp-image config set ${provider}`
    } else if (!values['offline'] && loaded.success) {
      const verification = await verifyProviderCredential(loaded.data, provider)
      report.status = verification.status
      if (verification.detail) {
        report.detail = verification.detail
      }
      if (verification.status === 'rejected') {
        report.hint = `Replace the key: mcp-image config set ${provider}`
      } else if (verification.status === 'unreachable') {
        report.hint = 'Check network access and the provider status page'
      }
    }

    reports.push(report)
  }

  const usable = reports.filter(
    (report) =>
      report.status === 'ok' || report.status === 'unchecked' || report.status === 'unverifiable',
  )

  if (json) {
    writeJson({
      success: usable.length > 0,
      configFile: configFilePath(),
      dotenv: layers.dotenvPath,
      defaultProvider: loaded.success ? loaded.data.imageProvider : null,
      providers: reports,
    })
    return usable.length > 0 ? EXIT_CODE.ok : EXIT_CODE.config
  }

  writeLine(`Config file: ${configFilePath()}`)
  writeLine(`Default provider: ${loaded.success ? loaded.data.imageProvider : '(unresolved)'}`)
  writeLine()

  for (const report of reports) {
    const status = report.status === 'unchecked' ? 'configured' : STATUS_LABEL[report.status]
    const origin = report.source ? ` from ${report.source}` : ''
    writeLine(`${report.provider.padEnd(10)} ${status.padEnd(16)} ${report.key ?? '-'}${origin}`)
    if (report.shadowed.length > 0) {
      writeLine(`${' '.repeat(10)} also set in ${report.shadowed.join(', ')}, ignored`)
    }
    if (report.detail) {
      writeLine(`${' '.repeat(10)} ${report.detail}`)
    }
    if (report.hint) {
      writeLine(`${' '.repeat(10)} ${report.hint}`)
    }
  }

  if (usable.length === 0) {
    writeLine()
    writeLine('No provider is usable. Run: mcp-image init')
    return EXIT_CODE.config
  }

  return EXIT_CODE.ok
}
```

## `src/cli/init.ts`

146 Zeilen

**Neu zu schreiben:** config, errors, mcp

```ts
/**
 * `init` subcommand: a one-time, per-machine setup wizard.
 *
 * Everything it does is also reachable through `config set`; this is the
 * guided path for a first run.
 */

import { parseArgs } from 'node:util'
import { readStoredConfig, type StoredConfig, writeStoredConfig } from '../config/file.js'
import { loadConfigLayers, resolveProviderKey } from '../config/layers.js'
import { verifyProviderCredential } from '../config/verify.js'
import { getProviderCredential } from '../providers/credentials.js'
import { IMAGE_PROVIDER_VALUES, type ImageProvider } from '../types/mcp.js'
import { createEmptyConfig } from '../utils/config.js'
import { InputValidationError } from '../utils/errors.js'
import { EXIT_CODE, type ExitCode, reportError, writeDiagnostic, writeLine } from './output.js'

const HELP = `
Set up providers and defaults on this machine.

Usage:
  mcp-image init

The wizard asks which providers you want, reads each key from a hidden
prompt, verifies it with one small live request, and stores the result in
the per-machine config file with owner-only permissions.

Options:
  --help, -h  Show this help
`

export async function runInit(argv: string[]): Promise<ExitCode> {
  let values: Record<string, boolean | undefined>
  try {
    ;({ values } = parseArgs({
      args: argv,
      options: { help: { type: 'boolean', short: 'h' } },
      allowPositionals: false,
    }))
  } catch (error) {
    return reportError(
      new InputValidationError(
        (error as Error).message,
        'Run "mcp-image init --help" for the supported options',
      ),
      false,
    )
  }

  if (values['help'] === true) {
    writeLine(HELP.trim())
    return EXIT_CODE.ok
  }

  if (!process.stdin.isTTY) {
    return reportError(
      new InputValidationError(
        'init needs an interactive terminal',
        'For scripted setup use: echo "$KEY" | mcp-image config set <provider> --stdin',
      ),
      false,
    )
  }

  const { checkbox, password, select } = await import('@inquirer/prompts')
  const layers = loadConfigLayers()

  const selected = (await checkbox({
    message: 'Which providers do you want to configure?',
    choices: IMAGE_PROVIDER_VALUES.map((provider) => {
      const existing = resolveProviderKey(layers, provider)
      return {
        name: existing ? `${provider} (already set from ${existing.source})` : provider,
        value: provider,
        checked: Boolean(existing),
      }
    }),
  })) as ImageProvider[]

  if (selected.length === 0) {
    writeDiagnostic('No providers selected; nothing was written.')
    return EXIT_CODE.ok
  }

  const stored: StoredConfig = readStoredConfig()
  const apiKeys = { ...stored.apiKeys }
  const verified: ImageProvider[] = []

  for (const provider of selected) {
    const credential = getProviderCredential(provider)
    const key = (
      await password({
        message: `${credential.envVar} (${credential.description})`,
        mask: true,
      })
    ).trim()

    if (!key) {
      writeDiagnostic(`Skipped ${provider}: no key entered.`)
      continue
    }

    const verification = await verifyProviderCredential(
      { ...createEmptyConfig(provider), [credential.configField]: key },
      provider,
    )

    if (verification.status === 'rejected') {
      writeDiagnostic(`${provider}: the provider rejected this key, not saving it.`)
      if (verification.detail) {
        writeDiagnostic(`  ${verification.detail}`)
      }
      continue
    }
    if (verification.status !== 'ok') {
      writeDiagnostic(
        `${provider}: could not confirm the key (${verification.status}); saving it anyway.`,
      )
    }

    apiKeys[provider] = key
    verified.push(provider)
  }

  if (verified.length === 0) {
    writeDiagnostic('No keys were stored.')
    return EXIT_CODE.config
  }

  const defaultProvider = (await select({
    message: 'Which provider should be the default?',
    choices: verified.map((provider) => ({ name: provider, value: provider })),
    default: stored.defaultProvider ?? verified[0],
  })) as ImageProvider

  const filePath = writeStoredConfig({ ...stored, apiKeys, defaultProvider })

  writeLine()
  writeLine(`Configured: ${verified.join(', ')}`)
  writeLine(`Default provider: ${defaultProvider}`)
  writeLine(filePath)
  writeDiagnostic('Run "mcp-image doctor" to re-check at any time.')

  return EXIT_CODE.ok
}
```

## `src/config/layers.ts`

115 Zeilen

**Neu zu schreiben:** mcp

```ts
/**
 * Layered configuration resolution with provenance.
 *
 * Three layers with three different lifetimes:
 * - process environment: per invocation, and what CI sets
 * - `.env` in the working directory: per project
 * - the config file written by `init` / `config set`: per machine
 *
 * Earlier layers win. Every lookup reports which layer answered so that
 * `config list` and `doctor` can warn when a value is shadowed.
 */

import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { parseEnv } from 'node:util'
import { getProviderCredential } from '../providers/credentials.js'
import type { ImageProvider } from '../types/mcp.js'
import { readStoredConfig, type StoredConfig } from './file.js'

const CONFIG_SOURCES = ['env', '.env', 'config file'] as const
type ConfigSource = (typeof CONFIG_SOURCES)[number]

export interface ResolvedValue {
  value: string
  source: ConfigSource
  /** Lower-priority layers that also define this value and were overridden. */
  shadowed: ConfigSource[]
}

export interface ConfigLayers {
  env: Record<string, string>
  dotenv: Record<string, string>
  stored: StoredConfig
  dotenvPath: string
}

function readDotenv(dotenvPath: string): Record<string, string> {
  try {
    return parseEnv(readFileSync(dotenvPath, 'utf-8')) as Record<string, string>
  } catch {
    // A missing or unreadable .env is not an error; the layer is simply absent.
    return {}
  }
}

function usable(value: string | undefined): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value !== 'undefined' &&
    value !== 'null'
  )
}

/**
 * Reads all three layers once. Callers resolve repeatedly against the result
 * so a single command never re-reads the filesystem per lookup.
 */
export function loadConfigLayers(cwd: string = process.cwd()): ConfigLayers {
  const dotenvPath = path.join(cwd, '.env')
  return {
    env: process.env as Record<string, string>,
    dotenv: readDotenv(dotenvPath),
    stored: readStoredConfig(),
    dotenvPath,
  }
}

/**
 * Resolves a plain environment-backed setting. `storedValue` is the config
 * file's contribution, which the caller reads from its typed field.
 */
export function resolveSetting(
  layers: ConfigLayers,
  envVar: string,
  storedValue: string | undefined,
): ResolvedValue | undefined {
  const candidates: Array<[ConfigSource, string | undefined]> = [
    ['env', layers.env[envVar]],
    ['.env', layers.dotenv[envVar]],
    ['config file', storedValue],
  ]

  const present = candidates.filter((entry): entry is [ConfigSource, string] => usable(entry[1]))
  const winner = present[0]
  if (!winner) {
    return undefined
  }

  return {
    value: winner[1],
    source: winner[0],
    shadowed: present.slice(1).map(([source]) => source),
  }
}

/** Resolves a provider's API key across all three layers. */
export function resolveProviderKey(
  layers: ConfigLayers,
  provider: ImageProvider,
): ResolvedValue | undefined {
  const { envVar } = getProviderCredential(provider)
  return resolveSetting(layers, envVar, layers.stored.apiKeys?.[provider])
}

/**
 * Masks a secret for display: enough to recognise, not enough to use.
 */
export function maskSecret(value: string): string {
  if (value.length <= 8) {
    return '*'.repeat(value.length)
  }
  return `${value.slice(0, 4)}…${value.slice(-2)}`
}
```

## `src/config/file.ts`

85 Zeilen

**Neu zu schreiben:** mcp

```ts
/**
 * The per-machine config file written by `init` and `config set`.
 *
 * This is the only file the CLI writes. Environment variables and `.env`
 * files belong to the user and are read but never modified.
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ImageProvider, ImageQuality } from '../types/mcp.js'

/** Directory name under the platform config root. */
const APP_DIR_NAME = 'mcp-image'

/** Owner read/write only; the file holds API keys. */
const SECRET_FILE_MODE = 0o600

export interface StoredConfig {
  defaultProvider?: ImageProvider
  outputDir?: string
  quality?: ImageQuality
  /** Model per provider, e.g. { kie: 'nano-banana-2' }. */
  models?: Partial<Record<ImageProvider, string>>
  apiKeys?: Partial<Record<ImageProvider, string>>
}

/**
 * Resolves the config directory: XDG when set, the Windows roaming profile on
 * win32, otherwise the XDG default.
 */
export function configDirPath(): string {
  const xdg = process.env['XDG_CONFIG_HOME']
  if (xdg && xdg.trim().length > 0) {
    return path.join(xdg, APP_DIR_NAME)
  }
  if (process.platform === 'win32') {
    const appData = process.env['APPDATA']
    if (appData && appData.trim().length > 0) {
      return path.join(appData, APP_DIR_NAME)
    }
  }
  return path.join(os.homedir(), '.config', APP_DIR_NAME)
}

export function configFilePath(): string {
  return path.join(configDirPath(), 'config.json')
}

/**
 * Reads the config file. A missing or malformed file resolves to an empty
 * config so that a broken file never blocks a run that has env credentials.
 */
export function readStoredConfig(): StoredConfig {
  try {
    const parsed: unknown = JSON.parse(readFileSync(configFilePath(), 'utf-8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {}
    }
    return parsed as StoredConfig
  } catch {
    return {}
  }
}

/**
 * Writes the config file with owner-only permissions, creating the directory
 * when needed.
 */
export function writeStoredConfig(config: StoredConfig): string {
  const filePath = configFilePath()
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
  writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: 'utf-8',
    mode: SECRET_FILE_MODE,
  })
  try {
    // writeFileSync only applies mode when creating; enforce it on rewrites too.
    chmodSync(filePath, SECRET_FILE_MODE)
  } catch {
    // Windows has no POSIX mode bits; the ACL of the user profile applies instead.
  }
  return filePath
}
```

## `src/config/verify.ts`

104 Zeilen

**Neu zu schreiben:** config, mcp

```ts
/**
 * Live credential verification.
 *
 * `validateConnection` on the text clients only asserts that the SDK object
 * exists, so it cannot tell a good key from a bad one. This issues a minimal
 * real request instead, which is the only way to learn whether a key works.
 */

import { getImageProviderDefinition } from '../providers/registry.js'
import type { ImageProvider } from '../types/mcp.js'
import type { Config } from '../utils/config.js'
import { validateProviderCredentials } from '../utils/config.js'

/** Smallest request that still exercises authentication. */
const PROBE_PROMPT = 'ping'
const PROBE_MAX_TOKENS = 1
const PROBE_TIMEOUT_MS = 15_000

/**
 * `unverifiable` covers providers that expose no text model: the key is
 * present and well-formed, but there is no cheap request to prove it works,
 * and spending an image generation to find out would not be reasonable.
 */
export type VerificationStatus = 'ok' | 'rejected' | 'unreachable' | 'missing' | 'unverifiable'

export interface VerificationResult {
  provider: ImageProvider
  status: VerificationStatus
  /** Present when the status is not `ok`. */
  detail?: string
}

/**
 * Not every provider surfaces an HTTP status, so an authentication failure is
 * recognised from the status code when present and from the upstream message
 * otherwise.
 */
const AUTH_FAILURE_PATTERN = new RegExp(
  [
    'api[- ]?key',
    'unauthorized',
    'forbidden',
    'permission denied',
    'invalid credential',
    'authentication',
  ].join('|'),
  'i',
)

function isAuthFailure(error: Error): boolean {
  const context = (error as { context?: Record<string, unknown> }).context
  const statusCode = context?.['statusCode']
  if (statusCode === 401 || statusCode === 403) {
    return true
  }

  const upstream = context?.['upstreamMessage']
  const haystack = `${error.message} ${typeof upstream === 'string' ? upstream : ''}`
  return AUTH_FAILURE_PATTERN.test(haystack)
}

/**
 * Issues one minimal request against the provider's text model.
 * @param config Configuration carrying the resolved API keys
 * @param provider The provider to probe
 */
export async function verifyProviderCredential(
  config: Config,
  provider: ImageProvider,
): Promise<VerificationResult> {
  const credentials = validateProviderCredentials(config, provider)
  if (!credentials.success) {
    return { provider, status: 'missing', detail: credentials.error.message }
  }

  try {
    const definition = getImageProviderDefinition(provider)
    if (!definition.createTextClient) {
      return {
        provider,
        status: 'unverifiable',
        detail: 'This provider exposes no text model to probe cheaply',
      }
    }

    const textClient = definition.createTextClient(config)
    const result = await textClient.generateText(PROBE_PROMPT, {
      maxTokens: PROBE_MAX_TOKENS,
      timeout: PROBE_TIMEOUT_MS,
    })

    if (result.success) {
      return { provider, status: 'ok' }
    }

    if (isAuthFailure(result.error)) {
      return { provider, status: 'rejected', detail: result.error.message }
    }
    return { provider, status: 'unreachable', detail: result.error.message }
  } catch (error) {
    return { provider, status: 'unreachable', detail: (error as Error).message }
  }
}
```

## `src/core/imageGenerator.ts`

268 Zeilen

**Neu zu schreiben:** config, fileManager, imageClient, inputValidator, logger, mcp, mimeUtils, result, security, structuredPromptGenerator

```ts
/**
 * Core image generation pipeline shared by every frontend.
 *
 * Validation, provider dispatch, prompt enhancement, generation and saving
 * live here so that the MCP server and the CLI stay thin adapters that only
 * translate input and format output.
 */

import * as path from 'node:path'
import { createFileManager, type FileManager } from '../business/fileManager.js'
import { validateGenerateImageParams } from '../business/inputValidator.js'
import type { FeatureFlags } from '../business/structuredPromptGenerator.js'
import { resolveModel } from '../providers/models.js'
import { getImageProviderDefinition } from '../providers/registry.js'
import type { GeneratedImageResult, ImageApiParams } from '../providers/shared/imageClient.js'
import type { GenerateImageParams } from '../types/mcp.js'
import type { Result } from '../types/result.js'
import { Err, Ok } from '../types/result.js'
import { type Config, getConfig, validateProviderCredentials } from '../utils/config.js'
import { Logger } from '../utils/logger.js'
import {
  getMimeTypeFromExtension,
  reconcileFileNameExtension,
  resolvePreferredOutputFormat,
  SUPPORTED_EXTENSIONS,
} from '../utils/mimeUtils.js'
import { SecurityManager } from '../utils/security.js'
import { markImage } from './imageMarker.js'
import { readInputImageWithinLimit } from './inputImage.js'
import { createProviderClientCache, type ProviderClientCache } from './providerClients.js'

/**
 * A generated image together with the path it was saved to.
 */
export interface GeneratedImage {
  generation: GeneratedImageResult
  filePath: string
}

export interface ImageGeneratorDependencies {
  fileManager: FileManager
  securityManager: SecurityManager
  clients: ProviderClientCache
  logger: Logger
  /** Overrides configuration loading; defaults to reading the environment. */
  loadConfig: () => Result<Config, Error>
}

export interface ImageGenerator {
  generate(params: GenerateImageParams): Promise<Result<GeneratedImage, Error>>
}

/**
 * Creates the image generator with its default collaborators.
 * @param overrides Dependencies to substitute, primarily for tests
 */
export function createImageGenerator(
  overrides: Partial<ImageGeneratorDependencies> = {},
): ImageGenerator {
  const logger = overrides.logger ?? new Logger()
  const deps: ImageGeneratorDependencies = {
    logger,
    fileManager: overrides.fileManager ?? createFileManager(),
    securityManager: overrides.securityManager ?? new SecurityManager(),
    clients: overrides.clients ?? createProviderClientCache(logger),
    loadConfig: overrides.loadConfig ?? getConfig,
  }

  return {
    async generate(params) {
      try {
        return Ok(await runPipeline(params, deps))
      } catch (error) {
        const finalError = error instanceof Error ? error : new Error('Unknown error')
        deps.logger.error('image-generation', 'Operation failed', finalError)
        return Err(finalError)
      }
    },
  }
}

async function runPipeline(
  params: GenerateImageParams,
  deps: ImageGeneratorDependencies,
): Promise<GeneratedImage> {
  const { fileManager, securityManager, clients, logger } = deps

  // Validate input
  const validationResult = validateGenerateImageParams(params)
  if (!validationResult.success) {
    throw validationResult.error
  }

  const sanitizedFileName = params.fileName
    ? securityManager.sanitizeFilename(params.fileName)
    : undefined
  const preferredOutputFormat = resolvePreferredOutputFormat(sanitizedFileName)

  // Get configuration
  const configResult = deps.loadConfig()
  if (!configResult.success) {
    throw configResult.error
  }
  const config = configResult.data

  // Resolve the provider for this request, falling back to the server default.
  const providerName = params.provider ?? config.imageProvider
  const credentialsResult = validateProviderCredentials(config, providerName)
  if (!credentialsResult.success) {
    throw credentialsResult.error
  }
  const provider = getImageProviderDefinition(providerName)

  // Initialize clients
  const { imageClient, structuredPromptGenerator } = clients.get(config, providerName, provider)

  // Handle input image if provided
  let inputImageData: string | undefined
  let inputImageMimeType: string | undefined
  if (params.inputImagePath) {
    const sanitizedInputPath = securityManager.sanitizeInputFilePath(params.inputImagePath)
    if (!sanitizedInputPath.success) {
      throw sanitizedInputPath.error
    }
    const extensionCheck = securityManager.validateImageFile(sanitizedInputPath.data)
    if (!extensionCheck.success) {
      throw extensionCheck.error
    }
    const imageBuffer = await readInputImageWithinLimit(sanitizedInputPath.data)
    inputImageData = imageBuffer.toString('base64')
    inputImageMimeType = getMimeTypeFromExtension(path.extname(sanitizedInputPath.data))
  }

  const model = resolveModel(
    providerName,
    params.model,
    config.imageModels[providerName],
    params.quality ?? config.imageQuality,
  )

  const imageOptions = {
    model,
    ...(inputImageData && { inputImage: inputImageData }),
    ...(inputImageMimeType && { inputImageMimeType }),
    ...(params.aspectRatio && { aspectRatio: params.aspectRatio }),
    ...(params.imageSize && { imageSize: params.imageSize }),
    ...(params.useGoogleSearch !== undefined && {
      useGoogleSearch: params.useGoogleSearch,
    }),
    ...(preferredOutputFormat && { preferredOutputFormat }),
    ...(params.quality !== undefined && { quality: params.quality }),
  } satisfies Omit<ImageApiParams, 'prompt'>

  provider.validateImageOptions?.(imageOptions, config)

  // Generate structured prompt (unless skipped)
  let structuredPrompt = params.prompt
  if (!config.skipPromptEnhancement && structuredPromptGenerator) {
    const features: FeatureFlags = {}
    if (params.maintainCharacterConsistency !== undefined) {
      features.maintainCharacterConsistency = params.maintainCharacterConsistency
    }
    if (params.blendImages !== undefined) {
      features.blendImages = params.blendImages
    }
    if (params.useWorldKnowledge !== undefined) {
      features.useWorldKnowledge = params.useWorldKnowledge
    }
    if (params.useGoogleSearch !== undefined) {
      features.useGoogleSearch = params.useGoogleSearch
    }

    const promptResult = await structuredPromptGenerator.generateStructuredPrompt(
      params.prompt,
      features,
      inputImageData,
      params.purpose,
      inputImageMimeType,
    )

    if (promptResult.success) {
      structuredPrompt = promptResult.data.structuredPrompt

      logger.info('image-generation', 'Structured prompt generated', {
        originalLength: params.prompt.length,
        structuredLength: structuredPrompt.length,
        selectedPractices: promptResult.data.selectedPractices,
      })
    } else {
      logger.warn('image-generation', 'Using original prompt', {
        error: promptResult.error.message,
      })
    }
  } else if (config.skipPromptEnhancement) {
    logger.info('image-generation', 'Prompt enhancement skipped (SKIP_PROMPT_ENHANCEMENT=true)')
  }

  // Generate image using selected provider.
  const generationResult = await imageClient.generateImage({
    prompt: structuredPrompt,
    ...imageOptions,
  })

  if (!generationResult.success) {
    throw generationResult.error
  }

  // Save image file
  const mimeType = generationResult.data.metadata.mimeType
  const rawFileName = sanitizedFileName ?? fileManager.generateFileName(mimeType)
  const fileName = params.fileName ? reconcileFileNameExtension(rawFileName, mimeType) : rawFileName
  const requestedExtension = path.extname(rawFileName)
  if (
    sanitizedFileName &&
    fileName !== rawFileName &&
    SUPPORTED_EXTENSIONS.includes(requestedExtension.toLowerCase())
  ) {
    logger.warn(
      'image-generation',
      'Output filename extension corrected to match generated MIME type',
      {
        requestedExtension,
        savedExtension: path.extname(fileName),
        mimeType,
      },
    )
  }
  const outputPath = path.join(config.imageOutputDir, fileName)

  const sanitizedPath = securityManager.sanitizeFilePath(outputPath)
  if (!sanitizedPath.success) {
    throw sanitizedPath.error
  }

  const saveResult = await fileManager.saveImage(
    generationResult.data.imageData,
    sanitizedPath.data,
  )
  if (!saveResult.success) {
    throw saveResult.error
  }

  // EU AI Act Article 50 marking, applied to the file that was just written.
  if (params.euAiActMarking || params.visibleLabel) {
    const marking = await markImage(
      saveResult.data,
      {
        machineReadable: params.euAiActMarking === true,
        visibleLabel: params.visibleLabel === true,
      },
      generationResult.data.metadata,
    )

    if (!marking.success) {
      // The image itself is saved and usable; failing to mark it must not
      // discard it, but the caller has to know the marking is missing.
      logger.warn('image-generation', 'Image saved but could not be marked', {
        error: marking.error.message,
        filePath: saveResult.data,
      })
    } else {
      logger.info('image-generation', 'Image marking applied', { ...marking.data })
    }
  }

  return { generation: generationResult.data, filePath: saveResult.data }
}
```

## `src/core/providerClients.ts`

79 Zeilen

**Neu zu schreiben:** config, imageClient, logger, mcp, structuredPromptGenerator

```ts
/**
 * Lazy, per-provider client cache shared by every frontend.
 *
 * Provider selection is a per-request concern, so clients are keyed by
 * provider: alternating between providers must never reuse another
 * provider's client, while repeat requests for the same provider still
 * reuse the one already built.
 */

import {
  createStructuredPromptGenerator,
  type StructuredPromptGenerator,
} from '../business/structuredPromptGenerator.js'
import type { ImageProviderDefinition } from '../providers/registry.js'
import type { ImageClient } from '../providers/shared/imageClient.js'
import type { ImageProvider } from '../types/mcp.js'
import type { Config } from '../utils/config.js'
import type { Logger } from '../utils/logger.js'

/**
 * Clients backing a single image provider.
 */
interface ProviderClients {
  imageClient: ImageClient
  structuredPromptGenerator: StructuredPromptGenerator | null
}

export interface ProviderClientCache {
  get(
    config: Config,
    providerName: ImageProvider,
    provider: ImageProviderDefinition,
  ): ProviderClients
}

/**
 * Creates a cache that builds each provider's clients on first use.
 */
export function createProviderClientCache(logger: Logger): ProviderClientCache {
  const byProvider = new Map<ImageProvider, ProviderClients>()

  return {
    get(config, providerName, provider) {
      const cached = byProvider.get(providerName)
      if (
        cached &&
        (config.skipPromptEnhancement ||
          !provider.createTextClient ||
          cached.structuredPromptGenerator)
      ) {
        return cached
      }

      // Initialize the structured prompt generator with its text client when
      // enhancement is enabled and the provider has a text model at all.
      const structuredPromptGenerator =
        config.skipPromptEnhancement || !provider.createTextClient
          ? null
          : createStructuredPromptGenerator(
              provider.createTextClient(config),
              provider.promptGeneration.maxTokens,
            )

      const clients: ProviderClients = {
        imageClient: cached?.imageClient ?? provider.createImageClient(config),
        structuredPromptGenerator,
      }
      byProvider.set(providerName, clients)

      logger.info('image-generator', 'Image provider clients initialized', {
        provider: providerName,
        promptEnhancement: !config.skipPromptEnhancement,
      })

      return clients
    },
  }
}
```

## `src/core/inputImage.ts`

63 Zeilen

**Neu zu schreiben:** errors, inputValidator

```ts
/**
 * Bounded reading of file-backed input images.
 *
 * The size limit is enforced before the file is turned into base64, so an
 * oversized file never reaches memory in its encoded form.
 */

import { constants as fsConstants } from 'node:fs'
import * as fs from 'node:fs/promises'
import { MAX_IMAGE_SIZE } from '../business/inputValidator.js'
import { InputValidationError } from '../utils/errors.js'

const INPUT_IMAGE_OPEN_FLAGS =
  fsConstants.O_RDONLY |
  (typeof fsConstants.O_NONBLOCK === 'number' ? fsConstants.O_NONBLOCK : 0) |
  (typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0)

function createInputImageSizeError(actualSize: number): InputValidationError {
  const sizeInMB = (actualSize / (1024 * 1024)).toFixed(1)
  const limitInMB = (MAX_IMAGE_SIZE / (1024 * 1024)).toFixed(1)
  return new InputValidationError(
    `Image size exceeds ${limitInMB}MB limit. Current size: ${sizeInMB}MB`,
    `Please compress your image or reduce its resolution to stay below ${limitInMB}MB`,
  )
}

export async function readInputImageWithinLimit(filePath: string): Promise<Buffer> {
  const fileHandle = await fs.open(filePath, INPUT_IMAGE_OPEN_FLAGS)

  try {
    const stats = await fileHandle.stat()
    if (!stats.isFile()) {
      throw new InputValidationError(
        'Input image must be a regular file',
        'Please provide a path to a regular PNG, JPEG, or WebP image file',
      )
    }
    if (stats.size > MAX_IMAGE_SIZE) {
      throw createInputImageSizeError(stats.size)
    }

    const boundedBuffer = Buffer.alloc(MAX_IMAGE_SIZE + 1)
    let observedBytes = 0

    while (observedBytes < boundedBuffer.length) {
      const readLength = Math.min(64 * 1024, boundedBuffer.length - observedBytes)
      const { bytesRead } = await fileHandle.read(boundedBuffer, observedBytes, readLength, null)
      if (bytesRead === 0) {
        break
      }

      observedBytes += bytesRead
      if (observedBytes > MAX_IMAGE_SIZE) {
        throw createInputImageSizeError(observedBytes)
      }
    }

    return boundedBuffer.subarray(0, observedBytes)
  } finally {
    await fileHandle.close()
  }
}
```

## `src/core/imageMarker.ts`

197 Zeilen

**Neu zu schreiben:** errors, imageClient, result

```ts
/**
 * EU AI Act Article 50 marking.
 *
 * Article 50 splits the duty in two, so the two markings are separate flags:
 * the provider must make synthetic content machine-readable, and the deployer
 * must disclose it to people who see it.
 *
 * Machine-readable marking is written as IPTC/XMP `DigitalSourceType`, the
 * interoperable marker that platforms actually read. A C2PA manifest is
 * deliberately not written here: a meaningful one requires a signing
 * certificate the caller does not have, and a test-signed manifest would look
 * like provenance without carrying any.
 *
 * Existing provider metadata is never discarded. When a provider already
 * declared a digital source type, this leaves the file's metadata alone.
 */

import { readFile, writeFile } from 'node:fs/promises'
import type { ImageGenerationMetadata } from '../providers/shared/imageClient.js'
import type { Result } from '../types/result.js'
import { Err, Ok } from '../types/result.js'
import { FileOperationError } from '../utils/errors.js'

/** IPTC controlled-vocabulary term for content generated by a trained model. */
export const TRAINED_ALGORITHMIC_MEDIA =
  'http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia'

const IPTC_EXT_NAMESPACE = 'http://iptc.org/std/Iptc4xmpExt/2008-02-29/'

/** Text placed on the image when a visible disclosure is requested. */
const VISIBLE_LABEL_TEXT = 'AI-generated'

export interface MarkingOptions {
  /** Write the machine-readable IPTC/XMP marker. */
  machineReadable: boolean
  /** Burn a visible disclosure into the image. */
  visibleLabel: boolean
}

export interface MarkingResult {
  filePath: string
  /** True when this call wrote the machine-readable marker. */
  machineReadableWritten: boolean
  /** True when the file already carried a digital source type. */
  alreadyMarked: boolean
  /** True when a visible label was composited onto the image. */
  visibleLabelWritten: boolean
}

/** Escapes text for inclusion in XML character data or an attribute value. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function buildProperties(metadata: ImageGenerationMetadata | undefined): string {
  const creatorTool = metadata
    ? escapeXml([metadata.provider, metadata.model].filter(Boolean).join(' '))
    : ''
  const lines = [
    `<Iptc4xmpExt:DigitalSourceType>${TRAINED_ALGORITHMIC_MEDIA}</Iptc4xmpExt:DigitalSourceType>`,
  ]
  if (creatorTool) {
    lines.push(`<xmp:CreatorTool>${creatorTool}</xmp:CreatorTool>`)
  }
  return lines.join('')
}

/** A complete XMP packet, used when the file carries no XMP at all. */
function buildXmpPacket(metadata: ImageGenerationMetadata | undefined): string {
  return [
    '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>',
    '<x:xmpmeta xmlns:x="adobe:ns:meta/">',
    '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
    '<rdf:Description rdf:about=""',
    ` xmlns:Iptc4xmpExt="${IPTC_EXT_NAMESPACE}"`,
    ' xmlns:xmp="http://ns.adobe.com/xap/1.0/">',
    buildProperties(metadata),
    '</rdf:Description>',
    '</rdf:RDF>',
    '</x:xmpmeta>',
    '<?xpacket end="w"?>',
  ].join('')
}

/**
 * Adds the marker to an existing packet rather than replacing it, so provider
 * metadata such as model identifiers survives.
 */
function injectIntoXmp(existing: string, metadata: ImageGenerationMetadata | undefined): string {
  const descriptionMatch = existing.match(/<rdf:Description\b[^>]*>/)
  if (!descriptionMatch || descriptionMatch.index === undefined) {
    // No element to extend; a fresh packet is the only option.
    return buildXmpPacket(metadata)
  }

  let openingTag = descriptionMatch[0]
  if (!openingTag.includes('xmlns:Iptc4xmpExt')) {
    openingTag = openingTag.replace(/>$/, ` xmlns:Iptc4xmpExt="${IPTC_EXT_NAMESPACE}">`)
  }
  if (!openingTag.includes('xmlns:xmp=')) {
    openingTag = openingTag.replace(/>$/, ' xmlns:xmp="http://ns.adobe.com/xap/1.0/">')
  }

  const insertAt = descriptionMatch.index + descriptionMatch[0].length
  return (
    existing.slice(0, descriptionMatch.index) +
    openingTag +
    buildProperties(metadata) +
    existing.slice(insertAt)
  )
}

/** True when a packet already declares any digital source type. */
export function hasDigitalSourceType(xmp: string | undefined): boolean {
  return typeof xmp === 'string' && /DigitalSourceType/i.test(xmp)
}

/** SVG banner composited into the bottom-right corner. */
function buildLabelSvg(width: number, height: number): Buffer {
  const scale = Math.max(1, Math.round(Math.min(width, height) / 400))
  const fontSize = 14 * scale
  const paddingX = 10 * scale
  const paddingY = 6 * scale
  const boxWidth = Math.round(fontSize * 0.62 * VISIBLE_LABEL_TEXT.length + paddingX * 2)
  const boxHeight = fontSize + paddingY * 2

  return Buffer.from(
    [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${boxWidth}" height="${boxHeight}">`,
      `<rect x="0" y="0" width="${boxWidth}" height="${boxHeight}" rx="${Math.round(boxHeight / 5)}" fill="rgba(0,0,0,0.62)"/>`,
      `<text x="${paddingX}" y="${paddingY + fontSize * 0.8}" font-family="sans-serif" font-size="${fontSize}" fill="#ffffff">${VISIBLE_LABEL_TEXT}</text>`,
      '</svg>',
    ].join(''),
  )
}

/**
 * Applies the requested markings to an image file in place.
 * @param filePath Image to mark
 * @param options Which markings to apply
 * @param metadata Generation metadata recorded alongside the marker
 */
export async function markImage(
  filePath: string,
  options: MarkingOptions,
  metadata?: ImageGenerationMetadata,
): Promise<Result<MarkingResult, FileOperationError>> {
  if (!options.machineReadable && !options.visibleLabel) {
    return Ok({
      filePath,
      machineReadableWritten: false,
      alreadyMarked: false,
      visibleLabelWritten: false,
    })
  }

  try {
    const sharpModule = await import('sharp')
    const sharp = sharpModule.default

    const original = await readFile(filePath)
    const existing = await sharp(original).metadata()
    const existingXmp = existing.xmp?.toString('utf-8')
    const alreadyMarked = hasDigitalSourceType(existingXmp)

    let pipeline = sharp(original).keepMetadata()

    if (options.visibleLabel) {
      const label = buildLabelSvg(existing.width ?? 1024, existing.height ?? 1024)
      pipeline = pipeline.composite([{ input: label, gravity: 'southeast' }])
    }

    const machineReadableWritten = options.machineReadable && !alreadyMarked
    if (machineReadableWritten) {
      pipeline = pipeline.withXmp(
        existingXmp ? injectIntoXmp(existingXmp, metadata) : buildXmpPacket(metadata),
      )
    }

    await writeFile(filePath, await pipeline.toBuffer())

    return Ok({
      filePath,
      machineReadableWritten,
      alreadyMarked,
      visibleLabelWritten: options.visibleLabel,
    })
  } catch (error) {
    // FileOperationError derives its suggestion from the message.
    return Err(new FileOperationError(`Failed to mark image: ${(error as Error).message}`))
  }
}
```

## `src/providers/credentials.ts`

56 Zeilen

**Neu zu schreiben:** mcp

```ts
/**
 * How each provider's credential is named and recognised.
 *
 * This is deliberately free of provider SDK imports so that credential
 * validation, `doctor` and `config` can be data-driven without pulling every
 * vendor SDK into the process.
 */

import type { Config } from '../types/config.js'
import type { ImageProvider } from '../types/mcp.js'

export interface ProviderCredential {
  /** Environment variable carrying the key. */
  readonly envVar: string
  /** Field on Config holding the resolved key. */
  readonly configField: Extract<keyof Config, `${string}ApiKey`>
  /** Shortest plausible key; omitted when the vendor defines no format. */
  readonly minLength?: number
  /** Used in setup hints, e.g. "your Google AI API key". */
  readonly description: string
}

const PROVIDER_CREDENTIALS = {
  gemini: {
    envVar: 'GEMINI_API_KEY',
    configField: 'geminiApiKey',
    minLength: 10,
    description: 'your Google AI API key',
  },
  openai: {
    envVar: 'OPENAI_API_KEY',
    configField: 'openaiApiKey',
    minLength: 10,
    description: 'your OpenAI API key',
  },
  seedream: {
    envVar: 'ARK_API_KEY',
    configField: 'arkApiKey',
    description: 'your BytePlus ModelArk API key',
  },
  kie: {
    envVar: 'KIE_API_KEY',
    configField: 'kieApiKey',
    description: 'your Kie AI API key',
  },
  higgsfield: {
    envVar: 'HIGGSFIELD_API_KEY',
    configField: 'higgsfieldApiKey',
    description: 'your Higgsfield key id and secret as keyId:keySecret',
  },
} as const satisfies Record<ImageProvider, ProviderCredential>

export function getProviderCredential(provider: ImageProvider): ProviderCredential {
  return PROVIDER_CREDENTIALS[provider]
}
```

## `src/providers/models.ts`

90 Zeilen

**Neu zu schreiben:** mcp

```ts
/**
 * Which model each provider uses, and which ones a caller may ask for.
 *
 * Model choice used to be either hidden (Gemini picked one from the quality
 * preset) or hard-wired (OpenAI, Seedream and Higgsfield had exactly one), and
 * only Kie exposed a choice through a provider-specific flag. This makes it
 * one provider-neutral concept instead.
 *
 * Every provider is open-ended: an id outside `known` is sent to the provider
 * rather than rejected, because this project cannot keep an authoritative
 * catalogue of five vendors' offerings. `known` is what the defaults and the
 * error hints are built from, not a gate.
 */

import { GEMINI_MODELS, type ImageProvider, type ImageQuality } from '../types/mcp.js'
import { DEFAULT_KIE_MODEL, VERIFIED_KIE_MODELS } from './kie/models.js'

/** The Seedream image model this project pins. */
export const SEEDREAM_IMAGE_MODEL = 'dola-seedream-5-0-pro-260628'

/** The OpenAI image model this project pins. */
export const OPENAI_IMAGE_MODEL = 'gpt-image-2'

/**
 * Higgsfield addresses models by URL path rather than by a body field, so the
 * model name is the path segment after `/higgsfield-ai/`.
 */
export const HIGGSFIELD_DEFAULT_MODEL = 'soul/standard'

export interface ProviderModelCatalogue {
  /** Ids known to work. Used for defaults and error hints, not as a gate. */
  readonly known: readonly string[]
  /** Chosen when neither the request nor the configuration names one. */
  defaultFor(quality: ImageQuality): string
  /** Explains what the ids mean, for `mcp-image models`. */
  readonly note?: string
}

export const PROVIDER_MODELS: Readonly<Record<ImageProvider, ProviderModelCatalogue>> = {
  gemini: {
    known: [GEMINI_MODELS.FLASH, GEMINI_MODELS.PRO],
    // Kept for compatibility: without an explicit model the quality preset
    // still decides, which is how this provider has always behaved.
    defaultFor: (quality) => (quality === 'quality' ? GEMINI_MODELS.PRO : GEMINI_MODELS.FLASH),
    note: 'Without --model the quality preset selects between these.',
  },
  openai: {
    known: [OPENAI_IMAGE_MODEL],
    defaultFor: () => OPENAI_IMAGE_MODEL,
  },
  seedream: {
    known: [SEEDREAM_IMAGE_MODEL],
    defaultFor: () => SEEDREAM_IMAGE_MODEL,
    note: 'The quality preset still selects the prompt optimisation mode.',
  },
  kie: {
    known: VERIFIED_KIE_MODELS,
    defaultFor: () => DEFAULT_KIE_MODEL,
    note: 'Generated from Kie documentation; any marketplace id also works.',
  },
  higgsfield: {
    known: [HIGGSFIELD_DEFAULT_MODEL],
    defaultFor: () => HIGGSFIELD_DEFAULT_MODEL,
    note: 'The path segment after /higgsfield-ai/.',
  },
}

export function getProviderModels(provider: ImageProvider): ProviderModelCatalogue {
  return PROVIDER_MODELS[provider]
}

/** The environment variable naming a provider's model, e.g. GEMINI_MODEL. */
export function modelEnvVar(provider: ImageProvider): string {
  return `${provider.toUpperCase()}_MODEL`
}

/**
 * Resolves the model for a request: what the caller asked for, else what is
 * configured for that provider, else the provider's own default.
 */
export function resolveModel(
  provider: ImageProvider,
  requested: string | undefined,
  configured: string | undefined,
  quality: ImageQuality,
): string {
  const explicit = requested?.trim() || configured?.trim()
  return explicit || getProviderModels(provider).defaultFor(quality)
}
```

## `src/providers/shared/polling.ts`

76 Zeilen

**Neu zu schreiben:** errors, result

```ts
/**
 * Polling for providers whose generation API is asynchronous.
 *
 * These providers accept a job and return an identifier; the image only
 * exists once the job finishes. Every such adapter needs the same loop, so
 * it lives here rather than being rewritten per provider.
 */

import type { Result } from '../../types/result.js'
import { Err, Ok } from '../../types/result.js'
import { NetworkError } from '../../utils/errors.js'

export interface PollingOptions {
  /** Give up after this long. */
  timeoutMs?: number
  /** Delay before the first status check. */
  initialDelayMs?: number
  /** Upper bound the backoff grows to. */
  maxDelayMs?: number
  /** Multiplier applied to the delay after each check. */
  backoffFactor?: number
}

const DEFAULT_POLLING: Required<PollingOptions> = {
  timeoutMs: 300_000,
  initialDelayMs: 2_000,
  maxDelayMs: 15_000,
  backoffFactor: 1.5,
}

/** One status check: either the job finished, or it is still running. */
export type PollOutcome<T> = { done: true; value: T } | { done: false; progress?: number }

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Repeatedly runs `check` until it reports completion or the timeout expires.
 *
 * A thrown error from `check` aborts the loop: a failed job is reported by
 * throwing the provider's own error rather than by polling forever.
 * @param check Performs one status check
 * @param options Timeout and backoff tuning
 */
export async function pollUntilDone<T>(
  check: () => Promise<PollOutcome<T>>,
  options: PollingOptions = {},
): Promise<Result<T, NetworkError>> {
  const { timeoutMs, initialDelayMs, maxDelayMs, backoffFactor } = {
    ...DEFAULT_POLLING,
    ...options,
  }

  const deadline = Date.now() + timeoutMs
  let delay = initialDelayMs

  while (Date.now() < deadline) {
    await sleep(Math.min(delay, Math.max(0, deadline - Date.now())))

    const outcome = await check()
    if (outcome.done) {
      return Ok(outcome.value)
    }

    delay = Math.min(delay * backoffFactor, maxDelayMs)
  }

  return Err(
    new NetworkError(
      `Generation did not finish within ${Math.round(timeoutMs / 1000)}s`,
      'The provider is still working on the job; try again or raise the timeout',
    ),
  )
}
```

## `src/providers/kie/models.ts`

84 Zeilen

**Neu zu schreiben:** mcp

```ts
/**
 * The Kie AI model table.
 *
 * Kie aggregates around a hundred models and offers no discovery endpoint;
 * their documentation states that "each model has unique parameters and
 * capabilities". That is literally true, and the differences are not cosmetic:
 * the field carrying input image URLs is called `input_urls`, `image_input`,
 * `image_urls` or `reference_image_urls` depending on the model, some models
 * have no `aspect_ratio` or `resolution` parameter at all, and the output
 * format is spelled `jpg` by one model and `jpeg` by another.
 *
 * The descriptors are therefore generated from Kie's own documentation rather
 * than hand-maintained — see `scripts/sync-kie-models.mjs`. Hand-maintaining
 * them would go stale in both directions, and the dangerous direction is
 * upward: when a model gains an aspect ratio, a frozen table starts rejecting
 * valid requests with a confident error.
 *
 * This module adds what the generated table cannot express: the default, and
 * the constraints Kie documents in prose rather than in the schema.
 */

import type { AspectRatio, ImageSize } from '../../types/mcp.js'
import type { KieModelShape } from './modelShape.js'
import { GENERATED_KIE_MODELS } from './models.generated.js'

/** A shape combination the model documents as unavailable. */
interface UnavailableCombination {
  readonly aspectRatio: AspectRatio
  readonly resolution: ImageSize
  readonly reason: string
}

export interface KieModel extends KieModelShape {
  readonly unavailable?: readonly UnavailableCombination[]
}

/**
 * Constraints Kie documents in prose, which therefore do not appear in the
 * OpenAPI schema the table is generated from. Keyed by model name.
 */
const UNAVAILABLE_COMBINATIONS: Readonly<Record<string, readonly UnavailableCombination[]>> = {
  'gpt-image-2': [
    { aspectRatio: '1:1', resolution: '4K', reason: 'this model has no 4K route at 1:1' },
  ],
}

/**
 * Default chosen because it maps onto every parameter this tool exposes: all
 * fourteen aspect ratios, every resolution, and an output format.
 */
export const DEFAULT_KIE_MODEL = 'nano-banana-2'

export const VERIFIED_KIE_MODELS = Object.keys(GENERATED_KIE_MODELS)

/**
 * Returns the descriptor for a model, or undefined when the model is not in
 * the generated table and should be passed through to Kie as-is.
 */
export function getKieModel(name: string): KieModel | undefined {
  const generated = (GENERATED_KIE_MODELS as Record<string, KieModelShape | undefined>)[name]
  if (!generated) {
    return undefined
  }
  const unavailable = UNAVAILABLE_COMBINATIONS[name]
  return unavailable ? { ...generated, unavailable } : generated
}

/**
 * The descriptor used for a model id that is not in the generated table: only
 * the parameters every documented image model shares, and no editing, because
 * the name of the input-image field cannot be guessed.
 */
export function passthroughModel(name: string): KieModel {
  return { textToImage: name }
}

/** A short, stable list for error messages, which must not print all of them. */
export function suggestedKieModels(): string {
  const preferred = ['nano-banana-2', 'nano-banana-pro', 'gpt-image-2'].filter((name) =>
    VERIFIED_KIE_MODELS.includes(name),
  )
  return preferred.join(', ')
}
```

## `src/providers/kie/modelShape.ts`

35 Zeilen

**Neu zu schreiben:** mcp

```ts
/**
 * The shape of a generated Kie model descriptor.
 *
 * This lives apart from `models.ts` so the generated table can be typed
 * without importing the module that consumes it.
 */

import type { AspectRatio, ImageOutputFormat, ImageSize } from '../../types/mcp.js'

export interface KieModelShape {
  /**
   * Model id used when generating from a prompt alone; absent for the
   * editing-only endpoints, which cannot generate.
   */
  readonly textToImage?: string
  /** Model id used when editing; absent when the model cannot edit. */
  readonly imageToImage?: string
  /**
   * Request field carrying input image URLs. Kie names it differently per
   * model, which is the main reason these descriptors exist at all.
   */
  readonly imageInputField?: string
  /**
   * Whether that field takes an array of URLs or a single URL string. Sending
   * the wrong shape breaks the request as surely as the wrong name does.
   */
  readonly imageInputIsArray?: boolean
  /** Accepted aspect ratios; absent when the model has no such parameter. */
  readonly aspectRatios?: readonly AspectRatio[]
  /** Accepted resolutions; absent when the model has no such parameter. */
  readonly resolutions?: readonly ImageSize[]
  /** How this model spells each output format; absent when it has no such parameter. */
  readonly outputFormats?: Readonly<Partial<Record<ImageOutputFormat, string>>>
}
```

## `src/providers/kie/capabilities.ts`

157 Zeilen

**Neu zu schreiben:** errors, mcp, result

```ts
/**
 * Validates a request against the selected Kie AI model.
 *
 * Unsupported combinations are rejected with a named reason rather than
 * silently mapped onto something else, so a caller learns why an image does
 * not have the shape they asked for. For an unverified model id there is
 * nothing to validate against, so the request goes through and Kie decides.
 */

import type { AspectRatio, ImageOutputFormat, ImageSize } from '../../types/mcp.js'
import type { Result } from '../../types/result.js'
import { Err, Ok } from '../../types/result.js'
import { ImageAPIError } from '../../utils/errors.js'
import { getKieModel, type KieModel, passthroughModel, suggestedKieModels } from './models.js'

export interface KieCapabilityInput {
  aspectRatio?: AspectRatio
  imageSize?: ImageSize
  preferredOutputFormat?: ImageOutputFormat
  hasInputImage?: boolean
}

export interface ResolvedKieCapabilities {
  model: KieModel
  /** Model id to send, already chosen for the generation or editing route. */
  modelId: string
  aspectRatio?: AspectRatio
  resolution?: ImageSize
  /** Already spelled the way this model expects it. */
  outputFormat?: string
  /** True when the model id was not one of the verified descriptors. */
  passthrough: boolean
}

function capabilityError(message: string, suggestion: string): ImageAPIError {
  return new ImageAPIError(message, {
    provider: 'kie',
    stage: 'capability validation',
    suggestion,
  })
}

/**
 * Resolves the request against the model's documented capabilities.
 * @param modelName The name passed as `--kie-model` or configured as KIE_MODEL
 * @param input The requested shape
 */
export function resolveKieCapabilities(
  modelName: string,
  input: KieCapabilityInput,
): Result<ResolvedKieCapabilities, ImageAPIError> {
  const verified = getKieModel(modelName)
  const model = verified ?? passthroughModel(modelName)
  const passthrough = verified === undefined

  if (input.hasInputImage && (!model.imageToImage || !model.imageInputField)) {
    return Err(
      capabilityError(
        passthrough
          ? `Editing is not available for the unlisted Kie model "${modelName}"`
          : `The Kie model "${modelName}" cannot edit an existing image`,
        passthrough
          ? `Kie names the input-image field differently per model, so editing needs a listed model. Try: ${suggestedKieModels()}`
          : `Use a model that supports editing, such as ${suggestedKieModels()}`,
      ),
    )
  }

  // Some Kie endpoints only edit; asking them to generate would send a prompt
  // to an editing route.
  if (!input.hasInputImage && !model.textToImage) {
    return Err(
      capabilityError(
        `The Kie model "${modelName}" only edits an existing image`,
        `Pass --input-image, or generate with a model such as ${suggestedKieModels()}`,
      ),
    )
  }

  if (input.aspectRatio && model.aspectRatios && !model.aspectRatios.includes(input.aspectRatio)) {
    return Err(
      capabilityError(
        `The Kie model "${modelName}" does not support the aspect ratio ${input.aspectRatio}`,
        `Use one of: ${model.aspectRatios.join(', ')}`,
      ),
    )
  }

  if (input.imageSize && model.resolutions && !model.resolutions.includes(input.imageSize)) {
    return Err(
      capabilityError(
        `The Kie model "${modelName}" does not support the image size ${input.imageSize}`,
        `Use one of: ${model.resolutions.join(', ')}`,
      ),
    )
  }

  // A model with no resolution parameter must not receive one.
  if (input.imageSize && !model.resolutions && !passthrough) {
    return Err(
      capabilityError(
        `The Kie model "${modelName}" has no image size parameter`,
        'Omit --image-size for this model, or choose a model that offers resolutions',
      ),
    )
  }

  const resolution = model.resolutions ? (input.imageSize ?? '1K') : undefined

  const unavailable = model.unavailable?.find(
    (entry) => entry.aspectRatio === input.aspectRatio && entry.resolution === resolution,
  )
  if (unavailable) {
    return Err(
      capabilityError(
        `The Kie model "${modelName}" cannot produce ${resolution} at ${input.aspectRatio}: ${unavailable.reason}`,
        'Choose a different aspect ratio or a lower image size',
      ),
    )
  }

  const outputFormat =
    input.preferredOutputFormat && model.outputFormats
      ? model.outputFormats[input.preferredOutputFormat]
      : undefined

  // The guards above make this unreachable, but a descriptor with neither
  // route must fail loudly rather than send an undefined model id.
  const modelId = input.hasInputImage ? model.imageToImage : model.textToImage
  if (!modelId) {
    return Err(
      capabilityError(
        `The Kie model "${modelName}" has no usable route for this request`,
        `Try a model such as ${suggestedKieModels()}`,
      ),
    )
  }

  return Ok({
    model,
    modelId,
    passthrough,
    ...(input.aspectRatio && { aspectRatio: input.aspectRatio }),
    ...(resolution && { resolution }),
    ...(outputFormat && { outputFormat }),
  })
}

/** Validation entry point used by the provider registry. */
export function validateKieCapabilities(
  modelName: string,
  input: KieCapabilityInput,
): Result<void, ImageAPIError> {
  const resolved = resolveKieCapabilities(modelName, input)
  return resolved.success ? Ok(undefined) : resolved
}
```

## `src/providers/kie/imageClient.ts`

369 Zeilen

**Neu zu schreiben:** errorClassification, errors, imageClient, mimeUtils, result

```ts
/**
 * Kie AI image client (GPT Image 2 route).
 *
 * Kie AI is asynchronous: a job is created, then polled, then the finished
 * image is downloaded from a temporary URL. Editing takes image URLs rather
 * than inline data, so a local input image is uploaded to Kie's own temporary
 * file store first.
 *
 * API surface used here:
 *   POST /api/v1/jobs/createTask      submit a generation job
 *   GET  /api/v1/jobs/recordInfo      poll a job
 *   POST /api/file-base64-upload      stage a local input image
 */

import type { Config } from '../../types/config.js'
import type { Result } from '../../types/result.js'
import { Err, Ok } from '../../types/result.js'
import { ConfigError, ImageAPIError, NetworkError } from '../../utils/errors.js'
import { getMimeTypeFromExtension } from '../../utils/mimeUtils.js'
import { isNetworkError } from '../shared/errorClassification.js'
import type { GeneratedImageResult, ImageApiParams, ImageClient } from '../shared/imageClient.js'
import { type PollingOptions, pollUntilDone } from '../shared/polling.js'
import { resolveKieCapabilities } from './capabilities.js'
import { DEFAULT_KIE_MODEL } from './models.js'

const API_BASE = 'https://api.kie.ai'
const CREATE_TASK_PATH = '/api/v1/jobs/createTask'
const RECORD_INFO_PATH = '/api/v1/jobs/recordInfo'
const UPLOAD_PATH = '/api/file-base64-upload'

/** Directory the staged input images are written to in Kie's file store. */
const UPLOAD_DIRECTORY = 'mcp-image'

/** Bound on the downloaded image, matching the input limit elsewhere. */
const MAX_DOWNLOAD_BYTES = 32 * 1024 * 1024

const REQUEST_TIMEOUT_MS = 60_000

/** Job states reported by recordInfo. */
const TERMINAL_SUCCESS = 'success'
const TERMINAL_FAILURE = 'fail'

interface KieEnvelope<T> {
  code?: number
  msg?: string
  data?: T
}

interface CreateTaskData {
  taskId?: string
}

interface RecordInfoData {
  state?: string
  resultJson?: string
  failCode?: string
  failMsg?: string
  progress?: number
}

interface UploadData {
  downloadUrl?: string
}

/** A finished job: either the image URL, or the reason it failed. */
type JobOutcome = { url: string } | { error: ImageAPIError | NetworkError }

function apiError(message: string, stage: string, upstreamMessage?: string): ImageAPIError {
  return new ImageAPIError(message, {
    provider: 'kie',
    stage,
    ...(upstreamMessage ? { upstreamMessage } : {}),
    suggestion: 'Check the Kie AI dashboard for job status and credit balance',
  })
}

async function request<T>(
  path: string,
  apiKey: string,
  init: { method: 'GET' | 'POST'; body?: unknown },
  stage: string,
): Promise<Result<T, ImageAPIError | NetworkError>> {
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })

    const payload = (await response.json().catch(() => undefined)) as KieEnvelope<T> | undefined

    if (!response.ok || (payload?.code !== undefined && payload.code !== 200)) {
      const detail = payload?.msg ?? `HTTP ${response.status}`
      if (response.status === 401 || response.status === 403 || payload?.code === 401) {
        return Err(apiError('Kie AI rejected the API key', stage, detail))
      }
      return Err(apiError(`Kie AI request failed during ${stage}`, stage, detail))
    }

    if (!payload?.data) {
      return Err(apiError(`Kie AI returned no data during ${stage}`, stage, payload?.msg))
    }

    return Ok(payload.data)
  } catch (error) {
    if (isNetworkError(error) || (error as Error).name === 'TimeoutError') {
      return Err(
        new NetworkError(
          `Network error during Kie AI ${stage}`,
          'Check your internet connection and try again',
        ),
      )
    }
    return Err(apiError(`Kie AI request failed during ${stage}`, stage, (error as Error).message))
  }
}

/** Stages a base64 input image in Kie's temporary file store and returns its URL. */
async function uploadInputImage(
  apiKey: string,
  base64: string,
  mimeType: string,
): Promise<Result<string, ImageAPIError | NetworkError>> {
  const extension = mimeType === 'image/jpeg' ? 'jpg' : mimeType === 'image/webp' ? 'webp' : 'png'
  const result = await request<UploadData>(
    UPLOAD_PATH,
    apiKey,
    {
      method: 'POST',
      body: {
        base64Data: `data:${mimeType};base64,${base64}`,
        uploadPath: UPLOAD_DIRECTORY,
        fileName: `input.${extension}`,
      },
    },
    'input image upload',
  )

  if (!result.success) {
    return result
  }
  if (!result.data.downloadUrl) {
    return Err(apiError('Kie AI upload returned no file URL', 'input image upload'))
  }
  return Ok(result.data.downloadUrl)
}

/** Reads the finished image, bounding how much is pulled into memory. */
async function downloadImage(url: string): Promise<Result<Buffer, ImageAPIError | NetworkError>> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    if (!response.ok) {
      return Err(
        apiError('Could not download the generated image', 'download', `HTTP ${response.status}`),
      )
    }

    const declaredLength = Number(response.headers.get('content-length') ?? '0')
    if (declaredLength > MAX_DOWNLOAD_BYTES) {
      await response.body?.cancel()
      return Err(apiError('Generated image exceeds the size limit', 'download'))
    }

    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.byteLength > MAX_DOWNLOAD_BYTES) {
      return Err(apiError('Generated image exceeds the size limit', 'download'))
    }

    const contentType = response.headers.get('content-type')
    const mimeType = contentType?.startsWith('image/')
      ? contentType.split(';')[0]
      : getMimeTypeFromExtension(new URL(url).pathname.slice(-5))

    return Ok(Object.assign(buffer, { mimeType }))
  } catch (error) {
    if (isNetworkError(error) || (error as Error).name === 'TimeoutError') {
      return Err(
        new NetworkError(
          'Network error while downloading the generated image',
          'Check your internet connection and try again',
        ),
      )
    }
    return Err(
      apiError('Could not download the generated image', 'download', (error as Error).message),
    )
  }
}

/** Extracts the first result URL from the JSON-encoded resultJson field. */
function firstResultUrl(resultJson: string | undefined): string | undefined {
  if (!resultJson) {
    return undefined
  }
  try {
    const parsed = JSON.parse(resultJson) as { resultUrls?: unknown }
    const urls = parsed.resultUrls
    return Array.isArray(urls) && typeof urls[0] === 'string' ? urls[0] : undefined
  } catch {
    return undefined
  }
}

/**
 * @param config Configuration carrying KIE_API_KEY
 * @param polling Overrides for the status-poll cadence, used by tests and by
 *   callers who need a longer ceiling for slow jobs
 */
export function createKieImageClient(
  config: Config,
  polling: PollingOptions = {},
): Result<ImageClient, ConfigError> {
  const apiKey = config.kieApiKey
  if (!apiKey || apiKey.trim().length === 0) {
    return Err(
      new ConfigError(
        'KIE_API_KEY is required but not provided',
        'Set KIE_API_KEY environment variable with your Kie AI API key, or run: mcp-image config set kie',
      ),
    )
  }

  const client: ImageClient = {
    async generateImage(params: ImageApiParams) {
      const modelName = params.model?.trim() || DEFAULT_KIE_MODEL
      const capabilities = resolveKieCapabilities(modelName, {
        ...(params.aspectRatio && { aspectRatio: params.aspectRatio }),
        ...(params.imageSize && { imageSize: params.imageSize }),
        ...(params.preferredOutputFormat && {
          preferredOutputFormat: params.preferredOutputFormat,
        }),
        hasInputImage: Boolean(params.inputImage),
      })
      if (!capabilities.success) {
        return capabilities
      }
      const resolved = capabilities.data

      // Editing takes URLs, so a local input image is staged first.
      let inputUrls: string[] | undefined
      if (params.inputImage) {
        const uploaded = await uploadInputImage(
          apiKey,
          params.inputImage,
          params.inputImageMimeType ?? 'image/png',
        )
        if (!uploaded.success) {
          return uploaded
        }
        inputUrls = [uploaded.data]
      }

      const created = await request<CreateTaskData>(
        CREATE_TASK_PATH,
        apiKey,
        {
          method: 'POST',
          body: {
            model: resolved.modelId,
            input: {
              prompt: params.prompt,
              ...(resolved.aspectRatio && { aspect_ratio: resolved.aspectRatio }),
              ...(resolved.resolution && { resolution: resolved.resolution }),
              ...(resolved.outputFormat && { output_format: resolved.outputFormat }),
              // Both the field name and its shape differ per model: some take
              // an array of URLs, others a single URL string.
              ...(inputUrls &&
                resolved.model.imageInputField && {
                  [resolved.model.imageInputField]: resolved.model.imageInputIsArray
                    ? inputUrls
                    : inputUrls[0],
                }),
            },
          },
        },
        'task creation',
      )

      if (!created.success) {
        return created
      }
      const taskId = created.data.taskId
      if (!taskId) {
        return Err(apiError('Kie AI did not return a task id', 'task creation'))
      }

      // A finished job is terminal whether it succeeded or failed, so both are
      // reported as "done" and the failure is unwrapped after the loop.
      const polled = await pollUntilDone<JobOutcome>(async () => {
        const status = await request<RecordInfoData>(
          `${RECORD_INFO_PATH}?taskId=${encodeURIComponent(taskId)}`,
          apiKey,
          { method: 'GET' },
          'status check',
        )

        if (!status.success) {
          return { done: true, value: { error: status.error } }
        }

        const { state, resultJson, failMsg, failCode, progress } = status.data

        if (state === TERMINAL_FAILURE) {
          return {
            done: true,
            value: {
              error: apiError(
                'Kie AI reported the generation as failed',
                'generation',
                [failCode, failMsg].filter(Boolean).join(': ') || undefined,
              ),
            },
          }
        }

        if (state === TERMINAL_SUCCESS) {
          const url = firstResultUrl(resultJson)
          return {
            done: true,
            value: url
              ? { url }
              : {
                  error: apiError(
                    'Kie AI reported success but returned no image URL',
                    'generation',
                  ),
                },
          }
        }

        return { done: false, ...(progress !== undefined && { progress }) }
      }, polling)

      if (!polled.success) {
        return Err(polled.error)
      }
      if ('error' in polled.data) {
        return Err(polled.data.error)
      }

      const downloaded = await downloadImage(polled.data.url)
      if (!downloaded.success) {
        return downloaded
      }

      const mimeType = (downloaded.data as Buffer & { mimeType?: string }).mimeType ?? 'image/png'
      const result: GeneratedImageResult = {
        imageData: downloaded.data,
        metadata: {
          model: resolved.modelId,
          provider: 'kie',
          prompt: params.prompt,
          mimeType,
          timestamp: new Date(),
          inputImageProvided: Boolean(inputUrls),
          responseId: taskId,
        },
      }
      return Ok(result)
    },
  }

  return Ok(client)
}
```

## `src/providers/higgsfield/imageClient.ts`

308 Zeilen

**Neu zu schreiben:** errorClassification, errors, imageClient, mcp, mimeUtils, result

```ts
/**
 * Higgsfield image client (Soul standard route).
 *
 * Like Kie AI this is an asynchronous API: the request is submitted, the
 * returned `status_url` is polled, and the finished image is downloaded.
 *
 * API surface used here:
 *   POST /higgsfield-ai/soul/standard   submit a generation request
 *   GET  <status_url>                   poll the request
 *
 * Two things are not covered by Higgsfield's public documentation and are
 * therefore handled as stated assumptions rather than silent guesses:
 *
 * 1. The full `resolution` vocabulary. Only "720p" appears in the docs, so
 *    `imageSize` is mapped onto the standard 720p/1080p/4k family. If the API
 *    rejects a value, the error names the mapping so it can be corrected.
 * 2. The full `aspect_ratio` vocabulary. Only "4:3" appears, and it matches
 *    the format this tool already uses, so ratios are passed through
 *    unchanged and the API is left to reject anything it does not accept.
 */

import type { Config } from '../../types/config.js'
import type { ImageSize } from '../../types/mcp.js'
import type { Result } from '../../types/result.js'
import { Err, Ok } from '../../types/result.js'
import { ConfigError, ImageAPIError, NetworkError } from '../../utils/errors.js'
import { getMimeTypeFromExtension } from '../../utils/mimeUtils.js'
import { HIGGSFIELD_DEFAULT_MODEL } from '../models.js'
import { isNetworkError } from '../shared/errorClassification.js'
import type { GeneratedImageResult, ImageApiParams, ImageClient } from '../shared/imageClient.js'
import { type PollingOptions, pollUntilDone } from '../shared/polling.js'

const API_BASE = 'https://platform.higgsfield.ai/higgsfield-ai'

/** Assumed mapping from this tool's sizes onto Higgsfield's resolution names. */
const RESOLUTION_BY_IMAGE_SIZE: Record<ImageSize, string> = {
  '1K': '720p',
  '2K': '1080p',
  '4K': '4k',
}

const MAX_DOWNLOAD_BYTES = 32 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 60_000

/** Terminal states reported by the status endpoint. */
const STATUS_COMPLETED = 'completed'
const STATUS_FAILED = 'failed'
const STATUS_NSFW = 'nsfw'
const STATUS_CANCELED = 'canceled'

interface SubmitResponse {
  status?: string
  request_id?: string
  status_url?: string
}

interface StatusResponse {
  status?: string
  images?: Array<{ url?: string }>
  error?: string
}

/** A finished request: either the image URL, or the reason it ended. */
type JobOutcome = { url: string } | { error: ImageAPIError }

function apiError(message: string, stage: string, upstreamMessage?: string): ImageAPIError {
  return new ImageAPIError(message, {
    provider: 'higgsfield',
    stage,
    ...(upstreamMessage ? { upstreamMessage } : {}),
    suggestion: 'Check your Higgsfield credit balance and the request in their dashboard',
  })
}

function networkError(stage: string): NetworkError {
  return new NetworkError(
    `Network error during Higgsfield ${stage}`,
    'Check your internet connection and try again',
  )
}

async function requestJson<T>(
  url: string,
  authorization: string,
  init: { method: 'GET' | 'POST'; body?: unknown },
  stage: string,
): Promise<Result<T, ImageAPIError | NetworkError>> {
  try {
    const response = await fetch(url, {
      method: init.method,
      headers: {
        Authorization: authorization,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })

    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      if (response.status === 401 || response.status === 403) {
        return Err(apiError('Higgsfield rejected the credentials', stage, detail || undefined))
      }
      return Err(
        apiError(
          `Higgsfield request failed during ${stage}`,
          stage,
          detail || `HTTP ${response.status}`,
        ),
      )
    }

    return Ok((await response.json()) as T)
  } catch (error) {
    if (isNetworkError(error) || (error as Error).name === 'TimeoutError') {
      return Err(networkError(stage))
    }
    return Err(
      apiError(`Higgsfield request failed during ${stage}`, stage, (error as Error).message),
    )
  }
}

async function downloadImage(url: string): Promise<Result<Buffer, ImageAPIError | NetworkError>> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    if (!response.ok) {
      return Err(
        apiError('Could not download the generated image', 'download', `HTTP ${response.status}`),
      )
    }

    if (Number(response.headers.get('content-length') ?? '0') > MAX_DOWNLOAD_BYTES) {
      await response.body?.cancel()
      return Err(apiError('Generated image exceeds the size limit', 'download'))
    }

    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.byteLength > MAX_DOWNLOAD_BYTES) {
      return Err(apiError('Generated image exceeds the size limit', 'download'))
    }

    const contentType = response.headers.get('content-type')
    const mimeType = contentType?.startsWith('image/')
      ? contentType.split(';')[0]
      : getMimeTypeFromExtension(new URL(url).pathname.slice(-5))

    return Ok(Object.assign(buffer, { mimeType }))
  } catch (error) {
    if (isNetworkError(error) || (error as Error).name === 'TimeoutError') {
      return Err(networkError('download'))
    }
    return Err(
      apiError('Could not download the generated image', 'download', (error as Error).message),
    )
  }
}

/**
 * @param config Configuration carrying HIGGSFIELD_API_KEY as `keyId:keySecret`
 * @param polling Overrides for the status-poll cadence
 */
export function createHiggsfieldImageClient(
  config: Config,
  polling: PollingOptions = {},
): Result<ImageClient, ConfigError> {
  const credential = config.higgsfieldApiKey?.trim() ?? ''
  if (credential.length === 0) {
    return Err(
      new ConfigError(
        'HIGGSFIELD_API_KEY is required but not provided',
        'Set HIGGSFIELD_API_KEY to your Higgsfield key id and secret joined by a colon, or run: mcp-image config set higgsfield',
      ),
    )
  }

  // Higgsfield authenticates with a key id and secret pair rather than a
  // single token, so the two halves travel together in one variable.
  if (!credential.includes(':')) {
    return Err(
      new ConfigError(
        'HIGGSFIELD_API_KEY must contain both the key id and the key secret',
        'Use the form keyId:keySecret, for example HIGGSFIELD_API_KEY=abc123:secret456',
      ),
    )
  }

  const authorization = `Key ${credential}`

  const client: ImageClient = {
    async generateImage(params: ImageApiParams) {
      if (params.inputImage) {
        return Err(
          apiError(
            'The Higgsfield Soul standard route does not accept an input image',
            'capability validation',
          ),
        )
      }

      // Higgsfield addresses models by path rather than by a body field.
      const modelPath = params.model?.trim() || HIGGSFIELD_DEFAULT_MODEL
      const submitted = await requestJson<SubmitResponse>(
        `${API_BASE}/${modelPath}`,
        authorization,
        {
          method: 'POST',
          body: {
            prompt: params.prompt,
            ...(params.aspectRatio && { aspect_ratio: params.aspectRatio }),
            ...(params.imageSize && { resolution: RESOLUTION_BY_IMAGE_SIZE[params.imageSize] }),
          },
        },
        'request submission',
      )

      if (!submitted.success) {
        return submitted
      }

      const statusUrl = submitted.data.status_url
      if (!statusUrl) {
        return Err(apiError('Higgsfield returned no status URL', 'request submission'))
      }

      const polled = await pollUntilDone<JobOutcome>(async () => {
        const status = await requestJson<StatusResponse>(
          statusUrl,
          authorization,
          { method: 'GET' },
          'status check',
        )

        if (!status.success) {
          return { done: true, value: { error: apiError(status.error.message, 'status check') } }
        }

        const state = status.data.status
        if (state === STATUS_COMPLETED) {
          const url = status.data.images?.[0]?.url
          return {
            done: true,
            value: url
              ? { url }
              : { error: apiError('Higgsfield completed without an image URL', 'generation') },
          }
        }

        if (state === STATUS_NSFW) {
          return {
            done: true,
            value: {
              error: apiError(
                'Higgsfield blocked the request as unsafe content',
                'generation',
                status.data.error,
              ),
            },
          }
        }

        if (state === STATUS_FAILED || state === STATUS_CANCELED) {
          return {
            done: true,
            value: {
              error: apiError(
                `Higgsfield reported the request as ${state}`,
                'generation',
                status.data.error,
              ),
            },
          }
        }

        return { done: false }
      }, polling)

      if (!polled.success) {
        return Err(polled.error)
      }
      if ('error' in polled.data) {
        return Err(polled.data.error)
      }

      const downloaded = await downloadImage(polled.data.url)
      if (!downloaded.success) {
        return downloaded
      }

      const result: GeneratedImageResult = {
        imageData: downloaded.data,
        metadata: {
          model: modelPath,
          provider: 'higgsfield',
          prompt: params.prompt,
          mimeType: (downloaded.data as Buffer & { mimeType?: string }).mimeType ?? 'image/jpeg',
          timestamp: new Date(),
          inputImageProvided: false,
          ...(submitted.data.request_id && { responseId: submitted.data.request_id }),
        },
      }
      return Ok(result)
    },
  }

  return Ok(client)
}
```

---

# C. Tests

Deine Tests. Assertions gegen fremde Fehlermeldungen musst du auf deine eigene Taxonomie umschreiben.

## `src/cli/__tests__/config.test.ts`

146 Zeilen

```ts
import { mkdtempSync, rmSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readStoredConfig } from '../../config/file.js'
import { runConfig } from '../config.js'

describe('runConfig', () => {
  let configHome: string
  let stdout: string[]
  let stderr: string[]
  const savedEnv = { ...process.env }

  beforeEach(() => {
    configHome = mkdtempSync(path.join(os.tmpdir(), 'mcp-image-cli-'))
    process.env['XDG_CONFIG_HOME'] = configHome
    delete process.env['GEMINI_API_KEY']
    delete process.env['OPENAI_API_KEY']
    delete process.env['ARK_API_KEY']
    delete process.env['IMAGE_PROVIDER']
    delete process.env['IMAGE_QUALITY']
    delete process.env['IMAGE_OUTPUT_DIR']

    stdout = []
    stderr = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout.push(String(chunk))
      return true
    })
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk))
      return true
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    process.env = { ...savedEnv }
    rmSync(configHome, { recursive: true, force: true })
  })

  it('should print the config file path', async () => {
    const code = await runConfig(['path'])

    expect(code).toBe(0)
    expect(stdout.join('').trim()).toBe(path.join(configHome, 'mcp-image', 'config.json'))
  })

  it('should store a non-secret setting in the config file', async () => {
    // Act
    const code = await runConfig(['set', 'default-provider', 'openai'])

    // Assert
    expect(code).toBe(0)
    expect(readStoredConfig().defaultProvider).toBe('openai')
  })

  it('should reject a value outside the allowed set', async () => {
    // Act
    const code = await runConfig(['set', 'quality', 'ultra'])

    // Assert
    expect(code).toBe(2)
    expect(stderr.join('')).toContain('Valid values: fast, balanced, quality')
    expect(readStoredConfig().quality).toBeUndefined()
  })

  it('should reject an unknown key', async () => {
    const code = await runConfig(['set', 'not-a-key', 'value'])

    expect(code).toBe(2)
    expect(stderr.join('')).toContain('Unknown config key')
  })

  it('should report the resolving source for each value', async () => {
    // Arrange
    await runConfig(['set', 'quality', 'balanced'])
    stdout.length = 0

    // Act
    const code = await runConfig(['list', '--json'])

    // Assert
    expect(code).toBe(0)
    const payload = JSON.parse(stdout.join(''))
    const quality = payload.entries.find((entry: { key: string }) => entry.key === 'quality')
    expect(quality).toMatchObject({ value: 'balanced', source: 'config file', shadowed: [] })
  })

  it('should mark the config file as shadowed when the environment also defines a value', async () => {
    // Arrange
    await runConfig(['set', 'quality', 'balanced'])
    process.env['IMAGE_QUALITY'] = 'quality'
    stdout.length = 0

    // Act
    await runConfig(['list', '--json'])

    // Assert
    const payload = JSON.parse(stdout.join(''))
    const quality = payload.entries.find((entry: { key: string }) => entry.key === 'quality')
    expect(quality).toMatchObject({ value: 'quality', source: 'env', shadowed: ['config file'] })
  })

  it('should mask a stored API key rather than printing it', async () => {
    // Arrange
    process.env['GEMINI_API_KEY'] = 'AIzaSyEXAMPLEKEYf3'
    stdout.length = 0

    // Act
    await runConfig(['get', 'gemini', '--json'])

    // Assert
    const payload = JSON.parse(stdout.join(''))
    expect(payload.value).toBe('AIza…f3')
    expect(stdout.join('')).not.toContain('AIzaSyEXAMPLEKEYf3')
  })

  it('should remove a stored value without touching other layers', async () => {
    // Arrange
    await runConfig(['set', 'output-dir', './images'])
    expect(readStoredConfig().outputDir).toBe('./images')

    // Act
    const code = await runConfig(['unset', 'output-dir'])

    // Assert
    expect(code).toBe(0)
    expect(readStoredConfig().outputDir).toBeUndefined()
  })

  it('should reject an unknown action', async () => {
    const code = await runConfig(['frobnicate'])

    expect(code).toBe(2)
    expect(stderr.join('')).toContain('Unknown config action')
  })

  it('should show help and exit 0 when asked', async () => {
    const code = await runConfig(['--help'])

    expect(code).toBe(0)
    expect(stdout.join('')).toContain('mcp-image config set')
  })
})
```

## `src/cli/__tests__/generate.test.ts`

175 Zeilen

**Neu zu schreiben:** errors

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfigError, ImageAPIError, InputValidationError } from '../../utils/errors.js'

const generate = vi.fn()

vi.mock('../../core/imageGenerator', () => ({
  createImageGenerator: vi.fn(() => ({ generate })),
}))

const { runGenerate } = await import('../generate.js')

function successResult() {
  return {
    success: true as const,
    data: {
      filePath: './output/generated.png',
      generation: {
        imageData: Buffer.from(''),
        metadata: {
          model: 'test-model',
          provider: 'gemini',
          prompt: 'test prompt',
          mimeType: 'image/png',
          timestamp: new Date(0),
          inputImageProvided: false,
        },
      },
    },
  }
}

describe('runGenerate', () => {
  let stdout: string[]
  let stderr: string[]

  beforeEach(() => {
    vi.clearAllMocks()
    stdout = []
    stderr = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout.push(String(chunk))
      return true
    })
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk))
      return true
    })
    process.env.GEMINI_API_KEY = 'test-gemini-api-key'
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env.GEMINI_API_KEY
  })

  it('should print the saved path as the last stdout line and exit 0', async () => {
    // Arrange
    generate.mockResolvedValue(successResult())

    // Act
    const code = await runGenerate(['a red bicycle'])

    // Assert
    expect(code).toBe(0)
    const lines = stdout.join('').trimEnd().split('\n')
    expect(lines.at(-1)).toBe('./output/generated.png')
  })

  it('should join positional words into a single prompt', async () => {
    // Arrange
    generate.mockResolvedValue(successResult())

    // Act
    await runGenerate(['a', 'red', 'bicycle'])

    // Assert
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'a red bicycle' }))
  })

  it('should emit exactly one JSON object on stdout in --json mode', async () => {
    // Arrange
    generate.mockResolvedValue(successResult())

    // Act
    const code = await runGenerate(['a red bicycle', '--json'])

    // Assert
    expect(code).toBe(0)
    const payload = JSON.parse(stdout.join(''))
    expect(payload).toMatchObject({
      success: true,
      filePath: './output/generated.png',
      model: 'test-model',
      provider: 'gemini',
      mimeType: 'image/png',
    })
  })

  it('should forward flags to the core parameters', async () => {
    // Arrange
    generate.mockResolvedValue(successResult())

    // Act
    await runGenerate([
      'a banner',
      '--provider',
      'openai',
      '--aspect-ratio',
      '16:9',
      '--file-name',
      'banner.png',
      '--use-google-search',
    ])

    // Assert
    expect(generate).toHaveBeenCalledWith({
      prompt: 'a banner',
      provider: 'openai',
      aspectRatio: '16:9',
      fileName: 'banner.png',
      useGoogleSearch: true,
    })
  })

  it('should reject a missing prompt with exit code 2 and keep stdout empty', async () => {
    // Act
    const code = await runGenerate([])

    // Assert
    expect(code).toBe(2)
    expect(stdout.join('')).toBe('')
    expect(stderr.join('')).toContain('A prompt is required')
    expect(generate).not.toHaveBeenCalled()
  })

  it('should reject unknown flags with exit code 2', async () => {
    // Act
    const code = await runGenerate(['a prompt', '--not-a-flag'])

    // Assert
    expect(code).toBe(2)
    expect(generate).not.toHaveBeenCalled()
  })

  it.each([
    [new InputValidationError('bad input', 'fix the input'), 2, 'INPUT_VALIDATION_ERROR'],
    [new ConfigError('no key', 'set the key'), 3, 'CONFIG_ERROR'],
    [new ImageAPIError('upstream failed'), 4, 'IMAGE_API_ERROR'],
  ])('should map %# to its exit code and JSON error shape', async (error, expected, code) => {
    // Arrange
    generate.mockResolvedValue({ success: false, error })

    // Act
    const exitCode = await runGenerate(['a prompt', '--json'])

    // Assert
    expect(exitCode).toBe(expected)
    const payload = JSON.parse(stdout.join(''))
    expect(payload.success).toBe(false)
    expect(payload.errorCode).toBe(code)
    expect(payload.error).toBe(error.message)
    expect(payload.hint).toBe(error.suggestion)
  })

  it('should print help without calling the generator', async () => {
    // Act
    const code = await runGenerate(['--help'])

    // Assert
    expect(code).toBe(0)
    expect(stdout.join('')).toContain('mcp-image generate')
    expect(generate).not.toHaveBeenCalled()
  })
})
```

## `src/config/__tests__/file.test.ts`

84 Zeilen

```ts
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { configDirPath, configFilePath, readStoredConfig, writeStoredConfig } from '../file.js'

describe('config file', () => {
  let configHome: string
  const originalXdg = process.env['XDG_CONFIG_HOME']

  beforeEach(() => {
    configHome = mkdtempSync(path.join(os.tmpdir(), 'mcp-image-config-'))
    process.env['XDG_CONFIG_HOME'] = configHome
  })

  afterEach(() => {
    if (originalXdg === undefined) {
      delete process.env['XDG_CONFIG_HOME']
    } else {
      process.env['XDG_CONFIG_HOME'] = originalXdg
    }
    rmSync(configHome, { recursive: true, force: true })
  })

  it('should place the config file under XDG_CONFIG_HOME when it is set', () => {
    expect(configDirPath()).toBe(path.join(configHome, 'mcp-image'))
    expect(configFilePath()).toBe(path.join(configHome, 'mcp-image', 'config.json'))
  })

  it('should return an empty config when the file does not exist', () => {
    expect(readStoredConfig()).toEqual({})
  })

  it('should round-trip a stored config', () => {
    // Arrange
    const stored = {
      defaultProvider: 'openai' as const,
      quality: 'balanced' as const,
      apiKeys: { openai: 'a-key' },
    }

    // Act
    const written = writeStoredConfig(stored)

    // Assert
    expect(written).toBe(configFilePath())
    expect(readStoredConfig()).toEqual(stored)
  })

  it.each(['not json at all', '[]', 'null'])(
    'should degrade to an empty config when the file contains %p',
    (contents) => {
      // Arrange: a broken file must not block a run that has env credentials
      mkdirSync(configDirPath(), { recursive: true })
      writeFileSync(configFilePath(), contents, 'utf-8')

      // Assert
      expect(readStoredConfig()).toEqual({})
    },
  )

  it.runIf(process.platform !== 'win32')(
    'should write the file with owner-only permissions',
    () => {
      // Act
      writeStoredConfig({ apiKeys: { gemini: 'secret' } })

      // Assert
      expect(statSync(configFilePath()).mode & 0o777).toBe(0o600)
    },
  )

  it('should keep permissions on a rewrite of an existing file', () => {
    // Arrange
    writeStoredConfig({ apiKeys: { gemini: 'first' } })

    // Act
    writeStoredConfig({ apiKeys: { gemini: 'second' } })

    // Assert
    expect(readStoredConfig().apiKeys?.gemini).toBe('second')
  })
})
```

## `src/config/__tests__/layers.test.ts`

106 Zeilen

```ts
import { describe, expect, it } from 'vitest'
import type { ConfigLayers } from '../layers.js'
import { maskSecret, resolveProviderKey, resolveSetting } from '../layers.js'

function layers(overrides: Partial<ConfigLayers> = {}): ConfigLayers {
  return {
    env: {},
    dotenv: {},
    stored: {},
    dotenvPath: '/project/.env',
    ...overrides,
  }
}

describe('resolveSetting', () => {
  it('should return undefined when no layer defines the value', () => {
    expect(resolveSetting(layers(), 'IMAGE_QUALITY', undefined)).toBeUndefined()
  })

  it('should prefer the process environment over .env and the config file', () => {
    // Arrange
    const resolution = resolveSetting(
      layers({ env: { IMAGE_QUALITY: 'quality' }, dotenv: { IMAGE_QUALITY: 'balanced' } }),
      'IMAGE_QUALITY',
      'fast',
    )

    // Assert
    expect(resolution).toEqual({
      value: 'quality',
      source: 'env',
      shadowed: ['.env', 'config file'],
    })
  })

  it('should prefer .env over the config file', () => {
    const resolution = resolveSetting(
      layers({ dotenv: { IMAGE_QUALITY: 'balanced' } }),
      'IMAGE_QUALITY',
      'fast',
    )

    expect(resolution).toEqual({ value: 'balanced', source: '.env', shadowed: ['config file'] })
  })

  it('should fall back to the config file and report no shadowing', () => {
    const resolution = resolveSetting(layers(), 'IMAGE_QUALITY', 'fast')

    expect(resolution).toEqual({ value: 'fast', source: 'config file', shadowed: [] })
  })

  it.each(['', '   ', 'undefined', 'null'])(
    'should treat %p in the environment as absent',
    (value) => {
      const resolution = resolveSetting(
        layers({ env: { IMAGE_QUALITY: value } }),
        'IMAGE_QUALITY',
        'fast',
      )

      expect(resolution?.source).toBe('config file')
      expect(resolution?.shadowed).toEqual([])
    },
  )
})

describe('resolveProviderKey', () => {
  it('should read a provider key from the environment variable it owns', () => {
    const resolution = resolveProviderKey(layers({ env: { ARK_API_KEY: 'ark-key' } }), 'seedream')

    expect(resolution).toEqual({ value: 'ark-key', source: 'env', shadowed: [] })
  })

  it('should read a provider key from the stored config when nothing else defines it', () => {
    const resolution = resolveProviderKey(
      layers({ stored: { apiKeys: { openai: 'stored-openai-key' } } }),
      'openai',
    )

    expect(resolution).toEqual({ value: 'stored-openai-key', source: 'config file', shadowed: [] })
  })

  it('should report the config file as shadowed when the environment also defines the key', () => {
    const resolution = resolveProviderKey(
      layers({
        env: { GEMINI_API_KEY: 'env-key' },
        stored: { apiKeys: { gemini: 'stored-key' } },
      }),
      'gemini',
    )

    expect(resolution?.value).toBe('env-key')
    expect(resolution?.shadowed).toEqual(['config file'])
  })
})

describe('maskSecret', () => {
  it('should keep only a recognisable head and tail', () => {
    expect(maskSecret('AIzaSyEXAMPLEKEYf3')).toBe('AIza…f3')
  })

  it.each(['', 'short', '12345678'])('should fully mask %p', (value) => {
    expect(maskSecret(value)).toBe('*'.repeat(value.length))
  })
})
```

## `src/core/__tests__/imageGenerator.test.ts`

149 Zeilen

**Neu zu schreiben:** config, fileManager, imageClient, logger, result

```ts
import { describe, expect, it, vi } from 'vitest'
import type { FileManager } from '../../business/fileManager.js'
import type { ImageProviderDefinition } from '../../providers/registry.js'
import type { GeneratedImageResult } from '../../providers/shared/imageClient.js'
import { Ok } from '../../types/result.js'
import type { Config } from '../../utils/config.js'
import { Logger } from '../../utils/logger.js'
import { createImageGenerator } from '../imageGenerator.js'
import type { ProviderClientCache } from '../providerClients.js'

const BASE_CONFIG: Config = {
  imageProvider: 'gemini',
  geminiApiKey: 'test-gemini-api-key',
  openaiApiKey: '',
  arkApiKey: '',
  kieApiKey: '',
  higgsfieldApiKey: '',
  imageModels: {},
  imageOutputDir: './test-output',
  skipPromptEnhancement: true,
  imageQuality: 'fast',
}

function createGenerationResult(): GeneratedImageResult {
  return {
    imageData: Buffer.from('image-bytes', 'utf-8'),
    metadata: {
      model: 'test-model',
      prompt: 'test prompt',
      mimeType: 'image/png',
      timestamp: new Date(0),
      inputImageProvided: false,
    },
  }
}

function createHarness(config: Partial<Config> = {}) {
  const generateImage = vi.fn().mockResolvedValue(Ok(createGenerationResult()))
  const requestedProviders: string[] = []

  const clients: ProviderClientCache = {
    get: (_config, providerName, _provider: ImageProviderDefinition) => {
      requestedProviders.push(providerName)
      return { imageClient: { generateImage }, structuredPromptGenerator: null }
    },
  }

  const fileManager: FileManager = {
    saveImage: vi.fn().mockResolvedValue(Ok('./test-output/generated.png')),
    ensureDirectoryExists: vi.fn().mockReturnValue(Ok(undefined)),
    generateFileName: vi.fn().mockReturnValue('generated.png'),
  }

  const generator = createImageGenerator({
    clients,
    fileManager,
    logger: new Logger(),
    loadConfig: () => Ok({ ...BASE_CONFIG, ...config }),
  })

  return { generator, generateImage, fileManager, requestedProviders }
}

describe('createImageGenerator', () => {
  it('should run the pipeline without an MCP server and return the saved path', async () => {
    // Arrange
    const { generator, generateImage } = createHarness()

    // Act
    const result = await generator.generate({ prompt: 'a red bicycle' })

    // Assert
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.filePath).toBe('./test-output/generated.png')
      expect(result.data.generation.metadata.model).toBe('test-model')
    }
    expect(generateImage).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'a red bicycle' }))
  })

  it('should resolve the model and pass it to the provider', async () => {
    // Arrange
    const { generator, generateImage } = createHarness()

    // Act
    await generator.generate({ prompt: 'a prompt', model: 'gemini-3-pro-image' })

    // Assert
    expect(generateImage).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gemini-3-pro-image' }),
    )
  })

  it('should fall back to the model configured for the provider', async () => {
    // Arrange
    const { generator, generateImage } = createHarness({
      imageModels: { gemini: 'configured-gemini-model' },
    })

    // Act
    await generator.generate({ prompt: 'a prompt' })

    // Assert
    expect(generateImage).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'configured-gemini-model' }),
    )
  })

  it('should dispatch to the provider named in the request', async () => {
    // Arrange
    const { generator, requestedProviders } = createHarness({
      openaiApiKey: 'test-openai-api-key',
    })

    // Act
    await generator.generate({ prompt: 'test prompt', provider: 'openai' })

    // Assert: the server default is gemini, the request asked for openai
    expect(requestedProviders).toEqual(['openai'])
  })

  it('should fail with a configuration error when the requested provider has no key', async () => {
    // Arrange
    const { generator, generateImage } = createHarness()

    // Act
    const result = await generator.generate({ prompt: 'test prompt', provider: 'seedream' })

    // Assert
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.message).toContain('ARK_API_KEY')
    }
    expect(generateImage).not.toHaveBeenCalled()
  })

  it('should fail validation before reaching the provider', async () => {
    // Arrange
    const { generator, generateImage } = createHarness()

    // Act
    const result = await generator.generate({ prompt: '' })

    // Assert
    expect(result.success).toBe(false)
    expect(generateImage).not.toHaveBeenCalled()
  })
})
```

## `src/core/__tests__/imageMarker.test.ts`

191 Zeilen

**Neu zu schreiben:** imageClient

```ts
import { mkdtempSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ImageGenerationMetadata } from '../../providers/shared/imageClient.js'
import { hasDigitalSourceType, markImage, TRAINED_ALGORITHMIC_MEDIA } from '../imageMarker.js'

const METADATA: ImageGenerationMetadata = {
  model: 'gemini-3.1-flash-image',
  provider: 'gemini',
  prompt: 'a red bicycle',
  mimeType: 'image/png',
  timestamp: new Date(0),
  inputImageProvided: false,
}

describe('markImage', () => {
  let dir: string

  async function createImage(name: string, xmp?: string): Promise<string> {
    const filePath = path.join(dir, name)
    let pipeline = sharp({
      create: { width: 320, height: 240, channels: 3, background: '#204080' },
    }).png()
    if (xmp) {
      pipeline = pipeline.withXmp(xmp)
    }
    await pipeline.toFile(filePath)
    return filePath
  }

  async function readXmp(filePath: string): Promise<string> {
    const metadata = await sharp(await readFile(filePath)).metadata()
    return metadata.xmp?.toString('utf-8') ?? ''
  }

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'mcp-image-marker-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('should write the IPTC digital source type for trained algorithmic media', async () => {
    // Arrange
    const filePath = await createImage('plain.png')

    // Act
    const result = await markImage(
      filePath,
      { machineReadable: true, visibleLabel: false },
      METADATA,
    )

    // Assert
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.machineReadableWritten).toBe(true)
      expect(result.data.alreadyMarked).toBe(false)
    }
    expect(await readXmp(filePath)).toContain(TRAINED_ALGORITHMIC_MEDIA)
  })

  it('should record the generating model alongside the marker', async () => {
    // Arrange
    const filePath = await createImage('with-model.png')

    // Act
    await markImage(filePath, { machineReadable: true, visibleLabel: false }, METADATA)

    // Assert
    const xmp = await readXmp(filePath)
    expect(xmp).toContain('gemini-3.1-flash-image')
    expect(xmp).toContain('CreatorTool')
  })

  it('should leave metadata untouched when a digital source type is already declared', async () => {
    // Arrange: stand in for a provider that marked the file itself
    const providerXmp = [
      '<x:xmpmeta xmlns:x="adobe:ns:meta/">',
      '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
      '<rdf:Description rdf:about="" xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/">',
      '<Iptc4xmpExt:DigitalSourceType>http://cv.iptc.org/newscodes/digitalsourcetype/compositeSynthetic</Iptc4xmpExt:DigitalSourceType>',
      '</rdf:Description></rdf:RDF></x:xmpmeta>',
    ].join('')
    const filePath = await createImage('provider-marked.png', providerXmp)

    // Act
    const result = await markImage(
      filePath,
      { machineReadable: true, visibleLabel: false },
      METADATA,
    )

    // Assert
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.alreadyMarked).toBe(true)
      expect(result.data.machineReadableWritten).toBe(false)
    }
    const xmp = await readXmp(filePath)
    expect(xmp).toContain('compositeSynthetic')
    expect(xmp).not.toContain(TRAINED_ALGORITHMIC_MEDIA)
  })

  it('should add the marker to existing metadata instead of replacing it', async () => {
    // Arrange: XMP that carries other data but no digital source type
    const existing = [
      '<x:xmpmeta xmlns:x="adobe:ns:meta/">',
      '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
      '<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">',
      '<dc:rights>Existing provider data</dc:rights>',
      '</rdf:Description></rdf:RDF></x:xmpmeta>',
    ].join('')
    const filePath = await createImage('has-other-xmp.png', existing)

    // Act
    await markImage(filePath, { machineReadable: true, visibleLabel: false }, METADATA)

    // Assert
    const xmp = await readXmp(filePath)
    expect(xmp).toContain('Existing provider data')
    expect(xmp).toContain(TRAINED_ALGORITHMIC_MEDIA)
  })

  it('should composite a visible label without changing the image dimensions', async () => {
    // Arrange
    const filePath = await createImage('labelled.png')
    const before = await sharp(await readFile(filePath))
      .raw()
      .toBuffer()

    // Act
    const result = await markImage(filePath, { machineReadable: false, visibleLabel: true })

    // Assert
    expect(result.success).toBe(true)
    const after = await sharp(await readFile(filePath))
    const metadata = await after.metadata()
    expect(metadata.width).toBe(320)
    expect(metadata.height).toBe(240)
    expect(Buffer.compare(await after.raw().toBuffer(), before)).not.toBe(0)
  })

  it('should do nothing when neither marking is requested', async () => {
    // Arrange
    const filePath = await createImage('untouched.png')
    const before = await readFile(filePath)

    // Act
    const result = await markImage(filePath, { machineReadable: false, visibleLabel: false })

    // Assert
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.machineReadableWritten).toBe(false)
      expect(result.data.visibleLabelWritten).toBe(false)
    }
    expect(Buffer.compare(await readFile(filePath), before)).toBe(0)
  })

  it('should fail with a file operation error for a missing file', async () => {
    // Act
    const result = await markImage(path.join(dir, 'nope.png'), {
      machineReadable: true,
      visibleLabel: false,
    })

    // Assert
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.code).toBe('FILE_OPERATION_ERROR')
    }
  })
})

describe('hasDigitalSourceType', () => {
  it.each([undefined, '', '<x:xmpmeta/>'])('should be false for %p', (value) => {
    expect(hasDigitalSourceType(value)).toBe(false)
  })

  it('should be true when the property is present', () => {
    expect(
      hasDigitalSourceType('<Iptc4xmpExt:DigitalSourceType>x</Iptc4xmpExt:DigitalSourceType>'),
    ).toBe(true)
  })
})
```

## `src/providers/__tests__/models.test.ts`

71 Zeilen

**Neu zu schreiben:** mcp

```ts
import { describe, expect, it } from 'vitest'
import { GEMINI_MODELS, IMAGE_PROVIDER_VALUES } from '../../types/mcp.js'
import { getProviderModels, modelEnvVar, PROVIDER_MODELS, resolveModel } from '../models.js'

describe('resolveModel', () => {
  it('should prefer the model named in the request', () => {
    expect(resolveModel('gemini', 'requested-model', 'configured-model', 'fast')).toBe(
      'requested-model',
    )
  })

  it('should fall back to the configured model', () => {
    expect(resolveModel('kie', undefined, 'nano-banana-pro', 'fast')).toBe('nano-banana-pro')
  })

  it("should fall back to the provider's own default", () => {
    expect(resolveModel('openai', undefined, undefined, 'fast')).toBe('gpt-image-2')
  })

  it.each(['', '   '])('should treat %p as unset rather than as a model id', (blank) => {
    expect(resolveModel('openai', blank, undefined, 'fast')).toBe('gpt-image-2')
  })

  it('should let the quality preset pick the Gemini model when none is named', () => {
    // Assert: the behaviour that existed before models became selectable
    expect(resolveModel('gemini', undefined, undefined, 'fast')).toBe(GEMINI_MODELS.FLASH)
    expect(resolveModel('gemini', undefined, undefined, 'balanced')).toBe(GEMINI_MODELS.FLASH)
    expect(resolveModel('gemini', undefined, undefined, 'quality')).toBe(GEMINI_MODELS.PRO)
  })

  it('should let an explicit model override the quality preset', () => {
    expect(resolveModel('gemini', GEMINI_MODELS.PRO, undefined, 'fast')).toBe(GEMINI_MODELS.PRO)
  })

  it('should pass through an id the provider is not known to offer', () => {
    // No project can keep an authoritative catalogue of five vendors' models,
    // so an unlisted id is the provider's business, not ours.
    expect(resolveModel('openai', 'gpt-image-9-unreleased', undefined, 'fast')).toBe(
      'gpt-image-9-unreleased',
    )
  })
})

describe('PROVIDER_MODELS', () => {
  it('should cover every provider', () => {
    expect(Object.keys(PROVIDER_MODELS).sort()).toEqual([...IMAGE_PROVIDER_VALUES].sort())
  })

  it.each([...IMAGE_PROVIDER_VALUES])(
    'should give %s a default it also lists as known',
    (provider) => {
      const catalogue = getProviderModels(provider)

      expect(catalogue.known.length).toBeGreaterThan(0)
      for (const quality of ['fast', 'balanced', 'quality'] as const) {
        expect(catalogue.known).toContain(catalogue.defaultFor(quality))
      }
    },
  )
})

describe('modelEnvVar', () => {
  it.each([
    ['gemini', 'GEMINI_MODEL'],
    ['kie', 'KIE_MODEL'],
    ['higgsfield', 'HIGGSFIELD_MODEL'],
  ] as const)('should name the variable for %s', (provider, expected) => {
    expect(modelEnvVar(provider)).toBe(expected)
  })
})
```

## `src/providers/higgsfield/__tests__/imageClient.test.ts`

211 Zeilen

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Config } from '../../../types/config.js'
import { createHiggsfieldImageClient } from '../imageClient.js'

const CONFIG: Config = {
  imageProvider: 'higgsfield',
  geminiApiKey: '',
  openaiApiKey: '',
  arkApiKey: '',
  kieApiKey: '',
  higgsfieldApiKey: 'key-id:key-secret',
  imageModels: {},
  imageOutputDir: './output',
  skipPromptEnhancement: true,
  imageQuality: 'fast',
}

const STATUS_URL = 'https://platform.higgsfield.ai/requests/req_1/status'
const IMAGE_URL = 'https://cdn.higgsfield.test/generated.jpg'

/** Poll fast so the suite does not wait on the production cadence. */
const FAST_POLLING = { initialDelayMs: 1, maxDelayMs: 4, backoffFactor: 1, timeoutMs: 2_000 }

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function imageResponse(): Response {
  return new Response(new Uint8Array(Buffer.from('higgsfield-bytes', 'utf-8')), {
    status: 200,
    headers: { 'content-type': 'image/jpeg' },
  })
}

function installFetch(handlers: Array<() => Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  let index = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), ...(init ? { init } : {}) })
      const handler = handlers[Math.min(index, handlers.length - 1)]
      index += 1
      return (handler as () => Response)()
    }),
  )
  return calls
}

function unwrapClient(config: Config = CONFIG) {
  const created = createHiggsfieldImageClient(config, FAST_POLLING)
  if (!created.success) {
    throw created.error
  }
  return created.data
}

describe('createHiggsfieldImageClient', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('should fail with a configuration error when the credential is missing', () => {
    const result = createHiggsfieldImageClient({ ...CONFIG, higgsfieldApiKey: '' })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.message).toContain('HIGGSFIELD_API_KEY')
    }
  })

  it('should reject a credential that is missing the key secret', () => {
    // Arrange: Higgsfield authenticates with an id and a secret, not one token
    const result = createHiggsfieldImageClient({ ...CONFIG, higgsfieldApiKey: 'only-an-id' })

    // Assert
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.suggestion).toContain('keyId:keySecret')
    }
  })

  it('should submit, poll the returned status URL, and download the image', async () => {
    // Arrange
    const calls = installFetch([
      () => jsonResponse({ status: 'queued', request_id: 'req_1', status_url: STATUS_URL }),
      () => jsonResponse({ status: 'queued' }),
      () => jsonResponse({ status: 'completed', images: [{ url: IMAGE_URL }] }),
      () => imageResponse(),
    ])

    // Act
    const result = await unwrapClient().generateImage({
      prompt: 'editorial portrait',
      aspectRatio: '4:3',
      imageSize: '2K',
    })

    // Assert
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.imageData.toString('utf-8')).toBe('higgsfield-bytes')
      expect(result.data.metadata.provider).toBe('higgsfield')
      expect(result.data.metadata.responseId).toBe('req_1')
    }

    const submitCall = calls[0]
    expect(submitCall?.url).toBe('https://platform.higgsfield.ai/higgsfield-ai/soul/standard')
    const headers = (submitCall?.init?.headers ?? {}) as Record<string, string>
    expect(headers['Authorization']).toBe('Key key-id:key-secret')
    expect(JSON.parse(String(submitCall?.init?.body))).toEqual({
      prompt: 'editorial portrait',
      aspect_ratio: '4:3',
      resolution: '1080p',
    })
    expect(calls[1]?.url).toBe(STATUS_URL)
    expect(calls[3]?.url).toBe(IMAGE_URL)
  })

  it.each([
    ['failed', 'failed'],
    ['canceled', 'canceled'],
  ])('should surface the %s terminal state', async (state, expected) => {
    // Arrange
    installFetch([
      () => jsonResponse({ status: 'queued', request_id: 'req_2', status_url: STATUS_URL }),
      () => jsonResponse({ status: state, error: 'upstream detail' }),
    ])

    // Act
    const result = await unwrapClient().generateImage({ prompt: 'a prompt' })

    // Assert
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.message).toContain(expected)
    }
  })

  it('should report a content block distinctly from a generic failure', async () => {
    // Arrange
    installFetch([
      () => jsonResponse({ status: 'queued', request_id: 'req_3', status_url: STATUS_URL }),
      () => jsonResponse({ status: 'nsfw' }),
    ])

    // Act
    const result = await unwrapClient().generateImage({ prompt: 'a prompt' })

    // Assert
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.message).toContain('unsafe content')
    }
  })

  it('should report rejected credentials rather than a generic failure', async () => {
    // Arrange
    installFetch([() => jsonResponse({ detail: 'unauthorized' }, 401)])

    // Act
    const result = await unwrapClient().generateImage({ prompt: 'a prompt' })

    // Assert
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.message).toContain('rejected the credentials')
    }
  })

  it('should refuse an input image, which this route does not accept', async () => {
    // Arrange
    const calls = installFetch([() => jsonResponse({ status: 'queued' })])

    // Act
    const result = await unwrapClient().generateImage({
      prompt: 'a prompt',
      inputImage: Buffer.from('x').toString('base64'),
    })

    // Assert
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.message).toContain('does not accept an input image')
    }
    expect(calls).toHaveLength(0)
  })

  it('should omit resolution when no image size is requested', async () => {
    // Arrange
    const calls = installFetch([
      () => jsonResponse({ status: 'queued', request_id: 'req_4', status_url: STATUS_URL }),
      () => jsonResponse({ status: 'completed', images: [{ url: IMAGE_URL }] }),
      () => imageResponse(),
    ])

    // Act
    await unwrapClient().generateImage({ prompt: 'a prompt' })

    // Assert
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ prompt: 'a prompt' })
  })
})
```

## `src/providers/kie/__tests__/capabilities.test.ts`

183 Zeilen

**Neu zu schreiben:** mcp

```ts
import { describe, expect, it } from 'vitest'
import type { AspectRatio } from '../../../types/mcp.js'
import { resolveKieCapabilities, validateKieCapabilities } from '../capabilities.js'
import { GENERATED_KIE_MODELS } from '../models.generated.js'
import { DEFAULT_KIE_MODEL, getKieModel, VERIFIED_KIE_MODELS } from '../models.js'

describe('resolveKieCapabilities', () => {
  it('should default to 1K for a model that has a resolution parameter', () => {
    // Act
    const result = resolveKieCapabilities('nano-banana-2', {})

    // Assert
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.resolution).toBe('1K')
      expect(result.data.modelId).toBe('nano-banana-2')
      expect(result.data.passthrough).toBe(false)
    }
  })

  it('should accept the extreme ratios that only nano-banana-2 offers', () => {
    // Act & Assert
    for (const aspectRatio of ['1:4', '4:1', '1:8', '8:1'] as AspectRatio[]) {
      expect(resolveKieCapabilities('nano-banana-2', { aspectRatio }).success).toBe(true)
      expect(resolveKieCapabilities('gpt-image-2', { aspectRatio }).success).toBe(false)
    }
  })

  it('should select the editing route and its model-specific field name', () => {
    // Act
    const gpt = resolveKieCapabilities('gpt-image-2', { hasInputImage: true })
    const nano = resolveKieCapabilities('nano-banana-2', { hasInputImage: true })
    const grok = resolveKieCapabilities('grok-imagine', { hasInputImage: true })

    // Assert: three models, three different field names
    expect(gpt.success && gpt.data.modelId).toBe('gpt-image-2-image-to-image')
    expect(gpt.success && gpt.data.model.imageInputField).toBe('input_urls')
    expect(nano.success && nano.data.model.imageInputField).toBe('image_input')
    expect(grok.success && grok.data.model.imageInputField).toBe('image_urls')
  })

  it('should refuse editing for a model that only generates', () => {
    // Act: Imagen 4 has no editing route
    const result = resolveKieCapabilities('google/imagen4', { hasInputImage: true })

    // Assert
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.message).toContain('cannot edit')
    }
  })

  it('should refuse generation for a model that only edits', () => {
    // Act: the qwen edit route has no text-to-image model id to send
    const result = resolveKieCapabilities('qwen/image-edit', {})

    // Assert
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.message).toContain('only edits')
    }
  })

  it('should reject an image size for a model with no resolution parameter', () => {
    // Act: Grok exposes no resolution parameter at all
    const result = resolveKieCapabilities('grok-imagine', { imageSize: '2K' })

    // Assert
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.message).toContain('no image size parameter')
    }
  })

  it('should reject 4K at a square ratio for gpt-image-2, which has no such route', () => {
    // Act
    const result = resolveKieCapabilities('gpt-image-2', { aspectRatio: '1:1', imageSize: '4K' })

    // Assert
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.message).toContain('no 4K route at 1:1')
    }
  })

  it.each([
    ['nano-banana-2', 'jpg'],
    ['google/nano-banana', 'jpeg'],
  ])('should spell the output format the way %s expects', (model, expected) => {
    // Act
    const result = resolveKieCapabilities(model, { preferredOutputFormat: 'jpeg' })

    // Assert
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.outputFormat).toBe(expected)
    }
  })

  it('should omit the output format for a model that has no such parameter', () => {
    const result = resolveKieCapabilities('gpt-image-2', { preferredOutputFormat: 'jpeg' })

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.outputFormat).toBeUndefined()
    }
  })

  describe('unverified models', () => {
    it('should pass an unknown model id through rather than rejecting it', () => {
      // Act
      const result = resolveKieCapabilities('some/newly-launched-model', { aspectRatio: '16:9' })

      // Assert
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.passthrough).toBe(true)
        expect(result.data.modelId).toBe('some/newly-launched-model')
        expect(result.data.aspectRatio).toBe('16:9')
        expect(result.data.resolution).toBeUndefined()
      }
    })

    it('should refuse editing, because the input-image field name is unknown', () => {
      // Act
      const result = resolveKieCapabilities('some/newly-launched-model', { hasInputImage: true })

      // Assert
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.message).toContain('unlisted')
        expect(result.error.suggestion).toContain('nano-banana-2')
      }
    })
  })
})

describe('the generated model table', () => {
  it('should use a default that is itself in the table', () => {
    expect(VERIFIED_KIE_MODELS).toContain(DEFAULT_KIE_MODEL)
  })

  it('should give every editing-capable model an input field name', () => {
    // The field name differs per model and cannot be guessed, so a descriptor
    // that offers editing without naming it would build a broken request.
    for (const [name, model] of Object.entries(GENERATED_KIE_MODELS)) {
      if ('imageToImage' in model) {
        expect(
          (model as { imageInputField?: string }).imageInputField,
          `${name} can edit but names no input field`,
        ).toBeDefined()
      }
    }
  })

  it('should give every model at least one usable route', () => {
    for (const [name, model] of Object.entries(GENERATED_KIE_MODELS)) {
      const routes = 'textToImage' in model || 'imageToImage' in model
      expect(routes, `${name} has neither a generate nor an edit route`).toBe(true)
    }
  })

  it('should carry the prose-only constraint that the schema cannot express', () => {
    // gpt-image-2's missing 1:1 4K route is documented in prose, so it is
    // layered on by hand rather than generated.
    expect(getKieModel('gpt-image-2')?.unavailable).toEqual([
      { aspectRatio: '1:1', resolution: '4K', reason: 'this model has no 4K route at 1:1' },
    ])
  })
})

describe('validateKieCapabilities', () => {
  it('should pass for a supported combination', () => {
    expect(
      validateKieCapabilities('nano-banana-2', { aspectRatio: '4:3', imageSize: '2K' }).success,
    ).toBe(true)
  })

  it('should fail for an unsupported combination', () => {
    expect(validateKieCapabilities('gpt-image-2', { aspectRatio: '8:1' }).success).toBe(false)
  })
})
```

## `src/providers/kie/__tests__/imageClient.test.ts`

248 Zeilen

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Config } from '../../../types/config.js'
import { createKieImageClient } from '../imageClient.js'

const CONFIG: Config = {
  imageProvider: 'kie',
  geminiApiKey: '',
  openaiApiKey: '',
  arkApiKey: '',
  kieApiKey: 'test-kie-api-key',
  higgsfieldApiKey: '',
  imageModels: {},
  imageOutputDir: './output',
  skipPromptEnhancement: true,
  imageQuality: 'fast',
}

const IMAGE_URL = 'https://files.kie.test/generated.png'
const IMAGE_BYTES = Buffer.from('kie-image-bytes', 'utf-8')

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function imageResponse(): Response {
  return new Response(new Uint8Array(IMAGE_BYTES), {
    status: 200,
    headers: { 'content-type': 'image/png' },
  })
}

function envelope(data: unknown) {
  return { code: 200, msg: 'success', data }
}

/** Records every call so request shape can be asserted. */
function installFetch(handlers: Array<(url: string, init?: RequestInit) => Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  let index = 0
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, ...(init ? { init } : {}) })
    const handler = handlers[Math.min(index, handlers.length - 1)]
    index += 1
    return (handler as (url: string, init?: RequestInit) => Response)(url, init)
  })
  vi.stubGlobal('fetch', fetchMock)
  return calls
}

/** Poll fast so the suite does not wait on the production cadence. */
const FAST_POLLING = { initialDelayMs: 1, maxDelayMs: 4, backoffFactor: 1, timeoutMs: 2_000 }

function unwrapClient(config: Config = CONFIG) {
  const created = createKieImageClient(config, FAST_POLLING)
  if (!created.success) {
    throw created.error
  }
  return created.data
}

describe('createKieImageClient', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('should fail with a configuration error when the key is missing', () => {
    // Act
    const result = createKieImageClient({ ...CONFIG, kieApiKey: '' })

    // Assert
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.message).toContain('KIE_API_KEY')
    }
  })

  it('should create a task, poll it, and download the finished image', async () => {
    // Arrange
    const calls = installFetch([
      () => jsonResponse(envelope({ taskId: 'task_1' })),
      () => jsonResponse(envelope({ state: 'generating', progress: 30 })),
      () =>
        jsonResponse(
          envelope({ state: 'success', resultJson: JSON.stringify({ resultUrls: [IMAGE_URL] }) }),
        ),
      () => imageResponse(),
    ])

    // Act
    const result = await unwrapClient().generateImage({
      prompt: 'a red bicycle',
      aspectRatio: '16:9',
      imageSize: '2K',
    })

    // Assert
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.imageData.toString('utf-8')).toBe('kie-image-bytes')
      expect(result.data.metadata.provider).toBe('kie')
      expect(result.data.metadata.model).toBe('nano-banana-2')
      expect(result.data.metadata.mimeType).toBe('image/png')
      expect(result.data.metadata.responseId).toBe('task_1')
    }

    const createCall = calls[0]
    expect(createCall).toBeDefined()
    expect(createCall?.url).toContain('/api/v1/jobs/createTask')
    expect(JSON.parse(String(createCall?.init?.body))).toEqual({
      model: 'nano-banana-2',
      input: { prompt: 'a red bicycle', aspect_ratio: '16:9', resolution: '2K' },
    })
    const headers = (createCall?.init?.headers ?? {}) as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer test-kie-api-key')
    expect(calls[1]?.url).toContain('/api/v1/jobs/recordInfo?taskId=task_1')
    expect(calls[3]?.url).toBe(IMAGE_URL)
  })

  it('should upload a local input image and switch to the editing model', async () => {
    // Arrange
    const calls = installFetch([
      () => jsonResponse(envelope({ downloadUrl: 'https://files.kie.test/input.png' })),
      () => jsonResponse(envelope({ taskId: 'task_2' })),
      () =>
        jsonResponse(
          envelope({ state: 'success', resultJson: JSON.stringify({ resultUrls: [IMAGE_URL] }) }),
        ),
      () => imageResponse(),
    ])

    // Act
    const result = await unwrapClient().generateImage({
      prompt: 'make it night',
      inputImage: Buffer.from('input').toString('base64'),
      inputImageMimeType: 'image/png',
    })

    // Assert
    expect(result.success).toBe(true)
    expect(calls[0]?.url).toContain('/api/file-base64-upload')

    const createBody = JSON.parse(String(calls[1]?.init?.body))
    expect(createBody.model).toBe('nano-banana-2')
    expect(createBody.input.image_input).toEqual(['https://files.kie.test/input.png'])
  })

  it('should send a single URL string to a model that expects one', async () => {
    // Arrange: qwen names the field image_url and takes a string, not an array
    const calls = installFetch([
      () => jsonResponse(envelope({ downloadUrl: 'https://files.kie.test/input.png' })),
      () => jsonResponse(envelope({ taskId: 'task_5' })),
      () =>
        jsonResponse(
          envelope({ state: 'success', resultJson: JSON.stringify({ resultUrls: [IMAGE_URL] }) }),
        ),
      () => imageResponse(),
    ])

    // Act
    await unwrapClient().generateImage({
      prompt: 'make it night',
      model: 'qwen',
      inputImage: Buffer.from('input').toString('base64'),
      inputImageMimeType: 'image/png',
    })

    // Assert
    const createBody = JSON.parse(String(calls[1]?.init?.body))
    expect(createBody.input.image_url).toBe('https://files.kie.test/input.png')
  })

  it('should surface a failed job with the provider reason', async () => {
    // Arrange
    installFetch([
      () => jsonResponse(envelope({ taskId: 'task_3' })),
      () => jsonResponse(envelope({ state: 'fail', failCode: '500', failMsg: 'content rejected' })),
    ])

    // Act
    const result = await unwrapClient().generateImage({ prompt: 'a prompt' })

    // Assert
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.message).toContain('failed')
      expect(result.error.context?.['upstreamMessage']).toContain('content rejected')
    }
  })

  it('should report a rejected API key rather than a generic failure', async () => {
    // Arrange
    installFetch([() => jsonResponse({ code: 401, msg: 'unauthorized' }, 401)])

    // Act
    const result = await unwrapClient().generateImage({ prompt: 'a prompt' })

    // Assert
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.message).toContain('rejected the API key')
    }
  })

  it('should reject an aspect ratio the model does not offer before calling the API', async () => {
    // Arrange
    const calls = installFetch([() => jsonResponse(envelope({ taskId: 'never' }))])

    // Act
    const result = await unwrapClient().generateImage({
      prompt: 'a prompt',
      model: 'gpt-image-2',
      aspectRatio: '8:1',
    })

    // Assert
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.message).toContain('8:1')
    }
    expect(calls).toHaveLength(0)
  })

  it('should fail when the job succeeds but carries no image URL', async () => {
    // Arrange
    installFetch([
      () => jsonResponse(envelope({ taskId: 'task_4' })),
      () => jsonResponse(envelope({ state: 'success', resultJson: JSON.stringify({}) })),
    ])

    // Act
    const result = await unwrapClient().generateImage({ prompt: 'a prompt' })

    // Assert
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.message).toContain('no image URL')
    }
  })
})
```

## `src/providers/shared/__tests__/polling.test.ts`

73 Zeilen

```ts
import { describe, expect, it, vi } from 'vitest'
import { pollUntilDone } from '../polling.js'

const FAST = { initialDelayMs: 1, maxDelayMs: 4, backoffFactor: 2, timeoutMs: 1_000 }

describe('pollUntilDone', () => {
  it('should return the value once the job reports completion', async () => {
    // Arrange
    const check = vi
      .fn()
      .mockResolvedValueOnce({ done: false })
      .mockResolvedValueOnce({ done: false, progress: 40 })
      .mockResolvedValueOnce({ done: true, value: 'https://example.test/image.png' })

    // Act
    const result = await pollUntilDone(check, FAST)

    // Assert
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toBe('https://example.test/image.png')
    }
    expect(check).toHaveBeenCalledTimes(3)
  })

  it('should stop with a network error when the job never finishes', async () => {
    // Arrange
    const check = vi.fn().mockResolvedValue({ done: false })

    // Act
    const result = await pollUntilDone(check, { ...FAST, timeoutMs: 25 })

    // Assert
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.code).toBe('NETWORK_ERROR')
      expect(result.error.message).toContain('did not finish')
    }
    expect(check).toHaveBeenCalled()
  })

  it('should back off between checks up to the configured maximum', async () => {
    // Arrange
    const timestamps: number[] = []
    const check = vi.fn().mockImplementation(async () => {
      timestamps.push(Date.now())
      return timestamps.length < 4 ? { done: false } : { done: true, value: 'done' }
    })

    // Act
    await pollUntilDone(check, {
      initialDelayMs: 10,
      maxDelayMs: 30,
      backoffFactor: 2,
      timeoutMs: 5_000,
    })

    // Assert: gaps grow rather than staying flat
    const gaps = timestamps.slice(1).map((value, index) => value - (timestamps[index] as number))
    expect(gaps.length).toBe(3)
    expect(gaps[1]).toBeGreaterThanOrEqual((gaps[0] as number) - 5)
    expect(Math.max(...gaps)).toBeLessThan(200)
  })

  it('should propagate an error thrown by the check', async () => {
    // Arrange
    const check = vi.fn().mockRejectedValue(new Error('provider exploded'))

    // Act & Assert
    await expect(pollUntilDone(check, FAST)).rejects.toThrow('provider exploded')
  })
})
```

## `src/utils/__tests__/configIsolation.test.ts`

50 Zeilen

```ts
/**
 * Guards the test harness itself.
 *
 * Configuration reads a per-machine config file, so without isolation a
 * developer who has run `init` would have their real default provider and real
 * API keys visible inside the suite. That makes tests machine-dependent and,
 * because some providers are reached over the network, can turn a test run
 * into billable API calls. `vitest.setup.mjs` prevents that; this file fails if
 * that setup is ever removed or stops working.
 *
 * These tests deliberately do not override the config location themselves.
 */

import { describe, expect, it } from 'vitest'
import { getConfig } from '../config.js'

describe('test configuration isolation', () => {
  it('should point the config file layer at a throwaway directory', () => {
    const configHome = process.env['XDG_CONFIG_HOME']

    expect(configHome, 'vitest.setup.mjs did not set XDG_CONFIG_HOME').toBeDefined()
    expect(configHome).toContain('mcp-image-test-config-')
  })

  it('should not inherit provider credentials from the developer environment', () => {
    for (const key of [
      'GEMINI_API_KEY',
      'OPENAI_API_KEY',
      'ARK_API_KEY',
      'KIE_API_KEY',
      'HIGGSFIELD_API_KEY',
    ]) {
      expect(process.env[key], `${key} leaked into the test environment`).toBeUndefined()
    }
  })

  it('should resolve the built-in default provider rather than the machine default', () => {
    // Act: with nothing configured anywhere, loading must fail on gemini,
    // the built-in default. Seeing another provider here means a real config
    // file is being read.
    const result = getConfig()

    // Assert
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.message).toContain('GEMINI_API_KEY')
    }
  })
})
```

## `vitest.setup.mjs`

45 Zeilen

```js
/**
 * Isolates every test run from the machine's own configuration.
 *
 * Configuration resolves from the process environment, then `.env`, then a
 * per-machine config file. Without this, a developer who has run `init` would
 * see their real default provider and real API keys inside the test suite:
 * tests would behave differently per machine and, worse, could issue live
 * billable requests. Both layers are pointed at an empty temporary directory
 * so only what a test sets itself is ever visible.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const isolatedConfigHome = mkdtempSync(join(tmpdir(), 'mcp-image-test-config-'))

// The config file layer looks at XDG_CONFIG_HOME first, then APPDATA on win32.
process.env.XDG_CONFIG_HOME = isolatedConfigHome
process.env.APPDATA = isolatedConfigHome

// The remaining layer is a `.env` beside the working directory. It is read
// relative to process.cwd(), which the suite shares, so it cannot be redirected
// from here; the repository has none and .gitignore keeps it that way.

// Provider credentials are never inherited from the developer's shell.
for (const key of [
  'GEMINI_API_KEY',
  'OPENAI_API_KEY',
  'ARK_API_KEY',
  'KIE_API_KEY',
  'HIGGSFIELD_API_KEY',
  'IMAGE_PROVIDER',
  'IMAGE_QUALITY',
  'IMAGE_OUTPUT_DIR',
  'KIE_MODEL',
  'SKIP_PROMPT_ENHANCEMENT',
]) {
  delete process.env[key]
}

process.on('exit', () => {
  rmSync(isolatedConfigHome, { recursive: true, force: true })
})
```

---

# Was du selbst bauen musst

| Baustein                                                        | Spec | Grobe Größe |
| --------------------------------------------------------------- | ---- | ----------- |
| Result-Typ, Fehler-Taxonomie, Client-Interfaces, Logger         | §6.5 | ~400        |
| MIME-Erkennung, Pfadsicherheit, Dateiablage, Eingabevalidierung | §8   | ~600        |
| Prompt-Optimizer mit eigenen Leitlinien                         | §5   | ~350        |
| Provider-Registry                                               | §6.1 | ~100        |
| Adapter für Gemini, OpenAI, Seedream gegen deren Dokus          | §6   | ~1300       |
| MCP-Server-Hülle                                                | §1.2 | ~200        |
