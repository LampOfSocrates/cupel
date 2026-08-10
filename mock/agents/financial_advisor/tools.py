"""Real, local tool implementations for the Financial Advisor demo tree
(mock/agents/financial_advisor/engine.py). Deterministic, no network calls —
the LLM call is the only network hop; these run entirely in-process so the
demo's tool step is genuine (not canned) without needing a second provider.

Illustrative demo data throughout. Not real financial or tax advice.
"""

import re

# "YYYY-MM-DD  description  amount" (amount optionally $-prefixed / comma-grouped).
_STATEMENT_LINE = re.compile(
    r"^(?P<date>\d{4}-\d{2}-\d{2})\s+(?P<desc>.+?)\s+(?P<amount>-?\$?\d[\d,]*\.\d{2})$"
)

_CATEGORY_KEYWORDS = {
    "groceries": ["grocery", "groceries", "market", "whole foods", "trader joe"],
    "dining": ["restaurant", "cafe", "coffee", "diner"],
    "transport": ["uber", "lyft", "transit", "gas", "fuel"],
    "income": ["payroll", "deposit", "salary"],
    "housing": ["rent", "mortgage"],
    "subscription": ["netflix", "spotify", "subscription"],
}


def _categorize(description: str) -> str:
    d = description.lower()
    for category, keywords in _CATEGORY_KEYWORDS.items():
        if any(k in d for k in keywords):
            return category
    return "other"


def parse_statement(text: str) -> dict:
    """Parse loose 'YYYY-MM-DD  description  amount' lines (also tolerates
    'date,description,amount' CSV) into a structured local table. No LLM
    involved — this is the tool the agent calls, not a summarizer standing
    in for one."""
    rows = []
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line:
            continue
        m = _STATEMENT_LINE.match(line)
        if m:
            date, desc, amount = m["date"], m["desc"].strip(), m["amount"]
        else:
            parts = [p.strip() for p in line.split(",")]
            if len(parts) != 3 or not re.match(r"^\d{4}-\d{2}-\d{2}$", parts[0]):
                continue
            date, desc, amount = parts
        try:
            amt = float(amount.replace("$", "").replace(",", ""))
        except ValueError:
            continue
        rows.append({"date": date, "description": desc, "amount": amt,
                     "category": _categorize(desc)})
    return {"rows": rows, "row_count": len(rows), "total": round(sum(r["amount"] for r in rows), 2)}


# Simplified 2026 US federal brackets — illustrative demo data, NOT tax advice.
TAX_BRACKETS = {
    "single": [
        (0, 11_600, 0.10), (11_600, 47_150, 0.12), (47_150, 100_525, 0.22),
        (100_525, 191_950, 0.24), (191_950, 243_725, 0.32),
        (243_725, 609_350, 0.35), (609_350, None, 0.37),
    ],
    "married_filing_jointly": [
        (0, 23_200, 0.10), (23_200, 94_300, 0.12), (94_300, 201_050, 0.22),
        (201_050, 383_900, 0.24), (383_900, 487_450, 0.32),
        (487_450, 731_200, 0.35), (731_200, None, 0.37),
    ],
}


def lookup_tax_rule(income: float, filing_status: str = "single") -> dict:
    """Marginal-bracket lookup against a small canned table — a genuine (if
    simplified) computation, not an LLM guess."""
    status = filing_status if filing_status in TAX_BRACKETS else "single"
    brackets = TAX_BRACKETS[status]
    income = max(0.0, float(income))
    tax, marginal_rate = 0.0, brackets[0][2]
    for lo, hi, rate in brackets:
        if income <= lo:
            break
        top = income if hi is None else min(income, hi)
        tax += (top - lo) * rate
        marginal_rate = rate
        if hi is None or income < hi:
            break
    return {
        "filing_status": status, "income": income, "marginal_rate": marginal_rate,
        "estimated_tax": round(tax, 2),
        "effective_rate": round(tax / income, 4) if income else 0.0,
    }


TOOL_SPECS = {
    "parse_statement": {
        "type": "function",
        "function": {
            "name": "parse_statement",
            "description": ("Parse a pasted bank/brokerage statement's text into structured "
                            "rows (date, description, amount, category) and a total."),
            "parameters": {
                "type": "object",
                "properties": {
                    "text": {"type": "string", "description": "The raw statement text to parse."},
                },
                "required": ["text"],
            },
        },
    },
    "lookup_tax_rule": {
        "type": "function",
        "function": {
            "name": "lookup_tax_rule",
            "description": ("Look up an approximate US federal marginal tax bracket and "
                            "estimated tax for a given income and filing status."),
            "parameters": {
                "type": "object",
                "properties": {
                    "income": {"type": "number", "description": "Annual taxable income in USD."},
                    "filing_status": {"type": "string",
                                      "enum": ["single", "married_filing_jointly"]},
                },
                "required": ["income"],
            },
        },
    },
}

IMPLEMENTATIONS = {"parse_statement": parse_statement, "lookup_tax_rule": lookup_tax_rule}
