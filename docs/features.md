# Skein — what you can do

> Half chat app, half agent studio. ✅ = shipped (live on the demo) · ⏳ = Phase 2, in build · ⭐ = pro tier (not in the free build)

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
- ✅ Share a link to a conversation or a single turn — the receiver sees exactly that spot, or logs in first

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
- ✅ Run the whole thing with no backend at all (bundled mock) — and share a working, token-gated demo URL with a client in minutes

## Make it yours, make it production (Phase 2)

- ✅ Point Skein at your own backend by editing one file (`agentic.config.ts`)
- ⏳ Switch between mock / local / staging / prod live from Settings, with health checks
- ⏳ Check your backend is ready before you try — a conformance report of every missing endpoint or mismatched shape
- ⏳ Turn login on or off with one env var — real JWTs, login screen, 401 handling; same app either way
- ⏳ Control who can view, tune, or evaluate each agent tree; disable a whole tree (history stays readable)
- ⏳ Inspect every conversation as a super user; collect noteworthy turns into casebooks that become eval sets or regression suites
- ⏳ Hand-craft expected answers (or bulk-import a spreadsheet) and have the judge score against them
- ⏳ Choose the context replays run under — original / today / custom — and replay recorded tool results so only your change varies
- ⏳ Manage what the app remembers per agent tree — view, edit, clear
- ⏳ Tune the demo generator's pace from Settings
- ⏳ Deploy to Kubernetes with a Playwright suite that gates every release
- ⭐ Manage agents like code — instruction changes become GitHub PRs; merging promotes the version live (pro)
