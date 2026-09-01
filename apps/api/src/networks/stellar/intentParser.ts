import { StrKey } from "@stellar/stellar-sdk";
import { isAddress } from "viem";
import { z } from "zod";

const StellarSemanticIntentSchema = z
  .object({
    kind: z.enum([
      "portfolio",
      "transfer",
      "swap",
      "trustline",
      "payout",
      "private_payment",
      "cross_chain",
      "unknown",
    ]),
    title: z.string().trim().min(1).max(100),
    summary: z.string().trim().min(1).max(280),
    nextStep: z.string().trim().min(1).max(280),
    amount: z.string().nullable(),
    assetIn: z.enum(["XLM", "USDC", "EURC"]).nullable(),
    assetOut: z.enum(["XLM", "USDC", "EURC"]).nullable(),
    recipient: z.string().nullable(),
    strictReceive: z.boolean(),
    readyToPrepare: z.boolean(),
    blockingReason: z.string().nullable(),
    stages: z
      .array(
        z
          .object({
            action: z.enum([
              "read_balance",
              "create_trustline",
              "payment",
              "swap",
              "bridge",
              "supply",
              "borrow_capacity",
              "private_payment",
            ]),
            network: z.enum([
              "stellar_testnet",
              "arc_testnet",
              "arbitrum_sepolia",
            ]),
            assetIn: z.enum(["XLM", "USDC", "EURC"]).nullable(),
            assetOut: z.enum(["XLM", "USDC", "EURC"]).nullable(),
            amountSource: z.enum([
              "explicit",
              "wallet_balance",
              "previous_output",
              "not_required",
            ]),
          })
          .strict(),
      )
      .max(8),
    missingFields: z.array(z.string().trim().min(1).max(80)).max(8),
    sourceNetwork: z
      .enum([
        "stellar_testnet",
        "arc_testnet",
        "base_sepolia",
        "arbitrum_sepolia",
      ])
      .nullable()
      .default(null),
    amountMode: z.enum(["send_exact", "receive_exact"]).nullable().default(null),
    destinationCountry: z.string().trim().length(2).nullable().default(null),
    destinationCurrency: z.string().trim().length(3).nullable().default(null),
    deliveryMethod: z.string().trim().min(1).max(40).nullable().default(null),
  })
  .strict();

export type StellarSemanticIntent = z.infer<typeof StellarSemanticIntentSchema>;

const responseProperties = {
  kind: {
    type: "string",
    enum: [
      "portfolio",
      "transfer",
      "swap",
      "trustline",
      "payout",
      "private_payment",
      "cross_chain",
      "unknown",
    ],
  },
  title: { type: "string" },
  summary: { type: "string" },
  nextStep: { type: "string" },
  amount: { type: ["string", "null"] },
  assetIn: {
    anyOf: [
      { type: "string", enum: ["XLM", "USDC", "EURC"] },
      { type: "null" },
    ],
  },
  assetOut: {
    anyOf: [
      { type: "string", enum: ["XLM", "USDC", "EURC"] },
      { type: "null" },
    ],
  },
  recipient: { type: ["string", "null"] },
  strictReceive: { type: "boolean" },
  readyToPrepare: { type: "boolean" },
  blockingReason: { type: ["string", "null"] },
  stages: {
    type: "array",
    maxItems: 8,
    items: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: {
          type: "string",
          enum: [
            "read_balance",
            "create_trustline",
            "payment",
            "swap",
            "bridge",
            "supply",
            "borrow_capacity",
            "private_payment",
          ],
        },
        network: {
          type: "string",
          enum: ["stellar_testnet", "arc_testnet", "arbitrum_sepolia"],
        },
        assetIn: {
          anyOf: [
            { type: "string", enum: ["XLM", "USDC", "EURC"] },
            { type: "null" },
          ],
        },
        assetOut: {
          anyOf: [
            { type: "string", enum: ["XLM", "USDC", "EURC"] },
            { type: "null" },
          ],
        },
        amountSource: {
          type: "string",
          enum: ["explicit", "wallet_balance", "previous_output", "not_required"],
        },
      },
      required: ["action", "network", "assetIn", "assetOut", "amountSource"],
    },
  },
  missingFields: { type: "array", maxItems: 8, items: { type: "string" } },
  sourceNetwork: {
    anyOf: [
      {
        type: "string",
        enum: [
          "stellar_testnet",
          "arc_testnet",
          "base_sepolia",
          "arbitrum_sepolia",
        ],
      },
      { type: "null" },
    ],
  },
  amountMode: {
    anyOf: [
      { type: "string", enum: ["send_exact", "receive_exact"] },
      { type: "null" },
    ],
  },
  destinationCountry: { type: ["string", "null"] },
  destinationCurrency: { type: ["string", "null"] },
  deliveryMethod: { type: ["string", "null"] },
} as const;

function controlled(code: string, message: string, statusCode = 400): Error {
  return Object.assign(new Error(message), { code, statusCode });
}

