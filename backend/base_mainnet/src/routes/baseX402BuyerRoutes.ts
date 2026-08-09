import { randomBytes } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import {
  decodePaymentResponseHeader,
  decodePaymentSignatureHeader,
} from '@x402/core/http';
import { parsePaymentPayload } from '@x402/core/schemas';
import {
  getAddress,
  hashTypedData,
  isAddress,
  isErc6492Signature,
  parseErc6492Signature,
  verifyTypedData,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem';
import { z } from 'zod';
import { TOKENS } from '../config/constants.js';
import { NETWORKS, basePublicClient } from '../config/networks.js';
import {
  BaseX402IntentError,
  forwardPinnedBaseX402BuyerPayment,
  prepareBaseX402BuyerChallenge,
  type BaseX402BuyerPaymentRequirement,
  type BaseX402ChallengeEvidence,
  type BaseX402BuyerUpstreamResponse,
} from '../intent/baseX402.js';
import {
  RequestIdValidationError,
  resolveIntentRequestId,
} from '../security/requestId.js';

const router = Router();

const BASE_CAIP_NETWORK = `eip155:${NETWORKS.base.chainId}` as const;
const SESSION_TTL_MS = 5 * 60 * 1_000;
const MAX_SESSIONS = 512;
const MAX_SIGNATURE_HEADER_BYTES = 32_768;
const MAX_SIGNATURE_BYTES = 8_192;
const MAX_PAYMENT_RESPONSE_HEADER_BYTES = 32_768;
const MAX_JSON_NODES = 20_000;
const MAX_JSON_DEPTH = 32;
const SIGNATURE_RPC_TIMEOUT_MS = 5_000;
const MAX_SIGNATURE_ATTEMPTS = 3;
const CLOCK_SKEW_SECONDS = 30n;
const VALID_BEFORE_SAFETY_SECONDS = 6n;
const SESSION_ID_PATTERN =
  /^[0-9a-f]{64}$/u;
const UINT_STRING_PATTERN = /^(?:0|[1-9]\d*)$/u;
const BYTES32_PATTERN = /^0x[0-9a-fA-F]{64}$/u;
const TRANSACTION_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/u;
const BASE_ACCOUNT_FACTORY = getAddress(
  '0xba5ed110efdba3d005bfc882d75358acbbb85842',
);

const ERC1271_ABI = [
  {
    name: 'isValidSignature',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'hash', type: 'bytes32' },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [{ name: '', type: 'bytes4' }],
  },
] as const;

const authorizationTypes = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

const paymentPayloadSchema = z
  .object({
    x402Version: z.literal(2),
    accepted: z
      .object({
        scheme: z.literal('exact'),
        network: z.literal(BASE_CAIP_NETWORK),
        amount: z.string(),
        asset: z.string(),
        payTo: z.string(),
        maxTimeoutSeconds: z.number().int().positive().max(300),
        extra: z.record(z.unknown()),
      })
      .passthrough(),
    resource: z
      .object({
        url: z.string(),
      })
      .passthrough(),
    payload: z
      .object({
        authorization: z
          .object({
            from: z.string(),
            to: z.string(),
            value: z.string(),
            validAfter: z.string(),
            validBefore: z.string(),
            nonce: z.string(),
          })
          .strict(),
        signature: z.string(),
      })
      .strict(),
    extensions: z.record(z.unknown()).nullish(),
  })
  .passthrough();

const settlementSchema = z
  .object({
    success: z.literal(true),
    network: z.literal(BASE_CAIP_NETWORK),
    payer: z.string(),
    transaction: z.string(),
    amount: z.string().optional(),
  })
  .passthrough();

type SessionState =
  | 'prepared'
  | 'verifying'
  | 'submitting'
  | 'settled'
  | 'rejected'
  | 'indeterminate';

interface BaseX402BuyerSession {
  readonly sessionId: string;
  readonly requestId: string;
  readonly userAddress: Address;
  readonly url: string;
  readonly maxPayment: string;
  readonly paymentRequiredHeader: string;
  readonly paymentRequired: Readonly<Record<string, unknown>>;
  readonly accepted: BaseX402BuyerPaymentRequirement;
  readonly evidence: BaseX402ChallengeEvidence;
  readonly createdAt: number;
  readonly expiresAt: number;
  signatureAttempts: number;
  state: SessionState;
  settlement?: {
    readonly payer: Address;
    readonly transaction: Hex;
    readonly amount: string;
    readonly network: typeof BASE_CAIP_NETWORK;
  };
}

