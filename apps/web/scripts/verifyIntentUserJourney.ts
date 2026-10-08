import assert from "node:assert/strict";

import {
  isIntentPrivacyDecision,
  isFinancialIntent,
  redactIntentForPersistentHistory,
} from "../src/shared/privacy/defaultIntentPrivacy";
import { isIntentPrivacyTrace } from "../src/shared/privacy/intentPrivacyTrace";
import {
  beginEgressGuardObservation,
  readEgressGuardReport,
  registerPrivateField,
  resetPrivateFields,
} from "../src/shared/privacy/egressGuard";
import { isWorkflowPlanV1 } from "../src/shared/security/workflowBoundary";
import { responseIntentAction } from "../src/shared/security/entityResolution";
import {
  hasExecutableIntentActionBinding,
  type IntentResponse,
  type RouteData,
} from "../src/shared/types";

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

// Chat history keeps only a minimised prompt. Amounts and recipients on every
// supported address format must be removed before anything is persisted.
const EVM_RECIPIENT = "0x1111111111111111111111111111111111111111";
const SOLANA_RECIPIENT = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const evmTransferPrompt = `Send 25.5 USDC to ${EVM_RECIPIENT} on Base`;
const solanaTransferPrompt = `Send 25.5 USDC to ${SOLANA_RECIPIENT} on Solana`;
assert.equal(isFinancialIntent(evmTransferPrompt), true);
assert.equal(
  redactIntentForPersistentHistory(evmTransferPrompt),
  "Send [[private amount]] USDC to [[private recipient]] on Base",
);
assert.equal(
  redactIntentForPersistentHistory(solanaTransferPrompt),
  "Send [[private amount]] USDC to [[private recipient]] on Solana",
);
assert.equal(
  redactIntentForPersistentHistory("What can Kletia do on Base?"),
  "What can Kletia do on Base?",
  "Non-financial prompts must be kept verbatim.",
);

// The semantic-planner consent question offers exactly three reviewed choices.
// A response that still carries a removed option must be rejected, not rendered.
const decisionNow = Date.now();
const consentDecision = {
  schemaVersion: "kletia_intent_decision_v1",
  questionId: "semantic-planner-consent",
  kind: "privacy",
  blockingField: "semanticPlanner",
  sensitivity: "public_semantics_may_include_private_values",
  whyAsked: "The deterministic compiler could not bind this goal without natural-language interpretation.",
  question: "Allow AI-assisted interpretation for this intent?",
  options: [
    {
      id: "allow_ai_for_this_intent",
      label: "Allow once",
      description: "Interpret only this prompt with the semantic planner.",
      impact: "The prompt is visible to the model provider for this request.",
    },
    {
      id: "allow_ai_for_session",
      label: "Allow for this session",
      description: "Interpret prompts in this tab until the grant expires.",
      impact: "Prompts are visible to the model provider until expiry.",
    },
    {
      id: "edit_intent",
      label: "Edit intent",
      description: "Rewrite the goal with explicit assets, amounts and network.",
      impact: "Nothing leaves the deterministic compiler.",
    },
  ],
  network: "base",
  decisionToken: "decision-token",
  sessionDecisionToken: "session-decision-token",
  expiresAt: decisionNow + 60_000,
  sessionExpiresAt: decisionNow + 600_000,
};
assert.equal(isIntentPrivacyDecision(consentDecision, "base"), true);
assert.equal(
  isIntentPrivacyDecision(consentDecision, "arbitrum"),
  false,
  "A consent decision must stay bound to the network it was issued for.",
);
assert.equal(
  isIntentPrivacyDecision(
    {
      ...consentDecision,
      options: [
        ...consentDecision.options,
        {
          id: "open_private_composer",
          label: "Legacy option",
          description: "Removed option.",
          impact: "Removed option.",
        },
      ],
    },
    "base",
  ),
  false,
  "A removed privacy option must not be accepted.",
);

