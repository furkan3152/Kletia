import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { getAddress, isAddressEqual, zeroAddress } from 'viem';

const BASE_CHAIN_ID = 8453;
const BASE_CHAIN_ID_HEX = '0x2105';
const ENTRY_POINT_V06 = getAddress(
    '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789',
);
const ALLOWED_METHODS = new Set([
    'pm_getPaymasterStubData',
    'pm_getPaymasterData',
]);
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_CALLDATA_BYTES = 48 * 1024;
const PROVIDER_TIMEOUT_MS = 12_000;
const PROVIDER_ERROR_MESSAGE =
    'Base paymaster sağlayıcısı isteği reddetti.';

type JsonRpcId = string | number;

interface JsonRpcRequest {
    readonly jsonrpc: '2.0';
    readonly id: JsonRpcId;
    readonly method: 'pm_getPaymasterStubData' | 'pm_getPaymasterData';
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
        this.name = 'PaymasterRequestError';
    }
}

function rpcError(
    res: Response,
    status: number,
    code: number,
    message: string,
    id: JsonRpcId | null,
) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(status).json({
        jsonrpc: '2.0',
        id,
        error: { code, message },
    });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function isHexData(value: unknown, maximumBytes: number): value is string {
    return (
        typeof value === 'string' &&
        /^0x(?:[0-9a-fA-F]{2})*$/.test(value) &&
        (value.length - 2) / 2 <= maximumBytes
    );
}

function isHexQuantity(value: unknown): value is string {
    return (
        typeof value === 'string' &&
        /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value) &&
        value.length <= 66
    );
}

function parseBaseChainId(value: unknown): number | null {
    if (value === BASE_CHAIN_ID) return BASE_CHAIN_ID;
    if (typeof value !== 'string') return null;
    const normalized = value.trim().toLowerCase();
    if (normalized === BASE_CHAIN_ID_HEX || normalized === String(BASE_CHAIN_ID)) {
        return BASE_CHAIN_ID;
    }
    return null;
}

function validateUserOperation(value: unknown): asserts value is Record<string, unknown> {
    if (!isPlainRecord(value)) {
        throw new PaymasterRequestError(
            400,
            -32602,
            'UserOperation nesnesi geçersiz.',
        );
    }

    const allowedFields = new Set([
        'sender',
        'nonce',
        'initCode',
        'callData',
        'callGasLimit',
        'verificationGasLimit',
        'preVerificationGas',
        'maxFeePerGas',
        'maxPriorityFeePerGas',
        'signature',
        'paymasterAndData',
    ]);
    if (Object.keys(value).some((key) => !allowedFields.has(key))) {
        throw new PaymasterRequestError(
            400,
            -32602,
            'UserOperation desteklenmeyen alan içeriyor.',
        );
    }

    let sender;
    try {
        if (typeof value.sender !== 'string') throw new Error('missing sender');
        sender = getAddress(value.sender);
    } catch {
        throw new PaymasterRequestError(
            400,
            -32602,
            'UserOperation sender adresi geçersiz.',
        );
    }
    if (isAddressEqual(sender, zeroAddress)) {
        throw new PaymasterRequestError(
            400,
            -32602,
            'UserOperation sender sıfır adres olamaz.',
        );
    }
    if (!isHexQuantity(value.nonce)) {
        throw new PaymasterRequestError(
            400,
            -32602,
            'UserOperation nonce değeri geçersiz.',
        );
    }
    if (!isHexData(value.callData, MAX_CALLDATA_BYTES) || value.callData === '0x') {
        throw new PaymasterRequestError(
            400,
            -32602,
            'UserOperation callData değeri geçersiz veya çok büyük.',
        );
    }

    const byteFields = ['initCode', 'signature', 'paymasterAndData'] as const;
    for (const field of byteFields) {
        if (
            value[field] !== undefined &&
            !isHexData(value[field], field === 'initCode' ? 16 * 1024 : 8 * 1024)
        ) {
            throw new PaymasterRequestError(
                400,
                -32602,
                `UserOperation ${field} değeri geçersiz.`,
            );
        }
    }
    const quantityFields = [
        'callGasLimit',
        'verificationGasLimit',
        'preVerificationGas',
        'maxFeePerGas',
        'maxPriorityFeePerGas',
    ] as const;
    for (const field of quantityFields) {
        if (value[field] !== undefined && !isHexQuantity(value[field])) {
            throw new PaymasterRequestError(
                400,
                -32602,
                `UserOperation ${field} değeri geçersiz.`,
            );
        }
    }
}

