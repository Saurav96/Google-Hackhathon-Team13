"""Custom ADK function tools for the Anchor Closure track.

Every traversal here is a real multi-hop GQL MATCH over the property graph in
agent/sql/create_graph.sql. The signature move of the track is a path that runs FORWARD along
DrawsFootfall (employer -> the businesses its workers spend at) and then BACKWARD along Supplies
(those businesses -> the suppliers that depend on their purchases):

    (e:Employer)-[:DrawsFootfall]->(c:Business)<-[:Supplies]-{1,2}(u:Business)

Tools return plain dicts. Heavy intermediate data is kept in session state (tool_context.state)
so the model does not have to carry it between calls.
"""

from __future__ import annotations

import json
from typing import Any, Optional

from google.adk.tools import ToolContext

from .. import config
from . import exposure as ex
from .bq import run

MAX_HOPS_ALLOWED = 3
MODELED_EVIDENCE = (
    "Businesses, addresses, industries, employer job counts, SBA loans/charge-offs and tract "
    "demographics are real public records. WHICH business supplies which, and WHICH businesses an "
    "employer block's workers spend at, are modeled by us from federal industry averages (BEA "
    "input-output, Census LEHD) plus walking distance - a modeling choice, not a measurement."
)


# --------------------------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------------------------

def _business_attrs(ids: list[str]) -> dict[str, dict[str, Any]]:
    if not ids:
        return {}
    rows = run(
        f"""SELECT business_id, name, address, naics4, zip, latitude, longitude
            FROM {config.table('businesses')} WHERE business_id IN UNNEST(@ids)""",
        {"ids": ids},
    )
    return {r["business_id"]: r for r in rows}


def _loans(ids: list[str]) -> dict[str, dict[str, Any]]:
    if not ids:
        return {}
    try:
        rows = run(
            f"""SELECT business_id, COUNT(*) AS n_loans, LOGICAL_OR(charged_off) AS charged_off,
                       ARRAY_AGG(STRUCT(bank_name, gross_approval, approval_date, loan_status,
                                        charged_off)) AS loans
                FROM {config.table('borrowed_from')}
                WHERE business_id IN UNNEST(@ids) GROUP BY business_id""",
            {"ids": ids},
        )
    except Exception:  # noqa: BLE001 - an empty/missing loan table is a legitimate corridor state
        return {}
    return {r["business_id"]: {"has_loan": True, "charged_off": bool(r["charged_off"]),
                               "n_loans": r["n_loans"], "loans": r["loans"]} for r in rows}


def _hop_pattern(k: int) -> tuple[str, str]:
    """Explicit k-hop backward supply pattern after the footfall hop, and its RETURN columns."""
    parts = ["(e:Employer WHERE e.block_id = @block)-[f:DrawsFootfall]->(b0:Business)"]
    cols = ["b0.business_id AS b0"]
    for i in range(1, k + 1):
        parts.append(f"<-[s{i}:Supplies]-(b{i}:Business)")
        cols += [f"b{i}.business_id AS b{i}", f"s{i}.intensity AS i{i}"]
    return "".join(parts), ", ".join(cols)


