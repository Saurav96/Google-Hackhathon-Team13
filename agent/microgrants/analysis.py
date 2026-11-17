"""Judgment tools: splitting the budget, what the money changes, second-order losses and the audits."""

from collections import Counter

from . import data
from .applicants import APPLICANTS, BUDGET_USD

HUB_ROLE = "Ubiquitous Hub"
FOOD_SERVICE_PREFIX = "722"

# Stated assumptions, not data: yearly closure risk without help, and how much a grant cuts it.
SCENARIOS = {
    "cautious": {"closure_risk_without_grant": 0.20, "risk_cut_by_grant": 0.15},
    "central": {"closure_risk_without_grant": 0.40, "risk_cut_by_grant": 0.30},
    "optimistic": {"closure_risk_without_grant": 0.60, "risk_cut_by_grant": 0.50},
}


def _stranding_share(business: dict) -> float:
    """Assumed share of buyers left without a local source: demand splits equally across peers."""
    return 1 / (1 + business["same_industry_peers"])


def _coverage(picks: list[dict]) -> set[str]:
    covered: set[str] = set()
    for pick in picks:
        covered |= set(data.exposed_set(pick["business_id"]))
    return covered


def _fund_in_order(order: list[dict], budget: int) -> list[dict]:
    picks, left = [], budget
    for applicant in order:
        if applicant["requested_usd"] <= left:
            picks.append(applicant)
            left -= applicant["requested_usd"]
    return picks


def plan_budget(budget_usd: int = 0, include_hubs: bool = False) -> dict:
    """Split the relief budget across the applicant queue so that grants do not pay twice
    to protect the same downstream businesses.

    Each step funds the applicant that adds the most newly protected businesses per dollar,
    after discounting for local substitutes. Ubiquitous Hubs are left out unless asked for.

    Args:
        budget_usd: Budget to allocate. Leave 0 to use the fund's budget.
        include_hubs: Set True to let Ubiquitous Hubs compete, to see how the plan changes.

    Returns:
        The funding plan step by step, how it compares with funding by reach alone or with
        one large grant, and why each unfunded applicant was left out.
    """
    return plan_for(int(budget_usd) if budget_usd and int(budget_usd) > 0 else BUDGET_USD, include_hubs)


