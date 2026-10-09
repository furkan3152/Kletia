/**
 * Asset-change preview through the service (asset-preview design V2): plan
 * previews from the quotes' own transactions, network jobs with assumed
 * funds, prepare-time invariants, `acknowledgedPreview` / PREVIEW_CHANGED,
 * strict mode, refresh limits, and S8 (no overrides at prepare). Offline:
 * `previewHarness.ts` answers every RPC.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { PREVIEW_DIGEST_PATTERN, type IntentGraph, type IntentPreview } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { configurePlatform, createIntentDetailed, getIntent, prepareStep, refreshIntent, refreshIntentPreview, submitStep } from "../service.js";
import { getPreviewStore } from "../preview/index.js";
import { resetSimulationEndpoints } from "../contracts/simulationRpc.js";
import { stubEvmTransfer } from "./helpers.js";
import {
  ACCOUNT_BASE,
  calls,
  FRIEND,
  fund,
  installPreviewChain,
  RELAY_DEPOSITORY,
  resetPreviewEngine,
  STRANGER,
  USDC,
  USER,
  venue,
  type PreviewChain,
} from "./previewHarness.js";

let chain: PreviewChain;

beforeEach(() => {
  chain = installPreviewChain();
  resetPreviewEngine();
  fund(chain.world, USDC.base, USER, 250_000_000n);
  chain.world.native.set(USER.toLowerCase(), 10n ** 16n);
});

afterEach(() => {
  chain.restore();
  delete process.env.KLETIA_PREVIEW_ENFORCE;
});

const transferRequest = (amount = "100") => ({
  actions: [{ kind: "transfer" as const, network: "base" as const, from: "USDC", amount, recipient: FRIEND }],
  accounts: [ACCOUNT_BASE],
});

const bridgeThenSwap = {
  actions: [
    { kind: "bridge" as const, network: "base" as const, toNetwork: "arbitrum" as const, from: "USDC", to: "USDC", amount: "100" },
    { kind: "swap" as const, network: "arbitrum" as const, from: "USDC", to: "WETH", amount: "max" },
  ],
  accounts: [ACCOUNT_BASE],
};

/** eth_simulateV1 requests of previews (balance-slot discovery and probes do not trace transfers). */
function previewSimulations() {
  return chain.world.simulations.filter((entry) => {
    const request = chain.router.calls.find((call) => call.method === "eth_simulateV1" && (call.params[0] as { blockStateCalls: unknown[] }).blockStateCalls === entry.blocks);
    return (request?.params[0] as { traceTransfers?: boolean } | undefined)?.traceTransfers === true;
  });
}

async function created(request: unknown): Promise<{ intent: IntentGraph; preview: IntentPreview }> {
  const result = await createIntentDetailed(request, { preview: true });
  assert.ok(result.preview, "preview requested");
  return { intent: result.intent, preview: result.preview };
}

async function refusal(run: () => Promise<unknown>): Promise<PlatformError> {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof PlatformError, String(error));
    return error;
  }
  assert.fail("expected a refusal");
}

