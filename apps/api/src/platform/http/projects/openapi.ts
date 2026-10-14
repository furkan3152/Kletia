/**
 * OpenAPI fragments of projects, publishable keys and flows (integrator
 * design 4.8, tag *Projects*): the `kletia.project/v1` settings, the
 * project view and the publishable profile (limits and patterns from
 * @kletia/core `projects.ts`, never hand-copied), the routes under
 * /v1/projects and GET /v1/publishable/profile, and the flow session
 * request. Merged by openapi.ts.
 */
import {
  PROJECT_ACTIONS,
  PROJECT_FLOW_ID_PATTERN,
  PROJECT_LIMITS,
  PROJECT_LOGO_TYPES,
  PROJECT_SCHEMA,
  PUBLISHABLE_KEY_PATTERN,
} from "@kletia/core";
import { arrayOf, bool, errors, idempotencyKeyParameter, int, jsonBody, KEY_REQUIRED, noContent, nullable, obj, ok, ref, str, type JsonObject } from "../openapiKit.js";

const ORIGIN = str({ description: "An https origin (any port), or http://localhost:<port> for development; no path.", examples: ["https://shop.example"] });
const HASH = str({ pattern: "^sha256:[0-9a-f]{64}$", description: "SHA-256 of the canonical settings: the If-Match value." });
const PROJECT_ID = str({ pattern: "^prj_[A-Za-z0-9_]+$", examples: ["prj_key_2dce0f6a1b2c3d4e5f6a7b8c"] });

