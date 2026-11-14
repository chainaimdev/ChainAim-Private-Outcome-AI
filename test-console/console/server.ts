/**
 * Local test console for the ChainAim stack running in Docker on this PC.
 * Serves one page and forwards its calls: scan, mask and chat to the gateway
 * (adding the local test key), unpaid calls to the paywall (to show the 402),
 * the spy stand-in's record of what left, the last ledger lines, and the
 * gateway's model list with this console's default model (the page's pick list).
 *
 *   node server.ts [--default-model ID] [--models-file PATH] [--port N] [--gateway URL] [--paywall URL] [--spy URL]
 *
 *   --default-model ID  model the pick list starts on until you pick another
 *                       (default: defaultModel in --models-file; chainaim/auto = let the gateway rank)
 *   --models-file PATH  local model registry       (default ../../config/local-models.json, from this folder)
 *   --generated-summary PATH  output budget of the last local-model switch (default ../../config/generated/summary.json)
 *   --port N            console port                (default 8730)
 *   --gateway URL       gateway                     (default http://127.0.0.1:8720)
 *   --paywall URL       paywall                     (default http://127.0.0.1:8080)
 *   --spy URL           stand-in's record           (default http://127.0.0.1:5004)
 *   --view-max N        HTML pages from answers kept in memory for "Open page" links (default 20; oldest dropped first)
 *   --view-ttl-min N    minutes a page link stays valid  (default 60)
 *   --view-max-bytes N  largest page accepted         (default 1000000)
 *   --view-script-src S space-separated https origins a page may load scripts and styles from
 *                       (default "https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com")
 *
 *   --data-config PATH  data folders the page may browse and read (default ../../config/data-sources.json):
 *                       allowedRoots, defaultFolder, defaultMode (whole|pick), extensions, maxBytes, exclude, maxFiles,
 *                       hideFolders (folder-name patterns never listed; default ["_*"], which hides the analyst's
 *                       work folder). Re-read on every call.
 *   --chain-query URL   chain-query for the "Blockchain queries" twisty (default http://127.0.0.1:8750; services/chain-query,
 *                       started as ca-chain-query by up.ps1 / desk.ps1; read-only, no keys). GET /chain/<chains|vaults|loan-terms|export> only.
 *   --analyst URL       the analyst for "03 Private chat + analysis" (default http://127.0.0.1:8740; services/analyst,
 *                       started as ca-analyst by up.ps1 / desk.ps1). Only its known routes are forwarded, as JSON.
 *   Ask across files ("Ask across files" box on the chat tab): POST /crossask {folder, question, model?, answerModel?, phrase?, sql?}
 *   runs packages/crossask here: the analyst finds how the folder's CSV/TSV files relate, the model
 *   (through the gateway, with the local key) writes one SELECT from the headers only, the analyst runs it, and with
 *   phrase "llm" the model words the answer from the result (masked by the gateway).
 *   --crossask-timeout-sec N   per call to the analyst or the gateway (default 300)
 *   --crossask-sql-retries N   times the model may fix a failed query (default 1)
 *   --crossask-answer-rows N   result rows sent for the worded answer (default 50)
 *   --crossask-max-prompt-chars N  text of one query request at most (default 40000; the gateway refuses over 48,000 characters
 *                              with the JSON keys counted): older failed attempts are left out first (crossask fitPrompt)
 *   --crossask-answer-max-prompt-chars N  text of the worded-answer request at most (default 8000): result rows are left
 *                              out from the end until the question and the rows fit (crossask); estimate-first offers price
 *                              the answer call at this size (privateAI-design-34 ARCH-638), so a run never sends more
 *   --crossask-retry-error-chars N  a failed query's error fed back to the model is cut to N characters (default 2000)
 *   --check-small-numbers on|off  also check whole numbers under 100 in the worded answer ("37 claims"; crossask verify.ts
 *                              smallNumbers; owner 2026-11-07, tab 03 "Calculated, NOT made up by the AI"). Default on.
 *   Run log (privateAI-design-31 §3): one JSON line per question in <dir>/crossask-YYYY-MM-DD.jsonl (run-log.ts).
 *   --run-log off|meta|full    meta (default): no data values; full: also result rows, the answer and model replies
 *                              (synthetic data only); off: nothing written
 *   --run-log-dir PATH         default test-console/runs (git-ignored)
 *   --run-log-max-rows N       result rows kept per run in full mode (default 50)
 *   --run-log-keep-days N      older run files are removed (default 14)
 *
 *   Paid chat ("Pay with Crossmark" box on the chat tab): the browser pays the paywall's chat price from its own
 *   Crossmark wallet with the web page's bundle (services/web, payAndChat). This server serves the bundle and
 *   relays /paid/chat to the PAYWALL with the payment header; it never adds the gateway key there and logs
 *   neither the text nor the payment.
 *   --wallet-bundle PATH  the browser payment bundle (default ../../services/web/public/wallet.js;
 *                         build it with npm --prefix services/web run build:wallet)
 *   --paid-timeout-sec N  how long a paid chat may take, quote, settle and answer together (default 240)
 *   Paid chat in USDC on NEAR ("Pay with USDC · NEAR" box, shown only with --near-wallet): the same, with the web
 *   page's NEAR bundle (services/web, nearPayAndChat) and the visitor's NEAR wallet; it goes through the same /paid/chat.
 *   --near-wallet ID      the NEAR wallet the page may run (only intear-wallet; services/web/src/near-wallets.ts).
 *                         Unset: no NEAR box and no /near-wallet.js. This page sends no CSP of its own either way.
 *   --near-wallet-bundle PATH  the NEAR browser bundle (default ../../services/web/public/near-wallet.js;
 *                         build it with npm --prefix services/web run build:near-wallet)
 *
 *   Paid jobs on tab 03 (architecture.md ARCH-104/105/112/114; off unless --paid-jobs on, which also needs --near-wallet):
 *   POST /jobs/crossask runs the same job as /crossask, meters each model call (gateway usage), prices it with
 *   packages/crossask cost.ts, holds the result here, registers {jobId, amount, expiresAt} with the paywall, and
 *   answers only the cost. POST /paid/jobs/<id>/release relays the NEAR payment to the paywall (no gateway key); the
 *   paywall reads the held result from the internal listener while it settles.
 *   --paid-jobs on|off         default off: no new route, listener or page change
 *   --jobs-internal-host H     the internal listener's address (default 127.0.0.1; see MANUAL_SETUP.md M2)
 *   --jobs-internal-port N     its port (default 8731): GET /internal/jobs/<id>, POST /internal/jobs/<id>/released
 *   --paid-jobs-key-env NAME   environment variable holding the key shared with the paywall (default PAID_JOBS_KEY, >= 24 chars)
 *   --job-ttl-min N            minutes a quoted job stays payable (default 15; at most the paywall's PAID_JOBS_TTL_SEC)
 *   --job-max N                open jobs held at once (default 100; beyond it /jobs/crossask answers 503)
 *   --pricing-catalog PATH     model prices (pricing.inputPerM / outputPerM), e.g. ../../config/catalog.bedrock.json
 *   --fee-per-model-call-usd D, --fee-analyst-usd D, --near-gas-fee-usd D, --margin-pct D, --min-price-usd D
 *                              required with --paid-jobs on, non-negative decimals, never defaulted (MANUAL_SETUP.md)
 *   --price-round micro|cent   privateAI-design-33 ARCH-629: round the total UP to 6 decimals (micro, default) or to whole
 *                              cents (cent; the default and the only value under --ap2 on, whose UCP totals are cents)
 *   Paid-job feed to near-watch (chainaim-adminUI-NEAR architecture-adminui-jobs.md ARCH-205; off unless --job-feed-url,
 *   which needs --paid-jobs on): job_quoted / job_released / job_expired, ids, times, amounts, models and counts only
 *   (job-feed.ts), never awaited by a request.
 *   --job-feed-url URL          near-watch's ingest route, e.g. http://127.0.0.1:8790/ingest/job (default unset = off)
 *   --job-feed-key-env NAME     environment variable holding near-watch's ingest key (default NEAR_WATCH_INGEST_KEY, >= 24 chars)
 *   --job-feed-timeout-ms N     one post (default 5000)
 *   --job-feed-max-inflight N   posts at once; beyond it an event is dropped and logged (default 20)
 *   --job-expiry-check-sec N    how often held jobs are checked for expiry (default 30)
 *   --job-feed-attest-keep N    quoted jobs whose model-call list is kept for their job_attested event (default 500)
 *   NEAR AI model attestation (PLAN-private-ai-nearai-attestation.md ARCH-411; off unless --attest-url, which needs
 *   --paid-jobs on): after a job is quoted, ca-attest (services/attest) is asked about each of its calls that carry the
 *   gateway's attestation evidence, in the background (attest.ts); never awaited, never fails a job.
 *   GET /jobs/<id>/attestation answers the result (ids, hashes, addresses, booleans, reasons). With --job-feed-url the
 *   finished result is also sent to near-watch as job_attested (job-feed.ts), so the admin Jobs tab shows it.
 *   --attest-url URL            ca-attest, e.g. http://attest:8770 (default unset = off)
 *   --attest-timeout-ms N       one POST /verify (default 20000)
 *   --attest-keep N             job attestations kept in memory (default 500; oldest dropped first)
 *   --pay-only-attested M       privateAI-design-39 ARCH-685: off | evidence (default: an estimate that said attested is
 *                               void when a call lacks the gateway's evidence) | verified (needs --attest-url: /offers refuses
 *                               a route that is not all attested models; the run step and the run-hold quote await
 *                               ca-attest's verdict and answer 422 attestation_not_proven unless every call is verified)
 *   --pay-only-attested-deadline-ms N  how long verified waits for the verdict (default 30000, 1000..240000)
 *   Job Evidence Receipts (privateAI-design-32 ARCH-613..616; off unless --receipts on, which needs --paid-jobs on): when
 *   a job is quoted, its dataset folder's files (inside allowedRoots; hidden folders such as _analyst left out) are hashed
 *   and held with it; when the paywall reports it released, a receipt (ids, hashes, amounts only) is signed with Ed25519,
 *   stored, and the settlement from the release notice appended. GET /jobs/<id>/receipt answers {receipt, publicKeyPem}.
 *   Body fields datasetId and templateLabel (optional) of POST /jobs/crossask name the dataset in the receipt.
 *   --receipts on|off           default off
 *   --receipt-key-env NAME      environment variable holding the PKCS#8 PEM Ed25519 key (default RECEIPT_SIGNING_KEY)
 *   --receipt-dir PATH          where receipts are kept as <jobId>.json (default ../../runtime/receipts)
 *   --receipt-max-files N       a dataset with more files is not sold (no receipt can cover it; default 500)
 *   --job-feed-receipts on|off  also send job_receipt to near-watch (default off: near-watch must accept the event first)
 *   --job-feed-ap2 on|off       also send the signed quote's key id and hash on job_quoted (default off; near-watch ARCH-702)
 *   --job-feed-mandate on|off   also send the receipt's checkout mandate {kid, tenant, sha256} on job_receipt (privateAI-
 *                               design-42 ARCH-710; default off; needs --job-feed-receipts on; near-watch ARCH-704)
 *   Observer view (privateAI-design-35 ARCH-650; needs --receipts on): GET /jobs/<id>/observer reads the job's settlement
 *   transaction from public NEAR RPC, as anyone could, and answers what the chain shows (payer, relayer, pay-to, amount,
 *   time) and the fixed list of what it does not (packages/observer). No key; nothing about the job's content is sent.
 *   --observer on|off                     default on (only with receipts: the settlement is read from the receipt)
 *   --observer-rpc-testnet URL            default https://rpc.testnet.fastnear.com
 *   --observer-rpc-fallback-testnet URL   asked when the first does not know the transaction (default
 *                                         https://archival-rpc.testnet.near.org; none = no fallback)
 *   --observer-rpc-mainnet URL            default https://rpc.mainnet.fastnear.com
 *   --observer-rpc-fallback-mainnet URL   default https://archival-rpc.mainnet.near.org
 *   --observer-timeout-ms N               one RPC call (default 15000, 1000..120000)
 *   --observer-token-decimals N           the paid token's decimals (default 6, NEAR USDC)
 *   AP2 signed quotes (privateAI-design-33 ARCH-628; off unless --ap2 on, which needs --paid-jobs on and implies
 *   --price-round cent): each quoted job is written as a UCP checkout (2026-08-25) and signed as an AP2 merchant
 *   authorization (detached JWS, ES256, packages/ap2); held with the job and answered as ap2 {checkout,
 *   merchant_authorization}. GET /.well-known/ucp answers the business profile with the public key (keys[]).
 *   --ap2 on|off                default off: the answer, the routes and the price are as before
 *   --ap2-key-env NAME          environment variable holding the PKCS#8 PEM EC P-256 key (default AP2_SIGNING_KEY; desk.ps1 -Ap2Key)
 *   --ap2-alg ES256             the JWS alg (only ES256; AP2 allows ECDSA only, design-33 D1)
 *   --ap2-terms-url URL         the checkout's terms_of_service link, required with --ap2 on
 *
 *   Docker split (DOCKERIZE-PLAN 4.1, C1-C7; every default is today's single process on 127.0.0.1):
 *   --mode all|ui|api          all (default): page and backend in one process, as before. api: the same backend, meant to
 *                              run in a container (with --bind 0.0.0.0). ui: serves only /, /wallet.js and /near-wallet.js
 *                              and forwards every other request, byte for byte, to --api; it holds no key and reads no
 *                              data, config or ledger.
 *   --bind HOST                the address this console listens on (default 127.0.0.1)
 *   --api URL                  ui mode only, required there: the console API, e.g. http://127.0.0.1:8735
 *   --forward-timeout-sec N    ui mode: one forwarded request (default the longer of --paid-timeout-sec and --crossask-timeout-sec)
 *   --allowed-hosts LIST       Host headers the guarded routes accept, comma-separated host:port
 *                              (default 127.0.0.1:<port>,localhost:<port>). In ui mode every forwarded request needs one.
 *   --ledger-source S          the ledger twisty: docker-exec (default: docker exec ca-gateway tail ...), dir:<path> (the
 *                              gateway's ledger folder mounted read-only, e.g. dir:/gateway-data/ledger) or off
 *   --gateway-key-file PATH    the gateway key (default test-console/local-gateway-key.txt; not read in ui mode)
 *   --paid-jobs-page on|off    ui mode: add the tab 03 pay box to the page (default off; jobs themselves run in the api)
 *   --dataset-root NAME=PATH   replace one root of config/datasets.json (repeatable), e.g. private=/data/priv-ai-data/chainaim3003
 *                              when the data is mounted at another path; default none = the file's own roots
 *
 *   Tab 03 agent mode (architecture-tab03-agent-mode.md ARCH-307/308; off unless --agent-service, which needs --paid-jobs on):
 *   a tenant's AI agent (services/paywall/scripts/agent-jobs.ts) runs the paid job and pays it from the tenant's NEAR
 *   account. GET /agent/config lists the agent's tenants; GET /agent/policy their spending policies and today's spend
 *   (privateAI-design-32 ARCH-620; {on: false} when the agent runs without one); POST /agent/crossask {folder, question, model?, answerModel?,
 *   phrase?, sql?, tenant} is relayed to the agent's POST /run and its event stream passed back byte for byte as it
 *   arrives. This server adds no key and logs only {route:"agent", tenant, jobId, status, ms}.
 *   --agent-service URL        the agent service, e.g. http://agent:8760 (default unset = no /agent routes)
 *   --agent-forward-timeout-sec N  one agent run through this server (default 330 = the agent's run timeout + 30); in ui
 *                              mode the same limit applies to the streamed pass-through of POST /agent/crossask
 *
 *   Pages are served at /view/<id> with a sandbox Content-Security-Policy: their scripts run in an opaque
 *   origin and connect-src is 'none', so model-written HTML cannot call this console, the gateway or any
 *   other address. Pages live in memory only (they can hold statement data) and vanish on restart.
 *
 *   node server.ts  ->  http://127.0.0.1:8730
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { NETWORKS } from "../../services/web/src/balance.ts";
import { NEAR_WALLETS, isNearWalletId } from "../../services/web/src/near-wallets.ts";
import { analystClient, crossAsk, gatewayChat } from "../../packages/crossask/src/index.ts";
import { RUN_LOG_MODES, RunLog, type RunLogMode } from "./run-log.ts";
import { microsToUsd, quoteJob, USDC_DECIMALS, type JobQuote } from "../../packages/crossask/src/cost.ts";
import { JobStore, internalHandler, meterOf, paidJobsConfig, registerJob, type RunNotice } from "./jobs.ts";
import { JobFeed, jobFeedConfig } from "./job-feed.ts";
import { AttestClient, attestConfig, payOnlyAttestedConfig, privacyProven } from "./attest.ts";
import { egressRefusedLines, SentStore, sentOf } from "./egress.ts";
import { calledModels, datasetFiles, datasetIdOf, receiptConfig, receiptConfigRemote, receiptOnRelease, ReceiptStore, routeOf, templateLabelOf } from "./receipt.ts";
import type { HeldJob, ReceiptHold } from "./jobs.ts";
import { ap2Answer, ap2Config, ap2ConfigRemote, JOB_EXTENSION, ucpProfile, type Ap2Hold } from "./ap2.ts";
import { RemoteSigner, signerClientConfig, SignerRefused, SignerUnavailable, waitForSignerKeys } from "./signer-client.ts";
import { SellerSigner, type SignedQuote, type SignerApi } from "../../packages/signer/src/index.ts";
import { parseMandateRegistry, verifyMerchantAuthorization } from "../../packages/ap2/src/index.ts";
import { limitsEqualBasis, parseLimits, pricedCalls, servedWithinLimits, withinLimits, type CheckoutLimits } from "../../packages/offer/src/index.ts";
import { economicsOf, filesRoot } from "../../packages/receipt/src/index.ts";
import { observe, observerConfig, ObserverError } from "../../packages/observer/src/index.ts";
import { attestedRoute, crossaskBasis, folderSize, offerModels, OfferStore, offerConfig, withinBasis, type HeldOffer, type OfferRequest } from "./offers.ts";
import { ceilingMicro, counterConfig, fitCounter, usdMicroCeil } from "./counter.ts";
import type { CrossaskBasis } from "../../packages/offer/src/index.ts";

const { values: flags } = parseArgs({
  args: process.argv.slice(2),
  strict: true,
  options: {
    "default-model": { type: "string" },
    "models-file": { type: "string", default: fileURLToPath(new URL("../../config/local-models.json", import.meta.url)) },
    "generated-summary": { type: "string", default: fileURLToPath(new URL("../../config/generated/summary.json", import.meta.url)) },
    port: { type: "string", default: "8730" },
    gateway: { type: "string", default: "http://127.0.0.1:8720" },
    paywall: { type: "string", default: "http://127.0.0.1:8080" },
    spy: { type: "string", default: "http://127.0.0.1:5004" },
    "data-config": { type: "string", default: fileURLToPath(new URL("../../config/data-sources.json", import.meta.url)) },
    analyst: { type: "string", default: "http://127.0.0.1:8740" },
    "chain-query": { type: "string", default: "http://127.0.0.1:8750" },
    "view-max": { type: "string", default: "20" },
    "view-ttl-min": { type: "string", default: "60" },
    "view-max-bytes": { type: "string", default: "1000000" },
    "view-script-src": { type: "string", default: "https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com" },
    "wallet-bundle": { type: "string", default: fileURLToPath(new URL("../../services/web/public/wallet.js", import.meta.url)) },
    "paid-timeout-sec": { type: "string", default: "240" },
    "near-wallet": { type: "string" },
    "near-wallet-bundle": { type: "string", default: fileURLToPath(new URL("../../services/web/public/near-wallet.js", import.meta.url)) },
    "crossask-timeout-sec": { type: "string", default: "300" },
    "crossask-sql-retries": { type: "string", default: "1" },
    "crossask-answer-rows": { type: "string", default: "50" },
    "crossask-max-prompt-chars": { type: "string", default: "40000" },
    "crossask-answer-max-prompt-chars": { type: "string", default: "8000" },
    "crossask-retry-error-chars": { type: "string", default: "2000" },
    "check-small-numbers": { type: "string", default: "on" },
    "default-answer-model": { type: "string", default: "" },
    "default-payer": { type: "string", default: "me" },
    "run-log": { type: "string", default: "meta" },
    "run-log-dir": { type: "string", default: fileURLToPath(new URL("../runs", import.meta.url)) },
    "run-log-max-rows": { type: "string", default: "50" },
    "run-log-keep-days": { type: "string", default: "14" },
    "paid-jobs": { type: "string" },
    "jobs-internal-host": { type: "string" },
    "jobs-internal-port": { type: "string" },
    "paid-jobs-key-env": { type: "string" },
    "job-ttl-min": { type: "string" },
    "job-max": { type: "string" },
    "pricing-catalog": { type: "string" },
    "fee-per-model-call-usd": { type: "string" },
    "fee-analyst-usd": { type: "string" },
    "near-gas-fee-usd": { type: "string" },
    "margin-pct": { type: "string" },
    "min-price-usd": { type: "string" },
    "price-round": { type: "string" },
    "offer-mode": { type: "string" },
    "offer-modes": { type: "string" },
    "cost-model": { type: "string" },
    "offer-max-tokens": { type: "string" },
    "offer-size-tolerance-pct": { type: "string" },
    "offer-limits-check": { type: "string" },
    // privateAI-design-43 ARCH-721: one-round counter-offers (POST /offers/<id>/counter); default off.
    counter: { type: "string" },
    "counter-ladder": { type: "string" },
    "counter-max-rounds": { type: "string" },
    "job-feed-url": { type: "string" },
    "job-feed-key-env": { type: "string" },
    "job-feed-timeout-ms": { type: "string" },
    "job-feed-max-inflight": { type: "string" },
    "job-expiry-check-sec": { type: "string" },
    "job-feed-attest-keep": { type: "string" },
    "attest-url": { type: "string" },
    "attest-timeout-ms": { type: "string" },
    "attest-keep": { type: "string" },
    "pay-only-attested": { type: "string" },
    "pay-only-attested-deadline-ms": { type: "string" },
    "attest-poll-ms": { type: "string", default: "3000" },
    "attest-poll-max": { type: "string", default: "40" },
    receipts: { type: "string" },
    "receipt-key-env": { type: "string" },
    "receipt-dir": { type: "string", default: fileURLToPath(new URL("../../runtime/receipts", import.meta.url)) },
    "receipt-max-files": { type: "string" },
    "job-feed-receipts": { type: "string" },
    observer: { type: "string", default: "on" },
    "observer-rpc-testnet": { type: "string", default: "https://rpc.testnet.fastnear.com" },
    "observer-rpc-fallback-testnet": { type: "string", default: "https://archival-rpc.testnet.near.org" },
    "observer-rpc-mainnet": { type: "string", default: "https://rpc.mainnet.fastnear.com" },
    "observer-rpc-fallback-mainnet": { type: "string", default: "https://archival-rpc.mainnet.near.org" },
    "observer-timeout-ms": { type: "string", default: "15000" },
    "observer-token-decimals": { type: "string", default: "6" },
    "job-feed-ap2": { type: "string" },
    "job-feed-mandate": { type: "string" },
    ap2: { type: "string" },
    "ap2-key-env": { type: "string" },
    "ap2-alg": { type: "string" },
    "ap2-terms-url": { type: "string" },
    // privateAI-design-36 ARCH-663 / ARCH-667: where the signing happens, and the buyer's checkout mandate.
    signer: { type: "string" },
    "signer-url": { type: "string" },
    "signer-key-env": { type: "string" },
    "signer-timeout-sec": { type: "string" },
    "signer-start-wait-sec": { type: "string" },
    "ap2-mandate": { type: "string" },
    "mandate-keys": { type: "string" },
    "mandate-audience": { type: "string" },
    mode: { type: "string", default: "all" },
    bind: { type: "string", default: "127.0.0.1" },
    api: { type: "string" },
    "forward-timeout-sec": { type: "string" },
    "allowed-hosts": { type: "string" },
    "ledger-source": { type: "string", default: "docker-exec" },
    "gateway-key-file": { type: "string", default: fileURLToPath(new URL("../local-gateway-key.txt", import.meta.url)) },
    "paid-jobs-page": { type: "string" },
    "dataset-root": { type: "string", multiple: true },
    "agent-service": { type: "string" },
    "agent-forward-timeout-sec": { type: "string", default: "330" },
  },
});
/** DOCKERIZE-PLAN C1: all (today), ui (page + forwarding) or api (backend in a container). */
const MODE = flags.mode as "all" | "ui" | "api";
if (!["all", "ui", "api"].includes(MODE)) throw new Error(`--mode must be all, ui or api, got ${flags.mode}`);
if (MODE === "ui") {
  // The ui process runs nothing of the backend; a backend flag here would be silently unused, so it is refused.
  for (const name of ["paid-jobs", "job-feed-url", "pricing-catalog", "dataset-root", "attest-url", "pay-only-attested", "pay-only-attested-deadline-ms", "receipts", "ap2", "price-round", "signer", "signer-url", "ap2-mandate", "mandate-keys", "counter", "counter-ladder", "counter-max-rounds"] as const) {
    if (flags[name] !== undefined) throw new Error(`--${name} belongs to the api process, not --mode ui (use --paid-jobs-page on for the tab 03 pay box)`);
  }
  if (!flags.api) throw new Error("--mode ui needs --api URL: the console API, e.g. http://127.0.0.1:8735");
  if (!URL.canParse(flags.api) || !/^https?:$/.test(new URL(flags.api).protocol)) throw new Error(`--api must be an http(s) URL, got ${flags.api}`);
} else {
  if (flags.api !== undefined) throw new Error("--api is for --mode ui only");
  if (flags["paid-jobs-page"] !== undefined) throw new Error("--paid-jobs-page is for --mode ui only (in this mode the page follows --paid-jobs)");
}
if (flags["paid-jobs-page"] !== undefined && !["on", "off"].includes(flags["paid-jobs-page"])) throw new Error(`--paid-jobs-page must be on or off, got ${flags["paid-jobs-page"]}`);
if (!/^[0-9a-fA-F.:]+$|^localhost$/.test(flags.bind!)) throw new Error(`--bind must be an IP address such as 127.0.0.1 or 0.0.0.0, got ${flags.bind}`);
/** C5: where the ledger twisty reads the gateway's last ledger lines. */
const LEDGER_SOURCE = flags["ledger-source"]!;
if (!(LEDGER_SOURCE === "docker-exec" || LEDGER_SOURCE === "off" || /^dir:.+/.test(LEDGER_SOURCE))) throw new Error(`--ledger-source must be docker-exec, dir:<path> or off, got ${LEDGER_SOURCE}`);
/** --dataset-root NAME=PATH: roots of config/datasets.json replaced for this process (e.g. inside a container). */
const DATASET_ROOTS: Record<string, string> = {};
for (const pair of flags["dataset-root"] ?? []) {
  const m = /^([A-Za-z0-9_-]+)=(.+)$/.exec(pair);
  if (!m) throw new Error(`--dataset-root must be NAME=PATH, got ${pair}`);
  DATASET_ROOTS[m[1]] = m[2];
}
function positiveInt(name: "view-max" | "view-ttl-min" | "view-max-bytes" | "paid-timeout-sec" | "crossask-timeout-sec" | "crossask-sql-retries" | "crossask-answer-rows" | "crossask-max-prompt-chars" | "crossask-answer-max-prompt-chars" | "crossask-retry-error-chars" | "agent-forward-timeout-sec", min = 1): number {
  const n = Number(flags[name]);
  if (!Number.isInteger(n) || n < min) throw new Error(`--${name} must be a positive integer, got ${flags[name]}`);
  return n;
}
const VIEW_MAX = positiveInt("view-max");
const VIEW_TTL_MS = positiveInt("view-ttl-min") * 60_000;
const VIEW_MAX_BYTES = positiveInt("view-max-bytes");
const VIEW_SOURCES = flags["view-script-src"]!.split(/\s+/).filter(Boolean);
const PAID_TIMEOUT_MS = positiveInt("paid-timeout-sec") * 1000;
const WALLET_BUNDLE = flags["wallet-bundle"]!;
const NEAR_WALLET = flags["near-wallet"];
if (NEAR_WALLET !== undefined && !isNearWalletId(NEAR_WALLET)) throw new Error(`--near-wallet must be one of ${Object.keys(NEAR_WALLETS).join(", ")}, got ${NEAR_WALLET}`);
const NEAR_WALLET_BUNDLE = flags["near-wallet-bundle"]!;
/** Paid jobs on tab 03 (ARCH-104/105/114): undefined unless --paid-jobs on; start-up stops here naming any missing flag. Never in ui mode. */
const PAID_JOBS = MODE === "ui" ? undefined : paidJobsConfig(flags, process.env);
if (PAID_JOBS && !NEAR_WALLET) throw new Error("--paid-jobs on needs --near-wallet intear-wallet: paid jobs are paid in USDC on NEAR from the page");
/** Tab 03 agent mode (ARCH-307): the agent service; unset (default) = no /agent routes. Never in ui mode (it forwards /agent/* to --api). */
const AGENT_SERVICE = flags["agent-service"]?.replace(/\/+$/, "");
if (AGENT_SERVICE !== undefined) {
  if (MODE === "ui") throw new Error("--agent-service belongs to the api process, not --mode ui (the ui forwards /agent/* to --api)");
  if (!URL.canParse(AGENT_SERVICE) || !/^https?:$/.test(new URL(AGENT_SERVICE).protocol)) throw new Error(`--agent-service must be an http(s) URL, got ${flags["agent-service"]}`);
  if (!PAID_JOBS) throw new Error("--agent-service needs --paid-jobs on: the agent runs and pays the paid job (/jobs/crossask)");
}
const AGENT_FORWARD_TIMEOUT_MS = positiveInt("agent-forward-timeout-sec") * 1000;
/** The paid-job feed to near-watch (adminUI ARCH-205): undefined unless --job-feed-url; start-up stops here on a bad flag or key. */
const JOB_FEED_CONFIG = MODE === "ui" ? undefined : jobFeedConfig(flags, process.env, PAID_JOBS !== undefined);
const JOB_FEED = JOB_FEED_CONFIG ? new JobFeed(JOB_FEED_CONFIG) : undefined;
/** NEAR AI model attestation (ARCH-411): undefined unless --attest-url; start-up stops here on a bad flag. */
const ATTEST_CONFIG = MODE === "ui" ? undefined : attestConfig(flags, PAID_JOBS !== undefined);
// The finished result goes to near-watch as job_attested when the job feed is on (adminUI ARCH-501).
const ATTEST = ATTEST_CONFIG ? new AttestClient(ATTEST_CONFIG, undefined, JOB_FEED ? (a) => JOB_FEED.attested(a) : undefined) : undefined;
/** privateAI-design-39 ARCH-685: what a paid job must show about attestation before delivery; start-up stops here on a bad flag. */
const PAY_ONLY_ATTESTED = MODE === "ui" ? undefined : payOnlyAttestedConfig(flags, ATTEST !== undefined);
/** ARCH-687: the 422 body of a job whose privacy was not proven (verified mode); the paywall then delivers nothing. */
const notProven = (summary: string, nothingPaid: boolean) => ({ error: `privacy was not proven for this job (NEAR AI attestation: ${summary})${nothingPaid ? ", so nothing can be paid" : ""}`, code: "attestation_not_proven", summary });
const JOBS = PAID_JOBS ? new JobStore(PAID_JOBS.max, PAID_JOBS.ttlMs, Date.now, JOB_FEED ? (j) => JOB_FEED.expired(j.jobId) : undefined) : undefined;
/** privateAI-design-41 ARCH-699: the exact bytes each held paid job's model calls sent, memory only, for the run's owner. */
const SENT = PAID_JOBS ? new SentStore(PAID_JOBS.max) : undefined;
/**
 * privateAI-design-36 ARCH-663: --signer local (default) signs in this process with the keys of --ap2-key-env and
 * --receipt-key-env; --signer remote leaves every ChainAim key in ca-control-signer, whose PUBLIC keys are read here once
 * at start-up (it is retried for --signer-start-wait-sec, then start-up stops naming the URL).
 */
