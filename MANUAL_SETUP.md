# MANUAL SETUP

Steps the owner must do by hand. Append-only.

## 2026-10-13 — before the XRPL migration build can continue

1. **Free disk space on C:.** The drive is at 100% (about 137 MB free). `services/paywall` needs roughly 300 MB for `npm ci`, and the XRPL packages need more. The npm cache at `C:\Users\Admin\AppData\Local\npm-cache` holds 5.2 GB and can be emptied with `npm cache clean --force`.
2. **Make `*.t54.ai` reachable with a trusted certificate.** The Sophos firewall re-signs TLS for `xrpl-facilitator-testnet.t54.ai`, `xrpl-facilitator-mainnet.t54.ai` and `xrpl-x402.t54.ai`. Either exclude these hosts from HTTPS decryption, or export the Sophos root CA to a `.pem` file and point Node at it with `NODE_EXTRA_CA_CERTS`. Check with: `node -e "fetch('https://xrpl-facilitator-testnet.t54.ai/supported').then(r=>r.text()).then(console.log)"`.
3. **Choose the browser wallet** for ARCH-016: Xaman, GemWallet or Crossmark.

## 2026-10-13 — paywall on XRPL/RLUSD (ARCH-010, ARCH-011, ARCH-012)

Items 1 above (disk space) is done. Item 2 (`*.t54.ai` behind the Sophos certificate) is still open.

### Environment variables the paywall service reads (`services/paywall/src/config.ts`)

| Variable | Required | Default | What it is |
|---|---|---|---|
| `XRPL_NETWORK` | no | `testnet` | `testnet` or `mainnet`. Only that network's variables below are read and checked. |
| `XRPL_PAY_TO_TESTNET` / `XRPL_PAY_TO_MAINNET` | yes, for the chosen network | none | The XRPL classic address (`r...`) every route pays. Checksum-verified at start. Must not be the buyer account. |
| `RLUSD_ISSUER_TESTNET` | no | `rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV` | RLUSD issuer on TestNet. |
| `RLUSD_ISSUER_MAINNET` | yes on mainnet | none, on purpose | Copy it from Ripple's documentation at deploy time (spec section 3.4). |
| `XRPL_CAIP2_TESTNET` / `XRPL_CAIP2_MAINNET` | no | `xrpl:1` / `xrpl:0` | CAIP-2 network id. |
| `FACILITATOR_URL_TESTNET` / `FACILITATOR_URL_MAINNET` | no | `https://xrpl-facilitator-testnet.t54.ai` / `https://xrpl-facilitator-mainnet.t54.ai` | The t54 x402 facilitator. |
| `RLUSD_CURRENCY_CODE` | no | `524C555344000000000000000000000000000000` | 40 hex characters. |
| `XRPL_SOURCE_TAG` | no | `804681468` | Put on every quoted price; a 32-bit number. |
| `XRPL_MAX_TIMEOUT_SECONDS` | no | `600` | How long a quoted price and its invoice stay payable. |

Unchanged: `CHAINAIM_GATEWAY_KEY`, `GATEWAY_URL`, `PUBLIC_BASE_URL`, `PRICE_SCAN`, `PRICE_MASK`, `PRICE_CHAT`, `GATEWAY_TIMEOUT_MS`, `PORT`, `HOST`.

Retired, remove from Railway: `AVM_PAY_TO`, `X402_NETWORK`, `FACILITATOR_URL`.

### Environment variables only the scripts read (`services/paywall/scripts/xrpl.ts`) — never set on a service, never committed

| Variable | Required | Default | What it is |
|---|---|---|---|
| `XRPL_BUYER_SEED_TESTNET` / `XRPL_BUYER_SEED_MAINNET` | yes, to pay or to run `trust-line.ts` / `send-xrp.ts` | none | Family seed (`s...`) of the account that signs. Replaces `AVM_MNEMONIC`. |
| `XRPL_WS_URL_TESTNET` | no | `wss://s.altnet.rippletest.net:51233/` | XRPL WebSocket server. |
| `XRPL_WS_URL_MAINNET` | yes on mainnet | none | XRPL WebSocket server for MainNet. |

### Owner steps on TestNet (spec Stage 2 and Stage 3) — not done by the agent

1. Make two accounts, buyer and pay-to: `node scripts/new-account.ts` twice, in `services/paywall`. Save each seed in a password manager.
2. Fund both with TestNet XRP from the XRPL TestNet faucet: `https://xrpl.org/resources/dev-tools/xrp-faucets`.
3. Open an RLUSD trust line on each: put that account's seed in `XRPL_BUYER_SEED_TESTNET` and run `node scripts/trust-line.ts`.
4. Get TestNet RLUSD into the buyer account from Ripple's RLUSD TestNet faucet, `https://tryrlusd.com/` (the address Ripple's RLUSD developer documentation links to).
5. Set `XRPL_PAY_TO_TESTNET` on the paywall, start it, then run `node scripts/pay.ts --dry-run URL` and `node scripts/pay.ts URL '{"text":"..."}'` with the buyer seed. A settled payment here is the proof the agent could not produce (see STATE.md).

## 2026-10-13 — web page on Crossmark (ARCH-015, ARCH-016)

No new environment variable: `services/web` still reads only `PAYWALL_URL`, `PORT` and `HOST`.

1. Install the Crossmark browser extension (`https://crossmark.io`) and make or import a TestNet account in it. This is the buyer; do not use the pay-to account.
2. Fund it with TestNet XRP, open its RLUSD trust line and get TestNet RLUSD, as in the owner steps above.
3. Start the paywall and the web app, open the page, click **Connect Crossmark**, mask a message and press **Execute**. This is the first time the Crossmark path runs for real; the agent could only test it with a stand-in.
4. On Vercel, redeploy `services/web` so the new `public/wallet.js` and security headers go live.
5. Review the disclaimer sentence in `services/web/public/index.html` that now names "Ripple, the XRPL Foundation".

## 2026-10-21 — owner steps on TestNet: done (details in STATE.md, section of the same date)

- Item 2 of the first list (`*.t54.ai` behind Sophos): not needed on this PC's network; the facilitator answered `/supported` from the host and from `ca-paywall`.
- "Owner steps on TestNet" 1 to 5: done. payTo `rn5hSy7QvsrQLpGb3k5dp4h8Yrk9J7gBej`, buyer `rMosbGSCHTWnZmdgyhVETxSDRdPnormKxR`; both funded and with RLUSD trust lines. First settled payment: tx `E55B67292C6DAFE7CC07060477FA5E65E38DCFCE8257AD8B0D5590EF8BE8400A`.
- Step 2 (faucet): the web page did not fund an existing address; use the faucet API instead, one address at a time:
  `Invoke-RestMethod -Method Post -Uri https://faucet.altnet.rippletest.net/accounts -ContentType application/json -Body (@{destination='r...'; userAgent='xrpl.js'} | ConvertTo-Json)`
- Step 4 (RLUSD): tryrlusd.com sent RLUSD to the owner's own account; 1 RLUSD was then sent to the buyer from Crossmark (open the RLUSD token, then its Send, so the amount is RLUSD and not XRP).
- Entering a seed in PowerShell: use a standalone PowerShell window and paste with a right-click. In the VS Code terminal, or with Ctrl+V at a hidden prompt, the paste becomes one control character (one `*` at the prompt).
- Still to do: "web page on Crossmark" steps 1 to 5 (the page itself has not been run).

## 2026-10-23 — test rig (L0): three buyer tenants paying in a loop

New script-only variables (never set on a service, never committed), read by `services/paywall/scripts/rig.ts` through `scripts/xrpl.ts`: `XRPL_SEED_T01_TESTNET`, `XRPL_SEED_T02_TESTNET`, `XRPL_SEED_T03_TESTNET`, one family seed per tenant in `rig/tenants/`. `pay.ts` and `private-ask.ts` take `--seed-prefix XRPL_SEED_T01` to pay as one tenant.