function validateContext(
    value: unknown,
    id: JsonRpcId,
): Record<string, string> {
    const configuredPolicy = process.env.CDP_PAYMASTER_POLICY_ID?.trim();
    if (
        !configuredPolicy ||
        !/^[A-Za-z0-9_-]{8,128}$/.test(configuredPolicy)
    ) {
        throw new PaymasterRequestError(
            503,
            -32003,
            'Base paymaster policy sunucuda yapılandırılmamış.',
            id,
        );
    }

    if (value === null || (isPlainRecord(value) && Object.keys(value).length === 0)) {
        return { policyId: configuredPolicy };
    }
    if (!isPlainRecord(value)) {
        throw new PaymasterRequestError(
            400,
            -32602,
            'Paymaster context nesnesi geçersiz.',
            id,
        );
    }

    const keys = Object.keys(value);
    if (
        keys.length !== 1 ||
        keys[0] !== 'policyId' ||
        typeof value.policyId !== 'string'
    ) {
        throw new PaymasterRequestError(
            400,
            -32602,
            'Paymaster context yalnız yapılandırılmış policyId içerebilir.',
            id,
        );
    }

    if (value.policyId !== configuredPolicy) {
        throw new PaymasterRequestError(
            403,
            -32001,
            'Paymaster policyId bu servis için yetkili değil.',
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
            'Tek bir JSON-RPC istek nesnesi gereklidir.',
        );
    }

    const serializedSize = Buffer.byteLength(JSON.stringify(body), 'utf8');
    if (serializedSize > MAX_REQUEST_BYTES) {
        throw new PaymasterRequestError(
            413,
            -32600,
            'Paymaster isteği boyut sınırını aşıyor.',
        );
    }

    const id =
        typeof body.id === 'string' || typeof body.id === 'number'
            ? body.id
            : null;
    if (
        body.jsonrpc !== '2.0' ||
        id === null ||
        (typeof id === 'string' && (id.length === 0 || id.length > 128)) ||
        (typeof id === 'number' &&
            (!Number.isSafeInteger(id) || !Number.isFinite(id)))
    ) {
        throw new PaymasterRequestError(
            400,
            -32600,
            'JSON-RPC 2.0 sürümü ve geçerli bir id zorunludur.',
            id,
        );
    }

    if (typeof body.method !== 'string' || !ALLOWED_METHODS.has(body.method)) {
        throw new PaymasterRequestError(
            405,
            -32601,
            'Bu JSON-RPC metodu paymaster proxy üzerinde desteklenmiyor.',
            id,
        );
    }
    if (!Array.isArray(body.params) || body.params.length !== 4) {
        throw new PaymasterRequestError(
            400,
            -32602,
            'Paymaster params dizisi ERC-7677 biçimiyle eşleşmiyor.',
            id,
        );
    }

    const [userOperation, entryPoint, chainId, context] = body.params;
    validateUserOperation(userOperation);

    let normalizedEntryPoint;
    try {
        if (typeof entryPoint !== 'string') throw new Error('invalid');
        normalizedEntryPoint = getAddress(entryPoint);
    } catch {
        throw new PaymasterRequestError(
            400,
            -32602,
            'Paymaster EntryPoint adresi geçersiz.',
            id,
        );
    }
    if (!isAddressEqual(normalizedEntryPoint, ENTRY_POINT_V06)) {
        throw new PaymasterRequestError(
            400,
            -32602,
            'Yalnız CDP tarafından desteklenen EntryPoint v0.6 kullanılabilir.',
            id,
        );
    }
    if (parseBaseChainId(chainId) !== BASE_CHAIN_ID) {
        throw new PaymasterRequestError(
            400,
            -32602,
            'Paymaster yalnız Base Mainnet chainId 8453 için kullanılabilir.',
            id,
        );
    }
    const policyContext = validateContext(context, id);

    return {
        jsonrpc: '2.0',
        id,
        method: body.method as JsonRpcRequest['method'],
        params: [
            userOperation,
            ENTRY_POINT_V06,
            BASE_CHAIN_ID_HEX,
            policyContext,
        ],
    };
}

