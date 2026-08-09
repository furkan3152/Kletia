import { Router } from 'express';

const router = Router();

const ALLORA_PRICE_URL =
    'https://api.allora.network/v2/allora/consumer/price/ethereum-11155111';
const BINANCE_PRICE_URL = 'https://api.binance.com/api/v3/ticker/price';
const PROVIDER_TIMEOUT_MS = 8_000;
const SUPPORTED_ASSETS = ['BTC', 'ETH'] as const;
const SUPPORTED_TIMEFRAMES = ['5m', '8h'] as const;
const FLAT_THRESHOLD_PERCENT = 0.05;

type SupportedAsset = (typeof SUPPORTED_ASSETS)[number];
type SupportedTimeframe = (typeof SUPPORTED_TIMEFRAMES)[number];
type Direction = 'UP' | 'DOWN' | 'FLAT';

interface PriceObservation {
    asset: SupportedAsset;
    timeframe: SupportedTimeframe;
    currentPrice: string;
    predictedPrice: string;
    predictedDeltaPercent: string;
    direction: Direction;
    fetchedAt: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function parseAsset(value: unknown): SupportedAsset | null {
    if (typeof value !== 'string') return null;
    const normalized = value.trim().toUpperCase();
    return SUPPORTED_ASSETS.includes(normalized as SupportedAsset)
        ? normalized as SupportedAsset
        : null;
}

function parseTimeframe(value: unknown): SupportedTimeframe | null {
    if (typeof value !== 'string') return null;
    const normalized = value.trim().toLowerCase();
    return SUPPORTED_TIMEFRAMES.includes(normalized as SupportedTimeframe)
        ? normalized as SupportedTimeframe
        : null;
}

async function fetchJson(
    url: string,
    init: RequestInit = {},
): Promise<{ response: Response; data: unknown }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);

    try {
        const response = await fetch(url, {
            ...init,
            signal: controller.signal,
        });
        const data: unknown = await response.json();
        return { response, data };
    } finally {
        clearTimeout(timeout);
    }
}

function extractAlloraPrice(payload: unknown): number {
    const root = asRecord(payload);
    const data = asRecord(root?.data);
    const inference = asRecord(
        data?.inference_data ?? root?.inference_data,
    );
    const rawPrice = inference?.network_inference_normalized;
    const price = typeof rawPrice === 'string' || typeof rawPrice === 'number'
        ? Number(rawPrice)
        : Number.NaN;

    if (!root || root.status === false || !Number.isFinite(price) || price <= 0) {
        throw new Error('INVALID_ALLORA_RESPONSE');
    }
    return price;
}

async function getPredictedPrice(
    asset: SupportedAsset,
    timeframe: SupportedTimeframe,
    apiKey: string,
): Promise<number> {
    const { response, data } = await fetchJson(
        `${ALLORA_PRICE_URL}/${asset}/${timeframe}`,
        {
            method: 'GET',
            headers: {
                accept: 'application/json',
                'x-api-key': apiKey,
            },
        },
    );

    if (!response.ok) {
        throw new Error('ALLORA_REQUEST_FAILED');
    }
    return extractAlloraPrice(data);
}

async function getCurrentPrice(asset: SupportedAsset): Promise<number> {
    const expectedSymbol = `${asset}USDT`;
    const { response, data } = await fetchJson(
        `${BINANCE_PRICE_URL}?symbol=${expectedSymbol}`,
        {
            method: 'GET',
            headers: { accept: 'application/json' },
        },
    );
    const payload = asRecord(data);
    const rawPrice = payload?.price;
    const price = typeof rawPrice === 'string' || typeof rawPrice === 'number'
        ? Number(rawPrice)
        : Number.NaN;

    if (
        !response.ok ||
        payload?.symbol !== expectedSymbol ||
        !Number.isFinite(price) ||
        price <= 0
    ) {
        throw new Error('INVALID_BINANCE_RESPONSE');
    }
    return price;
}

