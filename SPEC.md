# mediagen — Implementation Specification

A multi-provider generative media tool: images today, video next, reachable
three ways — a command line, an MCP server, and an agent skill.

This document is written to be implemented from scratch. It describes
**behaviour and interfaces**, not an existing codebase's internals.

---

## 0. How to use this document

Implement against this specification and the providers' own API documentation.
Do not consult any existing implementation while writing code. Where this
document says _research this_, the answer comes from the vendor's published API
reference, not from prior art.

Everything below is a requirement unless marked _optional_ or _later_.

The section numbers are stable references — cite them in commits and reviews
("implements §6.2").

---

## 1. What the tool is

### 1.1 Purpose

One interface for generating media from text prompts across several
commercial providers, so a user or an agent can pick the right model for a
task without learning five different APIs.

### 1.2 The three frontends

| Frontend    | Who uses it            | Contract                                       |
| ----------- | ---------------------- | ---------------------------------------------- |
| CLI         | People, scripts, CI    | Human output by default, `--json` for machines |
| MCP server  | Agent hosts over stdio | Tool schema, structured responses              |
| Agent skill | Coding agents          | Invokes the CLI, reads the JSON contract       |

All three must run the **same pipeline**. The CLI and the MCP server are thin
adapters over one core: they translate input and format output, nothing more.
A behaviour that exists in one and not the other is a defect.

### 1.3 Non-goals

- No image analysis, captioning, or understanding — generation only.
- No hosting, no web UI, no queue service.
- No attempt to maintain an authoritative catalogue of every provider's models
  (see §7.3 for what happens instead).
- No credential storage beyond one local file (§3.4).

---

## 2. Domain model

### 2.1 Media kinds

The tool generates **media items**. Each has a kind: `image` or `video`.
Kind is explicit in the CLI (`mediagen image …`, `mediagen video …`) and a
parameter on the MCP tool.

Design the core so kind is a dimension, not a fork: a provider declares which
kinds it supports, and everything downstream (capability checks, output
handling, marking) branches on data rather than on duplicated code paths.

### 2.2 Generation request

A request carries:

| Field           | Type                              | Meaning                                               |
| --------------- | --------------------------------- | ----------------------------------------------------- |
| `prompt`        | string, required                  | What to generate                                      |
| `kind`          | `image` \| `video`                | Defaults to `image`                                   |
| `provider`      | string                            | Overrides the configured default, per request         |
| `model`         | string                            | Overrides the provider's configured or built-in model |
| `inputMedia`    | path                              | Source for editing or transformation                  |
| `aspectRatio`   | string                            | e.g. `1:1`, `16:9`, `9:16`                            |
| `size`          | string                            | e.g. `1K`, `2K`, `4K`                                 |
| `duration`      | seconds                           | Video only                                            |
| `outputName`    | string                            | Output file name; its extension may select the format |
| `outputDir`     | path                              | Overrides the configured directory                    |
| `quality`       | `fast` \| `balanced` \| `quality` | Speed/cost against fidelity                           |
| `enhancePrompt` | boolean                           | Defaults to on; see §5                                |
| `mark`          | boolean                           | Machine-readable AI marking (§9)                      |
| `visibleLabel`  | boolean                           | Visible AI disclosure (§9)                            |

### 2.3 Generation result

A result carries the saved file path, the provider and model that produced it,
the MIME type, and — where the provider returns one — the revised prompt and a
request identifier. The pipeline returns this structure; each frontend renders
it in its own format.

---

## 3. Configuration

### 3.1 Three layers

Settings resolve from three sources, highest priority first. They exist
because they have three different lifetimes:

1. **Process environment** — per invocation, and what CI sets
2. **`.env` in the working directory** — per project
3. **A per-machine config file** — written by the tool itself

Every lookup must report **which layer answered**. This is not a nicety: users
lose hours to a stale environment variable shadowing the key they just
configured, and the tool should be able to say so.

### 3.2 What resolves

| Setting              | Environment variable  | Notes                            |
| -------------------- | --------------------- | -------------------------------- |
| Default provider     | `MEDIAGEN_PROVIDER`   |                                  |
| API key per provider | `<PROVIDER>_API_KEY`  | Naming is per provider; see §6.1 |
| Model per provider   | `<PROVIDER>_MODEL`    |                                  |
| Output directory     | `MEDIAGEN_OUTPUT_DIR` | Defaults to `./output`           |
| Quality preset       | `MEDIAGEN_QUALITY`    | Defaults to `fast`               |
| Prompt enhancement   | `MEDIAGEN_ENHANCE`    | Defaults to on                   |

