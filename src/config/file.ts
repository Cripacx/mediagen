/**
 * The per-machine config file written by `init` and `config set`.
 *
 * This is the only file the tool writes. Environment variables and
 * `.env` files belong to the user: they are read and never modified.
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ConfigFile } from '../types/config.js'

/** Directory name under the platform config root. */
const APP_DIR_NAME = 'mediagen'

/** Owner read/write only; the file holds API keys. */
const SECRET_FILE_MODE = 0o600

/**
 * XDG when set, the Windows roaming profile on win32, otherwise
 * the XDG default.
 */
export function configDirPath(): string {
  const xdg = process.env['XDG_CONFIG_HOME']
  if (xdg && xdg.trim().length > 0) {
    return path.join(xdg, APP_DIR_NAME)
  }
  if (process.platform === 'win32') {
    const appData = process.env['APPDATA']
    if (appData && appData.trim().length > 0) {
      return path.join(appData, APP_DIR_NAME)
    }
  }
  return path.join(os.homedir(), '.config', APP_DIR_NAME)
}

export function configFilePath(): string {
  return path.join(configDirPath(), 'config.json')
}

/**
 * A missing or malformed file resolves to empty configuration, so
 * a broken file never blocks a run that has working environment credentials.
 */
export function readConfigFile(): ConfigFile {
  try {
    const parsed: unknown = JSON.parse(readFileSync(configFilePath(), 'utf-8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {}
    }
    return parsed
  } catch {
    return {}
  }
}

/**
 * Writes the config file with owner-only permissions where the platform has
 * them. Windows has no POSIX mode bits; there the ACL on the user profile is
 * what protects the file, which is worth saying plainly rather than implying
 * a protection that is not there.
 */
export function writeConfigFile(config: ConfigFile): string {
  const filePath = configFilePath()
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
  writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: 'utf-8',
    mode: SECRET_FILE_MODE,
  })
  try {
    // writeFileSync applies `mode` only when creating; enforce it on rewrites too.
    chmodSync(filePath, SECRET_FILE_MODE)
  } catch {
    // Windows: no POSIX mode bits. The user profile ACL applies instead.
  }
  return filePath
}
