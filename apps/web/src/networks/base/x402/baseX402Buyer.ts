import {
  decodePaymentResponseHeader,
  x402Client,
  x402HTTPClient,
  type PaymentPayload,
  type PaymentRequirements,
} from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import {
  decodeEventLog,
  getAddress,
  isAddress,
  type Address,
  type Hex,
  type TransactionReceipt,
} from "viem";

import type { BaseX402ChallengeEvidence } from "../../../types";

const BASE_CHAIN_ID = 8_453 as const;
const BASE_CAIP_NETWORK = "eip155:8453";
const BASE_USDC = getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
const X402_PROTOCOL_VERSION = 2;
const MAX_PAYMENT_TIMEOUT_SECONDS = 300;

const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

const ERC20_TRANSFER_EVENT_ABI = [
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: "from", type: "address" },
      { indexed: true, name: "to", type: "address" },
      { indexed: false, name: "value", type: "uint256" },
    ],
    name: "Transfer",
    type: "event",
  },
] as const;
const USDC_AUTHORIZATION_USED_EVENT_ABI = [
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: "authorizer", type: "address" },
      { indexed: true, name: "nonce", type: "bytes32" },
    ],
    name: "AuthorizationUsed",
    type: "event",
  },
] as const;

type ExactTypedDataRequest = {
  domain: Record<string, unknown>;
  types: Record<string, unknown>;
  primaryType: string;
  message: Record<string, unknown>;
};

type SignExactTypedData = (parameters: {
  domain: {
    name: "USD Coin";
    version: "2";
    chainId: typeof BASE_CHAIN_ID;
    verifyingContract: Address;
  };
  types: typeof EIP3009_TYPES;
  primaryType: "TransferWithAuthorization";
  message: {
    from: Address;
    to: Address;
    value: bigint;
    validAfter: bigint;
    validBefore: bigint;
    nonce: Hex;
  };
}) => Promise<Hex>;

type PaymentContext = {
  readonly client: x402Client;
  readonly httpClient: x402HTTPClient;
  readonly payload: PaymentPayload;
  readonly paymentSignature: string;
  readonly expectedAccount: Address;
  readonly evidence: BaseX402ChallengeEvidence;
  readonly authorizationNonce: Hex;
};

