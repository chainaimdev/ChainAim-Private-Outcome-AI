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

loadEnv();

let config: PaywallConfig;
try {
  config = loadConfig(process.env);
} catch (e) {
  console.error(`[chainaim-paywall] ${(e as Error).message}`);
  process.exit(1);
}

// The payment log sink (PAYMENT_LOG_URL / PAYMENT_LOG_FILE) is built here so shutdown can flush it; none when both are unset.
const sink = config.paymentLog ? createSink(config.paymentLog) : undefined;
const server = serve({ fetch: createPaywall(config, sink ? { sink } : {}).fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(
    `[chainaim-paywall] listening on ${config.host}:${info.port}  network=${config.networkName} payTo=${config.payTo} ` +
      `gateway=${config.gatewayUrl} facilitator=${config.facilitatorUrl}${config.publicBaseUrl ? ` public=${config.publicBaseUrl}` : ""}` +
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
