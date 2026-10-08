import express from "express";
import rateLimit from "express-rate-limit";
import { isSolanaAddress } from "@kletia/core";
import { isSolanaNetworkKey, SOLANA_NETWORK_KEYS, type SolanaNetworkKey } from "./config.js";
import { SolanaProviderError } from "./http.js";
import { readSolanaPortfolio } from "./portfolio.js";
import { readSolanaHealth } from "./rpc.js";
import { prepareSolanaSwap, prepareSolanaTransfer, quoteSolanaSwap } from "./service.js";
import { searchSolanaTokens } from "./tokens.js";
import { verifySolanaTransaction } from "./verify.js";
import { readSolanaLendingYields } from "./yields.js";

const router = express.Router();
router.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
router.use(rateLimit({ windowMs: 60_000, max: 60, standardHeaders: true, legacyHeaders: false }));

function sendError(res: express.Response, error: unknown) {
  if (error instanceof SolanaProviderError) {
    return res.status(error.status).json({ success: false, code: error.code, message: error.message });
  }
  console.error("[solana]", error instanceof Error ? error.message : error);
  return res.status(502).json({
    success: false,
    code: "SOLANA_SERVICE_UNAVAILABLE",
    message: "The Solana service is temporarily unavailable.",
  });
}

function networkFrom(value: unknown): SolanaNetworkKey {
  if (value === undefined || value === "") return "solana";
  if (!isSolanaNetworkKey(value)) {
    throw new SolanaProviderError("network must be solana or solana-devnet.", "SOLANA_NETWORK_INVALID", 400);
  }
  return value;
}

function stringField(value: unknown, name: string, max = 128): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new SolanaProviderError(`${name} is required.`, "SOLANA_REQUEST_INVALID", 400);
  }
  return value.trim();
}

function optionalSlippage(value: unknown): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new SolanaProviderError("slippageBps must be an integer.", "SOLANA_SLIPPAGE_OUT_OF_RANGE", 400);
  }
  return parsed;
}

router.get("/health", async (_req, res) => {
  const checks = await Promise.all(SOLANA_NETWORK_KEYS.map(readSolanaHealth));
  res.status(checks.every((check) => check.ok) ? 200 : 503).json({ success: true, networks: checks });
});

router.get("/portfolio/:owner", async (req, res) => {
  try {
    const network = networkFrom(req.query.network);
    if (!isSolanaAddress(req.params.owner)) {
      throw new SolanaProviderError("A valid Solana address is required.", "SOLANA_ADDRESS_INVALID", 400);
    }
    res.json({ success: true, portfolio: await readSolanaPortfolio(network, req.params.owner) });
  } catch (error) {
    sendError(res, error);
  }
});

router.get("/tokens/search", async (req, res) => {
  try {
    const query = stringField(req.query.q, "q", 64);
    res.json({ success: true, tokens: await searchSolanaTokens(query) });
  } catch (error) {
    sendError(res, error);
  }
});

router.get("/quote", async (req, res) => {
  try {
    const slippageBps = optionalSlippage(req.query.slippageBps);
    const summary = await quoteSolanaSwap({
      from: stringField(req.query.from, "from"),
      to: stringField(req.query.to, "to"),
      amount: stringField(req.query.amount, "amount", 40),
      ...(slippageBps !== undefined ? { slippageBps } : {}),
    });
    const { quote: _raw, ...publicSummary } = summary;
    res.json({ success: true, quote: publicSummary });
  } catch (error) {
    sendError(res, error);
  }
});

router.post("/swap/prepare", async (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const slippageBps = optionalSlippage(body.slippageBps);
    const prepared = await prepareSolanaSwap({
      owner: stringField(body.owner, "owner", 44),
      from: stringField(body.from, "from"),
      to: stringField(body.to, "to"),
      amount: stringField(body.amount, "amount", 40),
      ...(slippageBps !== undefined ? { slippageBps } : {}),
    });
    res.json({ success: true, swap: prepared });
  } catch (error) {
    sendError(res, error);
  }
});

router.post("/transfer/prepare", async (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const prepared = await prepareSolanaTransfer({
      network: networkFrom(body.network),
      owner: stringField(body.owner, "owner", 44),
      recipient: stringField(body.recipient, "recipient", 44),
      asset: stringField(body.asset, "asset"),
      amount: stringField(body.amount, "amount", 40),
    });
    res.json({ success: true, transfer: prepared });
  } catch (error) {
    sendError(res, error);
  }
});

router.get("/tx/:signature", async (req, res) => {
  try {
    const network = networkFrom(req.query.network);
    const signer = typeof req.query.signer === "string" ? req.query.signer : undefined;
    res.json({ success: true, evidence: await verifySolanaTransaction(network, req.params.signature, signer) });
  } catch (error) {
    sendError(res, error);
  }
});

router.get("/yields", async (_req, res) => {
  try {
    res.json({ success: true, protocol: "kamino", reserves: await readSolanaLendingYields() });
  } catch (error) {
    sendError(res, error);
  }
});

export default router;
