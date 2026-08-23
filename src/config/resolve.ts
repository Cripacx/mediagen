/**
 * Turning the three layers into the settings a run actually uses.
 *
 * This is lazy rather than eager for one reason. A request may name
 * any provider, so credentials cannot be validated up front against one
 * configured provider: the tool must start if *at least one* provider is
 * usable, and validate a provider's key at the moment that provider is used.
 */

import { ERROR_CODE, MediagenError } from '../core/errors.js'
import { command } from '../core/invocation.js'
import { PROVIDERS, findProvider, BUILT_IN_DEFAULT_PROVIDER } from '../providers/registry.js'
import { CONFIG_DEFAULTS } from '../types/config.js'
import { isQualityPreset } from '../types/media.js'
import { fromDefault, loadConfigLayers, resolve, type ConfigLayers } from './layers.js'
import type { ConfigLayer, Resolved, ResolvedConfig } from '../types/config.js'
import type { MediaKind, QualityPreset } from '../types/media.js'
import type { ProviderManifest } from '../types/provider.js'

/** Kept together so the set of settings is visible at a glance. */
export const ENV_VARS = {
  providerPriority: 'MEDIAGEN_PROVIDER_PRIORITY',
  provider: 'MEDIAGEN_PROVIDER',
  outputDir: 'MEDIAGEN_OUTPUT_DIR',
  quality: 'MEDIAGEN_QUALITY',
  mark: 'MEDIAGEN_MARK',
  visibleLabel: 'MEDIAGEN_VISIBLE_LABEL',
} as const

/** `<PROVIDER>_MODEL`, derived so a new provider needs no edit here. */
export function modelEnvVar(providerId: string): string {
  return `${providerId.toUpperCase()}_MODEL`
}

export function loadConfig(layers: ConfigLayers = loadConfigLayers()): ResolvedConfig {
  const file = layers.file

  const providerPriority = resolveProviderPriority(layers)

  const outputDir =
    resolve(layers, ENV_VARS.outputDir, file.outputDir) ?? fromDefault(CONFIG_DEFAULTS.outputDir)

  const rawQuality = resolve(layers, ENV_VARS.quality, file.quality, isQualityPreset)
  const quality: Resolved<QualityPreset> =
    rawQuality && isQualityPreset(rawQuality.value)
      ? { ...rawQuality, value: rawQuality.value }
      : fromDefault(CONFIG_DEFAULTS.quality)

  return {
    providerPriority,
    outputDir,
    quality,
    mark: resolveBoolean(layers, ENV_VARS.mark, file.mark, CONFIG_DEFAULTS.mark),
    visibleLabel: resolveBoolean(
      layers,
      ENV_VARS.visibleLabel,
      file.visibleLabel,
      CONFIG_DEFAULTS.visibleLabel,
    ),
    apiKey(providerId) {
      const provider = findProvider(providerId)
      if (!provider) return undefined
      return resolve(layers, provider.credential.envVar, file.apiKeys?.[providerId])
    },
    model(providerId) {
      return resolve(layers, modelEnvVar(providerId), file.models?.[providerId])
    },
  }
}

/**
 * The preference order, read from whichever layer states one.
 *
 * A single `defaultProvider` — the setting this replaced — reads as a
 * one-entry list, so a config file written before the list existed keeps
 * meaning what it meant. Both spellings are accepted from every layer, the
 * list winning where a layer holds both, since it is the more specific
 * statement.
 *
 * The result always names every registered provider: what was configured
 * first, in the order given, then the rest. The list expresses preference and
 * must not become a whitelist — a provider left out of it is still better than
 * failing a request nothing else can serve.
 */
export function resolveProviderPriority(layers: ConfigLayers): Resolved<readonly string[]> {
  const listed =
    resolve(layers, ENV_VARS.providerPriority, joinList(layers.file.providerPriority)) ??
    resolve(layers, ENV_VARS.provider, layers.file.defaultProvider)

  const named = listed === undefined ? [] : known(splitList(listed.value))

  // A setting that named nothing known is not a setting: reporting the layer
  // it came from would credit it with a preference it did not express.
  if (listed === undefined || named.length === 0) return fromDefault<readonly string[]>([])

  return { ...listed, value: named }
}

/**
 * The complete order: what was asked for, then everything else.
 *
 * Kept separate from the setting itself so "the user chose this" stays
 * distinguishable from "this is merely what was left". Reporting the whole
 * list as the setting would claim a preference for providers nobody named.
 */
export function providerOrder(config: ResolvedConfig): readonly string[] {
  const named = config.providerPriority.value
  return [...named, ...PROVIDER_ORDER.filter((id) => !named.includes(id))]
}

/** Registry order, which is the preference when nothing is configured. */
const PROVIDER_ORDER: readonly string[] = [
  BUILT_IN_DEFAULT_PROVIDER,
  ...PROVIDERS.map((provider) => provider.id).filter((id) => id !== BUILT_IN_DEFAULT_PROVIDER),
]

/** Accepts commas or spaces, since both are what people type. */
function splitList(value: string): string[] {
  return value
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
}

function joinList(value: readonly string[] | undefined): string | undefined {
  return value === undefined || value.length === 0 ? undefined : value.join(',')
}

