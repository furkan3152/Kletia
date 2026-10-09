/**
 * ENS, Basenames and SNS resolvers behind the name hook: pinned contracts and
 * accounts, no CCIP-Read, the coin-type policy for non-Ethereum recipients,
 * Basenames read through the Base registry's resolver (the fix for names
 * migrated off the old resolver), and SNS `.sns` resolution to the on-chain
 * registry owner with `.sol` refused.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { address as solanaAddress, getAddressEncoder } from "@solana/kit";
import {
  BaseError,
  decodeFunctionData,
  encodeAbiParameters,
  encodeErrorResult,
  encodeFunctionResult,
  getAddress,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { namehash } from "viem/ens";
import { venueContracts } from "@kletia/core";
import { BASE_COIN_TYPE, evmCoinType, readBasenameRecords, resolveBasenameEvidence, type BasenameRecords } from "../../../networks/base/intent/basenameResolver.js";
import type { ParsedIntent } from "../../../shared/ai/parser.js";
import { resolveIntentEntities } from "../../../shared/assets/resolver.js";
import { PlatformError } from "../../errors.js";
import type { EvmNetworkKey } from "../chains/evm.js";
import { nameResolvers, resetNameResolvers, resolveRecipientName, registerNameResolver } from "../names.js";
import {
  createBasenamesResolver,
  createEnsResolver,
  createSnsResolver,
  DEFAULT_EVM_COIN_TYPE,
  installNameResolvers,
  snsAccountKeys,
  type SnsDependencies,
} from "../nameResolvers.js";
import { planIntent } from "../planner.js";
import { ACCOUNTS } from "./helpers.js";
import { resetVenueEngine } from "./venueStubs.js";

const VITALIK = getAddress("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045");
const JESSE = getAddress("0x2211d1D0020DAEA8039E46Cf1367962070d77DA9");
const SAFE = getAddress("0x1111111111111111111111111111111111111111");
const ENS_RESOLVER = getAddress("0x231b0Ee14048e9dCcD1d247744d114a4EB5E8E63");
const UNIVERSAL = getAddress(venueContracts("ens", "ethereum", "universal-resolver")[0]!);
const REGISTRY = getAddress(venueContracts("basenames", "base", "registry")[0]!);
const NEW_RESOLVER = getAddress("0xC6d566A56A1aFf6508b41f6c90ff131615583BCD");
const OLD_RESOLVER = getAddress("0x426fA03fB86E510d0Dd9F70335Cf102a98b10875");

const UR_ABI = parseAbi([
  "function resolve(bytes name, bytes data) view returns (bytes, address)",
  "error ResolverNotFound(bytes name)",
  "error OffchainLookup(address sender, string[] urls, bytes callData, bytes4 callbackFunction, bytes extraData)",
]);
const ADDR_ABI = parseAbi([
  "function addr(bytes32 node) view returns (address)",
  "function addr(bytes32 node, uint256 coinType) view returns (bytes)",
]);
const REGISTRY_ABI = parseAbi(["function resolver(bytes32 node) view returns (address)"]);

function reverted(data: Hex): BaseError {
  return new BaseError("execution reverted", { cause: Object.assign(new Error("execution reverted"), { data }) });
}

/** Records per name and coin type ("60" for addr(bytes32)). */
type RecordTable = Map<string, Map<bigint, Address>>;

interface FakeChain {
  readonly client: PublicClient;
  readonly code: Map<string, Hex>;
  readonly calls: string[];
}

function coinTypeOf(inner: Hex): bigint {
  const decoded = decodeFunctionData({ abi: ADDR_ABI, data: inner });
  return decoded.args.length === 2 ? (decoded.args[1] as bigint) : 60n;
}

function encodeRecord(coinType: bigint, value: Address | undefined): Hex {
  if (coinType === 60n) return encodeAbiParameters([{ type: "address" }], [value ?? "0x0000000000000000000000000000000000000000"]);
  return encodeAbiParameters([{ type: "bytes" }], [value ?? "0x"]);
}

/**
 * A fake EVM client: answers eth_call for the Universal Resolver (Ethereum),
 * the Basenames registry and resolvers (Base), and eth_getCode.
 */
