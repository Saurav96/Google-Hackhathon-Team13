import math
import os
from functools import lru_cache
from collections import Counter
from concurrent.futures import ThreadPoolExecutor

from google.cloud import bigquery

from .applicants import APPLICANTS, BUDGET_USD

PROJECT = os.environ.get("GOOGLE_CLOUD_PROJECT")
DATASET = os.environ.get("BQ_DATASET", "a4i_econ")
GRAPH = os.environ.get("BQ_GRAPH", "LocalEconomy")
MAX_HOPS = 3

_client = None


def _bq() -> bigquery.Client:
    global _client
    if _client is None:
        _client = bigquery.Client(project=PROJECT)
    return _client


def _rows(sql: str, **params) -> list[dict]:
    query_params = [
        bigquery.ArrayQueryParameter(k, "STRING", v)
        if isinstance(v, list)
        else bigquery.ScalarQueryParameter(k, "STRING", v)
        for k, v in params.items()
    ]
    config = bigquery.QueryJobConfig(query_parameters=query_params)
    return [dict(r) for r in _bq().query_and_wait(sql, job_config=config)]


@lru_cache(maxsize=512)
def _walk(business_id: str, hops: int, direction: str) -> tuple[dict, ...]:
    """Multi-hop traversal of the property graph; one row per path."""
    pattern = (
        f"-[e:Supplies]->{{1,{hops}}}" if direction == "downstream" else f"<-[e:Supplies]-{{1,{hops}}}"
    )
    sql = f"""
    GRAPH {DATASET}.{GRAPH}
    MATCH p = (seed:Business WHERE seed.business_id = @id){pattern}(other:Business)
    WHERE other.business_id != seed.business_id
    RETURN other.business_id AS business_id, other.name AS name, other.naics4 AS naics4,
           ARRAY(SELECT n.name FROM UNNEST(NODES(p)) AS n) AS chain,
           ARRAY(SELECT link.intensity FROM UNNEST(e) AS link) AS intensities
    """
    return tuple(_rows(sql, id=business_id))


def _hops(max_hops: int) -> int:
    return max(1, min(int(max_hops), MAX_HOPS))


def _best_paths(rows: tuple[dict, ...]) -> dict[str, dict]:
    """Keep the strongest path to each reached business. Strength = product of link intensities."""
    best: dict[str, dict] = {}
    for row in rows:
        strength = 1.0
        for intensity in row["intensities"]:
            strength *= intensity
        current = best.get(row["business_id"])
        if current is None or strength > current["path_strength"]:
            best[row["business_id"]] = {
                "business_id": row["business_id"],
                "name": row["name"],
                "industry_naics4": row["naics4"],
                "hops": len(row["intensities"]),
                "chain": " -> ".join(row["chain"]),
                "link_intensities": [round(i, 4) for i in row["intensities"]],
                "path_strength": round(strength, 5),
            }
    return best


@lru_cache(maxsize=512)
def _profile(business_id: str) -> dict | None:
    rows = _rows(
        f"""
        SELECT b.business_id, b.name, b.address, b.zip, b.naics4, b.network_role,
          (SELECT COUNT(*) FROM `{PROJECT}.{DATASET}.businesses` p
            WHERE p.naics4 = b.naics4 AND p.business_id != b.business_id) AS same_industry_peers
        FROM `{PROJECT}.{DATASET}.businesses_enriched` b
        WHERE b.business_id = @id
        """,
        id=business_id,
    )
    return rows[0] if rows else None


@lru_cache(maxsize=512)
def _loans(business_id: str) -> tuple[dict, ...]:
    return tuple(_rows(
        f"""
        SELECT bank_name, gross_approval, approval_date, loan_status, charged_off
        FROM `{PROJECT}.{DATASET}.borrowed_from` WHERE business_id = @id
        """,
        id=business_id,
    ))


