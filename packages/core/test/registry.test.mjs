import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  AMBIGUOUS_VENUE_WORDS,
  ASSETS,
  DEX_DEPLOYMENTS,
  EXECUTABLE_PROTOCOLS,
  RESERVED_CONTRACT_PHRASES,
  dexContracts,
  dexDeploymentsFor,
  protocolDependencies,
  venueByLabel,
  CHAINS,
  MORPHO_FACTORIES,
  NETWORK_KEYS,
  PROTOCOLS,
  VENUE_CONTRACTS,
  YIELD_VENUES,
  counterpartAsset,
  findAssetBySymbol,
  findYieldVenue,
  getProtocol,
  getYieldVenue,
  isEvmAddress,
  isSolanaAddress,
  isVenueContract,
  protocolExecutesKind,
  resolveChain,
  validateIntentRequest,
  venueContracts,
  yieldVenuesFor,
} from "../dist/index.js";

const NEW_NETWORKS = { ethereum: [1, 0], optimism: [10, 2], polygon: [137, 7] };

test("Ethereum, OP Mainnet and Polygon are production EVM chains with every settlement id", () => {
  for (const [key, [chainId, domain]] of Object.entries(NEW_NETWORKS)) {
    const chain = CHAINS[key];
    assert.equal(chain.id, `eip155:${chainId}`);
    assert.equal(chain.reference, String(chainId));
    assert.equal(chain.evmChainId, chainId);
    assert.equal(chain.vm, "evm");
    assert.equal(chain.environment, "mainnet");
    assert.equal(chain.lane, "production");
    assert.deepEqual(chain.settlement, {
      cctpDomain: domain,
      relayChainId: chainId,
      debridgeChainId: chainId,
      acrossChainId: chainId,
      lifiChainId: chainId,
    });
    assert.match(chain.explorer.tx, /^https:\/\/[^/]+\/tx\/\{hash\}$/u);
    assert.match(chain.explorer.address, /\{address\}$/u);
    assert.match(chain.color, /^#[0-9A-F]{6}$/u);
    assert.equal(resolveChain(chainId).key, key);
    assert.equal(resolveChain(String(chainId)).key, key);
  }
  assert.equal(CHAINS.polygon.nativeAsset.symbol, "POL");
  assert.equal(CHAINS.solana.settlement.lifiChainId, 1151111081099710);
  assert.ok(Number.isSafeInteger(CHAINS.solana.settlement.lifiChainId));
  assert.equal(CHAINS.base.settlement.lifiChainId, 8453);
  assert.equal(CHAINS.arbitrum.settlement.lifiChainId, 42161);
  for (const alias of ["op", "op mainnet", "optimism-mainnet"]) assert.equal(resolveChain(alias).key, "optimism", alias);
  for (const alias of ["polygon pos", "polygon-mainnet", "matic"]) assert.equal(resolveChain(alias).key, "polygon", alias);
  assert.equal(resolveChain("ethereum mainnet").key, "ethereum");
});

test("every production EVM chain lists native USDC, the native asset and a wrapped native", () => {
  for (const network of ["base", "arbitrum", "ethereum", "optimism", "polygon"]) {
    const usdc = findAssetBySymbol(network, "USDC");
    assert.equal(usdc?.group, "USDC", network);
    assert.equal(usdc?.decimals, 6, network);
    assert.ok(isEvmAddress(usdc.address), network);
    const native = ASSETS.find((asset) => asset.network === network && asset.address === null);
    assert.equal(native?.symbol, CHAINS[network].nativeAsset.symbol, network);
    assert.ok(ASSETS.some((asset) => asset.network === network && asset.category === "wrapped"), network);
  }
  assert.equal(findAssetBySymbol("ethereum", "USDC").address, "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
  assert.equal(findAssetBySymbol("optimism", "USDC").address, "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85");
  assert.equal(findAssetBySymbol("polygon", "USDC").address, "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359");
  assert.equal(counterpartAsset(findAssetBySymbol("base", "USDC"), "polygon").symbol, "USDC");
  assert.equal(counterpartAsset(findAssetBySymbol("base", "ETH"), "polygon").symbol, "WETH", "ETH bridges to bridged WETH on Polygon");
  assert.equal(counterpartAsset(findAssetBySymbol("polygon", "POL"), "base"), null, "POL has no cross-network identity");
});

test("protocol registry: ids, networks, kinds and the new venues", () => {
  assert.equal(new Set(PROTOCOLS.map((protocol) => protocol.id)).size, PROTOCOLS.length);
  for (const protocol of PROTOCOLS) {
    for (const network of protocol.networks) assert.ok(NETWORK_KEYS.includes(network), `${protocol.id} lists ${network}`);
    if (protocol.kinds) assert.ok(protocol.capabilities.includes("execute"), `${protocol.id} kinds without execute`);
  }
  for (const id of ["lifi", "debridge-dln"]) {
    const protocol = getProtocol(id);
    assert.equal(protocol.crossChain, true, id);
    assert.deepEqual(protocol.kinds, ["bridge"], id);
    for (const network of ["base", "arbitrum", "ethereum", "optimism", "polygon", "solana"]) assert.ok(protocol.networks.includes(network), `${id} ${network}`);
  }
  for (const id of ["aave-v3", "compound-v3", "morpho", "moonwell", "jupiter-lend", "kamino"]) {
    assert.ok(protocolExecutesKind(id, "deposit") && protocolExecutesKind(id, "withdraw"), id);
  }
  assert.ok(!protocolExecutesKind("jupiter", "deposit"));
  // Bring your own contract: one protocol per VM, category custom, only their own kinds.
  assert.deepEqual(PROTOCOLS.filter((protocol) => protocol.category === "custom").map((protocol) => protocol.id), ["custom-call", "solana-actions"]);
  assert.deepEqual(getProtocol("custom-call").kinds, ["call"]);
  assert.deepEqual(getProtocol("solana-actions").kinds, ["action"]);
  assert.deepEqual(getProtocol("solana-actions").networks, ["solana", "solana-devnet"]);
  for (const protocol of PROTOCOLS.filter((entry) => entry.category !== "custom")) {
    assert.ok(!(protocol.kinds ?? []).some((kind) => kind === "call" || kind === "action"), `${protocol.id} never executes custom calls`);
  }
  assert.equal(getProtocol("ens").category, "naming");
  assert.equal(getProtocol("sns").category, "naming");
  for (const network of ["ethereum", "optimism", "polygon"]) {
    assert.ok(getProtocol("relay").networks.includes(network), `relay ${network}`);
    assert.ok(getProtocol("erc20-transfer").networks.includes(network), `erc20-transfer ${network}`);
    assert.ok(getProtocol("aave-v3").networks.includes(network), `aave-v3 ${network}`);
  }
});

test("yield venues: ids, assets, protocols and addresses are consistent", () => {
  assert.equal(new Set(YIELD_VENUES.map((venue) => venue.id)).size, YIELD_VENUES.length, "unique ids");
  for (const venue of YIELD_VENUES) {
    assert.equal(venue.id, `${venue.network}:${venue.protocol}:${venue.slug}`);
    assert.match(venue.slug, /^[a-z0-9][a-z0-9-]{1,63}$/u);
    const asset = findAssetBySymbol(venue.network, venue.asset);
    assert.ok(asset, `${venue.id} asset ${venue.asset} resolves`);
    const protocol = getProtocol(venue.protocol);
    assert.ok(protocol.networks.includes(venue.network), `${venue.id} network listed by ${venue.protocol}`);
    for (const action of venue.actions) assert.ok(protocol.kinds.includes(action), `${venue.id} ${action}`);
    const valid = CHAINS[venue.network].vm === "evm" ? isEvmAddress : isSolanaAddress;
    assert.ok(valid(venue.target), `${venue.id} target`);
    if ("spender" in venue) assert.ok(valid(venue.spender), `${venue.id} spender`);
    if ("receipt" in venue) {
      assert.ok(valid(venue.receipt.address), `${venue.id} receipt`);
      assert.ok(Number.isInteger(venue.receipt.decimals) && venue.receipt.decimals >= 0 && venue.receipt.decimals <= 18);
    }
    assert.equal(getYieldVenue(venue.id), venue);
  }
  for (const venue of YIELD_VENUES.filter((entry) => entry.kind === "erc4626")) {
    assert.equal(venue.factory, MORPHO_FACTORIES[venue.network][venue.generation], venue.id);
    assert.equal(venue.receipt.address, venue.target);
  }
  for (const venue of YIELD_VENUES.filter((entry) => entry.kind === "comet" || entry.kind === "ctoken" || entry.kind === "aave-reserve")) {
    assert.equal(venue.spender, venue.target, `${venue.id} approves the contract it calls`);
  }
  for (const venue of YIELD_VENUES.filter((entry) => entry.kind === "ctoken")) {
    // Moonwell WETH markets (MWethDelegate) pay redeems in native ETH through a pinned unwrapper.
    assert.equal(Boolean(venue.nativeRouter), Boolean(venue.nativePayout), `${venue.id} pins router and payout together`);
    if (venue.nativePayout) {
      assert.ok(isEvmAddress(venue.nativePayout), `${venue.id} nativePayout`);
      assert.equal(venue.asset, "WETH", `${venue.id} pays native ETH only for a WETH market`);
    }
  }
  assert.equal(getYieldVenue("base:moonwell:weth")?.nativePayout, "0x1382cFf3CeE10D283DccA55A30496187759e4cAf");
  assert.equal(getYieldVenue("optimism:moonwell:weth")?.nativePayout, "0xa962F2974A846b30366251f4634384C1e42aeF16");
  const slugs = new Set(YIELD_VENUES.map((venue) => `${venue.network}:${venue.protocol}:${venue.slug}`));
  assert.equal(slugs.size, YIELD_VENUES.length, "slugs are unique per network and protocol");
});

test("venue lookups never cross networks and accept id, slug, target and receipt", () => {
  // The same Pool / aToken addresses are different deployments on Arbitrum, OP Mainnet and Polygon.
  const arbitrum = findYieldVenue("arbitrum", "0xe50fA9b3c56FfB159cB0FCA61F5c9D750e8128c8");
  const optimism = findYieldVenue("optimism", "0xE50FA9B3C56FFB159CB0FCA61F5C9D750E8128C8");
  assert.equal(arbitrum.id, "arbitrum:aave-v3:weth");
  assert.equal(optimism.id, "optimism:aave-v3:weth");
  assert.equal(findYieldVenue("base", "spark-usdc").id, "base:morpho:spark-usdc");
  assert.equal(findYieldVenue("base", "base:morpho:spark-usdc").name, "Spark USDC Vault");
  assert.equal(findYieldVenue("base", "0x7bfa7c4f149e7415b73bdedfe609237e29cbf34a").id, "base:morpho:spark-usdc");
  assert.equal(findYieldVenue("arbitrum", "spark-usdc"), null);
  assert.equal(findYieldVenue("base", "spark-usdc", "aave-v3"), null);
  assert.equal(findYieldVenue("solana", "D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59").id, "solana:kamino:usdc", "Kamino reserves match by reserve address");
  assert.equal(findYieldVenue("solana", "d6q6wuqsrifjkzyypr1m8r4yawnldtdsmmwm1nbbmgj59"), null, "Solana addresses are case-sensitive");
  assert.deepEqual(yieldVenuesFor("base", "moonwell").map((venue) => venue.slug), ["usdc", "weth"]);
  assert.ok(yieldVenuesFor("solana", "jupiter-lend").find((venue) => venue.slug === "sol").actions.length === 0, "jlWSOL is discovery-only");
});

test("venue contracts are pinned per network and role", () => {
  for (const entry of VENUE_CONTRACTS) {
    const protocol = getProtocol(entry.protocol);
    assert.ok(protocol, entry.protocol);
    assert.ok(protocol.networks.includes(entry.network), `${entry.protocol} on ${entry.network}`);
    const valid = CHAINS[entry.network].vm === "evm" ? isEvmAddress : isSolanaAddress;
    assert.ok(valid(entry.address), `${entry.protocol} ${entry.role} ${entry.address}`);
  }
  for (const network of ["base", "arbitrum", "ethereum", "optimism", "polygon"]) {
    assert.deepEqual(venueContracts("lifi", network, "diamond"), ["0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE"]);
    assert.deepEqual(venueContracts("debridge-dln", network, "dln-source"), ["0xeF4fB24aD0916217251F553c0596F8Edc630EB66"]);
    assert.equal(venueContracts("relay", network).length, 3);
  }
  assert.ok(isVenueContract("relay", "base", "0x4cd00e387622c35bddb9b4c962c136462338bc31", "depository"));
  assert.ok(!isVenueContract("relay", "base", "0x4cd00e387622c35bddb9b4c962c136462338bc31", "approval-proxy"));
  assert.ok(!isVenueContract("lifi", "solana", "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE"));
  assert.deepEqual(venueContracts("debridge-dln", "solana", "dln-source"), ["src5qyZHqTqecJV4aY6Cb6zDZLMDzrDKKezs22MPHr4"]);
});

test("request validation bounds maxSeconds and venue params", () => {
  const accounts = ["eip155:8453:0x000000000000000000000000000000000000dEaD"];
  assert.equal(validateIntentRequest({ text: "x", accounts, constraints: { maxSeconds: 1200 } }).ok, true);
  for (const maxSeconds of [5, 100_000, 1.5, "600"]) {
    const result = validateIntentRequest({ text: "x", accounts, constraints: { maxSeconds } });
    assert.equal(result.ok, false, String(maxSeconds));
    assert.equal(result.issues[0].path, "constraints.maxSeconds");
  }
  const action = { kind: "withdraw", network: "base", from: "USDC", amount: "max", protocol: "morpho" };
  assert.equal(validateIntentRequest({ actions: [{ ...action, params: { venue: "spark-usdc" } }], accounts }).ok, true);
  assert.equal(validateIntentRequest({ actions: [{ ...action, params: { venue: "" } }], accounts }).ok, false);
  assert.equal(validateIntentRequest({ actions: [{ ...action, params: { venue: { id: 1 } } }], accounts }).ok, false);
  assert.equal(validateIntentRequest({ actions: [{ ...action, protocol: "lifi" }], accounts }).ok, true, "protocol ids include the new venues");
  assert.equal(validateIntentRequest({ actions: [{ ...action, protocol: "custom-call" }], accounts }).ok, true, "custom-call is a protocol id");
  const call = { kind: "call", network: "base", contract: "acme vault", entry: "deposit", amount: "100" };
  assert.equal(validateIntentRequest({ actions: [call], accounts }).ok, true);
  assert.equal(validateIntentRequest({ actions: [{ ...call, entry: undefined }], accounts }).ok, false);
});

/* ------------------------------------------------------------- round 6 */

const ROUND6_PROTOCOLS = [
  "velodrome", "sparklend", "spark-savings", "fluid", "yearn-v3", "lido", "rocket-pool", "etherfi", "raydium", "orca", "meteora", "chainlink", "pyth",
];

  assert.equal(PROTOCOLS.length, 44);
  assert.equal(PROTOCOLS.filter((protocol) => protocol.category !== "custom").length, 42);
  for (const id of ROUND6_PROTOCOLS) assert.ok(getProtocol(id), id);
  assert.equal(getProtocol("spark"), null, "no bare spark id: Spark Savings and SparkLend are separate");
  assert.deepEqual(AMBIGUOUS_VENUE_WORDS.spark, ["spark-savings", "sparklend"]);
  assert.deepEqual(
    PROTOCOLS.filter((protocol) => protocol.execution).map((protocol) => [protocol.id, protocol.execution]),
    [["kletia-router-v2", "console"], ["basenames", "console"], ["x402", "service"], ["arc-native", "console"], ["circle-app-kit", "console"]],
  );
  for (const id of ["raydium", "orca", "meteora"]) {
    assert.deepEqual(getProtocol(id).routedVia, ["jupiter"], id);
    assert.deepEqual(protocolDependencies(id), [id, "jupiter"], id);
  }
  assert.deepEqual(protocolDependencies("jupiter"), ["jupiter"]);
  assert.equal(PROTOCOLS.filter((protocol) => protocol.routedVia).length, 3);
  for (const id of ["uniswap-v3", "across", "lifi"]) assert.ok(getProtocol(id).networks.length >= 5, id);
  assert.deepEqual(getProtocol("uniswap-v3").kinds, ["swap"]);
  assert.deepEqual(getProtocol("across").kinds, ["bridge"]);
  assert.deepEqual(getProtocol("cctp-v2").kinds, ["bridge"]);
  for (const id of ["lido", "rocket-pool", "etherfi"]) {
    assert.deepEqual(getProtocol(id).kinds, ["stake"], id);
    assert.deepEqual(getProtocol(id).networks, ["ethereum"], id);
  }
  for (const id of ["chainlink", "pyth"]) assert.deepEqual(getProtocol(id).capabilities, ["discover"], id);
  for (const id of ["sparklend", "spark-savings", "fluid", "yearn-v3"]) {
    assert.ok(protocolExecutesKind(id, "deposit") && protocolExecutesKind(id, "withdraw"), id);
  }
  // The Rule Book's executable set follows `capabilities` (narrowing denies by it); data feeds never execute.
  assert.ok(EXECUTABLE_PROTOCOLS.includes("raydium") && !EXECUTABLE_PROTOCOLS.includes("pyth"));
});

