import express from 'express';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { BatchSettlementEvmScheme } from '@x402/evm/batch-settlement/server';

const router = express.Router();

import jwt from 'jsonwebtoken';
import crypto from 'crypto';

// ── Config ──────────────────────────────────────────────────────────────
const X402_PAYMENT_ADDRESS = process.env.KLETIA_FEE_RECIPIENT || process.env.X402_TREASURY_ADDRESS || "0xFf3a3CFC42D27E85DbA9Ea85f0bFEC34bd632f9A";
const DEFAULT_PRICE = "$0.01";

// ── CDP Facilitator (Base Mainnet) ──────────────────────────────────────
const generateCdpToken = (method: string, requestPath: string) => {
  const keyName = process.env.CDP_API_KEY_NAME;
  const keySecret = process.env.CDP_API_KEY_PRIVATE_KEY?.replace(/\\n/g, '\n');
  if (!keyName || !keySecret) return "";
  return jwt.sign(
      {
          iss: "cdp",
          nbf: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 120,
          sub: keyName,
          uri: `${method} api.cdp.coinbase.com${requestPath}`,
      },
      keySecret,
      { algorithm: 'ES256', keyid: keyName, header: { kid: keyName, nonce: crypto.randomUUID() } }
  );
};

const cdpFacilitatorClient = new HTTPFacilitatorClient({
  url: "https://api.cdp.coinbase.com/platform/v2/x402",
  createAuthHeaders: async () => ({
    supported: { Authorization: `Bearer ${generateCdpToken('GET', '/platform/v2/x402/supported')}` },
    verify: { Authorization: `Bearer ${generateCdpToken('POST', '/platform/v2/x402/verify')}` },
    settle: { Authorization: `Bearer ${generateCdpToken('POST', '/platform/v2/x402/settle')}` }
  })
});

// ── Debug logging for settle calls ──────────────────────────────────────
const originalSettle = cdpFacilitatorClient.settle.bind(cdpFacilitatorClient);
cdpFacilitatorClient.settle = async function(args: any) {
  console.log("🔄 CDP SETTLE CALLED with args:", JSON.stringify(args, null, 2).substring(0, 500));
  try {
    const result = await originalSettle(args);
    console.log("✅ CDP SETTLE SUCCESS:", JSON.stringify(result, null, 2));
    return result;
  } catch (err: any) {
    console.error("❌ CDP SETTLE ERROR:", err.message);
    if (err.response) {
      try {
        const body = typeof err.response === 'string' ? err.response : JSON.stringify(err.response);
        console.error("❌ CDP SETTLE RESPONSE BODY:", body);
      } catch(e) {
        console.error("❌ CDP SETTLE RESPONSE (raw):", err.response);
      }
    }
    throw err;
  }
};

// ── x402 Resource Server ────────────────────────────────────────────────
const resourceServer = new x402ResourceServer(cdpFacilitatorClient)
  .register("eip155:8453", new BatchSettlementEvmScheme());

// ── Protected route paths ───────────────────────────────────────────────
const PROTECTED_PATHS = [
  '/alpha-signals',
  '/optimal-routes',
  '/yield-strategy',
  '/route-solver',
  '/sybil-report'
];

// ── Dynamic x402 Middleware ─────────────────────────────────────────────
// Creates per-request middleware so payTo can be dynamic (from ?gateway= param)
const dynamicX402Middleware = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  // Skip non-protected paths
  if (!PROTECTED_PATHS.includes(req.path)) {
    return next();
  }

  // Resolve dynamic payTo from query params
  const gateway = req.query.gateway as string;
  const payTo = gateway || X402_PAYMENT_ADDRESS;
  const price = req.query.price ? `$${req.query.price}` : DEFAULT_PRICE;

  console.log(`💰 x402 REQUEST: ${req.method} ${req.path} → payTo=${payTo}, price=${price}`);

  // Create route config with resolved payTo address
  const routeKey = `${req.method} ${req.path}`;
  const routesConfig: any = {
    [routeKey]: {
      accepts: [{
        scheme: "batch-settlement",
        price: price,
        network: "eip155:8453",
        payTo: payTo
      }],
      description: `Kletia Premium: ${req.path.replace('/', '')}`,
      mimeType: "application/json"
    }
  };

  // Execute x402 middleware for this specific request
  const mw = paymentMiddleware(routesConfig, resourceServer);
  mw(req, res, next);
};

