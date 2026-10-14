/**
 * Departure (sourceNetwork): the console prototype's ten cases with the
 * plan's unified rules, auto mode, its read budget and preview accounts,
 * and the planner wiring (interpretation.departure, never applied twice).
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { PREVIEW_ACCOUNT_IDS, toBaseUnits, type AccountId, type IntentActionSpec, type IntentRequest, type NetworkKey, type SourceNetwork } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { pickFundedSource, resolveDeparture, type DepartureBalanceReader } from "../departure.js";
import { compileIntentText, MissingSourceError } from "../grammar.js";
import { planIntent } from "../planner.js";
import { ACCOUNTS, EVM_ADDRESS, OTHER_SOL_ADDRESS, resetEngine, SOL_ADDRESS } from "./helpers.js";
import { resetVenueEngine } from "./venueStubs.js";

const accounts = ACCOUNTS as AccountId[];
const wallet: Record<string, Record<string, string>> = {
  base: { USDC: "120.4" },
  arbitrum: { USDC: "3" },
  solana: { USDC: "2", SOL: "0.09" },
};
const DECIMALS: Record<string, number> = { USDC: 6, SOL: 9, ETH: 18 };

interface Reader {
  readonly read: DepartureBalanceReader;
  readonly calls: { network: NetworkKey; asset: string }[];
}

function reader(balances: Record<string, Record<string, string | null>> = wallet): Reader {
  const calls: { network: NetworkKey; asset: string }[] = [];
  return {
    calls,
    read: async (reads) => reads.map((entry) => {
      calls.push({ network: entry.network, asset: entry.asset });
      const value = balances[entry.network]?.[entry.asset.toUpperCase()];
      if (value === null) return null;
      return BigInt(toBaseUnits(value ?? "0", DECIMALS[entry.asset.toUpperCase()] ?? 6));
    }),
  };
}

function request(text: string, sourceNetwork: SourceNetwork | undefined, own: AccountId[] = accounts): IntentRequest {
  return { text, accounts: own, ...(sourceNetwork ? { sourceNetwork } : {}) };
}

/** The planner's departure path in miniature: compile (sourceNetwork as defaultNetwork), then resolveDeparture. */
async function depart(text: string, sourceNetwork: SourceNetwork | undefined, balances = reader(), own: AccountId[] = accounts) {
  const fixed = sourceNetwork && sourceNetwork !== "auto" ? sourceNetwork : undefined;
  const compiled = compileIntentText(text, { accounts: own, ...(fixed ? { defaultNetwork: fixed } : {}) });
  return resolveDeparture(compiled.actions, compiled.explicitNetwork, request(text, sourceNetwork, own), own, balances.read);
}

function shape(actions: readonly IntentActionSpec[]): string {
  return actions.map((action) => `${action.kind}@${action.network}${action.toNetwork ? `->${action.toNetwork}` : ""}:${action.amount}`).join(" | ");
}

async function refusal(promise: Promise<unknown>): Promise<PlatformError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof PlatformError, `expected PlatformError, got ${String(error)}`);
    return error;
  }
  assert.fail("expected a refusal");
}

beforeEach(() => {
  resetEngine();
});

