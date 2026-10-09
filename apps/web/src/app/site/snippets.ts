/**
 * Code snippets shown on the home page and in the developer portal. They
 * mirror packages/sdk, packages/widget, packages/cli and docs/platform/*.md;
 * keep them in sync when a public API changes. Snippets never contain a real
 * secret: keys and webhook secrets are always read from the environment.
 */
import { PREVIEW_ACCOUNTS } from "../../shared/platform/previewAccounts";
import type { CodeLanguage } from "./ui/highlight";

export const API_BASE_URL = "https://api.kletiaai.xyz";
export const WEB_BASE_URL = "https://kletiaai.xyz";
export const MCP_URL = `${API_BASE_URL}/v1/mcp`;
/** Version the embed snippets pin (lockstep with the other @kletia packages). */
export const EMBED_VERSION = "0.2.0";
export const EMBED_CDN_URL = `https://cdn.jsdelivr.net/npm/@kletia/embed@${EMBED_VERSION}/dist/index.js`;
/** mcp-remote bridges stdio-only MCP clients to a Streamable HTTP server. */
export const MCP_REMOTE = "mcp-remote@0.14.3";

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

const kletia = new KletiaClient(); // public tier; pass { apiKey } on your server

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
  -H "idempotency-key: order-A-1029" \\
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
  { name: "bridge", values: "1", description: "Opts in to progress events over a MessageChannel; needs origin and a connect from your page." },
  { name: "origin", values: "your page origin", description: "The only origin whose connect the frame accepts (it must also be the frame's parent)." },
  { name: "ref", values: "[A-Za-z0-9_.:-], max 80", description: "Your reference, stored as metadata.hostRef and echoed in events. Publicly readable: no personal data." },
];

/** Attributes of the <kletia-intent> element (@kletia/embed). */
export const EMBED_ATTRIBUTES: readonly { name: string; values: string; description: string }[] = [
  { name: "theme", values: "light | dark | auto", description: "Widget theme; auto follows the visitor's OS." },
  { name: "text", values: "string, max 500", description: "Prompt pre-filled in the widget." },
  { name: "examples", values: "comma separated, max 6", description: "Example chips under the prompt." },
  { name: "bg", values: "transparent", description: "Lets your page show through behind the widget." },
  { name: "height", values: "pixels", description: "Starting height; the element then follows kletia:resize (320-1600 px)." },
  { name: "origin", values: "https origin", description: "Kletia origin that serves /embed (default https://kletiaai.xyz); set it only for a self-hosted Kletia." },
  { name: "reference", values: "[A-Za-z0-9_.:-], max 80", description: "Your reference, stored as metadata.hostRef and echoed in intent events. Publicly readable: no personal data." },
  { name: "label", values: "text", description: "Accessible name of the frame (default \"Kletia intent widget\")." },
];

/** DOM events the element dispatches (bubbling, composed CustomEvents). */
export const EMBED_EVENTS: readonly { name: string; detail: string; description: string }[] = [
  { name: "kletia:ready", detail: "{ height }", description: "The widget loaded and the bridge is connected." },
  { name: "kletia:intent-planned", detail: "{ status, reference? }", description: "A preview before a wallet is connected: a dry run, nothing stored, no id." },
  { name: "kletia:intent-created", detail: "{ intentId, status, reference? }", description: "The visitor planned with a connected wallet and Kletia stored the intent." },
  { name: "kletia:step-updated", detail: "{ intentId, stepId, stepIndex, network, status }", description: "A step changed status." },
  { name: "kletia:completed", detail: "{ intentId, status }", description: "The intent reached a terminal status." },
  { name: "kletia:error", detail: "{ code, message }", description: "Planning or execution failed in the widget." },
  { name: "kletia:resize", detail: "{ height }", description: "The content height changed (the element resizes itself)." },
];

/** Example /embed path (relative, so it also opens on preview deployments). */
export const EMBED_PATH =
  "/embed?theme=auto&text=swap%201%20SOL%20to%20USDC&examples=swap%201%20SOL%20to%20USDC,stake%202%20SOL%20with%20jito,bridge%2025%20USDC%20from%20base%20to%20solana";

