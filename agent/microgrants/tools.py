"""Cascade tools: what a closure exposes, what a business needs, and how applicants compare."""

import math
from collections import Counter
from concurrent.futures import ThreadPoolExecutor

from . import data
from .applicants import APPLICANTS, BUDGET_USD

EVIDENCE_NOTE = (
    "Businesses, addresses, census tracts and SBA loans are real records. Supplies links are "
    "modeled: federal BEA industry purchase rates assigned to business pairs within 1,200 "
    "metres. Intensity is the share of a buyer's input budget, not a measured contract."
)


def _queue_ids() -> set[str]:
    return {a["business_id"] for a in APPLICANTS}


def _seed_card(business: dict) -> dict:
    return {
        "business_id": business["business_id"],
        "name": business["name"],
        "address": f'{business["address"]}, San Francisco, CA {business["zip"]}',
        "industry_naics4": business["naics4"],
        "network_role": business["network_role"],
    }


def _replaceability(business: dict) -> dict:
    peers = business["same_industry_peers"]
    return {
        "same_industry_peers_in_corridor": peers,
        "reading": (
            "Only local source of this input in the corridor, so buyers have no local substitute. "
            "They could still buy from outside the corridor, which the data cannot see."
            if peers == 0
            else f"{peers} other local businesses in the same industry could absorb its buyers."
        ),
    }


def find_business(name: str) -> dict:
    """Look up businesses in the corridor by part of their name.

    Args:
        name: Full or partial business name, for example "Sour Flour".

    Returns:
        Matching businesses with business_id, name, address, industry and network role.
    """
    needle = (name or "").strip().lower()
    if not needle:
        return {"matches": [], "count": 0, "note": "Give at least part of a business name."}
    matches = [_seed_card(b) for b in data.directory().values() if needle in b["name"].lower()]
    matches.sort(key=lambda m: m["name"])
    return {"matches": matches[:15], "count": len(matches)}


def get_applicant_queue() -> dict:
    """Return the relief fund budget and the queue of applicants waiting for a decision.

    The queue and requested amounts are a demo scenario chosen by the team, not registry data.
    """
    return {
        "budget_usd": BUDGET_USD,
        "total_requested_usd": sum(a["requested_usd"] for a in APPLICANTS),
        "applicants": APPLICANTS,
        "note": "Scenario input. The city registry has no applicant list or requested amounts.",
    }


def trace_cascade(business_id: str, max_hops: int = 2) -> dict:
    """Trace what is exposed downstream if this business closes, by walking Supplies edges
    in the BigQuery property graph up to max_hops steps.

    Args:
        business_id: The business_id of the business that might close.
        max_hops: How many steps to follow, 1 to 3. Two is the default; three usually
            reaches most of the corridor and stops being informative.

    Returns:
        The seed business, counts of exposed businesses per hop, the strongest chains
        (named, with link intensity), how replaceable the seed is, its neighborhood,
        its loan record, and which exposed businesses are fragile or never applied.
    """
    business = data.directory().get(business_id)
    if business is None:
        return {"error": f"No business with id {business_id}. Use find_business first."}

    hops = data.clamp_hops(max_hops)
    paths = data.walk(business_id, hops, "downstream")
    exposed = sorted(
        data.best_paths(paths).values(), key=lambda e: e["path_strength"], reverse=True
    )
    by_hops = Counter(e["hops"] for e in exposed)
    queue = _queue_ids()
    loans = data.loans()
    directory = data.directory()
    baseline_poverty = data.corridor_baseline()["poverty_rate"]

    return {
        "seed": _seed_card(business),
        "max_hops": hops,
        "exposed_total": len(exposed),
        "exposed_by_hops": {f"{h}_hop": n for h, n in sorted(by_hops.items())},
        "cascade_intensity": round(sum(math.prod(p["intensities"]) for p in paths), 4),
        "strongest_chains": exposed[:12],
        "furthest_chains": [e for e in exposed if e["hops"] > 1][:6],
        "replaceability": _replaceability(business),
        "neighborhood": data.neighborhood(business),
        "exposed_in_higher_need_tracts": sum(
            1 for e in exposed if directory[e["business_id"]]["tract_poverty_rate"] > baseline_poverty
        ),
        "exposed_with_sba_loans": [
            {"name": e["name"], "hops": e["hops"], "loans": loans[e["business_id"]]}
            for e in exposed
            if e["business_id"] in loans
        ],
        "exposed_not_in_applicant_queue": sum(1 for e in exposed if e["business_id"] not in queue),
        "exposed_in_applicant_queue": [e["name"] for e in exposed if e["business_id"] in queue],
        "duplicate_registrations": business["other_registrations"],
        "sba_loans": loans.get(business_id, []),
        "evidence_note": EVIDENCE_NOTE,
    }


