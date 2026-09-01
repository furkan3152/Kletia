import express from "express";
import cors, { type CorsOptions } from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import {
  IntentDisclosureConsentRequiredError,
  parseUserIntent,
  type IntentSemanticPlannerMode,
  type ParsedIntent,
} from "./shared/ai/parser.js";
import {
  resolveIntentEntities,
  type EntityClarification,
  type IntentEntityResolutionEvidence,
} from "./shared/assets/resolver.js";
import { executeKletiaEngine } from "./networks/base/engine.js";
import { executeArcEngine } from "./networks/arc/engine.js";
import { executeArbitrumEngine } from "./networks/arbitrum/engine.js";
import workflowRoutes from "./cross-chain/routes.js";
import { compileWorkflow } from "./cross-chain/workflow.js";
import workflowV2Routes, { planWorkflowV2Handler } from "./cross-chain/v2/routes.js";
import workflowV3Routes, {
  capabilitiesV3Handler,
  compileWorkflowV3Handler,
} from "./cross-chain/v3/routes.js";
import workflowV4Routes, {
  capabilitiesV4Handler,
  compileWorkflowV4Handler,
} from "./cross-chain/v4/routes.js";
import { createVerifiedIntentResultEnvelope } from "./shared/intent/responseEnvelope.js";
import {
  issueSemanticConsentToken,
  issueSemanticSessionConsentToken,
  verifySemanticConsentToken,
} from "./shared/intent/semanticConsent.js";
import { createIntentPrivacyTrace } from "./shared/privacy/intentPrivacyTrace.js";
import {
  RequestIdValidationError,
  requireIntentRequestId,
  resolveIntentRequestId,
} from "./shared/security/requestId.js";
import { resolveIntentPublicError } from "./shared/security/intentError.js";
import premiumRoutes from "./networks/base/routes/premium.js";
import { agentRoutes } from "./networks/base/routes/agent.js";
import { validateAddress, sanitizePrompt } from "./shared/http/security.js";
import jwt, { type JwtHeader } from "jsonwebtoken";
import alloraRoutes from "./integrations/allora/routes.js";
import paymasterRoutes from "./networks/base/routes/paymaster.js";
import webacyRoutes from "./integrations/webacy/routes.js";
import arcRoutes from "./networks/arc/routes.js";
import baseRoutes from "./networks/base/routes/protocols.js";
import baseMcpRoutes from "./networks/base/routes/mcp.js";
import baseX402BuyerRoutes from "./networks/base/routes/x402Buyer.js";
import stellarRoutes from "./networks/stellar/routes.js";
import arbitrumSepoliaRoutes from "./networks/arbitrum-sepolia/routes.js";
import releaseRoutes from "./release/routes.js";
import { createServer } from "http";
import { randomUUID } from "crypto";
import { pathToFileURL } from "url";
import { getAddress, isAddress, zeroAddress } from "viem";
import { resolveBasenameEvidence } from "./networks/base/intent/basenameResolver.js";
import {
  NETWORKS,
  NETWORK_CLIENTS,
  getPublicNetworkDescriptor,
  type NetworkId,
} from "./shared/config/networks.js";
import {
  requireArcNetwork,
  requireArbitrumNetwork,
  requireBaseNetwork,
  requireFixedBaseNetwork,
  requireIntentNetwork,
} from "./shared/http/network.js";
import "./shared/config/productionEnvironment.js";

(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};

const app = express();
const stellarLabsEnabled =
  process.env.STELLAR_LABS_ENABLED?.trim().toLowerCase() === "true";

function requireStellarLabs(
  _req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) {
  if (!stellarLabsEnabled) {
    return res.status(404).json({
      success: false,
      code: "STELLAR_LAB_DISABLED",
      message:
        "This research workflow is not part of the default Kletia product.",
    });
  }
  return next();
}

const parsedPort = Number(process.env.PORT || 3001);
if (
  !Number.isSafeInteger(parsedPort) ||
  parsedPort < 1 ||
  parsedPort > 65_535
) {
  throw new Error("PORT must be an integer between 1 and 65535.");
}
const PORT = parsedPort;

function resolveTrustProxyHops() {
  const configured = process.env.TRUST_PROXY_HOPS?.trim();
  const raw = configured || (process.env.NODE_ENV === "production" ? "1" : "0");
  if (!/^\d$/u.test(raw) || Number(raw) > 3) {
    throw new Error("TRUST_PROXY_HOPS must be an integer between 0 and 3.");
  }
  return Number(raw);
}

const trustProxyHops = resolveTrustProxyHops();
app.set("trust proxy", trustProxyHops === 0 ? false : trustProxyHops);

app.use(helmet());
const productionOrigins = [
  "https://kletia.com",
  "https://www.kletia.com",
  "https://kletiaai.xyz",
  "https://www.kletiaai.xyz",
  "https://kletia-frontend.onrender.com",
];
const developmentOrigins = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:5174",
  "http://127.0.0.1:5174",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:10000",
  "http://127.0.0.1:10000",
];
const builtInOrigins = [
  ...productionOrigins,
  ...(process.env.NODE_ENV === "production" ? [] : developmentOrigins),
];
function normalizeCorsOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("CORS_ORIGINS contains an invalid origin.");
  }
  const isLocalDevelopmentOrigin =
    process.env.NODE_ENV !== "production" &&
    parsed.protocol === "http:" &&
    (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
  if (
    parsed.origin !== value ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    (parsed.protocol !== "https:" && !isLocalDevelopmentOrigin)
  ) {
    throw new Error(
      "CORS_ORIGINS entries must be exact HTTPS origins; local HTTP is development-only.",
    );
  }
  return parsed.origin;
}
const configuredOrigins = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean)
  .map(normalizeCorsOrigin);
export const allowedOrigins = [
  ...new Set([...builtInOrigins, ...configuredOrigins]),
];