const SIGNER_CLIENT = MODE === "ui" || !PAID_JOBS ? undefined : signerClientConfig(flags, process.env);
if (!PAID_JOBS && MODE !== "ui") for (const f of ["signer", "signer-url", "ap2-mandate", "mandate-keys"] as const) if (flags[f] !== undefined) throw new Error(`--${f} needs --paid-jobs on`);
const REMOTE_SIGNER = SIGNER_CLIENT?.mode === "remote" ? new RemoteSigner(SIGNER_CLIENT) : undefined;
const REMOTE_KEYS = REMOTE_SIGNER && SIGNER_CLIENT?.mode === "remote"
  ? await waitForSignerKeys(REMOTE_SIGNER, SIGNER_CLIENT.startWaitMs).catch((e: unknown) => { throw new Error(`--signer remote: ${SIGNER_CLIENT.url}/.well-known/keys did not answer (${(e as Error).message}); start ca-control-signer first (desk.ps1 -All starts it)`); })
  : undefined;
/** Job Evidence Receipts (ARCH-613..616): undefined unless --receipts on; start-up stops here when the key variable is missing or not Ed25519. */
const RECEIPT_CONFIG = MODE === "ui" ? undefined : REMOTE_KEYS ? receiptConfigRemote(flags, PAID_JOBS !== undefined, REMOTE_KEYS.receipt) : receiptConfig(flags, process.env, PAID_JOBS !== undefined);
const RECEIPTS = RECEIPT_CONFIG ? new ReceiptStore(RECEIPT_CONFIG) : undefined;
// ARCH-650: the observer view reads the settlement from the receipt, so it is on only with receipts.
const OBSERVER = RECEIPTS ? observerConfig(flags) : undefined;
/** AP2 signed quotes (privateAI-design-33 ARCH-628): undefined unless --ap2 on; start-up stops here when the key is missing or not P-256. */
const AP2_CONFIG = MODE === "ui" ? undefined : REMOTE_KEYS ? ap2ConfigRemote(flags, PAID_JOBS !== undefined, REMOTE_KEYS.ap2) : ap2Config(flags, process.env, PAID_JOBS !== undefined);
/** The console's hold of a signed quote (jobs.ts HeldJob.ap2) from the signer's answer. */
function holdOf(q: SignedQuote): Ap2Hold {
  return { checkout: q.checkout, merchantAuthorization: q.merchant_authorization, merchantAuthSha256: q.merchantAuthSha256, kid: q.kid };
}
/** A quote the signer could not be reached for is 502; one it refused (another amount, a field it does not take) 422. */
const signFailStatus = (e: unknown): number => (e instanceof SignerUnavailable ? 502 : e instanceof SignerRefused ? 422 : 500);
/** The paywall's release notice (jobs.ts internalHandler): the job feed's job_released, then the receipt, which is never awaited. */
/**
 * privateAI-design-38 ARCH-682: what runs is what was signed. With a signed quote and --offer-limits-check on, the run's
 * limits are read from the SIGNED checkout (verified with the signer's public key, equal to the held basis), before any
 * model call; a held quote changed in memory, or one without limits, is 422 and nothing runs or settles. (Moved out of
 * runOffer unchanged by privateAI-design-42 ARCH-711, so the pre-payment re-check applies the very same limits.)
 */
