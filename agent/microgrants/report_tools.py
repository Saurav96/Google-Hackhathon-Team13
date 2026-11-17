"""Tools that connect the advisor to the officer's report without letting it change anything."""

from . import analysis, data

SECTION_IDS = ("recommendation", "impact", "alternatives", "scenarios", "neighborhood")
MAX_TEXT = 1200


def propose_report_edit(section_id: str, new_text: str, summary: str) -> dict:
    """Propose new text for one section of the officer's report. The officer reviews a
    before and after view and decides whether to apply it. This never edits the report.

    Args:
        section_id: One of recommendation, impact, alternatives, scenarios, neighborhood.
        new_text: The full replacement text for that section, in plain sentences.
        summary: A short label for the change, for example "Clarify the recommendation".

    Returns:
        The proposal as it will be shown to the officer, or an error to correct.
    """
    if section_id not in SECTION_IDS:
        return {"error": f"Unknown section_id. Use one of: {', '.join(SECTION_IDS)}."}
    text = (new_text or "").strip()
    if not text:
        return {"error": "new_text is empty."}
    if len(text) > MAX_TEXT:
        return {"error": f"Keep section text under {MAX_TEXT} characters. Shorten it and try again."}
    return {"status": "proposed", "section_id": section_id, "new_text": text, "summary": (summary or "").strip()[:80]}


def evaluate_selection(business_ids: list[str], budget_usd: int) -> dict:
    """Total the grants currently selected in the report: amount, money left, distinct
    businesses in modeled reach, and where the money lands.

    Args:
        business_ids: The business_ids selected in the report.
        budget_usd: The report's budget.

    Returns:
        Per grant and overall figures for exactly that selection.
    """
    known = [b for b in (business_ids or []) if b in data.directory()]
    if not known:
        return {"error": "No known business_ids. The report has no grants selected, or use find_business first."}
    result = analysis.evaluate_selection(known, budget_usd)
    result["reading"] = "Reach counts businesses with a modeled link to a selected grant, each once. It is not businesses saved."
    return result
