# Team Brief: Challenge 03, Micro-Grants

A short version of the README for the whole team. Read this first. It takes 3 minutes.

**Hard deadline: 4:59 PM today.** Late submissions are not accepted.

## Team decisions

Update this table when something is decided, so everyone sees the same answer.

| Item | Decision |
|---|---|
| Team name | To be decided |
| Track | Main Street relief (proposed) |
| Corridor | Central Market, San Francisco (proposed) |
| Team repo | To be added |
| Google Cloud project ID | To be added |
| Live demo link | To be added |

## The problem in four lines

1. A city has a small relief fund, for example $50,000, and many struggling businesses.
2. The usual method is to fund the businesses in the most trouble.
3. That misses how businesses depend on each other. If a coffee roaster closes, the cafes that buy from it suffer, and then the event hall those cafes serve suffers too. This chain is called a **cascade**.
4. The better choice is to fund the business whose survival protects the most others.

## What we build

An AI agent for a city grant officer. The officer asks questions and gets back a **Grant Memo** that says:

- Which business to fund, and how much
- Which other businesses this protects, by name
- The chain of links that proves it, shown and not only described
- Why this business and not the second best choice
- What we are assuming, because a grant improves the odds and does not guarantee survival
- Which parts of the evidence are estimated
- Who lives in the neighborhood where the money lands

The motto from the organizers is "Build a case, not a score."

## Must haves

If one of these is missing, we lose most of the technical score.

| Requirement | What it means |
|---|---|
| ADK agent in Python | The agent is built with Google's Agent Development Kit |
| Gemini | The model that reasons and writes the memo |
| BigQuery property graph | Businesses are dots and relationships are arrows. The agent must follow the arrows at least two steps. A normal JOIN does not count |
| One tool we write ourselves | For example, "find the cascade for this business" |
| One managed MCP server | BigQuery's built in server, or MCP Toolbox for Databases |
| Deployed on Google Cloud | Cloud Run or Agent Runtime. It must run online |

## The data

One street area in San Francisco. Central Market has 230 businesses, and 86 of them have a cascade two steps deep.

Six tables in the BigQuery dataset `a4i_econ`:

| Table | What it holds | Real or estimated |
|---|---|---|
| `businesses` | Name, address, industry | Real |
| `employer_blocks` | City blocks with worker counts | Real |
| `supplies` | Which business supplies which | Estimated from national industry averages |
| `draws_footfall_from` | Which workers shop at which business | Estimated |
| `borrowed_from` | Bank loans, including failed ones | Real |
| `tract_demographics` | Poverty and need by neighborhood | Real |

We must say clearly in the deck and video which parts are estimated. Judges check this.

To load everything, run this in Cloud Shell from the repo root:

```bash
bash scripts/load.sh central-market
```

## The three tracks

We pick one and say which one early in the pitch.

| Track | Situation |
|---|---|
| Main Street relief | Businesses have applied. We choose who gets the money |
| Micro-producer | Nobody has applied. We find the hidden supplier that others depend on |
| Anchor closure | A big employer is leaving in 90 days. We find who will be hurt |

## How we are judged

| Area | Points | The question |
|---|---|---|
| Impact and insight | 30 | Would a real grant officer use this? |
| Technical execution | 30 | Does it work, and does it really follow the graph? |
| Rigor and judgment | 25 | Are we honest about limits and bias? |
| Craft and communication | 15 | Are the pitch and demo clear? |
| Bonus | 10 | Extra technology that truly helps the solution |

Judges only see what we submit. There is no live Q&A, so every answer must be in the deck or the video.

## Mistakes to avoid

- **Always funding the most connected business.** It may be the strongest one and not need help. Judges ask when our agent does not fund the biggest hub.
- **Following the arrows three steps.** That reaches 200 of 230 businesses and tells us nothing. Two steps is better.
- **Hiding weak points.** Judges reward teams that state their limits.
- **Ignoring the bias.** The estimated data favors restaurants over service businesses such as barbers. Finding and reporting this earns points.
- **Using Spanner Graph docs by mistake.** They look the same but differ. Check that the doc link contains `/bigquery/`.

## Suggested lanes for five people

| Lane | People | Main job |
|---|---|---|
| Data | 1 | Load the tables, create the property graph, write the cascade query |
| Agent | 2 | ADK agent, tools, prompt, MCP connection, deployment |
| Front end | 1 | Start with `adk web`, improve if time allows |
| Story | 1 | Deck, Grant Memo example, video, limits and bias notes |

Each lane works on its own git branch to avoid conflicts.

## What we submit by 4:59 PM

- GitHub repo link
- Google Cloud lab project link
- Live demo link
- A deck of exactly 6 slides, using the organizers' template, with the Our Team slide filled in
- A pitch video under 3 minutes

Submit here: http://goo.gle/A4I-Submission

## Suggested timeline

| Time | Goal |
|---|---|
| By 11:00 | Data loaded and property graph created |
| By 12:30 | Agent answers one cascade question locally |
| By 2:30 | Agent deployed, Grant Memo output working |
| By 3:30 | Bias check done, deck drafted |
| By 4:15 | Video recorded |
| By 4:45 | Everything submitted, with time to spare |

## Links

- Organizers' template repo: https://github.com/haggman/A4I2026-challenge-3-micro-grants
- Pitch deck template: https://docs.google.com/presentation/d/1VJc_4cI7rMvN7t_nZaoysAl3TeZ9oMhkt4itl28V5mU/edit
- BigQuery Graph introduction: https://docs.cloud.google.com/bigquery/docs/graph-overview
- ADK documentation: https://adk.dev/
- MCP Toolbox for Databases: https://github.com/googleapis/mcp-toolbox
