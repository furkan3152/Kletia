export interface PublicRouteFailure {
  readonly code: string;
  readonly message: string;
  readonly statusCode: number;
}

export class ControlledRouteError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode: number) {
    super(message);
    this.name = "ControlledRouteError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function safeControlledMessage(message: string): string {
  return message
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 500);
}

export function resolvePublicRouteFailure(
  error: unknown,
  fallback: PublicRouteFailure,
): PublicRouteFailure {
  if (!(error instanceof ControlledRouteError)) return fallback;
  const code = /^[A-Z][A-Z0-9_]{1,63}$/u.test(error.code)
    ? error.code
    : fallback.code;
  const statusCode =
    Number.isInteger(error.statusCode) &&
    error.statusCode >= 400 &&
    error.statusCode <= 599
      ? error.statusCode
      : fallback.statusCode;
  const message = safeControlledMessage(error.message);
  return {
    code,
    message: message || fallback.message,
    statusCode,
  };
}
