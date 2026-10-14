/**
 * Fluid Lending fToken deposits and withdrawals with on-chain share and
 * asset floors (protocols design 3.7), on Ethereum, Base, Arbitrum One and
 * Polygon PoS.
 *
 * Provenance, re-read before every plan, prepare and fact read: the fToken's
 * `getData()` reports the pinned Liquidity layer and LendingFactory (fTokens
 * do not expose them as public getters), the factory's `allTokens()` lists
 * the fToken, and `asset()` / `decimals()` match the pins.
 *
 * Kletia always uses the floor-carrying overloads: deposit(assets, receiver,
 * minAmountOut = previewDeposit less SHARE_TOLERANCE_BPS), withdraw(assets,
 * receiver, owner, maxSharesBurn = previewWithdraw plus the tolerance) and
 * redeem(shares, receiver, owner, minAmountOut); the plain ERC-4626
 * overloads are refused in proofs. Exits are bounded by `maxWithdraw(owner)`,
 * which follows the Liquidity layer's expanding withdrawal limit; deposits by
 * `minDeposit()` and `maxDeposit(account)`. Underlying moves between the
 * account and the Liquidity layer (not the fToken). Native ETH uses the
 * shared wrap / unwrap legs, never `depositNative`.
 */
import { decodeFunctionData, encodeFunctionData, getAddress, parseAbi, type Hex } from "viem";
import { CHAINS, type FluidFTokenVenue } from "@kletia/core";
import { PlatformError } from "../../../errors.js";
import { evmClient } from "../../chains/evm.js";
import type { ProtocolAdapter } from "../types.js";
import { assertPinned, formatUnits, SHARE_TOLERANCE_BPS, withTimeout } from "./common.js";
import {
  assertMaxDeposit,
  assertVaultAsset,
  createVaultAdapter,
  probeCap,
  realisedApy,
  VAULT_ABI,
  vaultMetrics,
  vaultRead,
  type DecodedVaultCall,
  type VaultFamily,
} from "./erc4626.js";

/** fToken overloads with floors, getData() and minDeposit(); plus the factory's token list. */
export const FTOKEN_ABI = [
  ...VAULT_ABI,
  ...parseAbi([
    "function deposit(uint256 assets,address receiver,uint256 minAmountOut) returns (uint256 shares)",
    "function withdraw(uint256 assets,address receiver,address owner,uint256 maxSharesBurn) returns (uint256 shares)",
    "function redeem(uint256 shares,address receiver,address owner,uint256 minAmountOut) returns (uint256 assets)",
    "function minDeposit() view returns (uint256)",
    "function getData() view returns (address liquidity_,address lendingFactory_,address lendingRewardsRateModel_,address permit2_,address rebalancer_,bool rewardsActive_,uint256 liquidityBalance_,uint256 liquidityExchangePrice_,uint256 tokenExchangePrice_)",
    "error FluidLendingError(uint256 errorId_)",
  ]),
] as const;
export const FLUID_FACTORY_ABI = parseAbi(["function allTokens() view returns (address[])"]);

const REFUSED = "The fToken call is not one of the floor-carrying overloads Kletia encodes.";

export const fluidFamily: VaultFamily<FluidFTokenVenue> = {
  protocol: "fluid",
  kind: "fluid-ftoken",
  label: "Fluid Lending",
  shortName: "Fluid",
  abi: FTOKEN_ABI,
  illiquidReason: () => "the Liquidity layer's withdrawal limit expands over the next hours",

  async verify(ref) {
    const { venue, network } = ref;
    const client = evmClient(network);
    const fToken = getAddress(venue.target);
    const [data, tokens] = await Promise.all([
      withTimeout(client.readContract({ address: fToken, abi: FTOKEN_ABI, functionName: "getData" })),
      withTimeout(client.readContract({ address: getAddress(venue.lendingFactory), abi: FLUID_FACTORY_ABI, functionName: "allTokens" })),
      assertVaultAsset(ref),
    ]);
    assertPinned(data[0], venue.liquidity, "Liquidity (getData)", venue);
    assertPinned(data[1], venue.lendingFactory, "LendingFactory (getData)", venue);
    if (!tokens.some((token) => token.toLowerCase() === fToken.toLowerCase())) {
      throw new PlatformError(
        "VENUE_UNVERIFIED",
        `${venue.name} on ${CHAINS[network].name} is not listed by the pinned Fluid LendingFactory ${venue.lendingFactory}. Kletia will not use it.`,
        422,
      );
    }
    return { gates: [] };
  },

  async assertDeposit(context, _state, amount) {
    const minimum = await withTimeout(evmClient(context.network).readContract({ address: getAddress(context.venue.target), abi: FTOKEN_ABI, functionName: "minDeposit" }));
    if (amount < minimum) {
      throw new PlatformError("AMOUNT_TOO_SMALL", `${context.venue.name} takes at least ${formatUnits(minimum, context.underlying.decimals, context.underlying.symbol)} per deposit.`, 422);
    }
    await assertMaxDeposit(context, amount, "its supply limit is reached");
  },

  positionValue(ref, shares) {
    return vaultRead(ref, "previewRedeem", shares);
  },

  exitLiquidity(ref, owner) {
    return vaultRead(ref, "maxWithdraw", owner);
  },

  capRemaining(ref) {
    return probeCap(ref);
  },

  async venueExitLiquidity() {
    return null;
  },

  async encodeDeposit(context, assets, minShares) {
    return encodeFunctionData({ abi: FTOKEN_ABI, functionName: "deposit", args: [assets, context.owner, minShares] });
  },

  async encodeWithdraw(context, assets) {
    const shares = await vaultRead(context, "previewWithdraw", assets);
    // The burn may grow with the share price between prepare and execution; never beyond the tolerance.
    const maxSharesBurn = (shares * (10_000n + SHARE_TOLERANCE_BPS)) / 10_000n + 1n;
    return encodeFunctionData({ abi: FTOKEN_ABI, functionName: "withdraw", args: [assets, context.owner, context.owner, maxSharesBurn] });
  },

  async encodeRedeem(context, shares, minAssets) {
    return encodeFunctionData({ abi: FTOKEN_ABI, functionName: "redeem", args: [shares, context.owner, context.owner, minAssets] });
  },

  decodeCall(data: Hex): DecodedVaultCall {
    let decoded;
    try {
      decoded = decodeFunctionData({ abi: FTOKEN_ABI, data });
    } catch {
      return { refused: REFUSED };
    }
    const args = (decoded.args ?? []) as readonly unknown[];
    if (decoded.functionName === "deposit" && args.length === 3 && (args[2] as bigint) > 0n) {
      return { functionName: "deposit", amount: args[0] as bigint, receiver: String(args[1]) };
    }
    if ((decoded.functionName === "withdraw" || decoded.functionName === "redeem") && args.length === 4 && (args[3] as bigint) > 0n) {
      return { functionName: decoded.functionName, amount: args[0] as bigint, receiver: String(args[1]), owner: String(args[2]) };
    }
    return { refused: REFUSED };
  },

  assetSink(venue) {
    return venue.liquidity;
  },

  assetSource(venue) {
    return venue.liquidity;
  },

  apy(ref) {
    return realisedApy(ref.venue);
  },
};

export const fluidAdapter: ProtocolAdapter | null = createVaultAdapter(fluidFamily);

export function fluidMetrics(venue: FluidFTokenVenue) {
  return vaultMetrics(fluidFamily, venue);
}
