/**
 * OpenAPI fragments of clarifying questions (clarify design §6.6): the turn
 * request and its three responses (`oneOf` on `status`), questions, options,
 * assumption chips, the draft, the client-held thread blob and the ThreadRef
 * of a Kletia-held thread, the `clarify` query parameter of createIntent, the
 * thread views and the three thread routes. Enums come from @kletia/core
 * `clarify.ts`, never hand-copied. Merged by openapi.ts.
 */
import {
  ASSUMPTION_SOURCES,
  CLARIFY_LIMITS,
  CLARIFY_POLICY_VERSION,
  CLARIFY_QUESTION_KINDS,
  CLARIFY_REASONS,
  GOAL_LIMITS,
  GOAL_SPEC,
  CLARIFY_STEP_KINDS,
  PURPOSE_REASONS,
  THREAD_ID_PATTERN,
  THREAD_LIMITS,
  THREAD_PROVENANCES,
  THREAD_SPEC,
  THREAD_STATUSES,
  TURN_KINDS,
} from "@kletia/core";
import { arrayOf, bool, errors, int, KEY_REQUIRED, noContent, nullable, obj, ok, ref, str, type JsonObject } from "./openapiKit.js";

const BOOLEAN_QUERY: JsonObject = str({ enum: ["true", "false", "1", "0"] });
const THREAD_ID: JsonObject = str({ pattern: THREAD_ID_PATTERN.source, description: "`th_` followed by 24 base32 characters." });
const QUESTION_ID: JsonObject = str({ pattern: "^q\\.[\\w.[\\]-]{1,94}$", examples: ["q.actions.0.amount"] });
const ASSUMPTION_ID: JsonObject = str({ pattern: "^a\\.[\\w.[\\]-]{1,94}$", examples: ["a.actions.0.network"] });
const OPTION_ID: JsonObject = str({ pattern: "^[\\w.:[\\]-]{1,128}$", examples: ["all", "base"] });
const FIELD: JsonObject = str({ pattern: "^actions\\[[0-7]\\]\\.[a-zA-Z]{1,24}$", examples: ["actions[0].amount"] });

/** `?clarify=true` on createIntent. */
export const CLARIFY_QUERY_PARAMETER: JsonObject = {
  name: "clarify",
  in: "query",
  required: false,
  description:
    "Ask instead of refusing: the body is an `IntentTurnRequest` and the response an `IntentTurnResponse` (needs_input 200, planned 201 when stored or 200 on a dry run or a replay, cancelled 200). Without it the endpoint is the strict planner, unchanged. See docs/platform/clarify.md.",
  schema: BOOLEAN_QUERY,
};

/** `interpretation.assumptions` and `interpretation.thread` of an IntentGraph planned by a clarify turn. */
export function interpretationClarifyFields(): JsonObject {
  return {
    assumptions: arrayOf(
      obj(
        { field: FIELD, label: str({ maxLength: 160 }), source: str({ enum: [...ASSUMPTION_SOURCES] }), material: bool() },
        ["field", "label", "source", "material"],
      ),
      { description: "Clarify turns: what Kletia assumed (the chips the person saw), material ones first." },
    ),
    thread: obj({ id: THREAD_ID, rev: int({ minimum: 1 }) }, ["id", "rev"], { description: "Clarify turns: the thread and revision this intent was planned from." }),
  };
}

function slot(value: JsonObject): JsonObject {
  return obj(
    {
      v: value,
      by: str({ enum: [...THREAD_PROVENANCES], description: "`user` typed it, `answer` picked or typed in reply, `assumed` Kletia's default (shown as a chip), `derived` follows from another slot." }),
      why: obj({ source: str({ enum: [...ASSUMPTION_SOURCES] }), code: str({ maxLength: 64 }) }, ["source", "code"], { description: "Assumed slots: the template code of the reason (never free text)." }),
    },
    ["v", "by"],
    { additionalProperties: false },
  );
}

