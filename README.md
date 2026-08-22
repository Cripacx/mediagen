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
npm run verify   # typecheck, lint, cycles, tests
```

Tests never read your config file or inherit your API keys; `test/setup.ts`
enforces that and `src/core/__tests__/isolation.test.ts` fails if it stops
working (§12.1).

## Licence

MIT
