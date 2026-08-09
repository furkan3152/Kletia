
import express from 'express';
import cors, { type CorsOptions } from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { parseUserIntent, type ParsedIntent } from './ai/parser.js';
import {
  resolveIntentEntities,
  type EntityClarification,
  type IntentEntityResolutionEvidence,
} from './assets/resolver.js';
import { executeKletiaEngine } from './intent/engine.js';
import { executeArcEngine } from './intent/arcEngine.js';
import { createVerifiedIntentResultEnvelope } from './intent/responseEnvelope.js';
import {
  RequestIdValidationError,
  requireIntentRequestId,
  resolveIntentRequestId,
} from './security/requestId.js';
import { resolveIntentPublicError } from './security/intentError.js';
import premiumRoutes from './routes/premiumRoutes.js';
import { agentRoutes } from './agent/index.js';
import {
  validateAddress,
  sanitizePrompt,
} from './middleware/security.js';
import jwt, { type JwtHeader } from 'jsonwebtoken';
import alloraRoutes from './routes/allora.js';
import paymasterRoutes from './routes/paymaster.js';
import webacyRoutes from './routes/webacy.js';
import arcRoutes from './routes/arcRoutes.js';
import baseRoutes from './routes/baseRoutes.js';
import baseMcpRoutes from './routes/baseMcpRoutes.js';
import baseX402BuyerRoutes from './routes/baseX402BuyerRoutes.js';
import { createServer } from 'http';
import { randomUUID } from 'crypto';
import { pathToFileURL } from 'url';
import { getAddress, zeroAddress } from 'viem';
import { resolveBasenameEvidence } from './intent/utils.js';
import {
  NETWORKS,
  NETWORK_CLIENTS,
  getPublicNetworkDescriptor,
  type NetworkId,
} from './config/networks.js';
import {
  requireArcNetwork,
  requireBaseNetwork,
  requireFixedBaseNetwork,
  requireIntentNetwork,
} from './middleware/network.js';

(BigInt.prototype as any).toJSON = function () {
    return this.toString();
};

const app = express();
const parsedPort = Number(process.env.PORT || 3001);
if (!Number.isSafeInteger(parsedPort) || parsedPort < 1 || parsedPort > 65_535) {
  throw new Error('PORT must be an integer between 1 and 65535.');
}
const PORT = parsedPort;

function resolveTrustProxyHops() {
  const configured = process.env.TRUST_PROXY_HOPS?.trim();
  const raw = configured || (process.env.NODE_ENV === 'production' ? '1' : '0');
  if (!/^\d$/u.test(raw) || Number(raw) > 3) {
    throw new Error('TRUST_PROXY_HOPS must be an integer between 0 and 3.');
  }
  return Number(raw);
}

const trustProxyHops = resolveTrustProxyHops();
app.set('trust proxy', trustProxyHops === 0 ? false : trustProxyHops);

app.use(helmet());
const builtInOrigins = [
  'https://kletia.com',
  'https://www.kletia.com',
  'https://kletiaai.xyz',
  'https://www.kletiaai.xyz',
  'https://kletia-frontend.onrender.com',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:5174',
  'http://127.0.0.1:5174',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
];
const configuredOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
export const allowedOrigins = [
  ...new Set([...builtInOrigins, ...configuredOrigins]),
];

const corsOptions: CorsOptions = {
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error(`CORS origin is not allowed: ${origin}`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type', 'Authorization',
    'X-PAYMENT', 'PAYMENT-SIGNATURE',
    'PAYMENT-REQUIRED', 'PAYMENT-RESPONSE',
    'Access-Control-Expose-Headers',
    'X-Kletia-Network', 'X-Kletia-Chain-Id', 'X-Request-Id'
  ],
  exposedHeaders: [
    'WWW-Authenticate',
    'PAYMENT-REQUIRED', 'PAYMENT-RESPONSE',
    'X-PAYMENT-RESPONSE'
  ]
};
app.use(cors(corsOptions));
app.use(express.json());

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, 
  max: 100, 
  message: { status: 'error', message: 'Too many requests. Please try again later.' }
});

const premiumLimiter = rateLimit({
  windowMs: 60 * 1000, 
  max: 10, 
  message: { status: 'error', message: 'You have exceeded the rate limit for premium routes.' }
});

const onrampLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    success: false,
    code: 'ONRAMP_RATE_LIMITED',
    message: 'Onramp istek limiti aşıldı. Lütfen daha sonra tekrar deneyin.',
  },
});

app.use('/api/', limiter);
app.use('/api/premium', premiumLimiter, requireFixedBaseNetwork, premiumRoutes);
app.use('/api/agent', requireBaseNetwork, agentRoutes);
app.use('/api/allora', requireBaseNetwork, alloraRoutes);
app.use('/api/paymaster', requireFixedBaseNetwork, paymasterRoutes);
app.use('/api/webacy', webacyRoutes);
app.use('/api/arc', requireArcNetwork, arcRoutes);
app.use(
  '/api/base/x402-buyer',
  requireBaseNetwork,
  baseX402BuyerRoutes,
);
app.use('/api/base', requireBaseNetwork, baseRoutes);
app.use('/api/base-mcp', requireBaseNetwork, baseMcpRoutes);

app.get('/api/networks', (_req, res) => {
  res.json({
    success: true,
    defaultNetwork: 'base',
    networks: Object.values(NETWORKS).map(getPublicNetworkDescriptor),
  });
});

type NetworkHealthCheck = {
  network: NetworkId;
  chainId: number | null;
  expectedChainId: number;
  blockNumber?: string;
  status: 'ok' | 'chain_mismatch' | 'unreachable';
  checkedAt: number;
  error?: string;
};

const NETWORK_HEALTH_TTL_MS = 10_000;
const NETWORK_HEALTH_TIMEOUT_MS = 7_000;
const networkHealthCache = new Map<
  NetworkId,
  { expiresAt: number; value: NetworkHealthCheck }
>();
const networkHealthInFlight = new Map<NetworkId, Promise<NetworkHealthCheck>>();

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('rpc_timeout')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readNetworkHealth(
  network: NetworkId,
  force = false,
): Promise<NetworkHealthCheck> {
  const cached = networkHealthCache.get(network);
  if (!force && cached && cached.expiresAt > Date.now()) return cached.value;
  const existing = networkHealthInFlight.get(network);
  if (existing) return existing;

  const check = (async () => {
    const config = NETWORKS[network];
    let value: NetworkHealthCheck;
    try {
      const [chainId, blockNumber] = await withDeadline(
        Promise.all([
          NETWORK_CLIENTS[network].getChainId(),
          NETWORK_CLIENTS[network].getBlockNumber(),
        ]),
        NETWORK_HEALTH_TIMEOUT_MS,
      );
      value = {
        network,
        chainId,
        expectedChainId: config.chainId,
        blockNumber: blockNumber.toString(),
        status: chainId === config.chainId ? 'ok' : 'chain_mismatch',
        checkedAt: Date.now(),
      };
    } catch (error: any) {
      console.error('[HEALTH RPC CHECK FAILED]', {
        network,
        code: typeof error?.code === 'string' ? error.code : 'RPC_ERROR',
      });
      value = {
        network,
        chainId: null,
        expectedChainId: config.chainId,
        status: 'unreachable',
        checkedAt: Date.now(),
        error: 'RPC health check failed.',
      };
    }
    networkHealthCache.set(network, {
      expiresAt: Date.now() + NETWORK_HEALTH_TTL_MS,
      value,
    });
    return value;
  })().finally(() => networkHealthInFlight.delete(network));

  networkHealthInFlight.set(network, check);
  return check;
}

app.get('/health', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  return res.json({
    success: true,
    status: 'alive',
    service: 'kletia-omni-engine',
  });
});

app.get(['/api/health/base', '/api/health/arc'], async (req, res) => {
  const network: NetworkId = req.path.endsWith('/arc') ? 'arc' : 'base';
  const check = await readNetworkHealth(network);
  res.setHeader('Cache-Control', 'no-store');
  return res.status(check.status === 'ok' ? 200 : 503).json({
    success: check.status === 'ok',
    status: check.status === 'ok' ? 'ready' : 'unavailable',
    service: 'kletia-omni-engine',
    check,
  });
});

app.get('/api/health', async (_req, res) => {
  const checks = await Promise.all(
    (Object.keys(NETWORKS) as NetworkId[]).map((network) =>
      readNetworkHealth(network),
    ),
  );
  const readyCount = checks.filter((check) => check.status === 'ok').length;
  const fullyReady = readyCount === checks.length;
  res.setHeader('Cache-Control', 'no-store');
  return res.status(readyCount > 0 ? 200 : 503).json({
    success: readyCount > 0,
    status: fullyReady ? 'ready' : readyCount > 0 ? 'degraded' : 'unavailable',
    service: 'kletia-omni-engine',
    checks,
  });
});

