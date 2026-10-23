/**
 * The independent oracles of the intent eval (goal/evalOracle.ts: the
 * invariants and the conservation check): each reads only the text, the
 * resolved actions and the fixture balances, so a permissive accept regex
 * cannot hide an unsaid recipient, a dropped venue, an ignored closed-class
 * or unit word, an unused number or a look-alike read as its sibling.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ResolvedAction } from "../clarify/types.js";
import { oracleFlags, recipientsSaid } from "../goal/evalOracle.js";

const step = (overrides: Partial<ResolvedAction>): ResolvedAction => ({ kind: "swap", network: "solana", from: "SOL", to: "USDC", amount: "1", ...overrides }) as ResolvedAction;
const flags = (text: string, actions: ResolvedAction[], extra: { balances?: Record<string, Record<string, string>>; confirmed?: boolean } = {}) =>
  oracleFlags({ text, actions, balances: extra.balances ?? null, ...(extra.confirmed ? { confirmed: true } : {}) });
const codes = (list: readonly string[]) => list.map((flag) => flag.split(":")[0]);

describe("eval oracles", () => {
  it("a faithful plan raises nothing", () => {
    assert.deepEqual(flags("swap 1 SOL to USDC", [step({})]), []);
    assert.deepEqual(flags("swap 1 sol to usdc via orca", [step({ protocol: "orca" } as Partial<ResolvedAction>)]), []);
    assert.deepEqual(flags("send 5 usdc to vitalik.eth on base", [step({ kind: "transfer", network: "base", from: "USDC", to: undefined, amount: "5", recipient: "vitalik.eth" })]), []);
    assert.deepEqual(flags("swap twenty five usdc to sol", [step({ from: "USDC", to: "SOL", amount: "25" })]), [], "spelled tens and units are one number");
  });

  it("I2 network continuity and I10 round trips", () => {
    const hop = [step({}), step({ kind: "deposit", network: "base", from: "USDC", to: undefined, amount: "max", protocol: "aave-v3" } as Partial<ResolvedAction>)];
    assert.ok(codes(flags("swap 1 sol to usdc and deposit it into aave on base", hop)).includes("I2 network"));
    const back = [
      step({ kind: "bridge", network: "base", toNetwork: "arbitrum", from: "USDC", to: undefined, amount: "10" }),
      step({ kind: "bridge", network: "arbitrum", toNetwork: "base", from: "USDC", to: undefined, amount: "max" }),
    ];
    assert.ok(codes(flags("bridge 10 usdc from base to arbitrum then back to base", back)).includes("I10 round trip"));
  });

  it("I3 recipient fidelity: only said recipients are paid, every said one is paid", () => {
    assert.deepEqual(recipientsSaid("send 5 usdc to Alice.eth and 0x1111111111111111111111111111111111111111"), ["alice.eth", "0x1111111111111111111111111111111111111111"]);
    const unsaid = flags("send 5 usdc on base", [step({ kind: "transfer", network: "base", from: "USDC", to: undefined, amount: "5", recipient: "bob.eth" })]);
    assert.ok(unsaid.some((flag) => flag === "I3 recipient: bob.eth is paid but not said"), unsaid.join("; "));
    const dropped = flags("send everything on base to alice.eth", [step({ kind: "bridge", network: "arbitrum", toNetwork: "base", from: "USDC", to: undefined, amount: "250" })]);
    assert.ok(dropped.includes("I3 recipient: alice.eth is said but not paid"), dropped.join("; "));
  });

  it("I4 verb and I5 venue fidelity", () => {
    const deposit = flags("swap 1 sol to usdc on meteora", [step({ kind: "deposit", from: "SOL", to: undefined, protocol: "kamino" } as Partial<ResolvedAction>)]);
    assert.ok(codes(deposit).includes("I4 verb"), deposit.join("; "));
    assert.ok(deposit.includes("I5 venue: meteora is named but not used"), deposit.join("; "));
    const avoided = flags("swap 1 sol to usdc without orca", [step({ protocol: "orca" } as Partial<ResolvedAction>)]);
    assert.ok(avoided.includes("I5 venue: orca is avoided but used"), avoided.join("; "));
  });

  it("I6 double claims, I7 stake input and I8 address family", () => {
    const twice = flags("swap all my sol to usdc and all my sol to usdt", [step({ amount: "max" }), step({ to: "USDT", amount: "max" })]);
    assert.ok(codes(twice).includes("I6 holding"), twice.join("; "));
    const stake = flags("stake 10 usdc with jito", [step({ kind: "stake", from: "USDC", to: "JitoSOL", amount: "10", provider: "jito" } as Partial<ResolvedAction>)]);
    assert.ok(codes(stake).includes("I7 stake input"), stake.join("; "));
    const family = flags("send 10 usdc to 0x1111111111111111111111111111111111111111 on solana", [
      step({ kind: "transfer", from: "USDC", to: undefined, amount: "10", recipient: "0x1111111111111111111111111111111111111111" }),
    ]);
    assert.ok(codes(family).includes("I8 family"), family.join("; "));
  });

  it("I9 funding: an exact spend above the fixture balance", () => {
    const balances = { optimism: { USDC: "0" } };
    const list = flags("send 5 usdc to vitalik.eth on optimism", [step({ kind: "transfer", network: "optimism", from: "USDC", to: undefined, amount: "5", recipient: "vitalik.eth" })], { balances });
    assert.deepEqual(list, ["I9 funding: spends 5 USDC on optimism, holds 0"]);
  });

  it("I13 third-party value: a whole holding or no receiving network needs a confirm", () => {
    const all = flags("send all my usdc to alice.eth on base", [step({ kind: "transfer", network: "base", from: "USDC", to: undefined, amount: "max", recipient: "alice.eth" })]);
    assert.ok(all.includes("I13 third party: pays all of a holding to alice.eth"), all.join("; "));
    const noNetwork = flags("send 5 usdc to alice.eth", [step({ kind: "transfer", network: "base", from: "USDC", to: undefined, amount: "5", recipient: "alice.eth" })]);
    assert.ok(noNetwork.includes("I13 third party: receiving network of alice.eth not said"), noNetwork.join("; "));
    // A confirm the person answered covers both.
    assert.deepEqual(codes(flags("send 5 usdc to alice.eth", [step({ kind: "transfer", network: "base", from: "USDC", to: undefined, amount: "5", recipient: "alice.eth" })], { confirmed: true })), []);
  });

  it("I14 look-alikes and untyped symbols", () => {
    const lookalike = flags("swap 1 steth to eth on ethereum", [step({ network: "ethereum", from: "wstETH", to: "ETH" })]);
    assert.ok(lookalike.some((flag) => flag.startsWith('I14 look-alike: "stETH" read as WSTETH')), lookalike.join("; "));
    const untyped = flags("swap 1 sol to usdc", [step({ to: "USDT" })]);
    assert.ok(untyped.includes("I14 symbol: USDT was not typed"), untyped.join("; "));
  });

  it("I16 closed-class and unit words are consumed by a planning rule", () => {
    const negation = flags("dont swap 1 sol to usdc", [step({})]);
    assert.ok(negation.some((flag) => flag.startsWith('I16 closed class: "dont" (negation)')), negation.join("; "));
    const limit = flags("swap over 100 usdc to eth on base", [step({ network: "base", from: "USDC", to: "ETH", amount: "100" })]);
    assert.ok(limit.some((flag) => flag.startsWith('I16 closed class: "over" (limit)')), limit.join("; "));
    const unit = flags("swap 1.5k usdc to sol", [step({ from: "USDC", to: "SOL", amount: "1.5" })]);
    assert.ok(unit.includes('I16 closed class: unit "k" not applied'), unit.join("; "));
    assert.ok(!flags("swap 1.5k usdc to sol", [step({ from: "USDC", to: "SOL", amount: "1500" })]).some((flag) => flag.startsWith("I16")));
    const network = flags("swap 1 eth to usdc on base sepolia", [step({ network: "base", from: "ETH", to: "USDC" })]);
    assert.ok(network.some((flag) => flag.startsWith("I16 closed class: unsupported network")), network.join("; "));
  });

  it("conservation of numbers, and dot-thousands is never read silently", () => {
    const extra = flags("swap 1 sol to usdc and 3 more", [step({})]);
    assert.ok(extra.includes("N number: 3 is not an amount of the plan"), extra.join("; "));
    const dot = flags("swap 1.000 usdc to sol", [step({ from: "USDC", to: "SOL", amount: "1.000" })]);
    assert.ok(dot.includes("N number: 1.000 has two readings (dot-thousands) and was not asked"), dot.join("; "));
    // USD amounts, percentages and kept amounts are converted or consumed.
    assert.deepEqual(flags("swap $20 of sol to usdc", [step({ amount: "0.132432" })]), []);
    assert.deepEqual(flags("swap 10% of my sol to usdc", [step({ amount: "0.25" })]), []);
  });
});