test("DEX deployments: Uniswap V3 on five networks, Slipstream on Base and OP Mainnet, no classic pools", () => {
  assert.equal(DEX_DEPLOYMENTS.length, 10);
  assert.deepEqual(DEX_DEPLOYMENTS.filter((entry) => entry.protocol === "uniswap-v3").map((entry) => entry.network).sort(), ["arbitrum", "base", "ethereum", "optimism", "polygon"]);
  assert.deepEqual(DEX_DEPLOYMENTS.filter((entry) => entry.protocol === "aerodrome").map((entry) => entry.network), ["base", "base", "base"]);
  assert.deepEqual(DEX_DEPLOYMENTS.filter((entry) => entry.protocol === "velodrome").map((entry) => entry.network), ["optimism", "optimism"]);
  assert.ok(DEX_DEPLOYMENTS.every((entry) => entry.dialect !== "solidly-v2"), "no classic pools");
  assert.equal(new Set(DEX_DEPLOYMENTS.map((entry) => entry.id)).size, DEX_DEPLOYMENTS.length);
  for (const deployment of DEX_DEPLOYMENTS) {
    assert.equal(deployment.id.split(":").slice(0, 2).join(":"), `${deployment.network}:${deployment.protocol}`);
    for (const address of [deployment.factory, deployment.router, deployment.quoter, deployment.wrappedNative]) assert.ok(isEvmAddress(address), `${deployment.id} ${address}`);
    // The wrapped native is the registry's (WETH, or WPOL on Polygon).
    const wrapped = ASSETS.find((asset) => asset.network === deployment.network && asset.address?.toLowerCase() === deployment.wrappedNative.toLowerCase());
    assert.ok(wrapped && wrapped.category === "wrapped", `${deployment.id} wraps ${wrapped?.symbol}`);
    assert.ok(getProtocol(deployment.protocol).networks.includes(deployment.network));
    if (deployment.dialect === "uniswap-v3") assert.deepEqual(deployment.feeTiers, [100, 500, 3000, 10000]);
    else assert.deepEqual(deployment.tickSpacings, [1, 50, 100, 200, 2000]);
  }
  assert.equal(dexDeploymentsFor("base", "aerodrome").length, 3);
  // Every router and quoter is a pinned venue contract (preview rule I4 knows every spender).
  for (const deployment of DEX_DEPLOYMENTS) {
    assert.ok(isVenueContract(deployment.protocol, deployment.network, deployment.router, "swap-router"), deployment.id);
    assert.ok(isVenueContract(deployment.protocol, deployment.network, deployment.quoter, "quoter"), deployment.id);
    assert.ok(isVenueContract(deployment.protocol, deployment.network, deployment.factory, "pool-factory"), deployment.id);
  }
  // Uniswap's shared addresses appear once per (network, role).
  assert.equal(dexContracts(DEX_DEPLOYMENTS).length, 30);
});

