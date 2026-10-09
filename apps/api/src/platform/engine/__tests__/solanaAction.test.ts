/**
 * Solana Action steps end to end against mocked RPC and a canned action
 * server: plan (fetch, rules, simulation, review), prepare (fresh fetch,
 * re-blockhash, instruction digest), submit / verify (instruction binding
 * with wallet-added compute budget and Lighthouse, deltas, owner and CPI
 * checks), simulated-effect refusals, program pin changes, and the dry-run
 * test of the live Jupiter blink fixture.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import { getBase58Decoder, getCompiledTransactionMessageDecoder, getTransactionDecoder } from "@solana/kit";
import { CONTRACT_REVIEW_NOTICE, type IntentGraph, type SolanaTransactionRequest } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { testContractAction } from "../contracts/review.js";
import { configurePlatform, createIntent, prepareStep, submitStep } from "../service.js";
import { MemoryIntentStore } from "../store.js";
import { randomSolanaSignature, STUB_ADAPTERS } from "./helpers.js";
import { installDirectory, installRpcRouter, OWNER_KEY, registrationOf, type MemoryDirectory, type Registration, type RpcRouter } from "./contractHarness.js";
import {
  ACME_PROGRAM,
  buildTransaction,
  CannedTransport,
  installSolanaAccounts,
  ix,
  JUP6,
  NOOP,
  programImages,
  randomAddress,
  SOL_OTHER,
  SOL_USER,
  TOKEN,
  tokenAccountImage,
  USDC_MINT,
  walletImage,
  type AccountImage,
} from "./solanaActionHarness.js";

const fixtures = JSON.parse(readFileSync(new URL("./contractFixtures.json", import.meta.url), "utf8")) as {
  jupiterBlink: { transaction: string };
  jupiterLookupTables: { tables: string[]; value: unknown[] };
  jupiterSimulationText: string;
};

const ACCOUNT = `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:${SOL_USER}`;
const ST_MINT = "G4TVyDdRUKZPVdoDdp3orG2djZTZVZq8uQz3vvpK3tZY";
const USER_USDC = randomAddress();
const USER_ST = randomAddress();
const POOL = randomAddress();

let router: RpcRouter;
let directory: MemoryDirectory;
let registration: Registration;
let accounts: Map<string, AccountImage>;
let transport: CannedTransport;
/** Post-simulation images by address (defaults to the pre images). */
let post: Map<string, AccountImage | null>;
let simulation: { err: unknown; logs: string[]; out: bigint; debit: bigint; postOwner: string; inner: unknown[] } ;
let programDataAddress: string;

function mintImage(decimals: number): AccountImage {
  const data = Buffer.alloc(82);
  data[44] = decimals;
  data[45] = 1;
  return { owner: TOKEN, lamports: 1_461_600n, data };
}

function actionDefinition(): Record<string, unknown> {
  return {
    vm: "svm",
    network: "solana",
    integrator: { name: "Acme Stake", website: "https://acme.example" },
    origin: "https://actions.acme.example",
    programs: [ACME_PROGRAM],
    actions: [{
      id: "stake",
      label: "Stake USDC with Acme",
      href: "https://actions.acme.example/api/stake?amount={amount}",
      primaryProgram: ACME_PROGRAM,
      input: { token: "USDC" },
      output: { mint: ST_MINT, toleranceBps: 50 },
      phrases: { verbs: ["stake"], aliases: ["acme stake"] },
      limits: { maxAmount: "10000" },
    }],
  };
}

function actionTransaction(data = Buffer.from([7])): string {
  const instruction = ix.program(ACME_PROGRAM, [USER_USDC, USER_ST, POOL], data);
  return buildTransaction(SOL_USER, [ix.computeUnits(200_000), ix.computePrice(1_000n), { ...instruction, accounts: [...(instruction.accounts ?? []), { address: TOKEN }] }]);
}

function staticKeys(base64: string): string[] {
  const message = getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(Buffer.from(base64, "base64")).messageBytes);
  return message.staticAccounts.map(String);
}

