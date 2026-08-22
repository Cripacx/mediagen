/**
 * Generated from Kie AI's documentation. Do not edit by hand.
 *
 * Regenerate with:
 *   npm run sync:kie-models
 *
 * Source: https://docs.kie.ai/llms.txt and the OpenAPI specification embedded
 * in each model's documentation page. 32 models.
 */

import type { KieModelShape } from './modelShape.js'

export const GENERATED_KIE_MODELS = {
  'bytedance/seedream': {
    textToImage: 'bytedance/seedream',
  },
  'bytedance/seedream-v4': {
    textToImage: 'bytedance/seedream-v4-text-to-image',
    imageToImage: 'bytedance/seedream-v4-edit',
    imageInputField: 'image_urls',
    imageInputIsArray: true,
  },
  'flux-2/flex': {
    textToImage: 'flux-2/flex-text-to-image',
    imageToImage: 'flux-2/flex-image-to-image',
    imageInputField: 'input_urls',
    imageInputIsArray: true,
    aspectRatios: ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3'],
    resolutions: ['1K', '2K'],
  },
  'flux-2/pro': {
    textToImage: 'flux-2/pro-text-to-image',
    imageToImage: 'flux-2/pro-image-to-image',
    imageInputField: 'input_urls',
    imageInputIsArray: true,
    aspectRatios: ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3'],
    resolutions: ['1K', '2K'],
  },
  'google/imagen4': {
    textToImage: 'google/imagen4',
    aspectRatios: ['1:1', '16:9', '9:16', '3:4', '4:3'],
  },
  'google/imagen4-fast': {
    textToImage: 'google/imagen4-fast',
    aspectRatios: ['1:1', '16:9', '9:16', '3:4', '4:3'],
  },
  'google/imagen4-ultra': {
    textToImage: 'google/imagen4-ultra',
    aspectRatios: ['1:1', '16:9', '9:16', '3:4', '4:3'],
  },
  'google/nano-banana': {
    textToImage: 'google/nano-banana',
    imageToImage: 'google/nano-banana-edit',
    imageInputField: 'image_urls',
    imageInputIsArray: true,
    aspectRatios: ['1:1', '9:16', '16:9', '3:4', '4:3', '3:2', '2:3', '5:4', '4:5', '21:9'],
    outputFormats: { png: 'png', jpeg: 'jpeg' },
  },
  'gpt-image-2': {
    textToImage: 'gpt-image-2-text-to-image',
    imageToImage: 'gpt-image-2-image-to-image',
    imageInputField: 'input_urls',
    imageInputIsArray: true,
    aspectRatios: ['1:1', '3:2', '2:3', '4:3', '3:4', '5:4', '4:5', '16:9', '9:16', '21:9'],
    resolutions: ['1K', '2K', '4K'],
  },
  'gpt-image/1.5': {
    textToImage: 'gpt-image/1.5-text-to-image',
    imageToImage: 'gpt-image/1.5-image-to-image',
    imageInputField: 'input_urls',
    imageInputIsArray: true,
    aspectRatios: ['1:1', '2:3', '3:2'],
  },
  'grok-imagine': {
    textToImage: 'grok-imagine/text-to-image',
    imageToImage: 'grok-imagine/image-to-image',
    imageInputField: 'image_urls',
    imageInputIsArray: true,
    aspectRatios: ['2:3', '3:2', '1:1', '16:9', '9:16'],
  },
  'grok-imagine-image-2-0': {
    textToImage: 'grok-imagine-image-2-0/text-to-image',
    aspectRatios: ['1:1', '2:3', '3:2', '16:9', '9:16'],
  },
  'grok-imagine-image-2-0/image-edit': {
    imageToImage: 'grok-imagine-image-2-0/image-edit',
    imageInputField: 'image_urls',
    imageInputIsArray: true,
    aspectRatios: ['1:1', '2:3', '3:2', '16:9', '9:16'],
  },
  'ideogram/character': {
    textToImage: 'ideogram/character',
    imageToImage: 'ideogram/character-edit',
    imageInputField: 'image_url',
    imageInputIsArray: false,
  },
  'ideogram/character-remix': {
    textToImage: 'ideogram/character-remix',
    imageToImage: 'ideogram/character-remix',
    imageInputField: 'image_url',
    imageInputIsArray: false,
  },
  'ideogram/v3': {
    textToImage: 'ideogram/v3-text-to-image',
    imageToImage: 'ideogram/v3-edit',
    imageInputField: 'image_url',
    imageInputIsArray: false,
  },
  'ideogram/v3-remix': {
    textToImage: 'ideogram/v3-remix',
    imageToImage: 'ideogram/v3-remix',
    imageInputField: 'image_url',
    imageInputIsArray: false,
  },
  'nano-banana-2': {
    textToImage: 'nano-banana-2',
    imageToImage: 'nano-banana-2',
    imageInputField: 'image_input',
    imageInputIsArray: true,
    aspectRatios: ['1:1', '2:3', '3:2', '1:4', '4:1', '3:4', '4:3', '4:5', '5:4', '1:8', '8:1', '9:16', '16:9', '21:9'],
    resolutions: ['1K', '2K', '4K'],
    outputFormats: { png: 'png', jpeg: 'jpg' },
  },
  'nano-banana-2-lite': {
    textToImage: 'nano-banana-2-lite',
    imageToImage: 'nano-banana-2-lite',
    imageInputField: 'image_urls',
    imageInputIsArray: true,
    aspectRatios: ['1:1', '1:4', '1:8', '2:3', '3:2', '3:4', '4:1', '4:3', '4:5', '5:4', '8:1', '9:16', '16:9', '21:9'],
  },
  'nano-banana-pro': {
    textToImage: 'nano-banana-pro',
    imageToImage: 'nano-banana-pro',
    imageInputField: 'image_input',
    imageInputIsArray: true,
    aspectRatios: ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'],
    resolutions: ['1K', '2K', '4K'],
    outputFormats: { png: 'png', jpeg: 'jpg' },
  },
  'qwen': {
    textToImage: 'qwen/text-to-image',
    imageToImage: 'qwen/image-to-image',
    imageInputField: 'image_url',
    imageInputIsArray: false,
    outputFormats: { png: 'png', jpeg: 'jpeg' },
  },
  'qwen/image-edit': {
    imageToImage: 'qwen/image-edit',
    imageInputField: 'image_url',
    imageInputIsArray: false,
    outputFormats: { jpeg: 'jpeg', png: 'png' },
  },
  'qwen2/image-edit': {
    imageToImage: 'qwen2/image-edit',
    imageInputField: 'image_url',
    imageInputIsArray: false,
    outputFormats: { jpeg: 'jpeg', png: 'png' },
  },
  'qwen3': {
    textToImage: 'qwen3/text-to-image',
    imageToImage: 'qwen3/image-to-image',
    imageInputField: 'image_urls',
    imageInputIsArray: true,
    resolutions: ['1K', '2K'],
    outputFormats: { png: 'png', jpeg: 'jpeg' },
  },
  'qwen3/pro': {
    textToImage: 'qwen3/pro-text-to-image',
    imageToImage: 'qwen3/pro-image-to-image',
    imageInputField: 'image_urls',
    imageInputIsArray: true,
    resolutions: ['1K', '2K'],
    outputFormats: { png: 'png', jpeg: 'jpeg' },
  },
  'seedream/4.5': {
    textToImage: 'seedream/4.5-text-to-image',
    imageToImage: 'seedream/4.5-edit',
    imageInputField: 'image_urls',
    imageInputIsArray: true,
    aspectRatios: ['1:1', '4:3', '3:4', '16:9', '9:16', '2:3', '3:2', '21:9'],
  },
  'seedream/5-lite': {
    textToImage: 'seedream/5-lite-text-to-image',
    imageToImage: 'seedream/5-lite-image-to-image',
    imageInputField: 'image_urls',
    imageInputIsArray: true,
    aspectRatios: ['1:1', '4:3', '3:4', '16:9', '9:16', '2:3', '3:2', '21:9'],
    outputFormats: { png: 'png', jpeg: 'jpeg' },
  },
  'seedream/5-pro': {
    textToImage: 'seedream/5-pro-text-to-image',
    imageToImage: 'seedream/5-pro-image-to-image',
    imageInputField: 'image_urls',
    imageInputIsArray: true,
    aspectRatios: ['1:1', '4:3', '3:4', '16:9', '9:16', '2:3', '3:2', '21:9'],
    outputFormats: { png: 'png', jpeg: 'jpeg' },
  },
  'seedream/5-pro-layer-decomposition': {
    textToImage: 'seedream/5-pro-layer-decomposition',
    imageToImage: 'seedream/5-pro-layer-decomposition',
    imageInputField: 'image_url',
    imageInputIsArray: false,
    outputFormats: { png: 'png', jpeg: 'jpeg' },
  },
  'wan/2-7-image': {
    textToImage: 'wan/2-7-image',
    imageToImage: 'wan/2-7-image',
    imageInputField: 'input_urls',
    imageInputIsArray: true,
    aspectRatios: ['1:1', '16:9', '4:3', '21:9', '3:4', '9:16', '8:1', '1:8'],
    resolutions: ['1K', '2K', '4K'],
  },
  'wan/2-7-image-pro': {
    textToImage: 'wan/2-7-image-pro',
    imageToImage: 'wan/2-7-image-pro',
    imageInputField: 'input_urls',
    imageInputIsArray: true,
    aspectRatios: ['1:1', '16:9', '4:3', '21:9', '3:4', '9:16', '8:1', '1:8'],
    resolutions: ['1K', '2K', '4K'],
  },
  'z-image': {
    textToImage: 'z-image',
    aspectRatios: ['1:1', '4:3', '3:4', '16:9', '9:16'],
  },
} as const satisfies Record<string, KieModelShape>
