import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type { NetworkId } from "../config/networks.js";
import { decodeCanonicalBase64Url } from "../security/canonicalBase64Url.js";

const TOKEN_VERSION = "idc1";
const TOKEN_TTL_MS = 5 * 60 * 1_000;
// One explicit choice covers the active workday. The token is still bound to
// the exact wallet, network and open browser session; it is not persisted as a
// spending authority and cannot authorize a transaction.
const SESSION_TOKEN_TTL_MS = 8 * 60 * 60 * 1_000;
const DEVELOPMENT_SECRET =
  "kletia-development-intent-disclosure-consent-only";

interface SemanticConsentClaimsBaseV1 {
  readonly schemaVersion: "kletia_semantic_consent_v1";
  readonly purpose: "ai_semantic_interpretation";
  readonly network: NetworkId;
  readonly chainId: number;
  readonly userAddress: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

interface SingleIntentSemanticConsentClaimsV1
  extends SemanticConsentClaimsBaseV1 {
  readonly scope: "single_intent";
  readonly promptSha256: `0x${string}`;
}

interface BrowserSessionSemanticConsentClaimsV1
  extends SemanticConsentClaimsBaseV1 {
  readonly scope: "browser_session";
  readonly sessionId: string;
}

type SemanticConsentClaimsV1 =
  | SingleIntentSemanticConsentClaimsV1
  | BrowserSessionSemanticConsentClaimsV1;

export interface SemanticConsentBinding {
  readonly network: NetworkId;
  readonly chainId: number;
  readonly userAddress: string;
  readonly prompt: string;
}

function controlled(code: string, message: string, statusCode = 400): Error {
  return Object.assign(new Error(message), { code, statusCode });
}

function signingSecret(): string {
  const configured = process.env.WORKFLOW_SIGNING_SECRET?.trim();
  if (configured && configured.length >= 32) return configured;
  if (process.env.NODE_ENV !== "production") return DEVELOPMENT_SECRET;
  throw controlled(
    "INTENT_CONSENT_CONFIGURATION_REQUIRED",
    "Intent disclosure consent is not configured.",
    503,
  );
}

function promptSha256(prompt: string): `0x${string}` {
  return `0x${createHash("sha256").update(prompt, "utf8").digest("hex")}`;
}

function normalizedBinding(binding: SemanticConsentBinding) {
  return {
    network: binding.network,
    chainId: binding.chainId,
    userAddress: binding.userAddress.trim().toLowerCase(),
    promptSha256: promptSha256(binding.prompt),
  } as const;
}

export function issueSemanticConsentToken(
  binding: SemanticConsentBinding,
  now = Date.now(),
): { token: string; expiresAt: number } {
  const normalized = normalizedBinding(binding);
  const claims: SemanticConsentClaimsV1 = {
    schemaVersion: "kletia_semantic_consent_v1",
    purpose: "ai_semantic_interpretation",
    scope: "single_intent",
    ...normalized,
    issuedAt: now,
    expiresAt: now + TOKEN_TTL_MS,
  };
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString(
    "base64url",
  );
  const signature = createHmac("sha256", signingSecret())
    .update(`${TOKEN_VERSION}.${payload}`)
    .digest("base64url");
  return {
    token: `${TOKEN_VERSION}.${payload}.${signature}`,
    expiresAt: claims.expiresAt,
  };
}

export function issueSemanticSessionConsentToken(
  binding: Omit<SemanticConsentBinding, "prompt">,
  now = Date.now(),
): { token: string; expiresAt: number } {
  const claims: BrowserSessionSemanticConsentClaimsV1 = {
    schemaVersion: "kletia_semantic_consent_v1",
    purpose: "ai_semantic_interpretation",
    scope: "browser_session",
    network: binding.network,
    chainId: binding.chainId,
    userAddress: binding.userAddress.trim().toLowerCase(),
    sessionId: randomUUID(),
    issuedAt: now,
    expiresAt: now + SESSION_TOKEN_TTL_MS,
  };
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString(
    "base64url",
  );
  const signature = createHmac("sha256", signingSecret())
    .update(`${TOKEN_VERSION}.${payload}`)
    .digest("base64url");
  return {
    token: `${TOKEN_VERSION}.${payload}.${signature}`,
    expiresAt: claims.expiresAt,
  };
}

export function verifySemanticConsentToken(
  token: unknown,
  binding: SemanticConsentBinding,
  now = Date.now(),
): { expiresAt: number; scope: "single_intent" | "browser_session" } {
  if (typeof token !== "string" || token.length < 120 || token.length > 4_096) {
    throw controlled(
      "AI_SEMANTIC_CONSENT_INVALID",
      "A valid disclosure consent is required before AI interpretation.",
      409,
    );
  }
  const [version, payload, suppliedSignature, extra] = token.split(".");
  if (version !== TOKEN_VERSION || !payload || !suppliedSignature || extra) {
    throw controlled(
      "AI_SEMANTIC_CONSENT_INVALID",
      "The disclosure consent token is malformed.",
      409,
    );
  }
  const expectedSignature = createHmac("sha256", signingSecret())
    .update(`${TOKEN_VERSION}.${payload}`)
    .digest();
  let supplied: Buffer;
  try {
    supplied = decodeCanonicalBase64Url(suppliedSignature);
  } catch {
    throw controlled(
      "AI_SEMANTIC_CONSENT_INVALID",
      "The disclosure consent token is malformed.",
      409,
    );
  }
  if (
    supplied.length !== expectedSignature.length ||
    !timingSafeEqual(supplied, expectedSignature)
  ) {
    throw controlled(
      "AI_SEMANTIC_CONSENT_INVALID",
      "The disclosure consent token signature is invalid.",
      409,
    );
  }

  let claims: Partial<SemanticConsentClaimsV1> & Record<string, unknown>;
  try {
    const decoded = JSON.parse(
      decodeCanonicalBase64Url(payload).toString("utf8"),
    ) as unknown;
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
      throw new Error("invalid");
    }
    claims = decoded as Partial<SingleIntentSemanticConsentClaimsV1> &
      Partial<BrowserSessionSemanticConsentClaimsV1> &
      Record<string, unknown>;
  } catch {
    throw controlled(
      "AI_SEMANTIC_CONSENT_INVALID",
      "The disclosure consent payload is invalid.",
      409,
    );
  }