function heldLimits(o: HeldOffer): { limits?: CheckoutLimits } | { refused: { status: number; body: unknown } } {
  if (!(o.ap2 && AP2_CONFIG && OFFER_CONFIG?.limitsCheck)) return {};
  const ext = o.ap2.checkout[JOB_EXTENSION] as Record<string, unknown> | undefined;
  if (ext?.limits === undefined) return { refused: { status: 422, body: { error: "the signed quote carries no limits (a signer before v2.1.0?), so the job cannot be held to what was signed; nothing ran", code: "limits_missing" } } };
  const sig = verifyMerchantAuthorization(o.ap2.merchantAuthorization, o.ap2.checkout, [AP2_CONFIG.signer.publicJwk]);
  if (!sig.ok) return { refused: { status: 422, body: { error: `the held signed quote does not verify with ChainAim's signer key (${sig.code}); nothing ran`, code: "limits_unsigned" } } };
  let limits: CheckoutLimits;
  try { limits = parseLimits(ext.limits); }
  catch (e) { return { refused: { status: 422, body: { error: `the signed limits cannot be read (${(e as Error).message}); nothing ran`, code: "limits_unsigned" } } }; }
  const differs = limitsEqualBasis(limits, o.basis);
  if (differs) return { refused: { status: 422, body: { error: `the held basis is not the signed limits (${differs}); nothing ran`, code: "limits_mismatch" } } };
  return { limits };
}
/**
 * ARCH-636 (moved here unchanged by privateAI-design-43 ARCH-721, so a counter-offer is made by the very same code): a
 * priced basis becomes an offer: the attested-only check, a new job id registered with the paywall at the price, ChainAim's
 * signed quote (its limits = this basis), held with the question. `counter`: the first offer's id, the steps that made it
 * smaller and the round; the answer then carries counterOf and reduced. Ids, amounts and sizes are logged, never the question.
 */
async function makeOffer(request: OfferRequest, basis: CrossaskBasis, quote: JobQuote, counter?: { counterOf: string; reduced: string[]; round: number }): Promise<{ status: number; body: unknown }> {
  const P = PAID_JOBS!, J = JOBS!, C = OFFER_CONFIG!;
  // privateAI-design-39 ARCH-687: this console sells only attested private inference; refused before the paywall is asked.
  if (PAY_ONLY_ATTESTED?.mode === "verified" && !attestedRoute(basis, P.attestable)) return { status: 422, body: { error: "this job's models are not all NEAR AI attested models, and this console sells only attested private inference (--pay-only-attested verified), so nothing can be paid", code: "route_not_attested" } };
  const offerId = J.newJobId();
  const expiresAt = J.expiryFromNow();
  let offer;
  try { offer = await registerJob(PAYWALL, P.key, { jobId: offerId, amount: quote.amount, expiresAt, run: true }); }
  catch (e) { return { status: 502, body: { error: (e as Error).message } }; }
  // ARCH-644: the route names the models the estimate lets the run call (the ones it priced), not the request's fields.
  const route = routeOf(offerModels(basis));
  let ap2Hold: Ap2Hold | undefined;
  if (AP2_CONFIG) {
    try { ap2Hold = holdOf(await SIGNER!.signQuote({ jobId: offerId, expiresAt, offer, pricing: { kind: "offer", basis }, route, datasetId: datasetIdOf(request.datasetId, request.folder), mode: "estimate-first", sizeTolerancePct: C.tolerancePct, ...(PAY_ONLY_ATTESTED ? { attestation: PAY_ONLY_ATTESTED.mode } : {}) })); }
    catch (e) { return { status: signFailStatus(e), body: { error: `the estimate could not be signed, so nothing can be paid: ${(e as Error).message}` } }; }
  }
  const attested = attestedRoute(basis, P.attestable);
  OFFERS!.hold({ offerId, request, basis, quote, amount: quote.amount, expiresAt, network: offer.network, attested, ...(ap2Hold ? { ap2: ap2Hold } : {}), ...(counter ?? {}) });
  // Ids, amounts and sizes only: never the question, folder or model reply.
  console.log(JSON.stringify({ ts: new Date().toISOString(), route: "offer", event: counter ? "offer_countered" : "offer_estimated", offerId, amount: quote.amount, files: basis.files, bytes: basis.totalBytes, calls: quote.breakdown.calls.length, ...(counter ? { counterOf: counter.counterOf, reduced: counter.reduced } : {}) }));
  return { status: 200, body: {
    jobId: offerId, offerId, mode: "estimate-first", totalUsd: quote.totalUsd, amount: quote.amount, network: offer.network, asset: offer.asset, payTo: offer.payTo, expiresAt,
    route, attested,
    // The basis this offer is priced and signed on (for a first offer: this console's limits, as before).
    basis: { files: basis.files, totalBytes: basis.totalBytes, modelCalls: quote.breakdown.calls.length, maxPromptChars: basis.maxPromptChars, answerMaxPromptChars: basis.answerMaxPromptChars, maxTokens: basis.maxTokens, sqlRetries: basis.sqlRetries, answerMaxRows: basis.answerMaxRows },
    ...(ap2Hold ? { ap2: ap2Answer(ap2Hold) } : {}),
    ...(counter ? { counterOf: counter.counterOf, reduced: counter.reduced } : {}),
  } };
}
/**
 * ARCH-638: the held offer's folder re-sized now, against the signed limits when there are some, else the held basis and
 * --offer-size-tolerance-pct: `grown` names how it grew past the tolerance or gained files (the estimate no longer
 * covers it: the caller answers 409), null when within; `refused` (422) when the data config or the folder cannot be read.
 * Used by the paid run and, before any payment, by GET /offers/<id>/recheck (privateAI-design-42 ARCH-711).
 */
async function offerSize(o: HeldOffer, limits: CheckoutLimits | undefined): Promise<{ size: { files: number; totalBytes: number }; grown: string | null; config: DataConfig } | { refused: { status: number; body: unknown } }> {
  const { config, error } = readDataConfig();
  if (!config) return { refused: { status: 422, body: { error: `the job cannot run: ${error}` } } };
  let now;
  try { now = await folderSize(o.request.folder, (n) => usableName(n, config), config.maxFiles); }
  catch (e) { return { refused: { status: 422, body: { error: `the folder cannot be read: ${(e as Error).message}` } } }; }
  const grown = limits ? withinLimits(limits, now) : withinBasis(o.basis, now, OFFER_CONFIG!.tolerancePct);
  return { size: now, grown, config };
}
/**
 * ARCH-637/638: the paid release of an estimate-first offer, called by the paywall after it verified the payment and
 * before it settles. Runs the held request within the offer's basis: the folder re-sized (409 when it grew past
 * --offer-size-tolerance-pct or gained files), the basis's retries, answer rows and prompt size, max_tokens on every
 * model call, and no more model calls than were priced (409). A run with no result, or one no receipt can cover, is 422:
 * the paywall settles nothing (design-32 ARCH-611). A good run becomes a held job (receipt, job feed, attestation as
 * for run-hold) and its result goes back; the buyer pays the estimate, the metered cost goes in the receipt (actualUsd).
 */
async function runOffer(jobId: string, notice?: RunNotice): Promise<{ status: number; body: unknown }> {
  const o = OFFERS?.get(jobId);
  if (!o || !PAID_JOBS || !JOBS || !OFFER_CONFIG) return { status: 404, body: { error: "no such offer (it expired or was never made)" } };
  // ARCH-667: the buyer agent's checkout mandate, verified by ChainAim's signer before anything runs. A refused, missing
  // (when required) or uncheckable mandate is 422 and a signer that cannot be reached 502: the paywall settles nothing.
  let mandate: HeldJob["mandate"];
  if (MANDATE_MODE !== "off" && o.ap2) {
    const presented = notice?.checkoutMandate;
    if (presented) {
      if (!notice?.invoiceId) return { status: 422, body: { error: "the paid release names no invoice, so the checkout mandate cannot be checked", code: "mandate_scope_mismatch" } };
      let v;
      try { v = await SIGNER!.verifyMandate({ mandate: presented, jobId, nonce: notice.invoiceId, ap2: { checkout: o.ap2.checkout, merchant_authorization: o.ap2.merchantAuthorization } }); }
      catch (e) { return { status: e instanceof SignerRefused ? 422 : 502, body: { error: `the checkout mandate could not be checked: ${(e as Error).message}` } }; }
      if (!v.ok) {
        console.log(JSON.stringify({ ts: new Date().toISOString(), route: "offer", event: "mandate_refused", offerId: jobId, code: v.code }));
        return { status: 422, body: { error: `the checkout mandate was refused by ChainAim's signer (${v.code}): ${v.reason}`, code: v.code } };
      }
      mandate = { ref: { sha256: v.sha256, kid: v.kid, tenant: v.tenant, accountId: v.accountId, nonce: v.nonce }, presentation: presented };
      console.log(JSON.stringify({ ts: new Date().toISOString(), route: "offer", event: "mandate_verified", offerId: jobId, kid: v.kid, tenant: v.tenant }));
    } else if (MANDATE_MODE === "required") {
      return { status: 422, body: { error: "a checkout mandate is required (mandate_required): the buyer's agent signs one per payment", code: "mandate_required" } };
    }
  }
  const held = heldLimits(o);
  if ("refused" in held) return held.refused;
  const limits = held.limits;
  const sized = await offerSize(o, limits);
  if ("refused" in sized) return sized.refused;
  if (sized.grown) return { status: 409, body: { error: sized.grown } };
  const config = sized.config;
  // Every limit of the run from the signed limits when there are some (equal to the held basis, checked above).
  const r = o.request, bs = limits ?? o.basis;
  let out;
  // ARCH-699: the bytes each call sent, by their egress hash (only when the gateway runs with --expose-egress on).
  const sentBySha = new Map<string, Uint8Array>();
  try {
    out = await crossAsk({ folder: r.folder, question: r.question, model: limits?.model ?? r.model, answerModel: limits?.answerModel ?? r.answerModel, phrase: bs.phrase, sqlRetries: bs.sqlRetries, answerMaxRows: bs.answerMaxRows, maxPromptChars: bs.maxPromptChars, answerMaxPromptChars: bs.answerMaxPromptChars, retryErrorMaxChars: CROSSASK_ERROR_CHARS, sql: r.sql, checkSmallNumbers: CHECK_SMALL },
      { analyst: analystClient(ANALYST, CROSSASK_TIMEOUT_MS), chat: gatewayChat({ url: GATEWAY, key: KEY, timeoutMs: CROSSASK_TIMEOUT_MS, maxTokens: bs.maxTokens, onSent: (sha, bytes) => sentBySha.set(sha, bytes) }), ...(JOB_FEED ? { clock: () => performance.now() } : {}) });
  } catch (e) { return { status: 422, body: { error: `the job did not run: ${(e as Error).message}` } }; }
  if (out.error || !out.result) return { status: 422, body: { error: "the job did not produce a result (run it unpaid to see why)" } };
  if (limits) {
    // ARCH-682 after the run: the signed call count, the signed models (the catalog id the meter prices by), max_tokens per call.
    const outside = servedWithinLimits(limits, out.served.map((s) => ({ model: s.model, completionTokens: s.usage?.completionTokens })));
    if (outside) {
      console.log(JSON.stringify({ ts: new Date().toISOString(), route: "offer", event: "offer_outside_limits", offerId: jobId, calls: out.served.length }));
      return { status: 409, body: { error: outside, code: "outside_limits" } };
    }
  } else {
    const priced = pricedCalls(o.basis);
    if (out.served.length > priced) return { status: 409, body: { error: `the job made ${out.served.length} model calls, more than the ${priced} estimated` } };
  }
  // privateAI-design-39 ARCH-688: the attestation rule is the one SIGNED into the offer's limits (a flag changed between the
  // estimate and the run cannot weaken a paid offer); an offer without a signed mode runs under the console's flag.
  const attestMode = limits?.attestation ?? PAY_ONLY_ATTESTED?.mode;
  // An estimate that promised an attested route (the buyer's policy may have paid for that) is void when a call lacks the evidence.
  if (attestMode === "evidence" && o.attested && !out.served.every((s) => s.attest !== undefined)) return { status: 422, body: { error: "the job ran on a route without NEAR AI attestation evidence, though the estimate said attested" } };
  // privateAI-design-39 ARCH-687: verified = ca-attest's verdict before the 200; not proven = 422, so the paywall delivers nothing.
  if (attestMode === "verified") {
    // Signed verified but this console now runs without --attest-url: nothing can prove it, so it is not proven.
    const a = ATTEST ? await ATTEST.verifyNow(jobId, out.served, PAY_ONLY_ATTESTED!.deadlineMs) : undefined;
    if (!a || !privacyProven(a, out.served)) {
      const summary = a?.summary ?? "unavailable";
      console.log(JSON.stringify({ ts: new Date().toISOString(), route: "offer", event: "attestation_not_proven", offerId: jobId, summary, calls: out.served.length }));
      return { status: 422, body: notProven(summary, false) };
    }
  }
  let metered;
  try { metered = quoteJob(meterOf(out.served), PAID_JOBS.prices, PAID_JOBS.fees); }
  catch (e) { return { status: 422, body: { error: `the job's calls could not be metered: ${(e as Error).message}` } }; }
  if (Number(metered.totalUsd) > Number(o.quote.totalUsd)) console.log(JSON.stringify({ ts: new Date().toISOString(), route: "offer", event: "offer_overrun", offerId: jobId, priceUsd: o.quote.totalUsd, actualUsd: metered.totalUsd }));
  let receiptHold: ReceiptHold | undefined;
  if (RECEIPT_CONFIG) {
    if (typeof out.sql !== "string" || !out.sql) return { status: 422, body: { error: "no receipt can be made (the job has no query)" } };
    let files;
    try { files = await datasetFiles(r.folder, RECEIPT_CONFIG.maxFiles, (n) => config.hideFolders.some((re) => re.test(n))); }
    catch (e) { return { status: 422, body: { error: `no receipt can be made: ${(e as Error).message}` } }; }
    receiptHold = {
      network: o.network, quoteId: jobId, route: routeOf(calledModels(r, out.sentToModel)), datasetId: datasetIdOf(r.datasetId, r.folder),
      // privateAI-design-43 ARCH-722: a counter-offer's receipt names the offer it countered and what was reduced.
      ...(o.counterOf !== undefined ? { counterOf: o.counterOf, reduced: o.reduced ?? [] } : {}),
      ...(templateLabelOf(r.templateLabel) ? { templateLabel: templateLabelOf(r.templateLabel) } : {}), files, sql: out.sql,
      priceUsd: o.quote.totalUsd, actualUsd: metered.totalUsd,
      // privateAI-design-40 ARCH-690: paid price vs the metered cost parts (an overrun is ChainAim's, shown as absorbed).
      economics: economicsOf(o.quote.totalUsd, metered.totalUsd, metered.breakdown),
      // ARCH-682 step 7: with signed limits, their numeric and flag members (verify-receipt checks them against the quote).
      quoteBasis: { pricing: "estimate-first", phrase: bs.phrase, userSql: bs.userSql, sqlRetries: bs.sqlRetries, answerMaxRows: bs.answerMaxRows, maxPromptChars: bs.maxPromptChars, maxTokens: bs.maxTokens, files: bs.files, totalBytes: bs.totalBytes, ...(limits ? { answerMaxPromptChars: limits.answerMaxPromptChars, sizeTolerancePct: limits.sizeTolerancePct } : {}), calls: out.served.length },
    };
  }
  const { timings: _timings, ...result } = out;
  // Held a little past the offer's expiry, so a settlement that lands near it still finds the job to release.
  for (const line of egressRefusedLines("offer", jobId, out.served)) console.log(line);
  SENT?.hold(jobId, sentOf(out.served, sentBySha), Math.max(o.expiresAt, Date.now() + 120_000));
  JOBS.hold({ jobId, result, amount: o.amount, breakdown: o.quote.breakdown, expiresAt: Math.max(o.expiresAt, Date.now() + 120_000), ...(receiptHold ? { receipt: receiptHold } : {}), ...(o.ap2 ? { ap2: o.ap2 } : {}), ...(mandate ? { mandate } : {}) });
  OFFERS!.drop(jobId);
  // The feed: each step at its metered cost; the total is the estimate the buyer paid (near-watch reconciles on it).
  JOB_FEED?.quoted({ jobId, network: o.network, expiresAt: o.expiresAt, out, quote: { ...metered, totalUsd: o.quote.totalUsd, amount: o.amount }, ...(o.ap2 ? { ap2: { kid: o.ap2.kid, merchantAuthSha256: o.ap2.merchantAuthSha256 } } : {}) });
  // ARCH-687: in verified mode the verdict is already stored; the feed gets it now that the job is quoted.
  if (attestMode === "verified") ATTEST!.announce(jobId);
  else ATTEST?.start(jobId, out.served);
  console.log(JSON.stringify({ ts: new Date().toISOString(), route: "offer", event: "offer_ran", offerId: jobId, calls: out.served.length, priceUsd: o.quote.totalUsd, actualUsd: metered.totalUsd }));
  return { status: 200, body: { jobId, result } };
}
function onJobReleased(jobId: string, job: HeldJob, notice: unknown): void {
  JOB_FEED?.released(jobId);
  if (!RECEIPTS || !RECEIPT_CONFIG) return;
  receiptOnRelease({ store: RECEIPTS, cfg: RECEIPT_CONFIG, ...(SIGNER ? { signer: SIGNER } : {}), ...(ATTEST ? { attestation: (id: string) => ATTEST.get(id) } : {}) }, jobId, job, notice).then(
    (r) => {
      if (!r) return;
      // Ids only.
      console.log(JSON.stringify({ ts: new Date().toISOString(), route: "paid-job", event: "job_receipt", jobId, receiptId: r.body.receiptId, settled: r.settlement !== undefined }));
      JOB_FEED?.receipt(r, job.receipt!.network);
    },
    (e: unknown) => console.error(JSON.stringify({ ts: new Date().toISOString(), route: "paid-job", event: "job_receipt_failed", jobId, reason: String((e as Error).message ?? e).slice(0, 200) })),
  );
}
/** The tab 03 pay box and its script, added to the page only with --paid-jobs on (the page is otherwise served as it is). */
const PAID_JOBS_FRAGMENT = fileURLToPath(new URL("./paid-jobs.html", import.meta.url));
/** C7: whether the page gets the pay box: --paid-jobs in all/api mode, --paid-jobs-page in ui mode. */
const PAGE_PAID = MODE === "ui" ? flags["paid-jobs-page"] === "on" : PAID_JOBS !== undefined;
if (MODE === "ui" && PAGE_PAID && !NEAR_WALLET) throw new Error("--paid-jobs-page on needs --near-wallet intear-wallet: the pay box pays with the NEAR bundle");
const CROSSASK_TIMEOUT_MS = positiveInt("crossask-timeout-sec") * 1000;
const CROSSASK_RETRIES = positiveInt("crossask-sql-retries", 0);
const CROSSASK_ROWS = positiveInt("crossask-answer-rows");
const CROSSASK_MAX_PROMPT = positiveInt("crossask-max-prompt-chars", 2000);
const CROSSASK_ANSWER_MAX_PROMPT = positiveInt("crossask-answer-max-prompt-chars", 500);
const CROSSASK_ERROR_CHARS = positiveInt("crossask-retry-error-chars", 100);
if (!["on", "off"].includes(flags["check-small-numbers"]!)) throw new Error(`--check-small-numbers must be on or off, got ${flags["check-small-numbers"]}`);
/** Tab 03's figures line says "NOT made up by the AI": with on (default) small whole numbers in the AI's wording are checked too. */
const CHECK_SMALL = flags["check-small-numbers"] === "on";
/** Tab 03 defaults (owner 2026-11-07): the model that words an Explained answer, and who pays when paid jobs are on. Only
 * defaults: the page falls back to its own choice when the model is not in the gateway's list, or no agent is configured. */
