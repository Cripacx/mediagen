# Contributing

```bash
npm install
npm run verify   # typecheck, lint, format, cycles, tests
```

`npm test` builds first: the output-contract tests run the real `dist/bin.js`,
because an in-process test can pass while the shipped binary writes a stray
line to stdout.

Tests never read your config file or inherit your API keys — `test/setup.ts`
enforces that, and a test fails if that enforcement is ever removed. No test
issues a live, billable request.

## Two invariants

The README has the directory tree. Two things about it are load-bearing:

- **`src/cli/output.ts` is the only module that writes to stdout.** The lint
  config enforces it. That is what makes the output contract a property of one
  file rather than a rule every command has to remember.
- **There are no circular dependencies**, and `npm run cycles` fails if one
  appears. The leaf types in `src/types/` exist to keep it that way.

## Adding a provider

Add one directory under `src/providers/`, and one line in
`src/providers/registry.ts`. Nothing else should need editing — capability
checks, model resolution, output handling and marking are all shared.

A provider directory holds:

- `manifest.ts` — data and validation only. It must not import a vendor SDK, so
  that `doctor` and `config` never pay to load one. Clients are reached through
  lazy factories.
- a client per media kind, imported only by those factories.
- `models.ts` — the catalogue. It is not a gate: an id absent from it is still
  sent to the provider, so a newly released model works before anyone updates
  the list.
- `probe.ts` — the cheapest authenticated request that proves a key works, or
  `probe: null` if the provider offers none.

Take the catalogue from the vendor's own type declarations where they exist,
not from prose documentation. That is how the `512` versus `512px` discrepancy
in Gemini's docs was caught before it rejected a valid request.

## The Kie catalogue

Kie's table is generated from Kie's own documentation:

```bash
npm run sync:kie-models
```

```bash
npm run check:kie-models
```

The check reports drift and runs on a schedule rather than in CI, so no pull
request depends on a third-party site being reachable. If pages cannot be
fetched the run refuses to write rather than producing a table that is short by
a model and looks complete.

## Releasing

**Actions → Release → Run workflow**, with `patch`, `minor`, `major`, or an
exact version. Tick **dry run** first to see what would happen without
publishing anything.

Manual on purpose: npm unpublish is restricted to a short window and the MCP
registry has no delete, so a release is a decision rather than something a merge
makes on your behalf.

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

### By hand

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

## Two departures from the original specification

This was built from a written specification that is no longer in the tree; it
remains in git history at the first commit. Two decisions differ from it
deliberately, and both are easy to mistake for oversights.

**Prompts are sent exactly as written.** The specification had the tool expand
a short prompt with a second model call. That is redundant when an agent is
driving the tool, so the prompt-writing guidance lives in the skill instead.
The cost is real: typing `mediagen image "a cat"` straight into a shell gives
you exactly that prompt and a weaker image.

**`mediagen` with no arguments prints help**, rather than starting the MCP
server; `mediagen mcp` starts it. Hosts spawn whatever their configuration
names, so nothing required the zero-argument form, and taking it literally made
every script and agent shell that ran the bare command hang.
