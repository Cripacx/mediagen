# mediagen

One interface for generating images and video across several commercial
providers — so you can pick the right model for a task without learning five
different APIs.

Reachable three ways: a **command line**, an **MCP server**, and an **agent
skill**. All three run the same pipeline, so anything one can do, all of them
can.

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

## Providers

| Provider          | Images                        | Video | Editing | Key check                        |
| ----------------- | ----------------------------- | ----- | ------- | -------------------------------- |
| **Google Gemini** | Nano Banana family, up to 4K  | yes   | yes     | live probe                       |
| **OpenAI**        | gpt-image family, DALL·E      | —     | yes     | live probe                       |
| **Kie AI**        | ~30 models: Flux, Imagen, ... | —     | most    | no cheap probe; reported as such |

Gemini offers the widest range of shapes — 14 aspect ratios including 21:9 and
8:1. OpenAI takes pixel dimensions rather than ratios and genuinely cannot do
16:9; asking for one is refused by name rather than quietly served as 3:2. Kie
aggregates other vendors' models, and its catalogue is generated from Kie's own
documentation rather than maintained by hand.

## What it does

**Generation and editing.** Text to image, image to image, text to video, image
to video. Aspect ratio, resolution, duration and quality preset where the model
supports them.

**Honest capability checks.** A shape a model cannot produce is refused _before
the request is sent_, naming what it does support. Nothing is silently
substituted — asking for 21:9 and receiving 1:1 without being told is a lie the
tool will not tell.

**Model choice that explains itself.** `mediagen models` shows which model each
provider would use right now and where that choice came from — the request,
your configuration, or the provider's default. A model absent from the listing
is still sent to the provider, so a newly released one works immediately.

**Configuration you can debug.** Settings resolve from the environment, then
`.env`, then a per-machine config file, and every lookup reports which layer
answered. A stale environment variable shadowing the key you just set is the
most expensive failure this kind of tool has, and `mediagen config list` says
so out loud.

**Keys handled properly.** Never accepted as a command argument, where they
would land in shell history and the process list. Read from a hidden prompt or
from stdin, verified with one live request before being stored, and masked
whenever shown.

**AI content marking.** Two independent switches, matching the two duties the
EU AI Act sets: `--mark` writes the IPTC/XMP `DigitalSourceType` that platforms
read, and `--visible-label` composites a disclosure people can see. Existing
provider metadata is never overwritten.

**Long jobs handled.** Video takes minutes. Asynchronous providers are polled
with backoff and a real timeout, with progress on stderr — never on stdout,
which belongs to the output contract.

## Installing

```bash
npm install -g mediagen
```

Or skip installing entirely — `npx -y mediagen <command>` works the same way
and runs an existing install if there is one.

Node 20.11 or later.

## Getting started

```bash
mediagen init
```

An interactive wizard: choose providers, enter each key without it being
echoed, verify each one against the live API, and pick a default. It writes a
single config file with owner-only permissions.

For scripts and CI, where there is no terminal:

```bash
echo "$GEMINI_API_KEY" | mediagen config set gemini --stdin
```

Then check everything is working:

```bash
mediagen doctor
```

It reports, per provider, whether a key is configured, which layer it came
from, and whether the provider actually accepts it — keeping "not configured",
"rejected", "unreachable" and "no cheap way to check" distinct, because they
call for four different fixes.

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
| `--output-dir <dir>`     |                                      |
| `--quality <preset>`     | `fast`, `balanced`, `quality`        |
| `--mark`                 | machine-readable AI-generated marker |
| `--visible-label`        | visible AI disclosure composited in  |
| `--json`                 | exactly one JSON object on stdout    |
| `--verbose` `--quiet`    | diagnostics on stderr                |

### Scripting

With `--json`, stdout carries **exactly one JSON object and nothing else**.
Without it, the saved path is the **last line**, and a failure writes nothing
to stdout at all — so reading the last line can never hand you an error message
where you expected a path.

| Exit code | Meaning                          |
| --------- | -------------------------------- |
| `0`       | success                          |
| `2`       | invalid input or usage           |
| `3`       | configuration or credentials     |
| `4`       | generation, network, or file I/O |

