import assert from "node:assert/strict";

import {
  IntentDisclosureConsentRequiredError,
  parseDeterministicArcIntent,
  parseDeterministicArbitrumIntent,
  parseDeterministicBaseIntent,
  parseUserIntent,
  type ParsedIntent,
} from "../shared/ai/parser.js";
import { normalizeWorkflowSteps } from "../cross-chain/workflow.js";
import { interpretStellarIntent } from "../networks/stellar/intentParser.js";
import { resolveIntentEntities } from "../shared/assets/resolver.js";

function expectIntent(
  intent: ParsedIntent | null,
  expected: {
    readonly action: string;
    readonly complete?: boolean;
    readonly amount?: string;
    readonly tokenIn?: string;
    readonly tokenOut?: string;
    readonly steps?: readonly string[];
  },
  label: string,
) {
  assert.ok(intent, `${label}: expected a locally resolved intent.`);
  assert.equal(intent.action, expected.action, `${label}: action`);
  assert.equal(intent.isComplete, expected.complete ?? true, `${label}: completeness`);
  if (expected.amount !== undefined) assert.equal(intent.amount, expected.amount, `${label}: amount`);
  if (expected.tokenIn !== undefined) assert.equal(intent.tokenIn, expected.tokenIn, `${label}: input asset`);
  if (expected.tokenOut !== undefined) assert.equal(intent.tokenOut, expected.tokenOut, `${label}: output asset`);
  if (expected.steps) {
    assert.deepEqual(
      intent.workflowSteps?.map((step) => step.action),
      expected.steps,
      `${label}: ordered steps`,
    );
  }
}

// Base: common reads and transactions stay deterministic; only the reviewed
// source-chain workflow is composed locally.
expectIntent(parseDeterministicBaseIntent("show my Base portfolio"), { action: "portfolio" }, "Base portfolio");
expectIntent(parseDeterministicBaseIntent("buy ETH with 5 USDC"), {
  action: "swap",
  amount: "5",
  tokenIn: "USDC",
  tokenOut: "ETH",
}, "Base buy wording");
expectIntent(parseDeterministicBaseIntent("lend 5 USDC on Aave"), {
  action: "lend",
  amount: "5",
  tokenIn: "USDC",
}, "Base lend");
expectIntent(parseDeterministicBaseIntent("bridge 5 USDC from Base to Arbitrum"), {
  action: "bridge",
  amount: "5",
  tokenIn: "USDC",
}, "Base direct bridge");
const baseWorkflow = parseDeterministicBaseIntent(
  "buy ETH with 5 USDC then bridge it to Arbitrum then lend it on Aave",
);
expectIntent(baseWorkflow, {
  action: "workflow",
  steps: ["swap", "bridge", "lend"],
}, "Base to Arbitrum workflow");
assert.equal(
  baseWorkflow?.tokenOut,
  undefined,
  "Base workflow output identities remain step-bound rather than copied to an unused top-level role",
);
assert.deepEqual(
  normalizeWorkflowSteps(baseWorkflow!, "base").map((step) => [step.action, step.network, step.amountSource]),
  [
    ["swap", "base", "explicit"],
    ["bridge", "base", "previous_output"],
    ["lend", "arbitrum", "previous_output"],
  ],
  "Base cross-chain dependency binding",
);
const baseWethWorkflow = parseDeterministicBaseIntent(
  "Swap 5 USDC to WETH on Base, bridge it to Arbitrum, then lend the WETH on Aave",
);
expectIntent(
  baseWethWorkflow,
  { action: "workflow", steps: ["swap", "bridge", "lend"] },
  "Base comma-separated cross-chain workflow",
);
assert.equal(
  (await resolveIntentEntities(baseWethWorkflow!, {
    network: "base",
    userAddress: "0x1111111111111111111111111111111111111111",
    originalPrompt:
      "Swap 5 USDC to WETH on Base, bridge it to Arbitrum, then lend the WETH on Aave",
    requestId: "11111111-1111-4111-8111-111111111111",
  })).status,
  "resolved",
  "Base workflow funding metadata must remain compatible with entity resolution",
);
expectIntent(
  parseDeterministicBaseIntent("swap 5 USDC to ETH then lend it on Aave"),
  { action: "chat", complete: false },
  "Unsupported same-chain Base composition stops locally",
);

