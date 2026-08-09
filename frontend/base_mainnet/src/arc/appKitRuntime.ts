import {
  formatUnits,
  getAddress,
  isAddress,
  parseUnits,
  type EIP1193Provider,
} from 'viem';
import type { Connector } from 'wagmi';
import type {
  BridgeResult,
  EstimateResult as BridgeEstimate,
  SwapEstimate,
  SwapResult,
} from '@circle-fin/app-kit';
import type {
  ArcAppKitExecutionPlan,
  ArcAppKitToken,
} from '../types';

const ARC_CHAIN_ID = 5_042_002;
const DECIMAL_INPUT = /^(?:\d+\.?\d*|\.\d+)$/;
const TRACE_ID = /^[0-9a-f]{32}$/;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const TOKENS = new Set<ArcAppKitToken>(['USDC', 'EURC', 'cirBTC']);
const DESTINATIONS = new Set([
  'Arbitrum_Sepolia',
  'Avalanche_Fuji',
  'Base_Sepolia',
  'Ethereum_Sepolia',
  'Optimism_Sepolia',
]);

export type ArcAppKitQuote = {
  operation: ArcAppKitExecutionPlan['operation'];
  headline: string;
  estimatedOutput?: string;
  minimumOutput?: string;
  fees: string[];
  feeDisclosure: string;
  planFingerprint: string;
  expectedAddress: string;
  provider: 'Circle App Kit';
  environment: 'testnet';
  observedAt: string;
};

export type ArcAppKitExecutionResult = {
  state: 'success' | 'pending' | 'recoverable' | 'blocked';
  consumed: boolean;
  statusMessage: string;
  txHash?: string;
  explorerUrl?: string;
  steps: {
    name: string;
    state: string;
    txHash?: string;
    explorerUrl?: string;
    forwarded?: boolean;
    batched?: boolean;
    batchId?: string;
    errorCategory?: string;
  }[];
};

type BridgePlan = Extract<
  ArcAppKitExecutionPlan,
  { operation: 'bridge' }
>;

const bridgeRecovery = new Map<
  string,
  { result: BridgeResult; plan: BridgePlan; expectedAddress: string }
>();

type JournalState =
  | 'started'
  | ArcAppKitExecutionResult['state'];

type JournalEntry = {
  version: 1;
  fingerprint: string;
  expectedAddress: string;
  state: JournalState;
  consumed: boolean;
  statusMessage: string;
  updatedAt: string;
  txHash?: string;
};

const JOURNAL_PREFIX = 'kletia:arc-app-kit:v1';

export function arcAppKitPlanFingerprint(
  plan: ArcAppKitExecutionPlan,
): string {
  if (plan.operation === 'swap') {
    return JSON.stringify([
      plan.version,
      plan.environment,
      plan.traceId,
      plan.sourceChain,
      plan.operation,
      plan.tokenIn,
      plan.tokenOut,
      plan.amount,
      plan.slippageBps,
      plan.minimumOutput || '',
    ]);
  }
  if (plan.operation === 'send') {
    return JSON.stringify([
      plan.version,
      plan.environment,
      plan.traceId,
      plan.sourceChain,
      plan.operation,
      plan.token,
      plan.amount,
      getAddress(plan.recipient),
    ]);
  }
  return JSON.stringify([
    plan.version,
    plan.environment,
    plan.traceId,
    plan.sourceChain,
    plan.operation,
    plan.token,
    plan.amount,
    plan.destinationChain,
    getAddress(plan.recipient),
    plan.useForwarder,
    plan.transferSpeed,
    plan.maxFee || '',
  ]);
}

const journalKey = (
  plan: ArcAppKitExecutionPlan,
  expectedAddress: string,
): string =>
  `${JOURNAL_PREFIX}:${plan.traceId}:${getAddress(expectedAddress)}`;

function readJournal(
  plan: ArcAppKitExecutionPlan,
  expectedAddress: string,
): JournalEntry | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(journalKey(plan, expectedAddress));
    if (!raw) return null;
    const entry = JSON.parse(raw) as Partial<JournalEntry>;
    if (
      entry.version !== 1 ||
      entry.fingerprint !== arcAppKitPlanFingerprint(plan) ||
      entry.expectedAddress !== getAddress(expectedAddress) ||
      typeof entry.statusMessage !== 'string' ||
      typeof entry.updatedAt !== 'string' ||
      !['started', 'success', 'pending', 'recoverable', 'blocked'].includes(
        String(entry.state),
      )
    ) {
      return {
        version: 1,
        fingerprint: arcAppKitPlanFingerprint(plan),
        expectedAddress: getAddress(expectedAddress),
        state: 'blocked',
        consumed: true,
        statusMessage:
          'Bu trace kimliği için yerel yürütme kaydı planla eşleşmiyor. Güvenlik için yeniden gönderim engellendi.',
        updatedAt: new Date().toISOString(),
      };
    }
    return entry as JournalEntry;
  } catch {
    return {
      version: 1,
      fingerprint: arcAppKitPlanFingerprint(plan),
      expectedAddress: getAddress(expectedAddress),
      state: 'blocked',
      consumed: true,
      statusMessage:
        'Yerel yürütme günlüğü okunamadı. Olası çift işlem riskine karşı yeniden gönderim engellendi.',
      updatedAt: new Date().toISOString(),
    };
  }
}

