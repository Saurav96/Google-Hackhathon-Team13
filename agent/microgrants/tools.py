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
        SELECT b.business_id, b.name, b.address, b.zip, b.naics4,
          (SELECT COUNT(*) FROM `{PROJECT}.{DATASET}.businesses` p
            WHERE p.naics4 = b.naics4 AND p.business_id != b.business_id) AS same_industry_peers
        FROM `{PROJECT}.{DATASET}.businesses` b
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

    best = _best_paths(_walk(business_id, _hops(max_hops), "downstream"))
    exposed = sorted(best.values(), key=lambda e: e["path_strength"], reverse=True)
    by_hops = Counter(e["hops"] for e in exposed)
    peers = seed["same_industry_peers"]

    return {
        "seed": seed,
        "max_hops": _hops(max_hops),
        "exposed_total": len(exposed),
        "exposed_by_hops": {f"{h}_hop": n for h, n in sorted(by_hops.items())},
        "weighted_exposure": round(sum(e["path_strength"] for e in exposed), 4),
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
                "weighted_exposure": result["weighted_exposure"],
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
            "exposed_total counts businesses reached. weighted_exposure sums the strongest "
            "path strength to each one. Many peers means buyers can switch locally, so a large "
            "cascade from a business with many peers is weaker than it looks."
        ),
    }