def plan_for(budget: int, include_hubs: bool = False) -> dict:
    """The planner for an explicit budget. Zero means zero, unlike the tool's "use the default"."""
    budget = max(0, int(budget))
    directory = data.directory()
    pool, skipped = [], []
    for applicant in APPLICANTS:
        business = directory.get(applicant["business_id"])
        if business is None:
            skipped.append({"name": applicant["name"], "reason": "Not found in the corridor registry."})
            continue
        exposed = set(data.exposed_set(applicant["business_id"]))
        entry = {**applicant, "role": business["network_role"], "exposed": exposed, "business": business}
        if not exposed:
            skipped.append(
                {
                    "name": applicant["name"],
                    "reason": "No cascade in the graph. Needs a human case; the graph cannot argue for it.",
                }
            )
        elif business["network_role"].startswith(HUB_ROLE) and not include_hubs:
            skipped.append(
                {
                    "name": applicant["name"],
                    "reason": (
                        f"Ubiquitous Hub with {len(exposed)} reach. Lone local producer, so the model "
                        "gives it all local demand. Buyers can source outside the corridor."
                    ),
                }
            )
        else:
            pool.append(entry)

    steps, covered, left = [], set(), budget
    while True:
        best, best_value = None, 0.0
        for entry in pool:
            if entry["requested_usd"] > left:
                continue
            new = entry["exposed"] - covered
            value = len(new) * _stranding_share(entry["business"]) / entry["requested_usd"]
            if value > best_value:
                best, best_value = entry, value
        if best is None:
            break
        new = best["exposed"] - covered
        covered |= best["exposed"]
        left -= best["requested_usd"]
        pool.remove(best)
        steps.append(
            {
                "step": len(steps) + 1,
                "name": best["name"],
                "business_id": best["business_id"],
                "grant_usd": best["requested_usd"],
                "network_role": best["role"],
                "cascade_reach": len(best["exposed"]),
                "newly_protected": len(new),
                "already_protected_by_earlier_grants": len(best["exposed"]) - len(new),
                "same_industry_peers": best["business"]["same_industry_peers"],
                "tract_poverty_rate": best["business"]["tract_poverty_rate"],
                "running_total_protected": len(covered),
                "budget_left_usd": left,
            }
        )
    for entry in pool:
        new = len(entry["exposed"] - covered)
        skipped.append(
            {
                "name": entry["name"],
                "reason": (
                    f"Asks ${entry['requested_usd']:,} with ${left:,} left."
                    if entry["requested_usd"] > left
                    else "Adds no new protected businesses."
                )
                + f" Would add {new} newly protected businesses.",
            }
        )

    with_reach = [a for a in APPLICANTS if a["business_id"] in directory]
    by_reach = sorted(
        with_reach, key=lambda a: len(data.exposed_set(a["business_id"])), reverse=True
    )
    naive = _fund_in_order(by_reach, budget)
    biggest = by_reach[:1] if by_reach and by_reach[0]["requested_usd"] <= budget else []
    return {
        "budget_usd": budget,
        "plan": steps,
        "plan_total_usd": budget - left,
        "plan_distinct_businesses_protected": len(covered),
        "budget_left_usd": left,
        "not_funded": skipped,
        "comparison": {
            "this_plan": {"grants": len(steps), "distinct_protected": len(covered)},
            "fund_by_reach_until_money_runs_out": {
                "grants": [a["name"] for a in naive],
                "distinct_protected": len(_coverage(naive)),
                "caveat": "Counts hub reach at face value, which the model inflates.",
            },
            "one_grant_to_the_biggest_cascade": {
                "grants": [a["name"] for a in biggest],
                "distinct_protected": len(_coverage(biggest)),
            },
        },
        "assumptions": [
            "Each applicant gets the amount it asked for or nothing.",
            "A business with N same industry peers strands 1/(1+N) of its buyers; the rest switch locally.",
            "Protected means a business keeps a supplier, not that it is guaranteed to survive.",
            "Requested amounts and the queue are scenario inputs, not registry data.",
        ],
    }


def grant_impact_scenarios(business_id: str, grant_usd: int, compare_to_business_id: str = "") -> dict:
    """Answer "what does this grant actually change?" The data has no revenue, rent or
    distress signal, so this returns explicit scenarios instead of a single invented number.

    Args:
        business_id: The business that would receive the grant.
        grant_usd: Grant amount in dollars.
        compare_to_business_id: Optional runner up, to show what would have to be true for
            the ranking to flip.

    Returns:
        For three stated scenarios, the expected number of downstream businesses shielded
        and the cost per business shielded, plus the condition under which the answer flips.
    """
    business = data.directory().get(business_id)
    if business is None:
        return {"error": f"No business with id {business_id}. Use find_business first."}
    if not grant_usd or int(grant_usd) <= 0:
        return {"error": "grant_usd must be a positive dollar amount."}

    grant = int(grant_usd)
    reach = len(data.exposed_set(business_id))
    stranded = reach * _stranding_share(business)
    scenarios = {}
    for label, s in SCENARIOS.items():
        averted = s["closure_risk_without_grant"] * s["risk_cut_by_grant"]
        shielded = averted * stranded
        scenarios[label] = {
            **s,
            "chance_this_grant_prevents_a_closure": round(averted, 3),
            "expected_businesses_shielded": round(shielded, 2),
            "cost_per_business_shielded_usd": round(grant / shielded) if shielded else None,
        }
    result = {
        "business": business["name"],
        "grant_usd": grant,
        "cascade_reach": reach,
        "buyers_without_local_substitute": round(stranded, 1),
        "scenarios": scenarios,
        "what_is_assumed": (
            "Closure risk and the effect of a grant are assumptions, not data. The registry "
            "has no revenue, rent, arrears or distress signal for any business."
        ),
        "what_would_firm_this_up": [
            "Whether the business is behind on rent, and by how much.",
            "Whether its buyers already source from outside the corridor.",
            "Jobs per business, which no public source publishes for small businesses.",
        ],
    }
    if reach == 0:
        result["note"] = "No cascade, so the graph gives no downstream reason. The case must rest on the business itself."

    other = data.directory().get(compare_to_business_id) if compare_to_business_id else None
    if other is not None:
        other_stranded = len(data.exposed_set(other["business_id"])) * _stranding_share(other)
        other_grant = next(
            (a["requested_usd"] for a in APPLICANTS if a["business_id"] == other["business_id"]), grant
        )
        ours, theirs = stranded / grant, other_stranded / other_grant
        if ours and theirs:
            result["flip_condition"] = (
                f"Per dollar, {business['name']} shields {ours / theirs:.2f} times as many "
                f"businesses as {other['name']}. The ranking flips only if {other['name']} is "
                f"more than {ours / theirs:.2f} times as likely to be saved by its grant."
            )
    return result


