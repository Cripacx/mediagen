/**
 * Reading a secret without echoing it.
 *
 * Spec §3.5 — two paths only: an interactive hidden prompt, or stdin for
 * scripting (the `docker login --password-stdin` pattern). There is
 * deliberately no flag that takes a key as an argument, because arguments land
 * in shell history and in the process list.
 */

export interface ReadSecretOptions {
  readonly fromStdin: boolean
  readonly prompt: string
}

/** Consumes all of stdin and returns it with surrounding whitespace removed. */
async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk as Buffer))
  }
  // Stop reading, but leave the handle for the runtime to close: destroying it
  // here and then exiting trips a libuv assertion on Windows.
  process.stdin.pause()
  return Buffer.concat(chunks).toString('utf-8').trim()
}

/**
 * Prompts on the TTY without echoing, so the key never appears on screen and
 * stdout stays clean for `--json`.
 */
async function promptHidden(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    // Without a TTY the echo cannot be suppressed. Returning empty makes the
    // caller fail and point at --stdin, rather than silently reading the key
    // in the clear.
    return ''
  }

  const { password } = await import('@inquirer/prompts')
  return await password({ message: prompt.replace(/:\s*$/, ''), mask: true })
}

export async function readSecret(options: ReadSecretOptions): Promise<string> {
  const value = options.fromStdin ? await readAllStdin() : await promptHidden(options.prompt)
  return value.trim()
}