interface VerifiedBuyerPayment {
  readonly authorization: {
    readonly from: Address;
    readonly to: Address;
    readonly value: string;
    readonly validAfter: string;
    readonly validBefore: string;
    readonly nonce: Hex;
  };
  readonly signature: Hex;
}

class BaseX402BuyerRouteError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = 'BaseX402BuyerRouteError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const sessions = new Map<string, BaseX402BuyerSession>();
const preparingRequestIds = new Set<string>();

function cleanupSessions(now = Date.now()): void {
  for (const [sessionId, session] of sessions) {
    if (
      session.expiresAt <= now &&
      session.state !== 'verifying' &&
      session.state !== 'submitting'
    ) {
      sessions.delete(sessionId);
    }
  }
}

function requestIdFrom(value: unknown): string {
  if (value === undefined) {
    throw new BaseX402BuyerRouteError(
      'REQUEST_ID_REQUIRED',
      'requestId zorunludur.',
    );
  }
  return resolveIntentRequestId(value, undefined, () => {
    throw new BaseX402BuyerRouteError(
      'REQUEST_ID_REQUIRED',
      'requestId zorunludur.',
    );
  });
}

function walletFrom(value: unknown): Address {
  if (typeof value !== 'string' || !isAddress(value)) {
    throw new BaseX402BuyerRouteError(
      'X402_BUYER_WALLET_INVALID',
      'wallet geçerli, sıfır olmayan bir EVM adresi olmalıdır.',
    );
  }
  const wallet = getAddress(value);
  if (wallet === zeroAddress) {
    throw new BaseX402BuyerRouteError(
      'X402_BUYER_WALLET_INVALID',
      'wallet geçerli, sıfır olmayan bir EVM adresi olmalıdır.',
    );
  }
  return wallet;
}

function singleHeader(req: Request, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  if (value === undefined) return undefined;
  if (Array.isArray(value)) {
    if (value.length !== 1) {
      throw new BaseX402BuyerRouteError(
        'X402_BUYER_HEADER_AMBIGUOUS',
        `${name} başlığı yalnız bir kez gönderilmelidir.`,
      );
    }
    return value[0];
  }
  return value;
}

function upstreamScalarHeader(
  response: BaseX402BuyerUpstreamResponse,
  name: string,
): string | undefined {
  const value = response.headers[name.toLowerCase()];
  if (value === undefined) return undefined;
  if (Array.isArray(value)) {
    if (value.length !== 1) return undefined;
    return value[0];
  }
  return value;
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new BaseX402BuyerRouteError(
        'X402_PAYMENT_PAYLOAD_INVALID',
        'PAYMENT-SIGNATURE sonlu olmayan sayı içeremez.',
      );
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson(record[key])}`,
      )
      .join(',')}}`;
  }
  throw new BaseX402BuyerRouteError(
    'X402_PAYMENT_PAYLOAD_INVALID',
    'PAYMENT-SIGNATURE desteklenmeyen bir değer içeriyor.',
  );
}

function exactRequirementMatches(
  candidate: z.infer<typeof paymentPayloadSchema>['accepted'],
  stored: BaseX402BuyerPaymentRequirement,
): boolean {
  try {
    return (
      candidate.scheme === stored.scheme &&
      candidate.network === stored.network &&
      candidate.amount === stored.amount &&
      candidate.maxTimeoutSeconds === stored.maxTimeoutSeconds &&
      getAddress(candidate.asset) === getAddress(stored.asset) &&
      getAddress(candidate.payTo) === getAddress(stored.payTo) &&
      canonicalJson(candidate.extra) === canonicalJson(stored.extra)
    );
  } catch {
    return false;
  }
}

function sessionIdentity(session: BaseX402BuyerSession) {
  return {
    network: 'base' as const,
    chainId: NETWORKS.base.chainId,
    requestId: session.requestId,
    userAddress: session.userAddress,
    sessionId: session.sessionId,
  };
}

