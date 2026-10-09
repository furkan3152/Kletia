/**
 * Step previews from simulations (asset-preview design §5.2-5.5): the live
 * Relay probe decoded (approve 100 USDC to the depository, 100 USDC moved,
 * balance after 0, OP-stack L1 fee read in the block), reverts, Polygon's
 * system log, traced native value, Arbitrum's NodeInterface L1 component,
 * Solana balances with a created token account (refundable rent) and a fee
 * that includes the priority fee, and dependent Solana steps staying quoted.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { encodeAbiParameters, pad, toHex, type Hex } from "viem";
import { CHAINS, type IntentGraph, type IntentStep, type TransactionRequest } from "@kletia/core";
import { planIntentWithPreviews } from "../planner.js";
import { configurePlatform } from "../service.js";
import { buildEvmJobs, type StepTransactions } from "../preview/jobs.js";
import { previewIntent, previewPreparedStep, rememberPlannedPreviews } from "../preview/index.js";
import type { SimulatedJob } from "../preview/simulate.js";
import { evmStepPreview, type StepBuildContext } from "../preview/steps.js";
import { ACCOUNTS, JUPITER_PROGRAM, SOL_ADDRESS, STUB_ADAPTERS, unsignedSolanaTransaction } from "./helpers.js";
import { ACCOUNT_BASE, FRIEND, fund, installPreviewChain, resetPreviewEngine, USDC, USER, type PreviewChain } from "./previewHarness.js";

const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const APPROVAL = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";
const DEPOSITORY = "0x4cd00e387622c35bddb9b4c962c136462338bc31";
/** The synthetic, never-funded account of the 2026-10-09 probe (probes/sim-relay-base.out). */
const PROBE_USER = "0x5eed00000000000000000000000000000000c0de";
const word = (value: bigint) => pad(toHex(value));
const topic = (address: string) => pad(address.toLowerCase() as Hex);

let chain: PreviewChain;

beforeEach(() => {
  chain = installPreviewChain();
  resetPreviewEngine();
});

afterEach(() => chain.restore());

/** A bridge step planned for the probe account, and its one-block job. */
async function relayJob() {
  const { graph, previews } = await planIntentWithPreviews({
    actions: [{ kind: "bridge", network: "base", toNetwork: "arbitrum", from: "USDC", to: "USDC", amount: "100" }],
    accounts: [`eip155:8453:${PROBE_USER}`],
  });
  const sources = new Map<string, StepTransactions>([["s1", { stepId: "s1", transactions: previews.get("s1")?.transactions ?? [], origin: "planned", approvalSpender: DEPOSITORY }]]);
  const job = buildEvmJobs(graph, sources, "plan")[0];
  assert.ok(job);
  return { graph, job, source: sources.get("s1") as StepTransactions };
}

/** Call results in the order the block plan put them, from the probe's numbers. */
function probeResults(job: NonNullable<Awaited<ReturnType<typeof relayJob>>["job"]>, options: { revert?: boolean; extraLogs?: { address: string; topics: string[]; data: string }[] } = {}) {
  const block = job.blocks[0];
  assert.ok(block);
  const results = block.calls.map(() => ({ status: "success" as "success" | "reverted", returnData: "0x", gasUsed: 30_990n, logs: [] as { address: string; topics: string[]; data: string }[] }));
  const set = (at: number | undefined, value: Partial<(typeof results)[number]>) => {
    if (at !== undefined) results[at] = { ...(results[at] as (typeof results)[number]), ...value };
  };
  set(block.index.before[0]?.at, { returnData: word(100_000_000n) });
  set(block.index.transactions[0], { returnData: word(1n), gasUsed: 55_437n, logs: [{ address: USDC.base.toLowerCase(), topics: [APPROVAL, topic(PROBE_USER), topic(DEPOSITORY)], data: word(100_000_000n) }] });
  set(block.index.transactions[1], options.revert
    ? { status: "reverted" as const, gasUsed: 50_000n, returnData: `0x08c379a0${encodeAbiParameters([{ type: "string" }], ["ERC20: transfer amount exceeds balance"]).slice(2)}` }
    : {
        gasUsed: 48_770n,
        logs: [
          { address: USDC.base.toLowerCase(), topics: [TRANSFER, topic(PROBE_USER), topic(DEPOSITORY)], data: word(100_000_000n) },
          { address: DEPOSITORY, topics: ["0x49fed1d0" + "0".repeat(56)], data: "0x" },
          ...(options.extraLogs ?? []),
        ],
      });
  set(block.index.after[0]?.at, { returnData: word(0n) });
  set(block.index.allowances[0]?.at, { returnData: word(0n) });
  for (const at of block.index.l1Fees) set(at, { returnData: word(541_007_203n) });
  return results.map((result) => ({ ...result, ...(result.status === "reverted" ? { error: "execution reverted: ERC20: transfer amount exceeds balance" } : {}) }));
}