function writeJournal(
  plan: ArcAppKitExecutionPlan,
  expectedAddress: string,
  entry: Pick<
    JournalEntry,
    'state' | 'consumed' | 'statusMessage' | 'txHash'
  >,
): boolean {
  if (typeof window === 'undefined') return false;
  const value: JournalEntry = {
    version: 1,
    fingerprint: arcAppKitPlanFingerprint(plan),
    expectedAddress: getAddress(expectedAddress),
    state: entry.state,
    consumed: entry.consumed,
    statusMessage: entry.statusMessage,
    updatedAt: new Date().toISOString(),
    ...(entry.txHash ? { txHash: entry.txHash } : {}),
  };
  try {
    window.localStorage.setItem(
      journalKey(plan, expectedAddress),
      JSON.stringify(value),
    );
    return true;
  } catch {
    return false;
  }
}

function clearJournal(
  plan: ArcAppKitExecutionPlan,
  expectedAddress: string,
) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(journalKey(plan, expectedAddress));
  } catch {

  }
}

export function getArcAppKitJournalState(
  plan: ArcAppKitExecutionPlan,
  expectedAddress: string,
): {
  state: ArcAppKitExecutionResult['state'];
  statusMessage: string;
  txHash?: string;
} | null {
  const entry = readJournal(plan, expectedAddress);
  if (!entry) return null;
  return {
    state: entry.state === 'started' ? 'blocked' : entry.state,
    statusMessage:
      entry.state === 'started'
        ? 'Önceki App Kit denemesi imza/yayın aşamasında kesildi. Zincir durumu doğrulanmadan aynı niyet yeniden gönderilemez.'
        : entry.statusMessage,
    txHash: entry.txHash,
  };
}

const tokenDecimals = (token: ArcAppKitToken): number =>
  token === 'cirBTC' ? 8 : 6;

function assertDecimal(
  value: unknown,
  decimals: number,
  field: string,
): asserts value is string {
  if (typeof value !== 'string' || !DECIMAL_INPUT.test(value)) {
    throw new Error(`${field} geçerli bir ondalık sayı değil.`);
  }
  if ((value.split('.')[1] || '').length > decimals) {
    throw new Error(`${field} ${decimals} ondalık hassasiyetini aşıyor.`);
  }
  if (parseUnits(value, decimals) <= 0n) {
    throw new Error(`${field} sıfırdan büyük olmalıdır.`);
  }
}

function assertNonNegativeDecimal(
  value: unknown,
  decimals: number,
  field: string,
): asserts value is string {
  if (typeof value !== 'string' || !DECIMAL_INPUT.test(value)) {
    throw new Error(`${field} geçerli bir ondalık sayı değil.`);
  }
  if ((value.split('.')[1] || '').length > decimals) {
    throw new Error(`${field} ${decimals} ondalık hassasiyetini aşıyor.`);
  }
  parseUnits(value, decimals);
}

function assertSameDecimal(
  actual: unknown,
  expected: string,
  decimals: number,
  field: string,
): asserts actual is string {
  assertDecimal(actual, decimals, field);
  if (parseUnits(actual, decimals) !== parseUnits(expected, decimals)) {
    throw new Error(`${field} imzalanan niyetle eşleşmiyor.`);
  }
}

function assertSameAddress(
  actual: unknown,
  expected: string,
  field: string,
): asserts actual is string {
  if (
    typeof actual !== 'string' ||
    !isAddress(actual) ||
    getAddress(actual) !== getAddress(expected)
  ) {
    throw new Error(`${field} aktif niyetle eşleşmiyor.`);
  }
}

function assertTransactionHash(
  value: unknown,
  field: string,
): asserts value is `0x${string}` {
  if (typeof value !== 'string' || !TX_HASH.test(value)) {
    throw new Error(`${field} geçerli bir işlem hash’i değil.`);
  }
}

const arcExplorerUrl = (hash: string): string =>
  `https://testnet.arcscan.app/tx/${hash}`;

const recoveryKey = (traceId: string, expectedAddress: string): string =>
  `${traceId}:${getAddress(expectedAddress)}`;

export function assertArcAppKitPlan(
  plan: unknown,
): asserts plan is ArcAppKitExecutionPlan {
  if (!plan || typeof plan !== 'object') {
    throw new Error('Circle App Kit planı eksik.');
  }
  const candidate = plan as Record<string, unknown>;
  if (
    candidate.version !== 1 ||
    candidate.environment !== 'testnet' ||
    candidate.sourceChain !== 'Arc_Testnet' ||
    typeof candidate.traceId !== 'string' ||
    !TRACE_ID.test(candidate.traceId)
  ) {
    throw new Error('Circle App Kit planı Arc Testnet politikasına uymuyor.');
  }
  if (candidate.operation === 'swap') {
    if (
      !TOKENS.has(candidate.tokenIn as ArcAppKitToken) ||
      !TOKENS.has(candidate.tokenOut as ArcAppKitToken) ||
      candidate.tokenIn === candidate.tokenOut
    ) {
      throw new Error('Circle App Kit swap token çifti geçersiz.');
    }
    assertDecimal(
      candidate.amount,
      tokenDecimals(candidate.tokenIn as ArcAppKitToken),
      'App Kit miktarı',
    );
    if (
      !Number.isSafeInteger(candidate.slippageBps) ||
      Number(candidate.slippageBps) <= 0 ||
      Number(candidate.slippageBps) > 500
    ) {
      throw new Error('Circle App Kit swap toleransı geçersiz.');
    }
    if (candidate.minimumOutput !== undefined) {
      assertDecimal(
        candidate.minimumOutput,
        tokenDecimals(candidate.tokenOut as ArcAppKitToken),
        'Minimum alınacak miktar',
      );
    }
    return;
  }

  if (candidate.operation === 'send') {
    if (
      (candidate.token !== 'USDC' && candidate.token !== 'EURC') ||
      !isAddress(String(candidate.recipient || ''))
    ) {
      throw new Error('Circle App Kit Send planı geçersiz.');
    }
    assertDecimal(candidate.amount, 6, 'App Kit miktarı');
    return;
  }

  if (candidate.operation === 'bridge') {
    if (
      candidate.token !== 'USDC' ||
      !DESTINATIONS.has(String(candidate.destinationChain || '')) ||
      !isAddress(String(candidate.recipient || '')) ||
      candidate.useForwarder !== true ||
      (candidate.transferSpeed !== 'FAST' &&
        candidate.transferSpeed !== 'SLOW')
    ) {
      throw new Error('Circle App Kit bridge planı geçersiz.');
    }
    assertDecimal(candidate.amount, 6, 'App Kit miktarı');
    if (candidate.transferSpeed === 'FAST' && candidate.maxFee === undefined) {
      throw new Error('FAST bridge için maksimum ücret sınırı eksik.');
    }
    if (candidate.maxFee !== undefined) {
      assertDecimal(candidate.maxFee, 6, 'Maksimum bridge ücreti');
    }
    if (
      candidate.transferSpeed === 'FAST' &&
      parseUnits(candidate.maxFee as string, 6) >=
        parseUnits(candidate.amount, 6)
    ) {
      throw new Error(
        'FAST bridge maksimum ücreti gönderilecek miktardan küçük olmalıdır.',
      );
    }
    if (
      candidate.transferSpeed === 'SLOW' &&
      candidate.maxFee !== undefined
    ) {
      throw new Error('SLOW bridge planı FAST maxFee alanı içeremez.');
    }
    return;
  }

  throw new Error('Desteklenmeyen Circle App Kit operasyonu.');
}