describe("departure: the prototype cases under the unified rules", () => {
  it("1. a fixed departure Base turns 'swap 10 USDC to SOL' into a bridge from Base, then the swap", async () => {
    const out = await depart("swap 10 USDC to SOL", "base");
    assert.equal(shape(out.actions), "bridge@base->solana:10 | swap@solana:max");
    assert.deepEqual(out.departure, { network: "base", chosen: "request", bridged: true, reason: "Bridges from Base to Solana first." });
    assert.deepEqual(out.explicitNetwork, [false, false]);
  });

  it("2. no departure keeps today's plan", async () => {
    const out = await depart("swap 10 USDC to SOL", undefined);
    assert.equal(shape(out.actions), "swap@solana:10");
    assert.equal(out.departure, undefined);
  });

  it("3. auto picks the funded network for a bridge without a source", async () => {
    const balances = reader();
    const picked = await pickFundedSource({ asset: "USDC", amount: "25", toNetwork: "solana" }, accounts, request("bridge 25 USDC to solana", "auto"), balances.read);
    assert.equal(picked.network, "base");
    assert.equal(picked.departure.chosen, "auto");
    assert.match(picked.departure.reason ?? "", /^Base holds 120\.40 USDC; Arbitrum One 3\.00$/u);
    assert.ok(balances.calls.length <= 5);
  });

  it("4. auto with nothing funded asks for a source with the balances read", async () => {
    const error = await refusal(pickFundedSource({ asset: "USDC", amount: "500", toNetwork: "solana" }, accounts, request("bridge 500 USDC to solana", "auto"), reader().read));
    assert.equal(error.code, "SOURCE_REQUIRED");
    assert.equal(error.status, 422);
    assert.deepEqual(error.details, {
      asset: "USDC",
      amount: "500",
      toNetwork: "solana",
      candidates: [{ network: "base", balance: "120.4", enough: false }, { network: "arbitrum", balance: "3", enough: false }],
    });
  });

  it("5. auto funds an underfunded swap from the best-funded network", async () => {
    const out = await depart("swap 10 USDC to SOL", "auto");
    assert.equal(shape(out.actions), "bridge@base->solana:10 | swap@solana:max");
    assert.equal(out.departure?.chosen, "auto");
    assert.equal(out.departure?.bridged, true);
    assert.equal(out.departure?.network, "base");
    assert.equal(out.departure?.reason, "Solana holds 2.00 USDC; Base 120.40");
  });

  it("6. the sentence wins over the departure", async () => {
    const out = await depart("bridge 25 USDC from base to solana", "arbitrum");
    assert.equal(shape(out.actions), "bridge@base->solana:25");
    assert.deepEqual(out.departure, { network: "base", chosen: "text" });
    assert.deepEqual(out.warnings, ["The sentence names Base; the departure Arbitrum One was not used."]);
  });

  it("7. a departure on the action's own network changes nothing", async () => {
    const out = await depart("deposit 100 USDC into aave on base", "base");
    assert.equal(shape(out.actions), "deposit@base:100");
    assert.deepEqual(out.departure, { network: "base", chosen: "request" });
    assert.deepEqual(out.warnings, []);
  });

  it("8. a transfer elsewhere to a third party becomes one bridge leg to the recipient (unified rule; the prototype refused it)", async () => {
    const out = await depart(`send 1 USDC to ${OTHER_SOL_ADDRESS}`, "base");
    assert.deepEqual(out.actions, [{ kind: "bridge", network: "base", from: "USDC", to: "USDC", amount: "1", toNetwork: "solana", recipient: OTHER_SOL_ADDRESS }]);
    assert.equal(out.departure?.bridged, true);
    assert.match(out.warnings[0] ?? "", /recipient receives what arrives on Solana after bridge fees/u);
  });

  it("9. an input that is not on the departure runs where it lives (unified rule; the prototype refused it)", async () => {
    const out = await depart("stake 2 SOL with jito", "base");
    assert.equal(shape(out.actions), "stake@solana:2");
    assert.deepEqual(out.departure, { network: "solana", chosen: "text" });
    assert.match(out.warnings[0] ?? "", /SOL cannot be bridged from Base to Solana; the stake runs where it is/u);
  });

  it("10. a testnet departure never funds a mainnet step", async () => {
    const error = await refusal(depart("deposit 10 USDC into kamino", "arc"));
    assert.equal(error.code, "SOURCE_UNREACHABLE");
    assert.deepEqual(error.details, { sourceNetwork: "arc", actionNetwork: "solana", kind: "deposit" });
  });
});