export function clarifySchemas(): JsonObject {
  const text = str({ minLength: 1, maxLength: CLARIFY_LIMITS.text });
  const purposeList = [...PURPOSE_REASONS].join(", ");
  return {
    ClarifyOption: obj(
      {
        id: OPTION_ID,
        label: str({ maxLength: CLARIFY_LIMITS.optionLabel, examples: ["All · 2.49 SOL"] }),
        detail: str({ maxLength: CLARIFY_LIMITS.optionDetail, examples: ["Keeps 0.01 SOL for network fees"] }),
        recommended: bool({ const: true, description: "Kletia's suggestion: at most one per question, never on gap or recipient questions." }),
        network: ref("NetworkKey"),
        sentence: str({ maxLength: 1000, description: "The complete sentence this choice leads to when the thread is then ready; a stateless agent can send it as `text`." }),
      },
      ["id", "label"],
    ),
    ClarifyQuestion: obj(
      {
        id: QUESTION_ID,
        field: { ...FIELD, description: "The slot this question fills (or `edit` for an ambiguous follow-up)." },
        kind: str({ enum: [...CLARIFY_QUESTION_KINDS] }),
        reason: str({ enum: [...CLARIFY_REASONS] }),
        purpose: bool({ description: `True when only the person can answer (${purposeList}): agents relay these and never pick an option themselves.` }),
        prompt: str({ maxLength: CLARIFY_LIMITS.prompt, examples: ["How much SOL?"] }),
        why: str({ maxLength: CLARIFY_LIMITS.why, examples: ["You hold 2.5 SOL on Solana."] }),
        options: arrayOf(ref("ClarifyOption"), { maxItems: CLARIFY_LIMITS.optionsPerQuestion }),
        allowsText: bool({ description: "The question also takes a typed answer (`answer.text`)." }),
        placeholder: str({ maxLength: 64, examples: ["Amount in SOL"] }),
      },
      ["id", "field", "kind", "reason", "purpose", "prompt", "why", "options", "allowsText"],
    ),
    ClarifyAssumption: obj(
      {
        id: ASSUMPTION_ID,
        field: FIELD,
        label: str({ maxLength: 160, examples: ["On Base"] }),
        reason: str({ maxLength: 160, examples: ["Your largest USDC balance."] }),
        source: str({ enum: [...ASSUMPTION_SOURCES] }),
        material: bool({ description: "Changes where money goes or how much moves: highlight it and announce it." }),
        alternatives: arrayOf(ref("ClarifyOption"), { maxItems: CLARIFY_LIMITS.alternativesPerAssumption, description: "One-tap alternatives (send `assumption` { id, option })." }),
      },
      ["id", "field", "label", "reason", "source", "material", "alternatives"],
    ),
    ClarifyDraft: obj(
      {
        summary: str({ maxLength: 200, examples: ["Swap SOL to USDC on Solana"] }),
        sentence: { type: ["string", "null"], description: "The canonical sentence once the thread is ready; null while questions are open." },
        missing: arrayOf(str(), { description: "Fields of the open questions." }),
        steps: arrayOf(
          obj(
            {
              index: int({ minimum: 0 }),
              kind: str({ enum: [...CLARIFY_STEP_KINDS] }),
              network: ref("NetworkKey"),
              toNetwork: ref("NetworkKey"),
              from: str(),
              to: str(),
              amount: str({ examples: ["25", "all", "half", "it"] }),
              recipient: str(),
              protocol: str(),
            },
            ["index"],
          ),
        ),
      },
      ["summary", "sentence", "missing", "steps"],
    ),
    ClarifyThreadStep: obj(
      {
        kind: slot(str({ enum: [...CLARIFY_STEP_KINDS] })),
        kindCandidates: arrayOf(str({ enum: [...CLARIFY_STEP_KINDS] }), { minItems: 1, maxItems: 4 }),
        amount: slot({
          type: "object",
          description: "`exact` { value } or `usd` { value } (decimal strings), or `previous`, `balance`, `position` { bps } (a share in basis points).",
          properties: { t: str({ enum: ["exact", "usd", "previous", "balance", "position"] }), value: ref("DecimalAmount"), raw: str({ maxLength: 40 }), bps: int({ minimum: 1, maximum: 10_000 }) },
          required: ["t"],
        }),
        from: slot(str({ maxLength: 128 })),
        to: slot(str({ maxLength: 128 })),
        network: slot(ref("NetworkKey")),
        toNetwork: slot(ref("NetworkKey")),
        recipient: slot(str({ maxLength: 128 })),
        protocol: slot(str({ maxLength: 64 })),
        vault: slot(str({ maxLength: 64 })),
        provider: slot(str({ maxLength: 64 })),
        contract: slot(str({ maxLength: 128, description: "`<registration>#<entry>`." })),
        usdFrom: bool(),
        usdTo: bool(),
      },
      [],
      { additionalProperties: false },
    ),
    ClarifyThread: obj(
      {
        spec: str({ const: THREAD_SPEC }),
        id: THREAD_ID,
        rev: int({ minimum: 0, description: "Turns applied so far; a thread closes at " + `${THREAD_LIMITS.maxTurns}.` }),
        status: str({ enum: [...THREAD_STATUSES] }),
        policy: str({ pattern: "^\\d{4}-\\d{2}\\.\\d{1,4}$", examples: [CLARIFY_POLICY_VERSION], description: "The policy version that wrote it; an older one is re-analysed." }),
        steps: arrayOf(ref("ClarifyThreadStep"), { maxItems: THREAD_LIMITS.maxSteps }),
        open: arrayOf(str(), { description: "Fields of the open questions." }),
        pendingEdit: { type: "object", description: "An edit waiting for its target (engine-defined shape)." },
        corrections: arrayOf(
          obj({ field: FIELD, from: str({ maxLength: CLARIFY_LIMITS.correctionFrom }), to: str({ maxLength: 64 }), material: bool() }, ["field", "from", "to", "material"]),
        ),
        turns: arrayOf(
          obj({ role: str({ enum: ["user", "kletia"] }), kind: str({ maxLength: 24 }), label: str({ maxLength: 160, description: "Kletia's own words (\"Changed the amount to 2\"), never the user's message." }) }, ["role", "kind", "label"]),
          { maxItems: THREAD_LIMITS.storedTurns },
        ),
        undo: arrayOf(arrayOf(ref("ClarifyThreadStep")), { maxItems: THREAD_LIMITS.undoSnapshots }),
        goals: arrayOf(
          { type: "object", description: `A \`${GOAL_SPEC}\` Goal (what is spent, what is wanted and where, for whom), never the user's words.` },
          { maxItems: GOAL_LIMITS.maxGoals, description: "The goals of the thread's goal steps (steps with no kind), in order: Kletia solves them again each turn from the current balances, prices and rates." },
        ),
      },
      ["spec", "id", "rev", "status", "policy", "steps", "open", "corrections", "turns", "undo"],
      {
        description: `A client-held thread (\`${THREAD_SPEC}\`, at most ${THREAD_LIMITS.maxBytes} bytes): send it back exactly as returned. Kletia re-checks every value each turn, so a changed blob can only say what its sender could have typed.`,
      },
    ),
    ThreadRef: obj(
      {
        id: THREAD_ID,
        rev: int({ minimum: 0, description: "Send it as `expectedRev` (or `If-Match: \"<rev>\"`) to refuse a thread that moved on." }),
        status: str({ enum: [...THREAD_STATUSES] }),
        expiresAt: str({ format: "date-time", description: `${THREAD_LIMITS.idleMs / 60_000} minutes after the last turn, at most ${THREAD_LIMITS.absoluteMs / 3_600_000} hours after creation.` }),
      },
      ["id", "rev", "status", "expiresAt"],
      { description: "A Kletia-held thread (`remember: true`)." },
    ),
    IntentTurnRequest: obj(
      {
        accounts: arrayOf(ref("AccountId"), { minItems: 1, maxItems: 6, description: "Required unless a Kletia-held thread kept them." }),
        defaultNetwork: ref("NetworkKey"),
        sourceNetwork: { oneOf: [ref("NetworkKey"), str({ const: "auto" })], description: "Where the money starts (as on IntentRequest)." },
        constraints: ref("IntentConstraints"),
        metadata: { type: "object", maxProperties: 20, propertyNames: { maxLength: 40 }, additionalProperties: str({ maxLength: 500 }) },
        clientReference: str({
          pattern: `^[A-Za-z0-9_.:-]{1,${CLARIFY_LIMITS.clientReference}}$`,
          description: "The intent stored at revision n gets `<clientReference>:r<n>` (default `thread:<threadId>:r<n>`), so a retried commit returns the same intent.",
        }),
        text: { ...text, description: "A sentence, an answer in words (\"50\"), a follow-up (\"make it 2\", \"from arbitrum instead\") or a control word (\"cancel\", \"undo\")." },
        answer: obj({ question: QUESTION_ID, option: OPTION_ID, text }, ["question"], { description: "Exactly one of option and text.", additionalProperties: false }),
        assumption: obj({ id: ASSUMPTION_ID, option: OPTION_ID }, ["id", "option"], { description: "Change an assumption chip to one of its alternatives.", additionalProperties: false }),
        thread: ref("ClarifyThread"),
        threadId: { ...THREAD_ID, description: "A Kletia-held thread of this API key." },
        remember: bool({ description: "First turn only: Kletia keeps the thread (API key required; 400 THREAD_REQUIRES_API_KEY otherwise)." }),
        expectedRev: int({ minimum: 0, description: "With threadId: refuse with 409 THREAD_CONFLICT when the thread is at another revision." }),
      },
      [],
      {
        additionalProperties: false,
        description:
          "One clarify turn: at most one input (text, answer, assumption; none with a ready thread is the commit turn) and at most one memory (thread or threadId). Structured `actions` are refused: send them without `clarify`.",
      },
    ),
    IntentTurnNeedsInput: obj(
      {
        status: str({ const: "needs_input" }),
        turn: str({ enum: [...TURN_KINDS] }),
        questions: arrayOf(ref("ClarifyQuestion"), { minItems: 1, maxItems: CLARIFY_LIMITS.questionsPerTurn }),
        assumptions: arrayOf(ref("ClarifyAssumption"), { maxItems: CLARIFY_LIMITS.chipsPerPlan }),
        draft: ref("ClarifyDraft"),
        thread: { oneOf: [ref("ClarifyThread"), ref("ThreadRef")] },
      },
      ["status", "turn", "questions", "assumptions", "draft", "thread"],
    ),
    IntentTurnPlanned: obj(
      {
        status: str({ const: "planned" }),
        turn: str({ enum: [...TURN_KINDS] }),
        intent: ref("IntentGraph"),
        preview: { ...ref("IntentPreview"), description: "With `preview=true` or `journey=true`." },
        journey: { oneOf: [ref("Journey"), { type: "null" }], description: "With `journey=true`: the journey on `preview`; null when it could not be built." },
        assumptions: arrayOf(ref("ClarifyAssumption")),
        sentence: str({ maxLength: 1000, description: "The canonical sentence: it compiles to exactly the planned actions." }),
        thread: { oneOf: [ref("ClarifyThread"), ref("ThreadRef")] },
        replayed: bool({ const: true, description: "The intent already existed under this clientReference." }),
      },
      ["status", "turn", "intent", "assumptions", "sentence", "thread"],
    ),
    IntentTurnCancelled: obj(
      { status: str({ const: "cancelled" }), turn: str({ const: "control" }), thread: { oneOf: [ref("ClarifyThread"), ref("ThreadRef")] } },
      ["status", "turn", "thread"],
    ),
    IntentTurnResponse: {
      oneOf: [ref("IntentTurnNeedsInput"), ref("IntentTurnPlanned"), ref("IntentTurnCancelled")],
      discriminator: {
        propertyName: "status",
        mapping: {
          needs_input: "#/components/schemas/IntentTurnNeedsInput",
          planned: "#/components/schemas/IntentTurnPlanned",
          cancelled: "#/components/schemas/IntentTurnCancelled",
        },
      },
    },
    ThreadContext: obj(
      {
        accounts: arrayOf(ref("AccountId")),
        defaultNetwork: ref("NetworkKey"),
        sourceNetwork: { oneOf: [ref("NetworkKey"), str({ const: "auto" })] },
        constraints: ref("IntentConstraints"),
        metadata: { type: "object", additionalProperties: str() },
        clientReference: str(),
      },
      ["accounts"],
      { description: "The request context the thread keeps (the last one sent, field by field)." },
    ),
    ThreadSummary: {
      allOf: [
        ref("ThreadRef"),
        obj(
          { summary: str({ maxLength: 200, description: "The draft summary, the planned sentence, or \"Cancelled\"." }), createdAt: str({ format: "date-time" }), updatedAt: str({ format: "date-time" }) },
          ["summary", "createdAt", "updatedAt"],
        ),
      ],
    },
    ThreadResponse: obj(
      {
        thread: ref("ClarifyThread"),
        ref: ref("ThreadRef"),
        summary: str({ maxLength: 200 }),
        createdAt: str({ format: "date-time" }),
        updatedAt: str({ format: "date-time" }),
        context: ref("ThreadContext"),
        response: nullable({
          type: "object",
          description: "The last turn's response with its ThreadRef; a planned turn keeps status, turn, sentence, assumptions, dryRun and (when stored) intentId, not the intent graph. Null when it did not fit in 32 KB.",
        }),
        intents: arrayOf(ref("IntentId"), { maxItems: THREAD_LIMITS.intentsPerThread, description: "Stored intents planned on this thread, newest last." }),
      },
      ["thread", "ref", "summary", "createdAt", "updatedAt", "context", "response", "intents"],
      { description: "A Kletia-held thread: the blob (`thread`, as a client-held thread would carry it), its ref, the context it keeps, its last response and its intents." },
    ),
    ThreadListResponse: obj(
      { threads: arrayOf(ref("ThreadSummary")), nextCursor: { type: ["string", "null"], description: "Send as `cursor` for the next page; null on the last page." } },
      ["threads", "nextCursor"],
    ),
  };
}