type RequestProvider = EIP1193Provider & {
  request(args: {
    method: string;
    params?: readonly unknown[];
  }): Promise<unknown>;
};

async function createRuntime(
  connector: Connector,
  expectedAddress: string,
) {
  const [
    { AppKit, isRetryableError, isUserCancellationError },
    { createViemAdapterFromProvider },
  ] = await Promise.all([
    import('@circle-fin/app-kit'),
    import('@circle-fin/adapter-viem-v2'),
  ]);
  const rawProvider = await connector.getProvider({
    chainId: ARC_CHAIN_ID,
  });
  if (
    !rawProvider ||
    typeof (rawProvider as { request?: unknown }).request !== 'function'
  ) {
    throw new Error('Bağlı cüzdan EIP-1193 provider sunmuyor.');
  }
  const provider = rawProvider as RequestProvider;
  const [chainValue, accountValue] = await Promise.all([
    provider.request({ method: 'eth_chainId' }),
    provider.request({ method: 'eth_accounts' }),
  ]);
  const providerChainId =
    typeof chainValue === 'string' ? Number.parseInt(chainValue, 16) : NaN;
  if (providerChainId !== ARC_CHAIN_ID) {
    throw new Error('Circle App Kit yalnızca aktif Arc Testnet oturumunda çalışır.');
  }
  const providerAccount =
    Array.isArray(accountValue) && typeof accountValue[0] === 'string'
      ? accountValue[0]
      : '';
  if (
    !isAddress(providerAccount) ||
    getAddress(providerAccount) !== getAddress(expectedAddress)
  ) {
    throw new Error('Circle App Kit provider hesabı aktif cüzdanla eşleşmiyor.');
  }

  const adapter = await createViemAdapterFromProvider({
    provider,
    capabilities: {
      addressContext: 'user-controlled',
    },
  });
  const kit = new AppKit({

    disableErrorReporting: true,
  });
  return { kit, adapter, isRetryableError, isUserCancellationError };
}

const feeText = (
  rawFee: unknown,
  token: string,
  decimals?: number,
): string | null => {
  if (rawFee === null || rawFee === undefined) return null;
  const value = String(rawFee);
  if (!/^\d+$/.test(value) || decimals === undefined) {
    return `${value} ${token}`;
  }
  return `${formatUnits(BigInt(value), decimals)} ${token}`;
};

function swapParams(
  plan: Extract<ArcAppKitExecutionPlan, { operation: 'swap' }>,
  adapter: Awaited<
    ReturnType<typeof createRuntime>
  >['adapter'],
) {
  return {
    from: { adapter, chain: 'Arc_Testnet' as const },
    tokenIn: plan.tokenIn,
    tokenOut: plan.tokenOut,
    amountIn: plan.amount,
    config: {
      slippageBps: plan.slippageBps,
      ...(plan.minimumOutput
        ? { stopLimit: plan.minimumOutput }
        : {}),

    },
  };
}

function bridgeParams(
  plan: BridgePlan,
  adapter: Awaited<
    ReturnType<typeof createRuntime>
  >['adapter'],
) {
  return {
    from: { adapter, chain: 'Arc_Testnet' as const },
    to: {
      chain: plan.destinationChain,
      recipientAddress: getAddress(plan.recipient),
      useForwarder: true as const,
    },
    amount: plan.amount,
    token: 'USDC' as const,
    config: {
      transferSpeed: plan.transferSpeed,
      batchTransactions: true,
      ...(plan.maxFee ? { maxFee: plan.maxFee } : {}),
    },
    invocationMeta: { traceId: plan.traceId },
  };
}

