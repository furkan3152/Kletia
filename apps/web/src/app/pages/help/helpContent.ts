/**
 * /help: answers for people using the console at /app, not for developers.
 * Every answer restates how the site already behaves (wallets sign, a
 * preview uses demo accounts, a declined signature sends nothing, test
 * networks hold no real money); nothing new is promised here. Network names
 * come from the registry, so the lists never drift. Pure data plus one
 * helper, so node tests load it directly.
 */
import { CHAINS, type NetworkKey } from "@kletia/core";

export interface HelpLink {
  readonly label: string;
  readonly to: string;
}

export interface HelpSection {
  /** The anchor: `/help#<id>`. */
  readonly id: string;
  readonly title: string;
  /** One line under the title. */
  readonly lead: string;
  readonly paragraphs: readonly string[];
  /** Numbered steps, when the answer is a procedure. */
  readonly steps?: readonly string[];
  readonly links?: readonly HelpLink[];
}

const NETWORK_KEYS = Object.keys(CHAINS) as NetworkKey[];

/** "Base, Arbitrum One, Ethereum, OP Mainnet and Polygon PoS". */
export function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Network names of one lane and virtual machine, in registry order. */
export function networkNames(lane: "production" | "testnet", vm?: "evm" | "svm"): string {
  return listNames(NETWORK_KEYS.filter((key) => CHAINS[key].lane === lane && (!vm || CHAINS[key].vm === vm)).map((key) => CHAINS[key].name));
}

export const HELP_SECTIONS: readonly HelpSection[] = [
  {
    id: "connect-wallet",
    title: "Connecting a wallet",
    lead: "Kletia plans; your own wallet signs. It never asks for a seed phrase or a private key.",
    paragraphs: [
      `EVM networks (${networkNames("production", "evm")}, plus the test networks) use an EVM wallet such as MetaMask, Rabby or Coinbase Wallet. Solana uses a Solana wallet such as Phantom, Solflare or Backpack. Connect only the kind a task needs; the console says which one when you plan.`,
      "If “Browser wallet” does nothing, no wallet extension is installed in this browser: install one, reload the page and connect again. On a phone, open kletiaai.xyz in your wallet app's own browser, or use WalletConnect when the connect window offers it.",
      "Connecting shares your public address so Kletia can read balances and plan with them. It does not let Kletia move anything: every transaction still opens in your wallet for you to approve or decline.",
    ],
    steps: [
      "Open the console and choose “Connect EVM wallet” or “Connect Solana wallet” at the top.",
      "Pick your wallet and approve the connection in it.",
      "Check that the address shown in the console is the one you expect.",
    ],
    links: [{ label: "Open the console", to: "/app" }],
  },
  {
    id: "preview",
    title: "What a preview is",
    lead: "A plan you can read before anything is signed.",
    paragraphs: [
      "When you type a sentence such as “swap 10 USDC to ETH on base”, Kletia answers with a plan: the steps (legs), the venues, the fees, the least you receive and how long it takes. Prices are quotes from the venues at that moment, so they move.",
      "Before you connect a wallet, the plan is a preview with demo accounts: the addresses and balances are examples, not yours, and nothing in it can be signed. A line such as “you have 0 USDC” in a preview is about the demo account. Connect the wallets the plan needs and Kletia plans it again with your accounts.",
      "A plan marked “Planned · not signed yet” has not moved anything. Nothing happens until you press “Review and sign”, tick “I reviewed…”, and approve each transaction in your wallet. Intent Studio shows the same plans as a dry run and never signs.",
    ],
    links: [
      { label: "Try Intent Studio", to: "/studio" },
      { label: "How Kletia keeps you in control", to: "/#security" },
    ],
  },
  {
    id: "step-failed",
    title: "When a step fails",
    lead: "What happened, and what you can do, depends on whether anything was sent.",
    paragraphs: [
      "You declined in your wallet, or the wallet closed: nothing was sent. The task says so and offers Retry, which asks your wallet again.",
      "Planning failed (“Kletia can't do that yet”, a refused sentence, or a venue that answered with an error): nothing was planned or signed. Rephrase the sentence, pick one of the suggested ones, or try again in a minute when a venue was busy.",
      "A transaction was sent but its result is not known yet: Kletia holds the task and checks the network for that transaction's evidence. It never sends the same step twice. Open the explorer link on the step to follow it there.",
      "A later step of a multi-step route failed after an earlier one settled: the money stays where the last settled step left it, in your own wallet or at the venue, and the route map shows where. You can plan the rest again from there, or stop the task between steps.",
    ],
    steps: [
      "Read the message on the task: it says whether anything was sent.",
      "If nothing was sent, use Retry or plan the sentence again.",
      "If a transaction was sent, wait for its evidence and follow the explorer link before you try again.",
    ],
    links: [{ label: "Network status", to: "/networks" }],
  },
  {
    id: "test-and-live",
    title: "Test networks and live networks",
    lead: "Test networks are a sandbox: their tokens have no value.",
    paragraphs: [
      `Live networks (${networkNames("production")}) move real money. Test networks (${networkNames("testnet")}) carry a TEST badge and use test tokens from faucets, so you can try a whole route without risk.`,
      "A plan never mixes the two: a test token can never pay for a step on a live network. The departure board marks which networks are answering right now.",
      "Developers see the same split as sandbox and live keys: a sandbox key stays on the test networks.",
    ],
    links: [
      { label: "Networks and status", to: "/networks" },
      { label: "Developer keys", to: "/developers/keys" },
    ],
  },
  {
    id: "safety",
    title: "Keeping your funds safe",
    lead: "Kletia never holds your keys or your money.",
    paragraphs: [
      "Never type or paste a seed phrase or private key into Kletia or into any site: Kletia refuses messages that look like one before anything is planned. Kletia staff will never ask for one either.",
      "Read each wallet request before you approve it: the network, the amount and, for a token approval, the exact amount being allowed. Kletia asks for an exact allowance, never an unlimited one.",
      "Kletia is in development and has not had an external audit. Start with small amounts.",
    ],
    links: [{ label: "Security model", to: "/#security" }],
  },
];

/** Section anchors are unique and URL safe. */
export function helpAnchors(sections: readonly HelpSection[] = HELP_SECTIONS): readonly string[] {
  return sections.map((section) => section.id);
}
