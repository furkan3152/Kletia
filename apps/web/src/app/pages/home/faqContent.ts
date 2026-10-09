/**
 * Home FAQ. Every answer restates facts already published on the site or in
 * the docs (security model, API v1, developer portal); nothing new is
 * promised here. Links are internal paths or anchors.
 */

export interface FaqLink {
  readonly label: string;
  readonly to: string;
}

export interface FaqItem {
  readonly id: string;
  readonly question: string;
  /** Paragraphs. `{protocols}` and `{networks}` are replaced with live counts. */
  readonly answer: readonly string[];
  readonly links?: readonly FaqLink[];
}

export const FAQ_ITEMS: readonly FaqItem[] = [
  {
    id: "custody",
    question: "Does Kletia ever hold my keys or funds?",
    answer: [
      "No. The API only returns unsigned transactions. Your own wallet signs every value-moving step, each step is bound to one account, and the SDK refuses to sign with a different wallet.",
    ],
    links: [{ label: "Security model", to: "/#security" }],
  },
  {
    id: "coverage",
    question: "Which networks and protocols are supported?",
    answer: [
      "Kletia currently knows {networks} networks and {protocols} protocols. Each protocol is marked execute, quote or discover, so you can see exactly what Kletia does with it today. Mainnet and testnet networks are separate lanes.",
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
      "No. A deterministic grammar compiles your sentence into an intent graph; the same request always produces the same graph for the same quotes. Wording the grammar does not support returns a 422 error with examples instead of a guess.",
    ],
    links: [{ label: "Try Intent Studio", to: "/studio" }],
  },
  {
    id: "integrate",
    question: "Can I integrate Kletia into my own product?",
    answer: [
      "Yes. The same /v1 REST API the console uses is public, with an OpenAPI 3.1 document. On top of it there is the typed @kletia/sdk, the drop-in @kletia/widget React component and an /embed page you can place in an iframe.",
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
    question: "What happens if a step fails halfway?",
    answer: [
      "Steps advance only on evidence observed on-chain or from the settlement network. A transaction whose outcome is uncertain becomes indeterminate and is recovered by its hash, never silently resent. Before anything is submitted you can retry or cancel.",
    ],
  },
  {
    id: "lanes",
    question: "Why are mainnet and testnet separate?",
    answer: [
      "They are separate capital lanes. A mainnet network and a testnet network never appear in the same intent graph, so testnet assets can never fund a production step.",
    ],
  },
  {
    id: "audit",
    question: "Is Kletia audited?",
    answer: [
      "Not yet. Kletia is development-stage software and has not been audited. The code is MIT licensed and open for review, and the security policy explains how to report a vulnerability.",
    ],
  },
];

export function fillCounts(text: string, counts: { readonly networks: number; readonly protocols: number }): string {
  return text.replace(/\{networks\}/gu, String(counts.networks)).replace(/\{protocols\}/gu, String(counts.protocols));
}
