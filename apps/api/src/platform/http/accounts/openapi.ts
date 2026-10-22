/**
 * OpenAPI fragments of developer accounts (tag *Accounts*): wallet sign-in,
 * the session, the wallet's projects and their keys. Limits and patterns come
 * from @kletia/core `accounts.ts`. Merged by openapi.ts.
 */
import {
  ACCOUNT_EVM_NETWORKS,
  ACCOUNT_LIMITS,
  ACCOUNT_SESSION_HEADER,
  ACCOUNT_SESSION_TOKEN_PATTERN,
  ACCOUNT_SIGN_IN_STATEMENT,
  CHAINS,
} from "@kletia/core";
import { API_KEY_ID_PATTERN, MAX_ACTIVE_KEYS_PER_PROJECT } from "../keys.js";
import { arrayOf, errors, int, jsonBody, KEY_REQUIRED, noContent, nullable, obj, ok, ref, str, type JsonObject } from "../openapiKit.js";

const TAGS = ["Accounts"];
const PROJECT_ID = str({ pattern: "^prj_key_[0-9a-f]{24}$", examples: ["prj_key_2dce0f6a1b2c3d4e5f6a7b8c"] });
const WALLET_KIND = str({ enum: ["evm", "solana"] });
const TIME = str({ format: "date-time" });
const NULLABLE_TIME = { type: ["string", "null"], format: "date-time" };

const SESSION_HEADER: JsonObject = {
  name: ACCOUNT_SESSION_HEADER,
  in: "header",
  required: true,
  description: "The token from POST /v1/accounts/session, from the origin that signed in.",
  schema: str({ pattern: ACCOUNT_SESSION_TOKEN_PATTERN.source }),
};
const PROJECT_PARAM: JsonObject = { name: "projectId", in: "path", required: true, schema: PROJECT_ID };
const KEY_PARAM: JsonObject = { name: "keyId", in: "path", required: true, schema: str({ pattern: API_KEY_ID_PATTERN.source }) };

const ORIGIN_NOTE = "Only from the Kletia developer portal: a first-party `Origin` is required (403 ACCOUNT_ORIGIN_FORBIDDEN otherwise).";
const SESSION_NOTE = `${ORIGIN_NOTE} Send the session in \`${ACCOUNT_SESSION_HEADER}\` (401 ACCOUNT_SESSION_REQUIRED when it is missing, expired or from another origin).`;

export function accountSchemas(): JsonObject {
  return {
    AccountNonceRequest: obj(
      {
        walletKind: WALLET_KIND,
        address: str({ description: "EVM address (0x…) or base58 Solana address." }),
        chainId: int({
          enum: ACCOUNT_EVM_NETWORKS.map((network) => CHAINS[network].evmChainId as number),
          description: "EVM only: the chain the message names. Smart-contract wallets (ERC-1271 / ERC-6492) are checked on it.",
        }),
      },
      ["walletKind", "address"],
    ),
    AccountNonceResponse: obj(
      {
        message: str({ description: `The exact text to sign: EIP-4361 for EVM wallets, the Sign In With Solana text for Solana wallets. Statement: "${ACCOUNT_SIGN_IN_STATEMENT}"` }),
        nonce: str(),
        expiresAt: TIME,
        walletKind: WALLET_KIND,
      },
      ["message", "nonce", "expiresAt", "walletKind"],
    ),
    AccountSignInRequest: obj(
      {
        message: str({ maxLength: 2000 }),
        signature: str({ maxLength: 4000, description: "EVM: 0x hex. Solana: base58 or base64 of the 64-byte ed25519 signature." }),
      },
      ["message", "signature"],
    ),
    AccountSession: obj(
      {
        walletKind: WALLET_KIND,
        address: str(),
        chainId: { type: ["integer", "null"] },
        expiresAt: TIME,
        idleExpiresAt: TIME,
      },
      ["walletKind", "address", "chainId", "expiresAt", "idleExpiresAt"],
    ),
    AccountSessionResponse: obj({ session: ref("AccountSession") }, ["session"]),
    AccountSignInResponse: obj(
      {
        token: str({ pattern: ACCOUNT_SESSION_TOKEN_PATTERN.source, description: "Shown once; only its SHA-256 is stored." }),
        session: ref("AccountSession"),
      },
      ["token", "session"],
    ),
    AccountProject: obj(
      {
        id: PROJECT_ID,
        name: nullable(str({ description: "The project's brand name, when set." })),
        source: str({ enum: ["created", "claimed"] }),
        ownedSince: TIME,
        activeKeys: int({ minimum: 0 }),
        activeChildKeys: int({ minimum: 0, description: "Active agent and publishable keys." }),
      },
      ["id", "name", "source", "ownedSince", "activeKeys", "activeChildKeys"],
    ),
    AccountProjectList: obj({ projects: arrayOf(ref("AccountProject")) }, ["projects"]),
    AccountProjectCreated: obj({ project: ref("AccountProject"), key: ref("ApiKey") }, ["project", "key"]),
    AccountProjectClaimed: obj(
      { project: ref("AccountProject"), claimed: { type: "boolean", description: "False when the wallet already owned the project." } },
      ["project", "claimed"],
    ),
    AccountKey: obj(
      {
        id: str({ pattern: API_KEY_ID_PATTERN.source }),
        name: str(),
        kind: str({ enum: ["project", "agent", "publishable"] }),
        parentId: nullable(str()),
        last4: nullable(str()),
        createdAt: TIME,
        lastUsedAt: NULLABLE_TIME,
        rotatedAt: NULLABLE_TIME,
        previousExpiresAt: NULLABLE_TIME,
        revokedAt: NULLABLE_TIME,
        expiresAt: NULLABLE_TIME,
      },
      ["id", "name", "kind", "parentId", "last4", "createdAt", "lastUsedAt", "rotatedAt", "previousExpiresAt", "revokedAt", "expiresAt"],
    ),
    AccountKeyList: obj({ keys: arrayOf(ref("AccountKey")) }, ["keys"]),
    AccountActivity: obj(
      {
        id: str(),
        at: TIME,
        action: str({ enum: ["account.sign_in", "account.sign_out", "account.project.create", "account.project.claim", "account.key.issue", "account.key.rotate", "account.key.revoke"] }),
        outcome: str({ enum: ["ok", "denied", "error"] }),
        projectId: nullable(PROJECT_ID),
        keyId: nullable(str()),
      },
      ["id", "at", "action", "outcome", "projectId", "keyId"],
    ),
    AccountActivityList: obj({ activity: arrayOf(ref("AccountActivity"), { maxItems: ACCOUNT_LIMITS.activityRows }) }, ["activity"]),
  };
}