def _fetch_trace(block_id: str, max_supply_hops: int) -> dict[str, Any]:
    g = config.graph()
    anchor = run(f"SELECT block_id, tract, jobs FROM {config.table('employer_blocks')} WHERE block_id = @block",
                 {"block": block_id})
    if not anchor:
        return {"error": f"No employer block with block_id {block_id!r}. Use find_anchor_employers first."}

    # Leg 1: forward along DrawsFootfall.
    direct_rows = run(
        f"""GRAPH {g}
            MATCH (e:Employer WHERE e.block_id = @block)-[f:DrawsFootfall]->(c:Business)
            RETURN c.business_id AS business_id, f.worker_share AS anchor_share""",
        {"block": block_id},
    )
    direct_ids = [r["business_id"] for r in direct_rows]
    totals = {}
    if direct_ids:
        totals = {r["business_id"]: r["total_share"] for r in run(
            f"""SELECT business_id, SUM(worker_share) AS total_share
                FROM {config.table('draws_footfall_from')}
                WHERE business_id IN UNNEST(@ids) GROUP BY business_id""",
            {"ids": direct_ids})}

    # Leg 2: forward one hop, then BACKWARD 1..k hops along Supplies. One explicit pattern per
    # depth so every intermediate node and edge weight comes back as a named column.
    paths: list[dict[str, Any]] = []
    for k in range(1, max_supply_hops + 1):
        pattern, cols = _hop_pattern(k)
        for r in run(f"GRAPH {g}\nMATCH {pattern}\nRETURN {cols}", {"block": block_id}):
            chain = [r[f"b{i}"] for i in range(k + 1)]
            if len(set(chain)) < len(chain):  # walk semantics allow cycles; drop them
                continue
            paths.append({"chain": chain, "intensities": [float(r[f"i{i}"] or 0) for i in range(1, k + 1)]})

    edges: dict[str, float] = {}
    for p in paths:
        for i, inten in enumerate(p["intensities"]):
            edges[f"{p['chain'][i + 1]}|{p['chain'][i]}"] = inten  # supplier|buyer
    suppliers = sorted({k.split("|")[0] for k in edges})
    supplier_totals = {}
    if suppliers:
        supplier_totals = {r["supplier_id"]: float(r["total"]) for r in run(
            f"""SELECT supplier_id, SUM(intensity) AS total FROM {config.table('supplies')}
                WHERE supplier_id IN UNNEST(@ids) GROUP BY supplier_id""",
            {"ids": suppliers})}

    all_ids = sorted(set(direct_ids) | {b for p in paths for b in p["chain"]})
    attrs = _business_attrs(all_ids)
    loans = _loans(all_ids)
    return {
        "anchor": anchor[0],
        "max_supply_hops": max_supply_hops,
        "direct": {r["business_id"]: [float(r["anchor_share"] or 0), float(totals.get(r["business_id"]) or 0)]
                   for r in direct_rows},
        "edges": edges,
        "supplier_totals": supplier_totals,
        "paths": paths,
        "businesses": {k: {kk: (float(vv) if isinstance(vv, (int, float)) and kk in ("latitude", "longitude") else vv)
                           for kk, vv in v.items()} for k, v in attrs.items()},
        "loans": {k: {"has_loan": True, "charged_off": v["charged_off"], "n_loans": v["n_loans"]}
                  for k, v in loans.items()},
    }


def _data_from_state(trace: dict[str, Any]) -> ex.TraversalData:
    return ex.TraversalData(
        direct={k: (v[0], v[1]) for k, v in trace["direct"].items()},
        supply_edges={tuple(k.split("|")): v for k, v in trace["edges"].items()},  # type: ignore[misc]
        supplier_total_intensity=trace["supplier_totals"],
        businesses=trace["businesses"],
        loans=trace["loans"],
    )


def _get_trace(tool_context: ToolContext, block_id: str, max_supply_hops: int) -> dict[str, Any]:
    traces = tool_context.state.get("traces", {})
    key = f"{block_id}|{max_supply_hops}"
    if key not in traces:
        traces[key] = _fetch_trace(block_id, max_supply_hops)
        tool_context.state["traces"] = traces
    return traces[key]


def _name(trace: dict[str, Any], b: str) -> str:
    return (trace["businesses"].get(b) or {}).get("name") or b


def _label(trace: dict[str, Any], b: str) -> dict[str, Any]:
    info = trace["businesses"].get(b) or {}
    return {"business_id": b, "name": info.get("name"), "address": info.get("address"),
            "naics4": info.get("naics4")}


def _strongest_path(trace: dict[str, Any], target: str) -> Optional[list[str]]:
    best, best_score = None, -1.0
    for p in trace["paths"]:
        if p["chain"][-1] != target:
            continue
        score = 1.0
        for i, inten in enumerate(p["intensities"]):
            tot = trace["supplier_totals"].get(p["chain"][i + 1]) or 1.0
            score *= inten / tot
        if score > best_score:
            best, best_score = p["chain"], score
    return best


def _clamp_hops(h: int) -> int:
    return max(1, min(MAX_HOPS_ALLOWED, int(h)))


# --------------------------------------------------------------------------------------------
# tools
# --------------------------------------------------------------------------------------------

