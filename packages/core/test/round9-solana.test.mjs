import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  JUPITER_DEX_FAMILIES,
  SOLANA_STAKE_POOLS,
  VENUE_CONTRACTS,
  YIELD_VENUES,
  findAssetBySymbol,
  findYieldVenue,
  getProtocol,
  isJupiterDexFamily,
  stakePoolsFor,
  venueContracts,
} from "../dist/index.js";

const evidence = JSON.parse(readFileSync(new URL("./fixtures/protocols-2026-10-23-solana.json", import.meta.url), "utf8"));
const verified = new Set(evidence.entries.filter((entry) => entry.verified).map((entry) => entry.address));
const ROUND9_KAMINO = ["solana:kamino:jlp-usdc", "solana:kamino:jlp-usdt", "solana:kamino:jlp-pyusd", "solana:kamino:altcoins-usdc"];
const ROUND9_POOLS = ["hSOL", "dSOL", "bonkSOL", "bSOL"];

test("round 9 registry: BlazeStake, Save and Solana Pay", () => {
  assert.deepEqual(getProtocol("blazestake").kinds, ["stake"]);
  assert.deepEqual(getProtocol("save").kinds, ["deposit", "withdraw"]);
  assert.equal(getProtocol("save").category, "lending");
  const pay = getProtocol("solana-pay");
  assert.deepEqual(pay.kinds, ["transfer"]);
  assert.equal(pay.explicitOnly, true);
  assert.deepEqual(pay.networks, ["solana", "solana-devnet"]);
  // "save" alone is an everyday word: Save is named "solend", "save finance" or "save lending".
  assert.ok(!getProtocol("save").words.includes("save"));
});

test("round 9 stake pools: one table, mirrored in VENUE_CONTRACTS, every LST an asset", () => {
  assert.deepEqual(stakePoolsFor("sanctum").map((pool) => pool.symbol), ["JupSOL", "hSOL", "dSOL", "bonkSOL"], "JupSOL stays the Sanctum default");
  assert.deepEqual(stakePoolsFor("blazestake").map((pool) => pool.symbol), ["bSOL"]);
  assert.deepEqual(stakePoolsFor("jito").map((pool) => pool.symbol), ["JitoSOL"]);
  for (const pool of SOLANA_STAKE_POOLS) {
    const asset = findAssetBySymbol("solana", pool.symbol);
    assert.equal(asset?.address, pool.mint, pool.symbol);
    assert.equal(asset.category, "liquid-staking", pool.symbol);
    for (const [role, address] of [["program", pool.program], ["stake-pool", pool.pool], ["pool-mint", pool.mint], ["reserve-stake", pool.reserve], ["fee-account", pool.feeAccount], ["validator-list", pool.validatorList]]) {
      assert.ok(venueContracts(pool.protocol, "solana", role).includes(address), `${pool.symbol} ${role}`);
    }
  }
  assert.equal(new Set(SOLANA_STAKE_POOLS.map((pool) => pool.mint)).size, SOLANA_STAKE_POOLS.length, "one pool per LST");
  // Sanctum pools live on two programs (multi-validator JupSOL, single-validator hSOL / dSOL / bonkSOL).
  assert.deepEqual(venueContracts("sanctum", "solana", "program"), ["SPMBzsVUuoHA4Jm6KunbsotaahvVikZs1JyTW6iJvbn", "SP12tWFxD9oJsVWNavTTBZvMbA6gkAmxtVgxdqvyvhY"]);
});

test("every round-9 pin is read back in the round-9 evidence (fixtures/protocols-2026-10-23-solana.json)", () => {
  assert.ok(evidence.entries.length >= 50);
  for (const pool of SOLANA_STAKE_POOLS.filter((entry) => ROUND9_POOLS.includes(entry.symbol))) {
    for (const address of [pool.program, pool.pool, pool.mint, pool.reserve, pool.feeAccount, pool.validatorList]) assert.ok(verified.has(address), `${pool.symbol} ${address}`);
  }
  for (const id of ROUND9_KAMINO) {
    const venue = YIELD_VENUES.find((entry) => entry.id === id);
    assert.ok(venue, id);
    for (const address of [venue.market, venue.marketAuthority, venue.reserve, venue.supplyVault]) assert.ok(verified.has(address), `${id} ${address}`);
  }
  for (const venue of YIELD_VENUES.filter((entry) => entry.kind === "save-reserve")) {
    for (const address of [venue.target, venue.market, venue.marketAuthority, venue.reserve, venue.supplyVault, venue.receipt.address]) assert.ok(verified.has(address), `${venue.id} ${address}`);
  }
  for (const row of Object.values(JUPITER_DEX_FAMILIES).flat()) assert.ok(verified.has(row.program), `Jupiter ${row.label}`);
  assert.ok(VENUE_CONTRACTS.some((row) => row.protocol === "save" && row.role === "program" && verified.has(row.address)));
});

test("round 9 venues: Kamino JLP / Altcoins reserves and Save cTokens resolve by slug and address, defaults unchanged", () => {
  assert.equal(findYieldVenue("solana", "usdc", "kamino")?.id, "solana:kamino:usdc", "the main market keeps its slugs");
  assert.equal(findYieldVenue("solana", "jlp-usdc", "kamino")?.name, "Kamino JLP USDC");
  assert.equal(findYieldVenue("solana", "Ga4rZytCpq1unD4DbEJ5bkHeUz9g3oh9AAFEi6vSauXp")?.id, "solana:kamino:jlp-usdc");
  assert.equal(YIELD_VENUES.find((venue) => venue.protocol === "kamino" && venue.asset === "USDC")?.id, "solana:kamino:usdc", "main USDC stays the default");
  const save = findYieldVenue("solana", "usdc", "save");
  assert.equal(save?.kind, "save-reserve");
  assert.equal(findYieldVenue("solana", "BgxfHJDzm44T7XG68MYKx7YisTjZu73tVovyZSjJMpmw")?.id, "solana:save:usdc", "by reserve");
  assert.equal(findYieldVenue("solana", "993dVFL2uXWYeoXuEBFXR4BijeXdTv4s6BzsCjJZuwqk")?.id, "solana:save:usdc", "by cToken");
  assert.equal(findYieldVenue("solana", save.target), null, "the shared program never names one reserve");
});

test("round 9 Jupiter venue families: labels unique, keys lower-case, no Lifinity", () => {
  const labels = Object.values(JUPITER_DEX_FAMILIES).flat().map((row) => row.label);
  assert.equal(new Set(labels).size, labels.length);
  for (const family of Object.keys(JUPITER_DEX_FAMILIES)) assert.match(family, /^[a-z]+$/u);
  assert.ok(isJupiterDexFamily("phoenix") && !isJupiterDexFamily("lifinity") && !isJupiterDexFamily("toString"));
});