export function projectSchemas(): JsonObject {
  const brand = obj(
    {
      name: str({ minLength: 2, maxLength: 40, description: "Same rules as a registration's integrator.name; reserved brand names need their own website." }),
      website: str({ description: "https origin whose /.well-known/kletia.json lists the project (domain proof)." }),
    },
    ["name"],
  );
  const flowFields: JsonObject = {
    id: str({ pattern: PROJECT_FLOW_ID_PATTERN.source }),
    label: str({ minLength: 1, maxLength: PROJECT_LIMITS.flowLabel }),
    actions: arrayOf(ref("IntentActionSpec"), { minItems: 1, maxItems: 8, description: "Structured actions only, validated and dry-run like POST /v1/sessions." }),
    amount: obj({ action: int({ minimum: 0 }), min: ref("DecimalAmount"), max: ref("DecimalAmount") }, ["action", "min", "max"], { description: "The visitor may choose this action's amount within the bounds." }),
    constraints: ref("IntentConstraints"),
  };
  const defaults: JsonObject = {
    networks: arrayOf(ref("NetworkKey"), { minItems: 1, uniqueItems: true }),
    sourceNetwork: str({ description: "A network key of `networks`, or `auto`." }),
    actions: arrayOf(str({ enum: [...PROJECT_ACTIONS] }), { minItems: 1, uniqueItems: true }),
    examples: arrayOf(str({ minLength: 1, maxLength: PROJECT_LIMITS.exampleLength }), { maxItems: PROJECT_LIMITS.examples }),
    appearance: { type: "object", description: "KletiaAppearance (validateAppearance in @kletia/core): colours, radius, border, shadow, font, density, header. Safety surfaces are never themable." },
  };
  const logo = obj(
    {
      url: str({ description: "/v1/projects/{projectId}/logo/{sha256}.{png|webp} (served while the domain is verified)." }),
      sha256: str({ pattern: "^[0-9a-f]{64}$" }),
      contentType: str({ enum: [...PROJECT_LOGO_TYPES] }),
      width: int({ minimum: PROJECT_LIMITS.logoMinPx, maximum: PROJECT_LIMITS.logoMaxPx }),
      height: int({ minimum: PROJECT_LIMITS.logoMinPx, maximum: PROJECT_LIMITS.logoMaxPx }),
    },
    ["url", "sha256", "contentType", "width", "height"],
  );
  return {
    ProjectSettings: obj(
      {
        schema: str({ const: PROJECT_SCHEMA }),
        brand,
        allowedOrigins: arrayOf(ORIGIN, { maxItems: PROJECT_LIMITS.allowedOrigins, description: "Pages where the project's publishable keys work (the Origin header, or Kletia-Host-Origin from the /embed frame)." }),
        defaults: obj({ lane: str({ enum: ["production", "testnet"] }), ...defaults }),
        flows: arrayOf(obj({ ...flowFields, ownerKeyId: str({ description: "The key that saved the flow: its registrations are the flow's contract authority (set by the API)." }) }, ["id", "label", "actions", "ownerKeyId"]), { maxItems: PROJECT_LIMITS.flows }),
      },
      ["schema"],
    ),
    ProjectSettingsPatch: {
      type: "object",
      description: "JSON merge patch (RFC 7386) of kletia.project/v1 settings: objects merge, `null` removes a field, arrays replace. A new or changed flow is dry-run as the caller, who becomes its saver.",
      properties: {
        schema: str({ const: PROJECT_SCHEMA }),
        brand: nullable(brand),
        allowedOrigins: nullable(arrayOf(ORIGIN, { maxItems: PROJECT_LIMITS.allowedOrigins })),
        defaults: { type: ["object", "null"] },
        flows: nullable(arrayOf(obj(flowFields, ["id", "label", "actions"]), { maxItems: PROJECT_LIMITS.flows })),
      },
    },
    ProjectLogo: logo,
    ProjectView: obj(
      {
        id: PROJECT_ID,
        version: int({ minimum: 0, description: "0 until the settings are first saved." }),
        hash: HASH,
        settings: ref("ProjectSettings"),
        domain: obj(
          {
            host: { type: ["string", "null"] },
            verified: bool(),
            checkedAt: { type: ["string", "null"], format: "date-time" },
            file: str({ description: `The JSON to publish at https://<website>/.well-known/kletia.json.`, examples: ["{\"projects\":[\"prj_key_2dce0f6a1b2c3d4e5f6a7b8c\"]}"] }),
          },
          ["host", "verified", "checkedAt", "file"],
        ),
        logo: nullable(ref("ProjectLogo")),
        updatedAt: str({ format: "date-time" }),
        updatedBy: str(),
      },
      ["id", "version", "hash", "settings", "domain", "updatedAt", "updatedBy"],
    ),
    ProjectResponse: obj({ project: ref("ProjectView") }, ["project"]),
    ProjectProfile: obj(
      {
        projectId: PROJECT_ID,
        brand: nullable(obj({ name: str(), host: { type: ["string", "null"] }, verified: bool(), logo: nullable(ref("ProjectLogo")) }, ["name", "host", "verified"], { description: "Show the name, header and logo only when `verified` (the domain proves the brand)." })),
        allowedOrigins: arrayOf(ORIGIN),
        lane: str({ enum: ["production", "testnet"] }),
        defaults: obj(defaults),
        flows: arrayOf(obj({ id: str(), label: str(), networks: arrayOf(ref("NetworkKey")) }, ["id", "label", "networks"])),
      },
      ["projectId", "brand", "allowedOrigins", "lane", "defaults", "flows"],
    ),
    ProjectProfileResponse: obj({ profile: ref("ProjectProfile") }, ["profile"]),
    PublishableKeyCreateRequest: obj({ label: str({ minLength: 1, maxLength: 80, examples: ["website"] }) }, ["label"]),
    PublishableKey: obj(
      {
        id: str(),
        key: str({ pattern: PUBLISHABLE_KEY_PATTERN.source, description: "Shown once; only its SHA-256 hash is stored. Meant for browser code: it works only from the project's allowed origins." }),
        label: str(),
        kind: str({ const: "publishable" }),
        parentId: str({ description: "The project key that issued it (revoking that key revokes this one)." }),
        createdAt: str({ format: "date-time" }),
      },
      ["id", "key", "label", "kind", "parentId", "createdAt"],
    ),
    PublishableKeyResponse: obj({ key: ref("PublishableKey") }, ["key"]),
    FlowSessionRequest: obj(
      {
        flow: str({ pattern: PROJECT_FLOW_ID_PATTERN.source, description: "Id of a flow stored in the project settings." }),
        hostOrigin: { ...ORIGIN, description: "Origin of the page hosting the widget; must be in allowedOrigins." },
      },
      ["flow", "hostOrigin"],
      { additionalProperties: false, description: "With a publishable key: a single-use session (600 s) from a stored flow, owned by the publishable key; its call / action steps use the registrations of the key that saved the flow." },
    ),
  };
}

const ifMatchParameter: JsonObject = {
  name: "If-Match",
  in: "header",
  required: true,
  description: "The project's `hash` (quoted, `sha256:` optional) the change is based on. A stale hash answers 409 PROJECT_CONFLICT.",
  schema: str(),
};

