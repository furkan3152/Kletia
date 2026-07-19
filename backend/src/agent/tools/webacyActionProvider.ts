import { customActionProvider } from "@coinbase/agentkit";
import { z } from "zod";
import { WebacyClient, Chain } from '@webacy-xyz/sdk';

let _client: WebacyClient | null = null;
function getClient() {
    if (!_client) {
        const apiKey = process.env.WEBACY_API_KEY || "";
        if (!apiKey) {
            console.warn("WEBACY_API_KEY is missing. WebacyActionProvider may not function properly.");
        }
        _client = new WebacyClient({ apiKey, defaultChain: Chain.BASE });
    }
    return _client;
}

export function webacyActionProvider() {
    return customActionProvider({
        name: "check_contract_risk",
        description: "Checks a smart contract address for vulnerabilities, malicious behavior, or high risks using Webacy's Risk Engine. Use this BEFORE interacting with any unknown or user-provided contract address.",
        schema: z.object({
            contractAddress: z.string().describe("The smart contract address to analyze")
        }),
        invoke: async (args: { contractAddress: string }) => {
            try {
                const client = getClient();
                const risk = await client.threat.contracts.analyze(args.contractAddress);
                if (risk.score > 50) {
                     return `WARNING: Contract is HIGH RISK (Score: ${risk.score}). Tags: ${risk.tags.map(t => t.name).join(', ')}. Do not interact unless explicitly overridden by the user.`;
                }
                return `Contract is SAFE (Score: ${risk.score}). You may proceed with interactions.`;
            } catch (error: any) {
                return `Failed to analyze contract risk: ${error.message}`;
            }
        }
    });
}
