import express from 'express';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import type { RouteConfig } from '@x402/core/http';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import {
  createCdpFacilitatorClient,
  CDP_FACILITATOR_URL,
} from '@coinbase/cdp-sdk/x402';
import {
  bazaarResourceServerExtension,
  declareDiscoveryExtension,
} from '@x402/extensions/bazaar';
import {
  formatUnits,
  getAddress,
  parseUnits,
  type Address,
} from 'viem';
import { basePublicClient } from '../config/networks.js';
import {
  BASE_X402_FACTORY_ADDRESS as X402_FACTORY_ADDRESS,
  BASE_X402_MAX_PRICE_ATOMIC as X402_MAX_PRICE_ATOMIC,
  BASE_X402_USDC as BASE_USDC,
  verifyBaseX402Gateway as verifiedGatewayPayment,
} from '../intent/baseX402GatewayPolicy.js';

const router = express.Router({ caseSensitive: true, strict: true });

router.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  next();
});

const configuredX402Treasury =
  process.env.X402_TREASURY_ADDRESS?.trim() ||
  process.env.KLETIA_FEE_RECIPIENT?.trim();
if (process.env.NODE_ENV === 'production' && !configuredX402Treasury) {
  throw new Error(
    'X402_TREASURY_ADDRESS or KLETIA_FEE_RECIPIENT is required in production.',
  );
}
const X402_PAYMENT_ADDRESS = getAddress(
  configuredX402Treasury ||
    "0xFf3a3CFC42D27E85DbA9Ea85f0bFEC34bd632f9A",
);
const configuredDefaultPrice =
  process.env.X402_DEFAULT_PRICE_USDC?.trim() || '0.01';
if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(configuredDefaultPrice)) {
  throw new Error(
    'X402_DEFAULT_PRICE_USDC must be a decimal USDC amount with at most 6 decimals.',
  );
}
const DEFAULT_PRICE_ATOMIC = parseUnits(configuredDefaultPrice, 6);
if (
  DEFAULT_PRICE_ATOMIC <= 0n ||
  DEFAULT_PRICE_ATOMIC > X402_MAX_PRICE_ATOMIC
) {
  throw new Error(
    'X402_DEFAULT_PRICE_USDC is outside the configured safe price range.',
  );
}
const DEFAULT_PRICE = `$${formatUnits(DEFAULT_PRICE_ATOMIC, 6)}`;

type X402Environment = {
  NODE_ENV?: string;
  CDP_API_KEY_ID?: string;
  CDP_API_KEY_SECRET?: string;
  CDP_API_KEY_NAME?: string;
  CDP_API_KEY_PRIVATE_KEY?: string;
};

export function readOfficialCdpX402Credentials(
  environment: X402Environment = process.env,
) {
  const apiKeyId = environment.CDP_API_KEY_ID?.trim();
  const apiKeySecret = environment.CDP_API_KEY_SECRET
    ?.trim()
    .replace(/\\n/g, '\n');
  if (apiKeyId && apiKeySecret) {
    return { apiKeyId, apiKeySecret };
  }

  // CDP previously named the same JWT credentials KEY_NAME/PRIVATE_KEY.
  // Keep existing production installations compatible while still passing
  // the credentials to the official CDP x402 SDK client below.
  const legacyApiKeyId = environment.CDP_API_KEY_NAME?.trim();
  const legacyApiKeySecret = environment.CDP_API_KEY_PRIVATE_KEY
    ?.trim()
    .replace(/\\n/g, '\n');
  if (!legacyApiKeyId || !legacyApiKeySecret) return null;
  return {
    apiKeyId: legacyApiKeyId,
    apiKeySecret: legacyApiKeySecret,
  };
}

export function assertProductionX402Configuration(
  environment: X402Environment = process.env,
) {
  if (
    environment.NODE_ENV === 'production' &&
    !readOfficialCdpX402Credentials(environment)
  ) {
    throw new Error(
      'A complete CDP API key pair is required for production x402 settlement.',
    );
  }
}

