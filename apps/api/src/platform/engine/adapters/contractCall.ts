/**
 * Custom contract calls (`custom-call`): integrator-registered EVM contract
 * actions.
 *
 * Plan and prepare:
 * 1. Re-read the code-identity pins (cached 30 s at plan, fresh at prepare);
 *    any difference refuses the step (CONTRACT_CHANGED) and suspends the
 *    registration.
 * 2. Encode the call from the snapshot ABI fragment and bindings (never from
 *    caller-supplied calldata); approvals are exact and only to the pinned
 *    spender, only when the allowance is short (USDT-style reset first).
 * 3. Simulate `[reads, approve(s), call, reads, allowance]` in one
 *    `eth_simulateV1` block from the user's address. Plan may override the
 *    input balance (it may arrive from a bridge); prepare never overrides
 *    and refuses without a simulation endpoint (SIMULATION_UNAVAILABLE).
 * 4. Hold the simulated asset changes to the rules (exact input debit, no
 *    other debit or approval, no leftover allowance, declared output
 *    credited); the decoded result becomes the review.
 *
 * Verify: the landed transactions are the prepared ones (quote binding),
 * then the declared event from the pinned emitter with its `where`
 * bindings, the user's deltas from receipt logs, the output floor, and the
 * pins at the receipt block.
 */
import { decodeFunctionData, encodeFunctionData, erc20Abi, getAddress, type Hex } from "viem";
import {
  CHAINS,
  CONTRACT_LIMITS,
  eventTopic,
  abiItemSignature,
  fromBaseUnits,
  nativeAssetId,
  needsApprovalReset,
  parseAssetId,
  type AssetAmount,
  type ContractReview,
  type ContractReviewApproval,
  type ContractStepCall,
  type EvmTransactionRequest,
  type IntentStep,
  type StepEvidence,
} from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { assetAmount } from "../assets.js";
import { evmChainId, evmClient, estimateEvmFeeUsd, isEvmNetwork, readAllowance, readEvmBalance, type EvmNetworkKey } from "../chains/evm.js";
import { assetChangeRows, creditsTo, flowRefusal, userFlows, type FlowLog } from "../contracts/assetChanges.js";
import { balanceOverride } from "../contracts/balanceSlots.js";
import {
  boundValues,
  callValue,
  decodeContractCall,
  decodeEvent,
  encodeContractCall,
  resolveArgs,
  reviewArgs,
  whereMatches,
  type BindingValues,
} from "../contracts/bindings.js";
import { reportContractAnomaly } from "../contracts/directory.js";
import { compareEvmPins, currentEvmPins } from "../contracts/pins.js";
import { evmCallReview } from "../contracts/review.js";
import { buildContractCallBlock, readUint, simulateEvmCalls, type SimulatedCallResult, type StateOverrides } from "../contracts/simulateEvm.js";
import { decodeStepRef } from "../stepRef.js";
import { lowestPreparedFloor, stepOwner, verifyEvmReceipts, type LandedEvmReceipt } from "./verification.js";
import type {
  AdapterAction,
  ContractCallContext,
  ContractPlannedStep,
  ContractPreparedPayload,
  ContractProtocolAdapter,
  PrepareContext,
  VerificationResult,
} from "./types.js";

/** Payload lifetime used for plan-time `$deadline` (the service's PAYLOAD_TTL_SECONDS). */
const PLAN_PAYLOAD_TTL_SECONDS = 90;
const ESTIMATED_SECONDS = 15;

type Stage = ContractCallContext["stage"];

interface EvmCallRun {
  readonly transactions: EvmTransactionRequest[];
  readonly input?: AssetAmount;
  readonly expectedOutput?: AssetAmount;
  readonly minimumOutput?: AssetAmount;
  readonly feesUsd?: number;
  readonly gas: bigint | null;
  readonly review: ContractReview;
  readonly call: ContractStepCall;
  readonly warnings: string[];
}

function invalidStep(message: string): PlatformError {
  return new PlatformError("STEP_INVALID", message, 500);
}