function sessionEnvelope(session: BaseX402BuyerSession) {
  return {
    success: true,
    ...sessionIdentity(session),
    relayPath: `/api/base/x402-buyer/session/${session.sessionId}`,
    evidence: session.evidence,
    expiresAt: new Date(session.expiresAt).toISOString(),
  };
}

function bindSessionRequestId(
  req: Request,
  session: BaseX402BuyerSession,
): void {
  const requestId = requestIdFrom(singleHeader(req, 'X-Request-Id'));
  if (requestId !== session.requestId) {
    throw new BaseX402BuyerRouteError(
      'X402_BUYER_REQUEST_ID_MISMATCH',
      'X-Request-Id aktif x402 buyer oturumuyla eşleşmiyor.',
      409,
    );
  }
}

function sessionByRequestId(
  requestId: string,
): BaseX402BuyerSession | undefined {
  for (const session of sessions.values()) {
    if (session.requestId === requestId) return session;
  }
  return undefined;
}

function safeSession(
  rawSessionId: unknown,
): BaseX402BuyerSession {
  if (
    typeof rawSessionId !== 'string' ||
    !SESSION_ID_PATTERN.test(rawSessionId)
  ) {
    throw new BaseX402BuyerRouteError(
      'X402_BUYER_SESSION_NOT_FOUND',
      'x402 buyer oturumu bulunamadı veya süresi doldu.',
      404,
    );
  }
  cleanupSessions();
  const session = sessions.get(rawSessionId);
  if (!session) {
    throw new BaseX402BuyerRouteError(
      'X402_BUYER_SESSION_NOT_FOUND',
      'x402 buyer oturumu bulunamadı veya süresi doldu.',
      404,
    );
  }
  return session;
}

function parsePaymentSignatureHeader(
  header: string,
  session: BaseX402BuyerSession,
): VerifiedBuyerPayment {
  if (
    header.length < 4 ||
    header.length > MAX_SIGNATURE_HEADER_BYTES ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(header)
  ) {
    throw new BaseX402BuyerRouteError(
      'X402_PAYMENT_SIGNATURE_INVALID',
      'PAYMENT-SIGNATURE geçersiz veya güvenli boyut sınırının dışında.',
    );
  }

  let decoded: unknown;
  try {
    decoded = decodePaymentSignatureHeader(header);
  } catch {
    throw new BaseX402BuyerRouteError(
      'X402_PAYMENT_SIGNATURE_INVALID',
      'PAYMENT-SIGNATURE çözümlenemedi.',
    );
  }
  if (!parsePaymentPayload(decoded).success) {
    throw new BaseX402BuyerRouteError(
      'X402_PAYMENT_PAYLOAD_INVALID',
      'PAYMENT-SIGNATURE geçerli bir x402 v2 ödeme yükü içermiyor.',
    );
  }
  const parsed = paymentPayloadSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new BaseX402BuyerRouteError(
      'X402_PAYMENT_PAYLOAD_INVALID',
      'PAYMENT-SIGNATURE yalnız Base USDC EIP-3009 exact yükünü içermelidir.',
    );
  }
  const payment = parsed.data;
  if (!exactRequirementMatches(payment.accepted, session.accepted)) {
    throw new BaseX402BuyerRouteError(
      'X402_PAYMENT_REQUIREMENT_MISMATCH',
      'PAYMENT-SIGNATURE aktif oturumdaki exact ödeme gereksinimiyle eşleşmiyor.',
      409,
    );
  }
  const storedResource = session.paymentRequired.resource;
  const storedExtensions = session.paymentRequired.extensions;
  if (
    canonicalJson(payment.resource) !== canonicalJson(storedResource) ||
    canonicalJson(payment.extensions) !== canonicalJson(storedExtensions)
  ) {
    throw new BaseX402BuyerRouteError(
      'X402_PAYMENT_CHALLENGE_MISMATCH',
      'PAYMENT-SIGNATURE aktif oturumun PAYMENT-REQUIRED kanıtıyla eşleşmiyor.',
      409,
    );
  }

  const authorization = payment.payload.authorization;
  let from: Address;
  let to: Address;
  try {
    from = getAddress(authorization.from);
    to = getAddress(authorization.to);
  } catch {
    throw new BaseX402BuyerRouteError(
      'X402_PAYMENT_AUTHORIZATION_INVALID',
      'EIP-3009 yetkilendirme adresleri geçersiz.',
    );
  }
  if (
    from !== session.userAddress ||
    to !== getAddress(session.accepted.payTo) ||
    authorization.value !== session.accepted.amount
  ) {
    throw new BaseX402BuyerRouteError(
      'X402_PAYMENT_AUTHORIZATION_MISMATCH',
      'EIP-3009 payer, alıcı veya tutar aktif oturumla eşleşmiyor.',
      409,
    );
  }
  if (
    !UINT_STRING_PATTERN.test(authorization.validAfter) ||
    !UINT_STRING_PATTERN.test(authorization.validBefore) ||
    authorization.validAfter !== '0' ||
    !BYTES32_PATTERN.test(authorization.nonce) ||
    /^0x0{64}$/iu.test(authorization.nonce)
  ) {
    throw new BaseX402BuyerRouteError(
      'X402_PAYMENT_AUTHORIZATION_INVALID',
      'EIP-3009 nonce veya geçerlilik aralığı geçersiz.',
    );
  }
  const now = BigInt(Math.floor(Date.now() / 1_000));
  const validBefore = BigInt(authorization.validBefore);
  if (
    validBefore < now + VALID_BEFORE_SAFETY_SECONDS ||
    validBefore >
      now +
        BigInt(session.accepted.maxTimeoutSeconds) +
        CLOCK_SKEW_SECONDS
  ) {
    throw new BaseX402BuyerRouteError(
      'X402_PAYMENT_AUTHORIZATION_EXPIRED',
      'EIP-3009 yetkilendirme süresi aktif challenge sınırları içinde değil.',
    );
  }
  const signature = payment.payload.signature;
  if (
    !/^0x[0-9a-fA-F]+$/u.test(signature) ||
    (signature.length - 2) % 2 !== 0 ||
    (signature.length - 2) / 2 < 1 ||
    (signature.length - 2) / 2 > MAX_SIGNATURE_BYTES
  ) {
    throw new BaseX402BuyerRouteError(
      'X402_PAYMENT_SIGNATURE_INVALID',
      'EIP-3009 imzası geçersiz veya güvenli boyut sınırının dışında.',
    );
  }

  return {
    authorization: {
      from,
      to,
      value: authorization.value,
      validAfter: authorization.validAfter,
      validBefore: authorization.validBefore,
      nonce: authorization.nonce as Hex,
    },
    signature: signature as Hex,
  };
}