def find_business(name: str) -> dict:
    """Look up businesses in the corridor by part of their name.

    Args:
        name: Full or partial business name, for example "Sour Flour".

    Returns:
        Matching businesses with business_id, name, address and 4-digit NAICS industry.
    """
    rows = _rows(
        f"""
        SELECT business_id, name, address, zip, naics4
        FROM `{PROJECT}.{DATASET}.businesses`
        WHERE LOWER(name) LIKE CONCAT('%', LOWER(@name), '%')
        ORDER BY name LIMIT 15
        """,
        name=name,
    )
    return {"matches": rows, "count": len(rows)}


def get_applicant_queue() -> dict:
    """Return the relief fund budget and the queue of applicants waiting for a decision.

    The queue and requested amounts are a demo scenario chosen by the team, not registry data.
    """
    return {
        "budget_usd": BUDGET_USD,
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
        (named, with link intensity), how replaceable the seed is, and its loan record.
    """
    seed = _profile(business_id)
    if seed is None:
        return {"error": f"No business with id {business_id}. Use find_business first."}

    paths = _walk(business_id, _hops(max_hops), "downstream")
    best = _best_paths(paths)
    exposed = sorted(best.values(), key=lambda e: e["path_strength"], reverse=True)
    by_hops = Counter(e["hops"] for e in exposed)
    peers = seed["same_industry_peers"]

    return {
        "seed": seed,
        "max_hops": _hops(max_hops),
        "exposed_total": len(exposed),
        "exposed_by_hops": {f"{h}_hop": n for h, n in sorted(by_hops.items())},
        "cascade_intensity": round(sum(math.prod(p["intensities"]) for p in paths), 4),
        "strongest_chains": exposed[:12],
        "furthest_chains": [e for e in exposed if e["hops"] > 1][:6],
        "replaceability": {
            "same_industry_peers_in_corridor": peers,
            "reading": (
                "Only local source of this input in the corridor, so buyers have no local substitute. "
                "They could still buy from outside the corridor, which the data cannot see."
                if peers == 0
                else f"{peers} other local businesses in the same industry could absorb its buyers."
            ),
        },
        "sba_loans": list(_loans(business_id)),
        "evidence_note": (
            "Businesses and loans are real records. Supplies links are modeled: federal BEA "
            "industry purchase rates assigned to nearby business pairs. Intensity is the share "
            "of a buyer's input budget, not a measured contract."
        ),
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
    seed = _profile(business_id)
    if seed is None:
        return {"error": f"No business with id {business_id}. Use find_business first."}

    best = _best_paths(_walk(business_id, _hops(max_hops), "upstream"))
    upstream = sorted(best.values(), key=lambda e: e["path_strength"], reverse=True)
    # Show chains supplier-first so the arrow reads the same way as in trace_cascade.
    for item in upstream:
        item["chain"] = " -> ".join(reversed(item["chain"].split(" -> ")))
        item["link_intensities"] = item["link_intensities"][::-1]
    return {
        "seed": seed,
        "upstream_total": len(upstream),
        "direct_suppliers": [u for u in upstream if u["hops"] == 1],
        "indirect_suppliers": [u for u in upstream if u["hops"] > 1][:10],
    }


def compare_applicants(business_ids: list[str], max_hops: int = 2) -> dict:
    """Compare several applicants side by side on what each one's closure would expose.

    Args:
        business_ids: The business_ids to compare.
        max_hops: Traversal depth for every applicant, 1 to 3.

    Returns:
        One row per applicant with cascade size, weighted exposure, replaceability and
        loan record, plus applicants that have no cascade at all.
    """
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(lambda b: trace_cascade(b, max_hops), business_ids))

    rows = []
    for business_id, result in zip(business_ids, results):
        if "error" in result:
            rows.append({"business_id": business_id, "error": result["error"]})
            continue
        top = result["strongest_chains"][:3]
        rows.append(
            {
                "business_id": business_id,
                "name": result["seed"]["name"],
                "address": result["seed"]["address"],
                "industry_naics4": result["seed"]["naics4"],
                "exposed_total": result["exposed_total"],
                "exposed_by_hops": result["exposed_by_hops"],
                "network_role": result["seed"]["network_role"],
                "cascade_intensity": result["cascade_intensity"],
                "same_industry_peers_in_corridor": result["replaceability"][
                    "same_industry_peers_in_corridor"
                ],
                "top_chains": [c["chain"] for c in top],
                "sba_loans": result["sba_loans"],
            }
        )
    return {
        "max_hops": _hops(max_hops),
        "applicants": rows,
        "no_cascade": [r["name"] for r in rows if r.get("exposed_total") == 0],
        "how_to_read": (
            "exposed_total counts businesses reached. cascade_intensity sums link intensity "
            "over every 1 hop path plus the product of intensities over every 2 hop path. "
            "network_role: Ubiquitous Hub is over 80 reach, Target Anchor is 10 to 50, "
            "Small/Peripheral Supplier is 1 to 9, Leaf Node is 0. A Ubiquitous Hub is usually a "
            "lone local producer that the model gives all local demand to, so it is a weak "
            "signal. Many peers means buyers can switch locally."
        ),
    }


def list_employer_blocks(limit: int = 10) -> dict:
    """List the largest employer blocks in the corridor. An employer block is a census block
    with a real worker count, not a single company.

    Args:
        limit: How many blocks to return, largest first.

    Returns:
        Blocks with block_id, census tract, jobs, and how many businesses draw footfall from them.
    """
    rows = _rows(
        f"""
        SELECT e.block_id, e.tract, e.jobs, COUNT(f.business_id) AS businesses_drawing_footfall
        FROM `{PROJECT}.{DATASET}.employer_blocks` e
        LEFT JOIN `{PROJECT}.{DATASET}.draws_footfall_from` f USING (block_id)
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
    hops = _hops(max_hops)
    employer = _rows(
        f"SELECT block_id, tract, jobs FROM `{PROJECT}.{DATASET}.employer_blocks` WHERE block_id = @id",
        id=block_id,
    )
    if not employer:
        return {"error": f"No employer block {block_id}. Use list_employer_blocks first."}

    first_order = _rows(
        f"""
        SELECT * FROM GRAPH_TABLE({DATASET}.{GRAPH}
          MATCH (emp:Employer WHERE emp.block_id = @id)-[f:DrawsFootfall]->(shop:Business)
          RETURN shop.business_id AS business_id, shop.name AS name, shop.naics4 AS naics4,
                 f.worker_share AS workers_from_block)
        JOIN (SELECT business_id, SUM(worker_share) AS workers_total
              FROM `{PROJECT}.{DATASET}.draws_footfall_from` GROUP BY 1) USING (business_id)
        """,
        id=block_id,
    )
    for shop in first_order:
        shop["share_of_footfall_lost"] = round(shop["workers_from_block"] / shop["workers_total"], 3)
        shop["workers_from_block"] = round(shop["workers_from_block"], 1)
        del shop["workers_total"]
    first_order.sort(key=lambda s: s["share_of_footfall_lost"], reverse=True)
    lost = {s["business_id"]: s["share_of_footfall_lost"] for s in first_order}

    paths = _rows(
        f"""
        GRAPH {DATASET}.{GRAPH}
        MATCH p = (emp:Employer WHERE emp.block_id = @id)-[f:DrawsFootfall]->(shop:Business)
                  <-[s:Supplies]-{{1,{hops}}}(supplier:Business)
        WHERE supplier.business_id != shop.business_id
        RETURN shop.business_id AS shop_id, shop.name AS shop,
               supplier.business_id AS business_id, supplier.name AS name, supplier.naics4 AS naics4,
               ARRAY(SELECT n.name FROM UNNEST(NODES(p)) AS n WITH OFFSET pos WHERE pos > 0 ORDER BY pos DESC) AS chain,
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
            "Job counts are real. Footfall and supply links are modeled, and footfall is spread "
            "equally across nearby businesses, so treat shares as rough."
        ),
    }
