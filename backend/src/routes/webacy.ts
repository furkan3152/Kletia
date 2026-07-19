import express from 'express';
import { WebacyClient, Chain } from '@webacy-xyz/sdk';
import rateLimit from 'express-rate-limit';

const router = express.Router();

const withTimeout = (promise: Promise<any>, ms: number) => {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('Webacy API Timeout')), ms))
    ]);
};

const apiLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 60, // Limit each IP to 60 requests per `window`
    message: { status: 'error', message: 'Too many requests, please try again later.' },
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers
});

// Apply rate limiter to all Webacy routes to prevent API key abuse
router.use(apiLimiter);

const webacyClient = process.env.WEBACY_API_KEY 
    ? new WebacyClient({ apiKey: process.env.WEBACY_API_KEY, defaultChain: Chain.BASE }) 
    : null;

router.get('/address/:address', async (req, res) => {
    const address = req.params.address;
    if (!address) {
        return res.status(400).json({ status: 'error', message: 'Address is required' });
    }

    if (!webacyClient) {
        return res.status(503).json({ status: 'error', message: 'Webacy API is not configured' });
    }

    try {
        const profile = await webacyClient.threat.addresses.analyze(address);
        res.json({
            status: 'success',
            riskScore: profile.overallRisk || 0,
            riskLevel: profile.overallRisk > 50 ? 'High' : (profile.overallRisk > 20 ? 'Medium' : 'Low'),
            tags: profile.tags?.map((t: any) => t.name) || []
        });
    } catch (error: any) {
        console.error("Webacy Profile Fetch Error:", error);
        res.status(500).json({ status: 'error', message: error.message });
    }
});

// Unified scan endpoint for UI Widget & Tx Interception
router.get('/scan/:address', async (req, res) => {
    let address = req.params.address;
    if (!address) return res.status(400).json({ status: 'error', message: 'Address is required' });
    if (!webacyClient) return res.status(503).json({ status: 'error', message: 'Webacy API is not configured' });

    address = address.toLowerCase(); // FIX: Prevent Webacy SDK checksum validation errors

    try {
        let isContract = true;
        let risk: any = null;
        
        try {
            // First try checking as a contract
            risk = await withTimeout(webacyClient.threat.contracts.analyze(address), 8000);
        } catch (err: any) {
            // Webacy SDK throws an error if it's not a contract or something fails in that endpoint.
            // Fallback to address (EOA) check
            isContract = false;
            risk = await withTimeout(webacyClient.threat.addresses.analyze(address), 8000);
        }

        const score = risk.score ?? risk.overallRisk ?? 0;
        
        let allTags: string[] = [];
        if (risk.tags && Array.isArray(risk.tags)) {
            allTags.push(...risk.tags.map((t: any) => t.name || t));
        }
        if (risk.issues && Array.isArray(risk.issues)) {
            risk.issues.forEach((issue: any) => {
                if (issue.tags && Array.isArray(issue.tags)) {
                    allTags.push(...issue.tags.map((t: any) => t.name || t));
                }
            });
        }
        allTags = [...new Set(allTags)]; // Remove duplicates
        
        let finalScore = score;
        const criticalTags = ['Sanctioned', 'OFAC Sanctioned', 'Scam', 'Phishing', 'Fraud', 'Hack', 'Exploit', 'Malicious', 'Blacklist', 'Drainer'];
        const hasCriticalRisk = allTags.some(tag => criticalTags.some(c => tag.toLowerCase().includes(c.toLowerCase())));
        
        // Community-Sourced / Local Blacklist (Real Threat Intelligence)
        // These are known scams that might not be flagged by Webacy on the Base chain yet.
        const communityBlacklist = [
            '0xd90e2f925da726b50c4ed8d0fb90ad053324f31b'.toLowerCase(), // Tornado Cash
            '0x0c99ae577ba40a81144beb7c504f2c74adb318e8'.toLowerCase(), // Magnate Finance
            '0x5ced88f3c35bf7a7b5cbd5098ebb1c92e21dfa0c'.toLowerCase()  // LeetSwap
        ];

        const isCommunityBlacklisted = communityBlacklist.includes(address.toLowerCase());

        if (hasCriticalRisk || isCommunityBlacklisted) {
            finalScore = 100;
            if (isCommunityBlacklisted && !hasCriticalRisk) {
                allTags.push('Community Blacklisted Scam');
            }
        }

        res.json({
            status: 'success',
            isContract,
            riskScore: finalScore,
            riskLevel: finalScore > 50 ? 'High' : (finalScore > 20 ? 'Medium' : 'Low'),
            tags: allTags,
            raw: risk
        });
    } catch (error: any) {
        console.error("Webacy Unified Scan Error:", error);
        res.status(500).json({ status: 'error', message: error.message });
    }
});

export default router;