assertProductionX402Configuration();

let resourceServer: x402ResourceServer | undefined;

function getOfficialCdpResourceServer() {
  if (resourceServer) return resourceServer;
  const credentials = readOfficialCdpX402Credentials();
  if (!credentials) {
    throw Object.assign(
      new Error('Official CDP x402 facilitator credentials are unavailable.'),
      {
        code: 'X402_FACILITATOR_NOT_CONFIGURED',
        statusCode: 503,
      },
    );
  }

  const facilitator = createCdpFacilitatorClient(credentials);
  resourceServer = new x402ResourceServer(facilitator)
    .register('eip155:8453', new ExactEvmScheme())
    .registerExtension(bazaarResourceServerExtension);
  return resourceServer;
}

const PREMIUM_PATHS = [
  '/alpha-signals',
  '/yield-strategy',
  '/sybil-report'
] as const;
type PremiumPath = (typeof PREMIUM_PATHS)[number];
const GATEWAY_DEMO_PATH = '/gateway-demo';
const PROTECTED_PATHS = [...PREMIUM_PATHS, GATEWAY_DEMO_PATH] as const;
const PROTECTED_PATH_SET: ReadonlySet<string> = new Set(PROTECTED_PATHS);
const MAX_DYNAMIC_PAYMENT_MIDDLEWARES = 128;
const dynamicPaymentMiddlewareCache = new Map<
  string,
  ReturnType<typeof paymentMiddleware>
>();
const SAFE_X402_GATEWAY_VALIDATION_CODES = new Set([
  'INVALID_X402_GATEWAY',
  'UNVERIFIED_X402_GATEWAY',
  'INVALID_X402_ASSET',
  'INVALID_X402_PRICE',
]);

const LIVE_FETCH_TIMEOUT_MS = 10_000;
const MAX_LIVE_JSON_BYTES = 32 * 1024 * 1024;

const discoveryOutputSchema = {
  properties: {
    status: { type: 'string', const: 'success' },
    data: { type: 'object' },
  },
  required: ['status', 'data'],
  additionalProperties: false,
} as const;

export const PREMIUM_BAZAAR_EXTENSIONS: Readonly<
  Record<PremiumPath, Record<string, unknown>>
> = Object.freeze({
  '/alpha-signals': declareDiscoveryExtension({
    output: {
      example: {
        status: 'success',
        data: {
          service: 'Kletia Premium Intelligence (DefiLlama)',
          alphaSignals: [],
          methodology:
            'Base-deployed protocols ranked by protocol-global positive 7-day TVL change.',
          source: 'https://api.llama.fi/protocols',
        },
      },
      schema: discoveryOutputSchema,
    },
  }),
  '/yield-strategy': declareDiscoveryExtension({
    output: {
      example: {
        status: 'success',
        data: {
          service: 'Kletia Premium Yield Observations',
          topYieldPools: [],
          methodology:
            'Base pools above the configured liquidity floor ranked by reported APY.',
          source: 'https://yields.llama.fi/pools',
        },
      },
      schema: discoveryOutputSchema,
    },
  }),
  '/sybil-report': declareDiscoveryExtension({
    input: {
      address: X402_PAYMENT_ADDRESS,
    },
    inputSchema: {
      properties: {
        address: {
          type: 'string',
          pattern: '^0x[a-fA-F0-9]{40}$',
          description: 'Base mainnet wallet address to analyze.',
        },
      },
      required: ['address'],
      additionalProperties: false,
    },
    output: {
      example: {
        status: 'success',
        data: {
          service: 'Kletia Premium Sybil Heuristic',
          address: X402_PAYMENT_ADDRESS,
          diagnosis: 'INSUFFICIENT_ACTIVITY',
          activityCompleteness: 'complete',
          source: 'https://base.blockscout.com/api',
        },
      },
      schema: discoveryOutputSchema,
    },
  }),
});