function typedDataFor(
  session: BaseX402BuyerSession,
  payment: VerifiedBuyerPayment,
) {
  return {
    address: session.userAddress,
    domain: {
      name: 'USD Coin',
      version: '2',
      chainId: NETWORKS.base.chainId,
      verifyingContract: getAddress(TOKENS.USDC),
    },
    types: authorizationTypes,
    primaryType: 'TransferWithAuthorization' as const,
    message: {
      from: payment.authorization.from,
      to: payment.authorization.to,
      value: BigInt(payment.authorization.value),
      validAfter: BigInt(payment.authorization.validAfter),
      validBefore: BigInt(payment.authorization.validBefore),
      nonce: payment.authorization.nonce,
    },
    signature: payment.signature,
  };
}

async function withSignatureDeadline<T>(promise: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new BaseX402BuyerRouteError(
                'X402_SIGNATURE_VERIFICATION_TIMEOUT',
                'Cüzdan imzası Base üzerinde zamanında doğrulanamadı.',
                504,
              ),
            ),
          SIGNATURE_RPC_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function verifyBuyerSignature(
  session: BaseX402BuyerSession,
  payment: VerifiedBuyerPayment,
): Promise<boolean> {
  const typedData = typedDataFor(session, payment);
  try {
    return await withSignatureDeadline(
      (async () => {
        if (isErc6492Signature(payment.signature)) {
          let wrapped: ReturnType<typeof parseErc6492Signature>;
          try {
            wrapped = parseErc6492Signature(payment.signature);
          } catch {
            return false;
          }
          if (
            !wrapped.address ||
            getAddress(wrapped.address) !== BASE_ACCOUNT_FACTORY
          ) {
            return false;
          }

          return basePublicClient.verifyTypedData(typedData);
        }

        try {
          if (await verifyTypedData(typedData)) return true;
        } catch {

        }
        const code = await basePublicClient.getBytecode({
          address: session.userAddress,
        });
        if (code && code !== '0x') {
          const digest = hashTypedData({
            domain: typedData.domain,
            types: typedData.types,
            primaryType: typedData.primaryType,
            message: typedData.message,
          });
          const result = await basePublicClient.readContract({
            address: session.userAddress,
            abi: ERC1271_ABI,
            functionName: 'isValidSignature',
            args: [digest, payment.signature],
          });
          return (
            typeof result === 'string' &&
            result.toLowerCase().startsWith('0x1626ba7e')
          );
        }
        return false;
      })(),
    );
  } catch (error) {
    if (error instanceof BaseX402BuyerRouteError) throw error;
    throw new BaseX402BuyerRouteError(
      'X402_SIGNATURE_VERIFICATION_UNAVAILABLE',
      'Cüzdan imzası Base üzerinde doğrulanamadı.',
      502,
    );
  }
}

