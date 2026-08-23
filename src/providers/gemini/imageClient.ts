/**
 * Gemini image generation, over the Interactions API.
 *
 * Loaded lazily by the manifest, so importing the registry never pulls
 * the SDK into a `doctor` or `config` run.
 */

import { ERROR_CODE, MediagenError } from '../../core/errors.js'
import { loadInputMedia } from '../../core/inputMedia.js'
import { createGenAI, mapGeminiError } from './client.js'
import type { GenerationClient, GenerationClientFactory } from '../../types/provider.js'

/** One entry in the interaction's `input` array. */
type InputPart = { type: 'text'; text: string } | { type: 'image'; mime_type: string; data: string }

export const createImageClient: GenerationClientFactory = (): GenerationClient => ({
  async generate(request, options) {
    const input: InputPart[] = [{ type: 'text', text: request.prompt }]

    // Gemini takes source media inline, base64, in the same input array
    // under `data` with an explicit `mime_type`. There is no upload step.
    if (request.inputMedia !== undefined) {
      const source = await loadInputMedia(request.inputMedia)
      input.push({
        type: 'image',
        mime_type: source.mimeType,
        data: Buffer.from(source.data).toString('base64'),
      })
    }

    const responseFormat: Record<string, unknown> = { type: 'image' }
    if (request.aspectRatio !== undefined) responseFormat['aspect_ratio'] = request.aspectRatio
    if (request.size !== undefined) responseFormat['image_size'] = request.size

    options.log.debug(`gemini: requesting ${options.model}`)

    let interaction: unknown
    try {
      interaction = await createGenAI(options.apiKey).interactions.create({
        model: options.model,
        input: input,
        response_format: responseFormat,
      })
    } catch (error) {
      mapGeminiError(error)
    }

    const parts = collectContent(interaction)
    const image = parts.find((part) => part.type === 'image')

    if (!image) {
      // A response carrying only text is how Gemini declines without an HTTP
      // error: it explains itself instead of generating. Reporting that as an
      // API failure would send the user looking in the wrong place.
      const explanation = parts.find((part) => part.type === 'text')
      throw new MediagenError(
        ERROR_CODE.CONTENT_BLOCKED,
        'Gemini returned no image for this prompt.',
        {
          hint: 'Rephrase the prompt, or try another provider.',
          ...(explanation?.type === 'text' ? { cause: explanation.text } : {}),
        },
      )
    }

    const id = idOf(interaction)

    return {
      data: Buffer.from(image.data, 'base64'),
      mimeType: image.mime_type,
      ...(id === undefined ? {} : { requestId: id }),
    }
  },
})

/**
 * Flattens the interaction's steps into their content parts.
 *
 * Indexing a fixed position would be wrong: the response carries reasoning
 * steps alongside output, and how many depends on the model's thinking. The
 * part we want is identified by its type, not by where it sits.
 */
function collectContent(interaction: unknown): InputPart[] {
  if (typeof interaction !== 'object' || interaction === null) return []
  const steps: unknown = (interaction as { steps?: unknown }).steps
  if (!Array.isArray(steps)) return []

  return steps.flatMap((step: unknown): InputPart[] => {
    if (typeof step !== 'object' || step === null) return []
    const content: unknown = (step as { content?: unknown }).content
    return Array.isArray(content) ? (content as InputPart[]) : []
  })
}

function idOf(interaction: unknown): string | undefined {
  if (typeof interaction !== 'object' || interaction === null) return undefined
  const id: unknown = (interaction as { id?: unknown }).id
  return typeof id === 'string' ? id : undefined
}
