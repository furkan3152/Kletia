import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

const REQUEST_ID_PATTERN =
  /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

declare global {
  namespace Express {
    interface Request {
      kletiaRequestId?: string;
    }
  }
}

export class RequestIdValidationError extends Error {
  readonly code = 'INVALID_REQUEST_ID';
  readonly statusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = 'RequestIdValidationError';
  }
}

function optionalRequestId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new RequestIdValidationError(
      'requestId metin biçiminde olmalıdır.',
    );
  }
  const normalized = value.trim();
  if (!REQUEST_ID_PATTERN.test(normalized)) {
    throw new RequestIdValidationError(
      'requestId UUID v4 veya 32 karakterlik hex kimlik olmalıdır.',
    );
  }
  return normalized;
}

export function resolveIntentRequestId(
  requestIdValue: unknown,
  legacyMsgIdValue: unknown,
  fallback: () => string,
): string {
  const requestId = optionalRequestId(requestIdValue);
  const legacyMsgId = optionalRequestId(legacyMsgIdValue);
  if (
    requestId !== undefined &&
    legacyMsgId !== undefined &&
    requestId !== legacyMsgId
  ) {
    throw new RequestIdValidationError(
      'requestId ve msgId birbiriyle uyuşmuyor.',
    );
  }
  return requestId || legacyMsgId || fallback();
}

export function requireIntentRequestId(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    req.kletiaRequestId = resolveIntentRequestId(
      req.body?.requestId,
      req.body?.msgId,
      randomUUID,
    );
    return next();
  } catch (error) {
    if (error instanceof RequestIdValidationError) {
      return res.status(error.statusCode).json({
        success: false,
        code: error.code,
        error: error.message,
        message: error.message,
        ...(req.kletiaNetwork
          ? {
              network: req.kletiaNetwork.id,
              chainId: req.kletiaNetwork.chainId,
            }
          : {}),
      });
    }
    return next(error);
  }
}