const PREMIUM_DESCRIPTIONS: Readonly<Record<PremiumPath, string>> = {
  '/alpha-signals':
    'Live Base protocol-growth observations sourced from DefiLlama.',
  '/yield-strategy':
    'Live Base yield-pool observations with liquidity and risk caveats.',
  '/sybil-report':
    'Deterministic Base wallet-activity heuristic sourced from Blockscout.',
};

async function fetchLiveResponse(
  url: string,
  source: string,
  init?: RequestInit,
  acceptedStatuses: ReadonlySet<number> = new Set(),
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    LIVE_FETCH_TIMEOUT_MS,
  );
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
    });
    if (!response.ok && !acceptedStatuses.has(response.status)) {
      throw new Error(`${source} returned HTTP ${response.status}.`);
    }
    return response;
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      throw new Error(`${source} timed out.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchLiveJson(url: string, source: string): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    LIVE_FETCH_TIMEOUT_MS,
  );
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`${source} returned HTTP ${response.status}.`);
    }
    const declaredLength = Number(
      response.headers.get('content-length'),
    );
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > MAX_LIVE_JSON_BYTES
    ) {
      throw new Error(`${source} exceeded the safe response size.`);
    }
    if (!response.body) {
      throw new Error(`${source} returned an empty response.`);
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_LIVE_JSON_BYTES) {
        await reader.cancel();
        throw new Error(`${source} exceeded the safe response size.`);
      }
      chunks.push(value);
    }
    const text = Buffer.concat(
      chunks.map((chunk) => Buffer.from(chunk)),
    ).toString('utf8');
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`${source} returned invalid JSON.`);
    }
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      throw new Error(`${source} timed out.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function buildProtectedX402RouteConfig(
  routeKey: string,
  payTo: Address,
  priceAtomic: string,
): Record<string, RouteConfig> {
  const normalizedPayTo = getAddress(payTo);
  const normalizedPriceAtomic = BigInt(priceAtomic);
  if (
    normalizedPriceAtomic <= 0n ||
    normalizedPriceAtomic > X402_MAX_PRICE_ATOMIC
  ) {
    throw Object.assign(
      new Error('x402 payment amount is outside the configured policy.'),
      { code: 'INVALID_X402_PRICE', statusCode: 400 },
    );
  }
  const routeMatch = /^GET (\/[a-z-]+)$/.exec(routeKey);
  const path = routeMatch?.[1];
  if (!path || !PROTECTED_PATH_SET.has(path)) {
    throw Object.assign(
      new Error('x402 route is outside the protected Base resource policy.'),
      { code: 'INVALID_X402_ROUTE', statusCode: 400 },
    );
  }
  const isPremiumPath = PREMIUM_PATHS.includes(path as PremiumPath);
  const extensions = isPremiumPath
    ? PREMIUM_BAZAAR_EXTENSIONS[path as PremiumPath]
    : undefined;

  const routeConfig: RouteConfig = {
    accepts: [{
      scheme: 'exact',

      price: {
        amount: normalizedPriceAtomic.toString(),
        asset: BASE_USDC,
        extra: {
          name: 'USD Coin',
          version: '2',
        },
      },
      network: 'eip155:8453',
      payTo: normalizedPayTo,
    }],
    description: isPremiumPath
      ? PREMIUM_DESCRIPTIONS[path as PremiumPath]
      : 'Owner-controlled Kletia x402 gateway verification demo.',
    mimeType: 'application/json',
    serviceName: 'Kletia Intent Intelligence',
    tags: isPremiumPath
      ? ['base', 'defi', 'intent', 'live-data']
      : ['base', 'x402', 'gateway-demo'],
    ...(extensions ? { extensions } : {}),
  };
  return {
    [routeKey]: routeConfig,
  };
}

function resolvedPaymentMiddleware(
  routeKey: string,
  payTo: Address,
  priceAtomic: string,
) {
  const cacheKey =
    `${routeKey}|${payTo.toLowerCase()}|${priceAtomic}`;
  const cached = dynamicPaymentMiddlewareCache.get(cacheKey);
  if (cached) {

    dynamicPaymentMiddlewareCache.delete(cacheKey);
    dynamicPaymentMiddlewareCache.set(cacheKey, cached);
    return cached;
  }

  const routesConfig = buildProtectedX402RouteConfig(
    routeKey,
    payTo,
    priceAtomic,
  );
  const middleware = paymentMiddleware(
    routesConfig,
    getOfficialCdpResourceServer(),
  );
  dynamicPaymentMiddlewareCache.set(cacheKey, middleware);
  if (
    dynamicPaymentMiddlewareCache.size >
    MAX_DYNAMIC_PAYMENT_MIDDLEWARES
  ) {
    const oldest = dynamicPaymentMiddlewareCache.keys().next().value;
    if (oldest) dynamicPaymentMiddlewareCache.delete(oldest);
  }
  return middleware;
}

const dynamicX402Middleware = async (req: express.Request, res: express.Response, next: express.NextFunction) => {

  if (!PROTECTED_PATH_SET.has(req.path)) {
    return next();
  }
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({
      status: 'error',
      code: 'METHOD_NOT_ALLOWED',
      message: 'Paid x402 resources accept GET only.',
    });
  }

  if (!readOfficialCdpX402Credentials()) {
    return res.status(503).json({
      status: 'unavailable',
      code: 'X402_FACILITATOR_NOT_CONFIGURED',
      message: 'x402 facilitator kimlik bilgileri yapılandırılmamış.',
    });
  }
  if (req.query.price !== undefined) {
    return res.status(400).json({
      status: 'error',
      code: 'CLIENT_PRICE_FORBIDDEN',
      message: 'x402 fiyatı istemci tarafından belirlenemez.',
    });
  }

  try {
    const isGatewayDemo = req.path === GATEWAY_DEMO_PATH;
    if (!isGatewayDemo && req.query.gateway !== undefined) {
      return res.status(400).json({
        status: 'error',
        code: 'CLIENT_GATEWAY_FORBIDDEN',
        message:
          'Kletia premium endpoints do not accept a client-selected payment receiver.',
      });
    }
    if (isGatewayDemo && req.query.gateway === undefined) {
      return res.status(400).json({
        status: 'error',
        code: 'GATEWAY_REQUIRED',
        message: 'gateway is required for the owner-controlled demo endpoint.',
      });
    }

    const resolved = isGatewayDemo
      ? await verifiedGatewayPayment(req.query.gateway)
      : {
          payTo: X402_PAYMENT_ADDRESS,
          price: DEFAULT_PRICE,
          priceAtomic: DEFAULT_PRICE_ATOMIC.toString(),
        };
    console.log(
      `💰 x402 REQUEST: ${req.method} ${req.path} → payTo=${resolved.payTo}, amount=${resolved.priceAtomic}`,
    );

    const routeKey = `${req.method} ${req.path}`;
    const mw = resolvedPaymentMiddleware(
      routeKey,
      resolved.payTo,
      resolved.priceAtomic,
    );
    return mw(req, res, next);
  } catch (error: any) {
    const statusCode = Number(error?.statusCode) || 502;
    const code =
      typeof error?.code === 'string'
        ? error.code
        : 'X402_GATEWAY_LOOKUP_FAILED';
    return res.status(statusCode).json({
      status: 'error',
      code,
      message:
        statusCode === 400 &&
        SAFE_X402_GATEWAY_VALIDATION_CODES.has(code)
          ? error.message
          : 'Gateway Base Mainnet üzerinde doğrulanamadı.',
    });
  }
};

