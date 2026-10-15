/**
 * Registry pins: every pin is unique, roles the adapters read as one
 * address are single, every network a pinned-venue protocol lists has a pin
 * (or is listed only, with a reason), testnet deployments never sit on a
 * mainnet network, the shared approval helper resets USDT-style allowances,
 * and the grammar reads the registry's new venue words without changing the
 * old ones.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeFunctionData, erc20Abi, getAddress } from "viem";
import {
  CHAINS,
  CURVE_POOLS,
  DEX_DEPLOYMENTS,
  findAssetBySymbol,
  getProtocol,
  PROTOCOLS,
  RESERVED_CONTRACT_PHRASES,
  VENUE_CONTRACTS,
  YIELD_VENUES,
  type AaveReserveVenue,
  type AccountId,
  type NetworkKey,
  type ProtocolId,
} from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { exactApproval, exactApprovalCalls, exactApprovals, needsApprovalReset, type LendingContext } from "../adapters/lending/common.js";
import { ADAPTERS } from "../adapters/registry.js";
import { compileIntentText, EVM_STAKING_TOKENS, GRAMMAR_VENUE_WORDS, isGrammarVenueWord, SWAP_VENUE_WORDS, SWAP_VENUES } from "../grammar.js";
import { ACCOUNTS, EVM_ADDRESS } from "./helpers.js";

const accounts = ACCOUNTS as AccountId[];

/** Roles an adapter reads as exactly one address per (protocol, network). */
const SINGLE_ROLES = new Set([
  "token-messenger", "message-transmitter", "token-minter", "token-messenger-minter", "deposit-target", "lst-token", "underlying-token",
  "config", "pauser", "stake-pool", "pool-mint", "reserve-stake", "fee-account", "validator-list", "program-state", "liquidity-leg",
  "addresses-provider", "locator", "storage", "liquidity-pool", "spoke-pool", "depository", "diamond",
]);

/**
 * Networks a pinned-venue protocol lists without a pin there, and why.
 * Anything else missing a pin fails the test.
 */
const LISTED_ONLY: Readonly<Partial<Record<ProtocolId, Readonly<Partial<Record<NetworkKey, string>>>>>> = {
  "cctp-v2": {
    arc: "testnet contracts held in CCTP_V2_TESTNET_CONTRACTS until the adapter's lane rule and sandbox Iris land (P6)",
    "arbitrum-sepolia": "same as Arc",
    "solana-devnet": "destination only, held with the testnet contracts (P6)",
  },
  lifi: { solana: "LI.FI delivers to Solana; Solana-origin routes are not built" },
};

function pinnedNetworks(protocol: ProtocolId): Set<NetworkKey> {
  return new Set<NetworkKey>([
    ...VENUE_CONTRACTS.filter((row) => row.protocol === protocol).map((row) => row.network),
    ...YIELD_VENUES.filter((venue) => venue.protocol === protocol).map((venue) => venue.network),
    ...DEX_DEPLOYMENTS.filter((deployment) => deployment.protocol === protocol).map((deployment) => deployment.network),
    ...CURVE_POOLS.filter((pool) => pool.protocol === protocol).map((pool) => pool.network),
  ]);
}

