export type StellarWorkspaceIntentKind =
  | "portfolio"
  | "transfer"
  | "swap"
  | "trustline"
  | "payout"
  | "private_payment"
  | "cross_chain"
  | "unknown";

export type StellarWorkspaceAsset = "XLM" | "USDC" | "EURC";

export interface StellarWorkspaceIntentResolution {
  readonly kind: StellarWorkspaceIntentKind;
  readonly title: string;
  readonly summary: string;
  readonly nextStep: string;
  readonly amount?: string;
  readonly assetIn?: StellarWorkspaceAsset;
  readonly assetOut?: StellarWorkspaceAsset;
  readonly recipient?: string;
  /** Optional user-authored source cap for strict-receive SDEX routes. */
  readonly maximumSend?: string;
  readonly strictReceive: boolean;
  readonly readyToPrepare: boolean;
  readonly blockingReason?: string;
  /** Kept only in the in-memory Stellar chat message for optional semantic interpretation. */
  readonly sourcePrompt: string;
  readonly semanticModelUsed?: boolean;
  readonly scenarioId?: "arc_testnet_usdc_to_arbitrum_sepolia_aave_supply";
  readonly routePreference?: "auto" | "direct_cctp" | "stellar_centered_public";
  readonly includeBorrowCapacity?: boolean;
  readonly sourceNetwork?:
    | "stellar_testnet"
    | "arc_testnet"
    | "base_sepolia"
    | "arbitrum_sepolia";
  readonly amountMode?: "send_exact" | "receive_exact";
  readonly destinationCountry?: string;
  readonly destinationCurrency?: string;
  readonly deliveryMethod?: string;
  readonly stages?: readonly {
    readonly action:
      | "read_balance"
      | "create_trustline"
      | "payment"
      | "swap"
      | "bridge"
      | "supply"
      | "borrow_capacity"
      | "private_payment";
    readonly network: "stellar_testnet" | "arc_testnet" | "arbitrum_sepolia";
    readonly assetIn: StellarWorkspaceAsset | null;
    readonly assetOut: StellarWorkspaceAsset | null;
    readonly amountSource:
      | "explicit"
      | "wallet_balance"
      | "previous_output"
      | "not_required";
  }[];
  readonly missingFields?: readonly string[];
}

const STELLAR_ADDRESS_PATTERN = /\bG[A-Z2-7]{55}\b/u;
const AMOUNT_PATTERN = /(?:^|\s)(\d+(?:[.,]\d+)?)(?=\s|$|\b(?:XLM|USDC|EURC)\b)/iu;

function normalizedText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/ı/gu, "i")
    .toLowerCase();
}

function mentionedAssets(value: string): StellarWorkspaceAsset[] {
  const matches = value.toUpperCase().match(/\b(?:XLM|USDC|EURC)\b/gu) || [];
  const assets = new Set<StellarWorkspaceAsset>();
  matches.forEach((asset) => {
    if (asset === "XLM" || asset === "USDC" || asset === "EURC") {
      assets.add(asset);
    }
  });
  return [...assets];
}

function amountFrom(value: string): string | undefined {
  const match = value.match(AMOUNT_PATTERN)?.[1];
  return match?.replace(",", ".");
}

function baseResolution(
  kind: StellarWorkspaceIntentKind,
  title: string,
  summary: string,
  nextStep: string,
  input: string,
  readiness: { readyToPrepare?: boolean; blockingReason?: string } = {},
): StellarWorkspaceIntentResolution {
  const assets = mentionedAssets(input);
  const strictReceive =
    /\b(?:exact(?:ly)? receive|strict receive|tam olarak|tam\s+\d|alici(?:nin)?\s+tam)\b/iu.test(
      normalizedText(input),
    ) ||
    /\b(?:buy|satin\s+al|al)\s+(?:\d+(?:[.,]\d+)?\s+)?(?:XLM|USDC)\s+(?:with|using|ile)\s+(?:XLM|USDC)\b/iu.test(
      normalizedText(input),
    );
  return {
    kind,
    title,
    summary,
    nextStep,
    amount: amountFrom(input),
    assetIn: strictReceive ? assets[1] ?? assets[0] : assets[0],
    assetOut: strictReceive ? assets[0] ?? assets[1] : assets[1],
    recipient: input.match(STELLAR_ADDRESS_PATTERN)?.[0],
    strictReceive,
    readyToPrepare: readiness.readyToPrepare ?? kind !== "unknown",
    sourcePrompt: input,
    ...(readiness.blockingReason
      ? { blockingReason: readiness.blockingReason }
      : {}),
  };
}

