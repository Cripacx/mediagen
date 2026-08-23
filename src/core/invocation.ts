/**
 * How this process was invoked, so hints name a command that actually works.
 *
 * A hint has to name a concrete next action. "Run: mediagen
 * config set gemini" is not one for someone who reached the tool through
 * `npx mediagen` and has nothing on their PATH — which is the normal case for
 * anyone who installed the agent skill, since that installs no CLI at all.
 * They get told to run a command their shell does not have, which is exactly
 * the failure the hint existed to prevent.
 *
 * npm places an npx-run binary under a cache directory containing `_npx`, so
 * the invocation can be recognised from the path Node was given.
 */

/** Cached: argv does not change, and this is read on most error paths. */
let cached: string | undefined

export function invocationPrefix(): string {
  cached ??= detect()
  return cached
}

function detect(): string {
  const entry = process.argv[1] ?? ''

  // Normalised because the separator differs by platform and the cache
  // directory is spelled `_npx` on both.
  const normalised = entry.replace(/\\/g, '/')

  return normalised.includes('/_npx/') ? 'npx -y mediagen' : 'mediagen'
}

/** Builds a hint naming the invocation the caller actually used. */
export function command(rest: string): string {
  return `${invocationPrefix()} ${rest}`
}

/** Tests set this to assert both forms without spawning two processes. */
export function setInvocationPrefixForTest(prefix: string | undefined): void {
  cached = prefix
}
