"""Thin BigQuery helper shared by every tool."""

from __future__ import annotations

from functools import lru_cache
from typing import Any

from google.cloud import bigquery

from .. import config


@lru_cache(maxsize=1)
def client() -> bigquery.Client:
    return bigquery.Client(project=config.PROJECT_ID or None, location=config.BQ_LOCATION)


def run(sql: str, params: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    """Run a query (SQL or GQL) and return rows as plain dicts."""
    query_params = []
    for name, value in (params or {}).items():
        if isinstance(value, (list, tuple)):
            query_params.append(bigquery.ArrayQueryParameter(name, "STRING", [str(v) for v in value]))
        elif isinstance(value, bool):
            query_params.append(bigquery.ScalarQueryParameter(name, "BOOL", value))
        elif isinstance(value, int):
            query_params.append(bigquery.ScalarQueryParameter(name, "INT64", value))
        elif isinstance(value, float):
            query_params.append(bigquery.ScalarQueryParameter(name, "FLOAT64", value))
        else:
            query_params.append(bigquery.ScalarQueryParameter(name, "STRING", str(value)))
    job = client().query(sql, job_config=bigquery.QueryJobConfig(query_parameters=query_params))
    return [dict(row.items()) for row in job.result()]
