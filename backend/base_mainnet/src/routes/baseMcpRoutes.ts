import { createHash } from 'node:crypto';
import { Router, type Response } from 'express';
import { getAddress } from 'viem';
import type { ParsedIntent } from '../ai/parser.js';
import { NETWORKS } from '../config/networks.js';
import {
  BaseX402IntentError,
  buildBaseMcpX402Plan,
  discoverBaseX402Services,
} from '../intent/baseX402.js';

const router = Router();
const BASE_MCP_ORIGIN = 'https://mcp.base.org';
const MAX_GET_BODY_BYTES = 4_096;

class BaseMcpRouteError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = 'BaseMcpRouteError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function scalarQuery(
  value: unknown,
  field: string,
  options: { required?: boolean } = {},
): string | undefined {
  if (value === undefined || value === null || value === '') {
    if (options.required) {
      throw new BaseMcpRouteError(
        `BASE_MCP_${field.toUpperCase()}_REQUIRED`,
        `${field} sorgu alanı zorunludur.`,
      );
    }
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new BaseMcpRouteError(
      `BASE_MCP_${field.toUpperCase()}_INVALID`,
      `${field} tek bir metin değeri olmalıdır.`,
    );
  }
  return value.trim();
}

function explicitWallet(value: unknown): string {
  const raw = scalarQuery(value, 'wallet', { required: true })!;
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) {
    throw new BaseMcpRouteError(
      'BASE_MCP_WALLET_INVALID',
      'wallet geçerli bir EVM adresi olmalıdır.',
    );
  }
  try {
    return getAddress(raw);
  } catch {
    throw new BaseMcpRouteError(
      'BASE_MCP_WALLET_INVALID',
      'wallet geçerli bir EVM adresi olmalıdır.',
    );
  }
}

function bodyCuratedOnly(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value === 'boolean') return value;
  throw new BaseMcpRouteError(
    'BASE_MCP_CURATED_ONLY_INVALID',
    'curatedOnly yalnızca JSON boolean olabilir.',
  );
}

function requestBody(value: unknown): Record<string, unknown> | undefined {
  const raw = scalarQuery(value, 'body');
  if (raw === undefined) return undefined;
  if (Buffer.byteLength(raw, 'utf8') > MAX_GET_BODY_BYTES) {
    throw new BaseMcpRouteError(
      'BASE_MCP_BODY_TOO_LARGE',
      `body ${MAX_GET_BODY_BYTES} baytı aşamaz.`,
    );
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed)
    ) {
      throw new Error('not an object');
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new BaseMcpRouteError(
      'BASE_MCP_BODY_INVALID',
      'body URL-kodlanmış geçerli bir JSON nesnesi olmalıdır.',
    );
  }
}

function preparationId(input: {
  wallet: string;
  url: string;
  method: string;
  maxPayment: string;
  body?: Record<string, unknown>;
}): string {
  const digest = createHash('sha256')
    .update(JSON.stringify(input))
    .digest('hex')
    .slice(0, 24);
  return `kletia-x402-${digest}`;
}

function integrationBoundary() {
  return {
    custody: 'none' as const,
    oauthVerifiedByKletia: false,
    walletOwnershipVerifiedByKletia: false,
    baseMcpServer: BASE_MCP_ORIGIN,
    baseMcpWebRequestAllowlist: 'unverified' as const,
    failClosed: true,
    execution:
      'Only official Base MCP tools may initiate and complete the paid request.',
  };
}

function routeError(res: Response, error: unknown) {
  const known =
    error instanceof BaseMcpRouteError ||
    error instanceof BaseX402IntentError;
  const statusCode = known ? error.statusCode : 502;
  return res.status(statusCode).json({
    success: false,
    code: known ? error.code : 'BASE_MCP_UPSTREAM_UNAVAILABLE',
    message: known
      ? error.message
      : 'Base MCP hazırlık servisi şu anda doğrulanmış bir yanıt üretemedi.',
    network: 'base',
    chainId: NETWORKS.base.chainId,
  });
}

router.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