function resolvePaymasterUrl(): URL {
    const configuredUrl = process.env.CDP_PAYMASTER_URL?.trim();
    const apiKeyId = process.env.CDP_API_KEY_ID?.trim();

    let rawUrl = configuredUrl;
    if (!rawUrl && apiKeyId) {
        if (!/^[A-Za-z0-9_-]{8,256}$/.test(apiKeyId)) {
            throw new Error('CDP_API_KEY_ID biçimi geçersiz.');
        }
        rawUrl = `https://api.developer.coinbase.com/rpc/v1/base/${apiKeyId}`;
    }
    if (!rawUrl) {
        throw new Error(
            'CDP_PAYMASTER_URL veya CDP_API_KEY_ID sunucuda yapılandırılmamış.',
        );
    }

    let url;
    try {
        url = new URL(rawUrl);
    } catch {
        throw new Error('CDP paymaster sağlayıcı URL yapılandırması geçersiz.');
    }
    if (
        url.protocol !== 'https:' ||
        url.hostname !== 'api.developer.coinbase.com' ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
    ) {
        throw new Error('CDP paymaster sağlayıcısı güvenilir Base HTTPS uç noktası değil.');
    }

    const pathParts = url.pathname.split('/').filter(Boolean);

    if (
        pathParts.length !== 4 ||
        pathParts[0] !== 'rpc' ||
        pathParts[1] !== 'v1' ||
        pathParts[2] !== 'base' ||
        !pathParts[3]
    ) {
        throw new Error(
            'CDP paymaster URL yolu /rpc/v1/base/<client-api-key> biçiminde olmalı.',
        );
    }
    return url;
}