function tokenBalance(keys: string[], account: string, mint: string, owner: string, amount: bigint) {
  return { accountIndex: keys.indexOf(account), mint, owner, programId: TOKEN, uiTokenAmount: { amount: amount.toString(), decimals: 6, uiAmount: null, uiAmountString: amount.toString() } };
}

function installSimulation(): void {
  router.handlers.set("simulateTransaction", ([base64, config]) => {
    const keys = staticKeys(String(base64));
    const requested = ((config as { accounts?: { addresses?: string[] } }).accounts?.addresses) ?? [];
    return {
      context: { slot: 400_000_001 },
      value: {
        err: simulation.err,
        logs: simulation.logs,
        fee: 5_200,
        unitsConsumed: 40_000,
        preBalances: keys.map((key) => (key === SOL_USER ? 1_000_000_000 : 0)),
        postBalances: keys.map((key) => (key === SOL_USER ? 1_000_000_000 - 5_200 : 0)),
        preTokenBalances: [tokenBalance(keys, USER_USDC, USDC_MINT, SOL_USER, 100_000_000n)],
        postTokenBalances: [
          tokenBalance(keys, USER_USDC, USDC_MINT, simulation.postOwner, 100_000_000n - simulation.debit),
          tokenBalance(keys, USER_ST, ST_MINT, SOL_USER, simulation.out),
        ],
        innerInstructions: simulation.inner,
        loadedAddresses: { writable: [], readonly: [] },
        accounts: requested.map((address) => {
          const image = post.has(address) ? post.get(address) : accounts.get(address);
          return image ? { data: [Buffer.from(image.data).toString("base64"), "base64"], executable: false, lamports: Number(image.lamports), owner: image.owner, rentEpoch: 0, space: image.data.length } : null;
        }),
      },
    };
  });
}

async function register(): Promise<void> {
  registration = directory.add(await registrationOf(actionDefinition(), {
    id: "ct_00000000000000000000a5a5",
    pins: [{ program: ACME_PROGRAM, loader: "BPFLoaderUpgradeab1e11111111111111111111111", programData: programDataAddress, lastDeploySlot: "400000000", upgradeAuthority: SOL_OTHER }],
    verification: { domain: { verified: true, checkedAt: null }, programs: [{ program: ACME_PROGRAM, verified: true, provider: "ottersec", checkedAt: null }] },
  }));
}

function planAction(amount = "1"): Promise<IntentGraph> {
  return createIntent({ accounts: [ACCOUNT], actions: [{ kind: "action", network: "solana", contract: registration.id, entry: "stake", amount }] }, { ownerKeyId: OWNER_KEY });
}

function rejects(code: string, pattern?: RegExp) {
  return (error: unknown) => {
    assert.ok(error instanceof PlatformError, String(error));
    assert.equal(error.code, code, error.message);
    if (pattern) assert.match(error.message, pattern);
    return true;
  };
}

