# Pitch Kit: Deck Text and Video Script

For the story lane. Everything here is checked against the live system. Adjust slide titles to match the organizers' template, which must stay at exactly 6 slides.

Live demo: https://grant-advisor-525982359170.us-central1.run.app

## One line pitch

We run relief funding for San Francisco's Central Market corridor. We have $50,000 and eleven applicants. Our agent shows which grant protects the most neighbors, and it says what it is assuming.

## The 6 slides

### Slide 1: Title

- Central Market relief desk
- An agent that builds a case, not a score
- Track: Main Street relief, plus the Anchor closure question

### Slide 2: The problem

- A city has $50,000 and eleven applicants asking for $127,500.
- Ranking by distress treats eleven businesses as eleven separate things.
- Businesses hold each other up. One closure can hurt dozens that never applied.
- Our user is the grant officer who must defend the decision in a meeting on Friday.

### Slide 3: Our team

Fill in from the template: names, roles, and lanes (data, agent, front end, story).

### Slide 4: What we built

- An ADK agent on Gemini, deployed on Cloud Run, with a custom screen for the officer.
- A BigQuery property graph of 229 real businesses, 979 supply links, 122 employer blocks, and 1,020 footfall links.
- Ten tools we wrote. The core one runs a real two step graph traversal, in both directions, over two link types.
- Google's managed BigQuery MCP server for simple lookups.
- Output: a seven section Grant Memo the officer can print.

### Slide 5: What we found

- The biggest cascade is the wrong grant. Three applicants reach 146 to 191 businesses, but each is the only local producer of its input, so the model hands it every nearby buyer. Real buyers can order from outside the corridor.
- The agent funds four targeted anchors for $33,000 and protects 105 distinct businesses, with $17,000 held back. Its first pick is Speed Queen Coin Laundry at $8,000: 39 businesses exposed, no local substitute, in a tract with 27.8% poverty against 22.3% for the corridor.
- 37 of those 39 exposed businesses never applied. The queue cannot see them. The graph can.
- When the largest office block (4,158 workers) leaves, 12 businesses lose customers and 38 suppliers behind them are hurt. 44 of those 50 never applied.

### Slide 6: What we are honest about, and what comes next

- Real: businesses, addresses, census need, job counts, bank loans. Modeled: who supplies whom, and which workers shop where.
- A bias we found in our own output: food service is 21% of businesses but 45% of businesses with any cascade. A business with no cascade is unseen by the model, not unimportant.
- No ground truth: only 4 SBA loans match this corridor and none failed.
- A grant changes a probability, not an outcome. The agent gives scenarios, never one invented number.
- Next: an intake agent that asks owners who they really buy from, and writes those links into the graph.

## Video script, about 2 minutes 45 seconds

**0:00, on the title slide.**
"A hardware store closes. On paper that is one business and four jobs. In reality the lumber supplier, three contractors and the lunch counter are now in trouble too, and none of them applied for help. We built the tool that can see that."

**0:20, open the live link.**
"This is the Central Market relief desk. Our user is a city grant officer with $50,000 and eleven applicants. Every dot is a real registered business at its real location."

**0:35, click Sour Flour in the queue.**
"The obvious pick is the biggest cascade. Sour Flour reaches 146 businesses. But our agent flags it. It is the only bakery in the corridor, so the model gives it every nearby buyer. Real restaurants can order bread from anywhere. A big number, but a weak case."

**0:55, click Speed Queen Coin Laundry.**
"Here is what it recommends. If Speed Queen closes, 39 businesses lose a supplier, two steps out. This is a real graph traversal in BigQuery, not a join. No other business here does the same work. And 37 of the 39 never applied."

**1:20, click "Use the advisor's split".**
"One grant or several? The agent splits the money so it never pays twice to protect the same business. Four grants, $33,000, 105 distinct businesses protected, and $17,000 held back."

**1:40, open the Grant memo tab and click "Write the memo for the queue". Let the steps appear.**
"Now the memo. You can watch each tool the agent uses: it reads the queue, walks the graph for every applicant, splits the budget, and works out what the grant changes. It ends with who to fund, what it protects, why not the runner up, and who lives in that neighborhood."

**2:05, switch to "A large employer leaves" and click the top block.**
"Now the hard case. An office block with 4,158 workers is leaving. Nobody has applied. The agent walks forward to the 12 businesses that lose customers, then backward to the 38 suppliers behind them. Those suppliers are nowhere near the office."

**2:25, open the Evidence tab.**
"We are honest about the evidence. Businesses, census data and loans are real. The supply links are modeled from federal purchase rates. We found a bias in our own output: restaurants are 21% of businesses but 45% of cascades. And a grant changes a probability, not an outcome, so the agent shows its assumptions."

**2:45, close.**
"A case, not a score. Something a grant officer can take into a meeting and defend."

## Numbers agreed with the data lane

- **Food service share: 21.4% of businesses** (industry codes starting with 722), against 45.5% of businesses with any cascade. Use 21.4% everywhere.
- **We improved the footfall edge generator.** The organizers split a block's workers equally among nearby businesses. The data lane weights by distance, so nearer businesses get more. For the largest block (4,416 jobs), the flat split gave each of 9 storefronts 490.6 workers. With distance weighting, the closest (189 m) rises to 977.8 and one at the edge (431 m) falls to 115.8. Across 75 storefronts, 17 gained and 27 lost more than 15 workers. These figures come from the data lane's analysis.

## What changed in the product since the first draft

- The Grant Memo is now an interactive report the officer edits, with the advisor on the left.
- The advisor proposes changes (a new split, or new wording with a before and after view). The officer applies or dismisses them.
- Every change is a revision that can be restored. Exports (PDF and Markdown) match the exact revision on screen.
- Links on the map are clickable and say what they are: supply or worker spending, direction, and units.

## Answers to the questions judges look for

| Question | Our answer |
|---|---|
| Which edges are real and which are modeled? | Loans are real. Supply and footfall links are modeled from federal rates, assigned to nearby pairs |
| Is the graph genuinely traversed? | Yes. Quantified paths of 1 to 2 hops, forward and backward, over two link types |
| When does the agent not fund the biggest hub? | Always, on reach alone. Hubs over 80 reach are flagged as a weak signal |
| Why two hops? | Three hops reaches most of the corridor and stops telling you anything |
| How is a path weighted? | Product of link intensities, with the weakest link shown beside it |
| Did you validate the tables? | Yes. Unique keys on 979 supply and 1,020 footfall links, no dangling links, no self loops |
| Did you run the equity audit? | Yes. Funded tracts average 22.8% poverty against 22.3%, and we report the food service bias |
| Why this interface? | The user is internal, a grant officer. A map and a printable memo fit that job better than a chat log |
| What can it not do? | See distress, count jobs, or check itself against real failures |