describe("plan-time preview", () => {
  it("simulates the quote's own transactions: exact debit, gas and L1 fee, payment, no extra quote", async () => {
    const { intent, preview } = await created(transferRequest());
    assert.equal(calls.plan, 1, "one quote, the plan's");
    assert.equal(calls.prepare, 0);
    assert.equal(preview.stage, "plan");
    assert.equal(preview.basis, "simulated");
    assert.match(preview.digest, PREVIEW_DIGEST_PATTERN);
    assert.equal(preview.intentId, intent.id);
    const usdc = preview.rows.find((row) => row.symbol === "USDC");
    assert.deepEqual([usdc?.expected.amount, usdc?.worst.amount, usdc?.certainty, usdc?.role], ["-100000000", "-100000000", "simulated", "you"]);
    // Gas: 45,000 gas at 0.006 gwei plus the OP-stack L1 fee read inside the block.
    const gas = 45_000n * 6_000_000n + 1_363_490_454n;
    const eth = preview.rows.find((row) => row.symbol === "ETH");
    assert.equal(eth?.expected.amount, (-gas).toString());
    assert.deepEqual(preview.payments.map((payment) => [payment.recipient, payment.expected.amount, payment.certainty]), [[`eip155:8453:${FRIEND}`, "100000000", "simulated"]]);
    assert.deepEqual(preview.fees.map((fee) => [fee.kind, fee.amount]), [["network", (45_000n * 6_000_000n).toString()], ["l1-data", "1363490454"]]);
    assert.equal(preview.totals.youPayUsd, 100);
    assert.equal(preview.totals.paidToOthersUsd.expected, 100);
    const steps = preview.steps;
    assert.equal(steps[0]?.status, "simulated");
    assert.equal(steps[0]?.endpoint, "preview-sim.test");
    assert.equal(previewSimulations().length, 1, "one request for the one network job");
    // The graph does not grow: no preview, no transactions inside it.
    assert.equal(JSON.stringify(intent).includes("preview"), false);
    assert.ok(intent.plan && /^[0-9a-f]{64}$/u.test(intent.plan.digest), "the immutable plan record is captured");
    assert.equal((await getPreviewStore().latest(intent.id))?.digest, preview.digest);
  });

  it("models a funded step on the destination with assumed funds: transit nets to zero, output estimated", async () => {
    const { preview, intent } = await created(bridgeThenSwap);
    assert.equal(intent.edges[0]?.kind, "funds");
    assert.equal(calls.plan, 2, "the auction's and the swap's quotes only: previews add none");
    const jobs = previewSimulations();
    assert.equal(jobs.length, 2, "one request per network job");
    const blocks = jobs.map((job) => job.blocks as { stateOverrides?: Record<string, unknown> }[]);
    assert.equal(blocks[0]?.[0]?.stateOverrides, undefined, "the ready bridge leg is simulated against the real wallet");
    const overrides = blocks[1]?.[0]?.stateOverrides ?? {};
    assert.deepEqual(Object.keys(overrides).map((address) => address.toLowerCase()), [USDC.arbitrum.toLowerCase()], "the funded swap assumes the bridged USDC");
    const [bridge, swap] = preview.steps;
    assert.equal(bridge?.status, "simulated");
    assert.equal(swap?.status, "simulated-assumed-funds");
    assert.deepEqual(swap?.overrides, [{ asset: intent.steps[1]?.input?.asset, amount: intent.steps[1]?.input?.amount }]);
    const transit = preview.rows.find((row) => row.network === "arbitrum" && row.symbol === "USDC");
    assert.deepEqual([transit?.role, transit?.expected.amount, transit?.worst.amount, transit?.certainty], ["transit", "0", "0", "venue-minimum"]);
    const weth = preview.rows.find((row) => row.symbol === "WETH");
    assert.equal(weth?.certainty, "estimated");
    assert.equal(weth?.worst.amount, intent.steps[1]?.minimumOutput?.amount);
    assert.ok(BigInt(weth?.expected.amount ?? "0") > BigInt(weth?.worst.amount ?? "0"), "expected scales with the bridge's expected output");
    assert.deepEqual(preview.arrival, { network: "arbitrum", seconds: 31 });
    assert.ok(preview.warnings.some((warning) => /simulated with 99\.4602 USDC that Relay delivers to you on Arbitrum One/u.test(warning)), preview.warnings.join("\n"));
    const relayer = preview.fees.find((fee) => fee.label === "Relay relayer fee");
    assert.deepEqual([relayer?.paid, relayer?.certainty], ["deducted", "quoted"]);
    assert.ok(preview.approvals.some((approval) => approval.spender === RELAY_DEPOSITORY.toLowerCase() && approval.leftAfter === "0" && approval.spenderLabel === "Relay depository"));
  });

  it("reports an unfunded ready step as a warning and a need, and gas on arrival", async () => {
    chain.world.balances.clear();
    chain.world.native.clear();
    const { preview } = await created(transferRequest());
    assert.equal(preview.steps[0]?.status, "failed");
    const codes = preview.steps[0]?.issues.map((issue) => `${issue.code}:${issue.severity}`) ?? [];
    assert.ok(codes.includes("INSUFFICIENT_BALANCE:warn"), codes.join(","));
    assert.ok(preview.needs.some((need) => need.reason === "input-balance" && need.have === "0" && need.amount === "100000000"));
    // Shown with its quoted numbers, never as simulated.
    assert.equal(preview.rows.find((row) => row.symbol === "USDC")?.certainty, "quoted");
  });

  it("never fails a plan when simulation is unavailable: steps are labelled unavailable", async () => {
    chain.world.simulateDown = true;
    resetSimulationEndpoints();
    const { preview } = await created(transferRequest());
    assert.equal(preview.basis, "unavailable");
    assert.equal(preview.steps[0]?.status, "unavailable");
    assert.ok(preview.steps[0]?.issues.some((issue) => issue.code === "PREVIEW_UNAVAILABLE"));
  });
});