function validateProviderResponse(
    value: unknown,
    requestId: JsonRpcId,
    method: JsonRpcRequest['method'],
): Record<string, unknown> {
    if (!isPlainRecord(value) || value.jsonrpc !== '2.0') {
        throw new Error('CDP paymaster geçersiz JSON-RPC yanıtı döndürdü.');
    }
    if (value.id !== requestId) {
        throw new Error('CDP paymaster yanıt id değeri istekle eşleşmiyor.');
    }
    const hasResult = Object.prototype.hasOwnProperty.call(value, 'result');
    const hasError = Object.prototype.hasOwnProperty.call(value, 'error');
    if (hasResult === hasError) {
        throw new Error('CDP paymaster yanıtı result/error sözleşmesiyle eşleşmiyor.');
    }
    if (hasError) {
        if (
            !isPlainRecord(value.error) ||
            !Number.isSafeInteger(value.error.code) ||
            typeof value.error.message !== 'string' ||
            value.error.message.length === 0 ||
            value.error.message.length > 1_000
        ) {
            throw new Error('CDP paymaster geçersiz hata yanıtı döndürdü.');
        }
        return {
            jsonrpc: '2.0',
            id: requestId,
            error: {
                code: value.error.code,
                message: PROVIDER_ERROR_MESSAGE,
            },
        };
    }

    if (!isPlainRecord(value.result)) {
        throw new Error('CDP paymaster geçersiz result nesnesi döndürdü.');
    }
    const allowedResultFields = new Set(
        method === 'pm_getPaymasterStubData'
            ? ['paymasterAndData', 'sponsor', 'isFinal']
            : ['paymasterAndData'],
    );
    if (
        Object.keys(value.result).some(
            (field) => !allowedResultFields.has(field),
        )
    ) {
        throw new Error('CDP paymaster result beklenmeyen alan içeriyor.');
    }
    const paymasterAndData = value.result.paymasterAndData;
    if (
        !isHexData(paymasterAndData, 8 * 1024) ||
        paymasterAndData.length < 42
    ) {
        throw new Error(
            'CDP paymaster result geçerli v0.6 paymasterAndData içermiyor.',
        );
    }
    try {
        const paymasterAddress = getAddress(paymasterAndData.slice(0, 42));
        if (isAddressEqual(paymasterAddress, zeroAddress)) {
            throw new Error('zero paymaster');
        }
    } catch {
        throw new Error(
            'CDP paymaster result geçerli bir v0.6 paymaster adresi içermiyor.',
        );
    }

    const normalizedResult: Record<string, unknown> = { paymasterAndData };
    if (method === 'pm_getPaymasterStubData') {
        if (
            value.result.isFinal !== undefined &&
            typeof value.result.isFinal !== 'boolean'
        ) {
            throw new Error('CDP paymaster isFinal alanı geçersiz.');
        }
        if (value.result.isFinal !== undefined) {
            normalizedResult.isFinal = value.result.isFinal;
        }
        if (value.result.sponsor !== undefined) {
            if (
                !isPlainRecord(value.result.sponsor) ||
                typeof value.result.sponsor.name !== 'string' ||
                value.result.sponsor.name.length === 0 ||
                value.result.sponsor.name.length > 100 ||
                Object.keys(value.result.sponsor).some(
                    (field) => field !== 'name' && field !== 'icon',
                )
            ) {
                throw new Error('CDP paymaster sponsor alanı geçersiz.');
            }
            let icon: string | undefined;
            if (value.result.sponsor.icon !== undefined) {
                if (
                    typeof value.result.sponsor.icon !== 'string' ||
                    value.result.sponsor.icon.length > 2_048
                ) {
                    throw new Error('CDP paymaster sponsor icon alanı geçersiz.');
                }
                let iconUrl: URL;
                try {
                    iconUrl = new URL(value.result.sponsor.icon);
                } catch {
                    throw new Error(
                        'CDP paymaster sponsor icon URL alanı geçersiz.',
                    );
                }
                if (
                    iconUrl.protocol !== 'https:' ||
                    iconUrl.username ||
                    iconUrl.password
                ) {
                    throw new Error(
                        'CDP paymaster sponsor icon güvenli HTTPS değil.',
                    );
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
        jsonrpc: '2.0',
        id: requestId,
        result: normalizedResult,
    };
}

async function readProviderResponse(
    response: globalThis.Response,
    requestId: JsonRpcId,
    method: JsonRpcRequest['method'],
): Promise<Record<string, unknown>> {
    const declaredLength = response.headers.get('content-length');
    if (
        declaredLength &&
        Number.isFinite(Number(declaredLength)) &&
        Number(declaredLength) > MAX_RESPONSE_BYTES
    ) {
        throw new Error('CDP paymaster yanıtı boyut sınırını aşıyor.');
    }

    const raw = await response.text();
    if (Buffer.byteLength(raw, 'utf8') > MAX_RESPONSE_BYTES) {
        throw new Error('CDP paymaster yanıtı boyut sınırını aşıyor.');
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new Error('CDP paymaster JSON olmayan bir yanıt döndürdü.');
    }
    return validateProviderResponse(parsed, requestId, method);
}

const router = Router();

const sponsorLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 20,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (req, res) => {
        const body = isPlainRecord(req.body) ? req.body : {};
        const id =
            typeof body.id === 'string' || typeof body.id === 'number'
                ? body.id
                : null;
        rpcError(
            res,
            429,
            -32005,
            'Paymaster istek limiti aşıldı. Lütfen daha sonra tekrar deneyin.',
            id,
        );
    },
});

router.post('/sponsor', sponsorLimiter, async (req: Request, res: Response) => {
    if (process.env.PAYMASTER_PROXY_ENABLED !== 'true') {
        const body = isPlainRecord(req.body) ? req.body : {};
        const id =
            typeof body.id === 'string' || typeof body.id === 'number'
                ? body.id
                : null;
        return rpcError(
            res,
            503,
            -32003,
            'Base paymaster sponsorship is not enabled.',
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
        return rpcError(res, 400, -32600, 'Geçersiz paymaster isteği.', null);
    }

    let paymasterUrl: URL;
    try {
        paymasterUrl = resolvePaymasterUrl();
    } catch {
        return rpcError(
            res,
            503,
            -32003,
            'Base paymaster sağlayıcısı sunucuda kullanıma hazır değil.',
            validatedRequest.id,
        );
    }

    try {
        const response = await fetch(paymasterUrl, {
            method: 'POST',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(validatedRequest),
            signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
        });
        const data = await readProviderResponse(
            response,
            validatedRequest.id,
            validatedRequest.method,
        );

        res.setHeader('Cache-Control', 'no-store');
        return res.status(response.ok ? 200 : response.status).json(data);
    } catch {
        return rpcError(
            res,
            502,
            -32003,
            'Base paymaster sağlayıcısına güvenli biçimde ulaşılamadı.',
            validatedRequest.id,
        );
    }
});

export default router;