const DEFAULT_ANSWER_MODEL = flags["default-answer-model"]!.trim();
if (DEFAULT_ANSWER_MODEL && !/^[\w.-]+\/[\w.:-]+$/.test(DEFAULT_ANSWER_MODEL)) throw new Error(`--default-answer-model must look like provider/name, got ${DEFAULT_ANSWER_MODEL}`);
if (!["me", "agent"].includes(flags["default-payer"]!)) throw new Error(`--default-payer must be me or agent, got ${flags["default-payer"]}`);
const DEFAULT_PAYER = flags["default-payer"] as "me" | "agent";
/** Tab 03 attestation panel (owner 2026-11-07): how often and how many times the page asks GET /jobs/<id>/attestation. */
const ATTEST_POLL_MS = Number(flags["attest-poll-ms"]);
const ATTEST_POLL_MAX = Number(flags["attest-poll-max"]);
if (!Number.isInteger(ATTEST_POLL_MS) || ATTEST_POLL_MS < 500 || ATTEST_POLL_MS > 60_000) throw new Error(`--attest-poll-ms must be a whole number from 500 to 60000, got ${flags["attest-poll-ms"]}`);
if (!Number.isInteger(ATTEST_POLL_MAX) || ATTEST_POLL_MAX < 1 || ATTEST_POLL_MAX > 1000) throw new Error(`--attest-poll-max must be a whole number from 1 to 1000, got ${flags["attest-poll-max"]}`);
if (!(RUN_LOG_MODES as readonly string[]).includes(flags["run-log"]!)) throw new Error(`--run-log must be one of ${RUN_LOG_MODES.join(", ")}, got ${flags["run-log"]}`);
const RUN_LOG = new RunLog({ mode: flags["run-log"] as RunLogMode, dir: resolve(flags["run-log-dir"]!), maxRows: Number(flags["run-log-max-rows"]), keepDays: Number(flags["run-log-keep-days"]) });
/** Paywall response headers the paid chat passes back: the price, the receipt, retry advice and the gateway's own. */
const PAID_PASS_BACK = /^(payment-required|payment-response|retry-after|x-chainaim-[a-z-]+)$/;
for (const s of VIEW_SOURCES) {
  if (!URL.canParse(s) || new URL(s).protocol !== "https:" || new URL(s).origin !== s.replace(/\/+$/, "")) throw new Error(`--view-script-src entries must be https origins like https://cdn.jsdelivr.net, got ${s}`);
}
for (const name of ["gateway", "paywall", "spy", "analyst", "chain-query"] as const) {
  if (!URL.canParse(flags[name]!)) throw new Error(`--${name} must be a URL, got ${flags[name]}`);
}
const PORT = Number(flags.port);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error(`--port must be 1 to 65535, got ${flags.port}`);
/** C4: the Host headers the guarded routes accept; by default exactly today's two. */
const ALLOWED_HOSTS = flags["allowed-hosts"] === undefined ? [`127.0.0.1:${PORT}`, `localhost:${PORT}`] : flags["allowed-hosts"].split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
for (const h of ALLOWED_HOSTS) if (!/^[a-z0-9.-]+:\d{1,5}$/.test(h)) throw new Error(`--allowed-hosts entries must be host:port, got ${h}`);
if (!ALLOWED_HOSTS.length) throw new Error("--allowed-hosts must list at least one host:port");
const API = MODE === "ui" ? flags.api!.replace(/\/+$/, "") : "";
const FORWARD_TIMEOUT_MS = flags["forward-timeout-sec"] === undefined ? Math.max(positiveInt("paid-timeout-sec"), positiveInt("crossask-timeout-sec")) * 1000 : (() => {
  const n = Number(flags["forward-timeout-sec"]);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--forward-timeout-sec must be a positive integer, got ${flags["forward-timeout-sec"]}`);
  return n * 1000;
})();
/** Request headers the ui forwards (the api needs nothing else), and the response headers it passes back: those this server sets. */
const FORWARD_IN = ["content-type", "payment-signature", "accept"];
const FORWARD_BACK = /^(content-type|cache-control|content-disposition|content-security-policy|x-content-type-options|referrer-policy|payment-required|payment-response|retry-after|x-chainaim-[a-z-]+)$/;
/** The registry's defaultModel, so the pick list follows config/local-models.json; chainaim/auto when it cannot be read. */
function registryDefault(path: string): string {
  try {
    const text = readFileSync(path, "utf8");
    const id = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).defaultModel;
    return typeof id === "string" && id ? id : "chainaim/auto";
  } catch {
    return "chainaim/auto";
  }
}
const DEFAULT_MODEL = (flags["default-model"] ?? registryDefault(flags["models-file"]!)).trim();
/** The output budget the last switch gave the gateway (config/generated/summary.json), or null outside the local-model mode. Read per call, so a switch needs no console restart. */
function generatedMaxOutput(): number | null {
  try {
    const text = readFileSync(flags["generated-summary"]!, "utf8");
    const n = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).maxOutputTokens;
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** C6: the gateway key file; the ui process holds no key. */
const KEY = MODE === "ui" ? "" : readFileSync(flags["gateway-key-file"]!, "utf8").trim();
const GATEWAY = flags.gateway!.replace(/\/+$/, "");
const PAYWALL = flags.paywall!.replace(/\/+$/, "");
const SPY = flags.spy!.replace(/\/+$/, "");
const PAGE = new URL("./index.html", import.meta.url);

const ANALYST = flags.analyst!.replace(/\/+$/, "");
const CHAIN_QUERY = flags["chain-query"]!.replace(/\/+$/, "");
const CHAIN_ROUTES = new Set(["healthz", "chains", "vaults", "loan-terms", "export"]);
const ANALYST_ROUTES = new Set(["profile", "recipe", "analyze", "status", "evidence", "verify", "relations", "sql", "pack-queries", "pack-run"]);
const ROUTES: Record<string, string> = { scan: "/v1/privacy/scan", mask: "/v1/privacy/mask", chat: "/v1/chat/completions" };

// "Open page" links: HTML pages found in model answers, kept in memory only, served sandboxed.
const views = new Map<string, { html: string; at: number }>();
function pruneViews(now = Date.now()): void {
  for (const [id, v] of views) if (now - v.at > VIEW_TTL_MS) views.delete(id);
  while (views.size > VIEW_MAX) views.delete(views.keys().next().value as string);
}
const VIEW_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VIEW_CSP = [
  "sandbox allow-scripts", // opaque origin: no access to this console's origin, storage or cookies
  "default-src 'none'",
  `script-src 'unsafe-inline' ${VIEW_SOURCES.join(" ")}`,
  `style-src 'unsafe-inline' ${VIEW_SOURCES.join(" ")} https://fonts.googleapis.com`,
  "font-src https://fonts.gstatic.com data:",
  "img-src data: blob:",
  "connect-src 'none'", // no fetch/XHR/WebSocket: the page cannot reach the console, the gateway or the internet
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");
const viewHeaders = { "content-security-policy": VIEW_CSP, "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "cache-control": "no-store" };

// ---- From data folder ------------------------------------------------------------------------------
// The page only NAMES a folder or file; this server decides. Only paths inside allowedRoots (the data config, re-read on
// every call so edits need no restart) are listed or read, after resolving links. Read-only; nothing is created.
/** The repository root: relative paths in the data config and in config/datasets.json are resolved against it. */
const REPO = fileURLToPath(new URL("../../", import.meta.url));
/**
 * Estimate-first offers (privateAI-design-34 ARCH-636): undefined without --paid-jobs on; start-up stops here when
 * estimate-first is allowed but config/cost-model.json is missing or invalid (desk.ps1 -Calibrate). OFFERS holds them.
 */
const OFFER_CONFIG = MODE === "ui" ? undefined : offerConfig(flags, PAID_JOBS !== undefined, (f) => readFileSync(isAbsolute(f) ? f : join(REPO, f), "utf8"));
/**
 * ChainAim's signer (privateAI-design-36 ARCH-662/663): every price, signed quote, mandate check, receipt and settlement
 * of a paid job goes through it. Remote: ca-control-signer, which prices with its own catalog, fees and cost model. Local:
 * the same code (packages/signer) in this process, with this console's keys, prices and cost model.
 */
const SIGNER: SignerApi | undefined = !PAID_JOBS || MODE === "ui" ? undefined : REMOTE_SIGNER ?? new SellerSigner({
  ...(AP2_CONFIG ? { ap2: AP2_CONFIG.signer } : {}),
  ...(RECEIPT_CONFIG ? { receipt: RECEIPT_CONFIG.signer } : {}),
  pricing: { prices: PAID_JOBS.prices, fees: PAID_JOBS.fees, round: PAID_JOBS.priceRound, ...(OFFER_CONFIG?.costModel ? { costModel: OFFER_CONFIG.costModel } : {}) },
  termsUrl: AP2_CONFIG?.termsUrl ?? "",
  ...(flags["mandate-keys"] !== undefined ? { mandates: {
    registry: parseMandateRegistry(JSON.parse(readFileSync(isAbsolute(flags["mandate-keys"]) ? flags["mandate-keys"] : join(REPO, flags["mandate-keys"]), "utf8").replace(/^\uFEFF/, ""))),
    aud: flags["mandate-audience"] ?? "chainaim", skewSec: 30, maxLifetimeSec: 900,
  } } : {}),
}).api();
if (REMOTE_SIGNER && (flags["mandate-keys"] !== undefined || flags["mandate-audience"] !== undefined)) throw new Error("--mandate-keys / --mandate-audience are for --signer local: ca-control-signer holds its own mandate key registry");
/**
 * ARCH-667: --ap2-mandate off|optional|required. optional (default with --ap2 on): a checkout mandate the buyer's agent
 * presents is verified by the signer before the run and refused when bad; a release without one runs as before (the tab 03
 * wallet pays as a person). required: a release without a mandate is refused. Either way a refusal settles nothing. With
 * no mandate key registry at the signer, optional turns off (said at start-up) and required stops start-up.
 */
const MANDATES_AT_SIGNER = REMOTE_KEYS ? REMOTE_KEYS.mandateAudience !== undefined : flags["mandate-keys"] !== undefined;
const MANDATE_MODE: "off" | "optional" | "required" = (() => {
  const raw = flags["ap2-mandate"] ?? (AP2_CONFIG ? "optional" : "off");
  if (raw !== "off" && raw !== "optional" && raw !== "required") throw new Error(`--ap2-mandate must be off, optional or required, got ${raw}`);
  if (raw !== "off" && !AP2_CONFIG) throw new Error("--ap2-mandate optional|required needs --ap2 on: a mandate permits a signed quote");
  if (raw === "required" && !MANDATES_AT_SIGNER) throw new Error("--ap2-mandate required: the signer has no mandate key registry (--mandate-keys on the signer)");
  return raw === "optional" && !MANDATES_AT_SIGNER ? "off" : raw;
})();
const OFFERS = OFFER_CONFIG?.costModel && PAID_JOBS ? new OfferStore(PAID_JOBS.max, Date.now, (o) => {
  JOB_FEED?.expired(o.offerId);
  console.log(JSON.stringify({ ts: new Date().toISOString(), route: "offer", event: "offer_expired", offerId: o.offerId }));
}) : undefined;
/**
 * privateAI-design-43 ARCH-721: one-round counter-offers; undefined with --counter off (the default). Start-up stops when
 * --counter on has no estimate-first offers or the ladder (config/counter-ladder.json) is missing or invalid.
 */
const COUNTER = MODE === "ui" ? undefined : counterConfig(flags, OFFERS !== undefined, (f) => readFileSync(isAbsolute(f) ? f : join(REPO, f), "utf8"));
/** Offers already countered (one counter per offer), until they expire. */
const COUNTERED = new Map<string, number>();
type DataConfig = { allowedRoots: string[]; defaultFolder: string; extensions: string[]; maxBytes: Record<string, number>; exclude: RegExp[]; excludeText: string[]; maxFiles: number; defaultMode: "whole" | "pick"; hideFolders: RegExp[] };
const fold = (p: string): string => (process.platform === "win32" ? p.toLowerCase() : p);
function within(child: string, root: string): boolean {
  const r = relative(fold(root), fold(child));
  return r === "" || (r !== ".." && !r.startsWith(".." + sep) && !isAbsolute(r));
}
const globToRe = (g: string): RegExp => new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "i");
function readDataConfig(): { config?: DataConfig; error?: string } {
  let raw: Record<string, any>;
  try {
    const text = readFileSync(flags["data-config"]!, "utf8");
    raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (e) {
    return { error: `Data folders are off: cannot read ${flags["data-config"]} (${(e as Error).message}). Copy config/data-sources.example.json to config/data-sources.json.` };
  }
  // A relative path is relative to the repository (e.g. "sample-data"), so one config works on every PC (DESIGN/xrplh-29).
  const roots: string[] = Array.isArray(raw.allowedRoots) ? raw.allowedRoots.filter((r: unknown) => typeof r === "string" && r.trim()).map((r: string) => resolve(REPO, r)) : [];
  if (!roots.length) return { error: "Data folders are off: allowedRoots must list at least one folder." };
  const defaultFolder = typeof raw.defaultFolder === "string" && raw.defaultFolder.trim() ? resolve(REPO, raw.defaultFolder) : roots[0];
  if (!roots.some((r) => within(defaultFolder, r))) return { error: `Data folders are off: defaultFolder ${defaultFolder} is not inside allowedRoots.` };
  const extensions: string[] = (Array.isArray(raw.extensions) ? raw.extensions : [".csv", ".tsv", ".txt", ".pdf"]).map((e: unknown) => String(e).toLowerCase());
  const maxBytes: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw.maxBytes ?? {})) if (Number.isInteger(v) && (v as number) > 0) maxBytes[k.toLowerCase()] = v as number;
  maxBytes["*"] ??= 2_000_000;
  const excludeText: string[] = Array.isArray(raw.exclude) ? raw.exclude.map(String) : [];
  const maxFiles = Number.isInteger(raw.maxFiles) && raw.maxFiles > 0 ? raw.maxFiles : 500;
  const defaultMode = raw.defaultMode === "pick" ? "pick" : "whole"; // whole: every file in the folder goes with each question
  const hideFolders = (Array.isArray(raw.hideFolders) ? raw.hideFolders.map(String) : ["_*"]).map(globToRe); // e.g. the analyst's _analyst work folder
  return { config: { allowedRoots: roots, defaultFolder, extensions, maxBytes, exclude: excludeText.map(globToRe), excludeText, maxFiles, defaultMode, hideFolders } };
}
class DataError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
/** The real location of a requested path, which must be inside an allowed root. The lexical check runs first, so a path outside the roots is refused without touching the disk; the real-path check then catches links that lead out. */
async function insideRoots(p: string, cfg: DataConfig): Promise<string> {
  if (!p || !isAbsolute(p)) throw new DataError(400, "path must be an absolute path");
  const asked = resolve(p);
  if (!cfg.allowedRoots.some((r) => within(asked, r))) throw new DataError(403, "outside the allowed data folders (allowedRoots in the data config)");
  let real: string;
  try { real = await realpath(asked); } catch { throw new DataError(404, `not found: ${asked}`); }
  for (const r of cfg.allowedRoots) {
    let rootReal: string;
    try { rootReal = await realpath(r); } catch { continue; }
    if (within(real, rootReal)) return real;
  }
  throw new DataError(403, "this path leads outside the allowed data folders (a link?)");
}
const usableName = (file: string, cfg: DataConfig): boolean => cfg.extensions.includes(extname(file).toLowerCase()) && !cfg.exclude.some((re) => re.test(basename(file)));
const capFor = (file: string, cfg: DataConfig): number => cfg.maxBytes[extname(file).toLowerCase()] ?? cfg.maxBytes["*"];
/** Only this console's own address may use the data routes, so a site reached through DNS rebinding cannot read files. */
const hostOk = (req: IncomingMessage): boolean => ALLOWED_HOSTS.includes((req.headers.host ?? "").toLowerCase());
const dataHeaders = { "x-content-type-options": "nosniff", "cache-control": "no-store" };
function dataJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", ...dataHeaders });
  res.end(JSON.stringify(body));
}
async function isFolder(p: string): Promise<boolean> { try { return (await stat(p)).isDirectory(); } catch { return false; } }

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://console");
    const [, api, name] = url.pathname.split("/");
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      if (!PAGE_PAID) { res.end(readFileSync(PAGE)); return; }
      const page = readFileSync(PAGE, "utf8");
      const at = page.lastIndexOf("</body>");
      res.end(at === -1 ? page + readFileSync(PAID_JOBS_FRAGMENT, "utf8") : page.slice(0, at) + readFileSync(PAID_JOBS_FRAGMENT, "utf8") + page.slice(at));
      return;
    }
    // ui mode, agent mode's run (ARCH-308): streamed through as it arrives, not buffered. Every other route is forward() below.
    if (MODE === "ui" && req.method === "POST" && url.pathname === "/agent/crossask") return forwardStream(req, res, url);
    // ui mode (C1/C3): the page and the two browser bundles are served below; every other request goes to the api, byte for byte.
    if (MODE === "ui" && !(req.method === "GET" && (api === "wallet.js" || api === "near-wallet.js") && !name)) return forward(req, res, url);
    // The pick list: every model the gateway serves now, plus this console's default.
    if (api === "gateway" && name === "models" && req.method === "GET") {
      const r = await fetch(GATEWAY + "/v1/models", { headers: { authorization: `Bearer ${KEY}` } });
      const body = (await r.json().catch(() => null)) as { data?: { id?: unknown; context_length?: unknown }[] } | null;
      const data = body?.data ?? [];
      const models = data.map((m) => m.id).filter((id): id is string => typeof id === "string");
      // Context length per model and the gateway's output budget let the page warn before a prompt is too big.
      const limits = Object.fromEntries(data.filter((m) => typeof m.id === "string" && typeof m.context_length === "number").map((m) => [m.id, m.context_length]));
      json(res, 200, { status: r.status, defaultModel: DEFAULT_MODEL, defaultAnswerModel: DEFAULT_ANSWER_MODEL || null, models, limits, maxOutputTokens: generatedMaxOutput() });
      return;
    }
    if (api === "gateway" && req.method === "POST" && ROUTES[name]) {
      const r = await fetch(GATEWAY + ROUTES[name], {
        method: "POST",
        headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
        body: await readBody(req),
      });
      const headers = Object.fromEntries([...r.headers].filter(([k]) => k.startsWith("x-chainaim")));
      json(res, 200, { status: r.status, headers, body: await r.json().catch(() => null) });
      return;
    }
    if (api === "paywall" && ROUTES[name]) {
      const body = name === "chat" ? { messages: [{ role: "user", content: "hi" }] } : { text: "hi" };
      const r = await fetch(PAYWALL + ROUTES[name], { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const header = r.headers.get("payment-required");
      const required = header ? JSON.parse(Buffer.from(header, "base64").toString("utf8")) : null;
      json(res, 200, {
        status: r.status,
        // One entry per rail the paywall offers (PAY_RAILS). XRPL writes RLUSD as a decimal; NEAR writes USDC in base units
        // (USDC_DECIMALS), so `price` is the decimal amount on both and `amountUnits` keeps NEAR's exact x402 amount.
        accepts: required?.accepts?.map((a: Record<string, any>) => {
          const near = typeof a.network === "string" && a.network.startsWith("near:");
          const units = near && typeof a.amount === "string" && /^\d+$/.test(a.amount) ? a.amount : undefined;
          return {
            rail: near ? "near" : "xrpl",
            price: near ? (units ? Number(microsToUsd(BigInt(units) * 10n ** BigInt(6 - USDC_DECIMALS))) : null) : Number(a.amount),
            ...(units ? { amountUnits: units } : {}),
            network: a.network, asset: a.asset, issuer: a.extra?.issuer, payTo: a.payTo, invoiceId: a.extra?.invoiceId,
          };
        }) ?? [],
        bazaar: Boolean(required?.extensions?.bazaar),
        body: header ? null : await r.json().catch(() => null),
      });
      return;
    }
    // Store one HTML page from an answer. JSON only, so a cross-site page cannot post here without a CORS preflight (which this server never grants).
    if (api === "view" && !name && req.method === "POST") {
      if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) return json(res, 415, { error: "send application/json" });
      const raw = await readBody(req);
      if (Buffer.byteLength(raw) > VIEW_MAX_BYTES + 1024) return json(res, 413, { error: `page over --view-max-bytes (${VIEW_MAX_BYTES})` });
      let html: unknown;
      try { html = JSON.parse(raw).html; } catch { return json(res, 400, { error: 'body must be JSON {"html": "..."}' }); }
      if (typeof html !== "string" || !html.includes("<")) return json(res, 400, { error: "html must be a string of HTML" });
      if (Buffer.byteLength(html) > VIEW_MAX_BYTES) return json(res, 413, { error: `page over --view-max-bytes (${VIEW_MAX_BYTES})` });
      pruneViews();
      const id = randomUUID();
      views.set(id, { html, at: Date.now() });
      pruneViews();
      json(res, 200, { url: `/view/${id}`, expiresInMin: VIEW_TTL_MS / 60_000 });
      return;
    }
    if (api === "view" && name && req.method === "GET") {
      pruneViews();
      const page = VIEW_ID.test(name) ? views.get(name) : undefined;
      if (!page) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8", ...viewHeaders });
        res.end("This page has expired or the test console was restarted. Ask the question again to get a new link.");
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", ...viewHeaders });
      res.end(page.html);
      return;
    }
    // From data folder: config, sub-folders, files, one file. GET only, read-only, confined to allowedRoots.
    if (api === "data" && req.method === "GET") {
      if (!hostOk(req)) return dataJson(res, 403, { error: `open the console as http://127.0.0.1:${PORT}` });
      const { config, error } = readDataConfig();
      if (name === "config") {
        return dataJson(res, 200, config
          ? { enabled: true, allowedRoots: config.allowedRoots, defaultFolder: config.defaultFolder, defaultExists: await isFolder(config.defaultFolder), extensions: config.extensions, maxBytes: config.maxBytes, exclude: config.excludeText, maxFiles: config.maxFiles, defaultMode: config.defaultMode }
          : { enabled: false, error });
      }
      if (!config) return dataJson(res, 503, { error });
      try {
        const p = url.searchParams.get("path") ?? "";
        if (name === "folders") {
          if (!p) return dataJson(res, 200, { path: "", parent: null, folders: config.allowedRoots.map((r) => ({ name: r, path: r })) });
          const dir = await insideRoots(p, config);
          if (!(await isFolder(dir))) throw new DataError(400, "not a folder");
          const folders = (await readdir(dir, { withFileTypes: true }))
            .filter((e) => e.isDirectory() && !e.isSymbolicLink() && !config.hideFolders.some((re) => re.test(e.name)))
            .map((e) => ({ name: e.name, path: join(dir, e.name) }))
            .sort((a, b) => a.name.localeCompare(b.name));
          const up = dirname(dir);
          return dataJson(res, 200, { path: dir, parent: up !== dir && config.allowedRoots.some((r) => within(up, r)) ? up : "", folders });
        }
        if (name === "files") {
          const dir = await insideRoots(p, config);
          if (!(await isFolder(dir))) throw new DataError(400, "not a folder");
          const entries = (await readdir(dir, { withFileTypes: true }))
            .filter((e) => e.isFile() && usableName(e.name, config))
            .sort((a, b) => a.name.localeCompare(b.name));
          const files = [];
          for (const e of entries.slice(0, config.maxFiles)) {
            const full = join(dir, e.name);
            const st = await stat(full);
            files.push({ name: e.name, path: full, ext: extname(e.name).toLowerCase(), size: st.size, modified: st.mtime.toISOString(), tooBig: st.size > capFor(e.name, config) });
          }
          return dataJson(res, 200, { path: dir, files, truncated: entries.length > config.maxFiles, maxFiles: config.maxFiles });
        }
        if (name === "file") {
          const file = await insideRoots(p, config);
          const st = await stat(file);
          if (!st.isFile()) throw new DataError(400, "not a file");
          if (!usableName(file, config)) throw new DataError(403, `not an allowed file type (${config.extensions.join(", ")}) or excluded`);
          if (st.size > capFor(file, config)) throw new DataError(413, `larger than the ${extname(file)} limit (${capFor(file, config)} bytes)`);
          res.writeHead(200, { "content-type": extname(file).toLowerCase() === ".pdf" ? "application/pdf" : "text/plain; charset=utf-8", ...dataHeaders });
          res.end(await readFile(file));
          return;
        }
        return dataJson(res, 404, { error: "unknown data route" });
      } catch (e) {
        if (e instanceof DataError) return dataJson(res, e.status, { error: e.message });
        throw e;
      }
    }
    // 03 Private chat + analysis: forwarded to the analyst (compute only, 127.0.0.1, no model calls). Known routes only, JSON only.
    if (api === "analyst") {
      if (!hostOk(req)) return dataJson(res, 403, { error: `open the console as http://127.0.0.1:${PORT}` });
      const route = name ?? "";
      if (!(req.method === "GET" ? route === "healthz" : req.method === "POST" && ANALYST_ROUTES.has(route))) return dataJson(res, 404, { error: "unknown analyst route" });
      if (req.method === "POST" && !/^application\/json\b/i.test(req.headers["content-type"] ?? "")) return dataJson(res, 415, { error: "send application/json" });
      let r: Response;
      try {
        r = await fetch(`${ANALYST}/${route}`, req.method === "POST" ? { method: "POST", headers: { "content-type": "application/json" }, body: await readBody(req) } : {});
      } catch {
        return dataJson(res, 503, { error: `the analyst is not running at ${ANALYST}: start the desk (.\\test-console\\desk.ps1, which runs it as ca-analyst)` });
      }
      res.writeHead(r.status, { "content-type": "application/json", ...dataHeaders });
      res.end(await r.text());
      return;
    }
    // Blockchain queries twisty: forwarded to chain-query (read-only, 127.0.0.1, holds no keys). Known routes only, GET only.
    if (api === "chain") {
      if (!hostOk(req)) return dataJson(res, 403, { error: `open the console as http://127.0.0.1:${PORT}` });
      const route = name ?? "";
      if (req.method !== "GET" || !CHAIN_ROUTES.has(route)) return dataJson(res, 404, { error: "unknown chain route" });
      let r: Response;
      try { r = await fetch(`${CHAIN_QUERY}/${route}${url.search}`, { signal: AbortSignal.timeout(60_000) }); }
      catch { return dataJson(res, 503, { error: `chain-query is not running at ${CHAIN_QUERY}: start the desk (.\\test-console\\desk.ps1, which runs it as ca-chain-query)` }); }
      const disposition = r.headers.get("content-disposition");
      res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json", ...(disposition ? { "content-disposition": disposition } : {}), ...dataHeaders });
      res.end(Buffer.from(await r.arrayBuffer()));
      return;
    }
    // Datasets for tab 03 (config/datasets.json, DESIGN/xrplh-29): each dataset's folder under the chosen root, whether it exists,
    // its data files and (for subfolders) the sets inside. Only folders inside allowedRoots are listed. GET only, read-only.
    if (api === "datasets" && !name && req.method === "GET") {
      if (!hostOk(req)) return dataJson(res, 403, { error: `open the console as http://127.0.0.1:${PORT}` });
      const { config, error } = readDataConfig();
      if (!config) return dataJson(res, 503, { error });
      let reg: { roots: Record<string, string>; datasets: Record<string, any>[] };
      try { const t = readFileSync(join(REPO, "config", "datasets.json"), "utf8"); reg = JSON.parse(t.charCodeAt(0) === 0xfeff ? t.slice(1) : t); }
      catch (e) { return dataJson(res, 503, { error: `cannot read config/datasets.json: ${(e as Error).message}` }); }
      const rootId = url.searchParams.get("root") ?? "samples";
      if (!reg.roots?.[rootId]) return dataJson(res, 400, { error: `unknown root ${rootId} (known: ${Object.keys(reg.roots ?? {}).join(", ")})` });
      const root = resolve(REPO, DATASET_ROOTS[rootId] ?? reg.roots[rootId]);
      const allowed = config.allowedRoots.some((r) => within(root, r));
      const isData = (n: string) => config.extensions.includes(extname(n).toLowerCase()) && !config.exclude.some((re) => re.test(n));
      const filesIn = async (dir: string) => { try { return (await readdir(dir, { withFileTypes: true })).filter((e) => e.isFile() && isData(e.name)).map((e) => e.name).sort(); } catch { return null; } };
      const out = [];
      for (const d of reg.datasets ?? []) {
        const folder = resolve(root, d.folder);
        const ok = allowed && within(folder, root);
        const files = ok ? await filesIn(folder) : null;
        let sets: { name: string; files: string[] }[] = [];
        if (ok && d.subfolders && files !== null) {
          const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
            let ents; try { ents = await readdir(dir, { withFileTypes: true }); } catch { return; }
            for (const e of ents.filter((x) => x.isDirectory() && !x.isSymbolicLink() && !config.hideFolders.some((re) => re.test(x.name))).sort((a, b) => a.name.localeCompare(b.name))) {
              const sub = join(dir, e.name), r = rel ? `${rel}/${e.name}` : e.name, f = await filesIn(sub);
              if (f && f.length) sets.push({ name: r, files: f });
              if (depth < 2) await walk(sub, r, depth + 1);
            }
          };
          await walk(folder, "", 1);
        }
        out.push({ id: d.id, label: d.label, description: d.description, engine: d.engine, pack: d.pack ?? null, templates: Array.isArray(d.templates) ? d.templates : [],
          templatesFrom: d.templates && !Array.isArray(d.templates) ? d.templates.from : null, defaultSubfolder: d.defaultSubfolder ?? null, setLabels: d.setLabels ?? {}, fileKinds: d.fileKinds ?? {},
          folder, exists: files !== null, allowed: ok, files: files ?? [], sets });
      }
      return dataJson(res, 200, { root: rootId, rootPath: root, rootAllowed: allowed, roots: Object.keys(reg.roots), datasets: out });
    }
    // Domain-pack question (DESIGN/xrplh-29): the analyst builds the fact sheet, the model rewords it through the gateway (masked),
    // the analyst checks every figure; a failed check shows the computed facts instead of the answer.
    if (api === "packask" && !name && req.method === "POST") {
      if (!hostOk(req)) return dataJson(res, 403, { error: `open the console as http://127.0.0.1:${PORT}` });
      let b: Record<string, unknown>;
      try { b = JSON.parse(await readBody(req)); } catch { return dataJson(res, 400, { error: "body must be JSON" }); }
      const model = typeof b.model === "string" && b.model ? b.model : DEFAULT_MODEL;
      if (!/^[\w.-]+\/[\w.:-]+$/.test(model)) return dataJson(res, 400, { error: `model must look like provider/name, got ${model}` });
      if (typeof b.folder !== "string" || typeof b.id !== "string") return dataJson(res, 400, { error: "folder and id are required" });
      const post = async (route: string, body: unknown) => {
        let r: Response;
        try { r = await fetch(`${ANALYST}/${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(CROSSASK_TIMEOUT_MS) }); }
        catch { throw new Error(`the analyst is not running at ${ANALYST}: start the desk (.\\test-console\\desk.ps1, which runs it as ca-analyst)`); }
        const j = await r.json() as Record<string, any>;
        if (!r.ok) throw new Error(j.error ?? `analyst HTTP ${r.status}`);
        return j;
      };
      try {
        const run = await post("pack-run", { folder: b.folder, pack: b.pack, ids: [b.id] });
        const q = run.questions?.[0];
        if (!q) return dataJson(res, 400, { error: `${b.id} is not a model question in the pack's query bank` });
        const t0 = Date.now();
        const reply = await gatewayChat({ url: GATEWAY, key: KEY, timeoutMs: CROSSASK_TIMEOUT_MS })([{ role: "system", content: run.system }, { role: "user", content: `${q.question}\n\n${q.sheet}` }], model);
        const seconds = Math.round((Date.now() - t0) / 100) / 10;
        const answer = reply.text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
        const check = await post("pack-verify", { runId: run.runId, id: b.id, answer: reply.text });
        return dataJson(res, 200, { id: q.id, title: q.title, question: q.question, files: run.files, facts: q.facts, sheetChars: q.sheet.length,
          served: { model: reply.model ?? null, zone: reply.zone ?? null, seconds }, answer, check: { ok: check.ok, checked: check.checked, problems: check.problems }, computed: check.computed });
      } catch (e) {
        return dataJson(res, 502, { error: (e as Error).message });
      }
    }
    // Ask across files: relations and query on this PC (analyst), the model through the gateway (headers first, the result only with phrase llm).
    if (api === "crossask" && !name && req.method === "POST") {
      if (!hostOk(req)) return dataJson(res, 403, { error: `open the console as http://127.0.0.1:${PORT}` });
      let b: Record<string, unknown>;
      try { b = JSON.parse(await readBody(req)); } catch { return dataJson(res, 400, { error: "body must be JSON" }); }
      const model = typeof b.model === "string" && b.model ? b.model : DEFAULT_MODEL;
      if (!/^[\w.-]+\/[\w.:-]+$/.test(model)) return dataJson(res, 400, { error: `model must look like provider/name, got ${model}` });
      if (typeof b.folder !== "string" || typeof b.question !== "string" || !b.question.trim()) return dataJson(res, 400, { error: "folder and question are required" });
      const phrase = b.phrase === "none" ? "none" : "llm";
      const answerModel = typeof b.answerModel === "string" && b.answerModel ? b.answerModel : undefined;
      if (answerModel && !/^[\w.-]+\/[\w.:-]+$/.test(answerModel)) return dataJson(res, 400, { error: `answerModel must look like provider/name, got ${answerModel}` });
      const userSql = typeof b.sql === "string" && b.sql.trim() ? b.sql : undefined;
      const runIn = { folder: b.folder, question: b.question, model, answerModel, phrase, userSql: userSql !== undefined };
      const started = Date.now();
      try {
        // timings: true (privateAI-design-34 ARCH-635, desk.ps1 -Calibrate): the step timings in ms (ARCH-204) come back with the
        // result. Whole milliseconds per step, no data; off unless asked, so the page's answer is as before.
        const out = await crossAsk({ folder: b.folder, question: b.question, model, answerModel, phrase, sqlRetries: CROSSASK_RETRIES, answerMaxRows: CROSSASK_ROWS, maxPromptChars: CROSSASK_MAX_PROMPT, answerMaxPromptChars: CROSSASK_ANSWER_MAX_PROMPT, retryErrorMaxChars: CROSSASK_ERROR_CHARS, sql: userSql, checkSmallNumbers: CHECK_SMALL },
          { analyst: analystClient(ANALYST, CROSSASK_TIMEOUT_MS), chat: gatewayChat({ url: GATEWAY, key: KEY, timeoutMs: CROSSASK_TIMEOUT_MS }), ...(b.timings === true ? { clock: () => performance.now() } : {}) });
        return dataJson(res, 200, { ...out, runLog: RUN_LOG.write(runIn, out, undefined, Date.now() - started) });
      } catch (e) {
        return dataJson(res, 502, { error: (e as Error).message, runLog: RUN_LOG.write(runIn, null, (e as Error).message, Date.now() - started) });
      }
    }
    // ARCH-628: the UCP business profile (capabilities and the AP2 signing key); 404 with --ap2 off.
    if (api === ".well-known" && name === "ucp" && req.method === "GET" && url.pathname === "/.well-known/ucp") {
      if (!hostOk(req)) return dataJson(res, 403, { error: `open the console as http://127.0.0.1:${PORT}` });
      if (!AP2_CONFIG) return dataJson(res, 404, { error: "AP2 is off: start the console with --ap2 on" });
      return dataJson(res, 200, ucpProfile(AP2_CONFIG));
    }
    // ---- Paid jobs on tab 03 (ARCH-104, ARCH-112): only with --paid-jobs on -----------------------------------------
    // ARCH-411: one job's model attestation (ids, hashes, addresses, booleans, reasons); 404 when off or unknown.
    if (PAID_JOBS && api === "jobs" && req.method === "GET" && /^\/jobs\/[0-9a-f]{32}\/attestation$/.test(url.pathname)) {
      if (!hostOk(req)) return dataJson(res, 403, { error: `open the console as http://127.0.0.1:${PORT}` });
      if (!ATTEST) return dataJson(res, 404, { error: "model attestation is off: start the console with --attest-url" });
      const a = ATTEST.get(url.pathname.split("/")[2]);
      if (!a) return dataJson(res, 404, { error: "no attestation for this job" });
      return dataJson(res, 200, a);
    }
    if (PAID_JOBS && JOBS && api === "jobs" && name === "config" && req.method === "GET") {
      if (!hostOk(req)) return dataJson(res, 403, { error: `open the console as http://127.0.0.1:${PORT}` });
      return dataJson(res, 200, { wallet: NEAR_WALLET, walletName: NEAR_WALLETS[NEAR_WALLET!].name, ttlMin: PAID_JOBS.ttlMs / 60_000, defaultPayer: DEFAULT_PAYER, attest: ATTEST ? { pollMs: ATTEST_POLL_MS, pollMax: ATTEST_POLL_MAX } : null, receipts: RECEIPTS !== undefined, observer: OBSERVER !== undefined,
        // ARCH-663/667: where ChainAim's signer runs (its URL only, never its key) and whether checkout mandates are checked.
        signer: SIGNER_CLIENT?.mode === "remote" ? { mode: "remote", url: SIGNER_CLIENT.url } : { mode: "local" }, mandates: MANDATE_MODE,
        // ARCH-642: the modes the pay box may offer and the default (estimate-first needs the cost model: OFFERS).
        offers: OFFER_CONFIG ? { mode: OFFERS ? OFFER_CONFIG.mode : "run-hold", modes: OFFER_CONFIG.modes.filter((m) => m === "run-hold" || OFFERS) } : { mode: "run-hold", modes: ["run-hold"] } });
    }
    // ARCH-615: one job's signed receipt and the key to check it with; 404 when receipts are off or the job has none (yet).
    if (PAID_JOBS && api === "jobs" && req.method === "GET" && /^\/jobs\/[0-9a-f]{32}\/receipt$/.test(url.pathname)) {
      if (!hostOk(req)) return dataJson(res, 403, { error: `open the console as http://127.0.0.1:${PORT}` });
      if (!RECEIPTS) return dataJson(res, 404, { error: "receipts are off: start the console with --receipts on" });
      const receipt = RECEIPTS.get(url.pathname.split("/")[2]);
      if (!receipt) return dataJson(res, 404, { error: "no receipt for this job: it is made once the job is paid and released" });
      // ARCH-631: with the signed quote the receipt points at (--ap2 on), so one download checks both.
      const quote = RECEIPTS.getQuote(url.pathname.split("/")[2]);
      // ARCH-668: and the checkout mandate the receipt records, so verify-receipt re-checks the buyer's signature too.
      const mandateToken = RECEIPTS.getMandate(url.pathname.split("/")[2]);
      // privateAI-design-40 ARCH-692: and the attestation bundle the receipt's evidenceBundleSha256 commits to.
      const attestation = RECEIPTS.getAttestation(url.pathname.split("/")[2]);
      return dataJson(res, 200, { receipt, publicKeyPem: RECEIPTS.publicKeyPem(), ...(quote ? { ap2: quote } : {}), ...(mandateToken ? { mandate: mandateToken } : {}), ...(attestation ? { attestation } : {}) });
    }
    // ARCH-650: what anyone reading NEAR learns about this job, from public RPC (no key; only the transaction hash and
    // the payer account, both already public, are sent).
    // privateAI-design-41 ARCH-699: "download what was sent": the exact bytes one model call of a held paid job sent, for the
    // run's owner on this PC (127.0.0.1 only); never logged, never sent to the paywall or the signer.
    if (PAID_JOBS && SENT && api === "jobs" && req.method === "GET" && /^\/jobs\/[0-9a-f]{32}\/egress\/\d{1,2}$/.test(url.pathname)) {
      if (!hostOk(req)) return dataJson(res, 403, { error: `open the console as http://127.0.0.1:${PORT}` });
      const [, , jobId, , call] = url.pathname.split("/");
      const bytes = SENT.get(jobId, Number(call));
      if (!bytes) return dataJson(res, 404, { error: "nothing kept for this call: the job expired, the gateway runs without --expose-egress, or the bytes could not be fetched" });
      res.writeHead(200, { "content-type": "application/json", "content-length": bytes.length, "cache-control": "no-store", "content-disposition": `attachment; filename="chainaim-sent-${jobId}-${call}.json"` });
      res.end(bytes);
      return;
    }
    if (PAID_JOBS && api === "jobs" && req.method === "GET" && /^\/jobs\/[0-9a-f]{32}\/observer$/.test(url.pathname)) {
      if (!hostOk(req)) return dataJson(res, 403, { error: `open the console as http://127.0.0.1:${PORT}` });
      if (!RECEIPTS || !OBSERVER) return dataJson(res, 404, { error: "the observer view is off: it needs --receipts on and --observer on" });
      const receipt = RECEIPTS.get(url.pathname.split("/")[2]);
      if (!receipt) return dataJson(res, 404, { error: "no receipt for this job: it is made once the job is paid and released" });
      if (!receipt.settlement) return dataJson(res, 409, { error: "the settlement is not attached to the receipt yet" });
      try {
        // privateAI-design-41 ARCH-699: what left the PC, as counts and hashes only (no host or zone in this view).
        const egress = receipt.body.egress?.map((e) => ({ call: e.call, sentSha256: e.sentSha256, sentBytes: e.sentBytes, masked: e.masked }));
        return dataJson(res, 200, { ...(await observe(receipt.settlement, OBSERVER)), ...(egress ? { egress } : {}) });
      } catch (e) {
        const status = e instanceof ObserverError ? e.status : 502;
        return dataJson(res, status, { error: (e as Error).message });
      }
    }
    // Run, meter, quote, hold, register: the page gets the cost and the job id, never the result.
    // ARCH-636: an estimate-first offer. Sizes only: the folder's data files are stat()ed, never opened; no model,
    // analyst or gateway call. The question is held with the offer until the paid release runs it (runOffer).
    // privateAI-design-42 ARCH-711: the pre-payment re-check of an estimate-first offer (the agent's --re-estimate on):
    // its folder re-sized now by the paid run's own rule (offerSize, heldLimits). Reads sizes only; runs, signs and
    // settles nothing. 200 = still within the estimate; 409 estimate_stale = grown or gained files (estimate it again);
    // 404 = no such offer (expired, already run, or never made); 422 = the held quote cannot be checked.
    if (PAID_JOBS && OFFERS && OFFER_CONFIG && api === "offers" && name && url.pathname.split("/")[3] === "recheck" && url.pathname.split("/").length === 4 && req.method === "GET") {
      if (!hostOk(req)) return dataJson(res, 403, { error: `open the console as http://127.0.0.1:${PORT}` });
      if (!/^[0-9a-f]{32}$/.test(name)) return dataJson(res, 400, { error: "the offer id must be 32 lowercase hex characters" });
      const o = OFFERS.get(name);
      if (!o) return dataJson(res, 404, { error: "no such offer (it expired, already ran, or was never made)" });
      const held = heldLimits(o);
      if ("refused" in held) return dataJson(res, held.refused.status, held.refused.body);
      const sized = await offerSize(o, held.limits);
      // Ids and sizes only: never the folder, question or model.
      if ("refused" in sized) return dataJson(res, sized.refused.status, sized.refused.body);
      console.log(JSON.stringify({ ts: new Date().toISOString(), route: "offer", event: "offer_rechecked", offerId: name, ok: sized.grown === null, files: sized.size.files, bytes: sized.size.totalBytes }));
      if (sized.grown) return dataJson(res, 409, { error: sized.grown, code: "estimate_stale", files: sized.size.files, totalBytes: sized.size.totalBytes });
      const bound = held.limits ?? { files: o.basis.files, totalBytes: o.basis.totalBytes, sizeTolerancePct: OFFER_CONFIG.tolerancePct };
      return dataJson(res, 200, { jobId: name, ok: true, files: sized.size.files, totalBytes: sized.size.totalBytes, estimated: { files: bound.files, totalBytes: bound.totalBytes, sizeTolerancePct: bound.sizeTolerancePct }, signedLimits: held.limits !== undefined });
    }
    // privateAI-design-43 ARCH-721: one counter round, before any payment. The buyer names its ceiling and the ladder steps
    // it accepts; the ladder (config/counter-ladder.json) is walked from the held offer's basis, each smaller basis priced by
    // ChainAim's signer, and the first price at or below the ceiling becomes a NEW offer (new job id, paywall registration,
    // signed quote whose limits are the smaller basis), made by the same code as POST /offers. No fit: 422 no_fit, nothing
    // registered or signed. The first offer stays payable until it expires. Ids, amounts and step names only in the log.
    if (PAID_JOBS && JOBS && OFFERS && OFFER_CONFIG?.costModel && api === "offers" && name && url.pathname.split("/")[3] === "counter" && url.pathname.split("/").length === 4 && req.method === "POST") {
      if (!hostOk(req)) return dataJson(res, 403, { error: `open the console as http://127.0.0.1:${PORT}` });
      if (!COUNTER) return dataJson(res, 404, { error: "this console makes no counter-offers (--counter off)", code: "counter_off" });
      if (!/^[0-9a-f]{32}$/.test(name)) return dataJson(res, 400, { error: "the offer id must be 32 lowercase hex characters" });
      let b: Record<string, unknown>;
      try { b = JSON.parse(await readBody(req)); } catch { return dataJson(res, 400, { error: "body must be JSON" }); }
      let ceiling: bigint;
      try { ceiling = ceilingMicro(b.maxPriceUsd); } catch (e) { return dataJson(res, 400, { error: (e as Error).message }); }
      if (!Array.isArray(b.accept) || b.accept.length > 10 || b.accept.some((x) => typeof x !== "string" || !/^[A-Za-z]{1,40}$/.test(x))) return dataJson(res, 400, { error: "accept must list the step names the buyer accepts (at most 10), e.g. [\"answerMaxRows\",\"maxTokens\"]" });
      const o = OFFERS.get(name);
      if (!o) return dataJson(res, 404, { error: "no such offer (it expired, already ran, or was never made)" });
      const now = Date.now();
      for (const [id, exp] of COUNTERED) if (exp <= now) COUNTERED.delete(id);
      if ((o.round ?? 0) >= COUNTER.maxRounds) return dataJson(res, 409, { error: `this offer is already a counter-offer; one round only (--counter-max-rounds ${COUNTER.maxRounds})`, code: "round_used" });
      if (COUNTERED.has(o.offerId)) return dataJson(res, 409, { error: "this offer was already countered (one counter per offer)", code: "round_used" });
      if (ceiling >= usdMicroCeil(o.quote.totalUsd, "the offer's price")) return dataJson(res, 400, { error: `maxPriceUsd ${b.maxPriceUsd} is not below the offer's price ${o.quote.totalUsd}: pay the offer as it is` });
      if (JOBS.full() || OFFERS.full()) return dataJson(res, 503, { error: `${PAID_JOBS.max} paid jobs are open (--job-max); pay or let one expire first` });
      const sellable = (bs: CrossaskBasis): boolean => (!o.attested || attestedRoute(bs, PAID_JOBS.attestable)) && (PAY_ONLY_ATTESTED?.mode !== "verified" || attestedRoute(bs, PAID_JOBS.attestable));
      let fit;
      try { fit = await fitCounter(o.basis, COUNTER.ladder, { maxPriceMicro: ceiling, accept: new Set(b.accept as string[]), price: (bs) => SIGNER!.price({ kind: "offer", basis: bs }), allowed: sellable }); }
      catch (e) { return dataJson(res, e instanceof SignerUnavailable ? 502 : 422, { error: `no price for a smaller job, so nothing can be paid: ${(e as Error).message}` }); }
      COUNTERED.set(o.offerId, o.expiresAt);
      if ("noFit" in fit) {
        console.log(JSON.stringify({ ts: new Date().toISOString(), route: "offer", event: "offer_counter_no_fit", offerId: o.offerId, maxPriceUsd: b.maxPriceUsd, cheapestUsd: fit.noFit.cheapestUsd, tried: fit.noFit.tried }));
        return dataJson(res, 422, { error: fit.noFit.cheapestUsd === null ? "no smaller job the buyer accepts can be made from this offer" : `the smallest job the buyer accepts still costs ${fit.noFit.cheapestUsd} USD, above ${b.maxPriceUsd}`, code: "no_fit", cheapestUsd: fit.noFit.cheapestUsd, counterOf: o.offerId });
      }
      const made = await makeOffer(o.request, fit.fit.basis, fit.fit.quote, { counterOf: o.counterOf ?? o.offerId, reduced: [...(o.reduced ?? []), ...fit.fit.reduced], round: (o.round ?? 0) + 1 });
      if (made.status !== 200) COUNTERED.delete(o.offerId);
      return dataJson(res, made.status, made.body);
    }
    if (PAID_JOBS && JOBS && OFFERS && OFFER_CONFIG?.costModel && api === "offers" && !name && req.method === "POST") {
      if (!hostOk(req)) return dataJson(res, 403, { error: `open the console as http://127.0.0.1:${PORT}` });
      let b: Record<string, unknown>;
      try { b = JSON.parse(await readBody(req)); } catch { return dataJson(res, 400, { error: "body must be JSON" }); }
      if (b.kind !== undefined && b.kind !== "crossask") return dataJson(res, 400, { error: "kind must be crossask (tabs 01 and 02 offers come later: design-34 ARCH-640/641)" });
      const model = typeof b.model === "string" && b.model ? b.model : DEFAULT_MODEL;
      if (!/^[\w.-]+\/[\w.:-]+$/.test(model)) return dataJson(res, 400, { error: `model must look like provider/name, got ${model}` });
      if (typeof b.folder !== "string" || typeof b.question !== "string" || !b.question.trim()) return dataJson(res, 400, { error: "folder and question are required" });
      const phrase = b.phrase === "none" ? "none" : "llm";
      const answerModel = typeof b.answerModel === "string" && b.answerModel ? b.answerModel : undefined;
      if (answerModel && !/^[\w.-]+\/[\w.:-]+$/.test(answerModel)) return dataJson(res, 400, { error: `answerModel must look like provider/name, got ${answerModel}` });
      if (JOBS.full() || OFFERS.full()) return dataJson(res, 503, { error: `${PAID_JOBS.max} paid jobs are open (--job-max); pay or let one expire first` });
      const { config, error } = readDataConfig();
      if (!config) return dataJson(res, 422, { error: `no estimate can be made: ${error}` });
      let folder: string, size: { files: number; totalBytes: number };
      try {
        folder = await insideRoots(b.folder, config);
        size = await folderSize(folder, (n) => usableName(n, config), config.maxFiles);
      } catch (e) { return dataJson(res, 422, { error: `no estimate can be made: ${(e as Error).message}` }); }
      if (!size.files) return dataJson(res, 422, { error: "no estimate can be made: the folder has no data files" });
      const request: OfferRequest = { folder, question: b.question, model, ...(answerModel ? { answerModel } : {}), phrase, ...(typeof b.sql === "string" && b.sql.trim() ? { sql: b.sql } : {}), datasetId: b.datasetId, templateLabel: b.templateLabel };
      let basis, quote;
      try {
        basis = crossaskBasis(request, size, { maxPromptChars: CROSSASK_MAX_PROMPT, answerMaxPromptChars: CROSSASK_ANSWER_MAX_PROMPT, maxTokens: OFFER_CONFIG.maxTokens, sqlRetries: CROSSASK_RETRIES, answerMaxRows: CROSSASK_ROWS });
        // ARCH-662: priced by ChainAim's signer from these sizes and limits, never by this process's own arithmetic.
        quote = await SIGNER!.price({ kind: "offer", basis });
      } catch (e) { return dataJson(res, e instanceof SignerUnavailable ? 502 : 422, { error: `no price for this job, so nothing can be paid: ${(e as Error).message}` }); }
      const made = await makeOffer(request, basis, quote);
      return dataJson(res, made.status, made.body);
    }
    if (PAID_JOBS && JOBS && api === "jobs" && name === "crossask" && req.method === "POST") {
      if (!hostOk(req)) return dataJson(res, 403, { error: `open the console as http://127.0.0.1:${PORT}` });
      let b: Record<string, unknown>;
      try { b = JSON.parse(await readBody(req)); } catch { return dataJson(res, 400, { error: "body must be JSON" }); }
      const model = typeof b.model === "string" && b.model ? b.model : DEFAULT_MODEL;
      if (!/^[\w.-]+\/[\w.:-]+$/.test(model)) return dataJson(res, 400, { error: `model must look like provider/name, got ${model}` });
      if (typeof b.folder !== "string" || typeof b.question !== "string" || !b.question.trim()) return dataJson(res, 400, { error: "folder and question are required" });
      const phrase = b.phrase === "none" ? "none" : "llm";
      const answerModel = typeof b.answerModel === "string" && b.answerModel ? b.answerModel : undefined;
      if (answerModel && !/^[\w.-]+\/[\w.:-]+$/.test(answerModel)) return dataJson(res, 400, { error: `answerModel must look like provider/name, got ${answerModel}` });
      if (JOBS.full()) return dataJson(res, 503, { error: `${PAID_JOBS.max} paid jobs are open (--job-max); pay or let one expire first` });
      let out;
      const sentBySha = new Map<string, Uint8Array>(); // ARCH-699, as in runOffer
      try {
        out = await crossAsk({ folder: b.folder, question: b.question, model, answerModel, phrase, sqlRetries: CROSSASK_RETRIES, answerMaxRows: CROSSASK_ROWS, maxPromptChars: CROSSASK_MAX_PROMPT, answerMaxPromptChars: CROSSASK_ANSWER_MAX_PROMPT, retryErrorMaxChars: CROSSASK_ERROR_CHARS, sql: typeof b.sql === "string" && b.sql.trim() ? b.sql : undefined, checkSmallNumbers: CHECK_SMALL },
          { analyst: analystClient(ANALYST, CROSSASK_TIMEOUT_MS), chat: gatewayChat({ url: GATEWAY, key: KEY, timeoutMs: CROSSASK_TIMEOUT_MS, onSent: (sha, bytes) => sentBySha.set(sha, bytes) }), ...(JOB_FEED ? { clock: () => performance.now() } : {}) });
      } catch (e) {
        return dataJson(res, 502, { error: `the job did not run, so nothing can be paid: ${(e as Error).message}` });
      }
      // A job that did not produce a result is not sold (the free /crossask shows why).
      if (out.error || !out.result) return dataJson(res, 422, { error: "the job did not produce a result, so nothing can be paid; run it unpaid to see why" });
      // privateAI-design-39 ARCH-687: verified = ca-attest's verdict before anything is priced or asked for (nothing paid yet).
      const jobId = JOBS.newJobId();
      if (PAY_ONLY_ATTESTED?.mode === "verified") {
        const a = await ATTEST!.verifyNow(jobId, out.served, PAY_ONLY_ATTESTED.deadlineMs);
        if (!privacyProven(a, out.served)) {
          console.log(JSON.stringify({ ts: new Date().toISOString(), route: "paid-job", event: "attestation_not_proven", jobId, summary: a.summary, calls: out.served.length }));
          return dataJson(res, 422, notProven(a.summary, true));
        }
      }
      let quote;
      const meter = meterOf(out.served);
      // ARCH-662: the signer prices the metered calls (model ids and token counts only).
      try { quote = await SIGNER!.price({ kind: "metered", meter }); }
      catch (e) { return dataJson(res, e instanceof SignerUnavailable ? 502 : 422, { error: `no price for this job, so nothing can be paid: ${(e as Error).message}` }); }
      // ARCH-613: the files the job read, hashed now (before registering), so the receipt commits to the data as it was run.
      // A job no receipt can cover is not sold while receipts are on.
      let receiptFiles;
      let resolvedFolder = "";
      if (RECEIPT_CONFIG) {
        const { config, error } = readDataConfig();
        if (!config) return dataJson(res, 422, { error: `no receipt can be made, so nothing can be paid: ${error}` });
        if (typeof out.sql !== "string" || !out.sql) return dataJson(res, 422, { error: "no receipt can be made (the job has no query), so nothing can be paid" });
        try {
          resolvedFolder = await insideRoots(b.folder, config);
          receiptFiles = await datasetFiles(resolvedFolder, RECEIPT_CONFIG.maxFiles, (n) => config.hideFolders.some((re) => re.test(n)));
        } catch (e) {
          return dataJson(res, 422, { error: `no receipt can be made, so nothing can be paid: ${(e as Error).message}` });
        }
      }
      const expiresAt = JOBS.expiryFromNow();
      let offer;
      try { offer = await registerJob(PAYWALL, PAID_JOBS.key, { jobId, amount: quote.amount, expiresAt }); }
      catch (e) { return dataJson(res, 502, { error: (e as Error).message }); }
      // The held (and later released) result is what it was before the job feed: the step timings are the feed's only.
      const { timings: _timings, ...result } = out;
      // ARCH-644: the route names the models this run called, from its own steps (an exact query calls no query model).
      const route = routeOf(calledModels({ model, answerModel }, out.sentToModel));
      // --pricing after: the quote is the job's own meter, so the quote id is the job id and the actual cost is the price.
      const receiptHold: ReceiptHold | undefined = receiptFiles ? {
        network: offer.network, quoteId: jobId, route, datasetId: datasetIdOf(b.datasetId, resolvedFolder),
        ...(templateLabelOf(b.templateLabel) ? { templateLabel: templateLabelOf(b.templateLabel) } : {}), files: receiptFiles, sql: out.sql as string,
        priceUsd: quote.totalUsd, actualUsd: quote.totalUsd,
        // ARCH-690: priced from its own meter, so no overrun by construction.
        economics: economicsOf(quote.totalUsd, quote.totalUsd, quote.breakdown),
        quoteBasis: { pricing: "after", phrase, userSql: typeof b.sql === "string" && b.sql.trim() !== "", sqlRetries: CROSSASK_RETRIES, answerMaxRows: CROSSASK_ROWS, maxPromptChars: CROSSASK_MAX_PROMPT, calls: out.served.length },
      } : undefined;
      // ARCH-628: the quote as a signed UCP checkout, only with --ap2 on. A quote that cannot be signed is not sold.
      let ap2Hold: Ap2Hold | undefined;
      if (AP2_CONFIG) {
        try {
          ap2Hold = holdOf(await SIGNER!.signQuote({ jobId, expiresAt, offer, pricing: { kind: "metered", meter }, route,
            ...(receiptHold ? { datasetId: receiptHold.datasetId, filesRoot: filesRoot(receiptHold.files) } : {}) }));
        } catch (e) {
          return dataJson(res, signFailStatus(e), { error: `the quote could not be signed, so nothing can be paid: ${(e as Error).message}` });
        }
      }
      for (const line of egressRefusedLines("paid-job", jobId, out.served)) console.log(line);
      SENT?.hold(jobId, sentOf(out.served, sentBySha), expiresAt);
      JOBS.hold({ jobId, result, amount: quote.amount, breakdown: quote.breakdown, expiresAt, ...(receiptHold ? { receipt: receiptHold } : {}), ...(ap2Hold ? { ap2: ap2Hold } : {}) });
      JOB_FEED?.quoted({ jobId, network: offer.network, expiresAt, out, quote, ...(ap2Hold ? { ap2: { kid: ap2Hold.kid, merchantAuthSha256: ap2Hold.merchantAuthSha256 } } : {}) });
      // ARCH-411: in the background; the quote below is returned without waiting for it. ARCH-687: in verified mode the
      // verdict was awaited above and is stored; the feed gets it now that the job is quoted.
      if (PAY_ONLY_ATTESTED?.mode === "verified") ATTEST!.announce(jobId);
      else ATTEST?.start(jobId, out.served);
      // Ids and amounts only.
      console.log(JSON.stringify({ ts: new Date().toISOString(), route: "paid-job", event: "job_quoted", jobId, amount: quote.amount, calls: quote.breakdown.calls.length }));
      // route / attested (privateAI-design-32 ARCH-620): what the buyer's spending policy checks. attested = every model
      // call of the job came back with the gateway's attestation evidence (the calls ca-attest is asked about); a job with
      // no model call, or with one call on a route without evidence, is not attested. Model ids and a boolean only.
      const attested = out.served.length > 0 && out.served.every((s) => s.attest !== undefined);
      return dataJson(res, 200, { jobId, totalUsd: quote.totalUsd, amount: quote.amount, network: offer.network, asset: offer.asset, payTo: offer.payTo, expiresAt, route, attested, ...(ap2Hold ? { ap2: ap2Answer(ap2Hold) } : {}) });
    }
    // The NEAR payment for one job, relayed to the paywall (never the gateway, and without the gateway key).
    if (PAID_JOBS && api === "paid" && name === "jobs" && req.method === "POST") {
      if (!hostOk(req)) return dataJson(res, 403, { error: `open the console as http://127.0.0.1:${PORT}` });
      const parts = url.pathname.split("/");
      const jobId = parts[3] ?? "";
      if (parts.length !== 5 || parts[4] !== "release" || !/^[0-9a-f]{32}$/.test(jobId)) return json(res, 404, { error: { message: "not found" } });
      const signature = req.headers["payment-signature"];
      if (Array.isArray(signature)) return json(res, 400, { error: { message: "send one payment-signature header" } });
      await readBody(req);
      const started = Date.now();
      let r: Response;
      try {
        // An estimate-first offer runs inside its release (ARCH-637): the run's time on top of the payment's.
        r = await fetch(`${PAYWALL}/v1/jobs/${jobId}/release`, { method: "POST", headers: { ...(signature ? { "payment-signature": signature } : {}) }, signal: AbortSignal.timeout(PAID_TIMEOUT_MS + (OFFERS ? CROSSASK_TIMEOUT_MS : 0)) });
      } catch {
        return json(res, 502, { error: { message: signature ? "The connection to the paywall failed after your payment was sent. Check your wallet's recent transactions before trying again." : "Could not reach the paywall. You were not charged." } });
      }
      const headers: Record<string, string> = { "content-type": r.headers.get("content-type") ?? "application/json", "cache-control": "no-store" };
      r.headers.forEach((value, key) => { if (PAID_PASS_BACK.test(key)) headers[key] = value; });
      let out: Buffer;
      try {
        out = Buffer.from(await r.arrayBuffer());
      } catch {
        const receipt = headers["payment-response"];
        res.writeHead(502, { "content-type": "application/json", ...(receipt ? { "payment-response": receipt } : {}) });
        res.end(JSON.stringify({ error: { message: signature ? "The result was lost after your payment went through. Check your wallet's recent transactions." : "Could not read the paywall's answer. You were not charged." } }));
        return;
      }
      // Status, job id and timing only: never the result, the payment header or the receipt.
      console.log(JSON.stringify({ ts: new Date().toISOString(), route: "paid-job-release", jobId, status: r.status, withPayment: signature !== undefined, ms: Date.now() - started }));
      res.writeHead(r.status, headers);
      res.end(out);
      return;
    }
    // ---- Tab 03 agent mode (ARCH-307): only with --agent-service ---------------------------------------------------
    if (AGENT_SERVICE && api === "agent" && name === "config" && req.method === "GET") {
      if (!hostOk(req)) return dataJson(res, 403, { error: `open the console as http://127.0.0.1:${PORT}` });
      const t = await agentTenants();
      if ("error" in t) return dataJson(res, 503, { error: t.error });
      return dataJson(res, 200, { network: t.network, tenants: t.tenants });
    }
    if (AGENT_SERVICE && api === "agent" && name === "crossask" && req.method === "POST") return relayAgent(req, res);
    // ARCH-620: the agent's spending policy per tenant (limits and today's spend), for the read-only line under "Who pays?".
    if (AGENT_SERVICE && api === "agent" && name === "policy" && req.method === "GET") {
      if (!hostOk(req)) return dataJson(res, 403, { error: `open the console as http://127.0.0.1:${PORT}` });
      const p = await agentPolicy();
      if ("error" in p) return dataJson(res, 503, { error: p.error });
      return dataJson(res, 200, p);
    }
    // ---- Paid chat ---------------------------------------------------------------------------------------------
    // The browser bundle that pays from the visitor's Crossmark wallet (services/web/public/wallet.js).
    if (api === "wallet.js" && req.method === "GET") {
      let js: Buffer;
      try { js = readFileSync(WALLET_BUNDLE); } catch { return json(res, 404, { error: `the wallet bundle is not at ${WALLET_BUNDLE}: run npm --prefix services/web run build:wallet` }); }
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache", "x-content-type-options": "nosniff" });
      res.end(js);
      return;
    }
    // The web page's NEAR bundle (services/web/public/near-wallet.js), only when the console was started with --near-wallet.
    if (api === "near-wallet.js" && req.method === "GET") {
      if (!NEAR_WALLET) return json(res, 404, { error: "the NEAR wallet is off: start the console with --near-wallet intear-wallet" });
      let js: Buffer;
      try { js = readFileSync(NEAR_WALLET_BUNDLE); } catch { return json(res, 404, { error: `the NEAR wallet bundle is not at ${NEAR_WALLET_BUNDLE}: run npm --prefix services/web run build:near-wallet` }); }
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache", "x-content-type-options": "nosniff" });
      res.end(js);
      return;
    }
    // What a NEAR paid chat pays, from the paywall's own chat quote: its near: offer, and the dollar price from its xrpl: offer when it has one.
    if (api === "paid" && name === "near" && req.method === "GET") {
      if (!hostOk(req)) return dataJson(res, 403, { error: `open the console as http://127.0.0.1:${PORT}` });
      if (!NEAR_WALLET) return json(res, 404, { error: "the NEAR wallet is off: start the console with --near-wallet intear-wallet" });
      const r = await fetch(PAYWALL + ROUTES.chat, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }), signal: AbortSignal.timeout(8000) });
      const header = r.headers.get("payment-required");
      if (r.status !== 402 || !header) return json(res, 503, { error: `the paywall did not quote a chat price (HTTP ${r.status}): ${(await r.text()).slice(0, 200)}` });
      const accepts = (JSON.parse(Buffer.from(header, "base64").toString("utf8")).accepts ?? []) as Record<string, any>[];
      const n = accepts.find((a) => a?.scheme === "exact" && (a.network === "near:testnet" || a.network === "near:mainnet"));
      if (!n || typeof n.asset !== "string" || typeof n.payTo !== "string" || typeof n.amount !== "string" || !/^[1-9]\d*$/.test(n.amount)) {
        return json(res, 503, { error: "the paywall does not offer USDC on NEAR: start it with PAY_RAILS=xrpl,near (or near)" });
      }
      const x = accepts.find((a) => typeof a?.network === "string" && a.network.startsWith("xrpl:"));
      json(res, 200, { network: n.network, asset: n.asset, payTo: n.payTo, amount: n.amount, price: x && Number.isFinite(Number(x.amount)) ? Number(x.amount) : null, wallet: NEAR_WALLET, walletName: NEAR_WALLETS[NEAR_WALLET].name });
      return;
    }
    // What the paid chat pays on, from the paywall's own chat quote, with the public ledger server for that network.
    if (api === "paid" && name === "network" && req.method === "GET") {
      if (!hostOk(req)) return dataJson(res, 403, { error: `open the console as http://127.0.0.1:${PORT}` });
      const r = await fetch(PAYWALL + ROUTES.chat, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }), signal: AbortSignal.timeout(8000) });
      const header = r.headers.get("payment-required");
      if (r.status !== 402 || !header) return json(res, 503, { error: `the paywall did not quote a chat price (HTTP ${r.status}): ${(await r.text()).slice(0, 200)}` });
      const a = JSON.parse(Buffer.from(header, "base64").toString("utf8")).accepts?.[0] as Record<string, any> | undefined;
      const known = Object.entries(NETWORKS).find(([, n]) => n.caip2 === a?.network);
      if (!a || !known || typeof a.extra?.issuer !== "string" || typeof a.asset !== "string") return json(res, 502, { error: `the paywall quotes a network or shape this console does not know (${a?.network ?? "none"})` });
      json(res, 200, { name: known[0], caip2: known[1].caip2, wsUrl: known[1].wsUrl, asset: a.asset, issuer: a.extra.issuer, payTo: a.payTo, price: Number(a.amount) });
      return;
    }
    // The paid chat itself, relayed to the paywall (not the gateway, and without the gateway key) with the payment header.
    if (api === "paid" && name === "chat" && req.method === "POST") {
      if (!hostOk(req)) return dataJson(res, 403, { error: `open the console as http://127.0.0.1:${PORT}` });
      if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) return json(res, 415, { error: { message: "send application/json" } });
      const signature = req.headers["payment-signature"];
      if (Array.isArray(signature)) return json(res, 400, { error: { message: "send one payment-signature header" } });
      const body = await readBody(req);
      const started = Date.now();
      let r: Response;
      try {
        r = await fetch(PAYWALL + ROUTES.chat, {
          method: "POST",
          headers: { "content-type": "application/json", ...(signature ? { "payment-signature": signature } : {}) },
          body,
          signal: AbortSignal.timeout(PAID_TIMEOUT_MS),
        });
      } catch {
        // Once a payment was forwarded, the paywall may have settled it before the connection failed.
        return json(res, 502, { error: { message: signature ? "The connection to the paywall failed after your payment was sent. Check your wallet's recent transactions before trying again." : "Could not reach the paywall. You were not charged." } });
      }
      const headers: Record<string, string> = { "content-type": r.headers.get("content-type") ?? "application/json", "cache-control": "no-store" };
      r.headers.forEach((value, key) => { if (PAID_PASS_BACK.test(key)) headers[key] = value; });
      let out: Buffer;
      try {
        out = Buffer.from(await r.arrayBuffer());
      } catch {
        // The paywall settles before it streams the answer, so a paid body lost here may already be paid for.
        const receipt = headers["payment-response"];
        res.writeHead(502, { "content-type": "application/json", ...(receipt ? { "payment-response": receipt } : {}) });
        res.end(JSON.stringify({ error: { message: signature ? "The answer was lost after your payment went through. Check your wallet's recent transactions before trying again." : "Could not read the paywall's answer. You were not charged." } }));
        return;
      }
      // Status and timing only: never the text, the payment header or the receipt.
      console.log(JSON.stringify({ ts: new Date().toISOString(), route: "paid-chat", status: r.status, withPayment: signature !== undefined, ms: Date.now() - started }));
      res.writeHead(r.status, headers);
      res.end(out);
      return;
    }
    if (api === "leaving") {
      json(res, 200, await (await fetch(SPY)).json());
      return;
    }
    if (api === "ledger") {
      const send = (out: string | null) => {
        const lines = out === null ? [] : out.trim().split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return l; } });
        json(res, 200, { lines });
      };
      if (LEDGER_SOURCE === "off") return send(null);
      if (LEDGER_SOURCE.startsWith("dir:")) return send(await tailLedgerDir(LEDGER_SOURCE.slice(4), 6));
      execFile("docker", ["exec", "ca-gateway", "sh", "-c", "tail -n 6 /data/ledger/*.jsonl"], (err, out) => send(err ? null : out));
      return;
    }
    json(res, 404, { error: "not found" });
  } catch (e) {
    json(res, 502, { error: (e as Error).message });
  }
}).listen(PORT, flags.bind, async () => {
  if (MODE === "ui") {
    console.log(`[test-console] http://127.0.0.1:${PORT}  ui mode: page and browser bundles here, everything else forwarded to ${API}${PAGE_PAID ? "  (tab 03 pay box on)" : ""}${NEAR_WALLET ? `  NEAR wallet: ${NEAR_WALLET}` : ""}`);
    return;
  }
  if (MODE === "api") console.log(`[test-console] api mode: listening on ${flags.bind}:${PORT}; hosts ${ALLOWED_HOSTS.join(",")}; ledger ${LEDGER_SOURCE}`);
  if (AGENT_SERVICE) console.log(`[test-console] agent mode on: /agent/config and /agent/crossask relayed to ${AGENT_SERVICE} (up to ${AGENT_FORWARD_TIMEOUT_MS / 1000} s per run)`);
  if (ATTEST_CONFIG) console.log(`[test-console] model attestation on: ${ATTEST_CONFIG.url}/verify after each quoted job (GET /jobs/<id>/attestation)`);
  if (PAY_ONLY_ATTESTED?.mode === "verified") console.log(`[test-console] pay only for attested private inference: every NEAR AI call verified by ca-attest within ${PAY_ONLY_ATTESTED.deadlineMs} ms before delivery, else 422 attestation_not_proven (the paywall's PAID_JOBS_RUN_TIMEOUT_SEC must cover the run plus this wait)`);
  console.log(`[test-console] run log: ${RUN_LOG.opt.mode}${RUN_LOG.opt.mode === "off" ? "" : ` -> ${RUN_LOG.opt.dir} (keep ${RUN_LOG.opt.keepDays} days${RUN_LOG.opt.mode === "full" ? `, up to ${RUN_LOG.opt.maxRows} rows per run` : ""})`}`);
  console.log(`[test-console] http://127.0.0.1:${PORT}  default model: ${DEFAULT_MODEL}${NEAR_WALLET ? `  NEAR wallet: ${NEAR_WALLET}` : ""}`);
  // The internal listener for the paywall (ARCH-105), only with --paid-jobs on; the key is never shown.
  if (PAID_JOBS && JOBS) {
    createServer(internalHandler(JOBS, PAID_JOBS.key, onJobReleased, OFFERS ? runOffer : undefined)).listen(PAID_JOBS.internalPort, PAID_JOBS.internalHost, () => {
      console.log(`[test-console] paid jobs on: internal listener http://${PAID_JOBS.internalHost}:${PAID_JOBS.internalPort}  key from ${PAID_JOBS.keyEnv}  ttl ${PAID_JOBS.ttlMs / 60_000} min  max ${PAID_JOBS.max}`);
      if (SIGNER_CLIENT?.mode === "remote") console.log(`[test-console] signer remote: ChainAim's keys and prices at ${SIGNER_CLIENT.url} (ca-control-signer); this console holds no signing key; request key from ${SIGNER_CLIENT.keyEnv}`);
      if (AP2_CONFIG) console.log(`[test-console] ap2 on: signing key id ${AP2_CONFIG.signer.kid} (${AP2_CONFIG.alg}) ${REMOTE_SIGNER ? "held by ca-control-signer" : `from ${AP2_CONFIG.keyEnv}`}  price round ${PAID_JOBS.priceRound}  (GET /.well-known/ucp)  checkout mandates ${MANDATE_MODE}`);
      // privateAI-design-43 ARCH-721: up.ps1 reads this line to confirm -Counter on.
      if (COUNTER) console.log(`[test-console] counter-offers on: one round, ladder ${COUNTER.file} (${COUNTER.ladder.steps.map((s) => s.name).join(" > ")})  (POST /offers/<id>/counter)`);
      if (RECEIPT_CONFIG) console.log(`[test-console] receipts on: signing key id ${RECEIPT_CONFIG.signer.keyId}${REMOTE_SIGNER ? " held by ca-control-signer" : ""}  -> ${RECEIPT_CONFIG.dir}  (GET /jobs/<id>/receipt)${JOB_FEED_CONFIG?.receipts ? "  job_receipt sent to near-watch" : ""}`);
      if (OBSERVER) console.log(`[test-console] observer view on: GET /jobs/<id>/observer reads the settlement from public NEAR RPC (testnet ${OBSERVER.urls["near:testnet"].map((u) => new URL(u).host).join(" then ")})`);
      if (JOB_FEED_CONFIG) {
        const u = new URL(JOB_FEED_CONFIG.url);
        console.log(`[test-console] job feed on: ${u.origin}${u.pathname}  key from ${JOB_FEED_CONFIG.keyEnv}  expiry check every ${JOB_FEED_CONFIG.expiryCheckSec} s`);
        // Expiry is noticed when the store is read; this read makes it happen on time even when nobody asks.
        setInterval(() => JOBS.size(), JOB_FEED_CONFIG.expiryCheckSec * 1000).unref();
      }
    }).on("error", (e) => { console.error(`[test-console] the paid jobs internal listener cannot start on ${PAID_JOBS.internalHost}:${PAID_JOBS.internalPort}: ${e.message}`); process.exit(1); });
  }
  const { config, error } = readDataConfig();
  if (!config) console.log(`[test-console] ${error}`);
  else console.log(`[test-console] data folders: ${config.allowedRoots.join(", ")}; default ${config.defaultFolder}${(await isFolder(config.defaultFolder)) ? "" : "  (NOT FOUND: create it)"}`);
});

