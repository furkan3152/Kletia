import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  ASSETS,
  CHAINS,
  CCTP_V2_TESTNET_CONTRACTS,
  CURVE_POOLS,
  DEX_DEPLOYMENTS,
  MORPHO_FACTORIES,
  PROTOCOLS,
  RESERVED_CONTRACT_PHRASES,
  VENUE_CONTRACTS,
  YIELD_VENUES,
  assetAliasNote,
  capabilityIndex,
  capableProtocols,
  curvePoolsFor,
  findAssetByAddress,
  findAssetBySymbol,
  getProtocol,
  isVenueContract,
  protocolByWord,
  protocolTier,
  reservedContractPhrase,
  reservedIntegratorName,
  venueContracts,
} from "../dist/index.js";

const NEW_IDS = ["pancakeswap-v3", "camelot", "curve", "stader", "mantle-lsp", "frax-ether", "solana-stake"];
/** Protocols whose every pin is a round-7 pin. */
const ROUND7_PROTOCOLS = new Set([...NEW_IDS, "jito", "sanctum", "marinade"]);
/** Yield venues added in round 7 (protocols design 3.2). */
const ROUND7_VENUES = [
  "ethereum:aave-v3:usdt", "ethereum:aave-v3:wsteth", "ethereum:aave-v3:cbbtc", "arbitrum:aave-v3:usdt0", "arbitrum:aave-v3:wsteth",
  "optimism:aave-v3:usdt", "optimism:aave-v3:wsteth", "polygon:aave-v3:usdt0", "polygon:aave-v3:wsteth", "base:aave-v3:wsteth",
  "base:aave-v3:cbeth", "arbitrum-sepolia:aave-v3:usdc",
  "arbitrum:compound-v3:usdt0", "optimism:compound-v3:usdt", "polygon:compound-v3:usdt0", "ethereum:compound-v3:wsteth",
  "ethereum:morpho:steakhouse-usdc", "ethereum:morpho:steakhouse-usdt", "ethereum:morpho:steakhouse-eth",
  "optimism:morpho:gauntlet-usdc-prime", "polygon:morpho:compound-usdc", "polygon:morpho:compound-usdt",
];
const ROUND7_ASSETS = [
  ["ethereum", "USDT"], ["ethereum", "DAI"], ["ethereum", "USDS"], ["ethereum", "cbBTC"], ["ethereum", "cbETH"], ["ethereum", "ETHx"],
  ["ethereum", "mETH"], ["ethereum", "sfrxETH"], ["arbitrum", "USDT0"], ["arbitrum", "wstETH"], ["arbitrum", "DAI"],
  ["optimism", "USDT"], ["optimism", "wstETH"], ["optimism", "OP"], ["polygon", "USDT0"], ["polygon", "wstETH"], ["polygon", "DAI"],
  ["base", "wstETH"], ["base", "cbETH"], ["base", "weETH"], ["arc", "EURC"], ["arbitrum-sepolia", "WETH"],
];

const evidence = JSON.parse(readFileSync(new URL("./fixtures/protocols-2026-10-15.json", import.meta.url), "utf8"));
const key = (network, address) => `${network}:${CHAINS[network].vm === "evm" ? address.toLowerCase() : address}`;
const verified = new Set(evidence.entries.filter((entry) => entry.verified).map((entry) => key(entry.network, entry.address)));

test("round 7 registry: seven new ids with words and tiers; Solana LSTs execute stake", () => {
  for (const id of NEW_IDS) {
    const protocol = getProtocol(id);
    assert.ok(protocol, id);
    assert.ok(protocol.words?.length > 0, `${id} words`);
    assert.ok(protocol.tier, `${id} tier`);
    assert.ok(protocol.capabilities.includes("execute"), id);
  }
  for (const id of ["jito", "marinade", "sanctum"]) assert.deepEqual(getProtocol(id).kinds, ["stake"], id);
  assert.ok(getProtocol("uniswap-v3").networks.includes("arbitrum-sepolia"));
  for (const network of ["optimism", "polygon"]) assert.ok(getProtocol("morpho").networks.includes(network), network);
  assert.ok(getProtocol("compound-v3").networks.includes("polygon"));
  // Words are unique across protocols and every word reads back to its protocol.
  const seen = new Map();
  for (const protocol of PROTOCOLS) {
    for (const word of protocol.words ?? []) {
      assert.equal(word, word.toLowerCase().trim(), `${protocol.id} word ${word} is lower-case`);
      assert.ok(!seen.has(word), `${word} is named by ${seen.get(word)} and ${protocol.id}`);
      seen.set(word, protocol.id);
      assert.equal(protocolByWord(word)?.id, protocol.id, word);
      assert.ok(RESERVED_CONTRACT_PHRASES.includes(word), `${word} is a reserved contract phrase`);
    }
  }
  assert.equal(protocolByWord("Pancake-Swap V3"), null, "words are matched whole, not by substring");
  assert.equal(protocolByWord("PancakeSwap  V3")?.id, "pancakeswap-v3");
  assert.equal(protocolTier("aave-v3"), "core");
  assert.equal(protocolTier("aave-v3", "arbitrum-sepolia"), "testnet");
  assert.equal(protocolTier("camelot"), "extended");
  assert.equal(protocolTier("ens"), "extended", "untiered protocols are extended");
  for (const id of ["raydium", "orca", "meteora"]) assert.equal(getProtocol(id).explicitOnly, true, id);
});