router.get('/debug-x402', async (req, res) => {
  if (
    process.env.NODE_ENV === 'production' &&
    process.env.ENABLE_X402_DEBUG !== 'true'
  ) {
    return res.status(404).json({
      success: false,
      code: 'NOT_FOUND',
      error: 'Resource not found.',
    });
  }
  try {
    if (!readOfficialCdpX402Credentials()) {
      return res.status(503).json({
        success: false,
        code: 'X402_FACILITATOR_NOT_CONFIGURED',
        error: 'Official CDP x402 facilitator credentials are unavailable.',
      });
    }
    const resolved = await verifiedGatewayPayment(req.query.gateway);
    const query = new URLSearchParams({ gateway: resolved.payTo });
    const targetUrl =
      `http://127.0.0.1:${process.env.PORT || 3001}` +
      `/api/premium${GATEWAY_DEMO_PATH}?${query.toString()}`;

    const response = await fetchLiveResponse(
      targetUrl,
      'Local x402 debug',
      {
        headers: {
          Accept: 'application/json',
          'X-Kletia-Network': 'base',
          'X-Kletia-Chain-Id': '8453',
        },
      },
      new Set([402]),
    );

    const headersObj: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headersObj[key] = value;
    });

    const paymentRequiredRaw = response.headers.get('PAYMENT-REQUIRED');
    let decoded = null;
    if (paymentRequiredRaw) {
      try {
        decoded = JSON.parse(Buffer.from(paymentRequiredRaw, 'base64').toString('utf8'));
      } catch(e) {
        decoded = { parseError: String(e) };
      }
    }

    res.status(200).json({
      success: response.status === 402,
      message: "x402 Debug Engine Active",
      x402_status: response.status,
      x402_headers: headersObj,
      payTo_used: resolved.payTo,
      decoded_payment_required: decoded
    });
  } catch (err: any) {
    const statusCode = Number(err?.statusCode) || 502;
    const code =
      typeof err?.code === 'string'
        ? err.code
        : 'X402_DEBUG_FAILED';
    res.status(statusCode).json({
      success: false,
      code,
      error:
        statusCode === 400 &&
        SAFE_X402_GATEWAY_VALIDATION_CODES.has(code)
          ? err.message
          : 'x402 gateway debug could not be completed.',
    });
  }
});

