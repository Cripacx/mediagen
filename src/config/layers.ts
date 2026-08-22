/**
 * Layered configuration resolution with provenance.
 *
 * Spec §3.1 — three layers, because they have three different lifetimes:
 * the process environment is per invocation and what CI sets, `.env` is per
 * project, and the config file is per machine. Earlier layers win.
 *
 * Every lookup reports which layer answered, and which lower layers were
 * shadowed. Users lose hours to a stale environment variable hiding the key
 * they just configured, and the tool should be able to say so.
 */

import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { parseEnv } from 'node:util'
import type { ConfigFile, ConfigLayer, Resolved } from '../types/config.js'
import { readConfigFile } from './file.js'

/** How each layer is named when shown to a person (§4.4). */
export const LAYER_LABEL: Record<ConfigLayer, string> = {
  environment: 'env',
  dotenv: '.env',
  file: 'config file',
  default: 'built-in default',
}

export interface ConfigLayers {
  readonly env: Record<string, string | undefined>
  readonly dotenv: Record<string, string>
  readonly file: ConfigFile
  readonly dotenvPath: string
}

function readDotenv(dotenvPath: string): Record<string, string> {
  try {
    return parseEnv(readFileSync(dotenvPath, 'utf-8')) as Record<string, string>
  } catch {
    // A missing or unreadable .env is not an error; the layer is simply absent.
    return {}
  }
}

/**
 * A value that is present but meaningless is treated as absent. `FOO=` in a
 * shell script and the literal strings a careless template leaves behind are
 * far more often a mistake than an intent to configure nothing.
 */
function usable(value: string | undefined): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value !== 'undefined' &&
    value !== 'null'
  )
}

/**
 * Reads all three layers once. Callers resolve repeatedly against the result,
 * so a single command never re-reads the filesystem per lookup.
 */
export function loadConfigLayers(cwd: string = process.cwd()): ConfigLayers {
  const dotenvPath = path.join(cwd, '.env')
  return {
    env: process.env,
    dotenv: readDotenv(dotenvPath),
    file: readConfigFile(),
    dotenvPath,
  }
}

/**
 * Resolves one setting across the layers. `fileValue` is the config file's
 * contribution, which the caller reads from its own typed field.
 */
export function resolve(
  layers: ConfigLayers,
  envVar: string,
  fileValue: string | undefined,
): Resolved<string> | undefined {
  const candidates: Array<[ConfigLayer, string | undefined]> = [
    ['environment', layers.env[envVar]],
    ['dotenv', layers.dotenv[envVar]],
    ['file', fileValue],
  ]

  const present = candidates.filter((entry): entry is [ConfigLayer, string] => usable(entry[1]))
  const winner = present[0]
  if (!winner) return undefined

  return {
    value: winner[1],
    layer: winner[0],
    shadowed: present.slice(1).map(([layer]) => layer),
  }
}

/** A value that came from nowhere but the built-in default. */
export function fromDefault<T>(value: T): Resolved<T> {
  return { value, layer: 'default', shadowed: [] }
}

/** Masks a secret for display: enough to recognise, not enough to use (§3.5). */
export function maskSecret(value: string): string {
  if (value.length <= 8) return '*'.repeat(value.length)
  return `${value.slice(0, 4)}…${value.slice(-2)}`
}