describe("departure: further rules", () => {
  it("leaves a withdraw where the position is, with a warning", async () => {
    const out = await depart("withdraw 50 USDC from kamino", "base");
    assert.equal(shape(out.actions), "withdraw@solana:50");
    assert.deepEqual(out.departure, { network: "solana", chosen: "text" });
    assert.match(out.warnings[0] ?? "", /A withdrawal starts where the position is \(Solana\)/u);
  });

  it("refuses a pair no bridge serves here (SOURCE_UNREACHABLE)", async () => {
    // The stub bridges serve Base, Arbitrum One and Solana only.
    const error = await refusal(depart("swap 10 USDC to SOL", "optimism"));
    assert.equal(error.code, "SOURCE_UNREACHABLE");
    assert.match(error.message, /No bridge serves USDC from OP Mainnet to Solana/u);
  });

  it("refuses an input the departure also lists when no bridge moves it (testnets)", async () => {
    const devnet = ["eip155:5042002:0x4f183e308f24c81c05303821AD025812fBFd807D", "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"] as AccountId[];
    const error = await refusal(depart(`send 1 USDC to ${OTHER_SOL_ADDRESS}`, "arc", reader(), devnet));
    assert.equal(error.code, "SOURCE_UNREACHABLE");
    assert.match(error.message, /No bridge serves USDC from Arc Testnet to Solana Devnet/u);
  });

  it("auto keeps the action's own network when it covers the amount", async () => {
    const out = await depart("swap 1 USDC to SOL", "auto");
    assert.equal(shape(out.actions), "swap@solana:1");
    assert.deepEqual(out.departure, { network: "solana", chosen: "auto", reason: "Solana holds 2.00 USDC" });
  });

  it("auto names the sentence's network without reading anything", async () => {
    const balances = reader();
    const out = await depart("swap 1 USDC to SOL on solana", "auto", balances);
    assert.deepEqual(out.departure, { network: "solana", chosen: "text" });
    assert.equal(balances.calls.length, 0);
  });

  it("auto never treats an unknown balance as zero", async () => {
    const own = await depart("swap 10 USDC to SOL", "auto", reader({ solana: { USDC: null }, base: { USDC: "500" } }));
    assert.equal(shape(own.actions), "swap@solana:10");
    assert.match(own.departure?.reason ?? "", /could not be read/u);
    const others = await depart("swap 10 USDC to SOL", "auto", reader({ solana: { USDC: "1" }, base: { USDC: null }, arbitrum: { USDC: null } }));
    assert.equal(shape(others.actions), "swap@solana:10", "nothing is chosen on unknown balances");
    assert.match(others.departure?.reason ?? "", /other balances could not be read/u);
  });

  it("auto with nobody covering the amount is SOURCE_REQUIRED with details.candidates", async () => {
    const error = await refusal(depart("swap 50 USDC to SOL", "auto", reader({ solana: { USDC: "1" }, base: { USDC: "4" }, arbitrum: { USDC: "3" } })));
    assert.equal(error.code, "SOURCE_REQUIRED");
    const candidates = (error.details as { candidates: unknown[] }).candidates;
    assert.deepEqual(candidates, [
      { network: "solana", balance: "1", enough: false },
      { network: "base", balance: "4", enough: false },
      { network: "arbitrum", balance: "3", enough: false },
    ]);
  });

  it("reads at most five balances", async () => {
    // Scripted bridges serving all six mainnet networks: five candidates for Solana, own + four for a swap there.
    resetVenueEngine({ bridges: true });
    const empty = reader({});
    await refusal(pickFundedSource({ asset: "USDC", amount: "5", toNetwork: "solana" }, accounts, request("bridge 5 USDC to solana", "auto"), empty.read));
    assert.deepEqual(empty.calls.map((call) => call.network), ["base", "arbitrum", "ethereum", "optimism", "polygon"]);
    const swap = reader({});
    await refusal(depart("swap 10 USDC to SOL", "auto", swap));
    assert.equal(swap.calls.length, 5);
    assert.equal(swap.calls[0]?.network, "solana", "the action's own network first");
  });

  it("never reads preview accounts: auto behaves as absent, and a bridge without a source asks", async () => {
    const preview = [...PREVIEW_ACCOUNT_IDS];
    const balances = reader();
    const out = await depart("swap 10 USDC to SOL", "auto", balances, preview);
    assert.equal(shape(out.actions), "swap@solana:10");
    assert.equal(out.departure, undefined);
    const error = await refusal(pickFundedSource({ asset: "USDC", amount: "25", toNetwork: "solana" }, preview, request("bridge 25 USDC to solana", "auto", preview), balances.read));
    assert.equal(error.code, "SOURCE_REQUIRED");
    assert.deepEqual((error.details as { candidates: unknown[] }).candidates, []);
    assert.equal(balances.calls.length, 0);
  });
});