router.get('/x402-config', (req, res) => {
  res.json({
    status: "success",
    data: {
      network: "eip155:8453",
      networkName: "Base Mainnet",
      scheme: "exact",
      defaultPayTo: X402_PAYMENT_ADDRESS,
      defaultPrice: DEFAULT_PRICE,
      facilitator: CDP_FACILITATOR_URL,
      facilitatorClient: 'official_coinbase_cdp_sdk',
      discoveryExtension: 'bazaar_v2',
      discoverableEndpoints: PREMIUM_PATHS,
      premiumEndpoints: PREMIUM_PATHS,
      gatewayDemoEndpoint: GATEWAY_DEMO_PATH,
      gatewayFactory: X402_FACTORY_ADDRESS,
      maxGatewayDemoPriceAtomic: X402_MAX_PRICE_ATOMIC.toString(),
      usdc: BASE_USDC,
    }
  });
});

async function buildGatewayDemoSnapshot() {
  const [chainId, block] = await Promise.all([
    basePublicClient.getChainId(),
    basePublicClient.getBlock({ blockTag: 'latest' }),
  ]);
  if (chainId !== 8453 || !block.hash) {
    throw new Error('Base RPC returned an invalid live network snapshot.');
  }
  return {
    service: 'Kletia x402 Gateway Demo',
    network: 'base',
    chainId,
    latestBlockNumber: block.number.toString(),
    latestBlockHash: block.hash,
    latestBlockTimestamp: block.timestamp.toString(),
    source: 'base_rpc',
  };
}