const THREAD_ID_PARAMETER: JsonObject = { name: "id", in: "path", required: true, schema: THREAD_ID };

export function clarifyPaths(): JsonObject {
  return {
    "/v1/threads": {
      get: {
        operationId: "listThreads",
        tags: ["Intents"],
        summary: "List the key's Kletia-held clarify threads",
        description: "Threads created with `remember: true` by this API key that have not expired, most recently used first. Publishable keys and the public tier have no Kletia-held threads.",
        security: KEY_REQUIRED,
        parameters: [
          { name: "status", in: "query", required: false, schema: str({ enum: [...THREAD_STATUSES] }) },
          { name: "limit", in: "query", required: false, schema: int({ minimum: 1, maximum: 100, default: 20 }) },
          { name: "cursor", in: "query", required: false, description: "`nextCursor` of the previous page.", schema: str({ maxLength: 200 }) },
        ],
        responses: { "200": ok("ThreadListResponse", "Threads, newest first."), ...errors() },
      },
    },
    "/v1/threads/{id}": {
      get: {
        operationId: "getThread",
        tags: ["Intents"],
        summary: "Read a Kletia-held clarify thread",
        description: "The thread blob, its context, its last response and its intents. Another key's thread, or an expired one, is 404 THREAD_NOT_FOUND.",
        security: KEY_REQUIRED,
        parameters: [THREAD_ID_PARAMETER],
        responses: { "200": ok("ThreadResponse", "Thread."), ...errors("404") },
      },
      delete: {
        operationId: "deleteThread",
        tags: ["Intents"],
        summary: "Delete a Kletia-held clarify thread",
        description: "The row is removed at once; later turns on it get 404 THREAD_NOT_FOUND. Intents it planned are not affected.",
        security: KEY_REQUIRED,
        parameters: [THREAD_ID_PARAMETER],
        responses: { "204": noContent("Deleted."), ...errors("404") },
      },
    },
  };
}