export const EMBED_URL = `${WEB_BASE_URL}${EMBED_PATH}`;

export const IFRAME_SNIPPET = `<iframe
  src="${EMBED_URL}"
  title="Kletia intents"
  width="492"
  height="720"
  style="border:0;max-width:100%"
  sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
  allow="clipboard-write"
  loading="lazy"
></iframe>`;

export const WEBHOOK_VERIFY = `import { createWebhookHandler } from "@kletia/sdk/server";

// Next.js App Router: app/api/kletia/webhook/route.ts (also Bun, Deno, Workers).
// It reads the RAW body itself: re-serialised JSON would not verify.
export const POST = createWebhookHandler({
  secret: process.env.KLETIA_WEBHOOK_SECRET!,
  onEvent: async (event) => {
    if (event.type === "intent.step_updated") {
      // event.data: { intentId, stepId, network, status, evidence? }
    }
  },
});`;

export const WEBHOOK_REGISTER = `const webhook = await kletia.webhooks.create({
  url: "https://example.com/kletia/webhooks",
  events: ["intent.status_changed", "intent.step_updated"],
});
// webhook.secret is returned once: store it in your secret manager.

const delivery = await kletia.webhooks.test(webhook.id); // signed webhook.test, sent now
console.log(delivery.status, delivery.httpStatus, delivery.durationMs);

const log = await kletia.webhooks.deliveries(webhook.id, { limit: 20 });`;

export const SSE_SNIPPET = `await kletia.intents.stream(intent.id, (event) => {
  if (event.type === "intent.step_updated") {
    console.log(event.data.stepId, event.data.status);
  }
});

// Or wait for the end: SSE with Last-Event-ID resume and a polling fallback.
const final = await kletia.intents.wait(intent.id, { timeoutMs: 20 * 60_000 });`;

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

/* ------------------------------------------------------------------ recipes */

export interface RecipeFile {
  readonly id: string;
  readonly label: string;
  readonly language: CodeLanguage;
  readonly filename: string;
  readonly code: string;
}

export type RecipeGroup = "Browser" | "Server" | "Agents and tools";

export interface Recipe {
  readonly id: string;
  readonly label: string;
  readonly group: RecipeGroup;
  readonly title: string;
  readonly summary: string;
  readonly install?: string;
  readonly files: readonly RecipeFile[];
  /** Short rules that matter in production. */
  readonly notes: readonly string[];
}

const HOOKS_SNIPPET = `import type { AccountId, IntentSigners } from "@kletia/sdk";
import { KletiaProvider, useIntent, useKletiaIntent } from "@kletia/widget/hooks";

export function App({ accounts, signers }: { accounts: AccountId[]; signers: IntentSigners }) {
  // Public tier. To attribute intents to your key, proxy through your server:
  // <KletiaProvider options={{ baseUrl: "https://your-app.example/kletia" }}>
  return (
    <KletiaProvider>
      <Checkout accounts={accounts} signers={signers} />
    </KletiaProvider>
  );
}

function Checkout({ accounts, signers }: { accounts: AccountId[]; signers: IntentSigners }) {
  const { plan, execute, cancel, reset, intent, phase, error } = useKletiaIntent({
    accounts,
    signers,
    metadata: { orderId: "A-1029" },
    maxSlippageBps: 50,
  });

  return (
    <section>
      <button disabled={phase === "planning"} onClick={() => plan("bridge 25 USDC from base to solana")}>
        Plan
      </button>
      <button disabled={phase !== "planned"} onClick={() => execute()}>
        Execute
      </button>
      {phase === "executing" ? <button onClick={() => cancel()}>Stop</button> : null}
      {phase === "finished" ? <button onClick={reset}>New intent</button> : null}
      {intent ? <p>{intent.summary.title}: {intent.status}</p> : null}
      {error instanceof Error ? <p role="alert">{error.message}</p> : null}
    </section>
  );
}

// Follow any intent by id, e.g. after a reload (SSE with resume, polling fallback).
export function OrderStatus({ intentId }: { intentId: string }) {
  const { intent, status } = useIntent(intentId);
  return <p>{intent ? intent.status : status}</p>;
}`;

