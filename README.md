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

Providers targeted for the first release: Google Gemini, OpenAI, Kie AI.

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
mediagen image --help
```

`--json` puts exactly one object on stdout and nothing else; in human mode the
saved path is the last line. Exit codes are `0` success, `2` invalid input,
`3` configuration, `4` generation or I/O failure (§4.2, §4.3).

Credentials are read from `GEMINI_API_KEY` (and the equivalent per provider),
from `.env`, or from the config file — never from a command argument, which
would put them in shell history and the process list (§3.5). The `config` and
`init` commands that write that file are not built yet, so for now use the
environment or `.env`.

Tests never read your config file or inherit your API keys; `test/setup.ts`
enforces that and `src/core/__tests__/isolation.test.ts` fails if it stops
working (§12.1).

## Licence

MIT
