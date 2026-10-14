/**
 * Desk strings added with the desk itself (the rest is `content/copy.ts`).
 * Same rules: plain English, sentence case, no emoji and no em dashes; the
 * copy test renders every entry.
 */
const COPY = {
  tasks: {
    restoredWorkflow: "Restored cross-chain workflow",
    dismiss: "Dismiss",
  },
  tools: {
    panelPending: "This panel is moving into the desk. Until it arrives, describe what you need in the composer.",
  },
  failure: {
    refusedTitle: "Kletia did not plan this",
    refusedLead: "It is a safety or input check, so it is not tried anywhere else.",
  },
  wallets: {
    group: "Your wallets",
    /** Visible pill text from 640 px; the accessible name stays "Connect EVM wallet", which contains it. */
    connectEvmShort: "Connect EVM",
    connectSolanaShort: "Connect Solana",
  },
  boot: {
    loading: "Loading Kletia",
  },
} as const;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const entry of Object.values(value)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}

export const DESK_MORE_COPY = deepFreeze(COPY);