test("round 7 assets: rows match tokens.json, aliases resolve on their network only", () => {
  for (const [network, symbol] of ROUND7_ASSETS) {
    const asset = findAssetBySymbol(network, symbol);
    assert.ok(asset, `${network} ${symbol}`);
    const row = evidence.entries.find((entry) => entry.source === "tokens.json" && entry.network === network && entry.address.toLowerCase() === asset.address.toLowerCase());
    assert.ok(row?.verified, `${network} ${symbol} read back`);
    assert.equal(row.decimals, asset.decimals, `${network} ${symbol} decimals`);
  }
  assert.equal(findAssetBySymbol("ethereum", "USDT").approvalReset, true);
  assert.deepEqual(ASSETS.filter((asset) => asset.approvalReset).map((asset) => `${asset.network}:${asset.symbol}`), ["ethereum:USDT"]);
  // USDT0 answers to USDT on Arbitrum and Polygon; an exact symbol always wins; never across networks.
  assert.equal(findAssetBySymbol("arbitrum", "usdt").symbol, "USDT0");
  assert.equal(findAssetBySymbol("polygon", "USDT").symbol, "USDT0");
  assert.equal(findAssetBySymbol("optimism", "USDT").symbol, "USDT");
  assert.equal(findAssetBySymbol("base", "USDT"), null);
  assert.match(assetAliasNote("arbitrum", "USDT"), /USDT0/u);
  assert.equal(assetAliasNote("arbitrum", "USDT0"), null);
  for (const network of ["arbitrum", "polygon", "optimism", "ethereum"]) assert.equal(findAssetBySymbol(network, "USDT").group, "USDT", network);
  // "ETH" on Polygon is a reading (bridged WETH), resolved only when the reader opts in.
  assert.equal(findAssetBySymbol("polygon", "ETH"), null);
  assert.equal(findAssetBySymbol("polygon", "ETH", { readings: true }).symbol, "WETH");
  assert.match(assetAliasNote("polygon", "ETH", { readings: true }), /POL/u);
  assert.equal(findAssetBySymbol("base", "weETH").transferOnly, true);
  assert.equal(findAssetBySymbol("ethereum", "weETH").transferOnly, undefined);
});

test("every round-7 pin is read back in the round-7 evidence (fixtures/protocols-2026-10-15.json)", () => {
  const rows = [...VENUE_CONTRACTS.filter((entry) => ROUND7_PROTOCOLS.has(entry.protocol)), ...CCTP_V2_TESTNET_CONTRACTS];
  assert.ok(rows.length >= 40, `${rows.length} rows`);
  for (const row of rows) assert.ok(verified.has(key(row.network, row.address)), `${row.protocol} ${row.role} ${row.network} ${row.address}`);
  for (const deployment of DEX_DEPLOYMENTS.filter((entry) => ["pancakeswap-v3", "camelot"].includes(entry.protocol) || entry.testnet)) {
    for (const address of [deployment.factory, deployment.router, deployment.quoter, deployment.wrappedNative, deployment.poolDeployer].filter(Boolean)) {
      assert.ok(verified.has(key(deployment.network, address)), `${deployment.id} ${address}`);
    }
  }
  for (const id of ROUND7_VENUES) {
    const venue = YIELD_VENUES.find((entry) => entry.id === id);
    assert.ok(venue, id);
    // Aave Pools on mainnet are round-6 pins (the reserve's aToken is the round-7 read-back, via the data provider).
    const earlier = YIELD_VENUES.some((entry) => !ROUND7_VENUES.includes(entry.id) && entry.network === venue.network && entry.target === venue.target);
    assert.ok(verified.has(key(venue.network, venue.target)) || earlier, `${id} target`);
    assert.ok(verified.has(key(venue.network, venue.receipt.address)), `${id} receipt`);
    if (venue.kind === "erc4626") assert.ok(verified.has(key(venue.network, venue.factory)), `${id} factory`);
  }
  for (const pool of CURVE_POOLS) assert.ok(verified.has(key(pool.network, pool.pool)), pool.id);
  // The Steakhouse vaults are v1.0 (factory pinned on Ethereum now); OP and Polygon have v1.1 factories only.
  assert.equal(MORPHO_FACTORIES.ethereum["metamorpho-v1.0"], "0xA9c3D3a366466Fa809d1Ae982Fb2c46E5fC41101");
  assert.equal(MORPHO_FACTORIES.optimism["metamorpho-v1.1"], "0x3Bb6A6A0Bc85b367EFE0A5bAc81c5E52C892839a");
  assert.equal(MORPHO_FACTORIES.polygon["metamorpho-v1.1"], "0xa9c87daB340631C34BB738625C70499e29ddDC98");
});