function fakeChain(options: { ens?: RecordTable; offchain?: Set<string>; basenames?: RecordTable; basenameResolver?: Map<string, Address>; fail?: boolean }): FakeChain {
  const code = new Map<string, Hex>();
  const calls: string[] = [];
  const nodes = new Map<string, string>();
  for (const name of [...(options.ens?.keys() ?? []), ...(options.basenames?.keys() ?? []), ...(options.basenameResolver?.keys() ?? []), ...(options.offchain ?? [])]) {
    nodes.set(namehash(name), name);
  }
  const client = {
    getBlockNumber: async () => 100n,
    request: async ({ method, params }: { method: string; params: unknown[] }) => {
      if (options.fail) throw new Error("rpc down");
      if (method === "eth_getCode") return code.get(String(params[0]).toLowerCase()) ?? "0x";
      if (method !== "eth_call") throw new Error(`unexpected ${method}`);
      const { to, data } = params[0] as { to: Address; data: Hex };
      calls.push(to);
      if (getAddress(to) === UNIVERSAL) {
        const { args } = decodeFunctionData({ abi: UR_ABI, data });
        const inner = args[1] as Hex;
        const { args: innerArgs } = decodeFunctionData({ abi: ADDR_ABI, data: inner });
        const name = nodes.get(innerArgs[0] as string) ?? "";
        if (options.offchain?.has(name)) {
          throw reverted(encodeErrorResult({ abi: UR_ABI, errorName: "OffchainLookup", args: [UNIVERSAL, ["https://gateway.example"], "0x", "0x12345678", "0x"] }));
        }
        const records = options.ens?.get(name);
        if (!records) throw reverted(encodeErrorResult({ abi: UR_ABI, errorName: "ResolverNotFound", args: ["0x00"] }));
        const coinType = coinTypeOf(inner);
        return encodeFunctionResult({ abi: UR_ABI, functionName: "resolve", result: [encodeRecord(coinType, records.get(coinType)), ENS_RESOLVER] });
      }
      if (getAddress(to) === REGISTRY) {
        const { args } = decodeFunctionData({ abi: REGISTRY_ABI, data });
        const resolver = options.basenameResolver?.get(nodes.get(args[0]) ?? "") ?? "0x0000000000000000000000000000000000000000";
        return encodeFunctionResult({ abi: REGISTRY_ABI, functionName: "resolver", result: resolver });
      }
      // A resolver contract: only the resolver the registry names holds the records.
      const { args } = decodeFunctionData({ abi: ADDR_ABI, data });
      const name = nodes.get(args[0] as string) ?? "";
      const holder = options.basenameResolver?.get(name);
      const coinType = coinTypeOf(data);
      const value = holder && getAddress(to) === holder ? options.basenames?.get(name)?.get(coinType) : undefined;
      return encodeRecord(coinType, value);
    },
  };
  return { client: client as unknown as PublicClient, code, calls };
}

function evmDependencies(chains: Partial<Record<EvmNetworkKey, FakeChain>>) {
  return {
    client: (network: EvmNetworkKey) => {
      const chain = chains[network];
      if (!chain) throw new Error(`no fake client for ${network}`);
      return chain.client;
    },
  };
}

async function rejects(promise: Promise<unknown>, code: string): Promise<PlatformError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof PlatformError, `expected PlatformError, got ${String(error)}`);
    assert.equal(error.code, code, error.message);
    return error;
  }
  assert.fail(`expected ${code}`);
}

