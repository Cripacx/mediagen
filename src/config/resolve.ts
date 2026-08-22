/**
 * Turning the three layers into the settings a run actually uses.
 *
 * Spec §3.3 is the reason this is lazy rather than eager. A request may name
 * any provider, so credentials cannot be validated up front against one
 * configured provider: the tool must start if *at least one* provider is
 * usable, and validate a provider's key at the moment that provider is used.
 */

import { ERROR_CODE, MediagenError } from '../core/errors.js'
import { PROVIDERS, findProvider, BUILT_IN_DEFAULT_PROVIDER } from '../providers/registry.js'
import { CONFIG_DEFAULTS } from '../types/config.js'
import { isQualityPreset } from '../types/media.js'
import { fromDefault, loadConfigLayers, resolve, type ConfigLayers } from './layers.js'
import type { Resolved, ResolvedConfig } from '../types/config.js'
import type { QualityPreset } from '../types/media.js'
import type { ProviderManifest } from '../types/provider.js'

/** Spec §3.2. Kept together so the set of settings is visible at a glance. */
export const ENV_VARS = {
  provider: 'MEDIAGEN_PROVIDER',
  outputDir: 'MEDIAGEN_OUTPUT_DIR',
  quality: 'MEDIAGEN_QUALITY',
  enhance: 'MEDIAGEN_ENHANCE',
} as const

/** Spec §3.2 — `<PROVIDER>_MODEL`, derived so a new provider needs no edit here. */
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

  const rawQuality = resolve(layers, ENV_VARS.quality, file.quality)
  const quality: Resolved<QualityPreset> =
    rawQuality && isQualityPreset(rawQuality.value)
      ? { ...rawQuality, value: rawQuality.value }
      : fromDefault(CONFIG_DEFAULTS.quality)

  const rawEnhance = resolve(
    layers,
    ENV_VARS.enhance,
    file.enhancePrompt === undefined ? undefined : String(file.enhancePrompt),
  )
  const enhancePrompt: Resolved<boolean> = rawEnhance
    ? { ...rawEnhance, value: !isFalsey(rawEnhance.value) }
    : fromDefault(CONFIG_DEFAULTS.enhancePrompt)

  return {
    defaultProvider,
    outputDir,
    quality,
    enhancePrompt,
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
 * Spec §3.3 — validated when the provider is actually used, with an error
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
        hint: `Run: mediagen config set ${provider.id}${signupUrl ? ` — get a key at ${signupUrl}` : ''}`,
      },
    )
  }

  if (minLength !== undefined && resolved.value.length < minLength) {
    throw new MediagenError(
      ERROR_CODE.CONFIG_ERROR,
      `The ${provider.label} key from ${resolved.layer} is too short to be valid.`,
      { hint: `Run: mediagen config set ${provider.id}` },
    )
  }

  return resolved.value
}

/**
 * Spec §3.3 — the tool must run if at least one provider is usable, and when
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
 * Accepts what a person would plausibly write to mean "off". Anything else,
 * including an empty string, leaves the setting at its default of on (§3.2).
 */
function isFalsey(value: string): boolean {
  return ['0', 'false', 'no', 'off'].includes(value.trim().toLowerCase())
}
