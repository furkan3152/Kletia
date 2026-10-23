/**
 * Savings-token vaults on Ethereum (round 9, E1): Sky's sUSDS (Sky Savings
 * Rate) and sDAI (Dai Savings Rate), and Ethena's sUSDe. All three are
 * ERC-4626 vaults run by the shared engine in erc4626.ts.
 *
 * Provenance, re-read before every plan, prepare and fact read:
 * - the EIP-1967 implementation slot equals the pinned implementation
 *   (sUSDS is a UUPS proxy: an upgrade refuses the venue until the registry
 *   is re-reviewed); sDAI and sUSDe are immutable, so their slot must be
 *   empty;
 * - every pinned view (`usds()`, `pot()` / `daiJoin()`, `silo()`) returns
 *   its pinned address, and `asset()` / `decimals()` match the pins.
 * Deposits are capped by `maxDeposit(account)`.
 *
 * Ethena exits are not instant: while `cooldownDuration()` is set, sUSDe's
 * withdraw / redeem revert and the holder must call `cooldownShares` and
 * `unstake` after the cooldown. The registry lists sUSDe for deposits only;
 * every deposit warns with the live cooldown and Kletia never encodes the
 * exit (positions report nothing withdrawable now).
 */
import { encodeFunctionData, getAddress, parseAbi } from "viem";
import { CHAINS, type SavingsVaultVenue } from "@kletia/core";
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
  vaultRead,
  type VaultFamily,
  type VaultRef,
} from "./erc4626.js";

export const SAVINGS_VAULT_ABI = [
  ...VAULT_ABI,
  ...parseAbi([
    "function ssr() view returns (uint256)",
    "function dsr() view returns (uint256)",
    "function cooldownDuration() view returns (uint24)",
  ]),
] as const;

const RAY = 1e27;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const SECONDS_PER_DAY = 86_400;

/** Implementation slot and every pinned view against the registry (plus the shared asset / decimals check). */
async function verifySavingsVault(ref: VaultRef<SavingsVaultVenue>): Promise<void> {
  const { venue, network } = ref;
  const client = evmClient(network);
  const vault = getAddress(venue.target);
  const [implementation, reported] = await Promise.all([
    proxyImplementation(network, vault),
    Promise.all(venue.pins.map((pin) =>
      withTimeout(client.readContract({ address: vault, abi: parseAbi([`function ${pin.call}() view returns (address)`]), functionName: pin.call } as never)) as Promise<string>)),
    assertVaultAsset(ref),
  ]);
  const wanted = venue.implementation ?? ZERO_ADDRESS;
  if (implementation.toLowerCase() !== wanted.toLowerCase()) {
    throw new PlatformError(
      "VENUE_UNVERIFIED",
      venue.implementation
        ? `${venue.name} on ${CHAINS[network].name} now runs implementation ${implementation}, not the reviewed ${venue.implementation}. Kletia will not use it until the registry is re-reviewed.`
        : `${venue.name} on ${CHAINS[network].name} now reports a proxy implementation (${implementation}); the reviewed vault is immutable. Kletia will not use it.`,
      422,
    );
  }
  venue.pins.forEach((pin, index) => assertPinned(reported[index] as string, pin.address, `${pin.call}()`, venue));
}

/** APY from a per-second ray rate (Sky `ssr()`, the Pot's `dsr()`). */
function rayApy(rate: bigint): number | null {
  return apyFromPerSecond(Number(rate) / RAY - 1);
}

function pinAddress(venue: SavingsVaultVenue, call: string): string {
  const pin = venue.pins.find((entry) => entry.call === call);
  if (!pin) throw new PlatformError("VENUE_INVALID", `${venue.name} has no ${call}() pin.`, 500);
  return pin.address;
}

/** Shared parts of both families: deposits, standard encoders, metrics reads. */
function savingsFamily(
  protocol: "sky" | "ethena",
  label: string,
  overrides: Pick<VaultFamily<SavingsVaultVenue>, "exitLiquidity" | "illiquidReason" | "assetSource" | "apy" | "encodeWithdraw" | "encodeRedeem"> &
    Partial<Pick<VaultFamily<SavingsVaultVenue>, "depositWarnings">>,
): VaultFamily<SavingsVaultVenue> {
  return {
    protocol,
    kind: "savings-vault",
    label,
    shortName: label,
    abi: SAVINGS_VAULT_ABI,

    async verify(ref) {
      await verifySavingsVault(ref);
      return { gates: [] };
    },

    async assertDeposit(context, _state, amount) {
      await assertMaxDeposit(context, amount, "its deposit cap is reached");
    },

    positionValue(ref, shares) {
      return vaultRead(ref, "previewRedeem", shares);
    },

    capRemaining(ref) {
      return probeCap(ref);
    },

    async venueExitLiquidity() {
      return null;
    },

    async encodeDeposit(context, assets) {
      return encodeFunctionData({ abi: VAULT_ABI, functionName: "deposit", args: [assets, context.owner] });
    },

    decodeCall(data) {
      return decodeStandardCall(VAULT_ABI, data);
    },

    assetSink(venue) {
      return venue.target;
    },

    ...overrides,
  };
}

