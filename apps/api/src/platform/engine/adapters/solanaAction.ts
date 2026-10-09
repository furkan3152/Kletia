/**
 * Solana Actions (`solana-actions`): integrator-registered action endpoints
 * whose transactions run only allowlisted programs.
 *
 * Plan fetches a transaction for the user's account to quote the outcome;
 * prepare fetches a fresh one (blockhashes expire), holds it to the same
 * rules and the plan, and replaces its blockhash with one Kletia read (no
 * signatures exist, the instructions are untouched). Verification binds the
 * landed instructions to a prepared payload (ComputeBudget and Lighthouse
 * assertion instructions a wallet adds or tunes are tolerated; anything else
 * is another transaction), then proves the user's deltas, that no authority
 * or delegate changed on the user's accounts, and that the user's signature
 * reached only the allowlisted and built-in programs (the CPI scan).
 */
import {
  CHAINS,
  CONTRACT_LIMITS,
  findAssetByAddress,
  fromBaseUnits,
  nativeAssetId,
  WRAPPED_SOL_MINT,
  type AssetAmount,
  type AssetChange,
  type ContractReview,
  type ContractStepCall,
  type IntentStep,
  type SolanaProgramPin,
  type StepEvidence,
  type TransactionRequest,
} from "@kletia/core";
import { isSolanaNetworkKey, type SolanaNetworkKey } from "../../../networks/solana/index.js";
import { PlatformError } from "../../errors.js";
import { assetAmount } from "../assets.js";
import {
  decodeSolanaTransaction,
  latestBlockhash,
  readSolanaAccounts,
  readU64,
  simulateSolanaTransactionDetailed,
  SOLANA_PROGRAM_IDS,
  type DecodedSolanaTransaction,
  type SolanaInstructionView,
  type SolanaTokenBalance,
} from "../chains/solana.js";
import { contractDirectory, reportContractAnomaly } from "../contracts/directory.js";
import { solanaActionReview } from "../contracts/review.js";
import {
  actionInstructionDigest,
  authorityStateRefusal,
  checkActionTransaction,
  compareSolanaProgramPins,
  currentProgramPins,
  decodeActionTransaction,
  decodeTokenAccount,
  fetchActionTransaction,
  fillActionHref,
  innerInstructionRefusal,
  INSTRUCTION_DIGEST_PREFIX,
  outcomeRefusal,
  staticKeysOf,
  tokenDeltasOf,
  walletAdditionRefusal,
  withBlockhash,
  type ActionSimulationRules,
} from "../contracts/solanaActions.js";
import { nativeUsdPrice } from "../prices.js";
import { contractPriceCheck } from "./contractCall.js";
import type {
  AdapterAction,
  ContractCallContext,
  ContractPlannedStep,
  ContractPreparedPayload,
  ContractProtocolAdapter,
  PrepareContext,
  VerificationResult,
} from "./types.js";
import { lowestPreparedFloor, SOL_RENT_TOLERANCE_LAMPORTS, stepOwner, verifySolanaReferences } from "./verification.js";

const ESTIMATED_SECONDS = 15;
const SYSTEM_PROGRAM = SOLANA_PROGRAM_IDS.system;

interface ActionRun {
  readonly transaction: string;
  readonly lastValidBlockHeight?: number;
  readonly input?: AssetAmount;
  readonly expectedOutput?: AssetAmount;
  readonly minimumOutput?: AssetAmount;
  readonly feesUsd?: number;
  readonly review: ContractReview;
  readonly call: ContractStepCall;
  readonly warnings: string[];
  readonly digest: string;
  readonly instructionCount: number;
  /** Top-level programs of the transaction, in order. */
  readonly programs: readonly string[];
}

function actionContext(action: AdapterAction): { network: SolanaNetworkKey; call: ContractCallContext } {
  const call = action.call;
  if (!call || call.snapshot.vm !== "svm" || !call.snapshot.href || !call.snapshot.programs) {
    throw new PlatformError("STEP_INVALID", "The action step has no Solana Actions snapshot.", 500);
  }
  if (!isSolanaNetworkKey(action.network)) {
    throw new PlatformError("NETWORK_UNSUPPORTED", `Solana Actions run on Solana networks, not ${CHAINS[action.network].name}.`, 422);
  }
  return { network: action.network, call };
}

