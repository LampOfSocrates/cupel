"""Structural definition for the Financial Advisor tree. Unlike
mock/agents/concierge and mock/agents/ops, this tree's trace is NOT
synthesized — mock/agents/financial_advisor/engine.py runs a real OpenRouter
tool-calling loop against mock/agents/financial_advisor/tools.py, so it is
only ever seeded when a server-side key is available (mock/seed.py,
config.live_env_key) — a tree with nothing to call would have nothing honest
to demonstrate.

ag_advisor carries both tools: only it ever actually runs turns, since this
mock has no cross-agent runtime routing (mock/main.py chat() always resolves
to the conversation's agent_id, which defaults to the tree's root). ag_tax is
still a real node in the tree view, documenting which tool is conceptually
the Tax Advisor sub-agent's.
"""

TREE_ID = "financial_advisor"

TREE = {
    "id": TREE_ID,
    "name": "Financial Advisor",
    "endpoints": [
        ("ep_financial_advisor_prod", "prod", "Production deployment"),
    ],
    "agents": [
        ("ag_advisor", "Financial Advisor", None, ["parse_statement", "lookup_tax_rule"], 1),
        ("ag_tax", "Tax Advisor", "ag_advisor", ["lookup_tax_rule"], 1),
    ],
}

CUSTOM_INSTRUCTIONS = {
    "ag_advisor": (
        "You are the Financial Advisor (v1), a demo ADK-style agent that "
        "actually calls tools rather than guessing.\n\n"
        "Tools:\n"
        "- parse_statement(text): parse pasted bank/brokerage statement lines "
        "into structured rows (date, description, amount, category) plus a "
        "total. Call this whenever the user pastes statement text — never "
        "eyeball the numbers yourself.\n"
        "- lookup_tax_rule(income, filing_status): the Tax Advisor sub-agent's "
        "marginal-bracket lookup. Call this before stating any tax rate or "
        "estimated tax — never state a bracket from memory.\n\n"
        "Answer concisely in markdown. This is illustrative demo data, not "
        "real tax or investment advice."
    ),
    "ag_tax": (
        "You are the Tax Advisor (v1), a sub-agent of the Financial Advisor "
        "specializing in tax questions.\n\n"
        "Tools:\n"
        "- lookup_tax_rule(income, filing_status): look up an approximate US "
        "federal marginal bracket and estimated tax from a small canned "
        "table. Always call it before quoting a rate.\n\n"
        "Illustrative demo data, not real tax advice."
    ),
}
