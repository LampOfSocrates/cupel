"""Cupel data generator: deterministic seed + basic drip.

Invariant (cupel-phases.md:160, feature-spec.md:181): the generator "writes
through the public API (POST …/chat, /replay, /eval/judge etc.), never
directly to the DB" — this module imports httpx and nothing from the mock
package; every write is an HTTP call against a RUNNING server.

Modes (feature-spec.md:183-184):
  seed     one-shot baseline: ~20 machine-origin conversations across both
           trees, forks via POST /replay/turn, replay evaluations, judgments across
           the 2 rubrics, a few thumbs. "Deterministic from --seed N".
  drip     continuous loop: "every N seconds starts a new conversation, adds
           turns to open ones, occasionally forks, queues a replay, judges a
           finished evaluation". Phase 1 exposes only --interval (rate sliders and
           the /admin/generator control API are Phase 2, cupel-phases.md:98).
  simulate seed then drip — what `npm run simulate` runs (cupel-phases.md:43).

Start the server first: npm run mock (http://localhost:4010). The generator
never opens the SQLite file.

Idempotency of re-running seed with the same --seed:
  - chats dedupe server-side via deterministic client_message_id
    (openapi.yaml:1400-1407);
  - forks are skipped when the source conversation already has forks
    (GET …/conversations?forks_of=);
  - replay evaluations are skipped when the tree already has that many "Replay ·"
    (evaluations are listable but carry no idempotency key — count-based skip);
  - judging/thumbs check GET /eval/judgments first and skip when present.
    Judgments are append-only BY DESIGN (cupel-phases.md:160), so if a judge
    call did repeat it would append a new score, never overwrite — acceptable.
All random draws happen in plan_seed() before any HTTP, so the dataset is a
pure function of --seed even when the skip checks fire.
"""

import argparse
import asyncio
import random
import signal
import time

import httpx

PERSONAS = [f"gen-persona-{i}" for i in range(1, 7)]
MODEL_POOL = [None, "claude-sonnet-5", "claude-haiku-4-5", "deepseek-v3"]
CHANNEL = "generator"

SEED_CONVERSATIONS = {"agent1": 14, "agent2": 6}
FORKS, REPLAYS, THUMBS = 4, 3, 3

# feature-spec.md:164 "judgments across 2 rubrics" — bootstrap seeds none.
RUBRICS = [
    ("Helpfulness",
     "Score 0-1: does the reply move the user measurably toward their goal, "
     "with concrete next steps rather than generic advice?"),
    ("Groundedness",
     "Score 0-1: is every claim supported by the conversation or the agent's "
     "tools, with no invented order numbers, dates, or policies?"),
]

