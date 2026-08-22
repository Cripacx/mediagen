/**
 * Prompt enhancement.
 *
 * Spec §5 — short prompts produce weak images, so a prompt is expanded into a
 * fuller description before generation unless disabled.
 *
 * Two rules shape everything here:
 *
 * - **It must never fail a generation.** Enhancement is a separate model call,
 *   and a separate call is a separate thing that can break. When it does, the
 *   original prompt is generated instead and a warning goes to stderr. A user
 *   who asked for an image should not be handed an error about a rewrite they
 *   never asked for.
 * - **The user's own words survive.** Enhancement fills in what was left
 *   unspecified. It may not contradict, drop, or reinterpret anything stated.
 *
 * The guidance below is this project's own. It is organised around what a
 * generation model can actually act on: a short prompt underdetermines the
 * image, and the model resolves that ambiguity arbitrarily unless told.
 */

import { loadTextClient } from '../providers/registry.js'
import type { GenerationRequest } from '../types/media.js'
import type { Logger, ProviderManifest } from '../types/provider.js'

/**
 * What a generation model needs decided, in the order it matters.
 *
 * Subject and action come first because everything else modifies them.
 * Lighting is third because it does more to determine whether an image reads
 * as photographic or synthetic than any other single choice. Camera and
 * materials are next because they resolve scale and surface, which are the
 * two things models most often get arbitrarily wrong. Atmosphere is last: it
 * is the easiest to over-apply, and an over-styled image is harder to use
 * than a plain one.
 */
const DIMENSIONS = [
  'Subject: what is present, and what it is doing.',
  'Composition: framing, where the subject sits, what surrounds it, depth.',
  'Light: source, direction, hardness, colour temperature, time of day.',
  'Camera or medium: lens and distance for a photograph; tool and surface for an illustration.',
  'Material and texture: what things are made of and how they catch light.',
  'Atmosphere: mood and palette, stated plainly rather than piled up.',
].join('\n- ')

function instruction(request: GenerationRequest): string {
  const hints: string[] = []

  if (request.purpose !== undefined) {
    hints.push(`It will be used for: ${request.purpose}. Let that guide framing and tone.`)
  }
  if (request.maintainCharacter === true) {
    hints.push(
      'A character must stay recognisable: describe their appearance concretely and consistently.',
    )
  }
  if (request.blendElements === true) {
    hints.push(
      'Several distinct elements must share one scene: state how they are arranged relative to each other, and give them one consistent light source.',
    )
  }
  if (request.realWorldAccuracy === true) {
    hints.push(
      'Real places, objects or conventions must be depicted accurately; prefer specific, checkable detail over evocative language.',
    )
  }

  const kindNote =
    request.kind === 'video'
      ? 'This is a video prompt, so also state camera movement and what changes over the shot. Describe one continuous shot unless the prompt says otherwise.'
      : 'This is a still image prompt.'

  return `Expand the image prompt below into a single fuller description.

Rules, in order of precedence:
1. Keep every element the writer stated. Do not contradict, remove, or reinterpret any of it. If they said "red bicycle", it stays a red bicycle.
2. Only add what they left unspecified.
3. If the prompt is already specific about something, leave it alone.
4. Do not invent text, logos, brands, or named people who were not asked for.

Decide what the prompt leaves open, across:
- ${DIMENSIONS}

${kindNote}
${hints.length > 0 ? `\nAdditional constraints:\n- ${hints.join('\n- ')}\n` : ''}
Answer with the expanded prompt and nothing else: no preamble, no explanation,
no quotation marks, no list. Two to four sentences.

Prompt: ${request.prompt}`
}

export interface EnhanceOptions {
  readonly provider: ProviderManifest
  readonly apiKey: string
  readonly log: Logger
  readonly signal?: AbortSignal
}

/**
 * Returns the prompt to generate with — expanded when that worked, the
 * original otherwise. Never throws.
 */
export async function enhancePrompt(
  request: GenerationRequest,
  options: EnhanceOptions,
): Promise<string> {
  const { provider, log } = options

  // §5: a provider with no text model skips enhancement rather than demanding
  // credentials for a second provider. Reaching across providers here would
  // turn one configured key into two, silently.
  const client = await loadTextClient(provider).catch(() => undefined)
  if (!client) {
    log.debug(`${provider.id} exposes no text model; generating with the original prompt`)
    return request.prompt
  }

  const textModel = provider.textModel
  if (textModel === undefined) {
    log.debug(`${provider.id} names no enhancement model; generating with the original prompt`)
    return request.prompt
  }

  try {
    const expanded = await client.complete(instruction(request), {
      apiKey: options.apiKey,
      model: textModel,
      log,
      ...(options.signal ? { signal: options.signal } : {}),
    })

    const cleaned = clean(expanded)
    if (cleaned.length === 0) {
      log.warn('Prompt enhancement returned nothing; generating with the original prompt.')
      return request.prompt
    }

    log.debug(`enhanced prompt: ${cleaned}`)
    return cleaned
  } catch (error) {
    // §5: never fail a generation because enhancement failed.
    log.warn(`Prompt enhancement failed (${describe(error)}); generating with the original prompt.`)
    return request.prompt
  }
}

/**
 * Models sometimes wrap the answer despite being told not to. Stripping a
 * matched pair of quotes and a leading label is worth doing; anything more
 * aggressive risks removing something the model was right to include.
 */
function clean(text: string): string {
  let result = text.trim()
  result = result.replace(/^(?:enhanced\s+prompt|prompt)\s*:\s*/i, '').trim()
  if (result.length > 1 && /^["'`]/.test(result) && result.at(-1) === result[0]) {
    result = result.slice(1, -1).trim()
  }
  return result
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error'
}