const NEXT_CHECKOUT_ROUTE = `// app/api/checkout/route.ts — runs on your server; the key never reaches the browser.
import { formatAccountId, KletiaClient } from "@kletia/sdk";
import { getOrder } from "@/lib/orders"; // your code

const kletia = new KletiaClient({ apiKey: process.env.KLETIA_API_KEY });

export async function POST(request: Request) {
  const { orderId, address } = (await request.json()) as { orderId: string; address: string };
  const order = await getOrder(orderId); // the amount comes from your database, never from the client

  const intent = await kletia.intents.create(
    {
      actions: [
        {
          kind: "transfer",
          network: "base",
          from: "USDC",
          amount: order.totalUsdc, // e.g. "25.00"
          recipient: process.env.TREASURY_ADDRESS!,
        },
      ],
      accounts: [formatAccountId("base", address)],
      metadata: { orderId },
    },
    // A retried checkout replays the same intent (24 h) instead of planning a second one.
    { idempotencyKey: \`checkout-\${orderId}\` },
  );
  return Response.json({ intent });
}`;

const NEXT_PAY_BUTTON = `"use client";
// app/checkout/PayButton.tsx — the user's wallet signs; no key in the browser.
import { useState } from "react";
import { eip1193Signer, executeIntent, KletiaClient, type Eip1193Provider, type IntentGraph } from "@kletia/sdk";

// Public tier: the intent id is the capability to prepare and submit its steps.
const kletia = new KletiaClient();

export function PayButton({ orderId, address, provider }: { orderId: string; address: string; provider: Eip1193Provider }) {
  const [status, setStatus] = useState("ready");

  async function pay() {
    const response = await fetch("/api/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orderId, address }),
    });
    const { intent } = (await response.json()) as { intent: IntentGraph };
    const final = await executeIntent(kletia, intent, { evm: eip1193Signer(provider, address) }, {
      onUpdate: (next) => setStatus(next.status),
    });
    setStatus(final.status); // show it; fulfil the order only from the webhook
  }

  return <button onClick={pay}>Pay with USDC ({status})</button>;
}`;

const NEXT_WEBHOOK_ROUTE = `// app/api/kletia/webhook/route.ts
import { KletiaClient } from "@kletia/sdk";
import { createWebhookHandler } from "@kletia/sdk/server";
import { hasProcessed, markOrderPaid, rememberEvent } from "@/lib/orders"; // your code

const kletia = new KletiaClient({ apiKey: process.env.KLETIA_API_KEY });

// Verifies Kletia-Signature on the raw body, answers 400 on a bad signature
// and 500 when onEvent throws (Kletia retries: 1 s, 5 s, 25 s).
export const POST = createWebhookHandler({
  secret: process.env.KLETIA_WEBHOOK_SECRET!,
  isDuplicate: (eventId) => hasProcessed(eventId), // deliveries are at-least-once
  markProcessed: (eventId) => rememberEvent(eventId),
  onEvent: async (event) => {
    if (event.type !== "intent.status_changed" || event.data.status !== "completed") return;
    // Re-read the intent with your key: its status, steps and metadata are the source of truth.
    const intent = await kletia.intents.get(event.data.intentId);
    const orderId = intent.metadata?.orderId;
    if (intent.status === "completed" && orderId) await markOrderPaid(orderId, intent);
  },
});`;

const NEXT_ENV = `# .env.local — server-only values (no NEXT_PUBLIC_ prefix)
KLETIA_API_KEY=kl_dev_…
KLETIA_WEBHOOK_SECRET=whsec_…
TREASURY_ADDRESS=0x…`;

