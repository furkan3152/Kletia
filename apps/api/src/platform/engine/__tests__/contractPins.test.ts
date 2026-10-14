/**
 * Code-identity pins of registered EVM contracts: every supported proxy
 * pattern (with the live Base USDC ZeppelinOS values), refusal hints, the
 * getProof → getCode fallback and diff detection, retries of reads at a
 * pinned block that a lagging RPC node does not know yet, and the sanitized
 * log line of mapped upstream errors.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { keccak256, pad, type Hex } from "viem";
import type { EvmContractPins } from "@kletia/core";
import { compareEvmPins, currentEvmPins, inspectEvmContract, PROXY_SLOTS, proxyRefusalReason, readEvmContractPins } from "../contracts/pins.js";
import { toPlatformError, sanitizeUpstreamMessage } from "../../errors.js";
import { configureBlockLagRetry, readStorageSlot } from "../chains/evm.js";
import { installEvmHarness, resetContractCaches, RpcError, type EvmHarness } from "./contractHarness.js";

/** Live values read 2026-10-09 (design §4.2 and Appendix A). */
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const BASE_USDC_IMPLEMENTATION = "0x2Ce6311ddAE708829bc0784C967b7d77D19FD779";
const BASE_USDC_ADMIN = "0x4fc7850364958d97B4d3f5A08f79db2493f8cA44";
const AAVE_POOL = "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5";
const AAVE_IMPLEMENTATION = "0xA4AbC5FcBA6D0d7E3D144d6dbF6cb6128599dFdB";
const PROXY_CODE = "0x60806040526004361061001e5760003560e01c";
const IMPLEMENTATION_CODE = "0x608060405234801561001057600080fd5b50";

let harness: EvmHarness;

function setSlot(address: string, slot: string, value: string, block?: bigint): void {
  harness.world.storage.set(`${block !== undefined ? `${block}:` : ""}${address.toLowerCase()}:${slot}`, pad(value as Hex));
}

beforeEach(() => {
  resetContractCaches();
  harness = installEvmHarness();
});

afterEach(() => harness.restore());

