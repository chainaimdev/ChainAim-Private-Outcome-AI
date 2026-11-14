# Jupiter Knitting: quote-agents dataset (synthetic)

privateAI-design-44 §3.2 / OA-1. Read by `services/quote-agents` (`--data-root sample-data/quote`), as of 2026-11-16.

Synthetic test data. The design names a "pack" generated in a chat session as the source; that pack is not in either
repository, so this set was written on 2026-11-14 to the design's §5 rules and calibrated so the treasury prices give the
companion design's T01, T02, T03 and T08 figures (SIGNATORY-quote-flow-design-01.md §7): landed 352.5c for 20,000
units → 415c at 15%, 384c at 8%; 18,000 → 411c at 13.5%; 30,000 standard + express sea → 413c at 12%. The other
scenarios (T04-T07) are decided by Signatory's flow and are not pinned by this data.

| File | What |
|---|---|
| `products.json` | SKUs, grade, unit cost (never leaves the service), units per 40HC, production lead days and capacity |
| `inventory-lots.json` | lots: FREE / WIP stock and lots allocated to other customers (TIER2 = Sales Officer, TIER1 = CEO) |
| `sailings.json` | INMAA → USLAX sailings, standard and express, rate per 40HC |
| `air.json` | air option: transit, clearance, cents per unit, units per shipment |
| `customers.json` | buyer credit limits and open receivables |
| `treasury-ledger.json` | cash, credit line headroom, receivables and payables with due dates |
| `business-policy.json` | target margin, overhead, customs / drayage / inland days, QC days, reallocation premiums, advance lever |

**Catalogue (10 SKUs, 15 lots).** Fabrics: `FAB-COT-180-A/B`, `FAB-JERSEY-140-A/B`, `FAB-COT-220-A`, `FAB-PC-160-A`,
`FAB-LIN-150-A`, `FAB-RIB-200-A`. Garments (`uom: PIECE`): `GAR-TSHIRT-CREW-A` (crew-neck T-shirt), `GAR-SAREE-COT-A`
(cotton saree). The 7 SKUs after the first three were added on 2026-11-14 as sample data: costs, units per 40HC, lead
times and capacities are illustrative, not market prices. Grade alternatives are offered within a family only, so the
added SKUs do not change any answer for the first three. Fabric units are not yet defined (metre or kg: open).
