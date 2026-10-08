/**
 * Code snippets shown on the home page and in the developer portal. They
 * mirror packages/sdk/README.md and docs/platform/api-v1.md; keep them in
 * sync when the public API changes.
 */
import { PREVIEW_ACCOUNTS } from "../../shared/platform/kletiaClient";

export const API_BASE_URL = "https://api.kletiaai.xyz";

/** Prompts the v1 grammar accepts (subset of the API's GRAMMAR_EXAMPLES). */
export const INTENT_EXAMPLES: readonly string[] = [
  "swap 1 SOL to USDC",
  "bridge 25 USDC from base to solana",
  "bridge 50 USDC from base to solana then swap half to JitoSOL",
  "move 0.01 ETH from arbitrum to solana as SOL",
  "stake 1.5 SOL with marinade",
  "bridge 20 USDC from solana to base and deposit it into aave",
];

export const SDK_INSTALL = "npm install @kletia/sdk";

export const SDK_PLAN_AND_EXECUTE = `import {
  KletiaClient,
  eip1193Signer,
  executeIntent,
  formatAccountId,
  walletStandardSolanaSigner,
} from "@kletia/sdk";

const kletia = new KletiaClient({ apiKey: process.env.KLETIA_API_KEY });

// 1. Plan: natural language (or structured actions) -> IntentGraph
const intent = await kletia.intents.create({
  text: "bridge 50 USDC from base to solana then swap half to JitoSOL",
  accounts: [
    formatAccountId("base", evmAddress),
    formatAccountId("solana", solanaAddress),
  ],
  constraints: { maxSlippageBps: 50 },
});

// 2. Execute: every step is signed by the wallet that owns it
const final = await executeIntent(kletia, intent, {
  evm: eip1193Signer(window.ethereum, evmAddress),
  solana: walletStandardSolanaSigner(wallet, account, "solana:mainnet"),
}, {
  onUpdate: (next) => render(next),
});`;

export const SDK_QUICKSTART = `import { KletiaClient, formatAccountId } from "@kletia/sdk";

const kletia = new KletiaClient(); // public tier; pass { apiKey } for more

const networks = await kletia.networks();
console.log(networks.map((network) => \`\${network.name}: \${network.actions.join(", ")}\`));

const intent = await kletia.intents.create(
  {
    text: "swap 1 SOL to USDC",
    accounts: [formatAccountId("solana", solanaAddress)],
  },
  { dryRun: true }, // plan and quote without persisting
);

for (const step of intent.steps) {
  console.log(step.title, step.expectedOutput?.formatted, step.expectedOutput?.symbol);
}`;

export const REST_CREATE_INTENT = `curl -X POST ${API_BASE_URL}/v1/intents \\
  -H "content-type: application/json" \\
  -H "authorization: Bearer $KLETIA_API_KEY" \\
  -d '{
    "text": "bridge 25 USDC from base to solana then swap half to JitoSOL",
    "accounts": [
      "eip155:8453:0x1111111111111111111111111111111111111111",
      "${PREVIEW_ACCOUNTS.solana}"
    ],
    "constraints": { "maxSlippageBps": 50 },
    "metadata": { "orderId": "A-1029" }
  }'`;

export const REST_STRUCTURED = `{
  "actions": [
    { "kind": "bridge", "network": "base", "from": "USDC", "amount": "25", "toNetwork": "solana", "to": "USDC" },
    { "kind": "swap", "network": "solana", "from": "USDC", "to": "JitoSOL", "amount": "max" }
  ],
  "accounts": ["eip155:8453:0x…", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:…"]
}`;

export const WIDGET_SNIPPET = `import { KletiaIntentWidget } from "@kletia/widget";
import { eip1193Signer, formatAccountId, walletStandardSolanaSigner } from "@kletia/sdk";

// Public tier: no API key in browser code. Pass the wallets your app already connected.
export function IntentPanel({ evm, solana }: ConnectedWallets) {
  return (
    <KletiaIntentWidget
      accounts={[
        formatAccountId("base", evm.address),
        formatAccountId("solana", solana.account.address),
      ]}
      signers={{
        evm: eip1193Signer(evm.provider, evm.address),
        solana: walletStandardSolanaSigner(solana.wallet, solana.account, "solana:mainnet"),
      }}
      defaultText="swap 1 SOL to USDC"
      theme="auto"
      onComplete={(intent) => console.log(intent.status)}
    />
  );
}`;