### 3.3 Validation timing

Because a request may name any provider, credentials cannot be validated
eagerly against one configured provider. Required behaviour:

- **At startup**, the tool must run if _at least one_ provider is usable.
- **When a provider is actually used**, its credentials are validated, and a
  missing or malformed key fails with an error naming the exact variable and
  the exact command that fixes it.
- When _no_ provider is usable, report the configured default provider's own
  error, not a generic one.

### 3.4 The config file

- One file, owned by the tool. It never writes environment variables or `.env`
  files — those belong to the user and are read only.
- Location: `$XDG_CONFIG_HOME/mediagen/config.json`, falling back to
  `~/.config/mediagen/config.json`, or the roaming profile on Windows.
- Written with owner-only permissions where the platform supports them.
  Document honestly that Windows has no POSIX mode bits and the profile ACL is
  what protects it there.
- A missing or malformed file resolves to empty configuration. A broken file
  must never block a run that has working environment credentials.

### 3.5 Secret handling — non-negotiable

- **API keys are never accepted as command arguments.** They land in shell
  history and the process list.
- Keys are read from a hidden interactive prompt, or from stdin for scripting
  (the `docker login --password-stdin` pattern).
- Any display of a key is masked, showing at most a short head and tail.
- A key is verified with one minimal live request before being stored, so a
  typo surfaces at setup rather than at first use.

---

## 4. Command line

### 4.1 Commands

```
mediagen image <prompt> [options]     Generate an image
mediagen video <prompt> [options]     Generate a video
mediagen mark <file...> [options]     Mark existing media as AI-generated
mediagen models [options]             Show each provider's models
mediagen init                         Guided setup
mediagen doctor [options]             Check keys and reachability
mediagen config <action>              Manage the config file
mediagen                              Start the MCP server on stdio
```

Starting the binary with no subcommand must run the MCP server — that is how
MCP hosts spawn it.

### 4.2 Output contract

This is the interface the skill and every script depend on. Get it exactly
right.

**Human mode (default):** a short summary on stdout, the saved path as the
**last line**. Diagnostics and logs go to stderr.

**`--json`:** stdout carries **exactly one JSON object and nothing else**.
Every log, warning and progress message goes to stderr.

Success:

```json
{
  "success": true,
  "filePath": "./output/image.png",
  "kind": "image",
  "provider": "…",
  "model": "…",
  "mimeType": "image/png"
}
```

Failure:

```json
{
  "success": false,
  "errorCode": "CONFIG_ERROR",
  "error": "…",
  "hint": "Run: mediagen config set …"
}
```

`hint` must name a concrete next action wherever one exists. An error that
says only what went wrong is half an error.

### 4.3 Exit codes

| Code | Meaning                                  |
| ---- | ---------------------------------------- |
| `0`  | Success                                  |
| `2`  | Invalid input or usage                   |
| `3`  | Configuration or credentials             |
| `4`  | Generation, network, or file I/O failure |

Callers branch on these without parsing text. Keep the mapping stable.

### 4.4 `config`

```
mediagen config set <provider>              Store an API key (hidden prompt)
mediagen config set <provider> --stdin      Read the key from stdin
mediagen config set default-provider <p>
mediagen config set <provider>-model <id>
mediagen config set output-dir <dir>
mediagen config set quality <preset>
mediagen config get <key>
mediagen config list
mediagen config unset <key>
mediagen config path
```

`list` and `get` show every value with its resolving layer, mask secrets, and
warn when a lower layer is being shadowed.

### 4.5 `doctor`

Per provider: whether a key is configured, which layer it came from, whether a
live request succeeds, and the command that fixes what is broken. `--offline`
skips the live requests.

Distinguish these outcomes: _not configured_, _key rejected_, _unreachable_,
_configured but not cheaply verifiable_ (a provider with no inexpensive probe
endpoint).

### 4.6 `init`

An interactive wizard: choose providers, enter each key hidden, verify each
with a live request, choose the default provider, write the file. Refuse to
run without a TTY and point at the `--stdin` path instead.

---

## 5. Prompt enhancement

Short prompts produce weak images. Before generation, the tool expands a
prompt into a fuller description, unless disabled.

**Requirements:**

- Enhancement is a **separate model call**, and it must degrade gracefully:
  if it fails, generate with the original prompt and log a warning. Never fail
  a generation because enhancement failed.
- A provider that exposes no text model skips enhancement rather than
  requiring credentials for a second provider.
