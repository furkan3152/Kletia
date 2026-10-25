/**
 * Every fixed string of the desk's Perps view, as data: plain English, no
 * emoji, no em dash (the same rules as content/copy.ts, checked by
 * perps.test.mjs). Venue and network names come from @kletia/core.
 */

const COPY = {
  heading: "Perps",
  intro: "Leveraged long and short positions on GMX, Hyperliquid and Drift. Kletia builds the order; your wallet signs it. Nothing is held by Kletia.",
  risk: {
    heading: "Read this before you trade",
    lines: [
      "Leverage multiplies losses as much as gains. At 10x, a 10% move against you wipes out your collateral.",
      "The liquidation price is an estimate. Funding, fees and the venue's own margin rules move it, so keep a buffer.",
      "Funding is paid or received every hour while the position is open. Positive rates mean your side pays.",
      "Orders fill at the market. The acceptable price caps slippage; past it the order does not fill.",
    ],
  },
  markets: {
    heading: "Markets",
    market: "Market",
    mark: "Mark price",
    /** Funding a long pays (positive) or earns (negative) per hour. */
    fundingShort: "Long funding /h",
    openInterest: "Open interest",
    loading: "Reading venue prices...",
    empty: "No venue price could be read right now. Kletia never shows a guessed price.",
    unavailable: (venue: string, reason: string) => `${venue} is unavailable: ${reason}`,
    disabled: (venue: string) => `${venue} is read-only in Kletia.`,
    choose: (market: string, venue: string) => `Trade ${market} on ${venue}`,
    trade: "Trade",
    refresh: "Refresh prices",
  },
  ticket: {
    heading: "Order ticket",
    long: "Long",
    short: "Short",
    sideLabel: "Direction",
    marketLabel: "Market",
    venueLabel: "Venue",
    bestVenue: "Best venue",
    bestVenueNamed: (venue: string) => `Best venue (now ${venue})`,
    collateralLabel: "Collateral",
    collateralAsset: "USDC",
    collateralHint: "USDC you put up. It is the most you can lose on this position.",
    leverageLabel: (value: string) => `Leverage ${value}x`,
    sizeLabel: "Position size",
    slippageLabel: "Slippage limit",
    entry: "Expected entry",
    acceptable: "Worst fill accepted",
    liquidation: "Estimated liquidation price",
    noLiquidation: "None by price alone",
    fees: "Fees (open and close)",
    execution: "Execution fee",
    funding: "Funding per hour",
    quote: "Get quote",
    review: "Review and sign",
    walletNeeded: (kind: string) => `Connect an ${kind} wallet to trade here.`,
    connect: "Connect wallet",
    whyVenue: "Why this venue",
    choiceCost: (venue: string, cost: string) => `${venue}: ${cost} in fees, a day of funding and price impact`,
    sizeAt: (size: string, leverage: string) => `${size} at ${leverage}x`,
    notEligible: (venue: string, reason: string) => `${venue}: ${reason}`,
    /** The one computed risk sentence under the quote. */
    riskSentence: (symbol: string, side: string, percent: string, price: string, collateral: string) =>
      `If ${symbol} ${side === "short" ? "rises" : "falls"} ${percent}% to ${price}, this position closes and you lose the ${collateral} USDC.`,
    riskNoLiquidation: (collateral: string) => `No liquidation by price alone here. Fees and funding still cost you, up to the ${collateral} USDC.`,
    venueBestDetail: "lowest total cost",
    venueBestNow: (venue: string) => `now ${venue}`,
    venueMax: (leverage: string) => `up to ${leverage}x`,
    venueReadOnly: "read-only",
    moreNumbers: "Every number of this quote",
    sizeHint: (size: string) => `Position size ${size}`,
  },
  tape: {
    label: (symbol: string, venue: string) => `${symbol} mark price on ${venue}, as read by this browser`,
    caption: (seconds: string, since: string) => `Mark price read every ${seconds} s since ${since} by this browser. Kletia keeps no candle history, so the line starts when Trade opened.`,
    waiting: "The line starts with the next read of the mark price.",
    empty: "No mark price for this market yet.",
    mark: (price: string) => `Mark ${price}`,
    entry: (price: string) => `Entry ${price}`,
    liquidation: (price: string) => `Liq ${price}`,
    venueLine: (venue: string, funding: string, openInterest: string) => `${venue} · long funding ${funding} /h · open interest ${openInterest}`,
    pickLabel: "Market",
  },
  lists: {
    label: "Positions and markets",
    positions: (count: string) => `Positions ${count}`,
    markets: "Markets",
  },
  steps: {
    heading: "Sign in your wallet",
    start: "Start signing",
    cancel: "Cancel",
    signing: "Waiting for your wallet...",
    confirming: "Waiting for the network...",
    relaying: "Sending your signed order to the venue...",
    done: "Done",
    failed: "Failed",
    settle: (seconds: string) => `The venue needs about ${seconds} s to credit this before the next step.`,
    continue: "Continue",
    expired: "Prices moved since this was prepared. Get a new quote.",
    locked: "Another task is signing. Finish or stop it first.",
    finished: "Order sent. The position appears below once the venue fills it.",
  },
  positions: {
    heading: "Your positions",
    none: "No open positions on these venues.",
    connect: "Connect a wallet to see your positions.",
    size: "Size",
    entry: "Entry",
    mark: "Mark",
    liquidation: "Liquidation",
    pnl: "PnL",
    away: (price: string, percent: string) => `${price} (${percent}% away)`,
    close: "Close",
    reduce: "Reduce by half",
    pnlNote: "PnL is the price move at the mark, before closing fees and unsettled funding.",
    unsupported: (count: string) => `${count} more GMX positions use markets Kletia does not list. Manage them on GMX.`,
    unavailable: (venue: string) => `${venue} positions could not be read.`,
  },
} as const;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}

export const PERPS_COPY = deepFreeze(COPY);
