/**
 * Interactive pieces shared by `init` and `config edit`.
 *
 * These live together because both commands ask the same questions, and a
 * model list that is pleasant in one and awkward in the other is a difference
 * nobody chose. Everything here writes to stderr through the prompt library,
 * so stdout stays free for the output contract.
 */

import { QUALITY_PRESETS, type MediaKind, type QualityPreset } from '../types/media.js'
import type { ProviderManifest } from '../types/provider.js'

/**
 * Above this many models a plain list stops being readable and starts being a
 * wall to scroll. Kie alone lists around thirty.
 */
const SEARCHABLE_FROM = 12

/** Sentinel for "no model configured", which is not the same as any model. */
export const PROVIDER_DEFAULT = Symbol('provider default')

export type ModelChoice = string | typeof PROVIDER_DEFAULT

/**
 * Asks which model a provider should use.
 *
 * Leaving it at the provider's default is offered first and deliberately
 * described, because it is the better answer for most people: the default
 * follows the quality preset, so it improves when the preset changes, and it
 * moves on when the provider adds a better model. Pinning one is a decision
 * to opt out of both.
 */
export async function pickModel(
  provider: ProviderManifest,
  kind: MediaKind,
  current: string | undefined,
): Promise<ModelChoice> {
  const models = provider.listModels(kind)
  if (models.length === 0) return PROVIDER_DEFAULT

  const { search, select } = await import('@inquirer/prompts')

  const defaultChoice = {
    name: `Use ${provider.label}'s default`,
    value: PROVIDER_DEFAULT as ModelChoice,
    description: 'Follows the quality preset, and keeps up when the provider adds models',
  }

  const modelChoices = models.map((model) => {
    const description = describe(model.note, model.aspectRatios?.length, model.sizes)
    return {
      name: model.id === current ? `${model.id}  (current)` : model.id,
      value: model.id,
      // Spread rather than assigned: under exactOptionalPropertyTypes an
      // explicit `undefined` is not the same as an absent property.
      ...(description === undefined ? {} : { description }),
    }
  })

  const message = `Which model should ${provider.label} use?`

  if (models.length < SEARCHABLE_FROM) {
    return await select({
      message,
      choices: [defaultChoice, ...modelChoices],
      ...(current === undefined ? {} : { default: current }),
    })
  }

  // With a long catalogue, typing a fragment beats scrolling past thirty ids.
  return await search({
    message: `${message} (type to filter)`,
    source: (term) => {
      const all = [defaultChoice, ...modelChoices]
      if (term === undefined || term.length === 0) return all
      const needle = term.toLowerCase()
      return all.filter((choice) => choice.name.toLowerCase().includes(needle))
    },
  })
}

function describe(
  note: string | undefined,
  ratioCount: number | undefined,
  sizes: readonly string[] | undefined,
): string | undefined {
  const facts = [
    note,
    ratioCount === undefined ? undefined : `${ratioCount} ratio${ratioCount === 1 ? '' : 's'}`,
    sizes === undefined ? undefined : sizes.join('/'),
  ].filter((fact): fact is string => fact !== undefined)

  return facts.length > 0 ? facts.join(' · ') : undefined
}

export async function pickProvider(
  providers: readonly ProviderManifest[],
  message: string,
  current: string | undefined,
): Promise<string> {
  const { select } = await import('@inquirer/prompts')

  return await select({
    message,
    choices: providers.map((provider) => ({
      name: provider.id === current ? `${provider.id}  (current)` : provider.id,
      value: provider.id,
      description: provider.label,
    })),
    ...(current === undefined ? {} : { default: current }),
  })
}

export async function pickQuality(current: QualityPreset): Promise<QualityPreset> {
  const { select } = await import('@inquirer/prompts')

  const descriptions: Record<QualityPreset, string> = {
    fast: 'Cheapest and quickest model the provider offers',
    balanced: 'A middle tier where the provider has one',
    quality: 'Best available, slower and more expensive',
  }

  return await select({
    message: 'Which quality preset?',
    choices: QUALITY_PRESETS.map((preset) => ({
      name: preset === current ? `${preset}  (current)` : preset,
      value: preset,
      description: descriptions[preset],
    })),
    default: current,
  })
}
