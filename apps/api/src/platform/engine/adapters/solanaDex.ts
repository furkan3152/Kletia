/**
 * Named Solana venues: exact-in swaps on one owner-checked Raydium, Orca
 * or Meteora pool, quoted and assembled through the Jupiter program and
 * served only when the request names the venue (`explicitOnly`; "via
 * raydium"), so a plain Solana swap still makes one Jupiter call. The
 * registry routes all three through Jupiter (`routedVia`), so avoiding or
 * denying Jupiter excludes them.
 *
 * - Plan: one direct leg (`onlyDirectRoutes`, one route-plan entry at 100 %)
 *   through a label of the venue that has a verified pool layout; the pool's
 *   owner must be that label's program and its mints the two swap assets.
 * - Prepare: the provider bundle is checked instruction by instruction, the
 *   transaction is assembled, re-decoded and checked again, and the
 *   simulation must show a CPI into the pool program with the pool account
 *   (otherwise SIMULATION_UNVERIFIED).
 * - Verify: the wallet may add compute-budget instructions and
 *   Lighthouse assertions; any other Lighthouse instruction, or one that
 *   invoked other programs, is REFERENCE_MISMATCH. The provider part is held
 *   to the strict prepare rules; the landed CPI, exact input and the floor
 *   (native SOL with rent and wrapped-SOL accounting) are required.
 */
import { formatAmount, fromBaseUnits, type AssetAmount, type IntentStep } from "@kletia/core";
import { fetchSolanaDexInstructions, quoteSolanaDexSwap, type SolanaDex, type SolanaDexQuote } from "../../../networks/solana/dexSwap.js";
import { assembleSolanaTransaction } from "../../../networks/solana/transactions.js";
import { PlatformError } from "../../errors.js";
import { assetAmount, assetFromRef, jupiterMint, sameAsset, type ResolvedAsset } from "../assets.js";
import { assertSolanaTransactionOwner, computeBudgetMismatch, decodeSolanaTransaction, readSolanaAccounts, simulateSolanaTransactionDetailed,
  SOLANA_PROGRAM_IDS, type SolanaInstructionView, type SolanaTransactionObservation } from "../chains/solana.js";
import { isLighthouseAssertion, LIGHTHOUSE_PROGRAM, walletAdditionRefusal } from "../contracts/solanaActions.js";
import { decodeStepRef } from "../stepRef.js";
import { checkDexInstructions, dexLabels, dexRoutePool, dexTokenAccount, externalDexViews, readDexPool,
  type DexExpectation } from "./solanaDexClient.js";
import type { AdapterAction, PlannedStep, PreparedPayload, ProtocolAdapter, VerificationResult } from "./types.js";
import { stepOwner, tokenDelta, verifySolanaReferences } from "./verification.js";

const NAMES: Readonly<Record<SolanaDex, string>> = { raydium: "Raydium", orca: "Orca", meteora: "Meteora" };

function title(dex: SolanaDex, action: Pick<AdapterAction, "amount" | "input" | "output">): string {
  return `Swap ${formatAmount(fromBaseUnits(action.amount, action.input.decimals))} ${action.input.symbol} for ${action.output.symbol} on ${NAMES[dex]}`;
}

function assertAction(action: AdapterAction): void {
  if (action.kind !== "swap" || action.network !== "solana" || action.destinationNetwork !== "solana" ||
      action.account.address !== action.recipient.address || sameAsset(action.input, action.output)) {
    throw new PlatformError("INTENT_UNSUPPORTED", "Direct DEX swaps run on Solana mainnet and pay the acting wallet. Send the output with a separate transfer step.", 422);
  }
  if (!Number.isInteger(action.slippageBps) || action.slippageBps < 1 || action.slippageBps > 300) {
    throw new PlatformError("SOLANA_SLIPPAGE_OUT_OF_RANGE", "Direct Solana DEX slippage must be between 1 and 300 bps.", 400);
  }
}

