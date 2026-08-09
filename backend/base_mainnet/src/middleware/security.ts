import { Request, Response, NextFunction } from 'express';
import { getAddress } from 'viem';
import { WebacyClient, Chain } from '@webacy-xyz/sdk';
import { parseStrictRiskScore } from '../security/riskScore.js';
import { containsSensitivePromptMaterial } from '../security/promptSecrets.js';
import {
  BaseX402IntentError,
  preflightExplicitBaseX402GetPrompt,
} from '../intent/baseX402.js';

const webacyClient = process.env.WEBACY_API_KEY
  ? new WebacyClient({
      apiKey: process.env.WEBACY_API_KEY,
      defaultChain: Chain.BASE,
    })
  : null;

async function withTimeout<T>(
  promise: Promise<T>,
  ms = 8_000,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Security provider timed out.')),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function blocked(
  req: Request,
  res: Response,
  statusCode: number,
  code: string,
  message: string,
  extras: Record<string, unknown> = {},
) {
  return res.status(statusCode).json({
    success: false,
    code,
    error: message,
    message,
    decision: 'blocked',
    ...extras,
    ...(req.kletiaNetwork
      ? {
          network: req.kletiaNetwork.id,
          chainId: req.kletiaNetwork.chainId,
        }
      : {}),
    ...(req.kletiaRequestId
      ? { requestId: req.kletiaRequestId }
      : {}),
  });
}

type UrlSecurityVerdict = 'benign' | 'malicious' | 'unknown';

function classifyWebacyUrlResponse(value: unknown): UrlSecurityVerdict {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return 'unknown';
  }
  const record = value as Record<string, unknown>;
  const prediction = String(record.prediction ?? '').toLowerCase();
  const blacklist = String(record.blacklist ?? '').toLowerCase();
  const riskLevel = String(record.riskLevel ?? '').toLowerCase();
  if (
    prediction === 'malicious' ||
    blacklist === 'true' ||
    riskLevel === 'malicious' ||
    riskLevel === 'high' ||
    riskLevel === 'critical'
  ) {
    return 'malicious';
  }
  if (
    (prediction === 'benign' && blacklist === 'false') ||
    riskLevel === 'low' ||
    riskLevel === 'benign' ||
    riskLevel === 'safe'
  ) {
    return 'benign';
  }
  return 'unknown';
}

async function verifiedX402Fallback(
  req: Request,
  prompt: string,
  urls: readonly string[],
): Promise<boolean> {
  if (req.kletiaNetwork?.id !== 'base' || urls.length !== 1) {
    return false;
  }
  const evidence = await preflightExplicitBaseX402GetPrompt(
    prompt,
    req.body?.userAddress,
  );
  if (!evidence) return false;
  req.kletiaBaseX402Challenge = evidence;
  return true;
}

export async function validateAddress(req: Request, res: Response, next: NextFunction) {
  const bodyAddress = req.body?.userAddress;
  const queryAddress = req.query.userAddress;
  if (Array.isArray(bodyAddress) || Array.isArray(queryAddress)) {
    return blocked(
      req,
      res,
      400,
      'AMBIGUOUS_ADDRESS',
      'userAddress tek bir EVM adresi olmalıdır.',
    );
  }
  if (
    bodyAddress !== undefined &&
    queryAddress !== undefined
  ) {
    try {
      if (
        getAddress(String(bodyAddress)) !==
        getAddress(String(queryAddress))
      ) {
        return blocked(
          req,
          res,
          400,
          'CONFLICTING_ADDRESS',
          'Body ve query userAddress değerleri birbiriyle uyuşmuyor.',
        );
      }
    } catch {
      return blocked(
        req,
        res,
        400,
        'INVALID_ADDRESS',
        'Geçersiz cüzdan adresi formatı. Lütfen doğru bir EVM adresi girin.',
      );
    }
  }
  const rawAddress = bodyAddress ?? queryAddress;
  if (rawAddress === undefined) return next();

  let validAddress: `0x${string}`;
  try {
    validAddress = getAddress(String(rawAddress));
  } catch {
    return blocked(
      req,
      res,
      400,
      'INVALID_ADDRESS',
      'Geçersiz cüzdan adresi formatı. Lütfen doğru bir EVM adresi girin.',
    );
  }

  if (req.body) req.body.userAddress = validAddress;
  if (req.query.userAddress !== undefined) {
    req.query.userAddress = validAddress;
  }

  if (req.kletiaNetwork?.id === 'base') {
    if (!webacyClient) {
      return blocked(
        req,
        res,
        503,
        'WEBACY_UNAVAILABLE',
        'Base address risk verification is unavailable.',
        { source: 'webacy', network: 'base', chainId: 8453 },
      );
    }

    try {
      const risk = await withTimeout(
        webacyClient.threat.addresses.analyze(validAddress),
      );
      const overallRisk = parseStrictRiskScore(risk.overallRisk);
      if (overallRisk === null) {
        throw new Error('Webacy returned no finite risk score.');
      }
      if (overallRisk > 50) {
        return blocked(
          req,
          res,
          403,
          'HIGH_RISK_ADDRESS',
          `Webacy risk score ${overallRisk}; Base intent access denied.`,
          {
            riskScore: overallRisk,
            source: 'webacy',
            network: 'base',
            chainId: 8453,
          },
        );
      }
    } catch (error: any) {
      console.error('Webacy address risk check failed:', {
        code: error?.code || error?.name || 'WEBACY_ERROR',
      });
      return blocked(
        req,
        res,
        503,
        'WEBACY_UNAVAILABLE',
        'Base address risk verification failed closed.',
        { source: 'webacy', network: 'base', chainId: 8453 },
      );
    }
  }

  return next();
}