function rejected(message: string): PlatformError {
  return new PlatformError("ACTION_TRANSACTION_REJECTED", message, 422);
}

function signed(delta: bigint, decimals: number): string {
  const magnitude = delta < 0n ? -delta : delta;
  return `${delta < 0n ? "-" : "+"}${fromBaseUnits(magnitude, decimals)}`;
}

function assetRows(network: SolanaNetworkKey, solDelta: bigint, deltas: ReadonlyMap<string, bigint>, decimals: ReadonlyMap<string, number>): AssetChange[] {
  const rows: AssetChange[] = [];
  if (solDelta !== 0n) {
    rows.push({ asset: nativeAssetId(network), symbol: "SOL", decimals: 9, listed: true, delta: solDelta.toString(), formatted: signed(solDelta, 9) });
  }
  for (const [mint, delta] of [...deltas.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (delta === 0n || mint === WRAPPED_SOL_MINT) continue;
    const listed = findAssetByAddress(network, mint);
    const places = listed?.decimals ?? decimals.get(mint) ?? 0;
    rows.push({
      asset: `${CHAINS[network].id}/token:${mint}` as AssetChange["asset"],
      symbol: listed?.symbol ?? `${mint.slice(0, 4)}…${mint.slice(-4)}`,
      decimals: places,
      listed: listed !== null,
      delta: delta.toString(),
      formatted: signed(delta, places),
    });
  }
  return rows;
}

/** Lamports the landed / prepared top-level System transfers pay to declared payees. */
function payeeLamports(instructions: readonly SolanaInstructionView[], user: string, payees: readonly { readonly address: string }[]): bigint {
  const declared = new Set(payees.map((payee) => payee.address));
  let total = 0n;
  for (const instruction of instructions) {
    if (instruction.program !== SYSTEM_PROGRAM || instruction.data.length !== 12) continue;
    if (new DataView(instruction.data.buffer, instruction.data.byteOffset, instruction.data.byteLength).getUint32(0, true) !== 2) continue;
    const [from, to] = instruction.accounts;
    if (from === user && to && declared.has(to)) total += readU64(instruction.data, 4) ?? 0n;
  }
  return total;
}

/** The plan / prepare / test pipeline of one Solana Action. */
async function runAction(action: AdapterAction, now: number): Promise<ActionRun> {
  const { network, call } = actionContext(action);
  const { snapshot, stage } = call;
  const label = snapshot.label ?? snapshot.entry;
  const user = action.account.address;
  const pinned = snapshot.programs as readonly SolanaProgramPin[];
  const directory = contractDirectory();
  if (!directory) throw new PlatformError("CONTRACTS_DISABLED", "Solana Actions are not enabled on this deployment.", 503);

  // 1. Program identity.
  const current = await currentProgramPins(network, pinned.map((pin) => pin.program), stage !== "plan");
  const changed = compareSolanaProgramPins(pinned, current);
  if (changed) {
    await reportContractAnomaly(snapshot.contract, "program_changed", changed);
    throw new PlatformError("PROGRAM_CHANGED", `${snapshot.integrator.name}'s action changed since it was registered: ${changed.replace(/([^.])$/u, "$1.")} The registration is suspended until the integrator reverifies it.`, 409);
  }

  // 2. Fetch the transaction for this account.
  const input = call.input;
  const amount = input ? BigInt(action.amount) : null;
  if (amount !== null && amount <= 0n) throw new PlatformError("AMOUNT_TOO_SMALL", `${label} would spend nothing.`, 422);
  const url = fillActionHref(snapshot.href as string, {
    ...(input && amount !== null ? { amount: fromBaseUnits(amount, input.decimals), amountBaseUnits: amount.toString() } : {}),
    params: snapshot.params ?? {},
  });
  const fetched = await fetchActionTransaction(directory.actionTransport, url, user, snapshot.params ?? {});
  const decoded: DecodedSolanaTransaction = await decodeActionTransaction(network, fetched, decodeSolanaTransaction);
  const payees = snapshot.payees ?? [];
  const structure = await checkActionTransaction(fetched, decoded, {
    user,
    network,
    programs: pinned.map((pin) => pin.program),
    primaryProgram: snapshot.target,
    payees,
  });

  // 3. Simulate with the user's account states.
  const watched = [user, ...structure.writable];
  const before = await readSolanaAccounts(network, watched);
  const simulation = await simulateSolanaTransactionDetailed(network, fetched, staticKeysOf(fetched), watched);
  const warnings: string[] = [];
  const funded = call.funded;
  const at = new Date(now).toISOString();
  let evaluated: { expected: bigint | null; rows: AssetChange[]; fee: bigint; slot: bigint | null } | null = null;
  if (!simulation) {
    if (stage !== "plan") throw new PlatformError("SIMULATION_UNAVAILABLE", "The Solana RPC cannot simulate right now; Kletia never prepares a Solana Action unsimulated. Retry shortly.", 503);
    warnings.push("Simulation was unavailable at planning; the action will be simulated again before signing.");
  } else if (simulation.error) {
    if (stage === "plan" && funded) {
      warnings.push("The action could not be simulated before the earlier step delivers its funds; it will be simulated again before signing.");
    } else {
      throw new PlatformError("SIMULATION_FAILED", `${label} would fail on-chain: ${simulation.error}${simulation.logs.length ? ` (${simulation.logs.slice(-2).join(" | ").slice(0, 200)})` : ""}`, 422);
    }
  } else {
    evaluated = evaluateSimulation(network, simulation, before, watched, pinned.map((pin) => pin.program), {
      user,
      input: input && amount !== null ? { mint: input.isNative ? null : (input.address as string), amount } : null,
      output: call.output?.address ? { mint: call.output.address } : null,
      payeeLamports: structure.payeeLamports,
      rentTolerance: SOL_RENT_TOLERANCE_LAMPORTS,
    });
  }

  // 4. Payload (prepare re-blockhashes it) and review.
  let transaction = fetched;
  let lastValidBlockHeight: number | undefined;
  if (stage === "prepare") {
    const latest = await latestBlockhash(network);
    transaction = withBlockhash(fetched, latest.blockhash);
    lastValidBlockHeight = latest.lastValidBlockHeight;
  }
  const output = call.output;
  const tolerance = BigInt(snapshot.toleranceBps ?? CONTRACT_LIMITS.defaultToleranceBps);
  const expected = evaluated?.expected ?? null;
  const fee = evaluated?.fee ?? null;
  const price = fee !== null ? await nativeUsdPrice(network).catch(() => null) : null;
  const feesUsd = fee !== null && price !== null ? (Number(fee) / 1e9) * price : undefined;
  const review = solanaActionReview({
    snapshot,
    ...(call.registration ? { registration: call.registration } : {}),
    url,
    programs: current,
    instructionCount: decoded.instructions.length,
    simulation: {
      status: evaluated ? "ok" : "unavailable",
      at,
      ...(evaluated?.slot !== null && evaluated?.slot !== undefined ? { slot: evaluated.slot.toString() } : {}),
      assetChanges: evaluated?.rows ?? [],
      ...(fee !== null ? {
        networkFee: {
          asset: nativeAssetId(network),
          symbol: "SOL",
          decimals: 9,
          amount: fee.toString(),
          formatted: fromBaseUnits(fee, 9),
          ...(feesUsd !== undefined ? { usd: Math.round(feesUsd * 10_000) / 10_000 } : {}),
        },
      } : {}),
      warnings: evaluated ? [] : warnings.slice(-1),
    },
  });
  const { review: _previous, ...rest } = snapshot;
  return {
    transaction,
    ...(lastValidBlockHeight !== undefined ? { lastValidBlockHeight } : {}),
    ...(input && amount !== null ? { input: assetAmount(input, amount.toString()) } : {}),
    ...(output && expected !== null ? { expectedOutput: assetAmount(output, expected.toString()) } : {}),
    ...(output && expected !== null ? { minimumOutput: assetAmount(output, ((expected * (10_000n - tolerance)) / 10_000n).toString()) } : {}),
    ...(feesUsd !== undefined ? { feesUsd } : {}),
    review,
    call: { ...rest, programs: current, review },
    warnings,
    digest: actionInstructionDigest(decoded.instructions),
    instructionCount: decoded.instructions.length,
    programs: decoded.programs,
  };
}

/** Token account → owner before the transaction (else after it), from token balances and decoded account states. */
function tokenOwnersOf(pre: readonly SolanaTokenBalance[], post: readonly SolanaTokenBalance[], states: ReadonlyMap<string, string> = new Map()): Map<string, string> {
  const owners = new Map(states);
  for (const entry of [...pre, ...post]) if (entry.owner && !owners.has(entry.account)) owners.set(entry.account, entry.owner);
  return owners;
}

/** Safety and amount rules over a successful simulation; throws on any violation. */
function evaluateSimulation(
  network: SolanaNetworkKey,
  simulation: NonNullable<Awaited<ReturnType<typeof simulateSolanaTransactionDetailed>>>,
  before: Awaited<ReturnType<typeof readSolanaAccounts>>,
  watched: readonly string[],
  programs: readonly string[],
  rules: ActionSimulationRules,
): { expected: bigint | null; rows: AssetChange[]; fee: bigint; slot: bigint | null } {
  const user = rules.user;
  // The wallet stays a plain System account.
  const wallet = simulation.accounts[0];
  if (!wallet || wallet.owner !== SYSTEM_PROGRAM || wallet.data.length !== 0) {
    throw rejected("The transaction would reassign or allocate the user's wallet.");
  }
  // The user's token accounts keep their owner, delegate and close authority.
  const userTokenAccounts = new Set<string>();
  const stateOwners = new Map<string, string>();
  watched.forEach((account, index) => {
    if (index === 0) return;
    const pre = decodeTokenAccount(before[index] ?? null);
    const postState = simulation.accounts[index] ?? null;
    const post = decodeTokenAccount(postState);
    if (pre) stateOwners.set(account, pre.owner);
    // Accounts the user holds authority over outside SPL balances keep their value and hands.
    const authority = authorityStateRefusal(account, before[index] ?? null, postState, user);
    if (authority) throw rejected(authority);
    if (pre?.owner === user) {
      userTokenAccounts.add(account);
      if (postState && postState.lamports > 0n) {
        if (!post || post.owner !== user) throw rejected(`The transaction would move ownership of the user's token account ${account}.`);
        if (post.delegate !== pre.delegate) throw rejected(`The transaction would set a delegate on the user's token account ${account}.`);
        if (post.closeAuthority !== pre.closeAuthority) throw rejected(`The transaction would change the close authority of the user's token account ${account}.`);
      }
    } else if (post?.owner === user) {
      userTokenAccounts.add(account);
      if (post.delegate !== null) throw rejected(`The transaction would create a token account for the user with a delegate (${account}).`);
      if (post.closeAuthority !== null && post.closeAuthority !== user) throw rejected(`The transaction would create a token account for the user that someone else can close (${account}).`);
    }
  });
  for (const entry of simulation.preTokenBalances) {
    if (entry.owner !== user) continue;
    userTokenAccounts.add(entry.account);
    const after = simulation.postTokenBalances.find((candidate) => candidate.account === entry.account);
    if (after && after.owner !== user) throw rejected(`The transaction would move ownership of the user's token account ${entry.account}.`);
  }
  for (const entry of simulation.postTokenBalances) if (entry.owner === user) userTokenAccounts.add(entry.account);
  const inner = innerInstructionRefusal(simulation.innerInstructions, user, userTokenAccounts, {
    programs,
    tokenOwners: tokenOwnersOf(simulation.preTokenBalances, simulation.postTokenBalances, stateOwners),
  });
  if (inner) throw rejected(inner);
  // Amounts.
  const index = simulation.accountKeys.indexOf(user);
  if (index < 0 || !simulation.preBalances || !simulation.postBalances) throw rejected("The simulation did not report the user's balances.");
  const fee = simulation.fee ?? 0n;
  const { deltas, decimals } = tokenDeltasOf(simulation.preTokenBalances, simulation.postTokenBalances, user);
  const lamports = (simulation.postBalances[index] as bigint) - (simulation.preBalances[index] as bigint);
  const solDelta = lamports + fee + (deltas.get(WRAPPED_SOL_MINT) ?? 0n);
  const outputCredit = rules.output ? (deltas.get(rules.output.mint) ?? 0n) : null;
  const refusal = outcomeRefusal({ solDelta, tokenDeltas: deltas, outputCredit }, rules);
  if (refusal) throw new PlatformError("SIMULATION_ASSET_CHANGE_REFUSED", refusal, 422);
  return { expected: outputCredit, rows: assetRows(network, solDelta, deltas, decimals), fee, slot: simulation.slot };
}

/* ---------------------------------------------------------------- verify */

function preparedDigests(step: IntentStep): Set<string> {
  return new Set(step.evidence
    .map((entry) => entry.reference ?? "")
    .filter((reference) => reference.startsWith(INSTRUCTION_DIGEST_PREFIX))
    .map((reference) => reference.slice(INSTRUCTION_DIGEST_PREFIX.length)));
}

async function verifyAction(context: Parameters<ContractProtocolAdapter["verify"]>[0]): Promise<VerificationResult> {
  const { step } = context;
  const snapshot = step.call;
  if (!snapshot || snapshot.vm !== "svm" || !isSolanaNetworkKey(step.network)) {
    return { status: "failed", evidence: [], failure: { code: "STEP_INVALID", message: "The action step has no Solana Actions snapshot." } };
  }
  const user = stepOwner(step);
  const digests = preparedDigests(step);
  const observed: { output?: AssetAmount } = {};
  const { result } = await verifySolanaReferences(context, (observations) => {
    for (const observation of observations) {
      if (!digests.has(actionInstructionDigest(observation.instructions ?? []))) {
        return { failure: { code: "REFERENCE_MISMATCH", message: "The landed transaction's instructions differ from every payload prepared for this step (only compute-budget and Lighthouse assertion instructions may be added)." } };
      }
      // Tolerated wallet additions move nothing: a Lighthouse MemoryWrite (funded by the user) or a CPI makes it another transaction.
      const addition = walletAdditionRefusal(observation.instructions ?? [], observation.innerInstructions ?? []);
      if (addition) return { failure: { code: "REFERENCE_MISMATCH", message: addition } };
    }
    const pre: SolanaTokenBalance[] = observations.flatMap((observation) => [...(observation.tokenBalances?.pre ?? [])]);
    const post: SolanaTokenBalance[] = observations.flatMap((observation) => [...(observation.tokenBalances?.post ?? [])]);
    const userTokenAccounts = new Set([...pre, ...post].filter((entry) => entry.owner === user).map((entry) => entry.account));
    for (const entry of pre) {
      if (entry.owner !== user) continue;
      const after = post.find((candidate) => candidate.account === entry.account);
      if (after && after.owner !== user) return { failure: { code: "OUTCOME_NOT_PROVEN", message: `The user's token account ${entry.account} changed owner.` } };
    }
    const inner = innerInstructionRefusal(observations.flatMap((observation) => [...(observation.innerInstructions ?? [])]), user, userTokenAccounts, {
      programs: (snapshot.programs ?? []).map((pin) => pin.program),
      tokenOwners: tokenOwnersOf(pre, post),
    });
    if (inner) return { failure: { code: "OUTCOME_NOT_PROVEN", message: inner } };
    const { deltas } = tokenDeltasOf(pre, post, user);
    const solDelta = observations.reduce((total, observation) => {
      const lamports = observation.lamportDeltas.get(user) ?? 0n;
      const fee = observation.feePayer === user ? (observation.fee ?? 0n) : 0n;
      return total + lamports + fee;
    }, 0n) + (deltas.get(WRAPPED_SOL_MINT) ?? 0n);
    const outputMint = snapshot.output ? snapshot.output.asset.slice(snapshot.output.asset.indexOf(":", snapshot.output.asset.indexOf("/")) + 1) : null;
    const inputMint = step.input && !step.input.asset.endsWith("/slip44:501") ? step.input.asset.slice(step.input.asset.indexOf(":", step.input.asset.indexOf("/")) + 1) : null;
    const credit = outputMint ? (deltas.get(outputMint) ?? 0n) : null;
    const refusal = outcomeRefusal({ solDelta, tokenDeltas: deltas, outputCredit: credit }, {
      user,
      input: step.input ? { mint: inputMint, amount: BigInt(step.input.amount) } : null,
      output: outputMint ? { mint: outputMint } : null,
      payeeLamports: payeeLamports(observations.flatMap((observation) => [...(observation.instructions ?? [])]), user, snapshot.payees ?? []),
      rentTolerance: SOL_RENT_TOLERANCE_LAMPORTS,
    });
    if (refusal) return { failure: { code: "OUTCOME_NOT_PROVEN", message: refusal } };
    if (credit !== null && step.minimumOutput) {
      const floor = lowestPreparedFloor(step) ?? 1n;
      if (credit < floor) {
        return { failure: { code: "OUTCOME_NOT_PROVEN", message: `The action credited ${fromBaseUnits(credit, step.minimumOutput.decimals)} ${step.minimumOutput.symbol}, below the guaranteed ${fromBaseUnits(floor, step.minimumOutput.decimals)}.` } };
      }
      observed.output = { asset: step.minimumOutput.asset, symbol: step.minimumOutput.symbol, decimals: step.minimumOutput.decimals, amount: credit.toString(), formatted: fromBaseUnits(credit, step.minimumOutput.decimals) };
    }
  });
  if (result.status === "confirmed" && observed.output) return { ...result, actualOutput: observed.output };
  return result;
}

/* ---------------------------------------------------------------- adapter */

function unsupportedEntry(): never {
  throw new PlatformError("PROTOCOL_UNSUPPORTED", "Solana Actions are planned and prepared by the contract branch of the planner.", 500);
}

export const solanaActionAdapter: ContractProtocolAdapter = {
  id: "solana-actions",
  protocols: ["solana-actions"],
  label: "Solana Action",
  contract: true,

  supports() {
    return false;
  },

  async plan() {
    return unsupportedEntry();
  },

  async prepare() {
    return unsupportedEntry();
  },

  async planCall(action: AdapterAction): Promise<ContractPlannedStep> {
    const run = await runAction(action, Date.now());
    const snapshot = run.call;
    return {
      kind: "call",
      protocol: "solana-actions",
      title: `${snapshot.label ?? snapshot.entry} · ${snapshot.integrator.name}`.slice(0, 160),
      mode: "wallet",
      ...(run.input ? { input: run.input } : {}),
      ...(run.expectedOutput ? { expectedOutput: run.expectedOutput } : {}),
      ...(run.minimumOutput ? { minimumOutput: run.minimumOutput } : {}),
      ...(run.feesUsd !== undefined ? { feesUsd: run.feesUsd } : {}),
      estimatedSeconds: ESTIMATED_SECONDS,
      settlement: { kind: "same-network" },
      warnings: run.warnings,
      transactionCount: 1,
      slippageBps: Math.max(1, snapshot.toleranceBps ?? CONTRACT_LIMITS.defaultToleranceBps),
      call: snapshot,
      review: run.review,
    };
  },

  async prepareCall(context: PrepareContext): Promise<ContractPreparedPayload> {
    const { step, graph, action } = context;
    const run = await runAction(action, context.now);
    const funded = graph.edges.some((edge) => edge.to === step.id && edge.kind === "funds");
    const moved = contractPriceCheck(step, run, funded);
    const description = `${run.call.label ?? run.call.entry} (${run.call.integrator.name})`;
    const transaction: TransactionRequest = {
      vm: "svm",
      network: action.network,
      feePayer: action.account.address,
      transaction: run.transaction,
      encoding: "base64",
      ...(run.lastValidBlockHeight !== undefined ? { lastValidBlockHeight: run.lastValidBlockHeight } : {}),
      description,
    };
    const evidence: StepEvidence = {
      kind: "note",
      network: action.network,
      reference: `${INSTRUCTION_DIGEST_PREFIX}${run.digest}`,
      observedAt: new Date(context.now).toISOString(),
      detail: `Solana Action instructions bound (${run.instructionCount} instruction(s); wallets may only add compute-budget and Lighthouse instructions).`,
    };
    return {
      kind: "call",
      transactions: [transaction],
      records: [{ vm: "svm", network: action.network, feePayer: action.account.address, to: run.call.target, description }],
      ...(run.input ? { input: run.input } : {}),
      ...(run.expectedOutput ? { expectedOutput: run.expectedOutput } : {}),
      ...(run.minimumOutput ? { minimumOutput: run.minimumOutput } : {}),
      ...(run.feesUsd !== undefined ? { feesUsd: run.feesUsd } : {}),
      warnings: moved ? [...run.warnings, moved] : run.warnings,
      review: run.review,
      evidence: [evidence],
    };
  },

  verify: verifyAction,
};

/** Test pipeline (dry run of one action for an account). */
export async function testSolanaAction(action: AdapterAction, now: number): Promise<ActionRun> {
  return runAction(action, now);
}
