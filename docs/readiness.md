# skein-ready — backend readiness / conformance report

P2-READY (skein-phases.md:74): before pointing Skein at your backend, check
whether it is ready — `skein-ready` compares your backend's OpenAPI document
against Skein's contract (`openapi.yaml`, v0.3.0) and reports every missing
endpoint or mismatched shape.

## Usage

```
npm run ready -- <openapi-url-or-file> [options]   # or: npx skein-ready ...
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

Exit codes: `0` fully conformant for the checked set · `1` gaps found ·
`2` usage/load error.

### First conformance test: the mock

The mock ships its own OpenAPI at `/openapi.json` (skein-phases.md:98) and is
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

### Remapped backends

Backends whose routes are named differently (skein-phases.md:75), e.g.
everything under `/nabu-service`:

```
npm run ready -- https://nabu.example.com/openapi.json --prefix /nabu-service
```

### Gated targets

Transport-level gates (like the demo deployment's shared token,
docs/deployment.md) are outside the contract; pass whatever header the
gate needs — the script does no login flows:

```
npm run ready -- https://skein-demo.onrender.com/openapi.json --header "X-Demo-Token: <token>"
```

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

Deliberately **not** checked: deep JSON-Schema diffing (types, enums, nested
required, formats), error responses, header/cookie params, security
declarations, `x-sse-events` frame schemas, and runtime behaviour — a
conformant report means the shapes line up, not that the semantics do.
A loose target spec passes where a wrong one fails: FastAPI-generated specs
without `response_model` declare empty schemas (and no request body for
raw-`Request` handlers), so for such targets conformance is effectively
path/method/param/status presence. That is exactly the mock's situation and
is acceptable — its behaviour is covered by `npm run test:mock`.
