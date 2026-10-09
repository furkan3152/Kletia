/**
 * OpenAPI fragments of intent links (links design §3, §5, §6, §8): the link
 * definition and views, CRUD, visitor quotes and intents, statistics, the
 * page shell and share card, reports, operator actions, Solana Actions and
 * the `link.*` events. Merged by openapi.ts.
 */
import { LINK_EVENT_TYPES, LINK_ID_PATTERN, LINK_LIMITS, NETWORK_KEYS } from "@kletia/core";
import { arrayOf, bool, errors, idempotencyKeyParameter, int, jsonBody, KEY_REQUIRED, noContent, nullable, obj, ok, ref, REQUEST_ID_HEADER, str, type JsonObject } from "../openapiKit.js";

const DECIMAL = "^(0|[1-9][0-9]*)(\\.[0-9]+)?$";
const ISO = str({ format: "date-time" });
const NULLABLE_ISO: JsonObject = { type: ["string", "null"], format: "date-time" };
const NETWORK = str({ enum: [...NETWORK_KEYS] });
const STATUSES = ["pending", "active", "paused", "suspended", "exhausted", "expired", "deleted"];
const linkIdPath: JsonObject = { name: "id", in: "path", required: true, schema: str({ pattern: LINK_ID_PATTERN.source }) };
const anyIdPath: JsonObject = { name: "id", in: "path", required: true, schema: str({ maxLength: 64, description: "lk_ followed by 24 hex characters (anything else renders the not-found page)." }) };
const COUNTER = int({ minimum: 0 });

const ACTIONS_HEADERS: JsonObject = {
  "X-Action-Version": { description: "Solana Actions specification version.", schema: str({ const: "2.4" }) },
  "X-Blockchain-Ids": { description: "CAIP-2 id of the chain the action signs on.", schema: str() },
};

function actionResponse(schema: JsonObject, description: string): JsonObject {
  return { description, headers: ACTIONS_HEADERS, content: { "application/json": { schema } } };
}

const ACTION_ERROR = obj({ message: str() }, ["message"], { description: "Solana Actions error (`ActionError`)." });
/** Rate limits: the tier limiter answers with the platform envelope, the blink limiter with an ActionError. */
const ACTION_RATE_LIMITED: JsonObject = {
  description: "Rate limited (Retry-After).",
  headers: { "Retry-After": { $ref: "#/components/headers/Retry-After" } },
  content: { "application/json": { schema: { oneOf: [ACTION_ERROR, ref("Error")] } } },
};

