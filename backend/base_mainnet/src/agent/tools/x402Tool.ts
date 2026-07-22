import { customActionProvider } from '@coinbase/agentkit';
import { z } from 'zod';
import { ExactEvmScheme } from "@x402/evm";
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";

export async function getX402Tool(walletProvider: any) {
    const address = await walletProvider.getAddress();
    
    // Create an X402 compatible signer interface
    const signer = {
        address: address as `0x${string}`,
        signTypedData: async (params: any) => {
            console.log("X402 Signing Typed Data for address:", address);
            return await walletProvider.signTypedData(params);
        }
    };

    // Create fetch wrapper with v2 API
    const x402fetch = wrapFetchWithPaymentFromConfig(fetch, {
        schemes: [
            {
                network: "eip155:8453", // Base Mainnet
                client: new ExactEvmScheme(signer),
            },
            {
                network: "eip155:84532", // Base Sepolia fallback
                client: new ExactEvmScheme(signer),
            }
        ],
    });

    return customActionProvider({
        name: "fetch_x402_resource",
        description: "Fetches data from a URL. If the URL requires an X402 payment (e.g. premium data, alpha signals), it automatically pays the invoice using the user's secure CDP wallet and returns the data.",
        schema: z.object({
            url: z.string().describe("The URL to fetch")
        }),
        invoke: async (args: { url: string }) => {
            try {
                console.log(`🤖 Agent fetching URL with X402: ${args.url}`);
                const response = await x402fetch(args.url);
                
                if (response.ok) {
                    const contentType = response.headers.get("content-type");
                    if (contentType && contentType.includes("application/json")) {
                        const data = await response.json();
                        return `Success! Data: ${JSON.stringify(data)}`;
                    } else {
                        const text = await response.text();
                        return `Success! Text: ${text.substring(0, 500)}`;
                    }
                } else {
                    return `Request failed. Status: ${response.status} ${response.statusText}`;
                }
            } catch (error: any) {
                console.error("X402 Tool Error:", error);
                return `Error occurred: ${error.message}`;
            }
        }
    });
}
