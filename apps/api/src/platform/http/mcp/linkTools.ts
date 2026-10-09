/**
 * MCP tools of intent links (links design §11.4):
 *
 * - `list_links`, `get_link` (key, read-only): compact views of the
 *   caller's links, nothing beyond what the public view shows plus status;
 * - `quote_link` (public, read-only): the indicative fare of a link for a
 *   funding choice, so an agent can answer "how much would I get";
 * - `create_link` (key; agent keys need `permissions.links`): publishes a
 *   link and returns its page URL for a human, who reviews and signs every
 *   step in their own wallet. Nothing is signed or sent.
 */
import { isLinkId, LINK_ID_PATTERN, NETWORK_KEYS, type LinkView } from "@kletia/core";
import { invalidRequest } from "../context.js";
import { createLink, getLinkView, listLinks, quoteLink } from "../links/service.js";
import { previewSummary } from "./featureTools.js";
import { toolAuth } from "./policyTools.js";
import type { KletiaTool, ToolAnnotations } from "./tools.js";

function annotations(title: string, readOnly: boolean, idempotent: boolean, openWorld: boolean): ToolAnnotations {
  return { title, readOnlyHint: readOnly, destructiveHint: false, idempotentHint: idempotent, openWorldHint: openWorld };
}

/** What an agent needs of a link: title, publisher and seal, status, funding, fixed payees, uses, the page. */
export function linkSummary(view: LinkView): Record<string, unknown> {
  return {
    id: view.id,
    status: view.status,
    title: view.title,
    publisher: { name: view.publisher.name, domain: view.publisher.domain ?? null, domainVerified: view.publisher.domainVerified },
    destination: { network: view.destination.network, asset: view.destination.asset.symbol, actions: view.destination.actions.map((action) => action.label) },
    funding: { networks: view.funding.networks, assets: view.funding.assets, mode: view.funding.amount.mode },
    fixedRecipients: view.fixed.recipients.map((recipient) => `${recipient.name ?? recipient.address} on ${recipient.network}`),
    uses: view.uses,
    expiresAt: view.expiresAt,
    page: view.urls.page,
  };
}

function linkIdArg(args: Record<string, unknown>): string {
  const id = typeof args.linkId === "string" ? args.linkId : "";
  if (!isLinkId(id)) throw invalidRequest("linkId must be lk_ followed by 24 hex characters.", [{ path: "linkId", message: "Invalid link id." }]);
  return id;
}

const LINK_ID = { type: "string", pattern: LINK_ID_PATTERN.source, description: "lk_ followed by 24 hex characters." } as const;

export const LIST_LINKS_TOOL: KletiaTool = {
  name: "list_links",
  description: "List the intent links published with the connecting API key: status, title, funding options, fixed payees, uses left and the page URL. Requires an API key.",
  inputSchema: { type: "object", properties: { status: { type: "string", enum: ["pending", "active", "paused", "suspended"] } }, additionalProperties: false },
  annotations: annotations("List my links", true, true, false),
  async run(args, caller) {
    const auth = await toolAuth(caller);
    const status = typeof args.status === "string" ? args.status : undefined;
    return { links: (await listLinks(auth, status, 50)).map(linkSummary) };
  },
};

export const GET_LINK_TOOL: KletiaTool = {
  name: "get_link",
  description: "Read one intent link (lk_…): the public view (publisher and domain seal, destination, funding options and bounds, fixed payees and contracts, uses, expiry, page URL).",
  inputSchema: { type: "object", properties: { linkId: LINK_ID }, required: ["linkId"], additionalProperties: false },
  annotations: annotations("Read a link", true, true, false),
  async run(args, caller) {
    const id = linkIdArg(args);
    const auth = caller.keyId ? await toolAuth(caller) : { tier: "public" as const };
    return linkSummary(await getLinkView(auth, id));
  },
};

export const QUOTE_LINK_TOOL: KletiaTool = {
  name: "quote_link",
  description:
    "Quote an intent link for a funding choice: what the visitor would send and receive (the fare breakdown), without storing anything. Without accounts the quote is indicative (placeholder accounts).",
  inputSchema: {
    type: "object",
    properties: {
      linkId: LINK_ID,
      source: {
        type: "object",
        properties: { network: { type: "string", enum: [...NETWORK_KEYS] }, asset: { type: "string", minLength: 1, maxLength: 64 } },
        required: ["network", "asset"],
        additionalProperties: false,
      },
      amount: { type: "string", pattern: "^(0|[1-9][0-9]*)(\\.[0-9]+)?$", description: "Decimal amount of the funding asset (input links only)." },
      accounts: { type: "array", minItems: 1, maxItems: 2, items: { type: "string", maxLength: 128 }, description: "The visitor's CAIP-10 accounts (optional)." },
    },
    required: ["linkId", "source"],
    additionalProperties: false,
  },
  annotations: annotations("Quote a link", true, false, true),
  async run(args) {
    const id = linkIdArg(args);
    const { linkId: _link, ...body } = args;
    const { intent, preview } = await quoteLink(id, body);
    return {
      title: intent.summary.title,
      steps: intent.steps.map((step) => ({ kind: step.kind, network: step.network, protocol: step.protocol, input: step.input ? `${step.input.formatted} ${step.input.symbol}` : undefined, minimumOutput: step.minimumOutput ? `${step.minimumOutput.formatted} ${step.minimumOutput.symbol}` : undefined })),
      preview: previewSummary(preview),
      note: "Nothing was stored. The visitor opens the link page to review and sign in their own wallet.",
    };
  },
};

export const CREATE_LINK_TOOL: KletiaTool = {
  name: "create_link",
  description:
    "Publish an intent link (the POST /v1/links body: title, publisher, destination actions, funding, bounds, expiry) owned by the connecting API key, and return its page URL to give to a human, who reviews and signs every step in their own wallet. Agent keys need the links permission of their rule book. Nothing is signed or sent.",
  inputSchema: { type: "object", properties: { definition: { type: "object", description: "The link definition, as POST /v1/links." } }, required: ["definition"], additionalProperties: false },
  annotations: annotations("Publish an intent link", false, false, true),
  async run(args, caller) {
    const auth = await toolAuth(caller);
    const view = await createLink(auth, args.definition);
    return { ...linkSummary(view), activatesAt: view.activatesAt, card: view.urls.card, note: "Give the page URL to a human; they review and sign in their own wallet." };
  },
};

export const LINK_TOOLS: readonly KletiaTool[] = [LIST_LINKS_TOOL, GET_LINK_TOOL, QUOTE_LINK_TOOL, CREATE_LINK_TOOL];