/** Registers a landed transaction (json getTransaction body) built from a wire transaction. */
function land(base64: string, options: { extra?: "compute" | "lighthouse"; owner?: string; inner?: unknown[]; credit?: bigint; debit?: bigint } = {}): string {
  const message = getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(Buffer.from(base64, "base64")).messageBytes) as unknown as {
    staticAccounts: string[];
    instructions: { programAddressIndex: number; accountIndices?: number[]; data?: Uint8Array }[];
  };
  const keys = message.staticAccounts.map(String);
  const base58 = getBase58Decoder();
  const instructions = message.instructions.map((instruction) => ({
    programIdIndex: instruction.programAddressIndex,
    accounts: [...(instruction.accountIndices ?? [])],
    data: base58.decode(Uint8Array.from(instruction.data ?? [])),
    stackHeight: null,
  }));
  if (options.extra === "compute") instructions.unshift({ programIdIndex: keys.indexOf("ComputeBudget111111111111111111111111111111"), accounts: [], data: base58.decode(Uint8Array.from([3, 9, 0, 0, 0, 0, 0, 0, 0])), stackHeight: null });
  const signature = randomSolanaSignature();
  const debit = options.debit ?? 1_000_000n;
  const body = {
    slot: 400_000_100,
    blockTime: Math.floor(Date.now() / 1000) + 5,
    version: 0,
    meta: {
      err: null,
      status: { Ok: null },
      fee: 5_200,
      preBalances: keys.map((key) => (key === SOL_USER ? 1_000_000_000 : 0)),
      postBalances: keys.map((key) => (key === SOL_USER ? 1_000_000_000 - 5_200 : 0)),
      preTokenBalances: [tokenBalance(keys, USER_USDC, USDC_MINT, SOL_USER, 100_000_000n)],
      postTokenBalances: [
        tokenBalance(keys, USER_USDC, USDC_MINT, options.owner ?? SOL_USER, 100_000_000n - debit),
        tokenBalance(keys, USER_ST, ST_MINT, SOL_USER, options.credit ?? 950_000n),
      ],
      innerInstructions: options.inner ?? [],
      loadedAddresses: { writable: [], readonly: [] },
      logMessages: [],
      rewards: [],
      computeUnitsConsumed: 40_000,
    },
    transaction: {
      signatures: [signature],
      message: {
        accountKeys: keys,
        header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 2 },
        recentBlockhash: "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi",
        instructions,
      },
    },
  };
  landed.set(signature, body);
  return signature;
}

const landed = new Map<string, unknown>();

beforeEach(async () => {
  router = installRpcRouter();
  directory = installDirectory();
  configurePlatform({ store: new MemoryIntentStore(), adapters: STUB_ADAPTERS, contracts: directory });
  const images = programImages(ACME_PROGRAM, 400_000_000n, SOL_OTHER);
  programDataAddress = images.programDataAddress;
  accounts = new Map<string, AccountImage>([
    [ACME_PROGRAM, images.program],
    [programDataAddress, images.programData],
    [SOL_USER, walletImage(1_000_000_000n)],
    [USER_USDC, tokenAccountImage(USDC_MINT, SOL_USER, 100_000_000n)],
    [ST_MINT, mintImage(6)],
  ]);
  post = new Map();
  simulation = { err: null, logs: ["Program log: ok"], out: 950_000n, debit: 1_000_000n, postOwner: SOL_USER, inner: [] };
  installSolanaAccounts(router, accounts);
  installSimulation();
  landed.clear();
  router.handlers.set("getSignatureStatuses", ([signatures]) => ({
    context: { slot: 400_000_200 },
    value: (signatures as string[]).map((signature) => (landed.has(signature) ? { slot: 400_000_100, confirmations: null, err: null, status: { Ok: null }, confirmationStatus: "finalized" } : null)),
  }));
  router.handlers.set("getTransaction", ([signature]) => landed.get(String(signature)) ?? null);
  transport = new CannedTransport((method) => (method === "post" ? { json: { type: "transaction", transaction: actionTransaction() } } : { json: { title: "Stake", label: "Stake" } }));
  directory.actionTransport = transport;
  await register();
});

afterEach(() => {
  router.restore();
  configurePlatform({ contracts: null });
});