function simulated(job: Awaited<ReturnType<typeof relayJob>>["job"], calls: ReturnType<typeof probeResults>): Extract<SimulatedJob, { status: "ok" }> {
  return {
    status: "ok",
    job,
    block: 52_381_201n,
    endpoint: "base-rpc.publicnode.com",
    blocks: [{ plan: job.blocks[0] as never, calls: calls as never, overridden: null, overrideMissing: false }],
    gasPrice: 6_000_000n,
    arbitrumL1: new Map(),
    at: Date.parse("2026-10-09T13:40:12.418Z"),
  };
}

function context(graph: IntentGraph, source: StepTransactions, stage: StepBuildContext["stage"] = "plan"): StepBuildContext {
  return { graph, step: graph.steps[0] as IntentStep, stage, now: Date.now(), source, built: new Map(), nativeBalances: new Map() };
}

describe("EVM step previews", () => {
  it("decodes the live Relay probe: exact approval with nothing left, 100 USDC out, gas and L1 fee, venue-minimum credit", async () => {
    const { graph, job, source } = await relayJob();
    const built = await evmStepPreview(context(graph, source), simulated(job, probeResults(job)), simulated(job, probeResults(job)).blocks[0] as never);
    const preview = built.preview;
    assert.equal(preview.status, "simulated");
    assert.equal(preview.block, "52381201");
    assert.deepEqual(built.violations, []);
    const usdc = preview.deltas.find((row) => row.network === "base" && row.symbol === "USDC");
    assert.deepEqual([usdc?.expected.amount, usdc?.certainty], ["-100000000", "simulated"]);
    const gas = (55_437n + 48_770n) * 6_000_000n;
    const l1 = 2n * 541_007_203n;
    assert.equal(preview.deltas.find((row) => row.symbol === "ETH")?.expected.amount, (-(gas + l1)).toString());
    assert.deepEqual(preview.gas, { used: "104207", price: "6000000", l1Fee: l1.toString() });
    assert.deepEqual(preview.approvals.map((approval) => [approval.spender, approval.amount, approval.leftAfter, approval.spenderLabel]), [[DEPOSITORY, "100000000", "0", "Relay depository"]]);
    const credit = preview.deltas.find((row) => row.network === "arbitrum");
    assert.deepEqual([credit?.certainty, credit?.expected.amount, credit?.worst.amount], ["venue-minimum", graph.steps[0]?.expectedOutput?.amount, graph.steps[0]?.minimumOutput?.amount]);
    assert.deepEqual(preview.fees.filter((fee) => fee.amount).map((fee) => [fee.kind, fee.paid, fee.amount]), [["network", "on-top", gas.toString()], ["l1-data", "on-top", l1.toString()]]);
  });

  it("labels a reverted payload failed, keeps quoted numbers and warns at plan (refuses at prepare)", async () => {
    const { graph, job, source } = await relayJob();
    const run = simulated(job, probeResults(job, { revert: true }));
    const plan = await evmStepPreview(context(graph, source), run, run.blocks[0] as never);
    assert.equal(plan.preview.status, "failed");
    assert.deepEqual(plan.preview.issues.map((entry) => `${entry.code}:${entry.severity}`), ["SIMULATION_FAILED:warn"]);
    assert.match(plan.preview.issues[0]?.message ?? "", /exceeds balance/u);
    assert.ok(plan.preview.deltas.every((row) => row.certainty !== "simulated"));
    const prepare = await evmStepPreview(context(graph, source, "prepare"), run, run.blocks[0] as never);
    assert.equal(prepare.preview.issues[0]?.severity, "block");
    assert.equal(prepare.violations[0]?.rule, "I1");
  });

  it("never asks a withdraw's wallet to hold the input (it comes out of the position)", async () => {
    const { graph: planned, source } = await relayJob();
    const withdraw: IntentStep = { ...(planned.steps[0] as IntentStep), kind: "withdraw", settlement: { kind: "same-network" } };
    const graph: IntentGraph = { ...planned, steps: [withdraw] };
    const job = buildEvmJobs(graph, new Map([["s1", source]]), "prepare")[0];
    assert.ok(job);
    const block = job.blocks[0];
    assert.ok(block);
    // The wallet holds none of the underlying before the step (the position does).
    const results = block.calls.map(() => ({ status: "success" as const, returnData: word(0n), gasUsed: 30_000n, logs: [] as { address: string; topics: string[]; data: string }[] }));
    const run: Extract<SimulatedJob, { status: "ok" }> = { status: "ok", job, block: 1n, endpoint: "test", blocks: [{ plan: block, calls: results as never, overridden: null, overrideMissing: false }], gasPrice: 1n, arbitrumL1: new Map(), at: Date.now() };
    const built = await evmStepPreview({ ...context(graph, source, "prepare"), step: withdraw }, run, run.blocks[0] as never);
    assert.equal(built.violations.some((violation) => violation.rule === "I6"), false);
    assert.equal(built.needs.length, 0);
  });

  it("ignores Polygon's 0x…1010 system logs", async () => {
    const { graph, job, source } = await relayJob();
    const system = { address: "0x0000000000000000000000000000000000001010", topics: [TRANSFER, topic(PROBE_USER), topic(DEPOSITORY)], data: word(5n) };
    const run = simulated(job, probeResults(job, { extraLogs: [system] }));
    const built = await evmStepPreview(context(graph, source), run, run.blocks[0] as never);
    assert.deepEqual(built.violations, []);
    assert.equal(built.preview.deltas.length, 3);
  });

  it("reads native value from traced transfers and pays the recipient", async () => {
    chain.world.native.set(USER.toLowerCase(), 10n ** 16n);
    const { graph, previews } = await planIntentWithPreviews({
      actions: [{ kind: "transfer", network: "base", from: "ETH", amount: "0.001", recipient: FRIEND }],
      accounts: [ACCOUNT_BASE],
    });
    rememberPlannedPreviews(graph.id, previews);
    const result = await previewIntent(graph, { stage: "plan" });
    const eth = result.rows.find((row) => row.symbol === "ETH");
    const gas = 21_000n * 6_000_000n + 1_363_490_454n;
    assert.equal(eth?.expected.amount, (-(10n ** 15n) - gas).toString());
    assert.deepEqual(result.payments.map((payment) => [payment.symbol, payment.expected.amount]), [["ETH", (10n ** 15n).toString()]]);
  });

  it("adds Arbitrum's L1 component from NodeInterface (read beside the simulation)", async () => {
    fund(chain.world, USDC.arbitrum, USER, 10_000_000n);
    chain.world.native.set(USER.toLowerCase(), 10n ** 16n);
    const { graph, previews } = await planIntentWithPreviews({
      actions: [{ kind: "transfer", network: "arbitrum", from: "USDC", amount: "1", recipient: FRIEND }],
      accounts: [`eip155:42161:${USER}`],
    });
    rememberPlannedPreviews(graph.id, previews);
    const preview = await previewIntent(graph, { stage: "plan" });
    const l1 = preview.fees.find((fee) => fee.kind === "l1-data");
    assert.equal(l1?.amount, (800n * 20_000_000n).toString());
    assert.ok(chain.router.calls.some((call) => call.method === "eth_call" && String((call.params[0] as { to?: string }).to).toLowerCase() === "0x00000000000000000000000000000000000000c8"));
  });
});