const corsOptions: CorsOptions = {
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error(`CORS origin is not allowed: ${origin}`));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-PAYMENT",
    "PAYMENT-SIGNATURE",
    "PAYMENT-REQUIRED",
    "PAYMENT-RESPONSE",
    "Access-Control-Expose-Headers",
    "X-Kletia-Network",
    "X-Kletia-Chain-Id",
    "X-Kletia-Chain-Ref",
    "X-Kletia-Intent-Version",
    "X-Kletia-Payment-Session",
    "X-Request-Id",
    "X-Client-Name",
    "X-Client-Version",
  ],
  exposedHeaders: [
    "WWW-Authenticate",
    "Payment-Receipt",
    "PAYMENT-REQUIRED",
    "PAYMENT-RESPONSE",
    "X-PAYMENT-RESPONSE",
    "X-Kletia-Payment-Session",
  ],
};
app.use(cors(corsOptions));
app.use(express.json());

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  // The read-only solver feed has its own tighter V3 limiter. Counting the
  // local worker here would exhaust the shared user-facing API budget.
  skip: (req) =>
    req.method === "GET" &&
    req.originalUrl.split("?", 1)[0] ===
      "/api/workflows/v3/solver-market/opportunities",
  message: {
    status: "error",
    message: "Too many requests. Please try again later.",
  },
});

const premiumLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: {
    status: "error",
    message: "You have exceeded the rate limit for premium routes.",
  },
});

const onrampLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 5,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    success: false,
    code: "ONRAMP_RATE_LIMITED",
    message: "Onramp request limit exceeded. Please try again later.",
  },
});

app.use("/api/", limiter);
app.use("/api/premium", premiumLimiter, requireFixedBaseNetwork, premiumRoutes);
app.use("/api/agent", requireBaseNetwork, agentRoutes);
app.use("/api/allora", requireBaseNetwork, alloraRoutes);
app.use("/api/paymaster", requireFixedBaseNetwork, paymasterRoutes);
app.use("/api/webacy", webacyRoutes);
app.use("/api/arc", requireArcNetwork, arcRoutes);
app.use("/api/workflows/v2", workflowV2Routes);
app.use("/api/workflows/v3", requireStellarLabs, workflowV3Routes);
app.use("/api/intents/v3", requireStellarLabs, workflowV3Routes);
app.get("/api/capabilities", requireStellarLabs, capabilitiesV3Handler);
app.use("/api/workflows/v4", requireStellarLabs, workflowV4Routes);
app.use("/api/intents/v4", requireStellarLabs, workflowV4Routes);
app.get("/api/capabilities/v4", requireStellarLabs, capabilitiesV4Handler);
app.use("/api/workflows", workflowRoutes);
app.use("/api/stellar", stellarRoutes);
app.use("/api/arbitrum-sepolia", arbitrumSepoliaRoutes);
app.use("/api/release", releaseRoutes);
app.use("/api/base/x402-buyer", requireBaseNetwork, baseX402BuyerRoutes);
app.use("/api/base", requireBaseNetwork, baseRoutes);
app.use("/api/base-mcp", requireBaseNetwork, baseMcpRoutes);

app.get("/api/networks", (_req, res) => {
  res.json({
    success: true,
    defaultNetwork: "base",
    networks: Object.values(NETWORKS).map(getPublicNetworkDescriptor),
  });
});

type NetworkHealthCheck = {
  network: NetworkId;
  chainId: number | null;
  expectedChainId: number;
  blockNumber?: string;
  status: "ok" | "chain_mismatch" | "unreachable" | "disabled";
  checkedAt: number;
  error?: string;
};

const NETWORK_HEALTH_TTL_MS = 10_000;
const NETWORK_HEALTH_TIMEOUT_MS = 7_000;
const networkHealthCache = new Map<
  NetworkId,
  { expiresAt: number; value: NetworkHealthCheck }
>();
const networkHealthInFlight = new Map<NetworkId, Promise<NetworkHealthCheck>>();

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("rpc_timeout")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readNetworkHealth(
  network: NetworkId,
  force = false,
): Promise<NetworkHealthCheck> {
  const cached = networkHealthCache.get(network);
  if (!force && cached && cached.expiresAt > Date.now()) return cached.value;
  const existing = networkHealthInFlight.get(network);
  if (existing) return existing;

  const check = (async () => {
    const config = NETWORKS[network];
    let value: NetworkHealthCheck;
    if (!config.enabled) {
      value = {
        network,
        chainId: null,
        expectedChainId: config.chainId,
        status: "disabled",
        checkedAt: Date.now(),
      };
      networkHealthCache.set(network, {
        expiresAt: Date.now() + NETWORK_HEALTH_TTL_MS,
        value,
      });
      return value;
    }
    try {
      const [chainId, blockNumber] = await withDeadline(
        Promise.all([
          NETWORK_CLIENTS[network].getChainId(),
          NETWORK_CLIENTS[network].getBlockNumber(),
        ]),
        NETWORK_HEALTH_TIMEOUT_MS,
      );
      value = {
        network,
        chainId,
        expectedChainId: config.chainId,
        blockNumber: blockNumber.toString(),
        status: chainId === config.chainId ? "ok" : "chain_mismatch",
        checkedAt: Date.now(),
      };
    } catch (error: any) {
      console.error("[HEALTH RPC CHECK FAILED]", {
        network,
        code: typeof error?.code === "string" ? error.code : "RPC_ERROR",
      });
      value = {
        network,
        chainId: null,
        expectedChainId: config.chainId,
        status: "unreachable",
        checkedAt: Date.now(),
        error: "RPC health check failed.",
      };
    }
    networkHealthCache.set(network, {
      expiresAt: Date.now() + NETWORK_HEALTH_TTL_MS,
      value,
    });
    return value;
  })().finally(() => networkHealthInFlight.delete(network));

  networkHealthInFlight.set(network, check);
  return check;
}

app.get("/health", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  return res.json({
    success: true,
    status: "alive",
    service: "kletia-omni-engine",
  });
});

