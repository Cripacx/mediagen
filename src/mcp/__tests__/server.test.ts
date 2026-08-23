/**
 * The MCP server, driven over a real in-memory transport.
 *
 * A behaviour present in one frontend and not the other is a defect,
 * so these tests check the same properties the CLI contract tests check:
 * the error taxonomy reaches the caller with its code and hint, and nothing
 * reaches stdout that the protocol did not put there.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { beforeEach, describe, expect, it } from 'vitest'
import { buildServer } from '../server.js'
import { PROVIDER_IDS } from '../../providers/registry.js'

async function connect(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0' })

  await Promise.all([buildServer().connect(serverTransport), client.connect(clientTransport)])

  return client
}

let client: Client

beforeEach(async () => {
  client = await connect()
})

interface ToolResult {
  isError?: boolean
  content?: Array<{ type: string; text?: string }>
  structuredContent?: Record<string, unknown>
}

describe('the tool surface', () => {
  it('exposes the tools an agent needs and no more', async () => {
    const { tools } = await client.listTools()

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'check_configuration',
      'generate_media',
      'list_models',
    ])
  })

  it('describes generate_media well enough to call without guessing', async () => {
    const { tools } = await client.listTools()
    const generate = tools.find((tool) => tool.name === 'generate_media')

    expect(generate?.description).toBeDefined()
    expect(Object.keys(generate?.inputSchema.properties ?? {})).toEqual(
      expect.arrayContaining(['prompt', 'kind', 'provider', 'model', 'aspectRatio']),
    )
  })
})

describe('the same pipeline as the CLI', () => {
  it('surfaces a configuration failure with its code and hint', async () => {
    // Nothing is configured in the test environment, so this fails on
    // credentials rather than reaching a provider.
    const result = (await client.callTool({
      name: 'generate_media',
      arguments: { prompt: 'a red bicycle' },
    })) as ToolResult

    expect(result.isError).toBe(true)
    expect(result.structuredContent?.['errorCode']).toBe('CONFIG_ERROR')
    expect(String(result.structuredContent?.['hint'])).toContain('mediagen config set')
  })

  it('rejects an unsupported shape before any network call', async () => {
    const result = (await client.callTool({
      name: 'generate_media',
      arguments: {
        prompt: 'a red bicycle',
        provider: 'openai',
        model: 'gpt-image-2',
        aspectRatio: '16:9',
      },
    })) as ToolResult

    expect(result.isError).toBe(true)
    expect(result.structuredContent?.['errorCode']).toBe('VALIDATION_ERROR')
    expect(String(result.structuredContent?.['error'])).toContain('1:1, 3:2, 2:3')
  })

  it('refuses an unknown provider at the schema, not the pipeline', async () => {
    const result = (await client.callTool({
      name: 'generate_media',
      arguments: { prompt: 'a cat', provider: 'midjourney' },
    })) as ToolResult

    expect(result.isError).toBe(true)
  })
})

describe('list_models', () => {
  it('reports what each provider would use and where that came from', async () => {
    const result = (await client.callTool({
      name: 'list_models',
      arguments: {},
    })) as ToolResult

    const providers = result.structuredContent?.['providers'] as Array<{
      provider: string
      wouldUse?: string
      source?: string
    }>

    expect(providers.map((entry) => entry.provider).sort()).toEqual([...PROVIDER_IDS].sort())
    for (const entry of providers) {
      expect(entry.wouldUse).toBeDefined()
      expect(entry.source).toBe('provider default')
    }
  })
})

describe('check_configuration', () => {
  it('never asks the caller for an API key', async () => {
    const result = (await client.callTool({
      name: 'check_configuration',
      arguments: {},
    })) as ToolResult

    const text = result.content?.[0]?.text ?? ''

    // On a configuration failure, tell the user to run `mediagen init` —
    // never ask them to paste a key into a chat.
    expect(text).toContain('mediagen init')
    expect(text).toMatch(/do not ask them for an API key/i)
  })

  it('reveals no key material', async () => {
    const result = (await client.callTool({
      name: 'check_configuration',
      arguments: {},
    })) as ToolResult

    const serialised = JSON.stringify(result)
    expect(serialised).not.toMatch(/sk-|AIza/)
  })
})