/** Drops unknown names and duplicates, keeping the first mention of each. */
function known(ids: readonly string[]): string[] {
  const seen = new Set<string>()
  return ids.filter((id) => {
    if (seen.has(id) || findProvider(id) === undefined) return false
    seen.add(id)
    return true
  })
}

/**
 * Validated when the provider is actually used, with an error
 * naming the exact variable and the exact command that fixes it.
 */
export function requireApiKey(config: ResolvedConfig, provider: ProviderManifest): string {
  const resolved = config.apiKey(provider.id)
  const { envVar, description, minLength, signupUrl } = provider.credential

  if (!resolved) {
    throw new MediagenError(
      ERROR_CODE.CONFIG_ERROR,
      `No API key for ${provider.label}. Set ${envVar} to ${description}.`,
      {
        hint: `Run: ${command(`config set ${provider.id}`)}${signupUrl ? ` — get a key at ${signupUrl}` : ''}`,
      },
    )
  }

  if (minLength !== undefined && resolved.value.length < minLength) {
    throw new MediagenError(
      ERROR_CODE.CONFIG_ERROR,
      `The ${provider.label} key from ${resolved.layer} is too short to be valid.`,
      { hint: `Run: ${command(`config set ${provider.id}`)}` },
    )
  }

  return resolved.value
}

/**
 * Where a provider stands for a given job: can it do this at all, is it
 * configured, and how much does the user want it.
 *
 * This is what a caller needs before choosing anything — an agent picking a
 * model, `mediagen models` reporting, the pipeline resolving a default. All
 * three answered it differently before, and only the pipeline was right.
 */
export interface ProviderStanding {
  readonly provider: ProviderManifest
  /** Does this provider do this kind of media at all. */
  readonly supportsKind: boolean
  /** Is there a credential for it. Not whether the credential works. */
  readonly configured: boolean
  /** Which layer supplied the credential. */
  readonly keyLayer?: ConfigLayer
  /** Configured and able to do the job. */
  readonly usable: boolean
  /** Was it named in the priority list, rather than merely following it. */
  readonly preferred: boolean
}

/**
 * Every provider, in preference order, annotated with what stands in its way.
 *
 * Nothing is filtered out. A provider that cannot be used is more useful
 * reported as unusable than omitted: it is the difference between an agent
 * saying "add an OpenAI key and this becomes possible" and an agent believing
 * OpenAI does not exist.
 */
export function providerStandings(
  config: ResolvedConfig,
  kind?: MediaKind,
): readonly ProviderStanding[] {
  const named = config.providerPriority.value.length

  return providerOrder(config).flatMap((id, index) => {
    const provider = findProvider(id)
    if (!provider) return []

    const key = config.apiKey(id)
    const supportsKind = kind === undefined || provider.kinds.includes(kind)

    return [
      {
        provider,
        supportsKind,
        configured: key !== undefined,
        ...(key === undefined ? {} : { keyLayer: key.layer }),
        usable: key !== undefined && supportsKind,
        // Only the entries the user actually listed; the rest were appended to
        // keep the order complete and were never asked for.
        preferred: index < named,
      },
    ]
  })
}

/**
 * The provider a request gets when it does not name one.
 *
 * The first that is both wanted and able. Falling past an unusable provider
 * rather than failing on it is the whole point of an order: a missing OpenAI
 * key should not stop a job Gemini can do. When nothing is usable this
 * returns the most preferred provider that could at least do the job, so the
 * error the caller then gets names something worth configuring.
 */
export function preferredProvider(
  config: ResolvedConfig,
  kind?: MediaKind,
): ProviderManifest | undefined {
  const standings = providerStandings(config, kind)

  return (
    standings.find((standing) => standing.usable)?.provider ??
    standings.find((standing) => standing.supportsKind)?.provider
  )
}

/**
 * The tool must run if at least one provider is usable, and when
 * none is, report the configured default provider's own error.
 */
export function assertSomeProviderUsable(config: ResolvedConfig): void {
  const usable = PROVIDERS.some((provider) => config.apiKey(provider.id) !== undefined)
  if (usable) return

  const fallback = preferredProvider(config) ?? findProvider(BUILT_IN_DEFAULT_PROVIDER)
  if (!fallback) {
    throw new MediagenError(ERROR_CODE.CONFIG_ERROR, 'No providers are registered.', {
      hint: 'This is a defect, not a configuration problem.',
    })
  }

  requireApiKey(config, fallback)
}

/**
 * Resolves a flag across the layers.
 *
 * A value that means neither yes nor no is treated as absent rather than as
 * either, so a typo falls back to the documented default instead of quietly
 * turning a disclosure duty on or off.
 */
function resolveBoolean(
  layers: ConfigLayers,
  envVar: string,
  fileValue: boolean | undefined,
  fallback: boolean,
): Resolved<boolean> {
  const raw = resolve(
    layers,
    envVar,
    fileValue === undefined ? undefined : String(fileValue),
    (value) => parseBoolean(value) !== undefined,
  )
  if (!raw) return fromDefault(fallback)

  const parsed = parseBoolean(raw.value)
  return parsed === undefined ? fromDefault(fallback) : { ...raw, value: parsed }
}

/** Accepts what a person would plausibly write for either answer. */
export function parseBoolean(value: string): boolean | undefined {
  const normalised = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalised)) return true
  if (['0', 'false', 'no', 'off'].includes(normalised)) return false
  return undefined
}