test("round 7 pins: staking tokens, pool mints and the Curve coins are the registry assets", () => {
  for (const [protocol, symbol] of [["stader", "ETHx"], ["mantle-lsp", "mETH"], ["frax-ether", "sfrxETH"]]) {
    const [token] = venueContracts(protocol, "ethereum", "lst-token");
    assert.equal(findAssetByAddress("ethereum", token)?.symbol, symbol, protocol);
    assert.equal(venueContracts(protocol, "ethereum", "deposit-target").length, 1, protocol);
  }
  for (const [protocol, symbol] of [["jito", "JitoSOL"], ["sanctum", "JupSOL"], ["marinade", "mSOL"]]) {
    const [mint] = venueContracts(protocol, "solana", "pool-mint");
    assert.equal(findAssetByAddress("solana", mint)?.symbol, symbol, protocol);
  }
  for (const network of ["solana", "solana-devnet"]) {
    assert.deepEqual(venueContracts("solana-stake", network, "program"), ["Stake11111111111111111111111111111111111111"], network);
    assert.ok(venueContracts("solana-stake", network, "vote-account").length >= 1, network);
  }
  // Default mainnet vote accounts charge at most 5 % commission.
  for (const vote of venueContracts("solana-stake", "solana", "vote-account")) {
    const row = evidence.entries.find((entry) => entry.address === vote && entry.network === "solana" && entry.commission !== undefined);
    assert.ok(row && row.commission <= 5, vote);
  }
  for (const pool of CURVE_POOLS) {
    for (const coin of pool.coins) assert.ok(findAssetBySymbol(pool.network, coin), `${pool.id} ${coin}`);
    assert.ok(isVenueContract("curve", pool.network, pool.pool, "curve-pool"), pool.id);
  }
  assert.deepEqual(curvePoolsFor("ethereum", ["usdc", "USDT"]).map((pool) => pool.id), ["ethereum:curve:3pool"]);
  assert.deepEqual(curvePoolsFor("ethereum", ["USDC", "WETH"]), []);
  // CCTP testnet contracts are pinned since P6 (lane rule and sandbox Iris).
  for (const network of ["arc", "arbitrum-sepolia"]) {
    for (const role of ["token-messenger", "message-transmitter", "token-minter"]) {
      assert.equal(CCTP_V2_TESTNET_CONTRACTS.filter((row) => row.network === network && row.role === role).length, 1, `${network} ${role}`);
      const [row] = CCTP_V2_TESTNET_CONTRACTS.filter((entry) => entry.network === network && entry.role === role);
      assert.deepEqual(venueContracts("cctp-v2", network, role), [row.address], `${network} ${role} pinned`);
    }
  }
  for (const row of CCTP_V2_TESTNET_CONTRACTS) {
    assert.equal(CHAINS[row.network].environment, "testnet");
    assert.ok(getProtocol("cctp-v2").networks.includes(row.network));
  }
});

