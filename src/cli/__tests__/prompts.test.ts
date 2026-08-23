/**
 * The interactive pickers.
 *
 * The prompts themselves need a terminal, so what is tested here is the part
 * that decides *what the user is shown*: which choices exist, in what order,
 * and whether the list is short enough to scroll or long enough to need
 * filtering. That is where the behaviour lives; the rendering is inquirer's.
 */

import { describe, expect, it, vi } from 'vitest'
import { PROVIDER_DEFAULT, pickModel } from '../prompts.js'
import { PROVIDERS, requireProvider } from '../../providers/registry.js'
import type { ProviderManifest } from '../../types/provider.js'

interface Choice {
  name: string
  value: unknown
  description?: string
}

interface SelectCall {
  message: string
  choices: Choice[]
  default?: string
}

interface SearchCall {
  message: string
  source: (term: string | undefined) => Choice[]
}

/**
 * Captures what `pickModel` would show, and answers with the first choice.
 * Mocking at the module boundary keeps the picker's own logic under test.
 */
function capture(answer?: unknown) {
  const select = vi.fn((call: SelectCall) => Promise.resolve(answer ?? call.choices[0]?.value))
  const search = vi.fn((call: SearchCall) =>
    Promise.resolve(answer ?? call.source(undefined)[0]?.value),
  )

  vi.doMock('@inquirer/prompts', () => ({ select, search, input: vi.fn(), checkbox: vi.fn() }))
  return { select, search }
}

async function freshPickModel() {
  vi.resetModules()
  return (await import('../prompts.js')).pickModel
}

describe('choosing a model', () => {
  it('offers the provider default first, and describes why it is a good answer', async () => {
    const { select } = capture()
    const pick = await freshPickModel()

    await pick(requireProvider('gemini'), 'image', undefined)

    const shown = select.mock.calls[0]?.[0] as SelectCall
    expect(shown.choices[0]?.value).toBe((await import('../prompts.js')).PROVIDER_DEFAULT)
    expect(shown.choices[0]?.description).toMatch(/quality preset/)
  })

  it('lists every model the provider offers', async () => {
    const { select } = capture()
    const pick = await freshPickModel()
    const provider = requireProvider('gemini')

    await pick(provider, 'image', undefined)

    const shown = select.mock.calls[0]?.[0] as SelectCall
    const names = shown.choices.map((choice) => choice.name)
    for (const model of provider.listModels('image')) {
      expect(names.some((name) => name.startsWith(model.id))).toBe(true)
    }
  })

  it('marks the model already configured', async () => {
    const { select } = capture()
    const pick = await freshPickModel()

    await pick(requireProvider('gemini'), 'image', 'gemini-3-pro-image')

    const shown = select.mock.calls[0]?.[0] as SelectCall
    const marked = shown.choices.find((choice) => choice.name.includes('(current)'))
    expect(marked?.value).toBe('gemini-3-pro-image')
  })

  it('switches to a filterable prompt for a long catalogue', async () => {
    // Kie lists around thirty models. Scrolling that in a fixed list is worse
    // than typing three characters.
    const { select, search } = capture()
    const pick = await freshPickModel()

    await pick(requireProvider('kie'), 'image', undefined)

    expect(search).toHaveBeenCalled()
    expect(select).not.toHaveBeenCalled()
  })

  it('filters that long list by what was typed', async () => {
    const { search } = capture()
    const pick = await freshPickModel()

    await pick(requireProvider('kie'), 'image', undefined)

    const shown = search.mock.calls[0]?.[0] as SearchCall
    const filtered = shown.source('flux')

    expect(filtered.length).toBeGreaterThan(0)
    for (const choice of filtered) {
      expect(choice.name.toLowerCase()).toContain('flux')
    }
  })

  it('returns the default sentinel rather than a model id when nothing is pinned', async () => {
    capture()
    const pick = await freshPickModel()

    const chosen = await pick(requireProvider('gemini'), 'image', undefined)

    // A string here would pin a model the user did not choose.
    expect(chosen).toBe((await import('../prompts.js')).PROVIDER_DEFAULT)
  })

  it('asks nothing at all for a provider with no catalogue for that kind', async () => {
    const { select, search } = capture()
    const pick = await freshPickModel()

    const noVideo: ProviderManifest = { ...PROVIDERS[0]!, listModels: () => [] }
    const chosen = await pick(noVideo, 'video', undefined)

    expect(chosen).toBe((await import('../prompts.js')).PROVIDER_DEFAULT)
    expect(select).not.toHaveBeenCalled()
    expect(search).not.toHaveBeenCalled()
  })
})

describe('the sentinel', () => {
  it('cannot collide with a model id', () => {
    // A provider is free to call a model "default"; the sentinel is a symbol
    // so that it never means the same thing.
    expect(typeof PROVIDER_DEFAULT).toBe('symbol')
    expect(pickModel).toBeTypeOf('function')
  })
})