export function linkSchemas(): JsonObject {
  const stats = {
    ...Object.fromEntries(["pageView", "unfurl", "blinkView", "quote", "intent", "prepared", "submitted", "completed", "failed", "expired", "cancelled", "overflow", "report", "unpriced"].map((metric) => [metric, COUNTER])),
    volumeUsd: str({ description: "Priced root input of completed intents (conservative oracle)." }),
  };
  return {
    LinkId: str({ pattern: LINK_ID_PATTERN.source }),
    LinkDefinition: obj(
      {
        title: str({ minLength: LINK_LIMITS.titleMinLength, maxLength: LINK_LIMITS.titleMaxLength }),
        description: str({ maxLength: LINK_LIMITS.descriptionMaxLength }),
        publisher: obj(
          {
            name: str({ minLength: LINK_LIMITS.publisherNameMinLength, maxLength: LINK_LIMITS.publisherNameMaxLength }),
            website: str({ format: "uri", pattern: "^https://", description: "Required on the production lane. Verified when its /.well-known/kletia.json lists the link (or the key)." }),
          },
          ["name"],
        ),
        destination: obj(
          { actions: arrayOf(ref("IntentActionSpec"), { minItems: 1, maxItems: LINK_LIMITS.maxActions, description: "Fixed by the publisher: what happens at the destination. Recipient names are resolved and pinned at creation." }) },
          ["actions"],
        ),
        funding: obj(
          {
            networks: arrayOf(NETWORK, { minItems: 1, maxItems: LINK_LIMITS.maxFundingNetworks, uniqueItems: true }),
            assets: arrayOf(str(), { minItems: 1, maxItems: LINK_LIMITS.maxFundingAssets, uniqueItems: true, description: "Registry symbols the visitor may fund with." }),
            amount: {
              oneOf: [
                obj(
                  {
                    mode: str({ const: "input" }),
                    bounds: { type: "object", additionalProperties: obj({ min: str({ pattern: DECIMAL }), max: str({ pattern: DECIMAL }), default: str({ pattern: DECIMAL }) }, ["min", "max"]), description: "Per funding asset symbol." },
                  },
                  ["mode", "bounds"],
                ),
                obj({ mode: str({ const: "deliver" }) }, ["mode"], { description: "The recipient receives at least the destination's fixed amount; the input is sized by quoting." }),
              ],
            },
          },
          ["networks", "assets", "amount"],
        ),
        constraints: obj({ maxSlippageBps: int({ minimum: 1, maximum: LINK_LIMITS.maxSlippageBps }), maxSeconds: int(), avoidProtocols: arrayOf(str()), preferProtocols: arrayOf(str()) }),
        expiresAt: str({ format: "date-time", description: `Default ${LINK_LIMITS.defaultTtlSeconds / 86_400} days, at most ${LINK_LIMITS.maxTtlSeconds / 86_400}.` }),
        maxUses: int({ minimum: 1, maximum: LINK_LIMITS.maxUses }),
        perAccount: obj({ maxUses: int({ minimum: 1, maximum: LINK_LIMITS.perAccountMaxUses }) }, ["maxUses"]),
        blink: bool({ description: "Also serve it as a Solana Action (blink) when eligible." }),
        allowHolds: bool({ description: "Accept intents the publisher key's rule book holds for approval (the page says so)." }),
        metadata: { type: "object", additionalProperties: str({ maxLength: 200 }), maxProperties: LINK_LIMITS.metadataEntries },
      },
      ["title", "publisher", "destination", "funding"],
      { description: `validateLinkDefinition in @kletia/core checks the same rules locally (at most ${LINK_LIMITS.definitionBytes} bytes).` },
    ),
    LinkView: obj(
      {
        id: ref("LinkId"),
        status: str({ enum: STATUSES }),
        revision: int({ minimum: 1 }),
        title: str(),
        description: str(),
        publisher: obj({ name: str(), website: str(), domain: str(), domainVerified: bool(), checkedAt: ISO }, ["name", "domainVerified"]),
        destination: obj(
          {
            network: NETWORK,
            asset: { type: "object" },
            actions: arrayOf(
              obj(
                {
                  kind: ref("IntentActionKind"),
                  network: NETWORK,
                  label: str(),
                  contract: obj({ id: str(), address: str(), integrator: str(), source: str(), domainVerified: bool(), revision: int() }, ["id", "address", "integrator", "domainVerified", "revision"]),
                },
                ["kind", "network", "label"],
              ),
            ),
          },
          ["network", "asset", "actions"],
        ),
        fixed: obj(
          {
            recipients: arrayOf(obj({ network: NETWORK, address: str(), name: str() }, ["network", "address"])),
            contracts: arrayOf(obj({ network: NETWORK, address: str(), label: str() }, ["network", "address", "label"])),
          },
          ["recipients", "contracts"],
          { description: "Every payee and contract the publisher fixed: what a visitor should check before signing." },
        ),
        funding: { type: "object" },
        expiresAt: ISO,
        activatesAt: NULLABLE_ISO,
        uses: obj({ max: { type: ["integer", "null"] }, left: { type: ["integer", "null"] } }, ["max", "left"]),
        perAccount: nullable(obj({ maxUses: int() }, ["maxUses"])),
        blink: obj({ enabled: bool(), eligible: bool(), reason: { type: ["string", "null"] } }, ["enabled", "eligible", "reason"]),
        urls: obj({ page: str({ format: "uri" }), card: str({ format: "uri" }), square: str({ format: "uri" }) }, ["page", "card", "square"]),
        notices: arrayOf(str()),
      },
      ["id", "status", "revision", "title", "publisher", "destination", "fixed", "funding", "expiresAt", "activatesAt", "uses", "perAccount", "blink", "urls", "notices"],
      { description: "The public view (anyone with the id)." },
    ),
    LinkOwnerView: {
      allOf: [
        ref("LinkView"),
        obj(
          {
            definition: ref("LinkDefinition"),
            pins: { type: "object", description: "Resolved recipients and contract revisions pinned at creation (or at an accepted resume)." },
            ownerKeyId: str(),
            pausedReason: { type: ["string", "null"] },
            suspendedReason: { type: ["string", "null"] },
            stats: obj(stats),
          },
          ["definition", "pins", "ownerKeyId", "pausedReason", "suspendedReason"],
        ),
      ],
      description: "The publisher's view (the owning key, its ancestors, or a project key of its project).",
    },
    LinkResponse: obj({ link: { oneOf: [ref("LinkOwnerView"), ref("LinkView")] } }, ["link"]),
    LinkOwnerResponse: obj({ link: ref("LinkOwnerView") }, ["link"]),
    LinkListResponse: obj({ links: arrayOf(ref("LinkOwnerView"), { description: "Newest first." }) }, ["links"]),
    LinkPatchRequest: obj(
      {
        title: str(),
        description: str(),
        status: str({ enum: ["active", "paused"] }),
        accept: arrayOf(str({ enum: ["recipient_changed", "contract_changed"] }), { description: "Resume a link that paused itself and pin the new state." }),
        funding: obj({ networks: arrayOf(NETWORK), assets: arrayOf(str()), amount: { type: "object" } }, [], { description: "Remove networks or assets; raise minimums, lower maximums." }),
        maxUses: int({ minimum: 1, description: "Only lower." }),
        perAccount: obj({ maxUses: int({ minimum: 1 }) }, ["maxUses"]),
        expiresAt: str({ format: "date-time", description: "Only earlier." }),
        blink: bool({ description: "Only off." }),
      },
      [],
      { additionalProperties: false, description: "A link's promise only tightens (anything else: 422 LINK_IMMUTABLE_FIELD). Destination, publisher and recipients never change." },
    ),
    LinkVisitorRequest: obj(
      {
        source: obj({ network: NETWORK, asset: str({ minLength: 1, maxLength: 64 }) }, ["network", "asset"]),
        amount: str({ pattern: DECIMAL, description: "Input links: decimal amount of the funding asset within its bounds." }),
        accounts: arrayOf(str({ maxLength: 128 }), { minItems: 1, maxItems: 2, description: "The visitor's CAIP-10 accounts, one per virtual machine the route signs on (optional for quotes)." }),
        clientReference: str({ maxLength: 128, description: "Intents only: a repeated reference returns the intent stored earlier." }),
      },
      ["source"],
    ),
    LinkPlanResponse: obj({ intent: ref("IntentGraph"), preview: ref("IntentPreview") }, ["intent", "preview"]),
    LinkStatsResponse: obj(
      {
        stats: obj(
          {
            linkId: ref("LinkId"),
            window: str({ enum: ["7d", "30d", "90d"] }),
            totals: obj(stats),
            daily: arrayOf({ allOf: [obj({ day: str({ format: "date" }) }, ["day"]), obj(stats)] }),
            bySource: arrayOf({ allOf: [obj({ source: str({ description: "`network:asset`." }) }, ["source"]), obj(stats)] }),
            conversion: obj({ intentPerPageView: { type: ["number", "null"] }, completedPerIntent: { type: ["number", "null"] } }, ["intentPerPageView", "completedPerIntent"]),
          },
          ["linkId", "window", "totals", "daily", "bySource", "conversion"],
          { description: "Additive daily counters; nothing per visitor (no addresses, IPs or user agents)." },
        ),
      },
      ["stats"],
    ),
    LinkReportRequest: obj({ reason: str({ enum: ["phishing", "impersonation", "broken", "other"] }) }, ["reason"], { additionalProperties: false }),
    LinkSuspendRequest: obj({ reason: str({ pattern: "^[a-z0-9_]{2,40}$" }) }, ["reason"]),
    LinkBlinkApprovalRequest: obj({ approved: bool() }, ["approved"]),
    LinkEvent: obj(
      {
        id: ref("EventId"),
        type: str({ enum: [...LINK_EVENT_TYPES] }),
        at: ISO,
        data: obj(
          {
            linkId: ref("LinkId"),
            ownerKeyId: str(),
            revision: int({ minimum: 1 }),
            reason: str({ description: "`recipient_changed`, `contract_changed`, `domain_unverified`, `domain_verified`, `operator`, `publisher`, `blink_approved`, …" }),
          },
          ["linkId", "ownerKeyId", "revision"],
        ),
      },
      ["id", "type", "at", "data"],
      { description: "Link lifecycle, delivered to the owning key's webhooks (and `scope: \"subtree\"` webhooks of its ancestors)." },
    ),
    ActionGetResponse: obj(
      {
        type: str({ const: "action" }),
        icon: str({ format: "uri" }),
        title: str(),
        description: str(),
        label: str(),
        disabled: bool(),
        error: obj({ message: str() }, ["message"]),
        links: obj({ actions: arrayOf({ type: "object" }) }, ["actions"]),
      },
      ["type", "icon", "title", "description", "label"],
    ),
    ActionPostResponse: obj(
      {
        type: str({ const: "transaction" }),
        transaction: str({ contentEncoding: "base64", description: "Unsigned v0 transaction for the visitor's account to sign." }),
        message: str(),
        links: obj({ next: obj({ type: str({ const: "post" }), href: str() }, ["type", "href"]) }),
      },
      ["type", "transaction", "message"],
    ),
    ActionNextResponse: obj(
      { type: str({ enum: ["action", "completed"] }), icon: str(), title: str(), description: str(), label: str(), links: obj({ actions: arrayOf({ type: "object" }) }) },
      ["type", "icon", "title", "label"],
    ),
  };
}