def what_if_fails_anyway(funded_business_id: str, failing_business_id: str) -> dict:
    """Second-order check: we fund one business, and another one closes anyway.
    Shows how much of the funded business's protection is lost, and whether the funded
    business itself is hit.

    Args:
        funded_business_id: The business that receives the grant.
        failing_business_id: The business assumed to close regardless.

    Returns:
        The overlap between the two cascades, what stays protected, and whether the
        funded business depends on the failing one.
    """
    directory = data.directory()
    funded, failing = directory.get(funded_business_id), directory.get(failing_business_id)
    if funded is None or failing is None:
        return {"error": "Unknown business_id. Use find_business first."}
    if funded_business_id == failing_business_id:
        return {"error": "Pick two different businesses."}

    protected = data.exposed_set(funded_business_id)
    lost = data.exposed_set(failing_business_id)
    overlap = set(protected) & set(lost)
    funded_is_hit = funded_business_id in lost
    return {
        "funded": funded["name"],
        "fails_anyway": failing["name"],
        "funded_cascade_reach": len(protected),
        "also_exposed_to_the_failure": len(overlap),
        "still_cleanly_protected": len(protected) - len(overlap),
        "examples_hit_from_both_sides": sorted(protected[i]["name"] for i in overlap)[:8],
        "funded_business_depends_on_the_failure": funded_is_hit,
        "funded_dependency_chain": lost[funded_business_id]["chain"] if funded_is_hit else None,
        "failure_is_downstream_of_funded": failing_business_id in protected,
        "reading": (
            f"{len(overlap)} of the {len(protected)} businesses this grant protects also depend on "
            f"{failing['name']}, so the grant only fully protects {len(protected) - len(overlap)}."
            + (
                f" {funded['name']} itself buys through {failing['name']}, so the grant may not hold."
                if funded_is_hit
                else ""
            )
        ),
    }