app.get(["/api/health/base", "/api/health/arc", "/api/health/arbitrum"], async (req, res) => {
  const network: NetworkId = req.path.endsWith("/arc")
    ? "arc"
    : req.path.endsWith("/arbitrum")
      ? "arbitrum"
      : "base";
  const check = await readNetworkHealth(network);
  res.setHeader("Cache-Control", "no-store");
  return res.status(check.status === "ok" ? 200 : 503).json({
    success: check.status === "ok",
    status: check.status === "ok" ? "ready" : "unavailable",
    service: "kletia-omni-engine",
    check,
  });
});

app.get("/api/health", async (_req, res) => {
  const enabledNetworks = (Object.keys(NETWORKS) as NetworkId[]).filter(
    (network) => NETWORKS[network].enabled,
  );
  const checks = await Promise.all(
    enabledNetworks.map((network) =>
      readNetworkHealth(network),
    ),
  );
  const readyCount = checks.filter((check) => check.status === "ok").length;
  const fullyReady = readyCount === checks.length;
  res.setHeader("Cache-Control", "no-store");
  return res.status(readyCount > 0 ? 200 : 503).json({
    success: readyCount > 0,
    status: fullyReady ? "ready" : readyCount > 0 ? "degraded" : "unavailable",
    service: "kletia-omni-engine",
    checks,
  });
});

app.post("/api/intent", (req, res, next) => {
  const requestedVersion = String(
    req.header("X-Kletia-Intent-Version") || req.body?.schemaVersion || "",
  )
    .trim()
    .toLowerCase();
  if (
    requestedVersion === "4" ||
    requestedVersion === "v4" ||
    requestedVersion === "kletia_intent_compile_v4"
  ) {
    return void compileWorkflowV4Handler(req, res);
  }
  if (
    requestedVersion === "3" ||
    requestedVersion === "v3" ||
    requestedVersion === "kletia_intent_compile_v3"
  ) {
    return void compileWorkflowV3Handler(req, res);
  }
  const network = String(req.header("X-Kletia-Network") || req.body?.network || "")
    .trim()
    .toLowerCase();
  const chainRef = String(req.header("X-Kletia-Chain-Ref") || req.body?.chainRef || "")
    .trim()
    .toLowerCase();
  if (network !== "stellar" && chainRef !== "stellar:testnet") return next();
  if (network !== "stellar" || chainRef !== "stellar:testnet") {
    return res.status(400).json({
      success: false,
      code: "NETWORK_CHAIN_MISMATCH",
      message: "Stellar intents require network stellar and chainRef stellar:testnet.",
    });
  }
  return void planWorkflowV2Handler(req, res);
});

app.post(
  "/api/intent/revalidate-recipient",
  requireIntentNetwork,
  async (req, res) => {
    const network = req.kletiaNetwork!;
    let requestId: string;
    try {
      requestId = resolveIntentRequestId(
        req.body?.requestId,
        req.body?.msgId,
        randomUUID,
      );
    } catch (error) {
      if (error instanceof RequestIdValidationError) {
        return res.status(error.statusCode).json({
          success: false,
          code: error.code,
          message: error.message,
          network: network.id,
          chainId: network.chainId,
        });
      }
      throw error;
    }

    const name =
      typeof req.body?.name === "string"
        ? req.body.name.trim().toLowerCase()
        : "";
    if (
      name.length < 6 ||
      name.length > 80 ||
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.base(?:\.eth)?$/u.test(name)
    ) {
      return res.status(400).json({
        success: false,
        code: "INVALID_BASENAME",
        message:
          "Recipient to be revalidated must be a valid .base or .base.eth name.",
        network: network.id,
        chainId: network.chainId,
        requestId,
      });
    }

    let expectedAddress;
    let userAddress;
    try {
      expectedAddress = getAddress(String(req.body?.expectedAddress || ""));
      userAddress = getAddress(String(req.body?.userAddress || ""));
      if (expectedAddress === zeroAddress || userAddress === zeroAddress) {
        throw new Error("zero_address");
      }
    } catch {
      return res.status(400).json({
        success: false,
        code: "INVALID_REVALIDATION_ADDRESS",
        message:
          "Expected recipient and active wallet must be valid, non-zero EVM addresses.",
        network: network.id,
        chainId: network.chainId,
        requestId,
      });
    }

    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const evidence = await Promise.race([
        resolveBasenameEvidence(name),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("basename_revalidation_timeout")),
            8_000,
          );
        }),
      ]).finally(() => {
        if (timer) clearTimeout(timer);
      });
      if (!evidence) {
        return res.status(409).json({
          success: false,
          code: "BASENAME_UNRESOLVED",
          message:
            "Basename could not be re-resolved immediately before signing; transaction plan was not used.",
          network: network.id,
          chainId: network.chainId,
          requestId,
          userAddress,
        });
      }
      if (evidence.address !== expectedAddress) {
        return res.status(409).json({
          success: false,
          code: "BASENAME_RECORD_CHANGED",
          message:
            "Basename address record changed after plan creation; a new intent must be created.",
          network: network.id,
          chainId: network.chainId,
          requestId,
          userAddress,
        });
      }
      return res.json({
        success: true,
        status: "resolved",
        network: network.id,
        chainId: network.chainId,
        requestId,
        userAddress,
        recipientResolution: {
          role: "recipient",
          originalReference: name,
          resolvedAddress: evidence.address,
          matchedBy: "basename",
          basename: evidence.name,
          resolver: evidence.resolver,
          observedAtBlock: evidence.observedAtBlock,
          observedAt: evidence.observedAt,
          expiresAt: evidence.expiresAt,
          crossNetworkIdentity: network.id !== "base",
        },
      });
    } catch {
      return res.status(503).json({
        success: false,
        code: "BASENAME_REVALIDATION_UNAVAILABLE",
        message:
          "Basename revalidation could not be completed; transaction was not sent.",
        network: network.id,
        chainId: network.chainId,
        requestId,
        userAddress,
      });
    }
  },
);

