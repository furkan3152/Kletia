/**
 * Balance-slot discovery beyond plain mappings at slots 0..20 (asset-preview
 * design F1/F2, live 2026-10-09): OpenZeppelin upgradeable layouts (Arbitrum
 * WETH and ARB keep `_balances` at slot 51), the ERC-7201 ERC20 namespace,
 * native-balance views (Arc USDC), and any other layout through
 * `eth_createAccessList`. Every location is proven by reading a marker back.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { encodeFunctionData, erc20Abi, getAddress, type Hex } from "viem";
import {
  balanceOverride,
  balanceStorageKey,
  discoverBalanceSlot,
  mappingCandidates,
  MAX_TRACED_KEYS,
  OZ_ERC20_NAMESPACE_SLOT,
} from "../contracts/balanceSlots.js";
import { readUint, simulateEvmCalls } from "../contracts/simulateEvm.js";
import { installEvmHarness, OTHER, resetContractCaches, SIM_URLS, USER, type EvmHarness } from "./contractHarness.js";

const TOKEN = "0x7777777777777777777777777777777777777777";
/** Arc's USDC: an ERC-20 view (6 decimals) of the 18-decimal native balance. */
const ARC_USDC = "0x3600000000000000000000000000000000000000";

let harness: EvmHarness;

beforeEach(() => {
  resetContractCaches();
  harness = installEvmHarness();
});

afterEach(() => harness.restore());

function calls(method: string) {
  return harness.router.calls.filter((call) => call.method === method);
}

/** eth_simulateV1 requests of the discovery (every block reads balanceOf), not the endpoint capability probes. */
function discoveryRequests() {
  return calls("eth_simulateV1").filter((call) => blocksOf(call).every((block) => (block as { calls?: { data?: string }[] }).calls?.[0]?.data?.startsWith("0x70a08231")));
}

function blocksOf(call: { params: unknown[] }): { stateOverrides: Record<string, { balance?: string; stateDiff?: Record<string, string> }> }[] {
  return (call.params[0] as { blockStateCalls: { stateOverrides: Record<string, { balance?: string; stateDiff?: Record<string, string> }> }[] }).blockStateCalls;
}

async function simulatedBalance(network: "base" | "arc", token: string, owner: string, overrides: Awaited<ReturnType<typeof balanceOverride>>): Promise<bigint | null> {
  assert.ok(overrides);
  const simulated = await simulateEvmCalls(network, {
    calls: [{ from: owner, to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [getAddress(owner)] }) as Hex }],
    overrides,
  });
  return simulated.status === "ok" ? readUint(simulated.calls[0]) : null;
}

describe("balance-slot discovery: first round", () => {
  it("covers OpenZeppelin upgradeable slots (Arbitrum WETH and ARB: 51) in one bounded request", async () => {
    harness.world.tokens.set(TOKEN, { symbol: "WETH", decimals: 18, slot: 51, layout: "solidity" });
    assert.deepEqual(await discoverBalanceSlot("arbitrum", TOKEN, USER), { kind: "mapping", slot: 51n, layout: "solidity" });
    assert.equal(discoveryRequests().length, 1, "one request");
    assert.equal(calls("eth_createAccessList").length, 0, "no tracing needed");
    const blocks = blocksOf(discoveryRequests()[0] as { params: unknown[] });
    assert.equal(blocks.length, mappingCandidates().length + 1, "every candidate plus the native view");
    assert.equal(blocks.length, 48);
    assert.equal(await simulatedBalance("base", TOKEN, USER, await balanceOverride("arbitrum", TOKEN, USER, 5n * 10n ** 16n)), 5n * 10n ** 16n);
    for (const slot of [101, 151, 201]) {
      const token = `0x${String(slot).padStart(40, "8")}`;
      harness.world.tokens.set(token, { symbol: "GAP", decimals: 18, slot, layout: "solidity" });
      assert.deepEqual(await discoverBalanceSlot("base", token, USER), { kind: "mapping", slot: BigInt(slot), layout: "solidity" });
    }
  });

  it("reads its markers back from uint96 balances (UNI slot 4, COMP slot 1)", async () => {
    harness.world.tokens.set(TOKEN, { symbol: "UNI", decimals: 18, slot: 4, layout: "solidity", valueBits: 96 });
    assert.deepEqual(await discoverBalanceSlot("ethereum", TOKEN, USER), { kind: "mapping", slot: 4n, layout: "solidity" });
    assert.equal(await simulatedBalance("base", TOKEN, USER, await balanceOverride("ethereum", TOKEN, USER, 10n ** 21n)), 10n ** 21n);
  });

  it("covers the ERC-7201 namespace of OpenZeppelin v5 ERC20Upgradeable", async () => {
    // Computed live (asset-preview probes/slots2.out).
    assert.equal(OZ_ERC20_NAMESPACE_SLOT, 0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00n);
    harness.world.tokens.set(TOKEN, { symbol: "NS", decimals: 18, slot: OZ_ERC20_NAMESPACE_SLOT, layout: "solidity" });
    assert.deepEqual(await discoverBalanceSlot("base", TOKEN, USER), { kind: "mapping", slot: OZ_ERC20_NAMESPACE_SLOT, layout: "solidity" });
    assert.equal(await simulatedBalance("base", TOKEN, USER, await balanceOverride("base", TOKEN, USER, 42n)), 42n);
  });

  it("overrides a native-balance view (Arc USDC) through the account's native balance", async () => {
    harness.world.tokens.set(ARC_USDC, { symbol: "USDC", decimals: 6, slot: 0, layout: "solidity", nativeScale: 10n ** 12n });
    assert.deepEqual(await discoverBalanceSlot("arc", ARC_USDC, USER), { kind: "native", scale: 10n ** 12n });
    const override = await balanceOverride("arc", ARC_USDC, USER, 123_000_000n);
    assert.deepEqual(override, { [getAddress(USER)]: { balance: 123n * 10n ** 18n } });
    assert.equal(await simulatedBalance("arc", ARC_USDC, USER, override), 123_000_000n);
    // The native probe overrides the holder's balance only, in the last block.
    const blocks = blocksOf(discoveryRequests()[0] as { params: unknown[] });
    assert.deepEqual(Object.keys(blocks.at(-1)?.stateOverrides ?? {}), [getAddress(USER)]);
    assert.ok(blocks.slice(0, -1).every((block) => Object.values(block.stateOverrides).every((entry) => entry.balance === undefined)));
  });
});