describe("Solana Action steps: plan and prepare", () => {
  it("plans an action step from the server's transaction and its simulation", async () => {
    const graph = await planAction();
    const step = graph.steps[0]!;
    assert.equal(step.kind, "action");
    assert.equal(step.protocol, "solana-actions");
    assert.equal(step.input?.amount, "1000000");
    assert.equal(step.expectedOutput?.amount, "950000");
    assert.equal(step.minimumOutput?.amount, String((950_000n * 9_950n) / 10_000n));
    assert.equal(transport.requests[0]?.url, "https://actions.acme.example/api/stake?amount=1");
    assert.deepEqual(transport.requests[0]?.body, { account: SOL_USER });
    const review = step.call!.review;
    assert.equal(review.kind, "solana-action");
    assert.equal(review.notices[0], CONTRACT_REVIEW_NOTICE);
    assert.ok(review.notices.some((notice) => /sent your address to actions\.acme\.example/u.test(notice)));
    assert.deepEqual(review.action?.programs, [{ id: ACME_PROGRAM, verified: true, upgradeable: true, upgradeAuthority: SOL_OTHER }]);
    assert.deepEqual(review.simulation.assetChanges.map((change) => [change.symbol, change.delta]), [["USDC", "-1000000"], [`${ST_MINT.slice(0, 4)}…${ST_MINT.slice(-4)}`, "950000"]]);
    assert.equal(review.simulation.networkFee?.amount, "5200");
  });

  it("prepares a fresh, re-blockhashed transaction bound by its instruction digest", async () => {
    const graph = await planAction();
    const { intent, payload } = await prepareStep(graph.id, "s1");
    const transaction = payload.transactions[0] as SolanaTransactionRequest;
    assert.equal(transaction.feePayer, SOL_USER);
    assert.equal(transaction.lastValidBlockHeight, 380_000_150);
    const message = getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(Buffer.from(transaction.transaction, "base64")).messageBytes) as { lifetimeToken: string };
    assert.equal(String(message.lifetimeToken), "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi");
    assert.equal(payload.review?.kind, "solana-action");
    assert.ok(intent.steps[0]?.evidence.some((entry) => entry.reference?.startsWith("ix1:")));
    assert.equal(transport.requests.filter((request) => request.method === "post").length, 2, "prepare fetched a fresh transaction");
  });

  it("refuses simulated effects on the user's accounts", async () => {
    post.set(USER_USDC, tokenAccountImage(USDC_MINT, SOL_USER, 99_000_000n, { delegate: SOL_OTHER }));
    await assert.rejects(planAction(), rejects("ACTION_TRANSACTION_REJECTED", /delegate/u));
    post.set(USER_USDC, tokenAccountImage(USDC_MINT, SOL_USER, 99_000_000n, { closeAuthority: SOL_OTHER }));
    await assert.rejects(planAction(), rejects("ACTION_TRANSACTION_REJECTED", /close authority/u));
    post.clear();
    post.set(SOL_USER, { owner: ACME_PROGRAM, lamports: 1n, data: new Uint8Array() });
    await assert.rejects(planAction(), rejects("ACTION_TRANSACTION_REJECTED", /reassign/u));
    post.clear();
    simulation.postOwner = SOL_OTHER;
    await assert.rejects(planAction(), rejects("ACTION_TRANSACTION_REJECTED", /ownership/u));
    simulation.postOwner = SOL_USER;
    simulation.inner = [{ index: 2, instructions: [{ programId: TOKEN, program: "spl-token", parsed: { type: "approve", info: { source: USER_USDC, delegate: SOL_OTHER, owner: SOL_USER, amount: "1" } }, stackHeight: 2 }] }];
    await assert.rejects(planAction(), rejects("ACTION_TRANSACTION_REJECTED", /approves a delegate/u));
    simulation.inner = [];
    simulation.debit = 2_000_000n;
    await assert.rejects(planAction(), rejects("SIMULATION_ASSET_CHANGE_REFUSED", /not exactly -1000000/u));
    simulation.debit = 1_000_000n;
    simulation.err = { InstructionError: [2, { Custom: 6001 }] };
    simulation.logs = ["Program log: Error: SlippageExceeded"];
    await assert.rejects(planAction(), rejects("SIMULATION_FAILED", /SlippageExceeded/u));
  });

  it("warns at plan and refuses at prepare when Solana cannot simulate", async () => {
    const graph = await planAction();
    router.handlers.set("simulateTransaction", () => {
      throw new Error("node down");
    });
    await assert.rejects(prepareStep(graph.id, "s1"), rejects("SIMULATION_UNAVAILABLE"));
    const unsimulated = await planAction();
    assert.equal(unsimulated.steps[0]?.call?.review.simulation.status, "unavailable");
    assert.equal(unsimulated.steps[0]?.expectedOutput, undefined);
  });

  it("refuses a redeployed program and suspends the registration", async () => {
    const graph = await planAction();
    accounts.set(programDataAddress, programImages(ACME_PROGRAM, 400_000_999n, SOL_OTHER).programData);
    await assert.rejects(prepareStep(graph.id, "s1"), rejects("PROGRAM_CHANGED", /redeployed/u));
    assert.equal(directory.anomalies[0]?.reason, "program_changed");
    assert.equal(registration.status, "suspended");
  });

  it("refuses non-transaction responses and dead servers", async () => {
    transport.responder = () => ({ json: { type: "message", data: "sign this" } });
    await assert.rejects(planAction(), rejects("ACTION_RESPONSE_UNSUPPORTED"));
    transport.responder = () => ({ status: 503, json: {} });
    await assert.rejects(planAction(), rejects("ACTION_ENDPOINT_UNAVAILABLE"));
  });
});