function maximumSendFrom(
  value: string,
  sourceAsset: StellarWorkspaceAsset | undefined,
): string | undefined {
  if (!sourceAsset) return undefined;
  const text = normalizedText(value);
  const patterns = [
    /(?:at\s+most|spend\s+at\s+most|max(?:imum)?\s+(?:send|spend)?|do\s+not\s+spend\s+more\s+than|en\s+fazla)\s*(\d+(?:[.,]\d+)?)\s*(XLM|USDC)\b/iu,
    /(\d+(?:[.,]\d+)?)\s*(XLM|USDC)\s*(?:maximum|max|cap|tavan(?:i)?|harca)\b/iu,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match && match[2].toUpperCase() === sourceAsset) {
      return match[1].replace(",", ".");
    }
  }
  return undefined;
}

const UNSUPPORTED_STELLAR_SWAP_ASSET =
  /\b(?:KLET|ETH|WETH|ARB|AERO|EURC|BTC|CIRBTC|DAI|USDT)\b/iu;

const THIRD_PARTY_PAYOUT_PATTERN =
  /\b(?:recipient|beneficiary|someone else|another person|their bank|alici|alicinin|baskasi|baska bir kisi|onun banka)\b/iu;

const PAYOUT_DESTINATIONS: ReadonlyArray<{
  country: string;
  currency: string;
  pattern: RegExp;
}> = [
  { country: "TR", currency: "TRY", pattern: /\b(?:turkey|turkiye|turkiye'ye|turkiye'ye|turkish|try|tl)\b/iu },
  { country: "BR", currency: "BRL", pattern: /\b(?:brazil|brasil|brl)\b/iu },
  { country: "MX", currency: "MXN", pattern: /\b(?:mexico|meksika|mxn)\b/iu },
  { country: "US", currency: "USD", pattern: /\b(?:united states|usa|abd|usd)\b/iu },
  { country: "DE", currency: "EUR", pattern: /\b(?:germany|almanya|eur|euro|sepa)\b/iu },
];

function payoutFields(text: string, source: string) {
  const destination = PAYOUT_DESTINATIONS.find((entry) => entry.pattern.test(text));
  const explicitCurrency = /\b(TRY|BRL|MXN|USD|EUR)\b/iu.exec(source)?.[1]?.toUpperCase();
  const destinationCurrency = explicitCurrency || destination?.currency;
  const destinationCountry = destination?.country;
  const deliveryMethod = /\bpix\b/iu.test(text)
    ? "PIX"
    : /\bsepa\b/iu.test(text)
      ? "SEPA"
      : /\bach\b/iu.test(text)
        ? "ACH"
        : /\bswift\b/iu.test(text)
          ? "SWIFT"
          : /\b(?:iban|bank|banka|account|hesap)\b/iu.test(text)
            ? "BANK"
            : undefined;
  const sourceNetwork = /\barc(?:\s+testnet)?\b/iu.test(text)
    ? "arc_testnet"
    : /\b(?:arbitrum|arb)\s+sepolia\b/iu.test(text)
      ? "arbitrum_sepolia"
      : /\bbase\s+sepolia\b/iu.test(text)
        ? "base_sepolia"
        : "stellar_testnet";
  const amount = amountFrom(source);
  const amountMode =
    amount && destinationCurrency &&
    new RegExp(`(?:^|[^\\d])${amount.replace(".", "[.,]")}\\s*${destinationCurrency}\\b`, "iu").test(source)
      ? "receive_exact"
      : "send_exact";
  return {
    sourceNetwork,
    amount,
    amountMode,
    destinationCountry,
    destinationCurrency,
    deliveryMethod,
  } as const;
}

function resolveSwapAssets(input: string, strictReceive: boolean): {
  assetIn?: StellarWorkspaceAsset;
  assetOut?: StellarWorkspaceAsset;
} {
  const assets = mentionedAssets(input);
  const normalized = normalizedText(input);
  const buyWith =
    /\b(?:buy|satin\s+al|al)\s+(?:\d+(?:[.,]\d+)?\s+)?(XLM|USDC)\s+(?:with|using|ile)\s+(?:\d+(?:[.,]\d+)?\s+)?(XLM|USDC)\b/iu.exec(
      normalized,
    );
  if (buyWith) {
    return {
      assetIn: buyWith[2].toUpperCase() as StellarWorkspaceAsset,
      assetOut: buyWith[1].toUpperCase() as StellarWorkspaceAsset,
    };
  }
  return {
    assetIn: strictReceive ? assets[1] ?? assets[0] : assets[0],
    assetOut: strictReceive ? assets[0] ?? assets[1] : assets[1],
  };
}