// Arc: natural buy/sell, transfer clarification, scaled amounts and staged
// Kletia protocol actions share one deterministic grammar.
expectIntent(parseDeterministicArcIntent("buy KLET with 5 USDC"), {
  action: "swap",
  amount: "5",
  tokenIn: "USDC",
  tokenOut: "KLET",
}, "Arc buy wording");
expectIntent(parseDeterministicArcIntent("stake 2 native USDC on Arc Testnet"), {
  action: "stake",
  amount: "2",
  tokenIn: "USDC",
}, "Arc stake");
expectIntent(parseDeterministicArcIntent("show my Arc balances"), { action: "portfolio" }, "Arc portfolio");
expectIntent(
  parseDeterministicArcIntent("send 5 USDC to 0x1111111111111111111111111111111111111111"),
  { action: "appkit_send", amount: "5", tokenIn: "USDC" },
  "Arc natural transfer",
);
expectIntent(parseDeterministicArcIntent("send 5 USDC"), {
  action: "appkit_send",
  amount: "5",
  tokenIn: "USDC",
  complete: false,
}, "Arc missing recipient clarification");
const arcWorkflow = parseDeterministicArcIntent(
  "swap 5 USDC to KLET after this lend it after borrow 1 USDC",
);
expectIntent(arcWorkflow, {
  action: "workflow",
  steps: ["swap", "lend", "borrow"],
}, "Arc three-step workflow");
assert.deepEqual(
  normalizeWorkflowSteps(arcWorkflow!, "arc").map((step) => [step.action, step.amountSource]),
  [
    ["swap", "explicit"],
    ["lending_deposit", "previous_output"],
    ["lending_borrow", "explicit"],
  ],
  "Arc dependency and exact-action mapping",
);
const privateArcWorkflow = parseDeterministicArcIntent(
  "swap [[private amount]] USDC to KLET after this lend [[private amount]] KLET",
);
expectIntent(privateArcWorkflow, {
  action: "workflow",
  complete: false,
  amount: "0",
  steps: ["swap", "lend"],
}, "Arc private-field workflow stays deterministic");
assert.deepEqual(
  privateArcWorkflow?.workflowSteps?.map((step) => step.amount),
  ["0", "0"],
  "Arc private values must never be replaced by executable parser sentinels",
);
const privateArcTransfer = parseDeterministicArcIntent(
  "send [[private amount]] USDC to [[private recipient]]",
);
expectIntent(privateArcTransfer, {
  action: "appkit_send",
  complete: false,
  amount: "0",
}, "Arc private transfer stays deterministic");
assert.equal(privateArcTransfer?.recipient, undefined, "Private recipient remains device-local");
const privateArcLiquidity = parseDeterministicArcIntent(
  "Add [[private amount]] native USDC liquidity to the KLET/USDC pool on Arc Testnet and spend at most [[private amount]] KLET; calculate and show the live requirement and enforce that hard cap before wallet approval",
);
expectIntent(privateArcLiquidity, {
  action: "add_liquidity",
  complete: false,
  amount: "0",
}, "Arc private two-amount liquidity intent stays non-executable");
assert.equal(privateArcLiquidity?.secondaryAmount, "0", "Private liquidity cap remains device-local");
const privateArcPayout = parseDeterministicArcIntent(
  "Atomically pay [[private amount]] native USDC to [[private recipient]] on Arc Testnet through the official Multicall3From route; fail the whole batch if any payment fails and simulate it before wallet approval",
);
expectIntent(privateArcPayout, {
  action: "atomic_payout",
  complete: false,
  amount: "0",
}, "Arc private payout stays non-executable");
assert.deepEqual(
  privateArcPayout?.transfers,
  [{ amount: "0", recipient: "" }],
  "Private payout fields must never be replaced by executable parser sentinels",
);
expectIntent(
  parseDeterministicArcIntent("sell 1.25 million KLET then lend 5 USDC"),
  { action: "workflow", complete: false },
  "Arc invalid collateral stops locally",
);
expectIntent(
  parseDeterministicArcIntent(
    "swap 5 USDC to KLET then lend 1 KLET then show my safe borrow capacity",
  ),
  { action: "workflow", complete: false },
  "Arc unavailable borrow-capacity read stops locally without AI",
);