const EXPRESS_WEBHOOK = `import express from "express";
import { expressWebhookHandler, memoryDeduplication } from "@kletia/sdk/server";

const app = express();

// The signature covers the exact bytes: mount express.raw on this route, before any JSON parser.
app.post(
  "/webhooks/kletia",
  express.raw({ type: "application/json" }),
  expressWebhookHandler({
    // While you replace a webhook, accept both secrets: [process.env.NEW_SECRET!, process.env.OLD_SECRET!]
    secret: process.env.KLETIA_WEBHOOK_SECRET!,
    ...memoryDeduplication(), // one process only; use your database across instances
    onEvent: async (event, { attempt }) => {
      console.log(event.type, event.id, \`attempt \${attempt}\`);
      if (event.type === "intent.step_updated") {
        // event.data: { intentId, stepId, network, status, evidence? }
      }
    },
  }),
);

app.use(express.json()); // other routes can parse JSON after the webhook route
app.listen(3000);`;

const HONO_NODE = `import { Hono } from "hono";
import { honoWebhookHandler } from "@kletia/sdk/server";

const app = new Hono();

// Node, Bun and Deno: build the handler once.
app.post(
  "/webhooks/kletia",
  honoWebhookHandler({
    secret: process.env.KLETIA_WEBHOOK_SECRET!,
    onEvent: async (event) => {
      if (event.type === "intent.status_changed") console.log(event.data.intentId, event.data.status);
    },
  }),
);

export default app;`;

const HONO_WORKER = `import { Hono } from "hono";
import { createWebhookHandler } from "@kletia/sdk/server";

// Cloudflare Workers: secrets live on c.env, so build the handler per request.
const app = new Hono<{ Bindings: { KLETIA_WEBHOOK_SECRET: string } }>();

app.post("/webhooks/kletia", (c) =>
  createWebhookHandler({
    secret: c.env.KLETIA_WEBHOOK_SECRET,
    onEvent: async (event) => {
      if (event.type === "intent.status_changed") console.log(event.data.intentId, event.data.status);
    },
  })(c.req.raw),
);

export default app;`;

const ELEMENT_HTML = `<script type="module" src="${EMBED_CDN_URL}" crossorigin="anonymous"></script>

<kletia-intent
  theme="auto"
  text="swap 1 SOL to USDC"
  examples="swap 1 SOL to USDC,bridge 25 USDC from base to solana"
  height="720"
></kletia-intent>

<script type="module">
  const widget = document.querySelector("kletia-intent");
  widget.addEventListener("kletia:intent-created", (event) => {
    // A notification only: your server verifies GET /v1/intents/{id} before it fulfils anything.
    console.log("intent", event.detail.intentId, event.detail.status);
  });
  widget.addEventListener("kletia:completed", (event) => console.log("done", event.detail.status));
  widget.addEventListener("kletia:error", (event) => console.warn(event.detail.code, event.detail.message));
</script>`;

const ELEMENT_BUNDLER = `// npm install @kletia/embed — defines <kletia-intent> once, safe to import twice.
import "@kletia/embed";

const widget = document.createElement("kletia-intent");
widget.setAttribute("theme", "dark");
widget.setAttribute("bg", "transparent");
widget.setAttribute("text", "bridge 25 USDC from base to solana");
widget.addEventListener("kletia:step-updated", (event) => {
  const { intentId, stepIndex, network, status } = (event as CustomEvent).detail;
  console.log(intentId, stepIndex, network, status);
});
document.querySelector("#checkout")?.append(widget);`;