app.post(
  '/api/intent/revalidate-recipient',
  requireIntentNetwork,
  async (req, res) => {
    const network = req.kletiaNetwork!;
    let requestId: string;
    try {
      requestId = resolveIntentRequestId(
        req.body?.requestId,
        req.body?.msgId,
        randomUUID,
      );
    } catch (error) {
      if (error instanceof RequestIdValidationError) {
        return res.status(error.statusCode).json({
          success: false,
          code: error.code,
          message: error.message,
          network: network.id,
          chainId: network.chainId,
        });
      }
      throw error;
    }

    const name = typeof req.body?.name === 'string'
      ? req.body.name.trim().toLowerCase()
      : '';
    if (
      name.length < 6 ||
      name.length > 80 ||
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.base(?:\.eth)?$/u
        .test(name)
    ) {
      return res.status(400).json({
        success: false,
        code: 'INVALID_BASENAME',
        message: 'Yeniden doğrulanacak alıcı geçerli bir .base veya .base.eth adı olmalıdır.',
        network: network.id,
        chainId: network.chainId,
        requestId,
      });
    }

    let expectedAddress;
    let userAddress;
    try {
      expectedAddress = getAddress(String(req.body?.expectedAddress || ''));
      userAddress = getAddress(String(req.body?.userAddress || ''));
      if (expectedAddress === zeroAddress || userAddress === zeroAddress) {
        throw new Error('zero_address');
      }
    } catch {
      return res.status(400).json({
        success: false,
        code: 'INVALID_REVALIDATION_ADDRESS',
        message: 'Beklenen alıcı ve aktif cüzdan geçerli, sıfır olmayan EVM adresleri olmalıdır.',
        network: network.id,
        chainId: network.chainId,
        requestId,
      });
    }

    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const evidence = await Promise.race([
        resolveBasenameEvidence(name),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('basename_revalidation_timeout')),
            8_000,
          );
        }),
      ]).finally(() => {
        if (timer) clearTimeout(timer);
      });
      if (!evidence) {
        return res.status(409).json({
          success: false,
          code: 'BASENAME_UNRESOLVED',
          message: 'Basename imzadan hemen önce yeniden çözümlenemedi; işlem planı kullanılmadı.',
          network: network.id,
          chainId: network.chainId,
          requestId,
          userAddress,
        });
      }
      if (evidence.address !== expectedAddress) {
        return res.status(409).json({
          success: false,
          code: 'BASENAME_RECORD_CHANGED',
          message: 'Basename adres kaydı plan oluşturulduktan sonra değişti; yeni niyet oluşturulmalıdır.',
          network: network.id,
          chainId: network.chainId,
          requestId,
          userAddress,
        });
      }
      return res.json({
        success: true,
        status: 'resolved',
        network: network.id,
        chainId: network.chainId,
        requestId,
        userAddress,
        recipientResolution: {
          role: 'recipient',
          originalReference: name,
          resolvedAddress: evidence.address,
          matchedBy: 'basename',
          basename: evidence.name,
          resolver: evidence.resolver,
          observedAtBlock: evidence.observedAtBlock,
          observedAt: evidence.observedAt,
          expiresAt: evidence.expiresAt,
          crossNetworkIdentity: network.id !== 'base',
        },
      });
    } catch {
      return res.status(503).json({
        success: false,
        code: 'BASENAME_REVALIDATION_UNAVAILABLE',
        message: 'Basename yeniden doğrulaması tamamlanamadı; işlem gönderilmedi.',
        network: network.id,
        chainId: network.chainId,
        requestId,
        userAddress,
      });
    }
  },
);

interface ConversationSession {
  network: 'base' | 'arc';
  userAddress: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  lastAccess: number;
  pendingResolution?: {
    intent: ParsedIntent;
    originalPrompt: string;
    clarification: EntityClarification;
    expiresAt: number;
  };
}