router.get('/context', (req, res) => {
  try {
    const wallet = explicitWallet(req.query.wallet);
    return res.json({
      success: true,
      network: 'base',
      chainId: NETWORKS.base.chainId,
      wallet: {
        address: wallet,
        sourceRequired: 'Base MCP get_wallets',
        ownershipAttestation: 'not_verified_by_kletia',
      },
      onboarding: {
        required: true,
        detectionTool: 'get_wallets',
        approvalForEveryPaidRequest: true,
      },
      capabilities: {
        x402Discovery: {
          method: 'POST',
          path: '/api/base-mcp/x402/discover',
          execution: 'read-only',
        },
        x402Prepare: {
          method: 'GET',
          path: '/api/base-mcp/x402/prepare',
          execution: 'prepare-only',
          nativeTools: [
            'initiate_x402_request',
            'complete_x402_request',
          ],
        },
      },
      boundary: integrationBoundary(),
    });
  } catch (error) {
    return routeError(res, error);
  }
});

router.get('/x402/discover', (_req, res) => {
  res.setHeader('Allow', 'POST');
  return res.status(405).json({
    success: false,
    code: 'BASE_MCP_DISCOVERY_POST_REQUIRED',
    message:
      'x402 keşif sorguları URL kayıtlarına sızmaması için POST JSON ile gönderilmelidir.',
    network: 'base',
    chainId: NETWORKS.base.chainId,
  });
});

router.post('/x402/discover', async (req, res) => {
  try {
    if (
      req.body === null ||
      typeof req.body !== 'object' ||
      Array.isArray(req.body)
    ) {
      throw new BaseMcpRouteError(
        'BASE_MCP_DISCOVERY_BODY_INVALID',
        'x402 keşif isteği bir JSON nesnesi olmalıdır.',
      );
    }
    const wallet = explicitWallet(req.body.wallet);
    const result = await discoverBaseX402Services({
      query: scalarQuery(req.body.query, 'query', { required: true }),
      maxPayment: scalarQuery(req.body.maxPayment, 'maxPayment', {
        required: true,
      }),
      curatedOnly: bodyCuratedOnly(req.body.curatedOnly),
    });
    return res.json({
      success: true,
      network: 'base',
      chainId: NETWORKS.base.chainId,
      wallet: {
        address: wallet,
        ownershipAttestation: 'not_verified_by_kletia',
      },
      data: result,
      boundary: integrationBoundary(),
    });
  } catch (error) {
    return routeError(res, error);
  }
});

router.get('/x402/prepare', (req, res) => {
  try {
    const wallet = explicitWallet(req.query.wallet);
    const url = scalarQuery(req.query.url, 'url', { required: true })!;
    const method = scalarQuery(req.query.method, 'method', {
      required: true,
    })!.toUpperCase();
    const maxPayment = scalarQuery(
      req.query.maxPayment,
      'maxPayment',
      { required: true },
    )!;
    const body = requestBody(req.query.body);
    const prepareId = preparationId({
      wallet,
      url,
      method,
      maxPayment,
      ...(body === undefined ? {} : { body }),
    });
    const intent: ParsedIntent = {
      isComplete: true,
      action: 'x402_request',
      message: 'Base MCP x402 plan preparation',
      amount: '0',
      durationInDays: 0,
      url,
      method,
      maxPayment,
      ...(body === undefined ? {} : { requestBody: body }),
    };
    const plan = buildBaseMcpX402Plan(intent, prepareId);

    return res.json({
      success: true,
      network: 'base',
      chainId: NETWORKS.base.chainId,
      wallet: {
        address: wallet,
        ownershipAttestation: 'not_verified_by_kletia',
        binding: 'display_and_policy_context_only',
      },
      prepareId,
      data: plan,
      instructions: {
        firstTool: 'initiate_x402_request',
        approval: 'Open and approve the link returned by the first tool.',
        secondTool: 'complete_x402_request',
        completionRequestId:
          'Use only the requestId returned by initiate_x402_request.',
        agentWalletId:
          'Optional; never substitute the wallet address for an agentWalletId.',
      },
      boundary: integrationBoundary(),
    });
  } catch (error) {
    return routeError(res, error);
  }
});

export default router;
