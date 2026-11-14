# tommy-hilfiger-europe (buyer tenant, synthetic sample data)

**Synthetic test data, invented for this demo.** It is not Tommy Hilfiger's data: no real prices, budgets, policies or
accounts, and no affiliation with or endorsement by Tommy Hilfiger is implied. The name only sets the scene of the demo.

The buyer tenant's private data for `tommyBuyerAgent` and `TommyTreasuryAgent` (src/buyer.ts).

| File | What |
|---|---|
| `purchase-requisitions.json` | per RFQ: SKU, quantity, Tommy's private maximum price (cents/unit, DAP Los Angeles), concession per round |
| `buyer-policy.json` | approval limits (agent up to $100,000, CPO up to $250,000, as the NEAR mandates in Signatory) and a cash safety threshold |
| `treasury-ledger.json` | cash and committed purchase orders |

The maximum prices are the same values Signatory's rule buyer used (buyerSim, T01-T08 and S01-S10), so a quote run with
the OutcomeAI buyer ends exactly like one with the rule buyer. Answers say whether a price is within budget, never the budget.
