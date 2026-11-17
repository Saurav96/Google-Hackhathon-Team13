"""Runtime configuration, all overridable by environment variables (see .env.example)."""

import os

PROJECT_ID = os.environ.get("GOOGLE_CLOUD_PROJECT", "")
BQ_LOCATION = os.environ.get("BQ_LOCATION", "US")
DATASET = os.environ.get("BQ_DATASET", "a4i_econ")
GRAPH = os.environ.get("BQ_GRAPH", "LocalEconomy")
MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.5-flash")

# Managed MCP server. Default is BigQuery's Google-managed remote MCP endpoint.
# To use MCP Toolbox for Databases on Cloud Run instead, set MCP_URL to "https://<service>/mcp".
MCP_URL = os.environ.get("MCP_URL", "https://bigquery.googleapis.com/mcp")
MCP_ENABLED = os.environ.get("MCP_ENABLED", "true").lower() == "true"

# Census tract geometries, used to place each business in a tract for the equity view.
TRACT_GEOM_TABLE = "bigquery-public-data.geo_census_tracts.us_census_tracts_national"


def table(name: str) -> str:
    """Fully qualified, backticked table reference for SQL (not for graph DDL)."""
    prefix = f"{PROJECT_ID}." if PROJECT_ID else ""
    return f"`{prefix}{DATASET}.{name}`"


def graph() -> str:
    """Graph reference for a GRAPH clause: dataset-qualified, unbackticked."""
    return f"{DATASET}.{GRAPH}"
