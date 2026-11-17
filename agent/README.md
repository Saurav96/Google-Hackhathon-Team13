# Anchor Closure agent (ADK)

**Track: 🏭 Anchor closure.** A large employer is leaving the corridor in 90 days. Nobody has
applied for anything. The agent finds who is exposed before they know it, and argues for how a
relief fund should be spent.

The traversal that defines this track goes **forward along one edge type, then backward along
another**:

```
(e:Employer)-[:DrawsFootfall]->(cafe:Business)<-[:Supplies]-{1,2}(roaster:Business)
```

The café loses the office lunch crowd. The roaster loses the café as a buyer, and never had
anything to do with the office. The roaster is the business a queue of applications never shows.

## Layout

```
agent/
  sql/create_graph.sql          Property graph DDL (Business + Employer nodes, Supplies + DrawsFootfall edges)
  anchor_agent/                 The ADK agent package (what adk web / adk deploy point at)
    agent.py                    root_agent: Gemini + our tools + BigQuery managed MCP
    prompts.py                  System instruction: who the user is, which tool when, when to refuse, memo format
    config.py                   Env-driven settings
    tools/graph_tools.py        Our tools - the multi-hop GQL traversals
    tools/exposure.py           Our judgment layer - exposure, closure risk, grant value, allocation, sensitivity
    tools/mcp.py                BigQuery managed MCP server (or MCP Toolbox via MCP_URL)
    requirements.txt, .env.example
  tests/test_exposure.py        Unit tests for the judgment layer on the README's toy block
  deploy.sh                     Cloud Run deploy (with ADK web UI, min-instances 1)
```

## Tools

| Tool | What it does | Graph |
|---|---|---|
| `find_anchor_employers` | Ranks employer blocks by how far their departure reaches | `-[:DrawsFootfall]->()<-[:Supplies]-{1,2}` |
| `trace_anchor_closure` | Who is exposed: direct (footfall) and upstream (supply), with the path to each | Explicit 2-, 3- and 4-hop patterns, direction change mid-path |
| `recommend_grants` | Budget split, what each grant protects, runner-up, hub check, sensitivity | Uses the trace |
| `show_cascade_path` | The actual path to one business, as text and `TO_JSON(p)` for a front end | `ANY SHORTEST ... {1,2}` |
| `neighborhood_context` | Tract poverty / no-vehicle / assistance + SBA loan history | SQL + public tract geometry |
| `equity_audit` | Funded vs exposed vs corridor: industry mix and tract need | SQL |
| `bq_mcp_*` | Ad hoc read-only lookups through BigQuery's managed MCP server | — |

## The exposure model (say this in the deck)

All parameters are explicit and the officer can override any of them in conversation.

1. The anchor's block loses `job_loss_fraction` of its workers (default 100%).
2. A business it draws footfall to loses `anchor worker_share / total worker_share` of its worker
   trade, times `footfall_dependence` (default 50% of revenue comes from nearby workers).
3. Its suppliers lose `buyer's intensity / supplier's total intensity` of their corridor sales,
   times `corridor_sales_share` (default 30%). Repeats for a second backward hop.
4. Closure risk = `min(90%, 1.5 × revenue lost)`, ×1.5 with a real SBA charge-off on record.
5. A grant cuts closure risk by `grant_effect` (default 50%). **A grant changes a probability.**
6. Grant value = expected closures averted, its own plus upstream suppliers kept alive.
   Budget is split in proportion to value, between $5k and $15k per grant (a policy rule:
   there is no revenue data).
7. Every recommendation ships with a sensitivity table: does the top pick survive if each
   assumption is wrong?

**What is real vs modeled:** businesses, job counts, SBA loans/charge-offs, tract demographics are
real. Which business supplies which, and where workers spend, are modeled from BEA/LEHD industry
averages plus walking distance.

## Run it

Prerequisites: data loaded (`bash scripts/load.sh central-market` or the notebook), which also
creates the Enterprise reservation that graph queries need.

```bash
# 1. Create the property graph (once)
bq query --use_legacy_sql=false < agent/sql/create_graph.sql

# 2. Enable BigQuery's managed MCP server (once)
gcloud beta services mcp enable bigquery.googleapis.com --project=$GOOGLE_CLOUD_PROJECT

# 3. Install and configure
cd agent
python -m venv .venv && source .venv/bin/activate
pip install -r anchor_agent/requirements.txt pytest
cp anchor_agent/.env.example anchor_agent/.env    # set GOOGLE_CLOUD_PROJECT
python -m pytest tests -q

# 4. Chat with it locally
adk web            # pick anchor_closure_agent in the UI

# 5. Deploy to Cloud Run
bash deploy.sh
```

If the MCP endpoint is not available in your project, set `MCP_ENABLED=false` to run with our
tools only, or point `MCP_URL` at an MCP Toolbox for Databases service on Cloud Run.

## Demo script (what to ask)

1. "Which employer blocks would hurt this corridor most if they emptied out?"
2. "The employer in block `<id>` is leaving in 90 days. Who is exposed?"
3. "Which of those never had anything to do with the employer?" (the backward leg)
4. "We have $50,000. How should we spend it?"
5. "Why not `<runner-up>`?" / "Why didn't you fund the biggest hub?"
6. "What if only half the jobs leave?" / "What if `<business>` closes anyway?"
7. "Whose neighborhood does this help?" then "Run the equity audit."
8. "Write it up. I present Friday." → Grant Memo

## Known limitations

- Supply and footfall edges are modeled; the agent says so in every recommendation.
- No revenue or per-business jobs data: grant sizing and closure risk are stated assumptions.
- Employers are census blocks, not named companies. LEHD places them at tract centroids.
- Harm is propagated only upstream (to suppliers). A closed supplier's buyers are assumed able
  to re-source.
- The edge generator favors input-heavy industries (restaurants) over personal services; the
  equity audit reports how much this shows in the output.
