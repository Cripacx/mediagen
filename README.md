# mediagen

[![npm](https://img.shields.io/npm/v/mediagen)](https://www.npmjs.com/package/mediagen)
[![CI](https://github.com/Cripacx/mediagen/actions/workflows/ci.yml/badge.svg)](https://github.com/Cripacx/mediagen/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/mediagen)](https://nodejs.org)
[![licence](https://img.shields.io/npm/l/mediagen)](LICENSE)

**One interface for generating images and video across several commercial
providers** — so you can pick the right model for a task without learning five
different APIs.

Reachable three ways, all running the same pipeline: a **command line**, an
**MCP server**, and an **agent skill**.

```bash
npx -y mediagen image "a red steel bicycle against a wet brick wall, overcast light, 50mm" --json
```

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

## Why

Every image API has its own vocabulary. One takes aspect ratios, another takes
pixel dimensions. One calls a quality level `high`, another calls it `hd`. One
wants your source image inline, another wants a URL you have to upload first.

mediagen puts one request shape in front of all of them — and refuses to
pretend they are more alike than they are. If a model cannot produce the shape
you asked for, you are told before the request is sent, with the shapes it can
produce. Nothing is silently substituted.

## Features

- **Images and video**, text-to-media and media-to-media, across Gemini, OpenAI
  and Kie AI.
- **Capability checks that happen first.** An unsupported aspect ratio, size or
  duration is refused before any network call, naming what the model supports.
- **Model choice that explains itself.** `mediagen models` shows what each
  provider would use right now and whether that came from your request, your
  configuration, or the provider's default.
- **Configuration you can debug.** Settings resolve from the environment, then
  `.env`, then a config file — and every value reports which layer answered.
- **Keys handled properly.** Never a command argument. Read from a hidden
  prompt or stdin, verified against the live API before being stored, masked
  whenever displayed.
- **AI content marking.** IPTC/XMP `DigitalSourceType` for machines, a
  composited label for people — two independent switches, matching the two
  duties the EU AI Act sets.
- **Built for scripts.** `--json` puts exactly one object on stdout and nothing
  else. Stable exit codes. Every error carries a code and an actionable hint.

## Providers

| Provider          | Images                         | Video | Editing | Key verification                 |
| ----------------- | ------------------------------ | ----- | ------- | -------------------------------- |
| **Google Gemini** | Nano Banana family, up to 4K   | yes   | yes     | live probe                       |
| **OpenAI**        | gpt-image family, DALL·E       | —     | yes     | live probe                       |
| **Kie AI**        | ~30 models: Flux, Imagen, Grok | —     | most    | no cheap probe; reported as such |

Gemini has the widest range of shapes — 14 aspect ratios including 21:9 and
8:1. Kie aggregates other vendors' models, with a catalogue generated from
Kie's own documentation rather than maintained by hand.

> [!NOTE]
> OpenAI takes pixel dimensions rather than aspect ratios, and genuinely cannot
> produce 16:9 — its widest image is 1536×1024, which is 3:2. Asking for 16:9 is
> refused by name rather than quietly served as something else. For anything
> wider than 3:2, use Gemini.

## Installation

```bash
npm install -g mediagen
```

Or skip installing — `npx -y mediagen <command>` behaves identically and uses
an existing install if there is one. Requires Node 20.11 or later.

## Getting started

```bash
mediagen init
```

An interactive wizard: pick providers, enter each key without it being echoed,
verify each against the live API, choose a default. It writes one config file
with owner-only permissions.

For CI and scripts, where there is no terminal:

```bash
echo "$GEMINI_API_KEY" | mediagen config set gemini --stdin
```

Then confirm it works:

```bash
mediagen doctor
```

`doctor` reports, per provider, whether a key is configured, which layer it
came from, and whether the provider accepts it — keeping _not configured_,
_rejected_, _unreachable_ and _no cheap way to check_ distinct, because they
call for four different fixes.

> [!WARNING]
> There is deliberately no flag that takes an API key as an argument. Arguments
> land in shell history and in the process list, where they outlive the command
> that used them.

## Usage

```bash
mediagen image "a logo for a coffee roastery, flat vector, two colours"
mediagen image "a wide banner" --aspect-ratio 21:9 --size 2K --mark
mediagen image "make the sky stormy" --input ./photo.jpg
mediagen video "a marble rolling down a wooden track" --duration 6
mediagen models
mediagen mark ./photo.png --visible-label
```

### Options

| Option                   |                                      |
| ------------------------ | ------------------------------------ |
| `--provider <name>`      | `gemini`, `openai`, `kie`            |
| `--model <id>`           | see `mediagen models`                |
| `--input <path>`         | source media to edit or transform    |
| `--aspect-ratio <ratio>` | `1:1`, `16:9`, `9:16`, …             |
| `--size <size>`          | `1K`, `2K`, `4K`                     |
| `--duration <seconds>`   | video only                           |
| `--output-name <name>`   | the extension may select the format  |
| `--output-dir <dir>`     | where to save                        |
| `--quality <preset>`     | `fast`, `balanced`, `quality`        |
| `--mark`                 | machine-readable AI-generated marker |
| `--visible-label`        | visible AI disclosure composited in  |
| `--json`                 | exactly one JSON object on stdout    |
| `--verbose` `--quiet`    | diagnostics on stderr                |

> [!TIP]
> The prompt is sent exactly as written — mediagen does not rewrite it. Being
> specific about subject, composition, light, camera or medium, materials and
> atmosphere does far more for the result than any flag here.

### Scripting

With `--json`, stdout carries **exactly one JSON object and nothing else**.
Without it, the saved path is the **last line**, and a failure writes nothing to
stdout at all — so reading the last line can never hand you an error message
where you expected a path.

| Exit code | Meaning                          |
| --------- | -------------------------------- |
| `0`       | success                          |
| `2`       | invalid input or usage           |
| `3`       | configuration or credentials     |
| `4`       | generation, network, or file I/O |

Failures carry a machine-readable code and a next action:

```json
{
  "success": false,
  "errorCode": "CONFIG_ERROR",
  "error": "No API key for Google Gemini. Set GEMINI_API_KEY to your Google AI API key.",
  "hint": "Run: mediagen config set gemini — get a key at https://aistudio.google.com/apikey"
}
```

Codes are `VALIDATION_ERROR`, `CONFIG_ERROR`, `API_ERROR`, `NETWORK_ERROR`,
`FILE_ERROR`, `CONTENT_BLOCKED` and `TIMEOUT`.

## Configuration

Three layers, highest priority first:

1. the process environment
2. `.env` in the working directory
3. the config file written by `mediagen init`

| Setting          | Variable                                          |
| ---------------- | ------------------------------------------------- |
| Default provider | `MEDIAGEN_PROVIDER`                               |
| API key          | `GEMINI_API_KEY`, `OPENAI_API_KEY`, `KIE_API_KEY` |
| Model            | `GEMINI_MODEL`, `OPENAI_MODEL`, `KIE_MODEL`       |
| Output directory | `MEDIAGEN_OUTPUT_DIR`                             |
| Quality preset   | `MEDIAGEN_QUALITY`                                |

```bash
mediagen config list        # every value, and which layer supplied it
mediagen config path        # where the file lives
mediagen config unset kie   # remove one value from the file
```

> [!TIP]
> A stale environment variable shadowing the key you just configured is the most
> expensive failure this kind of tool has. `mediagen config list` marks every
> shadowed value, so you can see it instead of guessing.

## MCP server

```json
{
  "mcpServers": {
    "mediagen": {
      "command": "npx",
      "args": ["-y", "mediagen", "mcp"],
      "env": { "GEMINI_API_KEY": "..." }
    }
  }
}
```

Three tools: `generate_media`, `list_models` and `check_configuration`. `env`
can be omitted once `mediagen init` has run — the server reads the same
configuration the CLI does.

## Agent skill

```bash
npx skills add Cripacx/mediagen --skill mediagen
```

Teaches an agent to drive the CLI: how to write a prompt worth sending, which
provider suits which task, how to read the JSON contract, and — importantly —
to tell you to run `mediagen init` rather than ever asking you to paste an API
key into a chat.

The skill installs no CLI of its own, so it invokes `npx -y mediagen`, which
needs none.

## Content marking

The EU AI Act splits disclosure into two duties, so mediagen has two
independent switches:

| Flag              | Duty                     | What it does                                           |
| ----------------- | ------------------------ | ------------------------------------------------------ |
| `--mark`          | make it machine-readable | writes IPTC/XMP `DigitalSourceType`, changes no pixels |
| `--visible-label` | disclose it to people    | composites a visible label into the image              |

Both default to off. `mediagen mark <file…>` applies them to media that already
exists.

> [!NOTE]
> No C2PA manifest is written. A manifest only carries provenance if it is
> signed, signing needs a certificate you do not have, and a test-signed
> manifest would look like provenance while carrying none. Marking video is not
> supported yet and is refused by name rather than silently skipped.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development setup, how to add a
provider, and how releases are cut.
