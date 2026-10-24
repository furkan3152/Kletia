/**
 * MCP tool `ask_portfolio`: POST /v1/assistant/ask for agents. The key must
 * name the wallets (an agent key only accounts its rule book pins); the
 * answer carries the facts with their sources, and a portfolio request's
 * `action.sentences`, which the agent plans with `plan_intent` and the
 * person confirms. Read-only: nothing is planned, stored or signed here.
 */
import { ASSISTANT_LIMITS } from "@kletia/core";
import { ask } from "../../assistant/index.js";
import { PlatformError } from "../../errors.js";
import { keyOwner, parseAskRequest } from "../assistant.js";
import { keyKindOf } from "../auth.js";
import { readKeyChain } from "../policies/chain.js";
import type { KletiaTool } from "./tools.js";

const ADDRESSES = { type: "array", maxItems: 2, items: { type: "string", maxLength: 64 } } as const;

export const ASK_PORTFOLIO_TOOL: KletiaTool = {
  name: "ask_portfolio",
  description:
    "Answer a question about the user's own wallets from Kletia's data (holdings, positions, loan health, fees, transactions, results), e.g. \"what's my biggest position?\" or \"how much did I spend on fees last month?\". Every number in `text` is one of `facts`, each with its source and reading time; `status` says when data is partial or unknown (never invented). A portfolio request that wants action (\"rebalance my portfolio to 60/40 ETH/USDC\") returns `action.sentences` with amounts from the holdings: plan each with plan_intent; the user confirms and signs. Questions about other people's wallets or keys are refused.",
  inputSchema: {
    type: "object",
    properties: {
      question: { type: "string", minLength: 1, maxLength: ASSISTANT_LIMITS.questionChars },
      wallets: {
        type: "object",
        properties: { evm: ADDRESSES, solana: ADDRESSES, lane: { type: "string", enum: ["production", "testnet"] } },
        additionalProperties: false,
        description: "The user's wallets (at most 2 EVM and 2 Solana addresses).",
      },
    },
    required: ["question", "wallets"],
    additionalProperties: false,
  },
  annotations: { title: "Ask about a portfolio", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async run(args, caller) {
    if (!caller.keyId) throw new PlatformError("ASSISTANT_OWNER_REQUIRED", "ask_portfolio needs an API key and the wallets to ask about.", 401);
    const body = parseAskRequest({ question: args.question, wallets: args.wallets });
    const chain = await readKeyChain(caller.keyId);
    const keyKind = chain?.record ? keyKindOf(chain.record) : undefined;
    const owner = await keyOwner({ keyId: caller.keyId, ...(keyKind ? { keyKind } : {}), ...(chain?.record ? { projectId: chain.record.projectId } : {}) }, body);
    const answer = await ask({ question: body.question, ...owner, model: null });
    return { answer };
  },
  render(value) {
    const answer = (value as { answer?: { text?: unknown } }).answer;
    return typeof answer?.text === "string" ? answer.text : null;
  },
};