def screen_corridor(network_role: str = "Target Anchor", only_non_applicants: bool = True, limit: int = 10) -> dict:
    """Find businesses that hold others up but are not in the applicant queue.
    Use this when nobody has applied yet, or to ask who should have applied.

    Args:
        network_role: Role to screen for: "Target Anchor", "Ubiquitous Hub",
            "Small/Peripheral Supplier" or "Leaf Node".
        only_non_applicants: True to leave out businesses already in the queue.
        limit: How many to return.

    Returns:
        Businesses in that role ranked by cascade intensity, with reach, peers and tract need.
    """
    queue = {a["business_id"] for a in APPLICANTS}
    wanted = (network_role or "").strip().lower()
    found = [
        b
        for b in data.directory().values()
        if b["network_role"].lower().startswith(wanted)
        and not (only_non_applicants and b["business_id"] in queue)
    ]
    found.sort(key=lambda b: b["cascade_intensity"], reverse=True)
    roles = Counter(b["network_role"] for b in data.directory().values())
    return {
        "role": network_role,
        "matches_total": len(found),
        "businesses": [
            {
                "business_id": b["business_id"],
                "name": b["name"],
                "address": b["address"],
                "industry_naics4": b["naics4"],
                "direct_buyers": b["direct_buyers"],
                "cascade_reach_2hop": b["total_exposed_2hop"],
                "cascade_intensity": round(b["cascade_intensity"], 4),
                "same_industry_peers": b["same_industry_peers"],
                "tract_poverty_rate": b["tract_poverty_rate"],
                "duplicate_registrations": b["other_registrations"],
            }
            for b in found[: max(1, min(int(limit or 10), 25))]
        ],
        "corridor_roles": dict(roles),
        "note": "Most businesses are Leaf Nodes. They sell to the public, not to each other.",
    }


def equity_audit(business_ids: list[str]) -> dict:
    """Audit a set of proposed grants: did the money go where the need is, or where the
    edge generator happened to have the most data?

    Args:
        business_ids: The businesses that would be funded.

    Returns:
        Industry mix and tract need of the funded set against the corridor, plus the
        structural bias of the supply edge model measured on the whole corridor.
    """
    directory = data.directory()
    funded = [directory[b] for b in dict.fromkeys(business_ids or []) if b in directory]
    if not funded:
        return {"error": "No known business_ids given. Use plan_budget or find_business first."}

    everyone = list(directory.values())
    roots = [b for b in everyone if b["total_exposed_2hop"] > 0]
    base = data.corridor_baseline()

    def food_share(group: list[dict]) -> float:
        return round(sum(b["naics4"].startswith(FOOD_SERVICE_PREFIX) for b in group) / len(group), 3)

    def mean(group: list[dict], key: str) -> float:
        return round(sum(b[key] for b in group) / len(group), 4)

    invisible = Counter(b["naics4"] for b in everyone if b["total_exposed_2hop"] == 0)
    funded_poverty = mean(funded, "tract_poverty_rate")
    return {
        "funded": [
            {
                "name": b["name"],
                "industry_naics4": b["naics4"],
                "census_tract": b["tract_geo_id"],
                "tract_poverty_rate": b["tract_poverty_rate"],
                "tract_no_vehicle_rate": b["tract_no_vehicle_rate"],
            }
            for b in funded
        ],
        "need": {
            "funded_avg_tract_poverty": funded_poverty,
            "corridor_avg_tract_poverty": base["poverty_rate"],
            "funded_avg_no_vehicle": mean(funded, "tract_no_vehicle_rate"),
            "corridor_avg_no_vehicle": base["no_vehicle_rate"],
            "money_went_to_higher_need": funded_poverty > base["poverty_rate"],
        },
        "industry": {
            "funded_industries": dict(Counter(b["naics4"] for b in funded)),
            "food_service_share_of_funded": food_share(funded),
            "food_service_share_of_corridor": food_share(everyone),
        },
        "structural_bias_in_the_model": {
            "food_service_share_of_all_businesses": food_share(everyone),
            "food_service_share_of_businesses_with_a_cascade": food_share(roots),
            "businesses_with_no_cascade": len(everyone) - len(roots),
            "largest_industries_with_no_cascade": dict(invisible.most_common(5)),
            "reading": (
                "Supply edges exist only where federal tables say one local industry buys from "
                "another. Food service gets edges far above its share, and personal or "
                "community services get almost none. A business with no cascade is unseen by "
                "the model, not unimportant to the neighborhood."
            ),
        },
        "excluded_on_purpose": "Race and ethnicity are never model inputs. They belong only in an audit of outcomes.",
    }