/**
 * Routes ordinary Stellar requests to reviewed local surfaces. This parser does
 * not create XDR, choose a contract, or claim execution. Exact transaction
 * preparation remains in the existing network runtimes after user review.
 */
export function resolveStellarWorkspaceIntent(
  input: string,
): StellarWorkspaceIntentResolution {
  const source = input.trim();
  const text = normalizedText(source);

  if (!source) {
    return baseResolution(
      "unknown",
      "Tell Kletia the outcome",
      "Write a payment, swap, balance, privacy, or cross-chain goal.",
      "No transaction will be prepared until the goal is clear.",
      source,
    );
  }

  const paymentLanguage = /\b(?:send|pay|payment|transfer|gonder|ode|odeme|aktar)\b/u.test(text);
  const privacyLanguage = /\b(?:private|privacy|shielded|confidential|gizli|gizlilik|sakla)\b/u.test(text);
  const mentionedNetworkCount = [
    /\barc(?:\s+testnet)?\b/u,
    /\b(?:arbitrum|arb)(?:\s+sepolia)?\b/u,
    /\bbase(?:\s+mainnet)?\b/u,
    /\bstellar(?:\s+testnet)?\b/u,
  ].filter((pattern) => pattern.test(text)).length;
  const explicitCrossChainLanguage =
    /\b(?:bridge|cross[- ]?chain|cctp|kopru)\b/u.test(text);
  const crossNetworkMovement =
    /\b(?:tasi|move|transfer|send|aktar|gonder)\b/u.test(text) &&
    mentionedNetworkCount >= 2;

  const payoutLanguage =
    /\b(?:withdraw|cash[- ]?out|off[- ]?ramp|remittance|payout|bank|banka|iban|sepa|swift|pix|ach|local currency|yerel para|nakit cek)\b/u.test(
      text,
    ) ||
    (/\b(?:pay|send|transfer|gonder|ode|aktar)\b/u.test(text) &&
      /\b(?:TRY|BRL|MXN|USD|EUR)\b/iu.test(source));

  if (payoutLanguage) {
    if (THIRD_PARTY_PAYOUT_PATTERN.test(text)) {
      return baseResolution(
        "unknown",
        "Third-party payout needs a partner rail",
        "The reviewed direct-wallet MVP uses SEP-24 for withdrawal to the authenticated user's anchor flow.",
        "Use your own hosted withdrawal flow. Third-party cross-border payments stay unavailable until a bilateral SEP-31 partner integration exists.",
        source,
        {
          readyToPrepare: false,
          blockingReason: "Third-party payout is not supported by the direct SEP-24 withdrawal flow.",
        },
      );
    }
    const fields = payoutFields(text, source);
    const missingFields = [
      ...(!fields.amount ? ["amount"] : []),
      ...(!fields.destinationCountry ? ["destination country"] : []),
      ...(!fields.destinationCurrency ? ["destination currency"] : []),
      ...(!fields.deliveryMethod ? ["payout rail"] : []),
    ];
    return {
      ...baseResolution(
        "payout",
        fields.destinationCurrency
          ? `Withdraw as ${fields.destinationCurrency} through Stellar`
          : "Withdraw to a bank or local rail through Stellar",
        "Kletia uses your Stellar passkey identity to compare reviewed SEP-24 withdrawal providers and live SEP-38 prices.",
        missingFields.length === 0
          ? "Compare live routes. Bank and KYC details are collected only by the selected anchor after review."
          : "Complete the payout details below. No bank details belong in chat.",
        source,
        {
          readyToPrepare: missingFields.length === 0,
          ...(missingFields.length > 0
            ? { blockingReason: "Complete the amount, country, currency, and payout rail." }
            : {}),
        },
      ),
      ...fields,
      assetIn: "USDC",
      assetOut: undefined,
      strictReceive: fields.amountMode === "receive_exact",
      ...(missingFields.length > 0 ? { missingFields } : {}),
    };
  }

  if (explicitCrossChainLanguage || crossNetworkMovement) {
    return baseResolution(
      "unknown",
      "Continue this DeFi route from its source network",
      "Stellar is no longer inserted into unrelated DeFi workflows. Arc and Base keep ownership of their own bridge and protocol execution.",
      "Switch to the Arc or Base workspace. Use Stellar when the outcome is a bank, cash, or local-currency payout.",
      source,
      {
        readyToPrepare: false,
        blockingReason: "This is a source-network DeFi workflow, not a Stellar last-mile payment.",
      },
    );
  }

  if (privacyLanguage && paymentLanguage) {
    return baseResolution(
      "unknown",
      "Private-payment labs are outside the payment MVP",
      "Kletia's default Stellar product now focuses on passkey identity, live FX, and real last-mile payout evidence.",
      "Use a public reviewed payout route, or open the research build separately when private-payment testing is explicitly required.",
      source,
      {
        readyToPrepare: false,
        blockingReason: "The research privacy pool is not part of the default Payment Center.",
      },
    );
  }

  if (/\b(?:trustline|trust line|guven hatti|usdc kabul|receive usdc)\b/u.test(text)) {
    return baseResolution(
      "trustline",
      "Enable reviewed USDC",
      "A Stellar trustline lets this account hold the exact reviewed Circle Testnet USDC asset.",
      "Connect Freighter, verify the issuer, then review and sign the trustline.",
      source,
    );
  }

  if (/\b(?:swap|exchange|convert|trade|buy|sell|takas|degistir|cevir|sat|satin\s+al|al|alsin|harca)\b/u.test(text)) {
    const base = baseResolution(
      "swap",
      "Compare a Stellar swap",
      "Kletia will request a fresh SDEX route and keep comparison-only providers separate.",
      "Review the exact send or receive bound before Freighter signs.",
      source,
    );
    const unsupported = source.match(UNSUPPORTED_STELLAR_SWAP_ASSET)?.[0];
    if (unsupported) {
      return {
        ...base,
        kind: "unknown",
        title: `${unsupported.toUpperCase()} is not on the reviewed Stellar swap surface`,
        summary:
          "The live Stellar MVP swap adapter supports only XLM and the exact Circle Testnet USDC issuer.",
        nextStep: "Choose XLM → USDC or USDC → XLM. Kletia will not substitute a different asset.",
        readyToPrepare: false,
        blockingReason: `Unsupported Stellar swap asset: ${unsupported.toUpperCase()}.`,
      };
    }
    const assets = resolveSwapAssets(source, base.strictReceive);
    if (
      !assets.assetIn ||
      !assets.assetOut ||
      assets.assetIn === assets.assetOut ||
      !([assets.assetIn, assets.assetOut].every(
        (asset) => asset === "XLM" || asset === "USDC",
      ))
    ) {
      return {
        ...base,
        assetIn: assets.assetIn,
        assetOut: assets.assetOut,
        readyToPrepare: false,
        blockingReason: "Choose both sides of the reviewed XLM/USDC pair.",
        nextStep: "Say XLM → USDC or USDC → XLM and include an amount.",
      };
    }
    const maximumSend = maximumSendFrom(source, assets.assetIn);
    const missingFields = [
      ...(!base.amount ? ["amount"] : []),
    ];
    return {
      ...base,
      ...assets,
      ...(maximumSend ? { maximumSend } : {}),
      readyToPrepare: missingFields.length === 0,
      ...(missingFields.length > 0
        ? {
            missingFields,
            blockingReason: "Enter the amount to compare a live Stellar route.",
            nextStep: "Complete the amount below, then compare live routes.",
          }
        : {}),
    };
  }

  if (paymentLanguage) {
    const base = baseResolution(
      "transfer",
      "Prepare a Stellar payment",
      "Kletia will validate the destination, asset identity, balance, and trustline before signing.",
      "Review the populated payment form; sending still requires Freighter approval.",
      source,
    );
    if (base.assetIn === "EURC") {
      return {
        ...base,
        kind: "unknown",
        readyToPrepare: false,
        blockingReason: "Direct Stellar payments currently support XLM and reviewed Circle Testnet USDC; EURC is limited to the separate private-payment research surface.",
        nextStep: "Choose XLM or USDC, or explicitly open a private EURC payment.",
      };
    }
    const missingFields = [
      ...(!base.amount ? ["amount"] : []),
      ...(!base.assetIn ? ["asset"] : []),
      ...(!base.recipient ? ["recipient"] : []),
    ];
    return {
      ...base,
      readyToPrepare: missingFields.length === 0,
      ...(missingFields.length > 0
        ? {
            missingFields,
            blockingReason: "Complete the amount, asset, and destination below.",
            nextStep: "Fill the missing payment fields; no AI interpretation is needed.",
          }
        : {}),
    };
  }

  if (/\b(?:portfolio|balance|balances|holdings|bakiye|bakiyem|portfoy|varlik)\b/u.test(text)) {
    return baseResolution(
      "portfolio",
      "Read your Stellar balances",
      "Kletia will read live XLM and reviewed Circle Testnet USDC balances from Horizon.",
      "Connect Freighter to load the account; no transaction is created.",
      source,
    );
  }

  return baseResolution(
    "unknown",
    "This goal needs one detail",
    "Kletia could not safely map the sentence to a reviewed Stellar action.",
    "Try: withdraw 100 TRY to my bank account, show balances, send USDC, or swap XLM to USDC.",
    source,
  );
}