function callContext(action: AdapterAction): { network: EvmNetworkKey; call: ContractCallContext } {
  const call = action.call;
  if (!call || call.snapshot.vm !== "evm" || !call.snapshot.fragment || !call.snapshot.bindings || !call.snapshot.pins || !call.snapshot.events) {
    throw invalidStep("The call step has no EVM contract snapshot.");
  }
  if (!isEvmNetwork(action.network) || action.destinationNetwork !== action.network) {
    throw new PlatformError("NETWORK_UNSUPPORTED", `Custom contract calls run on the contract's own EVM network, not ${CHAINS[action.network].name}.`, 422);
  }
  return { network: action.network, call };
}

function gasFor(simulated: SimulatedCallResult | undefined): bigint | null {
  if (!simulated || simulated.gasUsed <= 0n) return null;
  return (simulated.gasUsed * BigInt(CONTRACT_LIMITS.gasMultiplierBps)) / 10_000n + BigInt(CONTRACT_LIMITS.gasOverhead);
}

function transaction(network: EvmNetworkKey, from: string, to: string, data: Hex, value: bigint, gas: bigint | null, description: string): EvmTransactionRequest {
  return {
    vm: "evm",
    network,
    chainId: evmChainId(network),
    from: getAddress(from),
    to: getAddress(to),
    data,
    value: value.toString(),
    ...(gas !== null ? { gas: gas.toString() } : {}),
    description,
  };
}

function nativeAmount(network: EvmNetworkKey, units: bigint): AssetAmount {
  const native = CHAINS[network].nativeAsset;
  return { asset: nativeAssetId(network), symbol: native.symbol, decimals: native.decimals, amount: units.toString(), formatted: fromBaseUnits(units, native.decimals) };
}

function refused(message: string): PlatformError {
  return new PlatformError("SIMULATION_ASSET_CHANGE_REFUSED", message, 422);
}