// The privacy trace labels detected field classes with a closed vocabulary.
const traceBinding = {
  requestId: "33333333-3333-4333-8333-333333333333",
  network: "base",
  chainId: 8453,
} as const;
const privacyTrace = {
  schemaVersion: "kletia_intent_privacy_trace_v1",
  traceSha256: `0x${"ab".repeat(32)}`,
  binding: traceBinding,
  stage: "planned",
  policy: "privacy_first_minimum_disclosure",
  semantic: {
    requestedMode: "deterministic_only",
    modelRequestAttemptedForThisRequest: false,
    modelInfluencedCurrentPlan: false,
    promptDisclosureToModelProviderOccurred: false,
    deterministicTransactionCompilerRequired: true,
  },
  inputBoundary: {
    rawPromptReceivedByKletiaApi: true,
    rawPromptWrittenToApplicationLogs: false,
    durablePromptPersistence: false,
    ephemeralConversationMemory: "none",
    detectedFieldClasses: ["numeric_value", "evm_address", "solana_address"],
  },
  executionBoundary: {
    actionClass: "financial_public_if_executed",
    ledgerVisibility: "route_specific_public_settlement",
    perStepWalletApprovalRequired: true,
    aiCanSignOrConstructCalldata: false,
  },
  disclosureDiff: [
    {
      phase: "planning",
      field: "natural_language_prompt",
      newlyVisibleTo: "kletia_api",
      reason: "The deterministic compiler parsed the prompt.",
    },
  ],
  limitations: ["Public settlement remains visible onchain."],
};
assert.equal(isIntentPrivacyTrace(privacyTrace, traceBinding), true);
assert.equal(
  isIntentPrivacyTrace(
    {
      ...privacyTrace,
      inputBoundary: {
        ...privacyTrace.inputBoundary,
        detectedFieldClasses: ["unreviewed_address"],
      },
    },
    traceBinding,
  ),
  false,
  "An unknown detected field class must be rejected.",
);

// A realistically guardable private value is watched by the browser egress
// guard as soon as it is registered.
const privateAmount = "1234.56789";
beginEgressGuardObservation();
assert.equal(registerPrivateField("amount", privateAmount), "guarded");
assert.equal(registerPrivateField("amount", "5"), "unguardable_low_entropy");
assert.equal(registerPrivateField("amount", "9876.54321"), "guarded");
const privacyReport = readEgressGuardReport();
assert.equal(privacyReport.guardedFields.includes("amount"), true);
assert.equal(privacyReport.unguardableFields.length, 0);
assert.equal(privacyReport.violations.length, 0);
assert.equal(privacyReport.observedNoViolation, true);
assert.equal(JSON.stringify(privacyReport).includes(privateAmount), false);
resetPrivateFields();
assert.equal(readEgressGuardReport().coverage, "inactive");

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

// The live cross-chain corridor: an Across bridge from Base, then an Arbitrum
// step that consumes the bridged output.
const baseToArbitrumWorkflow = {
  ...arcWorkflow,
  workflowId: "44444444-4444-4444-8444-444444444444",
  steps: [
    {
      id: "step-1",
      order: 1,
      action: "bridge",
      network: "base",
      chainId: 8453,
      tokenIn: "USDC",
      amount: "10",
      amountSource: "explicit",
      destinationChain: "arbitrum",
      dependsOn: [],
      status: "awaiting_signature",
    },
    {
      id: "step-2",
      order: 2,
      action: "lending_deposit",
      network: "arbitrum",
      chainId: 42161,
      tokenIn: "USDC",
      amount: "MAX",
      amountSource: "previous_output",
      dependsOn: ["step-1"],
      status: "planned",
    },
  ],
} as const;
assert.equal(
  isWorkflowPlanV1(baseToArbitrumWorkflow, {
    requestId: baseToArbitrumWorkflow.requestId,
    userAddress: baseToArbitrumWorkflow.userAddress,
    nowMs: workflowNow,
  }),
  true,
  "The browser boundary must accept the staged Base to Arbitrum workflow.",
);
assert.equal(
  isWorkflowPlanV1(
    {
      ...baseToArbitrumWorkflow,
      steps: [
        { ...baseToArbitrumWorkflow.steps[0], destinationChain: "arc" },
        baseToArbitrumWorkflow.steps[1],
      ],
    },
    {
      requestId: baseToArbitrumWorkflow.requestId,
      userAddress: baseToArbitrumWorkflow.userAddress,
      nowMs: workflowNow,
    },
  ),
  false,
  "A bridge step must only target a reviewed destination chain.",
);