describe("registry pins", () => {
  it("every pin row is unique and single-address roles have one address per (protocol, network)", () => {
    const rows = new Set<string>();
    const singles = new Map<string, string>();
    for (const row of VENUE_CONTRACTS) {
      const address = CHAINS[row.network].vm === "evm" ? row.address.toLowerCase() : row.address;
      const id = `${row.protocol}|${row.network}|${row.role}|${address}`;
      assert.ok(!rows.has(id), `duplicate pin ${id}`);
      rows.add(id);
      if (SINGLE_ROLES.has(row.role)) {
        const slot = `${row.protocol}|${row.network}|${row.role}`;
        assert.ok(!singles.has(slot), `${slot} has two addresses (${singles.get(slot)}, ${row.address})`);
        singles.set(slot, row.address);
      }
    }
  });

  it("every network a pinned-venue protocol lists has a pin, or is listed only for a stated reason", () => {
    for (const protocol of PROTOCOLS) {
      if (!protocol.capabilities.includes("execute") || protocol.execution || !protocol.kinds?.length) continue;
      const pinned = pinnedNetworks(protocol.id);
      if (pinned.size === 0) continue; // API-routed or generic (Jupiter, transfers): nothing to pin per network
      for (const network of protocol.networks) {
        if (pinned.has(network)) continue;
        assert.ok(LISTED_ONLY[protocol.id]?.[network], `${protocol.id} lists ${network} without a pin`);
      }
      for (const network of Object.keys(LISTED_ONLY[protocol.id] ?? {}) as NetworkKey[]) {
        assert.ok(!pinned.has(network), `${protocol.id} ${network} is pinned now: drop it from LISTED_ONLY`);
      }
    }
  });

  it("testnet deployments sit on testnet networks only, and every mainnet deployment is a live-market one", () => {
    for (const deployment of DEX_DEPLOYMENTS) {
      const testnet = CHAINS[deployment.network].environment === "testnet";
      assert.equal(deployment.testnet === true, testnet, `${deployment.id}: testnet flag matches the network`);
    }
    for (const venue of YIELD_VENUES) assert.ok(getProtocol(venue.protocol)?.networks.includes(venue.network), venue.id);
  });

  it("round-7 adapter slots are empty: no new protocol executes before its package lands", () => {
    const live = new Set(ADAPTERS.flatMap((adapter) => adapter.protocols));
    for (const id of ["pancakeswap-v3", "camelot", "curve", "stader", "mantle-lsp", "frax-ether", "solana-stake"] as const) {
      assert.ok(!live.has(id), `${id} has no adapter yet`);
    }
    // jito / marinade / sanctum stakes keep running through the Jupiter adapter.
    for (const id of ["jito", "marinade", "sanctum"] as const) assert.ok(!live.has(id), id);
  });
});

describe("exact approvals with an allowance reset", () => {
  const usdt = findAssetBySymbol("ethereum", "USDT");
  const usdc = findAssetBySymbol("ethereum", "USDC");
  const spender = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";
  const decode = (data: `0x${string}`) => decodeFunctionData({ abi: erc20Abi, data });

  it("USDT allowance 5 -> amount 10 is approve(0) then approve(10); other tokens and empty allowances need one", () => {
    assert.ok(usdt?.address && usdc?.address);
    assert.equal(needsApprovalReset("ethereum", usdt.address), true);
    assert.equal(needsApprovalReset("ethereum", usdt.address.toLowerCase()), true, "case-insensitive");
    assert.equal(needsApprovalReset("ethereum", usdc.address), false);
    assert.equal(needsApprovalReset("optimism", findAssetBySymbol("optimism", "USDT")?.address ?? ""), false, "only Ethereum USDT");
    const calls = exactApprovalCalls("ethereum", usdt.address, spender, 10n, 5n);
    assert.deepEqual(calls.map((call) => [call.reset, call.amount]), [[true, 0n], [false, 10n]]);
    assert.deepEqual(calls.map((call) => decode(call.data).args), [[getAddress(spender), 0n], [getAddress(spender), 10n]]);
    assert.deepEqual(exactApprovalCalls("ethereum", usdt.address, spender, 10n, 0n).map((call) => call.amount), [10n], "no reset from zero");
    assert.deepEqual(exactApprovalCalls("ethereum", usdt.address, spender, 10n, 10n), [], "covered");
    assert.deepEqual(exactApprovalCalls("ethereum", usdc.address, spender, 10n, 5n).map((call) => call.amount), [10n], "USDC approves over a non-zero allowance");
  });

  it("lending: exactApprovals returns both transactions; the single-transaction form refuses instead of emitting a reverting approve", async () => {
    assert.ok(usdt?.address);
    const venue = YIELD_VENUES.find((entry) => entry.id === "ethereum:aave-v3:usdt") as AaveReserveVenue;
    assert.ok(venue);
    const context: LendingContext<AaveReserveVenue> = {
      venue, network: "ethereum", chainId: 1, kind: "deposit", owner: getAddress(EVM_ADDRESS), underlying: usdt,
      token: getAddress(usdt.address), native: false,
    };
    const both = await exactApprovals(context, venue.spender, 10_000_000n, 5n);
    assert.equal(both.length, 2);
    assert.ok(both.every((tx) => getAddress(tx.to) === getAddress(usdt.address as string) && tx.value === "0"));
    assert.match(both[0]?.description ?? "", /Reset the USDT allowance/u);
    assert.deepEqual(decode(both[1]?.data as `0x${string}`).args, [getAddress(venue.spender), 10_000_000n]);
    await assert.rejects(exactApproval(context, venue.spender, 10_000_000n, 5n), (error: unknown) =>
      error instanceof PlatformError && error.code === "APPROVAL_RESET_REQUIRED");
    assert.equal((await exactApproval(context, venue.spender, 10_000_000n, 0n))?.to, getAddress(usdt.address));
    assert.equal(await exactApproval(context, venue.spender, 10_000_000n, 10_000_000n), null);
  });
});

