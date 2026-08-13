import express, { type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { WebacyClient, Chain } from "@webacy-xyz/sdk";
import { getAddress, type Address } from "viem";
import {
  ARC_NATIVE_USDC_ADDRESS,
  NETWORKS,
  arcPublicClient,
  basePublicClient,
  isNetworkTargetAllowed,
  type NetworkId,
} from "../config/networks.js";
import { verifyBaseX402Gateway } from "../networks/base/intent/x402GatewayPolicy.js";
import { resolveStrictRequestNetwork } from "../middleware/network.js";
import { parseStrictRiskScore } from "../security/riskScore.js";
import {
  ControlledRouteError,
  resolvePublicRouteFailure,
} from "../security/routeError.js";

const router = express.Router();
const WEBACY_PROVIDER_TIMEOUT_MS = 20_000;
const webacyClient = process.env.WEBACY_API_KEY
  ? new WebacyClient({
      apiKey: process.env.WEBACY_API_KEY,
      defaultChain: Chain.BASE,
    })
  : null;
const CONTROLLED_X402_GATEWAY_ERRORS: Readonly<
  Record<string, { message: string; statusCode: number }>
> = {
  BASE_RPC_CHAIN_MISMATCH: {
    message: "Base RPC does not match the expected Base Mainnet chain.",
    statusCode: 503,
  },
  INVALID_X402_ASSET: {
    message: "x402 gateway failed Base USDC payment policy.",
    statusCode: 400,
  },
  INVALID_X402_GATEWAY: {
    message: "x402 gateway address is invalid.",
    statusCode: 400,
  },
  INVALID_X402_PRICE: {
    message: "x402 gateway price is not within safe limits.",
    statusCode: 400,
  },
  UNVERIFIED_X402_GATEWAY: {
    message: "x402 gateway could not be verified on Base Mainnet.",
    statusCode: 400,
  },
};

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Webacy API Timeout")), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

router.use(
  rateLimit({
    windowMs: 60_000,
    max: 60,
    message: {
      success: false,
      code: "RATE_LIMITED",
      error: "Too many requests, please try again later.",
    },
    standardHeaders: true,
    legacyHeaders: false,
  }),
);

function requestNetwork(req: Request): NetworkId {
  return resolveStrictRequestNetwork(req).id;
}

function checkedAddress(raw: string | string[]): Address {
  try {
    return getAddress(Array.isArray(raw) ? raw[0] : raw);
  } catch {
    throw new ControlledRouteError(
      "INVALID_ADDRESS",
      "A valid EVM address is required.",
      400,
    );
  }
}

function checkedAction(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") {
    throw new ControlledRouteError(
      "INVALID_ACTION",
      "A single valid action value is required.",
      400,
    );
  }
  const action = raw.trim().toLowerCase();
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(action)) {
    throw new ControlledRouteError(
      "INVALID_ACTION",
      "A valid action value is required.",
      400,
    );
  }
  return action;
}

function sendFailure(
  res: Response,
  statusCode: number,
  code: string,
  message: string,
  network: NetworkId,
) {
  return res.status(statusCode).json({
    success: false,
    status: "error",
    code,
    error: message,
    message,
    decision: "blocked",
    riskScore: null,
    source: network === "arc" ? "arc_manifest+rpc_bytecode" : "webacy",
    network,
    chainId: NETWORKS[network].chainId,
  });
}

async function verifyControlledBaseX402Gateway(address: Address) {
  try {
    await verifyBaseX402Gateway(address);
  } catch (error) {
    const code =
      error &&
      typeof error === "object" &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : "";
    const definition = CONTROLLED_X402_GATEWAY_ERRORS[code];
    if (!definition) throw error;
    throw new ControlledRouteError(
      code,
      definition.message,
      definition.statusCode,
    );
  }
}

async function scanArcTarget(address: Address, action?: string) {
  const allowlisted = isNetworkTargetAllowed("arc", address, action);
  const [chainId, bytecode] = await Promise.all([
    withTimeout(arcPublicClient.getChainId(), 8_000),
    withTimeout(arcPublicClient.getCode({ address }), 8_000),
  ]);
  if (chainId !== NETWORKS.arc.chainId) {
    throw new ControlledRouteError(
      "ARC_RPC_CHAIN_MISMATCH",
      "Arc RPC does not match the expected Arc Testnet chain.",
      503,
    );
  }
  const hasBytecode = Boolean(bytecode && bytecode !== "0x");
  const decision = allowlisted && hasBytecode ? "approved" : "blocked";

  return {
    success: true,
    status: "success",
    address,
    isContract: hasBytecode,
    allowlisted,
    bytecodeVerified: hasBytecode,
    bytecodeBytes: hasBytecode ? (bytecode!.length - 2) / 2 : 0,
    isNativeUSDC:
      address.toLowerCase() === ARC_NATIVE_USDC_ADDRESS.toLowerCase(),
    riskScore: null,
    riskLevel: null,
    decision,
    source: "arc_manifest+rpc_bytecode",
    tags: [
      allowlisted ? "Arc Manifest Allowlist" : "Not In Arc Manifest",
      hasBytecode ? "RPC Bytecode Verified" : "No RPC Bytecode",
    ],
    network: "arc",
    chainId: NETWORKS.arc.chainId,
  };
}