function assertSwapEstimateMatchesPlan(
  estimate: SwapEstimate,
  plan: Extract<ArcAppKitExecutionPlan, { operation: 'swap' }>,
  expectedAddress: string,
) {
  if (
    estimate.tokenIn !== plan.tokenIn ||
    estimate.tokenOut !== plan.tokenOut ||
    estimate.chainIn !== 'Arc_Testnet' ||
    estimate.chainOut !== 'Arc_Testnet' ||
    estimate.chain !== 'Arc_Testnet'
  ) {
    throw new Error('Circle swap tahmini Arc niyet rotasıyla eşleşmiyor.');
  }
  assertSameDecimal(
    estimate.amountIn,
    plan.amount,
    tokenDecimals(plan.tokenIn),
    'Circle swap girdi miktarı',
  );
  assertSameAddress(
    estimate.fromAddress,
    expectedAddress,
    'Circle swap göndereni',
  );
  assertSameAddress(
    estimate.toAddress,
    expectedAddress,
    'Circle swap alıcısı',
  );
  if (
    estimate.stopLimit.token !== plan.tokenOut ||
    estimate.estimatedOutput.token !== plan.tokenOut
  ) {
    throw new Error('Circle swap çıktı tokeni niyetle eşleşmiyor.');
  }
  assertDecimal(
    estimate.stopLimit.amount,
    tokenDecimals(plan.tokenOut),
    'Circle swap korunan minimumu',
  );
  assertDecimal(
    estimate.estimatedOutput.amount,
    tokenDecimals(plan.tokenOut),
    'Circle swap tahmini çıktısı',
  );
  if (
    plan.minimumOutput &&
    parseUnits(estimate.stopLimit.amount, tokenDecimals(plan.tokenOut)) <
      parseUnits(plan.minimumOutput, tokenDecimals(plan.tokenOut))
  ) {
    throw new Error('Circle swap sağlayıcısı kullanıcı minimumunu korumuyor.');
  }
  for (const fee of estimate.fees || []) {
    if (
      typeof fee.token !== 'string' ||
      fee.token.length === 0 ||
      typeof fee.type !== 'string' ||
      fee.type.length === 0
    ) {
      throw new Error('Circle swap ücret kalemi doğrulanamadı.');
    }
    assertNonNegativeDecimal(fee.amount, 18, 'Circle swap ücreti');
  }
}

function assertSwapResultMatchesPlan(
  result: SwapResult,
  plan: Extract<ArcAppKitExecutionPlan, { operation: 'swap' }>,
  expectedAddress: string,
) {
  if (
    result.tokenIn !== plan.tokenIn ||
    result.tokenOut !== plan.tokenOut ||
    result.chainIn !== 'Arc_Testnet' ||
    result.chainOut !== 'Arc_Testnet' ||
    result.chain !== 'Arc_Testnet'
  ) {
    throw new Error('Circle swap sonucu Arc niyet rotasıyla eşleşmiyor.');
  }
  assertSameDecimal(
    result.amountIn,
    plan.amount,
    tokenDecimals(plan.tokenIn),
    'Circle swap yürütme miktarı',
  );
  assertSameAddress(
    result.fromAddress,
    expectedAddress,
    'Circle swap göndereni',
  );
  assertSameAddress(
    result.toAddress,
    expectedAddress,
    'Circle swap alıcısı',
  );
  if (
    !result.config ||
    result.config.slippageBps !== plan.slippageBps ||
    (plan.minimumOutput
      ? result.config.stopLimit !== plan.minimumOutput
      : result.config.stopLimit !== undefined)
  ) {
    throw new Error('Circle swap yürütme sınırları niyetle eşleşmiyor.');
  }
  assertTransactionHash(result.txHash, 'Circle swap');
  if (result.amountOut !== undefined) {
    assertDecimal(
      result.amountOut,
      tokenDecimals(plan.tokenOut),
      'Circle swap gerçekleşen çıktısı',
    );
  }
  if (
    result.progress.status === 'DONE' &&
    plan.minimumOutput &&
    result.amountOut !== undefined &&
    parseUnits(result.amountOut, tokenDecimals(plan.tokenOut)) <
      parseUnits(plan.minimumOutput, tokenDecimals(plan.tokenOut))
  ) {
    throw new Error('Circle swap sonucu kullanıcı minimumunun altında.');
  }
}

function assertBridgeEstimateMatchesPlan(
  estimate: BridgeEstimate,
  plan: BridgePlan,
  expectedAddress: string,
) {
  if (
    estimate.token !== 'USDC' ||
    estimate.source.chain !== 'Arc_Testnet' ||
    estimate.destination.chain !== plan.destinationChain
  ) {
    throw new Error('Circle bridge tahmini niyet ağlarıyla eşleşmiyor.');
  }
  assertSameDecimal(
    estimate.amount,
    plan.amount,
    6,
    'Circle bridge miktarı',
  );
  assertSameAddress(
    estimate.source.address,
    expectedAddress,
    'Circle bridge kaynağı',
  );
  assertSameAddress(
    estimate.destination.recipientAddress || estimate.destination.address,
    plan.recipient,
    'Circle bridge alıcısı',
  );

  if (estimate.fees.length === 0 || estimate.gasFees.length === 0) {
    throw new Error('Circle bridge tam ücret tahmini döndürmedi.');
  }
  for (const fee of estimate.fees) {
    if (fee.error != null || fee.amount === null) {
      throw new Error(
        `Circle bridge ${fee.type} ücreti şu anda doğrulanamıyor.`,
      );
    }
    assertNonNegativeDecimal(
      fee.amount,
      6,
      `Circle bridge ${fee.type} ücreti`,
    );
  }
  for (const gasFee of estimate.gasFees) {
    assertArcAppKitBridgeGasEstimate(
      gasFee,
      plan.destinationChain,
    );
  }
}

type BridgeGasEstimate = BridgeEstimate['gasFees'][number];

