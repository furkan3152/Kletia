import assert from "node:assert/strict";
import test from "node:test";
import {
  ASSETS,
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
