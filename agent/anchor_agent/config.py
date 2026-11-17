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
# ACS tract demographics, read directly. The loaded tract_demographics table only holds tracts
# whose centre point falls in the corridor box, which misses the tracts most businesses sit in.
# 2019 5-year, NOT 2020: the public tract geometry table uses 2010 tract boundaries, and the 2020
# ACS uses 2020 boundaries (e.g. 06075017601 was split), so 2020 silently matches nothing.
ACS_TABLE = os.environ.get("ACS_TABLE", "bigquery-public-data.census_bureau_acs.censustract_2019_5yr")
ACS_VINTAGE_NOTE = "ACS 2015-2019 5-year estimates (pre-pandemic), matched to 2010 tract boundaries."
STATE_FIPS = os.environ.get("STATE_FIPS", "06")


def table(name: str) -> str:
    """Fully qualified, backticked table reference for SQL (not for graph DDL)."""
    prefix = f"{PROJECT_ID}." if PROJECT_ID else ""
    return f"`{prefix}{DATASET}.{name}`"


def graph() -> str:
    """Graph reference for a GRAPH clause: dataset-qualified, unbackticked."""
    return f"{DATASET}.{GRAPH}"