describe("prepare-time preview", () => {
  it("binds the step preview to the payload and returns the intent preview", async () => {
    const { intent } = await created(transferRequest());
    const result = await prepareStep(intent.id, "s1");
    assert.equal(result.payload.preview?.quoteBinding, result.payload.quoteBinding);
    assert.equal(result.payload.preview?.status, "simulated");
    assert.equal(result.preview?.stage, "prepare");
    assert.equal(result.previewAck, undefined);
    const last = previewSimulations().at(-1)?.blocks as { stateOverrides?: unknown }[];
    assert.equal(last[0]?.stateOverrides, undefined);
  });

  it("accepts an acknowledged preview that did not get worse, and reports an unknown digest", async () => {
    const { intent, preview } = await created(transferRequest());
    const matched = await prepareStep(intent.id, "s1", { acknowledgedPreview: preview.digest });
    assert.equal(matched.previewAck, "matched");
    const unknown = await prepareStep(intent.id, "s1", { acknowledgedPreview: `sha256:${"0".repeat(64)}` });
    assert.equal(unknown.previewAck, "unknown");
  });

  it("refuses a materially worse payload with PREVIEW_CHANGED and the fresh preview, committing nothing", async () => {
    const { intent, preview } = await created({ ...bridgeThenSwap, actions: [bridgeThenSwap.actions[0]] });
    venue.bridgeOutputBps = 9_980n; // the venue now guarantees 0.2 % less
    const error = await refusal(() => prepareStep(intent.id, "s1", { acknowledgedPreview: preview.digest }));
    assert.equal(error.code, "PREVIEW_CHANGED");
    assert.equal(error.status, 409);
    const body = JSON.parse(JSON.stringify(error)) as { preview?: IntentPreview; changes?: { code: string }[]; issues?: { path: string }[] };
    assert.equal(body.preview?.stage, "prepare");
    assert.notEqual(body.preview?.digest, preview.digest);
    assert.ok(body.changes?.some((change) => change.code === "PREVIEW_WORSE_AMOUNT"));
    assert.ok(body.issues?.some((entry) => entry.path === "PREVIEW_WORSE_AMOUNT"));
    const stored = await getIntent(intent.id);
    assert.equal(stored.steps[0]?.status, "ready");
    assert.equal(stored.steps[0]?.prepared, undefined);
    // The fresh preview can be acknowledged in turn.
    const again = await prepareStep(intent.id, "s1", { acknowledgedPreview: body.preview?.digest as string });
    assert.equal(again.previewAck, "matched");
  });

  it("holds the payload to the invariants: exact debit, pinned approvals, enough balance", async () => {
    const { intent } = await created(transferRequest());
    venue.transferExtra = 1n;
    const extra = await refusal(() => prepareStep(intent.id, "s1"));
    assert.equal(extra.code, "SIMULATION_ASSET_CHANGE_REFUSED");
    assert.match(extra.message, /input debit is 100000001 base units, not exactly the step amount 100000000/u);
    venue.transferExtra = 0n;

    const bridge = await created({ ...bridgeThenSwap, actions: [bridgeThenSwap.actions[0]] });
    chain.world.depositApproves = STRANGER;
    const approval = await refusal(() => prepareStep(bridge.intent.id, "s1"));
    assert.equal(approval.code, "SIMULATION_ASSET_CHANGE_REFUSED");
    assert.match(approval.message, /approves 0x2222222222222222222222222222222222222222, which is not the pinned spender/u);
    chain.world.depositApproves = null;
    chain.world.depositExtraPull = 5n;
    const pulled = await refusal(() => prepareStep(bridge.intent.id, "s1"));
    assert.equal(pulled.code, "SIMULATION_ASSET_CHANGE_REFUSED");
    chain.world.depositExtraPull = 0n;

    fund(chain.world, USDC.base, USER, 50_000_000n);
    const short = await refusal(() => prepareStep(intent.id, "s1"));
    assert.equal(short.code, "INSUFFICIENT_BALANCE");
    assert.equal((await getIntent(intent.id)).steps[0]?.status, "ready", "nothing was committed");
  });

  it("continues unsimulated on built-in venues, refuses in strict mode", async () => {
    const { intent } = await created(transferRequest());
    chain.world.simulateDown = true;
    resetSimulationEndpoints();
    const lenient = await prepareStep(intent.id, "s1");
    assert.equal(lenient.payload.preview?.status, "unavailable");
    assert.ok(lenient.payload.preview?.issues.some((issue) => issue.code === "PREVIEW_UNAVAILABLE"));
    process.env.KLETIA_PREVIEW_ENFORCE = "strict";
    const strict = await refusal(() => prepareStep(intent.id, "s1"));
    assert.equal(strict.code, "SIMULATION_UNAVAILABLE");
    assert.equal(strict.status, 503);
  });

  it("never overrides balances at prepare (S8): a funded step is simulated against the real wallet", async () => {
    const { intent } = await created(bridgeThenSwap);
    const first = await prepareStep(intent.id, "s1");
    await submitStep(intent.id, "s1", first.payload.transactions.map((_, index) => `0x${(index + 1).toString(16).padStart(64, "0")}`));
    const settled = await refreshIntent(intent.id);
    assert.equal(settled.steps[1]?.status, "ready");
    // The bridged USDC is in the wallet now.
    fund(chain.world, USDC.arbitrum, USER, BigInt(settled.steps[0]?.actualOutput?.amount ?? "0"));
    const before = previewSimulations().length;
    const second = await prepareStep(intent.id, "s2");
    const requests = previewSimulations().slice(before);
    assert.equal(requests.length, 1);
    assert.equal((requests[0]?.blocks as { stateOverrides?: unknown }[])[0]?.stateOverrides, undefined);
    assert.equal(second.payload.preview?.status, "simulated");
    assert.equal(second.payload.preview?.overrides, undefined);
    const transit = second.preview?.rows.find((row) => row.network === "arbitrum" && row.symbol === "USDC");
    assert.equal(transit?.role, "transit");
  });

  it("does not simulate an embedder's adapter that did not opt in (quoted preview, no RPC)", async () => {
    configurePlatform({ adapters: [stubEvmTransfer] });
    const { intent, preview } = await created(transferRequest());
    assert.equal(preview.basis, "quoted");
    const result = await prepareStep(intent.id, "s1");
    assert.equal(result.payload.preview?.status, "quoted");
    assert.equal(previewSimulations().length, 0);
  });
});

describe("preview refresh", () => {
  it("re-simulates without re-quoting by default, re-quotes on request at most every 20 s", async () => {
    const { intent } = await created(transferRequest());
    assert.equal(calls.plan, 1);
    const refreshed = await refreshIntentPreview(intent.id);
    assert.equal(refreshed.stage, "refresh");
    assert.equal(refreshed.basis, "simulated");
    assert.equal(calls.plan, 1, "no provider quote for a refresh");
    const requoted = await refreshIntentPreview(intent.id, { refreshQuotes: true });
    assert.equal(calls.plan, 2);
    assert.equal(requoted.steps[0]?.status, "simulated");
    const limited = await refusal(() => refreshIntentPreview(intent.id, { refreshQuotes: true }));
    assert.equal(limited.code, "RATE_LIMITED");
    assert.equal(limited.status, 429);
  });

});