/** tail -n <n> <dir>/*.jsonl, in name order, for --ledger-source dir:<path>; null when nothing can be read (as a failed docker exec). */
async function tailLedgerDir(dir: string, n: number): Promise<string | null> {
  let names: string[];
  try { names = (await readdir(dir)).filter((x) => x.endsWith(".jsonl")).sort(); } catch { return null; }
  if (!names.length) return null;
  const parts: string[] = [];
  for (const name of names) {
    let text: string;
    try { text = await readFile(join(dir, name), "utf8"); } catch { return null; }
    const lines = text.replace(/\n$/, "").split("\n");
    const last = lines.slice(-n).join("\n");
    parts.push(names.length > 1 ? `==> ${join(dir, name)} <==\n${last}` : last);
  }
  return parts.join("\n\n") + "\n";
}

/** ui mode: one request forwarded to the api unchanged, after this process's own Host check (C4). */
async function forward(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (!hostOk(req)) return dataJson(res, 403, { error: `open the console as http://127.0.0.1:${PORT}` });
  const headers: Record<string, string> = {};
  for (const name of FORWARD_IN) { const v = req.headers[name]; if (typeof v === "string") headers[name] = v; }
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBodyBytes(req);
  let r: Response;
  try {
    r = await fetch(API + url.pathname + url.search, { method: req.method, headers, ...(body ? { body } : {}), signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS), redirect: "manual" });
  } catch {
    // A paid call may have been settled before the connection failed: never say "not charged" when a payment was attached.
    return json(res, 502, { error: { message: headers["payment-signature"] ? "The connection to the console API failed after your payment was sent. Check your wallet's recent transactions before trying again." : `The console API is not answering at ${API}: start it (up.ps1) and try again.` } });
  }
  const back: Record<string, string> = {};
  r.headers.forEach((value, name) => { if (FORWARD_BACK.test(name)) back[name] = value; });
  let out: Buffer;
  try { out = Buffer.from(await r.arrayBuffer()); }
  catch {
    const receipt = back["payment-response"];
    res.writeHead(502, { "content-type": "application/json", ...(receipt ? { "payment-response": receipt } : {}) });
    res.end(JSON.stringify({ error: { message: headers["payment-signature"] ? "The answer was lost after your payment went through. Check your wallet's recent transactions before trying again." : "Could not read the console API's answer." } }));
    return;
  }
  res.writeHead(r.status, back);
  res.end(out);
}