test("venue contracts: unique labels keyed by Jupiter label; Solana DEX programs pinned", () => {
  const labelled = VENUE_CONTRACTS.filter((entry) => entry.label !== undefined);
  assert.equal(new Set(labelled.map((entry) => entry.label)).size, labelled.length, "labels are unique");
  assert.deepEqual(
    Object.fromEntries(labelled.map((entry) => [entry.label, entry.protocol])),
    { Raydium: "raydium", "Raydium CLMM": "raydium", "Raydium CP": "raydium", Whirlpool: "orca", "Meteora DLMM": "meteora", "Meteora DAMM v2": "meteora" },
  );
  assert.equal(venueByLabel("Whirlpool")?.address, "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");
  assert.equal(venueByLabel("Raydium")?.address, "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", "AMM v4 verified on-chain");
  assert.equal(venueByLabel("Orca V2"), null);
  for (const network of ["base", "arbitrum", "ethereum", "optimism", "polygon"]) {
    assert.equal(venueContracts("across", network, "spoke-pool").length, 1, network);
    assert.deepEqual(venueContracts("cctp-v2", network, "token-messenger"), ["0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d"]);
  }
  assert.deepEqual(venueContracts("across", "solana"), [], "Across lists no Solana network yet");
  assert.deepEqual(venueContracts("pyth", "solana", "receiver"), ["rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ"]);
});

