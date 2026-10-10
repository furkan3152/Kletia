/**
 * The link builder's three templates (links design §11.5) and the draft →
 * definition translation. Pure; only `@kletia/core` imports, so node tests
 * load it directly. The definition is always checked with
 * `validateLinkDefinition` before it is sent.
 */
import { CHAINS, LINK_ID_PATTERN, type LinkStatus, type LinkView, type NetworkKey } from "@kletia/core";

export type LinkTemplateId = "get-paid" | "deposit" | "bridge-stake";

export interface BoundsDraft {
  readonly min: string;
  readonly max: string;
  readonly default: string;
}

export interface LinkDraft {
  readonly template: LinkTemplateId;
  readonly title: string;
  readonly description: string;
  readonly publisherName: string;
  readonly website: string;
  /** Destination network (transfer, contract or stake network). */
  readonly network: NetworkKey;
  /** Get paid. */
  readonly recipient: string;
  readonly payAmount: string;
  readonly payAsset: string;
  /** Deposit into my contract: a registration id or alias, and its entry. */
  readonly contract: string;
  readonly entry: string;
  /** Bridge and stake: what the stake produces. */
  readonly stakeFrom: string;
  readonly stakeTo: string;
  readonly fundingNetworks: readonly NetworkKey[];
  readonly fundingAssets: readonly string[];
  readonly amountMode: "input" | "deliver";
  readonly bounds: Readonly<Record<string, BoundsDraft>>;
  /** yyyy-mm-dd, or "" for the default (30 days). */
  readonly expiresOn: string;
  readonly maxUses: string;
  readonly perAccountMaxUses: string;
  readonly maxSlippageBps: string;
  readonly blink: boolean;
  readonly allowHolds: boolean;
}

export interface LinkTemplate {
  readonly id: LinkTemplateId;
  readonly title: string;
  readonly summary: string;
  readonly draft: LinkDraft;
}

const BASE: Omit<LinkDraft, "template" | "title" | "description" | "network" | "fundingNetworks" | "fundingAssets" | "amountMode" | "bounds"> = {
  publisherName: "",
  website: "",
  recipient: "",
  payAmount: "25",
  payAsset: "USDC",
  contract: "",
  entry: "deposit",
  stakeFrom: "SOL",
  stakeTo: "JitoSOL",
  expiresOn: "",
  maxUses: "",
  perAccountMaxUses: "",
  maxSlippageBps: "",
  blink: false,
  allowHolds: false,
};

export const LINK_TEMPLATES: readonly LinkTemplate[] = [
  {
    id: "get-paid",
    title: "Get paid",
    summary: "A fixed amount to your address or name, from any network your payer is on. The amount arrives in full: Kletia sizes the input.",
    draft: {
      ...BASE,
      template: "get-paid",
      title: "Pay 25 USDC to Acme",
      description: "",
      network: "base",
      fundingNetworks: ["base", "arbitrum", "optimism", "solana"],
      fundingAssets: ["USDC"],
      amountMode: "deliver",
      bounds: {},
      maxUses: "1",
      blink: true,
    },
  },
  {
    id: "deposit",
    title: "Deposit into my contract",
    summary: "Visitors fund your registered contract entry from any listed network and asset, within the bounds you set.",
    draft: {
      ...BASE,
      template: "deposit",
      title: "Deposit USDC into Acme Vault",
      description: "From any network. Arrives as vault shares in your wallet.",
      network: "base",
      fundingNetworks: ["base", "arbitrum", "optimism", "ethereum", "polygon", "solana"],
      fundingAssets: ["USDC"],
      amountMode: "input",
      bounds: { USDC: { min: "10", max: "5000", default: "100" } },
    },
  },
  {
    id: "bridge-stake",
    title: "Bridge and stake",
    summary: "Visitors bring ETH, USDC or SOL from any network and leave with a Solana liquid staking token in their own wallet.",
    draft: {
      ...BASE,
      template: "bridge-stake",
      title: "Bridge to Solana and stake as JitoSOL",
      description: "",
      network: "solana",
      fundingNetworks: ["ethereum", "base", "arbitrum", "optimism", "polygon", "solana"],
      fundingAssets: ["ETH", "USDC", "SOL"],
      amountMode: "input",
      bounds: { ETH: { min: "0.005", max: "2", default: "" }, USDC: { min: "10", max: "5000", default: "" }, SOL: { min: "0.05", max: "25", default: "" } },
      blink: true,
    },
  },
];

export function templateDraft(id: LinkTemplateId): LinkDraft {
  return (LINK_TEMPLATES.find((template) => template.id === id) ?? LINK_TEMPLATES[0]!).draft;
}

function endOfDay(date: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) return null;
  return `${date}T23:59:59Z`;
}

/** The first destination action of the draft. */
export function destinationAction(draft: LinkDraft): Record<string, unknown> {
  if (draft.template === "get-paid") {
    return { kind: "transfer", network: draft.network, from: draft.payAsset, amount: draft.payAmount.trim(), recipient: draft.recipient.trim() };
  }
  if (draft.template === "deposit") {
    return { kind: "call", network: draft.network, contract: draft.contract.trim(), entry: draft.entry.trim(), amount: draft.amountMode === "input" ? "$amount" : draft.payAmount.trim() };
  }
  return { kind: "stake", network: draft.network, from: draft.stakeFrom, to: draft.stakeTo, amount: "$amount" };
}

