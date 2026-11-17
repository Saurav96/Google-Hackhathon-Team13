"""Anchor closure: a large employer block leaves, and the damage runs forward then backward."""

from . import data
from .applicants import APPLICANTS

_MAP_VIEWS: dict[tuple[str, int], dict] = {}


def map_view(block_id: str, max_hops: int = 2) -> dict | None:
    """Ids and links of the last simulation, for drawing. Kept out of the tool result."""
    return _MAP_VIEWS.get((block_id, data.clamp_hops(max_hops)))


def list_employer_blocks(limit: int = 10) -> dict:
    """List the largest employer blocks in the corridor. An employer block is a census block
    with a real worker count, not a single company.

    Args:
        limit: How many blocks to return, largest first.

    Returns:
        Blocks with block_id, census tract, jobs, and how many businesses draw footfall from them.
    """
    rows = data.rows(
        f"""
        SELECT e.block_id, e.tract, e.jobs, COUNT(f.business_id) AS businesses_drawing_footfall
        FROM `{data.PROJECT}.{data.DATASET}.employer_blocks` e
        LEFT JOIN `{data.PROJECT}.{data.DATASET}.draws_footfall_from` f USING (block_id)
        GROUP BY 1, 2, 3
        HAVING businesses_drawing_footfall > 1
        ORDER BY e.jobs DESC LIMIT {max(1, min(int(limit), 25))}
        """
    )
    return {
        "employer_blocks": rows,
        "note": "Job counts are real (Census LEHD). Which shops those workers use is modeled.",
    }


def simulate_employer_closure(block_id: str, max_hops: int = 2) -> dict:
    """Simulate a large employer block leaving. Walks the property graph forward along
    DrawsFootfall to the businesses that lose weekday trade, then backward along Supplies
    to the suppliers of those businesses, who are hurt without being anywhere near the employer.

    Args:
        block_id: The employer block that is closing. Use list_employer_blocks to find one.
        max_hops: How many Supplies steps to walk backward from the hit businesses, 1 to 3.

    Returns:
        First-order businesses losing footfall, second-order suppliers exposed through them,
        and which of the exposed businesses are not in the applicant queue.
    """
    hops = data.clamp_hops(max_hops)
    employer = data.rows(
        f"SELECT block_id, tract, jobs FROM `{data.PROJECT}.{data.DATASET}.employer_blocks` WHERE block_id = @id",
        id=block_id,
    )
    if not employer:
        return {"error": f"No employer block {block_id}. Use list_employer_blocks first."}

    first_order = data.rows(
        f"""
        SELECT * FROM GRAPH_TABLE({data.DATASET}.{data.GRAPH}
          MATCH (emp:Employer WHERE emp.block_id = @id)-[f:DrawsFootfall]->(shop:Business)
          RETURN shop.business_id AS business_id, shop.name AS name, shop.naics4 AS naics4,
                 f.worker_share AS workers_from_block)
        JOIN (SELECT business_id, SUM(worker_share) AS workers_total
              FROM `{data.PROJECT}.{data.DATASET}.draws_footfall_from` GROUP BY 1) USING (business_id)
        """,
        id=block_id,
    )
    for shop in first_order:
        shop["share_of_footfall_lost"] = round(shop["workers_from_block"] / shop["workers_total"], 3)
        shop["workers_from_block"] = round(shop["workers_from_block"], 1)
        del shop["workers_total"]
    first_order.sort(key=lambda s: s["share_of_footfall_lost"], reverse=True)
    lost = {s["business_id"]: s["share_of_footfall_lost"] for s in first_order}

    paths = data.rows(
        f"""
        GRAPH {data.DATASET}.{data.GRAPH}
        MATCH p = (emp:Employer WHERE emp.block_id = @id)-[f:DrawsFootfall]->(shop:Business)
                  <-[s:Supplies]-{{1,{hops}}}(supplier:Business)
        WHERE supplier.business_id != shop.business_id
        RETURN shop.business_id AS shop_id, shop.name AS shop,
               supplier.business_id AS business_id, supplier.name AS name, supplier.naics4 AS naics4,
               ARRAY(SELECT n.name FROM UNNEST(NODES(p)) AS n WITH OFFSET pos WHERE pos > 0 ORDER BY pos DESC) AS chain,
               ARRAY(SELECT n.business_id FROM UNNEST(NODES(p)) AS n WITH OFFSET pos WHERE pos > 0 ORDER BY pos DESC) AS chain_ids,
               ARRAY(SELECT link.intensity FROM UNNEST(s) AS link) AS intensities
        """,
        id=block_id,
    )
    suppliers: dict[str, dict] = {}
    for row in paths:
        strength = lost.get(row["shop_id"], 0.0)
        for intensity in row["intensities"]:
            strength *= intensity
        entry = suppliers.setdefault(
            row["business_id"],
            {
                "business_id": row["business_id"],
                "name": row["name"],
                "industry_naics4": row["naics4"],
                "buyers_losing_footfall": set(),
                "exposure_score": 0.0,
                "min_hops": len(row["intensities"]),
                "example_chain": "",
                "_best": -1.0,
            },
        )
        entry["buyers_losing_footfall"].add(row["shop"])
        entry["exposure_score"] += strength
        entry["min_hops"] = min(entry["min_hops"], len(row["intensities"]))
        if strength > entry["_best"]:
            entry["_best"] = strength
            entry["example_chain"] = " -> ".join(row["chain"]) + "  (buyer loses footfall)"

    second_order = sorted(suppliers.values(), key=lambda s: s["exposure_score"], reverse=True)
    for s in second_order:
        del s["_best"]
        s["buyers_losing_footfall"] = sorted(s["buyers_losing_footfall"])[:6]
        s["exposure_score"] = round(s["exposure_score"], 5)

    queue_ids = {a["business_id"] for a in APPLICANTS}
    exposed_ids = set(lost) | set(suppliers)
    links = {}
    for row in paths:
        ids = row["chain_ids"]
        for a, b in zip(ids, ids[1:]):
            links[(a, b)] = True
    _MAP_VIEWS[(block_id, hops)] = {
        "first_order": [{"id": s["business_id"], "share": s["share_of_footfall_lost"]} for s in first_order],
        "second_order": [
            {"id": s["business_id"], "score": s["exposure_score"], "hops": s["min_hops"]}
            for s in second_order
            if s["business_id"] not in lost
        ],
        "links": [{"source": a, "target": b} for a, b in links],
    }
    return {
        "employer_block": employer[0],
        "first_order_total": len(first_order),
        "first_order_lose_footfall": first_order[:15],
        "second_order_total": len(second_order),
        "second_order_suppliers": second_order[:12],
        "exposed_not_in_applicant_queue": len(exposed_ids - queue_ids),
        "exposed_in_applicant_queue": sorted(
            a["name"] for a in APPLICANTS if a["business_id"] in exposed_ids
        ),
        "how_to_read": (
            "share_of_footfall_lost is this block's share of all workers allocated to that "
            "business. exposure_score for a supplier sums, over its buyers that lose footfall, "
            "the buyer's footfall loss times the supply link intensity. Chains read supplier -> buyer."
        ),
        "evidence_note": (
            "Job counts are real. Footfall and supply links are modeled. Footfall gives nearer "
            "businesses a larger share of a block's workers, within 500 metres, so treat shares as rough."
        ),
    }
