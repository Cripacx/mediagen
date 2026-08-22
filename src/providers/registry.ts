/**
 * The provider registry.
 *
 * Spec §6.1 sets the acceptance criterion: adding a provider must mean adding
 * one directory, not editing a switch statement in six places. The array below
 * is the single edit — one import and one entry — and every other consumer
 * reads providers through this module rather than naming them.
 *
 * `ProviderId` is derived from the manifests rather than declared separately,
 * so a provider cannot exist in the union but not the registry, or the other
 * way round.
 *
 * Importing this file loads only catalogues and validation. Vendor transports
 * sit behind the lazy factories on each manifest and load when used.
 */

import { ERROR_CODE, MediagenError } from '../core/errors.js'
import { geminiManifest } from './gemini/manifest.js'
import type { MediaKind } from '../types/media.js'
import type {
  GenerationClient,
  GenerationClientFactory,
  ProviderManifest,
  TextClient,
} from '../types/provider.js'

const MANIFESTS = [geminiManifest] as const

/**
 * Derived from the manifests, so a provider cannot exist in the union but not
 * the registry, or the other way round.
 */
export type ProviderId = (typeof MANIFESTS)[number]['id']

export const PROVIDER_IDS: readonly ProviderId[] = MANIFESTS.map((provider) => provider.id)

/**
 * Widened deliberately: each manifest's literal types are what `ProviderId`
 * is built from, but consumers work against the interface, not the literals.
 */
export const PROVIDERS: readonly ProviderManifest[] = MANIFESTS

/**
 * Spec §3.3 — the fallback when nothing is configured. `doctor` and the
 * startup check report this provider's own error rather than a generic one.
 */
export const BUILT_IN_DEFAULT_PROVIDER: ProviderId = 'gemini'

export function findProvider(id: string): ProviderManifest | undefined {
  return PROVIDERS.find((provider) => provider.id === id)
}

/** Spec §6.5 — an unknown provider is invalid input, and the hint lists the real ones. */
export function requireProvider(id: string): ProviderManifest {
  const provider = findProvider(id)
  if (provider) return provider

  throw new MediagenError(ERROR_CODE.VALIDATION_ERROR, `Unknown provider "${id}".`, {
    hint: `Available providers: ${PROVIDER_IDS.join(', ')}.`,
  })
}

/** Spec §2.1 — capability is data on the manifest, not a branch here. */
export function providersFor(kind: MediaKind): readonly ProviderManifest[] {
  return PROVIDERS.filter((provider) => provider.kinds.includes(kind))
}

export function requireKindSupport(provider: ProviderManifest, kind: MediaKind): void {
  if (provider.kinds.includes(kind)) return

  const alternatives = providersFor(kind).map((candidate) => candidate.id)
  throw new MediagenError(
    ERROR_CODE.VALIDATION_ERROR,
    `${provider.label} does not generate ${kind}.`,
    {
      hint:
        alternatives.length > 0
          ? `Providers that do: ${alternatives.join(', ')}.`
          : `No configured provider generates ${kind} yet.`,
    },
  )
}

/**
 * Loaded clients, keyed by provider *and* kind.
 *
 * Spec §12.1 asks for proof that alternating providers between requests does
 * not reuse the wrong one. A single-slot cache is the natural mistake here and
 * it fails silently — the second request succeeds, against the wrong vendor.
 * The key is the pair, and `providerClients.test.ts` holds it to that.
 */
const clientCache = new Map<string, GenerationClient>()
const textClientCache = new Map<string, TextClient>()

export async function loadGenerationClient(
  provider: ProviderManifest,
  kind: MediaKind,
): Promise<GenerationClient> {
  requireKindSupport(provider, kind)

  const key = `${provider.id}:${kind}`
  const cached = clientCache.get(key)
  if (cached) return cached

  const load: (() => Promise<GenerationClientFactory>) | undefined = provider.clients[kind]
  if (!load) {
    // Reachable only if a manifest declares a kind it has no client for.
    throw new MediagenError(
      ERROR_CODE.CONFIG_ERROR,
      `${provider.label} declares ${kind} support but supplies no client.`,
      { hint: 'This is a defect in the provider directory, not in your setup.' },
    )
  }

  const client = (await load())()
  clientCache.set(key, client)
  return client
}

/** `undefined` where the provider exposes no text model to probe with (§4.5). */
export async function loadTextClient(provider: ProviderManifest): Promise<TextClient | undefined> {
  if (!provider.textClient) return undefined

  const cached = textClientCache.get(provider.id)
  if (cached) return cached

  const client = (await provider.textClient())()
  textClientCache.set(provider.id, client)
  return client
}

/** Tests reset between cases; nothing in production has a reason to call this. */
export function clearClientCache(): void {
  clientCache.clear()
  textClientCache.clear()
}