test("capability index: section-4 coverage rows, tiers, testnets and explicit-only venues", () => {
  const has = (network, kind, protocol, asset) => capabilityIndex(network, kind, asset).some((row) => row.protocol === protocol && (asset === undefined || row.asset === null || row.asset.toUpperCase() === asset.toUpperCase()));
  // Swaps (section 4)
  for (const network of ["ethereum", "base", "arbitrum"]) assert.ok(has(network, "swap", "pancakeswap-v3"), `pancake ${network}`);
  assert.ok(has("arbitrum", "swap", "camelot"));
  assert.ok(has("ethereum", "swap", "curve", "USDT") && has("ethereum", "swap", "curve", "DAI"));
  assert.ok(!capabilityIndex("ethereum", "swap", "WETH").some((row) => row.protocol === "curve"), "Curve rows are per coin");
  assert.ok(has("arbitrum-sepolia", "swap", "uniswap-v3"));
  assert.ok(!has("polygon", "swap", "pancakeswap-v3"));
  // Lending (section 4)
  assert.ok(has("ethereum", "deposit", "aave-v3", "USDT") && has("ethereum", "deposit", "aave-v3", "cbBTC"));
  assert.ok(has("arbitrum", "deposit", "aave-v3", "USDT0") && has("arbitrum", "deposit", "compound-v3", "USDT0"));
  assert.ok(has("polygon", "deposit", "compound-v3", "USDT0") && has("polygon", "deposit", "morpho", "USDC"));
  assert.ok(has("optimism", "deposit", "morpho", "USDC") && has("base", "deposit", "aave-v3", "cbETH"));
  assert.ok(has("arbitrum-sepolia", "deposit", "aave-v3", "USDC"));
  const deposit = capabilityIndex("ethereum", "deposit", "USDT").find((row) => row.protocol === "aave-v3");
  assert.equal(deposit.venueId, "ethereum:aave-v3:usdt");
  assert.equal(deposit.tier, "core");
  // Stake (section 4)
  for (const protocol of ["lido", "rocket-pool", "etherfi", "stader", "mantle-lsp", "frax-ether"]) assert.ok(has("ethereum", "stake", protocol, "ETH"), protocol);
  for (const protocol of ["jito", "sanctum", "marinade", "solana-stake", "jupiter"]) assert.ok(has("solana", "stake", protocol, "SOL"), protocol);
  assert.deepEqual(capableProtocols("stake", "solana-devnet"), ["solana-stake"]);
  assert.deepEqual(capableProtocols("stake", "base"), [], "no L2 staking venue (the L2 stake question is P7)");
  // Bridges: CCTP only where pinned (not the testnets yet), never from Solana (destination only); USDC only.
  for (const network of ["arc", "arbitrum-sepolia"]) assert.ok(has(network, "bridge", "cctp-v2", "USDC"), network);
  assert.ok(has("base", "bridge", "cctp-v2", "USDC"));
  assert.ok(!capabilityIndex("solana", "bridge").some((row) => row.protocol === "cctp-v2"));
  assert.ok(!capabilityIndex("solana-devnet", "bridge").some((row) => row.protocol === "cctp-v2"));
  assert.ok(!has("base", "bridge", "cctp-v2", "WETH"), "CCTP moves USDC only");
  assert.ok(has("base", "bridge", "across", "WETH"), "any-asset bridges match any asset");
  // Tiers, testnets, explicit-only, no console/service or integrator kinds.
  for (const row of capabilityIndex()) {
    assert.equal(row.tier === "testnet", CHAINS[row.network].environment === "testnet", `${row.network} ${row.protocol}`);
    assert.ok(getProtocol(row.protocol).networks.includes(row.network), `${row.protocol} lists ${row.network}`);
    assert.ok(!getProtocol(row.protocol).execution, row.protocol);
    assert.ok(!["call", "action"].includes(row.kind));
  }
  assert.ok(capabilityIndex("solana", "swap").filter((row) => ["raydium", "orca", "meteora"].includes(row.protocol)).every((row) => row.explicitOnly));
  assert.ok(capabilityIndex("solana", "swap").some((row) => row.protocol === "jupiter" && !row.explicitOnly));
  assert.ok(!capabilityIndex().some((row) => row.protocol === "kletia-router-v2" || row.protocol === "basenames"));
});

test("round 7 reserved words: brand words anywhere, common words only as a whole alias", () => {
  for (const word of ["pancakeswap", "camelot", "stader", "ethx", "sfrxeth", "frxeth"]) assert.equal(reservedContractPhrase(`acme ${word} vault`), word, word);
  for (const phrase of ["curve", "pancake", "mantle", "meth", "frax", "native stake", "validator", "3pool"]) assert.equal(reservedContractPhrase(phrase), phrase, phrase);
  for (const alias of ["curve vault", "frax helper", "mantle pool"]) assert.equal(reservedContractPhrase(alias), null, alias);
  assert.equal(reservedIntegratorName("PancakeSwap Tools")?.word, "pancakeswap");
  assert.equal(reservedIntegratorName("Curve Fans")?.word, "curve");
  assert.equal(reservedIntegratorName("Curved Labs"), null, "curve is a whole word");
});