export function assertArcAppKitBridgeGasEstimate(
  gasFee: BridgeGasEstimate,
  destinationChain: BridgePlan['destinationChain'],
): void {
  if (gasFee.error != null || gasFee.fees === null) {
    throw new Error(
      `Circle bridge ${String(gasFee.blockchain)} gas ücreti doğrulanamıyor.`,
    );
  }
  if (
    gasFee.blockchain !== 'Arc_Testnet' &&
    gasFee.blockchain !== destinationChain
  ) {
    throw new Error('Circle bridge gas tahmini beklenmeyen bir ağ içeriyor.');
  }
  if (
    typeof gasFee.name !== 'string' ||
    gasFee.name.length < 1 ||
    gasFee.name.length > 80 ||
    typeof gasFee.token !== 'string' ||
    gasFee.token.length < 1 ||
    gasFee.token.length > 32 ||
    typeof gasFee.fees.gas !== 'bigint' ||
    gasFee.fees.gas <= 0n ||
    typeof gasFee.fees.gasPrice !== 'bigint' ||
    gasFee.fees.gasPrice < 0n ||
    typeof gasFee.fees.fee !== 'string' ||
    gasFee.fees.fee.length > 96
  ) {
    throw new Error('Circle bridge gas tahmini geçersiz.');
  }
  assertNonNegativeDecimal(
    gasFee.fees.fee,
    18,
    'Circle bridge gas ücreti',
  );
}

function assertBridgeResultMatchesPlan(
  result: BridgeResult,
  plan: BridgePlan,
  expectedAddress: string,
) {
  if (
    result.token !== 'USDC' ||
    result.source.chain.chain !== 'Arc_Testnet' ||
    result.source.chain.isTestnet !== true ||
    result.destination.chain.chain !== plan.destinationChain ||
    result.destination.chain.isTestnet !== true ||
    result.destination.useForwarder !== true
  ) {
    throw new Error('Circle bridge sonucu niyet ağlarıyla eşleşmiyor.');
  }
  assertSameDecimal(
    result.amount,
    plan.amount,
    6,
    'Circle bridge yürütme miktarı',
  );
  assertSameAddress(
    result.source.address,
    expectedAddress,
    'Circle bridge kaynağı',
  );
  assertSameAddress(
    result.destination.recipientAddress || result.destination.address,
    plan.recipient,
    'Circle bridge alıcısı',
  );
  if (
    !result.config ||
    result.config.transferSpeed !== plan.transferSpeed ||
    result.config.batchTransactions !== true ||
    (plan.maxFee
      ? result.config.maxFee !== plan.maxFee
      : result.config.maxFee !== undefined && result.config.maxFee !== '0')
  ) {
    throw new Error('Circle bridge yürütme sınırları niyetle eşleşmiyor.');
  }
  if (typeof result.provider !== 'string' || result.provider.length === 0) {
    throw new Error('Circle bridge sağlayıcısı doğrulanamadı.');
  }
  if (result.steps.length === 0) {
    throw new Error('Circle bridge adım kanıtı eksik.');
  }
  for (const step of result.steps) {
    if (
      typeof step.name !== 'string' ||
      step.name.length === 0 ||
      !['pending', 'success', 'error', 'noop'].includes(step.state)
    ) {
      throw new Error('Circle bridge adım kanıtı geçersiz.');
    }
    if (step.txHash !== undefined) {
      assertTransactionHash(step.txHash, `Circle bridge ${step.name}`);
    }
    if (step.batchId !== undefined && step.batchId.length === 0) {
      throw new Error('Circle bridge batch kimliği geçersiz.');
    }
  }
  if (
    result.state === 'success' &&
    result.steps.some(
      (step) => step.state === 'pending' || step.state === 'error',
    )
  ) {
    throw new Error('Circle bridge başarı durumu adımlarla tutarsız.');
  }
  if (
    result.state === 'error' &&
    !result.steps.some((step) => step.state === 'error')
  ) {
    throw new Error('Circle bridge hata durumu adımlarla tutarsız.');
  }
}

function formatBridgeExecutionResult(
  result: BridgeResult,
  retryable: boolean,
): ArcAppKitExecutionResult {
  const steps = result.steps.map((step) => ({
    name: step.name,
    state: step.state,
    txHash: step.txHash,
    forwarded: step.forwarded,
    batched: step.batched,
    batchId: step.batchId,
    errorCategory: step.errorCategory,
  }));
  const sourceStep = result.steps.find(
    (step) =>
      Boolean(step.txHash) && step.name.toLocaleLowerCase('en-US').includes('burn'),
  );
  const consumed = result.steps.some(
    (step) => Boolean(step.txHash) || Boolean(step.batchId),
  );

  if (result.state === 'success') {
    return {
      state: 'success',
      consumed,
      statusMessage: 'Circle bridge tüm adımları tamamladı.',
      txHash: sourceStep?.txHash,
      explorerUrl: sourceStep?.txHash
        ? arcExplorerUrl(sourceStep.txHash)
        : undefined,
      steps,
    };
  }
  if (result.state === 'pending') {
    return {
      state: 'pending',
      consumed,
      statusMessage:
        'Kaynak işlem gönderildi; Circle attestation/forwarder yolu sürüyor. Aynı niyeti yeniden göndermeyin.',
      txHash: sourceStep?.txHash,
      explorerUrl: sourceStep?.txHash
        ? arcExplorerUrl(sourceStep.txHash)
        : undefined,
      steps,
    };
  }
  return {
    state: retryable ? 'recoverable' : 'blocked',
    consumed,
    statusMessage: retryable
      ? 'Bridge kısmen ilerledi. Resmî SDK ile kaldığı yerden devam edilebilir; kaynak işlemi yeniden başlatılmaz.'
      : 'Bridge kısmen ilerledi ancak güvenli otomatik devam koşulu yok. Aynı niyeti yeniden göndermeyin ve işlem adımlarını inceleyin.',
    txHash: sourceStep?.txHash,
    explorerUrl: sourceStep?.txHash
      ? arcExplorerUrl(sourceStep.txHash)
      : undefined,
    steps,
  };
}

