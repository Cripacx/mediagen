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
import type { Resolved, ResolvedConfig } from '../types/config.js'
import type { QualityPreset } from '../types/media.js'
import type { ProviderManifest } from '../types/provider.js'

/** Kept together so the set of settings is visible at a glance. */
export const ENV_VARS = {
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

  const defaultProvider =
    resolve(layers, ENV_VARS.provider, file.defaultProvider) ??
    fromDefault<string>(BUILT_IN_DEFAULT_PROVIDER)

  const outputDir =
    resolve(layers, ENV_VARS.outputDir, file.outputDir) ?? fromDefault(CONFIG_DEFAULTS.outputDir)

  const rawQuality = resolve(layers, ENV_VARS.quality, file.quality, isQualityPreset)
  const quality: Resolved<QualityPreset> =
    rawQuality && isQualityPreset(rawQuality.value)
      ? { ...rawQuality, value: rawQuality.value }
      : fromDefault(CONFIG_DEFAULTS.quality)

  return {
    defaultProvider,
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
 * The tool must run if at least one provider is usable, and when
 * none is, report the configured default provider's own error.
 */
export function assertSomeProviderUsable(config: ResolvedConfig): void {
  const usable = PROVIDERS.some((provider) => config.apiKey(provider.id) !== undefined)
  if (usable) return

  const fallback =
    findProvider(config.defaultProvider.value) ?? findProvider(BUILT_IN_DEFAULT_PROVIDER)
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