/** Query parameters accepted by the hosted /embed page. */
export const EMBED_PARAMS: readonly { name: string; values: string; description: string }[] = [
  { name: "theme", values: "light | dark | auto", description: "Widget and wallet bar theme. Defaults to auto (follows the visitor's OS)." },
  { name: "text", values: "string, max 500", description: "Prompt pre-filled in the widget." },
  { name: "examples", values: "comma separated, max 6", description: "Example chips under the prompt." },
  { name: "bg", values: "transparent", description: "Drops the page background so the widget sits on your page." },
];

/** Example /embed path (relative, so it also opens on preview deployments). */
export const EMBED_PATH =
  "/embed?theme=auto&text=swap%201%20SOL%20to%20USDC&examples=swap%201%20SOL%20to%20USDC,stake%202%20SOL%20with%20jito,bridge%2025%20USDC%20from%20base%20to%20solana";

export const EMBED_URL = `https://kletiaai.xyz${EMBED_PATH}`;

export const IFRAME_SNIPPET = `<iframe
  src="${EMBED_URL}"
  title="Kletia intents"
  width="492"
  height="720"
  style="border:0;max-width:100%"
  loading="lazy"
></iframe>`;

export const WEBHOOK_VERIFY = `import { verifyWebhookSignature, WEBHOOK_SIGNATURE_HEADER } from "@kletia/sdk";

// Node 20+ / edge runtime handler. Use the RAW body: re-serialised JSON will not verify.
export async function POST(request: Request) {
  const rawBody = await request.text();
  const result = await verifyWebhookSignature(
    process.env.KLETIA_WEBHOOK_SECRET!,
    rawBody,
    request.headers.get(WEBHOOK_SIGNATURE_HEADER), // "kletia-signature"
    { toleranceSeconds: 300 },
  );
  if (!result.valid) return new Response(result.reason, { status: 400 });

  const event = JSON.parse(rawBody);
  if (event.type === "intent.step_updated") {
    // event.data: { intentId, stepId, network, status, evidence? }
  }
  return new Response("ok");
}`;

export const WEBHOOK_REGISTER = `const webhook = await kletia.webhooks.create({
  url: "https://example.com/kletia/webhooks",
  events: ["intent.status_changed", "intent.step_updated"],
});
// webhook.secret is returned once: store it in your secret manager.`;

export const SSE_SNIPPET = `await kletia.intents.stream(intent.id, (event) => {
  if (event.type === "intent.step_updated") {
    console.log(event.data.stepId, event.data.status);
  }
});`;

export const EVENT_ENVELOPE = `{
  "id": "evt_…",
  "type": "intent.step_updated",
  "at": "2026-10-08T12:00:00.000Z",
  "data": {
    "intentId": "…",
    "stepId": "…",
    "network": "solana",
    "status": "settled"
  }
}`;

export const MCP_CONTEXT_SNIPPET = `GET {KLETIA_API_ORIGIN}/api/base-mcp/context?wallet={WALLET_ADDRESS}&network=base&chainId=8453
POST {KLETIA_API_ORIGIN}/api/base-mcp/x402/discover
GET {KLETIA_API_ORIGIN}/api/base-mcp/x402/prepare?wallet={WALLET_ADDRESS}&url={HTTPS_URL}&method=GET&maxPayment={USDC_CAP}&network=base&chainId=8453`;

export const AGENT_REST_SNIPPET = `# Agents use the same public v1 API: plan, then hand unsigned steps to the user's wallet.
curl -s "${API_BASE_URL}/v1/intents?dryRun=true" \\
  -H "content-type: application/json" \\
  -d '{"text":"swap 1 SOL to USDC","accounts":["${PREVIEW_ACCOUNTS.solana}"]}'`;