describe("balance-slot discovery: access-list round", () => {
  it("finds a mapping outside the candidates through the access list and generalises it to every holder", async () => {
    harness.world.tokens.set(TOKEN, { symbol: "ODD", decimals: 18, slot: 37, layout: "vyper" });
    assert.deepEqual(await discoverBalanceSlot("base", TOKEN, USER), { kind: "mapping", slot: 37n, layout: "vyper" });
    assert.equal(calls("eth_createAccessList").length, 1);
    // The trace round tries the proxy slots too; only the balance word reads its marker back.
    const traced = blocksOf(discoveryRequests()[1] as { params: unknown[] });
    assert.equal(traced.length, 3);
    const before = [harness.world.simulateCount, harness.world.accessListCount];
    assert.deepEqual(await discoverBalanceSlot("base", TOKEN, OTHER), { kind: "mapping", slot: 37n, layout: "vyper" });
    assert.deepEqual([harness.world.simulateCount, harness.world.accessListCount], before, "cached for the token");
    assert.equal(await simulatedBalance("base", TOKEN, OTHER, await balanceOverride("base", TOKEN, OTHER, 9n)), 9n);
  });

  it("keeps a non-mapping layout (Solady) per holder and overrides that exact word", async () => {
    harness.world.tokens.set(TOKEN, { symbol: "SLD", decimals: 18, slot: 0, layout: "solady" });
    const found = await discoverBalanceSlot("base", TOKEN, USER);
    assert.equal(found?.kind, "storage");
    assert.equal(found?.kind === "storage" ? found.address : null, TOKEN);
    assert.equal(await simulatedBalance("base", TOKEN, USER, await balanceOverride("base", TOKEN, USER, 77n)), 77n);
    // Another holder has another word: traced again, the first round is not repeated.
    const [simulations, traces] = [harness.world.simulateCount, harness.world.accessListCount];
    const other = await discoverBalanceSlot("base", TOKEN, OTHER);
    assert.equal(other?.kind, "storage");
    assert.notEqual(other?.kind === "storage" ? other.key : null, found?.kind === "storage" ? found.key : null);
    assert.deepEqual([harness.world.simulateCount - simulations, harness.world.accessListCount - traces], [1, 1]);
  });

  it("falls back to the next endpoint for the access list and caches nothing when none can trace", async () => {
    harness.world.tokens.set(TOKEN, { symbol: "SLD", decimals: 18, slot: 0, layout: "solady" });
    harness.world.accessListErrors.add(SIM_URLS[0] as string);
    assert.equal((await discoverBalanceSlot("base", TOKEN, USER))?.kind, "storage");
    const second = "0x9999999999999999999999999999999999999999";
    harness.world.tokens.set(second, { symbol: "SLD2", decimals: 18, slot: 0, layout: "solady" });
    harness.world.accessListErrors.add(SIM_URLS[1] as string);
    assert.equal(await discoverBalanceSlot("base", second, USER), null);
    harness.world.accessListErrors.clear();
    assert.equal((await discoverBalanceSlot("base", second, USER))?.kind, "storage", "an unavailable trace is retried");
  });

  it("bounds the keys it tries", () => {
    assert.ok(MAX_TRACED_KEYS <= 64);
    // Candidate keys are holder specific (the mapping key of the holder).
    const [first] = mappingCandidates();
    assert.ok(first);
    assert.notEqual(balanceStorageKey(USER, first), balanceStorageKey(OTHER, first));
  });
});
