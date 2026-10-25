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
  /** The machine shell (the Card machine): nameplate, dial, binder, LCD, panel. */
  machine: {
    model: "K-01 intent machine",
    homeLabel: "Kletia home",
    mode: "Mode",
    tasksKey: (count: number) => `Tasks ${count}`,
    more: "More",
    binder: "Binder",
    binderOpen: (count: number) => `Binder, ${count} settled cards. Open history`,
    binderEmpty: "No settled cards yet",
    binderLast: (title: string) => `Last: ${title}`,
    lcd: "Machine status",
    machine: "Machine",
    controls: "Machine controls",
    stale: "stale",
    ready: "Ready",
    working: "Working",
    attention: "Needs you",
    idleCaption: "Idle · print head parked",
    workingCaption: "Working · the print head is busy",
    jamCaption: "Stopped · the last task did not finish",
    now: "Now",
    balances: "Balances",
    networks: (count: number) => `${count} networks`,
    balancesNone: "Connect a wallet to read live balances.",
    balancesReading: "Reading balances…",
    balancesEmpty: "No balances on the networks read.",
    today: "Today on chain",
    unknown: "Not read yet",
    sound: "Sound",
    night: "Night mode",
    wallet: "Wallet",
    walletEmpty: "No wallet in the slot",
    skipBoot: "Skip start-up",
    newTask: "New task",
    navLabel: "Desk sections",
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
