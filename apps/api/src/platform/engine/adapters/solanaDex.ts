/** Explicit Raydium and Orca execution lanes, using Jupiter only as transport. */
import { formatAmount, fromBaseUnits, type AssetAmount, type IntentStep } from "@kletia/core";
import { quoteSolanaDexSwap, fetchSolanaDexInstructions, type SolanaDex, type SolanaDexQuote } from "../../../networks/solana/dexSwap.js";
import { assembleSolanaTransaction } from "../../../networks/solana/transactions.js";
import { PlatformError } from "../../errors.js";
import { assetAmount, assetFromRef, jupiterMint, sameAsset, type ResolvedAsset } from "../assets.js";
import { assertSolanaTransactionOwner, decodeSolanaTransaction, readSolanaAccounts, simulateSolanaTransactionDetailed,
  SOLANA_PROGRAM_IDS, type SolanaTransactionObservation } from "../chains/solana.js";
import { decodeStepRef } from "../stepRef.js";
import { checkDexInstructions, dexRoutePool, dexTokenAccount, externalDexViews, readDexPool,
  type DexExpectation } from "./solanaDexClient.js";
import type { AdapterAction, PlannedStep, PreparedPayload, ProtocolAdapter, VerificationResult } from "./types.js";
import { stepOwner, tokenDelta, verifySolanaReferences } from "./verification.js";

function title(dex: SolanaDex, action: Pick<AdapterAction, "amount" | "input" | "output">): string {
  return `Swap ${formatAmount(fromBaseUnits(action.amount, action.input.decimals))} ${action.input.symbol} for ${action.output.symbol} on ${dex === "raydium" ? "Raydium" : "Orca"}`;
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
  return ["Single direct pool, quoted and assembled through Jupiter; route splitting and intermediate tokens are disabled.",
    ...(quote.priceImpactPct > 0.01 ? [`Price impact is ${(quote.priceImpactPct * 100).toFixed(2)}%.`] : [])];
}