interface ConversationSession {
  network: NetworkId;
  userAddress: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  lastAccess: number;
  semanticPlanner: IntentSemanticPlannerMode;
  semanticModelInfluencedPlan: boolean;
  aiConsentExpiresAt?: number;
  pendingResolution?: {
    intent: ParsedIntent;
    originalPrompt: string;
    clarification: EntityClarification;
    expiresAt: number;
  };
  pendingCompletion?: {
    intent: ParsedIntent;
    originalPrompt: string;
    field: "recipient" | "tokenOut" | "amount";
    question: string;
    expiresAt: number;
  };
}

const conversationSessions = new Map<string, ConversationSession>();
const CONVERSATION_TTL_MS = 15 * 60 * 1000;
const PENDING_RESOLUTION_TTL_MS = 5 * 60 * 1000;
const MAX_CONVERSATION_SESSIONS = 1_000;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function pendingIntentCompletion(
  intent: ParsedIntent,
): ConversationSession["pendingCompletion"] | undefined {
  const action = String(intent.action || "").trim().toLowerCase();
  const question =
    intent.question || intent.message || "A little more information is required.";
  const recipientActions = new Set([
    "appkit_bridge",
    "appkit_send",
    "memo_send",
    "official_memo_send",
  ]);
  const field = recipientActions.has(action) && !intent.recipient
    ? "recipient"
    : action === "swap" && !intent.tokenOut
      ? "tokenOut"
      : (!intent.amount || intent.amount === "0") &&
          /\b(?:amount|miktar|how much)\b/iu.test(question)
        ? "amount"
        : undefined;
  if (!field) return undefined;
  return {
    intent,
    originalPrompt: "",
    field,
    question,
    expiresAt: Date.now() + PENDING_RESOLUTION_TTL_MS,
  };
}

function applyPendingIntentCompletion(
  pending: NonNullable<ConversationSession["pendingCompletion"]>,
  reply: string,
): ParsedIntent | null {
  const value = reply.trim();
  if (pending.field === "recipient") {
    if (!isAddress(value) && !/^[^\s.]+\.base(?:\.eth)?$/iu.test(value)) {
      return null;
    }
  } else if (pending.field === "amount") {
    if (!/^\d+(?:[.,]\d+)?$/u.test(value) || Number(value.replace(",", ".")) <= 0) {
      return null;
    }
  } else if (!/^[a-z][a-z0-9]{1,23}$/iu.test(value)) {
    return null;
  }
  const completed = {
    ...pending.intent,
    [pending.field]: pending.field === "amount"
      ? value.replace(",", ".")
      : pending.field === "tokenOut"
        ? value.toUpperCase()
        : value,
    isComplete: true,
    question: "",
    message: "The missing field was added to the existing wallet-bound intent.",
  };
  if (completed.action === "appkit_bridge" && completed.destinationChain) {
    const destinationKey = completed.destinationChain
      .trim()
      .toLowerCase()
      .replace(/[_\s]+/gu, "-");
    const supportedDestination = ({
      base: "base-sepolia",
      "base-sepolia": "base-sepolia",
      ethereum: "ethereum-sepolia",
      "ethereum-sepolia": "ethereum-sepolia",
      arbitrum: "arbitrum-sepolia",
      "arbitrum-sepolia": "arbitrum-sepolia",
      optimism: "optimism-sepolia",
      "optimism-sepolia": "optimism-sepolia",
      avalanche: "avalanche-fuji",
      "avalanche-fuji": "avalanche-fuji",
    } as Readonly<Record<string, string>>)[destinationKey];
    if (!supportedDestination) return null;
    completed.destinationChain = supportedDestination;
  }
  return completed;
}

function resolveIntentSemanticPlanner(
  value: unknown,
): IntentSemanticPlannerMode {
  const mode = String(value ?? "deterministic_only").trim();
  if (mode === "deterministic_only" || mode === "ai_assisted") return mode;
  throw Object.assign(new Error("Unsupported semantic planner mode."), {
    code: "INTENT_SEMANTIC_PLANNER_INVALID",
    statusCode: 400,
  });
}

function privacyDecisionContract(input: {
  network: NetworkId;
  chainId: number;
  userAddress: string;
  prompt: string;
}) {
  const consent = issueSemanticConsentToken(input);
  const sessionConsent = issueSemanticSessionConsentToken(input);
  return {
    schemaVersion: "kletia_intent_decision_v1" as const,
    questionId: "semantic-planner-consent" as const,
    kind: "privacy" as const,
    blockingField: "semanticPlanner" as const,
    sensitivity: "public_semantics_may_include_private_values" as const,
    whyAsked:
      "This wording needs Kletia's semantic model. Transaction building and wallet approval remain deterministic.",
    question:
      "Turn on smart intent interpretation for this browser session?",
    options: [
      {
        id: "allow_ai_for_this_intent" as const,
        label: "Allow AI for this intent",
        description:
          "Allow semantic-model interpretation for this intent; transaction construction and signing remain deterministic and wallet-controlled.",
        impact:
          "The model provider can observe the prompt and recent conversation context for this intent.",
      },
      {
        id: "allow_ai_for_session" as const,
        label: "Turn on smart parsing",
        description:
          "Understand natural language for this wallet and network during the current workday.",
        impact:
          "For up to 8 hours, unmatched prompts may be sent to the configured model provider without asking again.",
      },
      {
        id: "open_private_composer" as const,
        label: "Keep fields local",
        description:
          "Use the protected composer for supported private fields and commitments.",
        impact:
          "Unsupported operations will remain blocked instead of being downgraded to public or AI-assisted planning.",
      },
      {
        id: "edit_intent" as const,
        label: "Edit intent",
        description:
          "Rewrite the request with a supported explicit action, asset, network and constraints.",
        impact: "No semantic-model request is made.",
      },
    ],
    network: input.network,
    decisionToken: consent.token,
    sessionDecisionToken: sessionConsent.token,
    expiresAt: consent.expiresAt,
    sessionExpiresAt: sessionConsent.expiresAt,
  };
}