/** The tenants the agent service pays for now (its GET /tenants): ids, names and NEAR accounts only. */
async function agentTenants(): Promise<{ network: string; tenants: { id: string; name: string; accountId: string }[] } | { error: string }> {
  try {
    const r = await fetch(`${AGENT_SERVICE}/tenants`, { signal: AbortSignal.timeout(8000) });
    const j = (await r.json()) as { network?: unknown; tenants?: unknown };
    if (!r.ok || typeof j.network !== "string" || !Array.isArray(j.tenants)) throw new Error(`HTTP ${r.status}`);
    const tenants = (j.tenants as Record<string, unknown>[]).filter((t) => typeof t?.id === "string" && typeof t.name === "string" && typeof t.accountId === "string")
      .map((t) => ({ id: t.id as string, name: t.name as string, accountId: t.accountId as string }));
    return { network: j.network, tenants };
  } catch {
    return { error: `the agent service is not answering at ${AGENT_SERVICE}: start it (up.ps1 -Agent on); nothing was run or paid` };
  }
}

const POLICY_USD = /^(0|[1-9]\d*)(\.\d{1,6})?$/;
/**
 * The agent service's GET /policy (ARCH-620), re-read field by field: only decimal amounts, booleans and the tenant id
 * pass; a tenant whose ledger could not be read keeps a short error. {on: false} when the agent runs without a policy.
 */