describe("grammar venue words from the registry", () => {
  const shape = (text: string) =>
    compileIntentText(text, { accounts }).actions.map((action) =>
      [action.kind, action.network, action.from ?? "-", action.to ?? "-", action.amount, action.protocol ?? "-"].join(" "));

  it("keeps the hand-written words first and adds the registry venues", () => {
    assert.ok(SWAP_VENUE_WORDS.startsWith("jupiter|jup|raydium|orca|meteora|uniswap(?:[\\s-]+v3)?|aerodrome|velodrome|"));
    for (const word of ["pancakeswap", "pancake", "pancakeswap v3", "camelot", "curve", "3pool", "stader", "ethx", "mantle", "meth", "frax", "sfrxeth"]) {
      assert.ok(GRAMMAR_VENUE_WORDS.includes(word), word);
      assert.ok(isGrammarVenueWord(word), word);
      assert.ok(RESERVED_CONTRACT_PHRASES.includes(word), word);
    }
    assert.deepEqual(SWAP_VENUES.slice(-3).map((venue) => venue.protocol), ["pancakeswap-v3", "camelot", "curve"]);
    assert.deepEqual(EVM_STAKING_TOKENS.stader, { symbol: "ETHx", provider: "Stader", protocol: "stader" });
    assert.deepEqual(EVM_STAKING_TOKENS.meth, { symbol: "mETH", provider: "Mantle LSP", protocol: "mantle-lsp" });
    assert.deepEqual(EVM_STAKING_TOKENS["frax ether"], { symbol: "sfrxETH", provider: "Frax Ether", protocol: "frax-ether" });
    assert.equal(EVM_STAKING_TOKENS.lido?.protocol, "lido", "bare stake stays Lido");
  });

  it("reads the new venues in sentences (the planner refuses them until their adapters land)", () => {
    assert.deepEqual(shape("swap 1000 USDC to USDT on ethereum via pancake"), ["swap ethereum USDC USDT 1000 pancakeswap-v3"]);
    assert.deepEqual(shape("swap 1000 USDC to USDT on ethereum via pancakeswap-v3"), ["swap ethereum USDC USDT 1000 pancakeswap-v3"]);
    assert.deepEqual(shape("swap 1000 USDC to ETH via camelot on arbitrum"), ["swap arbitrum USDC ETH 1000 camelot"]);
    assert.deepEqual(shape("swap 1000 USDC to USDT on ethereum via curve"), ["swap ethereum USDC USDT 1000 curve"]);
    assert.deepEqual(shape("stake 1 ETH with stader"), ["stake ethereum ETH ETHx 1 stader"]);
    assert.deepEqual(shape("stake 1 ETH with mantle"), ["stake ethereum ETH mETH 1 mantle-lsp"]);
    assert.deepEqual(shape("stake 1 ETH with frax"), ["stake ethereum ETH sfrxETH 1 frax-ether"]);
    assert.deepEqual(shape("stake 1 ETH"), ["stake ethereum ETH wstETH 1 lido"]);
    assert.deepEqual(shape("swap 100 USDC to ETH via uniswap on arbitrum"), ["swap arbitrum USDC ETH 100 uniswap-v3"]);
  });
});
