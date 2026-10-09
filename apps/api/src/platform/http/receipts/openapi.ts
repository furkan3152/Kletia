/**
 * OpenAPI fragments of verifiable receipts (receipts design §11): schemas of
 * the receipt document (payload skeleton, signature, disclosures, inclusion,
 * EAS envelope), shares, keys and log batches, and the 14 operations.
 * Merged by openapi.ts.
 */
import {
  PLAN_RECORD_SPEC_VERSION,
  RECEIPT_DIGEST_PATTERN,
  RECEIPT_ID_PATTERN,
  RECEIPT_LOG_SPEC_VERSION,
  RECEIPT_SHARE_ID_PATTERN,
  RECEIPT_SPEC_VERSION,
} from "@kletia/core";
import {
  arrayOf,
  bool,
  errors,
  idempotencyKeyParameter,
  int,
  intentIdParameter,
  KEY_REQUIRED,
  noContent,
  nullable,
  obj,
  ok,
  ref,
  str,
  type JsonObject,
} from "../openapiKit.js";
import { EAS_ADDRESS, EAS_SCHEMA_UID } from "./eas.js";
import { MAX_LOG_LEAVES_PAGE, RECEIPT_KEYS_CACHE_SECONDS } from "./handlers.js";
import { DEFAULT_SHARE_SECONDS, MAX_SHARE_SECONDS, MIN_SHARE_SECONDS } from "./shares.js";
import { MAX_ACTIVE_SHARES } from "./store.js";

const HEX64 = str({ pattern: RECEIPT_DIGEST_PATTERN.source });
const DAY = str({ format: "date" });
const B64URL = str({ pattern: "^[A-Za-z0-9_-]+$" });