describe("ENS resolver", () => {
  const ens: RecordTable = new Map([
    ["vitalik.eth", new Map([[60n, VITALIK]])],
    ["chainaware.eth", new Map([[60n, SAFE], [BASE_COIN_TYPE, JESSE]])],
    ["everywhere.eth", new Map([[DEFAULT_EVM_COIN_TYPE, JESSE], [60n, SAFE]])],
    ["safe.eth", new Map([[60n, SAFE]])],
  ]);
  let ethereum: FakeChain;
  let target: FakeChain;
  let resolver: ReturnType<typeof createEnsResolver>;

  beforeEach(() => {
    ethereum = fakeChain({ ens, offchain: new Set(["jesse.base.eth"]) });
    target = fakeChain({});
    resolver = createEnsResolver(evmDependencies({ ethereum, base: target, optimism: target, arbitrum: target, polygon: target }));
  });
  afterEach(() => resetNameResolvers());

  it("resolves the ETH record for Ethereum through the pinned Universal Resolver at one block", async () => {
    const resolution = await resolver.resolve("vitalik.eth", "ethereum");
    assert.equal(resolution?.address, VITALIK);
    assert.equal(resolution?.reference, "100");
    assert.match(resolution?.detail ?? "", /Universal Resolver, coin type 60 \(ETH\), Ethereum block 100/u);
    assert.deepEqual(ethereum.calls, [UNIVERSAL]);
  });

  it("prefers the target chain's record, then the default EVM record, over the ETH record", async () => {
    assert.equal((await resolver.resolve("chainaware.eth", "base"))?.address, JESSE);
    const everywhere = await resolver.resolve("everywhere.eth", "optimism");
    assert.equal(everywhere?.address, JESSE);
    assert.equal(everywhere?.warnings, undefined);
  });

  it("falls back to the ETH record only for accounts a key controls on both chains or contracts deployed on the target", async () => {
    const eoa = await resolver.resolve("vitalik.eth", "optimism");
    assert.equal(eoa?.address, VITALIK);
    assert.match(eoa?.warnings?.[0] ?? "", /externally owned account/u);
    // An EIP-7702 delegation is still a key-controlled account.
    ethereum.code.set(VITALIK.toLowerCase(), `0xef0100${"ab".repeat(20)}`);
    target.code.set(VITALIK.toLowerCase(), `0xef0100${"ab".repeat(20)}`);
    assert.match((await resolver.resolve("vitalik.eth", "base"))?.warnings?.[0] ?? "", /externally owned account/u);
    // A contract that only exists on Ethereum (a mainnet Safe) is refused.
    ethereum.code.set(SAFE.toLowerCase(), "0x6080604052");
    await rejects(resolver.resolve("safe.eth", "arbitrum"), "RECIPIENT_NAME_UNRESOLVED");
    target.code.set(SAFE.toLowerCase(), "0x6080604052");
    assert.match((await resolver.resolve("safe.eth", "arbitrum"))?.warnings?.[0] ?? "", /contract deployed on Arbitrum One/u);
  });

  it("refuses offchain (CCIP-Read) resolvers and reports missing or unreadable records through the hook", async () => {
    const offchain = await rejects(resolver.resolve("jesse.base.eth", "ethereum"), "RECIPIENT_NAME_UNRESOLVED");
    assert.match(offchain.message, /CCIP-Read/u);
    registerNameResolver(resolver);
    await rejects(resolveRecipientName("nobody.eth", "ethereum"), "RECIPIENT_NAME_UNRESOLVED");
    resetNameResolvers();
    registerNameResolver(createEnsResolver(evmDependencies({ ethereum: fakeChain({ fail: true }) })));
    const unavailable = await rejects(resolveRecipientName("vitalik.eth", "ethereum"), "NAME_RESOLUTION_UNAVAILABLE");
    assert.equal(unavailable.status, 503);
  });
});

