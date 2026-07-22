import { Router } from 'express';

const router = Router();

router.post('/sponsor', async (req, res) => {
    try {
        const keyName = process.env.CDP_API_KEY_NAME;
        const keySecret = process.env.CDP_API_KEY_PRIVATE_KEY?.replace(/\\n/g, '\n');

        // Note: For Coinbase Paymaster, the URL uses the Paymaster API endpoint from the dashboard.
        // It's usually https://api.developer.coinbase.com/rpc/v1/base/CDP_API_KEY_ID
        // But some paymasters require JWT or simple POST. Since we use onchainkit or wagmi, they send standard JSON-RPC.
        const paymasterUrl = `https://api.developer.coinbase.com/rpc/v1/base/${process.env.CDP_API_KEY_ID}`;

        // Forward the exact JSON-RPC request to the CDP Paymaster
        const response = await fetch(paymasterUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(req.body)
        });

        const data = await response.json();
        
        if (!response.ok) {
            console.error("Paymaster Error from CDP:", data);
            return res.status(response.status).json(data);
        }

        res.json(data);

    } catch (error: any) {
        console.error("Paymaster Proxy Error:", error);
        res.status(500).json({ error: error.message });
    }
});

export default router;