async function buildAlphaSnapshot() {
  const protocols = await fetchLiveJson(
    'https://api.llama.fi/protocols',
    'DefiLlama protocols',
  );
  if (!Array.isArray(protocols)) {
    throw new Error('DefiLlama protocols returned an invalid payload.');
  }
  const topGrowers = protocols
    .filter(
      (protocol: any) =>
        (protocol.chain === 'Base' ||
          (Array.isArray(protocol.chains) &&
            protocol.chains.includes('Base'))) &&
        Number.isFinite(Number(protocol.tvl)) &&
        Number(protocol.tvl) > 1_000_000 &&
        Number.isFinite(Number(protocol.change_7d)) &&
        Number(protocol.change_7d) > 0,
    )
    .sort(
      (left: any, right: any) =>
        Number(right.change_7d) - Number(left.change_7d),
    )
    .slice(0, 3)
    .map((protocol: any) => {
      const protocolGlobalChange7dPercent = Number(protocol.change_7d);
      return {
        token: String(protocol.symbol || protocol.name || 'Unknown'),
        name: String(protocol.name || protocol.symbol || 'Unknown'),
        deployedOnBase: true,
        metricScope: 'protocol_global',
        protocolGlobalTvlUsd: Number(protocol.tvl),
        protocolGlobalChange7dPercent,
        observation:
          protocolGlobalChange7dPercent > 20
            ? 'HIGH_GLOBAL_7D_TVL_GROWTH'
            : 'POSITIVE_GLOBAL_7D_TVL_GROWTH',
      };
    });
  return {
    service: 'Kletia Premium Intelligence (DefiLlama)',
    alphaSignals: topGrowers,
    methodology:
      'Protocols deployed on Base with protocol-global TVL above $1m, ranked by protocol-global positive 7-day TVL change. These are not Base-deployment-only metrics or trade recommendations.',
    source: 'https://api.llama.fi/protocols',
    timestamp: Date.now(),
  };
}

async function buildYieldSnapshot() {
  const payload = await fetchLiveJson(
    'https://yields.llama.fi/pools',
    'DefiLlama yields',
  );
  if (!Array.isArray(payload?.data)) {
    throw new Error('DefiLlama yields returned an invalid payload.');
  }
  const topPools = payload.data
    .filter(
      (pool: any) =>
        pool.chain === 'Base' &&
        Number.isFinite(Number(pool.tvlUsd)) &&
        Number(pool.tvlUsd) > 1_000_000 &&
        Number.isFinite(Number(pool.apy)) &&
        Number(pool.apy) >= 0,
    )
    .sort(
      (left: any, right: any) => Number(right.apy) - Number(left.apy),
    )
    .slice(0, 3)
    .map((pool: any) => ({
      project: String(pool.project || 'Unknown'),
      symbol: String(pool.symbol || 'Unknown'),
      apyPercent: Number(pool.apy),
      tvlUsd: Number(pool.tvlUsd),
      poolId: typeof pool.pool === 'string' ? pool.pool : null,
    }));
  return {
    service: 'Kletia Premium Yield Observations',
    topYieldPools: topPools,
    methodology:
      'Base pools above $1m TVL ranked by reported APY. Values are live observations, not guaranteed yield or investment advice.',
    source: 'https://yields.llama.fi/pools',
    timestamp: Date.now(),
  };
}

