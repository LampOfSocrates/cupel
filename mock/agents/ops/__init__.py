"""Structural definition for the Ops Copilot tree. Same caveat as
mock/agents/concierge — canned demo agent, no tool it names actually runs."""

TREE_ID = "agent2"

TREE = {
    "id": TREE_ID,
    "name": "Ops Copilot",
    "endpoints": [
        ("ep_agent2_prod", "prod", "Production deployment"),
    ],
    "agents": [
        ("ag_ops", "Ops", None, ["run_query"], 2),
        ("ag_deploys", "Deploys", "ag_ops", ["rollout_status"], 1),
    ],
}
