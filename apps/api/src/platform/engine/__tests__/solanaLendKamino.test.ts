/**
 * Kamino Lend adapter and lookup-table-aware inspection: KTX transactions are
 * decoded with their address lookup tables, every instruction is checked
 * against the allowlist (amount, pinned reserve, own accounts, no transfers
 * elsewhere, no borrows), and landed transactions are bound by their KLend
 * instruction (accounts resolved through loaded addresses) plus token deltas.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  blockhash,
  compileTransaction,
  compressTransactionMessageUsingAddressLookupTables,
  createNoopSigner,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Instruction,
} from "@solana/kit";
import { getSetComputeUnitLimitInstruction, getSetComputeUnitPriceInstruction } from "@solana-program/compute-budget";
import { getTransferSolInstruction } from "@solana-program/system";
import { getCreateAssociatedTokenIdempotentInstruction, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { CHAINS } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { kaminoAdapter } from "../adapters/kamino.js";
import { collateralForLiquidity, KLEND_DISCRIMINATORS, type KaminoReserveState } from "../adapters/kaminoClient.js";
import { isReferenceRejection } from "../adapters/verification.js";
import { decodeSolanaTransaction } from "../chains/solana.js";
import { planIntent } from "../planner.js";
import { configurePlatform, createIntent, prepareStep } from "../service.js";
import { MemoryIntentStore } from "../store.js";
import { randomSolanaSignature } from "./helpers.js";
import {
  ALT_PROGRAM,
  ATTACKER,
  ata,
  FARMS,
  hex,
  installSolanaLendMock,
  instructionData,
  INSTRUCTIONS_SYSVAR,
  KAMINO_DECOY_USDC_RESERVE,
  KAMINO_LMA,
  KAMINO_MARKET,
  KAMINO_USDC_COLLATERAL_MINT,
  KAMINO_USDC_COLLATERAL_VAULT,
  KAMINO_USDC_RESERVE,
  KAMINO_USDC_SUPPLY,
  KLEND,
  lookupTableData,
  OWNER,
  reserveAccountData,
  TOKEN_PROGRAM,
  USDC,
  vanillaObligationOf,
  type SolanaLendMock,
} from "./solanaLendFixtures.js";

const ACCOUNTS = [`solana:${CHAINS.solana.reference}:${OWNER}`];
const LOOKUP_TABLE = "FGMSBiyVE8TvZcdQnZETAAKw28tkQJ2ccZy6pyp95URb";
const OBLIGATION_FARM = "CkHTYvbkBkwCyfFqfkPzdCxr9d6GyEiS38TQCXSsZ8m1";
const RESERVE_FARM = "JAvnB9AKtgPsTEoKmn24Bq64UMoYcrtWtq42HHBdsPkh";
const SCOPE_PRICES = "3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH";
const RESERVE = { available: 10_000_000_000_000n, borrowed: 112_000_000_000_000n, collateralSupply: 102_000_000_000_000n };
const RESERVE_STATE: KaminoReserveState = {
  market: KAMINO_MARKET,
  liquidityMint: USDC,
  supplyVault: KAMINO_USDC_SUPPLY,
  liquidityTokenProgram: TOKEN_PROGRAM,
  decimals: 6,
  collateralMint: KAMINO_USDC_COLLATERAL_MINT,
  collateralVault: KAMINO_USDC_COLLATERAL_VAULT,
  collateralSupply: RESERVE.collateralSupply,
  totalLiquiditySf: (RESERVE.available + RESERVE.borrowed) << 60n,
};

type Variant = {
  amount?: bigint;
  reserve?: string;
  extra?: (owner: string) => Instruction[];
  mainDiscriminator?: string;
  initObligationTag?: number;
  computeUnitPrice?: bigint;
};

const meta = (value: string, role: AccountRole) => ({ address: address(value), role });

function klend(accounts: { address: Address; role: AccountRole }[], data: Uint8Array): Instruction {
  return { programAddress: address(KLEND), accounts, data };
}

/** A KTX-shaped deposit / withdraw transaction; reserve-side accounts sit in a lookup table. */
async function ktxTransaction(kind: "deposit" | "withdraw", owner: string, amount: bigint, variant: Variant = {}): Promise<string> {
  const signer = createNoopSigner(address(owner));
  const obligation = await vanillaObligationOf(owner);
  const ownerUsdc = await ata(owner, USDC);
  const reserve = variant.reserve ?? KAMINO_USDC_RESERVE;
  const vaults = kind === "deposit"
    ? [meta(KAMINO_USDC_SUPPLY, AccountRole.WRITABLE), meta(KAMINO_USDC_COLLATERAL_MINT, AccountRole.WRITABLE), meta(KAMINO_USDC_COLLATERAL_VAULT, AccountRole.WRITABLE)]
    : [meta(KAMINO_USDC_COLLATERAL_VAULT, AccountRole.WRITABLE), meta(KAMINO_USDC_COLLATERAL_MINT, AccountRole.WRITABLE), meta(KAMINO_USDC_SUPPLY, AccountRole.WRITABLE)];
  const instructions: Instruction[] = [
    getSetComputeUnitLimitInstruction({ units: 1_000_000 }),
    ...(variant.computeUnitPrice !== undefined ? [getSetComputeUnitPriceInstruction({ microLamports: variant.computeUnitPrice })] : []),
    getCreateAssociatedTokenIdempotentInstruction({ payer: signer, ata: address(ownerUsdc), owner: address(owner), mint: address(USDC), tokenProgram: TOKEN_PROGRAM_ADDRESS }),
    ...(variant.initObligationTag !== undefined
      ? [klend([meta(owner, AccountRole.WRITABLE_SIGNER), meta(owner, AccountRole.WRITABLE_SIGNER), meta(obligation, AccountRole.WRITABLE), meta(KAMINO_MARKET, AccountRole.READONLY)], Uint8Array.from([...hex(KLEND_DISCRIMINATORS.initObligation), variant.initObligationTag, 0]))]
      : []),
    klend([meta(reserve, AccountRole.WRITABLE), meta(KAMINO_MARKET, AccountRole.READONLY), meta(KLEND, AccountRole.READONLY), meta(KLEND, AccountRole.READONLY), meta(KLEND, AccountRole.READONLY), meta(SCOPE_PRICES, AccountRole.READONLY)], hex(KLEND_DISCRIMINATORS.refreshReserve)),
    klend([meta(KAMINO_MARKET, AccountRole.READONLY), meta(obligation, AccountRole.WRITABLE)], hex(KLEND_DISCRIMINATORS.refreshObligation)),
    ...(variant.extra?.(owner) ?? []),
    klend([
      meta(owner, AccountRole.WRITABLE_SIGNER),
      meta(obligation, AccountRole.WRITABLE),
      meta(KAMINO_MARKET, AccountRole.READONLY),
      meta(KAMINO_LMA, AccountRole.READONLY),
      meta(reserve, AccountRole.WRITABLE),
      meta(USDC, AccountRole.READONLY),
      ...vaults,
      meta(ownerUsdc, AccountRole.WRITABLE),
      meta(KLEND, AccountRole.READONLY),
      meta(TOKEN_PROGRAM, AccountRole.READONLY),
      meta(TOKEN_PROGRAM, AccountRole.READONLY),
      meta(INSTRUCTIONS_SYSVAR, AccountRole.READONLY),
      meta(OBLIGATION_FARM, AccountRole.WRITABLE),
      meta(RESERVE_FARM, AccountRole.WRITABLE),
      meta(FARMS, AccountRole.READONLY),
    ], instructionData(variant.mainDiscriminator ?? (kind === "deposit" ? KLEND_DISCRIMINATORS.deposit : KLEND_DISCRIMINATORS.withdraw), amount)),
  ];
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (draft) => setTransactionMessageFeePayer(address(owner), draft),
    (draft) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash("4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM"), lastValidBlockHeight: 1_000n }, draft),
    (draft) => appendTransactionMessageInstructions(instructions, draft),
  );
  const compressed = compressTransactionMessageUsingAddressLookupTables(message, { [address(LOOKUP_TABLE)]: TABLE_ENTRIES.map((entry) => address(entry)) });
  return getBase64EncodedWireTransaction(compileTransaction(compressed));
}