test("yield venues: new kinds after Morpho; sUSDC is Ethereum's default USDC savings venue", () => {
  const order = YIELD_VENUES.map((venue) => venue.protocol);
  const lastMorpho = order.lastIndexOf("morpho");
  for (const protocol of ["sparklend", "spark-savings", "fluid", "yearn-v3"]) {
    assert.ok(order.indexOf(protocol) > lastMorpho, `${protocol} after the Morpho block`);
    assert.ok(order.indexOf(protocol) < order.indexOf("jupiter-lend"), `${protocol} before Jupiter Lend`);
  }
  // Existing defaults stay the defaults: the first venue per (network, protocol, asset).
  assert.equal(yieldVenuesFor("ethereum", "aave-v3")[0].id, "ethereum:aave-v3:usdc");
  assert.equal(yieldVenuesFor("base", "morpho")[0].id, "base:morpho:steakhouse-prime-usdc");
  assert.equal(yieldVenuesFor("ethereum", "spark-savings").filter((venue) => venue.asset === "USDC")[0].id, "ethereum:spark-savings:usdc");
  const susdc = getYieldVenue("ethereum:spark-savings:usdc");
  assert.equal(susdc.kind, "spark-vault");
  assert.equal(susdc.generation, "susdc-v1");
  assert.equal(susdc.receipt.decimals, 18);
  assert.equal(susdc.psm, "0xA188EEC8F81263234dA3622A406892F3D630f98c");
  assert.equal(getYieldVenue("ethereum:spark-savings:spusdc").admin, "0x3300f198988e4C9C63F75dF86De36421f06af8c4");
  assert.equal(getYieldVenue("ethereum:sparklend:usdc").kind, "aave-reserve");
  assert.equal(getYieldVenue("ethereum:sparklend:usdc").target, "0xC13e21B648A5Ee794902342038FF3aDAB66BE987");
  for (const venue of YIELD_VENUES.filter((entry) => entry.kind === "fluid-ftoken")) {
    assert.equal(venue.receipt.address, venue.target);
    assert.equal(venue.receipt.decimals, findAssetBySymbol(venue.network, venue.asset).decimals);
    assert.ok(isVenueContract("fluid", venue.network, venue.lendingFactory, "lending-factory"));
  }
  assert.equal(YIELD_VENUES.filter((entry) => entry.kind === "fluid-ftoken").length, 8);
  for (const venue of YIELD_VENUES.filter((entry) => entry.kind === "yearn-vault")) {
    assert.equal(venue.apiVersion, "3.0.2");
    assert.ok(venue.registries.length >= 1 && venue.registries.every((registry) => isVenueContract("yearn-v3", "ethereum", registry, "registry")));
    assert.ok(isVenueContract("yearn-v3", "ethereum", venue.implementation, "vault-original"));
  }
  for (const venue of YIELD_VENUES.filter((entry) => ["spark-vault", "fluid-ftoken", "yearn-vault"].includes(entry.kind))) {
    assert.equal(venue.spender, venue.target, `${venue.id} approves the contract it calls`);
  }
  assert.equal(findYieldVenue("ethereum", "usdc-1", "yearn-v3")?.id, "ethereum:yearn-v3:usdc-1");
});

