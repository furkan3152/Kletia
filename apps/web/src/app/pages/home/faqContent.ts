/**
 * Home FAQ. Every answer restates facts already published on the site or in
 * the docs (security model, API v1, developer portal); nothing new is
 * promised here. Links are internal paths or anchors.
 */
import { protocolNoun } from "../../site/protocolCount";

export interface FaqLink {
  readonly label: string;
  readonly to: string;
}

export interface FaqItem {
  readonly id: string;
  readonly question: string;
  /** Paragraphs. `{networks}`, `{protocols}` ("29 protocols") and `{ownContracts}` are replaced with live counts. */
  readonly answer: readonly string[];
  readonly links?: readonly FaqLink[];
}

export const FAQ_ITEMS: readonly FaqItem[] = [
  {
    id: "custody",
    question: "Does Kletia ever hold my keys or funds?",
    answer: [
      "No. The API only returns unsigned transactions. Your own wallet signs every leg that moves value, each leg is bound to one account, and the SDK refuses to sign it with a different wallet.",
    ],
    links: [{ label: "Security model", to: "/#security" }],
  },
  {
    id: "coverage",
    question: "Which networks and protocols are supported?",
    answer: [
      "Kletia knows {networks} networks and {protocols} today. {ownContracts}Each protocol is marked execute, quote or discover, so you can see what Kletia does with it. Mainnet and testnet networks are separate capital and never share a plan.",
    ],
    links: [
      { label: "Network status", to: "/networks" },
      { label: "Protocol directory", to: "/protocols" },
    ],
  },
  {
    id: "model",
    question: "Is an AI model deciding my transactions?",
    answer: [
      "No. A grammar compiles your sentence into a plan, and the same request with the same quotes always gives the same plan. Wording the grammar does not know returns a 422 error with phrases it does know, never a guess.",
    ],
    links: [{ label: "Try Intent Studio", to: "/studio" }],
  },
  {
    id: "integrate",
    question: "Can I integrate Kletia into my own product?",
    answer: [
      "Yes. The /v1 REST API the console uses is public and described by an OpenAPI 3.1 document. On top of it there is the typed @kletia/sdk, the @kletia/widget React component and an /embed page you can place in an iframe.",
    ],
    links: [
      { label: "Quickstart", to: "/developers#quickstart" },
      { label: "Embed guide", to: "/developers#embed" },
    ],
  },
  {
    id: "keys",
    question: "Do I need an API key?",
    answer: [
      "Not to start. The public tier needs no key: registries, quotes and planning work at 30 requests per minute per IP, and the /embed page always uses it. A developer key raises the limit to 300 requests per minute and adds intent listing and webhooks.",
    ],
    links: [{ label: "Developer keys", to: "/developers#keys" }],
  },
  {
    id: "failure",
    question: "What happens if a leg fails halfway?",
    answer: [
      "A leg moves forward only on evidence read on-chain or reported by the settlement network. A transaction whose outcome is unknown is marked held and recovered by its hash, never sent twice. Before anything is submitted you can retry or cancel.",
    ],
  },
  {
    id: "lanes",
    question: "Why are mainnet and testnet separate?",
    answer: [
      "They are separate capital. A mainnet network and a testnet network never appear in the same plan, so test tokens can never pay for a production leg.",
    ],
  },
  {
    id: "audit",
    question: "Is Kletia audited?",
    answer: [
      "Not yet. Kletia is in development and has not been audited. The code is MIT licensed and open for review, and the security policy explains how to report a vulnerability.",
    ],
  },
];

/**
 * `{protocols}` counts real protocols only (never the "custom" registry
 * entries); `{ownContracts}` names bring-your-own-contract separately.
 */
export function fillCounts(
  text: string,
  counts: { readonly networks: number; readonly protocols: number; readonly ownContracts?: boolean },
): string {
  return text
    .replace(/\{networks\}/gu, String(counts.networks))
    .replace(/\{protocols\}/gu, protocolNoun(counts.protocols))
    .replace(/\{ownContracts\}/gu, counts.ownContracts ? "Developers can register custom contracts for their own project integrations; Kletia's main website does not execute them. " : "");
}
