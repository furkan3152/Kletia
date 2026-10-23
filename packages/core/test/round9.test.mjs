import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  CURVE_POOLS,
  MORPHO_FACTORIES,
  RESERVED_CONTRACT_PHRASES,
  VENUE_CONTRACTS,
  YIELD_VENUES,
  capabilityIndex,
  curvePoolsFor,
  findAssetByAddress,
  findAssetBySymbol,
  findYieldVenue,
  getProtocol,
  protocolByWord,
  reservedContractPhrase,
  venueContracts,
  yieldVenuesFor,
} from "../dist/index.js";

/** Round 9 (E1: more EVM protocols): the new ids, venues and pins. */
const NEW_IDS = ["sky", "ethena", "kelp", "renzo"];
const ROUND9_VENUES = [
  "ethereum:compound-v3:usdt", "ethereum:compound-v3:usds", "base:compound-v3:aero",
  "ethereum:morpho:spark-blue-chip-usdt", "ethereum:morpho:steakhouse-prime-usdt", "ethereum:morpho:sky-usds-flagship", "ethereum:morpho:gauntlet-weth-prime",
  "base:morpho:steakhouse-high-yield-usdc", "base:morpho:grove-steakhouse-usdc", "base:morpho:steakhouse-eurc", "arbitrum:morpho:bitget-steakhouse-usdt",
  "optimism:morpho:re7-weth", "polygon:morpho:compound-weth",
  "ethereum:sky:susds", "ethereum:sky:sdai", "ethereum:ethena:susde",
];

const evidence = JSON.parse(readFileSync(new URL("./fixtures/protocols-2026-10-23.json", import.meta.url), "utf8"));
const verified = new Set(evidence.entries.filter((entry) => entry.verified).map((entry) => `${entry.network}:${entry.address.toLowerCase()}`));
const isVerified = (network, address) => verified.has(`${network}:${address.toLowerCase()}`);

test("round 9 registry: four new ids with words, tiers and kinds", () => {
  for (const id of NEW_IDS) {
    const protocol = getProtocol(id);
    assert.ok(protocol, id);
    assert.ok(protocol.words?.length > 0 && protocol.tier, id);
    assert.deepEqual(protocol.networks, ["ethereum"], id);
    for (const word of protocol.words) {
      assert.equal(protocolByWord(word)?.id, id, word);
      assert.ok(RESERVED_CONTRACT_PHRASES.includes(word), word);
    }
  }
  assert.deepEqual(getProtocol("sky").kinds, ["deposit", "withdraw"]);
  assert.deepEqual(getProtocol("ethena").kinds, ["deposit"], "sUSDe exits need Ethena's cooldown: deposits only");
  for (const id of ["kelp", "renzo"]) assert.deepEqual(getProtocol(id).kinds, ["stake"], id);
  assert.deepEqual(getProtocol("curve").networks, ["ethereum", "arbitrum"]);
  // Brand words are refused anywhere in an integrator alias; "sky" only as a whole alias.
  assert.equal(reservedContractPhrase("fast renzo lane"), "renzo");
  assert.equal(reservedContractPhrase("sky"), "sky");
  assert.equal(reservedContractPhrase("blue sky pay"), null);
});

test("every round-9 pin is read back on-chain (fixtures/protocols-2026-10-23.json)", () => {
  assert.deepEqual(evidence.summary.failed, []);
  for (const id of ROUND9_VENUES) {
    const venue = YIELD_VENUES.find((entry) => entry.id === id);
    assert.ok(venue, id);
    assert.ok(isVerified(venue.network, venue.target), `${id} target`);
  }
  for (const row of VENUE_CONTRACTS.filter((entry) => ["kelp", "renzo"].includes(entry.protocol))) {
    assert.ok(isVerified(row.network, row.address), `${row.protocol} ${row.role}`);
  }
  for (const pool of CURVE_POOLS.filter((entry) => entry.network === "arbitrum")) assert.ok(isVerified(pool.network, pool.pool), pool.id);
  for (const symbol of ["USDe", "rsETH", "ezETH"]) assert.ok(isVerified("ethereum", findAssetBySymbol("ethereum", symbol).address), symbol);
  assert.ok(isVerified("optimism", MORPHO_FACTORIES.optimism["vault-v2"]), "OP VaultV2Factory");
});