export function receiptSchemas(): JsonObject {
  return {
    ReceiptId: str({ pattern: RECEIPT_ID_PATTERN.source }),
    ReceiptShareId: str({ pattern: RECEIPT_SHARE_ID_PATTERN.source }),
    ReceiptDigest: { ...HEX64, description: "Lower-case hex SHA-256 of the RFC 8785 (JCS) payload." },
    ReceiptPayload: obj(
      {
        spec: str({ const: RECEIPT_SPEC_VERSION }),
        receiptId: ref("ReceiptId"),
        sequence: int({ minimum: 1 }),
        supersedes: { type: ["string", "null"], pattern: RECEIPT_DIGEST_PATTERN.source, description: "Digest of the receipt this one replaces." },
        issuedOn: DAY,
        issuer: obj({ name: str({ const: "Kletia" }), origin: str({ format: "uri" }), apiVersion: str(), kid: str() }, ["name", "origin", "apiVersion", "kid"]),
        intent: obj(
          {
            ref: { ...HEX64, description: "hex sha256(\"kletia.intent-ref.v1:\" + intent id): the id (a bearer capability) never appears." },
            spec: str({ const: "kletia.intent/v1" }),
            status: str({ enum: ["completed", "partially_completed", "failed", "cancelled"] }),
            terminal: bool({ description: "False for failed and partially completed intents: a retried step can supersede this receipt." }),
            lane: str({ enum: ["production", "testnet"] }),
            source: str({ enum: ["structured", "grammar", "assistant"] }),
            networks: arrayOf(ref("NetworkKey")),
            finishedOn: DAY,
            durationSeconds: { type: ["integer", "null"], minimum: 0 },
            finality: str({ enum: ["finalized", "none"] }),
            commitments: obj({ request: HEX64, plan: HEX64, timing: HEX64, outcome: HEX64 }, ["request", "plan", "timing", "outcome"]),
          },
          ["ref", "spec", "status", "terminal", "lane", "source", "networks", "finishedOn", "durationSeconds", "finality", "commitments"],
        ),
        steps: arrayOf(
          obj(
            {
              id: str(),
              index: int({ minimum: 0 }),
              kind: ref("IntentActionKind"),
              network: ref("NetworkKey"),
              chain: ref("CaipChainId"),
              protocol: ref("ProtocolId"),
              mode: str({ enum: ["wallet", "settlement", "read"] }),
              status: ref("StepStatus"),
              dependsOn: arrayOf(str()),
              settlement: { type: ["object", "null"] },
              assets: obj({ input: { type: ["string", "null"] }, output: { type: ["string", "null"] } }, ["input", "output"], { description: "CAIP-19 ids only, no amounts." }),
              venue: { type: ["string", "null"] },
              contract: { type: ["object", "null"], description: "Custom contract steps: integrator, domain verification, target, function, definition hash, revision." },
              failure: { type: ["object", "null"] },
              evidenceClass: str({ enum: ["onchain", "onchain+provider", "none"] }),
              commitments: obj({ parties: HEX64, amounts: HEX64, evidence: HEX64 }, ["parties", "amounts", "evidence"]),
            },
            ["id", "index", "kind", "network", "chain", "protocol", "mode", "status", "dependsOn", "settlement", "assets", "venue", "contract", "failure", "evidenceClass", "commitments"],
          ),
        ),
        edges: arrayOf(obj({ from: str(), to: str(), kind: str({ enum: ["funds", "orders"] }) }, ["from", "to", "kind"])),
      },
      ["spec", "receiptId", "sequence", "supersedes", "issuedOn", "issuer", "intent", "steps", "edges"],
      { description: "The signed part: a public skeleton plus salted, path-bound commitments of every disclosure group." },
    ),
    ReceiptDisclosure: obj(
      { salt: str({ pattern: "^[A-Za-z0-9_-]{22}$", description: "base64url of 16 random bytes." }), value: { type: "object" } },
      ["salt", "value"],
      { description: "One disclosure group; it verifies against its commitment slot in the payload." },
    ),
    ReceiptInclusion: obj(
      {
        batch: ref("ReceiptLogBatch"),
        batchSignature: B64URL,
        leafIndex: int({ minimum: 0 }),
        path: arrayOf(HEX64, { description: "RFC 6962 audit path, closest sibling first." }),
        anchor: nullable(obj({ chain: str(), contract: str(), timestamp: int(), tx: str() }, ["chain", "contract", "timestamp", "tx"])),
      },
      ["batch", "batchSignature", "leafIndex", "path", "anchor"],
    ),
    EasEnvelope: obj(
      {
        signer: str({ description: "The attester address (a Kletia key without funds)." }),
        sig: obj(
          {
            domain: obj({ name: str({ const: "EAS Attestation" }), version: str(), chainId: int(), verifyingContract: str({ const: EAS_ADDRESS }) }),
            primaryType: str({ const: "Attest" }),
            types: { type: "object" },
            message: { type: "object", description: "Version 2 offchain attestation of abi.encode(bytes32 digest, string spec, uint32 sequence); recipient is the zero address." },
            uid: str(),
            signature: obj({ r: str(), s: str(), v: int() }, ["r", "s", "v"]),
          },
          ["domain", "primaryType", "types", "message", "uid", "signature"],
        ),
      },
      ["signer", "sig"],
      { description: "Optional EAS offchain attestation of the receipt digest, verifiable offline with ecrecover; no chain transaction." },
    ),
    ReceiptDocument: obj(
      {
        payload: ref("ReceiptPayload"),
        digest: ref("ReceiptDigest"),
        signature: obj({ alg: str({ const: "Ed25519" }), kid: str(), value: { ...B64URL, description: "Ed25519 over \"kletia.receipt.v1:\" + digest, 64 bytes." } }, ["alg", "kid", "value"]),
        disclosures: { type: "object", additionalProperties: ref("ReceiptDisclosure"), description: "Any subset; keys are group paths (intent.request, steps.s1.evidence, …)." },
        inclusion: ref("ReceiptInclusion"),
        attestations: obj({ eas: ref("EasEnvelope") }),
      },
      ["payload", "digest", "signature"],
      { description: "Verify offline with verifyReceipt from @kletia/core; re-check on-chain with `npx @kletia/cli receipt reverify`." },
    ),
    ReceiptPending: obj(
      {
        reason: str({ enum: ["queued", "awaiting_finality", "finality_timeout", "rpc_unavailable", "anchor_reorged", "signer_missing", "issuer_error"] }),
        expectedBy: { type: ["string", "null"], format: "date-time" },
        retryAfterSeconds: int({ minimum: 1 }),
      },
      ["reason", "expectedBy", "retryAfterSeconds"],
    ),
    ReceiptResponse: obj(
      {
        receipt: { oneOf: [ref("ReceiptDocument"), { type: "null" }] },
        pending: { ...ref("ReceiptPending"), description: "202: the receipt is not issued yet. 200: a newer state of the intent is being receipted." },
      },
      ["receipt"],
    ),
    ReceiptListResponse: obj(
      {
        receipts: arrayOf(
          obj(
            {
              receiptId: ref("ReceiptId"),
              sequence: int({ minimum: 1 }),
              status: str(),
              terminal: bool(),
              digest: ref("ReceiptDigest"),
              issuedOn: DAY,
              supersededBy: nullable(ref("ReceiptId")),
            },
            ["receiptId", "sequence", "status", "terminal", "digest", "issuedOn", "supersededBy"],
          ),
        ),
      },
      ["receipts"],
    ),
    ReceiptShareRequest: obj(
      {
        profile: str({ enum: ["route", "amounts", "proof", "full"], default: "route", description: "route: skeleton only; amounts: amounts and outcome; proof: amounts, evidence and timing (evidence reveals senders through the chain); full: everything." }),
        groups: arrayOf(str({ pattern: "^(intent\\.(request|plan|timing|outcome)|steps\\.(\\*|[A-Za-z0-9_-]{1,32})\\.(parties|amounts|evidence))$" }), {
          maxItems: 64,
          description: "Explicit group paths or patterns instead of a profile.",
        }),
        sequence: int({ minimum: 1, description: "Default: the latest receipt." }),
        expiresInSeconds: { type: ["integer", "null"], minimum: MIN_SHARE_SECONDS, maximum: MAX_SHARE_SECONDS, default: DEFAULT_SHARE_SECONDS, description: "null: never expires." },
      },
      [],
      { additionalProperties: false },
    ),
    ReceiptShare: obj(
      {
        id: ref("ReceiptShareId"),
        receiptId: ref("ReceiptId"),
        sequence: int({ minimum: 1 }),
        groups: arrayOf(str()),
        expiresAt: { type: ["string", "null"], format: "date-time" },
        createdAt: str({ format: "date-time" }),
        url: str({ format: "uri", description: "Creation response only: the link carries the decryption key in its fragment, which never reaches a server. Kletia does not keep the key." }),
      },
      ["id", "receiptId", "sequence", "groups", "expiresAt", "createdAt"],
    ),
    ReceiptShareResponse: obj({ share: ref("ReceiptShare") }, ["share"]),
    ReceiptShareListResponse: obj({ shares: arrayOf(ref("ReceiptShare"), { description: "Active shares, newest first (no keys)." }) }, ["shares"]),
    ReceiptShareCiphertext: obj(
      {
        ciphertext: { ...B64URL, description: "base64url(iv 12 bytes || AES-256-GCM ciphertext || tag 16 bytes); AAD \"kletia.receipt-share.v1:\" + receiptId + \":\" + shareId." },
        alg: str({ const: "A256GCM" }),
        groups: arrayOf(str()),
        expiresAt: { type: ["string", "null"], format: "date-time" },
      },
      ["ciphertext", "alg", "groups", "expiresAt"],
    ),
    PublicReceiptResponse: obj(
      { receipt: { ...ref("ReceiptDocument"), description: "The signed payload, digest, signature, inclusion and attestations; never disclosures (they travel encrypted in shares)." } },
      ["receipt"],
    ),
    ReceiptStatusResponse: obj(
      { sequence: int({ minimum: 1 }), terminal: bool(), supersededBy: nullable(ref("ReceiptId")) },
      ["sequence", "terminal", "supersededBy"],
    ),
    ReceiptKey: obj(
      {
        kty: str({ const: "OKP" }),
        crv: str({ const: "Ed25519" }),
        x: B64URL,
        kid: str({ description: "RFC 7638 thumbprint of the key." }),
        alg: str({ const: "Ed25519" }),
        use: str({ const: "sig" }),
        status: str({ enum: ["active", "next", "retired", "revoked", "development"] }),
        notBefore: DAY,
        revokedOn: DAY,
      },
      ["kty", "crv", "x", "kid", "alg", "use", "status", "notBefore"],
    ),
    ReceiptKeySet: obj(
      {
        keys: arrayOf(ref("ReceiptKey")),
        attesters: arrayOf(
          obj({ type: str({ const: "eas" }), chain: str(), address: str(), schemaUid: str({ const: EAS_SCHEMA_UID }), status: str({ const: "active" }) }, ["type", "chain", "address", "schemaUid", "status"]),
        ),
      },
      ["keys", "attesters"],
    ),
    ReceiptLogBatch: obj(
      {
        spec: str({ const: RECEIPT_LOG_SPEC_VERSION }),
        seq: int({ minimum: 1 }),
        size: int({ minimum: 1 }),
        root: HEX64,
        previous: { type: ["string", "null"], pattern: RECEIPT_DIGEST_PATTERN.source, description: "Batch digest of the previous batch: batches form a hash chain." },
        closedOn: DAY,
      },
      ["spec", "seq", "size", "root", "previous", "closedOn"],
    ),
    ReceiptLogBatchView: obj(
      {
        seq: int({ minimum: 1 }),
        batch: ref("ReceiptLogBatch"),
        batchDigest: HEX64,
        signature: { ...B64URL, description: "Ed25519 over \"kletia.receipt-log.v1:\" + batchDigest." },
        anchor: nullable(obj({ chain: str(), contract: str(), tx: str(), timestamp: int() }, ["chain", "contract", "tx", "timestamp"])),
        closedAt: str({ format: "date-time" }),
      },
      ["seq", "batch", "batchDigest", "signature", "anchor", "closedAt"],
    ),
    ReceiptLogResponse: obj({ batches: arrayOf(ref("ReceiptLogBatchView"), { description: "Newest first." }) }, ["batches"]),
    ReceiptLogBatchResponse: obj(
      {
        batch: ref("ReceiptLogBatchView"),
        leaves: obj({ offset: int({ minimum: 0 }), limit: int({ minimum: 1 }), total: int({ minimum: 1 }), items: arrayOf(HEX64) }, ["offset", "limit", "total", "items"]),
      },
      ["batch"],
    ),
    ReceiptInclusionResponse: obj({ inclusion: ref("ReceiptInclusion") }, ["inclusion"]),
    ReceiptAnchorRequest: obj({ tx: str({ pattern: "^0x[0-9a-fA-F]{64}$" }) }, ["tx"], { additionalProperties: false }),
    ReceiptLogAnchorResponse: obj({ batch: ref("ReceiptLogBatchView") }, ["batch"]),
    ReceiptIssuedEvent: obj(
      {
        id: ref("EventId"),
        type: str({ const: "intent.receipt_issued" }),
        at: str({ format: "date-time" }),
        data: obj(
          {
            intentId: ref("IntentId"),
            receiptId: ref("ReceiptId"),
            sequence: int({ minimum: 1 }),
            status: str({ enum: ["completed", "partially_completed", "failed", "cancelled"] }),
            terminal: bool(),
            digest: ref("ReceiptDigest"),
            kid: str(),
            supersedes: { type: ["string", "null"] },
          },
          ["intentId", "receiptId", "sequence", "status", "terminal", "digest", "kid", "supersedes"],
        ),
      },
      ["id", "type", "at", "data"],
      { description: "A receipt was issued (after every reference finalized); ids and digest only, never disclosures." },
    ),
    PlanRecord: obj(
      {
        spec: str({ const: PLAN_RECORD_SPEC_VERSION }),
        createdAt: str({ format: "date-time" }),
        expiresAt: str({ format: "date-time" }),
        interpretation: { type: "object" },
        steps: arrayOf({ type: "object" }),
        edges: arrayOf({ type: "object" }),
        warnings: arrayOf(str()),
      },
      ["spec", "createdAt", "expiresAt", "interpretation", "steps", "edges", "warnings"],
      { description: "The plan as created (amounts as base-unit strings, USD with 4 decimals); never changed by prepare." },
    ),
  };
}

