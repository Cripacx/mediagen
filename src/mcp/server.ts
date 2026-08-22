/**
 * The MCP server: the second adapter over the core (§1.2).
 *
 * It translates input and formats output and does nothing else. Every tool
 * below reaches the same pipeline the CLI reaches, so a behaviour that exists
 * in one and not the other would be a defect rather than a difference.
 *
 * **stdout belongs to the protocol here.** On the CLI side stdout carries the
 * output contract; over stdio it carries JSON-RPC frames, and one stray line
 * corrupts the stream for the host. Nothing in this file writes to it: the
 * transport owns it, and diagnostics go through a logger that only ever writes
 * to stderr.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { EXIT_CODE, isMediagenError, toMediagenError, type ExitCode } from '../core/errors.js'
import { createLogger } from '../core/logger.js'
import { version } from '../core/version.js'
import { generate, resolveModel } from '../core/pipeline.js'
import { loadConfig } from '../config/resolve.js'
import { LAYER_LABEL } from '../config/layers.js'
import { PROVIDERS, PROVIDER_IDS, requireProvider } from '../providers/registry.js'
import { MEDIA_KINDS, QUALITY_PRESETS } from '../types/media.js'
import type { GenerationRequest, MediaKind } from '../types/media.js'

/** Diagnostics go to stderr; an MCP host shows them in its own log. */
const log = createLogger({ quiet: false })

const GENERATE_SHAPE = {
  prompt: z
    .string()
    .min(1)
    .describe(
      'What to generate. Be specific: a short prompt underdetermines the image, and the model resolves the rest arbitrarily.',
    ),
  kind: z.enum(MEDIA_KINDS).default('image').describe('image or video'),
  provider: z
    .enum(PROVIDER_IDS as [string, ...string[]])
    .optional()
    .describe('Overrides the configured default provider'),
  model: z.string().optional().describe('Model id for the chosen provider; see the models tool'),
  inputMedia: z.string().optional().describe('Path to a local file to edit or transform'),
  aspectRatio: z
    .string()
    .optional()
    .describe(
      'e.g. 1:1, 16:9, 9:16. Rejected with the supported values if the model cannot do it.',
    ),
  size: z.string().optional().describe('e.g. 1K, 2K, 4K'),
  duration: z.number().positive().optional().describe('Video only, in seconds'),
  outputName: z
    .string()
    .optional()
    .describe('Output file name; its extension may select the format'),
  outputDir: z.string().optional().describe('Overrides the configured output directory'),
  quality: z.enum(QUALITY_PRESETS).optional().describe('Trades speed and cost against fidelity'),
  mark: z.boolean().optional().describe('Write the machine-readable AI-generated marker (§9)'),
  visibleLabel: z.boolean().optional().describe('Composite a visible AI disclosure into the media'),
}

const MODELS_SHAPE = {
  kind: z.enum(MEDIA_KINDS).default('image'),
  provider: z.enum(PROVIDER_IDS as [string, ...string[]]).optional(),
}