const memoryCleanupTimer = setInterval(
  () => {
    const now = Date.now();
    for (const [conversationId, session] of conversationSessions) {
      if (now - session.lastAccess > CONVERSATION_TTL_MS) {
        conversationSessions.delete(conversationId);
      }
    }
  },
  5 * 60 * 1000,
);
memoryCleanupTimer.unref();

const MAX_ONRAMP_RESPONSE_BYTES = 64 * 1024;
const MAX_ONRAMP_TOKEN_LENGTH = 16 * 1024;

app.post(
  "/api/onramp-token",
  onrampLimiter,
  requireFixedBaseNetwork,
  async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");
    try {
      const allowedBodyFields = new Set(["address", "network", "chainId"]);
      if (
        !req.body ||
        typeof req.body !== "object" ||
        Array.isArray(req.body) ||
        Object.keys(req.body).some((key) => !allowedBodyFields.has(key))
      ) {
        return res.status(400).json({
          success: false,
          code: "INVALID_ONRAMP_REQUEST",
          message: "Onramp request contains unsupported fields.",
          network: "base",
          chainId: NETWORKS.base.chainId,
        });
      }
      if (typeof req.body.address !== "string") {
        return res.status(400).json({
          success: false,
          code: "INVALID_ADDRESS",
          message: "The address field is required.",
          network: "base",
          chainId: NETWORKS.base.chainId,
        });
      }
      const destinationAddress = getAddress(req.body.address);

      const keyName = process.env.CDP_API_KEY_NAME?.trim();
      const keySecret = process.env.CDP_API_KEY_PRIVATE_KEY?.replace(
        /\\n/g,
        "\n",
      );
      if (!keyName || !keySecret) {
        return res.status(503).json({
          success: false,
          code: "ONRAMP_NOT_CONFIGURED",
          message: "Coinbase onramp server credentials are not configured.",
          network: "base",
          chainId: NETWORKS.base.chainId,
        });
      }

      const requestMethod = "POST";
      const requestPath = "/onramp/v1/token";
      const jwtHeader: JwtHeader & { nonce: string } = {
        alg: "ES256",
        kid: keyName,
        nonce: randomUUID(),
      };
      const authorizationToken = jwt.sign(
        {
          iss: "cdp",
          nbf: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 120,
          sub: keyName,
          uri: `${requestMethod} api.developer.coinbase.com${requestPath}`,
        },
        keySecret,
        {
          algorithm: "ES256",
          keyid: keyName,
          header: jwtHeader,
        },
      );

      const response = await fetch(
        `https://api.developer.coinbase.com${requestPath}`,
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            Authorization: `Bearer ${authorizationToken}`,
          },
          body: JSON.stringify({
            destination_wallets: [
              { address: destinationAddress, blockchains: ["base"] },
            ],
          }),
          signal: AbortSignal.timeout(12_000),
        },
      );

      const declaredLength = Number(response.headers.get("content-length"));
      if (
        Number.isFinite(declaredLength) &&
        declaredLength > MAX_ONRAMP_RESPONSE_BYTES
      ) {
        throw new Error("onramp_response_too_large");
      }
      const raw = await response.text();
      if (Buffer.byteLength(raw, "utf8") > MAX_ONRAMP_RESPONSE_BYTES) {
        throw new Error("onramp_response_too_large");
      }
      let data: unknown;
      try {
        data = JSON.parse(raw);
      } catch {
        throw new Error("onramp_invalid_json");
      }

      if (!response.ok) {
        console.error("[CDP ONRAMP] Provider rejected token request:", {
          status: response.status,
        });
        return res.status(502).json({
          success: false,
          code: "ONRAMP_PROVIDER_REJECTED",
          message: "Failed to create Coinbase onramp session.",
          network: "base",
          chainId: NETWORKS.base.chainId,
        });
      }
      const onrampToken =
        data && typeof data === "object" && !Array.isArray(data)
          ? (data as Record<string, unknown>).token
          : undefined;
      if (
        typeof onrampToken !== "string" ||
        onrampToken.length < 1 ||
        onrampToken.length > MAX_ONRAMP_TOKEN_LENGTH
      ) {
        throw new Error("onramp_invalid_token");
      }

      return res.json({
        success: true,
        status: "success",
        token: onrampToken,
        network: "base",
        chainId: NETWORKS.base.chainId,
      });
    } catch (error: any) {
      console.error("[CDP ONRAMP] Token request failed:", {
        name: error instanceof Error ? error.name : "UnknownError",
        code: typeof error?.code === "string" ? error.code : undefined,
      });
      const invalidAddress = error?.name === "InvalidAddressError";
      const timedOut = error?.name === "TimeoutError";
      const statusCode = invalidAddress ? 400 : timedOut ? 504 : 502;
      const code = invalidAddress
        ? "INVALID_ADDRESS"
        : timedOut
          ? "ONRAMP_PROVIDER_TIMEOUT"
          : "ONRAMP_TOKEN_ERROR";
      const message = invalidAddress
        ? "Invalid wallet address."
        : timedOut
          ? "Coinbase onramp timed out."
          : "Coinbase onramp session could not be securely verified.";
      return res.status(statusCode).json({
        success: false,
        code,
        message,
        network: "base",
        chainId: NETWORKS.base.chainId,
      });
    }
  },
);