export async function quoteArcAppKitPlan(
  connector: Connector,
  expectedAddress: string,
  plan: ArcAppKitExecutionPlan,
): Promise<ArcAppKitQuote> {
  assertArcAppKitPlan(plan);
  const { kit, adapter } = await createRuntime(connector, expectedAddress);
  const base = {
    operation: plan.operation,
    planFingerprint: arcAppKitPlanFingerprint(plan),
    expectedAddress: getAddress(expectedAddress),
    provider: 'Circle App Kit' as const,
    environment: 'testnet' as const,
    observedAt: new Date().toISOString(),
  };

  if (plan.operation === 'swap') {
    const estimate = await kit.estimateSwap(swapParams(plan, adapter));
    assertSwapEstimateMatchesPlan(estimate, plan, expectedAddress);
    const estimatedOutput = estimate.estimatedOutput.amount;
    if (
      plan.minimumOutput &&
      parseUnits(estimatedOutput, tokenDecimals(plan.tokenOut)) <
        parseUnits(plan.minimumOutput, tokenDecimals(plan.tokenOut))
    ) {
      throw new Error(
        `Canlı çıktı ${plan.minimumOutput} ${plan.tokenOut} altındaki kullanıcı sınırını karşılamıyor.`,
      );
    }
    return {
      ...base,
      headline: `${plan.amount} ${plan.tokenIn} → yaklaşık ${estimatedOutput} ${plan.tokenOut}`,
      estimatedOutput: `${estimatedOutput} ${plan.tokenOut}`,
      minimumOutput: `${estimate.stopLimit.amount} ${plan.tokenOut}`,
      fees: (estimate.fees || []).map(
        (fee) => `${fee.amount} ${String(fee.token)} (${fee.type})`,
      ),
      feeDisclosure:
        'Sağlayıcı ücret kalemi yoksa bu sıfır gas garantisi değildir; cüzdan son gas tutarını ayrıca gösterir. Üretim kit anahtarı istemciye gömülmez, anonim SDK kotası uygulanabilir.',
    };
  }

  if (plan.operation === 'send') {
    const estimate = await kit.estimateSend({
      from: { adapter, chain: 'Arc_Testnet' },
      to: getAddress(plan.recipient),
      amount: plan.amount,
      token: plan.token,
    });
    if (
      estimate.gas < 0n ||
      estimate.gasPrice < 0n ||
      !/^\d+$/.test(estimate.fee)
    ) {
      throw new Error('Circle Send gas tahmini doğrulanamadı.');
    }
    return {
      ...base,
      headline: `${plan.amount} ${plan.token} → ${getAddress(plan.recipient)}`,
      fees: [
        feeText(estimate.fee, 'USDC gas', 18) as string,
      ],
      feeDisclosure:
        'Arc gası native USDC ile ödenir; gösterilen gas tahmindir ve cüzdan onayı nihai tutarı belirler.',
    };
  }

  const estimate = await kit.estimateBridge(bridgeParams(plan, adapter));
  assertBridgeEstimateMatchesPlan(estimate, plan, expectedAddress);
  const protocolFees = estimate.fees.map(
    (fee) => `${fee.amount as string} ${fee.token} (${fee.type})`,
  );
  const gasFees = estimate.gasFees.map(
    (fee) =>
      `${(fee.fees as { fee: string }).fee} ${fee.token} gas / ` +
      `${String(fee.blockchain)} (${fee.name})`,
  );
  return {
    ...base,
    headline:
      `${plan.amount} USDC → ${plan.destinationChain} ` +
      `(${plan.transferSpeed}, Circle Forwarder)`,
    fees: [...protocolFees, ...gasFees],
    feeDisclosure:
      `${plan.maxFee ? `${plan.maxFee} USDC SDK burn ücret tavanı uygulandı. ` : ''}` +
      'Protokol/forwarder ücretleri ve ağ gası ayrı kalemlerdir; Kletia belirsiz veya eksik bir ücret tahmininde yürütmeyi açmaz.',
  };
}

