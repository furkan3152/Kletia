/**
 * Jupiter Lend Earn adapter: the API instruction is accepted only when every
 * pinned account, the discriminator and the amount match; the engine builds
 * the transaction itself; withdraw-all redeems every share; verification
 * binds the landed instruction and proves the outcome from token deltas.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { CHAINS } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { jupiterLendAdapter } from "../adapters/jupiterLend.js";
import { assetsForShares, JUPITER_LEND_DISCRIMINATORS, resetJupiterLendCache } from "../adapters/jupiterLendClient.js";
import { isReferenceRejection } from "../adapters/verification.js";
import { decodeSolanaTransaction, readU64 } from "../chains/solana.js";
import { planIntent } from "../planner.js";
import { configurePlatform, createIntent, prepareStep } from "../service.js";
import { MemoryIntentStore } from "../store.js";
import { randomSolanaSignature } from "./helpers.js";
import {
  ATA_PROGRAM,
  ATTACKER,
  COMPUTE_BUDGET,
  ata,
  installSolanaLendMock,
  instructionData,
  JL_CLAIM,
  JL_LIQUIDITY,
  JL_LIQUIDITY_STATE,
  JL_POSITION,
  JL_PRICE,
  JL_PROGRAM,
  JL_RATE_MODEL,
  JL_RESERVES,
  JL_REWARDS,
  JL_USDC,
  JL_VAULT,
  jupiterLendPdas,
  lendingAccountData,
  OWNER,
  SYSTEM,
  TOKEN_PROGRAM,
  tokenAccountData,
  USDC,
  type SolanaLendMock,
} from "./solanaLendFixtures.js";

const ACCOUNTS = [`solana:${CHAINS.solana.reference}:${OWNER}`];
const SHARES_PER_USDC = 940_332n;

type Tamper = (accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[], data: Uint8Array) => Uint8Array | void;

let mock: SolanaLendMock;
let tamper: Tamper | null;
let rates: Record<string, unknown>;
const requests: Record<string, unknown>[] = [];

async function apiInstruction(kind: "deposit" | "withdraw" | "redeem", signer: string, amount: bigint) {
  const { lending, lendingAdmin } = await jupiterLendPdas();
  const [ownerUsdc, ownerJl] = [await ata(signer, USDC), await ata(signer, JL_USDC)];
  const keys = kind === "deposit"
    ? [signer, ownerUsdc, ownerJl, USDC, lendingAdmin, lending, JL_USDC, JL_RESERVES, JL_POSITION, JL_RATE_MODEL, JL_VAULT, JL_LIQUIDITY_STATE, JL_LIQUIDITY, JL_REWARDS, TOKEN_PROGRAM, ATA_PROGRAM, SYSTEM]
    : [signer, ownerJl, ownerUsdc, lendingAdmin, lending, USDC, JL_USDC, JL_RESERVES, JL_POSITION, JL_RATE_MODEL, JL_VAULT, JL_CLAIM, JL_LIQUIDITY_STATE, JL_LIQUIDITY, JL_REWARDS, TOKEN_PROGRAM, ATA_PROGRAM, SYSTEM];
  const accounts = keys.map((pubkey, index) => ({ pubkey, isSigner: index === 0, isWritable: index < 3 || [4, 5, 6, 7, 8].includes(index) }));
  let data = instructionData(JUPITER_LEND_DISCRIMINATORS[kind], amount);
  data = tamper?.(accounts, data) ?? data;
  return { programId: JL_PROGRAM, accounts, data: Buffer.from(data).toString("base64") };
}

async function plannedError(text: string): Promise<PlatformError> {
  try {
    await planIntent({ text, accounts: ACCOUNTS });
  } catch (error) {
    assert.ok(error instanceof PlatformError, `expected PlatformError, got ${String(error)}`);
    return error;
  }
  assert.fail(`planning "${text}" succeeded but should have failed`);
}

async function holdShares(shares: bigint): Promise<void> {
  mock.accounts.set(await ata(OWNER, JL_USDC), { owner: TOKEN_PROGRAM, data: tokenAccountData(JL_USDC, OWNER, shares) });
}

describe("Jupiter Lend adapter", () => {
  beforeEach(async () => {
    mock = installSolanaLendMock();
    configurePlatform({ store: new MemoryIntentStore(), adapters: null });
    tamper = null;
    requests.length = 0;
    rates = { convertToShares: SHARES_PER_USDC.toString(), convertToAssets: "1063454", supplyRate: "408", rewardsRate: "35", totalRate: "443", liquiditySupplyData: { withdrawable: "61552822646921" } };
    const { lending } = await jupiterLendPdas();
    mock.accounts.set(lending, { owner: JL_PROGRAM, data: lendingAccountData() });
    mock.jupiter.set("tokens", () => ({ body: [{ address: JL_USDC, assetAddress: USDC, decimals: 6, symbol: "jlUSDC", ...rates }] }));
    for (const kind of ["deposit", "withdraw", "redeem"] as const) {
      mock.jupiter.set(`${kind}-instructions`, async (body) => {
        requests.push({ kind, ...(body ?? {}) });
        const amount = BigInt(String(kind === "redeem" ? body?.shares : body?.amount));
        return { body: { instructions: [await apiInstruction(kind, String(body?.signer), amount)] } };
      });
    }
  });
  afterEach(() => mock.restore());

  it("plans a deposit whose jlToken output is priced from the on-chain exchange price", async () => {
    const graph = await planIntent({ text: "deposit 5 USDC into jupiter lend", accounts: ACCOUNTS });
    const step = graph.steps[0]!;
    assert.equal(step.protocol, "jupiter-lend");
    assert.equal(step.venue, "solana:jupiter-lend:usdc");
    assert.equal(step.input?.amount, "5000000");
    const expected = (5_000_000n * SHARES_PER_USDC) / 1_000_000n;
    assert.equal(step.expectedOutput?.asset, `${CHAINS.solana.id}/token:${JL_USDC}`);
    assert.equal(step.expectedOutput?.amount, expected.toString());
    assert.equal(step.minimumOutput?.amount, ((expected * 9_990n) / 10_000n).toString());
    assert.ok(step.warnings?.some((warning) => warning.includes("4.43% APY")));
    assert.deepEqual(requests.map((request) => [request.kind, request.amount, request.signer]), [["deposit", "5000000", OWNER]]);
    assert.deepEqual(mock.unknown, []);
  });

  it("refuses an API share price that disagrees with the on-chain exchange price", async () => {
    rates.convertToShares = "990000";
    resetJupiterLendCache();
    assert.equal((await plannedError("deposit 5 USDC into jupiter lend")).code, "VENUE_UNVERIFIED");
  });

  it("refuses a lending account the pinned program does not own or that names another mint", async () => {
    const { lending } = await jupiterLendPdas();
    mock.accounts.set(lending, { owner: ATTACKER, data: lendingAccountData() });
    assert.equal((await plannedError("deposit 5 USDC into jupiter lend")).code, "VENUE_UNVERIFIED");
    mock.accounts.set(lending, { owner: JL_PROGRAM, data: lendingAccountData({ mint: JL_USDC }) });
    assert.equal((await plannedError("deposit 5 USDC into jupiter lend")).code, "VENUE_UNVERIFIED");
  });

  it("refuses API instructions that pay another account, change the amount, add a signer or swap the action", async () => {
    const attackerJl = await ata(ATTACKER, JL_USDC);
    const tampers: [string, Tamper][] = [
      ["recipient jlToken account", (accounts) => { accounts[2]!.pubkey = attackerJl; }],
      ["source token account", (accounts) => { accounts[1]!.pubkey = attackerJl; }],
      ["amount", () => instructionData(JUPITER_LEND_DISCRIMINATORS.deposit, 5_000_001n)],
      ["discriminator", () => instructionData(JUPITER_LEND_DISCRIMINATORS.withdraw, 5_000_000n)],
      ["extra signer", (accounts) => { accounts[9]!.isSigner = true; }],
      ["liquidity program", (accounts) => { accounts[12]!.pubkey = ATTACKER; }],
      ["rewards model", (accounts) => { accounts[13]!.pubkey = ATTACKER; }],
      ["extra account", (accounts) => { accounts.push({ pubkey: ATTACKER, isSigner: false, isWritable: true }); }],
    ];
    for (const [label, change] of tampers) {
      tamper = change;
      const error = await plannedError("deposit 5 USDC into jupiter lend");
      assert.equal(error.code, "PROVIDER_TRANSACTION_REJECTED", label);
    }
  });

  it("prepares one engine-built transaction: compute budget, the account's own jlToken account, the checked instruction", async () => {
    const intent = await createIntent({ text: "deposit 5 USDC into jupiter lend", accounts: ACCOUNTS });
    const { payload } = await prepareStep(intent.id, intent.steps[0]!.id);
    assert.equal(payload.transactions.length, 1);
    const transaction = payload.transactions[0]!;
    assert.ok(transaction.vm === "svm");
    const decoded = await decodeSolanaTransaction("solana", transaction.transaction);
    assert.equal(decoded.feePayer, OWNER);
    assert.deepEqual(decoded.signers, [OWNER]);
    assert.deepEqual(decoded.instructions.map((instruction) => instruction.program), [COMPUTE_BUDGET, COMPUTE_BUDGET, ATA_PROGRAM, JL_PROGRAM]);
    const createAta = decoded.instructions[2]!;
    assert.deepEqual(createAta.accounts.slice(0, 4), [OWNER, await ata(OWNER, JL_USDC), OWNER, JL_USDC]);
    const lend = decoded.instructions[3]!;
    assert.equal(readU64(lend.data, 8), 5_000_000n);
    assert.equal(lend.accounts[2], await ata(OWNER, JL_USDC));
  });

  it("refuses to prepare a deposit whose simulation fails", async () => {
    const intent = await createIntent({ text: "deposit 5 USDC into jupiter lend", accounts: ACCOUNTS });
    mock.simulationError = { InstructionError: [3, { Custom: 1 }] };
    await assert.rejects(prepareStep(intent.id, intent.steps[0]!.id), (error: PlatformError) => error.code === "SIMULATION_FAILED");
  });

  it("withdraws everything by redeeming every share, and refuses an empty position", async () => {
    assert.equal((await plannedError("withdraw all USDC from jupiter lend")).code, "POSITION_EMPTY");
    const shares = 49_667_215_871n;
    await holdShares(shares);
    const graph = await planIntent({ text: "withdraw all USDC from jupiter lend", accounts: ACCOUNTS });
    const step = graph.steps[0]!;
    const value = assetsForShares(shares, JL_PRICE);
    assert.equal(step.input?.amount, value.toString());
    assert.equal(step.minimumOutput?.amount, (value - 1n).toString());
    assert.deepEqual(requests.map((request) => [request.kind, request.shares]), [["redeem", shares.toString()]]);
  });

  it("refuses withdrawals larger than the position or than Jupiter Lend can release now", async () => {
    await holdShares(4_701_655n);
    assert.equal((await plannedError("withdraw 6 USDC from jupiter lend")).code, "INSUFFICIENT_BALANCE");
    rates.liquiditySupplyData = { withdrawable: "1000000" };
    resetJupiterLendCache();
    assert.equal((await plannedError("withdraw 4 USDC from jupiter lend")).code, "RESERVE_UNAVAILABLE");
  });

  describe("verification", () => {
    async function preparedDeposit() {
        const intent = await createIntent({ text: "deposit 5 USDC into jupiter lend", accounts: ACCOUNTS });
      const { intent: prepared } = await prepareStep(intent.id, intent.steps[0]!.id);
      return prepared.steps[0]!;
    }

    async function land(options: { amount?: bigint; recipient?: string; minted?: bigint; spent?: bigint; loaded?: boolean } = {}) {
      const { lending, lendingAdmin } = await jupiterLendPdas();
      const ownerUsdc = await ata(OWNER, USDC);
      const ownerJl = await ata(OWNER, JL_USDC);
      const signature = randomSolanaSignature();
      mock.landed.set(signature, {
        signature,
        feePayer: OWNER,
        blockTime: Math.floor(Date.now() / 1000),
        instructions: [{
          program: JL_PROGRAM,
          accounts: [OWNER, ownerUsdc, options.recipient ?? ownerJl, USDC, lendingAdmin, lending, JL_USDC, JL_RESERVES, JL_POSITION, JL_RATE_MODEL, JL_VAULT, JL_LIQUIDITY_STATE, JL_LIQUIDITY, JL_REWARDS, TOKEN_PROGRAM, ATA_PROGRAM, SYSTEM],
          data: instructionData(JUPITER_LEND_DISCRIMINATORS.deposit, options.amount ?? 5_000_000n),
        }],
        // Liquidity-side accounts come through a lookup table, as wallets may compress them.
        ...(options.loaded ? { loaded: [JL_RESERVES, JL_POSITION, JL_VAULT] } : {}),
        tokenBalances: [
          { owner: OWNER, mint: USDC, account: ownerUsdc, pre: 10_000_000n, post: 10_000_000n - (options.spent ?? 5_000_000n) },
          { owner: OWNER, mint: JL_USDC, account: ownerJl, pre: 0n, post: options.minted ?? 4_701_655n },
        ],
      });
      return signature;
    }

    it("confirms a landed deposit by its instruction and token deltas and reports the shares minted", async () => {
      const step = await preparedDeposit();
      const reference = await land({ loaded: true });
      const result = await jupiterLendAdapter.verify({ step, references: [reference], submittedAt: Date.now(), now: Date.now() });
      assert.equal(result.status, "confirmed", JSON.stringify(result));
      assert.equal(result.status === "confirmed" ? result.actualOutput?.amount : null, "4701655");
    });

    it("rejects a transaction that deposits another amount or credits another account", async () => {
      const step = await preparedDeposit();
      for (const options of [{ amount: 5_000_001n }, { recipient: await ata(ATTACKER, JL_USDC) }]) {
        const result = await jupiterLendAdapter.verify({ step, references: [await land(options)], submittedAt: Date.now(), now: Date.now() });
        assert.ok(isReferenceRejection(result), JSON.stringify(result));
      }
    });

    it("proves 'withdraw all' from the redeemed shares: a partial redeem or credit from another instruction never counts", async () => {
      const shares = 49_667_215_871n;
      await holdShares(shares);
      const intent = await createIntent({ text: "withdraw all USDC from jupiter lend", accounts: ACCOUNTS });
      const { intent: prepared } = await prepareStep(intent.id, intent.steps[0]!.id);
      const step = prepared.steps[0]!;
      const value = assetsForShares(shares, JL_PRICE);
      const { lending, lendingAdmin } = await jupiterLendPdas();
      const ownerUsdc = await ata(OWNER, USDC);
      const ownerJl = await ata(OWNER, JL_USDC);
      const redeem = async (redeemed: bigint, credited: bigint, swap = false) => {
        const signature = randomSolanaSignature();
        mock.landed.set(signature, {
          signature,
          feePayer: OWNER,
          blockTime: Math.floor(Date.now() / 1000),
          instructions: [
            {
              program: JL_PROGRAM,
              accounts: [OWNER, ownerJl, ownerUsdc, lendingAdmin, lending, USDC, JL_USDC, JL_RESERVES, JL_POSITION, JL_RATE_MODEL, JL_VAULT, JL_CLAIM, JL_LIQUIDITY_STATE, JL_LIQUIDITY, JL_REWARDS, TOKEN_PROGRAM, ATA_PROGRAM, SYSTEM],
              data: instructionData(JUPITER_LEND_DISCRIMINATORS.redeem, redeemed),
            },
            // An unrelated swap of the account's SOL into USDC.
            ...(swap ? [{ program: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", accounts: [OWNER, ownerUsdc], data: Uint8Array.from([1, 2, 3]) }] : []),
          ],
          tokenBalances: [
            { owner: OWNER, mint: JL_USDC, account: ownerJl, pre: shares, post: shares - redeemed },
            { owner: OWNER, mint: USDC, account: ownerUsdc, pre: 0n, post: credited },
          ],
        });
        const result = await jupiterLendAdapter.verify({ step, references: [signature], submittedAt: Date.now(), now: Date.now() });
        return result.status === "failed" ? result.failure.code : result.status === "confirmed" ? `confirmed ${result.actualOutput?.amount}` : result.status;
      };
      assert.equal(await redeem(shares, value), `confirmed ${value}`);
      assert.equal(await redeem(1n, value + 1n, true), "OUTCOME_NOT_PROVEN", "one share redeemed, the rest credited by a swap");
      assert.equal(await redeem(shares, value + 1_000_000n, true), "OUTCOME_NOT_PROVEN", "the whole position plus a swap credit");
    });

    it("fails the step when the bound transaction did not mint the guaranteed shares", async () => {
      const step = await preparedDeposit();
      const result = await jupiterLendAdapter.verify({ step, references: [await land({ minted: 4_000_000n })], submittedAt: Date.now(), now: Date.now() });
      assert.equal(result.status, "failed");
      assert.equal(result.status === "failed" ? result.failure.code : null, "OUTCOME_NOT_PROVEN");
    });
  });
});
