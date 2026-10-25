/**
 * /privacy: what Kletia stores, for how long, who else receives what, and how
 * to delete it. Every sentence restates what the code does (the long form,
 * with the file behind each period, is docs/platform/data-retention.md);
 * nothing here is a promise the code does not keep. The retention periods
 * come from @kletia/core (`INTENT_RETENTION`), the same constants the API's
 * sweep uses, so the page cannot drift from it. Pure data plus one helper,
 * so node tests load it directly.
 */
import { INTENT_RETENTION } from "@kletia/core";

export interface PrivacySection {
  /** The anchor: `/privacy#<id>`. */
  readonly id: string;
  readonly title: string;
  /** One line under the title. */
  readonly lead: string;
  readonly paragraphs: readonly string[];
  /** Rows of "what · who · how long", when the section is a list. */
  readonly rows?: readonly { readonly what: string; readonly detail: string }[];
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** The intent retention periods in words ("24 hours", "30 days"). */
export const RETENTION_WORDS = Object.freeze({
  text: `${INTENT_RETENTION.textGraceMs / HOUR} hours`,
  intent: `${INTENT_RETENTION.purgeAfterMs / DAY} days`,
  staleText: `${INTENT_RETENTION.staleTextMs / DAY} days`,
  staleIntent: `${INTENT_RETENTION.stalePurgeMs / DAY} days`,
});

export const PRIVACY_SECTIONS: readonly PrivacySection[] = [
  {
    id: "custody",
    title: "What Kletia never has",
    lead: "Kletia never holds your keys or your funds, and its server never signs a transaction.",
    paragraphs: [
      "Your own wallet signs every step. Kletia never asks for a seed phrase or a private key, and refuses a message that contains one.",
      "A transaction you sign is public on its network: the amounts, the addresses and the time. Nothing Kletia stores or deletes changes that.",
    ],
  },
  {
    id: "requests",
    title: "What you type",
    lead: `A planned request is stored with its intent. The text is removed ${RETENTION_WORDS.text} after the intent is final, and the intent ${RETENTION_WORDS.intent} after.`,
    paragraphs: [
      "When the desk or an app plans a request through the API, Kletia stores the intent: your sentence, the accounts, the steps with amounts and recipients, the quotes and the transaction references. It needs them to ask a question, re-quote, follow a bridge and issue a receipt.",
      `${RETENTION_WORDS.text[0]?.toUpperCase()}${RETENTION_WORDS.text.slice(1)} after the intent is final (completed, cancelled or expired), Kletia removes the sentence and its normalized copies and keeps only a salted digest and its length. ${RETENTION_WORDS.intent[0]?.toUpperCase()}${RETENTION_WORDS.intent.slice(1)} after that, the whole intent is deleted. An intent that never becomes final loses its text after ${RETENTION_WORDS.staleText} without a change and is deleted after ${RETENTION_WORDS.staleIntent}.`,
      "A dry run or a preview before you confirm is not stored. Transaction references (which transaction completed which step) are kept, so one transaction can never complete two intents.",
      "Kletia's application logs carry request ids and error codes, never your sentence, and name an intent by a one-way reference, not by its id. The access logs of the host or a proxy can record full web addresses, which is why the Data API takes wallet addresses in the request body.",
    ],
  },
  {
    id: "recipients",
    title: "Who else receives what",
    lead: "Planning a route means asking the venues that could carry it. They see what you want to move, and usually your wallet address.",
    paragraphs: [
      "Each plan says which quote providers it asked and whether they received your address (the intent's providersContacted, and the privacy trace returned with it).",
    ],
    rows: [
      { what: "Quote providers", detail: "Relay, Across, LI.FI, deBridge and Jupiter (plus Jupiter Lend, Kamino, and KyberSwap when the operator enables it) receive the assets, amounts, networks and usually your address, when Kletia plans and prepares a route." },
      { what: "Network RPC providers", detail: "The RPC endpoints the deployment uses, and the ones your browser reads directly, see your address, your balance reads and the transactions Kletia simulates." },
      { what: "Name services", detail: "ENS, Basenames and SNS receive a name you typed when Kletia resolves it." },
      { what: "History providers", detail: "Etherscan, Alchemy and Helius receive your addresses when you read your transaction history or turn on tracking." },
      { what: "WalletConnect", detail: "Its relay carries encrypted messages between this site and your wallet app and sees connection metadata, such as your IP address." },
      { what: "Model providers", detail: "Only when you turn model help on. See the next section for exactly what is sent." },
    ],
  },
  {
    id: "models",
    title: "Model providers",
    lead: "No model reads your request unless the deployment turns it on and you agree. What is sent then depends on the feature.",
    paragraphs: [
      "Reading an unclear sentence: one clause goes to the model as a list of Kletia's own words, with every amount and every unknown word replaced by a placeholder. Addresses and names are never sent; a clause with one is not sent at all.",
      "The portfolio assistant: the question goes with addresses, names and links masked. To word an answer it also sends up to 24 facts Kletia computed, such as balances, amounts, fees and dates, with your wallets named “EVM wallet 1” and so on, never by address.",
      "Both go through OpenRouter with one pinned serving provider, no fallbacks, and OpenRouter's zero-data-retention and no-data-collection settings. Kletia cannot audit the provider's side of that.",
      "The older console's smart parsing (the legacy planner) is different: after you allow it, your full sentence, unmasked, and the earlier turns of that short conversation go to a model through OpenRouter without those settings. The consent card says so before you choose.",
    ],
  },
  {
    id: "receipts",
    title: "Receipts",
    lead: "A receipt's signed part holds no sentence, amounts or addresses in the clear, and it is kept so receipts can always be verified.",
    paragraphs: [
      `When the text of an intent is removed (${RETENTION_WORDS.text} after it is final), Kletia also drops the receipt parts that contain it: the request and the plan. A receipt you downloaded earlier keeps them and still verifies.`,
      "When the intent is deleted, every stored disclosure of its receipts and every share link are deleted too. The signed part and its place in the public log stay.",
    ],
  },
  {
    id: "browser",
    title: "In your browser",
    lead: "Some things are kept in this browser only, never on Kletia's servers.",
    paragraphs: [
      "The desk keeps its task list (with amounts and addresses taken out of the titles), the state of each task and a model-help consent in this tab's session storage, which closes with the tab. Your theme, sound, motion and starting-network choices are kept in local storage, and WalletConnect keeps its own session data there. A developer key you load in the portal stays in the tab's memory only.",
    ],
  },
  {
    id: "other-records",
    title: "Other records",
    lead: "A few records outside intents are kept longer, and some are not deleted automatically.",
    paragraphs: [],
    rows: [
      { what: "Wallet sign-in", detail: "Sign-in sessions last 8 hours. An audit row of each sign-in attempt and account change (your address, the action, a hash of the IP address) is kept with no automatic deletion." },
      { what: "Tracking", detail: "If you turn tracking on, your tracked wallets, value snapshots and a cache of their transactions are kept until you turn it off." },
      { what: "Retries", detail: "An app that sends an Idempotency-Key has its response, the intent included, kept for 24 hours so a retry replays it." },
      { what: "Rule Book", detail: "For agent keys with a rule book: decisions (with a digest of the request, not the request) for 30 days, spend exposure for 8 days." },
    ],
  },
  {
    id: "delete",
    title: "Deleting your data",
    lead: "The holder of an intent's id can delete it now; everything else has the periods above.",
    paragraphs: [
      "An intent: DELETE /v1/intents/{id} with the intent id, no key needed (an app using the SDK calls intents.delete). It is refused only while a step is moving money; retry once it settled. Receipt disclosures alone: DELETE /v1/intents/{id}/receipt/disclosures.",
      "Tracking: turn it off on the desk. This browser's copies: close the tab or clear this site's data. Anything else, such as audit rows: ask the operator of the deployment; for this site, see the security policy for how to reach the maintainers.",
      "This page describes what the software does today. There is no separate legal privacy policy yet.",
    ],
  },
];

/** Every section anchor, in page order. */
export function privacyAnchors(): string[] {
  return PRIVACY_SECTIONS.map((section) => section.id);
}
