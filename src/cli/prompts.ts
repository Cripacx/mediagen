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

/**
 * Builds a preference order by asking for one provider at a time.
 *
 * Repeated single choices rather than a reorderable list: the prompt library
 * has no drag-to-reorder, and "which do you want first" is a question people
 * answer without being taught anything. Stopping early is allowed — whatever
 * is left keeps its existing order behind the choices made, because the list
 * expresses preference and never restricts what may be used.
 */
export async function pickPriority(
  providers: readonly ProviderManifest[],
  current: readonly string[],
  configured: (providerId: string) => boolean,
): Promise<string[]> {
  const { select } = await import('@inquirer/prompts')

  const ordered: string[] = []
  const remaining = [...current.filter((id) => providers.some((p) => p.id === id))]
  for (const provider of providers) {
    if (!remaining.includes(provider.id)) remaining.push(provider.id)
  }

  const DONE = Symbol('done')

  while (remaining.length > 1) {
    const position = ordered.length + 1
    const choice = await select<string | typeof DONE>({
      message: position === 1 ? 'Which provider first?' : `Which provider ${nth(position)}?`,
      choices: [
        ...remaining.map((id) => {
          const label = providers.find((entry) => entry.id === id)?.label
          return {
            name: configured(id) ? id : `${id}  (no key yet)`,
            value: id,
            ...(label === undefined ? {} : { description: label }),
          }
        }),
        {
          name: `Keep the rest as they are  (${remaining.join(', ')})`,
          value: DONE,
          description: 'Stop here; the remaining providers keep their current order',
        },
      ],
    })

    if (choice === DONE) break

    ordered.push(choice)
    remaining.splice(remaining.indexOf(choice), 1)
  }

  return [...ordered, ...remaining]
}

function nth(position: number): string {
  return { 2: 'second', 3: 'third', 4: 'fourth', 5: 'fifth' }[position] ?? `number ${position}`
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

export interface MarkingDefaults {
  readonly mark: boolean
  readonly visibleLabel: boolean
}

/**
 * Asks how generated media should be marked by default.
 *
 * One question rather than two yes/no prompts, because the three sensible
 * combinations are a ladder and the fourth — a visible label with no
 * machine-readable marker — is not something anyone means to choose.
 */
export async function pickMarking(current: MarkingDefaults): Promise<MarkingDefaults> {
  const { select } = await import('@inquirer/prompts')

  const options: ReadonlyArray<{ name: string; value: MarkingDefaults; description: string }> = [
    {
      name: 'No marking',
      value: { mark: false, visibleLabel: false },
      description: 'Nothing is added; you can still pass --mark per command',
    },
    {
      name: 'Machine-readable marker',
      value: { mark: true, visibleLabel: false },
      description: 'IPTC/XMP DigitalSourceType, which platforms read. Changes no pixels',
    },
    {
      name: 'Machine-readable marker and a visible label',
      value: { mark: true, visibleLabel: true },
      description: 'Also composites "AI-generated" into the image itself',
    },
  ]

  const matches = (value: MarkingDefaults): boolean =>
    value.mark === current.mark && value.visibleLabel === current.visibleLabel

  const chosen = await select({
    message: 'Mark generated media as AI-generated by default?',
    choices: options.map((option) => ({
      name: matches(option.value) ? `${option.name}  (current)` : option.name,
      value: option.value,
      description: option.description,
    })),
    default: options.find((option) => matches(option.value))?.value,
  })

  return chosen
}