def trace_dependencies(business_id: str, max_hops: int = 2) -> dict:
    """Trace what this business needs to survive, by walking Supplies edges backward
    (against the arrow) up to max_hops steps.

    Args:
        business_id: The business_id to inspect.
        max_hops: How many steps upstream to follow, 1 to 3.

    Returns:
        The suppliers it depends on, directly and indirectly, with chain and link intensity.
    """
    business = data.directory().get(business_id)
    if business is None:
        return {"error": f"No business with id {business_id}. Use find_business first."}

    best = data.best_paths(data.walk(business_id, data.clamp_hops(max_hops), "upstream"))
    # Show chains supplier-first so the arrow reads the same way as in trace_cascade.
    upstream = [
        {
            **u,
            "chain": " -> ".join(reversed(u["chain"].split(" -> "))),
            "link_intensities": u["link_intensities"][::-1],
        }
        for u in sorted(best.values(), key=lambda e: e["path_strength"], reverse=True)
    ]
    queue = _queue_ids()
    return {
        "seed": _seed_card(business),
        "upstream_total": len(upstream),
        "direct_suppliers": [u for u in upstream if u["hops"] == 1],
        "indirect_suppliers": [u for u in upstream if u["hops"] > 1][:10],
        "suppliers_in_applicant_queue": [u["name"] for u in upstream if u["business_id"] in queue],
        "note": (
            "No modeled suppliers inside the corridor. It may buy everything from outside."
            if not upstream
            else "If one of these suppliers closes, this business has to find a new source."
        ),
    }


def compare_applicants(business_ids: list[str], max_hops: int = 2) -> dict:
    """Compare several applicants side by side on what each one's closure would expose.

    Args:
        business_ids: The business_ids to compare.
        max_hops: Traversal depth for every applicant, 1 to 3.

    Returns:
        One row per applicant with cascade size, cascade intensity, network role,
        replaceability, neighborhood need and loan record, plus applicants with no cascade.
    """
    business_ids = list(dict.fromkeys(business_ids or []))
    if not business_ids:
        return {"error": "No business_ids given. Use get_applicant_queue or find_business first."}

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(lambda b: trace_cascade(b, max_hops), business_ids))

    requested = {a["business_id"]: a["requested_usd"] for a in APPLICANTS}
    table = []
    for business_id, result in zip(business_ids, results):
        if "error" in result:
            table.append({"business_id": business_id, "error": result["error"]})
            continue
        table.append(
            {
                **result["seed"],
                "requested_usd": requested.get(business_id),
                "exposed_total": result["exposed_total"],
                "exposed_by_hops": result["exposed_by_hops"],
                "cascade_intensity": result["cascade_intensity"],
                "same_industry_peers_in_corridor": result["replaceability"][
                    "same_industry_peers_in_corridor"
                ],
                "tract_poverty_rate": result["neighborhood"]["poverty_rate"],
                "higher_need_than_corridor": result["neighborhood"]["higher_need_than_corridor"],
                "top_chains": [c["chain"] for c in result["strongest_chains"][:3]],
                "duplicate_registrations": result["duplicate_registrations"],
                "sba_loans": result["sba_loans"],
            }
        )
    return {
        "max_hops": data.clamp_hops(max_hops),
        "corridor_poverty_rate": data.corridor_baseline()["poverty_rate"],
        "applicants": table,
        "no_cascade": [r["name"] for r in table if r.get("exposed_total") == 0],
        "how_to_read": (
            "exposed_total counts businesses reached. cascade_intensity sums link intensity "
            "over every 1 hop path plus the product of intensities over every 2 hop path. "
            "network_role: Ubiquitous Hub is over 80 reach, Target Anchor is 10 to 50, "
            "Small/Peripheral Supplier is 1 to 9, Leaf Node is 0. A Ubiquitous Hub is usually a "
            "lone local producer that the model gives all local demand to, so it is a weak "
            "signal. Many peers means buyers can switch locally."
        ),
    }