async function getObservation(
    asset: SupportedAsset,
    timeframe: SupportedTimeframe,
    apiKey: string,
): Promise<PriceObservation> {
    const [currentPrice, predictedPrice] = await Promise.all([
        getCurrentPrice(asset),
        getPredictedPrice(asset, timeframe, apiKey),
    ]);
    const deltaPercent =
        ((predictedPrice - currentPrice) / currentPrice) * 100;
    const direction: Direction =
        deltaPercent > FLAT_THRESHOLD_PERCENT
            ? 'UP'
            : deltaPercent < -FLAT_THRESHOLD_PERCENT
                ? 'DOWN'
                : 'FLAT';

    return {
        asset,
        timeframe,
        currentPrice: currentPrice.toFixed(2),
        predictedPrice: predictedPrice.toFixed(2),
        predictedDeltaPercent: deltaPercent.toFixed(3),
        direction,
        fetchedAt: new Date().toISOString(),
    };
}

function logProviderFailure(scope: string, error: unknown) {
    const errorName = error instanceof Error ? error.name : 'UnknownError';
    console.error(`[Allora] ${scope} provider request failed (${errorName}).`);
}

router.get('/prediction', async (req, res) => {
    const asset = parseAsset(req.query.asset);
    const timeframe = req.query.timeframe === undefined
        ? '5m'
        : parseTimeframe(req.query.timeframe);
    if (!asset) {
        return res.status(400).json({
            success: false,
            error: 'asset must be BTC or ETH.',
        });
    }
    if (!timeframe) {
        return res.status(400).json({
            success: false,
            error: 'timeframe must be 5m or 8h.',
        });
    }

    const apiKey = process.env.ALLORA_API_KEY?.trim();
    if (!apiKey) {
        return res.status(503).json({
            success: false,
            error: 'Live prediction service is unavailable.',
        });
    }

    try {
        const observation = await getObservation(asset, timeframe, apiKey);
        res.setHeader('Cache-Control', 'no-store');
        return res.json({ success: true, data: observation });
    } catch (error) {
        logProviderFailure('single', error);
        return res.status(502).json({
            success: false,
            error: 'Live prediction data is temporarily unavailable.',
        });
    }
});

router.post('/multi-prediction', async (req, res) => {
    const rawAssets = asRecord(req.body)?.assets;
    if (
        !Array.isArray(rawAssets) ||
        rawAssets.length === 0 ||
        rawAssets.length > SUPPORTED_ASSETS.length
    ) {
        return res.status(400).json({
            success: false,
            error: 'assets must contain one or two unique BTC/ETH values.',
        });
    }

    const assets = rawAssets.map(parseAsset);
    if (
        assets.some((asset) => asset === null) ||
        new Set(assets).size !== assets.length
    ) {
        return res.status(400).json({
            success: false,
            error: 'assets must contain one or two unique BTC/ETH values.',
        });
    }

    const rawTimeframe = asRecord(req.body)?.timeframe;
    const timeframe = rawTimeframe === undefined
        ? '5m'
        : parseTimeframe(rawTimeframe);
    if (!timeframe) {
        return res.status(400).json({
            success: false,
            error: 'timeframe must be 5m or 8h.',
        });
    }

    const apiKey = process.env.ALLORA_API_KEY?.trim();
    if (!apiKey) {
        return res.status(503).json({
            success: false,
            error: 'Live prediction service is unavailable.',
        });
    }

    try {
        const observations = await Promise.all(
            (assets as SupportedAsset[]).map((asset) =>
                getObservation(asset, timeframe, apiKey),
            ),
        );
        res.setHeader('Cache-Control', 'no-store');
        return res.json({ success: true, data: observations });
    } catch (error) {
        logProviderFailure('multi', error);
        return res.status(502).json({
            success: false,
            error: 'Live prediction data is temporarily unavailable.',
        });
    }
});

export default router;
