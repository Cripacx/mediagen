# mediagen

Generate images and video from text prompts across several providers — from a
command line, an MCP server, or an agent skill.

The behaviour this implements is specified in [SPEC.md](SPEC.md). Section
numbers there are stable references; the code cites them.

## Status

Every step of the build order in §13 is implemented, with two deliberate
deviations noted below.

| Area                                      | Spec            |
| ----------------------------------------- | --------------- |
| Domain types, error taxonomy, toolchain   | §2, §6.5, §12.2 |
| Core pipeline and output handling         | §1.2, §8        |
| CLI, output contract and exit codes       | §4.1–4.3        |
| Configuration: `config`, `doctor`, `init` | §3, §4.4–4.6    |
| Providers: Gemini, OpenAI, Kie AI         | §6.1, §6.3–6.5  |
| Model selection and `models`              | §7              |
| Asynchronous providers and shared polling | §6.2            |
| Catalogue generation from vendor docs     | §7.4            |
| MCP server                                | §1.2            |
| AI content marking                        | §9              |
| Agent skill                               | §11             |
| Video                                     | §10             |

| Provider      | Images          | Video | Key verification         |
| ------------- | --------------- | ----- | ------------------------ |
| Google Gemini | yes             | yes   | live probe               |
| OpenAI        | yes             | —     | live probe               |
| Kie AI        | yes, ~30 models | —     | none cheap enough (§4.5) |

No provider has yet been exercised against a live endpoint — see the note at
the end.

## Development

```bash
npm install
npm run verify   # typecheck, lint, format, cycles, tests
```

`npm test` builds first: the output-contract tests run the real `dist/bin.js`,
because an in-process test can pass while the shipped binary writes a stray
line to stdout.

Tests never read your config file or inherit your API keys; `test/setup.ts`
enforces that and `src/core/__tests__/isolation.test.ts` fails if it stops
working (§12.1).

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

Releasing is one manual button: **Actions → Release → Run workflow**, with
`patch`, `minor`, `major`, or an exact version.

It is manual on purpose. npm unpublish is restricted to a short window and the
MCP registry has no delete, so a release is a decision rather than something a
merge does on your behalf. Tick **dry run** first to see what would happen
without publishing anything.

The workflow does all of it in order:

1. `npm run verify` — nothing ships from a tree that does not pass
2. bumps the version in `package.json` and `server.json` together
3. commits, tags `vX.Y.Z`, pushes
4. publishes to npm
5. publishes to the MCP registry
6. creates the GitHub Release with generated notes

npm goes before the registry because the registry stores metadata only: an
entry published first would point at a version nobody can install. The Release
comes last, so it never points at something that does not exist yet.

### The first release

The first one cannot be the button: npm configures trusted publishing on a
package that already exists, so version one has to go out by hand. Everything
after that is one click.

```bash
gh repo create mediagen --public --source=. --push
```

```bash
npm login
```

```bash
npm publish --access public
```

Then on npmjs.com open the package settings, add a **trusted publisher** —
GitHub Actions, repository `Cripacx/mediagen`, workflow `release.yml` — and
from then on the workflow publishes without a token, with provenance attached
automatically.

That leaves the registry entry. Do not install anything for it: run the Release
workflow with **dry run** first to check it, then for real. It publishes to npm
over OIDC and to the registry in the same run.

### Publishing to the registry by hand

Only needed if you want a registry entry without cutting a new version. It is a
Go binary from the registry's releases, not an npm package:

```bash
curl -L https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_windows_amd64.tar.gz -o mcp-publisher.tar.gz
```

```bash
tar -xzf mcp-publisher.tar.gz mcp-publisher.exe
```

```bash
./mcp-publisher.exe login github
```

```bash
./mcp-publisher.exe publish
```

Swap `windows_amd64` for `darwin_arm64` or `linux_amd64` as appropriate.

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

`node scripts/set-version.mjs --check` fails if the three version fields ever
drift apart; `npm test` checks the same thing.

## Not yet verified against a live endpoint

No generation has been run against a real provider — every test covers the
paths around it: configuration, capability validation, polling states, file
handling, marking against real images, and the MCP server over real stdio. The
three `generate()` implementations are written against vendor documentation and
SDK type declarations, and the first real key is what will confirm them.

## Licence

MIT