async function agentPolicy(): Promise<{ on: boolean; tenants: Record<string, unknown>[] } | { error: string }> {
  try {
    const r = await fetch(`${AGENT_SERVICE}/policy`, { signal: AbortSignal.timeout(8000) });
    const j = (await r.json()) as { on?: unknown; tenants?: unknown };
    if (!r.ok || typeof j.on !== "boolean") throw new Error(`HTTP ${r.status}`);
    if (!j.on || !Array.isArray(j.tenants)) return { on: false, tenants: [] };
    const tenants = (j.tenants as Record<string, unknown>[]).filter((t) => typeof t?.id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(t.id as string)).map((t) =>
      typeof t.error === "string" ? { id: t.id, error: (t.error as string).slice(0, 200) }
        : ["autoApproveMaxUsd", "maxPerJobUsd", "dailyCapUsd", "spentTodayUsd"].every((k) => typeof t[k] === "string" && POLICY_USD.test(t[k] as string)) && typeof t.requireAttestedRoute === "boolean" && typeof t.counter === "boolean"
          ? { id: t.id, autoApproveMaxUsd: t.autoApproveMaxUsd, maxPerJobUsd: t.maxPerJobUsd, dailyCapUsd: t.dailyCapUsd, requireAttestedRoute: t.requireAttestedRoute, counter: t.counter, spentTodayUsd: t.spentTodayUsd }
          : { id: t.id, error: "the agent's policy answer could not be read" });
    return { on: true, tenants };
  } catch {
    return { error: `the agent service is not answering at ${AGENT_SERVICE}` };
  }
}