describe("EVM contract pins", () => {
  it("pins a plain contract by code hash", async () => {
    const code = "0x6080604052600436106100";
    harness.world.code.set("0x7bfa7c4f149e7415b73bdedfe609237e29cbf34a", code);
    const { pins, hints } = await readEvmContractPins("base", "0x7BfA7C4f149E7415b73bdeDfe609237e29CBF34A");
    assert.equal(pins.codeHash, keccak256(code));
    assert.equal(pins.codeSize, 11);
    assert.equal(pins.proxy, null);
    assert.equal(pins.blockNumber, harness.world.blockNumber.toString());
    assert.deepEqual(hints, []);
  });

  it("pins Base USDC as a ZeppelinOS proxy (EIP-1967 slots are empty), with its admin", async () => {
    harness.world.code.set(BASE_USDC.toLowerCase(), PROXY_CODE);
    harness.world.code.set(BASE_USDC_IMPLEMENTATION.toLowerCase(), IMPLEMENTATION_CODE);
    setSlot(BASE_USDC, PROXY_SLOTS.zeppelinosImplementation, BASE_USDC_IMPLEMENTATION);
    setSlot(BASE_USDC, PROXY_SLOTS.zeppelinosAdmin, BASE_USDC_ADMIN);
    const inspection = await inspectEvmContract("base", BASE_USDC);
    assert.equal(inspection.eip7702, false);
    assert.deepEqual(inspection.pins.proxy, {
      kind: "zeppelinos",
      implementation: BASE_USDC_IMPLEMENTATION,
      implementationCodeHash: keccak256(IMPLEMENTATION_CODE),
      admin: BASE_USDC_ADMIN,
      beacon: null,
      beaconCodeHash: null,
    });
    assert.deepEqual(inspection.proxyHints, ["zeppelinos"]);
    assert.equal(proxyRefusalReason(inspection), null);
  });

  it("pins an EIP-1967 proxy and notes an unset admin slot (Aave V3 Pool shape)", async () => {
    harness.world.code.set(AAVE_POOL.toLowerCase(), PROXY_CODE);
    harness.world.code.set(AAVE_IMPLEMENTATION.toLowerCase(), IMPLEMENTATION_CODE);
    setSlot(AAVE_POOL, PROXY_SLOTS.eip1967Implementation, AAVE_IMPLEMENTATION);
    const { pins, hints } = await readEvmContractPins("base", AAVE_POOL);
    assert.equal(pins.proxy?.kind, "eip1967");
    assert.equal(pins.proxy?.implementation, AAVE_IMPLEMENTATION);
    assert.equal(pins.proxy?.admin, null);
    assert.deepEqual(hints, ["eip1967", "eip1967-admin-unset"]);
  });

  it("pins a beacon proxy through beacon.implementation(), with the beacon's code hash", async () => {
    const proxy = "0x3333333333333333333333333333333333333333";
    const beacon = "0x4444444444444444444444444444444444444444";
    const implementation = "0x5555555555555555555555555555555555555555";
    harness.world.code.set(proxy, PROXY_CODE);
    harness.world.code.set(beacon, "0x6001");
    harness.world.code.set(implementation, IMPLEMENTATION_CODE);
    harness.world.beacons.set(beacon, implementation);
    setSlot(proxy, PROXY_SLOTS.eip1967Beacon, beacon);
    const { pins, hints } = await readEvmContractPins("base", proxy);
    assert.equal(pins.proxy?.kind, "eip1967-beacon");
    assert.equal(pins.proxy?.beacon?.toLowerCase(), beacon);
    assert.equal(pins.proxy?.beaconCodeHash, keccak256("0x6001"));
    assert.equal(pins.proxy?.implementation.toLowerCase(), implementation);
    assert.equal(pins.proxy?.implementationCodeHash, keccak256(IMPLEMENTATION_CODE));
    assert.deepEqual(hints, ["eip1967-beacon"]);
  });

  it("pins EIP-1822 and EIP-1167 proxies", async () => {
    const uups = "0x6666666666666666666666666666666666666666";
    const implementation = "0x5555555555555555555555555555555555555555";
    harness.world.code.set(uups, PROXY_CODE);
    harness.world.code.set(implementation, IMPLEMENTATION_CODE);
    setSlot(uups, PROXY_SLOTS.eip1822, implementation);
    assert.equal((await readEvmContractPins("base", uups)).pins.proxy?.kind, "eip1822");

    const clone = "0x7777777777777777777777777777777777777777";
    harness.world.code.set(clone, `0x363d3d373d3d3d363d73${implementation.slice(2)}5af43d82803e903d91602b57fd5bf3`);
    const { pins } = await readEvmContractPins("base", clone);
    assert.equal(pins.proxy?.kind, "eip1167");
    assert.equal(pins.proxy?.implementation.toLowerCase(), implementation);
  });

  it("reports EIP-7702 delegations, missing code, diamonds and broken proxies as refusal hints", async () => {
    const delegated = "0x8888888888888888888888888888888888888888";
    harness.world.code.set(delegated, "0xef01005555555555555555555555555555555555555555");
    const inspection = await inspectEvmContract("base", delegated);
    assert.equal(inspection.eip7702, true);

    const empty = await inspectEvmContract("base", "0x9999999999999999999999999999999999999999");
    assert.equal(empty.codeSize, 0);
    assert.ok(empty.proxyHints.includes("not-deployed"));

    const diamond = "0xabababababababababababababababababababab";
    harness.world.code.set(diamond, PROXY_CODE);
    harness.world.diamonds.add(diamond);
    const loupe = await inspectEvmContract("base", diamond);
    assert.ok(loupe.proxyHints.includes("eip2535-diamond"));
    assert.match(proxyRefusalReason(loupe) ?? "", /diamond/u);

    const hollow = "0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd";
    harness.world.code.set(hollow, PROXY_CODE);
    setSlot(hollow, PROXY_SLOTS.eip1967Implementation, "0x1212121212121212121212121212121212121212");
    assert.match(proxyRefusalReason(await inspectEvmContract("base", hollow)) ?? "", /without code/u);

    const double = "0xefefefefefefefefefefefefefefefefefefefef";
    harness.world.code.set(double, PROXY_CODE);
    harness.world.code.set("0x5555555555555555555555555555555555555555", IMPLEMENTATION_CODE);
    setSlot(double, PROXY_SLOTS.eip1967Implementation, "0x5555555555555555555555555555555555555555");
    setSlot(double, PROXY_SLOTS.zeppelinosImplementation, "0x5555555555555555555555555555555555555555");
    assert.match(proxyRefusalReason(await inspectEvmContract("base", double)) ?? "", /several proxy patterns/u);

    const dirty = "0x1313131313131313131313131313131313131313";
    harness.world.code.set(dirty, PROXY_CODE);
    harness.world.storage.set(`${dirty}:${PROXY_SLOTS.eip1967Implementation}`, `0x01${"0".repeat(22)}5555555555555555555555555555555555555555`);
    assert.match(proxyRefusalReason(await inspectEvmContract("base", dirty)) ?? "", /something other than an address/u);
  });

  it("falls back to keccak256(eth_getCode) when eth_getProof is not served, with identical hashes", async () => {
    const proxy = "0x3333333333333333333333333333333333333333";
    const implementation = "0x5555555555555555555555555555555555555555";
    harness.world.code.set(proxy, PROXY_CODE);
    harness.world.code.set(implementation, IMPLEMENTATION_CODE);
    setSlot(proxy, PROXY_SLOTS.eip1967Implementation, implementation);
    const withProof = (await readEvmContractPins("base", proxy)).pins;
    harness.world.proofs = false;
    const withoutProof = (await readEvmContractPins("base", proxy)).pins;
    assert.equal(withoutProof.proxy?.implementationCodeHash, withProof.proxy?.implementationCodeHash);
    assert.equal(compareEvmPins(withProof, withoutProof), null);
    assert.ok(harness.router.calls.some((call) => call.method === "eth_getProof"));
  });

  it("pins extra addresses with their labels and reads everything at one block", async () => {
    const spender = "0x2121212121212121212121212121212121212121";
    harness.world.code.set("0xbeef010f9cb27031ad51e3333f9af9c6b1228183", "0x6001");
    harness.world.code.set(spender, "0x6002");
    const { pins } = await readEvmContractPins("base", "0xbeeF010f9cb27031ad51e3333f9aF9C6B1228183", [{ label: "router", address: spender }], 99n);
    assert.equal(pins.blockNumber, "99");
    assert.equal(pins.addresses[0]?.label, "router");
    assert.equal(pins.addresses[0]?.codeHash, keccak256("0x6002"));
    const reads = harness.router.calls.filter((call) => call.method === "eth_getCode" || call.method === "eth_getStorageAt");
    assert.ok(reads.length > 0 && reads.every((call) => call.params[call.params.length - 1] === "0x63"));
  });

  it("detects a change in every pinned field and ignores block and time", () => {
    const base: EvmContractPins = {
      codeHash: `0x${"11".repeat(32)}`,
      codeSize: 10,
      proxy: { kind: "zeppelinos", implementation: BASE_USDC_IMPLEMENTATION, implementationCodeHash: `0x${"22".repeat(32)}`, admin: BASE_USDC_ADMIN, beacon: null, beaconCodeHash: null },
      addresses: [{ label: "router", address: "0x2121212121212121212121212121212121212121", codeHash: `0x${"33".repeat(32)}`, codeSize: 3, proxy: null }],
      blockNumber: "1",
      checkedAt: "2026-01-01T00:00:00.000Z",
    };
    assert.equal(compareEvmPins(base, { ...base, blockNumber: "2", checkedAt: "2026-10-09T00:00:00.000Z" }), null);
    assert.equal(compareEvmPins(base, { ...base, proxy: { ...base.proxy!, implementation: BASE_USDC_IMPLEMENTATION.toLowerCase() } }), null);
    const changes: [string, EvmContractPins][] = [
      ["code hash", { ...base, codeHash: `0x${"44".repeat(32)}` }],
      ["implementation changed", { ...base, proxy: { ...base.proxy!, implementation: "0x5555555555555555555555555555555555555555" } }],
      ["implementation code hash", { ...base, proxy: { ...base.proxy!, implementationCodeHash: `0x${"55".repeat(32)}` } }],
      ["admin", { ...base, proxy: { ...base.proxy!, admin: "0x6666666666666666666666666666666666666666" } }],
      ["beacon", { ...base, proxy: { ...base.proxy!, beacon: "0x6666666666666666666666666666666666666666" } }],
      ["proxy shape", { ...base, proxy: null }],
      ["proxy kind", { ...base, proxy: { ...base.proxy!, kind: "eip1967" } }],
      ["missing", { ...base, addresses: [{ ...base.addresses[0]!, address: "0x7777777777777777777777777777777777777777" }] }],
      ["router's code hash", { ...base, addresses: [{ ...base.addresses[0]!, codeHash: `0x${"66".repeat(32)}` }] }],
    ];
    for (const [needle, current] of changes) {
      assert.match(compareEvmPins(base, current) ?? "no diff", new RegExp(needle, "u"), needle);
    }
  });

  it("caches plan-time pins for 30 seconds and re-reads fresh ones at prepare", async () => {
    harness.world.code.set("0xbeef010f9cb27031ad51e3333f9af9c6b1228183", "0x6001");
    const first = await currentEvmPins("base", "0xbeeF010f9cb27031ad51e3333f9aF9C6B1228183", []);
    harness.world.code.set("0xbeef010f9cb27031ad51e3333f9af9c6b1228183", "0x6002");
    const cached = await currentEvmPins("base", "0xbeeF010f9cb27031ad51e3333f9aF9C6B1228183", []);
    assert.equal(cached.codeHash, first.codeHash);
    const fresh = await currentEvmPins("base", "0xbeeF010f9cb27031ad51e3333f9aF9C6B1228183", [], { fresh: true });
    assert.equal(fresh.codeHash, keccak256("0x6002"));
    harness.world.codeAt.set("7:0xbeef010f9cb27031ad51e3333f9af9c6b1228183", "0x6003");
    const atBlock = await currentEvmPins("base", "0xbeeF010f9cb27031ad51e3333f9aF9C6B1228183", [], { blockNumber: 7n });
    assert.equal(atBlock.codeHash, keccak256("0x6003"));
  });
});

