/**
 * Resolved runtime configuration, and the provenance that comes with it.
 *
 * Every lookup reports which layer answered. That is not
 * cosmetic: a stale environment variable shadowing a freshly configured key is
 * the single most expensive failure this tool has, and it is invisible unless
 * the resolver carries the layer alongside the value.
 *
 * Nothing here names a provider. The old shape had one field per provider
 * (`geminiApiKey`, `openaiApiKey`, …), which makes adding a provider an edit
 * in six places, which is exactly what the provider contract exists to avoid.
 */

import type { QualityPreset } from './media.js'

/** Highest priority first. */
export const CONFIG_LAYERS = ['environment', 'dotenv', 'file', 'default'] as const
export type ConfigLayer = (typeof CONFIG_LAYERS)[number]

/** A value together with the layer that produced it. */
export interface Resolved<T> {
  readonly value: T
  readonly layer: ConfigLayer
  /**
   * Layers that also hold a value but lost. `config list` warns about these so
   * a shadowed key is visible rather than merely puzzling.
   */
  readonly shadowed: readonly ConfigLayer[]
}

/** The shape written to the config file. All fields optional by design. */
export interface ConfigFile {
  defaultProvider?: string
  /** Keyed by provider id. */
  apiKeys?: Record<string, string>
  /** Keyed by provider id. */
  models?: Record<string, string>
  outputDir?: string
  quality?: QualityPreset
  /** Default for the machine-readable AI marker. */
  mark?: boolean
  /** Default for the visible AI disclosure. */
  visibleLabel?: boolean
}

/** What the pipeline actually runs with, once all three layers have been read. */
export interface ResolvedConfig {
  readonly defaultProvider: Resolved<string>
  readonly outputDir: Resolved<string>
  readonly quality: Resolved<QualityPreset>
  readonly mark: Resolved<boolean>
  readonly visibleLabel: Resolved<boolean>
  /** Resolved per provider, on use, never eagerly for all. */
  apiKey(providerId: string): Resolved<string> | undefined
  model(providerId: string): Resolved<string> | undefined
}

/**
 * Both marking switches default to off, because both are the caller's
 * decision to make rather than something to be opted out of.
 */
export const CONFIG_DEFAULTS = {
  outputDir: './output',
  quality: 'fast',
  mark: false,
  visibleLabel: false,
} as const satisfies {
  outputDir: string
  quality: QualityPreset
  mark: boolean
  visibleLabel: boolean
}
