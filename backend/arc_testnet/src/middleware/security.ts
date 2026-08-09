import { Request, Response, NextFunction } from 'express';
import { getAddress } from 'viem';
import { WebacyClient, Chain } from '@webacy-xyz/sdk';

const webacyClient = process.env.WEBACY_API_KEY 
    ? new WebacyClient({ apiKey: process.env.WEBACY_API_KEY, defaultChain: Chain.BASE }) 
    : null;

export async function validateAddress(req: Request, res: Response, next: NextFunction) {
    const userAddress = req.body?.userAddress;

    const addressToCheck = userAddress || req.query.userAddress;

    if (addressToCheck) {
        try {

            const validAddress = getAddress(addressToCheck as string);
            if (req.body) {
                req.body.userAddress = validAddress;
            }
            if (req.query && req.query.userAddress) {
                req.query.userAddress = validAddress;
            }

            if (webacyClient) {
                try {
                    const risk = await webacyClient.threat.addresses.analyze(validAddress);
                    if ((risk as any)?.overallRisk > 50) {
                        return res.status(403).json({
                            status: 'error',
                            error: 'HIGH_RISK_ADDRESS',
                            message: `Webacy Risk Engine detected high risk for this address (Score: ${risk.overallRisk}). Access denied.`
                        });
                    }
                } catch (webacyError) {
                    console.error("Webacy Address Risk Check Failed:", webacyError);
                }
            }
        } catch (error) {
            return res.status(400).json({ 
                status: 'error', 
                error: 'INVALID_ADDRESS',
                message: 'Geçersiz cüzdan adresi formatı. Lütfen doğru bir EVM adresi girin.' 
            });
        }
    }
    next();
}

export async function sanitizePrompt(req: Request, res: Response, next: NextFunction) {
    if (req.body.prompt) {
        let prompt = req.body.prompt;

        if (prompt.length > 500) {
            prompt = prompt.substring(0, 500);
        }

        prompt = prompt.replace(/<[^>]*>?/gm, '');

        // Webacy URL Risk Check
        if (webacyClient) {
            // Extract URLs from prompt
            const urlRegex = /(https?:\/\/[^\s]+)/g;
            const urls = prompt.match(urlRegex) || [];

            for (const url of urls) {
                try {
                    const urlRisk = await (webacyClient.threat as any).url.check(url);
                    if (urlRisk.is_malicious) {
                         return res.status(403).json({
                            status: 'error',
                            error: 'MALICIOUS_URL_DETECTED',
                            message: `Webacy Risk Engine detected a malicious URL in your prompt: ${url}`
                        });
                    }
                } catch (urlError) {
                    console.error("Webacy URL Risk Check Failed:", urlError);
                }
            }
        }

        req.body.prompt = prompt;
    }
    next();
}
