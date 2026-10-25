/**
 * Parsed intent schema, its inferred type and the parser's error classes.
 */
import { z } from "zod";
import type { NetworkId } from "../../config/networks.js";

export const IntentSchema = z.object({
  isComplete: z.boolean().catch(false),
  question: z.string().optional().catch(""),
  message: z.string().catch("I understood your request, handling it now."),
  action: z.string().catch("unknown"),
  tokenIn: z
    .any()
    .transform((v) => (v == null ? undefined : String(v).trim()))
    .optional(),
  tokenOut: z
    .any()
    .transform((v) => (v == null ? undefined : String(v).trim()))
    .optional(),
  amount: z.any().transform((v) => (v == null || v === "" ? "0" : String(v))),
  secondaryAmount: z
    .any()
    .transform((v) => (v == null ? undefined : String(v).trim()))
    .optional(),
  protocol: z
    .any()
    .transform((v) => (v == null ? undefined : String(v)))
    .optional(),
  objective: z
    .enum(["best_output", "best_rate", "lowest_borrow_cost", "lowest_risk"])
    .optional(),
  riskTolerance: z.enum(["conservative", "balanced", "aggressive"]).optional(),
  timeHorizonDays: z.coerce.number().int().positive().max(3650).optional(),
  maxGas: z
    .any()
    .transform((v) => (v == null ? undefined : String(v).trim()))
    .optional(),
  maxPriceImpactBps: z.coerce.number().int().min(1).max(5000).optional(),
  excludedProtocols: z.array(z.string().trim().min(1)).max(20).optional(),
  collateralToken: z
    .any()
    .transform((v) => (v == null ? undefined : String(v).trim()))
    .optional(),
  borrowToken: z
    .any()
    .transform((v) => (v == null ? undefined : String(v).trim()))
    .optional(),
  allowMultiStep: z.boolean().optional(),
  destinationChain: z
    .any()
    .transform((v) => (v == null ? undefined : String(v).trim().toLowerCase()))
    .optional(),
  durationInDays: z.coerce.number().optional().catch(0),
  name: z.string().optional(),
  symbol: z.string().optional(),
  launchId: z
    .any()
    .transform((v) => (v == null ? undefined : String(v)))
    .optional(),
  slippage: z
    .any()
    .transform((v) => (v == null ? "1" : String(v).replace("%", "")))
    .optional(),
  recipient: z
    .any()
    .transform((v) => (v == null ? undefined : String(v).trim()))
    .optional(),
  memo: z
    .any()
    .transform((v) => (v == null ? undefined : String(v).trim()))
    .optional(),
  minimumOutput: z
    .any()
    .transform((v) => (v == null ? undefined : String(v).trim()))
    .optional(),
  maxFee: z
    .any()
    .transform((v) => (v == null ? undefined : String(v).trim()))
    .optional(),
  transferSpeed: z
    .any()
    .transform((v) => (v == null ? undefined : String(v).trim().toUpperCase()))
    .optional(),
  serviceQuery: z
    .any()
    .transform((v) => (v == null ? undefined : String(v).trim()))
    .optional(),
  url: z
    .any()
    .transform((v) => (v == null ? undefined : String(v).trim()))
    .optional(),
  method: z
    .any()
    .transform((v) => (v == null ? undefined : String(v).trim().toUpperCase()))
    .optional(),
  maxPayment: z
    .any()
    .transform((v) => (v == null ? undefined : String(v).trim()))
    .optional(),
  requestBody: z.record(z.unknown()).optional(),
  curatedOnly: z.boolean().optional(),
  transfers: z
    .array(
      z
        .object({
          recipient: z.string().trim(),
          amount: z.any().transform((v) => String(v ?? "").trim()),
        })
        .strict(),
    )
    .max(25)
    .optional(),
  workflowSteps: z
    .array(
      z
        .object({
          action: z.enum([
            "bridge",
            "swap",
            "lend",
            "withdraw",
            "borrow",
            "borrow_capacity",
            "repay",
            "transfer",
            "stake",
            "unstake",
            "vault_deposit",
            "vault_withdraw",
            "lending_deposit",
            "lending_withdraw",
            "lending_borrow",
            "lending_repay",
            "gas_acquire",
            "x402_request",
            "data_purchase",
          ]),
          network: z.enum(["base", "arc", "arbitrum"]).optional(),
          tokenIn: z.string().trim().optional(),
          tokenOut: z.string().trim().optional(),
          amount: z.string().trim().optional(),
          amountSource: z
            .enum(["explicit", "wallet_balance", "previous_output"])
            .optional(),
          protocol: z.string().trim().optional(),
          destinationChain: z.string().trim().toLowerCase().optional(),
          objective: z
            .enum([
              "best_output",
              "best_rate",
              "lowest_borrow_cost",
              "lowest_risk",
            ])
            .optional(),
          url: z.string().trim().url().optional(),
          method: z.enum(["GET"]).optional(),
          maxPayment: z.string().trim().regex(/^\d+(?:\.\d{1,6})?$/u).optional(),
        })
        .strict(),
    )
    .min(2)
    .max(8)
    .optional(),
  policyAgent: z
    .object({
      name: z.string().trim().min(1).max(64),
      objective: z.string().trim().min(1).max(500),
      allowedNetworks: z.array(z.enum(["base", "arbitrum"])).min(1).max(2),
      allowedProtocols: z.array(z.string().trim().min(1).max(64)).max(12),
      allowedAssets: z.array(z.string().trim().min(1).max(64)).max(16),
      maxSpendUsdc: z.string().trim().regex(/^\d+(?:\.\d{1,6})?$/u),
      riskTolerance: z.enum(["conservative", "balanced", "aggressive"]),
      expiresInHours: z.coerce.number().int().min(1).max(720),
    })
    .strict()
    .optional(),
});

export type ParsedIntent = z.infer<typeof IntentSchema>;

export class IntentParserError extends Error {
  readonly code = "INTENT_PARSER_UNAVAILABLE";
  readonly statusCode = 502;

  constructor(
    message = "Intent parsing service currently cannot produce a verified response.",
  ) {
    super(message);
    this.name = "IntentParserError";
  }
}

export type IntentSemanticPlannerMode =
  | "deterministic_only"
  | "ai_assisted";

/**
 * A consent boundary, not a provider failure. The deterministic parser raises
 * this before any model request when an intent needs semantic interpretation.
 * The HTTP layer can then ask the user whether the additional disclosure is
 * acceptable instead of silently falling back to AI.
 */
export class IntentDisclosureConsentRequiredError extends Error {
  readonly code = "AI_SEMANTIC_CONSENT_REQUIRED";
  readonly statusCode = 409;
  readonly network: NetworkId;

  constructor(network: NetworkId) {
    super(
      "The deterministic intent parser could not resolve this request without semantic AI interpretation.",
    );
    this.name = "IntentDisclosureConsentRequiredError";
    this.network = network;
  }
}