async function buildSybilSnapshot(address: Address) {
  const query = new URLSearchParams({
    module: 'account',
    action: 'txlist',
    address,
    startblock: '0',
    endblock: '99999999',
    page: '1',
    offset: '10000',
    sort: 'asc',
  });
  const txData = await fetchLiveJson(
    `https://base.blockscout.com/api?${query.toString()}`,
    'Base Blockscout',
  );
  const noTransactions =
    txData?.status === '0' &&
    /no (transactions|records) found/i.test(
      String(txData?.message || txData?.result || ''),
    );
  if (
    !noTransactions &&
    (txData?.status !== '1' || !Array.isArray(txData.result))
  ) {
    throw new Error('Base Blockscout returned an invalid transaction list.');
  }
  const normalTxs: any[] = noTransactions ? [] : txData.result;
  const transactionLimit = 10_000;
  const complete = normalTxs.length < transactionLimit;
  const baseLaunchTimestamp = 1_691_539_200_000;
  let firstTxTimestamp: number | null = null;
  const activeDaysSet = new Set<string>();
  const txCountsByDay: Record<string, number> = {};

  for (const transaction of normalTxs) {
    const seconds = Number(transaction.timeStamp);
    if (!Number.isFinite(seconds) || seconds < 0) {
      throw new Error('Base Blockscout returned an invalid timestamp.');
    }
    const timestamp = seconds * 1_000;
    if (firstTxTimestamp === null || timestamp < firstTxTimestamp) {
      firstTxTimestamp = timestamp;
    }
    const date = new Date(timestamp);
    if (!Number.isFinite(date.getTime())) {
      throw new Error('Base Blockscout returned an invalid date.');
    }
    const dateKey = date.toISOString().split('T')[0];
    activeDaysSet.add(dateKey);
    txCountsByDay[dateKey] = (txCountsByDay[dateKey] || 0) + 1;
  }
  if (
    firstTxTimestamp !== null &&
    firstTxTimestamp < baseLaunchTimestamp
  ) {
    firstTxTimestamp = baseLaunchTimestamp;
  }
  const walletAgeDays =
    firstTxTimestamp === null
      ? null
      : Math.max(
          0,
          Math.floor((Date.now() - firstTxTimestamp) / 86_400_000),
        );
  const activeDays = activeDaysSet.size;
  const counts = Object.values(txCountsByDay);
  const mean = counts.length
    ? counts.reduce((sum, count) => sum + count, 0) / counts.length
    : 0;
  const variance = counts.length
    ? counts.reduce(
        (sum, count) => sum + Math.pow(count - mean, 2),
        0,
      ) / counts.length
    : 0;
  let diagnosis = 'LOW_HEURISTIC_SIGNAL';
  if (normalTxs.length === 0) {
    diagnosis = 'INSUFFICIENT_ACTIVITY';
  } else if (!complete) {
    diagnosis = 'INDETERMINATE_PARTIAL_DATA';
  } else if (variance > 50 && activeDays < 5) {
    diagnosis = 'HIGH_HEURISTIC_SIGNAL';
  } else if (variance > 20 && activeDays < 10) {
    diagnosis = 'MEDIUM_HEURISTIC_SIGNAL';
  }

  return {
    service: 'Kletia Premium Sybil Heuristic',
    address,
    walletAgeDays,
    activeDaysCount: activeDays,
    transactionDistributionVariance: Number(variance.toFixed(2)),
    transactionsAnalyzed: normalTxs.length,
    activityCompleteness: complete ? 'complete' : 'partial_capped',
    transactionLimit,
    diagnosis,
    methodology:
      'Deterministic activity heuristic over Base Blockscout normal transactions; it is not proof of identity or misconduct.',
    source: 'https://base.blockscout.com/api',
    timestamp: Date.now(),
  };
}

router.use((req, res, next) => {
  if (req.path !== '/sybil-report') return next();
  try {
    res.locals.sybilAddress = getAddress(String(req.query.address || ''));
    return next();
  } catch {
    return res.status(400).json({
      status: 'error',
      code: 'INVALID_ADDRESS',
      message: 'A valid Base wallet address is required.',
    });
  }
});

