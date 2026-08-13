import { Router, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { getAddress, isAddressEqual, zeroAddress } from "viem";

const BASE_CHAIN_ID = 8453;
const BASE_CHAIN_ID_HEX = "0x2105";
const ENTRY_POINT_V06 = getAddress(
  "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789",
);
const ALLOWED_METHODS = new Set([
  "pm_getPaymasterStubData",
  "pm_getPaymasterData",
]);
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_CALLDATA_BYTES = 48 * 1024;
const PROVIDER_TIMEOUT_MS = 12_000;
const PROVIDER_ERROR_MESSAGE = "Base paymaster provider rejected the request.";

type JsonRpcId = string | number;

interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly method: "pm_getPaymasterStubData" | "pm_getPaymasterData";
  readonly params: readonly [
    Record<string, unknown>,
    string,
    string | number,
    Record<string, unknown> | null,
  ];
}

class PaymasterRequestError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly rpcCode: number,
    message: string,
    readonly id: JsonRpcId | null = null,
  ) {
    super(message);
    this.name = "PaymasterRequestError";
  }
}

function rpcError(
  res: Response,
  status: number,
  code: number,
  message: string,
  id: JsonRpcId | null,
) {
  res.setHeader("Cache-Control", "no-store");
  return res.status(status).json({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isHexData(value: unknown, maximumBytes: number): value is string {
  return (
    typeof value === "string" &&
    /^0x(?:[0-9a-fA-F]{2})*$/.test(value) &&
    (value.length - 2) / 2 <= maximumBytes
  );
}

function isHexQuantity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value) &&
    value.length <= 66
  );
}

function parseBaseChainId(value: unknown): number | null {
  if (value === BASE_CHAIN_ID) return BASE_CHAIN_ID;
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (
    normalized === BASE_CHAIN_ID_HEX ||
    normalized === String(BASE_CHAIN_ID)
  ) {
    return BASE_CHAIN_ID;
  }
  return null;
}

function validateUserOperation(
  value: unknown,
): asserts value is Record<string, unknown> {
  if (!isPlainRecord(value)) {
    throw new PaymasterRequestError(
      400,
      -32602,
      "UserOperation object is invalid.",
    );
  }

  const allowedFields = new Set([
    "sender",
    "nonce",
    "initCode",
    "callData",
    "callGasLimit",
    "verificationGasLimit",
    "preVerificationGas",
    "maxFeePerGas",
    "maxPriorityFeePerGas",
    "signature",
    "paymasterAndData",
  ]);
  if (Object.keys(value).some((key) => !allowedFields.has(key))) {
    throw new PaymasterRequestError(
      400,
      -32602,
      "UserOperation contains unsupported fields.",
    );
  }

  let sender;
  try {
    if (typeof value.sender !== "string") throw new Error("missing sender");
    sender = getAddress(value.sender);
  } catch {
    throw new PaymasterRequestError(
      400,
      -32602,
      "UserOperation sender address is invalid.",
    );
  }
  if (isAddressEqual(sender, zeroAddress)) {
    throw new PaymasterRequestError(
      400,
      -32602,
      "UserOperation sender cannot be the zero address.",
    );
  }
  if (!isHexQuantity(value.nonce)) {
    throw new PaymasterRequestError(
      400,
      -32602,
      "UserOperation nonce value is invalid.",
    );
  }
  if (
    !isHexData(value.callData, MAX_CALLDATA_BYTES) ||
    value.callData === "0x"
  ) {
    throw new PaymasterRequestError(
      400,
      -32602,
      "UserOperation callData value is invalid or too large.",
    );
  }

  const byteFields = ["initCode", "signature", "paymasterAndData"] as const;
  for (const field of byteFields) {
    if (
      value[field] !== undefined &&
      !isHexData(value[field], field === "initCode" ? 16 * 1024 : 8 * 1024)
    ) {
      throw new PaymasterRequestError(
        400,
        -32602,
        `UserOperation ${field} value is invalid.`,
      );
    }
  }
  const quantityFields = [
    "callGasLimit",
    "verificationGasLimit",
    "preVerificationGas",
    "maxFeePerGas",
    "maxPriorityFeePerGas",
  ] as const;
  for (const field of quantityFields) {
    if (value[field] !== undefined && !isHexQuantity(value[field])) {
      throw new PaymasterRequestError(
        400,
        -32602,
        `UserOperation ${field} value is invalid.`,
      );
    }
  }
}