test("the 2026-10-14 pins are read back on-chain in docs/networks/evidence/protocols-2026-10-14.json", () => {
  const evidence = JSON.parse(readFileSync(new URL("../../../docs/networks/evidence/protocols-2026-10-14.json", import.meta.url), "utf8"));
  assert.equal(evidence.summary.failed.length, 0);
  const verified = new Set(
    [...evidence.evm, ...evidence.solana, ...evidence.assets]
      .filter((entry) => entry.verified)
      .map((entry) => `${entry.network ?? "solana"}:${entry.address.toLowerCase()}`),
  );
  const key = (network, address) => `${network}:${address.toLowerCase()}`;
  const round6 = new Set([...ROUND6_PROTOCOLS, "uniswap-v3", "aerodrome", "across", "cctp-v2"]);
  for (const row of VENUE_CONTRACTS.filter((entry) => round6.has(entry.protocol))) {
    assert.ok(verified.has(key(row.network, row.address)), `${row.protocol} ${row.role} ${row.network} ${row.address}`);
  }
  for (const venue of YIELD_VENUES.filter((entry) => round6.has(entry.protocol))) {
    assert.ok(verified.has(key(venue.network, venue.target)) || verified.has(key(venue.network, venue.receipt.address)), venue.id);
  }
  for (const symbol of ["wstETH", "rETH", "weETH"]) assert.ok(verified.has(key("ethereum", findAssetBySymbol("ethereum", symbol).address)), symbol);
  assert.ok(verified.has(key("base", findAssetBySymbol("base", "USDbC").address)));
});

