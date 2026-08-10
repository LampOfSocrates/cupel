"""Structural definition for the Customer Support tree (Concierge + Refunds +
Shipping). A CANNED demo agent: mock/engine.py's _emit_trace synthesizes its
agent/tool/llm spans and no tool it names actually runs — contrast with
mock/agents/financial_advisor, the one tree whose tools execute for real."""

TREE_ID = "agent1"

TREE = {
    "id": TREE_ID,
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
}
