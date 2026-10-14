/**
 * Spark Savings vault deposits and withdrawals (protocols design 3.6):
 * sUSDC on Ethereum, Base, Arbitrum One and OP Mainnet (generation
 * "susdc-v1", USDC routed into sUSDS through the pinned PSM) and the
 * Spark Vaults V2 spUSDC and spETH on Ethereum ("spark-vault-v2").
 *
 * Provenance, re-read before every plan, prepare and fact read: the EIP-1967
 * implementation slot equals the pinned implementation (an upgrade refuses
 * the venue until the registry is re-reviewed), `asset()` and `decimals()`
 * match the pins, and sUSDC's `psm()` / a V2 vault's DEFAULT_ADMIN_ROLE
 * holder equal theirs. Deposits are capped by `maxDeposit(account)`.
 *
 * Exits: sUSDC pays out through its PSM, bounded by `maxWithdraw(owner)`. A
 * V2 vault pays from its idle balance only (the TAKER_ROLE deploys the
 * rest), and its `previewRedeem` / `previewWithdraw` revert when idle cash
 * is short, so positions are valued with `convertToAssets` and the idle
 * balance gates the amount (VENUE_ILLIQUID with the number; a revert is
 * never read as zero).
 */
import { encodeFunctionData, erc20Abi, getAddress, parseAbi } from "viem";
import { CHAINS, type SparkVaultVenue } from "@kletia/core";
import { PlatformError } from "../../../errors.js";
import { evmClient } from "../../chains/evm.js";
import type { ProtocolAdapter } from "../types.js";
import { apyFromPerSecond, assertPinned, proxyImplementation, withTimeout } from "./common.js";
import {
  assertMaxDeposit,
  assertVaultAsset,
  createVaultAdapter,
  decodeStandardCall,
  probeCap,
  realisedApy,
  VAULT_ABI,
  vaultMetrics,
  vaultRead,
  type VaultFamily,
  type VaultRef,
} from "./erc4626.js";

export const SPARK_VAULT_ABI = [
  ...VAULT_ABI,
  ...parseAbi([
    "function psm() view returns (address)",
    "function susds() view returns (address)",
    "function vsr() view returns (uint256)",
    "function ssr() view returns (uint256)",
    "function getRoleMember(bytes32 role,uint256 index) view returns (address)",
  ]),
] as const;

const DEFAULT_ADMIN_ROLE = `0x${"00".repeat(32)}` as const;
const RAY = 1e27;

function v2(venue: SparkVaultVenue): boolean {
  return venue.generation === "spark-vault-v2";
}

function sparkRead<F extends "psm" | "susds" | "vsr">(ref: Pick<VaultRef, "venue" | "network">, functionName: F) {
  return withTimeout(evmClient(ref.network).readContract({ address: getAddress(ref.venue.target), abi: SPARK_VAULT_ABI, functionName }));
}

/** Idle underlying a V2 vault holds (what it can pay out now). */
async function idleBalance(ref: VaultRef<SparkVaultVenue>): Promise<bigint> {
  return withTimeout(evmClient(ref.network).readContract({ address: ref.token, abi: erc20Abi, functionName: "balanceOf", args: [getAddress(ref.venue.target)] }));
}

/** APY from a per-second ray rate (V2 `vsr()`, Sky `ssr()`). */
function rayApy(rate: bigint): number | null {
  return apyFromPerSecond(Number(rate) / RAY - 1);
}

export const sparkSavingsFamily: VaultFamily<SparkVaultVenue> = {
  protocol: "spark-savings",
  kind: "spark-vault",
  label: "Spark Savings",
  shortName: "Spark Savings",
  abi: SPARK_VAULT_ABI,
  illiquidReason: (venue) => (v2(venue) ? "the rest of its assets are deployed, only idle cash pays out" : "its PSM holds no more USDC right now"),

  async verify(ref) {
    const { venue, network } = ref;
    const client = evmClient(network);
    const vault = getAddress(venue.target);
    const [implementation, pin] = await Promise.all([
      proxyImplementation(network, vault),
      v2(venue)
        ? withTimeout(client.readContract({ address: vault, abi: SPARK_VAULT_ABI, functionName: "getRoleMember", args: [DEFAULT_ADMIN_ROLE, 0n] }))
        : sparkRead(ref, "psm"),
      assertVaultAsset(ref),
    ]);
    if (implementation.toLowerCase() !== venue.implementation.toLowerCase()) {
      throw new PlatformError(
        "VENUE_UNVERIFIED",
        `${venue.name} on ${CHAINS[network].name} now runs implementation ${implementation}, not the reviewed ${venue.implementation}. Kletia will not use it until the registry is re-reviewed.`,
        422,
      );
    }
    const expected = v2(venue) ? venue.admin : venue.psm;
    if (!expected) throw new PlatformError("VENUE_INVALID", `${venue.name} has no ${v2(venue) ? "admin" : "PSM"} pin.`, 500);
    assertPinned(pin, expected, v2(venue) ? "admin (DEFAULT_ADMIN_ROLE)" : "psm()", venue);
    return { gates: [] };
  },

  async assertDeposit(context, _state, amount) {
    await assertMaxDeposit(context, amount, "its deposit cap is reached");
  },

  positionValue(ref, shares) {
    // V2 previews revert on short idle cash; convertToAssets values the shares without touching liquidity.
    return v2(ref.venue) ? vaultRead(ref, "convertToAssets", shares) : vaultRead(ref, "previewRedeem", shares);
  },

  async exitLiquidity(ref, owner) {
    return v2(ref.venue) ? idleBalance(ref) : vaultRead(ref, "maxWithdraw", owner);
  },

  capRemaining(ref) {
    return probeCap(ref);
  },

  async venueExitLiquidity(ref) {
    return v2(ref.venue) ? idleBalance(ref) : null;
  },

  async encodeDeposit(context, assets) {
    return encodeFunctionData({ abi: VAULT_ABI, functionName: "deposit", args: [assets, context.owner] });
  },

  async encodeWithdraw(context, assets) {
    return encodeFunctionData({ abi: VAULT_ABI, functionName: "withdraw", args: [assets, context.owner, context.owner] });
  },

  async encodeRedeem(context, shares) {
    return encodeFunctionData({ abi: VAULT_ABI, functionName: "redeem", args: [shares, context.owner, context.owner] });
  },

  decodeCall(data) {
    return decodeStandardCall(VAULT_ABI, data);
  },

  assetSink(venue) {
    return venue.target;
  },

  assetSource(venue) {
    // sUSDC pays out of its PSM's pocket (a contract the PSM chooses); the Withdraw event binds the amount.
    return v2(venue) ? venue.target : null;
  },

  async apy(ref) {
    if (v2(ref.venue)) {
      const apy = rayApy(await sparkRead(ref, "vsr"));
      return apy === null ? null : { apy, source: "rate" };
    }
    if (ref.network === "ethereum") {
      // Ethereum sUSDC holds sUSDS: its Sky Savings Rate is the vault's rate.
      const susds = await sparkRead(ref, "susds");
      const ssr = await withTimeout(evmClient(ref.network).readContract({ address: getAddress(susds), abi: SPARK_VAULT_ABI, functionName: "ssr" }));
      const apy = rayApy(ssr);
      if (apy !== null) return { apy, source: "rate" };
    }
    return realisedApy(ref.venue);
  },
};

export const sparkSavingsAdapter: ProtocolAdapter | null = createVaultAdapter(sparkSavingsFamily);

export function sparkSavingsMetrics(venue: SparkVaultVenue) {
  return vaultMetrics(sparkSavingsFamily, venue);
}