export function projectPaths(): JsonObject {
  return {
    "/v1/projects/current": {
      get: {
        operationId: "getProject",
        tags: ["Projects"],
        summary: "The caller's project: settings, version, hash and domain proof",
        description: "Any key of the project (agent keys read too). Version 0 and empty settings until the first PATCH.",
        security: KEY_REQUIRED,
        responses: { "200": ok("ProjectResponse", "The project."), ...errors("403", "409") },
      },
      patch: {
        operationId: "updateProject",
        tags: ["Projects"],
        summary: "Merge-patch the project settings (If-Match)",
        description: `A project key with its current secret. The merged settings are validated (400 PROJECT_SETTINGS_INVALID with issues): at most ${PROJECT_LIMITS.allowedOrigins} origins, brand names with the integrator rules, defaults (appearance through validateAppearance) and at most ${PROJECT_LIMITS.flows} flows, each dry-run like a session template as the caller, who becomes its saver (its contract authority). A new website starts unverified. Never retried automatically.`,
        security: KEY_REQUIRED,
        parameters: [ifMatchParameter],
        requestBody: jsonBody("ProjectSettingsPatch"),
        responses: { "200": ok("ProjectResponse", "The saved project (ETag: its hash)."), ...errors("403", "409", "413", "415") },
      },
    },
    "/v1/projects/current/domain/verify": {
      post: {
        operationId: "verifyProjectDomain",
        tags: ["Projects"],
        summary: "Check the domain proof now",
        description: `Fetches https://<brand.website>/.well-known/kletia.json (${PROJECT_LIMITS.domainFileBytes / 1024} KB at most, no redirects, public hosts only) and checks that \`projects\` lists this project. Re-checked daily; a project whose file stops listing it loses its verified brand.`,
        security: KEY_REQUIRED,
        responses: { "200": ok("ProjectResponse", "The project with the check's result."), ...errors("403", "409") },
      },
    },
    "/v1/projects/current/publishable-keys": {
      post: {
        operationId: "createPublishableKey",
        tags: ["Projects"],
        summary: "Issue a publishable key (kl_pub_, browsers)",
        description: `A project key with its current secret. At most ${PROJECT_LIMITS.activePublishableKeys} active per project (409 KEY_LIMIT_REACHED). The key gets a rule book derived from the project defaults (kinds, networks, lane, storeIntents; the stored flows' kinds, networks and registrations), editable with PUT /v1/keys/{id}/policy. It may call the public tier, plan and store intents it owns (never call or action steps), start sessions from stored flows and read GET /v1/publishable/profile; anything else is 403 PUBLISHABLE_KEY_FORBIDDEN. Every request must come from an allowed origin (403 PUBLISHABLE_ORIGIN_FORBIDDEN) and counts ${PROJECT_LIMITS.publishableRatePerMinute} per minute per key plus the public per-IP limit.`,
        security: KEY_REQUIRED,
        parameters: [idempotencyKeyParameter],
        requestBody: jsonBody("PublishableKeyCreateRequest"),
        responses: { "201": ok("PublishableKeyResponse", "The key, shown once."), ...errors("403", "409", "413", "415") },
      },
    },
    "/v1/projects/current/logo": {
      put: {
        operationId: "setProjectLogo",
        tags: ["Projects"],
        summary: "Upload the brand logo (PNG or WebP)",
        description: `Raw bytes with Content-Type image/png or image/webp, at most ${PROJECT_LIMITS.logoBytes / 1024} KB, ${PROJECT_LIMITS.logoMinPx}-${PROJECT_LIMITS.logoMaxPx} px per side, width 1 to ${PROJECT_LIMITS.logoMaxAspect} times the height. Only the PNG IHDR / WebP VP8, VP8L or VP8X header is read; SVG, GIF, APNG and animated WebP are refused (422 PROJECT_LOGO_INVALID). Shown only in the frame header next to the verified name.`,
        security: KEY_REQUIRED,
        requestBody: {
          required: true,
          content: Object.fromEntries(PROJECT_LOGO_TYPES.map((type) => [type, { schema: str({ format: "binary" }) }])),
        },
        responses: { "200": ok("ProjectResponse", "The project with its logo."), ...errors("403", "409", "413", "415", "422") },
      },
      delete: {
        operationId: "deleteProjectLogo",
        tags: ["Projects"],
        summary: "Remove the brand logo",
        security: KEY_REQUIRED,
        responses: { "204": noContent("Removed."), ...errors("403", "409") },
      },
    },
    "/v1/projects/{projectId}/logo/{file}": {
      get: {
        operationId: "getProjectLogo",
        tags: ["Projects"],
        summary: "A project's logo (public, immutable)",
        description: "`file` is `<sha256>.png` or `<sha256>.webp`. Fixed Content-Type, `Cache-Control: public, max-age=31536000, immutable`, `Content-Security-Policy: default-src 'none'; sandbox`, `X-Content-Type-Options: nosniff`, `Cross-Origin-Resource-Policy: cross-origin`. 404 while the domain is not verified.",
        parameters: [
          { name: "projectId", in: "path", required: true, schema: PROJECT_ID },
          { name: "file", in: "path", required: true, schema: str({ pattern: "^[0-9a-f]{64}\\.(png|webp)$" }) },
        ],
        responses: {
          "200": { description: "The logo bytes.", content: Object.fromEntries(PROJECT_LOGO_TYPES.map((type) => [type, { schema: str({ format: "binary" }) }])) },
          ...errors("404"),
        },
      },
    },
    "/v1/publishable/profile": {
      get: {
        operationId: "getPublishableProfile",
        tags: ["Projects"],
        summary: "What a publishable key reveals about its project",
        description: "Brand (with `verified`), allowed origins, lane, defaults and the stored flows' ids, labels and networks. Never keys, flow contents or who saved them. Call it with the publishable key from an allowed origin.",
        security: KEY_REQUIRED,
        responses: { "200": ok("ProjectProfileResponse", "The profile."), ...errors("403") },
      },
    },
  };
}