describe("Solana Action steps: verify", () => {
  async function prepared(): Promise<{ graph: IntentGraph; transaction: string }> {
    const graph = await planAction();
    const { payload } = await prepareStep(graph.id, "s1");
    return { graph, transaction: (payload.transactions[0] as SolanaTransactionRequest).transaction };
  }

  it("confirms the landed transaction with a wallet-added compute-budget instruction", async () => {
    const { graph, transaction } = await prepared();
    const signature = land(transaction, { extra: "compute" });
    const step = (await submitStep(graph.id, "s1", [signature])).steps[0]!;
    assert.equal(step.status, "settled", JSON.stringify(step.failure));
    assert.equal(step.actualOutput?.amount, "950000");
  });

  it("rejects a landed transaction whose instructions differ", async () => {
    const { graph } = await prepared();
    const signature = land(actionTransaction(Buffer.from([8])));
    await assert.rejects(submitStep(graph.id, "s1", [signature]), rejects("REFERENCE_MISMATCH"));
    assert.equal(directory.anomalies.length, 0);
  });

  it("fails and suspends on an owner change or a CPI approval in the landed transaction", async () => {
    const { graph, transaction } = await prepared();
    const step = (await submitStep(graph.id, "s1", [land(transaction, { owner: SOL_OTHER })])).steps[0]!;
    assert.equal(step.failure?.code, "OUTCOME_NOT_PROVEN");
    assert.equal(directory.anomalies[0]?.reason, "outcome_mismatch");

    registration.status = "active";
    const second = await prepared();
    const keys = staticKeys(second.transaction);
    const inner = [{ index: 2, instructions: [{ programIdIndex: keys.indexOf(ACME_PROGRAM), accounts: [keys.indexOf(USER_USDC)], data: getBase58Decoder().decode(Uint8Array.from([1])), stackHeight: 2 }, { programIdIndex: keys.indexOf(TOKEN), accounts: [keys.indexOf(USER_USDC), keys.indexOf(POOL), 0], data: getBase58Decoder().decode(Uint8Array.from([4, 1, 0, 0, 0, 0, 0, 0, 0])), stackHeight: 2 }] }];
    const approved = (await submitStep(second.graph.id, "s1", [land(second.transaction, { inner })])).steps[0]!;
    assert.equal(approved.failure?.code, "OUTCOME_NOT_PROVEN");
  });

  it("fails when the output is below the guaranteed minimum", async () => {
    const { graph, transaction } = await prepared();
    const step = (await submitStep(graph.id, "s1", [land(transaction, { credit: 10n })])).steps[0]!;
    assert.equal(step.failure?.code, "OUTCOME_NOT_PROVEN");
    assert.match(step.failure?.message ?? "", /below the guaranteed/u);
  });
});

