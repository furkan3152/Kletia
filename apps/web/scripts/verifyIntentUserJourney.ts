import assert from "node:assert/strict";

import {
  beginPrivateIntentObservation,
  commitPrivateField,
  forgetPrivateFieldGuards,
  redactPrivatePrompt,
  resolvePrivateIntentSelection,
} from "../src/networks/stellar/runtime/privateIntent";
import { resolveStellarWorkspaceIntent } from "../src/networks/stellar/runtime/intentWorkspace";
import { readEgressGuardReport } from "../src/shared/privacy/egressGuard";
import { isWorkflowPlanV1 } from "../src/shared/security/workflowBoundary";
import { responseIntentAction } from "../src/shared/security/entityResolution";
import {
  hasExecutableIntentActionBinding,
  type IntentResponse,
  type RouteData,
} from "../src/shared/types";

const USER_PROMPT =
  "USDC bakiyemi en mantikli yerde degerlendir ve guvenli borc gucumu soyle.";
const EXPECTED_SCENARIO =
  "arc_testnet_usdc_to_arbitrum_sepolia_aave_supply" as const;

const stagedExecutionResponse = {
  status: "success",
  action: "workflow",
  actionType: "swap",
  executionKind: "workflow_plan_v1",
} as IntentResponse;
const stagedExecutionRoute = { action: "swap" } as RouteData;
assert.equal(responseIntentAction(stagedExecutionResponse), "swap");
assert.equal(
  hasExecutableIntentActionBinding(stagedExecutionResponse, stagedExecutionRoute),
  true,
  "A staged plan must retain its workflow identity without rejecting the current wallet-bound action.",
);

// The first pass deliberately lacks network and protocol bindings. A real user
// should receive a structured question instead of an inferred money movement.
const unresolved = resolvePrivateIntentSelection({ prompt: USER_PROMPT });
assert.equal(unresolved.status, "clarification");
if (unresolved.status !== "clarification") {
  throw new Error("The ambiguous user goal did not produce a clarification card.");
}
assert.equal(
  unresolved.clarification.question,
  "Which reviewed outcome should Kletia compile?",
);
const selectedOption = unresolved.clarification.options.find(
  (option) => option.scenarioId === EXPECTED_SCENARIO,
);
assert.ok(selectedOption, "The reviewed Arc-to-Arbitrum outcome was not offered.");
assert.equal(selectedOption.selectable, true);
assert.equal(selectedOption.executionReadiness, "executable");

// This mirrors a user pressing the clarification card and then choosing the
// reviewed direct public corridor. The selected structured state, not a prompt
// suffix, becomes the compiler input.
const resolved = resolvePrivateIntentSelection({
  prompt: USER_PROMPT,
  scenarioId: selectedOption.scenarioId,
  routePreference: "direct_cctp",
});
assert.equal(resolved.status, "resolved");
if (resolved.status !== "resolved") {
  throw new Error("The selected clarification option did not resolve the intent.");
}
assert.equal(resolved.scenarioId, EXPECTED_SCENARIO);
assert.equal(resolved.routePreference, "direct_cctp");

// Use a realistically guardable amount. Only its commitment may enter the
// planning receipt; the raw prompt and exact amount must be absent from the
// semantic envelope that crosses the AI/API boundary.
const privateAmount = "1234.56789";
const deterministicSalt = new Uint8Array(32).fill(0x5a);
beginPrivateIntentObservation();
const amountCommitment = await commitPrivateField(
  "amount",
  privateAmount,
  deterministicSalt,
);
const semanticEnvelope = redactPrivatePrompt({
  prompt: USER_PROMPT,
  scenarioId: resolved.scenarioId,
  routePreference: resolved.routePreference,
  includeBorrowCapacity: true,
});

assert.match(
  semanticEnvelope,
  /scenario=arc_testnet_usdc_to_arbitrum_sepolia_aave_supply/u,
);
assert.match(semanticEnvelope, /stellar_policy_center=false/u);
assert.match(semanticEnvelope, /include_borrow_capacity=true/u);
assert.match(semanticEnvelope, /amount_slot=\[\[private:amount\]\]/u);
assert.equal(semanticEnvelope.includes(USER_PROMPT), false);
assert.equal(semanticEnvelope.includes(privateAmount), false);
assert.match(amountCommitment, /^0x[a-f\d]{64}$/u);

const privacyReport = readEgressGuardReport();
assert.equal(privacyReport.guardedFields.includes("amount"), true);
assert.equal(privacyReport.violations.length, 0);
assert.equal(privacyReport.observedNoViolation, true);

forgetPrivateFieldGuards();

const stellarTransfer = resolveStellarWorkspaceIntent(
  "Send 5 USDC to GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF on Stellar",
);
assert.equal(stellarTransfer.kind, "transfer");
assert.equal(stellarTransfer.amount, "5");
assert.equal(stellarTransfer.assetIn, "USDC");
assert.equal(
  stellarTransfer.recipient,
  "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
);

const stellarSwap = resolveStellarWorkspaceIntent(
  "Alıcı tam 20 USDC alsın, en fazla 100 XLM harca",
);
assert.equal(stellarSwap.kind, "swap");
assert.equal(stellarSwap.assetIn, "XLM");
assert.equal(stellarSwap.assetOut, "USDC");
assert.equal(stellarSwap.strictReceive, true);
assert.equal(stellarSwap.readyToPrepare, true);

