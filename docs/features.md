# Skein — what you can do

> Half chat app, half agent studio.
>
> ✅ = shipped (live on the demo) · ⏳ = in build (Phase 2) · 🗓️ = planned (Phase 3) · ⭐ = pro tier (Phase 4)

## The chat half — talk to your agentic app

- ✅ Chat with your agent and watch the reply stream in word by word
- ✅ Stop a reply mid-stream and keep what it wrote so far
- ✅ Attach files and images to a message, remove them before sending
- ✅ Thumb up/down any reply — ratings are kept forever, never overwritten
- ✅ Copy any reply as clean markdown
- ✅ Set model, temperature, and system prompt for your chat session
- ✅ Bring your own LLM key (OpenRouter) so replies come from a real model — the key stays in your browser, is never stored or logged server-side
- ✅ Find any past conversation by search or recency; rename or delete it
- ✅ See forked conversations nested under their parent
- ✅ Share a link to a conversation or a single turn — the receiver lands on exactly that turn, or signs in first and still lands there
- ✅ Chat from your phone in portrait (the studio views below are desktop-first by design)

## The studio half — build and trust your agents

- ✅ See your agent team as a tree — every agent, its live version, its tools
- ✅ Add a sub-agent under any node
- ✅ Edit instructions safely — every save is a new version; nothing is ever overwritten
- ✅ Diff any two versions and roll back
- ✅ Download an agent's full version history as JSON or Markdown
- ✅ Test a draft in one click — "Test in Runs" replays your usual conversations against it; repeating a test is two taps
- ✅ Replay stored conversations — or one turn — under a different instruction version or model, and compare side by side as results fill in live
- ✅ Re-fire one turn at several deployments at once, each result becoming a real conversation you can open and continue
- ✅ Score runs with an LLM judge and read its reasoning — every past score kept forever
- ✅ Watch every background job's live progress; cancel batches; retry just the failures
- ✅ Debug any turn — the full agent → tool → LLM flow with time, tokens, and cost per step, down to the actual prompts
- ✅ Trust your comparisons — every turn records its context (date, timezone, region) and replays run under the original context by default
- ✅ Watch the app fill itself with realistic activity for demos
- ⏳ Hand-craft expected answers (or bulk-import a spreadsheet) and have the judge score against them — the eval workbench
- ⏳ Inspect every conversation as a super user; collect noteworthy turns into casebooks that become eval sets or regression suites

## Run it, point it at your stack, ship it

- ✅ Run the whole thing with no backend at all — the bundled demo backend, and a token-gated demo URL you can send a client
- ✅ Start everything with one command — `npm start` boots the UI and the demo backend, and tells you which backend you're on and where your data lives
- ✅ Point Skein at your own backend by editing one file (`agentic.config.ts`) — flip `localMock.enabled` off and your backend holds all persistence
- ✅ Switch between mock / local / staging / prod live from Settings, with health checks
- ✅ Check your backend is ready before you try — `skein-ready` reports every missing endpoint or mismatched shape
- ✅ Generate your config from your own OpenAPI file — `skein-ready --init` detects base URL, route prefix, and auth scheme
- ✅ Turn login on or off with one env var — real JWTs, login screen, 401 handling; the same UI code either way
- ✅ Control who can view, tune, or evaluate each agent tree; disable a tree so new work stops but history stays readable
- ⏳ Keep the hosted demo's data across restarts — SQLite replicated to object storage
- ⏳ Trust every release — the full end-to-end suite walks every journey in both auth modes
- ⏳ Watch the tests instead of reading them — recorded films of each journey, pass/fail
- 🗓️ Choose the context a replay runs under — original / today / custom — and replay recorded tool results so only your change varies
- 🗓️ Tune the demo generator's pace from Settings
- 🗓️ Manage what the app remembers per agent tree — view, edit, clear
- 🗓️ Deploy to Kubernetes with a Helm-gated test job that blocks a bad release

## Pro tier (Phase 4)

- ⭐ Manage agents like code — instruction changes become GitHub PRs; merging promotes the version live
- ⭐ Share a conversation publicly with a tokenised link — no account needed, with expiry and revocation
- ⭐ Reels — a journey runner that turns any conformant app's tests into reviewable films
- ⭐ Adopt Skein with a half-built backend — implemented endpoints go to yours, the rest are served by the bundled mock

---

**Not planned:** a project scaffolder (`create-agentic-app`) and a hosted multi-tenant platform. Skein is a repo you clone, configure in one file, and run.
