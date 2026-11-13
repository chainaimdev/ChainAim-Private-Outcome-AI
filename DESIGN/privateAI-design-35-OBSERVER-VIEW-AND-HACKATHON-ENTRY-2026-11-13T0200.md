# privateAI-design-35: observer view, query-cap flag, judge path, refusal scene (ARCH-650 to ARCH-653)

Chat near-ai-impl-8, 2026-11-13 ~02:00Z. Status: BUILT (ARCH-650..653), see §5. Owner request 2026-11-13 01:48Z:
"Please proceed from A to F" (the Entry A plan in DESIGN-REF/near-hackathon-session-2026-11-13-entry-a.md §5, kept
local). Source of the observer idea: Wraps (XRPL hackathon, github.com/hrishabhayush/wraps), its "spy bot" that shows
what an observer learns from x402 payments (chat "ref privacy projects-1").

## 1. Why

Outcome AI protects a job's content: data de-identified before any model, numbers computed, every NEAR AI call
attested, a signed receipt. It does not hide the payment: one USDC transfer on NEAR per job, so the payer's account, the
amount and the time are public. A Privacy-track entry that leaves this unsaid overclaims. ARCH-650 states it on tab 03
and shows it with the job's own transaction, read the way any outsider would read it.

## 2. ARCH-650 observer view

| Part | File | What |
|---|---|---|
| Decoder + RPC client | packages/observer (src/index.ts; moved from test-console/console/observer.ts so scripts/observe-receipt.ts may import it: check-deps) | `decodePayment(raw)`: NEP-366 meta transaction (relayer signs; Delegate {sender = payer, receiver = token, ft_transfer}) or a direct ft_transfer; refuses a transaction moving another account's tokens than the receipt's payer (409), one with no ft_transfer (502). `observe(settlement)`: RPC `tx` {tx_hash, sender_account_id: payer, wait_until FINAL} on each URL in order (UNKNOWN_TRANSACTION -> next, an archival node by default), then `block` for the time |
| Route | server.ts `GET /jobs/<id>/observer` | needs --receipts on (the settlement is read from the signed receipt) and --observer on (default); 404 before the receipt, 409 before the settlement, ObserverError status otherwise |
| Flags | server.ts | `--observer on\|off` (on), `--observer-rpc-testnet` (rpc.testnet.fastnear.com), `--observer-rpc-fallback-testnet` (archival-rpc.testnet.near.org; `none`), same two for mainnet, `--observer-timeout-ms` (15000), `--observer-token-decimals` (6) |
| Page | paid-jobs.html `observerPanel` | after both paid releases (Me and AI agent): the line "Your content stays private: … Only the payment is on NEAR, like any transfer: who paid, how much and when.", a "What the chain shows" button -> table (paid by, relayer, paid to, amount, when, token, memo, transaction link) and "Not on the chain: the question; the data files and their rows; the query and the computed result; the answer; which models ran". Text only, no innerHTML |
| /jobs/config | server.ts | adds `observer: true\|false` |

What is sent to the RPC: the transaction hash and the payer account, both already public. No key, no job id, no content.

Checked live 2026-11-13 ~01:55Z: `observe()` on the recorded payment H3ZFsVY1… (testnet): fastnear had dropped it,
archival-rpc answered: relayer chainaim-relayer-seller.testnet, payer chainaim-buyer-seller.testnet, pay-to
chainaim-payto-seller.testnet, 0.01 USDC, block 276202563 at 2026-11-04T13:44:28Z. RPC `tx` accepts the payer as
sender_account_id (shard routing only) as well as the relayer.

Tests: packages/observer/test/observer.test.ts (9: decode, flags, RPC order) and test-console/test/observer.test.ts (2: page and route guards) (11 together: decode on the recorded transaction, direct transfer, failure, wrong payer,
not a payment, decimals, flags, URL order and fallback, 404/502, page and route guards);
scripts/test/console-paid-jobs.test.ts ARCH-615 test: the real console with a local JSON-RPC server answering the
recorded transaction: 404 before release, no RPC call before a settlement, then 409 (the recorded payer is not the
receipt's t02.testnet) with exactly one `tx` call carrying only the hash and payer.

## 3. ARCH-651 query-cap flag on the desk (item C)

`-CrossaskMaxPromptChars N` on up.ps1 / desk.ps1 (default 16000; was the console's 40000 default) passed to the console
as `--crossask-max-prompt-chars`. A free question's quote prices its query calls at this cap, so nearai free questions go
from about 0.06 to about 0.04 USDC, under t01/t02's 0.05 auto-approve. A larger folder whose prompt needs more is refused
before the run with the existing "prompt too large" error (fit-prompt drops rows from the end; never silently cut).

## 4. ARCH-652 judge path, ARCH-653 refusal scene

ARCH-652: README "Judges: check it without keys" (tests, a receipt verified offline, the public chain read).
ARCH-653: DEMO.md "Refusal scene": a quote above the agent's per-job cap is refused by the agent before any payment
(policy check `max_per_job`); nothing is paid, nothing runs.

## 5. Status

| Item | Status |
|---|---|
| ARCH-650 observer view | built, tests pass in the VM (observer 11/11; console-paid-jobs 31 + 1 skip) |
| ARCH-651 desk flag | built; desk.test +1; price effect to be seen live (MANUAL_SETUP 2026-11-13 step 3) |
| ARCH-652 README judge path | built: scripts/observe-receipt.ts (+2 tests), docs/judge/sample-receipt-2026-11-13T0214Z.json, both commands OK on the sample; judge test command 471/471 |
| ARCH-653 refusal scene + video script | written: docs/judge/demo-script-2026-11-13T0230Z.md; Scene 2 to be run by the owner (step 4) |

Full VM run: 741 = 740 pass + 1 skip, 0 fail.

Not done here (Entry A §6, after the hackathon): gateway in a TEE with a client measurement check, provable no-logs,
buyer-side AP2 mandate, on-chain spending policy, blind-token credits.