app.post(
  "/api/intent",
  requireIntentNetwork,
  requireIntentRequestId,
  validateAddress,
  sanitizePrompt,
  async (req, res) => {
    const { prompt, userAddress } = req.body;
    const network = req.kletiaNetwork!;
    const requestId = req.kletiaRequestId!;
    const responseMetadata = {
      network: network.id,
      chainId: network.chainId,
      requestId,
    };
    let semanticPlanner: IntentSemanticPlannerMode;
    try {
      semanticPlanner = resolveIntentSemanticPlanner(req.body?.semanticPlanner);
    } catch (error) {
      const candidate = error as { code?: string; statusCode?: number; message?: string };
      return res.status(candidate.statusCode || 400).json({
        success: false,
        code: candidate.code || "INTENT_SEMANTIC_PLANNER_INVALID",
        message: candidate.message || "Unsupported semantic planner mode.",
        ...responseMetadata,
      });
    }

    if (!prompt || !userAddress) {
      return res.status(400).json({
        success: false,
        code: "INVALID_INTENT_REQUEST",
        error: "The prompt and userAddress fields are required.",
        message: "The prompt and userAddress fields are required.",
        ...responseMetadata,
      });
    }

    let semanticProviderRequestAttempted = false;
    let semanticModelInfluencedPlan = false;
    const privacyTrace = (
      stage: Parameters<typeof createIntentPrivacyTrace>[0]["stage"],
      options: {
        readonly intent?: Pick<ParsedIntent, "action">;
        readonly clarificationStored?: boolean;
      } = {},
    ) =>
      createIntentPrivacyTrace({
        requestId,
        network: network.id,
        chainId: network.chainId,
        prompt: String(prompt),
        stage,
        semanticPlanner,
        semanticProviderRequestAttempted,
        semanticModelInfluencedPlan,
        intent: options.intent,
        clarificationStored: options.clarificationStored === true,
      });

    const suppliedConversationId = req.body.conversationId;
    if (
      suppliedConversationId !== undefined &&
      (typeof suppliedConversationId !== "string" ||
        !UUID_V4_PATTERN.test(suppliedConversationId))
    ) {
      return res.status(400).json({
        success: false,
        code: "INVALID_CONVERSATION_ID",
        error: "Invalid conversationId.",
        message: "Invalid conversationId.",
        ...responseMetadata,
      });
    }

    const suppliedClarificationSelection = req.body.clarificationSelection;
    if (
      suppliedClarificationSelection !== undefined &&
      (!suppliedClarificationSelection ||
        typeof suppliedClarificationSelection !== "object" ||
        Array.isArray(suppliedClarificationSelection) ||
        typeof suppliedClarificationSelection.optionId !== "string" ||
        suppliedClarificationSelection.optionId.length < 1 ||
        suppliedClarificationSelection.optionId.length > 160 ||
        Object.keys(suppliedClarificationSelection).some(
          (key) => key !== "optionId",
        ))
    ) {
      return res.status(400).json({
        success: false,
        code: "INVALID_CLARIFICATION_SELECTION",
        error: "Invalid token selection.",
        message: "Invalid token selection.",
        ...responseMetadata,
      });
    }

    console.log(
      `
📡 [NEW ORDER][${network.id}:${network.chainId}][${requestId}] ` +
        `promptLength=${String(prompt).length} wallet=${userAddress.substring(0, 6)}…`,
    );

    try {
      let conversationId =
        typeof suppliedConversationId === "string"
          ? suppliedConversationId
          : null;
      let session = conversationId
        ? conversationSessions.get(conversationId)
        : undefined;
      if (
        session &&
        (Date.now() - session.lastAccess > CONVERSATION_TTL_MS ||
          (session.pendingResolution !== undefined &&
            Date.now() > session.pendingResolution.expiresAt) ||
          (session.pendingCompletion !== undefined &&
            Date.now() > session.pendingCompletion.expiresAt) ||
          session.network !== network.id ||
          session.userAddress !== String(userAddress).toLowerCase())
      ) {
        conversationSessions.delete(conversationId!);
        session = undefined;
      }
      semanticModelInfluencedPlan =
        session?.semanticModelInfluencedPlan === true;
      if (conversationId && !session) {
        return res.status(409).json({
          success: false,
          code: "CONVERSATION_CONTEXT_INVALID",
          error:
            "Conversation context not found, expired, or does not match wallet/network.",
          message:
            "Conversation context not found, expired, or does not match wallet/network.",
          ...responseMetadata,
        });
      }

      const history = session ? [...session.history] : [];
      let aiConsentExpiresAt = session?.aiConsentExpiresAt;
      let parsedIntent: ParsedIntent;
      let resolutionPrompt = String(prompt);
      if (session?.pendingCompletion) {
        const pending = session.pendingCompletion;
        const completed = applyPendingIntentCompletion(pending, String(prompt));
        if (!completed) {
          session.lastAccess = Date.now();
          conversationSessions.set(conversationId!, session);
          return res.json({
            success: false,
            status: "question",
            requiresInput: true,
            question: pending.question,
            message: pending.question,
            conversationId,
            conversationExpiresAt: pending.expiresAt,
            privacyTrace: privacyTrace("clarification", {
              intent: pending.intent,
              clarificationStored: true,
            }),
            userAddress: getAddress(userAddress),
            ...responseMetadata,
          });
        }
        parsedIntent = completed;
        resolutionPrompt = `${pending.originalPrompt}\n${pending.field}: ${String(prompt).trim()}`;
        conversationSessions.delete(conversationId!);
        session = undefined;
      } else if (session?.pendingResolution) {
        const pending = session.pendingResolution;
        const field = pending.clarification.field;
        if (!field) {
          conversationSessions.delete(conversationId!);
          return res.status(409).json({
            success: false,
            code: "CLARIFICATION_CONTEXT_INVALID",
            error: "Token selection context is invalid.",
            message: "Token selection context is invalid.",
            ...responseMetadata,
          });
        }
        const selectedOption = suppliedClarificationSelection
          ? pending.clarification.options.find(
              ({ id }) => id === suppliedClarificationSelection.optionId,
            )
          : undefined;
        if (suppliedClarificationSelection && !selectedOption) {
          return res.status(409).json({
            success: false,
            code: "CLARIFICATION_OPTION_INVALID",
            error: "Selected token is not among the candidates for the pending intent.",
            message:
              "Selected token is not among the candidates for the pending intent.",
            ...responseMetadata,
          });
        }
        const workflowField = /^workflowSteps\.(\d+)\.(tokenIn|tokenOut|collateralToken|borrowToken)$/u.exec(field);
        if (workflowField) {
          const stepIndex = Number(workflowField[1]);
          const assetField = workflowField[2] as "tokenIn" | "tokenOut";
          if (
            !selectedOption ||
            !pending.intent.workflowSteps ||
            !Number.isSafeInteger(stepIndex) ||
            stepIndex < 0 ||
            stepIndex >= pending.intent.workflowSteps.length ||
            (assetField !== "tokenIn" && assetField !== "tokenOut")
          ) {
            return res.status(409).json({
              success: false,
              code: "CLARIFICATION_CONTEXT_INVALID",
              error: "Workflow asset selection context is invalid.",
              message: "Workflow asset selection context is invalid.",
              ...responseMetadata,
            });
          }
          const workflowSteps = pending.intent.workflowSteps.map((step, index) =>
            index === stepIndex
              ? { ...step, [assetField]: selectedOption.symbol }
              : step,
          );
          parsedIntent = {
            ...pending.intent,
            workflowSteps,
            isComplete: true,
          };
        } else {
          const selectedReference = selectedOption
            ? selectedOption.address || selectedOption.symbol
            : String(prompt).trim();
          parsedIntent = {
            ...pending.intent,
            [field]: selectedReference,
            isComplete: true,
          };
        }
        resolutionPrompt = pending.originalPrompt;

        conversationSessions.delete(conversationId!);
        session = undefined;
      } else {
        if (suppliedClarificationSelection) {
          return res.status(409).json({
            success: false,
            code: "CLARIFICATION_CONTEXT_REQUIRED",
            error: "A valid and pending intent is required for token selection.",
            message: "A valid and pending intent is required for token selection.",
            ...responseMetadata,
          });
        }
        if (semanticPlanner === "ai_assisted") {
          const existingConsentIsActive =
            session?.semanticPlanner === "ai_assisted" &&
            typeof session.aiConsentExpiresAt === "number" &&
            session.aiConsentExpiresAt > Date.now();
          if (!existingConsentIsActive) {
            const consent = verifySemanticConsentToken(
              req.body?.semanticPlannerConsentToken,
              {
                network: network.id,
                chainId: network.chainId,
                userAddress: getAddress(userAddress),
                prompt: String(prompt),
              },
            );
            aiConsentExpiresAt = consent.expiresAt;
          }
        }
        try {
          parsedIntent = await parseUserIntent(prompt, history, network.id, {
            semanticPlanner,
            onSemanticProviderRequest: () => {
              semanticProviderRequestAttempted = true;
            },
          });
          if (semanticProviderRequestAttempted) {
            semanticModelInfluencedPlan = true;
          }
        } catch (error) {
          if (error instanceof IntentDisclosureConsentRequiredError) {
            const privacyDecision = privacyDecisionContract({
              network: network.id,
              chainId: network.chainId,
              userAddress: getAddress(userAddress),
              prompt: String(prompt),
            });
            return res.status(error.statusCode).json({
              success: false,
              status: "question",
              requiresInput: true,
              code: error.code,
              question: privacyDecision.question,
              message: error.message,
              privacyDecision,
              privacyTrace: privacyTrace("semantic_consent"),
              userAddress: getAddress(userAddress),
              ...responseMetadata,
            });
          }
          throw error;
        }
      }

      history.push({ role: "user", content: prompt });
      history.push({
        role: "assistant",
        content: parsedIntent.message || "Understood.",
      });
      console.log(
        `[PARSED INTENT][${network.id}:${network.chainId}][${requestId}] ` +
          `action=${parsedIntent.action} complete=${parsedIntent.isComplete}`,
      );
      if (!parsedIntent.isComplete) {
        if (!conversationId) {
          if (conversationSessions.size >= MAX_CONVERSATION_SESSIONS) {
            const oldest = conversationSessions.keys().next().value;
            if (oldest) conversationSessions.delete(oldest);
          }
          conversationId = randomUUID();
        }
        const completion = pendingIntentCompletion(parsedIntent);
        conversationSessions.set(conversationId, {
          network: network.id,
          userAddress: String(userAddress).toLowerCase(),
          history: history.slice(-6),
          lastAccess: Date.now(),
          semanticPlanner,
          semanticModelInfluencedPlan,
          ...(semanticPlanner === "ai_assisted" && aiConsentExpiresAt
            ? { aiConsentExpiresAt }
            : {}),
          ...(completion
            ? {
                pendingCompletion: {
                  ...completion,
                  originalPrompt: String(prompt),
                },
              }
            : {}),
        });
        const conversationExpiresAt = completion?.expiresAt ||
          Date.now() + CONVERSATION_TTL_MS;
        return res.json({
          success: false,
          status: "question",
          requiresInput: true,
          question:
            parsedIntent.question ||
            parsedIntent.message ||
            "A little more information is required.",
          message: parsedIntent.message,
          conversationId,
          conversationExpiresAt,
          privacyTrace: privacyTrace("clarification", {
            intent: parsedIntent,
            clarificationStored: true,
          }),
          userAddress: getAddress(userAddress),
          ...responseMetadata,
        });
      }

      const entityResolution = await resolveIntentEntities(parsedIntent, {
        network: network.id,
        userAddress,
        originalPrompt: resolutionPrompt,
        requestId,
      });
      if (entityResolution.status === "clarification") {
        if (!conversationId) {
          if (conversationSessions.size >= MAX_CONVERSATION_SESSIONS) {
            const oldest = conversationSessions.keys().next().value;
            if (oldest) conversationSessions.delete(oldest);
          }
          conversationId = randomUUID();
        }
        const conversationExpiresAt = Date.now() + PENDING_RESOLUTION_TTL_MS;
        conversationSessions.set(conversationId, {
          network: network.id,
          userAddress: String(userAddress).toLowerCase(),
          history: [],
          lastAccess: Date.now(),
          semanticPlanner,
          semanticModelInfluencedPlan,
          ...(semanticPlanner === "ai_assisted" && aiConsentExpiresAt
            ? { aiConsentExpiresAt }
            : {}),
          pendingResolution: {
            intent: parsedIntent,
            originalPrompt: resolutionPrompt,
            clarification: entityResolution.clarification,
            expiresAt: conversationExpiresAt,
          },
        });
        return res.json({
          success: false,
          status: "question",
          requiresInput: true,
          question: entityResolution.clarification.question,
          message: entityResolution.clarification.question,
          clarification: entityResolution.clarification,
          conversationId,
          conversationExpiresAt,
          privacyTrace: privacyTrace("clarification", {
            intent: parsedIntent,
            clarificationStored: true,
          }),
          userAddress: getAddress(userAddress),
          ...responseMetadata,
        });
      }

      if (conversationId) conversationSessions.delete(conversationId);
      const executableIntent = entityResolution.intent;
      const resolutionEvidence: IntentEntityResolutionEvidence =
        entityResolution.evidence;

      const rawResult =
        executableIntent.action === "workflow"
          ? await compileWorkflow(
              executableIntent,
              userAddress,
              requestId,
              resolutionPrompt,
              req.kletiaBaseX402Challenge,
              network.id,
            )
        : network.id === "arc"
          ? await executeArcEngine(
              executableIntent,
              userAddress,
              resolutionPrompt,
              requestId,
            )
          : network.id === "arbitrum"
            ? await executeArbitrumEngine(
                executableIntent,
                userAddress,
                resolutionPrompt,
                requestId,
              )
            : await executeKletiaEngine(
              executableIntent,
              userAddress,
              resolutionPrompt,
              requestId,
              req.kletiaBaseX402Challenge,
            );

      const result =
        rawResult.executionKind === "workflow_plan_v1" &&
        rawResult.action === "workflow" &&
        rawResult.entityResolution
          ? {
              message: rawResult.winnerMessage || executableIntent.message,
              ...rawResult,
            }
          : createVerifiedIntentResultEnvelope(
              {
                message: rawResult.winnerMessage || executableIntent.message,
                ...rawResult,
              },
              network.id,
              requestId,
              userAddress,
              resolutionEvidence,
            );

      const resultWithPrivacy = {
        ...result,
        privacyTrace: privacyTrace("planned", { intent: executableIntent }),
      };
      return res.json({
        success: true,
        result: resultWithPrivacy,
        ...resultWithPrivacy,
      });
    } catch (error: any) {
      const publicError = resolveIntentPublicError(error, network.id);
      console.log(
        `[Intent error][${network.id}:${network.chainId}][${requestId}] ` +
          `code=${error?.code || error?.name || "ENGINE_ERROR"}`,
      );

      return res.status(publicError.statusCode).json({
        success: false,
        code: publicError.code,
        error: publicError.message,
        message: publicError.message,
        privacyTrace: privacyTrace("rejected"),
        ...responseMetadata,
      });
    }
  },
);