function paymentResponseHeader(
  upstream: BaseX402BuyerUpstreamResponse,
): string {
  const primary = upstreamScalarHeader(upstream, 'payment-response');
  const legacy = upstreamScalarHeader(upstream, 'x-payment-response');
  if (primary && legacy && primary !== legacy) {
    throw new BaseX402BuyerRouteError(
      'X402_PAYMENT_RESPONSE_AMBIGUOUS',
      'Üst servis birbiriyle çelişen ödeme sonuçları döndürdü.',
      502,
    );
  }
  const value = primary || legacy;
  if (
    !value ||
    value.length < 4 ||
    value.length > MAX_PAYMENT_RESPONSE_HEADER_BYTES ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)
  ) {
    throw new BaseX402BuyerRouteError(
      'X402_PAYMENT_RESPONSE_MISSING',
      'Ücretli çağrının PAYMENT-RESPONSE sonucu doğrulanamadı.',
      502,
    );
  }
  return value;
}

function validateSettlement(
  header: string,
  session: BaseX402BuyerSession,
) {
  let decoded: unknown;
  try {
    decoded = decodePaymentResponseHeader(header);
  } catch {
    throw new BaseX402BuyerRouteError(
      'X402_PAYMENT_RESPONSE_INVALID',
      'Ücretli çağrının PAYMENT-RESPONSE zarfı geçersiz.',
      502,
    );
  }
  const parsed = settlementSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new BaseX402BuyerRouteError(
      'X402_PAYMENT_RESPONSE_INVALID',
      'Ücretli çağrı doğrulanabilir bir başarılı settlement sonucu döndürmedi.',
      502,
    );
  }
  const settlement = parsed.data;
  let payer: Address;
  try {
    payer = getAddress(settlement.payer);
  } catch {
    throw new BaseX402BuyerRouteError(
      'X402_PAYMENT_RESPONSE_INVALID',
      'Settlement payer adresi geçersiz.',
      502,
    );
  }
  if (
    payer !== session.userAddress ||
    !TRANSACTION_HASH_PATTERN.test(settlement.transaction) ||
    /^0x0{64}$/iu.test(settlement.transaction) ||
    (settlement.amount !== undefined &&
      settlement.amount !== session.accepted.amount)
  ) {
    throw new BaseX402BuyerRouteError(
      'X402_PAYMENT_RESPONSE_MISMATCH',
      'Settlement sonucu aktif payer, ağ veya tutarla eşleşmiyor.',
      502,
    );
  }
  return {
    payer,
    transaction: settlement.transaction as Hex,
    amount: settlement.amount || session.accepted.amount,
    network: BASE_CAIP_NETWORK,
  };
}