test("reserved words of the 2026-10-14 venues: brand words anywhere, common words only as a whole alias", async () => {
  const { reservedContractPhrase, reservedIntegratorName } = await import("../dist/index.js");
  for (const word of ["velodrome", "raydium", "meteora", "sparklend", "etherfi", "wsteth", "reth", "weeth", "rocketpool", "yearn", "uniswap", "aerodrome"]) {
    assert.equal(reservedContractPhrase(`acme ${word} vault`), word, word);
  }
  for (const phrase of ["fluid", "spark", "orca", "lido", "pyth", "chainlink", "spark savings", "rocket pool", "uniswap v3", "susdc"]) {
    assert.ok(RESERVED_CONTRACT_PHRASES.includes(phrase), phrase);
    assert.equal(reservedContractPhrase(phrase), phrase, phrase);
  }
  // Common English words stay usable inside an alias.
  for (const alias of ["fluid vault", "spark pool", "orca fund", "lido helper"]) assert.equal(reservedContractPhrase(alias), null, alias);
  // Integrator names.
  assert.equal(reservedIntegratorName("Raydium Pro")?.word, "raydium");
  assert.equal(reservedIntegratorName("Lido Staking")?.word, "lido");
  assert.equal(reservedIntegratorName("Pyth Oracle")?.word, "pyth");
  assert.equal(reservedIntegratorName("Python Tools"), null, "pyth is a whole word");
  assert.equal(reservedIntegratorName("Yearning Labs"), null, "yearn is a whole word");
  assert.equal(reservedIntegratorName("Spark Yield")?.word, "spark");
  assert.equal(reservedIntegratorName("SparkLend Tools")?.word, "sparklend");
  assert.equal(reservedIntegratorName("Fluid Finance")?.hosts.includes("instadapp.io"), true);
  assert.equal(reservedIntegratorName("Rocket Pool Fans")?.word, "rocketpool");
  assert.equal(reservedIntegratorName("ether.fi tools")?.word, "etherfi");
  assert.equal(reservedIntegratorName("Velodrome Club")?.word, "velodrome");
  assert.equal(reservedIntegratorName("Chainlink Labs Fan")?.word, "chainlink");
});

