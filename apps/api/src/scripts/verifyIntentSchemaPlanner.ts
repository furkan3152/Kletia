import assert from "node:assert/strict";

import {
  IntentSchema,
  parseDeterministicArcIntent,
  parseDeterministicArbitrumIntent,
  parseUserIntent,
  structuredIntentResponseFormat,
} from "../shared/ai/parser.js";
import { normalizeWorkflowSteps } from "../cross-chain/workflow.js";
import { enforceReviewedStellarIntent } from "../networks/stellar/intentParser.js";
import { computeSolverBidCommitment } from "../networks/stellar/solverBidCommitment.js";

const format = structuredIntentResponseFormat("base");
assert.equal(format.type, "json_schema");
assert.equal(format.json_schema.strict, true);
assert.equal(format.json_schema.schema.additionalProperties, false);
assert.ok(format.json_schema.schema.required.includes("workflowSteps"));
const workflow = format.json_schema.schema.properties.workflowSteps;
assert.equal(workflow.maxItems, 8);
assert.equal(workflow.items.additionalProperties, false);
assert.deepEqual(
  new Set(workflow.items.required),
  new Set(Object.keys(workflow.items.properties)),
  "Strict provider output must explicitly return every staged-step field or null.",
);

const staged = IntentSchema.parse({
  isComplete: true,
  action: "workflow",
  message: "Prepare the reviewed staged route.",
  tokenIn: "USDC",
  amount: "5",
  workflowSteps: [
    {
      action: "swap",
      network: "base",
      tokenIn: "USDC",
      tokenOut: "ETH",
      amount: "5",
      amountSource: "explicit",
    },
    {
      action: "bridge",
      network: "base",
      tokenIn: "ETH",
      amount: "MAX",
      amountSource: "previous_output",
      destinationChain: "arbitrum",
      protocol: "across",
    },
    {
      action: "lend",
      network: "arbitrum",
      tokenIn: "ETH",
      amount: "MAX",
      amountSource: "previous_output",
      protocol: "aave-v3",
    },
  ],
});
assert.equal(staged.workflowSteps?.length, 3);
assert.equal(staged.workflowSteps?.[1]?.amountSource, "previous_output");

const arcFormat = structuredIntentResponseFormat("arc");
assert.ok(
  arcFormat.json_schema.schema.properties.action.enum.includes("workflow"),
  "Arc must be able to return a staged intent instead of collapsing it to one action.",
);
const arcStaged = IntentSchema.parse({
  isComplete: true,
  action: "workflow",
  message: "Swap and deposit the verified output.",
  tokenIn: "USDC",
  tokenOut: "KLET",
  amount: "5",
  workflowSteps: [
    {
      action: "swap",
      network: "arc",
      tokenIn: "USDC",
      tokenOut: "KLET",
      amount: "5",
      amountSource: "explicit",
    },
    {
      action: "lend",
      network: "arc",
      tokenIn: "KLET",
      amount: "MAX",
      amountSource: "previous_output",
      protocol: "kletia",
    },
  ],
});
const normalizedArc = normalizeWorkflowSteps(arcStaged, "arc");
assert.equal(normalizedArc[0]?.action, "swap");
assert.equal(normalizedArc[1]?.action, "lending_deposit");
assert.equal(normalizedArc[1]?.amountSource, "previous_output");
assert.equal(normalizedArc[1]?.dependsOn[0], "step-1");

