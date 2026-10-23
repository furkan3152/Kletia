/**
 * Recorded perps reads (fixtures/perps, captured from mainnet on 2026-10-23)
 * behind the PerpsIo port: GMX keeper API answers and eth_calls, Hyperliquid
 * /info answers, Drift accounts. Any read outside the recording throws, so a
 * test never reaches the network.
 */
import { readFileSync } from "node:fs";
import { HYPERLIQUID_MAINNET } from "@kletia/core";
import type { SolanaAccountState } from "../chains/solana.js";
import type { PerpsIo } from "../../perps/io.js";

const load = (name: string): Record<string, unknown> => JSON.parse(readFileSync(new URL(`./fixtures/perps/${name}`, import.meta.url), "utf8")) as Record<string, unknown>;

export const GMX_FIXTURE = load("gmx-arbitrum.json") as {
  readonly now: number;
  readonly account: string;
  readonly gasPrice: string;
  readonly http: Record<string, unknown>;
  readonly calls: Record<string, string>;
};
export const GMX_ORDERS = load("gmx-orders.json") as { readonly examples: readonly { readonly hash: string; readonly from: string; readonly value: string; readonly input: string }[] };
export const HL_FIXTURE = load("hyperliquid-info.json") as {
  readonly metaAndAssetCtxs: unknown;
  readonly clearinghouseState: { readonly user: string; readonly state: { readonly assetPositions: unknown[]; readonly withdrawable: string } };
};
export const DRIFT_FIXTURE = load("drift-accounts.json") as { readonly accounts: Record<string, { readonly owner: string; readonly lamports: number; readonly data: string }> };
/** When the Drift accounts were read (oracle prices are months old by then: the venue is halted). */
export const DRIFT_RECORDED_AT = 1_792_770_277;

export interface FixtureIoOptions {
  readonly now?: number;
  /** Hyperliquid clearinghouseState per lower-case address (default: an empty account). */
  readonly hyperliquidStates?: Readonly<Record<string, unknown>>;
  /** Answer of POST /exchange. */
  readonly exchange?: unknown;
  /** eth_call answers that replace or extend the recording ("to:data" keys). */
  readonly calls?: Readonly<Record<string, string>>;
}

export interface FixtureIo extends PerpsIo {
  /** Bodies POSTed to Hyperliquid /exchange. */
  readonly relayed: unknown[];
}

const EMPTY_STATE = { marginSummary: {}, crossMarginSummary: {}, crossMaintenanceMarginUsed: "0.0", withdrawable: "0.0", assetPositions: [], time: 0 };

export function fixtureIo(options: FixtureIoOptions = {}): FixtureIo {
  const relayed: unknown[] = [];
  const calls = { ...GMX_FIXTURE.calls, ...options.calls };
  return {
    relayed,
    async json(_provider, url, body) {
      if (url.endsWith("/exchange")) {
        relayed.push(body);
        return options.exchange ?? { status: "ok", response: { type: "order", data: { statuses: [{ filled: { totalSz: "0.05", avgPx: "2404.5", oid: 1 } }] } } };
      }
      if (url === `${HYPERLIQUID_MAINNET.api}/info`) {
        const request = body as { type: string; user?: string };
        if (request.type === "metaAndAssetCtxs") return HL_FIXTURE.metaAndAssetCtxs;
        if (request.type === "clearinghouseState") return options.hyperliquidStates?.[request.user ?? ""] ?? EMPTY_STATE;
      }
      if (url in GMX_FIXTURE.http) return GMX_FIXTURE.http[url];
      throw new Error(`unrecorded request ${url}`);
    },
    async arbitrumCall(to, data) {
      const key = `${to.toLowerCase()}:${data}`;
      const result = calls[key];
      if (result === undefined) throw new Error(`unrecorded eth_call ${key.slice(0, 90)}`);
      return result as `0x${string}`;
    },
    async arbitrumGasPrice() {
      return BigInt(GMX_FIXTURE.gasPrice);
    },
    async solanaAccounts(addresses): Promise<(SolanaAccountState | null)[]> {
      return addresses.map((address) => {
        const account = DRIFT_FIXTURE.accounts[address];
        return account ? { owner: account.owner, lamports: BigInt(account.lamports), executable: false, data: Uint8Array.from(Buffer.from(account.data, "base64")) } : null;
      });
    },
    now: () => options.now ?? GMX_FIXTURE.now,
  };
}
