/**
 * Argument bindings: every declared source, literals, tuples and arrays,
 * user parameters (enum as value and as index), the canonical re-encoding
 * check and event `where` matching.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeFunctionData, encodeFunctionData, parseAbi, type Hex } from "viem";
import type { AbiEventItem, AbiFunctionItem, ArgBinding } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import {
  boundValues,
  callValue,
  decodeContractCall,
  decodeEvent,
  encodeContractCall,
  isCanonicalCall,
  resolveArgs,
  reviewArgs,
  whereMatches,
  type BindingValues,
} from "../contracts/bindings.js";
import { depositLog, USER, VAULT, USDC_BASE } from "./contractHarness.js";

const DEPOSIT: AbiFunctionItem = {
  type: "function",
  name: "deposit",
  stateMutability: "nonpayable",
  inputs: [{ name: "assets", type: "uint256" }, { name: "receiver", type: "address" }],
};

const COMPLEX: AbiFunctionItem = {
  type: "function",
  name: "lock",
  stateMutability: "payable",
  inputs: [
    { name: "order", type: "tuple", components: [{ name: "amount", type: "uint256" }, { name: "minOut", type: "uint256" }, { name: "beneficiary", type: "address" }] },
    { name: "days", type: "uint32" },
    { name: "tier", type: "uint8" },
    { name: "label", type: "string" },
    { name: "auto", type: "bool" },
    { name: "deadline", type: "uint64" },
    { name: "path", type: "address[2]" },
    { name: "tag", type: "bytes32" },
    { name: "hook", type: "bytes" },
    { name: "previousAmount", type: "uint256" },
    { name: "previousToken", type: "address" },
    { name: "token", type: "address" },
  ],
};

const COMPLEX_BINDINGS: readonly ArgBinding[] = [
  { tuple: ["$amount", "$minimumOutput", "$recipient"] },
  "$param.lockDays",
  "$param.tier",
  "$param.tierName",
  "$param.auto",
  "$deadline",
  { array: [{ literal: "0x1111111111111111111111111111111111111111" }, { literal: "0x2222222222222222222222222222222222222222" }] },
  { literal: `0x${"ab".repeat(32)}` },
  { literal: "0x" },
  "$previous.output.amount",
  "$previous.output.asset",
  "$token",
];

function values(overrides: Partial<BindingValues> = {}): BindingValues {
  return {
    amount: 100_000_000n,
    account: USER,
    recipient: USER,
    token: USDC_BASE,
    self: VAULT,
    minimumOutput: 90_000_000_000_000_000_000n,
    deadline: 1_800_000_900n,
    previousAmount: 99_500_000n,
    previousAsset: USDC_BASE,
    params: { lockDays: "30", tier: "gold", tierName: "gold", auto: true },
    declarations: [
      { name: "lockDays", type: "uint", min: "1", max: "365" },
      { name: "tier", type: "enum", enum: ["silver", "gold"] },
      { name: "tierName", type: "enum", enum: ["silver", "gold"] },
      { name: "auto", type: "bool" },
    ],
    ...overrides,
  };
}

function bindingError(code = "CONTRACT_BINDING_INVALID") {
  return (error: unknown) => error instanceof PlatformError && error.code === code;
}

describe("contract bindings", () => {
  it("encodes the registered function exactly like viem and round-trips it", () => {
    const args = resolveArgs(DEPOSIT, ["$amount", "$account"], values());
    const data = encodeContractCall(DEPOSIT, args);
    const expected = encodeFunctionData({ abi: parseAbi(["function deposit(uint256,address)"]), functionName: "deposit", args: [100_000_000n, USER] });
    assert.equal(data, expected);
    assert.equal(data.slice(0, 10), "0x6e553f65");
    assert.deepEqual(decodeContractCall(DEPOSIT, data), [100_000_000n, USER]);
    assert.equal(isCanonicalCall(DEPOSIT, data), true);
  });

  it("refuses trailing data, another selector and non-canonical words", () => {
    const data = encodeContractCall(DEPOSIT, [100n, USER]);
    assert.equal(isCanonicalCall(DEPOSIT, `${data}00`), false);
    assert.equal(isCanonicalCall(DEPOSIT, `${data}${"00".repeat(32)}`), false);
    assert.equal(isCanonicalCall(DEPOSIT, `0x095ea7b3${data.slice(10)}`), false);
    // A dirty high word for the address argument decodes in some decoders; it must never pass the guard.
    const dirty = `${data.slice(0, 10 + 64)}ff${data.slice(10 + 64 + 2)}`;
    assert.equal(isCanonicalCall(DEPOSIT, dirty), false);
    assert.equal(decodeContractCall(DEPOSIT, "0xzz"), null);
  });

  it("binds tuples, params (uint, enum as index and value, bool), $deadline, literals, arrays, $previous and $token", () => {
    const args = resolveArgs(COMPLEX, COMPLEX_BINDINGS, values());
    const data = encodeContractCall(COMPLEX, args);
    assert.equal(isCanonicalCall(COMPLEX, data), true);
    const decoded = decodeFunctionData({
      abi: [COMPLEX as never],
      data: data as Hex,
    }).args as readonly unknown[];
    assert.deepEqual(decoded[0], { amount: 100_000_000n, minOut: 90_000_000_000_000_000_000n, beneficiary: USER });
    assert.equal(decoded[1], 30);
    assert.equal(decoded[2], 1);
    assert.equal(decoded[3], "gold");
    assert.equal(decoded[4], true);
    assert.equal(decoded[5], 1_800_000_900n);
    assert.equal(decoded[8], "0x");
    assert.equal(decoded[9], 99_500_000n);
    assert.equal(String(decoded[10]).toLowerCase(), USDC_BASE.toLowerCase());
    assert.deepEqual(boundValues(COMPLEX, COMPLEX_BINDINGS, decodeContractCall(COMPLEX, data) ?? [], "$amount"), [100_000_000n]);
  });

  it("encodes $minimumOutput as 0 until it is known", () => {
    const args = resolveArgs(COMPLEX, COMPLEX_BINDINGS, values({ minimumOutput: null }));
    assert.deepEqual((args[0] as unknown[])[1], 0n);
  });

  it("refuses $previous without a previous output, $amount without input, unknown and malformed params", () => {
    assert.throws(() => resolveArgs(COMPLEX, COMPLEX_BINDINGS, values({ previousAmount: null })), bindingError());
    assert.throws(() => resolveArgs(COMPLEX, COMPLEX_BINDINGS, values({ previousAsset: null })), bindingError());
    assert.throws(() => resolveArgs(DEPOSIT, ["$amount", "$account"], values({ amount: null })), bindingError());
    assert.throws(() => resolveArgs(COMPLEX, COMPLEX_BINDINGS, values({ params: { lockDays: "30", tier: "bronze", tierName: "gold", auto: true } })), bindingError());
    assert.throws(() => resolveArgs(COMPLEX, COMPLEX_BINDINGS, values({ params: { lockDays: "30", tier: "gold", tierName: "gold" } })), bindingError());
    assert.throws(() => resolveArgs(DEPOSIT, ["$amount"], values()), bindingError());
    assert.throws(() => resolveArgs(DEPOSIT, ["$amount", "$nope" as ArgBinding], values()), bindingError());
  });

  it("caps the call value and binds it to the native amount", () => {
    assert.equal(callValue(undefined, 5n), 0n);
    assert.equal(callValue({ bind: "$amount", max: "10" }, 7n), 7n);
    assert.equal(callValue({ bind: "1000", max: "1000" }, null), 1000n);
    assert.throws(() => callValue({ bind: "$amount", max: "10" }, 11n), bindingError("CONTRACT_AMOUNT_LIMIT"));
  });

  it("shows each argument with its source in the review", () => {
    const args = resolveArgs(COMPLEX, COMPLEX_BINDINGS, values());
    const rows = reviewArgs(COMPLEX, COMPLEX_BINDINGS, args, { input: { symbol: "USDC", decimals: 6 }, previous: { symbol: "USDC", decimals: 6 } });
    assert.deepEqual(rows.map((row) => row.source), ["literal", "param", "param", "param", "param", "deadline", "literal", "literal", "literal", "previousOutput", "previousOutput", "token"]);
    assert.equal(rows[0]?.type, "(uint256,uint256,address)");
    assert.equal(rows[9]?.display, "99.5 USDC");
    assert.match(rows[5]?.display ?? "", /^2027-/u);
    const simple = reviewArgs(DEPOSIT, ["$amount", "$account"], [100_000_000n, USER], { input: { symbol: "USDC", decimals: 6 } });
    assert.deepEqual(simple, [
      { name: "assets", type: "uint256", display: "100 USDC", source: "amount" },
      { name: "receiver", type: "address", display: USER, source: "account" },
    ]);
  });

  it("matches event where-bindings against the landed values", () => {
    const fragment: AbiEventItem = {
      type: "event",
      name: "Deposit",
      inputs: [
        { name: "sender", type: "address", indexed: true },
        { name: "owner", type: "address", indexed: true },
        { name: "assets", type: "uint256", indexed: false },
        { name: "shares", type: "uint256", indexed: false },
      ],
    };
    const log = depositLog(VAULT, USER, USER, 100n, 90n);
    const decoded = decodeEvent(fragment, log);
    assert.ok(decoded);
    const where = { owner: "$account", assets: "$amount" } as const;
    const base = { account: USER, recipient: USER, amount: 100n, token: USDC_BASE, self: VAULT };
    assert.equal(whereMatches(fragment, decoded, where, base), true);
    assert.equal(whereMatches(fragment, decoded, where, { ...base, amount: 101n }), false);
    assert.equal(whereMatches(fragment, decoded, where, { ...base, account: VAULT }), false);
    assert.equal(whereMatches(fragment, decoded, { owner: { literal: USER } }, base), true);
    assert.equal(decodeEvent(fragment, { topics: log.topics.slice(0, 2), data: log.data }), null);
  });
});
