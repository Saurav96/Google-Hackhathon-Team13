# Central Market relief desk: the agent

An ADK agent that helps a city grant officer decide which businesses to fund, by tracing what
each closure would expose in a BigQuery property graph. It builds a case, not a score.

- Live: https://grant-advisor-525982359170.us-central1.run.app
- ADK developer UI on the same service: `/dev-ui/`
- Track: Main Street relief, plus the Anchor closure question

## What it does

| The officer asks | Tool | How it answers |
|---|---|---|
| If this business closes, what is exposed? | `trace_cascade` | Multi hop GQL traversal of `Supplies`, 2 hops by default |
| What does this business need to survive? | `trace_dependencies` | The same traversal backward, against the arrow |
| Why this one and not that one? | `compare_applicants` | Traversal for every applicant, side by side |
| One grant or several? | `plan_budget` | Funds the most newly protected businesses per dollar, never counting one twice |
| What does $8,000 actually change? | `grant_impact_scenarios` | Three stated scenarios and the condition that flips the answer |
| We fund A and B closes anyway? | `what_if_fails_anyway` | Overlap of the two cascades |
| Nobody at the far end applied. Should they have? | `screen_corridor` | Anchors that are not in the queue |
| A big employer is leaving | `simulate_employer_closure` | Forward along `DrawsFootfall`, then backward along `Supplies` |
| Whose neighborhood does this help? | `equity_audit` | Tract need and industry mix of the funded set against the corridor |
| Can I trust the data? | `data_health_check` | Duplicate keys, dangling links, graph depth |
| Any other lookup | `execute_sql_readonly` | Google's managed BigQuery MCP server |

## How it meets the requirements

| Requirement | Where |
|---|---|
| ADK agent, Gemini | `microgrants/agent.py`, model `gemini-3.8-flash` on Vertex AI |
| BigQuery property graph, genuinely traversed | `microgrants/data.py` (`walk`) and `microgrants/closure.py`. Quantified paths `{1,2}`, both directions, two edge types |
| A tool we built | Ten Python function tools in `tools.py`, `analysis.py`, `closure.py` |
| A managed MCP server, consumed | BigQuery's remote MCP server, read only tool, in `agent.py` |
| Deployed on Google Cloud | Cloud Run, one warm instance, `scripts/deploy.sh` |

## Decisions we made on purpose

- **Two hops, not three.** Three hops reaches most of the corridor and stops saying anything.
- **Path weight is the product of link intensities.** The weakest link is reported next to it.
- **We do not fund the biggest hub.** A business with over 80 reach is almost always the only
  local producer of an input, so the model hands it every buyer within 1,200 metres. Real buyers
  can order from outside the corridor. The agent prefers anchors with 10 to 50 reach, no local
  substitute, and a tract with higher need.
- **Substitutes discount a cascade.** A business with N same industry peers is assumed to strand
  1/(1+N) of its buyers. This is an assumption and the agent says so.
- **No invented numbers.** The data has no revenue, rent or distress signal. "What does the grant
  change" returns scenarios with stated assumptions, not a single figure.
- **Duplicates are flagged, not merged.** Two registrations of one business are shown as one.

## What is real and what is modeled

Real: businesses, addresses, industries, census tract demographics, employer block job counts,
SBA loans. Modeled: who supplies whom, and which workers shop where. The link types and their
industry average strengths are measured by the federal government; assigning them to specific
pairs of businesses is a modeling choice.

## What it cannot do

- Check itself against real failures. Only 4 SBA loans match this corridor and none were charged off.
- See distress. There is no revenue, rent or arrears data.
- Count jobs. No public source lists jobs per small business.
- See buyers that already order from outside the corridor.
- See industries the federal tables give few links to. Food service is 21% of businesses but 45%
  of businesses with any cascade. A business with no cascade is unseen, not unimportant.
- The applicant queue and requested amounts are a demo scenario. The registry has neither.

## Run it

```bash
cd agent
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp microgrants/.env.example microgrants/.env
gcloud auth application-default login
python server.py          # relief desk at http://localhost:8080, ADK UI at /dev-ui/
```

`adk web` also works from this folder if you only want the ADK developer UI.

## Test and deploy

```bash
pip install pytest && pytest -q        # 21 integration tests against the live dataset
bash ../scripts/deploy.sh              # Cloud Run, about 5 minutes
```

## Layout

```
microgrants/agent.py       the agent, its instructions, the MCP connection
microgrants/data.py        BigQuery client, corridor directory, the graph walk
microgrants/tools.py       cascade, dependencies, comparison
microgrants/analysis.py    budget split, scenarios, what if, screening, audits
microgrants/closure.py     employer closure, forward then backward
microgrants/applicants.py  the demo queue and budget
server.py                  one service: ADK API, JSON for the screen, the screen
web/                       the relief desk screen, plain ES modules, no build step
tests/                     edge case tests
```