function short(value: string): string {
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

/** Native fee of `gas` at the current gas price (best effort, for the review). */
async function networkFee(network: EvmNetworkKey, gas: bigint | null, feesUsd: number | undefined): Promise<AssetAmount | undefined> {
  if (gas === null) return undefined;
  try {
    const price = await evmClient(network).getGasPrice();
    const native = CHAINS[network].nativeAsset;
    const units = gas * price;
    return {
      asset: nativeAssetId(network),
      symbol: native.symbol,
      decimals: native.decimals,
      amount: units.toString(),
      formatted: fromBaseUnits(units, native.decimals),
      ...(feesUsd !== undefined ? { usd: Math.round(feesUsd * 10_000) / 10_000 } : {}),
    };
  } catch {
    return undefined;
  }
}

/** The plan / prepare / test pipeline of one EVM call. */
async function runEvmCall(action: AdapterAction, options: { readonly now: number; readonly expiresAt?: number }): Promise<EvmCallRun> {
  const { network, call } = callContext(action);
  const stage: Stage = call.stage;
  const snapshot = call.snapshot;
  const fragment = snapshot.fragment as NonNullable<ContractStepCall["fragment"]>;
  const bindings = snapshot.bindings as NonNullable<ContractStepCall["bindings"]>;
  const pinned = snapshot.pins as NonNullable<ContractStepCall["pins"]>;
  const target = getAddress(snapshot.target);
  const label = snapshot.label ?? snapshot.entry;

  // 1. Code identity.
  const current = await currentEvmPins(network, target, pinned.addresses.map(({ label: entry, address }) => ({ label: entry, address })), { fresh: stage !== "plan" });
  const changed = compareEvmPins(pinned, current);
  if (changed) {
    await reportContractAnomaly(snapshot.contract, "pins_changed", changed);
    throw new PlatformError("CONTRACT_CHANGED", `${snapshot.integrator.name}'s contract changed since it was registered: ${changed.replace(/([^.])$/u, "$1.")} The registration is suspended until the integrator reverifies it.`, 409);
  }

  // 2. Values and calldata.
  const account = getAddress(action.account.address);
  const thirdParty = snapshot.recipientMode === "any" && action.recipient.address.toLowerCase() !== account.toLowerCase();
  if (snapshot.recipientMode !== "any" && action.recipient.address.toLowerCase() !== account.toLowerCase()) {
    throw new PlatformError("INTENT_UNSUPPORTED", `${label} pays the acting account; send the result with a separate "send" step.`, 422);
  }
  const recipient = thirdParty ? getAddress(action.recipient.address) : account;
  const input = call.input;
  const output = call.output;
  const amount = input ? BigInt(action.amount) : null;
  if (amount !== null && amount <= 0n) throw new PlatformError("AMOUNT_TOO_SMALL", `${label} would spend nothing.`, 422);
  const inputToken = input && !input.isNative && input.address ? getAddress(input.address) : null;
  const outputToken = output?.address ? getAddress(output.address) : null;
  const value = callValue(snapshot.value, amount);
  const expiresAt = options.expiresAt ?? Math.floor(options.now / 1000) + PLAN_PAYLOAD_TTL_SECONDS;
  const declarations = call.registration?.definition.actions.find((entry) => entry.id === snapshot.entry)?.params ?? [];
  const previousAsset = call.previousOutput ? parseAssetId(call.previousOutput.asset) : null;
  const values: BindingValues = {
    amount,
    account,
    recipient,
    token: inputToken,
    self: target,
    minimumOutput: null,
    deadline: BigInt(expiresAt + CONTRACT_LIMITS.deadlineSecondsAfterExpiry),
    previousAmount: call.previousOutput ? BigInt(call.previousOutput.amount) : null,
    previousAsset: previousAsset && previousAsset.assetNamespace === "erc20" ? previousAsset.reference : null,
    params: snapshot.params ?? {},
    declarations,
  };

  // 3. Approvals: exact and to the pinned spender. Stricter than "only when short": an allowance above the
  // amount (an earlier unlimited approval) is lowered to exactly the amount, so the step can never pull more.
  const spender = snapshot.approvalSpender ? getAddress(snapshot.approvalSpender) : null;
  const approvals: { data: Hex; amount: bigint }[] = [];
  let existing: bigint | null = null;
  if (inputToken && spender && amount !== null) {
    existing = stage === "plan"
      ? await readAllowance(network, inputToken, account, spender).catch(() => 0n)
      : await readAllowance(network, inputToken, account, spender);
    if (existing !== amount) {
      if (existing > 0n && needsApprovalReset(network, inputToken)) {
        approvals.push({ data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, 0n] }), amount: 0n });
      }
      approvals.push({ data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] }), amount });
    }
  }

  // 4. Balances: prepare holds the real state; plan and test may override a short balance.
  const warnings: string[] = [];
  let overrides: StateOverrides | undefined;
  let simulationNote: string | null = null;
  if (input && amount !== null) {
    const balance = await readEvmBalance(network, account, inputToken).catch((error: unknown) => {
      if (stage === "prepare") throw error;
      return 0n;
    });
    const needed = inputToken ? amount : value;
    if (balance < needed) {
      if (stage === "prepare") {
        throw new PlatformError(
          "INSUFFICIENT_BALANCE",
          `The account holds ${fromBaseUnits(balance, input.decimals)} ${input.symbol} on ${CHAINS[network].name}; ${fromBaseUnits(needed, input.decimals)} is needed.`,
          422,
        );
      }
      if (inputToken) {
        const override = await balanceOverride(network, inputToken, account, amount);
        if (override) overrides = override;
        else simulationNote = `The ${input.symbol} balance slot could not be found, so the call was not simulated before the account holds the amount.`;
      } else {
        overrides = { [account]: { balance: needed } };
      }
      if (overrides && stage === "test") warnings.push(`Simulated with a balance override: the account holds ${fromBaseUnits(balance, input.decimals)} ${input.symbol}.`);
    }
  }

  // 5. Encode and simulate (twice when the call enforces $minimumOutput on-chain).
  const usesMinimum = bindings.some(function walk(binding): boolean {
    if (binding === "$minimumOutput") return true;
    if (typeof binding === "object" && "tuple" in binding) return binding.tuple.some(walk);
    return false;
  });
  const simulate = async (minimum: bigint | null) => {
    const args = resolveArgs(fragment, bindings, { ...values, minimumOutput: minimum });
    const data = encodeContractCall(fragment, args);
    const block = buildContractCallBlock({
      account,
      recipient,
      inputToken,
      outputToken,
      spender,
      approvals: approvals.map((approval) => ({ from: account, to: inputToken as string, data: approval.data })),
      call: { from: account, to: target, data, value },
    });
    const result = simulationNote ? null : await simulateEvmCalls(network, { calls: block.calls, ...(overrides ? { overrides } : {}) });
    return { args, data, block, result };
  };
  let run = await simulate(null);
  const unavailable = !run.result || run.result.status === "unavailable";
  if (unavailable) {
    if (stage !== "plan") {
      throw new PlatformError("SIMULATION_UNAVAILABLE", `No endpoint can simulate on ${CHAINS[network].name} right now; Kletia never prepares a custom contract call unsimulated. Retry shortly.`, 503);
    }
    warnings.push(simulationNote ?? "Simulation was unavailable at planning; the call will be simulated again before signing.");
  }
  let outputCredit: bigint | null = null;
  let flowsForReview = null as ReturnType<typeof userFlows> | null;
  let simulatedBlock: bigint | null = null;
  const evaluate = (current: typeof run) => {
    if (!current.result || current.result.status !== "ok") return null;
    const calls = current.result.calls;
    const index = current.block.index;
    for (const [position, simulated] of calls.entries()) {
      if (simulated.status !== "success") {
        const what = position === index.call ? `${label}` : index.approvals.includes(position) ? "The approval" : "A balance read";
        throw new PlatformError("SIMULATION_FAILED", `${what} would revert on-chain: ${simulated.error ?? "execution reverted"}`, 422);
      }
    }
    const logs: FlowLog[] = [...index.approvals, index.call].flatMap((position) => calls[position]?.logs ?? []);
    const flows = userFlows(logs, account);
    const lastApproval = approvals[approvals.length - 1];
    const refusal = flowRefusal(flows, {
      input: input && amount !== null ? { token: inputToken ? inputToken.toLowerCase() : null, amount } : null,
      value,
      approval: inputToken && spender ? { token: inputToken, spender, amount: lastApproval?.amount ?? existing } : null,
      traced: true,
    });
    if (refusal) throw refused(refusal);
    if (inputToken && amount !== null && index.inputBefore !== null && index.inputAfter !== null) {
      const before = readUint(calls[index.inputBefore]);
      const after = readUint(calls[index.inputAfter]);
      if (before === null || after === null || before - after !== amount) {
        throw refused(`The ${input?.symbol ?? "input"} balance changes by ${before !== null && after !== null ? before - after : "an unreadable amount"}, not exactly the step amount.`);
      }
    }
    if (index.allowanceAfter !== null) {
      const left = readUint(calls[index.allowanceAfter]);
      if (left === null || left !== 0n) throw refused(`The call leaves an allowance of ${left ?? "?"} for ${spender}; it must pull exactly the approved amount.`);
    }
    let credit: bigint | null = null;
    if (outputToken && index.outputBefore !== null && index.outputAfter !== null) {
      const before = readUint(calls[index.outputBefore]);
      const after = readUint(calls[index.outputAfter]);
      const logged = creditsTo(logs, outputToken, recipient);
      if (before === null || after === null) throw refused("The declared output token's balance could not be read.");
      credit = after - before;
      if (credit <= 0n) throw refused(`The declared output ${output?.symbol ?? outputToken} is not credited to ${thirdParty ? "the recipient" : "the account"}.`);
      if (logged !== credit) throw refused(`The output token reports ${logged} in Transfer events but the balance moved ${credit}; verification could not prove it.`);
    }
    return { credit, flows, block: current.result.block };
  };
  let evaluated = evaluate(run);
  if (evaluated && usesMinimum && outputToken && evaluated.credit !== null) {
    const minimum = (evaluated.credit * BigInt(10_000 - (snapshot.toleranceBps ?? CONTRACT_LIMITS.defaultToleranceBps))) / 10_000n;
    run = await simulate(minimum);
    if (!run.result || run.result.status !== "ok") {
      if (stage !== "plan") throw new PlatformError("SIMULATION_UNAVAILABLE", `No endpoint can simulate on ${CHAINS[network].name} right now. Retry shortly.`, 503);
      evaluated = null;
    } else {
      evaluated = evaluate(run);
    }
  }
  if (evaluated) {
    outputCredit = evaluated.credit;
    flowsForReview = evaluated.flows;
    simulatedBlock = evaluated.block;
  }

  // 6. Payload, gas and review.
  const calls = run.result?.status === "ok" ? run.result.calls : [];
  const approvalTransactions = approvals.map((approval, index) => transaction(
    network,
    account,
    inputToken as string,
    approval.data,
    0n,
    gasFor(calls[run.block.index.approvals[index] as number]),
    approval.amount === 0n
      ? `Reset the ${input?.symbol} allowance of ${snapshot.integrator.name} to 0`
      : `Approve exactly ${fromBaseUnits(approval.amount, input?.decimals ?? 0)} ${input?.symbol} for ${snapshot.integrator.name} (${short(spender as string)})`,
  ));
  const callGas = gasFor(calls[run.block.index.call]);
  const callTransaction = transaction(network, account, target, run.data, value, callGas, `${label} (${snapshot.integrator.name})`);
  const transactions = [...approvalTransactions, callTransaction];
  const gasValues = transactions.map((entry) => (entry.gas ? BigInt(entry.gas) : null));
  const gas = gasValues.every((entry) => entry !== null) ? gasValues.reduce((total, entry) => (total as bigint) + (entry as bigint), 0n) : null;
  const feesUsd = gas !== null ? await estimateEvmFeeUsd(network, gas) : undefined;
  const inputAmount = input && amount !== null ? assetAmount(input, amount.toString()) : undefined;
  const tolerance = BigInt(snapshot.toleranceBps ?? CONTRACT_LIMITS.defaultToleranceBps);
  const expectedOutput = output && outputCredit !== null ? assetAmount(output, outputCredit.toString()) : undefined;
  const minimumOutput = output && outputCredit !== null ? assetAmount(output, ((outputCredit * (10_000n - tolerance)) / 10_000n).toString()) : undefined;
  const reviewApprovals: ContractReviewApproval[] = input && spender && amount !== null && approvals.some((approval) => approval.amount > 0n)
    ? [{
        token: { asset: input.id, symbol: input.symbol, decimals: input.decimals },
        spender,
        amount: assetAmount(input, amount.toString()),
        ...(existing !== null && existing > 0n ? { existingAllowance: assetAmount(input, existing.toString()) } : {}),
      }]
    : [];
  if (input && spender && amount !== null && approvals.length === 0 && existing !== null) {
    warnings.push(`Uses the existing ${input.symbol} allowance of exactly ${fromBaseUnits(existing, input.decimals)} for ${short(spender)}.`);
  }
  const at = new Date(options.now).toISOString();
  const simulationWarnings = evaluated ? [] : [simulationNote ?? "Simulation was unavailable at planning."];
  const review = evmCallReview({
    snapshot,
    ...(call.registration ? { registration: call.registration } : {}),
    network,
    args: reviewArgs(fragment, bindings, run.args, {
      ...(input ? { input: { symbol: input.symbol, decimals: input.decimals } } : {}),
      ...(output ? { output: { symbol: output.symbol, decimals: output.decimals } } : {}),
      ...(call.previousOutput ? { previous: { symbol: call.previousOutput.symbol, decimals: call.previousOutput.decimals } } : {}),
    }),
    ...(value > 0n ? { value: nativeAmount(network, value) } : {}),
    approvals: reviewApprovals,
    simulation: {
      status: evaluated ? "ok" : "unavailable",
      at,
      ...(simulatedBlock !== null ? { block: simulatedBlock.toString() } : {}),
      assetChanges: flowsForReview ? await assetChangeRows(network, flowsForReview, true) : [],
      ...(evaluated ? { networkFee: await networkFee(network, gas, feesUsd) } : {}),
      warnings: [
        ...simulationWarnings,
        ...(overrides && evaluated
          ? [stage === "plan" ? "Simulated with the step amount credited to the account (it arrives from an earlier step)." : "Simulated with a balance override: the account holds less than the amount."]
          : []),
      ],
    },
    ...(thirdParty ? { thirdPartyRecipient: recipient } : {}),
  });
  const { review: _previous, ...rest } = snapshot;
  return {
    transactions,
    ...(inputAmount ? { input: inputAmount } : {}),
    ...(expectedOutput ? { expectedOutput } : {}),
    ...(minimumOutput ? { minimumOutput } : {}),
    ...(feesUsd !== undefined ? { feesUsd } : {}),
    gas,
    review,
    call: { ...rest, review },
    warnings,
  };
}

function stripUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

/**
 * Prepare-time price check: the fresh output per unit of input must reach the
 * planned guarantee (QUOTE_MOVED otherwise; a funded step only warns, its
 * input already moved).
 */
function priceCheck(step: IntentStep, run: EvmCallRun | { readonly input?: AssetAmount; readonly expectedOutput?: AssetAmount }, funded: boolean): string | null {
  const ref = decodeStepRef(step.quoteRef);
  if (!ref?.plannedMinimum || !run.expectedOutput) return null;
  const plannedMinimum = BigInt(ref.plannedMinimum);
  const expected = BigInt(run.expectedOutput.amount);
  const plannedInput = ref.plannedInput ? BigInt(ref.plannedInput) : null;
  const moved = run.input && plannedInput
    ? expected * plannedInput < plannedMinimum * BigInt(run.input.amount)
    : expected < plannedMinimum;
  if (!moved) return null;
  const label = `${fromBaseUnits(plannedMinimum, run.expectedOutput.decimals)} ${run.expectedOutput.symbol}`;
  if (!funded) {
    throw new PlatformError("QUOTE_MOVED", `The contract now returns ${run.expectedOutput.formatted} ${run.expectedOutput.symbol}, below the planned guarantee of ${label}. Create a new intent to re-quote.`, 409);
  }
  return `The contract's rate moved since planning; it now returns ${run.expectedOutput.formatted} ${run.expectedOutput.symbol} (plan guaranteed ${label} for the planned input).`;
}