const IFRAME_BRIDGE = `<iframe
  id="kletia"
  title="Kletia intents"
  width="492"
  height="720"
  style="border:0;max-width:100%"
  sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
  allow="clipboard-write"
  referrerpolicy="strict-origin-when-cross-origin"
></iframe>

<script type="module">
  const KLETIA = "${WEB_BASE_URL}";
  const frame = document.getElementById("kletia");

  frame.addEventListener("load", () => {
    const channel = new MessageChannel();
    channel.port1.onmessage = ({ data }) => {
      if (data?.kletia !== "event" || data.v !== 1) return;
      if (data.type === "ready" || data.type === "resize") {
        frame.style.height = \`\${Math.min(1600, Math.max(320, data.height))}px\`;
      }
      if (data.type === "intent.planned") console.log("preview (dry run, no id)", data.status);
      if (data.type === "intent.created") console.log("intent", data.intentId, data.status);
      if (data.type === "intent.step_updated") console.log(data.stepIndex, data.network, data.status);
      if (data.type === "intent.completed") console.log("done", data.intentId, data.status);
      if (data.type === "error") console.warn(data.code, data.message);
    };
    // The explicit target origin means the port can only ever reach Kletia.
    frame.contentWindow.postMessage({ kletia: "connect", v: 1 }, KLETIA, [channel.port2]);
  }, { once: true });

  const params = new URLSearchParams({ theme: "auto", text: "swap 1 SOL to USDC", bridge: "1", origin: location.origin });
  frame.src = \`\${KLETIA}/embed?\${params}\`;
</script>`;

const MCP_CLAUDE_CODE = `claude mcp add --transport http kletia ${MCP_URL}

# With a developer key (higher limits, list_intents):
claude mcp add --transport http kletia ${MCP_URL} \\
  --header "Authorization: Bearer $KLETIA_API_KEY"`;

const MCP_CLAUDE_DESKTOP = `{
  "mcpServers": {
    "kletia": {
      "command": "npx",
      "args": ["-y", "${MCP_REMOTE}", "${MCP_URL}"]
    }
  }
}`;

const MCP_CURSOR = `{
  "mcpServers": {
    "kletia": {
      "url": "${MCP_URL}"
    }
  }
}`;

const MCP_VSCODE = `{
  "servers": {
    "kletia": {
      "type": "http",
      "url": "${MCP_URL}"
    }
  }
}`;

const CLI_USAGE = `# Read-only commands need no key.
npx @kletia/cli networks
npx @kletia/cli venues --network base
npx @kletia/cli quote 25 USDC --from base --to arbitrum
npx @kletia/cli plan "bridge 25 USDC from base to solana then swap half to JitoSOL" \\
  --account base:0xYourEvmAddress --account solana:YourSolanaAddress

# Keys: the secret goes to a new mode-600 file, never to your terminal history.
npm install -g @kletia/cli
kletia keys create ci --secret-file ./ci-key.txt
export KLETIA_API_KEY="$(cat ./ci-key.txt)"
kletia keys list
kletia keys rotate key_… --grace-seconds 3600 --secret-file ./ci-key-next.txt

# Webhooks, usage and live intents
kletia webhooks create https://example.com/kletia/webhooks --event intent.status_changed
kletia webhooks test wh_…
kletia webhooks deliveries wh_…
kletia usage --window 7d
kletia intents watch int_…   # exit 0 when completed, 2 when it ended otherwise

# Local receivers: forward an intent's events, signed like real deliveries.
export KLETIA_WEBHOOK_SECRET=whsec_…
kletia webhooks forward --intent int_… --to http://localhost:3000/api/kletia/webhook`;