function blocked(
  intent: StellarSemanticIntent,
  reason: string,
  fields: readonly string[],
): StellarSemanticIntent {
  return {
    ...intent,
    readyToPrepare: false,
    blockingReason: reason,
    missingFields: [...new Set([...intent.missingFields, ...fields])],
  };
}

export function enforceReviewedStellarIntent(
  value: unknown,
): StellarSemanticIntent {
  const intent = StellarSemanticIntentSchema.parse(value);
  const amount = intent.amount?.trim() || null;
  if (
    amount !== null &&
    (!/^\d+(?:[.,]\d{1,7})?$/u.test(amount) || Number(amount.replace(",", ".")) <= 0)
  ) {
    return blocked(intent, "Enter a positive amount with at most seven decimals.", ["amount"]);
  }
  if (
    intent.recipient !== null &&
    intent.kind === "cross_chain" &&
    !isAddress(intent.recipient)
  ) {
    return blocked(intent, "Enter the destination EVM wallet address.", ["recipient"]);
  }
  if (
    intent.recipient !== null &&
    intent.kind !== "cross_chain" &&
    intent.kind !== "payout" &&
    !StrKey.isValidEd25519PublicKey(intent.recipient)
  ) {
    return blocked(intent, "Enter a valid Stellar G-address.", ["recipient"]);
  }
  if (
    intent.kind === "swap" &&
    !(
      (intent.assetIn === "XLM" && intent.assetOut === "USDC") ||
      (intent.assetIn === "USDC" && intent.assetOut === "XLM")
    )
  ) {
    return blocked(intent, "The reviewed Stellar swap pair is XLM and Circle Testnet USDC.", ["asset pair"]);
  }
  if (intent.kind === "transfer" && (!amount || !intent.assetIn || !intent.recipient)) {
    return blocked(intent, "Choose an amount, XLM or USDC, and a Stellar recipient.", [
      ...(!amount ? ["amount"] : []),
      ...(!intent.assetIn ? ["asset"] : []),
      ...(!intent.recipient ? ["recipient"] : []),
    ]);
  }
  if (intent.kind === "swap" && !amount) {
    return blocked(intent, "Enter the amount to swap.", ["amount"]);
  }
  if (intent.kind === "private_payment") {
    return blocked(
      intent,
      "Private Payments is a separate research lab and is not part of the default Stellar Payment Center.",
      ["research-lab mode"],
    );
  }
  if (intent.kind === "payout") {
    const country = intent.destinationCountry?.toUpperCase() || null;
    const currency = intent.destinationCurrency?.toUpperCase() || null;
    const deliveryMethod = intent.deliveryMethod?.toUpperCase() || null;
    const missing = [
      ...(!amount ? ["amount"] : []),
      ...(!intent.sourceNetwork ? ["source network"] : []),
      ...(!country || !/^[A-Z]{2}$/u.test(country) ? ["destination country"] : []),
      ...(!currency || !/^[A-Z]{3}$/u.test(currency) ? ["destination currency"] : []),
      ...(!deliveryMethod ? ["payout rail"] : []),
    ];
    if (intent.recipient) {
      return blocked(
        intent,
        "Do not put bank-account or recipient KYC data in chat. The selected anchor collects it after route review.",
        ["remove recipient banking data"],
      );
    }
    if (intent.assetIn !== "USDC" || intent.assetOut !== null || missing.length > 0) {
      return blocked(
        intent,
        "A payout needs USDC, an amount, source Testnet, destination country and currency, and a payout rail.",
        missing.length > 0 ? missing : ["USDC payout binding"],
      );
    }
    return {
      ...intent,
      amount: amount?.replace(",", ".") || null,
      destinationCountry: country,
      destinationCurrency: currency,
      deliveryMethod,
      readyToPrepare: true,
      blockingReason: null,
      missingFields: [],
    };
  }
  if (intent.kind === "cross_chain") {
    return blocked(
      intent,
      "Continue DeFi bridge and protocol actions from their source-network workspace. Stellar is used when the final outcome is a bank, cash, or local-currency payout.",
      ["source-network workspace"],
    );
  }
  if (intent.kind === "unknown") {
    return blocked(intent, intent.blockingReason || "Describe the asset, amount, and action you want.", ["supported action"]);
  }
  return {
    ...intent,
    amount: amount ? amount.replace(",", ".") : null,
    readyToPrepare: true,
    blockingReason: null,
    missingFields: [],
  };
}

function promptContainsAsset(prompt: string, asset: string): boolean {
  return new RegExp(
    `(?:^|[^A-Z0-9_])${asset}(?=$|[^A-Z0-9_])`,
    "iu",
  ).test(prompt);
}