function amounts(action: Pick<AdapterAction, "input" | "output" | "amount">, quote: SolanaDexQuote) {
  return { input: assetAmount(action.input, action.amount), expectedOutput: assetAmount(action.output, quote.outAmount),
    minimumOutput: assetAmount(action.output, quote.minimumOutAmount) };
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

/** Native swap movement across the wallet and its two canonical ATAs.
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

function createDexAdapter(dex: SolanaDex): ProtocolAdapter {
  const label = dex === "raydium" ? "Raydium" : "Orca";
  return {
    id: dex, protocols: [dex], label,
    supports(route) {
      return route.kind === "swap" && route.network === "solana" && route.destinationNetwork === "solana" && !sameAsset(route.input, route.output);
    },
    async plan(action): Promise<PlannedStep> {
      assertAction(action);
      await assertMints(action.input, action.output);
      const quote = await quoteSolanaDexSwap(dex, { inputMint: jupiterMint(action.input), outputMint: jupiterMint(action.output), amount: action.amount, slippageBps: action.slippageBps });
      const notes = warnings(quote);
      await readDexPool(dex, quote.label, quote.pool, quote.inputMint, quote.outputMint);
      return { protocol: dex, title: title(dex, action), mode: "wallet", ...amounts(action, quote), estimatedSeconds: 15,
        settlement: { kind: "same-network" }, warnings: notes, quoteId: `pool:${quote.pool}`, transactionCount: 1, slippageBps: quote.slippageBps };
    },
    async prepare({ action, step }): Promise<PreparedPayload> {
      assertAction(action);
      await assertMints(action.input, action.output);
      const slippageBps = decodeStepRef(step.quoteRef)?.slippageBps ?? action.slippageBps;
      const quote = await quoteSolanaDexSwap(dex, { inputMint: jupiterMint(action.input), outputMint: jupiterMint(action.output), amount: action.amount, slippageBps });
      const notes = warnings(quote);
      const pool = await readDexPool(dex, quote.label, quote.pool, quote.inputMint, quote.outputMint);
      const expected = { ...await expectation(dex, action.account.address, action.input, action.output, action.amount, BigInt(quote.minimumOutAmount), slippageBps), quote, pool };
      const bundle = await fetchSolanaDexInstructions(quote, action.account.address);
      const main = checkDexInstructions(externalDexViews(bundle.instructions), expected);
      const encodedPool = dexRoutePool(main, dex);
      if (encodedPool?.pool !== pool.address) throw new PlatformError("PROVIDER_TRANSACTION_REJECTED", "The direct DEX instruction uses another pool.", 502);
      const built = await assembleSolanaTransaction({ network: "solana", feePayer: action.account.address, instructions: bundle.instructions, addressLookupTables: bundle.lookupTables });
      assertSolanaTransactionOwner(built.transaction, action.account.address);
      const decoded = await decodeSolanaTransaction("solana", built.transaction);
      if (decoded.version !== 0 && decoded.version !== "legacy") throw new PlatformError("PROVIDER_TRANSACTION_REJECTED", "Direct DEX swaps support legacy/v0 transactions only.", 502);
      checkDexInstructions(decoded.instructions, expected);
      if (!built.simulation.ok) {
        if (built.simulation.error === "Simulation unavailable") {
          throw new PlatformError("SOLANA_RPC_UNAVAILABLE", `The ${label} transaction could not be simulated successfully (unavailable).`, 502);
        }
        throw new PlatformError("SIMULATION_FAILED", `The ${label} transaction could not be simulated successfully (${built.simulation.error ?? "unavailable"}).`, 422);
      }
      // Requiring the actual CPI prevents an inert Jupiter instruction with unrelated account balances from being accepted.
      const simulation = await simulateSolanaTransactionDetailed("solana", built.transaction, decoded.accountKeys, [], true);
      if (!simulation) throw new PlatformError("SOLANA_RPC_UNAVAILABLE", `The ${label} instruction-level simulation is unavailable.`, 502);
      if (simulation.error) throw new PlatformError("SIMULATION_FAILED", `The ${label} swap simulation failed (${simulation.error.slice(0, 160)}).`, 422);
      const routeIndex = decoded.instructions.findIndex((ix) => ix.program === SOLANA_PROGRAM_IDS.jupiterV6);
      if (!simulation.innerInstructions.some((ix) => ix.index === routeIndex && ix.program === pool.program && ix.accounts.includes(pool.address))) {
        throw new PlatformError("SIMULATION_UNVERIFIED", `The simulation did not prove a swap through the reviewed ${label} pool.`, 502);
      }
      const description = title(dex, action);
      return { transactions: [{ vm: "svm", network: "solana", feePayer: action.account.address, transaction: built.transaction,
        encoding: "base64", lastValidBlockHeight: built.lastValidBlockHeight, description }],
        records: [{ vm: "svm", network: "solana", feePayer: action.account.address, to: SOLANA_PROGRAM_IDS.jupiterV6, description }],
        ...amounts(action, quote), quoteId: `pool:${quote.pool}`, warnings: notes };
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
      const expected = await expectation(dex, owner, input, output, step.input.amount, floor, slippageBps);
      let main;
      try { main = checkDexInstructions(observation.instructions ?? [], expected); }
      catch (error) { return fail("REFERENCE_MISMATCH", error instanceof Error ? error.message : "The submitted swap instructions differ."); }
      const route = dexRoutePool(main, dex);
      if (!route) return fail("REFERENCE_MISMATCH", "The direct swap does not identify a supported DEX pool.");
      let pool;
      try { pool = await readDexPool(dex, route.label, route.pool, expected.inputMint, expected.outputMint); }
      catch (error) {
        if (error instanceof PlatformError && error.code === "VENUE_UNVERIFIED") return fail("REFERENCE_MISMATCH", error.message);
        return { status: "pending", evidence: result.evidence, reason: "The landed DEX pool is not readable yet.", stale: false };
      }
      try { checkDexInstructions(observation.instructions ?? [], { ...expected, pool }); }
      catch (error) { return fail("REFERENCE_MISMATCH", error instanceof Error ? error.message : "The submitted pool differs."); }
      const routeIndex = observation.instructions?.indexOf(main) ?? -1;
      if (!observation.innerInstructions?.some((ix) => ix.index === routeIndex && ix.program === pool.program && ix.accounts.includes(pool.address))) {
        return fail("OUTCOME_NOT_PROVEN", `The receipt did not invoke the reviewed ${label} pool.`);
      }
      const native = input.isNative || output.isNative ? nativeSwapDelta(observation, expected) : null;
      if ((input.isNative || output.isNative) && native === null) {
        return { status: "pending", evidence: result.evidence, reason: "The wallet and associated-account lamport balances or transaction fee are not readable yet.", stale: false };
      }
      const spent = input.isNative ? -(native as bigint) : -tokenDelta(observations, owner, expected.inputMint);
      const amount = BigInt(step.input.amount);
      if (spent !== amount) return fail("OUTCOME_NOT_PROVEN", "The swap did not spend exactly the reviewed input amount.");
      const received = output.isNative ? native as bigint : tokenDelta(observations, owner, expected.outputMint);
      if (received < floor) return fail("OUTCOME_NOT_PROVEN", "The swap did not credit the guaranteed output to the acting wallet.");
      return { ...result, actualOutput: observedOutput(step.minimumOutput, received) };
    },
  };
}

export const raydiumAdapter = createDexAdapter("raydium");
export const orcaAdapter = createDexAdapter("orca");
