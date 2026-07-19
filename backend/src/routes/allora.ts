import { Router } from 'express';

const router = Router();

router.get('/prediction', async (req, res) => {
    try {
        const { asset, timeframe } = req.query; // e.g. asset=ETH, timeframe=5m
        const apiKey = process.env.ALLORA_API_KEY;

        if (!asset) {
            return res.status(400).json({ success: false, error: "Asset parametresi zorunludur" });
        }

        const tf = timeframe || '5m'; // Default 5m

        if (!apiKey) {
            return res.status(500).json({ success: false, error: "Allora API Anahtarı eksik! Lütfen backend'e ALLORA_API_KEY ekleyin." });
        }

        // Real API Call
        const response = await fetch(`https://api.allora.network/v2/allora/consumer/price/ethereum-11155111/${asset}/${tf}`, {
            method: 'GET',
            headers: {
                'accept': 'application/json',
                'x-api-key': apiKey
            }
        });

        const data = await response.json();
        
        if (!response.ok) {
            throw new Error(data.apiResponseMessage || 'Allora API Hatası');
        }
        
        const predictedPrice = data?.data?.inference_data?.network_inference_normalized || data?.inference_data?.network_inference_normalized;

        res.json({
            success: true,
            isMock: false,
            data: {
                asset,
                timeframe: tf,
                predictedPrice: predictedPrice ? parseFloat(predictedPrice).toFixed(2) : "0.00",
                raw: data
            }
        });

    } catch (error: any) {
        console.error("Allora API Hatası:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});



// Binance üzerinden güncel fiyat çekici
async function getCurrentPrice(symbol: string): Promise<number> {
    try {
        const binanceSymbol = symbol === 'BTC' || symbol === 'ETH' ? `${symbol}USDT` : null;
        if (!binanceSymbol) return 0;
        
        const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${binanceSymbol}`);
        const data = await res.json();
        if (data && data.price) {
            return parseFloat(data.price);
        }
        return 0;
    } catch (e) {
        console.error(`Binance Fiyat Hatası (${symbol}):`, e);
        return 0;
    }
}

router.post('/multi-prediction', async (req, res) => {
    try {
        const { assets, timeframe } = req.body; 
        const apiKey = process.env.ALLORA_API_KEY;

        if (!assets || !Array.isArray(assets)) {
            return res.status(400).json({ success: false, error: "assets array parametresi zorunludur" });
        }

        const tf = timeframe || '5m';

        if (!apiKey) {
            return res.status(500).json({ success: false, error: "Allora API Anahtarı eksik!" });
        }

        const promises = assets.map(async (asset) => {
            try {
                // 1. Anlık Fiyatı Çek
                const currentPrice = await getCurrentPrice(asset);

                // 2. Allora Tahminini Çek
                const response = await fetch(`https://api.allora.network/v2/allora/consumer/price/ethereum-11155111/${asset}/${tf}`, {
                    method: 'GET',
                    headers: { 'accept': 'application/json', 'x-api-key': apiKey }
                });
                const data = await response.json();
                if (!response.ok) throw new Error('API Hatası');
                
                const predictedPriceStr = data?.data?.inference_data?.network_inference_normalized || data?.inference_data?.network_inference_normalized;
                const predictedPrice = predictedPriceStr ? parseFloat(predictedPriceStr) : 0;
                
                // 3. Karşılaştırma Analizi
                let differencePercent = 0;
                let recommendation = 'HOLD';

                if (currentPrice > 0 && predictedPrice > 0) {
                    differencePercent = ((predictedPrice - currentPrice) / currentPrice) * 100;
                    
                    if (differencePercent > 0.05) { // Çok ufak dalgalanmaları filtrelemek için %0.05 barajı
                        recommendation = 'BUY';
                    } else if (differencePercent < -0.05) {
                        recommendation = 'SELL';
                    }
                }

                return {
                    asset,
                    currentPrice: currentPrice > 0 ? currentPrice.toFixed(2) : "0.00",
                    predictedPrice: predictedPrice > 0 ? predictedPrice.toFixed(2) : "0.00",
                    differencePercent: differencePercent.toFixed(3),
                    recommendation
                };
            } catch (e) {
                return { 
                    asset, 
                    currentPrice: "0.00", 
                    predictedPrice: "0.00", 
                    differencePercent: "0.00",
                    recommendation: "ERROR" 
                };
            }
        });

        const results = await Promise.all(promises);
        
        res.json({
            success: true,
            data: results
        });

    } catch (error: any) {
        console.error("Allora Multi API Hatası:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});


export default router;