export async function executeArcAppKitPlan(
  connector: Connector,
  expectedAddress: string,
  plan: ArcAppKitExecutionPlan,
): Promise<ArcAppKitExecutionResult> {
  assertArcAppKitPlan(plan);
  const { kit, adapter, isRetryableError, isUserCancellationError } =
    await createRuntime(connector, expectedAddress);
  const existingJournal = readJournal(plan, expectedAddress);
  if (existingJournal) {
    throw new Error(
      'Bu App Kit niyeti daha önce yürütmeye alındı. Olası çift işlem riskine karşı yeni kaynak işlemi başlatılmadı.',
    );
  }
  if (
    !writeJournal(plan, expectedAddress, {
      state: 'started',
      consumed: false,
      statusMessage:
        'Cüzdan imzası/yayın sonucu bekleniyor; bu trace yeniden başlatılamaz.',
    })
  ) {
    throw new Error(
      'Güvenli yürütme günlüğü oluşturulamadı. Çift işlem koruması olmadan App Kit çalıştırılmaz.',
    );
  }

  if (plan.operation === 'swap') {
    let result: SwapResult;
    try {
      result = await kit.swap(swapParams(plan, adapter));
    } catch (error) {
      if (isUserCancellationError(error)) {
        clearJournal(plan, expectedAddress);
        throw new Error('Cüzdan imzası kullanıcı tarafından iptal edildi.', {
          cause: error,
        });
      }
      const blocked: ArcAppKitExecutionResult = {
        state: 'blocked',
        consumed: true,
        statusMessage:
          'Swap yürütmesi imza/yayın sonrasında belirsiz bir hatayla kesildi. Zincir doğrulanmadan aynı niyeti yeniden göndermeyin.',
        steps: [],
      };
      writeJournal(plan, expectedAddress, blocked);
      return blocked;
    }
    try {
      assertSwapResultMatchesPlan(result, plan, expectedAddress);
    } catch {
      const blocked: ArcAppKitExecutionResult = {
        state: 'blocked',
        consumed: true,
        statusMessage:
          'Swap sağlayıcı sonucu imzalanan niyetle yeniden doğrulanamadı. İşlem hash’inizi cüzdandan inceleyin; niyeti tekrar göndermeyin.',
        txHash: TX_HASH.test(result.txHash) ? result.txHash : undefined,
        steps: [],
      };
      writeJournal(plan, expectedAddress, blocked);
      return blocked;
    }
    const state =
      result.progress.status === 'DONE'
        ? 'success'
        : result.progress.status === 'PENDING'
          ? 'pending'
          : 'blocked';
    const executionResult: ArcAppKitExecutionResult = {
      state,
      consumed: true,
      statusMessage:
        state === 'success'
          ? 'Arc stable swap zincir üzerinde tamamlandı.'
          : state === 'pending'
            ? 'Swap kaynak işlemi gönderildi ancak SDK durumu henüz kesinleşmedi. Aynı niyeti yeniden göndermeyin.'
            : 'Swap kaynak işlemi gönderildi ancak sağlayıcı terminal başarı doğrulamadı. Aynı niyeti yeniden göndermeyin.',
      txHash: result.txHash,
      explorerUrl: arcExplorerUrl(result.txHash),
      steps: [
        {
          name: 'Arc stable swap',
          state: result.progress.status,
          txHash: result.txHash,
          explorerUrl: arcExplorerUrl(result.txHash),
        },
      ],
    };
    writeJournal(plan, expectedAddress, executionResult);
    return executionResult;
  }

  if (plan.operation === 'send') {
    let result: Awaited<ReturnType<typeof kit.send>>;
    try {
      result = await kit.send({
        from: { adapter, chain: 'Arc_Testnet' },
        to: getAddress(plan.recipient),
        amount: plan.amount,
        token: plan.token,
      });
    } catch (error) {
      if (isUserCancellationError(error)) {
        clearJournal(plan, expectedAddress);
        throw new Error('Cüzdan imzası kullanıcı tarafından iptal edildi.', {
          cause: error,
        });
      }
      const blocked: ArcAppKitExecutionResult = {
        state: 'blocked',
        consumed: true,
        statusMessage:
          'Send yürütmesi imza/yayın sonrasında belirsiz bir hatayla kesildi. Zincir doğrulanmadan aynı niyeti yeniden göndermeyin.',
        steps: [],
      };
      writeJournal(plan, expectedAddress, blocked);
      return blocked;
    }
    const submitted = Boolean(result.txHash) || Boolean(result.batchId);
    if (result.state !== 'success' || !result.txHash) {
      if (!submitted) {
        clearJournal(plan, expectedAddress);
        throw new Error('Circle App Kit Send zincire gönderilmeden durdu.');
      }
      const blocked: ArcAppKitExecutionResult = {
        state: 'blocked',
        consumed: true,
        statusMessage:
          'Send işlemi yayınlanmış olabilir fakat başarı doğrulanmadı. Aynı niyeti yeniden göndermeyin.',
        txHash:
          result.txHash && TX_HASH.test(result.txHash)
            ? result.txHash
            : undefined,
        steps: [],
      };
      writeJournal(plan, expectedAddress, blocked);
      return blocked;
    }
    try {
      assertTransactionHash(result.txHash, 'Circle Send');
    } catch {
      const blocked: ArcAppKitExecutionResult = {
        state: 'blocked',
        consumed: true,
        statusMessage:
          'Send sonucu doğrulanamadı. Cüzdan geçmişini inceleyin ve aynı niyeti yeniden göndermeyin.',
        steps: [],
      };
      writeJournal(plan, expectedAddress, blocked);
      return blocked;
    }
    const executionResult: ArcAppKitExecutionResult = {
      state: 'success',
      consumed: true,
      statusMessage: 'Arc Send zincir üzerinde tamamlandı.',
      txHash: result.txHash,
      explorerUrl: arcExplorerUrl(result.txHash),
      steps: [
        {
          name: result.name,
          state: result.state,
          txHash: result.txHash,
          explorerUrl: arcExplorerUrl(result.txHash),
          batched: result.batched,
          batchId: result.batchId,
        },
      ],
    };
    writeJournal(plan, expectedAddress, executionResult);
    return executionResult;
  }

  let result: BridgeResult;
  try {
    result = await kit.bridge(bridgeParams(plan, adapter));
  } catch (error) {
    if (isUserCancellationError(error)) {
      clearJournal(plan, expectedAddress);
      throw new Error('Cüzdan imzası kullanıcı tarafından iptal edildi.', {
        cause: error,
      });
    }
    const blocked: ArcAppKitExecutionResult = {
      state: 'blocked',
      consumed: true,
      statusMessage:
        'Bridge yürütmesi imza/yayın sonrasında belirsiz bir hatayla kesildi. Zincir doğrulanmadan aynı niyeti yeniden burn etmeyin.',
      steps: [],
    };
    writeJournal(plan, expectedAddress, blocked);
    return blocked;
  }
  const likelySubmitted =
    result.state !== 'error' ||
    result.steps.some(
      (step) => Boolean(step.txHash) || Boolean(step.batchId),
    );
  try {
    assertBridgeResultMatchesPlan(result, plan, expectedAddress);
  } catch {
    if (!likelySubmitted) {
      clearJournal(plan, expectedAddress);
      throw new Error(
        'Circle bridge sonucu niyetle eşleşmedi; kaynak işlem kanıtı bulunmadığı için yürütme durduruldu.',
      );
    }
    const blocked: ArcAppKitExecutionResult = {
      state: 'blocked',
      consumed: true,
      statusMessage:
        'Bridge sağlayıcı sonucu niyetle yeniden doğrulanamadı. Aynı kaynak niyetini yeniden göndermeyin.',
      steps: [],
    };
    writeJournal(plan, expectedAddress, blocked);
    return blocked;
  }
  const failedStep = result.steps.find((step) => step.state === 'error');
  const retryable = Boolean(
    failedStep?.error && isRetryableError(failedStep.error),
  );
  const executionResult = formatBridgeExecutionResult(result, retryable);
  if (result.state === 'error' && !executionResult.consumed) {
    clearJournal(plan, expectedAddress);
    throw new Error(
      'Circle bridge kaynak işlem göndermeden durdu; canlı tahmini yenileyebilirsiniz.',
    );
  }
  if (executionResult.state === 'recoverable') {
    bridgeRecovery.set(recoveryKey(plan.traceId, expectedAddress), {
      result,
      plan,
      expectedAddress: getAddress(expectedAddress),
    });
  } else {
    bridgeRecovery.delete(recoveryKey(plan.traceId, expectedAddress));
  }
  writeJournal(plan, expectedAddress, executionResult);
  return executionResult;
}