test("EVM liquid staking pins match the minted tokens in ASSETS (the staking adapters rely on it)", () => {
  const one = (protocol, role) => {
    const addresses = venueContracts(protocol, "ethereum", role);
    assert.equal(addresses.length, 1, `${protocol} ${role}`);
    return addresses[0].toLowerCase();
  };
  // Lido mints wstETH by receiving ETH at wstETH itself; Rocket Pool and ether.fi mint their lst-token.
  assert.equal(one("lido", "deposit-target"), findAssetBySymbol("ethereum", "wstETH").address.toLowerCase());
  assert.equal(one("rocket-pool", "lst-token"), findAssetBySymbol("ethereum", "rETH").address.toLowerCase());
  assert.equal(one("etherfi", "lst-token"), findAssetBySymbol("ethereum", "weETH").address.toLowerCase());
  for (const role of ["lst-token", "locator"]) one("lido", role);
  for (const role of ["storage", "deposit-target"]) one("rocket-pool", role);
  for (const role of ["deposit-target", "liquidity-pool", "underlying-token"]) one("etherfi", role);
  // SparkLend's provider is pinned so the adapter can tie the Pool and data provider to it.
  assert.equal(one("sparklend", "addresses-provider"), "0x02c3ea4e34c0cbd694d2adfa2c690eecbc1793ee");
});