def find_anchor_employers(top_n: int = 10) -> dict:
    """Lists the employer census blocks whose departure would reach the most businesses.

    Use this when the officer has not named a specific employer block, or to show which anchor
    closures matter most in this corridor. Ranks blocks by how many businesses are reached by the
    two-leg traversal: forward along DrawsFootfall, then backward 1-2 hops along Supplies.

    Args:
        top_n: How many employer blocks to return.

    Returns:
        A dict with a list of employer blocks: block_id, tract, jobs, businesses hit directly
        (footfall) and businesses hit upstream (suppliers that never interact with the employer).
    """
    g = config.graph()
    reach = run(
        f"""GRAPH {g}
            MATCH (e:Employer)-[:DrawsFootfall]->(c:Business)<-[:Supplies]-{{1,2}}(u:Business)
            RETURN e.block_id AS block_id, COUNT(DISTINCT u.business_id) AS upstream_reach""")
    reach_by = {r["block_id"]: r["upstream_reach"] for r in reach}
    blocks = run(
        f"""SELECT e.block_id, e.tract, e.jobs, COUNT(DISTINCT f.business_id) AS direct_hit
            FROM {config.table('employer_blocks')} e
            JOIN {config.table('draws_footfall_from')} f USING (block_id)
            GROUP BY 1, 2, 3""")
    for b in blocks:
        b["upstream_reach"] = int(reach_by.get(b["block_id"], 0))
    blocks.sort(key=lambda b: (b["upstream_reach"], b["jobs"]), reverse=True)
    return {
        "employer_blocks": blocks[: int(top_n)],
        "note": "Employer nodes are census blocks with a real LEHD job count, not named companies. "
                "Ask the officer which block the departing employer sits in, or how many of the "
                "block's jobs are leaving (job_loss_fraction).",
    }


def trace_anchor_closure(block_id: str, tool_context: ToolContext, max_supply_hops: int = 2,
                         job_loss_fraction: float = 1.0) -> dict:
    """Traces who is exposed when an anchor employer in a census block leaves.

    Runs a multi-hop graph traversal: FORWARD along DrawsFootfall to the businesses whose weekday
    trade the employer's workers provide, then BACKWARD along Supplies to the suppliers that lose
    those businesses as buyers. The second group never applied for anything and has no direct
    tie to the employer - finding them is the point of this track.

    Args:
        block_id: The employer census block (block_id) that is losing its anchor.
        max_supply_hops: How far to follow Supplies backward (1-3). Default 2; 3 tends to saturate
            the corridor and stop being informative.
        job_loss_fraction: Share of the block's jobs that leave (1.0 = all of them).

    Returns:
        A dict with the anchor, the directly exposed businesses (footfall), the upstream exposed
        businesses (supply chain) with the path that reaches each, and counts.
    """
    hops = _clamp_hops(max_supply_hops)
    trace = _get_trace(tool_context, block_id, hops)
    if "error" in trace:
        return trace
    a = ex.assumptions_from(job_loss_fraction=job_loss_fraction)
    data = _data_from_state(trace)
    loss, hop_of = ex.revenue_loss(data, a, hops)

    def row(b: str) -> dict[str, Any]:
        r = _label(trace, b)
        r.update({"revenue_loss_pct": round(100 * loss[b], 1),
                  "closure_risk_pct": round(100 * ex.closure_risk(b, loss[b], data, a), 1),
                  "hops_from_anchor": hop_of.get(b),
                  "sba_charge_off_on_record": bool(trace["loans"].get(b, {}).get("charged_off"))})
        if hop_of.get(b, 0) > 0:
            chain = _strongest_path(trace, b)
            if chain:
                r["path"] = " <-supplies- ".join(_name(trace, x) for x in chain)
        return r

    direct = sorted((b for b in loss if hop_of.get(b) == 0), key=lambda b: -loss[b])
    upstream = sorted((b for b in loss if hop_of.get(b, 0) > 0), key=lambda b: -loss[b])
    material = [b for b in loss if loss[b] >= a.materiality]
    tool_context.state["last_block_id"] = block_id
    tool_context.state["last_hops"] = hops
    return {
        "anchor": trace["anchor"],
        "traversal": f"(Employer {block_id})-[:DrawsFootfall]->(Business)<-[:Supplies]-{{1,{hops}}}(Business)",
        "counts": {"hit_directly_by_footfall": len(direct),
                   "hit_upstream_via_supply_chain": len(upstream),
                   "materially_exposed": len(material),
                   "upstream_and_material": len([b for b in upstream if loss[b] >= a.materiality])},
        "directly_exposed": [row(b) for b in direct[:15]],
        "upstream_exposed_never_applied": [row(b) for b in upstream[:15]],
        "evidence_note": MODELED_EVIDENCE,
        "assumptions": a.describe(),
    }


