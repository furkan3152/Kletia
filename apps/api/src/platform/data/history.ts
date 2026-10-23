/**
 * Kletia activity of the calling key (`GET /v1/data/history`): its intents
 * (newest first), the receipt issued for each finished one, and its intent
 * links, merged into one timeline. With a wallet set, only intents planned
 * for one of those wallets are listed (links are not tied to a wallet and are
 * left out then). Read from the existing stores; nothing is changed.
 */
import { parseAccountId, type DataHistory, type DataHistoryEntry, type DataWalletSet, type IntentGraph } from "@kletia/core";
import { listIntents } from "../engine/service.js";
import { linkStore } from "../http/links/store.js";
import { linksEnabled } from "../http/links/service.js";
import { receiptStore } from "../http/receipts/store.js";
import { inWalletSet } from "./wallets.js";

export const HISTORY_LIMITS = Object.freeze({ defaultLimit: 50, maxLimit: 100 });

const FINISHED: ReadonlySet<string> = new Set(["completed", "partially_completed", "failed", "cancelled", "expired"]);

function forWallets(intent: IntentGraph, wallets: Pick<DataWalletSet, "evm" | "solana">): boolean {
  return intent.request.accounts.some((account) => {
    const parsed = parseAccountId(account);
    return parsed !== null && inWalletSet(wallets, parsed.address);
  });
}

function intentEntry(intent: IntentGraph): DataHistoryEntry {
  return {
    kind: "intent",
    id: intent.id,
    at: intent.createdAt,
    status: intent.status,
    title: intent.summary.title,
    networks: intent.summary.networks,
    intentId: intent.id,
    source: "kletia",
  };
}

async function receiptEntry(intent: IntentGraph): Promise<DataHistoryEntry | null> {
  if (!FINISHED.has(intent.status)) return null;
  const receipt = await receiptStore().latest(intent.id).catch(() => null);
  if (!receipt) return null;
  return {
    kind: "receipt",
    id: receipt.id,
    at: receipt.issuedAt,
    status: receipt.intentStatus,
    title: `Receipt: ${intent.summary.title}`,
    networks: intent.summary.networks,
    intentId: intent.id,
    source: "kletia",
  };
}

/** The key's timeline, newest first, at most `limit` entries. */
export async function readHistory(keyId: string, options: { readonly wallets?: Pick<DataWalletSet, "evm" | "solana"> | null; readonly limit?: number } = {}): Promise<DataHistory> {
  const limit = Math.max(1, Math.min(HISTORY_LIMITS.maxLimit, options.limit ?? HISTORY_LIMITS.defaultLimit));
  const wallets = options.wallets ?? null;
  const intents = (await listIntents(keyId, limit)).filter((intent) => !wallets || forWallets(intent, wallets));
  const receipts = await Promise.all(intents.map(receiptEntry));
  const links = !wallets && linksEnabled() ? await linkStore().listByOwner(keyId, { limit }) : [];
  const entries: DataHistoryEntry[] = [
    ...intents.map(intentEntry),
    ...receipts.filter((entry): entry is DataHistoryEntry => entry !== null),
    ...links.map((link): DataHistoryEntry => ({
      kind: "link",
      id: link.id,
      at: link.createdAt,
      status: link.status,
      title: link.definition.title,
      networks: [...new Set(link.definition.destination.actions.map((action) => action.network))],
      intentId: null,
      source: "kletia",
    })),
  ];
  entries.sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id));
  return { entries: entries.slice(0, limit), filtered: wallets !== null, asOf: new Date().toISOString() };
}