describe("Basenames", () => {
  const records: RecordTable = new Map([["jesse.base.eth", new Map([[BASE_COIN_TYPE, JESSE], [60n, JESSE]])]]);

  it("reads the resolver the Base registry names, not the old hard-coded resolver", async () => {
    // jesse.base.eth moved to the new resolver; the old one holds no record for it.
    const base = fakeChain({ basenames: records, basenameResolver: new Map([["jesse.base.eth", NEW_RESOLVER]]) });
    const read = await readBasenameRecords("jesse.base.eth", [BASE_COIN_TYPE, 60n], base.client);
    assert.equal(read?.resolver, NEW_RESOLVER);
    assert.equal(read?.addresses.get(BASE_COIN_TYPE), JESSE);
    assert.deepEqual(base.calls, [REGISTRY, NEW_RESOLVER, NEW_RESOLVER]);
    assert.ok(!base.calls.includes(OLD_RESOLVER));
    assert.equal(await readBasenameRecords("jesse.base", [60n], base.client).then((value) => value?.name), "jesse.base.eth");
  });

  it("treats a zero resolver as no resolution", async () => {
    const base = fakeChain({ basenames: records, basenameResolver: new Map() });
    assert.equal(await readBasenameRecords("jesse.base.eth", [60n], base.client), null);
    assert.equal(await readBasenameRecords("vitalik.eth", [60n], base.client), null, "not a Basename");
  });

  it("resolves Base recipients with Base's record and discloses a custom resolver", async () => {
    const custom = getAddress("0x9999999999999999999999999999999999999999");
    const read = async (name: string): Promise<BasenameRecords | null> => ({
      name,
      resolver: name === "custom.base.eth" ? custom : NEW_RESOLVER,
      block: 7n,
      addresses: new Map([[BASE_COIN_TYPE, JESSE]]),
    });
    const resolver = createBasenamesResolver({ ...evmDependencies({}), read });
    const resolution = await resolver.resolve("jesse.base.eth", "base");
    assert.equal(resolution?.address, JESSE);
    assert.equal(resolution?.protocol, "basenames");
    assert.equal(resolution?.reference, "7");
    assert.equal(resolution?.warnings, undefined);
    assert.match((await resolver.resolve("custom.base.eth", "base"))?.warnings?.[0] ?? "", /custom resolver/u);
  });

  it("resolves the legacy intent flow per network: a Base-only record never pays an Arbitrum or Arc transfer", async () => {
    const baseOnly = getAddress("0xba5E00000000000000000000000000000000ba5e");
    const onArbitrum = getAddress("0xa4b100000000000000000000000000000000a4b1");
    const table: RecordTable = new Map([
      ["alice.base.eth", new Map([[60n, SAFE], [BASE_COIN_TYPE, baseOnly]])],
      ["bob.base.eth", new Map([[60n, SAFE], [BASE_COIN_TYPE, baseOnly], [evmCoinType(42161), onArbitrum]])],
    ]);
    const base = fakeChain({ basenames: table, basenameResolver: new Map([["alice.base.eth", NEW_RESOLVER], ["bob.base.eth", NEW_RESOLVER]]) });
    assert.equal((await resolveBasenameEvidence("alice.base.eth", "base", base.client))?.address, baseOnly);
    assert.equal((await resolveBasenameEvidence("alice.base.eth", "arbitrum", base.client))?.address, SAFE);
    assert.equal((await resolveBasenameEvidence("alice.base.eth", "arc", base.client))?.address, SAFE);
    assert.equal((await resolveBasenameEvidence("bob.base.eth", "arbitrum", base.client))?.address, onArbitrum);
    // POST /api/intent resolves the recipient for the network the transfer runs on.
    const networks: (string | undefined)[] = [];
    const entities = await resolveIntentEntities(
      { action: "transfer", tokenIn: "USDC", amount: "5", recipient: "alice.base.eth" } as ParsedIntent,
      { network: "arbitrum", userAddress: "0x2222222222222222222222222222222222222222", originalPrompt: "send 5 USDC to alice.base.eth", requestId: "test" },
      {
        resolveBasename: (name, network) => {
          networks.push(network);
          return resolveBasenameEvidence(name, network, base.client);
        },
      },
    );
    assert.deepEqual(networks, ["arbitrum"]);
    assert.match(JSON.stringify(entities), new RegExp(`"resolvedAddress":"${SAFE}"`, "u"));
    assert.doesNotMatch(JSON.stringify(entities), /ba5e/iu);
  });
});