export function accountPaths(): JsonObject {
  return {
    "/v1/accounts/nonce": {
      post: {
        operationId: "createAccountSignInMessage",
        tags: TAGS,
        summary: "Get a sign-in message for a wallet",
        description: `${ORIGIN_NOTE} The message names the calling origin's host, the address, a single-use nonce and an expiry ${ACCOUNT_LIMITS.nonceTtlSeconds / 60} minutes away. Signing it moves no funds. At most ${ACCOUNT_LIMITS.noncesPerMinutePerIp} per minute per address.`,
        requestBody: jsonBody("AccountNonceRequest"),
        responses: { "201": ok("AccountNonceResponse", "The message to sign."), ...errors("403", "413", "415") },
      },
    },
    "/v1/accounts/session": {
      post: {
        operationId: "signInAccount",
        tags: TAGS,
        summary: "Sign in with the signed message",
        description: `${ORIGIN_NOTE} The nonce is used up by the first attempt, valid or not (401 ACCOUNT_NONCE_INVALID for an unknown, used, expired or altered message; 401 ACCOUNT_SIGNATURE_INVALID for a wrong signature; 502 RPC_UNAVAILABLE when a smart-wallet signature could not be checked). The session ends ${ACCOUNT_LIMITS.sessionTtlSeconds / 3600} h after sign-in or after ${ACCOUNT_LIMITS.sessionIdleSeconds / 60} minutes without a request. Signing in again on any device recovers the same projects. At most ${ACCOUNT_LIMITS.signInsPerMinutePerIp} attempts per minute per address.`,
        requestBody: jsonBody("AccountSignInRequest"),
        responses: { "201": ok("AccountSignInResponse", "The session token, shown once."), ...errors("403", "413", "415", "502") },
      },
      get: {
        operationId: "getAccountSession",
        tags: TAGS,
        summary: "The current session",
        description: SESSION_NOTE,
        parameters: [SESSION_HEADER],
        responses: { "200": ok("AccountSessionResponse", "The session."), ...errors("403") },
      },
      delete: {
        operationId: "signOutAccount",
        tags: TAGS,
        summary: "Sign out (end the session)",
        description: SESSION_NOTE,
        parameters: [SESSION_HEADER],
        responses: { "204": noContent("Signed out."), ...errors("403") },
      },
    },
    "/v1/accounts/activity": {
      get: {
        operationId: "listAccountActivity",
        tags: TAGS,
        summary: "The wallet's recent account activity",
        description: `${SESSION_NOTE} The newest ${ACCOUNT_LIMITS.activityRows} audit rows of the signed-in wallet: sign-ins, sign-outs, project creations and claims, key issues, rotations and revocations, with their outcome.`,
        parameters: [SESSION_HEADER],
        responses: { "200": ok("AccountActivityList", "Newest first."), ...errors("403") },
      },
    },
    "/v1/accounts/projects": {
      get: {
        operationId: "listAccountProjects",
        tags: TAGS,
        summary: "Projects the signed-in wallet owns",
        description: `${SESSION_NOTE} Also the projects whose keys were all lost or revoked: issue a new key to get back in.`,
        parameters: [SESSION_HEADER],
        responses: { "200": ok("AccountProjectList", "Oldest first."), ...errors("403") },
      },
      post: {
        operationId: "createAccountProject",
        tags: TAGS,
        summary: "Create a project owned by the wallet, with its first key",
        description: `${SESSION_NOTE} Same body as POST /v1/keys without a key. A wallet owns at most ${ACCOUNT_LIMITS.projectsPerWallet} projects (409 PROJECT_LIMIT_REACHED) and creates at most ${ACCOUNT_LIMITS.projectsPerHourPerWallet} an hour.`,
        parameters: [SESSION_HEADER],
        requestBody: jsonBody("ApiKeyCreateRequest"),
        responses: { "201": ok("AccountProjectCreated", "The project and its first key (shown once)."), ...errors("403", "409", "413", "415") },
      },
    },
    "/v1/accounts/projects/claim": {
      post: {
        operationId: "claimAccountProject",
        tags: TAGS,
        summary: "Link an existing project to the wallet",
        description: `${SESSION_NOTE} Also send a project key (kl_dev_) of the project with its current secret: the key proves control of the project. A project has one owner for good: a project another wallet owns is 409 PROJECT_ALREADY_OWNED. 201 when this call linked it, 200 when the wallet already owned it.`,
        security: KEY_REQUIRED,
        parameters: [SESSION_HEADER],
        responses: {
          "200": ok("AccountProjectClaimed", "The wallet already owned the project."),
          "201": ok("AccountProjectClaimed", "The project is now the wallet's."),
          ...errors("403", "409"),
        },
      },
    },
    "/v1/accounts/projects/{projectId}/keys": {
      get: {
        operationId: "listAccountProjectKeys",
        tags: TAGS,
        summary: "Keys of an owned project",
        description: `${SESSION_NOTE} Every key of the project, revoked ones included (never secrets; \`last4\` only). A project the wallet does not own is 404 PROJECT_NOT_FOUND.`,
        parameters: [SESSION_HEADER, PROJECT_PARAM],
        responses: { "200": ok("AccountKeyList", "Newest first."), ...errors("403", "404") },
      },
      post: {
        operationId: "issueAccountProjectKey",
        tags: TAGS,
        summary: "Issue a project key in an owned project",
        description: `${SESSION_NOTE} Works when every key of the project was lost or revoked: this is how access comes back. At most ${MAX_ACTIVE_KEYS_PER_PROJECT} active project keys (409 KEY_LIMIT_REACHED).`,
        parameters: [SESSION_HEADER, PROJECT_PARAM],
        requestBody: jsonBody("ApiKeyCreateRequest"),
        responses: { "201": ok("ApiKeyResponse", "The new key, shown once."), ...errors("403", "404", "409", "413", "415") },
      },
    },
    "/v1/accounts/projects/{projectId}/keys/{keyId}/rotate": {
      post: {
        operationId: "rotateAccountProjectKey",
        tags: TAGS,
        summary: "Replace a key's secret (same id)",
        description: `${SESSION_NOTE} Same rules as POST /v1/keys/{id}/rotate: the previous secret keeps authenticating for \`graceSeconds\` but cannot manage keys.`,
        parameters: [SESSION_HEADER, PROJECT_PARAM, KEY_PARAM],
        requestBody: { ...jsonBody("ApiKeyRotateRequest", false) },
        responses: { "200": ok("RotatedApiKeyResponse", "The key with its new secret, shown once."), ...errors("403", "404", "409", "413", "415") },
      },
    },
    "/v1/accounts/projects/{projectId}/keys/{keyId}": {
      delete: {
        operationId: "revokeAccountProjectKey",
        tags: TAGS,
        summary: "Revoke a key and its subtree",
        description: `${SESSION_NOTE} Same effect as DELETE /v1/keys/{id}. The project stays the wallet's even with no key left.`,
        parameters: [SESSION_HEADER, PROJECT_PARAM, KEY_PARAM],
        responses: { "204": noContent("Revoked."), ...errors("403", "404", "409") },
      },
    },
  };
}