describe("departure: planner wiring", () => {
  const read = () => reader().read;

  it("plans the prepended bridge and records interpretation.departure", async () => {
    const graph = await planIntent({ text: "deposit 10 USDC into aave on arbitrum", accounts, sourceNetwork: "base" }, { readBalance: read() });
    assert.deepEqual(graph.interpretation.departure, { network: "arbitrum", chosen: "text" }, "the sentence names Arbitrum One");
    const bridged = await planIntent({ text: "swap 10 USDC to SOL", accounts, sourceNetwork: "base" }, { readBalance: read() });
    assert.deepEqual(bridged.steps.map((step) => `${step.kind}/${step.protocol}@${step.network}`), ["bridge/relay@base"], "bridge + swap merge into one Relay cross-network swap");
    assert.equal(bridged.steps[0]?.minimumOutput?.symbol, "SOL");
    assert.equal(bridged.interpretation.departure?.bridged, true);
    assert.equal(bridged.request.sourceNetwork, "base");
  });

  it("auto plans a bridge without a source from the funded network", async () => {
    const graph = await planIntent({ text: "bridge 25 USDC to solana", accounts, sourceNetwork: "auto" }, { readBalance: read() });
    assert.deepEqual(graph.steps.map((step) => `${step.kind}@${step.network}`), ["bridge@base"]);
    assert.equal(graph.interpretation.departure?.chosen, "auto");
  });

  it("without sourceNetwork the grammar's MissingSourceError surfaces unchanged", async () => {
    const error = await refusal(planIntent({ text: "bridge 25 USDC to solana", accounts }));
    assert.ok(error instanceof MissingSourceError);
    assert.equal(error.code, "INTENT_UNSUPPORTED");
  });

  it("a same-network departure gives steps identical to no departure", async () => {
    const text = "deposit 100 USDC into aave on base";
    const plain = await planIntent({ text, accounts }, { now: 1_800_000_000_000, id: "int_00000000000000000000000000000001" });
    const departed = await planIntent({ text, accounts, sourceNetwork: "base" }, { now: 1_800_000_000_000, id: "int_00000000000000000000000000000001", readBalance: read() });
    const strip = (steps: typeof plain.steps) => steps.map(({ quoteRef: _quoteRef, ...rest }) => rest);
    assert.deepEqual(strip(departed.steps), strip(plain.steps));
    assert.equal(plain.interpretation.departure, undefined);
    assert.deepEqual(departed.interpretation.departure, { network: "base", chosen: "request" });
  });

  it("keeps a departure clarify supplied and ignores sourceNetwork then (never applied twice)", async () => {
    const balances = reader();
    const graph = await planIntent(
      { text: "bridge 10 USDC from base to solana then swap it to SOL", accounts, sourceNetwork: "arbitrum" },
      {
        readBalance: balances.read,
        interpretation: {
          departure: { network: "base", chosen: "request", bridged: true },
          assumptions: [{ field: "actions[0].network", label: "On Base", source: "default", material: true }],
          thread: { id: "thr_test", rev: 2 },
        },
      },
    );
    assert.deepEqual(graph.interpretation.departure, { network: "base", chosen: "request", bridged: true });
    assert.equal(graph.interpretation.thread?.rev, 2);
    assert.equal(graph.interpretation.assumptions?.length, 1);
    assert.equal(graph.steps[0]?.network, "base", "no second bridge from Arbitrum One");
    assert.ok(!graph.warnings.some((warning) => warning.includes("Arbitrum One")));
    assert.equal(balances.calls.length, 0);
  });

  it("turns a third-party transfer elsewhere into one bridge leg that pays the recipient", async () => {
    const graph = await planIntent({ text: `send 5 USDC to ${OTHER_SOL_ADDRESS}`, accounts, sourceNetwork: "base" }, { readBalance: read() });
    assert.equal(graph.steps.length, 1);
    const [leg] = graph.steps;
    assert.equal(leg?.kind, "bridge");
    assert.equal(leg?.network, "base");
    assert.equal(leg?.input?.amount, "5000000", "the exact stated input leaves Base");
    assert.equal(leg?.recipient, `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:${OTHER_SOL_ADDRESS}`);
    assert.ok(leg?.minimumOutput, "the arriving minimum is shown");
    assert.ok(graph.warnings.some((warning) => warning.includes("recipient receives what arrives")));
    assert.notEqual(SOL_ADDRESS, OTHER_SOL_ADDRESS);
    assert.ok(EVM_ADDRESS);
  });
});
