"""The judgment layer: turns traversal results into exposure, closure risk and grant value.

Pure Python, no BigQuery, so it is unit-testable and every number is explainable.

The model, in one paragraph (this is what the memo's "what we are assuming" section restates):

1. An anchor employer leaves. Its census block loses `job_loss_fraction` of its workers.
2. Every business that block DrawsFootfall to loses the anchor's share of its worker foot traffic,
   times `footfall_dependence` (the share of that business's revenue that comes from nearby workers).
3. Those businesses buy less. Each of their suppliers loses revenue in proportion to how important
   that buyer is to it (the buyer's BEA intensity / the supplier's total intensity over all its
   corridor buyers), times `corridor_sales_share` (suppliers also sell outside the corridor).
   This is the BACKWARD leg along Supplies, and it repeats once more for a second hop.
4. Closure risk = min(0.9, closure_sensitivity x revenue loss), x 1.5 if the business has a real
   SBA charge-off on record. A grant cuts that risk by `grant_effect` (relative).
5. The value of funding a business = expected closures averted: its own, plus the closures its
   survival prevents upstream (its suppliers keep a buyer).
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field, replace
from typing import Any


@dataclass(frozen=True)
class Assumptions:
    job_loss_fraction: float = 1.0
    footfall_dependence: float = 0.5
    corridor_sales_share: float = 0.3
    closure_sensitivity: float = 1.5
    grant_effect: float = 0.5
    materiality: float = 0.03
    charge_off_multiplier: float = 1.5
    max_risk: float = 0.9

    def describe(self) -> list[str]:
        return [
            f"The anchor's census block loses {self.job_loss_fraction:.0%} of its workers.",
            f"{self.footfall_dependence:.0%} of a consumer-facing business's revenue comes from nearby "
            "workers (footfall_dependence). Not in the data: a policy assumption.",
            f"{self.corridor_sales_share:.0%} of a supplier's sales go to buyers inside this corridor "
            "(corridor_sales_share). Not in the data.",
            f"Closure risk = min({self.max_risk:.0%}, {self.closure_sensitivity} x revenue lost); x"
            f"{self.charge_off_multiplier} where the business has a real SBA loan charge-off.",
            f"A grant cuts a business's closure risk by {self.grant_effect:.0%} (relative). A grant "
            "changes a probability, not an outcome.",
            f"A business counts as exposed when it stands to lose at least {self.materiality:.0%} of revenue.",
        ]


@dataclass
class TraversalData:
    """Everything the model needs, as fetched by the graph tools."""

    # business_id -> (worker_share from the anchor block, total worker_share from all blocks)
    direct: dict[str, tuple[float, float]]
    # (supplier_id, buyer_id) -> intensity, for every Supplies edge on a traversed path
    supply_edges: dict[tuple[str, str], float]
    # supplier_id -> total intensity over ALL its buyers in the corridor
    supplier_total_intensity: dict[str, float]
    # business_id -> {"name", "address", "naics4", ...}
    businesses: dict[str, dict[str, Any]] = field(default_factory=dict)
    # business_id -> {"has_loan": bool, "charged_off": bool}
    loans: dict[str, dict[str, Any]] = field(default_factory=dict)


def _share(data: TraversalData, supplier: str, buyer: str) -> float:
    total = data.supplier_total_intensity.get(supplier) or 0.0
    if total <= 0:
        return 0.0
    return data.supply_edges.get((supplier, buyer), 0.0) / total


def _suppliers_of(data: TraversalData) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    for supplier, buyer in data.supply_edges:
        out.setdefault(buyer, []).append(supplier)
    return out


def revenue_loss(
    data: TraversalData,
    a: Assumptions,
    max_supply_hops: int = 2,
    assume_closed: tuple[str, ...] = (),
) -> tuple[dict[str, float], dict[str, int]]:
    """Revenue share each business loses, and the hop distance (0 = hit by footfall directly)."""
    loss: dict[str, float] = {}
    hops: dict[str, int] = {}
    for b, (anchor_share, total_share) in data.direct.items():
        if total_share > 0:
            loss[b] = a.job_loss_fraction * a.footfall_dependence * min(1.0, anchor_share / total_share)
            hops[b] = 0
    for b in assume_closed:
        loss[b] = 1.0
        hops.setdefault(b, 0)

    suppliers_of = _suppliers_of(data)
    frontier = dict(loss)  # the increment introduced at the previous level
    for level in range(1, max_supply_hops + 1):
        nxt: dict[str, float] = {}
        for buyer, delta in frontier.items():
            for supplier in suppliers_of.get(buyer, []):
                if supplier == buyer:
                    continue
                hit = delta * a.corridor_sales_share * _share(data, supplier, buyer)
                if hit > 0:
                    nxt[supplier] = nxt.get(supplier, 0.0) + hit
                    hops.setdefault(supplier, level)
        for b, d in nxt.items():
            if b in assume_closed:
                continue
            loss[b] = min(1.0, loss.get(b, 0.0) + d)
        frontier = {b: d for b, d in nxt.items() if b not in assume_closed}
    return loss, hops


def closure_risk(b: str, loss: float, data: TraversalData, a: Assumptions) -> float:
    risk = a.closure_sensitivity * loss
    if data.loans.get(b, {}).get("charged_off"):
        risk *= a.charge_off_multiplier
    return min(a.max_risk, risk)


def upstream_if_closed(
    data: TraversalData, a: Assumptions, b: str, max_supply_hops: int = 2
) -> list[dict[str, Any]]:
    """Suppliers that lose revenue if `b` closes, with the size of the hit and the chain."""
    suppliers_of = _suppliers_of(data)
    hits: dict[str, dict[str, Any]] = {}
    frontier = {b: (1.0, [b])}
    for level in range(1, max_supply_hops + 1):
        nxt: dict[str, tuple[float, list[str]]] = {}
        for buyer, (delta, chain) in frontier.items():
            for supplier in suppliers_of.get(buyer, []):
                if supplier in chain:
                    continue
                hit = delta * a.corridor_sales_share * _share(data, supplier, buyer)
                if hit <= 0:
                    continue
                if supplier not in nxt or hit > nxt[supplier][0]:
                    nxt[supplier] = (hit, chain + [supplier])
                rec = hits.setdefault(supplier, {"business_id": supplier, "revenue_hit": 0.0,
                                                 "hops_from_funded": level, "chain": chain + [supplier]})
                rec["revenue_hit"] = min(1.0, rec["revenue_hit"] + hit)
        frontier = nxt
    return sorted(hits.values(), key=lambda r: -r["revenue_hit"])


def grant_value(data: TraversalData, a: Assumptions, b: str, loss: float, max_supply_hops: int = 2) -> dict[str, Any]:
    risk = closure_risk(b, loss, data, a)
    averted_self = a.grant_effect * risk
    upstream = upstream_if_closed(data, a, b, max_supply_hops)
    upstream_risk = sum(min(a.max_risk, a.closure_sensitivity * u["revenue_hit"]) for u in upstream)
    return {
        "business_id": b,
        "revenue_loss": loss,
        "closure_risk": risk,
        "upstream_dependants": upstream,
        # Expected closures averted: the business itself, plus the upstream closures that its
        # survival prevents (only realised in the branch where it would otherwise have closed).
        "value": averted_self * (1.0 + upstream_risk),
    }


def rank(
    data: TraversalData,
    a: Assumptions,
    max_supply_hops: int = 2,
    assume_closed: tuple[str, ...] = (),
) -> list[dict[str, Any]]:
    loss, hops = revenue_loss(data, a, max_supply_hops, assume_closed)
    out = []
    for b, l in loss.items():
        if b in assume_closed or l < a.materiality:
            continue
        v = grant_value(data, a, b, l, max_supply_hops)
        v["hops_from_anchor"] = hops.get(b)
        v["exposure_route"] = "footfall (direct)" if hops.get(b) == 0 else f"supply, {hops.get(b)} hop(s) upstream"
        out.append(v)
    out.sort(key=lambda r: -r["value"])
    return out


def allocate(
    ranked: list[dict[str, Any]],
    budget: float,
    max_grants: int = 5,
    min_grant: float = 5000.0,
    max_grant: float = 15000.0,
) -> tuple[list[dict[str, Any]], float]:
    """Split the budget across the top candidates in proportion to expected closures averted.

    Grant SIZE is a policy rule, not a measurement: the data has no revenue figures.
    """
    n = int(min(max_grants, len(ranked), budget // max(min_grant, 1)))
    chosen = [dict(r) for r in ranked[:n]]
    if not chosen:
        return [], budget
    total_value = sum(r["value"] for r in chosen) or 1.0
    for r in chosen:
        r["amount"] = budget * r["value"] / total_value
    # clamp, then redistribute what the caps freed up, a few times
    for _ in range(5):
        for r in chosen:
            r["amount"] = max(min_grant, min(max_grant, r["amount"]))
        spent = sum(r["amount"] for r in chosen)
        if spent > budget:
            scale = budget / spent
            for r in chosen:
                r["amount"] *= scale
        free = budget - sum(r["amount"] for r in chosen)
        room = [r for r in chosen if r["amount"] < max_grant]
        if free < 1 or not room:
            break
        rv = sum(r["value"] for r in room) or 1.0
        for r in room:
            r["amount"] += free * r["value"] / rv
    for r in chosen:
        r["amount"] = float(int(r["amount"] // 500 * 500))
    reserve = budget - sum(r["amount"] for r in chosen)
    return chosen, reserve


def sensitivity(
    data: TraversalData,
    base: Assumptions,
    max_supply_hops: int,
    assume_closed: tuple[str, ...],
    top_k: int,
) -> list[dict[str, Any]]:
    """Does the recommendation survive if our assumptions are wrong?"""
    base_rank = [r["business_id"] for r in rank(data, base, max_supply_hops, assume_closed)[:top_k]]
    variants = {
        "footfall_dependence 0.25": replace(base, footfall_dependence=0.25),
        "footfall_dependence 0.75": replace(base, footfall_dependence=0.75),
        "corridor_sales_share 0.15": replace(base, corridor_sales_share=0.15),
        "corridor_sales_share 0.6": replace(base, corridor_sales_share=0.6),
        "grant_effect 0.25": replace(base, grant_effect=0.25),
        "only 50% of block jobs leave": replace(base, job_loss_fraction=0.5),
    }
    out = []
    for label, a in variants.items():
        r = [x["business_id"] for x in rank(data, a, max_supply_hops, assume_closed)[:top_k]]
        overlap = len(set(r) & set(base_rank)) / max(1, len(set(r) | set(base_rank)))
        out.append({
            "if": label,
            "top_pick_unchanged": bool(r and base_rank and r[0] == base_rank[0]),
            "new_top_pick": r[0] if r else None,
            "shortlist_overlap": round(overlap, 2),
        })
    return out


def assumptions_from(**kwargs: Any) -> Assumptions:
    clean = {k: float(v) for k, v in kwargs.items() if v is not None and k in Assumptions.__dataclass_fields__}
    return replace(Assumptions(), **clean)


def as_dict(a: Assumptions) -> dict[str, float]:
    return asdict(a)