Owner steps, in `services/paywall`, once per tenant (t01, t02, t03); none of them is done by the agent:
1. `node scripts/new-account.ts`: save the seed in the password manager and in the repository `.env` as `XRPL_SEED_T0n_TESTNET`. Each tenant needs its own account, separate from payTo and from the other tenants.
2. Fund the address with TestNet XRP through the faucet API (see 2026-10-21 above).
3. Open its RLUSD trust line: set `XRPL_BUYER_SEED_TESTNET` to that tenant's seed for this one command and run `node scripts/trust-line.ts`.
4. Send it RLUSD from the owner's Crossmark account (open the RLUSD token, then Send). The rig spends at most `--max-spend` (default 0.2 RLUSD) per tenant per run.
5. With the paywall running: `node scripts/rig.ts --url http://127.0.0.1:8080 --dry-run`, then `node scripts/rig.ts --url http://127.0.0.1:8080 --calls 10`. The pass for L0 is "settled 30 of 30" and 30 `payment_settled` lines from three payers in `docker logs ca-paywall`.

## 2026-10-23 — buyer agents (L1): Strands agents on Amazon Bedrock

New code: `services/paywall/scripts/agent.ts` (command line), `agent-core.ts` (tool, session, agent), `private-ask-core.ts` (masking/paying path shared with `private-ask.ts`). New dev dependencies: `@strands-agents/sdk` 1.20.0, `zod` 4.6.7. Tenant documents (synthetic): `rig/tenants/<id>/docs/`.

No new variable is read by this code. The agent's language model is Amazon Bedrock, reached with the AWS SDK's usual credential chain (`AWS_PROFILE`, or `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN`, or SSO). Never put AWS keys in `.env` or any committed file. Tenant seeds are the L0 ones (`XRPL_SEED_T0n_TESTNET`).

Owner steps, none done by the agent:
1. In `services/paywall`: `npm install` (adds the Strands SDK and zod), then `npm test`. The pass is 90 of 90.
2. AWS: an identity on this PC (profile or SSO) allowed `bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream` in the region passed to `--region` (default `us-east-1`). The agent's default model is the inference profile `global.anthropic.claude-sonnet-4-6`; if Bedrock answers AccessDenied or "model not found", open Bedrock in the AWS console for that region and enable access to the Anthropic model, or pass another model you have with `--model-id`.
3. Dry run (calls Bedrock, pays nothing, sends nothing to ChainAim): `node scripts/agent.ts --tenant t02 --dry-run --prompt "What does my discharge note say about follow-up?"`.
4. Paid run, stack up, on Wi-Fi (Sophos, see 2026-10-23 L0): `node scripts/agent.ts --tenant t02 --url http://127.0.0.1:8080 --prompt "What does my discharge note say about follow-up?"`. The pass is one `[chainaim_private_ask] discharge-note.txt: answered, 0.01 RLUSD, tx ...` line, the answer with the real names shown on screen, and one `payment_settled` line in `docker logs ca-paywall`. The paid chat needs the gateway's chat path to answer (the local `ca-openrouter-stub` or a real model).

## 2026-10-24 — M1: masking before the model (gateway)

No new environment variable. New gateway flags, all with defaults: `--extra-entities all`, `--residual-guard on`, `--residual-checks all`, `--residual-min-digits 9`. Needs the real Presidio running (`ca-presidio`); the Presidio image itself is unchanged (the new recognizers are sent with each request).

Owner steps, none done by the agent:
1. In `chainaim-router-private-ai-2`: `npm test`. The pass is `pass 292 fail 0`.
2. Rebuild the gateway image from this folder and recreate `ca-gateway` (same commands as in RUN-ON-ANOTHER-PC.md). Its start-up line must show `extra-entities=bank_account,titled_name,street_address,dob,location residual=digits,spaced_digits,intl_phone,email,titled_name/9`. If it stops with "did not detect X in the start-up test sentence", note X; restart with `--extra-entities` minus that group and report it.
3. With the stand-in model (`use-stand-in.cmd`), send the sample bank statement from the console's private chat. The pass is: the spy's "what left" view holds no name, account number or address from the statement, and the ledger line holds no value. A 422 naming kinds (for example `digits 1`) means masking missed a value and nothing was sent; report the kinds.

## 2026-10-24 — M1d: synthetic values in place of the real statement values

No new variable, flag or service. Owner steps, none done by the agent:
1. In `chainaim-router-private-ai-2` on Windows: `npm test`. The pass is `pass 296 fail 0`.
2. Rebuild the gateway image (`docker build -t chainaim-gateway:test -f services/gateway/Dockerfile .`) and `switch-models.ps1 -To ollama-cpu-8gb`. The pass is a gateway start-up with no "did not detect ... in the start-up test sentence" error (the canary now uses the synthetic account and name).
3. Commit the 7 files plus BUILD_LOG/STATE/MANUAL_SETUP, tag `v1.0.3`, `git push private2 main --tags` (never `origin`).
4. Decide whether to rewrite history so v1.0.2 and earlier commits no longer hold the real values (destructive: rewrites tags, needs a force push).

## 2026-10-24 — S1: rebuild the paywall with stack.ps1

No new variable. Owner steps, in PowerShell from the repository folder, Docker Desktop running:
1. `.\test-console\stack.ps1 -Check`: expect FAIL lines for ca-paywall (Algorand settings, quote 10000) and WARN "image source unknown" for the hand-built images. Nothing changes.
2. `.\test-console\stack.ps1 -Rebuild paywall`: builds `chainaim-paywall:test` from `services/paywall`, recreates `ca-paywall` on TestNet paying to `rn5hSy7QvsrQLpGb3k5dp4h8Yrk9J7gBej` (override with `-PayTo`). The pass is the check at the end showing `quotes 0.01 RLUSD for chat`, `quote network xrpl:1`, `pays to rn5h...`, and no FAIL for ca-paywall.
3. Restart the console (`node test-console\console\server.ts --models-file config\local-models.cpu.json`) and reload http://127.0.0.1:8730: the button reads "Send ($0.01)".

## 2026-10-24 — P2: TestNet RLUSD for a script buyer, without a browser wallet

No new environment variable. The seed is read from a file outside the repository with `--env-file` (example: `C:\PRIV-AI-SECRETS\testnet.env` holding `XRPL_SEED_B01_TESTNET=s...`, TestNet only). Owner steps, in `services/paywall`:
1. `npm test`: the pass is every test passing, including the 11 `buy-rlusd` tests.
2. New buyer wallet (if none): `node scripts\new-account.ts`; fund with the faucet API; `trust-line.ts` with the seed loaded for that one command.
3. Quote: `node scripts\buy-rlusd.ts --env-file C:/PRIV-AI-SECRETS/testnet.env --seed-prefix XRPL_SEED_B01 --amount 1 --max-xrp 5 --dry-run`.
4. Buy: the same command without `--dry-run`. The pass is `bought 1 RLUSD; transaction ...` and `RLUSD balance after: 1`.
- Balances (read-only, no seed): `node scripts\balances.ts --account buyer=racuvQQJSCD2YUxR5qLstLBfbCkxj53dcU --account seller=rn5hSy7QvsrQLpGb3k5dp4h8Yrk9J7gBej`, before and after a paid call.

## 2026-10-24 — R1: lenient restore and the end-to-end script

No new environment variable. New gateway flags (defaults on): `--restore-lenient on|off`, `--placeholder-instruction on|off`. The gateway source changed, so its image must be rebuilt. Owner steps:
1. Repo root: `npm test` (gateway); `services/paywall`: `npm test`. The pass is fail 0 in both.
2. `.\test-console\stack.ps1 -Rebuild gateway`, then `.\test-console\switch-models.ps1 -To ollama-cpu-8gb`; the start-up line shows `restore-lenient=on placeholder-instruction=on`.
3. In `services/paywall`: `node scripts\e2e-private-ask.ts --file ..\..\rig\tenants\t01\docs\supplier-dispute.txt --env-file C:/PRIV-AI-SECRETS/testnet.env --seed-prefix XRPL_SEED_B01`. The pass is `END-TO-END PASSED` (8 PASS lines), BEFORE/AFTER showing buyer -0.01 and seller +0.01 RLUSD. On Wi-Fi.
- Balances without typing addresses: `node scripts\balances.ts --title BEFORE --env-file C:/PRIV-AI-SECRETS/testnet.env --buyer-seed-prefix XRPL_SEED_B01 --seller-from-paywall http://127.0.0.1:8080`.
- stack.ps1 has no built-in pay-to address: pass -PayTo r..., or set XRPL_PAY_TO_TESTNET, or it keeps the running ca-paywall's.