# (opener, [follow-ups]) — support-y for agent1 (Customer Support),
# ops-y for agent2 (Ops Copilot). Markdown-ish, multi-turn.
TOPICS = {
    "agent1": [
        ("My order **#4821** never arrived — tracking has said *in transit* for 9 days now.",
         ["The carrier page now shows `exception: address unreadable`. What happens next?",
          "Can you reship to my **work address** instead? I'll be there all week.",
          "If reshipping adds another week I'd honestly rather take the refund."]),
        ("I was charged **twice** for the same subscription renewal this month.",
         ["Here are both charge ids: `ch_9f2a` and `ch_9f2b`, minutes apart on the 3rd.",
          "How long until the reversal shows on my statement?",
          "Please check last month too — I suspect the same double charge."]),
        ("How do I return a gift without the original receipt?",
         ["It was bought in-store; all I have is the barcode on the gift box.",
          "Store credit is fine if a card refund isn't possible.",
          "Great — which locations near *Guildford* accept returns?"]),
        ("The blender I bought sparks when I switch it to high speed. Safety issue?",
         ["Model is `BX-500`, purchased 3 weeks ago, order **#5102**.",
          "Yes, please recall-flag it — do I get a replacement or refund first?",
          "Do you cover the courier pickup for the faulty unit?"]),
        ("Can I change the delivery date on order **#6339**? I'm away Thursday.",
         ["Friday works. Does the driver need a door code?",
          "Will I still get the SMS tracking link on the new date?"]),
        ("Your app logged me out and my saved basket of 14 items is gone.",
         ["Account email is the one on this ticket — can you restore the basket?",
          "Two of those items were on a *flash sale*. Will the prices be honoured?"]),
        ("What's your price-match policy? A competitor lists the same TV for £120 less.",
         ["Here's the link and a screenshot — same model number `QN55Q80`.",
          "If you can't match it, can you at least waive delivery?"]),
        ("I need an invoice with my company's VAT number for order **#7290**.",
         ["VAT ID is `GB123456789`, company name *Surrey Labs Ltd*.",
          "Can you re-issue the previous three orders the same way?"]),
        ("The discount code `WELCOME15` says *expired* but I signed up yesterday.",
         ["Tried incognito and a different card — same error at checkout.",
          "Applied, thanks — will it stack with student discount?"]),
        ("Half my order arrived: the box lists 6 items but contained 4.",
         ["Missing are the `USB-C hub` and one of the two cables.",
          "Photos of the packing slip and box are attached to the ticket."]),
        ("Do you ship to the Channel Islands, and what are the customs charges?",
         ["Jersey, JE2 postcode. The checkout only offers mainland options.",
          "Understood — can you split the order so the in-stock part ships now?"]),
        ("I want to cancel my subscription before Friday's renewal.",
         ["It's the *annual* plan — do I get a pro-rated refund?",
          "Done. Can you confirm no further charges by email?"]),
    ],
    "agent2": [
        ("Deploy `api-gateway v2.14` is stuck at 60% rollout — roll back or push through?",
         ["Error-budget burn is **3x normal** since the canary started.",
          "Rolled back. Can you confirm the whole fleet is on `v2.13` again?",
          "What guardrail would have caught this before 60%?"]),
        ("p95 latency on `/checkout` jumped from 180ms to 900ms at 14:05 UTC.",
         ["The jump lines up with the `redis-cache` failover. Coincidence?",
          "Which dashboard shows per-shard cache hit rate?"]),
        ("Why did the nightly `db-backup` job fail twice this week?",
         ["Both failures show `disk quota exceeded` on the staging volume.",
          "Raise the quota or rotate old snapshots — which is cheaper?"]),
        ("List every service still pinned to the deprecated `node16` base image.",
         ["Which of those have an owner tag? I'll file migration tickets.",
          "Draft the ticket template with the EOL date in bold, please."]),
        ("The on-call pager fired 41 times last night, all from `disk-pressure` warnings.",
         ["Most are the same node pool. Can we tune the threshold to 85%?",
          "Also route *warning*-level alerts to Slack instead of the pager."]),
        ("Cost report: our staging environment spend doubled month-over-month. Why?",
         ["Break it down by namespace — I suspect the load-test cluster.",
          "Schedule the load-test nodes to scale to zero outside 09:00-18:00."]),
        ("Is the `payments` service ready for the Black Friday traffic estimate?",
         ["Estimate is 12x normal peak. Current HPA max is 40 pods.",
          "Run the soak test tonight and send me the saturation report."]),
        ("Rotate the TLS certs on the internal registry before they expire Sunday.",
         ["Use the new wildcard cert from the vault path `secret/infra/tls`.",
          "Confirm the kubelet trust bundle picked up the change."]),
    ],
}

DRIP_ACTIONS = (("new", 3), ("continue", 3), ("fork", 1), ("replay", 1), ("judge", 1))


