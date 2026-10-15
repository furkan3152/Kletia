/**
 * Every fixed string of the desk at /app, as data. Plain English,
 * sentence case, no emoji and no em dashes: the copy test renders every
 * entry, templates included, and checks those rules.
 *
 * Network names never live here: they come from the @kletia/core registry
 * (`CHAINS[key].name` or `.shortName`) and are passed into the templates.
 */

import { countWord, NETWORK_COUNT } from "../../site/networkCount.ts";

const COPY = {
  page: {
    /** Unchanged, so every "Open the console" link still fits. */
    title: "Kletia Console",
    description: "Plan and sign intents on all nine Kletia networks from one sentence, with your own wallets.",
  },

  header: {
    brand: "Kletia",
    product: "Console",
    navLabel: "Console",
    viewNavLabel: "Console views",
    views: {
      desk: "Desk",
      tasks: "Tasks",
      holdings: "Holdings",
      tools: "Tools",
      activity: "Activity",
    },
    tasksButton: (count: number) => `Tasks (${count})`,
    tasksView: (count: number) => `Tasks ${count}`,
    skipToComposer: "Skip to the composer",
    skipToContent: "Skip to content",
    themeToDark: "Use dark theme",
    themeToLight: "Use light theme",
  },

  wallets: {
    connectEvm: "Connect EVM wallet",
    connectSolana: "Connect Solana wallet",
    compactEvm: "EVM",
    compactSolana: "SOL",
    evmLabel: "EVM",
    solanaLabel: "Solana",
    /** Accessible name of a connected pill; it contains the visible text. */
    evmConnected: (wallet: string, address: string) => `EVM wallet ${wallet} ${address}, open account options`,
    solanaConnected: (wallet: string, address: string) => `Solana wallet ${wallet} ${address}, open account options`,
    connected: "connected",
    notConnected: "not connected",
  },

  empty: {
    kicker: "Platform 1 · Console",
    heading: "Where should the money go?",
    lead: `One sentence on any of ${countWord(NETWORK_COUNT)} networks. Kletia plans it, shows the fare, and your wallet signs every step.`,
    statusBoard: "Departures · network status",
    statusBoardLabel: "Network status",
    testYard: "Test yard",
    tryOne: "Try one",
    tryOneHint: "Fills the composer; nothing is sent.",
    latency: (milliseconds: number) => `${milliseconds} ms`,
  },

  composer: {
    label: "Describe what should happen",
    placeholderAuto: "bridge 25 USDC from base to solana",
    /** Placeholder when a departure is chosen: a sentence that starts there. */
    placeholderFrom: (sentence: string) => sentence,
    send: "Plan",
    sendLabel: "Plan this sentence",
    sendAnswer: "Send answer",
    enterHint: "Enter plans",
    newLineHint: "Shift and Enter add a line",
    examples: "Examples",
    examplesLabel: "Example sentences",
    fromChip: "From",
    fromChipLabel: (departure: string) => `Departure: ${departure}. Change where the money starts`,
    enginePin: (network: string) => `${network} engine`,
    enginePinLabel: (network: string) => `The next sentence goes to the ${network} engine. Remove`,
    answering: (title: string) => `Answering: ${title}`,
    answeringLabel: (title: string) => `Answering the question about ${title}. Remove to start a new task`,
    removeChip: (label: string) => `Remove ${label}`,
    testYardBadge: "Test yard",
    errors: {
      empty: "Type what should happen first.",
      tooLong: (limit: number) => `Keep it to ${limit} characters or fewer.`,
      secret: "Private keys, seed phrases and API keys never go into Kletia. Nothing was sent or saved.",
      placeholder: (placeholder: string) => `Replace ${placeholder} with your own value, then plan.`,
    },
    commands: {
      portfolio: "Opened your holdings.",
      activity: "Opened your activity.",
      tools: "Opened the tools.",
    },
  },

  departure: {
    auto: "Auto",
    autoCode: "AUTO",
    captionAutoNoWallet: "Kletia picks",
    captionAutoMostFunds: (network: string) => `most funds: ${network}`,
    captionHere: (usd: string) => `${usd} here`,
    captionEmpty: "empty here",
    captionTestYard: "test yard",
    pinnedBy: (tool: string) => `set by the ${tool}`,
    boardTitle: "Departures",
    boardSubtitle: "Where your money starts",
    boardLabel: "Choose where your money starts",
    autoDescription: "Kletia picks a network that holds enough, task by task",
    autoExplained:
      "Auto keeps the first action on its own network when your balance there covers it; otherwise it starts from the network holding the most of what you spend.",
    autoMostFunds: (network: string, usd: string) => `Most funds right now: ${network}, ${usd}`,
    groupProduction: "Production",
    groupTestYard: "Test yard · separate capital",
    columnBalance: "Your balance",
    columnStatus: "Status",
    showYard: (count: number) => `Test yard (${count}) · separate capital`,
    hideYard: "Hide",
    status: {
      running: "Running",
      delayed: "Delayed",
      noService: "No service",
      notOffered: "Not offered",
      unknown: "Status unknown",
    },
    disabledNoService: "No service: the network's RPC is not answering.",
    disabledNotOffered: "Not available on this deployment.",
    walletHintEvm: "Connect an EVM wallet to see balances",
    walletHintSolana: "Connect a Solana wallet to see balances",
    empty: "empty",
    test: "test",
    noBalance: "no balance read yet",
    balancesRead: (time: string) => `Balances read ${time} from your connected wallets`,
    refresh: "Refresh",
    keyboardHint: "Arrow keys choose · Enter confirms · Esc closes",
    done: "Done",
    close: "Close",
    lanes: { production: "production", testnet: "test yard" },
    /** Spoken row name: "Base, production, 120.40 USDC and 0.002 ETH, about 127 dollars, running". */
    rowLabel: (network: string, lane: string, balances: string, value: string, status: string) =>
      [network, lane, balances, value, status].filter((part) => part.length > 0).join(", "),
    aboutDollars: (dollars: string) => `about ${dollars} dollars`,
    continueFrom: (network: string) => `Continue from ${network}`,
  },

  ticket: {
    kicker: "Kletia intent ticket",
    serial: (serial: string) => `No. ${serial}`,
    youAskedFor: "You asked for",
    from: "From",
    to: "To",
    engineBadge: (network: string) => `${network} engine`,
    testYardRibbon: "Test yard",
    articleLabel: (serial: string, title: string) => `Task ${serial}: ${title}`,
    lines: {
      auto: (network: string, holding: string) => `Departs ${network} · picked by Kletia: ${holding} there`,
      autoNoHolding: (network: string) => `Departs ${network} · picked by Kletia`,
      request: (network: string) => `Departs ${network}, as you chose`,
      requestBridged: (network: string, destination: string) =>
        `Departs ${network}, as you chose · Kletia adds a bridge to ${destination} first`,
      text: (network: string, chosen: string) => `Departs ${network} · your sentence names it (the departure said ${chosen})`,
      inferred: (network: string) => `Departs ${network}`,
      mismatch: (network: string, chosen: string) => `This plan starts on ${network}, not ${chosen}.`,
      startFromInstead: (network: string) => `Start from ${network} instead`,
      change: "Change",
    },
    stepProgress: (step: number, total: number) => `Step ${step} of ${total}`,
  },

  tasks: {
    railTitle: "Tasks · this tab",
    regionLabel: "Tasks in this tab",
    listLabel: "Tasks in this tab, newest first",
    newTask: "New task",
    clearFinished: "Clear finished",
    none: "No tasks yet. Plan a sentence to start one.",
    open: "Open",
    collapse: "Collapse",
    status: {
      planning: "Planning",
      preview: "Preview",
      question: "Question",
      review: "In review",
      executing: "Signing",
      paused: "Paused",
      completed: "Settled",
      failed: "Failed",
      cancelled: "Cancelled",
      unsupported: "Not supported",
      engine: "Network engine",
    },
    stub: (serial: string, title: string, route: string, status: string, time: string) =>
      [serial, title, route, `${status} ${time}`.trim()].filter((part) => part.length > 0).join(" · "),
    route: (from: string, to: string) => (from === to ? from : `${from} to ${to}`),
    planning: "Planning with your accounts.",
    planningPreview: "Planning a preview with demo accounts.",
    signingLocked: "Another task is signing. Finish or stop it first.",
    routeMap: "Route map",
    openInStudio: "Open in Studio",
    planAgain: "Plan again",
    planAnother: "Plan another",
    pickUp: "Pick up where you left off",
    resume: "Resume",
    pickedUpFromStudio: "Picked up from Studio",
    pickedUpFromAsk: "Picked up from the Solana Ask tab",
    questionCleared: "This question was cleared when the page reloaded. Type the task again.",
    sentenceForgotten: "The sentence stays in this tab's memory only; after a reload the title is all that is kept.",
    announcements: {
      added: "Task added",
      question: (title: string) => `Kletia has a question about ${title}`,
    },
  },

  preview: {
    notice: "Preview with demo accounts. Nothing can be signed until you connect the wallets this plan needs.",
    connectHint: "Connect the wallets this plan needs; Kletia then plans it again with your accounts.",
    connectEvm: "Connect EVM wallet",
    connectSolana: "Connect Solana wallet",
    replanning: "Planning again with your accounts.",
  },

  unsupported: {
    heading: "Kletia's planner does not cover this yet",
    hintsLabel: "Sentences Kletia plans today",
    hintChipLabel: (sentence: string) => `Put "${sentence}" in the composer`,
    offerLead: "A network engine may still plan it on its own network:",
    askEngine: (network: string) => `Ask the ${network} engine`,
    noEngine: "No network engine serves this network either.",
    refused: "Kletia refused this plan. It is a safety or input check, so it is not tried anywhere else.",
  },

  source: {
    question: (amount: string, asset: string) => `Where should the ${amount} ${asset} come from?`,
    questionGeneric: "Where should the money come from?",
    candidate: (network: string, balance: string) => `${network} · ${balance}`,
    candidateShort: (network: string) => `${network} · not enough`,
    candidateLabel: (network: string, balance: string, enough: string) => `Start from ${network}, balance ${balance}, ${enough}`,
    enough: "enough",
    notEnough: "not enough",
    none: "None of your connected networks holds enough. Fund one, then plan again.",
    unreachable: "This sentence cannot start from that network.",
  },

  engine: {
    names: {
      base: "Base engine",
      arbitrum: "Arbitrum engine",
      arc: "Arc engine",
    },
    whyFallback: (network: string) => `Kletia's cross-network planner does not cover this; the ${network} engine does.`,
    whyTool: (tool: string) => `The ${tool} tool sent this sentence to its network engine.`,
    whyOffer: (network: string) => `You asked the ${network} engine to plan this.`,
    signsOn: (network: string) => `It plans and signs on ${network} only.`,
    wrongChain: (walletNetwork: string, taskNetwork: string) =>
      `Your EVM wallet is on ${walletNetwork}. This task signs on ${taskNetwork}.`,
    unknownChain: "another network",
    switchTo: (network: string) => `Switch to ${network}`,
    switching: "Switching networks in your wallet.",
    switchFailed: "The wallet did not switch networks. Nothing was signed.",
    loading: "Loading the network engine.",
  },

  holdings: {
    title: "Holdings",
    asideLabel: "Holdings",
    refresh: "Refresh holdings",
    refreshedAt: (time: string) => `Read ${time}`,
    laneTotal: (lane: string, total: string) => `${lane} · ${total} priced`,
    unpriced: (count: number) => `${count} unpriced`,
    empty: "empty",
    notUpdated: (time: string) => `not updated since ${time}`,
    startHere: "Start here",
    startHereLabel: (network: string) => `Start the next task from ${network}`,
    fund: "Fund",
    fundCoinbase: "Fund (Coinbase)",
    fundFaucet: "Get test USDC",
    fundBridge: (sentence: string) => sentence,
    testYard: (names: string) => `Test yard · ${names}`,
    showTestYard: "Show the test yard",
    verifiedScans: "Verified position scans",
    scanPrompt: {
      base: "Show my Base portfolio",
      arbitrum: "Show my Arbitrum portfolio",
      arc: "Show my Arc portfolio",
    },
    connect: "Connect a wallet to see your holdings on every network.",
    loading: "Reading your balances.",
    unavailable: "Holdings could not be read right now.",
    perAccount: "Read one network at a time (this API has no batch holdings route).",
  },

  activity: {
    title: "Activity",
    all: "All activity",
    peekLabel: "Latest activity",
    empty: "Nothing has happened in this browser yet.",
  },

  tools: {
    title: "Tools",
    search: "Search tools",
    networkFilter: "Network",
    kindFilter: "Kind",
    all: "All",
    testYard: "Test yard",
    open: "Open",
    back: "All tools",
    noMatch: "No tool matches these filters.",
    loading: "Loading the tool.",
    needs: {
      evm: "EVM wallet",
      solana: "Solana wallet",
      none: "No wallet",
    },
    needsOn: (wallet: string, network: string) => `Needs an ${wallet} on ${network}`,
    kinds: {
      panel: "Panel",
      form: "Form",
      "read-only": "Read only",
      prompt: "Prompt",
      link: "Link",
    },
    categories: {
      pay: "Pay",
      earn: "Earn",
      swap: "Swap",
      send: "Send",
      names: "Names",
      security: "Security",
      data: "Data",
      funding: "Funding",
      contracts: "Contracts",
      agents: "Agents",
    },
    opensInNewTab: "opens in a new tab",
  },

  errors: {
    unreachable: "The Kletia API is unreachable from this browser right now.",
    rateLimited: "Rate limit reached. Wait a minute and try again.",
    generic: "Something went wrong. Nothing was signed.",
  },
} as const;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const entry of Object.values(value)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}

export const DESK_COPY = deepFreeze(COPY);

export type DeskCopy = typeof DESK_COPY;