- The user's own words survive. Enhancement fills in what was left
  unspecified — lighting, composition, camera, materials, atmosphere — and
  must not contradict or drop anything the user stated.
- Feature hints from the request (character consistency, multi-element
  composition, real-world accuracy, intended purpose) steer the expansion.

**Write your own guidance.** The taxonomy for _what makes a good image prompt_
is yours to author; do not lift prose from any existing tool.

---

## 6. Provider integration

### 6.1 What a provider must supply

Each provider is a self-contained unit declaring:

- **Credential metadata**: the environment variable, a human description, and
  any cheap format check. Keep this free of vendor SDK imports so credential
  validation, `doctor` and `config` can run without loading five SDKs.
- **Supported media kinds**.
- **A generation client** per supported kind.
- **A text client for enhancement**, or an explicit absence.
- **Capability rules** (§6.3).
- **A model catalogue** (§7).

Adding a provider must mean adding one directory, not editing a switch
statement in six places. Treat that as an acceptance criterion.

### 6.2 Synchronous and asynchronous providers

Some providers return the media in the response. Others accept a job, return
an identifier, and require polling. Both must be supported, and the polling
loop must be **shared infrastructure**, not rewritten per provider:

- Exponential backoff between checks, with a ceiling
- An overall timeout that produces a clear error, not a hang
- Terminal states distinguished: success, provider-side failure, content
  block, cancellation — a content block must not read as a network error
- Finished-and-failed is still finished; do not keep polling a failed job

Video will make this the common case rather than the exception (§10).

### 6.3 Capability validation

Providers differ in what shapes they accept. Validate **before** sending the
request and fail with a named reason and the supported values:

> `The model "x" does not support the aspect ratio 8:1. Use one of: 1:1, 3:2, …`

Never silently substitute a different shape. A user who asked for 21:9 and
received 1:1 without being told has been lied to by the tool.

### 6.4 Input media

Providers accept source media differently — inline base64, a URL, an array of
URLs, a single URL string, under differing field names. Where a provider
requires a URL and the user supplied a local file, upload it to whatever
temporary store the provider offers, then reference it.

**Research per provider.** Do not assume the field name or its shape; both
vary, and sending an array where a string is expected fails as surely as the
wrong name.

### 6.5 Error mapping

Map provider errors onto a small, stable taxonomy — invalid input,
configuration, upstream API failure, network failure, file operation — each
carrying a machine-readable code and an actionable hint. Frontends render this
taxonomy; they must not parse vendor error strings themselves.

Never let a raw upstream message reach the user unredacted: it may echo the
prompt or fragments of a key.

---

## 7. Model selection

### 7.1 One concept for every provider

Model choice is provider-neutral. It resolves in this order:

1. What the request asked for (`--model`)
2. What is configured for that provider (`<PROVIDER>_MODEL`, or the config file)
3. The provider's own default

A provider may derive its default from the quality preset — that is a
provider-internal decision and must not leak into the shared interface.

### 7.2 `mediagen models`

Shows, per provider, the model a request would use right now, **where that
choice came from**, and which models are listed. With more than thirty models
available from a single aggregator, this stops being optional.

### 7.3 Listed models are not a gate

An id outside a provider's listed set is **sent to the provider rather than
rejected**. No project can keep an authoritative catalogue of several vendors'
offerings, and a wrong rejection is worse than no opinion: it is a confident
error the user believes.

The listed ids drive the defaults, the error hints, and `models` output.

### 7.4 Generating a catalogue from vendor documentation

Where a provider publishes a machine-readable API description covering many
models, **derive the catalogue from it rather than maintaining it by hand**.
A hand-written table goes stale in both directions, and the dangerous
direction is upward: when a model gains an aspect ratio, a frozen table starts
rejecting valid requests.

Requirements for such a generator:

- Emits a committed source file, so generating media never depends on the
  network or on a vendor's docs being reachable
- Has a `--check` mode that reports drift and exits non-zero
- Runs on a schedule, **not** in the main CI job — otherwise every pull
  request depends on a third-party site
- Refuses to write an empty catalogue if parsing yields nothing
- Logs what it dropped and why; silent truncation reads as full coverage

Constraints a vendor documents in prose rather than in a schema cannot be
generated. Layer those on by hand, in a separate file, clearly marked.

---

## 8. Output handling

- Resolve and sanitise the output path; refuse traversal outside the intended
  directory.
- Bound how much is read into memory, both for input media and for downloads.
  Enforce the limit **before** decoding, not after.