/** The `POST /v1/links` body the draft describes. */
export function buildLinkDefinition(draft: LinkDraft): Record<string, unknown> {
  const definition: Record<string, unknown> = {
    title: draft.title.trim(),
    publisher: { name: draft.publisherName.trim(), ...(draft.website.trim() ? { website: draft.website.trim() } : {}) },
    destination: { actions: [destinationAction(draft)] },
    funding: {
      networks: [...draft.fundingNetworks],
      assets: [...draft.fundingAssets],
      amount:
        draft.amountMode === "deliver"
          ? { mode: "deliver" }
          : {
              mode: "input",
              bounds: Object.fromEntries(
                draft.fundingAssets.map((asset) => {
                  const bounds = draft.bounds[asset] ?? { min: "", max: "", default: "" };
                  return [asset, { min: bounds.min.trim(), max: bounds.max.trim(), ...(bounds.default.trim() ? { default: bounds.default.trim() } : {}) }];
                }),
              ),
            },
    },
    blink: draft.blink,
  };
  if (draft.description.trim()) definition.description = draft.description.trim();
  const expires = endOfDay(draft.expiresOn);
  if (expires) definition.expiresAt = expires;
  if (draft.maxUses.trim()) definition.maxUses = Number(draft.maxUses);
  if (draft.perAccountMaxUses.trim()) definition.perAccount = { maxUses: Number(draft.perAccountMaxUses) };
  if (draft.maxSlippageBps.trim()) definition.constraints = { maxSlippageBps: Number(draft.maxSlippageBps) };
  if (draft.allowHolds) definition.allowHolds = true;
  return definition;
}

/** The sentence printed on the preview ticket. */
export function draftSentence(draft: LinkDraft): string {
  const where = CHAINS[draft.network]?.name ?? draft.network;
  if (draft.template === "get-paid") return `pay ${draft.payAmount || "?"} ${draft.payAsset} to ${draft.recipient.trim() || "your address"} on ${where}`;
  if (draft.template === "deposit") return `deposit into ${draft.contract.trim() || "your contract"} (${draft.entry || "entry"}) on ${where}`;
  return `stake as ${draft.stakeTo} on ${where}`;
}

/** The bounds printed on the preview ticket. */
export function draftBounds(draft: LinkDraft): { label: string; value: string }[] {
  if (draft.amountMode === "deliver") return [{ label: "Delivers exactly", value: `${draft.payAmount || "?"} ${draft.payAsset}` }];
  return draft.fundingAssets.map((asset) => {
    const bounds = draft.bounds[asset];
    return { label: asset, value: bounds ? `${bounds.min || "?"} to ${bounds.max || "?"}` : "no bounds" };
  });
}

/* ------------------------------------------------------------------ views */

export interface LinkStatusView {
  readonly label: string;
  readonly tone: "green" | "yellow" | "red" | "neutral";
}

const STATUS: Readonly<Record<LinkStatus, LinkStatusView>> = {
  pending: { label: "Pending", tone: "yellow" },
  active: { label: "Active", tone: "green" },
  paused: { label: "Paused", tone: "yellow" },
  suspended: { label: "Suspended", tone: "red" },
  exhausted: { label: "Used up", tone: "neutral" },
  expired: { label: "Expired", tone: "neutral" },
  deleted: { label: "Withdrawn", tone: "neutral" },
};

export function linkStatus(status: LinkStatus): LinkStatusView {
  return STATUS[status] ?? { label: status, tone: "neutral" };
}

const REASONS: Readonly<Record<string, string>> = {
  publisher: "Paused by you (the publisher).",
  recipient_changed: "A pinned recipient name now resolves to another address.",
  contract_changed: "A pinned contract registration has a newer revision.",
  domain_unverified: "The publisher's domain file no longer lists this link.",
  operator: "Paused by the operator.",
  abuse_reports: "Paused after abuse reports.",
};

export function reasonText(reason: string | null | undefined): string | null {
  if (!reason) return null;
  if (reason.startsWith("operator:")) return `By the operator: ${reason.slice("operator:".length).trim()}`;
  return REASONS[reason] ?? `Paused: ${reason.replace(/_/gu, " ")}.`;
}

/** Reasons a resume must accept explicitly (it re-pins, a new revision). */
export function acceptOnResume(reason: string | null | undefined): ("recipient_changed" | "contract_changed")[] {
  return reason === "recipient_changed" || reason === "contract_changed" ? [reason] : [];
}

/** The API's own card URL for a link id (never a URL taken from the response). */
export function cardUrl(apiOrigin: string, id: string, variant: "wide" | "square" = "wide", revision?: number): string | null {
  if (!LINK_ID_PATTERN.test(id)) return null;
  const query = [variant === "square" ? "variant=square" : "", revision ? `v=${revision}` : ""].filter(Boolean).join("&");
  return `${apiOrigin.replace(/\/+$/u, "")}/v1/links/${id}/card.png${query ? `?${query}` : ""}`;
}

/** `solana-action:<api>/v1/blinks/<id>` for eligible links (the page URL also unfurls through actions.json). */
export function blinkActionUrl(apiOrigin: string, view: Pick<LinkView, "id" | "blink">): string | null {
  if (!view.blink.eligible || !LINK_ID_PATTERN.test(view.id)) return null;
  return `solana-action:${apiOrigin.replace(/\/+$/u, "")}/v1/blinks/${view.id}`;
}
