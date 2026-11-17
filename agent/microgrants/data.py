"""BigQuery access shared by every tool: the client, the corridor directory and the graph walk."""

import math
import os
from functools import lru_cache

from google.cloud import bigquery

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


def rows(sql: str, **params) -> list[dict]:
    query_params = [bigquery.ScalarQueryParameter(k, "STRING", v) for k, v in params.items()]
    config = bigquery.QueryJobConfig(query_parameters=query_params)
    return [dict(r) for r in _bq().query_and_wait(sql, job_config=config)]


def clamp_hops(max_hops) -> int:
    try:
        return max(1, min(int(max_hops), MAX_HOPS))
    except (TypeError, ValueError):
        return 2


@lru_cache(maxsize=1)
def directory() -> dict[str, dict]:
    """Every business in the corridor with its network role and census tract, keyed by id."""
    found = rows(
        f"""
        SELECT business_id, name, address, zip, naics4, latitude, longitude, network_role,
               direct_buyers, total_exposed_2hop, cascade_intensity, dedup_account_id,
               tract_geo_id, tract_poverty_rate, tract_no_vehicle_rate, tract_assistance_rate
        FROM `{PROJECT}.{DATASET}.businesses_enriched`
        """
    )
    peers: dict[str, int] = {}
    registrations: dict[str, list[str]] = {}
    for b in found:
        peers[b["naics4"]] = peers.get(b["naics4"], 0) + 1
        registrations.setdefault(b["dedup_account_id"], []).append(b["name"])
    for b in found:
        b["same_industry_peers"] = peers[b["naics4"]] - 1
        b["other_registrations"] = [n for n in registrations[b["dedup_account_id"]] if n != b["name"]]
    return {b["business_id"]: b for b in found}


@lru_cache(maxsize=1)
def loans() -> dict[str, list[dict]]:
    found = rows(
        f"""
        SELECT business_id, bank_name, gross_approval, approval_date, loan_status, charged_off
        FROM `{PROJECT}.{DATASET}.borrowed_from`
        """
    )
    by_business: dict[str, list[dict]] = {}
    for loan in found:
        by_business.setdefault(loan.pop("business_id"), []).append(loan)
    return by_business


@lru_cache(maxsize=1)
def corridor_baseline() -> dict:
    """Simple mean across the corridor's census tracts, the same baseline the data lane reports."""
    return rows(
        f"""
        SELECT COUNT(*) AS tracts, ROUND(AVG(poverty_rate), 4) AS poverty_rate,
               ROUND(AVG(no_vehicle_rate), 4) AS no_vehicle_rate,
               ROUND(AVG(assistance_rate), 4) AS assistance_rate
        FROM `{PROJECT}.{DATASET}.tract_demographics`
        """
    )[0]


@lru_cache(maxsize=512)
def walk(business_id: str, hops: int, direction: str) -> tuple[dict, ...]:
    """Multi-hop traversal of the property graph along Supplies; one row per path."""
    pattern = (
        f"-[e:Supplies]->{{1,{hops}}}" if direction == "downstream" else f"<-[e:Supplies]-{{1,{hops}}}"
    )
    return tuple(
        rows(
            f"""
            GRAPH {DATASET}.{GRAPH}
            MATCH p = (seed:Business WHERE seed.business_id = @id){pattern}(other:Business)
            WHERE other.business_id != seed.business_id
            RETURN other.business_id AS business_id, other.name AS name, other.naics4 AS naics4,
                   ARRAY(SELECT n.name FROM UNNEST(NODES(p)) AS n) AS chain,
                   ARRAY(SELECT n.business_id FROM UNNEST(NODES(p)) AS n) AS chain_ids,
                   ARRAY(SELECT link.intensity FROM UNNEST(e) AS link) AS intensities
            """,
            id=business_id,
        )
    )


def best_paths(paths: tuple[dict, ...]) -> dict[str, dict]:
    """Strongest path to each reached business. Strength is the product of link intensities."""
    best: dict[str, dict] = {}
    for row in paths:
        strength = math.prod(row["intensities"])
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
                "weakest_link": round(min(row["intensities"]), 4),
            }
    return best


def exposed_set(business_id: str, hops: int = 2) -> dict[str, dict]:
    return best_paths(walk(business_id, hops, "downstream"))


def neighborhood(business: dict) -> dict:
    base = corridor_baseline()
    return {
        "census_tract": business["tract_geo_id"],
        "poverty_rate": business["tract_poverty_rate"],
        "no_vehicle_rate": business["tract_no_vehicle_rate"],
        "assistance_rate": business["tract_assistance_rate"],
        "corridor_average": {
            "poverty_rate": base["poverty_rate"],
            "no_vehicle_rate": base["no_vehicle_rate"],
            "assistance_rate": base["assistance_rate"],
        },
        "higher_need_than_corridor": business["tract_poverty_rate"] > base["poverty_rate"],
    }


def path_links(paths: tuple[dict, ...], reverse: bool = False) -> list[dict]:
    """Distinct supplier-to-buyer links used by a traversal, with the hop they sit on."""
    links: dict[tuple[str, str], int] = {}
    for row in paths:
        ids = row["chain_ids"]
        for hop, (a, b) in enumerate(zip(ids, ids[1:]), start=1):
            key = (b, a) if reverse else (a, b)
            links[key] = min(hop, links.get(key, hop))
    return [{"source": a, "target": b, "hop": hop} for (a, b), hop in links.items()]