  const expected = normalizedBinding(binding);
  const commonKeys = [
    "schemaVersion",
    "purpose",
    "scope",
    "network",
    "chainId",
    "userAddress",
    "issuedAt",
    "expiresAt",
  ];
  const issuedAt = claims.issuedAt;
  const expiresAt = claims.expiresAt;
  const temporalShapeValid =
    typeof issuedAt === "number" &&
    Number.isSafeInteger(issuedAt) &&
    typeof expiresAt === "number" &&
    Number.isSafeInteger(expiresAt) &&
    expiresAt > issuedAt;
  const scopeValid =
    temporalShapeValid &&
    ((claims.scope === "single_intent" &&
      Object.keys(claims).length === commonKeys.length + 1 &&
      commonKeys.every((key) => key in claims) &&
      "promptSha256" in claims &&
      claims.promptSha256 === expected.promptSha256 &&
      expiresAt - issuedAt === TOKEN_TTL_MS) ||
    (claims.scope === "browser_session" &&
      Object.keys(claims).length === commonKeys.length + 1 &&
      commonKeys.every((key) => key in claims) &&
      "sessionId" in claims &&
      typeof claims.sessionId === "string" &&
      /^[0-9a-f-]{36}$/iu.test(claims.sessionId) &&
      expiresAt - issuedAt === SESSION_TOKEN_TTL_MS));
  if (
    !scopeValid ||
    claims.schemaVersion !== "kletia_semantic_consent_v1" ||
    claims.purpose !== "ai_semantic_interpretation" ||
    claims.network !== expected.network ||
    claims.chainId !== expected.chainId ||
    claims.userAddress !== expected.userAddress ||
    !temporalShapeValid
  ) {
    throw controlled(
      "AI_SEMANTIC_CONSENT_BINDING_MISMATCH",
      "The disclosure consent does not match this prompt, wallet, network, or chain.",
      409,
    );
  }
  if (issuedAt! > now + 30_000 || expiresAt! <= now) {
    throw controlled(
      "AI_SEMANTIC_CONSENT_EXPIRED",
      "The disclosure consent expired; review the disclosure choice again.",
      409,
    );
  }
  return {
    expiresAt: expiresAt!,
    scope: claims.scope as "single_intent" | "browser_session",
  };
}