describe("Solana step previews", () => {
  const USDC_SOL = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const ATA = "Bm7q1ZJx7Pj6g9u7Wq2QH4dQCPS5uuFQS5RtcpBMx5BA";

  it("reads balances, the fee (priority included) and a created token account's refundable rent; sends no override field", async () => {
    configurePlatform({ adapters: STUB_ADAPTERS });
    const graph = (await planIntentWithPreviews({ text: "swap 1 SOL to USDC", accounts: ACCOUNTS })).graph;
    const step = { ...(graph.steps[0] as IntentStep), status: "awaiting_signature" as const };
    const minimum = BigInt(step.minimumOutput?.amount ?? "0");
    const credit = BigInt(step.expectedOutput?.amount ?? "0");
    chain.world.solanaSimulation = () => ({
      context: { slot: 412_000_000 },
      value: {
        err: null,
        logs: [],
        accounts: null,
        unitsConsumed: 450,
        fee: 205_000,
        preBalances: [2_000_000_000, 1, 0],
        postBalances: [2_000_000_000 - 1_000_000_000 - 205_000 - 2_039_280, 1, 2_039_280],
        preTokenBalances: [],
        postTokenBalances: [{ accountIndex: 2, mint: USDC_SOL, owner: SOL_ADDRESS, programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", uiTokenAmount: { amount: credit.toString(), decimals: 6, uiAmount: null, uiAmountString: "" } }],
        loadedAddresses: { writable: [ATA], readonly: [] },
        innerInstructions: [],
      },
    });
    const transaction: TransactionRequest = { vm: "svm", network: "solana", feePayer: SOL_ADDRESS, transaction: unsignedSolanaTransaction(SOL_ADDRESS, JUPITER_PROGRAM), encoding: "base64", description: "swap" };
    const result = await previewPreparedStep(graph, step, { transactions: [transaction], quoteBinding: "ab".repeat(32) }, { simulate: true });
    const preview = result.step;
    assert.equal(preview.status, "simulated");
    assert.equal(preview.slot, "412000000");
    assert.deepEqual(result.violations, []);
    const sol = preview.deltas.find((row) => row.symbol === "SOL");
    assert.equal(sol?.expected.amount, (-(1_000_000_000n + 205_000n + 2_039_280n)).toString());
    const usdc = preview.deltas.find((row) => row.symbol === "USDC");
    assert.deepEqual([usdc?.expected.amount, usdc?.worst.amount], [credit.toString(), (credit < minimum ? credit : minimum).toString()]);
    assert.deepEqual(preview.fees.map((fee) => [fee.kind, fee.paid, fee.amount]), [["network", "on-top", "205000"], ["rent", "refundable", "2039280"]]);
    assert.ok(result.intent.needs.some((need) => need.reason === "rent" && need.amount === "2039280"));
    const config = (chain.world.solanaRequests[0]?.[1] ?? {}) as Record<string, unknown>;
    assert.deepEqual(Object.keys(config).sort(), ["commitment", "encoding", "innerInstructions", "replaceRecentBlockhash", "sigVerify"]);
  });

  it("counts the user's wrapped-SOL account as SOL: closing a pre-existing one nets out (live Jupiter shape)", async () => {
    configurePlatform({ adapters: STUB_ADAPTERS });
    const graph = (await planIntentWithPreviews({ text: "swap 0.05 SOL to USDC", accounts: ACCOUNTS })).graph;
    const step = { ...(graph.steps[0] as IntentStep), status: "awaiting_signature" as const };
    const WSOL_ACCOUNT = "qx84tiXFKS93Md34ENxNBNu33vPsEJ4BU1o7KYHm6pV";
    const USDC_ACCOUNT = "BmeV7UWExZeSboQXYW4biUVEx2SyYDVTdWhHoQEQcUFu";
    const POOL = "7kctoUvvP77tvLPBbTcgXQqUDSqBYRXcQZyWELWQeHxA";
    const credit = BigInt(step.minimumOutput?.amount ?? "0") + 10n;
    // Numbers of a live simulation (2026-10-09): the wallet pays 0.05 SOL and the fee, partly from a wSOL account Jupiter closes.
    chain.world.solanaSimulation = () => ({
      context: { slot: 454_942_418 },
      value: {
        err: null,
        accounts: null,
        fee: 27_211,
        preBalances: [34_599_135_270, 1, 5_723_133, 2_039_280, 202_434_408_408],
        postBalances: [34_554_831_192, 1, 0, 2_039_280, 202_484_408_408],
        preTokenBalances: [
          { accountIndex: 2, mint: "So11111111111111111111111111111111111111112", owner: SOL_ADDRESS, uiTokenAmount: { amount: "4234693", decimals: 9 } },
          { accountIndex: 3, mint: USDC_SOL, owner: SOL_ADDRESS, uiTokenAmount: { amount: "27463914", decimals: 6 } },
        ],
        postTokenBalances: [{ accountIndex: 3, mint: USDC_SOL, owner: SOL_ADDRESS, uiTokenAmount: { amount: (27_463_914n + credit).toString(), decimals: 6 } }],
        loadedAddresses: { writable: [WSOL_ACCOUNT, USDC_ACCOUNT, POOL], readonly: [] },
        innerInstructions: [],
      },
    });
    const transaction: TransactionRequest = { vm: "svm", network: "solana", feePayer: SOL_ADDRESS, transaction: unsignedSolanaTransaction(SOL_ADDRESS, JUPITER_PROGRAM), encoding: "base64", description: "swap" };
    // The wallet's balance numbers above are the live ones; the step's own wallet is the stub account.
    const result = await previewPreparedStep(graph, step, { transactions: [transaction], quoteBinding: "cd".repeat(32) }, { simulate: true });
    const sol = result.step.deltas.find((row) => row.symbol === "SOL");
    assert.equal(sol?.expected.amount, (-(50_000_000n + 27_211n)).toString(), "0.05 SOL and the fee, the closed account's reserve included");
    assert.deepEqual(result.violations, [], "the input debit is exact once wrapped SOL is counted");
    assert.equal(result.step.fees.some((fee) => fee.kind === "rent"), false);
  });

  it("shows rent of accounts a venue creates as a fee and tolerates it only up to a cap", async () => {
    configurePlatform({ adapters: STUB_ADAPTERS });
    const graph = (await planIntentWithPreviews({ text: "swap 1 SOL to USDC", accounts: ACCOUNTS })).graph;
    const step = { ...(graph.steps[0] as IntentStep), status: "awaiting_signature" as const };
    const credit = BigInt(step.expectedOutput?.amount ?? "0");
    const ORDER = "Ord1111111111111111111111111111111111111111";
    const simulate = (orderRent: number) => () => ({
      context: { slot: 1 },
      value: {
        err: null,
        fee: 5_000,
        preBalances: [3_000_000_000, 1, 0, 2_039_280],
        postBalances: [3_000_000_000 - 1_000_000_000 - 5_000 - orderRent, 1, orderRent, 2_039_280],
        preTokenBalances: [{ accountIndex: 3, mint: USDC_SOL, owner: SOL_ADDRESS, uiTokenAmount: { amount: "0", decimals: 6 } }],
        postTokenBalances: [{ accountIndex: 3, mint: USDC_SOL, owner: SOL_ADDRESS, uiTokenAmount: { amount: credit.toString(), decimals: 6 } }],
        loadedAddresses: { writable: [ORDER, ATA], readonly: [] },
        innerInstructions: [],
      },
    });
    const transaction: TransactionRequest = { vm: "svm", network: "solana", feePayer: SOL_ADDRESS, transaction: unsignedSolanaTransaction(SOL_ADDRESS, JUPITER_PROGRAM), encoding: "base64", description: "swap" };
    chain.world.solanaSimulation = simulate(5_000_000);
    const small = await previewPreparedStep(graph, step, { transactions: [transaction], quoteBinding: "ef".repeat(32) }, { simulate: true });
    assert.deepEqual(small.violations, []);
    assert.deepEqual(small.step.fees.map((fee) => [fee.kind, fee.label, fee.amount, fee.paid]), [["network", "Solana network fee", "5000", "on-top"], ["rent", "Account rent (venue accounts)", "5000000", "on-top"]]);
    chain.world.solanaSimulation = simulate(40_000_000);
    await assert.rejects(
      previewPreparedStep(graph, step, { transactions: [transaction], quoteBinding: "ef".repeat(32) }, { simulate: true }),
      (error: { code?: string }) => error.code === "SIMULATION_ASSET_CHANGE_REFUSED",
    );
  });

  it("keeps a Solana step funded by a pending bridge quoted (no Solana override exists)", async () => {
    configurePlatform({ adapters: STUB_ADAPTERS });
    const { graph } = await planIntentWithPreviews({
      actions: [
        { kind: "bridge", network: "base", toNetwork: "solana", from: "USDC", to: "USDC", amount: "100" },
        { kind: "swap", network: "solana", from: "USDC", to: "SOL", amount: "max" },
      ],
      accounts: ACCOUNTS,
      constraints: { preferProtocols: ["jupiter"] },
    });
    assert.equal(graph.steps.length, 2);
    const solanaTx: TransactionRequest = { vm: "svm", network: "solana", feePayer: SOL_ADDRESS, transaction: unsignedSolanaTransaction(SOL_ADDRESS, JUPITER_PROGRAM), encoding: "base64", description: "swap" };
    const preview = await previewIntent(graph, { stage: "plan", sources: new Map([["s2", { transactions: [solanaTx], expiresAt: Math.floor(Date.now() / 1000) + 60 }]]) });
    assert.equal(preview.steps[1]?.status, "quoted");
    assert.equal(chain.world.solanaRequests.length, 0);
    assert.equal(CHAINS.solana.vm, "svm");
  });
});