export async function sanitizePrompt(req: Request, res: Response, next: NextFunction) {
  const rawPrompt = req.body?.prompt;
  if (rawPrompt === undefined) return next();
  if (typeof rawPrompt !== 'string' || !rawPrompt.trim()) {
    return blocked(
      req,
      res,
      400,
      'INVALID_PROMPT',
      'prompt boş olmayan bir metin olmalıdır.',
    );
  }
  if (rawPrompt.length > 500) {
    return blocked(
      req,
      res,
      400,
      'PROMPT_TOO_LONG',
      'prompt en fazla 500 karakter olabilir.',
    );
  }
  if (/<[^>]*>/u.test(rawPrompt)) {
    return blocked(
      req,
      res,
      400,
      'HTML_NOT_ALLOWED',
      'prompt içinde HTML etiketleri kullanılamaz.',
    );
  }

  const prompt = rawPrompt.trim();
  if (containsSensitivePromptMaterial(prompt)) {
    return blocked(
      req,
      res,
      400,
      'SENSITIVE_DATA_NOT_ALLOWED',
      'Private key, seed phrase veya API kimlik bilgisi niyet mesajına eklenemez.',
    );
  }

  const urls = (prompt.match(/\bhttps?:\/\/[^\s<>"']+/giu) || []).map(
    (url) => url.replace(/[),.;!?]+$/u, ''),
  );
  if (urls.length > 3) {
    return blocked(
      req,
      res,
      400,
      'TOO_MANY_URLS',
      'Bir prompt içinde en fazla 3 URL doğrulanabilir.',
    );
  }

  if (urls.length > 0) {
    try {
      const verdicts = webacyClient
        ? await withTimeout(
            Promise.all(
              urls.map(async (url) => {
                const parsedUrl = new URL(url);
                if (
                  parsedUrl.protocol !== 'https:' &&
                  parsedUrl.protocol !== 'http:'
                ) {
                  throw new Error('Unsupported URL protocol.');
                }
                return classifyWebacyUrlResponse(
                  await webacyClient.threat.url.check(url, {
                    timeout: 7_000,
                  }),
                );
              }),
            ),
            8_000,
          )
        : urls.map(() => 'unknown' as const);
      if (
        verdicts.some((verdict) => verdict === 'malicious')
      ) {
        return blocked(
          req,
          res,
          403,
          'MALICIOUS_URL_DETECTED',
          'Webacy detected a malicious URL in the prompt.',
          {
            source: 'webacy',
            network: req.kletiaNetwork?.id,
            chainId: req.kletiaNetwork?.chainId,
          },
        );
      }
      if (
        verdicts.some((verdict) => verdict === 'unknown') &&
        !(await verifiedX402Fallback(req, prompt, urls))
      ) {
        throw new Error('Webacy returned no explicit benign URL decision.');
      }
      if (
        verdicts.every((verdict) => verdict === 'benign')
      ) {

        await verifiedX402Fallback(req, prompt, urls);
      }
    } catch (error) {
      console.error(
        'Webacy URL risk check failed:',
        error instanceof Error ? error.name : 'URL_SCAN_ERROR',
      );
      if (error instanceof BaseX402IntentError) {
        return blocked(
          req,
          res,
          error.statusCode,
          error.code,
          error.message,
          {
            source: 'x402_challenge_preflight',
          },
        );
      }

      try {
        if (await verifiedX402Fallback(req, prompt, urls)) {
          req.body.prompt = prompt;
          return next();
        }
      } catch (fallbackError) {
        if (fallbackError instanceof BaseX402IntentError) {
          return blocked(
            req,
            res,
            fallbackError.statusCode,
            fallbackError.code,
            fallbackError.message,
            {
              source: 'x402_challenge_preflight',
            },
          );
        }
      }
      return blocked(
        req,
        res,
        503,
        'URL_SECURITY_UNAVAILABLE',
        'URL risk verification failed closed.',
        {
          source: 'webacy',
          network: req.kletiaNetwork?.id,
          chainId: req.kletiaNetwork?.chainId,
        },
      );
    }
  }

  req.body.prompt = prompt;
  return next();
}