describe("Solana Action test endpoint (live Jupiter fixture)", () => {
  it("accepts the captured blink and reports the simulated USDC credit", async () => {
    const jupiter = programImages(JUP6, 454_465_850n, "CvQZZ23qYDWF2RUpxYJ8y9K4skmuvYEEjH7fK58jtipQ");
    const noop = programImages(NOOP, 154_177_312n, "F3S4PD17Eo3FyCMropzDLCpBFuQuBmufUVBBdKEHbQFT");
    accounts.set(JUP6, jupiter.program);
    accounts.set(jupiter.programDataAddress, jupiter.programData);
    accounts.set(NOOP, noop.program);
    accounts.set(noop.programDataAddress, noop.programData);
    const lookup = new Map(fixtures.jupiterLookupTables.tables.map((table, index) => [table, fixtures.jupiterLookupTables.value[index]]));
    const original = router.handlers.get("getMultipleAccounts");
    router.handlers.set("getMultipleAccounts", (params, url) => {
      const keys = params[0] as string[];
      if (keys.every((key) => lookup.has(key))) return { context: { slot: 1 }, value: keys.map((key) => lookup.get(key)) };
      return original?.(params, url);
    });
    router.handlers.delete("simulateTransaction");
    router.raw.set("simulateTransaction", () => fixtures.jupiterSimulationText);
    transport.responder = () => ({ json: { type: "transaction", transaction: fixtures.jupiterBlink.transaction } });
    const swap = await registrationOf({
      vm: "svm",
      network: "solana",
      integrator: { name: "Acme Swap", website: "https://acme.example" },
      origin: "https://jupiter.dial.to",
      programs: [JUP6, NOOP],
      actions: [{ id: "swap", label: "Swap SOL to USDC", href: "https://jupiter.dial.to/api/v0/swap/SOL-USDC/{amount}", primaryProgram: JUP6, input: { token: "native" }, output: { mint: USDC_MINT, toleranceBps: 100 }, limits: { maxAmount: "1" } }],
    }, {
      id: "ct_00000000000000000000b0b0",
      pins: [
        { program: JUP6, loader: "BPFLoaderUpgradeab1e11111111111111111111111", programData: jupiter.programDataAddress, lastDeploySlot: "454465850", upgradeAuthority: "CvQZZ23qYDWF2RUpxYJ8y9K4skmuvYEEjH7fK58jtipQ" },
        { program: NOOP, loader: "BPFLoaderUpgradeab1e11111111111111111111111", programData: noop.programDataAddress, lastDeploySlot: "154177312", upgradeAuthority: "F3S4PD17Eo3FyCMropzDLCpBFuQuBmufUVBBdKEHbQFT" },
      ],
      verification: { domain: { verified: false, checkedAt: null }, programs: [{ program: JUP6, verified: false, provider: "ottersec", checkedAt: null }] },
    });
    const result = await testContractAction(swap, { entry: "swap", account: ACCOUNT, amount: "0.01" });
    const sim = JSON.parse(fixtures.jupiterSimulationText).result.value as { preTokenBalances: { owner: string; mint: string; uiTokenAmount: { amount: string } }[]; postTokenBalances: { owner: string; mint: string; uiTokenAmount: { amount: string } }[] };
    const sum = (list: typeof sim.preTokenBalances) => list.filter((entry) => entry.owner === SOL_USER && entry.mint === USDC_MINT).reduce((total, entry) => total + BigInt(entry.uiTokenAmount.amount), 0n);
    assert.equal(result.expectedOutput?.amount, String(sum(sim.postTokenBalances) - sum(sim.preTokenBalances)));
    assert.equal(result.input?.amount, "10000000");
    assert.deepEqual(result.transactions[0]?.programs, ["ComputeBudget111111111111111111111111111111", "11111111111111111111111111111111", TOKEN, JUP6, NOOP]);
    assert.equal(result.review.simulation.status, "ok");
    assert.ok(result.review.notices.some((notice) => /JUP6Lk…TaV4 source is not verified/u.test(notice)));
    assert.equal(transport.requests.at(-1)?.url, "https://jupiter.dial.to/api/v0/swap/SOL-USDC/0.01");
  });
});