const conversationSessions = new Map<string, ConversationSession>();
const CONVERSATION_TTL_MS = 15 * 60 * 1000;
const PENDING_RESOLUTION_TTL_MS = 5 * 60 * 1000;
const MAX_CONVERSATION_SESSIONS = 1_000;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const memoryCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [conversationId, session] of conversationSessions) {
    if (now - session.lastAccess > CONVERSATION_TTL_MS) {
      conversationSessions.delete(conversationId);
    }
  }
}, 5 * 60 * 1000);
memoryCleanupTimer.unref();

const MAX_ONRAMP_RESPONSE_BYTES = 64 * 1024;
const MAX_ONRAMP_TOKEN_LENGTH = 16 * 1024;

app.post(
  '/api/onramp-token',
  onrampLimiter,
  requireFixedBaseNetwork,
  async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    try {
      const allowedBodyFields = new Set(['address', 'network', 'chainId']);
      if (
        !req.body ||
        typeof req.body !== 'object' ||
        Array.isArray(req.body) ||
        Object.keys(req.body).some((key) => !allowedBodyFields.has(key))
      ) {
        return res.status(400).json({
          success: false,
          code: 'INVALID_ONRAMP_REQUEST',
          message: 'Onramp isteği desteklenmeyen alan içeriyor.',
          network: 'base',
          chainId: NETWORKS.base.chainId,
        });
      }
      if (typeof req.body.address !== 'string') {
        return res.status(400).json({
          success: false,
          code: 'INVALID_ADDRESS',
          message: 'address alanı zorunludur.',
          network: 'base',
          chainId: NETWORKS.base.chainId,
        });
      }
      const destinationAddress = getAddress(req.body.address);

      const keyName = process.env.CDP_API_KEY_NAME?.trim();
      const keySecret = process.env.CDP_API_KEY_PRIVATE_KEY?.replace(/\\n/g, '\n');
      if (!keyName || !keySecret) {
        return res.status(503).json({
          success: false,
          code: 'ONRAMP_NOT_CONFIGURED',
          message: 'Coinbase onramp sunucu kimlik bilgileri yapılandırılmamış.',
          network: 'base',
          chainId: NETWORKS.base.chainId,
        });
      }

      const requestMethod = 'POST';
      const requestPath = '/onramp/v1/token';
      const jwtHeader: JwtHeader & { nonce: string } = {
        alg: 'ES256',
        kid: keyName,
        nonce: randomUUID(),
      };
      const authorizationToken = jwt.sign(
        {
          iss: 'cdp',
          nbf: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 120,
          sub: keyName,
          uri: `${requestMethod} api.developer.coinbase.com${requestPath}`,
        },
        keySecret,
        {
          algorithm: 'ES256',
          keyid: keyName,
          header: jwtHeader,
        },
      );

      const response = await fetch(
        `https://api.developer.coinbase.com${requestPath}`,
        {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            Authorization: `Bearer ${authorizationToken}`,
          },
          body: JSON.stringify({
            destination_wallets: [
              { address: destinationAddress, blockchains: ['base'] },
            ],
          }),
          signal: AbortSignal.timeout(12_000),
        },
      );

      const declaredLength = Number(response.headers.get('content-length'));
      if (
        Number.isFinite(declaredLength) &&
        declaredLength > MAX_ONRAMP_RESPONSE_BYTES
      ) {
        throw new Error('onramp_response_too_large');
      }
      const raw = await response.text();
      if (Buffer.byteLength(raw, 'utf8') > MAX_ONRAMP_RESPONSE_BYTES) {
        throw new Error('onramp_response_too_large');
      }
      let data: unknown;
      try {
        data = JSON.parse(raw);
      } catch {
        throw new Error('onramp_invalid_json');
      }

      if (!response.ok) {
        console.error('[CDP ONRAMP] Provider rejected token request:', {
          status: response.status,
        });
        return res.status(502).json({
          success: false,
          code: 'ONRAMP_PROVIDER_REJECTED',
          message: 'Coinbase onramp oturumu oluşturulamadı.',
          network: 'base',
          chainId: NETWORKS.base.chainId,
        });
      }
      const onrampToken =
        data && typeof data === 'object' && !Array.isArray(data)
          ? (data as Record<string, unknown>).token
          : undefined;
      if (
        typeof onrampToken !== 'string' ||
        onrampToken.length < 1 ||
        onrampToken.length > MAX_ONRAMP_TOKEN_LENGTH
      ) {
        throw new Error('onramp_invalid_token');
      }

      return res.json({
        success: true,
        status: 'success',
        token: onrampToken,
        network: 'base',
        chainId: NETWORKS.base.chainId,
      });
    } catch (error: any) {
      console.error('[CDP ONRAMP] Token request failed:', {
        name: error instanceof Error ? error.name : 'UnknownError',
        code: typeof error?.code === 'string' ? error.code : undefined,
      });
      const invalidAddress = error?.name === 'InvalidAddressError';
      const timedOut = error?.name === 'TimeoutError';
      const statusCode = invalidAddress ? 400 : timedOut ? 504 : 502;
      const code = invalidAddress
        ? 'INVALID_ADDRESS'
        : timedOut
          ? 'ONRAMP_PROVIDER_TIMEOUT'
          : 'ONRAMP_TOKEN_ERROR';
      const message = invalidAddress
        ? 'Geçersiz cüzdan adresi.'
        : timedOut
          ? 'Coinbase onramp zaman aşımına uğradı.'
          : 'Coinbase onramp oturumu güvenli biçimde doğrulanamadı.';
      return res.status(statusCode).json({
        success: false,
        code,
        message,
        network: 'base',
        chainId: NETWORKS.base.chainId,
      });
    }
  },
);

