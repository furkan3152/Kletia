import { getAddress, isAddress, type Address, type Hex } from 'viem';

import {
  isBaseX402ChallengeEvidence,
  type BaseMcpX402Plan,
  type BaseX402ChallengeEvidence,
} from '../types';

const BASE_CHAIN_ID = 8_453;
const SESSION_ID = /^[0-9a-f]{64}$/u;
const RELAY_PATH = /^\/api\/base\/x402-buyer\/session\/[0-9a-f]{64}$/u;

export type BaseX402BuyerSession = {
  readonly sessionId: string;
  readonly relayPath: string;
  readonly expiresAt: number;
  readonly evidence: BaseX402ChallengeEvidence;
};

export type BaseX402BuyerStatus = {
  readonly paymentState:
    | 'prepared'
    | 'verifying'
    | 'submitting'
    | 'settled'
    | 'rejected'
    | 'indeterminate';
  readonly retryable: boolean;
  readonly settlement?: {
    readonly payer: Address;
    readonly transaction: Hex;
    readonly amount: string;
    readonly network: 'eip155:8453';
  };
};

export function parseBaseX402BuyerSession(
  value: unknown,
  plan: BaseMcpX402Plan,
  expectedUserAddress: Address,
  displayedEvidence: BaseX402ChallengeEvidence,
): BaseX402BuyerSession {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('x402 relay oturumu geçersiz bir yanıt döndürdü.');
  }
  const data = value as Record<string, unknown>;
  const expiresAt =
    typeof data.expiresAt === 'number'
      ? data.expiresAt
      : Date.parse(String(data.expiresAt || ''));
  if (
    data.success !== true ||
    data.network !== 'base' ||
    data.chainId !== BASE_CHAIN_ID ||
    data.requestId !== plan.requestId ||
    typeof data.userAddress !== 'string' ||
    !isAddress(data.userAddress) ||
    getAddress(data.userAddress) !== expectedUserAddress ||
    typeof data.sessionId !== 'string' ||
    !SESSION_ID.test(data.sessionId) ||
    typeof data.relayPath !== 'string' ||
    !RELAY_PATH.test(data.relayPath) ||
    !data.relayPath.endsWith(data.sessionId) ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= Date.now() ||
    expiresAt > Date.now() + 5 * 60_000 ||
    !isBaseX402ChallengeEvidence(
      data.evidence,
      plan,
      expectedUserAddress,
    )
  ) {
    throw new Error(
      'x402 relay oturumu aktif plan, cüzdan veya Base ağıyla eşleşmiyor.',
    );
  }
  const evidence = data.evidence as BaseX402ChallengeEvidence;
  if (
    evidence.requestUrl !== displayedEvidence.requestUrl ||
    evidence.resourceUrl !== displayedEvidence.resourceUrl ||
    getAddress(evidence.asset) !== getAddress(displayedEvidence.asset) ||
    getAddress(evidence.payTo) !== getAddress(displayedEvidence.payTo) ||
    evidence.amountAtomic !== displayedEvidence.amountAtomic ||
    evidence.amount !== displayedEvidence.amount ||
    evidence.maxPayment !== displayedEvidence.maxPayment ||
    evidence.maxTimeoutSeconds !== displayedEvidence.maxTimeoutSeconds
  ) {
    throw new Error(
      'Canlı x402 challenge ekranda gösterilen fiyat veya alıcıdan değişti; yeni plan onayı gerekli.',
    );
  }
  return {
    sessionId: data.sessionId,
    relayPath: data.relayPath,
    expiresAt,
    evidence,
  };
}

export function parseBaseX402PaidEnvelope(
  value: unknown,
  plan: BaseMcpX402Plan,
  session: BaseX402BuyerSession,
  expectedUserAddress: Address,
): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Ücretli kaynak güvenli JSON zarfı döndürmedi.');
  }
  const envelope = value as Record<string, unknown>;
  if (
    envelope.success !== true ||
    envelope.network !== 'base' ||
    envelope.chainId !== BASE_CHAIN_ID ||
    envelope.requestId !== plan.requestId ||
    envelope.sessionId !== session.sessionId ||
    typeof envelope.userAddress !== 'string' ||
    !isAddress(envelope.userAddress) ||
    getAddress(envelope.userAddress) !== expectedUserAddress ||
    typeof envelope.upstreamStatus !== 'number' ||
    !Number.isSafeInteger(envelope.upstreamStatus) ||
    envelope.upstreamStatus < 200 ||
    envelope.upstreamStatus >= 300 ||
    !('data' in envelope)
  ) {
    throw new Error(
      'Ücretli kaynak sonucu aktif x402 oturumu veya başarılı upstream yanıtıyla eşleşmiyor.',
    );
  }
  return envelope.data;
}

export function parseBaseX402BuyerStatus(
  value: unknown,
  plan: BaseMcpX402Plan,
  session: BaseX402BuyerSession,
  expectedUserAddress: Address,
): BaseX402BuyerStatus {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('x402 ödeme durumu geçersiz bir yanıt döndürdü.');
  }
  const status = value as Record<string, unknown>;
  const paymentStates = new Set([
    'prepared',
    'verifying',
    'submitting',
    'settled',
    'rejected',
    'indeterminate',
  ]);
  if (
    status.success !== true ||
    status.network !== 'base' ||
    status.chainId !== BASE_CHAIN_ID ||
    status.requestId !== plan.requestId ||
    status.sessionId !== session.sessionId ||
    typeof status.userAddress !== 'string' ||
    !isAddress(status.userAddress) ||
    getAddress(status.userAddress) !== expectedUserAddress ||
    typeof status.paymentState !== 'string' ||
    !paymentStates.has(status.paymentState) ||
    typeof status.retryable !== 'boolean' ||
    (status.retryable && status.paymentState !== 'prepared')
  ) {
    throw new Error('x402 ödeme durumu aktif oturum kimliğiyle eşleşmiyor.');
  }

  let settlement: BaseX402BuyerStatus['settlement'];
  if (status.settlement !== undefined) {
    if (
      status.paymentState !== 'settled' ||
      !status.settlement ||
      typeof status.settlement !== 'object' ||
      Array.isArray(status.settlement)
    ) {
      throw new Error('x402 settlement durumu geçersiz.');
    }
    const raw = status.settlement as Record<string, unknown>;
    if (
      typeof raw.payer !== 'string' ||
      !isAddress(raw.payer) ||
      getAddress(raw.payer) !== expectedUserAddress ||
      raw.network !== 'eip155:8453' ||
      raw.amount !== session.evidence.amountAtomic ||
      typeof raw.transaction !== 'string' ||
      !/^0x[0-9a-fA-F]{64}$/u.test(raw.transaction) ||
      /^0x0{64}$/iu.test(raw.transaction)
    ) {
      throw new Error('x402 settlement kanıtı aktif oturumla eşleşmiyor.');
    }
    settlement = {
      payer: getAddress(raw.payer),
      transaction: raw.transaction as Hex,
      amount: raw.amount,
      network: 'eip155:8453',
    };
  } else if (status.paymentState === 'settled') {
    throw new Error('Settled x402 durumu işlem kanıtı içermiyor.');
  }

  return {
    paymentState: status.paymentState as BaseX402BuyerStatus['paymentState'],
    retryable: status.retryable,
    ...(settlement ? { settlement } : {}),
  };
}