export { priceCheck as contractPriceCheck };

/* ---------------------------------------------------------------- verify */

function approvedAmount(receipts: readonly LandedEvmReceipt[], token: string, spender: string): bigint | null {
  let amount: bigint | null = null;
  for (const receipt of receipts) {
    if (!receipt.to || receipt.to.toLowerCase() !== token.toLowerCase()) continue;
    try {
      const decoded = decodeFunctionData({ abi: erc20Abi, data: receipt.input as Hex });
      if (decoded.functionName === "approve" && decoded.args[0].toLowerCase() === spender.toLowerCase()) amount = decoded.args[1];
    } catch {
      // Not an approval.
    }
  }
  return amount;
}

async function verifyCall(context: Parameters<ContractProtocolAdapter["verify"]>[0]): Promise<VerificationResult> {
  const { step } = context;
  const snapshot = step.call;
  if (!snapshot || snapshot.vm !== "evm" || !snapshot.fragment || !snapshot.bindings || !snapshot.events || !snapshot.pins || !isEvmNetwork(step.network)) {
    return { status: "failed", evidence: [], failure: { code: "STEP_INVALID", message: "The call step has no EVM contract snapshot." } };
  }
  const network = step.network;
  const fragment = snapshot.fragment;
  const bindings = snapshot.bindings;
  const target = snapshot.target;
  const account = stepOwner(step);
  const recipientAccount = step.recipient ? step.recipient.slice(step.recipient.lastIndexOf(":") + 1) : account;
  const recipient = snapshot.recipientMode === "any" ? recipientAccount : account;
  const inputAsset = step.input ? parseAssetId(step.input.asset) : null;
  const inputToken = inputAsset && inputAsset.assetNamespace === "erc20" ? inputAsset.reference.toLowerCase() : null;
  const outputAsset = snapshot.output ? parseAssetId(snapshot.output.asset) : null;
  const outputToken = outputAsset && outputAsset.assetNamespace === "erc20" ? outputAsset.reference : null;
  const observed: { output?: AssetAmount } = {};
  const evidence: StepEvidence[] = [];
  const observedAt = new Date(context.now).toISOString();
  const note = (detail: string, reference?: string): StepEvidence => ({ kind: "receipt", network, ...(reference ? { reference } : {}), observedAt, detail: detail.slice(0, 300) });
  const { result } = await verifyEvmReceipts(context, async (receipts) => {
    const landed = receipts.filter((receipt) => receipt.to?.toLowerCase() === target.toLowerCase()).pop();
    if (!landed) return { failure: { code: "OUTCOME_NOT_PROVEN", message: "No landed transaction calls the registered contract." } };
    const args = decodeContractCall(fragment, landed.input);
    if (!args) return { failure: { code: "OUTCOME_NOT_PROVEN", message: "The landed call is not the registered function." } };
    const bound = boundValues(fragment, bindings, args, "$amount");
    const amount = step.input
      ? (typeof bound[0] === "bigint" ? bound[0] : snapshot.value?.bind === "$amount" ? landed.value : null)
      : null;
    if (step.input && amount === null) return { failure: { code: "OUTCOME_NOT_PROVEN", message: "The amount could not be decoded from the landed call." } };
    const logs: FlowLog[] = receipts.flatMap((receipt) => receipt.logs.map((log) => ({ address: log.address, topics: log.topics as readonly string[], data: log.data })));
    // 1. A declared event from its pinned emitter, with matching bindings.
    let matched = false;
    let eventOutput: bigint | null = null;
    for (const declared of snapshot.events ?? []) {
      const topic0 = eventTopic(abiItemSignature(declared.fragment)).toLowerCase();
      for (const log of logs) {
        if (log.address.toLowerCase() !== declared.emitter.toLowerCase() || log.topics[0]?.toLowerCase() !== topic0) continue;
        const decoded = decodeEvent(declared.fragment, log);
        if (!decoded || !whereMatches(declared.fragment, decoded, declared.where, { account, recipient, amount, token: inputToken, self: target })) continue;
        matched = true;
        if (declared.output) {
          const value = decoded.args[declared.output];
          if (typeof value === "bigint") eventOutput = eventOutput === null ? value : eventOutput + value;
        }
      }
    }
    if (!matched) return { failure: { code: "OUTCOME_NOT_PROVEN", message: "No declared success event from the pinned emitter matches this call." } };
    evidence.push(note(`${snapshot.label ?? snapshot.entry}: declared event observed from ${target}.`, landed.reference));
    // 2. The user's deltas.
    const flows = userFlows(logs, account);
    const spender = snapshot.approvalSpender ?? null;
    const approved = inputToken && spender ? approvedAmount(receipts, inputToken, spender) : null;
    const refusal = flowRefusal(flows, {
      input: step.input && amount !== null ? { token: inputToken, amount } : null,
      value: landed.value,
      approval: inputToken && spender ? { token: inputToken, spender, amount: approved } : null,
      traced: false,
    });
    if (approved !== null && inputToken) {
      const pulled = flows.debits.get(inputToken) ?? 0n;
      if (approved > pulled) evidence.push(note(`Leftover allowance: ${approved - pulled} base units of ${step.input?.symbol ?? "the input"} remain approved to ${spender}; revoke it if unwanted.`));
    }
    if (refusal) return { failure: { code: "OUTCOME_NOT_PROVEN", message: refusal } };
    // 3. Declared output.
    if (outputToken && step.minimumOutput) {
      const credit = creditsTo(logs, outputToken, recipient);
      const floor = lowestPreparedFloor(step) ?? 1n;
      if (credit <= 0n || credit < floor) {
        return { failure: { code: "OUTCOME_NOT_PROVEN", message: `The call credited ${fromBaseUnits(credit, step.minimumOutput.decimals)} ${step.minimumOutput.symbol}, below the guaranteed ${fromBaseUnits(floor, step.minimumOutput.decimals)}.` } };
      }
      if (eventOutput !== null && eventOutput !== credit) {
        return { failure: { code: "OUTCOME_NOT_PROVEN", message: "The declared event reports a different output than the token transfers." } };
      }
      observed.output = { asset: step.minimumOutput.asset, symbol: step.minimumOutput.symbol, decimals: step.minimumOutput.decimals, amount: credit.toString(), formatted: fromBaseUnits(credit, step.minimumOutput.decimals) };
    }
    // 4. Code identity at the receipt block (latest when the node keeps no state for that block).
    const extra = (snapshot.pins?.addresses ?? []).map(({ label, address }) => ({ label, address }));
    let pins;
    let where = `block ${landed.blockNumber}`;
    try {
      pins = await currentEvmPins(network, target, extra, { blockNumber: landed.blockNumber });
    } catch {
      pins = await currentEvmPins(network, target, extra, { fresh: true });
      where = "the latest block (no state kept for the receipt block)";
    }
    const changed = compareEvmPins(snapshot.pins as NonNullable<ContractStepCall["pins"]>, pins);
    if (changed) return { failure: { code: "CONTRACT_CHANGED_DURING_EXECUTION", message: `At ${where}: ${changed}` } };
    evidence.push(note(`Contract code identity matched its pins at ${where}.`));
    return { evidence };
  });
  if (result.status === "confirmed" && observed.output) return { ...result, actualOutput: observed.output };
  return result;
}