export type VerifiedBaseX402Settlement = {
  readonly transaction: Hex;
  readonly payer: Address;
  readonly network: typeof BASE_CAIP_NETWORK;
  readonly amountAtomic: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requiredAddress = (value: unknown, label: string): Address => {
  if (typeof value !== "string" || !isAddress(value)) {
    throw new Error(`x402 ${label} alanı geçerli bir EVM adresi değil.`);
  }
  return getAddress(value);
};

export function assertBaseX402PaymentRequirement(
  requirement: PaymentRequirements,
  evidence: BaseX402ChallengeEvidence,
): PaymentRequirements {
  if (
    requirement.scheme !== "exact" ||
    requirement.network !== BASE_CAIP_NETWORK ||
    requiredAddress(requirement.asset, "asset") !== BASE_USDC ||
    requiredAddress(requirement.payTo, "payTo") !==
      getAddress(evidence.payTo) ||
    !/^(?:0|[1-9]\d*)$/u.test(requirement.amount) ||
    requirement.amount !== evidence.amountAtomic ||
    BigInt(requirement.amount) <= 0n ||
    BigInt(requirement.amount) > BigInt(evidence.amountAtomic) ||
    !Number.isSafeInteger(requirement.maxTimeoutSeconds) ||
    requirement.maxTimeoutSeconds <= 0 ||
    requirement.maxTimeoutSeconds > MAX_PAYMENT_TIMEOUT_SECONDS
  ) {
    throw new Error(
      "x402 ödeme gereksinimi ekranda doğrulanan Base/USDC/tutar/alıcı politikasıyla eşleşmiyor.",
    );
  }

  const extra = requirement.extra;
  if (
    !isRecord(extra) ||
    extra.name !== "USD Coin" ||
    extra.version !== "2" ||
    (extra.assetTransferMethod !== undefined &&
      extra.assetTransferMethod !== "eip3009")
  ) {
    throw new Error("x402 Base USDC EIP-3009 alanı onaylı değil.");
  }
  return requirement;
}

function validateExactAuthorization(
  parameters: ExactTypedDataRequest,
  expectedAccount: Address,
  evidence: BaseX402ChallengeEvidence,
) {
  const transferFields = parameters.types.TransferWithAuthorization;
  const domain = parameters.domain;
  const message = parameters.message;
  const expectedPayTo = getAddress(evidence.payTo);
  const expectedAmount = BigInt(evidence.amountAtomic);

  if (
    parameters.primaryType !== "TransferWithAuthorization" ||
    domain.name !== "USD Coin" ||
    domain.version !== "2" ||
    Number(domain.chainId) !== BASE_CHAIN_ID ||
    requiredAddress(domain.verifyingContract, "verifyingContract") !==
      BASE_USDC ||
    !Array.isArray(transferFields) ||
    transferFields
      .map((field) => (isRecord(field) ? `${field.name}:${field.type}` : ""))
      .join(",") !==
      "from:address,to:address,value:uint256,validAfter:uint256,validBefore:uint256,nonce:bytes32" ||
    requiredAddress(message.from, "from") !== expectedAccount ||
    requiredAddress(message.to, "to") !== expectedPayTo ||
    !/^(?:0|[1-9]\d*)$/u.test(String(message.value)) ||
    BigInt(String(message.value)) !== expectedAmount
  ) {
    throw new Error(
      "Cüzdanın imzalaması istenen EIP-3009 yetkilendirmesi doğrulanmış x402 planından farklı.",
    );
  }

  const now = BigInt(Math.floor(Date.now() / 1_000));
  const validAfter = BigInt(String(message.validAfter));
  const validBefore = BigInt(String(message.validBefore));
  const nonce = String(message.nonce || "");
  const declaredTimeout = BigInt(
    Math.min(
      evidence.maxTimeoutSeconds || MAX_PAYMENT_TIMEOUT_SECONDS,
      MAX_PAYMENT_TIMEOUT_SECONDS,
    ),
  );
  if (
    validAfter > now ||
    validBefore <= now ||
    validBefore > now + declaredTimeout + 30n ||
    !/^0x[0-9a-fA-F]{64}$/u.test(nonce)
  ) {
    throw new Error(
      "x402 EIP-3009 nonce veya yetkilendirme zaman aralığı geçersiz.",
    );
  }

  return {
    domain: {
      name: "USD Coin" as const,
      version: "2" as const,
      chainId: BASE_CHAIN_ID,
      verifyingContract: BASE_USDC,
    },
    types: EIP3009_TYPES,
    primaryType: "TransferWithAuthorization" as const,
    message: {
      from: expectedAccount,
      to: expectedPayTo,
      value: expectedAmount,
      validAfter,
      validBefore,
      nonce: nonce as Hex,
    },
  };
}

export async function createBaseX402PaymentAuthorization(input: {
  readonly getUnpaidHeader: (name: string) => string | null;
  readonly evidence: BaseX402ChallengeEvidence;
  readonly expectedAccount: Address;
  readonly assertWalletContext: () => void;
  readonly signTypedData: SignExactTypedData;
}): Promise<PaymentContext> {
  input.assertWalletContext();
  let authorizationNonce: Hex | null = null;
  const signer = {
    address: input.expectedAccount,
    signTypedData: async (parameters: ExactTypedDataRequest) => {
      input.assertWalletContext();
      const validated = validateExactAuthorization(
        parameters,
        input.expectedAccount,
        input.evidence,
      );
      const signature = await input.signTypedData(validated);
      authorizationNonce = validated.message.nonce;
      input.assertWalletContext();
      return signature;
    },
  };

  const client = x402Client.fromConfig({
    schemes: [
      {
        network: BASE_CAIP_NETWORK,
        client: new ExactEvmScheme(signer),
      },
    ],
    paymentRequirementsSelector: (version, requirements) => {
      if (version !== X402_PROTOCOL_VERSION || requirements.length !== 1) {
        throw new Error(
          "x402 sunucusu tek ve doğrulanabilir bir v2 ödeme seçeneği sunmadı.",
        );
      }
      return assertBaseX402PaymentRequirement(requirements[0], input.evidence);
    },
  });
  const httpClient = new x402HTTPClient(client);
  const paymentRequired = httpClient.getPaymentRequiredResponse(
    input.getUnpaidHeader,
  );
  if (
    paymentRequired.x402Version !== X402_PROTOCOL_VERSION ||
    paymentRequired.error ||
    paymentRequired.accepts.length !== 1 ||
    paymentRequired.resource.url !== input.evidence.resourceUrl
  ) {
    throw new Error(
      paymentRequired.error ||
        "x402 challenge kaynağı doğrulanan URL ile eşleşmiyor.",
    );
  }
  assertBaseX402PaymentRequirement(paymentRequired.accepts[0], input.evidence);

  const payload = await client.createPaymentPayload(paymentRequired);
  input.assertWalletContext();
  if (
    payload.x402Version !== X402_PROTOCOL_VERSION ||
    !("accepted" in payload) ||
    !payload.accepted
  ) {
    throw new Error("x402 istemcisi geçerli bir v2 ödeme payloadı üretmedi.");
  }
  assertBaseX402PaymentRequirement(payload.accepted, input.evidence);
  const encoded = httpClient.encodePaymentSignatureHeader(payload);
  const paymentSignature = encoded["PAYMENT-SIGNATURE"];
  if (
    typeof paymentSignature !== "string" ||
    paymentSignature.length < 32 ||
    paymentSignature.length > 32_768
  ) {
    throw new Error("x402 ödeme imzası güvenli boyut sınırında üretilemedi.");
  }
  if (!authorizationNonce) {
    throw new Error("x402 EIP-3009 authorization nonce üretilemedi.");
  }

  return {
    client,
    httpClient,
    payload,
    paymentSignature,
    expectedAccount: input.expectedAccount,
    evidence: input.evidence,
    authorizationNonce,
  };
}

export async function verifyBaseX402PaymentResult(input: {
  readonly context: PaymentContext;
  readonly getPaidHeader: (name: string) => string | null;
  readonly status: number;
}): Promise<VerifiedBaseX402Settlement> {
  const processed = await input.context.httpClient.processPaymentResult(
    input.context.payload,
    input.getPaidHeader,
    input.status,
  );
  if (processed.recovered) {
    throw new Error(
      "x402 kanalı ikinci bir imza istedi; otomatik yeniden ödeme kapalıdır.",
    );
  }
  const rawSettlement =
    input.getPaidHeader("PAYMENT-RESPONSE") ||
    input.getPaidHeader("X-PAYMENT-RESPONSE");
  if (!rawSettlement) {
    throw new Error(
      "Ücretli yanıt x402 settlement kanıtı içermiyor; veri kabul edilmedi.",
    );
  }
  const settlement = decodePaymentResponseHeader(rawSettlement);
  const transaction = String(settlement.transaction || "");
  const payer = requiredAddress(settlement.payer, "settlement payer");
  if (
    settlement.success !== true ||
    settlement.network !== BASE_CAIP_NETWORK ||
    payer !== input.context.expectedAccount ||
    (settlement.amount !== undefined &&
      String(settlement.amount) !== input.context.evidence.amountAtomic) ||
    !/^0x[0-9a-fA-F]{64}$/u.test(transaction) ||
    /^0x0{64}$/iu.test(transaction)
  ) {
    throw new Error(
      settlement.errorMessage ||
        settlement.errorReason ||
        "x402 settlement ağ, ödeyen, tutar veya işlem kanıtı doğrulanamadı.",
    );
  }
  return {
    transaction: transaction as Hex,
    payer,
    network: BASE_CAIP_NETWORK,
    amountAtomic: input.context.evidence.amountAtomic,
  };
}

export function assertBaseX402SettlementReceipt(input: {
  readonly receipt: TransactionReceipt;
  readonly payer: Address;
  readonly evidence: BaseX402ChallengeEvidence;
  readonly authorizationNonce: Hex;
}): void {
  if (
    input.receipt.status !== "success" ||
    !input.receipt.to ||
    getAddress(input.receipt.to) !== BASE_USDC
  ) {
    throw new Error(
      "x402 settlement işlemi Base USDC üzerinde başarılı olarak doğrulanamadı.",
    );
  }
  const expectedPayTo = getAddress(input.evidence.payTo);
  const expectedAmount = BigInt(input.evidence.amountAtomic);
  const exactTransfer = input.receipt.logs.some((log) => {
    if (getAddress(log.address) !== BASE_USDC) return false;
    try {
      const decoded = decodeEventLog({
        abi: ERC20_TRANSFER_EVENT_ABI,
        data: log.data,
        topics: log.topics,
      });
      return (
        decoded.eventName === "Transfer" &&
        getAddress(decoded.args.from) === input.payer &&
        getAddress(decoded.args.to) === expectedPayTo &&
        decoded.args.value === expectedAmount
      );
    } catch {
      return false;
    }
  });
  const exactAuthorizationUsed = input.receipt.logs.some((log) => {
    if (getAddress(log.address) !== BASE_USDC) return false;
    try {
      const decoded = decodeEventLog({
        abi: USDC_AUTHORIZATION_USED_EVENT_ABI,
        data: log.data,
        topics: log.topics,
      });
      return (
        decoded.eventName === "AuthorizationUsed" &&
        getAddress(decoded.args.authorizer) === input.payer &&
        decoded.args.nonce.toLowerCase() ===
          input.authorizationNonce.toLowerCase()
      );
    } catch {
      return false;
    }
  });
  if (!exactTransfer || !exactAuthorizationUsed) {
    throw new Error(
      "Base makbuzu, bu imzanın nonce değerini ve gösterilen alıcıya giden tam USDC tutarını birlikte kanıtlamıyor.",
    );
  }
}
