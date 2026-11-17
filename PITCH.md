# Pitch kit: deck text and video script

For the story lane. Adjust slide titles to match the organizers' template, which must stay at exactly 6 slides. The video must be under 3 minutes.

Live demo: https://grant-advisor-525982359170.us-central1.run.app

## One line pitch

We run relief funding for San Francisco's Central Market corridor. We have $50,000 and eleven applicants. Our agent shows which grants keep the most neighbors supplied, and it says what it is assuming.

## The 6 slides

### Slide 1: Title

- Central Market relief desk
- An agent that builds a case, not a score
- Track: Main Street relief, plus the Anchor closure question

### Slide 2: The problem

- A city has $50,000 and eleven applicants asking for $127,500.
- Ranking by distress treats eleven businesses as eleven separate things.
- Businesses hold each other up. One closure can hurt dozens that are outside the applicant queue.
- Our user is the grant officer who must defend the decision in a meeting on Friday.

### Slide 3: Our team

Fill in from the template: names, roles, and lanes (data, agent, front end, story).

### Slide 4: What we built

- An interactive Grant Memo. The report is the main workspace, and the officer edits the budget, the grants and the text directly.
- An ADK agent on Gemini sits beside it as an advisor. It proposes changes. The officer applies or dismisses them. Every change is a revision that can be restored.
- A BigQuery property graph of 229 real businesses, 979 supply links, 122 employer blocks, and 1,020 footfall links.
- Fifteen tools we wrote. The core ones run a real two step graph traversal, forward and backward, over two link types.
- Google's managed BigQuery MCP server for simple lookups. Deployed on Cloud Run.
- Export to PDF and Markdown, built from the exact revision on screen.

### Slide 5: What we found

- The biggest cascade is the wrong grant. Three applicants reach 146 to 191 businesses, but each is the only local producer of its input, so the model hands it every nearby buyer. Real buyers can order from outside the corridor.
- The computed draft funds four targeted anchors for $33,000, with 105 distinct businesses in modeled reach and $17,000 unallocated. Its first pick is Speed Queen Coin Laundry at $8,000: 39 businesses in modeled reach, no local substitute, in a tract with 27.8% poverty against 22.3% for the corridor.
- 37 of those 39 businesses are outside the demo applicant queue. The queue cannot see them. The graph can.
- When the largest office block (4,158 workers) leaves, 12 businesses lose customers and 38 suppliers behind them are exposed. 44 of those 50 are outside the demo applicant queue.
- Ask for a $20,000 budget and the advisor proposes two grants for $14,000. The officer reviews it before anything changes.

### Slide 6: What we are honest about, and what comes next

- Real: businesses, addresses, census need, job counts, bank loans. Modeled: who supplies whom, and which workers spend where.
- A bias we found in our own output: food service is 21.4% of businesses but 45.5% of businesses with any cascade. A business with no cascade is unseen by the model, not unimportant.
- No ground truth: only 4 SBA loans match this corridor and none were charged off.
- Reach is not a count of businesses saved. A grant changes a probability, not an outcome. The agent gives scenarios, never one invented number.
- Next: an intake agent that asks owners who they really buy from, and writes those links into the graph.

## Video script, about 2 minutes 45 seconds

The screen has the report on the left and the advisor on the right.

**0:00, on the title slide.**
"A hardware store closes. On paper that is one business. In reality its supplier, three contractors and the lunch counter are now in trouble too, and none of them asked for help. We built the tool that can see that."

**0:15, open the live link. Stay on the Recommendation section.**
"This is the Central Market relief desk. Our user is a city grant officer with $50,000 and eleven applicants. The Grant Memo is an interactive report. It opens on a computed draft: four grants, $33,000, and 105 distinct businesses in modeled reach."

**0:35, click Alternatives in the section row.**
"The obvious pick is the biggest cascade. Tradespace reaches 191 businesses. We do not fund it. It is the only business of its kind here, so the model gives it every nearby buyer. Real buyers can order from outside the corridor. A big number, but a weak case."

**0:55, scroll up. Click Speed Queen Coin Laundry in the table. Let the map draw. Click one supply line.**
"Here is the first pick. If Speed Queen closes, 39 businesses lose a supplier, two steps out. This is a real graph traversal in BigQuery, not a join. I can click any link. This one is a supply link, supplier to buyer, about 1% of the buyer's input spending, and it is labeled as modeled. 37 of the 39 are outside the applicant queue."

