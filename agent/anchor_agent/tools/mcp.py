"""Managed MCP server: BigQuery's Google-managed remote MCP endpoint (or MCP Toolbox on Cloud Run).

Used for generic, ad hoc questions ("how many cafes are in the corridor?", "show me the loan
table"). The cascade itself goes through our own tools, because it carries the depth rule and
the weighting.

One-time setup for the BigQuery managed server:
    gcloud beta services mcp enable bigquery.googleapis.com --project=$GOOGLE_CLOUD_PROJECT
The caller (you locally, the Cloud Run service account when deployed) needs
roles/bigquery.user, roles/bigquery.dataViewer and roles/mcp.toolUser.
"""

from __future__ import annotations

import google.auth
import google.auth.transport.requests
from google.adk.tools.mcp_tool import McpToolset, StreamableHTTPConnectionParams

from .. import config

_SCOPES = ["https://www.googleapis.com/auth/bigquery", "https://www.googleapis.com/auth/cloud-platform"]
_creds = None


def _auth_headers(_ctx=None) -> dict[str, str]:
    """Mint a fresh OAuth token per request, so the session survives the 1-hour token expiry."""
    global _creds
    if _creds is None:
        _creds, _ = google.auth.default(scopes=_SCOPES)
    if not _creds.valid:
        _creds.refresh(google.auth.transport.requests.Request())
    headers = {"Authorization": f"Bearer {_creds.token}"}
    if config.PROJECT_ID:
        headers["x-goog-user-project"] = config.PROJECT_ID
    return headers


def bigquery_mcp_toolset() -> McpToolset:
    return McpToolset(
        connection_params=StreamableHTTPConnectionParams(url=config.MCP_URL, timeout=60),
        header_provider=_auth_headers,
        tool_name_prefix="bq_mcp",
    )
