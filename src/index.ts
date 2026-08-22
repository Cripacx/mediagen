/**
 * Library entry point.
 *
 * The CLI (`src/cli`) and the MCP server (`src/mcp`) are adapters over this
 * surface; per §1.2 they translate input and format output and do nothing
 * else, so anything either of them can do is reachable from here.
 */

export type {
  GenerationRequest,
  GenerationResult,
  MediaKind,
  QualityPreset,
} from './types/media.js'
export { MEDIA_KINDS, QUALITY_PRESETS, isMediaKind, isQualityPreset } from './types/media.js'
export type {
  ClientOptions,
  GeneratedMedia,
  GenerationClient,
  Logger,
  ModelDescriptor,
  ProviderCredential,
  Probe,
  ProviderManifest,
} from './types/provider.js'
export type { ConfigLayer, ConfigFile, Resolved, ResolvedConfig } from './types/config.js'
export {
  ERROR_CODE,
  EXIT_CODE,
  MediagenError,
  exitCodeFor,
  isMediagenError,
  toMediagenError,
} from './core/errors.js'
export type { ErrorCode, ExitCode } from './core/errors.js'
export { createLogger, silentLogger } from './core/logger.js'
