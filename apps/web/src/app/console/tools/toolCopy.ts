/**
 * Strings of the hosted tool panels (the catalogue and the Tools view use
 * `content/copy.ts`). Same rules as the desk copy: plain English, sentence
 * case, no emoji and no em dashes; the catalogue test checks every entry.
 */
export const TOOL_COPY = Object.freeze({
  loading: (title: string) => `Loading ${title}`,
  failed: "This tool could not load. Nothing was signed. Check your connection and reload.",
  reload: "Reload",
  promptHint: (engine: string) => `Sentences from this tool go to the composer with the ${engine} engine pinned. Nothing is sent until you press Enter.`,
  promptFilled: "The sentence is in the composer.",
  engineNames: Object.freeze({ base: "Base", arbitrum: "Arbitrum", arc: "Arc" }),
  networkChoice: "Network",
  opensInNewTab: "opens in a new tab",
  solana: Object.freeze({
    connectLead: "Connect a Solana wallet to fill in your balances and sign. Quotes work without one.",
    connect: "Connect Solana wallet",
  }),
  onramp: Object.freeze({
    lead: "Coinbase sells USDC straight to your connected wallet on Base. Kletia only asks for a session for that address; Coinbase handles the purchase.",
    connectLead: "Connect an EVM wallet first: Coinbase funds that address on Base.",
    connect: "Connect EVM wallet",
    open: "Open Coinbase",
  }),
});