class Generator:
    def __init__(self, client: httpx.AsyncClient, seed: int = 42, log=print):
        self.c = client
        self.seed_n = seed  # not `self.seed`: that name is the seed() method
        self.rng = random.Random(seed)
        self.log = log
        self._drip_n = 0

    # ------------------------------------------------------------- helpers
    async def _get(self, path: str, **params):
        r = await self.c.get(path, params=params or None)
        r.raise_for_status()
        return r.json()

    async def _post(self, path: str, payload: dict):
        r = await self.c.post(path, json=payload)
        r.raise_for_status()
        return r.json()

    async def wait_task(self, task_id: str, timeout: float = 120.0) -> dict:
        deadline = time.monotonic() + timeout
        task = None
        while time.monotonic() < deadline:
            task = await self._get(f"/tasks/{task_id}")
            if task["status"] in ("done", "failed", "cancelled"):
                return task
            await asyncio.sleep(0.05)
        raise TimeoutError(f"task {task_id} still {task and task['status']} after {timeout}s")

    async def chat(self, tree: str, message: str, *, author: str, cmid: str,
                   conversation_id: str | None = None, model: str | None = None) -> dict:
        body = await self._post(f"/agenttrees/{tree}/chat", {
            "conversation_id": conversation_id, "message": message,
            "stream": False, "origin": "machine", "channel": CHANNEL,
            "author": author, "client_message_id": cmid, "model": model,
        })
        await self.wait_task(body["task_id"])
        return body

    async def ensure_rubrics(self):
        existing = {r["name"] for r in await self._get("/eval/rubrics")}
        for name, prompt in RUBRICS:
            if name not in existing:
                await self._post("/eval/rubrics", {"name": name, "prompt": prompt})

    # ---------------------------------------------------------------- seed
    def plan_seed(self) -> dict:
        """Every random draw for seed mode, before any HTTP — determinism must
        not depend on server state or on which idempotency skips fire."""
        rng = self.rng
        convs = []
        for tree, count in SEED_CONVERSATIONS.items():
            for ci in range(count):
                opener, follows = TOPICS[tree][rng.randrange(len(TOPICS[tree]))]
                n = min(rng.choice((0, 1, 1, 2, 2, 3)), len(follows))
                picks = sorted(rng.sample(range(len(follows)), n))
                convs.append({
                    "tree": tree, "ci": ci, "author": rng.choice(PERSONAS),
                    "model": rng.choice(MODEL_POOL),
                    "messages": [opener] + [follows[p] for p in picks],
                })
        forks = [{"conv": i, "n_endpoints": rng.choice((1, 2))}
                 for i in rng.sample(range(SEED_CONVERSATIONS["agent1"]), FORKS)]
        replays = [
            {"tree": "agent1", "conv": rng.randrange(SEED_CONVERSATIONS["agent1"]),
             "config": {"model": rng.choice(("deepseek-v3", "gemini-flash"))}},
            {"tree": "agent1", "conv": rng.randrange(SEED_CONVERSATIONS["agent1"]),
             "config": {"instruction_version": rng.choice((1, 2))}},
            {"tree": "agent2", "conv": rng.randrange(SEED_CONVERSATIONS["agent2"]),
             "config": {"model": "claude-haiku-4-5",
                        "instruction_version": rng.choice((1, 2))}},
        ]
        judge_model = rng.choice(("claude-haiku-4-5", "claude-sonnet-5"))
        thumbs = [{"pick": rng.randrange(len(convs)),
                   "rating": rng.choice(("up", "up", "down"))} for _ in range(THUMBS)]
        return {"convs": convs, "forks": forks, "replays": replays,
                "judge_model": judge_model, "thumbs": thumbs}

    async def seed(self):
        plan = self.plan_seed()
        await self.ensure_rubrics()

        ids: dict[tuple, str] = {}
        for spec in plan["convs"]:
            conv_id = None
            for mi, message in enumerate(spec["messages"]):
                cmid = f"gen-s{self.seed_n}-{spec['tree']}-c{spec['ci']:02d}-m{mi}"
                body = await self.chat(spec["tree"], message, author=spec["author"],
                                       cmid=cmid, conversation_id=conv_id,
                                       model=spec["model"])
                conv_id = body["conversation_id"]
            ids[(spec["tree"], spec["ci"])] = conv_id
        self.log(f"[seed] {len(ids)} conversations "
                 f"({', '.join(f'{n} {t}' for t, n in SEED_CONVERSATIONS.items())})")

        endpoints = {t: await self._get(f"/agenttrees/{t}/endpoints")
                     for t in SEED_CONVERSATIONS}
        forked = 0
        for f in plan["forks"]:
            conv_id = ids[("agent1", f["conv"])]
            if (await self._get("/agenttrees/agent1/conversations",
                                forks_of=conv_id))["total"]:
                continue
            conv = await self._get(f"/agenttrees/agent1/conversations/{conv_id}")
            turn = [t for t in conv["turns"] if t["role"] == "assistant"][-1]
            eps = [e["id"] for e in endpoints["agent1"][:f["n_endpoints"]]]
            acc = await self._post("/agenttrees/agent1/replay/turn", {
                "conversation_id": conv_id, "turn_id": turn["id"], "endpoints": eps})
            for res in acc["results"]:
                await self.wait_task(res["task_id"])
            forked += 1
        self.log(f"[seed] {forked} fork(s) created, {FORKS - forked} already present")

        existing = {}
        for tree in SEED_CONVERSATIONS:
            evaluations = await self._get(f"/agenttrees/{tree}/evaluations")
            # Oldest first, so re-runs re-target the same evaluations for judging.
            existing[tree] = [r["id"] for r in reversed(evaluations)
                              if (r.get("label") or "").startswith("Replay")]
        evaluation_ids, seen = [], {t: 0 for t in SEED_CONVERSATIONS}
        for spec in plan["replays"]:
            tree = spec["tree"]
            if seen[tree] < len(existing[tree]):
                evaluation_ids.append(existing[tree][seen[tree]])
                seen[tree] += 1
                continue
            seen[tree] += 1
            acc = await self._post(f"/agenttrees/{tree}/replay", {
                "selection": [{"conversation_id": ids[(tree, spec["conv"])]}],
                "configs": [spec["config"]]})
            await self.wait_task(acc["task_id"])
            evaluation_ids.append(acc["evaluation_id"])
        self.log(f"[seed] {len(evaluation_ids)} replay evaluation(s)")

        rubric_by_name = {r["name"]: r for r in await self._get("/eval/rubrics")}
        judged = 0
        for i, evaluation_id in enumerate(evaluation_ids[:2]):
            prior = await self._get("/eval/judgments", evaluation_id=evaluation_id)
            if any(x["type"] == "llm" for x in prior):
                continue
            rubric = rubric_by_name[RUBRICS[i % len(RUBRICS)][0]]
            acc = await self._post("/eval/judge", {
                "evaluation_id": evaluation_id, "judge_model": plan["judge_model"],
                "rubric_id": rubric["id"]})
            await self.wait_task(acc["task_id"])
            judged += 1
        self.log(f"[seed] {judged} evaluation(s) judged")

        thumbed = 0
        for t in plan["thumbs"]:
            spec = plan["convs"][t["pick"]]
            conv_id = ids[(spec["tree"], spec["ci"])]
            conv = await self._get(f"/agenttrees/{spec['tree']}/conversations/{conv_id}")
            turn = [x for x in conv["turns"] if x["role"] == "assistant"][-1]
            prior = await self._get("/eval/judgments", turn_id=turn["id"])
            if any(x["type"] == "human" for x in prior):
                continue
            await self._post("/feedback", {"message_id": turn["id"], "rating": t["rating"]})
            thumbed += 1
        self.log(f"[seed] {thumbed} thumb(s); done (seed={self.seed_n})")

    # ---------------------------------------------------------------- drip
    async def drip(self, *, interval: float = 8.0, iterations: int | None = None,
                   stop: asyncio.Event | None = None):
        names = [n for n, _ in DRIP_ACTIONS]
        weights = [w for _, w in DRIP_ACTIONS]
        n = 0
        while iterations is None or n < iterations:
            if stop and stop.is_set():
                break
            action = self.rng.choices(names, weights)[0]
            try:
                self.log(f"[drip] {await self._drip_once(action)}")
            except httpx.HTTPError as exc:
                self.log(f"[drip] {action} skipped: {exc}")
            n += 1
            if iterations is not None and n >= iterations:
                break
            if stop:
                try:
                    await asyncio.wait_for(stop.wait(), timeout=interval)
                    break
                except asyncio.TimeoutError:
                    pass
            elif interval:
                await asyncio.sleep(interval)

    async def _drip_once(self, action: str) -> str:
        rng = self.rng
        tree = rng.choice(tuple(SEED_CONVERSATIONS))
        self._drip_n += 1
        # Drip is live activity, not a replayable dataset: cmid must be unique
        # across generator restarts, so it is time-based (seed still drives
        # the choice of action/topic/persona).
        nonce = f"gen-d{time.time_ns():x}-{self._drip_n}"
        recent = None
        if action in ("continue", "fork", "replay"):
            page = await self._get(f"/agenttrees/{tree}/conversations",
                                   origin="machine", page_size=10)
            if page["items"]:
                recent = rng.choice(page["items"])
            else:
                action = "new"

        if action == "new":
            opener, _ = TOPICS[tree][rng.randrange(len(TOPICS[tree]))]
            body = await self.chat(tree, opener, author=rng.choice(PERSONAS),
                                   cmid=f"{nonce}-m0", model=rng.choice(MODEL_POOL))
            return f"new conversation {body['conversation_id']} ({tree})"
        if action == "continue":
            _, follows = TOPICS[tree][rng.randrange(len(TOPICS[tree]))]
            await self.chat(tree, rng.choice(follows), author=rng.choice(PERSONAS),
                            cmid=f"{nonce}-m1", conversation_id=recent["id"])
            return f"turn added to {recent['id']}"
        if action == "fork":
            turns = [t for t in recent["turns"]
                     if t["role"] == "assistant" and t["content"]]
            if not turns:
                return f"fork skipped: {recent['id']} has no finished assistant turn"
            eps = await self._get(f"/agenttrees/{tree}/endpoints")
            acc = await self._post(f"/agenttrees/{tree}/replay/turn", {
                "conversation_id": recent["id"], "turn_id": rng.choice(turns)["id"],
                "endpoints": [rng.choice(eps)["id"]]})
            return f"forked {recent['id']} -> evaluation {acc['evaluation_id']}"
        if action == "replay":
            cfg = {"model": rng.choice(("deepseek-v3", "gemini-flash", "claude-haiku-4-5"))}
            acc = await self._post(f"/agenttrees/{tree}/replay", {
                "selection": [{"conversation_id": recent["id"]}], "configs": [cfg]})
            return f"queued replay {acc['evaluation_id']} on {recent['id']}"
        # judge
        evaluations = [r for r in await self._get(f"/agenttrees/{tree}/evaluations")
                if r["status"] == "done"]
        if not evaluations:
            return f"judge skipped: no finished evaluations in {tree}"
        await self.ensure_rubrics()
        rubrics = await self._get("/eval/rubrics")
        acc = await self._post("/eval/judge", {
            "evaluation_id": rng.choice(evaluations)["id"],
            "judge_model": rng.choice(("claude-haiku-4-5", "claude-sonnet-5")),
            "rubric_id": rng.choice(rubrics)["id"]})
        return f"judging evaluation -> task {acc['task_id']}"