export function linkPaths(): JsonObject {
  return {
    "/v1/links": {
      post: {
        operationId: "createLink",
        tags: ["Links"],
        summary: "Publish an intent link",
        description: `A public link (\`/go/lk_…\`) whose destination the publisher fixes and whose funding the visitor chooses (networks, assets, amount within bounds). Validated like validateLinkDefinition, recipient names resolved and pinned, contracts pinned at their active revision, checked against the key's rule book (422 LINK_POLICY_CONFLICT) and dry-run planned for a representative funding choice. Production links that pay a fixed third party or call a custom contract are \`pending\` for ${LINK_LIMITS.activationDelaySeconds / 60} minutes. Unverified publishers are capped at $${LINK_LIMITS.unverifiedMaxUsd} per intent. At most ${LINK_LIMITS.activeLinksPerKey} active links and ${LINK_LIMITS.creationsPerHourPerKey} creations an hour per key. Agent keys need \`permissions.links\`. Honours \`Idempotency-Key\`.`,
        security: KEY_REQUIRED,
        parameters: [idempotencyKeyParameter],
        requestBody: jsonBody("LinkDefinition"),
        responses: { "201": ok("LinkOwnerResponse", "The link."), ...errors("403", "404", "409", "413", "415", "422", "502") },
      },
      get: {
        operationId: "listLinks",
        tags: ["Links"],
        summary: "Links of the caller (and its subtree)",
        security: KEY_REQUIRED,
        parameters: [
          { name: "status", in: "query", required: false, schema: str({ enum: STATUSES }) },
          { name: "limit", in: "query", required: false, schema: int({ minimum: 1, maximum: 200, default: 50 }) },
        ],
        responses: { "200": ok("LinkListResponse", "Links."), ...errors() },
      },
    },
    "/v1/links/{id}": {
      get: {
        operationId: "getLink",
        tags: ["Links"],
        summary: "Read a link",
        description: "Public view for anyone; the owner's view (definition, pins, reasons, totals) for the owning key, its ancestors and the project's project keys. A link whose owning key was revoked is not found.",
        parameters: [linkIdPath],
        responses: { "200": ok("LinkResponse", "The link."), ...errors("404") },
      },
      patch: {
        operationId: "updateLink",
        tags: ["Links"],
        summary: "Tighten, pause or resume a link",
        description: "Every change only narrows what visitors can do (new revision, `link.updated`); pausing and resuming (`link.paused`). A link that paused itself because a pinned name or contract changed resumes only with `accept` (409 LINK_RECIPIENT_CHANGED / LINK_CONTRACT_CHANGED otherwise) and is re-pinned. Honours `Idempotency-Key`.",
        security: KEY_REQUIRED,
        parameters: [linkIdPath, idempotencyKeyParameter],
        requestBody: jsonBody("LinkPatchRequest"),
        responses: { "200": ok("LinkOwnerResponse", "The link."), ...errors("403", "404", "409", "410", "413", "415", "422") },
      },
      delete: {
        operationId: "deleteLink",
        tags: ["Links"],
        summary: "Withdraw a link",
        description: "Visitors get 410 LINK_EXPIRED; intents already started can finish. Idempotent.",
        security: KEY_REQUIRED,
        parameters: [linkIdPath],
        responses: { "204": noContent("Withdrawn."), ...errors("403", "404") },
      },
    },
    "/v1/links/{id}/quote": {
      post: {
        operationId: "quoteLink",
        tags: ["Links"],
        summary: "Quote a link for a funding choice (nothing stored)",
        description: `The dry-run intent and its preview for the visitor's choice; without accounts the quote is indicative. Cached ${LINK_LIMITS.quoteCacheSeconds} s per choice (\`Kletia-Quote-Cache: hit\`). ${LINK_LIMITS.quotePerMinutePerIp} per minute per IP and ${LINK_LIMITS.quotePerMinutePerLink} per link.`,
        parameters: [linkIdPath],
        requestBody: jsonBody("LinkVisitorRequest"),
        responses: { "200": ok("LinkPlanResponse", "Quote."), ...errors("404", "409", "410", "413", "415", "422", "502") },
      },
    },
    "/v1/links/{id}/intents": {
      post: {
        operationId: "createLinkIntent",
        tags: ["Links"],
        summary: "Create the visitor's intent from a link",
        description: `Plans and stores the intent the link describes for the visitor's accounts, owned by the link's key (its rule book applies; \`metadata.linkId\` forces strict simulation at prepare). A use is reserved at the first prepare and consumed at the first submit; abandoned intents release it. The plan must stay inside the link's envelope (fixed networks, recipients, contracts and input) or nothing is stored. ${LINK_LIMITS.intentsPerMinutePerIp} per minute per IP, ${LINK_LIMITS.intentsPerMinutePerLink} per link and ${LINK_LIMITS.intentsPer10MinutesPerAccount} per 10 minutes per account.`,
        parameters: [linkIdPath],
        requestBody: jsonBody("LinkVisitorRequest"),
        responses: { "201": ok("LinkPlanResponse", "The stored intent."), "200": ok("LinkPlanResponse", "An intent stored earlier with this clientReference."), ...errors("403", "404", "409", "410", "413", "415", "422", "502") },
      },
    },
    "/v1/links/{id}/stats": {
      get: {
        operationId: "getLinkStats",
        tags: ["Links"],
        summary: "Privacy-preserving counters of a link",
        security: KEY_REQUIRED,
        parameters: [linkIdPath, { name: "window", in: "query", required: false, schema: str({ enum: ["7d", "30d", "90d"], default: "7d" }) }],
        responses: { "200": ok("LinkStatsResponse", "Counters."), ...errors("404") },
      },
    },
    "/v1/links/{id}/card.png": {
      get: {
        operationId: "getLinkCard",
        tags: ["Links"],
        summary: "Share card (PNG)",
        description: `The link as a ticket: title, route, publisher, domain seal, amount bounds and expiry. \`wide\` 1200x600 (og:image), \`square\` 600x600 (blink icon). Cached per revision (ETag; \`?v=<revision>\` is immutable). No live counters. ${LINK_LIMITS.pagePerMinutePerLink} page and card requests per minute per link.`,
        parameters: [
          linkIdPath,
          { name: "variant", in: "query", required: false, schema: str({ enum: ["wide", "square"], default: "wide" }) },
          { name: "v", in: "query", required: false, description: "The link revision (cache busting).", schema: str() },
        ],
        responses: {
          "200": { description: "The card.", headers: { "X-Request-Id": REQUEST_ID_HEADER, ETag: { schema: str() } }, content: { "image/png": { schema: str({ format: "binary" }) } } },
          "304": { description: "Not modified (If-None-Match)." },
          ...errors("404"),
        },
      },
    },
    "/v1/links/{id}/page": {
      get: {
        operationId: "getLinkPage",
        tags: ["Links"],
        summary: "The link page shell with per-link meta (served at /go/{id} by the web origin)",
        description: "The web app's HTML shell with the link's title, description, card image and canonical URL injected (escaped) for unfurls; the page itself renders client-side. Unknown, withdrawn or suspended links get a noindex page. 503 LINK_PAGE_UNAVAILABLE (HTML) when the shell cannot be loaded.",
        parameters: [anyIdPath],
        responses: {
          "200": { description: "HTML.", headers: { "X-Request-Id": REQUEST_ID_HEADER }, content: { "text/html": { schema: str() } } },
          "404": { description: "Unknown link (HTML).", content: { "text/html": { schema: str() } } },
          "410": { description: "Withdrawn or expired link (HTML).", content: { "text/html": { schema: str() } } },
          "503": { description: "LINK_PAGE_UNAVAILABLE (HTML).", content: { "text/html": { schema: str() } } },
          ...errors(),
        },
      },
    },
    "/v1/links/{id}/report": {
      post: {
        operationId: "reportLink",
        tags: ["Links"],
        summary: "Report a link (counted, no free text)",
        description: `${LINK_LIMITS.reportsPerHourPerIp} per hour per IP. Reports are counters the operator reviews; nothing personal is stored.`,
        parameters: [linkIdPath],
        requestBody: jsonBody("LinkReportRequest"),
        responses: { "204": noContent("Counted."), ...errors("404", "413", "415") },
      },
    },
    "/v1/links/{id}/suspend": {
      post: {
        operationId: "suspendLink",
        tags: ["Links"],
        summary: "Suspend a link (operator)",
        description: "Operator keys only. Every prepare of the link's intents is refused (409 LINK_SUSPENDED); `link.suspended`.",
        security: KEY_REQUIRED,
        parameters: [linkIdPath],
        requestBody: jsonBody("LinkSuspendRequest"),
        responses: { "200": ok("LinkOwnerResponse", "The link."), ...errors("404", "410", "413", "415") },
      },
    },
    "/v1/links/{id}/blink-approval": {
      post: {
        operationId: "approveLinkBlink",
        tags: ["Links"],
        summary: "Approve or revoke a link's blink (operator)",
        description: "Operator keys only, when blink approval is required on the deployment. 422 LINK_NOT_BLINK_ELIGIBLE when the link cannot be a blink.",
        security: KEY_REQUIRED,
        parameters: [linkIdPath],
        requestBody: jsonBody("LinkBlinkApprovalRequest"),
        responses: { "200": ok("LinkOwnerResponse", "The link."), ...errors("404", "413", "415", "422") },
      },
    },
    "/v1/blinks/{id}": {
      get: {
        operationId: "getBlink",
        tags: ["Blinks"],
        summary: "Solana Action metadata of a link",
        description: "Solana Actions GET (CORS for every origin; X-Action-Version, X-Blockchain-Ids). A link that cannot be a blink now answers `disabled` with the page URL. Only Solana-only visitor flows of at most 3 steps from verified publishers qualify.",
        parameters: [anyIdPath],
        responses: { ...errors(), "429": ACTION_RATE_LIMITED, "200": actionResponse(ref("ActionGetResponse"), "Action metadata."), "404": actionResponse(ACTION_ERROR, "Unknown link."), "410": actionResponse(ACTION_ERROR, "Expired or withdrawn.") },
      },
      post: {
        operationId: "postBlink",
        tags: ["Blinks"],
        summary: "Plan the visitor's intent and return its first unsigned transaction",
        description: `Body \`{ "account": "<base58>" }\`. Creates the link intent for the account (or continues one with a callback token) and prepares the step as an unsigned transaction; the visitor's wallet signs and sends it. Nothing is signed or sent by Kletia. ${LINK_LIMITS.blinkPostPerMinutePerIp} per minute per IP.`,
        parameters: [
          anyIdPath,
          { name: "asset", in: "query", required: false, schema: str() },
          { name: "amount", in: "query", required: false, schema: str({ pattern: DECIMAL }) },
          { name: "intent", in: "query", required: false, schema: ref("IntentId") },
          { name: "step", in: "query", required: false, schema: str() },
          { name: "t", in: "query", required: false, description: "Callback token (HMAC of link, intent, step and account).", schema: str() },
        ],
        requestBody: { required: true, content: { "application/json": { schema: obj({ account: str() }, ["account"]) } } },
        responses: { ...errors(), "429": ACTION_RATE_LIMITED, "200": actionResponse(ref("ActionPostResponse"), "The transaction."), "400": actionResponse(ACTION_ERROR, "Invalid request."), "403": actionResponse(ACTION_ERROR, "Refused."), "404": actionResponse(ACTION_ERROR, "Unknown link."), "409": actionResponse(ACTION_ERROR, "Not usable now."), "422": actionResponse(ACTION_ERROR, "Not executable.") },
      },
    },
    "/v1/blinks/{id}/next": {
      post: {
        operationId: "postBlinkNext",
        tags: ["Blinks"],
        summary: "Record the signed step and chain the next one",
        description: "Solana Actions action chaining: `{ account, signature }` submits the visitor's signature as the step's reference, then returns the next step as an action, or `completed`. The callback token binds link, intent, step and account.",
        parameters: [
          anyIdPath,
          { name: "intent", in: "query", required: true, schema: ref("IntentId") },
          { name: "step", in: "query", required: true, schema: str() },
          { name: "t", in: "query", required: true, schema: str() },
        ],
        requestBody: { required: true, content: { "application/json": { schema: obj({ account: str(), signature: str() }, ["account", "signature"]) } } },
        responses: { ...errors(), "429": ACTION_RATE_LIMITED, "200": actionResponse(ref("ActionNextResponse"), "Next action or completion."), "400": actionResponse(ACTION_ERROR, "Invalid request."), "403": actionResponse(ACTION_ERROR, "Token mismatch."), "404": actionResponse(ACTION_ERROR, "Unknown link."), "409": actionResponse(ACTION_ERROR, "Not usable now.") },
      },
    },
  };
}
