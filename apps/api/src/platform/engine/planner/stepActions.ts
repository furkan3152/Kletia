/**
 * Maps planned steps back to intent actions.
 */
import {
  CHAINS,
  getYieldVenue,
  nativeAssetId,
  parseAccountId,
  fundedFlow,
  fundingParent,
  parentCreditFromGraph,
  type AssetAmount,
  type IntentGraph,
  type IntentStep,
} from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { ownAccountOn, parseAccounts } from "../accounts.js";
import { recordedVenueId } from "../adapters/lending/common.js";
import type { AdapterAction } from "../adapters/types.js";
import { assetFromRef } from "../assets.js";
import { normalizeName } from "../names.js";
import { decodeStepRef } from "../stepRef.js";
import { CONTRACT_KINDS, DEFAULT_SLIPPAGE_BPS } from "./shared.js";

/**
 * Rebuilds the adapter action for a step at prepare time. A step funded by a
 * previous step spends its share of that step's observed output when known,
 * otherwise of its guaranteed minimum, minus its planned gas reserve (F3, F6;
 * core flow.ts). A leg planned with gas on arrival asks the same top-up again.
 */
export function actionForStep(graph: IntentGraph, step: IntentStep): AdapterAction {
  if (CONTRACT_KINDS.includes(step.kind)) return contractActionForStep(graph, step);
  if (!step.input || !step.minimumOutput) {
    throw new PlatformError("STEP_INVALID", "The step has no input or output amounts.", 500);
  }
  const account = parseAccountId(step.account);
  if (!account) throw new PlatformError("STEP_INVALID", "The step account is invalid.", 500);
  const recipient = step.recipient ? parseAccountId(step.recipient) : account;
  if (!recipient) throw new PlatformError("STEP_INVALID", "The step recipient is invalid.", 500);
  const ref = decodeStepRef(step.quoteRef);
  const input = assetFromRef(step.input);
  const destinationNetwork = step.settlement?.destinationNetwork ?? step.network;
  const output = step.kind === "transfer" || step.kind === "deposit" || step.kind === "withdraw" ? input : assetFromRef(step.minimumOutput);
  const venueId = recordedVenueId(step);
  const venue = venueId ? getYieldVenue(venueId) : null;
  if (venueId && (!venue || venue.network !== step.network || venue.protocol !== step.protocol)) {
    throw new PlatformError("STEP_INVALID", "The step's venue is not in the registry for its network and protocol.", 500);
  }
  const slippageBps = ref?.slippageBps ?? graph.request.constraints?.maxSlippageBps ?? DEFAULT_SLIPPAGE_BPS;
  const amount = fundedAmount(graph, step, step.input, ref, slippageBps).amount;
  const accounts = parseAccounts(graph.request.accounts);
  // Same derivation as at plan time, from the intent's own accounts.
  const destinationAccount = destinationNetwork !== step.network ? ownAccountOn(accounts, destinationNetwork) : undefined;
  return {
    kind: step.kind,
    network: step.network,
    destinationNetwork,
    input,
    output,
    amount,
    account,
    recipient,
    slippageBps,
    ...(ref?.provider ? { provider: ref.provider } : {}),
    ...(venue ? { venue: venue.id } : {}),
    ...(ref?.closePosition && step.kind === "withdraw" ? { closePosition: true } : {}),
    ...(destinationAccount ? { destinationAccount } : {}),
    ...(ref?.gasTopupUsd !== undefined && step.gasTopup ? { gasTopupUsd: ref.gasTopupUsd } : {}),
  };
}

/**
 * The amount a step executes now (core flow.ts): its share of the funding
 * step's observed output (else guaranteed minimum), minus its gas reserve,
 * and for a third-party recipient never more than the planned input plus
 * slippage (a larger funding output, e.g. a "withdraw all" position that
 * grew or positive slippage, stays with the user).
 */
function fundedAmount(
  graph: IntentGraph,
  step: IntentStep,
  input: AssetAmount,
  ref: ReturnType<typeof decodeStepRef>,
  slippageBps: number,
): { amount: string; funded: boolean } {
  if (!fundingParent(graph, step)) return { amount: input.amount, funded: false };
  const credit = parentCreditFromGraph(graph, { ...step, input });
  let amount = input.amount;
  if (credit) {
    const flow = fundedFlow(graph, { ...step, input }, credit, {
      slippageBps,
      plannedInput: BigInt(ref?.plannedInput ?? input.amount),
      ...(ref?.portionBps !== undefined ? { portionBps: ref.portionBps } : {}),
    });
    amount = flow.spends.worst.toString();
  }
  if (amount === "0") {
    throw new PlatformError(
      "AMOUNT_TOO_SMALL",
      step.funding?.gasReserve
        ? `The funding step delivered too little to continue after keeping ${step.funding.gasReserve.formatted} ${step.funding.gasReserve.symbol} for network fees.`
        : "The funding step produced too little to continue.",
      422,
    );
  }
  return { amount, funded: true };
}

/**
 * Prepare-time action of a call / action step: the step's own snapshot, its
 * (funded) amount, and the previous step's observed output for `$previous`
 * bindings. The service adds the re-read registration before the adapter runs.
 */
function contractActionForStep(graph: IntentGraph, step: IntentStep): AdapterAction {
  if (!step.call) throw new PlatformError("STEP_INVALID", "The call step has no contract snapshot.", 500);
  const account = parseAccountId(step.account);
  if (!account) throw new PlatformError("STEP_INVALID", "The step account is invalid.", 500);
  const recipient = step.recipient ? parseAccountId(step.recipient) : account;
  if (!recipient) throw new PlatformError("STEP_INVALID", "The step recipient is invalid.", 500);
  const ref = decodeStepRef(step.quoteRef);
  const input = step.input ? assetFromRef(step.input) : null;
  const output = step.call.output ? assetFromRef(step.call.output) : null;
  let amount = "0";
  let funded = false;
  if (step.input) {
    ({ amount, funded } = fundedAmount(graph, step, step.input, ref, ref?.slippageBps ?? DEFAULT_SLIPPAGE_BPS));
  }
  const parent = graph.steps.find((candidate) => candidate.id === step.dependsOn[0]);
  // `$previous.*` reads the previous step's output when it lands on this step's network.
  const previousOutput = parent && (parent.settlement?.destinationNetwork ?? parent.network) === step.network
    ? parent.actualOutput ?? parent.minimumOutput
    : undefined;
  const placeholder = input ?? assetFromRef({
    asset: nativeAssetId(step.network),
    symbol: CHAINS[step.network].nativeAsset.symbol,
    decimals: CHAINS[step.network].nativeAsset.decimals,
  });
  return {
    kind: step.kind,
    network: step.network,
    destinationNetwork: step.network,
    input: placeholder,
    output: output ?? placeholder,
    amount,
    account,
    recipient,
    slippageBps: ref?.slippageBps ?? DEFAULT_SLIPPAGE_BPS,
    call: {
      snapshot: step.call,
      input,
      output,
      ...(previousOutput ? { previousOutput } : {}),
      funded,
      stage: "prepare",
    },
  };
}

/** Normalised recipient name of a step, when it was planned from one (service re-resolves it before prepare). */
export function stepRecipientName(step: IntentStep): string | null {
  return step.recipientName && step.recipient ? normalizeName(step.recipientName) : null;
}