/** POST /agent/crossask in api/all mode (ARCH-307): the same body checks as /jobs/crossask plus the tenant, then the agent's run relayed as it arrives. */
async function relayAgent(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!hostOk(req)) return dataJson(res, 403, { error: `open the console as http://127.0.0.1:${PORT}` });
  if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) return dataJson(res, 415, { error: "send application/json" });
  let b: Record<string, unknown>;
  try { b = JSON.parse(await readBody(req)); } catch { return dataJson(res, 400, { error: "body must be JSON" }); }
  if (typeof b !== "object" || b === null) return dataJson(res, 400, { error: "body must be a JSON object" });
  const model = typeof b.model === "string" && b.model ? b.model : DEFAULT_MODEL;
  if (!/^[\w.-]+\/[\w.:-]+$/.test(model)) return dataJson(res, 400, { error: `model must look like provider/name, got ${model}` });
  if (typeof b.folder !== "string" || typeof b.question !== "string" || !b.question.trim()) return dataJson(res, 400, { error: "folder and question are required" });
  const answerModel = typeof b.answerModel === "string" && b.answerModel ? b.answerModel : undefined;
  if (answerModel && !/^[\w.-]+\/[\w.:-]+$/.test(answerModel)) return dataJson(res, 400, { error: `answerModel must look like provider/name, got ${answerModel}` });
  const known = await agentTenants();
  if ("error" in known) return dataJson(res, 503, { error: known.error });
  if (typeof b.tenant !== "string" || !known.tenants.some((t) => t.id === b.tenant)) return dataJson(res, 400, { error: `unknown tenant ${String(b.tenant)} (the agent pays for: ${known.tenants.map((t) => t.id).join(", ")})` });
  const tenant = b.tenant;
  // datasetId / templateLabel (privateAI-design-32 ARCH-613) go on to the agent, which passes them to /jobs/crossask for
  // the job's receipt; malformed ones are left out here (the console then names the dataset by a folder hash).
  const runLabel = templateLabelOf(b.templateLabel);
  const run = { tenant, folder: b.folder, question: b.question, model, ...(answerModel ? { answerModel } : {}), phrase: b.phrase === "none" ? "none" : "llm", ...(typeof b.sql === "string" && b.sql.trim() ? { sql: b.sql } : {}),
    ...(typeof b.datasetId === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(b.datasetId) ? { datasetId: b.datasetId } : {}), ...(runLabel ? { templateLabel: runLabel } : {}) };
  // A hang-up here is passed on: the agent cancels a run that has not signed yet, and completes one that has.
  const hangUp = new AbortController();
  res.on("close", () => { if (!res.writableEnded) hangUp.abort(); });
  const started = Date.now();
  let r: Response;
  try {
    r = await fetch(`${AGENT_SERVICE}/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(run), signal: AbortSignal.any([hangUp.signal, AbortSignal.timeout(AGENT_FORWARD_TIMEOUT_MS)]) });
  } catch {
    return dataJson(res, 502, { error: `the agent service is not answering at ${AGENT_SERVICE}; nothing was run or paid` });
  }
  // Only the job id and the last step's name are read from the stream, for the log line; the stream itself passes unchanged.
  let tail = "", jobId: string | null = null, status: string | null = null;
  const sniff = (text: string) => {
    tail = (tail + text).slice(-4096);
    jobId ??= /"jobId":"([0-9a-f]{32})"/.exec(tail)?.[1] ?? null;
    for (const m of tail.matchAll(/^event: ([a-z_]+)$/gm)) status = m[1];
  };
  await pipeStream(r, res, { "content-type": r.headers.get("content-type") ?? "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" },
    "the connection to the agent service broke during the run; if the payment was signed, check the tenant account's recent transactions", sniff);
  // Tenant, job id, last step and timing only: never the question, the result or a key.
  console.log(JSON.stringify({ ts: new Date().toISOString(), route: "agent", tenant, jobId, status: status ?? `http-${r.status}`, ms: Date.now() - started }));
}

/** ui mode (ARCH-308): POST /agent/crossask forwarded like forward(), with the response streamed to the browser as it arrives. */
async function forwardStream(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (!hostOk(req)) return dataJson(res, 403, { error: `open the console as http://127.0.0.1:${PORT}` });
  const headers: Record<string, string> = {};
  for (const name of FORWARD_IN) { const v = req.headers[name]; if (typeof v === "string") headers[name] = v; }
  const body = await readBodyBytes(req);
  const hangUp = new AbortController();
  res.on("close", () => { if (!res.writableEnded) hangUp.abort(); });
  let r: Response;
  try {
    r = await fetch(API + url.pathname + url.search, { method: "POST", headers, body, signal: AbortSignal.any([hangUp.signal, AbortSignal.timeout(AGENT_FORWARD_TIMEOUT_MS)]), redirect: "manual" });
  } catch {
    return json(res, 502, { error: { message: `The console API is not answering at ${API}: start it (up.ps1) and try again.` } });
  }
  const back: Record<string, string> = {};
  r.headers.forEach((value, name) => { if (FORWARD_BACK.test(name)) back[name] = value; });
  await pipeStream(r, res, back, "the connection to the console API broke during the agent's run; if the payment was signed, check the tenant account's recent transactions");
}

/**
 * Writes the status and headers at once, then each chunk of the body as it arrives. When the upstream breaks in the
 * middle of an event stream, one last `error` event says so (the page would otherwise wait for a step that never comes).
 */
async function pipeStream(r: Response, res: ServerResponse, headers: Record<string, string>, brokenReason: string, onText?: (text: string) => void): Promise<void> {
  res.writeHead(r.status, headers);
  res.flushHeaders();
  if (!r.body) { res.end(); return; }
  const decoder = new TextDecoder();
  const reader = r.body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      onText?.(decoder.decode(value, { stream: true }));
      if (!res.destroyed) res.write(value);
    }
  } catch {
    if (!res.destroyed && /^text\/event-stream\b/i.test(headers["content-type"] ?? "")) res.write(`event: error\ndata: ${JSON.stringify({ reason: brokenReason })}\n\n`);
  }
  if (!res.writableEnded) res.end();
}

/** The request body's bytes, as a Uint8Array over its own ArrayBuffer (what fetch's body type takes). */
function readBodyBytes(req: IncomingMessage): Promise<Uint8Array<ArrayBuffer>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
    req.on("error", reject);
  });
}