function validateContext(
  value: unknown,
  id: JsonRpcId,
): Record<string, string> {
  const configuredPolicy = process.env.CDP_PAYMASTER_POLICY_ID?.trim();
  if (!configuredPolicy || !/^[A-Za-z0-9_-]{8,128}$/.test(configuredPolicy)) {
    throw new PaymasterRequestError(
      503,
      -32003,
      "Base paymaster policy is not configured on the server.",
      id,
    );
  }

  if (
    value === null ||
    (isPlainRecord(value) && Object.keys(value).length === 0)
  ) {
    return { policyId: configuredPolicy };
  }
  if (!isPlainRecord(value)) {
    throw new PaymasterRequestError(
      400,
      -32602,
      "Paymaster context object is invalid.",
      id,
    );
  }

  const keys = Object.keys(value);
  if (
    keys.length !== 1 ||
    keys[0] !== "policyId" ||
    typeof value.policyId !== "string"
  ) {
    throw new PaymasterRequestError(
      400,
      -32602,
      "Paymaster context can only contain the configured policyId.",
      id,
    );
  }

  if (value.policyId !== configuredPolicy) {
    throw new PaymasterRequestError(
      403,
      -32001,
      "Paymaster policyId is not authorized for this service.",
      id,
    );
  }
  return { policyId: configuredPolicy };
}

export function validatePaymasterRequest(body: unknown): JsonRpcRequest {
  if (!isPlainRecord(body)) {
    throw new PaymasterRequestError(
      400,
      -32600,
      "Tek bir JSON-RPC istek nesnesi gereklidir.",
    );
  }

  const serializedSize = Buffer.byteLength(JSON.stringify(body), "utf8");
  if (serializedSize > MAX_REQUEST_BYTES) {
    throw new PaymasterRequestError(
      413,
      -32600,
      "Paymaster request exceeds size limit.",
    );
  }

  const id =
    typeof body.id === "string" || typeof body.id === "number" ? body.id : null;
  if (
    body.jsonrpc !== "2.0" ||
    id === null ||
    (typeof id === "string" && (id.length === 0 || id.length > 128)) ||
    (typeof id === "number" &&
      (!Number.isSafeInteger(id) || !Number.isFinite(id)))
  ) {
    throw new PaymasterRequestError(
      400,
      -32600,
      "JSON-RPC 2.0 version and a valid id are required.",
      id,
    );
  }

  if (typeof body.method !== "string" || !ALLOWED_METHODS.has(body.method)) {
    throw new PaymasterRequestError(
      405,
      -32601,
      "This JSON-RPC method is not supported on the paymaster proxy.",
      id,
    );
  }
  if (!Array.isArray(body.params) || body.params.length !== 4) {
    throw new PaymasterRequestError(
      400,
      -32602,
      "Paymaster params array does not match the ERC-7677 format.",
      id,
    );
  }

  const [userOperation, entryPoint, chainId, context] = body.params;
  validateUserOperation(userOperation);

  let normalizedEntryPoint;
  try {
    if (typeof entryPoint !== "string") throw new Error("invalid");
    normalizedEntryPoint = getAddress(entryPoint);
  } catch {
    throw new PaymasterRequestError(
      400,
      -32602,
      "Invalid Paymaster EntryPoint address.",
      id,
    );
  }
  if (!isAddressEqual(normalizedEntryPoint, ENTRY_POINT_V06)) {
    throw new PaymasterRequestError(
      400,
      -32602,
      "Only EntryPoint v0.6 supported by CDP is allowed.",
      id,
    );
  }
  if (parseBaseChainId(chainId) !== BASE_CHAIN_ID) {
    throw new PaymasterRequestError(
      400,
      -32602,
      "Paymaster can only be used for Base Mainnet chainId 8453.",
      id,
    );
  }
  const policyContext = validateContext(context, id);

  return {
    jsonrpc: "2.0",
    id,
    method: body.method as JsonRpcRequest["method"],
    params: [userOperation, ENTRY_POINT_V06, BASE_CHAIN_ID_HEX, policyContext],
  };
}

