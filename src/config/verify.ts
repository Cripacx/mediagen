/**
 * Live credential verification.
 *
 * A key is verified with one minimal live request before it is stored, so a
 * typo surfaces at setup rather than at first use. `doctor` then distinguishes
 * the outcomes rather than collapsing them into "broken":
 *
 * - `missing` — nothing configured
 * - `rejected` — a key is there and the provider refused it
 * - `unreachable` — the request never got an answer
 * - `unverifiable` — configured, well-formed, and no cheap way to prove it
 *
 * That last one is not a hedge. A provider with no text model has no request
 * cheaper than generating an image, and spending a generation to check a key
 * is not a reasonable thing to do behind the user's back.
 */

import { loadProbe } from '../providers/registry.js'
import { isMediagenError, ERROR_CODE } from '../core/errors.js'
import type { ProviderManifest } from '../types/provider.js'
import type { ResolvedConfig } from '../types/config.js'

const PROBE_TIMEOUT_MS = 15_000

export type VerificationStatus = 'ok' | 'rejected' | 'unreachable' | 'missing' | 'unverifiable'

export interface VerificationResult {
  readonly provider: string
  readonly status: VerificationStatus
  /** Present when the status is not `ok`. */
  readonly detail?: string
}

/**
 * Not every provider surfaces an HTTP status, so an authentication failure is
 * recognised from the mapped error code when there is one and from the
 * message otherwise.
 */
const AUTH_FAILURE_PATTERN = new RegExp(
  [
    'api[- ]?key',
    'unauthorized',
    'forbidden',
    'permission denied',
    'invalid credential',
    'authentication',
    'rejected the api key',
  ].join('|'),
  'i',
)

function isAuthFailure(error: unknown): boolean {
  if (isMediagenError(error)) {
    if (error.code === ERROR_CODE.CONFIG_ERROR) return true
    if (error.code === ERROR_CODE.NETWORK_ERROR) return false
  }
  const message = error instanceof Error ? error.message : String(error)
  return AUTH_FAILURE_PATTERN.test(message)
}

/** Verifies a key already resolved through the layers. */
export async function verifyProvider(
  config: ResolvedConfig,
  provider: ProviderManifest,
): Promise<VerificationResult> {
  const resolved = config.apiKey(provider.id)
  if (!resolved) {
    return {
      provider: provider.id,
      status: 'missing',
      detail: `${provider.credential.envVar} is not set`,
    }
  }

  return await verifyKey(provider, resolved.value)
}

/**
 * Verifies a key the caller holds directly — used by `init` and `config set`,
 * where the key is not yet stored anywhere to be resolved from.
 */
export async function verifyKey(
  provider: ProviderManifest,
  apiKey: string,
): Promise<VerificationResult> {
  const { minLength } = provider.credential
  if (minLength !== undefined && apiKey.length < minLength) {
    return { provider: provider.id, status: 'rejected', detail: 'The key is too short to be valid' }
  }

  if (!provider.probe) {
    return {
      provider: provider.id,
      status: 'unverifiable',
      detail: 'This provider offers no request cheap enough to verify a key with',
    }
  }

  try {
    const probe = await loadProbe(provider)
    if (!probe) {
      return { provider: provider.id, status: 'unverifiable', detail: 'No probe available' }
    }

    await probe({ apiKey, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })

    return { provider: provider.id, status: 'ok' }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return {
      provider: provider.id,
      status: isAuthFailure(error) ? 'rejected' : 'unreachable',
      detail,
    }
  }
}