const httpServer = createServer(app);

export async function assertRuntimeNetworkAttestation() {
  const enabledNetworks = (Object.keys(NETWORKS) as NetworkId[]).filter(
    (network) => NETWORKS[network].enabled,
  );
  const checks = await Promise.all(
    enabledNetworks.map((network) =>
      readNetworkHealth(network, true),
    ),
  );
  const failed = checks.filter((check) => check.status !== "ok");
  if (failed.length > 0) {
    throw Object.assign(
      new Error(
        `Configured RPC chain attestation failed for ${failed
          .map(({ network }) => network)
          .join(", ")}.`,
      ),
      { code: "RPC_CHAIN_ATTESTATION_FAILED" },
    );
  }
  return checks;
}

export async function startServer() {
  if (httpServer.listening) return httpServer;
  const checks = await assertRuntimeNetworkAttestation();

  await new Promise<void>((resolve, reject) => {
    const onStartupError = (error: Error) => reject(error);
    httpServer.once("error", onStartupError);
    httpServer.listen(PORT, () => {
      httpServer.off("error", onStartupError);
      resolve();
    });
  });

  httpServer.on("error", (error: any) => {
    console.error("Server startup failed.", {
      name: error instanceof Error ? error.name : "UnknownError",
      code: typeof error?.code === "string" ? error.code : undefined,
    });
  });
  console.log(`Kletia API listening on port ${PORT}.`);
  console.log(
    `Attested networks: ${checks
      .map(({ network, chainId }) => `${network}:${chainId}`)
      .join(", ")}`,
  );
  return httpServer;
}