# --------------------------------------------------------------------- CLI
def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        prog="python -m mock.generator",
        description="Fill a RUNNING Cupel mock with realistic data, writing only "
                    "through the public API (never the database).",
        epilog="Start the server first in another terminal: npm run mock "
               "(http://localhost:4010). npm run simulate wraps "
               "'python -m mock.generator simulate'.")
    ap.add_argument("mode", nargs="?", default="simulate",
                    choices=("seed", "drip", "simulate"),
                    help="seed = one-shot deterministic baseline; drip = continuous "
                         "activity until Ctrl+C; simulate = seed then drip (default)")
    ap.add_argument("--base", default="http://localhost:4010",
                    help="mock base URL (default %(default)s)")
    ap.add_argument("--seed", type=int, default=42,
                    help="drives ALL content choices; same seed = same dataset "
                         "(default %(default)s)")
    ap.add_argument("--token", default=None,
                    help="demo token sent as X-Demo-Token on every request — "
                         "required when the server runs with DEMO_TOKEN set "
                         "(P1-TDEPLOY gate; docs/deployment.md:11-12)")
    ap.add_argument("--interval", type=float, default=8.0,
                    help="seconds between drip actions (default %(default)s)")
    ap.add_argument("--iterations", type=int, default=None,
                    help="stop drip after N actions (default: run until Ctrl+C)")
    return ap


