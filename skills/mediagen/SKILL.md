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

**Run `npx -y mediagen models --json` before generating.** Not as a formality:
the user has keys for some providers and not others, and has an order they
prefer. Neither is guessable, and a model from an unconfigured provider fails
after you have already committed to it.

What comes back:

```json
{
  "kind": "image",
  "wouldUse": { "provider": "gemini", "model": "gemini-3.1-flash-image" },
  "usableProviders": ["gemini", "kie"],
  "providerPriority": ["gemini", "kie", "openai"],
  "providers": [
    { "provider": "gemini", "usable": true, "preferred": true, "rank": 1, "listed": ["…"] },
    {
      "provider": "openai",
      "usable": false,
      "configured": false,
      "fix": "mediagen config set openai"
    }
  ]
}
```

Read it in this order:

1. **`wouldUse`** — what a request with no `--provider` gets. If it suits the
   task, pass neither flag and let it happen. This already honours the user's
   priority and skips anything unconfigured.
2. **`usableProviders`** — the only ones you may name. A provider outside this
   list has no key; naming it produces a `CONFIG_ERROR`, not an image.
3. **`providerPriority`** — the user's stated order. Prefer earlier entries
   when more than one usable provider fits. Their order beats the guidance in
   the table below.
4. **`listed`** per provider — the models, with their capabilities.
5. **`source`** per provider — where its `effectiveModel` came from. `"configuration"`
   means the user chose that model for that provider deliberately. Leave it
   alone unless the task actually needs a different one, and say so when you
   override it.

If nothing is usable, `wouldUse` is `null` and `usableProviders` is empty. Do
not generate: tell the user, and pass on the `fix` command for whichever
provider suits the task.

Mention an unconfigured provider only when it would genuinely have been the
better choice — "OpenAI would suit this, but has no key; `mediagen config set
openai` adds one". Do not list every missing key on every run.

### Preferences are settings, not something to repeat

When the user states a lasting preference rather than a one-off, offer to
store it. The difference is "use gemini-3-pro-image for this" against "always
use gemini-3-pro-image" — the second is a setting, and passing `--model` on
every future call instead is how it gets forgotten.

```bash
# Which model this provider uses when none is named
npx -y mediagen config set gemini-model gemini-3-pro-image

# Which providers to prefer, best first
npx -y mediagen config set provider-priority kie,gemini,openai
```

`config set <provider>-model` takes any id, including one not in `listed` — a
newly released model is settable before this skill knows it exists. Clear it
again with `npx -y mediagen config unset gemini-model`, which returns that
provider to its own default.

Offer this; do not do it unasked. It changes what every future run does,
including runs that have nothing to do with the current task.

### What each provider is good at

Applies only to providers in `usableProviders`, and yields to the user's
priority order when both fit.

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

Do not guess model ids. The `listed` array has them, and an id absent from it
is still sent to the provider rather than rejected — so a newly released model
works before this skill knows about it.

**When the user names a provider or model, use it as given** — even if it is
not their configured first preference. Priority is what to do when nobody
said.

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
```

Generating never marks. Marking is a separate command, run afterwards — see
below.

## Marking

Marking is always a second pass over a file that already exists:
`npx -y mediagen mark <file...>`. Generating does not mark, and there is no
flag to make it.

That is not a style preference. A visible label has to go where the subject
is not, and only the finished image can say where that is. And the
machine-readable marker is not free either: adding metadata to a JPEG or WebP
means decoding and re-encoding it, so marking costs a second lossy pass. Worth
paying deliberately; not worth paying as a side effect of asking for an image.

**Recommend marking whenever the output is photorealistic, will be published,
or is for professional use.** `mediagen mark` writes the IPTC/XMP
`DigitalSourceType` that platforms read. In the EU it is a legal duty for the
provider of synthetic content.

`--visible-label` is the separate duty — disclosure to people who see the
image. It composites the European Commission's official AI-content icon and
picks the right variant on its own: "AI GENERATED" by default, "AI MODIFIED"
with `--modified`, for media a model altered rather than made.

### The workflow

1. **Generate.** The saved path comes back on stdout.
2. **Open the image and look at it.** You wrote the prompt, but the model
   decided the composition.
3. **Mark it, naming the corner** that covers nothing important:

```bash
npx -y mediagen mark ./output/image-….png --visible-label --label-position top-left
```

That writes `image-….labelled.png` beside the original, and writes the
machine-readable marker into the original itself. Both files stay on disk, so
a badly placed label costs nothing but a rerun of step 3, and whichever file
gets published carries the disclosure.

If you cannot view images, leave `--label-position` off: it defaults to
bottom-right. `auto` measures each corner and picks the calmest, but it only
knows where the image is busy, not what in it matters — so if you do know the
composition, naming a corner beats it.

The user may have configured marking on by default. If they have, `mediagen
mark` draws the visible label without your asking; `--no-mark` and
`--no-visible-label` turn each off for a single run.

**Video cannot be marked yet.** Writing XMP into a video container is a
different operation from writing it into a still, and this build does not do
it — a video passed to `mediagen mark` is refused by name rather than silently
ignored. If a
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

# Wide banner for publication: generate, look at it, then mark.
npx -y mediagen image "..." --aspect-ratio 21:9 --size 2K --json
npx -y mediagen mark ./output/image-….png --visible-label --label-position top-left --json

# Video: slow, and Gemini only.
npx -y mediagen video "A marble rolling fast down a wooden track, continuous smooth
  shot following it from the side, warm afternoon light" --duration 6 --json

# Edit an existing image.
npx -y mediagen image "Replace the sky with heavy storm clouds, keep the lighting on
  the building consistent" --input ./photo.jpg --json

# Find out what is available before choosing.
npx -y mediagen models --json
```