export const RECIPES: readonly Recipe[] = [
  {
    id: "react-widget",
    label: "React widget",
    group: "Browser",
    title: "Drop in the React widget",
    summary: "A complete plan, review and execute flow with your users' own EVM and Solana wallets. Styles are scoped; no CSS import.",
    install: "npm install @kletia/widget @kletia/sdk",
    files: [{ id: "panel", label: "IntentPanel.tsx", language: "tsx", filename: "IntentPanel.tsx", code: WIDGET_SNIPPET }],
    notes: [
      "Never pass a kl_dev_ key to the widget: use the public tier, or clientOptions={{ baseUrl }} pointing at a proxy route on your server.",
      "Without signers it plans and reviews only, which is enough for quotes and previews.",
      "If a wallet broadcast a step that Kletia could not record, the button turns into Resubmit instead of asking to sign again.",
    ],
  },
  {
    id: "react-hooks",
    label: "React hooks",
    group: "Browser",
    title: "Build your own UI with hooks",
    summary: "@kletia/widget/hooks gives you the widget's state machines without its UI, with no data-fetching library.",
    install: "npm install @kletia/widget @kletia/sdk",
    files: [{ id: "checkout", label: "Checkout.tsx", language: "tsx", filename: "Checkout.tsx", code: HOOKS_SNIPPET }],
    notes: [
      "Unmounting, planning again or reset() aborts a running execution, and its signers stop reaching the wallet.",
      "useQuote(request, { debounceMs: 400 }), useNetworks() and usePortfolio(accountId) return { data, status, error, reload }.",
      "cancel() is refused once a step was submitted: follow the intent to settlement instead.",
    ],
  },
  {
    id: "nextjs",
    label: "Next.js",
    group: "Server",
    title: "Next.js checkout with server-side intents",
    summary:
      "Your server plans the intent with your key (attributed, idempotent, with order metadata); the browser executes it on the public tier; a webhook route fulfils the order.",
    install: "npm install @kletia/sdk",
    files: [
      { id: "route", label: "Checkout route", language: "ts", filename: "app/api/checkout/route.ts", code: NEXT_CHECKOUT_ROUTE },
      { id: "button", label: "Pay button", language: "tsx", filename: "app/checkout/PayButton.tsx", code: NEXT_PAY_BUTTON },
      { id: "webhook", label: "Webhook route", language: "ts", filename: "app/api/kletia/webhook/route.ts", code: NEXT_WEBHOOK_ROUTE },
      { id: "env", label: ".env.local", language: "bash", filename: ".env.local", code: NEXT_ENV },
    ],
    notes: [
      "Fulfil orders from the webhook (or by reading GET /v1/intents/{id} on your server), never from the browser's result.",
      "Webhooks are delivered only to public HTTPS URLs. Locally, use kletia webhooks forward (see the CLI recipe).",
      "Deliveries are at-least-once: de-duplicate by event id (the Kletia-Event-Id header).",
    ],
  },
  {
    id: "express",
    label: "Express",
    group: "Server",
    title: "Verify webhooks in Express",
    summary: "expressWebhookHandler verifies the signature on the raw body, de-duplicates and calls you once per event.",
    install: "npm install @kletia/sdk express",
    files: [{ id: "server", label: "server.ts", language: "ts", filename: "server.ts", code: EXPRESS_WEBHOOK }],
    notes: [
      "A body already parsed by express.json() is refused with a 500 that explains the fix: the signature covers the exact bytes.",
      "Throw from onEvent to have Kletia retry the delivery (up to 3 times: 1 s, 5 s, 25 s).",
      "Signatures older than 300 s are rejected; pass toleranceSeconds to change it.",
    ],
  },
  {
    id: "hono",
    label: "Hono",
    group: "Server",
    title: "Hono on Node, Bun, Deno or Workers",
    summary: "@kletia/sdk/server uses Web Crypto only, so the same handler runs on edge runtimes.",
    install: "npm install @kletia/sdk hono",
    files: [
      { id: "node", label: "Node, Bun, Deno", language: "ts", filename: "server.ts", code: HONO_NODE },
      { id: "worker", label: "Workers", language: "ts", filename: "worker.ts", code: HONO_WORKER },
    ],
    notes: [
      "createWebhookHandler returns (request: Request) => Promise<Response>: it also works in Next.js, Bun.serve and Deno.serve.",
      "Add isDuplicate and markProcessed backed by your database to make processing exactly-once.",
    ],
  },
  {
    id: "web-component",
    label: "Web component",
    group: "Browser",
    title: "Any page: the <kletia-intent> element",
    summary: "One script, no framework. The element frames the hosted widget and reports progress as DOM events.",
    install: "npm install @kletia/embed",
    files: [
      { id: "html", label: "index.html", language: "html", filename: "index.html", code: ELEMENT_HTML },
      { id: "bundler", label: "With a bundler", language: "ts", filename: "checkout.ts", code: ELEMENT_BUNDLER },
    ],
    notes: [
      "Pin the exact version in the script URL, and add the integrity hash published with that release.",
      "Events carry ids and statuses, never addresses or amounts. Never fulfil an order from a browser event: verify on your server.",
      "The visitor sees that your site is notified of their intent's progress. Signing always needs a click inside the widget.",
    ],
  },
  {
    id: "iframe",
    label: "Iframe",
    group: "Browser",
    title: "Plain iframe, with or without events",
    summary: "The hosted /embed page works in any iframe. Add the bridge handshake to receive progress over a private MessageChannel.",
    files: [
      { id: "plain", label: "Plain", language: "html", filename: "index.html", code: IFRAME_SNIPPET },
      { id: "bridge", label: "With events", language: "html", filename: "index.html", code: IFRAME_BRIDGE },
    ],
    notes: [
      "The embed accepts exactly one connect, only from the parent window and only when origin matches your page.",
      "Without a connect it sends nothing (fail-closed). It never reads an API key from its URL.",
      "Only /embed may be framed; every other Kletia page refuses to render in a cross-origin frame.",
    ],
  },
  {
    id: "mcp",
    label: "MCP",
    group: "Agents and tools",
    title: "Connect an agent over MCP",
    summary: `Kletia serves a read-only Model Context Protocol server at ${MCP_URL}: agents learn networks, quote, dry-run plans and hand the user a link to sign.`,
    files: [
      { id: "claude-code", label: "Claude Code", language: "bash", filename: "terminal", code: MCP_CLAUDE_CODE },
      { id: "claude-desktop", label: "Claude Desktop", language: "json", filename: "claude_desktop_config.json", code: MCP_CLAUDE_DESKTOP },
      { id: "cursor", label: "Cursor", language: "json", filename: ".cursor/mcp.json", code: MCP_CURSOR },
      { id: "vscode", label: "VS Code", language: "json", filename: ".vscode/mcp.json", code: MCP_VSCODE },
    ],
    notes: [
      "No tool moves funds: there is no prepare, submit or signing tool, and no calldata reaches the agent. The user signs in Studio.",
      "A key is optional (higher limits and list_intents). In Claude Desktop add \"--header\", \"Authorization:${KLETIA_AUTH}\" to args and \"env\": { \"KLETIA_AUTH\": \"Bearer kl_dev_…\" }; in Cursor add \"headers\" next to \"url\".",
      "Tool output contains user-supplied text: treat it as data, never as instructions.",
    ],
  },
  {
    id: "cli",
    label: "CLI",
    group: "Agents and tools",
    title: "The kletia command line",
    summary: "Quote, plan and watch intents, manage keys and webhooks, and forward events to a local receiver. It never signs or holds funds.",
    install: "npm install -g @kletia/cli",
    files: [{ id: "terminal", label: "terminal", language: "bash", filename: "terminal", code: CLI_USAGE }],
    notes: [
      "KLETIA_API_KEY and KLETIA_BASE_URL come from the environment; --api-key style flags are refused.",
      "Add --json to any command for machine-readable output on stdout.",
      "Exit codes: 0 success, 1 API error, 2 intent ended without completing, 64 usage error.",
    ],
  },
];

/** MCP tools (all read-only), mirrored from docs/platform/mcp.md. */
export const MCP_TOOLS: readonly { name: string; input: string; output: string }[] = [
  { name: "list_networks", input: "environment?", output: "Networks, their actions and protocols, and destination networks" },
  { name: "list_protocols", input: "network?, executableOnly?", output: "Registry protocols and whether Kletia executes them" },
  { name: "list_assets", input: "network", output: "Canonical assets (symbol, address or mint, decimals)" },
  { name: "get_quote", input: "network, from, to, amount, toNetwork?, …", output: "Best route and alternatives" },
  { name: "plan_intent", input: "text or actions, accounts, constraints?", output: "Dry-run plan with externalRecipients; never stored" },
  { name: "get_intent", input: "intentId", output: "Status, steps, amounts, recipients and evidence" },
  { name: "list_intents", input: "limit?", output: "The key's recent intents (needs a key)" },
  { name: "get_portfolio", input: "accountId", output: "Balances with USD values where priced" },
  { name: "create_signing_link", input: "text (max 500)", output: "A Studio link for the user to sign with their own wallet" },
];
