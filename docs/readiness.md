# cupel-ready — backend readiness / conformance report

P2-READY (cupel-phases.md:74): before pointing Cupel at your backend, check
whether it is ready — `cupel-ready` compares your backend's OpenAPI document
against Cupel's contract (`openapi.yaml`, v0.4.0) and reports every missing
endpoint or mismatched shape.

## Usage

```
npm run ready -- <openapi-url-or-file> [options]   # or: npx cupel-ready ...
```

The target may be a URL (`http://localhost:4010/openapi.json`) or a local
file, JSON or YAML.

| Option | Meaning |
|---|---|
| `--contract <path>` | contract to validate against (default `./openapi.yaml`) |
| `--prefix <p>` | remap: prepend `p` to every contract path before lookup |
| `--header k:v` | extra request header when fetching a URL target (repeatable) |
| `--phase1-only` | check only the Phase-1 surface (see below) |
| `--json` | machine-readable report on stdout |
| `--init` | also emit a ready-to-paste `agentic.config.ts` target block (see below) |
| `--id` / `--label` | identity for the `--init` block (default: derived from hostname) |

Exit codes: `0` fully conformant for the checked set · `1` gaps found ·
`2` usage/load error. (`--init` bases the exit code on the with-remap run —
what you'd get after pasting the block.)

### First conformance test: the mock

The mock ships its own OpenAPI at `/openapi.json` (cupel-phases.md:98) and is
the script's first target:

```
npm run mock
npm run ready -- http://localhost:4010/openapi.json --phase1-only
# ... conformance: PASS
```

While the mock is mid-Phase-2, the default (full-contract) run intentionally
FAILs, listing the not-yet-implemented Phase-2 endpoints; `--phase1-only`
restricts the check to the Phase-1 surface (a maintained operation list in
`scripts/conformance.mjs` mirroring `tests/openapi-contract.test.js` — a tag
heuristic was rejected because contract tags group by resource, not phase).

### The report is grouped by family

Alongside the per-operation lines, every run prints a **by family** rollup —
`full` / `partial` / `none` per family, in the contract's declared order:

```
by family:
  ✓ chat             3/3 full
  ~ admin            6/8 partial
  ✗ memory           0/4 none
```

Family is the axis worth acting on: it is one question per line
("your endpoints, the bundled mock, or hide it?"), and it is what the project
scaffolder's `--family <name>=mine|mock|hide` takes. The names are the
contract's own — the top-level `tags` of `openapi.yaml`, where every operation
carries exactly one — so neither this script nor the scaffolder keeps a list
that could drift from the contract. An operation in *your* spec that carries no
tag is reported under `(unclassified)` rather than dropped.

A backend can also **declare** the same thing about itself:
`GET /healthz` may return `contract_version` and a `capabilities` map keyed by
family (`{status, implemented, operations, missing}`). Both are optional and
additive — a family missing from the map is *unknown*, not `none` — so
`cupel-ready` still computes the truth from the two specs; the declaration is
what lets a UI or a generator ask cheaply instead of guessing. The mock
declares its own honestly in `mock/capabilities.py`, and a pytest recomputes it
from the contract so it cannot go stale.

### Every operation declares what it requires of its caller

The same trick, one axis over. Beside its family tag, every operation carries
`x-requires` — `none`, one of the per-tree permissions `view` / `tune` /
`evaluate`, or one of the global roles `admin` / `inspect` — so "may this user
do this?" is answerable from the contract instead of from a backend's source.
The declaration sits on the operation for the same reason the tag does: it
cannot drift from the thing it describes.

Two failures, on purpose. A caller without `view` on a tree gets **404** from
every operation under it, so an unpermitted tree is indistinguishable from an
absent one — which means a `view` operation never answers 403, and
`tests/openapi-contract.test.js` asserts that none declares one. A caller who
lacks `tune`, `evaluate`, `admin` or `inspect` gets **403** naming what is
missing, because inside a tree you can already see there is nothing left to
hide and plenty left to explain.

### Remapped backends

Backends whose routes are named differently (cupel-phases.md:75), e.g.
everything under `/nabu-service`:

```
npm run ready -- https://nabu.example.com/openapi.json --prefix /nabu-service
```

### Gated targets

Transport-level gates (like the demo deployment's shared token,
docs/deployment.md) are outside the contract; pass whatever header the
gate needs — the script does no login flows:

```
npm run ready -- https://cupel-demo.onrender.com/openapi.json --header "X-Demo-Token: <token>"
```

## `--init` — generate an `agentic.config.ts` target block (P2-INIT)

`--init` reads the same backend OpenAPI and, after the conformance report,
prints a ready-to-paste `BackendTarget` block. **Text only**: cupel-ready
never writes `agentic.config.ts` — that file is THE one config artifact
(CLAUDE.md invariant) and stays human-owned; you paste the block into its
`targets` array yourself. The block's header comment restates this.

Derivations:

- **baseUrl** — precedence: (1) the target's `servers[0].url` when it is
  absolute (`http`/`https`); (2) else, when the target was fetched from a
  URL, that URL's origin (the `/openapi.json`-ish path stripped); (3) else
  empty + a `TODO` comment (local file, no absolute server declared).
- **prefix remap** — candidate prefixes are taken from the target's own
  leading path segments (e.g. paths like `/nabu-service/agenttrees/...`
  yield candidate `/nabu-service`); each is scored by re-running the
  comparator's matching with the prefix applied. The single candidate that
  strictly beats the no-prefix run becomes `remap: (p) => "<P>" + p`, with a
  before/after comment. Tied candidates → no remap + a note.
- **auth** — token-ish `securitySchemes` (http bearer, apiKey, oauth2,
  openIdConnect) → `requiresToken: true` with a comment naming the scheme;
  none → the key is omitted.
- **id / label** — `--id` / `--label` flags, else derived from the baseUrl
  hostname; plus a non-prod `banner` suggestion (`banner: false` for prod).

Worked example — a backend whose routes live under `/nabu-service`
(cupel-phases.md:75):

```
npm run ready -- https://nabu.example.com/openapi.json --init --id nabu --label "Nabu"
```

```ts
// Generated by cupel-ready --init from https://nabu.example.com/openapi.json. TEXT ONLY:
// cupel-ready never writes agentic.config.ts -- paste this block into its
// `targets` array yourself (the one config artifact stays human-owned).
{
  id: "nabu",
  label: "Nabu",
  baseUrl: "https://nabu.example.com", // from the fetched URL's origin (spec declares no absolute servers[0].url)
  // conformance without remap 5/66 -> with /nabu-service remap 37/66
  remap: (p) => "/nabu-service" + p,
  requiresToken: true, // securityScheme "bearerAuth" (http bearer)
  banner: { label: "NABU BACKEND" }, // non-prod default; use `banner: false` for prod
},
```

With an explicit `--prefix`, detection is skipped and that prefix is used.
With `--json`, the derivations plus the rendered block land under an `init`
key, and the top-level report is the with-remap run.

## What "conformant" means (and its limits)

For every contract operation (path + method), checked contract → target
(extra target endpoints are ignored):

- **presence** — the path (after `--prefix`) and method exist in the target.
  Path templates match exactly, with a positional fallback so a renamed path
  param (`{tree}` vs `{tree_id}`) reports as a param mismatch, not a missing
  path.
- **parameters** (`in: path|query` only) — each contract param exists in the
  target by name + location; params the contract marks `required` are
  required in the target.
- **request body** — content types overlap *when both sides declare a body*.
- **responses** — the contract's primary success code (lowest 2xx) is
  declared; its content types overlap when both declare content. Error
  responses (4xx/5xx) are not required.
- **schemas (shallow)** — when both sides declare a JSON schema for the
  success response, every `required` key of the contract's object schema
  (or its array items) must appear among the target schema's properties.

Collections fall out of the schema rule rather than needing one of their own:
every contract listing declares a `<Thing>Page` object whose `required` keys
are `items`, `page`, `page_size` and `total`, so a target that still returns a
bare array reports the four as missing. `page`/`page_size` are optional query
params, so a target that ignores them is conformant but will answer its whole
collection to a caller expecting a page.

Response HEADERS are not checked either, which now matters for two things.
`GET …/evaluations/{id}` declares an `ETag` and a `304`, and a target that
omits both is reported conformant — clients degrade cleanly, since no
validator means no `If-None-Match` and the grid simply re-downloads. And every
error response declares `X-Request-Id`, so a target that never emits one still
reports conformant; the client falls back to `Error.request_id` in the body,
which the schema rule does not reach either (error responses are not checked
at all — see below). Both are gaps a reader should know about rather than
discover: correlation ids are a promise this tool cannot verify.

Deliberately **not** checked: deep JSON-Schema diffing (types, enums, nested
required, formats), error responses, header/cookie params, security
declarations, `x-sse-events` frame schemas, and runtime behaviour — a
conformant report means the shapes line up, not that the semantics do.
A loose target spec passes where a wrong one fails: FastAPI-generated specs
without `response_model` declare empty schemas (and no request body for
raw-`Request` handlers), so for such targets conformance is effectively
path/method/param/status presence. That is exactly the mock's situation and
is acceptable — its behaviour is covered by `npm run test:mock`.