function resolvePaymasterUrl(): URL {
  const configuredUrl = process.env.CDP_PAYMASTER_URL?.trim();
  const apiKeyId = process.env.CDP_API_KEY_ID?.trim();

  let rawUrl = configuredUrl;
  if (!rawUrl && apiKeyId) {
    if (!/^[A-Za-z0-9_-]{8,256}$/.test(apiKeyId)) {
      throw new Error("Invalid CDP_API_KEY_ID format.");
    }
    rawUrl = `https://api.developer.coinbase.com/rpc/v1/base/${apiKeyId}`;
  }
  if (!rawUrl) {
    throw new Error(
      "CDP_PAYMASTER_URL or CDP_API_KEY_ID is not configured on the server.",
    );
  }

  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Invalid CDP paymaster provider URL configuration.");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "api.developer.coinbase.com" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "CDP paymaster provider is not a trusted Base HTTPS endpoint.",
    );
  }

  const pathParts = url.pathname.split("/").filter(Boolean);

  if (
    pathParts.length !== 4 ||
    pathParts[0] !== "rpc" ||
    pathParts[1] !== "v1" ||
    pathParts[2] !== "base" ||
    !pathParts[3]
  ) {
    throw new Error(
      "CDP paymaster URL path must be in the format /rpc/v1/base/<client-api-key>.",
    );
  }
  return url;
}

function validateProviderResponse(
  value: unknown,
  requestId: JsonRpcId,
  method: JsonRpcRequest["method"],
): Record<string, unknown> {
  if (!isPlainRecord(value) || value.jsonrpc !== "2.0") {
    throw new Error("CDP paymaster returned an invalid JSON-RPC response.");
  }
  if (value.id !== requestId) {
    throw new Error("CDP paymaster response id does not match the request.");
  }
  const hasResult = Object.prototype.hasOwnProperty.call(value, "result");
  const hasError = Object.prototype.hasOwnProperty.call(value, "error");
  if (hasResult === hasError) {
    throw new Error(
      "CDP paymaster response does not conform to the result/error contract.",
    );
  }
  if (hasError) {
    if (
      !isPlainRecord(value.error) ||
      !Number.isSafeInteger(value.error.code) ||
      typeof value.error.message !== "string" ||
      value.error.message.length === 0 ||
      value.error.message.length > 1_000
    ) {
      throw new Error("CDP paymaster returned an invalid error response.");
    }
    return {
      jsonrpc: "2.0",
      id: requestId,
      error: {
        code: value.error.code,
        message: PROVIDER_ERROR_MESSAGE,
      },
    };
  }

  if (!isPlainRecord(value.result)) {
    throw new Error("CDP paymaster returned an invalid result object.");
  }
  const allowedResultFields = new Set(
    method === "pm_getPaymasterStubData"
      ? ["paymasterAndData", "sponsor", "isFinal"]
      : ["paymasterAndData"],
  );
  if (
    Object.keys(value.result).some((field) => !allowedResultFields.has(field))
  ) {
    throw new Error("CDP paymaster result contains unexpected fields.");
  }
  const paymasterAndData = value.result.paymasterAndData;
  if (!isHexData(paymasterAndData, 8 * 1024) || paymasterAndData.length < 42) {
    throw new Error(
      "CDP paymaster result does not contain valid v0.6 paymasterAndData.",
    );
  }
  try {
    const paymasterAddress = getAddress(paymasterAndData.slice(0, 42));
    if (isAddressEqual(paymasterAddress, zeroAddress)) {
      throw new Error("zero paymaster");
    }
  } catch {
    throw new Error(
      "CDP paymaster result does not contain a valid v0.6 paymaster address.",
    );
  }

  const normalizedResult: Record<string, unknown> = { paymasterAndData };
  if (method === "pm_getPaymasterStubData") {
    if (
      value.result.isFinal !== undefined &&
      typeof value.result.isFinal !== "boolean"
    ) {
      throw new Error("CDP paymaster isFinal field is invalid.");
    }
    if (value.result.isFinal !== undefined) {
      normalizedResult.isFinal = value.result.isFinal;
    }
    if (value.result.sponsor !== undefined) {
      if (
        !isPlainRecord(value.result.sponsor) ||
        typeof value.result.sponsor.name !== "string" ||
        value.result.sponsor.name.length === 0 ||
        value.result.sponsor.name.length > 100 ||
        Object.keys(value.result.sponsor).some(
          (field) => field !== "name" && field !== "icon",
        )
      ) {
        throw new Error("CDP paymaster sponsor field is invalid.");
      }
      let icon: string | undefined;
      if (value.result.sponsor.icon !== undefined) {
        if (
          typeof value.result.sponsor.icon !== "string" ||
          value.result.sponsor.icon.length > 2_048
        ) {
          throw new Error("CDP paymaster sponsor icon field is invalid.");
        }
        let iconUrl: URL;
        try {
          iconUrl = new URL(value.result.sponsor.icon);
        } catch {
          throw new Error("CDP paymaster sponsor icon URL field is invalid.");
        }
        if (
          iconUrl.protocol !== "https:" ||
          iconUrl.username ||
          iconUrl.password
        ) {
          throw new Error("CDP paymaster sponsor icon is not secure HTTPS.");
        }
        icon = iconUrl.toString();
      }
      normalizedResult.sponsor = {
        name: value.result.sponsor.name,
        ...(icon ? { icon } : {}),
      };
    }
  }

  return {
    jsonrpc: "2.0",
    id: requestId,
    result: normalizedResult,
  };
}

