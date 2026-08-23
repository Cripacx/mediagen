# mediagen — an image and video generation skill for coding agents

[![npm](https://img.shields.io/npm/v/mediagen)](https://www.npmjs.com/package/mediagen)
[![CI](https://github.com/Cripacx/mediagen/actions/workflows/ci.yml/badge.svg)](https://github.com/Cripacx/mediagen/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/mediagen)](https://nodejs.org)

Give your agent image and video generation across **Google Gemini**, **OpenAI**
and **Kie AI** — one skill, one install, no API to learn.

Say roughly what you want and let it decide the rest:

```
You:   Make a hero image for the landing page, wide, something moody and industrial.

Agent: npx -y mediagen image "A disused loading dock at dusk, wet concrete…"
         --aspect-ratio 21:9 --json
       → ./output/image-20260823T094107Z.png
```

It wrote the prompt out in full, knew 21:9 rules OpenAI out, and read the path
back from `--json`.

Or be exact, and it stops deciding:

```
You:   Same thing with gemini-3-pro-image, 21:9, 4K, marked as AI-generated,
       saved as hero.png.

Agent: npx -y mediagen image "A disused loading dock at dusk, wet concrete…"
         --model gemini-3-pro-image --aspect-ratio 21:9 --size 4K
         --mark --output-name hero.png --json
       → ./output/hero.png
```

Anything the CLI takes can be asked for in words — provider, model, aspect
ratio, size, output name and directory, quality preset, video duration, an
input image to edit, and whether to mark the result. Name any of them and the
agent uses it as given; leave it out and it chooses, or falls back to what you
configured.

## Install

```bash
npx -y skills add Cripacx/mediagen --skill mediagen
```

That is the whole installation. **Nothing else to set up** — the skill runs the
CLI through `npx`, which fetches it on first use and caches it afterwards.

Then give it a key:

```bash
npx -y mediagen init
```

An interactive wizard: pick providers, enter each key without it being echoed,
verify each against the live API, choose a model per provider, and set a
default. One key is enough to start.

Now just ask your agent for an image.

## What your agent can do with it

- **Generate images and video** from a description, or edit media you already
  have
- **Choose the right provider** for the task — the skill knows Gemini handles
  21:9 and video, that OpenAI cannot do 16:9 at all, and that Kie aggregates
  around thirty third-party models
- **Take your instructions literally when you give them.** Name a model, a
  ratio, a size or a filename and it is used as stated. `mediagen models` is
  there when you want to see what is available before choosing
- **Write the prompt properly.** The skill carries prompt-writing guidance, so
  "a hero image, moody and industrial" becomes a full description of subject,
  composition, light, camera and materials before anything is sent
- **Mark AI-generated output** when it matters — the skill suggests it for
  anything photorealistic or destined for publication
- **Recover from failures on its own**, because every error carries a
  machine-readable code and a next action

And what it will not do: **ask you to paste an API key into the chat.** On a
configuration error the skill tells you to run `mediagen init` in your own
terminal.

## Prerequisites

- At least one API key:
  - Google Gemini ([get one here](https://aistudio.google.com/apikey)) — images
    **and** video, widest range of shapes
  - OpenAI ([get one here](https://platform.openai.com/api-keys)) — images
  - Kie AI ([get one here](https://kie.ai/api-key)) — ~30 third-party models
- Node.js 20.11 or later

## Configuration

`mediagen init` covers first-time setup. To change something later:

```bash
npx -y mediagen config edit
```

A menu of every setting with its current value and where that value came from —
provider, model, key, output directory, quality preset, and whether generated
media is marked by default. Each change is written as you make it.

For CI and scripts, where there is no terminal, `config set` takes the same
settings as arguments:

```bash
echo "$GEMINI_API_KEY" | npx -y mediagen config set gemini --stdin
npx -y mediagen config set gemini-model gemini-3-pro-image
```

To check what is configured and whether it still works:

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

Settings resolve from the environment first, then `.env` in the working
directory, then the config file:

| Variable                                          | Purpose                        |
| ------------------------------------------------- | ------------------------------ |
| `GEMINI_API_KEY`, `OPENAI_API_KEY`, `KIE_API_KEY` | credentials; at least one      |
| `MEDIAGEN_PROVIDER`                               | default provider               |
| `GEMINI_MODEL`, `OPENAI_MODEL`, `KIE_MODEL`       | default model per provider     |
| `MEDIAGEN_OUTPUT_DIR`                             | where media is saved           |
| `MEDIAGEN_QUALITY`                                | `fast`, `balanced`, `quality`  |
| `MEDIAGEN_MARK`                                   | mark output by default         |
| `MEDIAGEN_VISIBLE_LABEL`                          | add a visible label by default |

> [!TIP]
> A stale environment variable shadowing the key you just configured is the most
> expensive failure this kind of tool has. `mediagen config list` marks every
> shadowed value, so you can see it rather than guess.

## Providers

| Provider          | Images                         | Video | Editing | Key verification                 |
| ----------------- | ------------------------------ | ----- | ------- | -------------------------------- |
| **Google Gemini** | Nano Banana family, up to 4K   | yes   | yes     | live probe                       |
| **OpenAI**        | gpt-image family, DALL·E       | —     | yes     | live probe                       |
| **Kie AI**        | ~30 models: Flux, Imagen, Grok | —     | most    | no cheap probe; reported as such |

> [!NOTE]
> OpenAI takes pixel dimensions rather than aspect ratios and genuinely cannot
> produce 16:9 — its widest image is 1536×1024, which is 3:2. Asking for 16:9 is
> refused by name rather than quietly served as something else. The skill knows
> this and routes wide shapes to Gemini.

A model absent from the listings is still sent to the provider, so a newly
released model works before mediagen knows about it. Kie's catalogue is
generated from Kie's own documentation rather than maintained by hand.

## Content marking

The EU AI Act splits disclosure into two duties, so mediagen has two
independent switches:

| Flag              | Duty                     | What it does                                           |
| ----------------- | ------------------------ | ------------------------------------------------------ |
| `--mark`          | make it machine-readable | writes IPTC/XMP `DigitalSourceType`, changes no pixels |
| `--visible-label` | disclose it to people    | composites the EU's official AI-content label          |

Both default to off; the skill suggests `--mark` for photorealistic or
published output. To turn either on for every generation, set it once:

```bash
npx -y mediagen config edit      # "AI marking by default"
```

A configured default is still overridable per command with `--no-mark` or
`--no-visible-label`.

The visible label is the European Commission's own icon, published with the
Code of Practice on Transparency of AI-generated Content and free to use
without attribution. Two of its three variants are used, chosen automatically:
**AI GENERATED** when the media came from a prompt alone, **AI MODIFIED** when
you supplied media and a model altered it. The light or dark version is picked
from what is actually under the corner it lands in, because a label nobody can
read is not a disclosure. `mediagen mark` takes `--modified` to state the
second claim for a file it cannot infer it from.

`mediagen mark <file…>` applies them to media that already exists, in place.
Existing provider metadata is never overwritten, and a second pass does not
mark twice.

> [!NOTE]
> No C2PA manifest is written. A manifest only carries provenance if it is
> signed, signing needs a certificate you do not have, and a test-signed manifest
> would look like provenance while carrying none. Marking video is not supported
> yet and is refused by name rather than silently skipped.

---

## Using it without an agent

The skill is a wrapper around a CLI, and the CLI stands on its own.

```bash
npx -y mediagen image "a wide banner" --aspect-ratio 21:9 --size 2K --mark
npx -y mediagen image "make the sky stormy" --input ./photo.jpg
npx -y mediagen video "a marble rolling down a wooden track" --duration 6
npx -y mediagen models
```

Install it globally if you use it often enough to want the shorter command:

```bash
npm install -g mediagen
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
> Without the skill, prompt writing is on you. mediagen sends the prompt exactly
> as written — it does not expand or rewrite it. Decide subject, composition,
> light, camera or medium, materials and atmosphere, and say what you want
> rather than what you do not.

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

| Exit code | Meaning                          |
| --------- | -------------------------------- |
| `0`       | success                          |
| `2`       | invalid input or usage           |
| `3`       | configuration or credentials     |
| `4`       | generation, network, or file I/O |

A failure carries an `errorCode` — one of `VALIDATION_ERROR`, `CONFIG_ERROR`,
`API_ERROR`, `NETWORK_ERROR`, `FILE_ERROR`, `CONTENT_BLOCKED` or `TIMEOUT` —
and a `hint` naming a concrete next action.

## Using it as an MCP server

For hosts that speak MCP rather than running skills. Same package, started with
`mediagen mcp`, exposing `generate_media`, `list_models` and
`check_configuration`.

<details>
<summary><strong>Claude Code</strong></summary>

```bash
claude mcp add mediagen --env GEMINI_API_KEY=your-api-key-here -- npx -y mediagen mcp
```

The `--` separates Claude's own flags from the command that starts the server.
Add `--scope project` or `--scope user` to change where the entry is written.

</details>

<details>
<summary><strong>Claude Desktop</strong></summary>

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

</details>

<details>
<summary><strong>VS Code</strong></summary>

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

</details>

<details>
<summary><strong>Any other MCP client</strong></summary>

Cursor, Windsurf, Zed and most others take the same shape as Claude Desktop, in
their own config file:

| Field     | Value                       |
| --------- | --------------------------- |
| `command` | `npx`                       |
| `args`    | `["-y", "mediagen", "mcp"]` |
| transport | stdio                       |

</details>

`env` can be omitted from any of these once `mediagen init` has run — the
server reads the same configuration the CLI does.

## How it works

One pipeline, three frontends. The skill drives the CLI; the MCP server is a
second adapter over the same core. Neither contains behaviour of its own, so a
capability cannot exist in one and be missing from the other.

```
      agent skill  ·  CLI  ·  MCP server
                     ↓
 request → model resolution → capability check → provider client
                     ↓
       save to disk → optional AI marking → result
```

Each provider is one self-contained directory declaring what it supports.
Adding one touches a single line outside its own folder. Provider manifests
carry no vendor SDK imports, so `doctor` and `config` never pay to load one.

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