const receiptIdParameter: JsonObject = { name: "receiptId", in: "path", required: true, schema: ref("ReceiptId") };
const shareIdParameter: JsonObject = { name: "shareId", in: "path", required: true, schema: ref("ReceiptShareId") };
const seqParameter: JsonObject = { name: "seq", in: "path", required: true, schema: int({ minimum: 1 }) };
const RETRY_AFTER: JsonObject = { "Retry-After": { $ref: "#/components/headers/Retry-After" } };

export function receiptPaths(): JsonObject {
  return {
    "/v1/intents/{id}/receipt": {
      get: {
        operationId: "getIntentReceipt",
        tags: ["Receipts"],
        summary: "The intent's latest receipt with every disclosure",
        description:
          "Receipts are issued after the intent ends (completed, partially completed, failed or cancelled) and every on-chain reference is finalized, usually 15 to 25 minutes after the last leg on EVM rollups, seconds on Solana and Polygon. 202 with `pending` and Retry-After while waiting; 409 RECEIPT_NOT_READY while the intent runs (when no earlier receipt exists), 409 RECEIPT_NOT_APPLICABLE for expired intents, 503 RECEIPTS_DISABLED when the deployment cannot sign. `sequence` reads an earlier receipt (404 RECEIPT_NOT_FOUND when unknown).",
        parameters: [intentIdParameter, { name: "sequence", in: "query", required: false, schema: int({ minimum: 1 }) }],
        responses: {
          "200": ok("ReceiptResponse", "Receipt (with `pending` when a newer state is being receipted)."),
          "202": ok("ReceiptResponse", "Not issued yet: `receipt` is null.", RETRY_AFTER),
          ...errors("404", "409"),
        },
      },
    },
    "/v1/intents/{id}/receipts": {
      get: {
        operationId: "listIntentReceipts",
        tags: ["Receipts"],
        summary: "Every receipt sequence of an intent",
        parameters: [intentIdParameter],
        responses: { "200": ok("ReceiptListResponse", "Oldest first."), ...errors("404") },
      },
    },
    "/v1/intents/{id}/receipt/shares": {
      post: {
        operationId: "createReceiptShare",
        tags: ["Receipts"],
        summary: "Share a receipt (link returned once)",
        description: `Encrypts the chosen disclosure groups with a fresh key that only the returned \`url\` carries (in its fragment); Kletia keeps the ciphertext, never the key. At most ${MAX_ACTIVE_SHARES} active shares per receipt (409 RECEIPT_SHARE_LIMIT); 410 RECEIPT_DISCLOSURES_WITHDRAWN after a withdrawal. Honours \`Idempotency-Key\` with an API key: the stored response (with the link) is encrypted at rest.`,
        parameters: [intentIdParameter, idempotencyKeyParameter],
        requestBody: { required: false, content: { "application/json": { schema: ref("ReceiptShareRequest") } } },
        responses: { "201": ok("ReceiptShareResponse", "Share with its one-time link."), ...errors("404", "409", "410", "413", "415", "422") },
      },
      get: {
        operationId: "listReceiptShares",
        tags: ["Receipts"],
        summary: "Active shares of the intent's receipts (no keys)",
        parameters: [intentIdParameter],
        responses: { "200": ok("ReceiptShareListResponse", "Active shares."), ...errors("404") },
      },
    },
    "/v1/intents/{id}/receipt/shares/{shareId}": {
      delete: {
        operationId: "revokeReceiptShare",
        tags: ["Receipts"],
        summary: "Revoke a share (idempotent)",
        parameters: [intentIdParameter, shareIdParameter],
        responses: { "204": noContent("Revoked."), ...errors("404") },
      },
    },
    "/v1/intents/{id}/receipt/disclosures": {
      delete: {
        operationId: "withdrawReceiptDisclosures",
        tags: ["Receipts"],
        summary: "Withdraw stored disclosures and every share",
        description: "Deletes the stored disclosures of every receipt of the intent (and of later ones) and every share. The signed payloads (commitments only) and log leaves stay; copies already downloaded cannot be recalled. 409 RECEIPT_NOT_READY (or RECEIPT_NOT_APPLICABLE) when the intent has no receipt yet.",
        parameters: [intentIdParameter],
        responses: { "204": noContent("Withdrawn."), ...errors("404", "409") },
      },
    },
    "/v1/receipts/keys": {
      get: {
        operationId: "getReceiptKeys",
        tags: ["Receipts"],
        summary: "Receipt signing keys and EAS attesters",
        description: `Ed25519 public keys (active, next, retired, revoked; development keys sign only outside production). Cacheable for ${RECEIPT_KEYS_CACHE_SECONDS / 60} minutes. Cross-check with the web origin's /.well-known/kletia-receipt-keys.json before trusting a key that is not pinned in @kletia/core.`,
        responses: { "200": ok("ReceiptKeySet", "Key set."), ...errors() },
      },
    },
    "/v1/receipts/log": {
      get: {
        operationId: "listReceiptLogBatches",
        tags: ["Receipts"],
        summary: "Transparency log batches",
        description: "Hourly batches: an RFC 6962 Merkle tree over receipt digests, hash-chained and signed. `unanchored=true` lists batches no EAS timestamp on Base is recorded for yet.",
        parameters: [
          { name: "limit", in: "query", required: false, schema: int({ minimum: 1, maximum: 100, default: 20 }) },
          { name: "unanchored", in: "query", required: false, schema: str({ enum: ["true", "false", "1", "0"] }) },
        ],
        responses: { "200": ok("ReceiptLogResponse", "Newest first."), ...errors() },
      },
    },
    "/v1/receipts/log/inclusion": {
      get: {
        operationId: "getReceiptInclusion",
        tags: ["Receipts"],
        summary: "Inclusion proof of a receipt digest",
        parameters: [{ name: "digest", in: "query", required: true, schema: ref("ReceiptDigest") }],
        responses: { "200": ok("ReceiptInclusionResponse", "Inclusion proof."), ...errors("404") },
      },
    },
    "/v1/receipts/log/{seq}": {
      get: {
        operationId: "getReceiptLogBatch",
        tags: ["Receipts"],
        summary: "One log batch (optionally its leaves)",
        parameters: [
          seqParameter,
          { name: "leaves", in: "query", required: false, schema: str({ enum: ["true", "false", "1", "0"] }) },
          { name: "offset", in: "query", required: false, schema: int({ minimum: 0, default: 0 }) },
          { name: "limit", in: "query", required: false, schema: int({ minimum: 1, maximum: MAX_LOG_LEAVES_PAGE, default: MAX_LOG_LEAVES_PAGE }) },
        ],
        responses: { "200": ok("ReceiptLogBatchResponse", "Batch."), ...errors("404") },
      },
    },
    "/v1/receipts/log/{seq}/anchor": {
      post: {
        operationId: "reportReceiptLogAnchor",
        tags: ["Receipts"],
        summary: "Report the Base transaction that timestamped a batch (operator)",
        description: "Recorded only when the transaction is a successful call to EAS.timestamp(batchDigest) on Base whose timestamp EAS returns (422 RECEIPT_ANCHOR_INVALID otherwise, 409 RECEIPT_ANCHOR_EXISTS when already recorded). Kletia only reads the chain.",
        security: KEY_REQUIRED,
        parameters: [seqParameter],
        requestBody: { required: true, content: { "application/json": { schema: ref("ReceiptAnchorRequest") } } },
        responses: { "200": ok("ReceiptLogAnchorResponse", "Anchor recorded."), ...errors("404", "409", "413", "415", "422", "502") },
      },
    },
    "/v1/receipts/{receiptId}": {
      get: {
        operationId: "getSharedReceipt",
        tags: ["Receipts"],
        summary: "A shared receipt's signed payload",
        description: "Only while the owner shares the receipt; unknown and unshared receipts both answer 404 RECEIPT_NOT_FOUND. No disclosures (they come encrypted from the share).",
        parameters: [receiptIdParameter],
        responses: { "200": ok("PublicReceiptResponse", "Signed payload."), ...errors("404") },
      },
    },
    "/v1/receipts/{receiptId}/status": {
      get: {
        operationId: "getSharedReceiptStatus",
        tags: ["Receipts"],
        summary: "Whether a shared receipt was superseded",
        parameters: [receiptIdParameter],
        responses: { "200": ok("ReceiptStatusResponse", "Status."), ...errors("404") },
      },
    },
    "/v1/receipts/{receiptId}/shares/{shareId}": {
      get: {
        operationId: "getReceiptShare",
        tags: ["Receipts"],
        summary: "A share's encrypted disclosures",
        description: "Decrypt with the key from the link's fragment (Web Crypto AES-GCM), then verify with verifyReceipt. 404 RECEIPT_SHARE_NOT_FOUND when unknown or revoked, 410 RECEIPT_SHARE_EXPIRED when expired.",
        parameters: [receiptIdParameter, shareIdParameter],
        responses: { "200": ok("ReceiptShareCiphertext", "Ciphertext."), ...errors("404", "410") },
      },
    },
  };
}