app.post(
  '/api/intent',
  requireIntentNetwork,
  requireIntentRequestId,
  validateAddress,
  sanitizePrompt,
  async (req, res) => {
    const { prompt, userAddress } = req.body;
    const network = req.kletiaNetwork!;
    const requestId = req.kletiaRequestId!;
    const responseMetadata = {
      network: network.id,
      chainId: network.chainId,
      requestId,
    };

    if (!prompt || !userAddress) {
      return res.status(400).json({
        success: false,
        code: 'INVALID_INTENT_REQUEST',
        error: 'prompt ve userAddress alanları zorunludur.',
        message: 'prompt ve userAddress alanları zorunludur.',
        ...responseMetadata,
      });
    }

    const suppliedConversationId = req.body.conversationId;
    if (
      suppliedConversationId !== undefined &&
      (typeof suppliedConversationId !== 'string' ||
        !UUID_V4_PATTERN.test(suppliedConversationId))
    ) {
      return res.status(400).json({
        success: false,
        code: 'INVALID_CONVERSATION_ID',
        error: 'conversationId geçersiz.',
        message: 'conversationId geçersiz.',
        ...responseMetadata,
      });
    }

    const suppliedClarificationSelection = req.body.clarificationSelection;
    if (
      suppliedClarificationSelection !== undefined &&
      (
        !suppliedClarificationSelection ||
        typeof suppliedClarificationSelection !== 'object' ||
        Array.isArray(suppliedClarificationSelection) ||
        typeof suppliedClarificationSelection.optionId !== 'string' ||
        suppliedClarificationSelection.optionId.length < 1 ||
        suppliedClarificationSelection.optionId.length > 160 ||
        Object.keys(suppliedClarificationSelection).some(
          (key) => key !== 'optionId',
        )
      )
    ) {
      return res.status(400).json({
        success: false,
        code: 'INVALID_CLARIFICATION_SELECTION',
        error: 'Token seçimi geçersiz.',
        message: 'Token seçimi geçersiz.',
        ...responseMetadata,
      });
    }

    console.log(
      `\n📡 [YENİ EMİR][${network.id}:${network.chainId}][${requestId}] ` +
      `promptLength=${String(prompt).length} wallet=${userAddress.substring(0, 6)}…`,
    );

    try {
      let conversationId =
        typeof suppliedConversationId === 'string'
          ? suppliedConversationId
          : null;
      let session = conversationId
        ? conversationSessions.get(conversationId)
        : undefined;
      if (
        session &&
        (Date.now() - session.lastAccess > CONVERSATION_TTL_MS ||
          (session.pendingResolution !== undefined &&
            Date.now() > session.pendingResolution.expiresAt) ||
          session.network !== network.id ||
          session.userAddress !== String(userAddress).toLowerCase())
      ) {
        conversationSessions.delete(conversationId!);
        session = undefined;
      }
      if (conversationId && !session) {
        return res.status(409).json({
          success: false,
          code: 'CONVERSATION_CONTEXT_INVALID',
          error: 'Konuşma bağlamı bulunamadı, süresi doldu veya cüzdan/ağ ile eşleşmedi.',
          message: 'Konuşma bağlamı bulunamadı, süresi doldu veya cüzdan/ağ ile eşleşmedi.',
          ...responseMetadata,
        });
      }

      const history = session ? [...session.history] : [];
      let parsedIntent: ParsedIntent;
      let resolutionPrompt = String(prompt);
      if (session?.pendingResolution) {
        const pending = session.pendingResolution;
        const field = pending.clarification.field;
        if (!field) {
          conversationSessions.delete(conversationId!);
          return res.status(409).json({
            success: false,
            code: 'CLARIFICATION_CONTEXT_INVALID',
            error: 'Token seçim bağlamı geçersiz.',
            message: 'Token seçim bağlamı geçersiz.',
            ...responseMetadata,
          });
        }
        const selectedOption = suppliedClarificationSelection
          ? pending.clarification.options.find(
              ({ id }) => id === suppliedClarificationSelection.optionId,
            )
          : undefined;
        if (suppliedClarificationSelection && !selectedOption) {
          return res.status(409).json({
            success: false,
            code: 'CLARIFICATION_OPTION_INVALID',
            error: 'Seçilen token bu bekleyen niyetin adayları arasında değil.',
            message: 'Seçilen token bu bekleyen niyetin adayları arasında değil.',
            ...responseMetadata,
          });
        }
        const selectedReference = selectedOption
          ? selectedOption.address || selectedOption.symbol
          : String(prompt).trim();
        parsedIntent = {
          ...pending.intent,
          [field]: selectedReference,
          isComplete: true,
        };
        resolutionPrompt = pending.originalPrompt;

        conversationSessions.delete(conversationId!);
        session = undefined;
      } else {
        if (suppliedClarificationSelection) {
          return res.status(409).json({
            success: false,
            code: 'CLARIFICATION_CONTEXT_REQUIRED',
            error: 'Token seçimi için geçerli ve bekleyen bir niyet gerekli.',
            message: 'Token seçimi için geçerli ve bekleyen bir niyet gerekli.',
            ...responseMetadata,
          });
        }
        parsedIntent = await parseUserIntent(prompt, history, network.id);
      }

      history.push({ role: 'user', content: prompt });
      history.push({
        role: 'assistant',
        content: parsedIntent.message || 'Anlaşıldı.',
      });
      console.log(
        `[PARSED INTENT][${network.id}:${network.chainId}][${requestId}] ` +
        `action=${parsedIntent.action} complete=${parsedIntent.isComplete}`,
      );
      if (!parsedIntent.isComplete) {
        if (!conversationId) {
          if (conversationSessions.size >= MAX_CONVERSATION_SESSIONS) {
            const oldest = conversationSessions.keys().next().value;
            if (oldest) conversationSessions.delete(oldest);
          }
          conversationId = randomUUID();
        }
        conversationSessions.set(conversationId, {
          network: network.id,
          userAddress: String(userAddress).toLowerCase(),
          history: history.slice(-6),
          lastAccess: Date.now(),
        });
        return res.json({
          success: false,
          status: 'question',
          requiresInput: true,
          question:
            parsedIntent.question ||
            parsedIntent.message ||
            'Biraz daha bilgi gerekli.',
          message: parsedIntent.message,
          conversationId,
          conversationExpiresAt: Date.now() + CONVERSATION_TTL_MS,
          userAddress: getAddress(userAddress),
          ...responseMetadata,
        });
      }

      const entityResolution = await resolveIntentEntities(
        parsedIntent,
        {
          network: network.id,
          userAddress,
          originalPrompt: resolutionPrompt,
          requestId,
        },
      );
      if (entityResolution.status === 'clarification') {
        if (!conversationId) {
          if (conversationSessions.size >= MAX_CONVERSATION_SESSIONS) {
            const oldest = conversationSessions.keys().next().value;
            if (oldest) conversationSessions.delete(oldest);
          }
          conversationId = randomUUID();
        }
        const conversationExpiresAt =
          Date.now() + PENDING_RESOLUTION_TTL_MS;
        conversationSessions.set(conversationId, {
          network: network.id,
          userAddress: String(userAddress).toLowerCase(),
          history: [],
          lastAccess: Date.now(),
          pendingResolution: {
            intent: parsedIntent,
            originalPrompt: resolutionPrompt,
            clarification: entityResolution.clarification,
            expiresAt: conversationExpiresAt,
          },
        });
        return res.json({
          success: false,
          status: 'question',
          requiresInput: true,
          question: entityResolution.clarification.question,
          message: entityResolution.clarification.question,
          clarification: entityResolution.clarification,
          conversationId,
          conversationExpiresAt,
          userAddress: getAddress(userAddress),
          ...responseMetadata,
        });
      }

      if (conversationId) conversationSessions.delete(conversationId);
      const executableIntent = entityResolution.intent;
      const resolutionEvidence: IntentEntityResolutionEvidence =
        entityResolution.evidence;

      const rawResult =
        network.id === 'arc'
          ? await executeArcEngine(
              executableIntent,
              userAddress,
              resolutionPrompt,
              requestId,
            )
          : await executeKletiaEngine(
              executableIntent,
              userAddress,
              resolutionPrompt,
              requestId,
              req.kletiaBaseX402Challenge,
            );

      const result = createVerifiedIntentResultEnvelope(
        {
          message: rawResult.winnerMessage || executableIntent.message,
          ...rawResult,
        },
        network.id,
        requestId,
        userAddress,
        resolutionEvidence,
      );

      return res.json({ success: true, result, ...result });
    } catch (error: any) {
      const publicError = resolveIntentPublicError(error, network.id);
      console.log(
        `❌ [MOTOR HATASI][${network.id}:${network.chainId}][${requestId}] ` +
        `code=${error?.code || error?.name || 'ENGINE_ERROR'}`,
      );

      return res.status(publicError.statusCode).json({
        success: false,
        code: publicError.code,
        error: publicError.message,
        message: publicError.message,
        ...responseMetadata,
      });
    }
  },
);