def data_health_check() -> dict:
    """Validate the tables behind the graph before trusting a traversal: duplicate edge
    keys (which silently multiply paths), dangling references, and graph depth.
    """
    p, d = data.PROJECT, data.DATASET
    checks = data.rows(
        f"""
        SELECT
          (SELECT COUNT(*) FROM `{p}.{d}.businesses`) AS businesses,
          (SELECT COUNT(*) - COUNT(DISTINCT business_id) FROM `{p}.{d}.businesses`) AS duplicate_business_keys,
          (SELECT COUNT(*) FROM `{p}.{d}.supplies`) AS supply_edges,
          (SELECT COUNT(*) - COUNT(DISTINCT edge_id) FROM `{p}.{d}.supplies`) AS duplicate_supply_keys,
          (SELECT COUNTIF(supplier_id = buyer_id) FROM `{p}.{d}.supplies`) AS supply_self_loops,
          (SELECT COUNT(*) FROM `{p}.{d}.supplies` s
            WHERE s.supplier_id NOT IN (SELECT business_id FROM `{p}.{d}.businesses`)
               OR s.buyer_id NOT IN (SELECT business_id FROM `{p}.{d}.businesses`)) AS dangling_supply_edges,
          (SELECT COUNT(*) FROM `{p}.{d}.draws_footfall_from`) AS footfall_edges,
          (SELECT COUNT(*) - COUNT(DISTINCT edge_id) FROM `{p}.{d}.draws_footfall_from`) AS duplicate_footfall_keys,
          (SELECT COUNT(*) FROM `{p}.{d}.borrowed_from`) AS sba_loans,
          (SELECT COUNTIF(charged_off) FROM `{p}.{d}.borrowed_from`) AS sba_loans_charged_off
        """
    )[0]
    directory = data.directory().values()
    problems = [
        k
        for k in ("duplicate_business_keys", "duplicate_supply_keys", "supply_self_loops",
                  "dangling_supply_edges", "duplicate_footfall_keys")
        if checks[k]
    ]
    return {
        **checks,
        "businesses_with_a_2hop_cascade": sum(1 for b in directory if b["total_exposed_2hop"] > 0),
        "businesses_without_a_census_tract": sum(1 for b in directory if not b["tract_geo_id"]),
        "passed": not problems,
        "problems": problems,
        "why_it_matters": (
            "BigQuery does not check that graph keys are unique. Duplicate keys multiply paths "
            "silently and inflate every cascade."
        ),
        "ground_truth_limit": (
            "With so few matched SBA loans and no charge offs, results cannot be checked "
            "against real local failures."
        ),
    }


def evaluate_selection(business_ids: list[str], budget_usd: int) -> dict:
    """Totals for the grants an officer has actually ticked, in the order given.
    Used by the report and its exports, so they describe the selection on screen.
    """
    directory = data.directory()
    asks = {a["business_id"]: a["requested_usd"] for a in APPLICANTS}
    grants, covered = [], set()
    for business_id in dict.fromkeys(business_ids or []):
        business = directory.get(business_id)
        if business is None or business_id not in asks:
            continue
        exposed = set(data.exposed_set(business_id))
        new = exposed - covered
        covered |= exposed
        grants.append(
            {
                "business_id": business_id,
                "name": business["name"],
                "grant_usd": asks[business_id],
                "network_role": business["network_role"].split(" (")[0],
                "cascade_reach": len(exposed),
                "newly_protected": len(new),
                "same_industry_peers": business["same_industry_peers"],
                "tract_poverty_rate": business["tract_poverty_rate"],
            }
        )
    total = sum(g["grant_usd"] for g in grants)
    budget = max(0, int(budget_usd or 0))
    return {
        "budget_usd": budget,
        "grants": grants,
        "total_usd": total,
        "unallocated_usd": budget - total,
        "over_budget": total > budget,
        "distinct_businesses_in_reach": len(covered),
        "audit": equity_audit([g["business_id"] for g in grants]) if grants else None,
    }