router.use((req, res, next) => {
  if (!PROTECTED_PATH_SET.has(req.path)) return next();
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({
      status: 'error',
      code: 'METHOD_NOT_ALLOWED',
      message: 'Paid x402 resources accept GET only.',
    });
  }
  if (!readOfficialCdpX402Credentials()) {
    return res.status(503).json({
      status: 'unavailable',
      code: 'X402_FACILITATOR_NOT_CONFIGURED',
      message: 'x402 facilitator kimlik bilgileri yapılandırılmamış.',
    });
  }
  if (req.query.price !== undefined) {
    return res.status(400).json({
      status: 'error',
      code: 'CLIENT_PRICE_FORBIDDEN',
      message: 'x402 fiyatı istemci tarafından belirlenemez.',
    });
  }

  const isGatewayDemo = req.path === GATEWAY_DEMO_PATH;
  if (!isGatewayDemo && req.query.gateway !== undefined) {
    return res.status(400).json({
      status: 'error',
      code: 'CLIENT_GATEWAY_FORBIDDEN',
      message:
        'Kletia premium endpoints do not accept a client-selected payment receiver.',
    });
  }
  if (isGatewayDemo && req.query.gateway === undefined) {
    return res.status(400).json({
      status: 'error',
      code: 'GATEWAY_REQUIRED',
      message: 'gateway is required for the owner-controlled demo endpoint.',
    });
  }
  return next();
});

router.use(async (req, res, next) => {
  if (
    !PROTECTED_PATH_SET.has(req.path) ||
    req.method !== 'GET' ||
    !readOfficialCdpX402Credentials()
  ) {
    return next();
  }
  try {
    if (req.path === GATEWAY_DEMO_PATH) {
      res.locals.premiumSnapshot = await buildGatewayDemoSnapshot();
    } else if (req.path === '/alpha-signals') {
      res.locals.premiumSnapshot = await buildAlphaSnapshot();
    } else if (req.path === '/yield-strategy') {
      res.locals.premiumSnapshot = await buildYieldSnapshot();
    } else if (req.path === '/sybil-report') {
      res.locals.premiumSnapshot = await buildSybilSnapshot(
        res.locals.sybilAddress as Address,
      );
    }
    return next();
  } catch (error) {
    console.error(
      `[PREMIUM PREFLIGHT] ${req.path}`,
      error instanceof Error ? error.name : 'LIVE_DATA_ERROR',
    );
    return res.status(502).json({
      status: 'error',
      code: 'LIVE_DATA_UNAVAILABLE',
      message:
        'The paid resource could not be prepared from verified live data; no x402 payment was requested.',
    });
  }
});

router.use((req, res, next) => {
  if (PROTECTED_PATH_SET.has(req.path)) {
    console.log(
      `📡 x402 DEBUG: ${req.method} ${req.path} | ` +
      `gateway=${req.query.gateway === undefined ? 'default' : 'provided'} | ` +
      `hasPayment=${Boolean(req.headers['x-payment'] || req.headers['payment-signature'])}`,
    );
  }
  next();
});

router.use(dynamicX402Middleware);

router.get(GATEWAY_DEMO_PATH, (_req, res) => {
  return res.json({
    status: 'success',
    data: res.locals.premiumSnapshot,
  });
});

router.get('/alpha-signals', (_req, res) => {
  return res.json({
    status: 'success',
    data: res.locals.premiumSnapshot,
  });
});

router.get('/optimal-routes', (_req, res) => {
  res.status(501).json({
    status: "unavailable",
    code: "LIVE_QUOTE_REQUIRED",
    message:
      "No live quote provider was configured for this endpoint. Kletia will not return a fabricated route.",
  });
});

router.get('/route-solver', (_req, res) => {
  res.status(501).json({
    status: "unavailable",
    code: "VERIFIED_ARBITRAGE_REQUIRED",
    message:
      "No atomic, simulated arbitrage opportunity is currently available. Kletia will not return placeholder calldata or guaranteed-profit claims.",
  });
});

router.get('/yield-strategy', (_req, res) => {
  return res.json({
    status: 'success',
    data: res.locals.premiumSnapshot,
  });
});

router.get('/sybil-report', (_req, res) => {
  return res.json({
    status: 'success',
    data: res.locals.premiumSnapshot,
  });
});

export default router;
