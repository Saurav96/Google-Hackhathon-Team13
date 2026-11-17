# Central Market relief desk

An ADK agent and an interactive Grant Memo that help a city grant officer decide which small businesses to fund, by showing what each closure would expose in a BigQuery property graph.

- **Challenge:** Agents for Impact 2026, Challenge 3, Community Economic Resilience and Micro-Grants
- **Track:** Main Street relief, plus the Anchor closure question
- **Corridor:** Central Market, San Francisco
- **Live:** https://grant-advisor-525982359170.us-central1.run.app
- **ADK developer UI:** the same address with `/dev-ui/` at the end

## The problem in three lines

1. A city has $50,000 and eleven applicants who ask for $127,500 in total.
2. Ranking applicants by distress treats them as eleven separate businesses.
3. Businesses hold each other up, so the right grant is the one that keeps the most neighbors supplied.

## What it does

The officer works in one screen. The Grant Memo is an interactive report on the left, about 70 percent of the width. The advisor chat sits on the right.

1. **The report opens on a computed draft.** No model call is needed to see it. The draft is four grants for $33,000, with 105 distinct businesses in modeled reach, and it is labeled as a draft.
2. **The officer edits it directly.** They change the budget, tick or untick applicants, and edit the text of any section. Totals, reach and the neighborhood audit follow the selection on screen. When the budget changes, the money left over updates by itself. The selected grants do not change by themselves: the report says they no longer fit, or that a better split exists, and offers it in one click.
3. **The officer explores the map.** Every dot is a real business at its real address. Clicking one shows what loses a supplier if it closes, two steps out. Links are clickable and say what they are.
4. **The officer asks the advisor.** Each question carries the report's revision, budget, selected grants and the section being discussed.
5. **The advisor proposes, the officer applies.** A new split or new wording appears inside the report as a proposal, with a before and after view for text. Nothing changes until "Apply changes". "Dismiss" leaves the report as it was. A proposal made against an older revision cannot be applied.
6. **Every change is a revision.** Any earlier revision can be restored, and restoring makes a new revision.
7. **Export matches the screen.** PDF and Markdown are built from the exact revision shown. If text is out of date, the export is marked as a draft.

The report has six sections: Recommendation, Impact, Alternatives, Scenarios, Neighborhood, and Evidence and limitations. The Alternatives section also lists strong businesses outside the applicant queue, drawn from all 229 businesses in the corridor. Sources and methodology open from a link in the top bar.

## Answers to the judges' questions

| Question | Answer |
|---|---|
| Which edges are real and which are modeled? | Bank loans are real records. Supply links and worker spending links are modeled. The link types and their industry average strengths are measured by the federal government. Assigning them to specific pairs of businesses is a modeling choice |
| Is the graph genuinely traversed? | Yes. See the three patterns below. Depth is a parameter, and the traversal runs forward, backward, and across two link types |
| Why two hops? | Three hops reaches most of the corridor and stops telling you anything. Two is the default, and the officer can switch to one or three |
| How is a path weighted? | By the product of the link intensities along it. The weakest link is reported next to it. An intensity of 0.011 means 1.1% of the buyer's input spending, not a 1.1% chance of failure |
| When does the agent not fund the biggest hub? | Whenever reach is the only argument. A business with over 80 reach is almost always the only local producer of an input, so the model gives it every buyer within 1,200 metres. Real buyers can order from outside the corridor |
| Did you validate the tables? | Yes. 979 supply links and 1,020 footfall links have unique keys. No link points at a missing business. No business supplies itself. Every business has a census tract |
| Did you run the equity audit? | Yes. Food service is 21.4% of businesses but 45.5% of businesses with any cascade. The four funded businesses sit in tracts averaging 22.8% poverty, against 22.3% for the corridor |
| What does the money actually do? | The data cannot say. So the advisor gives three stated scenarios and the condition that would flip the ranking, never one invented number |
| Why this interface? | The user is an internal grant officer who must defend a decision in a meeting. An editable, printable report with an advisor beside it fits that job better than a chat log |
| What can it not do? | See distress, count jobs, see buyers who already order from outside, or check itself against real local failures |

The traversal patterns, as they appear in the code:

```
-- What a closure exposes downstream (agent/microgrants/data.py)
MATCH p = (seed:Business WHERE seed.business_id = @id)-[e:Supplies]->{1,2}(other:Business)

-- What a business depends on, against the arrow (agent/microgrants/data.py)
MATCH p = (seed:Business WHERE seed.business_id = @id)<-[e:Supplies]-{1,2}(other:Business)

-- Anchor closure: forward along one link type, then backward along another (agent/microgrants/closure.py)
MATCH p = (emp:Employer WHERE emp.block_id = @id)-[f:DrawsFootfall]->(shop:Business)
          <-[s:Supplies]-{1,2}(supplier:Business)
```