const httpServer = createServer(app);

export async function assertRuntimeNetworkAttestation() {
  const checks = await Promise.all(
    (Object.keys(NETWORKS) as NetworkId[]).map((network) =>
      readNetworkHealth(network, true),
    ),
  );
  const failed = checks.filter((check) => check.status !== 'ok');
  if (failed.length > 0) {
    throw Object.assign(
      new Error(
        `Configured RPC chain attestation failed for ${failed
          .map(({ network }) => network)
          .join(', ')}.`,
      ),
      { code: 'RPC_CHAIN_ATTESTATION_FAILED' },
    );
  }
  return checks;
}

export async function startServer() {
  if (httpServer.listening) return httpServer;
  const checks = await assertRuntimeNetworkAttestation();

  await new Promise<void>((resolve, reject) => {
    const onStartupError = (error: Error) => reject(error);
    httpServer.once('error', onStartupError);
    httpServer.listen(PORT, () => {
      httpServer.off('error', onStartupError);
      resolve();
    });
  });

  httpServer.on('error', (error: any) => {
    console.error('❌ SUNUCU HATASI:', {
      name: error instanceof Error ? error.name : 'UnknownError',
      code: typeof error?.code === 'string' ? error.code : undefined,
    });
  });
  console.log(`🟢 KLETIA OMNI-ENGINE AKTİF (Port: ${PORT})`);
  console.log(
    `🌐 Ağlar: ${checks
      .map(({ network, chainId }) => `${network}:${chainId}`)
      .join(', ')}`,
  );
  return httpServer;
}

let shutdownStarted = false;
function shutdownProcess(
  exitCode: number,
  reason: string,
  error?: unknown,
) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  console.error(`[PROCESS SHUTDOWN] ${reason}`, {
    name: error instanceof Error ? error.name : undefined,
    code:
      error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code || '')
        : undefined,
  });

  const exit = () => process.exit(exitCode);
  const forceExitTimer = setTimeout(exit, 5_000);
  forceExitTimer.unref();
  if (httpServer.listening) {
    httpServer.close(exit);
  } else {
    exit();
  }
}

function installProcessHandlers() {
  process.once('SIGINT', () => shutdownProcess(0, 'SIGINT'));
  process.once('SIGTERM', () => shutdownProcess(0, 'SIGTERM'));
  process.once('uncaughtException', (error) =>
    shutdownProcess(1, 'UNCAUGHT_EXCEPTION', error),
  );
  process.once('unhandledRejection', (reason) =>
    shutdownProcess(1, 'UNHANDLED_REJECTION', reason),
  );
}

const isDirectExecution =
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectExecution) {
  installProcessHandlers();
  startServer().catch((error) =>
    shutdownProcess(1, 'STARTUP_FAILED', error),
  );
}

export { app, httpServer };
