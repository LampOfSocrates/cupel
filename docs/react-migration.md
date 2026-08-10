# React Migration Instructions (Streamlit/Python → React + FastAPI)

> Drop this file in the repo root (or paste it as CLAUDE.md / system context) before starting any migration work. These rules exist to prevent hallucination and guarantee functional parity.

---

## 1. Ground rules — read before you write

1. **Never answer from memory.** Read the actual file before making any claim about it. If you have not opened a file in this session, you do not know its contents.
2. **Cite evidence for every claim.** Every statement about existing behaviour must include a file path and line numbers (e.g. `app.py:42-58`). If you cannot cite it, say "unverified" instead of guessing.
3. **Check versions first.** Read `requirements.txt` / `pyproject.toml` / `package.json` / lockfiles before suggesting any library API. Only use APIs that exist in the pinned versions.
4. **Don't assume defaults.** Check config files (`.streamlit/config.toml`, `.env`, settings modules) before assuming standard framework behaviour. This repo may override defaults.
5. **Distinguish live code from dead code.** Before migrating anything, verify it is actually imported/called somewhere. Flag suspected dead code instead of silently porting or dropping it.
6. **When unsure, ask or flag — never invent.** If behaviour is ambiguous (e.g. implicit Streamlit rerun semantics), state the ambiguity explicitly and propose options rather than picking one silently.

## 2. Phase 0 — Full inventory (mandatory, before any code)

Produce an `INVENTORY.md` containing, with file:line citations for each item:

- **Pages/routes**: every Streamlit page, its entry file, and navigation between them.
- **Widgets**: every input widget (`st.text_input`, `st.selectbox`, `st.file_uploader`, etc.), its key, default value, and what state it drives.
- **Session state**: every `st.session_state` key — where it is set, read, and mutated. Note initialisation order dependencies.
- **Caching**: every `@st.cache_data` / `@st.cache_resource` usage, its TTL/params, and why it exists.
- **Data sources**: every DB connection, API call, file read, secret, and environment variable.
- **Side effects**: file writes, emails, external API mutations — anything that must not fire twice.
- **Rerun-dependent logic**: any behaviour that relies on Streamlit's top-to-bottom rerun model (this is the #1 source of parity bugs — see §5).
- **Outputs**: every chart, table, download button, and its exact data shape.

Do not write any React or FastAPI code until the inventory is complete and reviewed.

## 3. Phase 1 — Backend extraction rules

- **Do not rewrite Python logic in JavaScript.** Business logic stays in Python; wrap it in FastAPI endpoints.
- One endpoint per user-triggered action; pure display logic moves to the frontend.
- Preserve exact function signatures and return shapes first; refactor only after parity is proven.
- Replace `st.cache_data` with explicit caching (e.g. `functools.lru_cache`, Redis) with the **same key parameters and TTL** — document each mapping.
- Replace `st.session_state` with explicit server-side session or client state — document each key's new home in a mapping table:

  | Streamlit key | New location (server session / React state / URL param) | Set where | Read where |
  |---|---|---|---|

- Define Pydantic models for every request/response. The response shape must match what the Streamlit UI actually consumed, verified against the inventory.

## 4. Phase 2 — Frontend rules

- Rebuild UI against the **inventory**, not against your idea of what the app "probably" does.
- Every widget in the inventory must have a mapped React equivalent, including its default value and validation. Produce a widget mapping table before coding.
- Match Streamlit behaviours users depend on: input debouncing vs on-change firing, disabled states while loading, spinner placement, download buttons producing byte-identical files.
- Use a component library; do not hand-roll form controls.
- File uploads: replicate accepted types, size limits, and multi-file behaviour exactly as configured in the original.

## 5. Known parity traps (check every one)

- **Rerun semantics**: Streamlit reruns the whole script on every interaction. Code that "accidentally works" because of reruns (e.g. recomputation keeping data fresh) will silently go stale in React. For each computed value, decide and document: recompute on which events?
- **Widget keys and state resets**: changing a selectbox may implicitly reset downstream widgets in Streamlit. Reproduce or consciously drop each such dependency — list them.
- **Execution order**: top-to-bottom script order can hide race conditions. FastAPI endpoints run concurrently; add explicit locking/ordering where the inventory shows order dependence.
- **Double-fire side effects**: buttons in Streamlit fire once per rerun; React onClick can fire on re-render mistakes. Guard all side-effecting endpoints with idempotency keys.
- **Caching scope**: `st.cache_data` is global across users by default. If the app relied on that (shared cache) or was bitten by it (data leaking between users), replicate the intended behaviour, not the literal one — and flag it.
- **Timezones and locale**: Streamlit renders server-side; React renders client-side. Dates/numbers may format differently. Pin formatting explicitly.
- **Secrets**: `st.secrets` values must move to backend env vars — never to the React bundle.

## 6. Verification protocol (definition of done)

For each page/feature, before it counts as migrated:

1. **Behaviour spec**: write down expected behaviour from the inventory (inputs → outputs), citing original code lines.
2. **Golden tests**: for every backend endpoint, a test asserting output equality with the original Python function for at least 3 representative inputs (including one edge case from the original code).
3. **Side-by-side check**: run old and new app with the same data; compare outputs (charts' underlying data, table contents, downloaded files — compare data, not pixels).
4. **State walkthrough**: script a multi-step user flow touching every session-state key; verify state matches the mapping table at each step.
5. **Parity report**: list any intentional behaviour changes. Anything not listed must behave identically. "Probably the same" is a failure — verify or flag.

## 7. Prompting contract (how to instruct the model each session)

Start each working session with:

> Read `react-migration.md` and `INVENTORY.md` first. Before answering anything about existing behaviour, open the relevant files and cite file:line. List the files you plan to read before making changes. Do not invent APIs — check lockfile versions. Flag anything ambiguous instead of guessing.

Per-task template:

> Task: migrate [feature] per inventory items [IDs].
> 1) Quote the original code you're migrating.
> 2) Show the mapping (widget/state/cache) entries you're implementing.
> 3) Write the code.
> 4) Write the golden test proving parity.
> Do not touch anything outside this task's files.

## 8. Red flags — stop and re-verify if the model:

- Describes code without quoting it
- Says "typically" or "usually" about *this* repo's behaviour
- Suggests a library method without citing the installed version
- Marks a feature done without a golden test
- Silently "improves" behaviour instead of matching it