def recommend_grants(budget: float, tool_context: ToolContext, block_id: Optional[str] = None,
                     max_grants: int = 5, min_grant: float = 5000.0, max_grant: float = 15000.0,
                     max_supply_hops: Optional[int] = None,
                     footfall_dependence: Optional[float] = None,
                     corridor_sales_share: Optional[float] = None,
                     grant_effect: Optional[float] = None,
                     job_loss_fraction: Optional[float] = None,
                     assume_closed: Optional[list[str]] = None) -> dict:
    """Turns the anchor-closure cascade into a defended funding recommendation.

    Scores each exposed business by expected closures averted: its own closure risk cut by the
    grant, plus the upstream suppliers whose risk falls because it keeps buying from them. Splits
    the budget, names the runner-up, checks whether the biggest hub was funded and why, and tests
    whether the answer survives different assumptions.

    Args:
        budget: Total dollars available.
        block_id: Employer block; defaults to the last one traced.
        max_grants: Maximum number of grants to split the budget into.
        min_grant: Smallest grant worth making, in dollars.
        max_grant: Largest single grant, in dollars.
        max_supply_hops: Backward supply hops (defaults to the last trace).
        footfall_dependence: Override: share of a shop's revenue from nearby workers (0-1).
        corridor_sales_share: Override: share of a supplier's sales inside the corridor (0-1).
        grant_effect: Override: relative cut in closure risk a grant buys (0-1).
        job_loss_fraction: Override: share of the block's jobs that leave (0-1).
        assume_closed: business_ids assumed to close regardless (second-order scenario). They
            are not funded and their full loss propagates to their suppliers.

    Returns:
        Grants with amounts and what each protects, the runner-up, a hub check, a sensitivity
        table, the assumptions and the evidence note.
    """
    block_id = block_id or tool_context.state.get("last_block_id")
    if not block_id:
        return {"error": "No anchor traced yet. Call trace_anchor_closure first."}
    hops = _clamp_hops(max_supply_hops or tool_context.state.get("last_hops", 2))
    trace = _get_trace(tool_context, block_id, hops)
    if "error" in trace:
        return trace
    a = ex.assumptions_from(footfall_dependence=footfall_dependence,
                            corridor_sales_share=corridor_sales_share,
                            grant_effect=grant_effect, job_loss_fraction=job_loss_fraction)
    closed = tuple(assume_closed or ())
    data = _data_from_state(trace)
    ranked = ex.rank(data, a, hops, closed)
    if not ranked:
        return {"block_id": block_id, "grants": [], "reserve": budget,
                "finding": "No business is materially exposed under these assumptions. Recommend "
                           "holding the fund rather than spending it on an exposure we cannot see.",
                "assumptions": a.describe(), "evidence_note": MODELED_EVIDENCE}

    chosen, reserve = ex.allocate(ranked, float(budget), int(max_grants), float(min_grant), float(max_grant))

    def present(r: dict[str, Any]) -> dict[str, Any]:
        out = _label(trace, r["business_id"])
        out.update({
            "exposure_route": r["exposure_route"],
            "revenue_loss_pct": round(100 * r["revenue_loss"], 1),
            "closure_risk_pct": round(100 * r["closure_risk"], 1),
            "expected_closures_averted": round(r["value"], 3),
            "protects_upstream": [
                {"name": _name(trace, u["business_id"]), "business_id": u["business_id"],
                 "hops_from_funded": u["hops_from_funded"],
                 "revenue_share_kept_pct": round(100 * u["revenue_hit"], 1),
                 "chain": " <-supplies- ".join(_name(trace, x) for x in u["chain"])}
                for u in r["upstream_dependants"][:6]],
            "sba_charge_off_on_record": bool(trace["loans"].get(r["business_id"], {}).get("charged_off")),
        })
        if "amount" in r:
            out["amount"] = r["amount"]
        return out

    funded_ids = [c["business_id"] for c in chosen]
    runner = next((r for r in ranked if r["business_id"] not in funded_ids), None)
    hub = max(ranked, key=lambda r: len(r["upstream_dependants"]))
    hub_check = {
        "most_connected_exposed_business": _name(trace, hub["business_id"]),
        "upstream_dependants": len(hub["upstream_dependants"]),
        "funded": hub["business_id"] in funded_ids,
        "why": ("Funded: its survival protects the most upstream." if hub["business_id"] in funded_ids else
                f"Not funded: its own revenue loss is {100 * hub['revenue_loss']:.1f}% and closure risk "
                f"{100 * hub['closure_risk']:.1f}%, so a grant averts fewer expected closures than the "
                "picks above. Connected is not the same as at risk."),
    }
    result = {
        "block_id": block_id,
        "anchor": trace["anchor"],
        "budget": budget,
        "grants": [present(c) for c in chosen],
        "reserve_unallocated": reserve,
        "runner_up": present(runner) if runner else None,
        "hub_check": hub_check,
        "sensitivity": ex.sensitivity(data, a, hops, closed, max(1, len(chosen))),
        "assumed_closed": [_name(trace, b) for b in closed],
        "assumptions": a.describe() + [
            f"Grant sizes split the budget in proportion to expected closures averted, between "
            f"${min_grant:,.0f} and ${max_grant:,.0f}. That is a policy rule: the data has no revenue figures."],
        "evidence_note": MODELED_EVIDENCE,
    }
    for b in result["sensitivity"]:
        if b["new_top_pick"]:
            b["new_top_pick"] = _name(trace, b["new_top_pick"])
    tool_context.state["last_recommendation"] = {
        "block_id": block_id, "funded": funded_ids,
        "exposed": [r["business_id"] for r in ranked]}
    return result