// Arbitrum: no ordered suffix may be discarded. Both explicit and pronoun
// dependencies are represented as separately approved workflow steps.
expectIntent(parseDeterministicArbitrumIntent("buy WETH with 5 USDC"), {
  action: "swap",
  amount: "5",
  tokenIn: "USDC",
  tokenOut: "WETH",
}, "Arbitrum buy wording");
expectIntent(
  parseDeterministicArbitrumIntent("Swap 0.001 WETH to USDC on Arbitrum with maximum 0.5% slippage."),
  { action: "swap", amount: "0.001", tokenIn: "WETH", tokenOut: "USDC" },
  "Arbitrum constrained swap",
);
expectIntent(parseDeterministicArbitrumIntent("lend 5 USDC on Aave"), {
  action: "lend",
  amount: "5",
  tokenIn: "USDC",
}, "Arbitrum lend");
expectIntent(parseDeterministicArbitrumIntent("tell me how much USDC I can safely borrow"), {
  action: "borrow_capacity",
  tokenIn: "USDC",
}, "Arbitrum read-only capacity");
expectIntent(
  parseDeterministicArbitrumIntent("send 5 USDC to 0x1111111111111111111111111111111111111111"),
  { action: "transfer", amount: "5", tokenIn: "USDC" },
  "Arbitrum transfer",
);
const arbitrumWorkflow = parseDeterministicArbitrumIntent(
  "swap 5 USDC to WETH after this lend it then borrow 1 USDC",
);
expectIntent(arbitrumWorkflow, {
  action: "workflow",
  steps: ["swap", "lend", "borrow"],
}, "Arbitrum three-step workflow");
expectIntent(
  parseDeterministicArbitrumIntent(
    "swap [[private amount]] USDC to WETH after this lend it then borrow [[private amount]] USDC",
  ),
  {
    action: "workflow",
    complete: false,
    amount: "0",
    steps: ["swap", "lend", "borrow"],
  },
  "Arbitrum private-field workflow stays deterministic",
);
expectIntent(
  parseDeterministicArbitrumIntent(
    "swap 5 USDC to WETH, then lend the WETH on Aave",
  ),
  { action: "workflow", steps: ["swap", "lend"] },
  "Arbitrum explicit previous-output asset",
);
assert.equal(
  parseDeterministicArbitrumIntent("swap 5 USDC to WETH after this dance"),
  null,
  "An unresolved ordered suffix must never degrade into a single swap.",
);
expectIntent(parseDeterministicArbitrumIntent("swap 1 ETH to USDC"), {
  action: "chat",
  complete: false,
}, "Arbitrum native ETH clarification");

// The public entry point must preserve negative/informational safety and the
// explicit AI disclosure boundary on every EVM workspace.
for (const network of ["base", "arc", "arbitrum"] as const) {
  const informational = await parseUserIntent(
    "What would happen if I swapped 5 USDC? Do not prepare a transaction.",
    [],
    network,
  );
  assert.equal(informational.action, "chat", `${network}: informational request`);
  assert.equal(informational.isComplete, false, `${network}: no transaction for informational request`);
  await assert.rejects(
    () => parseUserIntent("Please do something useful with my funds", [], network),
    (error: unknown) => error instanceof IntentDisclosureConsentRequiredError,
    `${network}: unmatched wording requires explicit semantic consent`,
  );
}

