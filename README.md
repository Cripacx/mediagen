# mediagen

Generate images and video from text prompts across several providers — from a
command line, an MCP server, or an agent skill.

The behaviour this implements is specified in [SPEC.md](SPEC.md). Section
numbers there are stable references; the code cites them.

## Status

Under construction, following the build order in §13.

| Step                                      | Spec            | State |
| ----------------------------------------- | --------------- | ----- |
| Skeleton, error taxonomy, domain types    | §2, §6.5, §12.2 | done  |
| Core pipeline, one provider               | §1.2, §6        | next  |
| CLI `image` with the output contract      | §4              |       |
| Configuration, `config`, `doctor`, `init` | §3, §4.4–4.6    |       |
| MCP server                                | §1.2            |       |
| Further providers                         | §6.1            |       |
| Model selection and `models`              | §7              |       |
| Asynchronous providers and polling        | §6.2            |       |
| Catalogue generation                      | §7.4            |       |
| Content marking                           | §9              |       |
| Skill                                     | §11             |       |
| Video                                     | §10             |       |

| Provider      | Images          | Video | Key verification         |
| ------------- | --------------- | ----- | ------------------------ |
| Google Gemini | yes             | yes   | live probe               |
| OpenAI        | yes             | —     | live probe               |
| Kie AI        | yes, ~30 models | —     | none cheap enough (§4.5) |

## Development

```bash
npm install
npm run verify   # typecheck, lint, format, cycles, tests
```

`npm test` builds first: the output-contract tests run the real `dist/bin.js`,
because an in-process test can pass while the shipped binary writes a stray
line to stdout.

## Usage

```bash
mediagen image "a red bicycle in the rain"
mediagen image "a banner" --aspect-ratio 16:9 --json
mediagen video "a marble rolling down a track" --duration 6
mediagen models          # what each provider would use, and why
mediagen mark photo.png  # mark existing media as AI-generated
```

`mediagen mcp` runs the MCP server on stdio; that is the command to put in a
host's configuration. The agent skill in
[skills/mediagen/](skills/mediagen/SKILL.md) drives the CLI.

`--json` puts exactly one object on stdout and nothing else; in human mode the
saved path is the last line. Exit codes are `0` success, `2` invalid input,
`3` configuration, `4` generation or I/O failure (§4.2, §4.3).

Credentials are read from `GEMINI_API_KEY` (and the equivalent per provider),
from `.env`, or from the config file — never from a command argument, which
would put them in shell history and the process list (§3.5).

```bash
mediagen init                              # interactive setup
echo "$KEY" | mediagen config set gemini --stdin   # for scripts
mediagen doctor                            # what is configured, and does it work
mediagen config list                       # every value, and which layer it came from
```

## Deviations from the specification

**§4.1, the zero-argument MCP server, is not implemented as written.**

The specification says starting the binary with no subcommand must run the MCP
server, "because that is how MCP hosts spawn it". Hosts spawn whatever `args`
their configuration names, so nothing actually requires the zero-argument
form — it is a convention, not a constraint, and honouring it literally means
every script, CI job or agent shell that runs `mediagen` without arguments
gets a process reading JSON-RPC forever that has to be killed. `mediagen mcp`
is the explicit command, and bare `mediagen` prints help.

**§5, prompt enhancement, is deliberately not implemented.**

The specification has the tool expand a short prompt into a fuller one with a
separate model call. This build does not: the prompt is sent exactly as
written. The reasoning is that the agent skill (§11) is itself driven by a
language model that can write a strong prompt directly, so a second model call
that rewrites it is redundant, costs latency, and can talk the caller's
intent down. The prompt-writing guidance §5 describes lives in the skill
instead, where it shapes the prompt before it is ever sent.

The cost of this choice is real and worth naming: someone typing
`mediagen image "a cat"` straight into a shell, with no model in the loop, gets
exactly that prompt and a weaker image than §5 would have produced for them.

Tests never read your config file or inherit your API keys; `test/setup.ts`
enforces that and `src/core/__tests__/isolation.test.ts` fails if it stops
working (§12.1).

## Installing

```bash
npm install -g mediagen   # or use npx -y mediagen <command>
mediagen init             # interactive setup
```

`npx -y mediagen <command>` needs no install.

### As an MCP server

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

The key can equally come from the config file written by `mediagen init`, in
which case `env` can be omitted entirely.

### As an agent skill

```bash
npx skills add Cripacx/mediagen --skill mediagen
```

## Releasing

Three channels, in this order — the last two both point at the first, so npm
has to go first.

**1. npm.** `prepublishOnly` runs the full verification, so a broken build
cannot ship.

```bash
npm login
npm publish --access public
```

**2. The MCP registry.** It hosts metadata only, which is why the package must
exist first. Ownership is proved by `mcpName` in `package.json` matching
`name` in `server.json`; a test keeps the two, and the version in three
places, from drifting.

```bash
mcp-publisher login github
mcp-publisher validate
mcp-publisher publish
```

**3. The skill.** Nothing to publish — `npx skills add` reads the GitHub
repository directly, so pushing is the release. The layout it looks for is
`skills/<name>/SKILL.md`.

Bump the version in `package.json` **and** `server.json` together; `npm test`
fails if they disagree.

## Licence

MIT
