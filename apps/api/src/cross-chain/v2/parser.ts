import { z } from "zod";
import {
  buildIntentParserInstruction,
  findIntentScenario,
  matchIntentEnvelope,
  type IntentEnvelopeMatchV1,
  type IntentScenarioDefinitionV1,
} from "./intentGrammar.js";

/**
 * The parsed goal.
 *
 * Every field except `semanticGoal` and the toggles is derived from the matched
 * grammar entry, not from the model. The model's only job is to confirm the
 * structure it was given; a response that changes any binding is rejected.
 */
const ParsedWorkflowGoalSchema = z.object({
  isComplete: z.boolean(),
  question: z.string().max(300).optional(),
  semanticGoal: z.string().min(1).max(500),
  scenarioId: z.string().min(1).max(120),
  sourceNetwork: z.enum(["arc_testnet", "stellar_testnet", "arbitrum_sepolia"]),
  destinationNetwork: z.enum([
    "arc_testnet",
    "stellar_testnet",
    "arbitrum_sepolia",
  ]),
  asset: z.enum(["USDC", "XLM"]),
  targetProtocol: z.enum([
    "cctp_v2",
    "aave_v3",
    "stellar_sac",
    "stellar_classic_dex",
    "kletia_policy_registry",
    "kletia_intent_anchor",
  ]),
  targetAction: z.enum([
    "supply",
    "transfer",
    "path_payment",
    "anchor_policy",
    "anchor_intent",
  ]),
  privateFieldIsolation: z.literal(true),
  ledgerConfidentialityRequested: z.boolean(),
});

type ParsedWorkflowGoalCore = z.infer<typeof ParsedWorkflowGoalSchema>;

export type ParsedWorkflowGoalV2 = ParsedWorkflowGoalCore & {
  /** The matched registry entry. Downstream compilers read bindings from here. */
  readonly scenario: IntentScenarioDefinitionV1;
  /** Device-selected toggles, taken from the envelope and never from the model. */
  readonly toggles: Readonly<Record<string, boolean>>;
  /**
   * Retained for the executable Arc → Arbitrum corridor. Both are toggle
   * projections; new scenarios read `toggles` directly instead of growing this
   * surface.
   */
  readonly includeBorrowCapacity: boolean;
  readonly stellarPolicyCenter: boolean;
};

function controlled(code: string, message: string, statusCode = 400): Error {
  return Object.assign(new Error(message), { code, statusCode });
}

/**
 * Asserts the prompt is a device-generated envelope for a registered scenario.
 *
 * Free-form text is rejected outright. The envelope pattern is derived from the
 * grammar and anchored, so nothing can be appended, prepended or interleaved.
 */
export function assertRedactedWorkflowPrompt(value: unknown): string {
  const prompt = String(value ?? "").trim();
  if (prompt.length < 4 || prompt.length > 2_000) {
    throw controlled("WORKFLOW_PROMPT_INVALID", "Enter a workflow goal between 4 and 2000 characters.");
  }
  const match = matchIntentEnvelope(prompt);
  if (!match) {
    throw controlled(
      "PRIVATE_FIELD_EGRESS_BLOCKED",
      "Only the device-created, allowlisted semantic envelope may cross the privacy intent boundary.",
    );
  }
  for (const marker of match.requiredPrivateMarkers) {
    if (!prompt.includes(marker)) {
      throw controlled(
        "PRIVATE_FIELD_MARKERS_REQUIRED",
        "The workflow prompt must contain every device-created private field marker for this scenario.",
      );
    }
  }
  return prompt;
}

/**
 * Accepts only the optional, locally redacted natural-language context.
 *
 * This check lives next to the parser rather than only in the HTTP route so a
 * future caller cannot bypass the privacy boundary by importing
 * `parseWorkflowGoalV2` directly. Exact numbers and supported wallet address
 * families are rejected after Unicode normalization; the semantic model never
 * needs either class of value to confirm a registry scenario.
 */
export function assertRedactedSemanticContext(
  value: unknown,
): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const context = String(value).normalize("NFKC").trim();
  if (
    context.length < 4 ||
    context.length > 1_200 ||
    /0x[a-f\d]{40}/iu.test(context) ||
    /[GC][A-Z2-7]{55}/u.test(context) ||
    /\p{Number}/u.test(context) ||
    /[\u0000-\u001f\u007f]/u.test(context)
  ) {
    throw controlled(
      "PRIVATE_FIELD_EGRESS_BLOCKED",
      "Natural-language context must be locally redacted before semantic planning.",
    );
  }
  return context;
}

/**
 * Refuses a scenario the runtime cannot actually execute.
 *
 * Non-executable entries exist so the roadmap is reviewable in code. They must
 * never reach a signable compilation, so this is a hard boundary rather than a
 * warning. `integration_incomplete` is intentionally distinct from an upstream
 * blocker: the official unaudited Testnet reference exists. Kletia separately
 * integrates the pinned browser-only XLM privacy pool, while this USDC/private
 * cross-chain scenario still has no signable runtime.
 */
