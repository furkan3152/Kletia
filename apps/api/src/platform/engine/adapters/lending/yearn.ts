/**
 * Yearn V3 vault deposits and withdrawals with an explicit loss limit on
 * every exit (protocols design 3.8): the registry-endorsed USDC-1 and
 * WETH-1 yVaults on Ethereum.
 *
 * Provenance, re-read before every plan, prepare and fact read: the vault's
 * runtime code is the EIP-1167 clone of the pinned Vault original,
 * `apiVersion()` is the pinned version, at least one pinned registry
 * `isEndorsed(vault)`, and `asset()` / `decimals()` match the pins.
 * `isShutdown()` refuses deposits only (withdrawals keep working).
 *
 * Yearn's three-argument ERC-4626 `redeem` accepts a 100% loss, so Kletia
 * never encodes it: exact exits call withdraw(assets, receiver, owner,
 * max_loss = 0) and "withdraw all" calls redeem(shares, receiver, owner,
 * max_loss = 1 bps), both with the default (empty) withdrawal queue; any
 * other loss limit fails the proof. Exit liquidity is
 * `maxWithdraw(owner, 0, [])` (idle cash plus what the strategies can
 * return without loss).
 */
import { decodeFunctionData, encodeFunctionData, getAddress, parseAbi, type Hex } from "viem";
import { CHAINS, type YearnVaultVenue } from "@kletia/core";
import { PlatformError } from "../../../errors.js";
import { evmClient } from "../../chains/evm.js";
import type { ProtocolAdapter } from "../types.js";
import { cloneTarget, withTimeout } from "./common.js";
import {
  assertMaxDeposit,
  assertVaultAsset,
  createVaultAdapter,
  probeCap,
  realisedApy,
  REDEEM_TOLERANCE_BPS,
  VAULT_ABI,
  vaultMetrics,
  vaultRead,
  type DecodedVaultCall,
  type VaultFamily,
} from "./erc4626.js";

/** The bounded exit overloads and the 3.0.x reads Kletia uses. */
export const YEARN_VAULT_ABI = [
  ...VAULT_ABI,
  ...parseAbi([
    "function withdraw(uint256 assets,address receiver,address owner,uint256 max_loss) returns (uint256 shares)",
    "function redeem(uint256 shares,address receiver,address owner,uint256 max_loss) returns (uint256 assets)",
    "function maxWithdraw(address owner,uint256 max_loss,address[] strategies) view returns (uint256)",
    "function apiVersion() view returns (string)",
    "function isShutdown() view returns (bool)",
  ]),
] as const;
export const YEARN_REGISTRY_ABI = parseAbi(["function isEndorsed(address vault) view returns (bool)"]);

/** max_loss of an exact withdraw: none. */
const WITHDRAW_MAX_LOSS = 0n;
const REFUSED = "The vault exit does not use the reviewed loss limit (withdraw with max_loss 0, redeem with max_loss 1).";

export const yearnFamily: VaultFamily<YearnVaultVenue> = {
  protocol: "yearn-v3",
  kind: "yearn-vault",
  label: "Yearn V3",
  shortName: "Yearn",
  abi: YEARN_VAULT_ABI,
  illiquidReason: () => "its strategies cannot return more without a loss",

  async verify(ref) {
    const { venue, network } = ref;
    const client = evmClient(network);
    const vault = getAddress(venue.target);
    const [target, version, shutdown, endorsements] = await Promise.all([
      cloneTarget(network, vault),
      withTimeout(client.readContract({ address: vault, abi: YEARN_VAULT_ABI, functionName: "apiVersion" })),
      withTimeout(client.readContract({ address: vault, abi: YEARN_VAULT_ABI, functionName: "isShutdown" })),
      Promise.all(venue.registries.map((registry) =>
        withTimeout(client.readContract({ address: getAddress(registry), abi: YEARN_REGISTRY_ABI, functionName: "isEndorsed", args: [vault] })).catch(() => false))),
      assertVaultAsset(ref),
    ]);
    if (!target || target.toLowerCase() !== venue.implementation.toLowerCase()) {
      throw new PlatformError(
        "VENUE_UNVERIFIED",
        `${venue.name} on ${CHAINS[network].name} is not a clone of the reviewed Yearn vault ${venue.implementation}. Kletia will not use it.`,
        422,
      );
    }
    if (version !== venue.apiVersion) {
      throw new PlatformError("VENUE_UNVERIFIED", `${venue.name} reports API version ${String(version).slice(0, 16)}, not ${venue.apiVersion}.`, 422);
    }
    if (!endorsements.some((endorsed) => endorsed === true)) {
      throw new PlatformError("VENUE_UNVERIFIED", `${venue.name} is not endorsed by its pinned Yearn registries. Kletia will not use it.`, 422);
    }
    return { gates: [], shutdown };
  },

  async assertDeposit(context, state, amount) {
    if (state.shutdown) {
      throw new PlatformError("RESERVE_UNAVAILABLE", `${context.venue.name} is shut down: it takes no deposits (withdrawals still work).`, 422);
    }
    await assertMaxDeposit(context, amount, "its deposit limit is reached");
  },

  positionValue(ref, shares) {
    return vaultRead(ref, "previewRedeem", shares);
  },

  exitLiquidity(ref, owner) {
    return withTimeout(evmClient(ref.network).readContract({
      address: getAddress(ref.venue.target),
      abi: YEARN_VAULT_ABI,
      functionName: "maxWithdraw",
      args: [owner, WITHDRAW_MAX_LOSS, []],
    }));
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

  async encodeWithdraw(context, assets) {
    return encodeFunctionData({ abi: YEARN_VAULT_ABI, functionName: "withdraw", args: [assets, context.owner, context.owner, WITHDRAW_MAX_LOSS] });
  },

  async encodeRedeem(context, shares) {
    return encodeFunctionData({ abi: YEARN_VAULT_ABI, functionName: "redeem", args: [shares, context.owner, context.owner, REDEEM_TOLERANCE_BPS] });
  },

  decodeCall(data: Hex): DecodedVaultCall {
    let decoded;
    try {
      decoded = decodeFunctionData({ abi: YEARN_VAULT_ABI, data });
    } catch {
      return { refused: REFUSED };
    }
    const args = (decoded.args ?? []) as readonly unknown[];
    if (decoded.functionName === "deposit" && args.length === 2) {
      return { functionName: "deposit", amount: args[0] as bigint, receiver: String(args[1]) };
    }
    const limit = decoded.functionName === "withdraw" ? WITHDRAW_MAX_LOSS : REDEEM_TOLERANCE_BPS;
    if ((decoded.functionName === "withdraw" || decoded.functionName === "redeem") && args.length === 4 && args[3] === limit) {
      return { functionName: decoded.functionName, amount: args[0] as bigint, receiver: String(args[1]), owner: String(args[2]) };
    }
    return { refused: REFUSED };
  },

  assetSink(venue) {
    return venue.target;
  },

  assetSource(venue) {
    return venue.target;
  },

  apy(ref) {
    return realisedApy(ref.venue);
  },
};

export const yearnAdapter: ProtocolAdapter | null = createVaultAdapter(yearnFamily);

export function yearnMetrics(venue: YearnVaultVenue) {
  return vaultMetrics(yearnFamily, venue);
}