## 2026-10-24 — H2 + X1 (owner, Windows PowerShell, from the repository folder)
1. `Remove-Item -Recurse -Force services\analyst\node_modules` (it holds Linux DuckDB files from the agent's test run; start-analyst.cmd reinstalls the Windows ones).
2. `npm test` (gateway, expect 327 pass) and `npm --prefix services\paywall test` and `npm --prefix services\analyst test` (after step 4 installs DuckDB; expect 32 pass).
3. `.\test-console\stack.ps1 -Rebuild gateway`, then `.\test-console\switch-models.ps1 -To ollama-cpu-8gb-hosted` (OpenRouter key at the hidden prompt; it is never written).
4. `test-console\start-analyst.cmd` (keep the window open).
5. `node test-console\console\server.ts --models-file config\local-models.cpu-hosted.json` -> http://127.0.0.1:8730, 02 Private chat: "Ask across files" with a data folder that holds 2+ CSV files.

## 2026-10-24 — ALL-1: one gateway with local + OpenRouter + Bedrock (owner, Windows PowerShell, repo folder)
Run the Docker stack from ONE clone only (this one): each clone's stack.ps1 / switch-models.ps1 replaces the same containers with its own gateway key.
1. `.\test-console\stack.ps1 -Rebuild gateway` and `.\test-console\stack.ps1 -Rebuild paywall`
2. `.\test-console\switch-models.ps1 -To ollama-cpu-8gb-all` - paste OPENROUTER_API_KEY, then BEDROCK_API_KEY, each with a RIGHT-CLICK at the hidden prompt.
3. Name a model to use it: local/qwen2.5-3b, hosted/nemotron-nano-reasoning, bedrock/nemotron-nano-3-30b (chainaim/auto stays local).
4. Console: `node test-console\console\server.ts --models-file config\local-models.cpu-all.json`


## CreditSeal sealed exchange — key passphrases (added 2026-10-28, DESIGN/xrplh-22)

Code that reads these: `services/lending/src/keys.ts` `readPassphrase()`, used by `scripts/keys.ts`, `scripts/facts.ts --seal-to`,
`scripts/decide.ts --sealed`, `scripts/open.ts`, `scripts/prove-isolation.ts`.

| Variable | Who sets it | What it is |
|---|---|---|
| `CREDITSEAL_KEY_PASSPHRASE` (default name; any name via `--passphrase-env`) | you, in the terminal session only | The passphrase that unlocks a party's key file (at least 12 characters). Never in a file in the repo, never on the command line. In the demo one terminal plays both parties, so one passphrase unlocks both key files; in production each party has its own. |
| `CREDITSEAL_PROVE_PASSPHRASE` | `prove-isolation.ts` itself, per run | A random passphrase for the proof's throwaway keys. Nothing to set. |
| `CREDITSEAL_TEST_PASSPHRASE` | `test/e2e-exchange.test.ts` itself | Test-only. Nothing to set. |

Set it for one PowerShell window (it disappears when the window closes):
```
$env:CREDITSEAL_KEY_PASSPHRASE = Read-Host "Key passphrase"
```
Back up the key files: an envelope sealed to a key can only be opened with that key file and its passphrase.
Recommended key folder outside the repo: `C:\PRIV-AI-SECRETS\creditseal-keys\` (pass it with `--keys-dir`).
Not built yet (DESIGN/xrplh-22 step 2): the lender's keys in AWS KMS (needs two KMS keys and an IAM role in ap-southeast-2).

## 2026-10-27 — LW1: ledger-watch (owner, Windows PowerShell)
Environment variables read by services/ledger-watch (values in your private env file, e.g. C:\PRIV-AI-SECRETS\creditseal-quicknode.env; never in the repo):
- `QUICKNODE_XRPL_WSS_TESTNET`, `QUICKNODE_XRPL_HTTP_TESTNET`: QuickNode XRPL Testnet endpoint URLs (token in the path).
- `XRPL_PAY_TO_TESTNET`: the paywall's pay-to address (public).
- `ADMIN_API_KEY`: 24+ random characters; the console sends it.
Steps (given one at a time in chat):
1. `cd services\ledger-watch`, `npm install`, `npm test` (expect 22/22), `npm run typecheck` (expect no output).
2. `cd ..\paywall`, `npm test` (unchanged count expected; confirms tenant.json "address" does not affect the rig).
3. Phase 4: QuickNode Testnet endpoint into the private env file, then the first live run.

## 2026-10-30 — SW1 Seller Wallet tile (owner; steps given one at a time in chat)
No new environment variable: the Seller Wallet is the existing `XRPL_PAY_TO_TESTNET` (role payto in ledger-watch).
1. `cd services\ledger-watch`, `npm test` (expect the earlier count + 6 SW tests), `npm run typecheck` (no output).
2. `cd ..\..\apps\admin-console`, `npm test` (+2 SW-CONSOLE tests), `npm run typecheck`, `npm run build`.
3. Restart ledger-watch with the same command and env file; the start-up log has a `seller wallet:` line.
4. Restart the console (`node --env-file=C:\PRIV-AI-SECRETS\ledger-watch.env scripts/console.ts --mode start`) and open http://127.0.0.1:8800: the first Live Ops tile reads SELLER WALLET.
5. One paid call from a tenant (`node scripts/rig.ts --only t01 --calls 1 ...` in services\paywall, seed loaded as before): the tile highlights with +0.01, received goes up, the balance follows from a validated-ledger read.
Wallets (config only, the console stays read-only):
- A buyer that pays from the rig: `rig/tenants/tNN/tenant.json` with its public `"address"` (its seed stays in `.env` as `XRPL_SEED_TNN_TESTNET`, read by the rig only).
- A buyer that pays from a wallet app (Crossmark) only: ledger-watch flag `--watch <label>=buyer=rADDRESS`.
- Create and fund: `services/paywall/scripts/new-account.ts` (address + seed), the Testnet faucet API, `trust-line.ts` (RLUSD line), RLUSD from Crossmark or `buy-rlusd.ts`. Then restart ledger-watch.

## 2026-10-30 — SW3 continuous live stream (owner; steps given one at a time in chat)
New secrets file (outside the repo, written by the script, never typed by hand): `C:\PRIV-AI-SECRETS\rig-devnet.env` with `XRPL_SEED_T01_DEVNET`, `XRPL_SEED_T02_DEVNET`, `XRPL_SEED_T03_DEVNET`. Also read: the lending secrets file (`LENDING_ISSUER_SEED_DEVNET`, `LENDING_CHAINAIM_SEED_DEVNET`; expected at `C:\PRIV-AI-SECRETS\lending-devnet.env`, `-LendingEnv` otherwise), `rig-testnet.env`, `ledger-watch.env`.
1. Stop any rig still paying (Ctrl+C in its windows): the stream pays from the same wallets, and two payers on one account race for its sequence numbers.
2. Tests: `services\ledger-watch` `npm test` (79) + `npm run typecheck`; `apps\admin-console` `npm test` (47) + `npm run typecheck` + `npm run build`; `services\paywall` `npm test` (earlier count + 10 STREAM tests).
3. Once: Devnet wallets for the tenants, in `services\paywall`: `node --env-file=C:\PRIV-AI-SECRETS\lending-devnet.env scripts/stream.ts setup-devnet --secrets-out C:\PRIV-AI-SECRETS\rig-devnet.env` (faucet-funded wallets, TUSD trust line, 5 TUSD from the issuer, `devnetAddress` written into rig\tenants\tNN\tenant.json).
4. From the repo root: `.\test-console\start-live.ps1 -RestartLedgerWatch -RestartConsole` (first time: the running ledger-watch and console are the old code). Later: `.\test-console\start-live.ps1` starts only what is missing.
5. Expected on http://127.0.0.1:8800 Live Ops: the RLUSD Seller Wallet row and a TUSD row ("TUSD · XRPL devnet · buyers pay chainaim") both rising every few seconds; buyer cards for RLUSD (testnet) and TUSD (devnet) with balances falling; the ledger tape filling with RLUSD and TUSD rows; "buyers watched 3 RLUSD · 3 TUSD". The stream window prints one line per payment (`x402 settled`, `direct settled`, `tusd settled`, `buy`, `mint`, `pause` with the reason).
Network: on the wired LAN (Sophos re-signs *.t54.ai) x402 cannot settle; with `-Mode auto` (default) the RLUSD lanes pay direct instead and try x402 again every 60 s. On the hotspot they pay x402.


## 2026-11-04 — NEAR USDC rail (DESIGN "design-plan - private-ai-NEAR"; owner; steps given one at a time in chat)
Nothing changes while `PAY_RAILS` is unset: the paywall stays RLUSD-only and reads no NEAR variable.
Dependencies changed in `services/paywall` (run `npm ci` there): `@x402/core`, `@x402/hono`, `@x402/extensions`, `@x402/xrpl` 2.27.0 → 2.29.0 (required by `@x402/near`), and new `@x402/near` 2.29.0, `@near-js/{crypto,providers,signers,transactions,utils}` 2.5.1, `borsh` 1.0.0. Rebuild the paywall image (`npm ci --omit=dev` picks them up).
Environment variables (names in `.env.example`; values in your private env file, never in the repo):
- Paywall: `PAY_RAILS` (`near` or `xrpl,near`), `NEAR_NETWORK`, `NEAR_PAY_TO_<NET>`, `NEAR_USDC_CONTRACT_<NET>`, `NEAR_USDC_DECIMALS_<NET>`, `NEAR_RPC_URL_<NET>` (+ optional `NEAR_RPC_FALLBACK_URL_<NET>`), and either `NEAR_FACILITATOR_URL_<NET>` or `NEAR_RELAYER_ACCOUNT_<NET>` + `NEAR_RELAYER_KEY_<NET>` (secret), optional `NEAR_MAX_GAS`.
- Buyer scripts: `NEAR_BUYER_ACCOUNT_<NET>`, `NEAR_BUYER_KEY_<NET>` (secret); rig tenants: `NEAR_KEY_T0N_<NET>` (secret) and `"near": {"accountId": "...", "keyEnv": "NEAR_KEY_T0N"}` in `rig/tenants/t0N/tenant.json`.
Third-party services: NEAR TestNet RPC (FastNEAR public by default, or your QuickNode NEAR TestNet HTTPS endpoint); Circle TestNet USDC on NEAR (faucet: faucet.circle.com).
Steps:
1. Tests: `services\paywall` `npm ci`, `npm test` (258: 221 before + 37 NEAR); `services\web` `npm test` (129: 105 + 7 + 17 for the web NEAR wallet).
2. TestNet accounts (wallet.near.org / MyNearWallet / `near-cli-rs`), each with a full-access key you export as `ed25519:...`:
   the pay-to account, a relayer account (holds some TestNet NEAR for gas, must differ from pay-to), and a buyer account.
3. Buyer gets TestNet USDC from faucet.circle.com (network: NEAR Testnet). The buyer needs no NEAR to pay; it needs a little NEAR for step 4.
4. Register the pay-to account with the USDC contract once: `node scripts/near-storage.ts --account <payTo> --dry-run`, then without `--dry-run`.
5. Start the paywall with `PAY_RAILS=near` (or `xrpl,near`). The start line shows `rails=... near=testnet nearPayTo=... usdc=...`; it stops with a clear message if the contract's decimals or the pay-to registration are wrong.
6. One paid call: `node scripts/near-pay.ts --dry-run http://127.0.0.1:8080/v1/privacy/scan`, then `node scripts/near-pay.ts http://127.0.0.1:8080/v1/chat/completions --body-file ask.json --max-amount 0.05`. Check the transaction on testnet.nearblocks.io and the `payment_settled` line (network `near:testnet`, asset = USDC contract, payer, transaction, invoiceId with the sink on).
7. Rig on NEAR: add the `"near"` entry to each tenant, fund each with USDC, then `node scripts/rig.ts --url http://127.0.0.1:8080 --rail near --calls 2`.
Web NEAR wallet (decided 2026-11-04: Intear Wallet; CSP changes in docs/NEAR-GATES.md, "Web wallet and CSP"):
- Dependencies added in `services/web` (run `npm ci` there; dev only, bundled into `public/near-wallet.js`): `@hot-labs/near-connect` 0.12.0, `@x402/near` 2.29.0, `@near-js/{crypto,signers,transactions}` 2.5.1. Rebuild after a change: `npm run build:near-wallet` (and `npm run build:wallet`, whose banner hash covers package.json).
- Environment variable (web service, and the Vercel project if it is deployed there; set it before `npm run build:vercel` too): `NEAR_WALLET=intear-wallet`.
- Third-party services the visitor's browser then contacts, only after choosing "USDC · NEAR" and pressing Connect: raw.githubusercontent.com (near-connect's wallet list) and wallet.intear.tech (Intear Wallet).
- Live check (the acceptance test; not done yet): one paid call from the page on TestNet.
  1. Paywall running with `PAY_RAILS=xrpl,near` and steps 2–5 above done; web started with `PAYWALL_URL` and `NEAR_WALLET=intear-wallet` (`services\web` `npm start`).
  2. Make an Intear Wallet TestNet account at wallet.intear.tech and get it TestNet USDC from faucet.circle.com (network: NEAR Testnet).
  3. Open the page, set "Pay with" to "USDC · NEAR", press "Connect Intear Wallet", sign in. The buyer chip shows the account.
  4. Mask the example and press Execute; approve the payment in Intear. The answer shows "Paid $… USDC · receipt", linking to testnet.nearblocks.io.
  5. Record here: the date, the account, the transaction hash, and the paywall's `payment_settled` line. If the paywall refuses with a validity-window error, record the reason it gave: Intear's `max_block_height` is longer than 600 blocks, and the page cannot pay with Intear until that is resolved.
  6. In the browser's developer console, check there is no "Content Security Policy" error while connecting and paying, and note any here.

