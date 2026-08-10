# What you can do with Cupel

Everything below is free and open source. There is no paid tier and nothing is held back.

**✅ works today** (try it on the demo) · **🗓️ planned** ([TASKS.md](../TASKS.md) has the order)

---

## Talk to your agent

| | |
|---|---|
| ✅ | Watch replies stream in word by word — and **stop mid-answer**, keeping whatever was written |
| ✅ | Attach files and images, or **paste a screenshot straight from the clipboard** |
| ✅ | Copy any reply as clean markdown |
| ✅ | Thumb a reply up or down, then **say why** — your note stays under that reply for good |
| ✅ | Choose the model, temperature and system prompt for your session |
| ✅ | **Use your own model key** — it stays in your browser and is never stored or logged on the server |
| ✅ | Find any past conversation by search or recency; rename or delete it |
| ✅ | **Deleting is a tombstone, not a shredder** — the conversation leaves your list and takes no new messages, but its forks keep working and every score and eval case recorded against it still resolves |
| ✅ | Open a long conversation instantly — it loads the latest turns, with **Load earlier turns** for the rest |
| ✅ | See forked conversations nested under the one they came from |
| ✅ | **Send someone a link to one exact turn** — they land on it, signing in first if your instance requires it |
| ✅ | Chat from your phone in portrait |
| 🗓️ | Share a conversation publicly with a tokenised link — no account needed, with expiry and revocation |

## Improve the agent

| | |
|---|---|
| ✅ | See your agent team as a tree — live version and tools per node; add sub-agents |
| ✅ | **Every instruction save is a new version.** Nothing is ever overwritten |
| ✅ | Diff any two versions, roll back, or download the whole history as JSON or Markdown |
| ✅ | **Test a draft in one click** — it replays your usual conversations against it; repeating a test is two taps |
| ✅ | Replay real conversations — or a single turn — under a different version or model |
| ✅ | **Compare side by side**, cells filling in live as each result lands |
| ✅ | A comparison that lost a cell says so — it reads *failed* until you retry the failures, so a half-filled grid is never mistaken for a finished one |
| ✅ | Big comparisons stay fast — the grid loads a page of rows at a time and refreshes only what actually changed |
| ✅ | Re-fire one turn at several deployments at once; each result becomes a real conversation you can continue |
| ✅ | **Score with an LLM judge and read its reasoning.** Every past score is kept |
| ✅ | Hand-craft expected answers, or import a spreadsheet of them, and score against those |
| ✅ | Collect noteworthy turns into eval sets — freeze them into cases or replay them as regression suites |
| 🗓️ | Choose the context a replay runs under — original, today, or one you specify — and replay recorded tool results so only your change varies |
| 🗓️ | Manage what the app remembers per agent tree — view it, edit it, clear it |

## Understand what happened

| | |
|---|---|
| ✅ | Open any turn's **full trace**: agent → tool → LLM, with time, tokens and cost per step, down to the actual prompts |
| ✅ | Watch every background job's progress; cancel a batch; retry only the failures |
| ✅ | **Trust your comparisons** — every turn records the date, timezone and region it ran under, and replays reuse them |
| ✅ | Inspect every conversation in the system as a super user, filtered by user, tree, date or score |

## Run it your way

| | |
|---|---|
| ✅ | **Runs with no backend at all** — a real bundled backend, seeded with realistic data, so the whole app works before you write any server code |
| ✅ | **One command.** `npm start` boots it and tells you which backend you are on and where your data lives |
| ✅ | **Point it at your own backend by editing one file.** Turn the bundled one off and your backend holds all persistence — Cupel stores nothing server-side |
| ✅ | Check your backend before you try: `cupel-ready` reports every missing endpoint and mismatched shape — **grouped into families**, so "implement chat first, evaluations later" is a plan you can measure |
| ✅ | A backend can say what it implements: its health check reports the contract version and which families it serves, so nothing has to guess |
| ✅ | **Every error is traceable.** Anything that goes wrong carries a reference id you can quote in a bug report, and the same id is on the response header for your logs — an id your own gateway sent is kept, not replaced |
| ✅ | An error that rejects something you typed **names the field**, so the app can point at it instead of showing you a sentence |
| ✅ | **Generate your config from your own OpenAPI file** — base URL, route prefix and auth scheme detected for you |
| ✅ | Switch between mock, local, staging and prod live from Settings, with health checks |
| ✅ | **Turn login on or off with one environment variable** — real tokens and a login screen, or straight in as a dev user. Same UI either way |
| ✅ | Control who can view, tune or evaluate each agent tree; disable a tree so new work stops but history stays readable |
| ✅ | Fill the app with realistic activity for a demo, on demand |
| ✅ | Send a client a token-gated demo URL |
| ✅ | **Put your own name on it** — `npm run init` asks for your product name and backend and writes the config in place, keeping your comments, extra targets and compare presets |
| 🗓️ | **Switch between agent trees in the UI** (today the active tree comes from config) |
| 🗓️ | Keep a hosted instance's data across restarts — the code is written, it needs an object-storage bucket |
| 🗓️ | Work with **any AG-UI agent** through a bridge, so an agent that already speaks that protocol needs no new endpoints for chat |
| 🗓️ | Adopt it with a **half-built backend** — implemented endpoints go to yours, the rest are served by the bundled one |
| 🗓️ | **Drive it from the terminal** — chat, replay, watch evaluations and tasks, `--json` for scripts |
| 🗓️ | **Generate your own project** from this repo, pointed at your backend |
| 🗓️ | Manage agents like code — instruction changes become GitHub pull requests; merging promotes the version live |
| 🗓️ | Deploy to Kubernetes with a test job that blocks a bad release |

## Prove it still works

| | |
|---|---|
| ✅ | A full end-to-end suite walks **13 user journeys in both auth modes** — and asserts each journey really called the documented endpoints, not just that the screen looked right |
| ✅ | **Watch the tests instead of reading them**: `npm run e2e:record` films every journey with an on-screen caption of the step it is performing |

*A film is evidence, not verification — the assertions decide pass or fail, the video shows what happened while they ran.*

---

**Not planned:** a hosted multi-tenant platform. Cupel is a repo you clone, configure in one
file, and run — or, once the CLIs land, generate your own project from.