function safeContentType(
  upstream: BaseX402BuyerUpstreamResponse,
): string {
  const contentType = upstreamScalarHeader(upstream, 'content-type');
  if (
    !contentType ||
    contentType.length > 200 ||
    /[\r\n]/u.test(contentType)
  ) {
    throw new BaseX402BuyerRouteError(
      'X402_PAID_CONTENT_TYPE_INVALID',
      'Ücretli x402 yanıtı güvenli bir JSON Content-Type döndürmedi.',
      502,
    );
  }
  const mediaType = contentType.split(';', 1)[0]?.trim().toLowerCase();
  if (
    mediaType !== 'application/json' &&
    !/^application\/[a-z0-9!#$&^_.+-]+\+json$/u.test(mediaType || '')
  ) {
    throw new BaseX402BuyerRouteError(
      'X402_PAID_CONTENT_TYPE_INVALID',
      'Ücretli x402 yanıtı yalnız JSON olabilir.',
      502,
    );
  }
  return contentType;
}

function validateSafeJsonTree(value: unknown): void {
  const pending: Array<{ value: unknown; depth: number }> = [
    { value, depth: 0 },
  ];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    nodes += 1;
    if (nodes > MAX_JSON_NODES || current.depth > MAX_JSON_DEPTH) {
      throw new BaseX402BuyerRouteError(
        'X402_PAID_JSON_COMPLEXITY_EXCEEDED',
        'Ücretli x402 JSON yanıtı güvenli karmaşıklık sınırını aştı.',
        502,
      );
    }
    if (typeof current.value === 'string' && current.value.length > 262_144) {
      throw new BaseX402BuyerRouteError(
        'X402_PAID_JSON_COMPLEXITY_EXCEEDED',
        'Ücretli x402 JSON yanıtı güvenli metin sınırını aştı.',
        502,
      );
    }
    if (Array.isArray(current.value)) {
      for (const child of current.value) {
        pending.push({ value: child, depth: current.depth + 1 });
      }
      continue;
    }
    if (current.value && typeof current.value === 'object') {
      for (const [key, child] of Object.entries(
        current.value as Record<string, unknown>,
      )) {
        if (key.length > 256) {
          throw new BaseX402BuyerRouteError(
            'X402_PAID_JSON_COMPLEXITY_EXCEEDED',
            'Ücretli x402 JSON yanıtı güvenli anahtar sınırını aştı.',
            502,
          );
        }
        pending.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
}

function safePaidJson(upstream: BaseX402BuyerUpstreamResponse): unknown {
  let data: unknown;
  try {
    data = JSON.parse(upstream.body) as unknown;
  } catch {
    throw new BaseX402BuyerRouteError(
      'X402_PAID_JSON_INVALID',
      'Ücretli x402 yanıtı geçerli JSON değil.',
      502,
    );
  }
  validateSafeJsonTree(data);
  return data;
}

function sendError(
  res: Response,
  error: unknown,
  session?: BaseX402BuyerSession,
  requestId?: string,
  upstream?: {
    readonly upstreamStatus?: number;
    readonly contentType?: string;
  },
): Response {
  const known =
    error instanceof BaseX402BuyerRouteError ||
    error instanceof BaseX402IntentError ||
    error instanceof RequestIdValidationError;
  const statusCode = known ? error.statusCode : 500;
  const code = known ? error.code : 'X402_BUYER_INTERNAL_ERROR';
  const message = known
    ? error.message
    : 'x402 buyer isteği güvenli biçimde tamamlanamadı.';
  return res.status(statusCode).json({
    success: false,
    code,
    error: message,
    message,
    ...(session
      ? sessionIdentity(session)
      : requestId
        ? {
            network: 'base' as const,
            chainId: NETWORKS.base.chainId,
            requestId,
          }
        : {
            network: 'base' as const,
            chainId: NETWORKS.base.chainId,
          }),
    ...(session
      ? {
          paymentState: session.state,
          retryable: session.state === 'prepared',
        }
      : {}),
    ...(upstream?.upstreamStatus === undefined
      ? {}
      : { upstreamStatus: upstream.upstreamStatus }),
    ...(upstream?.contentType === undefined
      ? {}
      : { contentType: upstream.contentType }),
  });
}

function setPrivateResponseHeaders(
  res: Response,
  requestId?: string,
): void {
  res.set('Cache-Control', 'no-store');
  res.set('Pragma', 'no-cache');
  if (requestId) res.set('X-Request-Id', requestId);
}

router.post('/session', async (req, res) => {
  let requestId: string | undefined;
  try {
    setPrivateResponseHeaders(res);
    requestId = requestIdFrom(req.body?.requestId);
    setPrivateResponseHeaders(res, requestId);
    const wallet = walletFrom(req.body?.wallet);
    if (
      req.body?.network !== 'base' ||
      req.body?.chainId !== NETWORKS.base.chainId
    ) {
      throw new BaseX402BuyerRouteError(
        'X402_BUYER_BASE_CONTEXT_REQUIRED',
        'x402 buyer oturumu network=base ve chainId=8453 gerektirir.',
      );
    }
    if (
      typeof req.body?.url !== 'string' ||
      req.body.url.length > 2_048 ||
      typeof req.body?.maxPayment !== 'string' ||
      req.body.maxPayment.length > 32 ||
      req.body?.method !== 'GET'
    ) {
      throw new BaseX402BuyerRouteError(
        'X402_BUYER_SESSION_INPUT_INVALID',
        'method=GET, url ve maxPayment açık, sınırlı alanlar olmalıdır.',
      );
    }

    cleanupSessions();
    const existing = sessionByRequestId(requestId);
    if (existing) {
      if (
        existing.state === 'prepared' &&
        existing.userAddress === wallet &&
        existing.url === req.body.url &&
        existing.maxPayment === req.body.maxPayment
      ) {
        return res.status(200).json(sessionEnvelope(existing));
      }
      throw new BaseX402BuyerRouteError(
        'X402_BUYER_REQUEST_ID_ACTIVE',
        'Bu requestId için zaten bir x402 buyer oturumu hazırlandı.',
        409,
      );
    }
    if (preparingRequestIds.has(requestId)) {
      throw new BaseX402BuyerRouteError(
        'X402_BUYER_REQUEST_ID_ACTIVE',
        'Bu requestId için x402 buyer oturumu hazırlanıyor.',
        409,
      );
    }
    if (sessions.size + preparingRequestIds.size >= MAX_SESSIONS) {
      throw new BaseX402BuyerRouteError(
        'X402_BUYER_SESSION_CAPACITY',
        'x402 buyer oturum kapasitesi geçici olarak dolu.',
        503,
      );
    }

    preparingRequestIds.add(requestId);
    try {
      const prepared = await prepareBaseX402BuyerChallenge({
        url: req.body.url,
        maxPayment: req.body.maxPayment,
        wallet,
      });
      if (sessionByRequestId(requestId)) {
        throw new BaseX402BuyerRouteError(
          'X402_BUYER_REQUEST_ID_ACTIVE',
          'Bu requestId için zaten bir x402 buyer oturumu hazırlandı.',
          409,
        );
      }
      const createdAt = Date.now();
      const sessionId = randomBytes(32).toString('hex');
      const session: BaseX402BuyerSession = {
        sessionId,
        requestId,
        userAddress: wallet,
        url: prepared.evidence.requestUrl,
        maxPayment: prepared.evidence.maxPayment,
        paymentRequiredHeader: prepared.paymentRequiredHeader,
        paymentRequired:
          prepared.paymentRequired as Readonly<Record<string, unknown>>,
        accepted: prepared.accepted,
        evidence: prepared.evidence,
        createdAt,
        expiresAt: createdAt + SESSION_TTL_MS,
        signatureAttempts: 0,
        state: 'prepared',
      };
      sessions.set(sessionId, session);
      return res.status(201).json(sessionEnvelope(session));
    } finally {
      preparingRequestIds.delete(requestId);
    }
  } catch (error) {
    return sendError(res, error, undefined, requestId);
  }
});

router.get('/session/:sessionId/status', (req, res) => {
  let session: BaseX402BuyerSession | undefined;
  try {
    setPrivateResponseHeaders(res);
    session = safeSession(req.params.sessionId);
    setPrivateResponseHeaders(res, session.requestId);
    bindSessionRequestId(req, session);
    return res.status(200).json({
      success: true,
      ...sessionIdentity(session),
      paymentState: session.state,
      retryable:
        session.state === 'prepared' && session.expiresAt > Date.now(),
      expiresAt: new Date(session.expiresAt).toISOString(),
      ...(session.settlement ? { settlement: session.settlement } : {}),
    });
  } catch (error) {
    return sendError(res, error, session);
  }
});

router.get('/session/:sessionId', async (req, res) => {
  let session: BaseX402BuyerSession | undefined;
  let paymentResponse: string | undefined;
  let upstreamStatus: number | undefined;
  let contentType: string | undefined;
  try {
    setPrivateResponseHeaders(res);
    session = safeSession(req.params.sessionId);
    setPrivateResponseHeaders(res, session.requestId);
    bindSessionRequestId(req, session);

    const paymentSignature = singleHeader(req, 'Payment-Signature');
    if (!paymentSignature) {
      if (session.state !== 'prepared') {
        throw new BaseX402BuyerRouteError(
          'X402_BUYER_SESSION_ALREADY_USED',
          'x402 buyer oturumu kullanımda veya daha önce kullanıldı; tekrar ödeme gönderilemez.',
          409,
        );
      }
      res.set('PAYMENT-REQUIRED', session.paymentRequiredHeader);
      res.set('X-PAYMENT-REQUIRED', session.paymentRequiredHeader);
      return res.status(402).json({
        success: false,
        code: 'X402_PAYMENT_REQUIRED',
        message: 'Ödeme için kayıtlı x402 challenge onayı gerekiyor.',
        ...sessionIdentity(session),
        evidence: session.evidence,
        expiresAt: new Date(session.expiresAt).toISOString(),
      });
    }
    if (session.state !== 'prepared') {
      throw new BaseX402BuyerRouteError(
        'X402_BUYER_SESSION_ALREADY_USED',
        'x402 buyer oturumu kullanımda veya daha önce kullanıldı; tekrar ödeme gönderilemez.',
        409,
      );
    }

    session.state = 'verifying';
    session.signatureAttempts += 1;
    let payment: VerifiedBuyerPayment;
    try {
      payment = parsePaymentSignatureHeader(paymentSignature, session);
      if (!(await verifyBuyerSignature(session, payment))) {
        throw new BaseX402BuyerRouteError(
          'X402_PAYMENT_SIGNATURE_INVALID',
          'Cüzdan imzası aktif EIP-3009 yetkilendirmesi için geçerli değil.',
          401,
        );
      }
    } catch (error) {
      session.state =
        session.signatureAttempts >= MAX_SIGNATURE_ATTEMPTS
          ? 'rejected'
          : 'prepared';
      throw error;
    }

    if (session.expiresAt <= Date.now()) {
      session.state = 'rejected';
      throw new BaseX402BuyerRouteError(
        'X402_BUYER_SESSION_EXPIRED',
        'x402 buyer oturumunun süresi doldu; imza üst servise gönderilmedi.',
        410,
      );
    }
    session.state = 'submitting';
    let upstream: BaseX402BuyerUpstreamResponse;
    try {
      upstream = await forwardPinnedBaseX402BuyerPayment({
        url: session.url,
        paymentSignature,
      });
      upstreamStatus = upstream.statusCode;
    } catch (error) {
      session.state = 'indeterminate';
      throw error;
    }

    try {
      const candidatePaymentResponse = paymentResponseHeader(upstream);
      const settlement = validateSettlement(
        candidatePaymentResponse,
        session,
      );
      paymentResponse = candidatePaymentResponse;
      session.settlement = settlement;
      session.state = 'settled';
      res.set('PAYMENT-RESPONSE', paymentResponse);
      res.set('X-PAYMENT-RESPONSE', paymentResponse);
      contentType = safeContentType(upstream);
      const data = safePaidJson(upstream);
      if (upstream.statusCode < 200 || upstream.statusCode >= 300) {
        throw new BaseX402BuyerRouteError(
          'X402_PAID_UPSTREAM_STATUS_INVALID',
          'Ödeme doğrulandı ancak ücretli servis başarılı bir HTTP durumu döndürmedi.',
          502,
        );
      }
      return res.status(200).json({
        success: true,
        ...sessionIdentity(session),
        upstreamStatus: upstream.statusCode,
        contentType,
        data,
        settlement,
      });
    } catch (error) {
      if (session.state !== 'settled') session.state = 'indeterminate';
      throw error;
    }
  } catch (error) {
    if (paymentResponse) {
      res.set('PAYMENT-RESPONSE', paymentResponse);
      res.set('X-PAYMENT-RESPONSE', paymentResponse);
    }
    return sendError(res, error, session, undefined, {
      upstreamStatus,
      contentType,
    });
  }
});

export function clearBaseX402BuyerSessionsForTests(): void {
  sessions.clear();
  preparingRequestIds.clear();
}

export default router;