export function buildServer(): McpServer {
  const server = new McpServer({ name: 'mediagen', version: version() })

  server.registerTool(
    'generate_media',
    {
      title: 'Generate media',
      description:
        'Generate an image or a video from a text prompt and save it to disk. Returns the saved path.',
      inputSchema: GENERATE_SHAPE,
    },
    async (args) => {
      try {
        const request: GenerationRequest = {
          prompt: args.prompt,
          kind: args.kind,
          ...(args.provider === undefined ? {} : { provider: args.provider }),
          ...(args.model === undefined ? {} : { model: args.model }),
          ...(args.inputMedia === undefined ? {} : { inputMedia: args.inputMedia }),
          ...(args.aspectRatio === undefined ? {} : { aspectRatio: args.aspectRatio }),
          ...(args.size === undefined ? {} : { size: args.size }),
          ...(args.duration === undefined ? {} : { duration: args.duration }),
          ...(args.outputName === undefined ? {} : { outputName: args.outputName }),
          ...(args.outputDir === undefined ? {} : { outputDir: args.outputDir }),
          ...(args.quality === undefined ? {} : { quality: args.quality }),
          ...(args.mark === undefined ? {} : { mark: args.mark }),
          ...(args.visibleLabel === undefined ? {} : { visibleLabel: args.visibleLabel }),
        }

        const result = await generate(request, { config: loadConfig(), log })

        return {
          content: [
            {
              type: 'text' as const,
              text: `Saved ${result.filePath}\nProvider: ${result.provider}\nModel: ${result.model}\nType: ${result.mimeType}`,
            },
          ],
          structuredContent: { ...result },
        }
      } catch (error) {
        return toolError(error)
      }
    },
  )

  server.registerTool(
    'list_models',
    {
      title: 'List models',
      description:
        'Show which model each provider would use right now, where that choice came from, and which models are listed. A model absent from the lists is still sent to the provider.',
      inputSchema: MODELS_SHAPE,
    },
    (args) => {
      try {
        const kind = args.kind
        const config = loadConfig()
        const providers = args.provider === undefined ? PROVIDERS : [requireProvider(args.provider)]

        const reported = providers.map((provider) => {
          if (!provider.kinds.includes(kind)) {
            return { provider: provider.id, supportsKind: false, models: [] }
          }

          const { model, source } = resolveModel({ kind }, provider, config, config.quality.value)
          const configured = config.model(provider.id)

          return {
            provider: provider.id,
            supportsKind: true,
            wouldUse: model,
            source,
            ...(configured === undefined ? {} : { configuredLayer: LAYER_LABEL[configured.layer] }),
            models: provider.listModels(kind).map((descriptor) => ({ ...descriptor })),
          }
        })

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(reported, null, 2) }],
          structuredContent: { kind, providers: reported },
        }
      } catch (error) {
        return toolError(error)
      }
    },
  )

  server.registerTool(
    'check_configuration',
    {
      title: 'Check configuration',
      description:
        'Report which providers have a key configured and which layer supplied it. Does not make live requests and never reveals a key.',
      inputSchema: {},
    },
    () => {
      const config = loadConfig()

      const providers = PROVIDERS.map((provider) => {
        const resolved = config.apiKey(provider.id)
        return {
          provider: provider.id,
          configured: resolved !== undefined,
          ...(resolved === undefined ? {} : { layer: LAYER_LABEL[resolved.layer] }),
          envVar: provider.credential.envVar,
        }
      })

      const usable = providers.filter((entry) => entry.configured)

      return {
        content: [
          {
            type: 'text' as const,
            text:
              usable.length > 0
                ? `Configured: ${usable.map((entry) => entry.provider).join(', ')}. Default: ${config.defaultProvider.value}.`
                : // §11: never ask a user to paste an API key into a chat.
                  'No provider is configured. Ask the user to run `mediagen init` in their terminal — do not ask them for an API key here.',
          },
        ],
        structuredContent: {
          defaultProvider: config.defaultProvider.value,
          providers,
        },
      }
    },
  )

  return server
}

/**
 * Spec §6.5's taxonomy, rendered for an agent.
 *
 * The code and the hint are both included, because an agent that can read
 * `CONFIG_ERROR` and the sentence next to it can do the right thing — which
 * for a configuration failure means telling the user to run `mediagen init`
 * rather than asking them for a key (§11).
 */
function toolError(error: unknown) {
  const mapped = isMediagenError(error) ? error : toMediagenError(error)

  return {
    isError: true,
    content: [
      {
        type: 'text' as const,
        text: `${mapped.code}: ${mapped.message}${mapped.hint === undefined ? '' : `\nHint: ${mapped.hint}`}`,
      },
    ],
    structuredContent: {
      success: false,
      errorCode: mapped.code,
      error: mapped.message,
      ...(mapped.hint === undefined ? {} : { hint: mapped.hint }),
    },
  }
}

export async function startMcpServer(): Promise<ExitCode> {
  const server = buildServer()
  await server.connect(new StdioServerTransport())

  // The transport keeps the process alive; resolving here would end it.
  await new Promise<void>((resolve) => {
    process.on('SIGINT', () => resolve())
    process.on('SIGTERM', () => resolve())
    process.stdin.on('close', () => resolve())
  })

  return EXIT_CODE.SUCCESS
}