test("SparkLend and Yearn V3 pins and governance roles are read back in docs/networks/evidence/evm-lending-additions.json", () => {
  const evidence = JSON.parse(readFileSync(new URL("../../../docs/networks/evidence/evm-lending-additions.json", import.meta.url), "utf8"));
  assert.equal(evidence.allChecksPass, true);
  assert.ok(Object.values(evidence.checks).every(Boolean));
  const sparklend = getYieldVenue("ethereum:sparklend:usdc");
  assert.equal(evidence.pins.sparklendPool.toLowerCase(), sparklend.target.toLowerCase());
  assert.equal(evidence.pins.sparklendDataProvider.toLowerCase(), sparklend.dataProvider.toLowerCase());
  assert.equal(evidence.pins.spUSDC.toLowerCase(), sparklend.receipt.address.toLowerCase());
  const yearn = getYieldVenue("ethereum:yearn-v3:usdc-1");
  assert.equal(evidence.pins.yearnUsdc1.toLowerCase(), yearn.target.toLowerCase());
  assert.equal(evidence.pins.yearnVaultOriginal.toLowerCase(), yearn.implementation.toLowerCase());
  assert.deepEqual(evidence.pins.yearnRegistries.map((address) => address.toLowerCase()), yearn.registries.map((address) => address.toLowerCase()));
});
