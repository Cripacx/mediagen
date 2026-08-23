/**
 * The error taxonomy every frontend renders.
 *
 * Provider errors are mapped onto a small, stable set
 * before they reach a frontend, so that neither the CLI nor the MCP server
 * ever parses a vendor error string. The exit code has to be
 * derivable without parsing text, so the code-to-exit mapping lives here and
 * nowhere else.
 *
 * Errors travel as exceptions inside the pipeline and are converted to a
 * result object at the frontend boundary. Threading a result type through
 * every stage would buy nothing that the output contract does not already get from one
 * conversion at the edge.
 */

/**
 * Callers branch on these, so the mapping is stable.
 */
export const EXIT_CODE = {
  SUCCESS: 0,
  /** Invalid input or usage. */
  USAGE: 2,
  /** Configuration or credentials. */
  CONFIG: 3,
  /** Generation, network, or file I/O failure. */
  FAILURE: 4,
} as const

export type ExitCode = (typeof EXIT_CODE)[keyof typeof EXIT_CODE]

/**
 * Invalid input, configuration, upstream API failure, network
 * failure, file operation. `CONTENT_BLOCKED` and `TIMEOUT` are split out
 * because a content block must not read as a network error, and a
 * polling timeout not to read as an upstream failure.
 */
export const ERROR_CODE = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  CONFIG_ERROR: 'CONFIG_ERROR',
  API_ERROR: 'API_ERROR',
  NETWORK_ERROR: 'NETWORK_ERROR',
  FILE_ERROR: 'FILE_ERROR',
  CONTENT_BLOCKED: 'CONTENT_BLOCKED',
  TIMEOUT: 'TIMEOUT',
} as const

export type ErrorCode = (typeof ERROR_CODE)[keyof typeof ERROR_CODE]

const EXIT_FOR_CODE: Record<ErrorCode, ExitCode> = {
  VALIDATION_ERROR: EXIT_CODE.USAGE,
  CONFIG_ERROR: EXIT_CODE.CONFIG,
  API_ERROR: EXIT_CODE.FAILURE,
  NETWORK_ERROR: EXIT_CODE.FAILURE,
  FILE_ERROR: EXIT_CODE.FAILURE,
  CONTENT_BLOCKED: EXIT_CODE.FAILURE,
  TIMEOUT: EXIT_CODE.FAILURE,
}

export function exitCodeFor(code: ErrorCode): ExitCode {
  return EXIT_FOR_CODE[code]
}

/**
 * Every failure the tool reports deliberately.
 *
 * `hint` names a concrete next action: an error that says only what
 * went wrong is half an error — so anything constructed without a hint should
 * be a case where genuinely no action exists.
 */
export class MediagenError extends Error {
  readonly code: ErrorCode
  readonly hint: string | undefined

  constructor(code: ErrorCode, message: string, options?: { hint?: string; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'MediagenError'
    this.code = code
    this.hint = options?.hint
  }

  get exitCode(): ExitCode {
    return exitCodeFor(this.code)
  }
}

/** Narrowing helper; `instanceof` alone breaks across duplicated module copies. */
export function isMediagenError(value: unknown): value is MediagenError {
  return value instanceof MediagenError
}

/**
 * Last line of defence for anything thrown that was not already mapped.
 *
 * The raw message is deliberately dropped rather than forwarded, because
 * that an upstream message never reaches the user unredacted, because it may
 * echo the prompt or fragments of a key. The original is kept as `cause` for
 * stderr diagnostics, which are not part of the output contract.
 */
export function toMediagenError(value: unknown): MediagenError {
  if (isMediagenError(value)) return value

  if (value instanceof Error && isNetworkFailure(value)) {
    return new MediagenError(ERROR_CODE.NETWORK_ERROR, 'Could not reach the provider.', {
      hint: 'Check your network connection, then try again.',
      cause: value,
    })
  }

  return new MediagenError(ERROR_CODE.API_ERROR, 'An unexpected error occurred.', {
    hint: 'Run the same command with --verbose to see the underlying error.',
    cause: value,
  })
}

const NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
])

function isNetworkFailure(error: Error): boolean {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    const code: unknown = (current as { code?: unknown }).code
    if (typeof code === 'string' && NETWORK_ERROR_CODES.has(code)) return true
    if (current.name === 'TimeoutError' || current.name === 'AbortError') return true
  }
  return false
}