async function scanBaseAddress(address: Address) {
  if (!webacyClient) {
    throw new ControlledRouteError(
      "WEBACY_UNAVAILABLE",
      "Base risk verification is currently unavailable.",
      503,
    );
  }

  const [chainId, bytecode] = await Promise.all([
    withTimeout(basePublicClient.getChainId(), 8_000),
    withTimeout(basePublicClient.getCode({ address }), 8_000),
  ]);
  if (chainId !== NETWORKS.base.chainId) {
    throw new ControlledRouteError(
      "BASE_RPC_CHAIN_MISMATCH",
      "Base RPC does not match the expected Base Mainnet chain.",
      503,
    );
  }
  const isContract = Boolean(bytecode && bytecode !== "0x");
  const risk: any = isContract
    ? await withTimeout(
        webacyClient.threat.contracts.analyze(address.toLowerCase()),
        WEBACY_PROVIDER_TIMEOUT_MS,
      )
    : await withTimeout(
        webacyClient.threat.addresses.analyze(address),
        WEBACY_PROVIDER_TIMEOUT_MS,
      );

  const tags: string[] = [];
  if (Array.isArray(risk.tags)) {
    tags.push(...risk.tags.map((tag: any) => tag.name || String(tag)));
  }
  if (Array.isArray(risk.issues)) {
    for (const issue of risk.issues) {
      if (Array.isArray(issue.tags)) {
        tags.push(...issue.tags.map((tag: any) => tag.name || String(tag)));
      }
    }
  }

  const uniqueTags = [...new Set(tags)];
  const criticalTags = [
    "sanctioned",
    "scam",
    "phishing",
    "fraud",
    "hack",
    "exploit",
    "malicious",
    "blacklist",
    "drainer",
  ];
  const communityBlacklist = new Set([
    "0xd90e2f925da726b50c4ed8d0fb90ad053324f31b",
    "0x0c99ae577ba40a81144beb7c504f2c74adb318e8",
    "0x5ced88f3c35bf7a7b5cbd5098ebb1c92e21dfa0c",
  ]);
  const critical = uniqueTags.some((tag) =>
    criticalTags.some((needle) => tag.toLowerCase().includes(needle)),
  );
  const locallyBlocked = communityBlacklist.has(address.toLowerCase());
  const rawScore = risk.score ?? risk.overallRisk;
  const reportedScore = parseStrictRiskScore(rawScore);
  if (reportedScore === null) {
    throw new ControlledRouteError(
      "WEBACY_INVALID_RESPONSE",
      "Webacy did not return a verifiable risk score.",
      502,
    );
  }
  const riskScore = critical || locallyBlocked ? 100 : reportedScore;

  if (locallyBlocked) uniqueTags.push("Community Blacklisted Scam");
  return {
    success: true,
    status: "success",
    address,
    isContract,
    riskScore,
    riskLevel: riskScore > 50 ? "High" : riskScore > 20 ? "Medium" : "Low",
    decision: riskScore > 50 ? "blocked" : "approved",
    source: "webacy",
    tags: uniqueTags,
    network: "base",
    chainId: NETWORKS.base.chainId,
  };
}

async function handleScan(req: Request, res: Response) {
  let network: NetworkId = "base";
  try {
    network = requestNetwork(req);
    const address = checkedAddress(req.params.address);
    const action = checkedAction(req.query.action);
    const dynamicBaseX402Action =
      network === "base" &&
      (action === "x402_gateway_admin" || action === "x402_gateway_payment");
    if (
      action &&
      !dynamicBaseX402Action &&
      !isNetworkTargetAllowed(network, address, action)
    ) {
      throw new ControlledRouteError(
        "ACTION_TARGET_NOT_ALLOWED",
        "Transaction target is not allowed on this network for the specified action.",
        400,
      );
    }
    if (dynamicBaseX402Action) {
      await verifyControlledBaseX402Gateway(address);
    }
    const actionEvidence = {
      action: action ?? null,
      actionBound: action !== undefined,
      targetPolicy: dynamicBaseX402Action
        ? "base_x402_factory_provenance"
        : action
          ? "network_action_allowlist"
          : "address_risk_only",
    };
    if (network === "arc") {
      return res.json({
        ...(await scanArcTarget(address, action)),
        ...actionEvidence,
      });
    }
    return res.json({
      ...(await scanBaseAddress(address)),
      ...actionEvidence,
    });
  } catch (error: any) {
    const failure = resolvePublicRouteFailure(error, {
      code: network === "arc" ? "ARC_RPC_ERROR" : "WEBACY_ERROR",
      message:
        network === "arc"
          ? "Arc target verification is unavailable."
          : "Base risk verification is unavailable.",
      statusCode: 502,
    });
    console.error(
      `[SECURITY SCAN][${network}:${NETWORKS[network].chainId}]`,
      error?.code || error?.name || "PROVIDER_ERROR",
    );
    return sendFailure(
      res,
      failure.statusCode,
      failure.code,
      failure.message,
      network,
    );
  }
}

router.get("/address/:address", handleScan);
router.get("/scan/:address", handleScan);

export default router;
