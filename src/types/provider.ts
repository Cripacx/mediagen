/**
 * What a provider must supply, and nothing about how it supplies it.
 *
 * Spec §6.1 requires two things of this file that shape every decision in it:
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
 * Spec §6.1. Deliberately data only: the env var name, a human description,
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
 * Spec §7.3 — this drives defaults, error hints and `models` output. It is
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
  /** Whether the model accepts input media (§6.4). */
  readonly acceptsInputMedia?: boolean
  /** One line for `mediagen models`. */
  readonly note?: string
}

/** Media as the provider returned it, before the core saves or marks it (§8, §9). */
export interface GeneratedMedia {
  readonly data: Uint8Array
  readonly mimeType: string
  /** Where the provider rewrote the prompt and says so. */
  readonly revisedPrompt?: string
  /** Provider-side identifier, useful for support and for §10 resumability. */
  readonly requestId?: string
}

/** Everything a client needs that it must not resolve for itself. */
export interface ClientOptions {
  readonly apiKey: string
  /** Model already resolved through §7.1; the client never re-decides. */
  readonly model: string
  /** Diagnostics go to stderr and are never part of the output contract (§4.2). */
  readonly log: Logger
  /** Aborts in-flight work when the caller gives up. */
  readonly signal?: AbortSignal
}

export interface Logger {
  debug(message: string): void
  info(message: string): void
  warn(message: string): void
  /** Progress for long-running jobs; §10 requires this on stderr, never stdout. */
  progress(message: string): void
}

export interface GenerationClient {
  generate(request: GenerationRequest, options: ClientOptions): Promise<GeneratedMedia>
}

/**
 * A cheap text completion, or explicitly absent.
 *
 * This exists for §4.5: `doctor` and `config set` verify a key with one
 * minimal live request, and a text model is the cheapest request a provider
 * offers. A provider without one is reported as `unverifiable` rather than
 * having an image generation spent on proving its key works.
 */
export interface TextClient {
  complete(instruction: string, options: ClientOptions): Promise<string>
}

export type GenerationClientFactory = () => GenerationClient
export type TextClientFactory = () => TextClient

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
  /** Spec §2.1 — which kinds this provider can produce. */
  readonly kinds: readonly MediaKind[]

  /**
   * Spec §7.1 step 3. A provider may derive this from the quality preset; that
   * is a provider-internal decision and does not leak into this interface.
   */
  defaultModel(kind: MediaKind, quality: QualityPreset): string

  /** Spec §7.2 — what `mediagen models` lists. Not a gate (§7.3). */
  listModels(kind: MediaKind): readonly ModelDescriptor[]

  /**
   * Spec §6.3. Runs before any network call. Throws a `MediagenError` naming
   * the reason and the supported values; never substitutes a different shape.
   *
   * An unlisted model is not a reason to fail: with nothing known about it,
   * there is nothing to validate, and §7.3 says send it anyway.
   */
  validate(request: GenerationRequest, model: string): void

  /**
   * Spec §6.1. Lazily loaded so importing the registry stays SDK-free.
   * A kind absent from this map is a kind the provider cannot produce.
   */
  readonly clients: Readonly<Partial<Record<MediaKind, () => Promise<GenerationClientFactory>>>>

  /**
   * `null` where the provider exposes no text model. Key verification then
   * reports `unverifiable` (§4.5) rather than guessing.
   */
  readonly textClient: (() => Promise<TextClientFactory>) | null

  /**
   * The model used to probe a credential. Named here rather than inside the
   * client so the decision costs no import. Undefined exactly when
   * `textClient` is null.
   */
  readonly textModel?: string
}
