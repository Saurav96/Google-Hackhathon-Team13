"""ADK entry point. `adk web` / `adk run` / `adk deploy cloud_run` look for `root_agent` here."""

from google.adk.agents import LlmAgent

from . import config
from .prompts import INSTRUCTION
from .tools.graph_tools import (
    equity_audit,
    find_anchor_employers,
    neighborhood_context,
    recommend_grants,
    show_cascade_path,
    trace_anchor_closure,
)

tools = [
    find_anchor_employers,
    trace_anchor_closure,
    recommend_grants,
    show_cascade_path,
    neighborhood_context,
    equity_audit,
]

if config.MCP_ENABLED:
    from .tools.mcp import bigquery_mcp_toolset

    tools.append(bigquery_mcp_toolset())

root_agent = LlmAgent(
    name="anchor_closure_agent",
    model=config.MODEL,
    description="Finds businesses exposed to an anchor employer leaving a San Francisco corridor "
                "and argues for how a relief fund should be spent.",
    instruction=INSTRUCTION,
    tools=tools,
)