## 2026-11-04 — Test console: pay in USDC on NEAR (owner, Windows PowerShell, from the repository folder)
The console (test-console/console, port 8730) gets a "Pay with USDC · NEAR" box next to "Pay with Crossmark", using services/web's NEAR bundle. Off unless the console is started with the flag; nothing changes for Crossmark.
- Flags (no environment variables): `--near-wallet intear-wallet` (only allowed value), optional `--near-wallet-bundle PATH` (default `services\web\public\near-wallet.js`; build it with `npm --prefix services/web run build:near-wallet`).
- The console page sends no Content-Security-Policy of its own (it never did), so no CSP change was made for it; see STATE.md.
- Third-party services the browser then contacts, only after ticking the box and pressing Send to connect: raw.githubusercontent.com (near-connect's wallet list) and wallet.intear.tech (Intear Wallet).
Live check (not done yet): one paid console chat on TestNet.
1. Paywall running with `PAY_RAILS=xrpl,near` and the NEAR rail steps above done (pay-to registered, relayer funded).
2. Start the console with the flag: `node test-console\console\server.ts --near-wallet intear-wallet` (or add `--near-wallet intear-wallet` to the command in `test-console\start-ui.ps1` / `start.cmd` for that run). The start line ends `NEAR wallet: intear-wallet`.
3. An Intear Wallet TestNet account with TestNet USDC (faucet.circle.com, network NEAR Testnet), as in the web check.
4. Open http://127.0.0.1:8730, tick "Pay with USDC · NEAR" (it unticks Crossmark). The line under it shows the price, network and pay-to account.
5. Press Send: Intear Wallet connects; press Send again and approve the payment in Intear. The answer shows "Paid … USDC on near:testnet · receipt", linking to testnet.nearblocks.io.
6. Record here: the date, the account, the transaction hash, the paywall's `payment_settled` line, and the console's `paid-chat` log line (status and `withPayment` only). Check the browser console for "Content Security Policy" errors, and note any. If the paywall refuses Intear's validity window (longer than 600 blocks), record its reason.

## 2026-11-05 — Paid jobs: tab 03 pay-after-quote in USDC on NEAR (architecture.md ARCH-101..115; owner, Windows PowerShell, from the repository folder)
Tab 03 ("Private Chat and AI (Across Files)") can run a job as a paid job: the job runs as today, the console meters every model call, computes ONE total, holds the result and shows only the total; Pay pays that exact amount in USDC on NEAR with Intear Wallet, and the result is shown only after the payment settled. Off unless both the paywall and the console are switched on; with both off nothing changes.

**Paywall environment variables** (in `.env` when run by hand; on `ca-paywall` add them as `-e NAME` in `test-console\stack.ps1` the way PAYMENT_LOG_URL / PAYMENT_LOG_KEY are passed, so the key is never on a command line) — owner step M4:
- `PAID_JOBS` = `on` (default `off`). Needs `PAY_RAILS=near` or `xrpl,near` and the NEAR rail steps above (pay-to registered, relayer funded).
- `PAID_JOBS_KEY` = a random key of at least 24 characters, shared with the console. Generate one: `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`. Never paste it into a chat.
- `PAID_JOBS_RESULT_URL` = the console's internal listener as the paywall reaches it, e.g. `http://host.docker.internal:8731` (container) or `http://127.0.0.1:8731` (paywall run by hand).
- `PAID_JOBS_TTL_SEC` (optional, default 900, 60..86400): the longest a job may stay payable; the console's `--job-ttl-min` must not exceed it.
- `PAID_JOBS_MAX` (optional, default 1000): most open jobs; beyond it registration answers 503.
- The start line then ends `paidJobs=on jobsResult=<scheme://host> jobsMax=… jobsTtlSec=…`.

**Console flags** (`node test-console\console\server.ts …`; with `--paid-jobs on` every fee flag is required and nothing is defaulted, ARCH-114):
- `--paid-jobs on --near-wallet intear-wallet`
- `--pricing-catalog config\catalog.bedrock.json` (or the catalog the gateway runs: model prices `pricing.inputPerM` / `outputPerM` per 1M tokens; OpenRouter `:free` models are priced 0; a model missing from it means no quote)
- `--fee-per-model-call-usd D`, `--fee-analyst-usd D`, `--margin-pct D`, `--min-price-usd D` (non-negative decimals; the owner chooses them)
- `--near-gas-fee-usd D`: derive it from the measured gas of one x402 NEAR payment on TestNet (2026-11-05, tx H3ZFsVY1zDSQKsL3dktYBcNHSLiE8GpR5JtytFLjnbqD): **0.000332587 NEAR** burnt per payment (3.772 TGas at 100,000,000 yoctoNEAR/gas), × your chosen NEAR/USD rate × your buffer. Example only, not a default: at 3.00 USD/NEAR and a 2× buffer, 0.000332587 × 3.00 × 2 = 0.001995522 → `--near-gas-fee-usd 0.002`. The relayer pays this gas; the buyer pays it back through this fee.
- Optional: `--jobs-internal-host` (default 127.0.0.1), `--jobs-internal-port` (default 8731), `--paid-jobs-key-env` (default PAID_JOBS_KEY), `--job-ttl-min` (default 15), `--job-max` (default 100).
- Environment: `PAID_JOBS_KEY` (same value as the paywall's) in the console's window: `$env:PAID_JOBS_KEY = "<the key>"` before starting it. Start-up stops, naming what is missing, when it is unset or shorter than 24 characters.
- The start lines then add `paid jobs on: internal listener http://127.0.0.1:8731 key from PAID_JOBS_KEY ttl 15 min max 100`.

**Owner checks (not done yet; record results in BUILD_LOG.md):**
- **M2** reachability: with the console running with `--paid-jobs on`, run `docker exec ca-paywall node -e "fetch('http://host.docker.internal:8731/internal/jobs/x').then(r=>console.log(r.status))"`. Expected `401` (no key; the listener answered). If it cannot connect, the listener's 127.0.0.1 is not reachable from Docker Desktop: start the console with `--jobs-internal-host` set to the host's Docker interface address (e.g. the vEthernet (WSL) IPv4 from `ipconfig`), set `PAID_JOBS_RESULT_URL` to that address, and repeat. Do not bind it to 0.0.0.0 on a shared network.
- **M1** Bedrock usage: one tab 03 run in mode `bedrock` with the answer model on Bedrock and `--paid-jobs on`: the console prints `"event":"job_quoted"` with `calls` ≥ 1. If instead the page says "no price for this job … no token usage", Bedrock's OpenAI-compatible endpoint returned no `usage` through the gateway: record it here; no job can be priced until it does.
- **M5** relayer balance: check `chainaim-relayer-seller.testnet` holds NEAR for gas (testnet.nearblocks.io) before M3.
- **M3 / ARCH-115** live run: Intear Wallet TestNet account with TestNet USDC (faucet.circle.com, NEAR Testnet). Open http://127.0.0.1:8730, tab 03, pick a dataset, tick "Pay with USDC · NEAR", press Ask: the page shows "Total cost … USDC (expires …)" and Pay. Press Pay and approve in Intear: the result appears in tab 03 as usual, with "Paid … · receipt" linking to testnet.nearblocks.io. Record: the total, the tx hash, that nearblocks shows exactly that USDC amount to NEAR_PAY_TO_TESTNET signed by the relayer, the paywall's `payment_settled` line for `POST /v1/jobs/<id>/release`, and that adminUI-NEAR near-watch shows the claim `matched`.
- Tab 03 with a domain-pack dataset ("Practice Management - Dental" queries) stays free: the pay box applies to the "Ask across files" path only.

## 2026-11-05 — Job feed and masking counts for the adminUI Jobs tab (chainaim-adminUI-NEAR architecture-adminui-jobs.md; owner)
Off unless switched on; with the flags off nothing changes.
- **Gateway (M-G):** add `--expose-entity-counts on` to the mode's gateway flags, then `test-console\stack.ps1 -Rebuild gateway` and `test-console\switch-models.ps1 -To ollama-cpu-8gb-all` (keys at the hidden prompts). Chat replies then carry `x-chainaim-entity-counts` (entity kind → count) and `x-chainaim-residual` (pass/refused): kinds and counts only. The start line ends ` expose-entity-counts=on`.
- **Paywall (M-P):** `test-console\stack.ps1 -Rebuild paywall` with the same `-PassEnv` list as on 2026-11-05. It always strips those two headers from public responses; nothing to configure.
- **Console (M-C):** add `--job-feed-url http://127.0.0.1:8790/ingest/job` (with `--paid-jobs on`). Environment: `NEAR_WATCH_INGEST_KEY`, the same value near-watch uses, at least 24 characters. Load it from `C:\PRIV-AI-SECRETS\near-watch.env` into the console's window by name; never paste the value. Optional: `--job-feed-key-env NAME` (default NEAR_WATCH_INGEST_KEY), `--job-feed-timeout-ms` (5000), `--job-feed-max-inflight` (20), `--job-expiry-check-sec` (30). The start lines then add `job feed on: http://127.0.0.1:8790/ingest/job  key from NEAR_WATCH_INGEST_KEY  expiry check every 30 s`. A failed post prints one `"event":"job_feed_failed"` line (job id and reason only) and never fails the job.
- **near-watch (M-W, adminUI repo):** stop the running near-watch and start it again from `chainaim-adminUI-NEAR\services\near-watch` with its usual flags plus `--watch relayer=relayer=chainaim-relayer-seller.testnet --gas-per-payment-near 0.000333`, e.g. `node --env-file=C:\PRIV-AI-SECRETS\near-watch.env src/main.ts --watch buyer1=buyer=chainaim-buyer-seller.testnet --watch relayer=relayer=chainaim-relayer-seller.testnet --gas-per-payment-near 0.000333`. (test-console\start-live.ps1 starts the XRPL ledger-watch, not near-watch.) This restart also picks up the 2026-11-04 read-ahead and late-match fixes.
- **M-UI / ARCH-211:** one paid and one unpaid tab 03 job, then open http://127.0.0.1:8800/#jobs. Record in both BUILD_LOGs: paid quoted → paid → released, with Bedrock models, tokens, masking counts, breakdown, reconcile `matched`, and the tx equal to the receipt. The unpaid job turns `expired` after its TTL and lost compute rises by its cost. With the relayer watched, there is no `low_gas` at the current balance.

## 2026-11-05 — Where the adminUI-NEAR checkout is, for the near-watch tests (privateAI-design-31 §4; owner)
The ARCH-205 tests (scripts/test/console-paid-jobs.test.ts, test-console/test/job-feed.test.ts) start the real near-watch from
the chainaim-adminUI-NEAR repository. They are not tied to one folder layout:
1. Copy `config\local\repos.example.json` to `config\local\repos.json` (git-ignored, per PC) and set `nearWatchDir` to the
   checkout's `services\near-watch` folder. A relative path is resolved from this repository's root (not the current folder);
   an absolute path also works. On the owner PC: `"../../BLK-LIVEOPS/BLK-NEAR/chainaim-adminUI-NEAR/services/near-watch"`
   (use / or \\ in JSON). Agree one layout with the team and the relative value is the same on every PC.
2. Or, for one PowerShell window: `$env:NEAR_WATCH_DIR = "<absolute path to services\near-watch>"` (wins over the file).
3. Neither set: the sibling folder `..\chainaim-adminUI-NEAR` is tried.
Not found: those tests are skipped and the run says where it looked, from which setting, and how to fix it; the rest of the
suite is unaffected. `$env:REQUIRE_NEAR_WATCH = "1"` makes them fail instead (release checks, CI). Keep the adminUI checkout
current (`git pull` there) when the job-feed contract changes.

## 2026-11-05 — One command for the desk: test-console\desk.ps1 (privateAI-design-31 §5; owner)
Starts or restarts everything with one settings file and prints one READY table. Replaces the hand-typed console flags, the
long stack.ps1 -PassEnv line and the separate adminUI launcher for daily use (start-ui.ps1 and stack.ps1 still work).
One time:
1. `config\local\repos.json` points at the adminUI checkout (nearWatchDir) — section above.
2. Secrets in `C:\PRIV-AI-SECRETS` (names only listed; never paste values): `paid-jobs.env` (PAID_JOBS, PAID_JOBS_KEY,
   PAID_JOBS_RESULT_URL=http://host.docker.internal:8731), `near-watch.env` (adminUI .env.example: ADMIN_API_KEY,
   NEAR_WATCH_INGEST_KEY, NEAR_PAY_TO_TESTNET = the paywall's NEAR pay-to), `near-testnet.env` (NEAR rail, as before).
3. The adminUI built once: `npm --prefix <adminUI>\services\near-watch install`, `npm --prefix <adminUI>\apps\admin-console install`,
   `npm --prefix <adminUI>\apps\admin-console run build`.
4. Copy `config\local\desk.example.json` to `config\local\desk.json` and set YOUR fees (text numbers) and watch accounts.
Daily: `.\test-console\desk.ps1` (start what is missing) or `-Restart` (clean restart of containers and every service);
`-Check` reports only; `-Stop` stops the services; `-Test` runs the terminal suites; `-RebuildPaywall` after changing
paid-jobs.env. Services run hidden; their logs are `test-console\runs\desk\<service>.log` (previous run `.prev`).
The console's model list follows the gateway's current set (config\generated\summary.json); switch models with
switch-models.ps1, then `desk.ps1 -Restart`.

## 2026-11-06 — Backend in Docker, UI on the PC (DOCKERIZE-PLAN.md; owner, Windows PowerShell, from the repository folder)
Everything below is new and optional: the old way (stack.ps1, switch-models.ps1, start-ui.ps1) is unchanged and still works. Every new flag defaults to today's behaviour.

**What runs where.** Docker (network `chainaim-test`, one `docker-compose.yml` at the repository root): ca-presidio, ca-gateway, ca-paywall (same names, images, aliases, ports and ledger volume as today), plus ca-analyst (127.0.0.1:8740), ca-chain-query (127.0.0.1:8750) and ca-console-api (127.0.0.1:8735; paid-jobs internal listener 8731 on the network only). The stand-in ca-openrouter-stub only with `-Test`. On the PC: the 8730 UI (`server.ts --mode ui`), which serves the page and the two wallet bundles and forwards everything else to 127.0.0.1:8735; it holds no key and reads no data.

**Files to have (outside the repository; values never printed):**
- `C:\PRIV-AI-SECRETS\near-testnet.env` (exists): the paywall's NEAR settings; up.ps1 uses the same allowlist as stack.ps1, so the buyer keys in it are ignored.
- `C:\PRIV-AI-SECRETS\paid-jobs.env` (exists): `PAID_JOBS_KEY`.
- `C:\PRIV-AI-SECRETS\near-watch.env` (exists): `NEAR_WATCH_INGEST_KEY`, used as the paywall's PAYMENT_LOG_KEY and the console's job-feed key (near-watch runs as ca-near-watch, alias near-watch, from chainaim-adminUI-NEAR).
- Paid-job prices: **none needed on a new PC.** Owner decision 2026-11-06: the team's shared prices are committed in `config\paid-jobs-prices.conf` (PRICING_CATALOG=config/generated/catalog.local.json, FEE_PER_MODEL_CALL_USD=0.001, FEE_ANALYST_USD=0.002, NEAR_GAS_FEE_USD=0.002, MARGIN_PCT=20, MIN_PRICE_USD=0.01) and up.ps1 uses them by default. Not a `.env` file on purpose: `.gitignore` ignores `*.env` (so `config\paid-jobs-settings.example.env` is not committed either). To use other prices on one PC, put a NAME=value file at `C:\PRIV-AI-SECRETS\paid-jobs-settings.env` (up.ps1 `-PaidJobsOverride`; it wins when present), or pass `-PaidJobsSettings <file>`. server.ts itself still defaults no fee (ARCH-114, its tests unchanged): the values reach it as flags. The catalog is generated by switch-models.ps1 (`config\generated\` is git-ignored), which a new PC runs once anyway because up.ps1 takes the gateway's mode from a running ca-gateway.
- `C:\PRIV-AI-SECRETS\chainaim.env` (optional): OPENROUTER_API_KEY / BEDROCK_API_KEY. When absent, up.ps1 keeps the ones the running ca-gateway holds (in memory only).
- The gateway key stays `test-console\local-gateway-key.txt`, mounted read-only as a compose secret.

**Steps:**
1. `.\test-console\up.ps1 -DryRun` — checks Docker, the files, the gateway's current model mode (taken from the running ca-gateway), the ports, and that compose accepts the configuration; writes `runtime\compose\commands.yml` (commands only, no secrets). Starts nothing. (Done 2026-11-06 with `-PaidJobs off`: all checks passed; with paid jobs on it stops at the missing paid-jobs-settings.env, as it should.)
2. Close the analyst, chain-query and console windows of start-ui.ps1 (ports 8740, 8750, 8730 must be free).
3. `.\test-console\up.ps1 -ReplaceRunning -Build` — stops ca-presidio, ca-gateway, ca-paywall (started by stack.ps1 / switch-models.ps1; volumes and images kept), starts the compose stack, waits for every service, then opens the UI window and the browser.
4. Check: `.\test-console\stack.ps1 -Check` (same container names; the images carry the chainaim.source label); one unpaid "Ask across files"; Blockchain queries; one paid chat in NEAR USDC; one paid tab 03 job released; `docker logs ca-paywall` shows `payment_settled`; the admin UI shows the job and a `matched` reconcile. Record the results in BUILD_LOG.md.
5. Stop: `.\test-console\down.ps1` (UI and compose stack; volumes kept). Back to the old way: DOCKERIZE-PLAN.md section 8 (`stack.ps1 -Rebuild paywall -NearEnvFile ...`, `switch-models.ps1 -To <mode>`, `start-ui.ps1`).

**Visible differences:** the folder picker shows `/data/priv-ai-data/...` and `/app/sample-data/...` instead of `C:\PRIV-AI-DATA\...` (same files, read-only). The ledger twisty reads the gateway's ledger volume (mounted read-only) instead of `docker exec`. Changing the gateway's model mode: `switch-models.ps1 -To <mode>` (it then owns ca-gateway again) and `up.ps1` takes the new mode the next time.
**Never** run `docker compose config` or `docker inspect` where others can see the output: both print the environment values. (`config -q`, which up.ps1 uses, prints nothing.)

## 2026-11-06 — Tab 03 agent mode: a programmatic wallet pays the paid job (architecture-tab03-agent-mode.md ARCH-301..314; owner, Windows PowerShell)
Optional and **off by default**: without `-Agent on` nothing starts or changes (no ca-agent, no `--agent-service`, no "Who pays?" choice).

**What it adds.** `ca-agent` (image `chainaim-agent:local`, compose profile `agent`, 127.0.0.1:8760, network alias `agent`): `services/paywall/scripts/agent-jobs.ts`. For each run it masks the typed question on this PC (Presidio at `presidio.railway.internal:3000`, fail closed), asks a Strands agent on Bedrock, which calls the one tool; the tool runs the job on ca-console-api (`/jobs/crossask`), pays `ca-paywall`'s `/v1/jobs/<id>/release` from the **tenant's** NEAR account (NEP-366 delegate signed with the tenant's key, submitted by ChainAim's relayer, so the account needs USDC only, no NEAR) and streams the steps and the released result to the page. The agent's model gets the status, amount, transaction and row count only, never the result. No spending limit in this build (`--agent-max-amount` unset).

**Variables and files (values are never printed or written by the scripts):**
- `C:\PRIV-AI-SECRETS\agent-tenants.env` (**new**, path = `up.ps1 -AgentEnvFile`): mounted read-only into ca-agent, read by Node's `--env-file`. Allowed names only: `NEAR_NETWORK` (testnet), optional `NEAR_RPC_URL_TESTNET`, optional `NEAR_USDC_CONTRACT_TESTNET`, and each tenant's key variable: `NEAR_BUYER_KEY_TESTNET` (t01), `NEAR_T02_KEY_TESTNET` (t02), `NEAR_T03_KEY_TESTNET` (t03), as named by `rig/tenants/<id>/tenant.json` `near.keyEnv` + `_TESTNET`. **Never** the relayer key: the agent refuses to start when any `NEAR_RELAYER_KEY_*` is in its environment.
- `AWS_BEARER_TOKEN_BEDROCK` (set by up.ps1 in its own process only, passed to ca-agent by name): the value of `BEDROCK_API_KEY` from `C:\PRIV-AI-SECRETS\chainaim.env`, or the one the running ca-gateway holds (on this PC `chainaim.env` does not exist, so it is taken from ca-gateway). The AWS SDK uses it as a Bedrock API key (bearer auth). It is in the container's environment, so `docker inspect ca-agent` shows it: never paste that output.
- `AGENT_ENV_FILE` (set by up.ps1 for compose: the path of the env file, not a secret).

**Checked by the build (2026-11-06):** V1 — Bedrock answered one Strands tool call from inside the agent image with the bearer token (`nvidia.nemotron-nano-3-30b`, ap-southeast-2, 4.0 s). V2 — the agent image's PromptScan against the running ca-presidio masked "Ravi Kumar" as `<C_PERSON_1>` and refused when Presidio was unreachable.

**Owner steps (one at a time; never paste a key, `docker inspect` or `docker compose config` output):**
- **M1** Check each tenant key is a **full-access** key of its account, with public keys only: `near account list-keys chainaim-buyer-seller.testnet network-config testnet now` (and `chainaim-t02-seller.testnet`, `chainaim-t03-seller.testnet`); compare with the public key of the key you hold. Do not run any command that exports or prints a private key. A function-call key cannot pay (ft_transfer needs 1 yoctoNEAR attached).
- **M2** Create `C:\PRIV-AI-SECRETS\agent-tenants.env` in Notepad with the lines `NEAR_NETWORK=testnet`, `NEAR_BUYER_KEY_TESTNET=`, `NEAR_T02_KEY_TESTNET=`, `NEAR_T03_KEY_TESTNET=` and copy the three values from `C:\PRIV-AI-SECRETS\near-testnet.env` (same names). Do not copy `NEAR_RELAYER_KEY_TESTNET`. Check names only: `Get-Content C:\PRIV-AI-SECRETS\agent-tenants.env | ForEach-Object { ($_ -split '=')[0] }`.
- **M3** Bedrock key: nothing to do while ca-gateway holds `BEDROCK_API_KEY` (up.ps1 prints `BEDROCK_API_KEY kept from the running ca-gateway`). Otherwise add `BEDROCK_API_KEY=` to `C:\PRIV-AI-SECRETS\chainaim.env`.
- **M4** Admin UI repo: add the tenant buyer lines to `config\near-watch-watch.conf` (`WATCH=t02=buyer=chainaim-t02-seller.testnet`, `WATCH=t03=buyer=chainaim-t03-seller.testnet`, and your manual Intear wallet account as another `buyer`), then `.\down.ps1; .\up.ps1` there. `.\up.ps1 -DryRun` prints the near-watch command first.
- **M5** `.\test-console\up.ps1 -Agent on -Build` (here) and report the `OK`/`READY` lines (`OK agent answers` among them). `-DryRun -Agent on` checks everything first and starts nothing.
- **M6** ARCH-314 live proof: in tab 03, one agent-paid job per tenant (t01, t02, t03) and one manual Intear job in the same session. For each: the timeline reaches `Done` and the result shows; nearblocks shows the quoted USDC from that tenant's account to `chainaim-payto-seller.testnet`, submitted by the relayer; `docker logs ca-paywall` has `payment_settled`; the admin UI Reconcile shows `matched` with the tenant as payer. Record the results in BUILD_LOG.md.

**Rollback:** `.\test-console\up.ps1` without `-Agent` (ca-agent is not started; the console has no `--agent-service`); `.\test-console\down.ps1` stops ca-agent too.

## 2026-11-06 — desk.ps1 is now the one command over BOTH Docker launchers (supersedes the 2026-11-05 desk.ps1 section)
`.\test-console\desk.ps1` checks, then runs the adminUI's `nearadminup.ps1` (near-watch in Docker + the 8800 admin UI) and
this repo's `test-console\up.ps1 -ReplaceRunning` (the compose stack + the 8730 page), then prints one READY table.
`-Stop` runs both `down.ps1`; `-Check` reports only; `-Test` runs the terminal suites; `-Build`, `-WithStub`, `-NoBrowser`.
It no longer starts services itself (that collided with the Docker stacks: same ports).
One time:
1. `config\local\repos.json` nearWatchDir -> the adminUI checkout's `services\near-watch` (section above).
2. `config\local\desk.json` from `desk.example.json`: secretsDir, paidJobs.enabled, adminUi.watch (YOUR buyer and relayer
   accounts; passed as nearadminup.ps1 -Watch, so its committed watch file with another PC's accounts is not used) and gasPerPaymentNear.
   Prices: test-console\up.ps1's own files (config\paid-jobs-prices.conf or <secretsDir>\paid-jobs-settings.env).
3. NEAR RPC (FastNEAR rate-limits when the paywall and near-watch share it): in `near-testnet.env` add
   `NEAR_RPC_URL_TESTNET=https://near-testnet.drpc.org`; in `near-watch.env` set `NEAR_RPC_FALLBACK_URL_TESTNET` to the same.
   Public URLs, but both files hold keys: edit in Notepad, never paste them. desk.ps1 tests the paywall's RPC from inside
   ca-paywall and says so in the table.

## 2026-11-06 — NEAR AI model + attestation (PLAN-private-ai-nearai-attestation.md): what is needed before the build can start (owner)
The build stopped at the plan's verify-first gate (section 4); nothing was changed in the product. Needed, one at a time:
- **M1 — `NEARAI_API_KEY`** (none exists on this PC). Create the key at cloud.near.ai, then put `NEARAI_API_KEY=...` in `C:\PRIV-AI-SECRETS\chainaim.env` in Notepad (the file does not exist yet; create it). Check names only: `Get-Content C:\PRIV-AI-SECRETS\chainaim.env | ForEach-Object { ($_ -split '=')[0] }`. Never paste the key in chat. It unblocks V1 (one chat completion), V2 (its signature) and V5.
- **M2 — credits** on the NEAR AI account (cloud.near.ai, Credits): V1 makes one small paid completion.
- **Approval to run the official verifier** (V3): `github.com/nearai/nearai-cloud-verifier` at commit `94554726fd548676842b7ea603a8173a60c31341` with its npm dependencies (`@phala/dcap-qvl-node`, `ethers` 5, `tweetnacl`, `ed2curve`), built and run inside a throwaway `node:24-slim` container. This session's permission policy refuses running external code until you allow it.
- **Decision — how the key is asked for.** `switch-models.ps1` stops ("No NAME entered, so nothing changed") when a `secretEnv` key is missing, so adding `NEARAI_API_KEY` to `test-console/modes/ollama-cpu-8gb-all.json` as the plan says would stop that mode on every PC without a NEAR AI key. Choose: (a) a new mode file (e.g. `ollama-cpu-8gb-all-nearai.json`) that asks for it, the current mode unchanged; or (b) an optional-key list in the mode file that switch-models.ps1 uses only when the key is present.
- **Decided 2026-11-06: (a).** Built: `config/local-models.cpu-all-nearai.json` (cpu-all's entries unchanged + `nearai/deepseek-v4.1-flash`) and `test-console/modes/ollama-cpu-8gb-all-nearai.json` (asks for `NEARAI_API_KEY`); `ollama-cpu-8gb-all` is unchanged. `NEARAI_API_KEY` is passed to ca-gateway by name (compose) and taken by up.ps1 from `chainaim.env` or the running ca-gateway, silently skipped when absent. Once M1/M2 are done: `.\test-console\switch-models.ps1 -To ollama-cpu-8gb-all-nearai`, then `.\test-console\up.ps1 -ReplaceRunning`. Still pending before tab 03 can rely on it: V1 (does NEAR AI accept the gateway's `provider` field, and does DeepSeek's reasoning fit the shared 2048-token output budget, ARCH-405), the B part (attestation) after V2/V3.

## 2026-11-06 — NEAR AI attestation, ca-attest (ARCH-409/410): one-time setup (owner)
ca-attest (`services/attest`, compose service `attest`, profile `attest`, container `ca-attest`, 127.0.0.1:8770) reads
**`NEARAI_API_KEY`** (by name, the same key as the gateway; `--key-env` to change the name) and calls: NEAR AI
(`GET /v1/attestation/report`, `GET /v1/signature/{chat id}`), Intel PCS (`api.trustedservices.intel.com`, TDX collateral)
and NVIDIA NRAS (`nras.attestation.nvidia.com`, GPU evidence), all from inside the container. The image builds the official
`nearai-cloud-verifier` at commit `94554726fd548676842b7ea603a8173a60c31341` with OUR lockfile. Decision 2026-11-06 (option a):
no RTMR3 event-log replay is added; ca-attest relies on the official verifier's checks.
One time, in order:
1. **Lockfile.** From the repository root (writes `services\attest\verifier\package-lock.json`; runs the verifier's npm
   resolution in a throwaway container, nothing installed on the PC):
   `docker run --rm -v "${PWD}\services\attest\verifier:/out" node:24-slim sh -c "apt-get update -qq && apt-get install -y -qq git >/dev/null && git clone -q https://github.com/nearai/nearai-cloud-verifier.git /v && cd /v && git checkout -q 94554726fd548676842b7ea603a8173a60c31341 && npm install --package-lock-only --no-audit --no-fund && cp package-lock.json /out/"`
   Commit the lockfile: the image refuses to build without it (`npm ci`).
2. **Fixture** (one real call, a fraction of a cent of NEAR AI credit; the prompt and answer are not saved):
   `node --env-file=C:\PRIV-AI-SECRETS\chainaim.env services/attest/scripts/record-fixture.ts` -> `services/attest/test/fixtures/nearai-recorded.json`. Commit it (public evidence: quotes, addresses, hashes, the signature). Before the image: the image copies `test/` in.
3. **Image.** `docker compose --profile attest build attest`.
4. **Tests.** `npm --prefix services/attest test` (on the PC) and, in the image (needs no key),
   `docker compose --profile attest run --rm --entrypoint npm attest run test:official`.
Rollback: do not start the `attest` profile; nothing else depends on it until ARCH-411 (`--attest-url`, off by default).

## Receipt signing key (privateAI-design-32 ARCH-614, added 2026-11-10)

`packages/receipt` (`signerFromEnv`) reads the console's Ed25519 receipt signing key from the environment variable named
by `--receipt-key-env` (default `RECEIPT_SIGNING_KEY`): a PKCS#8 PEM private key, newlines written as `\n` on one line.

Updated 2026-11-10 (step 3c): the key is made and wired by the desk. One time, from the repository root:

1. `.\test-console\desk.ps1 -ReceiptKey` — runs `scripts\receipt-key.ts`, which writes `RECEIPT_SIGNING_KEY` into
   `<secretsDir>\chainaim.env` (secretsDir from `config\local\desk.json`, default `C:\PRIV-AI-SECRETS`; every other line
   of the file is kept). It prints `OK ... created`, a `KEY ID` (32 hex characters) and the PUBLIC key, never the private
   key. The public key is safe to share (verifiers need it). Running it again keeps the key (`already present and valid`).
   `-ReceiptKeyRotate` replaces it: receipts signed before then verify only with the old public key.
2. `.\test-console\desk.ps1 -All` — up.ps1 finds the key (by name, value never printed), passes it to ca-console-api as
   `RECEIPT_SIGNING_KEY` (compose, by name), and starts the console with `--receipts=on --receipt-dir=/receipts`; receipts
   are kept on the Docker volume `chainaim-console-receipts`. The READY table shows `receipts OK`.

Switches: `desk.ps1 -Receipts` (or `receipts.enabled` "on" in desk.json) requires receipts and stops when the key is
missing; "off" turns them off; "auto" (default) turns them on only when the key exists. `-ReceiptKeyName` changes the
name in chainaim.env (inside the container it is always `RECEIPT_SIGNING_KEY`).
Never open chainaim.env in a shared screen or paste it: it holds this key and the model keys.

## PAID_JOBS_CLOCK_SKEW_SEC (paywall, optional, added 2026-11-10)

Nothing to do: the default (30) is right. The console registers each paid job with expiresAt = its own clock +
`--job-ttl-min` (15 min), and the paywall accepted at most its own clock + `PAID_JOBS_TTL_SEC` (900 s), with no margin,
so a console clock slightly ahead of the paywall's refused every paid job (owner test runs 2026-11-10). The paywall now
allows `PAID_JOBS_CLOCK_SKEW_SEC` seconds of difference (0 to 300; 0 = the old strict check). Set it in the paywall's
environment only if the console and paywall run on machines whose clocks differ by more than that.
