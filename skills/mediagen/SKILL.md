---
name: mediagen
description: Generate images and video from text prompts via the mediagen CLI, across Gemini, OpenAI and Kie AI. Use when asked to create, generate, render, or edit an image or a video — a logo, an illustration, a mockup, a photo, a banner, a clip — or to mark existing media as AI-generated. Also covers choosing a provider or model for a generation task.
---

# mediagen

Generate images and video from text prompts across several providers.

## How to call it

Use **`npx -y mediagen`** with `--json`. Always `--json`: it puts exactly one
object on stdout and nothing else, so you never have to parse prose.

```bash
npx -y mediagen image "<prompt>" --json
npx -y mediagen video "<prompt>" --json
```

`npx` needs no installation and runs an existing one if the user has it, so
this is the right form either way — installing the skill does not install the
CLI, and most users who have the skill will not have it on their PATH.

**Always pass a subcommand.** With no arguments the tool prints its help and
exits; it does nothing useful, but it will not hang.

Do not run `mediagen init` yourself — it needs a terminal and refuses without
one. It is something to ask the user to run.

If you have no shell at all, the same pipeline is available over MCP as the
`generate_media` tool, with `list_models` and `check_configuration` alongside
it — a host spawns it with `npx -y mediagen mcp`. The CLI is the primary path;
MCP is the fallback.

Video takes minutes and only Gemini does it. Progress goes to stderr; the one
JSON object still lands on stdout at the end.

## Write the prompt yourself

**This is the part that decides whether the result is any good, and it is your
job.** mediagen sends your prompt to the provider exactly as written — it does
not expand, rewrite, or improve it. A four-word prompt produces a generic
image, because the model resolves everything you left unsaid arbitrarily.

Before generating, decide these. Not all of them matter every time, but each
one you leave open is one the model decides for you:

|                      |                                                                                                                                                                |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Subject**          | What is present, and what it is doing. Concrete nouns beat categories.                                                                                         |
| **Composition**      | Framing, where the subject sits, what surrounds it, depth, what is cropped.                                                                                    |
| **Light**            | Source, direction, hardness, colour temperature, time of day. This does more than anything else to decide whether an image reads as photographic or synthetic. |
| **Camera or medium** | Lens and distance for a photograph; tool and surface for an illustration. This resolves scale, which models otherwise get arbitrarily wrong.                   |
| **Material**         | What things are made of and how they catch light.                                                                                                              |
| **Atmosphere**       | Mood and palette, stated plainly. The easiest to overdo — an over-styled image is harder to use than a plain one.                                              |

Two or three sentences is usually right. Some specifics:

- **Keep what the user said.** If they said "a red bicycle", it stays a red
  bicycle. Fill in what they left open; never contradict or quietly drop what
  they specified.
- **Say what you want, not what you don't.** "An empty street at dawn" works;
  "no people" often does not.
- **Don't stack style words.** "cinematic, 8k, hyperdetailed, masterpiece,
  award-winning" adds noise, not quality. One clear stylistic statement beats
  five adjectives.
- **Text in images is unreliable** across every provider here. If the user
  needs exact wording, warn them and expect to check it.
- **For video**, also state camera movement and what changes over the shot.
  Describe one continuous shot unless asked otherwise.

Ask the user before generating only when a genuinely ambiguous choice would
change the result — photo or illustration, portrait or landscape. Otherwise
make the call, generate, and say what you assumed.

## Choosing a provider

Run `npx -y mediagen models --json` to see what is configured and what each provider
would use. As a starting point:

| Task                                | Provider                                                      | Why                                                                      |
| ----------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------ |
| General images, wide aspect ratios  | `gemini`                                                      | 14 aspect ratios including 21:9 and 8:1, sizes to 4K, edits input images |
| Complex instructions, many elements | `gemini` with `--model gemini-3-pro-image`                    | Reasons about the prompt before generating; slower                       |
| Speed and volume                    | `gemini` (default model) or `openai --model gpt-image-1-mini` |                                                                          |
| Strong instruction following        | `openai --model gpt-image-1.5` or `gpt-image-2`               |                                                                          |
| A specific third-party model        | `kie`                                                         | Aggregates ~30 models: Flux, Imagen, Seedream, Grok and others           |
| Video                               | `gemini`                                                      | The only provider here that generates video; 16:9 and 9:16 only          |