test("round 9 venues: savings vaults, defaults kept first, deposits-only sUSDe", () => {
  const susds = findYieldVenue("ethereum", "susds", "sky");
  assert.equal(susds.kind, "savings-vault");
  assert.equal(susds.asset, "USDS");
  assert.equal(susds.implementation, "0x4e7991e5C547ce825BdEb665EE14a3274f9F61e0");
  const sdai = findYieldVenue("ethereum", "0x83F20F44975D03b1b09e64809B757c47f942BEeA");
  assert.equal(sdai.id, "ethereum:sky:sdai");
  assert.equal(sdai.implementation, null, "sDAI is immutable");
  assert.deepEqual(sdai.pins.map((pin) => pin.call), ["pot", "daiJoin"]);
  const susde = findYieldVenue("ethereum", "susde", "ethena");
  assert.deepEqual(susde.actions, ["deposit"]);
  assert.equal(susde.asset, "USDe");
  // Existing defaults stay first within (network, protocol, asset).
  const first = (network, protocol, asset) => yieldVenuesFor(network, protocol).find((venue) => venue.asset === asset)?.id;
  assert.equal(first("ethereum", "morpho", "USDT"), "ethereum:morpho:steakhouse-usdt");
  assert.equal(first("base", "morpho", "USDC"), "base:morpho:steakhouse-prime-usdc");
  assert.equal(first("ethereum", "compound-v3", "USDC"), "ethereum:compound-v3:usdc");
  // Capability rows: deposits for sUSDS / sDAI / sUSDe, withdrawals only for Sky; stakes for Kelp and Renzo.
  const has = (network, kind, protocol, asset) => capabilityIndex(network, kind, asset).some((row) => row.protocol === protocol);
  assert.ok(has("ethereum", "deposit", "sky", "USDS") && has("ethereum", "deposit", "sky", "DAI"));
  assert.ok(has("ethereum", "withdraw", "sky", "DAI"));
  assert.ok(has("ethereum", "deposit", "ethena", "USDe") && !has("ethereum", "withdraw", "ethena", "USDe"));
  for (const protocol of ["kelp", "renzo"]) assert.ok(has("ethereum", "stake", protocol, "ETH"), protocol);
  assert.ok(has("arbitrum", "swap", "curve", "USDT0") && has("base", "deposit", "compound-v3", "AERO"));
});

test("round 9 pins: restaking tokens are registry assets, the Arbitrum Curve pool trades USDC and USDT0", () => {
  for (const [protocol, symbol] of [["kelp", "rsETH"], ["renzo", "ezETH"]]) {
    const [token] = venueContracts(protocol, "ethereum", "lst-token");
    assert.equal(findAssetByAddress("ethereum", token)?.symbol, symbol, protocol);
    assert.equal(venueContracts(protocol, "ethereum", "deposit-target").length, 1, protocol);
    assert.equal(venueContracts(protocol, "ethereum", "rate-oracle").length, 1, protocol);
  }
  assert.deepEqual(curvePoolsFor("arbitrum", ["usdc", "USDT"]).map((pool) => pool.id), [], "USDT is an alias: pools list registry symbols");
  assert.deepEqual(curvePoolsFor("arbitrum", ["USDC", "USDT0"]).map((pool) => pool.id), ["arbitrum:curve:usdc-usdt0"]);
  assert.deepEqual(curvePoolsFor("optimism"), [], "no Curve pool between registry assets with real liquidity on OP Mainnet");
});
