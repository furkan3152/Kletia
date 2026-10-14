/**
 * Helpers of the network engines (the legacy Base, Arbitrum One and Arc chat
 * engines behind `POST /api/intent`), moved unchanged from the old console
 * shell (`App.tsx`).
 */
import React from "react";
import type { Hex } from "viem";
import { explorerTxUrl, formatAccountId } from "@kletia/core";
import type { NetworkMode } from "../../../shared/config/networks";
import { recordActivity } from "../../../shared/sync/activityStore";
import { emitPortfolioInvalidated } from "../../../shared/sync/bus";
import type { IntentResponse } from "../../../shared/types";

// The API defaults to the public Intent Router V2 deployment; keep both sides
// aligned unless an operator overrides VITE_BASE_SWAP_EXECUTION_MODE.
export const BASE_SWAP_EXECUTION_POLICY_SETTING =
  import.meta.env.VITE_BASE_SWAP_EXECUTION_MODE?.trim() || "intent_v2";

export const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/**
 * Modules a network engine may open (`action: "open_widget"`): the old
 * console's tabs, per engine network. The desk maps each to its tool.
 */
export type EngineTab = "chat" | "basename" | "allora" | "airdrop" | "x402" | "webacy" | "arc" | "lending";

export const ENGINE_TABS: Readonly<Record<NetworkMode, readonly EngineTab[]>> = Object.freeze({
  base: Object.freeze(["chat", "webacy", "allora", "basename", "airdrop", "x402"] as const),
  arc: Object.freeze(["chat", "arc", "lending"] as const),
  arbitrum: Object.freeze(["chat", "webacy"] as const),
});

const ALL_ENGINE_TABS: ReadonlySet<string> = new Set<string>(Object.values(ENGINE_TABS).flat());

export const isEngineTab = (value: unknown): value is EngineTab =>
  typeof value === "string" && ALL_ENGINE_TABS.has(value);

/** An engine-pinned sentence that names Solana or crosses networks: the engines cannot run it. */
export const CROSS_NETWORK_ENGINE_MESSAGE =
  "This sentence involves Solana or more than one network, which the EVM engines cannot run. Send it from the desk's composer without an engine pin and Kletia's planner will plan it.";

export const createRequestId = (): string => {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();

  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0"));
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10, 16).join(""),
  ].join("-");
};

export const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    const sanitized = error.message
      .replace(/https?:\/\/[^\s"'<>]+/giu, "[redacted-url]")
      .replace(
        /\b(?:authorization|signature|api[-_ ]?key)\b\s*[:=]\s*[^\s,;]+/giu,
        "[redacted-credential]",
      )
      .replace(/\b0x[a-f\d]{96,}\b/giu, "[redacted-payload]")
      .replace(/\b[A-Za-z\d+/_-]{80,}={0,2}\b/gu, "[redacted-payload]")
      .trim();
    return sanitized || "Unknown system error.";
  }
  return "Unknown system error.";
};

export const parseExpiry = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return undefined;
};

export const requiresExplicitLiquiditySelection = (
  response: IntentResponse,
): boolean =>
  response.liquidityRoutingEvidence?.selectionPolicy ===
    "explicit_wallet_position_selection" &&
  (response.allRoutes?.length || 0) > 1;

export const isCalldata = (value: unknown): value is Hex =>
  typeof value === "string" && /^0x(?:[0-9a-fA-F]{2}){4,}$/.test(value);

export const isUnsignedIntegerString = (value: unknown): value is string =>
  typeof value === "string" && /^\d+$/.test(value);

export const describeAction = (action: string | undefined): string => {
  const normalized = (action ?? "").trim().replace(/_/gu, " ");
  return normalized
    ? `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}`
    : "Transaction";
};

/**
 * Record a confirmed EVM execution in the shared activity feed and ask every
 * balance view for this account to re-read.
 */
export const recordEvmActivity = ({
  network,
  hash,
  title,
  walletAddress,
}: {
  network: NetworkMode;
  hash: string;
  title: string;
  walletAddress: string;
}) => {
  try {
    recordActivity({
      id: hash,
      network,
      title,
      status: "confirmed",
      reference: hash,
      url: explorerTxUrl(network, hash),
    });
    emitPortfolioInvalidated(formatAccountId(network, walletAddress), network, title);
  } catch {
    // Activity is a convenience; it must never interrupt a confirmed execution.
  }
};

export const renderSafeMessage = (text: string) => {
  const cleanText = text.replace(/\[SHOW_ONRAMP\]/g, "");
  const sections = cleanText.split(/(\*\*[^*]+\*\*)/g);

  return (
    <span className="whitespace-pre-wrap">
      {sections.map((section, index) =>
        section.startsWith("**") && section.endsWith("**") ? (
          <strong
            key={`${index}-${section}`}
            className="text-[#1A1A1A] dark:text-white font-black border-b-[3px] border-[#0052FF] pb-0.5"
          >
            {section.slice(2, -2)}
          </strong>
        ) : (
          <React.Fragment key={`${index}-${section}`}>{section}</React.Fragment>
        ),
      )}
    </span>
  );
};
