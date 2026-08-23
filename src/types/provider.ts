/**
 * What a provider must supply, and nothing about how it supplies it.
 *
 * Two things are required of this file, and they shape every decision in it:
 *
 * 1. Adding a provider means adding one directory. So this is an interface the
 *    provider implements, never a union the core switches on.
 * 2. Credential metadata must be free of vendor SDK imports, so `doctor` and
 *    `config` can run without loading five SDKs. That is why a manifest holds
 *    only pure data and validation, and reaches its clients through a lazy
 *    factory: the SDK or the fetch client loads at the moment it is used, not
 *    at the moment the registry is imported.
 *
 * Kept as a leaf module so manifests can import it without importing the
 * registry that collects them.
 */

import type { GenerationRequest, MediaKind, QualityPreset } from './media.js'

/**
 * Deliberately data only: the env var name, a human description,
 * and any cheap format check.
 */
export interface ProviderCredential {
  /** Environment variable carrying the key, e.g. `GEMINI_API_KEY`. */
  readonly envVar: string
  /** Used in setup hints, e.g. "your Google AI API key". */
  readonly description: string
  /** Shortest plausible key; omitted when the vendor defines no format. */
  readonly minLength?: number
  /** Where the user obtains a key, shown by `init` and `doctor`. */
  readonly signupUrl?: string
}

/**
 * One entry in a provider's catalogue.
 *
 * This drives defaults, error hints and `models` output. It is
 * explicitly not a gate: an id absent from here is still sent to the provider.
 *
 * Every constraint is optional and every list is of plain strings, not a
 * closed union. A vendor that adds an aspect ratio must not turn a valid
 * request into a compile error or a confident rejection.
 */
export interface ModelDescriptor {
  /** The id a user names, e.g. `flux-2/pro`. */
  readonly id: string
  readonly kind: MediaKind
  /** Accepted aspect ratios; absent when the model has no such parameter. */
  readonly aspectRatios?: readonly string[]
  /** Accepted resolutions; absent when the model has no such parameter. */
  readonly sizes?: readonly string[]
  /** Accepted durations in seconds; video only. */
  readonly durations?: readonly number[]
  /** Whether the model accepts input media. */
  readonly acceptsInputMedia?: boolean
  /** One line for `mediagen models`. */
  readonly note?: string
}

/** Media as the provider returned it, before the core saves or marks it. */
export interface GeneratedMedia {
  readonly data: Uint8Array
  readonly mimeType: string
  /** Where the provider rewrote the prompt and says so. */
  readonly revisedPrompt?: string
  /** Provider-side identifier, useful for support and for resuming a job later. */
  readonly requestId?: string
}

/** Everything a client needs that it must not resolve for itself. */
export interface ClientOptions {
  readonly apiKey: string
  /** Model already resolved by the pipeline; the client never re-decides. */
  readonly model: string
  /** Diagnostics go to stderr and are never part of the output contract. */
  readonly log: Logger
  /** Aborts in-flight work when the caller gives up. */
  readonly signal?: AbortSignal
}

export interface Logger {
  debug(message: string): void
  info(message: string): void
  warn(message: string): void
  /** Progress for long-running jobs; always stderr, never stdout. */
  progress(message: string): void
}

export interface GenerationClient {
  generate(request: GenerationRequest, options: ClientOptions): Promise<GeneratedMedia>
}

/**
 * One cheap authenticated request that proves a key works, or explicitly absent.
 *
 * A key is verified before it is stored, and
 * `doctor` reports whether it still works. What counts as cheap is the
 * provider's decision — listing models costs nothing at one vendor, a
 * one-token completion is cheapest at another — so this returns nothing and
 * signals failure by throwing.
 *
 * A provider with no cheap request is reported as `unverifiable` rather than
 * having an image generation spent on proving its key works.
 */
export type Probe = (options: ProbeOptions) => Promise<void>

export interface ProbeOptions {
  readonly apiKey: string
  readonly signal?: AbortSignal
}

export type GenerationClientFactory = () => GenerationClient

/**
 * A provider, as the registry sees it.
 *
 * `id` is typed as `string` rather than a union so that this leaf module does
 * not have to import the registry. The registry recovers the literal types
 * from the manifests themselves.
 */
export interface ProviderManifest {
  readonly id: string
  /** Shown to people, e.g. "Google Gemini". */
  readonly label: string
  readonly credential: ProviderCredential
  /** Which kinds this provider can produce. */
  readonly kinds: readonly MediaKind[]

  /**
   * A provider may derive this from the quality preset; that
   * is a provider-internal decision and does not leak into this interface.
   */
  defaultModel(kind: MediaKind, quality: QualityPreset): string

  /** What `mediagen models` lists. Not a gate. */
  listModels(kind: MediaKind): readonly ModelDescriptor[]

  /**
   * Runs before any network call. Throws a `MediagenError` naming
   * the reason and the supported values; never substitutes a different shape.
   *
   * An unlisted model is not a reason to fail: with nothing known about it,
   * there is nothing to validate, and it is sent anyway.
   */
  validate(request: GenerationRequest, model: string): void

  /**
   * Lazily loaded so importing the registry stays SDK-free.
   * A kind absent from this map is a kind the provider cannot produce.
   */
  readonly clients: Readonly<Partial<Record<MediaKind, () => Promise<GenerationClientFactory>>>>

  /**
   * `null` where the provider offers no cheap authenticated request. Key
   * verification then reports `unverifiable` rather than guessing.
   */
  readonly probe: (() => Promise<Probe>) | null
}