/* ---------------------------------------------------------------- adapter */

function unsupportedEntry(): never {
  throw new PlatformError("PROTOCOL_UNSUPPORTED", "Custom contract calls are planned and prepared by the contract branch of the planner.", 500);
}

export const contractCallAdapter: ContractProtocolAdapter = {
  id: "custom-call",
  protocols: ["custom-call"],
  label: "Custom contract call",
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
    const run = await runEvmCall(action, { now: Date.now() });
    const snapshot = run.call;
    return stripUndefined({
      kind: "call" as const,
      protocol: "custom-call" as const,
      title: `${snapshot.label ?? snapshot.entry} · ${snapshot.integrator.name}`.slice(0, 160),
      mode: "wallet" as const,
      input: run.input,
      expectedOutput: run.expectedOutput,
      minimumOutput: run.minimumOutput,
      feesUsd: run.feesUsd,
      estimatedSeconds: ESTIMATED_SECONDS * run.transactions.length,
      settlement: { kind: "same-network" as const },
      warnings: run.warnings,
      transactionCount: run.transactions.length,
      slippageBps: Math.max(1, snapshot.toleranceBps ?? CONTRACT_LIMITS.defaultToleranceBps),
      call: snapshot,
      review: run.review,
      // The reviewed transactions, for the plan-time asset-change preview (simulated again there, with the intent's other steps).
      preview: { transactions: run.transactions, approvalSpender: snapshot.approvalSpender, expiresAt: Math.floor(Date.now() / 1000) + 90 },
    });
  },

  async prepareCall(context: PrepareContext): Promise<ContractPreparedPayload> {
    const { step, graph } = context;
    const run = await runEvmCall(context.action, { now: context.now, ...(context.expiresAt !== undefined ? { expiresAt: context.expiresAt } : {}) });
    const funded = graph.edges.some((edge) => edge.to === step.id && edge.kind === "funds");
    const moved = priceCheck(step, run, funded);
    return stripUndefined({
      kind: "call" as const,
      transactions: run.transactions,
      records: run.transactions.map((entry) => ({ vm: "evm" as const, network: entry.network, to: entry.to, description: entry.description })),
      input: run.input,
      expectedOutput: run.expectedOutput,
      minimumOutput: run.minimumOutput,
      feesUsd: run.feesUsd,
      warnings: moved ? [...run.warnings, moved] : run.warnings,
      review: run.review,
    });
  },

  verify: verifyCall,
};

/** Test pipeline (dry run): the prepare path with a balance override when the account is short. */
export async function testEvmCall(action: AdapterAction, now: number): Promise<EvmCallRun> {
  return runEvmCall(action, { now });
}