**OpenAI takes pixel sizes, not aspect ratios.** It can do 1:1, 3:2 and 2:3
only. It genuinely cannot do 16:9 — asking for one is rejected rather than
silently served as 3:2. For anything wider than 3:2, use `gemini`.

Do not guess model ids. `npx -y mediagen models --json` lists them, and an id absent
from the list is still sent to the provider rather than rejected — so a newly
released model works before this skill knows about it.

## Options worth knowing

```
--provider <name>       gemini, openai, kie
--model <id>            see the models command
--aspect-ratio <ratio>  1:1, 16:9, 9:16, … rejected by name if the model cannot
--size <size>           1K, 2K, 4K
--input <path>          edit or transform an existing image
--output-name <name>    file name; the extension may select the format
--output-dir <dir>
--quality <preset>      fast, balanced, quality
--duration <seconds>    video only
--mark                  machine-readable AI-generated marker
--visible-label         visible AI disclosure composited into the image
```

## Marking

**Recommend `--mark` whenever the output is photorealistic, will be published,
or is for professional use.** It writes the IPTC/XMP `DigitalSourceType` that
platforms read, costs nothing, and changes no pixels. In the EU it is a legal
duty for the provider of synthetic content.

`--visible-label` is the separate duty — disclosure to people who see the
image. Suggest it when the image will be shown to an audience who might
otherwise take it for a photograph.

`npx -y mediagen mark <file...>` applies both to media that already exists.

**Video cannot be marked yet.** Writing XMP into a video container is a
different operation from writing it into a still, and this build does not do
it — `--mark` on a video is refused by name rather than silently ignored. If a
video needs a disclosure, say so to the user rather than assuming it is marked.

## Reading the result

Success:

```json
{
  "success": true,
  "filePath": "./output/image-20260823T094107Z.png",
  "kind": "image",
  "provider": "gemini",
  "model": "gemini-3.1-flash-image",
  "mimeType": "image/png"
}
```

Failure:

```json
{
  "success": false,
  "errorCode": "CONFIG_ERROR",
  "error": "…",
  "hint": "Run: mediagen config set gemini"
}
```

Exit codes: `0` success, `2` invalid input, `3` configuration, `4` generation
or I/O failure.

Act on `errorCode`, and pass the `hint` on to the user — it names a concrete
next action.

| `errorCode`                   | What to do                                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------------------------ |
| `CONFIG_ERROR`                | **Tell the user to run `npx -y mediagen init` in their terminal.** See below.                    |
| `VALIDATION_ERROR`            | The message names the supported values. Fix the request and retry once.                          |
| `CONTENT_BLOCKED`             | The provider declined the prompt. Rephrase, or suggest another provider. Do not retry unchanged. |
| `API_ERROR` / `NETWORK_ERROR` | Retry once. If it persists, suggest another provider.                                            |
| `TIMEOUT`                     | The job outlived the wait. Retry, or suggest a faster model.                                     |
| `FILE_ERROR`                  | A path problem. Check the path with the user.                                                    |

## Never ask for an API key

On `CONFIG_ERROR`, tell the user to run `npx -y mediagen init` in their own terminal.

**Do not ask the user to paste an API key into this conversation**, and do not
offer to set one for them. Keys pasted into a chat end up in transcripts and
logs. `npx -y mediagen init` prompts without echoing and stores the key with
owner-only permissions; `echo "$KEY" | npx -y mediagen config set <provider> --stdin`
is the scriptable equivalent. There is deliberately no flag that takes a key
as an argument.

`npx -y mediagen doctor` reports which providers are configured, which layer each key
came from, and whether it still works.

## Examples

```bash
# A specific prompt beats a short one.
npx -y mediagen image "A red steel bicycle leaning against a wet brick wall, seen from
  across the street at eye level. Overcast afternoon light, no direct sun.
  Shallow depth of field, 50mm. Rain beading on the frame." --json

# Wide banner, marked for publication.
npx -y mediagen image "..." --aspect-ratio 21:9 --size 2K --mark --json

# Video: slow, and Gemini only.
npx -y mediagen video "A marble rolling fast down a wooden track, continuous smooth
  shot following it from the side, warm afternoon light" --duration 6 --json

# Edit an existing image.
npx -y mediagen image "Replace the sky with heavy storm clouds, keep the lighting on
  the building consistent" --input ./photo.jpg --json

# Find out what is available before choosing.
npx -y mediagen models --json
```