const TABLE_ENTRIES = [KAMINO_MARKET, KAMINO_LMA, KAMINO_USDC_RESERVE, KAMINO_DECOY_USDC_RESERVE, KAMINO_USDC_SUPPLY, KAMINO_USDC_COLLATERAL_MINT, KAMINO_USDC_COLLATERAL_VAULT, OBLIGATION_FARM, RESERVE_FARM, SCOPE_PRICES, INSTRUCTIONS_SYSVAR];

let mock: SolanaLendMock;
let variant: Variant;
const requests: Record<string, unknown>[] = [];

async function plannedError(text: string): Promise<PlatformError> {
  try {
    await planIntent({ text, accounts: ACCOUNTS });
  } catch (error) {
    assert.ok(error instanceof PlatformError, `expected PlatformError, got ${String(error)}`);
    return error;
  }
  assert.fail(`planning "${text}" succeeded but should have failed`);
}

describe("Kamino adapter", () => {
  beforeEach(() => {
    mock = installSolanaLendMock();
    configurePlatform({ store: new MemoryIntentStore(), adapters: null });
    variant = {};
    requests.length = 0;
    mock.accounts.set(KAMINO_USDC_RESERVE, { owner: KLEND, data: reserveAccountData(RESERVE) });
    mock.accounts.set(LOOKUP_TABLE, { owner: ALT_PROGRAM, data: lookupTableData(TABLE_ENTRIES) });
    for (const kind of ["deposit", "withdraw"] as const) {
      mock.kamino.set(kind, async (body) => {
        requests.push({ kind, ...body });
        const units = BigInt(Math.round(Number(body.amount) * 1_000_000));
        // KTX converts a withdrawal into collateral units at the reserve rate (rounding up).
        const encoded = variant.amount ?? (kind === "deposit" ? units : collateralForLiquidity(RESERVE_STATE, units) + 1n);
        return { body: { transaction: await ktxTransaction(kind, String(body.wallet), encoded, variant) } };
      });
    }
  });
  afterEach(() => mock.restore());

  it("decodes lookup-table accounts into their instruction positions and refuses a foreign table", async () => {
    const wire = await ktxTransaction("deposit", OWNER, 5_000_000n);
    const decoded = await decodeSolanaTransaction("solana", wire);
    assert.deepEqual(decoded.lookupTables, [LOOKUP_TABLE]);
    const main = decoded.instructions.at(-1)!;
    assert.deepEqual(main.accounts.slice(2, 9), [KAMINO_MARKET, KAMINO_LMA, KAMINO_USDC_RESERVE, USDC, KAMINO_USDC_SUPPLY, KAMINO_USDC_COLLATERAL_MINT, KAMINO_USDC_COLLATERAL_VAULT]);
    assert.deepEqual(main.metas.filter((entry) => entry.signer).map((entry) => entry.address), [OWNER]);
    assert.ok(main.metas[4]!.writable && !main.metas[2]!.writable, "lookup-table roles follow writable / read-only indexes");
    mock.accounts.set(LOOKUP_TABLE, { owner: ATTACKER, data: lookupTableData(TABLE_ENTRIES) });
    await assert.rejects(decodeSolanaTransaction("solana", wire), (error: PlatformError) => error.code === "PROVIDER_TRANSACTION_INVALID");
  });

  it("plans a deposit whose output is the reserve collateral booked to the obligation", async () => {
    const graph = await planIntent({ text: "deposit 5 USDC into kamino", accounts: ACCOUNTS });
    const step = graph.steps[0]!;
    assert.equal(step.protocol, "kamino");
    assert.equal(step.venue, "solana:kamino:usdc");
    assert.equal(step.input?.amount, "5000000");
    const minted = collateralForLiquidity(RESERVE_STATE, 5_000_000n);
    assert.equal(step.expectedOutput?.asset, `${CHAINS.solana.id}/token:${KAMINO_USDC_COLLATERAL_MINT}`);
    assert.equal(step.expectedOutput?.amount, minted.toString());
    assert.equal(step.minimumOutput?.amount, ((minted * 9_990n) / 10_000n).toString());
    assert.deepEqual(requests.map((request) => [request.kind, request.reserve, request.market, request.amount]), [["deposit", KAMINO_USDC_RESERVE, KAMINO_MARKET, "5"]]);
    assert.deepEqual(mock.unknown, []);
  });

  it("refuses KTX transactions that change the amount, target a decoy reserve, move funds elsewhere or borrow", async () => {
    const variants: [string, Variant][] = [
      ["truncated amount", { amount: 4_999_999n }],
      ["decoy reserve", { reserve: KAMINO_DECOY_USDC_RESERVE }],
      ["SOL to another account", { extra: (owner) => [getTransferSolInstruction({ source: createNoopSigner(address(owner)), destination: address(ATTACKER), amount: 1n })] }],
      ["borrow instead of deposit", { mainDiscriminator: "a1808ff5abc7c206" }],
      ["unknown KLend instruction", { extra: () => [klend([meta(KAMINO_MARKET, AccountRole.READONLY)], hex("a1808ff5abc7c206"))] }],
      ["unknown program", { extra: () => [{ programAddress: address(ATTACKER), accounts: [], data: new Uint8Array([1]) }] }],
      ["priority fee above the cap", { computeUnitPrice: 5_000_000n }],
      ["non-vanilla obligation", { initObligationTag: 1 }],
    ];
    for (const [label, change] of variants) {
      variant = change;
      const error = await plannedError("deposit 5 USDC into kamino");
      assert.equal(error.code, "PROVIDER_TRANSACTION_REJECTED", `${label}: ${error.message}`);
    }
  });

  it("binds a withdrawal's collateral to the requested amount and refuses closing a whole position", async () => {
    const graph = await planIntent({ text: "withdraw 5 USDC from kamino", accounts: ACCOUNTS });
    assert.equal(graph.steps[0]?.input?.amount, "5000000");
    assert.ok(mock.methods.includes("simulateTransaction"), "withdrawals are dry-run at planning");
    variant = { amount: collateralForLiquidity(RESERVE_STATE, 6_000_000n) };
    assert.equal((await plannedError("withdraw 5 USDC from kamino")).code, "PROVIDER_TRANSACTION_REJECTED");
    variant = {};
    assert.equal((await plannedError("withdraw all USDC from kamino")).code, "INTENT_UNSUPPORTED");
  });

  it("refuses a reserve account that is not the pinned KLend reserve", async () => {
    mock.accounts.set(KAMINO_USDC_RESERVE, { owner: KLEND, data: reserveAccountData({ ...RESERVE, market: ATTACKER }) });
    assert.equal((await plannedError("deposit 5 USDC into kamino")).code, "VENUE_UNVERIFIED");
    mock.accounts.set(KAMINO_USDC_RESERVE, { owner: ATTACKER, data: reserveAccountData(RESERVE) });
    assert.equal((await plannedError("deposit 5 USDC into kamino")).code, "VENUE_UNVERIFIED");
  });

  describe("verification", () => {
    async function preparedDeposit() {
      const intent = await createIntent({ text: "deposit 5 USDC into kamino", accounts: ACCOUNTS });
      const { intent: prepared, payload } = await prepareStep(intent.id, intent.steps[0]!.id);
      assert.equal(payload.transactions.length, 1);
      return prepared.steps[0]!;
    }

    async function land(options: { reserve?: string; vaultCredit?: bigint; minted?: bigint } = {}) {
      const obligation = await vanillaObligationOf(OWNER);
      const ownerUsdc = await ata(OWNER, USDC);
      const signature = randomSolanaSignature();
      const minted = options.minted ?? collateralForLiquidity(RESERVE_STATE, 5_000_000n);
      mock.landed.set(signature, {
        signature,
        feePayer: OWNER,
        blockTime: Math.floor(Date.now() / 1000),
        instructions: [{
          program: KLEND,
          accounts: [OWNER, obligation, KAMINO_MARKET, KAMINO_LMA, options.reserve ?? KAMINO_USDC_RESERVE, USDC, KAMINO_USDC_SUPPLY, KAMINO_USDC_COLLATERAL_MINT, KAMINO_USDC_COLLATERAL_VAULT, ownerUsdc, KLEND, TOKEN_PROGRAM, TOKEN_PROGRAM, INSTRUCTIONS_SYSVAR, OBLIGATION_FARM, RESERVE_FARM, FARMS],
          data: instructionData(KLEND_DISCRIMINATORS.deposit, 5_000_000n),
        }],
        loaded: [KAMINO_MARKET, KAMINO_LMA, options.reserve ?? KAMINO_USDC_RESERVE, KAMINO_USDC_SUPPLY, KAMINO_USDC_COLLATERAL_MINT, KAMINO_USDC_COLLATERAL_VAULT],
        tokenBalances: [
          { owner: OWNER, mint: USDC, account: ownerUsdc, pre: 10_000_000n, post: 5_000_000n },
          { owner: KAMINO_LMA, mint: USDC, account: KAMINO_USDC_SUPPLY, pre: 1_000_000_000n, post: 1_000_000_000n + (options.vaultCredit ?? 5_000_000n) },
          { owner: KAMINO_LMA, mint: KAMINO_USDC_COLLATERAL_MINT, account: KAMINO_USDC_COLLATERAL_VAULT, pre: 1_000_000_000n, post: 1_000_000_000n + minted },
        ],
      });
      return { signature, minted };
    }

    it("confirms a deposit bound by its KLend instruction (accounts from loaded addresses) and token deltas", async () => {
      const step = await preparedDeposit();
      const { signature, minted } = await land();
      const result = await kaminoAdapter.verify({ step, references: [signature], submittedAt: Date.now(), now: Date.now() });
      assert.equal(result.status, "confirmed", JSON.stringify(result));
      assert.equal(result.status === "confirmed" ? result.actualOutput?.amount : null, minted.toString());
    });

    type LandedInstruction = { program: string; accounts: string[]; data: Uint8Array };

    async function landWithdraw(collateral: bigint, paid: bigint, extra: (ownerUsdc: string, obligation: string) => LandedInstruction[] = () => []) {
      const obligation = await vanillaObligationOf(OWNER);
      const ownerUsdc = await ata(OWNER, USDC);
      const signature = randomSolanaSignature();
      mock.landed.set(signature, {
        signature,
        feePayer: OWNER,
        blockTime: Math.floor(Date.now() / 1000),
        instructions: [
          {
            program: KLEND,
            accounts: [OWNER, obligation, KAMINO_MARKET, KAMINO_LMA, KAMINO_USDC_RESERVE, USDC, KAMINO_USDC_COLLATERAL_VAULT, KAMINO_USDC_COLLATERAL_MINT, KAMINO_USDC_SUPPLY, ownerUsdc, KLEND, TOKEN_PROGRAM, TOKEN_PROGRAM, INSTRUCTIONS_SYSVAR, OBLIGATION_FARM, RESERVE_FARM, FARMS],
            data: instructionData(KLEND_DISCRIMINATORS.withdraw, collateral),
          },
          ...extra(ownerUsdc, obligation),
        ],
        loaded: [KAMINO_MARKET, KAMINO_LMA, KAMINO_USDC_RESERVE, KAMINO_USDC_SUPPLY, KAMINO_USDC_COLLATERAL_MINT, KAMINO_USDC_COLLATERAL_VAULT],
        tokenBalances: [
          { owner: OWNER, mint: USDC, account: ownerUsdc, pre: 0n, post: paid },
          { owner: KAMINO_LMA, mint: USDC, account: KAMINO_USDC_SUPPLY, pre: 1_000_000_000n, post: 1_000_000_000n - paid },
          { owner: KAMINO_LMA, mint: KAMINO_USDC_COLLATERAL_MINT, account: KAMINO_USDC_COLLATERAL_VAULT, pre: 1_000_000_000n, post: 1_000_000_000n - collateral },
        ],
      });
      return signature;
    }

    it("proves a withdrawal from its own collateral: a borrow or other liquidity in the same transaction never counts as paid", async () => {
      const intent = await createIntent({ text: "withdraw 5 USDC from kamino", accounts: ACCOUNTS });
      const { intent: prepared } = await prepareStep(intent.id, intent.steps[0]!.id);
      const step = prepared.steps[0]!;
      const verify = async (signature: string) => {
        const result = await kaminoAdapter.verify({ step, references: [signature], submittedAt: Date.now(), now: Date.now() });
        return result.status === "failed" ? result.failure.code : result.status === "confirmed" ? `confirmed ${result.actualOutput?.amount}` : result.status;
      };
      const collateral = collateralForLiquidity(RESERVE_STATE, 5_000_000n) + 1n;
      assert.equal(await verify(await landWithdraw(collateral, 5_000_001n)), "confirmed 5000001");
      // borrow_obligation_liquidity_v2 of 5 USDC from the same reserve, paid out of the same supply vault.
      const borrow = (ownerUsdc: string, obligation: string): LandedInstruction[] => [{
        program: KLEND,
        accounts: [OWNER, obligation, KAMINO_MARKET, KAMINO_LMA, KAMINO_USDC_RESERVE, USDC, KAMINO_USDC_SUPPLY, KLEND, ownerUsdc, TOKEN_PROGRAM, INSTRUCTIONS_SYSVAR],
        data: instructionData("a1808ff5abc7c206", 5_000_000n),
      }];
      assert.equal(await verify(await landWithdraw(1n, 5_000_001n, borrow)), "OUTCOME_NOT_PROVEN", "one collateral unit plus a borrow");
      assert.equal(await verify(await landWithdraw(collateral, 10_000_001n, borrow)), "OUTCOME_NOT_PROVEN", "a full withdrawal next to a borrow");
      // The same payout reached without a top-level KLend borrow (e.g. through another program): more than the collateral is worth.
      assert.equal(await verify(await landWithdraw(1n, 5_000_001n)), "OUTCOME_NOT_PROVEN", "one collateral unit cannot pay 5 USDC");
    });

    it("rejects a deposit into another reserve and fails one whose reserve vault did not receive the amount", async () => {
      const step = await preparedDeposit();
      const decoy = await kaminoAdapter.verify({ step, references: [(await land({ reserve: KAMINO_DECOY_USDC_RESERVE })).signature], submittedAt: Date.now(), now: Date.now() });
      assert.ok(isReferenceRejection(decoy), JSON.stringify(decoy));
      const short = await kaminoAdapter.verify({ step, references: [(await land({ vaultCredit: 4_000_000n })).signature], submittedAt: Date.now(), now: Date.now() });
      assert.equal(short.status === "failed" ? short.failure.code : short.status, "OUTCOME_NOT_PROVEN");
    });
  });
});