// ── Debug Endpoint (Hata Motoru) ────────────────────────────────────────
router.get('/debug-x402', async (req, res) => {
  try {
    const gateway = req.query.gateway || X402_PAYMENT_ADDRESS;
    const targetUrl = `http://localhost:${process.env.PORT || 3001}/api/premium/alpha-signals?gateway=${gateway}`;
    
    const response = await fetch(targetUrl);
    
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
      success: true,
      message: "x402 Debug Engine Active",
      x402_status: response.status,
      x402_headers: headersObj,
      payTo_used: gateway,
      decoded_payment_required: decoded
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── x402 Config Info Endpoint ───────────────────────────────────────────
router.get('/x402-config', (req, res) => {
  res.json({
    status: "success",
    data: {
      network: "eip155:8453",
      networkName: "Base Mainnet",
      scheme: "exact",
      defaultPayTo: X402_PAYMENT_ADDRESS,
      defaultPrice: DEFAULT_PRICE,
      facilitator: "https://api.cdp.coinbase.com/platform/v2/x402",
      protectedEndpoints: PROTECTED_PATHS,
      usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
    }
  });
});

// ── Pre-x402 Debug Logger ───────────────────────────────────────────────
router.use((req, res, next) => {
  if (PROTECTED_PATHS.includes(req.path)) {
    console.log(`📡 x402 DEBUG: ${req.method} ${req.path} | gateway=${req.query.gateway || 'default'} | hasPayment=${!!req.headers['x-payment'] || !!req.headers['payment-signature']}`);
  }
  next();
});

// ── x402 Payment Wall ───────────────────────────────────────────────────
router.use(dynamicX402Middleware);

// ── Premium Data Endpoints ──────────────────────────────────────────────
router.get('/alpha-signals', async (req, res) => {
  try {
    const response = await fetch('https://api.llama.fi/protocols');
    const protocols = await response.json();
    const baseProtocols = protocols.filter((p: any) =>
      p.chain === 'Base' || (p.chains && p.chains.includes('Base'))
    );
    const topGrowers = baseProtocols
      .filter((p: any) => p.change_7d && p.tvl > 1000000)
      .sort((a: any, b: any) => b.change_7d - a.change_7d)
      .slice(0, 3)
      .map((p: any) => ({
        token: p.symbol || p.name,
        name: p.name,
        tvl: `$${(p.tvl / 1e6).toFixed(2)}M`,
        growth7d: `${p.change_7d.toFixed(2)}%`,
        recommendation: p.change_7d > 20 ? "STRONG BUY" : "BUY",
        reason: `Base ağında son 7 günde TVL'si ${p.change_7d.toFixed(2)}% arttı.`
      }));
    res.json({
      status: "success",
      data: {
        service: "Kletia Premium Intelligence (DefiLlama)",
        alphaSignals: topGrowers,
        timestamp: Date.now()
      }
    });
  } catch (error) {
    res.json({ status: "error", message: "Veri çekilirken hata oluştu." });
  }
});

router.get('/optimal-routes', (req, res) => {
  res.json({
    status: "success",
    data: {
      service: "Kletia Premium Intelligence",
      premiumRouting: {
        optimalPath: "USDC -> Aerodrome (0.01%) -> WETH",
        estimatedSlippage: "0.05%",
        expectedYieldBoost: "+2.4%"
      },
      timestamp: Date.now()
    }
  });
});

router.get('/route-solver', (req, res) => {
  res.json({
    status: "success",
    data: {
      service: "Kletia MEV Arbitrage Solver",
      arbitrageOpportunity: {
        route: "USDC (Aave Flashloan) -> WETH (Uniswap V3) -> USDC (Aerodrome) -> Repay",
        guaranteedProfitUsdc: "12.45",
        gasCostEstimated: "0.15",
        calldata: "0xdeadbeef...",
        targetContract: "0xArbitrageExecutor...",
        message: "KletiaVault 'execute' fonksiyonu ile çağırarak anında kâr edebilirsiniz."
      },
      timestamp: Date.now()
    }
  });
});

router.get('/yield-strategy', async (req, res) => {
  try {
    const response = await fetch('https://yields.llama.fi/pools');
    const data = await response.json();
    const basePools = data.data.filter((p: any) => p.chain === 'Base' && p.tvlUsd > 1000000);
    const topPools = basePools
      .sort((a: any, b: any) => b.apy - a.apy)
      .slice(0, 3)
      .map((p: any) => ({
        project: p.project,
        symbol: p.symbol,
        apy: `${p.apy.toFixed(2)}%`,
        tvl: `$${(p.tvlUsd / 1e6).toFixed(2)}M`,
        strategy: `Likiditeyi ${p.project} üzerindeki ${p.symbol} havuzuna sağlayın.`
      }));
    res.json({
      status: "success",
      data: {
        service: "Kletia Premium Yield Strategist",
        topYieldPools: topPools,
        timestamp: Date.now()
      }
    });
  } catch (error) {
    res.json({ status: "error", message: "Yield stratejisi alınırken hata oluştu." });
  }
});

router.get('/sybil-report', async (req, res) => {
  const address = req.query.address as string;
  if (!address) {
    return res.json({ status: "error", message: "Address is required" });
  }
  try {
    const txRes = await fetch(`https://base.blockscout.com/api?module=account&action=txlist&address=${address}&startblock=0&endblock=99999999&page=1&offset=10000&sort=asc`);
    const txData = await txRes.json();
    const normalTxs = txData.status === "1" ? txData.result : [];
    const BASE_LAUNCH_TIMESTAMP = 1691539200 * 1000;
    let firstTxTimestamp = Date.now();
    const activeDaysSet = new Set<string>();
    const txCountsByDay: Record<string, number> = {};
    for (const tx of normalTxs) {
      const timestamp = parseInt(tx.timeStamp) * 1000;
      if (timestamp < firstTxTimestamp) firstTxTimestamp = timestamp;
      const dateStr = new Date(timestamp).toISOString().split('T')[0];
      activeDaysSet.add(dateStr);
      txCountsByDay[dateStr] = (txCountsByDay[dateStr] || 0) + 1;
    }
    if (firstTxTimestamp < BASE_LAUNCH_TIMESTAMP) firstTxTimestamp = BASE_LAUNCH_TIMESTAMP;
    const accountAgeDays = Math.max(1, Math.floor((Date.now() - firstTxTimestamp) / (1000 * 60 * 60 * 24)));
    const activeDays = activeDaysSet.size;
    const counts = Object.values(txCountsByDay);
    const mean = counts.length ? counts.reduce((a, b) => a + b, 0) / counts.length : 0;
    const variance = counts.length ? counts.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / counts.length : 0;
    let sybilDiagnosis = "Organik Kullanıcı";
    if (variance > 50 && activeDays < 5) sybilDiagnosis = "YÜKSEK RİSK";
    else if (variance > 20 && activeDays < 10) sybilDiagnosis = "ORTA RİSK";
    res.json({
      status: "success",
      data: {
        service: "Kletia Premium Sybil Engine",
        address,
        walletAgeDays: accountAgeDays,
        activeDaysCount: activeDays,
        transactionDistributionVariance: variance.toFixed(2),
        diagnosis: sybilDiagnosis,
        timestamp: Date.now()
      }
    });
  } catch (error: any) {
    res.json({ status: "error", message: "Analiz hatası: " + error.message });
  }
});

export default router;