const deterministicArcWorkflow = parseDeterministicArcIntent(
  "Swap 5 USDC to KLET on Arc, then lend all resulting KLET",
);
assert.equal(deterministicArcWorkflow?.action, "workflow");
assert.deepEqual(
  deterministicArcWorkflow?.workflowSteps?.map((step) => ({
    action: step.action,
    tokenIn: step.tokenIn,
    tokenOut: step.tokenOut,
    amount: step.amount,
    amountSource: step.amountSource,
  })),
  [
    {
      action: "swap",
      tokenIn: "USDC",
      tokenOut: "KLET",
      amount: "5",
      amountSource: "explicit",
    },
    {
      action: "lend",
      tokenIn: "KLET",
      tokenOut: undefined,
      amount: "MAX",
      amountSource: "previous_output",
    },
  ],
);
assert.equal(
  parseDeterministicArcIntent(
    "Swap 5 USDC to KLET on Arc, then lend all resulting USDC",
  )?.isComplete,
  false,
  "A staged Arc intent must stop locally instead of binding a mismatched downstream asset or requesting AI.",
);
const explicitArcWorkflow = parseDeterministicArcIntent(
  "swap 5 usdc to klet after this lend 3 klet after borrow 1 usdc",
);
assert.equal(explicitArcWorkflow?.action, "workflow");
assert.equal(explicitArcWorkflow?.isComplete, true);
assert.deepEqual(
  explicitArcWorkflow?.workflowSteps?.map((step) => ({
    action: step.action,
    amount: step.amount,
    tokenIn: step.tokenIn,
    amountSource: step.amountSource,
  })),
  [
    { action: "swap", amount: "5", tokenIn: "USDC", amountSource: "explicit" },
    { action: "lend", amount: "3", tokenIn: "KLET", amountSource: "explicit" },
    { action: "borrow", amount: "1", tokenIn: "USDC", amountSource: "explicit" },
  ],
);
const scaledArcSale = parseDeterministicArcIntent(
  "sell 1.25 million klet after this lend 5 usdc",
);
assert.equal(scaledArcSale?.isComplete, false);
assert.match(
  scaledArcSale?.question || "",
  /accepts KLET as collateral/u,
  "The two-asset Arc market should infer sale output but refuse an invalid USDC collateral step locally.",
);
assert.equal(
  parseDeterministicArcIntent("stake 2 native usdc on Arc Testnet")?.action,
  "stake",
  "A high-confidence single Arc action should not require semantic-model consent.",
);
const naturalArcBridge = parseDeterministicArcIntent(
  "bridge 5 USDC from Arc to Arbitrum Sepolia",
);
assert.equal(naturalArcBridge?.action, "appkit_bridge");
assert.equal(naturalArcBridge?.destinationChain, "arbitrum-sepolia");
assert.equal(naturalArcBridge?.isComplete, false);
assert.match(naturalArcBridge?.question || "", /EVM address/u);
const completeNaturalArcBridge = parseDeterministicArcIntent(
  "move 5 USDC from Arc Testnet to Arbitrum Sepolia for 0x1111111111111111111111111111111111111111",
);
assert.equal(completeNaturalArcBridge?.action, "appkit_bridge");
assert.equal(completeNaturalArcBridge?.isComplete, true);
assert.equal(
  completeNaturalArcBridge?.recipient,
  "0x1111111111111111111111111111111111111111",
);

const deterministicArbitrumSwap = parseDeterministicArbitrumIntent(
  "Swap 0.001 WETH to USDC on Arbitrum with maximum 0.5% slippage.",
);
assert.equal(deterministicArbitrumSwap?.action, "swap");
assert.equal(deterministicArbitrumSwap?.tokenIn, "WETH");
assert.equal(deterministicArbitrumSwap?.tokenOut, "USDC");
assert.equal(deterministicArbitrumSwap?.slippage, "0.5");