const privateBaseWorkflow = await parseUserIntent(
  "swap [[private amount]] USDC to WETH then bridge it to Arbitrum then lend it on Aave",
  [],
  "base",
);
expectIntent(privateBaseWorkflow, {
  action: "workflow",
  complete: false,
  amount: "0",
  steps: ["swap", "bridge", "lend"],
}, "Private Base-to-Arbitrum workflow does not request semantic AI consent");

// Exercise the AI response boundary without external network calls. The model
// supplies semantics only; prompt-bound actions, assets and amounts are still
// enforced by the deterministic server.
const originalFetch = globalThis.fetch;
const originalKey = process.env.OPENROUTER_API_KEY;
process.env.OPENROUTER_API_KEY = "intent-matrix-local-test-key";
const aiCases = [
  {
    network: "base" as const,
    prompt: "Turn 5 USDC into AERO on Base",
    response: { isComplete: true, action: "swap", message: "Preparing Base swap.", amount: "5", tokenIn: "USDC", tokenOut: "AERO" },
  },
  {
    network: "arc" as const,
    prompt: "Transform 5 USDC into KLET on Arc",
    response: { isComplete: true, action: "swap", message: "Preparing Arc swap.", amount: "5", tokenIn: "USDC", tokenOut: "KLET" },
  },
  {
    network: "arbitrum" as const,
    prompt: "Change 5 USDC into WETH on Arbitrum",
    response: { isComplete: true, action: "swap", message: "Preparing Arbitrum swap.", amount: "5", tokenIn: "USDC", tokenOut: "WETH", protocol: "uniswap-v3" },
  },
];
try {
  for (const testCase of aiCases) {
    let providerRequests = 0;
    globalThis.fetch = async () => {
      providerRequests += 1;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify(testCase.response) } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const interpreted = await parseUserIntent(testCase.prompt, [], testCase.network, {
      semanticPlanner: "ai_assisted",
      onSemanticProviderRequest: () => {
        providerRequests += 1;
      },
    });
    assert.equal(interpreted.action, "swap", `${testCase.network}: AI semantic action`);
    assert.equal(interpreted.isComplete, true, `${testCase.network}: AI response remains prompt-bound`);
    assert.equal(providerRequests, 2, `${testCase.network}: exactly one provider boundary and one fetch`);
  }

  const stellarResponse = {
    kind: "swap",
    title: "Compare a Stellar swap",
    summary: "Compare the reviewed live pair.",
    nextStep: "Review the quote.",
    amount: "5",
    assetIn: "XLM",
    assetOut: "USDC",
    recipient: null,
    strictReceive: false,
    readyToPrepare: true,
    blockingReason: null,
    stages: [],
    missingFields: [],
  };
  globalThis.fetch = async () => new Response(
    JSON.stringify({ choices: [{ message: { content: JSON.stringify(stellarResponse) } }] }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
  const stellarInterpreted = await interpretStellarIntent(
    "Transform 5 XLM into USDC on Stellar",
  );
  assert.equal(stellarInterpreted.kind, "swap", "Stellar: smart semantic action");
  assert.equal(stellarInterpreted.readyToPrepare, true, "Stellar: exact amount and assets remain prompt-bound");

  globalThis.fetch = async () => new Response(
    JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({ ...stellarResponse, amount: "99" }),
        },
      }],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
  const inventedStellarAmount = await interpretStellarIntent(
    "Transform 5 XLM into USDC on Stellar",
  );
  assert.equal(inventedStellarAmount.readyToPrepare, false, "Stellar: model cannot invent an amount");
  assert.match(inventedStellarAmount.blockingReason || "", /amount could not be matched/iu);
} finally {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = originalKey;
}

console.log(
  "Intent network matrix verified: deterministic simple and staged flows, no silent suffix truncation, safety stops, and prompt-bound AI semantics across Base, Arc, and Arbitrum.",
);