describe("SNS resolver", () => {
  const NAME_PROGRAM = "namesLPneVptA9Z5rqUDD9tMTWEJwofgaYwp8cawRkX";
  const ROOT = "58PwtjSDuFHuUkYjH9BYnnQKHfwo9reZhC2zMJv9JPkx";
  const TOLY = "86xCnPeV69n6t3DnyGvkKobf9FdN2H9oiVDdaMpo2MMY";
  /** A program-derived (off-curve) address: the Jupiter Lend USDC lending account. */
  const PDA = "2vVYHYM8VYnvZqQWpTJSj8o8DBf1wM8pVs3bsTgYZiqJ";
  const encoder = getAddressEncoder();

  function nameAccount(owner: string, parent = ROOT): { owner: string; data: Uint8Array } {
    const data = new Uint8Array(105);
    data.set(encoder.encode(solanaAddress(parent)), 0);
    data.set(encoder.encode(solanaAddress(owner)), 32);
    return { owner: NAME_PROGRAM, data };
  }

  let accounts: Map<string, { owner: string; data: Uint8Array }>;
  let proxied: string[];
  let proxyAnswer: string | null;
  const dependencies: SnsDependencies = {
    readAccounts: async (addresses) => ({ slot: 454_000_000n, accounts: addresses.map((key) => accounts.get(key) ?? null) }),
    resolveWithSns: async (name) => {
      proxied.push(name);
      return proxyAnswer;
    },
  };
  const resolver = createSnsResolver(dependencies);

  beforeEach(() => {
    accounts = new Map();
    proxied = [];
    proxyAnswer = null;
  });

  it("derives the same name accounts as SNS (checked against live mainnet accounts)", async () => {
    assert.equal((await snsAccountKeys("bonfida")).domain, "Crf8hzfthWGbGbLTVCiqRqV5MVnbpHB1L9KQMd6gsinb");
    assert.equal((await snsAccountKeys("toly")).domain, "FX1APjKbFu6M8GKb3dGXcZLXjxX4fGaYwvHqb5Vaee8q");
  });

  it("resolves a .sns name to its registry owner at one slot", async () => {
    accounts.set((await snsAccountKeys("toly")).domain, nameAccount(TOLY));
    const resolution = await resolver.resolve("toly.sns", "solana");
    assert.equal(resolution?.address, TOLY);
    assert.equal(resolution?.reference, "454000000");
    assert.deepEqual(proxied, [], "no offchain lookup without records");
  });

  it("refuses .sol while SNS pauses it, subdomains, unknown names and program-owned names", async () => {
    assert.match((await rejects(resolver.resolve("toly.sol", "solana"), "RECIPIENT_NAME_UNSUPPORTED")).message, /toly\.sns/u);
    await rejects(resolver.resolve("pay.toly.sns", "solana"), "RECIPIENT_NAME_UNSUPPORTED");
    assert.equal(await resolver.resolve("nobody.sns", "solana"), null);
    const keys = await snsAccountKeys("toly");
    accounts.set(keys.domain, nameAccount(PDA));
    await rejects(resolver.resolve("toly.sns", "solana"), "RECIPIENT_NAME_UNRESOLVED");
    accounts.set(keys.domain, { ...nameAccount(TOLY), owner: "11111111111111111111111111111111" });
    await rejects(resolver.resolve("toly.sns", "solana"), "RECIPIENT_NAME_UNRESOLVED");
    accounts.set(keys.domain, nameAccount(TOLY, TOLY));
    await rejects(resolver.resolve("toly.sns", "solana"), "RECIPIENT_NAME_UNRESOLVED");
  });

  it("accepts the owner of a name with records only when SNS resolves it to the same wallet", async () => {
    const keys = await snsAccountKeys("toly");
    accounts.set(keys.domain, nameAccount(TOLY));
    accounts.set(keys.solRecordV2, { owner: NAME_PROGRAM, data: new Uint8Array(200) });
    proxyAnswer = TOLY;
    assert.equal((await resolver.resolve("toly.sns", "solana"))?.address, TOLY);
    proxyAnswer = PDA;
    await rejects(resolver.resolve("toly.sns", "solana"), "RECIPIENT_NAME_UNRESOLVED");
    assert.deepEqual(proxied, ["toly.sns", "toly.sns"]);
    // An inactive tokenization record (tag 3) does not override the owner.
    accounts.delete(keys.solRecordV2);
    accounts.set(keys.nftRecord, { owner: "nftD3vbNkNqfj2Sd3HZwbpw4BxxKWr4AjGb9X38JeZk", data: Uint8Array.from([3, ...new Array(97).fill(0)]) });
    assert.equal((await resolver.resolve("toly.sns", "solana"))?.address, TOLY);
    assert.equal(proxied.length, 2);
  });
});

describe("installNameResolvers", () => {
  afterEach(() => resetNameResolvers());

  it("registers ENS, Basenames and SNS once and plans a name recipient end to end", async () => {
    resetVenueEngine();
    const remove = installNameResolvers();
    installNameResolvers();
    assert.deepEqual(nameResolvers().map((resolver) => resolver.id), ["ens", "basenames", "sns"]);
    remove();
    assert.deepEqual(nameResolvers(), []);
    const ethereum = fakeChain({ ens: new Map([["vitalik.eth", new Map([[60n, VITALIK]])]]) });
    installNameResolvers([createEnsResolver(evmDependencies({ ethereum, optimism: fakeChain({}) }))]);
    const graph = await planIntent({ text: "send 5 USDC to vitalik.eth on optimism", accounts: ACCOUNTS });
    assert.equal(graph.steps[0]?.recipient, `eip155:10:${VITALIK}`);
    assert.equal(graph.steps[0]?.recipientName, "vitalik.eth");
    assert.ok(graph.steps[0]?.warnings?.some((warning) => warning.includes("externally owned account")));
  });
});