def show_cascade_path(business_id: str, tool_context: ToolContext, block_id: Optional[str] = None) -> dict:
    """Shows the actual graph path from the anchor employer to one exposed business.

    Use it when the officer asks "why is this business on the list?" Returns the shortest path as
    returned by the graph (TO_JSON, renderable by a front end) and as readable text.

    Args:
        business_id: The exposed business.
        block_id: Employer block; defaults to the last one traced.

    Returns:
        The path as text with each link's weight, and the raw graph JSON.
    """
    block_id = block_id or tool_context.state.get("last_block_id")
    if not block_id:
        return {"error": "No anchor traced yet. Call trace_anchor_closure first."}
    hops = tool_context.state.get("last_hops", 2)
    g = config.graph()
    direct = run(f"""GRAPH {g}
        MATCH p = (e:Employer WHERE e.block_id = @block)-[:DrawsFootfall]->(c:Business WHERE c.business_id = @biz)
        RETURN TO_JSON(p) AS path LIMIT 1""", {"block": block_id, "biz": business_id})
    rows = direct or run(f"""GRAPH {g}
        MATCH p = ANY SHORTEST (e:Employer WHERE e.block_id = @block)-[:DrawsFootfall]->(c:Business)
                  <-[:Supplies]-{{1,{int(hops)}}}(u:Business WHERE u.business_id = @biz)
        RETURN TO_JSON(p) AS path LIMIT 1""", {"block": block_id, "biz": business_id})
    if not rows:
        return {"business_id": business_id, "path": None,
                "finding": f"No path within {hops} supply hops: this business is not exposed to this anchor."}
    raw = rows[0]["path"]
    elements = json.loads(raw) if isinstance(raw, str) else raw
    text = []
    for el in elements or []:
        props = el.get("properties", {}) if isinstance(el, dict) else {}
        labels = el.get("labels", []) if isinstance(el, dict) else []
        if el.get("kind") == "node":
            text.append(props.get("name") or f"Employer block {props.get('block_id')} ({props.get('jobs')} jobs)")
        else:
            lab = labels[0] if labels else "edge"
            w = props.get("intensity", props.get("worker_share"))
            text.append(f"--[{lab} {w:.3g}]--" if isinstance(w, (int, float)) else f"--[{lab}]--")
    return {"business_id": business_id, "path_text": " ".join(text), "path_json": elements}