async function readProviderResponse(
  response: globalThis.Response,
  requestId: JsonRpcId,
  method: JsonRpcRequest["method"],
): Promise<Record<string, unknown>> {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength &&
    Number.isFinite(Number(declaredLength)) &&
    Number(declaredLength) > MAX_RESPONSE_BYTES
  ) {
    throw new Error("CDP paymaster response exceeds size limit.");
  }

  const raw = await response.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_RESPONSE_BYTES) {
    throw new Error("CDP paymaster response exceeds size limit.");
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("CDP paymaster returned a non-JSON response.");
  }
  return validateProviderResponse(parsed, requestId, method);
}

const router = Router();

const sponsorLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  handler: (req, res) => {
    const body = isPlainRecord(req.body) ? req.body : {};
    const id =
      typeof body.id === "string" || typeof body.id === "number"
        ? body.id
        : null;
    rpcError(
      res,
      429,
      -32005,
      "Paymaster request limit exceeded. Please try again later.",
      id,
    );
  },
});

router.post("/sponsor", sponsorLimiter, async (req: Request, res: Response) => {
  if (process.env.PAYMASTER_PROXY_ENABLED !== "true") {
    const body = isPlainRecord(req.body) ? req.body : {};
    const id =
      typeof body.id === "string" || typeof body.id === "number"
        ? body.id
        : null;
    return rpcError(
      res,
      503,
      -32003,
      "Base paymaster sponsorship is not enabled.",
      id,
    );
  }
  let validatedRequest: JsonRpcRequest;
  try {
    validatedRequest = validatePaymasterRequest(req.body);
  } catch (error) {
    if (error instanceof PaymasterRequestError) {
      return rpcError(
        res,
        error.httpStatus,
        error.rpcCode,
        error.message,
        error.id,
      );
    }
    return rpcError(res, 400, -32600, "Invalid paymaster request.", null);
  }

  let paymasterUrl: URL;
  try {
    paymasterUrl = resolvePaymasterUrl();
  } catch {
    return rpcError(
      res,
      503,
      -32003,
      "Base paymaster provider is not ready on the server.",
      validatedRequest.id,
    );
  }

  try {
    const response = await fetch(paymasterUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(validatedRequest),
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
    const data = await readProviderResponse(
      response,
      validatedRequest.id,
      validatedRequest.method,
    );

    res.setHeader("Cache-Control", "no-store");
    return res.status(response.ok ? 200 : response.status).json(data);
  } catch {
    return rpcError(
      res,
      502,
      -32003,
      "Could not securely reach the base paymaster provider.",
      validatedRequest.id,
    );
  }
});

export default router;