let shutdownStarted = false;
function shutdownProcess(exitCode: number, reason: string, error?: unknown) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  console.error(`[PROCESS SHUTDOWN] ${reason}`, {
    name: error instanceof Error ? error.name : undefined,
    code:
      error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code || "")
        : undefined,
  });

  const exit = () => process.exit(exitCode);
  const forceExitTimer = setTimeout(exit, 5_000);
  forceExitTimer.unref();
  if (httpServer.listening) {
    httpServer.close(exit);
  } else {
    exit();
  }
}

function installProcessHandlers() {
  process.once("SIGINT", () => shutdownProcess(0, "SIGINT"));
  process.once("SIGTERM", () => shutdownProcess(0, "SIGTERM"));
  process.once("uncaughtException", (error) =>
    shutdownProcess(1, "UNCAUGHT_EXCEPTION", error),
  );
  process.once("unhandledRejection", (reason) =>
    shutdownProcess(1, "UNHANDLED_REJECTION", reason),
  );
}

const isDirectExecution =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectExecution) {
  installProcessHandlers();
  startServer().catch((error) => shutdownProcess(1, "STARTUP_FAILED", error));
}

// Vercel's Express runtime discovers a default-exported application. The
// direct-execution guard above preserves the long-running Render/local server
// path, while importing this module on Vercel never opens a port.
export default app;
export { app, httpServer };