def auth_headers(token: str | None) -> dict:
    """Headers for the demo token gate; {} when no token (open server)."""
    return {"X-Demo-Token": token} if token else {}


async def _amain(args) -> None:
    async with httpx.AsyncClient(base_url=args.base, timeout=60.0,
                                 headers=auth_headers(args.token)) as client:
        try:
            (await client.get("/healthz")).raise_for_status()
        except httpx.HTTPError as exc:
            raise SystemExit(
                f"Cannot reach the mock at {args.base} ({exc!r}). "
                "Start it first: npm run mock") from exc
        gen = Generator(client, seed=args.seed)
        if args.mode in ("seed", "simulate"):
            gen.log(f"[generator] seeding {args.base} (seed={args.seed})")
            await gen.seed()
        if args.mode in ("drip", "simulate"):
            stop = asyncio.Event()
            for sig in (signal.SIGINT, signal.SIGTERM):
                try:
                    signal.signal(sig, lambda *_: stop.set())
                except (ValueError, OSError):
                    pass
            gen.log(f"[generator] drip every {args.interval}s — Ctrl+C to stop")
            await gen.drip(interval=args.interval, iterations=args.iterations,
                           stop=stop)
            gen.log("[generator] stopped cleanly")


def main(argv=None) -> None:
    args = build_parser().parse_args(argv)
    try:
        asyncio.run(_amain(args))
    except KeyboardInterrupt:
        print("[generator] stopped")


if __name__ == "__main__":
    main()