export async function retryArcAppKitBridge(
  connector: Connector,
  expectedAddress: string,
  plan: BridgePlan,
): Promise<ArcAppKitExecutionResult> {
  assertArcAppKitPlan(plan);
  const key = recoveryKey(plan.traceId, expectedAddress);
  const recovery = bridgeRecovery.get(key);
  if (
    !recovery ||
    recovery.expectedAddress !== getAddress(expectedAddress) ||
    arcAppKitPlanFingerprint(recovery.plan) !==
      arcAppKitPlanFingerprint(plan)
  ) {
    throw new Error(
      'Güvenli SDK retry bağlamı bu tarayıcı oturumunda bulunamadı. Kaynak bridge’i yeniden başlatmayın; kayıtlı işlem adımlarını inceleyin.',
    );
  }
  const { kit, adapter, isRetryableError, isUserCancellationError } =
    await createRuntime(connector, expectedAddress);
  assertBridgeResultMatchesPlan(
    recovery.result,
    plan,
    expectedAddress,
  );
  const failedStep = recovery.result.steps.find(
    (step) => step.state === 'error',
  );
  if (!failedStep?.error || !isRetryableError(failedStep.error)) {
    throw new Error('Circle bridge hatası resmî SDK tarafından retryable değil.');
  }
  if (
    !writeJournal(plan, expectedAddress, {
      state: 'started',
      consumed: true,
      statusMessage:
        'Bridge tamamlanan kaynak adımları korunarak resmî SDK ile devam ettiriliyor.',
    })
  ) {
    throw new Error('Bridge retry günlüğü güvenli biçimde güncellenemedi.');
  }

  let result: BridgeResult;
  try {
    result = await kit.retryBridge(recovery.result, {
      from: adapter,
      to: undefined,
    });
  } catch (error) {
    if (isUserCancellationError(error)) {
      const previous = formatBridgeExecutionResult(recovery.result, true);
      writeJournal(plan, expectedAddress, previous);
      throw new Error('Bridge devam imzası kullanıcı tarafından iptal edildi.', {
        cause: error,
      });
    }
    const blocked: ArcAppKitExecutionResult = {
      state: 'blocked',
      consumed: true,
      statusMessage:
        'Bridge retry çağrısı belirsiz bir durumda kesildi. Kaynak burn yeniden başlatılmadı; zincir ve forwarder durumunu inceleyin.',
      steps: [],
    };
    writeJournal(plan, expectedAddress, blocked);
    return blocked;
  }
  try {
    assertBridgeResultMatchesPlan(result, plan, expectedAddress);
  } catch {
    const blocked: ArcAppKitExecutionResult = {
      state: 'blocked',
      consumed: true,
      statusMessage:
        'Bridge retry sonucu özgün niyetle doğrulanamadı. Kaynak burn yeniden başlatılmadı.',
      steps: [],
    };
    writeJournal(plan, expectedAddress, blocked);
    return blocked;
  }
  const nextFailedStep = result.steps.find(
    (step) => step.state === 'error',
  );
  const retryable = Boolean(
    nextFailedStep?.error && isRetryableError(nextFailedStep.error),
  );
  const executionResult = formatBridgeExecutionResult(result, retryable);
  if (executionResult.state === 'recoverable') {
    bridgeRecovery.set(key, {
      result,
      plan,
      expectedAddress: getAddress(expectedAddress),
    });
  } else {
    bridgeRecovery.delete(key);
  }
  writeJournal(plan, expectedAddress, executionResult);
  return executionResult;
}