/** Both mints are initialized classic SPL mints with the registry's decimals (Token-2022 is not supported). */
async function assertMints(input: ResolvedAsset, output: ResolvedAsset): Promise<void> {
  const assets = [input, output];
  const states = await readSolanaAccounts("solana", assets.map(jupiterMint));
  for (const [index, asset] of assets.entries()) {
    const mint = states[index];
    if (!mint || mint.owner !== SOLANA_PROGRAM_IDS.token || mint.data.length !== 82 || mint.data[45] !== 1 || mint.data[44] !== asset.decimals) {
      throw new PlatformError("DEX_ASSET_UNSUPPORTED", "Direct DEX swaps require initialized classic SPL mints with the reviewed decimals; Token-2022 mints are currently unsupported.", 422);
    }
  }
}

function warnings(quote: SolanaDexQuote): string[] {
  if (quote.priceImpactPct > 0.05) throw new PlatformError("PRICE_IMPACT_TOO_HIGH", "Direct DEX routes with price impact above 5% are refused.", 422);
  return [`Single direct ${quote.label} pool, quoted and assembled through the Jupiter program; route splitting and intermediate tokens are disabled.`,
    ...(quote.priceImpactPct > 0.01 ? [`Price impact is ${(quote.priceImpactPct * 100).toFixed(2)}%.`] : [])];
}

function amounts(action: Pick<AdapterAction, "input" | "output" | "amount">, quote: SolanaDexQuote) {
  return { input: assetAmount(action.input, action.amount), expectedOutput: assetAmount(action.output, quote.outAmount),
    minimumOutput: assetAmount(action.output, quote.minimumOutAmount) };
}

async function quote(dex: SolanaDex, action: Pick<AdapterAction, "input" | "output" | "amount">, slippageBps: number): Promise<SolanaDexQuote> {
  return quoteSolanaDexSwap(dex, dexLabels(dex), { inputMint: jupiterMint(action.input), outputMint: jupiterMint(action.output), amount: action.amount, slippageBps });
}

async function expectation(dex: SolanaDex, owner: string, input: ResolvedAsset, output: ResolvedAsset,
  amount: string, minimum: bigint, slippageBps: number): Promise<DexExpectation> {
  const inputMint = jupiterMint(input);
  const outputMint = jupiterMint(output);
  const [inputAccount, outputAccount] = await Promise.all([dexTokenAccount(owner, inputMint), dexTokenAccount(owner, outputMint)]);
  return { dex, owner, inputMint, outputMint, inputAccount, outputAccount,
    inputNative: input.isNative, outputNative: output.isNative, amount: BigInt(amount), minimum, slippageBps };
}

/** Keep the floor of an earlier re-prepared payload only while its blockhash could land. */
function landedFloor(step: IntentStep, blockTime: number): bigint {
  const current = BigInt(step.minimumOutput?.amount ?? "0");
  const eligible = (decodeStepRef(step.quoteRef)?.floors ?? []).filter((floor) =>
    floor.at - 300 <= blockTime && blockTime <= floor.at + 90 + 180 + 300).map((floor) => BigInt(floor.min));
  return eligible.length ? eligible.reduce((low, value) => value < low ? value : low) : current;
}

function observedOutput(minimum: AssetAmount, amount: bigint): AssetAmount {
  const { usd: _usd, ...asset } = minimum;
  return { ...asset, amount: amount.toString(), formatted: fromBaseUnits(amount, minimum.decimals) };
}

/**
 * Native swap movement across the wallet and its two canonical ATAs.
 * ATA lamports cancel rent creation/refunds and any pre-existing WSOL unwrapped
 * at cleanup. Adding WSOL token deltas as well would count that balance twice.
 */
function nativeSwapDelta(observation: SolanaTransactionObservation, expected: DexExpectation): bigint | null {
  if (observation.fee === null) return null;
  let delta = observation.fee;
  for (const account of new Set([expected.owner, expected.inputAccount, expected.outputAccount])) {
    const value = observation.lamportDeltas.get(account);
    if (value === undefined) return null;
    delta += value;
  }
  return delta;
}

/**
 * The landed instructions without what a wallet may add:
 * compute-budget instructions that pass the budget caps and Lighthouse
 * assertions. Everything else stays and meets the strict provider rules.
 */
function providerInstructions(landed: readonly SolanaInstructionView[]): SolanaInstructionView[] {
  return landed.filter((ix) => !(ix.program === SOLANA_PROGRAM_IDS.computeBudget && ix.accounts.length === 0 && computeBudgetMismatch(ix.data) === null) &&
    !(ix.program === LIGHTHOUSE_PROGRAM && isLighthouseAssertion(ix.data)));
}