Failures carry a machine-readable code and an actionable hint:

```json
{
  "success": false,
  "errorCode": "CONFIG_ERROR",
  "error": "No API key for Google Gemini. Set GEMINI_API_KEY to your Google AI API key.",
  "hint": "Run: mediagen config set gemini — get a key at https://aistudio.google.com/apikey"
}
```

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

## As an MCP server

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

`env` can be omitted if you have run `mediagen init` — the server reads the
same configuration the CLI does.

Three tools: `generate_media`, `list_models`, and `check_configuration`.

## As an agent skill

```bash
npx skills add Cripacx/mediagen --skill mediagen
```

Teaches an agent to drive the CLI: how to write a prompt worth sending, which
provider suits which task, how to read the JSON contract, and — importantly —
to tell you to run `mediagen init` rather than ever asking you to paste an API
key into a chat.

The skill installs no CLI, so it invokes `npx -y mediagen`, which needs none.

## Development

```bash
npm install
npm run verify   # typecheck, lint, format, cycles, tests
```

`npm test` builds first: the output-contract tests run the real `dist/bin.js`,
because an in-process test can pass while the shipped binary writes a stray
line to stdout.

Tests never read your config file or inherit your API keys — `test/setup.ts`
enforces that, and a test fails if that enforcement is ever removed.

### Adding a provider

Add one directory under `src/providers/` with a manifest, and one line in
`src/providers/registry.ts`. The manifest holds only data and validation, and
reaches its client through a lazy factory, so `doctor` and `config` never load
a vendor SDK. Everything else — capability checks, model resolution, output
handling, marking — is shared and needs no edit.

### The Kie catalogue

Kie's model table is generated from Kie's own documentation:

```bash
npm run sync:kie-models
```

`npm run check:kie-models` reports drift and runs on a schedule rather than in
CI, so no pull request depends on a third-party site being up.

### Notes in the code

Comments cite section numbers such as `§6.3`. Those refer to the written
specification this was implemented from, which is no longer in the tree; it
remains in git history at the first commit if you want the original wording.
The comments themselves state the reasoning, so nothing depends on having it.

Two deliberate departures from that specification are worth knowing about:

- **Prompts are sent exactly as written.** The specification had the tool
  expand a short prompt with a second model call. That is redundant when an
  agent is driving it, so the prompt-writing guidance lives in the skill
  instead. The cost: typing `mediagen image "a cat"` straight into a shell
  gives you exactly that prompt.
- **`mediagen` with no arguments prints help**, rather than starting the MCP
  server. `mediagen mcp` starts it. Hosts spawn whatever their configuration
  names, so nothing needed the zero-argument form, and it made every script and
  agent shell that ran the bare command hang.

## Releasing

**Actions → Release → Run workflow**, with `patch`, `minor`, `major`, or an
exact version. Tick **dry run** first to see what would happen without
publishing anything.

Manual on purpose: npm unpublish is restricted to a short window and the MCP
registry has no delete, so a release is a decision rather than something a
merge makes on your behalf.

The workflow verifies, bumps the version in `package.json` and `server.json`
together, commits, tags, publishes to npm, publishes to the MCP registry, and
creates the GitHub Release last — so a release never points at something that
does not exist yet.

Neither destination stores a secret: npm trusted publishing and
`mcp-publisher login github-oidc` both authenticate over GitHub OIDC, and npm
attaches provenance automatically.

Release notes come from pull requests merged since the last tag, grouped by the
labels in [.github/release.yml](.github/release.yml). Work pushed straight to
`main` appears only in the compare link, so merge through pull requests if you
want them to read well.

### Cutting a version by hand

```bash
node scripts/set-version.mjs patch
```

```bash
npm run verify
```

```bash
npm publish --access public
```

`node scripts/set-version.mjs --check` fails if the version fields ever drift
apart, and `npm test` checks the same thing.

## Status

Every provider integration is written against vendor documentation and SDK type
declarations. The paths around generation are covered by tests — configuration,
capability validation, polling states, file handling, marking against real
images, the MCP server over real stdio — but a live generation is the thing a
real API key confirms.

## Licence

MIT
