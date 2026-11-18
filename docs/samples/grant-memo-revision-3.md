# Relief funding recommendation

Interactive Grant Memo, revision 3, November 18, 2026.

## 1. Recommendation

- Budget: $50,000
- Proposed: $33,000 across 4 grants
- Unallocated: $17,000
- Distinct businesses in modeled reach: 105

Propose 4 grants totaling $33,000. Their modeled reach includes 105 distinct businesses. These estimates do not guarantee survival.

| Business | Address | Role | Proposed grant | Newly in modeled reach |
|---|---|---|---|---|
| Speed Queen Coin Laundry Inc | 118 6th St | Target Anchor | $8,000 | 39 |
| Steel + Lacquer | 14 10th St | Target Anchor | $6,000 | 23 |
| Microbiz | 444 Jessie St | Target Anchor | $10,000 | 35 |
| Chico's Pizza | 131 6th St | Target Anchor | $9,000 | 8 |

## 2. What each grant protects, and the traversal

**Speed Queen Coin Laundry Inc.** 39 businesses within two steps (16 direct). 37 are outside the demo applicant queue. Same industry peers in the corridor: 0.

- Speed Queen Coin Laundry Inc → Chico's Pizza (1 step, 1.12% of buyer input spending)
- Speed Queen Coin Laundry Inc → Miss Saigon LLC (1 step, 1.12% of buyer input spending)
- Speed Queen Coin Laundry Inc → The Pawn Shop (1 step, 1.12% of buyer input spending)
- Speed Queen Coin Laundry Inc → The Pawn Shop → Sunnyside Hotel (2 steps, 0.04% of buyer input spending)
- Speed Queen Coin Laundry Inc → Square Pie Guys → Yotel Hotel (2 steps, 0.04% of buyer input spending)

**Steel + Lacquer.** 23 businesses within two steps (10 direct). 23 are outside the demo applicant queue. Same industry peers in the corridor: 0.

- Steel + Lacquer → The Function (1 step, 1.12% of buyer input spending)
- Steel + Lacquer → Starbucks Coffee #6937 (1 step, 1.12% of buyer input spending)
- Steel + Lacquer → The Barbary Coast Pastry And Coffee (1 step, 1.12% of buyer input spending)
- Steel + Lacquer → Starbucks Coffee #6937 → Ram's Hotel (2 steps, 0.04% of buyer input spending)
- Steel + Lacquer → The Barbary Coast Pastry And Coffee → Richmond Area Multi-Services, Inc. Caap (2 steps, 0.03% of buyer input spending)

**Microbiz.** 43 businesses within two steps (16 direct). 39 are outside the demo applicant queue. Same industry peers in the corridor: 1.

- Microbiz → Blue Bottle Coffee LLC (1 step, 1.12% of buyer input spending)
- Microbiz → The Melt (1 step, 1.12% of buyer input spending)
- Microbiz → Honeybee Foods Corporation (1 step, 1.12% of buyer input spending)
- Microbiz → 54 Mint-Winebar → Hampton Inn San Francisco Downtown Convention Center (2 steps, 0.04% of buyer input spending)
- Microbiz → Honeybee Foods Corporation → Warfield Hotel Inc (2 steps, 0.04% of buyer input spending)

**Chico's Pizza.** 16 businesses within two steps (8 direct). 15 are outside the demo applicant queue. Same industry peers in the corridor: 28.

- Chico's Pizza → Sunnyside Hotel (1 step, 3.56% of buyer input spending)
- Chico's Pizza → San Francisco Health Care (1 step, 3.49% of buyer input spending)
- Chico's Pizza → Replica Ai, Inc. → Tradespace (2 steps, 0.03% of buyer input spending)
- Chico's Pizza → Replica Ai, Inc. → 415 Ebikes (2 steps, 0.02% of buyer input spending)

## 3. Why not the others

| Business | Reach | Same industry peers | Requested | Why it is not selected |
|---|---|---|---|---|
| Sour Flour | 146 | 0 | $15,000 | Ubiquitous Hub. It is the only local producer of its input, so the model gives it every nearby buyer. A weak signal. |
| Cumaica Coffee | 146 | 0 | $12,000 | Ubiquitous Hub. It is the only local producer of its input, so the model gives it every nearby buyer. A weak signal. |
| Tradespace | 191 | 0 | $25,000 | Ubiquitous Hub. It is the only local producer of its input, so the model gives it every nearby buyer. A weak signal. |
| Laz Parking California, LLC | 39 | 14 | $20,000 | Asks $20,000 with $17,000 left. Would add 8 businesses to reach. |
| The Bite | 2 | 28 | $7,500 | Would add 0 businesses to reach. 28 same industry peers could absorb its buyers. |
| Mo'z Cafe Inc | 0 | 0 | $10,000 | No modeled downstream links. The graph cannot argue for it. It needs a human case. |
| The Vita Brevis Club | 0 | 0 | $5,000 | No modeled downstream links. The graph cannot argue for it. It needs a human case. |

## 4. What the grant changes: Speed Queen Coin Laundry Inc, $8,000

| If we assume | Closure risk without a grant | Grant cuts the risk by | Businesses shielded | Cost per business |
|---|---|---|---|---|
| Cautious | 20% | 15% | 1.2 | $6,838 |
| Central | 40% | 30% | 4.7 | $1,709 |
| Optimistic | 60% | 50% | 11.7 | $684 |

Closure risk and the effect of a grant are assumptions, not data. The registry has no revenue, rent, arrears or distress signal for any business.

Per dollar, Speed Queen Coin Laundry Inc shields 1.27 times as many businesses as Steel + Lacquer. The ranking flips only if Steel + Lacquer is more than 1.27 times as likely to be saved by its grant.

## 5. Who the neighborhood is

- Funded tracts average 22.8% poverty, against 22.3% for the corridor.
- Households with no vehicle: 74.1% in funded tracts, against 67.7% for the corridor.
- Model bias: food service is 21.4% of businesses but 45.5% of businesses with any modeled cascade.

## 6. Evidence and limitations

- Public records: business identity and address, census tract demographics, employer block job counts, SBA loan records.
- Modeled: supply links (federal industry purchase rates assigned to nearby pairs) and worker spending links (block job counts shared among nearby businesses, nearer ones weighted more).
- Scenario inputs: the applicant queue, the requested amounts and the budget are demo inputs, not registry data.
- Reach counts businesses with a modeled link to a funded business. It is not a count of businesses saved.
- No revenue, rent, jobs per business or distress data exists. A grant changes a probability, not an outcome.
- Only 4 SBA loans match this corridor and none were charged off, so results cannot be checked against real failures.