def neighborhood_context(business_ids: list[str]) -> dict:
    """Census tract demographics and SBA loan history for specific businesses.

    Use for "whose neighborhood does this help?" and to check fragility evidence. Places each
    business in its census tract by its coordinates and compares to the corridor average.

    Args:
        business_ids: Businesses to look up.

    Returns:
        Per business: tract, poverty rate, no-vehicle rate, public-assistance rate, loans; plus the
        corridor-wide averages for comparison.
    """
    rows = run(f"""
        WITH b AS (
          SELECT business_id, name, address, ST_GEOGPOINT(longitude, latitude) AS pt
          FROM {config.table('businesses')} WHERE business_id IN UNNEST(@ids)),
        t AS (
          SELECT geo_id, tract_geom FROM `{config.TRACT_GEOM_TABLE}` WHERE state_fips_code = '06')
        SELECT b.business_id, b.name, b.address, d.geo_id AS tract, d.poverty_rate,
               d.no_vehicle_rate, d.assistance_rate, d.median_income
        FROM b LEFT JOIN t ON ST_CONTAINS(t.tract_geom, b.pt)
        LEFT JOIN {config.table('tract_demographics')} d ON d.geo_id = t.geo_id""",
               {"ids": business_ids})
    avg = run(f"""SELECT AVG(poverty_rate) AS poverty_rate, AVG(no_vehicle_rate) AS no_vehicle_rate,
                         AVG(assistance_rate) AS assistance_rate
                  FROM {config.table('tract_demographics')}""")
    loans = _loans(business_ids)
    for r in rows:
        r["loans"] = loans.get(r["business_id"], {}).get("loans", [])
    return {"businesses": rows, "corridor_tract_average": avg[0] if avg else None,
            "note": "Demographics are an audit of where money lands, not an input to the ranking. "
                    "Race and ethnicity are excluded entirely."}


def equity_audit(tool_context: ToolContext) -> dict:
    """Audits the last recommendation: did the money go where the need is, or where the edge
    generator happens to see the most?

    Compares funded vs. all exposed vs. the whole corridor on industry mix (NAICS 2-digit sector)
    and on tract poverty / no-vehicle rates.

    Returns:
        Industry shares and tract need for each group, plus the known structural bias to report.
    """
    rec = tool_context.state.get("last_recommendation")
    if not rec:
        return {"error": "No recommendation yet. Call recommend_grants first."}
    rows = run(f"""
        WITH t AS (SELECT geo_id, tract_geom FROM `{config.TRACT_GEOM_TABLE}` WHERE state_fips_code = '06')
        SELECT b.business_id, SUBSTR(b.naics4, 1, 2) AS sector, d.poverty_rate, d.no_vehicle_rate
        FROM {config.table('businesses')} b
        LEFT JOIN t ON ST_CONTAINS(t.tract_geom, ST_GEOGPOINT(b.longitude, b.latitude))
        LEFT JOIN {config.table('tract_demographics')} d ON d.geo_id = t.geo_id""")
    groups = {"corridor": rows,
              "exposed": [r for r in rows if r["business_id"] in set(rec["exposed"])],
              "funded": [r for r in rows if r["business_id"] in set(rec["funded"])]}

    def summary(rs: list[dict[str, Any]]) -> dict[str, Any]:
        n = len(rs) or 1
        sectors: dict[str, int] = {}
        for r in rs:
            sectors[r["sector"]] = sectors.get(r["sector"], 0) + 1
        pov = [r["poverty_rate"] for r in rs if r["poverty_rate"] is not None]
        veh = [r["no_vehicle_rate"] for r in rs if r["no_vehicle_rate"] is not None]
        return {"n": len(rs),
                "sector_share_pct": {k: round(100 * v / n, 1) for k, v in sorted(sectors.items(), key=lambda x: -x[1])},
                "avg_poverty_rate": round(sum(pov) / len(pov), 3) if pov else None,
                "avg_no_vehicle_rate": round(sum(veh) / len(veh), 3) if veh else None}

    return {
        "groups": {k: summary(v) for k, v in groups.items()},
        "sector_key": {"72": "food service", "44/45": "retail", "81": "personal services",
                       "31-33": "manufacturing", "42": "wholesale", "71": "arts/recreation"},
        "known_bias": "Supply edges come from BEA industry purchase rates, so input-heavy industries "
                      "(restaurants, light manufacturing) get many edges and service-light ones "
                      "(barbers, salons) get almost none. Footfall edges only exist for NAICS 44/45/"
                      "71/72/81. Over-representation of 72 in 'funded' vs 'corridor' is likely this "
                      "mechanical bias, not need. Report the numbers, not the intention.",
    }