## How it meets the requirements

| Requirement | Where |
|---|---|
| ADK agent | `google.adk` `Agent` in `agent/microgrants/agent.py`, served by ADK's own FastAPI app in `agent/server.py` |
| Gemini | `gemini-3.8-flash` on Vertex AI |
| BigQuery property graph, genuinely traversed | `a4i_econ.LocalEconomy`, with the three patterns above |
| At least one tool we built | Fifteen Python function tools, listed below |
| A managed MCP server, consumed | BigQuery's remote MCP server, limited to its read only query tool |
| Deployed on Google Cloud | Cloud Run, with one instance kept warm |

Tools we built: `find_business`, `get_applicant_queue`, `trace_cascade`, `trace_dependencies`, `compare_applicants`, `plan_budget`, `grant_impact_scenarios`, `what_if_fails_anyway`, `screen_corridor`, `list_employer_blocks`, `simulate_employer_closure`, `equity_audit`, `data_health_check`, `evaluate_selection`, `propose_report_edit`.

Beyond the requirements:

- Google Maps for the corridor map
- Cloud Storage for uploaded application documents, in a private bucket
- Gemini reads attached letters, photos and PDFs. Claims in a file are treated as the applicant's words, not as evidence
- Voice input and read aloud in the browser (Chrome and Edge)
- PDF and Markdown export of the report

## What we decided on purpose

- **Two hops, not three.** Three reaches most of the corridor.
- **Path weight is the product of intensities.** The weakest link is shown beside it.
- **Hubs over 80 reach are a weak signal.** The advisor prefers businesses with 10 to 50 reach, no local substitute, and a tract with higher need.
- **Substitutes discount a cascade.** A business with N same industry peers is assumed to strand 1/(1+N) of its buyers. This is an assumption, and the product says so.
- **Scenarios instead of invented numbers.** The data has no revenue, rent or distress signal.
- **The advisor proposes and the officer applies.** The advisor never changes the report itself.

## What is real and what is modeled

- **Real:** businesses, addresses and industries, from the City of San Francisco registry.
- **Real:** census tract demographics, employer block job counts, and SBA loan records.
- **Modeled:** who supplies whom, from federal industry purchase rates assigned to nearby pairs.
- **Modeled:** which workers spend where, from block job counts shared among nearby businesses.

## Limits

- The applicant queue and the requested amounts are demo inputs. The registry has neither.
- Only 4 SBA loans match this corridor and none were charged off, so there is no local ground truth.
- There is no jobs data per business and no distress data.
- Reach counts businesses with a modeled link. It is not a count of businesses saved.
- Reports and chats are saved in the browser only. There is no login and no sharing between devices.
- Grants are all or nothing at the requested amount.
- The budget split is a rule of thumb, not a proven best answer.
- A workplace block's position on the map is approximate to its census tract.

## What we improved in the data

The organizers split a block's workers equally among nearby businesses. Our data lane weights by distance, so nearer businesses get a larger share.

| Largest block, 4,416 jobs | Flat split | Distance weighted |
|---|---|---|
| Each of 9 storefronts | 490.6 workers | varies |
| Closest storefront, 189 m | 490.6 | 977.8 |
| Storefront at the edge, 431 m | 490.6 | 115.8 |

Across 75 storefronts, 17 gained and 27 lost more than 15 workers. These figures come from the data lane's analysis.

## Run, test, deploy

Full notes are in [agent/README.md](agent/README.md).

```bash
cd agent
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp microgrants/.env.example microgrants/.env
gcloud auth application-default login
python server.py          # relief desk at http://localhost:8080, ADK UI at /dev-ui/
```

```bash
pip install pytest && pytest -q        # 28 integration tests against the live dataset
node ui/tests/ui_test.mjs http://localhost:8080   # browser click through checks
bash ../scripts/deploy.sh              # builds the screen and deploys to Cloud Run
```

## Repository map

```
README.md             this page
TEMPLATE_README.md    the organizers' original challenge brief
TEAM_BRIEF.md         short summary of the challenge for the team
FLOW.md               how the solution works, end to end
PITCH.md              deck text, video script, demo checklist
agent/                the ADK agent, its tools, the server, the screen and the tests
scripts/deploy.sh     one command deploy to Cloud Run
scripts/load.sh       the organizers' data loader
notebooks/, data/     the organizers' notebook and federal purchase rate files
```

## Team

Add names and lanes here.