const deterministicArbitrumWorkflow = parseDeterministicArbitrumIntent(
  "Swap 10 USDC to WETH on Arbitrum, then lend all resulting WETH",
);
assert.equal(deterministicArbitrumWorkflow?.action, "workflow");
assert.deepEqual(
  deterministicArbitrumWorkflow?.workflowSteps?.map((step) => ({
    action: step.action,
    tokenIn: step.tokenIn,
    tokenOut: step.tokenOut,
    amountSource: step.amountSource,
  })),
  [
    { action: "swap", tokenIn: "USDC", tokenOut: "WETH", amountSource: "explicit" },
    { action: "lend", tokenIn: "WETH", tokenOut: undefined, amountSource: "previous_output" },
  ],
);
assert.equal(
  parseDeterministicArbitrumIntent(
    "Swap 10 USDC to WETH on Arbitrum, then lend all resulting ARB",
  )?.isComplete,
  false,
  "An Arbitrum workflow must stop locally instead of silently binding a different downstream asset.",
);
assert.equal(
  parseDeterministicArbitrumIntent("Swap 0.001 ETH to USDC on Arbitrum")?.isComplete,
  false,
  "Native ETH must produce an explicit WETH clarification instead of an AI consent prompt.",
);
const groundedArbitrumWorkflow = await parseUserIntent(
  "Swap 10 USDC to WETH on Arbitrum, then lend all resulting WETH",
  [],
  "arbitrum",
  { semanticPlanner: "deterministic_only" },
);
assert.equal(groundedArbitrumWorkflow.action, "workflow");
assert.equal(groundedArbitrumWorkflow.isComplete, true);
assert.throws(
  () => normalizeWorkflowSteps({
    ...arcStaged,
    workflowSteps: [
      arcStaged.workflowSteps![0],
      {
        ...arcStaged.workflowSteps![1],
        tokenIn: "USDC",
      },
    ],
  }, "arc"),
  /preceding output only when both assets match exactly/u,
);
assert.throws(
  () => normalizeWorkflowSteps({
    ...arcStaged,
    workflowSteps: [
      arcStaged.workflowSteps![0],
      { ...arcStaged.workflowSteps![1], network: "arbitrum" },
    ],
  }, "arc"),
  /cannot silently execute a step on another network/u,
);

const validCorridor = enforceReviewedStellarIntent({
  kind: "cross_chain",
  title: "Move and supply USDC",
  summary: "Move Arc USDC to Arbitrum Sepolia and supply it.",
  nextStep: "Review the stages.",
  amount: "25",
  assetIn: "USDC",
  assetOut: "USDC",
  recipient: "0x1111111111111111111111111111111111111111",
  strictReceive: false,
  readyToPrepare: true,
  blockingReason: null,
  stages: [
    {
      action: "bridge",
      network: "arc_testnet",
      assetIn: "USDC",
      assetOut: "USDC",
      amountSource: "explicit",
    },
    {
      action: "supply",
      network: "arbitrum_sepolia",
      assetIn: "USDC",
      assetOut: null,
      amountSource: "previous_output",
    },
    {
      action: "borrow_capacity",
      network: "arbitrum_sepolia",
      assetIn: "USDC",
      assetOut: null,
      amountSource: "not_required",
    },
  ],
  missingFields: [],
});
assert.equal(validCorridor.readyToPrepare, false);
assert.match(validCorridor.blockingReason || "", /source-network workspace/u);

const hallucinatedCorridor = enforceReviewedStellarIntent({
  ...validCorridor,
  stages: [
    {
      action: "bridge",
      network: "stellar_testnet",
      assetIn: "EURC",
      assetOut: "XLM",
      amountSource: "explicit",
    },
  ],
});
assert.equal(hallucinatedCorridor.readyToPrepare, false);
assert.match(hallucinatedCorridor.blockingReason || "", /source-network workspace/u);

const releaseVector = {
  schemaVersion: "kletia_solver_bid_secret_v1",
  auctionContract: "CCFY5ZJJ5CILIOPD7LUYRRQ3XCO2OUUL3ZMZQER4IWQ6XO7ZLVWBBP5D",
  workflowRoot: `0x${"11".repeat(32)}`,
  solver: "GDKHTBTURCFYXVNBRIXTUFGIS76TOZGBOA52VAYFKTMWXELDBGA4E5CN",
  routeHash: `0x${"22".repeat(32)}`,
  quoteEvidenceHash: `0x${"33".repeat(32)}`,
  promisedOutputAtomic: "1234567",
  solverFeeAtomic: "1234",
  durationSeconds: 321,
  quoteExpiresAtLedger: 987654,
  salt: `0x${"44".repeat(32)}`,
} as const;
assert.equal(
  computeSolverBidCommitment(releaseVector),
  "0x46f4ff28bb98647369cc77c774828e163b9414108035752867bbd3cdff2c82af",
  "The API-side reference solver commitment must match the Rust and browser vector.",
);

console.log(
  "Structured staged intent schema, reviewed Stellar stage gates, and solver commitment vector verified.",
);