function promptContainsAmountForAsset(
  prompt: string,
  amountValue: string,
  asset: string | null,
): boolean {
  if (!asset) return false;
  const normalized = amountValue.replace(",", ".");
  const escapedAmount = normalized.replace(".", "[.,]");
  return new RegExp(
    `(?:^|[^\\d])${escapedAmount}\\s+${asset}(?=$|[^A-Z0-9_])|` +
      `(?:^|[^A-Z0-9_])${asset}[^,;:.!?\\n]{0,24}(?:amount|miktar)?\\s*${escapedAmount}(?=$|[^\\d])`,
    "iu",
  ).test(prompt);
}

function enforceStellarPromptBinding(
  intent: StellarSemanticIntent,
  prompt: string,
): StellarSemanticIntent {
  if (
    intent.kind === "payout" &&
    /\b(?:recipient|beneficiary|someone else|another person|their bank|alici|alicinin|baskasi|baska bir kisi|onun banka)\b/iu.test(
      prompt,
    )
  ) {
    return blocked(
      intent,
      "Third-party payout requires a bilateral SEP-31 partner integration; the direct SEP-24 flow is a withdrawal for the authenticated user.",
      ["partner payout rail"],
    );
  }
  if (intent.amount) {
    if (intent.kind === "payout") {
      const amountPattern = intent.amount.replace(",", ".").replace(".", "[.,]");
      const payoutCurrency = intent.destinationCurrency || "";
      if (
        !new RegExp(
          `(?:^|[^\\d])${amountPattern}\\s*(?:USDC|${payoutCurrency})(?=$|[^A-Z0-9_])`,
          "iu",
        ).test(prompt)
      ) {
        return blocked(
          intent,
          "The payout amount could not be matched to USDC or the destination currency in your message.",
          ["amount and currency"],
        );
      }
    } else {
    const amountAsset = intent.kind === "swap" && intent.strictReceive
      ? intent.assetOut
      : intent.assetIn;
    if (!promptContainsAmountForAsset(prompt, intent.amount, amountAsset)) {
      return blocked(
        intent,
        "The amount could not be matched to the selected Stellar asset in your message.",
        ["amount and asset"],
      );
    }
    }
  }
  if (intent.recipient && !prompt.includes(intent.recipient)) {
    return blocked(
      intent,
      "The recipient must appear exactly in your current message.",
      ["recipient"],
    );
  }
  for (const asset of [intent.assetIn, intent.assetOut]) {
    if (asset && !promptContainsAsset(prompt, asset)) {
      return blocked(
        intent,
        "Every selected Stellar asset must appear in your current message.",
        ["asset"],
      );
    }
  }
  return intent;
}

export async function interpretStellarIntent(promptInput: unknown): Promise<StellarSemanticIntent> {
  const prompt = String(promptInput ?? "").trim();
  if (!prompt || prompt.length > 2_000) {
    throw controlled("STELLAR_INTENT_PROMPT_INVALID", "Enter a Stellar goal under 2,000 characters.");
  }
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    throw controlled(
      "STELLAR_SMART_PARSER_UNAVAILABLE",
      "Smart intent interpretation is not configured.",
      503,
    );
  }
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://kletia.com",
      "X-Title": "Kletia Stellar Intent Parser",
    },
    body: JSON.stringify({
      model:
        process.env.OPENROUTER_INTENT_MODEL?.trim() ||
        "openai/gpt-4o-2024-08-06",
      temperature: 0.1,
      max_tokens: 900,
      provider: { require_parameters: true },
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "kletia_stellar_semantic_intent_v1",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: responseProperties,
            required: Object.keys(responseProperties),
          },
        },
      },
      messages: [
        {
          role: "system",
          content:
            "Interpret the user's financial goal into semantic stages only. Never create XDR, contract IDs, quotes, fees, balances, success claims, or unsupported assets. The primary Stellar product is a passkey-authenticated USDC payout center: live SEP-38 indicative pricing followed later by SEP-45 authentication and a SEP-24 hosted withdrawal for the authenticated user. SEP-12 is optional remediation and third-party SEP-31 payments are partner-only and currently unavailable. For payout intents set kind=payout, assetIn=USDC, assetOut=null, never place banking or KYC data in recipient, and capture sourceNetwork, amountMode, ISO country/currency, and payout rail. Stellar Testnet also supports XLM/USDC balances, Circle USDC trustline, XLM-USDC SDEX swaps and XLM/USDC payments. Preserve step order. Ask one short question only when a required field is missing.",
        },
        { role: "user", content: `<<<${prompt}>>>` },
      ],
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw controlled(
      "STELLAR_SMART_PARSER_UNAVAILABLE",
      "Smart intent interpretation is temporarily unavailable.",
      502,
    );
  }
  const body = (await response.json()) as {
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  const content = body.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw controlled(
      "STELLAR_SMART_PARSER_INVALID",
      "Smart intent interpretation returned no usable plan.",
      502,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw controlled(
      "STELLAR_SMART_PARSER_INVALID",
      "Smart intent interpretation returned an invalid plan.",
      502,
    );
  }
  return enforceStellarPromptBinding(enforceReviewedStellarIntent(parsed), prompt);
}
