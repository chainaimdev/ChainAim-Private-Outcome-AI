/**
 * chainaim-paywall entry point. Configuration comes from the environment;
 * see src/config.ts and docs/deploy/railway.md. The repository's .env is read
 * first when there is one (src/env.ts), so running this by hand needs no
 * --env-file; in a container there is no .env and the variables are already
 * set.
 */
import { serve } from "@hono/node-server";
import { createPaywall } from "./app.ts";
import { loadConfig, type PaywallConfig } from "./config.ts";
import { loadEnv } from "./env.ts";
import { createSink } from "./sink.ts";
import { createNearRpc, redactUrl } from "./near/rpc.ts";
import { checkUsdc } from "./near/usdc.ts";
import { loadNearRail, type NearRail } from "./near/rail.ts";

loadEnv();

let config: PaywallConfig;
try {
  config = loadConfig(process.env);
} catch (e) {
  console.error(`[chainaim-paywall] ${(e as Error).message}`);
  process.exit(1);
}

// NEAR rail: the USDC contract and decimals are read back from the chain, and payTo's registration checked, before any price is quoted.
// Its libraries are loaded only here, so an XRPL-only paywall never loads them.
const near = config.near;
let nearRail: NearRail | undefined;
if (near) {
  try {
    const rpc = createNearRpc({ urls: [near.rpcUrl, ...(near.rpcFallbackUrl ? [near.rpcFallbackUrl] : [])], timeoutMs: 10_000 });
    await checkUsdc(near, rpc);
    nearRail = await loadNearRail(near);
  } catch (e) {
    console.error(`[chainaim-paywall] ${(e as Error).message}`);
    process.exit(1);
  }
}

// The payment log sink (PAYMENT_LOG_URL / PAYMENT_LOG_FILE) is built here so shutdown can flush it; none when both are unset.
const sink = config.paymentLog ? createSink(config.paymentLog) : undefined;
const deps = { ...(sink ? { sink } : {}), ...(nearRail ? { nearRail } : {}) };
const server = serve({ fetch: createPaywall(config, deps).fetch, port: config.port, hostname: config.host }, (info) => {
  // URLs are shown as scheme and host only on the NEAR rail: a QuickNode URL holds its token in the path. The relayer key is never shown.
  const nearPart = near
    ? ` near=${near.networkName} nearPayTo=${near.payTo} usdc=${near.usdcContract} nearRpc=${redactUrl(near.rpcUrl)}` +
      ` nearFacilitator=${near.facilitator.kind === "remote" ? redactUrl(near.facilitator.url) : `local relayer=${near.facilitator.relayerId}`}`
    : "";
  const xrplPart = config.rails.includes("xrpl") ? ` network=${config.networkName} payTo=${config.payTo}` : "";
  const facilitatorPart = config.rails.includes("xrpl") ? ` facilitator=${config.facilitatorUrl}` : "";
  console.log(
    `[chainaim-paywall] listening on ${config.host}:${info.port} ${xrplPart}${config.rails.length > 1 || near ? ` rails=${config.rails.join(",")}${nearPart}` : ""} ` +
      `gateway=${config.gatewayUrl}${facilitatorPart}${config.publicBaseUrl ? ` public=${config.publicBaseUrl}` : ""}` +
      `${config.paymentLog ? ` paymentLog=${[config.paymentLog.url ? "url" : "", config.paymentLog.file ? "file" : ""].filter(Boolean).join("+")}` : ""}`,
  );
});
const shutdown = () =>
  server.close(() => {
    if (!sink) return process.exit(0);
    void sink.close().finally(() => process.exit(0));
  });
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