function assertScenarioExecutable(scenario: IntentScenarioDefinitionV1): void {
  if (scenario.executionReadiness !== "executable") {
    throw controlled(
      scenario.executionReadiness === "integration_incomplete"
        ? "INTENT_SCENARIO_INTEGRATION_INCOMPLETE"
        : "INTENT_SCENARIO_NOT_EXECUTABLE",
      `${scenario.label} is declared for review only: ${scenario.limitations[0] ?? "its signable runtime is incomplete."}`,
      409,
    );
  }
  if (scenario.requestsLedgerConfidentiality) {
    // Defence in depth. A confidential scenario should already be refused above;
    // this guarantees no future readiness edit can silently open a confidential
    // claim without a pinned and validated Kletia execution surface.
    throw controlled(
      "LEDGER_CONFIDENTIALITY_UNAVAILABLE",
      "This scenario has no pinned USDC privacy pool or private cross-chain execution runtime. The separate XLM Testnet shielded-payment surface cannot be substituted silently.",
      409,
    );
  }
}

async function requestSemanticConfirmation(
  prompt: string,
  match: IntentEnvelopeMatchV1,
  semanticContext?: string,
): Promise<unknown> {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    throw controlled("INTENT_PARSER_UNAVAILABLE", "The intent parser is not configured.", 503);
  }
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://kletiaai.xyz",
      "X-Title": "Kletia Stellar Workflow Compiler",
    },
    body: JSON.stringify({
      model: process.env.OPENROUTER_INTENT_MODEL?.trim() || "openai/gpt-4.1-mini",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: buildIntentParserInstruction(match.scenario) },
        {
          role: "user",
          content: semanticContext
            ? `${prompt}\n\nREDACTED_NATURAL_LANGUAGE_CONTEXT\n${semanticContext}`
            : prompt,
        },
      ],
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw controlled("INTENT_PARSER_UNAVAILABLE", "The intent parser is temporarily unavailable.", 502);
  }
  const body = (await response.json()) as {
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  const content = body.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw controlled("INTENT_PARSER_INVALID", "The intent parser returned an invalid response.", 502);
  }
  try {
    return JSON.parse(content);
  } catch {
    throw controlled("INTENT_PARSER_INVALID", "The intent parser returned invalid JSON.", 502);
  }
}

export async function parseWorkflowGoalV2(
  prompt: string,
  options: {
    readonly semanticPlanner?: "openrouter_constrained" | "deterministic_registry";
    readonly semanticContext?: string;
  } = {},
): Promise<ParsedWorkflowGoalV2> {
  const match = matchIntentEnvelope(prompt);
  if (!match) {
    throw controlled(
      "PRIVATE_FIELD_EGRESS_BLOCKED",
      "Only the device-created, allowlisted semantic envelope may cross the privacy intent boundary.",
    );
  }
  assertScenarioExecutable(match.scenario);
  const semanticContext = assertRedactedSemanticContext(options.semanticContext);
  if (options.semanticPlanner === "deterministic_registry") {
    if (semanticContext !== undefined) {
      throw controlled(
        "SEMANTIC_CONTEXT_NOT_ALLOWED",
        "Deterministic planning does not accept natural-language context because no semantic model is used.",
      );
    }
    const scenario = match.scenario;
    return {
      isComplete: true,
      semanticGoal: `Execute ${scenario.label} under the device-selected privacy and route constraints.`,
      scenarioId: scenario.id,
      scenario,
      toggles: match.toggles,
      sourceNetwork: scenario.sourceNetwork,
      destinationNetwork: scenario.destinationNetwork,
      asset: scenario.asset,
      targetProtocol: scenario.targetProtocol,
      targetAction: scenario.targetAction,
      privateFieldIsolation: true,
      ledgerConfidentialityRequested: scenario.requestsLedgerConfidentiality,
      includeBorrowCapacity: match.toggles.includeBorrowCapacity === true,
      stellarPolicyCenter: match.toggles.stellarPolicyCenter === true,
    };
  }
  const parsed = await requestSemanticConfirmation(
    prompt,
    match,
    semanticContext,
  );
  const result = ParsedWorkflowGoalSchema.safeParse(parsed);
  if (!result.success) {
    throw controlled("INTENT_PARSER_INVALID", "The intent parser response failed schema validation.", 502);
  }
  // Every binding is compared against the grammar entry the device selected. A
  // model that renames a network, swaps a protocol or flips a disclosure choice
  // is rejected rather than trusted.
  const scenario = match.scenario;
  if (
    findIntentScenario(result.data.scenarioId)?.id !== scenario.id ||
    result.data.sourceNetwork !== scenario.sourceNetwork ||
    result.data.destinationNetwork !== scenario.destinationNetwork ||
    result.data.asset !== scenario.asset ||
    result.data.targetProtocol !== scenario.targetProtocol ||
    result.data.targetAction !== scenario.targetAction ||
    result.data.ledgerConfidentialityRequested !== scenario.requestsLedgerConfidentiality
  ) {
    throw controlled(
      "INTENT_PARSER_BOUNDARY_MISMATCH",
      "The semantic parser changed a device-selected workflow boundary.",
      502,
    );
  }
  return {
    ...result.data,
    scenarioId: scenario.id,
    scenario,
    toggles: match.toggles,
    includeBorrowCapacity: match.toggles.includeBorrowCapacity === true,
    stellarPolicyCenter: match.toggles.stellarPolicyCenter === true,
  };
}