const stellarBuy = resolveStellarWorkspaceIntent("Buy 5 XLM with USDC on Stellar");
assert.equal(stellarBuy.kind, "swap");
assert.equal(stellarBuy.assetIn, "USDC");
assert.equal(stellarBuy.assetOut, "XLM");
assert.equal(stellarBuy.strictReceive, true);

const incompleteStellarSwap = resolveStellarWorkspaceIntent("Swap XLM to USDC");
assert.equal(incompleteStellarSwap.kind, "swap");
assert.equal(incompleteStellarSwap.readyToPrepare, false);
assert.deepEqual(incompleteStellarSwap.missingFields, ["amount"]);

const cappedStrictReceive = resolveStellarWorkspaceIntent(
  "Alıcı tam 20 USDC alsın, en fazla 100 XLM harca",
);
assert.equal(cappedStrictReceive.kind, "swap");
assert.equal(cappedStrictReceive.strictReceive, true);
assert.equal(cappedStrictReceive.amount, "20");
assert.equal(cappedStrictReceive.maximumSend, "100");

const incompleteStellarTransfer = resolveStellarWorkspaceIntent("Send 5 USDC on Stellar");
assert.equal(incompleteStellarTransfer.kind, "transfer");
assert.equal(incompleteStellarTransfer.readyToPrepare, false);
assert.deepEqual(incompleteStellarTransfer.missingFields, ["recipient"]);

const unsupportedEurcTransfer = resolveStellarWorkspaceIntent(
  "Send 5 EURC to GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF on Stellar",
);
assert.equal(unsupportedEurcTransfer.kind, "unknown");
assert.equal(unsupportedEurcTransfer.readyToPrepare, false);

const unsupportedStellarSwap = resolveStellarWorkspaceIntent(
  "Buy KLET with 5 USDC on Stellar",
);
assert.equal(unsupportedStellarSwap.kind, "unknown");
assert.equal(unsupportedStellarSwap.readyToPrepare, false);
assert.match(unsupportedStellarSwap.blockingReason || "", /KLET/u);

const privatePaymentLab = resolveStellarWorkspaceIntent("Make a private XLM payment");
assert.equal(privatePaymentLab.kind, "unknown");
assert.equal(privatePaymentLab.readyToPrepare, false);
assert.match(privatePaymentLab.blockingReason || "", /research.+default Payment Center/u);
assert.equal(
  resolveStellarWorkspaceIntent("Enable the Circle USDC trustline").kind,
  "trustline",
);
assert.equal(
  resolveStellarWorkspaceIntent("Move 5 USDC from Arc to Arbitrum Sepolia").kind,
  "unknown",
);
const reviewedCrossChain = resolveStellarWorkspaceIntent(
  "Move [[private amount]] USDC from Arc to Arbitrum Sepolia and supply it to Aave",
);
assert.equal(reviewedCrossChain.kind, "unknown");
assert.equal(reviewedCrossChain.readyToPrepare, false);
assert.match(reviewedCrossChain.blockingReason || "", /source-network/u);
const fundedCrossChain = resolveStellarWorkspaceIntent(
  "Move 5 USDC from Arc to Arbitrum Sepolia and supply it to Aave",
);
assert.equal(fundedCrossChain.kind, "unknown");
assert.equal(fundedCrossChain.readyToPrepare, false);
const unsupportedCrossChain = resolveStellarWorkspaceIntent(
  "Move 5 USDC from Base to Arc and stake it",
);
assert.equal(unsupportedCrossChain.kind, "unknown");
assert.equal(unsupportedCrossChain.readyToPrepare, false);
assert.equal(resolveStellarWorkspaceIntent("do something clever").kind, "unknown");

const workflowNow = Date.now();
const arcWorkflow = {
  version: 1,
  workflowId: "11111111-1111-4111-8111-111111111111",
  requestId: "22222222-2222-4222-8222-222222222222",
  userAddress: "0x1111111111111111111111111111111111111111",
  createdAt: workflowNow,
  expiresAt: workflowNow + 60_000,
  objective: "risk_adjusted_net_return",
  atomicity: {
    sameChain: "wallet_batch_when_verified",
    crossChain: "staged_checkpointed_no_global_rollback",
  },
  hardPolicies: {
    minimumHealthFactor: "1.5",
    requiresPerStepWalletApproval: true,
    mockDataAllowed: false,
  },
  currentStepIndex: 0,
  steps: [
    {
      id: "step-1",
      order: 1,
      action: "swap",
      network: "arc",
      chainId: 5042002,
      tokenIn: "USDC",
      tokenOut: "KLET",
      amount: "5",
      amountSource: "explicit",
      dependsOn: [],
      status: "awaiting_signature",
    },
    {
      id: "step-2",
      order: 2,
      action: "lending_deposit",
      network: "arc",
      chainId: 5042002,
      tokenIn: "KLET",
      amount: "MAX",
      amountSource: "previous_output",
      dependsOn: ["step-1"],
      status: "planned",
    },
  ],
} as const;
assert.equal(
  isWorkflowPlanV1(arcWorkflow, {
    requestId: arcWorkflow.requestId,
    userAddress: arcWorkflow.userAddress,
    nowMs: workflowNow,
  }),
  true,
  "The browser boundary must accept a wallet-bound Arc staged workflow.",
);

console.log(
  "Intent-driven user journey verified: Stellar native intent routing plus ambiguous multichain goal -> clarification -> structured selection -> private commitment -> deterministic semantic receipt.",
);
