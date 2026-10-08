import { randomUUID } from "crypto";
import { isAddress } from "viem";

import type {
  IntentSemanticPlannerMode,
  ParsedIntent,
} from "../ai/parser.js";
import type { EntityClarification } from "../assets/resolver.js";
import type { NetworkId } from "../config/networks.js";

/**
 * In-memory conversation state for POST /api/intent. A session is bound to
 * one network and one lower-cased wallet address; it holds the last turns of
 * history plus at most one pending clarification (entity resolution) or
 * pending completion (a single missing field).
 *
 * The store is per process. It is intentionally not shared across serverless
 * instances: a conversation that lands on another instance fails closed with
 * CONVERSATION_CONTEXT_INVALID.
 */
export interface ConversationSession {
  network: NetworkId;
  userAddress: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  lastAccess: number;
  semanticPlanner: IntentSemanticPlannerMode;
  semanticModelInfluencedPlan: boolean;
  aiConsentExpiresAt?: number;
  pendingResolution?: {
    intent: ParsedIntent;
    originalPrompt: string;
    clarification: EntityClarification;
    expiresAt: number;
  };
  pendingCompletion?: {
    intent: ParsedIntent;
    originalPrompt: string;
    field: "recipient" | "tokenOut" | "amount";
    question: string;
    expiresAt: number;
  };
}

export const conversationSessions = new Map<string, ConversationSession>();
export const CONVERSATION_TTL_MS = 15 * 60 * 1000;
export const PENDING_RESOLUTION_TTL_MS = 5 * 60 * 1000;
export const MAX_CONVERSATION_SESSIONS = 1_000;
export const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Returns a fresh conversation id, evicting the oldest session first when the
 * store is at capacity.
 */
export function allocateConversationId(): string {
  if (conversationSessions.size >= MAX_CONVERSATION_SESSIONS) {
    const oldest = conversationSessions.keys().next().value;
    if (oldest) conversationSessions.delete(oldest);
  }
  return randomUUID();
}

export function pendingIntentCompletion(
  intent: ParsedIntent,
): ConversationSession["pendingCompletion"] | undefined {
  const action = String(intent.action || "").trim().toLowerCase();
  const question =
    intent.question || intent.message || "A little more information is required.";
  const recipientActions = new Set([
    "appkit_bridge",
    "appkit_send",
    "memo_send",
    "official_memo_send",
  ]);
  const field = recipientActions.has(action) && !intent.recipient
    ? "recipient"
    : action === "swap" && !intent.tokenOut
      ? "tokenOut"
      : (!intent.amount || intent.amount === "0") &&
          /\b(?:amount|miktar|how much)\b/iu.test(question)
        ? "amount"
        : undefined;
  if (!field) return undefined;
  return {
    intent,
    originalPrompt: "",
    field,
    question,
    expiresAt: Date.now() + PENDING_RESOLUTION_TTL_MS,
  };
}

export function applyPendingIntentCompletion(
  pending: NonNullable<ConversationSession["pendingCompletion"]>,
  reply: string,
): ParsedIntent | null {
  const value = reply.trim();
  if (pending.field === "recipient") {
    if (!isAddress(value) && !/^[^\s.]+\.base(?:\.eth)?$/iu.test(value)) {
      return null;
    }
  } else if (pending.field === "amount") {
    if (!/^\d+(?:[.,]\d+)?$/u.test(value) || Number(value.replace(",", ".")) <= 0) {
      return null;
    }
  } else if (!/^[a-z][a-z0-9]{1,23}$/iu.test(value)) {
    return null;
  }
  const completed = {
    ...pending.intent,
    [pending.field]: pending.field === "amount"
      ? value.replace(",", ".")
      : pending.field === "tokenOut"
        ? value.toUpperCase()
        : value,
    isComplete: true,
    question: "",
    message: "The missing field was added to the existing wallet-bound intent.",
  };
  if (completed.action === "appkit_bridge" && completed.destinationChain) {
    const destinationKey = completed.destinationChain
      .trim()
      .toLowerCase()
      .replace(/[_\s]+/gu, "-");
    const supportedDestination = ({
      base: "base-sepolia",
      "base-sepolia": "base-sepolia",
      ethereum: "ethereum-sepolia",
      "ethereum-sepolia": "ethereum-sepolia",
      arbitrum: "arbitrum-sepolia",
      "arbitrum-sepolia": "arbitrum-sepolia",
      optimism: "optimism-sepolia",
      "optimism-sepolia": "optimism-sepolia",
      avalanche: "avalanche-fuji",
      "avalanche-fuji": "avalanche-fuji",
    } as Readonly<Record<string, string>>)[destinationKey];
    if (!supportedDestination) return null;
    completed.destinationChain = supportedDestination;
  }
  return completed;
}

const memoryCleanupTimer = setInterval(
  () => {
    const now = Date.now();
    for (const [conversationId, session] of conversationSessions) {
      if (now - session.lastAccess > CONVERSATION_TTL_MS) {
        conversationSessions.delete(conversationId);
      }
    }
  },
  5 * 60 * 1000,
);
memoryCleanupTimer.unref();