- Reconcile the requested file extension with the actual media type, correct
  it when they disagree, and log that correction rather than doing it
  silently.
- Follow symlinks safely; refuse anything that is not a regular file.

---

## 9. AI content marking

The EU AI Act splits disclosure into two duties, so implement two independent
switches:

| Switch            | Duty                           | Behaviour                                                                                      |
| ----------------- | ------------------------------ | ---------------------------------------------------------------------------------------------- |
| `--mark`          | Provider: machine-readable     | Write the IPTC/XMP `DigitalSourceType` of `trainedAlgorithmicMedia`, plus the generating model |
| `--visible-label` | Deployer: disclosure to people | Composite a visible label into the media                                                       |

Both default to off.

**Never discard provider metadata.** If the file already declares a digital
source type, leave it alone and report that. If it carries other metadata
without a source type, add to it rather than replacing it.

`mediagen mark <file…>` applies both to media that already exists, in place.

**On C2PA:** a manifest only carries provenance if it is signed, and signing
needs a certificate the user does not have. A test-signed manifest looks like
provenance while carrying none. Support C2PA only for users who bring their
own certificate; the IPTC/XMP marker needs none and is what platforms read.

---

## 10. Video

Video is the second media kind, not a second product. What changes:

- **Everything asynchronous.** Generation takes minutes. §6.2's polling loop
  becomes the normal path, and the CLI needs progress feedback on stderr —
  a percentage or elapsed time, never on stdout.
- **New request dimensions:** duration, frame rate, and for image-to-video a
  source frame. Model these as capability-validated fields (§6.3).
- **Larger outputs.** Revisit every size bound; a video is orders of magnitude
  larger than an image.
- **Marking differs.** XMP in a video container is not the same operation as
  in a still. Research the container formats you will emit before committing
  to a marking approach, and be willing to support marking for a subset of
  formats initially, saying so plainly.
- **Resumability.** A job that outlives the process is worth being able to
  reattach to. Persist the job id and offer a command to collect a finished
  result later. _Optional for the first release, but design the job handling
  so it can be added._

---

## 11. The agent skill

A skill that teaches an agent to use this tool. It must:

- Invoke the **CLI**, not the MCP server, and read the `--json` contract
- Name the MCP tool as the fallback when no shell is available
- Give real guidance on choosing a provider and model for a task
- Recommend marking for photorealistic, published, or professional output
- On `CONFIG_ERROR`, tell the user to run `mediagen init` —
  **never ask a user to paste an API key into a chat**
- Carry the prompt-writing guidance from §5

---

## 12. Quality bar

### 12.1 Tests that must exist

- **Isolation:** the suite must not read the developer's config file or
  inherit their API keys. Without this, tests behave differently per machine
  and can issue live billable requests. Write a test that fails if the
  isolation is removed.
- **Provider client caching:** if clients are cached, prove that alternating
  providers between requests does not reuse the wrong one.
- **Output contract:** `--json` emits exactly one parseable object; stdout
  stays empty on failure in human mode; exit codes map correctly.
- **Capability validation:** an unsupported shape fails before any network
  call is made.
- **Catalogue invariants:** every listed default is itself listed; every
  edit-capable model names its input field.
- **Marking:** metadata is written, provider metadata survives, a second pass
  does not double-mark.

### 12.2 Engineering constraints

- Type-check with strict settings, including exact optional property types.
- No circular dependencies; enforce it in CI.
- Lint and format in CI.
- Ship a `.gitattributes` that pins line endings, so Windows contributors do
  not see the whole tree as modified.
- Every test must pass on Windows, macOS, and Linux. Path assumptions and
  symlink permissions differ; guard platform-specific tests explicitly rather
  than leaving them failing.

---

## 13. Suggested build order

Each step should leave the tool working.

1. Core pipeline for one provider, one media kind, no enhancement — prove
   prompt in, file out.
2. The CLI `image` command with the full output contract and exit codes.
3. Configuration: three layers with provenance, then `config`, `doctor`, `init`.
4. The MCP server as a second adapter over the same core.
5. A second and third provider — this is where §6.1's "one directory" claim
   gets tested for real.
6. Model selection and `models`.
7. Asynchronous provider support and the shared polling loop.
8. Catalogue generation from vendor documentation.
9. Content marking.
10. The skill, and publishing.
11. Video as the second media kind.

---

## 14. What this document does not decide

Deliberately left to the implementation: language and runtime, module layout,
error representation (exceptions against result types), dependency injection
style, test framework, and the internal shape of every client. Those are
design decisions, and they belong to whoever writes the code.