describe("pin reads at a pinned block on lagging RPC nodes", () => {
  const TARGET = "0x7BfA7C4f149E7415b73bdeDfe609237e29CBF34A";

  beforeEach(() => {
    configureBlockLagRetry([1, 1]);
    harness.world.code.set(TARGET.toLowerCase(), "0x6080604052600436106100");
  });

  afterEach(() => configureBlockLagRetry(null));

  /** Makes eth_getStorageAt of the EIP-1967 implementation slot fail `times` times with `message`. */
  function lagging(times: number, message = "unsupported block number 52376674"): { readonly blocks: string[] } {
    const original = harness.router.handlers.get("eth_getStorageAt");
    assert.ok(original);
    const blocks: string[] = [];
    let failures = 0;
    harness.router.handlers.set("eth_getStorageAt", (params, url) => {
      if (String(params[1]).toLowerCase() === PROXY_SLOTS.eip1967Implementation) {
        blocks.push(String(params[2]));
        if (failures < times) {
          failures += 1;
          throw new RpcError(-32000, message);
        }
      }
      return original(params, url);
    });
    return { blocks };
  }

  it("retries twice at the same block and then reads the pins", async () => {
    const seen = lagging(2);
    const { pins } = await readEvmContractPins("base", TARGET, undefined, 52_376_674n);
    assert.equal(pins.blockNumber, "52376674");
    assert.equal(seen.blocks.length, 3);
    assert.deepEqual(new Set(seen.blocks), new Set([`0x${(52_376_674n).toString(16)}`]), "every retry reads the same block");
  });

  it("recognises the other propagation-lag messages", async () => {
    for (const message of ["header not found", "unknown block", "block not found"]) {
      resetContractCaches();
      const seen = lagging(1, message);
      await readEvmContractPins("base", TARGET, undefined, 52_376_674n);
      assert.equal(seen.blocks.length, 2, message);
    }
  });

  it("fails RPC_UNAVAILABLE after the third lag error, and logs one sanitized line", async () => {
    const seen = lagging(3);
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(" "));
    try {
      const error = await readEvmContractPins("base", TARGET, undefined, 52_376_674n).then(() => null, (failure: unknown) => failure);
      assert.ok(error, "the read fails");
      assert.equal(seen.blocks.length, 3, "two retries, no more");
      assert.equal(toPlatformError(error).code, "RPC_UNAVAILABLE");
    } finally {
      console.warn = original;
    }
    const line = warnings.find((entry) => entry.startsWith("[platform] upstream evm error:"));
    assert.ok(line, warnings.join("\n"));
    assert.doesNotMatch(line, /https?:\/\//u, "no RPC URL in the log");
    assert.ok(line.length <= "[platform] upstream evm error: ".length + 160);
  });

  it("never retries other errors, nor reads at the latest block", async () => {
    const other = lagging(1, "rate limit reached");
    await assert.rejects(readEvmContractPins("base", TARGET, undefined, 52_376_674n));
    assert.equal(other.blocks.length, 1);
    harness.restore();
    harness = installEvmHarness();
    const latest = lagging(1);
    await assert.rejects(readStorageSlot("base", TARGET, PROXY_SLOTS.eip1967Implementation));
    assert.deepEqual(latest.blocks, ["latest"], "a read at latest has nothing to wait for");
    // Pins without a block are still read at one pinned block (the latest number), so they retry.
    const pinned = lagging(1);
    const { pins } = await readEvmContractPins("base", TARGET);
    assert.equal(pinned.blocks.length, 2);
    assert.equal(pinned.blocks[0], `0x${BigInt(pins.blockNumber).toString(16)}`);
  });

  it("sanitizes upstream messages: URLs, long hex, keys; one line of at most 160 characters", () => {
    const raw = `HTTP request failed.\nURL: https://base-mainnet.g.alchemy.com/v2/SECRETKEY123\nRequest body: {"data":"0x${"ab".repeat(60)}"} apikey=abc123 ${"x".repeat(300)}`;
    const clean = sanitizeUpstreamMessage(raw);
    assert.doesNotMatch(clean, /alchemy|SECRETKEY|abc123|\n/u);
    assert.doesNotMatch(clean, /0x(?:ab){20}/u);
    assert.ok(clean.length <= 160);
    assert.match(clean, /^HTTP request failed\. URL: <url>/u);
  });
});
