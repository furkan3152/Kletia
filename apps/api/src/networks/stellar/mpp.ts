import type { RequestHandler } from "express";
import { Mppx } from "mppx/express";
import { stellar } from "@stellar/mpp/charge/server";
import { StrKey } from "@stellar/stellar-sdk";

import { STELLAR_TESTNET } from "./config.js";
import { readStellarMppStoreReadiness, stellarMppAtomicStore } from "./mppStore.js";

const PRICE_PATTERN = /^(?:0\.\d{1,7}|[1-9]\d*(?:\.\d{1,7})?)$/u;
const MAX_PRICE_ATOMIC = 100n * 10_000_000n;
let middleware: RequestHandler | null = null;

export function parseStellarMppPriceAtomic(value: string): bigint | null {
  if (!PRICE_PATTERN.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  const atomic = BigInt(whole) * 10_000_000n + BigInt(fraction.padEnd(7, "0"));
  return atomic > 0n && atomic <= MAX_PRICE_ATOMIC ? atomic : null;
}

export function validateStellarMppConfiguration(input: {
  readonly enabled: boolean;
  readonly recipient: string;
  readonly secretKey: string;
  readonly price: string;
  readonly databaseConfigured: boolean;
}) {
  const { enabled, recipient, secretKey, price, databaseConfigured } = input;
  const parsedPriceAtomic = parseStellarMppPriceAtomic(price);
  const recipientValid =
    StrKey.isValidEd25519PublicKey(recipient) || StrKey.isValidContract(recipient);
  const valid =
    enabled && recipientValid && secretKey.length >= 32 && parsedPriceAtomic !== null && databaseConfigured;
  return Object.freeze({
    enabled,
    valid,
    recipient: recipientValid ? recipient : null,
    price: parsedPriceAtomic === null ? null : price,
    priceAtomic: parsedPriceAtomic?.toString() ?? null,
    maximumPriceAtomic: MAX_PRICE_ATOMIC.toString(),
    databaseConfigured,
    mode: "official_stellar_mpp_charge" as const,
    sessionMode: "disabled_until_channel_contract_is_pinned" as const,
    unsignedPushAccepted: false as const,
  });
}

export function stellarMppConfiguration() {
  return validateStellarMppConfiguration({
    enabled: process.env.STELLAR_MPP_ENABLED?.trim() === "true",
    recipient: process.env.STELLAR_MPP_RECIPIENT?.trim() || "",
    secretKey: process.env.STELLAR_MPP_SECRET_KEY?.trim() || "",
    price: process.env.STELLAR_MPP_PRICE_USDC?.trim() || "0.01",
    databaseConfigured: Boolean(
      process.env.STELLAR_MPP_DATABASE_URL?.trim() ||
      process.env.WORKFLOW_V3_DATABASE_URL?.trim() ||
      process.env.WORKFLOW_V2_DATABASE_URL?.trim(),
    ),
  });
}

export async function readStellarMppReadiness() {
  const configuration = stellarMppConfiguration();
  const storeReady = configuration.valid
    ? await readStellarMppStoreReadiness()
    : false;
  return {
    ...configuration,
    storeReady,
    ready: configuration.valid && storeReady,
    network: "stellar:testnet" as const,
    currency: STELLAR_TESTNET.usdc.sac,
    mockSettlementAllowed: false as const,
  };
}

export function stellarMppChargeMiddleware(): RequestHandler {
  if (middleware) return middleware;
  const configuration = stellarMppConfiguration();
  if (!configuration.valid || !configuration.recipient || !configuration.price) {
    throw Object.assign(
      new Error("Stellar MPP charge is disabled or incompletely configured."),
      { code: "STELLAR_MPP_UNAVAILABLE", statusCode: 503 },
    );
  }
  const payments = Mppx.create({
    secretKey: process.env.STELLAR_MPP_SECRET_KEY!.trim(),
    realm: process.env.STELLAR_MPP_REALM?.trim() || "Kletia Stellar Testnet",
    methods: [
      stellar.charge({
        recipient: configuration.recipient,
        currency: STELLAR_TESTNET.usdc.sac,
        decimals: 7,
        network: "stellar:testnet",
        rpcUrl: STELLAR_TESTNET.rpcUrl,
        store: stellarMppAtomicStore(),
        allowUnsignedPush: false,
        maxPushPaymentAgeSeconds: 300,
        challengeLifetimeSeconds: 300,
      }),
    ],
  });
  middleware = payments.charge({
    amount: configuration.price,
    description: "Kletia Stellar capability and disclosure report",
    scope: "/api/stellar/mpp/capability-report",
  });
  return middleware;
}