// ---------------------------------------------------------------------------
// Platform execution surfaces (Studio, /embed, Solana Ask, chat handoff).
// Browser storage is replaced by in-memory stand-ins before those modules load.
// ---------------------------------------------------------------------------
const memoryStorage = () => {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, String(value)),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
    key: (index: number) => [...map.keys()][index] ?? null,
    get length() {
      return map.size;
    },
  };
};
(globalThis as unknown as { window: unknown }).window = {
  localStorage: memoryStorage(),
  sessionStorage: memoryStorage(),
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
};
// The cross-tab relay would keep Node's event loop alive; tabs do not exist here.
delete (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel;

const { detectCrossNetworkPrompt } = await import("../src/shared/platform/crossNetworkPrompt");
assert.equal(detectCrossNetworkPrompt("bridge 20 USDC from solana to base")?.reason, "route");
assert.equal(detectCrossNetworkPrompt("move 0.01 ETH from arbitrum to sol")?.reason, "route");
assert.ok(detectCrossNetworkPrompt("stake 2 SOL with jito"), "SOL amounts belong to Solana.");
assert.equal(
  detectCrossNetworkPrompt(`send 5 USDC to ${SOLANA_RECIPIENT}`)?.reason,
  "solana-address",
  "A base58 Solana address routes the prompt to the platform planner.",
);
assert.equal(detectCrossNetworkPrompt("swap 1 ETH to USDC on solana")?.reason, "solana-network");
for (const evmOnly of [
  "swap 10 USDC to ETH on base",
  "bridge 25 USDC from base to arbitrum",
  `Send 25.5 USDC to ${EVM_RECIPIENT} on Base`,
  "What can Kletia do on Base?",
  "show my portfolio solutions",
]) {
  assert.equal(detectCrossNetworkPrompt(evmOnly), null, `EVM chat keeps handling: ${evmOnly}`);
}

const { readEmbedParams } = await import("../src/app/pages/embed/embedParams");
const embed = readEmbedParams(
  "?theme=dark&text=swap%201%20SOL%20to%20USDC&examples=a,%20b%20,,A&bg=transparent&apiKey=kl_dev_secret",
);
assert.deepEqual(embed, {
  theme: "dark",
  text: "swap 1 SOL to USDC",
  examples: ["a", "b"],
  transparent: true,
});
assert.equal(JSON.stringify(embed).includes("kl_dev"), false, "The embed never reads an API key from its URL.");
assert.equal(readEmbedParams("?theme=neon").theme, "auto");
assert.equal(readEmbedParams(`?text=${"x".repeat(900)}`).text.length, 500);
assert.equal(readEmbedParams("?examples=,,").examples, null);

const session = await import("../src/shared/platform/intentSession");
const SIGNATURE = "5".repeat(87);
session.markStepSigning(session.STUDIO_INTENT_SESSION_KEY, "int_resume", "s1", "requested");
session.appendStepReference(session.STUDIO_INTENT_SESSION_KEY, "int_resume", "s1", SIGNATURE);
session.appendStepReference(session.STUDIO_INTENT_SESSION_KEY, "int_resume", "s1", "not a reference");
const stored = session.readIntentSession(session.STUDIO_INTENT_SESSION_KEY);
assert.equal(stored?.intentId, "int_resume");
assert.deepEqual(stored?.references, { s1: [SIGNATURE] }, "Only well-formed references are kept for a resume.");
assert.equal(stored?.signing.s1, "requested");
session.forgetSteps(session.STUDIO_INTENT_SESSION_KEY, "int_resume", ["s1"]);
assert.deepEqual(session.readIntentSession(session.STUDIO_INTENT_SESSION_KEY)?.references, {});
session.clearIntentSession(session.STUDIO_INTENT_SESSION_KEY);
assert.equal(session.readIntentSession(session.STUDIO_INTENT_SESSION_KEY), null);

const { syncIntentActivity } = await import("../src/shared/platform/intentActivity");
const { useActivityStore } = await import("../src/shared/sync/activityStore");
const { kletiaBus } = await import("../src/shared/sync/bus");
const invalidated: string[] = [];
kletiaBus.on("portfolio.invalidated", (event) => invalidated.push(`${event.network}:${event.account}`));
const EVM_ACCOUNT = `eip155:8453:${EVM_RECIPIENT}` as const;
const SOLANA_ACCOUNT = `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:${SOLANA_RECIPIENT}` as const;
const TX_HASH = `0x${"ab".repeat(32)}`;
const bridgeStep = {
  id: "s1",
  index: 0,
  kind: "bridge",
  title: "Bridge 25 USDC from Base to Solana",
  network: "base",
  chain: "eip155:8453",
  account: EVM_ACCOUNT,
  protocol: "relay",
  mode: "wallet",
  dependsOn: [],
  settlement: { kind: "cross-network", destinationNetwork: "solana" },
  status: "settling",
  evidence: [],
  references: [TX_HASH],
};
const bridgeIntent = {
  id: "int_bridge",
  status: "settling",
  request: { text: "bridge 25 USDC from base to solana", accounts: [EVM_ACCOUNT, SOLANA_ACCOUNT] },
  steps: [bridgeStep],
} as unknown as Parameters<typeof syncIntentActivity>[0];
syncIntentActivity(bridgeIntent);
let entry = useActivityStore.getState().entries.find((item) => item.id === "intent:int_bridge:s1");
assert.equal(entry?.status, "pending", "A submitted step shows as pending activity.");
assert.equal(invalidated.length, 0, "Balances are only invalidated once a step settles or fails.");
const settledIntent = {
  ...bridgeIntent,
  status: "completed",
  steps: [{ ...bridgeStep, status: "settled" }],
} as unknown as Parameters<typeof syncIntentActivity>[0];
syncIntentActivity(settledIntent);
syncIntentActivity(settledIntent);
entry = useActivityStore.getState().entries.find((item) => item.id === "intent:int_bridge:s1");
assert.equal(entry?.status, "confirmed");
assert.equal(entry?.reference, TX_HASH);
assert.equal(entry?.url, `https://basescan.org/tx/${TX_HASH}`);
assert.deepEqual(
  invalidated,
  [`base:${EVM_ACCOUNT}`, `solana:${SOLANA_ACCOUNT}`],
  "A settled cross-network step invalidates the source and destination portfolios exactly once.",
);

const { stepDisplayPhase, withLocalPhases } = await import("../src/app/site/intent/stepPhase");
const readyStep = { ...bridgeStep, status: "ready" } as unknown as Parameters<typeof stepDisplayPhase>[0];
assert.equal(stepDisplayPhase(readyStep), "ready");
assert.equal(stepDisplayPhase(readyStep, "signing"), "awaiting_signature");
assert.equal(stepDisplayPhase({ ...readyStep, status: "confirmed" }), "settling");
assert.equal(
  withLocalPhases({ ...bridgeIntent, steps: [readyStep] }, { s1: "confirming" }).steps[0]?.status,
  "submitted",
);

console.log(
  "Intent-driven user journey verified: staged workflow binding, minimised chat history for EVM and Solana recipients, three-option semantic consent, privacy trace vocabulary, egress guard registration, wallet-bound Arc and Base to Arbitrum workflow plans, cross-network chat handoff detection, /embed parameters, resumable intent sessions, intent activity sync and step phases.",
);
