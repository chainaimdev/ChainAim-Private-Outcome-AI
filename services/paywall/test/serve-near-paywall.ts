/**
 * A paywall with the NEAR rail on a loopback port, for tests that run it as a separate process (scripts/test may not
 * import services/paywall). The paywall is the real code (createPaywall through startNearPaywall); NEAR JSON-RPC is the
 * protocol double the NEAR rail tests use, with the USDC contract and NEAR_PAY_TO_TESTNET registered. The relayer key is
 * generated here for this run. Every other variable comes from this process's environment (PAID_JOBS, GATEWAY_URL, ...).
 * Prints one line, {"url": "...", "rpcUrl": "..."}, once listening, and every paywall log line after it.
 *
 *   node services/paywall/test/serve-near-paywall.ts
 */
import { KeyPair } from "@near-js/crypto";
import { addAccount, nearRpcDouble, startNearPaywall } from "./near-rpc-double.ts";
import { listen } from "./stubs.ts";

const TOKEN = process.env.NEAR_USDC_CONTRACT_TESTNET || "usdc.chainaim-test.testnet";
const PAY_TO = process.env.NEAR_PAY_TO_TESTNET || "merchant.chainaim-test.testnet";
const RELAYER = "relayer.chainaim-test.testnet";
const relayerKey = KeyPair.fromRandom("ed25519");
const double = nearRpcDouble({ tokenId: TOKEN, decimals: 6 });
const rpcUrl = await listen(double.server);
addAccount(double.state, RELAYER, relayerKey.getPublicKey().toString());
addAccount(double.state, PAY_TO);
double.state.token.registered.add(PAY_TO);
const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === "string"));
const paywall = await startNearPaywall(
  {
    ...env,
    PAY_RAILS: env.PAY_RAILS || "near",
    NEAR_PAY_TO_TESTNET: PAY_TO,
    NEAR_USDC_CONTRACT_TESTNET: TOKEN,
    NEAR_USDC_DECIMALS_TESTNET: "6",
    NEAR_RPC_URL_TESTNET: rpcUrl,
    NEAR_RELAYER_ACCOUNT_TESTNET: RELAYER,
    NEAR_RELAYER_KEY_TESTNET: relayerKey.toString(),
  },
  (line) => process.stdout.write(line + "\n"),
);
process.stdout.write(JSON.stringify({ url: paywall.url, rpcUrl }) + "\n");
const stop = () => void paywall.close().finally(() => process.exit(0));
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