function createDexAdapter(dex: SolanaDex): ProtocolAdapter {
  const label = NAMES[dex];
  return {
    id: dex,
    protocols: [dex],
    label,
    explicitOnly: true,
    supports(route) {
      return route.kind === "swap" && route.network === "solana" && route.destinationNetwork === "solana" && !sameAsset(route.input, route.output);
    },
    async plan(action): Promise<PlannedStep> {
      assertAction(action);
      await assertMints(action.input, action.output);
      const quoted = await quote(dex, action, action.slippageBps);
      const notes = warnings(quoted);
      await readDexPool(dex, quoted.label, quoted.pool, quoted.inputMint, quoted.outputMint);
      return { protocol: dex, title: title(dex, action), mode: "wallet", ...amounts(action, quoted), estimatedSeconds: 15,
        settlement: { kind: "same-network" }, warnings: notes, quoteId: `pool:${quoted.pool}`, transactionCount: 1, slippageBps: quoted.slippageBps,
        floor: "onchain" };
    },
    async prepare({ action, step }): Promise<PreparedPayload> {
      assertAction(action);
      await assertMints(action.input, action.output);
      const slippageBps = decodeStepRef(step.quoteRef)?.slippageBps ?? action.slippageBps;
      const quoted = await quote(dex, action, slippageBps);
      const notes = warnings(quoted);
      const pool = await readDexPool(dex, quoted.label, quoted.pool, quoted.inputMint, quoted.outputMint);
      const expected = { ...await expectation(dex, action.account.address, action.input, action.output, action.amount, BigInt(quoted.minimumOutAmount), slippageBps), quote: quoted, pool };
      const bundle = await fetchSolanaDexInstructions(quoted, action.account.address);
      const main = checkDexInstructions(externalDexViews(bundle.instructions), expected);
      if (dexRoutePool(main, dex)?.pool !== pool.address) throw new PlatformError("PROVIDER_TRANSACTION_REJECTED", "The direct DEX instruction uses another pool.", 502);
      const built = await assembleSolanaTransaction({ network: "solana", feePayer: action.account.address, instructions: bundle.instructions, addressLookupTables: bundle.lookupTables });
      assertSolanaTransactionOwner(built.transaction, action.account.address);
      const decoded = await decodeSolanaTransaction("solana", built.transaction);
      if (decoded.version !== 0 && decoded.version !== "legacy") throw new PlatformError("PROVIDER_TRANSACTION_REJECTED", "Direct DEX swaps support legacy/v0 transactions only.", 502);
      const assembled = checkDexInstructions(decoded.instructions, expected);
      if (!built.simulation.ok) {
        if (built.simulation.error === "Simulation unavailable") {
          throw new PlatformError("SOLANA_RPC_UNAVAILABLE", `The ${label} transaction could not be simulated successfully (unavailable).`, 502);
        }
        throw new PlatformError("SIMULATION_FAILED", `The ${label} transaction could not be simulated successfully (${built.simulation.error ?? "unavailable"}).`, 422);
      }
      // The actual CPI is required: an inert Jupiter instruction beside unrelated balance changes is not a swap.
      const simulation = await simulateSolanaTransactionDetailed("solana", built.transaction, decoded.accountKeys, [], true);
      if (!simulation) throw new PlatformError("SOLANA_RPC_UNAVAILABLE", `The ${label} instruction-level simulation is unavailable.`, 502);
      if (simulation.error) throw new PlatformError("SIMULATION_FAILED", `The ${label} swap simulation failed (${simulation.error.slice(0, 160)}).`, 422);
      const routeIndex = decoded.instructions.indexOf(assembled as (typeof decoded.instructions)[number]);
      if (!simulation.innerInstructions.some((ix) => ix.index === routeIndex && ix.program === pool.program && ix.accounts.includes(pool.address))) {
        throw new PlatformError("SIMULATION_UNVERIFIED", `The simulation did not prove a swap through the reviewed ${label} pool.`, 502);
      }
      const description = title(dex, action);
      return { transactions: [{ vm: "svm", network: "solana", feePayer: action.account.address, transaction: built.transaction,
        encoding: "base64", lastValidBlockHeight: built.lastValidBlockHeight, description }],
        records: [{ vm: "svm", network: "solana", feePayer: action.account.address, to: SOLANA_PROGRAM_IDS.jupiterV6, description }],
        ...amounts(action, quoted), quoteId: `pool:${quoted.pool}`, warnings: notes };
    },
    async verify(context): Promise<VerificationResult> {
      const { step } = context;
      if (!step.input || !step.minimumOutput || step.kind !== "swap" || context.references.length !== 1 || step.prepared?.transactions.length !== 1) {
        return { status: "failed", evidence: [], failure: { code: "STEP_INVALID", message: "The direct DEX step has no recorded swap amounts or requires more than one transaction." } };
      }
      const { result, observations } = await verifySolanaReferences(context);
      if (result.status !== "confirmed") return result;
      const input = assetFromRef(step.input);
      const output = assetFromRef(step.minimumOutput);
      const owner = stepOwner(step);
      const observation = observations[0];
      const fail = (code: string, message: string): VerificationResult => ({ status: "failed", evidence: result.evidence, failure: { code, message } });
      if (!observation || observation.blockTime === null) return fail("REFERENCE_MISMATCH", "The swap has no readable block time.");
      const floor = landedFloor(step, observation.blockTime);
      const slippageBps = decodeStepRef(step.quoteRef)?.slippageBps;
      if (!slippageBps) return fail("STEP_INVALID", "The direct DEX step has no recorded slippage limit.");
      const landed = observation.instructions ?? [];
      const refusal = walletAdditionRefusal(landed, observation.innerInstructions ?? []);
      if (refusal) return fail("REFERENCE_MISMATCH", refusal);
      const core = providerInstructions(landed);
      const expected = await expectation(dex, owner, input, output, step.input.amount, floor, slippageBps);
      let main: SolanaInstructionView;
      try { main = checkDexInstructions(core, expected); }
      catch (error) { return fail("REFERENCE_MISMATCH", error instanceof Error ? error.message : "The submitted swap instructions differ."); }
      const route = dexRoutePool(main, dex);
      if (!route) return fail("REFERENCE_MISMATCH", "The direct swap does not identify a supported DEX pool.");
      let pool;
      try { pool = await readDexPool(dex, route.label, route.pool, expected.inputMint, expected.outputMint); }
      catch (error) {
        if (error instanceof PlatformError && error.code === "VENUE_UNVERIFIED") return fail("REFERENCE_MISMATCH", error.message);
        return { status: "pending", evidence: result.evidence, reason: "The landed DEX pool is not readable yet.", stale: false };
      }
      try { checkDexInstructions(core, { ...expected, pool }); }
      catch (error) { return fail("REFERENCE_MISMATCH", error instanceof Error ? error.message : "The submitted pool differs."); }
      // The CPI is matched by the route's index in the landed (original) instruction list.
      const routeIndex = landed.indexOf(main);
      if (!observation.innerInstructions?.some((ix) => ix.index === routeIndex && ix.program === pool.program && ix.accounts.includes(pool.address))) {
        return fail("OUTCOME_NOT_PROVEN", `The receipt did not invoke the reviewed ${label} pool.`);
      }
      const native = input.isNative || output.isNative ? nativeSwapDelta(observation, expected) : null;
      if ((input.isNative || output.isNative) && native === null) {
        return { status: "pending", evidence: result.evidence, reason: "The wallet and associated-account lamport balances or transaction fee are not readable yet.", stale: false };
      }
      const spent = input.isNative ? -(native as bigint) : -tokenDelta(observations, owner, expected.inputMint);
      if (spent !== BigInt(step.input.amount)) return fail("OUTCOME_NOT_PROVEN", "The swap did not spend exactly the reviewed input amount.");
      const received = output.isNative ? native as bigint : tokenDelta(observations, owner, expected.outputMint);
      if (received < floor) return fail("OUTCOME_NOT_PROVEN", "The swap did not credit the guaranteed output to the acting wallet.");
      return { ...result, actualOutput: observedOutput(step.minimumOutput, received) };
    },
  };
}

export const raydiumAdapter: ProtocolAdapter = createDexAdapter("raydium");
export const orcaAdapter: ProtocolAdapter = createDexAdapter("orca");
export const meteoraAdapter: ProtocolAdapter = createDexAdapter("meteora");
