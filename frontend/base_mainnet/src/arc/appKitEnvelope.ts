import {
  getAddress,
  isAddress,
  keccak256,
  parseUnits,
  toBytes,
} from 'viem';

import type {
  ArcAppKitExecutionPlan,
  IntentResponse,
} from '../types';

const ACTION_OPERATION = {
  stable_swap: 'swap',
  appkit_send: 'send',
  appkit_bridge: 'bridge',
} as const;
const TOKENS = new Set(['USDC', 'EURC', 'cirBTC']);
const DESTINATIONS = new Set([
  'Arbitrum_Sepolia',
  'Avalanche_Fuji',
  'Base_Sepolia',
  'Ethereum_Sepolia',
  'Optimism_Sepolia',
]);
const REQUEST_ID = /^[0-9a-zA-Z:_-]{8,128}$/;
const DECIMAL = /^(?:\d+\.?\d*|\.\d+)$/;

export const expectedArcAppKitTraceId = (requestId: string): string | null => {
  if (!REQUEST_ID.test(requestId)) return null;
  return keccak256(toBytes(`kletia:${requestId}`)).slice(2, 34);
};

const validDecimal = (
  value: unknown,
  decimals: number,
): value is string => {
  if (typeof value !== 'string' || !DECIMAL.test(value)) return false;
  if ((value.split('.')[1] || '').length > decimals) return false;
  try {
    return parseUnits(value, decimals) > 0n;
  } catch {
    return false;
  }
};

const validRecipient = (value: unknown): value is string => {
  if (typeof value !== 'string' || !isAddress(value)) return false;
  try {
    return getAddress(value) === getAddress(value);
  } catch {
    return false;
  }
};

const hasValidPlanShape = (
  value: unknown,
): value is ArcAppKitExecutionPlan => {
  if (!value || typeof value !== 'object') return false;
  const plan = value as Record<string, unknown>;
  if (
    plan.version !== 1 ||
    plan.environment !== 'testnet' ||
    plan.sourceChain !== 'Arc_Testnet' ||
    typeof plan.traceId !== 'string' ||
    !/^[0-9a-f]{32}$/.test(plan.traceId)
  ) {
    return false;
  }

  if (plan.operation === 'swap') {
    if (
      !TOKENS.has(String(plan.tokenIn)) ||
      !TOKENS.has(String(plan.tokenOut)) ||
      plan.tokenIn === plan.tokenOut ||
      !validDecimal(plan.amount, plan.tokenIn === 'cirBTC' ? 8 : 6) ||
      !Number.isSafeInteger(plan.slippageBps) ||
      Number(plan.slippageBps) <= 0 ||
      Number(plan.slippageBps) > 500
    ) {
      return false;
    }
    return (
      plan.minimumOutput === undefined ||
      validDecimal(plan.minimumOutput, plan.tokenOut === 'cirBTC' ? 8 : 6)
    );
  }

  if (plan.operation === 'send') {
    return (
      (plan.token === 'USDC' || plan.token === 'EURC') &&
      validDecimal(plan.amount, 6) &&
      validRecipient(plan.recipient)
    );
  }

  if (plan.operation === 'bridge') {
    if (
      plan.token !== 'USDC' ||
      !DESTINATIONS.has(String(plan.destinationChain)) ||
      !validDecimal(plan.amount, 6) ||
      !validRecipient(plan.recipient) ||
      plan.useForwarder !== true ||
      (plan.transferSpeed !== 'FAST' && plan.transferSpeed !== 'SLOW')
    ) {
      return false;
    }
    if (plan.transferSpeed === 'SLOW') return plan.maxFee === undefined;
    return (
      validDecimal(plan.maxFee, 6) &&
      parseUnits(plan.maxFee, 6) < parseUnits(plan.amount, 6)
    );
  }

  return false;
};

export const isArcAppKitResponseBound = (
  response: IntentResponse,
  requestId: string,
): boolean => {
  const action = String(response.action || '');
  const expectedOperation =
    ACTION_OPERATION[action as keyof typeof ACTION_OPERATION];
  const expectedTraceId = expectedArcAppKitTraceId(requestId);
  const plan = response.executionPlan;
  const proof = response.routeProof;

  return (
    response.executionKind === 'circle_app_kit' &&
    response.provider === 'Circle App Kit' &&
    response.approvalRequired === true &&
    response.network === 'arc' &&
    response.chainId === 5_042_002 &&
    response.requestId === requestId &&
    expectedOperation !== undefined &&
    response.actionType === action &&
    hasValidPlanShape(plan) &&
    plan.operation === expectedOperation &&
    plan.traceId === expectedTraceId &&
    proof?.environment === 'testnet' &&
    proof.sourceNetwork === 'arc' &&
    proof.sourceChainId === 5_042_002 &&
    proof.provider === 'Circle App Kit' &&
    proof.requiresLiveEstimate === true &&
    proof.requiresExplicitWalletApproval === true &&
    proof.forwardsDestinationMint ===
      (expectedOperation === 'bridge')
  );
};