/** Sky: sUSDS and sDAI (withdrawals paid at once: sUSDS from its own balance, sDAI minted by the DaiJoin). */
export const skyFamily: VaultFamily<SavingsVaultVenue> = savingsFamily("sky", "Sky Savings", {
  illiquidReason: () => "its savings module pays out no more right now",

  exitLiquidity(ref, owner) {
    return vaultRead(ref, "maxWithdraw", owner);
  },

  async encodeWithdraw(context, assets) {
    return encodeFunctionData({ abi: VAULT_ABI, functionName: "withdraw", args: [assets, context.owner, context.owner] });
  },

  async encodeRedeem(context, shares) {
    return encodeFunctionData({ abi: VAULT_ABI, functionName: "redeem", args: [shares, context.owner, context.owner] });
  },

  assetSource(venue) {
    // sDAI exits DAI from the DSR through the DaiJoin, which mints it to the receiver; sUSDS pays from its own balance.
    return venue.generation === "sdai" ? null : venue.target;
  },

  async apy(ref) {
    const client = evmClient(ref.network);
    const rate = ref.venue.generation === "sdai"
      ? await withTimeout(client.readContract({ address: getAddress(pinAddress(ref.venue, "pot")), abi: SAVINGS_VAULT_ABI, functionName: "dsr" }))
      : await withTimeout(client.readContract({ address: getAddress(ref.venue.target), abi: SAVINGS_VAULT_ABI, functionName: "ssr" }));
    const apy = rayApy(rate);
    return apy === null ? realisedApy(ref.venue) : { apy, source: "rate" };
  },
});

/** The live sUSDe cooldown in seconds. */
export async function ethenaCooldownSeconds(ref: Pick<VaultRef<SavingsVaultVenue>, "venue" | "network">): Promise<number> {
  const seconds = await withTimeout(evmClient(ref.network).readContract({ address: getAddress(ref.venue.target), abi: SAVINGS_VAULT_ABI, functionName: "cooldownDuration" }));
  return Number(seconds);
}

/** The exit warning every sUSDe deposit carries (the cooldown as read now). */
export function ethenaExitWarning(cooldownSeconds: number): string {
  const days = cooldownSeconds / SECONDS_PER_DAY;
  const wait = cooldownSeconds === 0
    ? "Ethena's cooldown is off right now, but it can be switched back on at any time"
    : `Ethena's cooldown is ${Number.isInteger(days) ? days : days.toFixed(2)} day${days === 1 ? "" : "s"} right now: start it with cooldownShares, then unstake once it ends`;
  return `sUSDe has no instant exit through Kletia: ${wait}. Kletia does not run that exit; swapping sUSDe back is the other way out, at the market rate.`;
}

const ETHENA_EXIT = "Kletia does not withdraw sUSDe: exits go through Ethena's cooldown (cooldownShares, then unstake).";

/** Ethena: sUSDe deposits only; exits are Ethena's cooldown, shown and never encoded. */
export const ethenaFamily: VaultFamily<SavingsVaultVenue> = savingsFamily("ethena", "Ethena", {
  illiquidReason: () => "exits go through Ethena's cooldown",

  async exitLiquidity() {
    // Nothing leaves sUSDe at once: the cooldown comes first, outside Kletia.
    return 0n;
  },

  async encodeWithdraw() {
    throw new PlatformError("INTENT_UNSUPPORTED", ETHENA_EXIT, 422);
  },

  async encodeRedeem() {
    throw new PlatformError("INTENT_UNSUPPORTED", ETHENA_EXIT, 422);
  },

  assetSource(venue) {
    return venue.target;
  },

  apy(ref) {
    return realisedApy(ref.venue);
  },

  async depositWarnings(ref) {
    return [ethenaExitWarning(await ethenaCooldownSeconds(ref))];
  },
});

export const skyAdapter: ProtocolAdapter | null = createVaultAdapter(skyFamily);
export const ethenaAdapter: ProtocolAdapter | null = createVaultAdapter(ethenaFamily);
