/**
 * USDC on NEAR: the price in base units, and the start-up check that the
 * configured contract is the token the configuration says it is.
 *
 * NEAR_USDC_DECIMALS_<NETWORK> is required, and is read back from the
 * contract's ft_metadata (NEP-148) when the paywall starts, so a wrong contract
 * id or a wrong decimals value stops the paywall instead of mispricing every
 * call. The pay-to account must be registered with the contract (NEP-145
 * storage_balance_of), or every ft_transfer to it fails; @x402/near's verify
 * refuses such payments too, so the check here only says it once, at start,
 * with the fix (scripts/near-storage.ts).
 */
import { usdToBaseUnits, type NearConfig, type Priced } from "../config.ts";
import type { NearRpc } from "./rpc.ts";

/** A route's USD price as a whole number of USDC base units, e.g. "$0.01" with 6 decimals is "10000". */
export function usdcAmount(price: string, near: Pick<NearConfig, "usdcDecimals">): string {
  return usdToBaseUnits(price, near.usdcDecimals);
}

/** Every route's NEAR price, computed once. */
export function usdcPrices(prices: Record<Priced, string>, near: Pick<NearConfig, "usdcDecimals">): Record<Priced, string> {
  return { scan: usdcAmount(prices.scan, near), mask: usdcAmount(prices.mask, near), chat: usdcAmount(prices.chat, near) };
}

export type UsdcCheck = { symbol: string; decimals: number };

/** Throws, with what to fix, unless the contract's metadata matches the configuration and payTo is registered with it. */
export async function checkUsdc(near: Pick<NearConfig, "usdcContract" | "usdcDecimals" | "payTo" | "networkName">, rpc: NearRpc): Promise<UsdcCheck> {
  const net = near.networkName.toUpperCase();
  let metadata: { spec?: unknown; symbol?: unknown; decimals?: unknown };
  try {
    metadata = (await rpc.view(near.usdcContract, "ft_metadata", {})) as typeof metadata;
  } catch (e) {
    throw new Error(`cannot read ft_metadata from NEAR_USDC_CONTRACT_${net} (${near.usdcContract}): ${(e as Error).message}`);
  }
  if (typeof metadata?.spec !== "string" || !metadata.spec.startsWith("ft-")) {
    throw new Error(`NEAR_USDC_CONTRACT_${net} (${near.usdcContract}) does not answer ft_metadata as a NEP-141 fungible token`);
  }
  if (metadata.decimals !== near.usdcDecimals) {
    throw new Error(`NEAR_USDC_DECIMALS_${net} is ${near.usdcDecimals}, but ${near.usdcContract} reports ${String(metadata.decimals)} decimals`);
  }
  let storage: unknown;
  try {
    storage = await rpc.view(near.usdcContract, "storage_balance_of", { account_id: near.payTo });
  } catch (e) {
    throw new Error(`cannot read storage_balance_of(${near.payTo}) from ${near.usdcContract}: ${(e as Error).message}`);
  }
  if (storage === null) {
    throw new Error(
      `NEAR_PAY_TO_${net} (${near.payTo}) is not registered with ${near.usdcContract}, so no USDC can be paid to it; ` +
        `register it once: node scripts/near-storage.ts --account ${near.payTo}`,
    );
  }
  return { symbol: typeof metadata.symbol === "string" ? metadata.symbol : "?", decimals: near.usdcDecimals };
}