**1:20, type in the advisor: "Recalculate the split for a 20,000 dollar budget." Wait for the proposal card.**
"Now I ask the advisor for a smaller budget. It does not change my report. It proposes two grants for $14,000, and I review it. I click Apply changes, and the whole report updates as a new revision."

**1:45, type: "Make the recommendation clearer for the committee." Wait for the before and after card. Click Apply changes.**
"I can also ask it to rewrite the text. I see the wording before and after. The numbers stay the same. Every change is a revision I can restore."

**2:05, click Employer closure. Click the first workplace block.**
"Now the hard case. A large employer is leaving and nobody has applied. The agent walks forward to the businesses that lose worker spending, then backward to the suppliers behind them. Those suppliers are nowhere near the employer." Read the two numbers from the headline on screen.

**2:25, click Sources and methodology in the top bar.**
"We are honest about the evidence. Businesses, census data and loans are real. The links are modeled from federal purchase rates. We found a bias in our own output: food service is 21.4% of businesses but 45.5% of cascades."

**2:38, close the drawer. Click Export, then PDF report.**
"And I export exactly the revision I approved, as a PDF for the meeting. A case, not a score."

## Latest screen changes to know before recording

- The report is on the left and the advisor is on the right. "Hide advisor" in the top bar gives the report the full width.
- The revision number is on the "Revisions" button in the top bar. The report title shows only a state: Draft, Current, Needs update, or Review changes.
- Click the budget number to change it. If the selected grants no longer fit, a notice appears with "Fit the split to $X". If a better split exists, the notice offers "Update the split".
- The Alternatives section lists strong businesses outside the queue, taken from all 229 businesses.
- Menus close when you click anywhere else.
- The exported PDF is now the full Grant Memo. It has the grants with addresses, the named chains for each grant, why each other applicant was not selected, the scenario table, the neighborhood charts, and the limits. A sample is in `docs/samples/`.
- The report has a one line intro under the title, and the chat welcome says it covers all 229 businesses, not only the 11 applicants.
- Read numbers off the live screen while recording. The data lane changed the footfall weights, so employer closure figures can differ from older notes.

## Click by click demo checklist

1. Open the live link in Chrome. Wait until the map shows dots.
2. Read the four numbers in Recommendation: Budget $50,000, Proposed $33,000, Unallocated $17,000, Modeled reach 105.
3. Click "Alternatives" in the section row. Point at the three hubs and the reason text.
4. Scroll back to the table. Click "Speed Queen Coin Laundry Inc".
5. In the Impact section, wait for the map and the card. Point at 16, 23 and 37 on the card.
6. Click one solid line near Speed Queen. Read the supply link card. Close it.
7. In the advisor, send: "Recalculate the split for a 20,000 dollar budget."
8. When the proposal card appears in Recommendation, click "Apply changes".
9. Send: "Make the recommendation clearer for the committee." Show the before and after card, then click "Apply changes".
10. Click "Employer closure", then the first workplace block. Scroll to the map.
11. Click "Sources and methodology". Scroll once. Press Escape.
12. Click "Export", then "PDF report". Open the downloaded file.

## Before recording

- Open "Revisions" and click "Start a new report", so the demo starts from the draft.
- Click "New chat" in the advisor, so the chat is empty.
- Use light mode. The map is easier to read.
- Close other tabs and turn off notifications.
- Do one full practice run with a timer. Advisor answers take 7 to 15 seconds each.
- Keep a screenshot of each step, in case the live version misbehaves.
- If a proposal card does not appear, ask again with the words "propose the split".

## Numbers agreed with the data lane

- **Food service share: 21.4% of businesses** (industry codes starting with 722), against 45.5% of businesses with any cascade. Use 21.4% everywhere.
- **We improved the footfall edge generator.** The organizers split a block's workers equally among nearby businesses. The data lane weights by distance, so nearer businesses get more. For the largest block (4,416 jobs), the flat split gave each of 9 storefronts 490.6 workers. With distance weighting, the closest (189 m) rises to 977.8 and one at the edge (431 m) falls to 115.8. Across 75 storefronts, 17 gained and 27 lost more than 15 workers. These figures come from the data lane's analysis.

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
| What does the money do? | The data cannot say, so we show three stated scenarios and what would flip the ranking |
| Why this interface? | The user is internal, a grant officer. An editable, printable report with an advisor beside it fits that job better than a chat log |
| What can it not do? | See distress, count jobs, or check itself against real local failures |
