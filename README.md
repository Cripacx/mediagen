# mediagen — CLI + MCP + Agent Skill

[![npm](https://img.shields.io/npm/v/mediagen)](https://www.npmjs.com/package/mediagen)
[![CI](https://github.com/Cripacx/mediagen/actions/workflows/ci.yml/badge.svg)](https://github.com/Cripacx/mediagen/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/mediagen)](https://nodejs.org)

Image and video generation across Google Gemini, OpenAI and Kie AI — one
request shape in front of all of them, reachable from a command line, an MCP
server, or an agent skill.

```bash
npx -y mediagen image "a red steel bicycle against a wet brick wall, overcast light, 50mm"
```

## Features

- Generate images and video from text prompts, or edit existing media, across
  **Google Gemini**, **OpenAI** and **Kie AI** (~30 aggregated models)
- **Three execution modes**: CLI, MCP server, or agent skill — all running the
  same pipeline, so none of them can do something the others cannot
- **Capability checks before the request is sent.** An aspect ratio, size or
  duration the model cannot produce is refused by name, listing what it does
  support. Nothing is silently substituted
- **Model listings that explain themselves**: `mediagen models` shows what each
  provider would use right now and whether that came from your request, your
  configuration, or the provider's default
- **Layered configuration with provenance** — environment, then `.env`, then a
  config file, with every value reporting which layer answered
- **API keys never taken as arguments**: hidden prompt or stdin only, verified
  against the live API before being stored, masked whenever displayed
- **EU AI Act content marking**: IPTC/XMP `DigitalSourceType` for machines and
  a composited label for people, as two independent switches
- **Built for scripting**: `--json` emits exactly one object on stdout, with
  stable exit codes and an actionable hint on every error
- Kie's model catalogue is **generated from Kie's own documentation**, not
  maintained by hand, with a scheduled drift check

## Prerequisites

- At least one API key:
  - Google Gemini ([get one here](https://aistudio.google.com/apikey)) — images
    **and** video
  - OpenAI ([get one here](https://platform.openai.com/api-keys)) — images
  - Kie AI ([get one here](https://kie.ai/api-key)) — ~30 third-party models
- Node.js 20.11 or later

## Installation

Three ways to use mediagen. They are independent — pick whichever fits, or use
several.

### As an agent skill

```bash
npx -y skills add Cripacx/mediagen --skill mediagen
```

That is the entire installation. **The CLI does not need installing
separately** — the skill invokes `npx -y mediagen`, which fetches it on first
use and runs it from the npx cache afterwards.

The skill teaches the agent how to write a prompt worth sending, which provider
suits which task, how to read the JSON contract, and to ask _you_ to set up
keys rather than requesting them in chat.

### As a CLI

No installation needed:

```bash
npx -y mediagen image "a logo for a coffee roastery, flat vector, two colours"
```

Or install it globally, if you use it often enough to want the shorter command:

```bash
npm install -g mediagen
```

> [!NOTE]
> Always pass a subcommand. Bare `mediagen` prints help; `mediagen mcp` starts
> the MCP server.

### As an MCP server

The server is the same package, started with `mediagen mcp`. It exposes three
tools: `generate_media`, `list_models` and `check_configuration`.

**Option A — Claude Code**

```bash
claude mcp add mediagen --env GEMINI_API_KEY=your-api-key-here -- npx -y mediagen mcp
```

The `--` separates Claude's own flags from the command that starts the server.
Add `--scope project` or `--scope user` to change where the entry is written.

**Option B — Claude Desktop**

Settings → Developer → Edit Config, or edit directly:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "mediagen": {
      "command": "npx",
      "args": ["-y", "mediagen", "mcp"],
      "env": {
        "GEMINI_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

Restart Claude Desktop afterwards.

**Option C — VS Code**

```bash
code --add-mcp "{\"name\":\"mediagen\",\"command\":\"npx\",\"args\":[\"-y\",\"mediagen\",\"mcp\"]}"
```

Or create `.vscode/mcp.json` in your workspace — note that VS Code uses
`servers`, not `mcpServers`:

```json
{
  "servers": {
    "mediagen": {
      "command": "npx",
      "args": ["-y", "mediagen", "mcp"]
    }
  }
}
```

**Option D — any other MCP client**

Cursor, Windsurf, Zed and most others take the same shape as Claude Desktop, in
their own config file:

| Field     | Value                       |
| --------- | --------------------------- |
| `command` | `npx`                       |
| `args`    | `["-y", "mediagen", "mcp"]` |
| transport | stdio                       |

> [!TIP]
> `env` can be omitted from any of these once you have run `mediagen init` —
> the server reads the same configuration the CLI does.

## Configuration

### Setting up keys

```bash
npx -y mediagen init
```

An interactive wizard: pick providers, enter each key without it being echoed,
verify each against the live API, choose a default. It writes one config file
with owner-only permissions.

For CI and scripts, where there is no terminal:

```bash
echo "$GEMINI_API_KEY" | npx -y mediagen config set gemini --stdin
```

Then confirm everything works:

```bash
npx -y mediagen doctor
```

`doctor` reports, per provider, whether a key is configured, which layer it came
from, and whether the provider accepts it — keeping _not configured_,
_rejected_, _unreachable_ and _no cheap way to check_ distinct, because they
call for four different fixes.

> [!WARNING]
> There is deliberately no flag that takes an API key as an argument. Arguments
> land in shell history and in the process list, where they outlive the command
> that used them.

### Environment variables

Settings resolve from the environment first, then `.env` in the working
directory, then the config file.

| Variable                                          | Purpose                       |
| ------------------------------------------------- | ----------------------------- |
| `GEMINI_API_KEY`, `OPENAI_API_KEY`, `KIE_API_KEY` | credentials; at least one     |
| `MEDIAGEN_PROVIDER`                               | default provider              |
| `GEMINI_MODEL`, `OPENAI_MODEL`, `KIE_MODEL`       | default model per provider    |
| `MEDIAGEN_OUTPUT_DIR`                             | where media is saved          |
| `MEDIAGEN_QUALITY`                                | `fast`, `balanced`, `quality` |

```bash
mediagen config list        # every value, and which layer supplied it
mediagen config path        # where the file lives
mediagen config unset kie   # remove one value from the file
```

> [!TIP]
> A stale environment variable shadowing the key you just configured is the most
> expensive failure this kind of tool has. `config list` marks every shadowed
> value, so you can see it rather than guess.

## Usage

```bash
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

### Scripting

With `--json`, stdout carries **exactly one JSON object and nothing else**.
Without it the saved path is the **last line**, and a failure writes nothing to
stdout at all — so reading the last line can never hand you an error message
where you expected a path.

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

```json
{
  "success": false,
  "errorCode": "CONFIG_ERROR",
  "error": "No API key for Google Gemini. Set GEMINI_API_KEY to your Google AI API key.",
  "hint": "Run: mediagen config set gemini — get a key at https://aistudio.google.com/apikey"
}
```

| Exit code | Meaning                          |
| --------- | -------------------------------- |
| `0`       | success                          |
| `2`       | invalid input or usage           |
| `3`       | configuration or credentials     |
| `4`       | generation, network, or file I/O |

Error codes are `VALIDATION_ERROR`, `CONFIG_ERROR`, `API_ERROR`,
`NETWORK_ERROR`, `FILE_ERROR`, `CONTENT_BLOCKED` and `TIMEOUT`.

## Providers

| Provider          | Images                         | Video | Editing | Key verification                 |
| ----------------- | ------------------------------ | ----- | ------- | -------------------------------- |
| **Google Gemini** | Nano Banana family, up to 4K   | yes   | yes     | live probe                       |
| **OpenAI**        | gpt-image family, DALL·E       | —     | yes     | live probe                       |
| **Kie AI**        | ~30 models: Flux, Imagen, Grok | —     | most    | no cheap probe; reported as such |

Run `mediagen models` for the full list and what each would be used for.

> [!NOTE]
> OpenAI takes pixel dimensions rather than aspect ratios and genuinely cannot
> produce 16:9 — its widest image is 1536×1024, which is 3:2. Asking for 16:9 is
> refused by name rather than quietly served as something else. For anything
> wider than 3:2, use Gemini.

A model absent from the listings is still sent to the provider, so a newly
released model works before mediagen knows about it.

## Content marking

The EU AI Act splits disclosure into two duties, so mediagen has two
independent switches:

| Flag              | Duty                     | What it does                                           |
| ----------------- | ------------------------ | ------------------------------------------------------ |
| `--mark`          | make it machine-readable | writes IPTC/XMP `DigitalSourceType`, changes no pixels |
| `--visible-label` | disclose it to people    | composites a visible label into the image              |

Both default to off. `mediagen mark <file…>` applies them to media that already
exists, in place. Existing provider metadata is never overwritten, and a second
pass does not mark twice.

> [!NOTE]
> No C2PA manifest is written. A manifest only carries provenance if it is
> signed, signing needs a certificate you do not have, and a test-signed manifest
> would look like provenance while carrying none. Marking video is not supported
> yet and is refused by name rather than silently skipped.

## Prompt tips

mediagen sends your prompt **exactly as written** — it does not expand or
rewrite it. A short prompt underdetermines the image, and the model resolves
everything you left unsaid arbitrarily. Decide these before generating:

- **Subject** — what is present, and what it is doing
- **Composition** — framing, where the subject sits, depth, what is cropped
- **Light** — source, direction, hardness, colour temperature, time of day.
  This decides more than anything else whether an image reads as photographic
- **Camera or medium** — lens and distance for a photograph, tool and surface
  for an illustration. This resolves scale, which models otherwise guess at
- **Material** — what things are made of and how they catch light
- **Atmosphere** — mood and palette, stated plainly rather than piled up

Say what you want rather than what you do not; "an empty street at dawn" works
where "no people" often does not. Avoid stacking style words — one clear
statement beats five adjectives. Text inside images is unreliable across every
provider here.

The agent skill carries this guidance, so an agent writes the prompt itself and
you do not have to.

## How it works

One pipeline, three frontends. The CLI and MCP server translate input and
format output and contain no behaviour of their own, so a capability cannot
exist in one and be missing from the other.

```
                CLI  ·  MCP server  ·  agent skill
                            ↓
   request → model resolution → capability check → provider client
                            ↓
              save to disk → optional AI marking → result
```

Each provider is one self-contained directory declaring what it supports.
Adding one touches a single line outside its own folder. Provider manifests
carry no vendor SDK imports, so `doctor` and `config` never pay to load one.

## Project structure

```
src/
├── types/          leaf types everything shares
├── core/           pipeline, errors, capability checks, file handling
├── config/         the three configuration layers, key verification
├── providers/      one directory per provider, plus the registry
│   ├── gemini/
│   ├── openai/
│   ├── kie/
│   └── shared/     polling for asynchronous providers
├── cli/            the command tree; output.ts owns stdout
├── mcp/            the MCP server
└── marking/        AI content marking
skills/mediagen/    the agent skill
scripts/            catalogue generation, version syncing
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, how to add a
provider, and how releases are cut.
