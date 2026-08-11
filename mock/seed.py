"""Structural bootstrap so a fresh server is usable: trees agent1 + agent2,
agents with instruction versions, replay endpoints.
Conversations/evaluations/judgments are the generator's job, not the server's.

Each tree's structural definition lives under mock/agents/<slug>/ — this
module only composes them and writes the rows.
"""

from . import config
from .agents import concierge, ops
from .agents.financial_advisor import tree as financial_advisor
from .auth import ensure_users
from .db import Db, j
from .util import now_iso

SEED_LABEL = "bootstrap-v1"

FINANCIAL_ADVISOR_TREE_ID = financial_advisor.TREE_ID

TREES = [concierge.TREE, ops.TREE]

# Bespoke instruction text for agents whose tools actually run for real
# (currently just financial_advisor) — everything else falls back to the
# generic instruction_text() template below.
CUSTOM_INSTRUCTIONS = dict(financial_advisor.CUSTOM_INSTRUCTIONS)


def instruction_text(agent_name: str, version: int) -> str:
    return (
        f"You are {agent_name} (v{version}).\n\n"
        f"- Answer concisely in markdown.\n"
        f"- Use your tools before guessing.\n"
        f"- Escalate to a human when unsure."
        + ("\n- Prefer bullet lists for multi-part answers." if version > 1 else "")
        + ("\n- Always confirm resolution before closing." if version > 2 else "")
    )


def seeded_trees() -> list[dict]:
    """The trees a FRESH bootstrap plants.

    One function owns the decision, because it is conditional: the Financial
    Advisor demo joins only when this process holds a provider key
    (config.live_env_key) — it exists to show a genuine multi-step tool-calling
    loop and has nothing honest to demonstrate without one. Restating that
    condition anywhere else makes the restatement environment-dependent, which
    is exactly how two tests came to pass in CI and fail on any machine with
    OPENROUTER_API_KEY set.

    A fresh bootstrap: an already-seeded database keeps whatever it was seeded
    with, so read the trees table rather than this list when the answer must
    describe an existing DB.
    """
    trees = list(TREES)
    if config.live_env_key():
        trees.append(financial_advisor.TREE)
    return trees


def seeded_tree_ids() -> set[str]:
    """Ids of seeded_trees() — what /agenttrees answers on a fresh database."""
    return {tree["id"] for tree in seeded_trees()}


def bootstrap(db: Db) -> str:
    # Seeded auth users, on fresh AND pre-existing DBs — ensure_users
    # is INSERT OR IGNORE so it runs before the seed-label short-circuit
    # (a pre-existing DB has the label but not the users). Also called on
    # POST /auth/token as a defensive first-auth-request path (mock/auth.py).
    ensure_users(db)
    row = db.one("SELECT value FROM meta WHERE key = 'seed'")
    if row:
        return row["value"]
    now = now_iso()
    for tree in seeded_trees():
        db.run("INSERT INTO trees (id, name, enabled, created_at) VALUES (?, ?, 1, ?)",
               (tree["id"], tree["name"], now))
        for eid, name, desc in tree["endpoints"]:
            db.run("INSERT INTO endpoints (id, tree_id, name, description) VALUES (?, ?, ?, ?)",
                   (eid, tree["id"], name, desc))
        for aid, name, parent, tools, versions in tree["agents"]:
            db.run(
                "INSERT INTO agents (id, tree_id, name, parent_id, tools, enabled, format)"
                " VALUES (?, ?, ?, ?, ?, 1, 'text')",
                (aid, tree["id"], name, parent, j(tools)),
            )
            for v in range(1, versions + 1):
                content = CUSTOM_INSTRUCTIONS.get(aid) if v == 1 else None
                db.run(
                    "INSERT INTO instruction_versions (agent_id, version, content, format, created_at)"
                    " VALUES (?, ?, ?, 'text', ?)",
                    (aid, v, content or instruction_text(name, v), now),
                )
    db.run("INSERT INTO meta (key, value) VALUES ('seed', ?)", (SEED_LABEL,))
    return SEED_LABEL
