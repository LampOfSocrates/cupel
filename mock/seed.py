"""Structural bootstrap so a fresh server is usable: trees agent1 + agent2
(cupel-phases.md:43), agents with instruction versions, replay endpoints.
Conversations/evaluations/judgments are the generator's job, not the server's.
"""

from .auth import ensure_users
from .db import Db, j
from .util import now_iso

SEED_LABEL = "bootstrap-v1"

TREES = [
    {
        "id": "agent1",
        "name": "Customer Support",
        "endpoints": [
            ("ep_agent1_prod", "prod", "Production deployment"),
            ("ep_agent1_staging", "staging", "Staging deployment"),
        ],
        "agents": [
            ("ag_concierge", "Concierge", None, ["search_kb"], 3),
            ("ag_refunds", "Refunds", "ag_concierge", ["lookup_order", "refund"], 1),
            ("ag_shipping", "Shipping", "ag_concierge", ["track_parcel"], 1),
        ],
    },
    {
        "id": "agent2",
        "name": "Ops Copilot",
        "endpoints": [
            ("ep_agent2_prod", "prod", "Production deployment"),
        ],
        "agents": [
            ("ag_ops", "Ops", None, ["run_query"], 2),
            ("ag_deploys", "Deploys", "ag_ops", ["rollout_status"], 1),
        ],
    },
]


def instruction_text(agent_name: str, version: int) -> str:
    return (
        f"You are {agent_name} (v{version}).\n\n"
        f"- Answer concisely in markdown.\n"
        f"- Use your tools before guessing.\n"
        f"- Escalate to a human when unsure."
        + ("\n- Prefer bullet lists for multi-part answers." if version > 1 else "")
        + ("\n- Always confirm resolution before closing." if version > 2 else "")
    )


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
    for tree in TREES:
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
                db.run(
                    "INSERT INTO instruction_versions (agent_id, version, content, format, created_at)"
                    " VALUES (?, ?, ?, 'text', ?)",
                    (aid, v, instruction_text(name, v), now),
                )
    db.run("INSERT INTO meta (key, value) VALUES ('seed', ?)", (SEED_LABEL,))
    return SEED_LABEL
