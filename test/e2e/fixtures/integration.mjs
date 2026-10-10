import { aggregatePreview, CONTRACT_REVIEW_NOTICE } from "@kletia/core";

export const TEST_ACCOUNT = "0x1111111111111111111111111111111111111111";
export const TEST_CONTRACT = "0x2222222222222222222222222222222222222222";
export const TEST_INTENT_ID = `int_${"a".repeat(32)}`;
export const TEST_SESSION_ID = `cs_${"b".repeat(32)}`;
export const TEST_LINK_ID = `lk_${"c".repeat(24)}`;
export const TEST_CONTRACT_ID = `ct_${"d".repeat(24)}`;
export const INTEGRATOR_LABEL = "Fixture project integration";
export const CUSTOM_PROMPT = "call fixture project contract on base";
export const TEST_ACCOUNT_ID = `eip155:8453:${TEST_ACCOUNT}`;

const ETH = { asset: "eip155:8453/slip44:60", symbol: "ETH", decimals: 18 };
const USDC = { asset: "eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol: "USDC", decimals: 6 };

/** A deterministic simulation fixture; it does not quote or execute a live market. */
export function contractReview(stage = "plan") {
  return {
    kind: "evm-call",
    integrator: { name: INTEGRATOR_LABEL, website: "https://fixture.example", domainVerified: true },
    notices: [CONTRACT_REVIEW_NOTICE],
    contract: { network: "base", address: TEST_CONTRACT, source: "exact_match", revision: 1, registeredAt: "2026-01-01T00:00:00.000Z" },
    call: { label: "Fixture contract entry", function: "fixtureCall()", args: [] },
    approvals: [],
    simulation: { status: "ok", at: stage, assetChanges: [], warnings: ["Deterministic browser fixture; no live execution."] },
  };
}

export function customIntent({ account = TEST_ACCOUNT_ID, status = "ready", text = CUSTOM_PROMPT } = {}) {
  return {
    spec: "kletia.intent/v1", id: TEST_INTENT_ID,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z",
    status: "planned", request: { text, accounts: [account] },
    interpretation: { source: "structured", confidence: 1 },
    steps: [{
      id: "fixture-step", index: 0, kind: "call", title: "Fixture contract entry",
      network: "base", chain: "eip155:8453", account, protocol: "custom-call", mode: "wallet", status,
      dependsOn: [], evidence: [],
      call: {
        contract: TEST_CONTRACT_ID, revision: 1, definitionHash: "fixture-definition", entry: "fixture", vm: "evm",
        target: TEST_CONTRACT, selector: "0x12345678", function: "fixtureCall()", label: "Fixture contract entry",
        integrator: { name: INTEGRATOR_LABEL, website: "https://fixture.example", domainVerified: true },
        review: contractReview(),
      },
    }],
    edges: [], summary: { title: "Fixture custom contract plan", networks: ["base"], inputs: [], outputs: [], signaturesRequired: 1, crossNetwork: false },
    warnings: ["Deterministic browser fixture; no live execution."],
  };
}

export function preparedCustomIntent() {
  const intent = customIntent({ status: "awaiting_signature" });
  intent.steps[0].call.review = contractReview("prepare");
  return {
    intent,
    payload: {
      vm: "evm", expiresAt: Math.floor(Date.now() / 1000) + 300, quoteBinding: "fixture-binding",
      review: contractReview("prepare"),
      transactions: [{ vm: "evm", network: "base", chainId: 8453, from: TEST_ACCOUNT, to: TEST_CONTRACT, data: "0x12345678", value: "0", description: "Fixture custom contract call" }],
    },
  };
}

export function customLink(webOrigin) {
  return {
    id: TEST_LINK_ID, status: "active", revision: 1, title: "Fixture project contract link",
    description: "Deterministic browser fixture; this link cannot sign custom contracts on the main site.",
    publisher: { name: INTEGRATOR_LABEL, website: "https://fixture.example", domain: "fixture.example", domainVerified: true },
    destination: { network: "base", asset: USDC, actions: [{ kind: "call", network: "base", label: "Fixture contract entry", contract: { id: TEST_CONTRACT_ID, address: TEST_CONTRACT, integrator: INTEGRATOR_LABEL, source: "exact_match", domainVerified: true, revision: 1 } }] },
    fixed: { recipients: [], contracts: [{ network: "base", address: TEST_CONTRACT, label: "Fixture contract entry" }] },
    funding: { networks: ["base"], assets: ["USDC"], amount: { mode: "input", bounds: { USDC: { min: "1", max: "10", default: "1" } } } },
    expiresAt: "2099-01-01T00:00:00.000Z", activatesAt: null,
    uses: { max: null, left: null }, perAccount: null, blink: { enabled: false, eligible: false, reason: "Custom fixture" },
    urls: { page: `${webOrigin}/go/${TEST_LINK_ID}`, card: `${webOrigin}/go/${TEST_LINK_ID}/card.png`, square: `${webOrigin}/go/${TEST_LINK_ID}/card.png?variant=square` },
    notices: ["Deterministic browser fixture; no live execution."],
  };
}

export function customSession(hostOrigin) {
  return {
    id: TEST_SESSION_ID, status: "active", createdAt: "2026-01-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z",
    integrator: { name: INTEGRATOR_LABEL, website: "https://fixture.example", domainVerified: true },
    allowedOrigins: [hostOrigin], actions: [{ kind: "call", network: "base", contract: TEST_CONTRACT_ID, entry: "fixture", label: "Fixture contract entry" }],
    maxIntents: 1, used: 0,
  };
}

/** EIP-1193 test provider: connecting is allowed, every signing method refuses. */
export async function installTestWallet(context) {
  await context.addInitScript(({ address }) => {
    let connected = false;
    const listeners = new Map();
    window.__kletiaTestWalletRequests = [];
    const permissions = () => [{ parentCapability: "eth_accounts", caveats: [{ type: "restrictReturnedAccounts", value: [address] }] }];
    const provider = {
      isMetaMask: true,
      on(event, listener) { const list = listeners.get(event) ?? new Set(); list.add(listener); listeners.set(event, list); },
      removeListener(event, listener) { listeners.get(event)?.delete(listener); },
      async request({ method }) {
        window.__kletiaTestWalletRequests.push(method);
        if (method === "eth_requestAccounts" || method === "wallet_requestPermissions") { connected = true; return method === "eth_requestAccounts" ? [address] : permissions(); }
        if (method === "eth_accounts") return connected ? [address] : [];
        if (method === "eth_chainId") return "0x2105";
        if (method === "net_version") return "8453";
        if (method === "wallet_getPermissions") return connected ? permissions() : [];
        if (method === "eth_getBalance") return "0x0";
        if (method === "wallet_switchEthereumChain") return null;
        if (method === "eth_getCode" || method === "eth_call") return "0x";
        if (method === "wallet_getCapabilities") return {};
        if (/send|sign/iu.test(method)) throw Object.assign(new Error("Fixture wallet refuses all signing."), { code: 4001 });
        throw Object.assign(new Error(`Unsupported fixture wallet method: ${method}`), { code: 4200 });
      },
    };
    Object.defineProperty(window, "ethereum", { configurable: true, value: provider });
    const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: {
      info: { uuid: "f57e8503-9e2b-4bc0-8af6-078b0546a110", name: "Fixture EVM wallet", icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E", rdns: "test.kletia.fixture" }, provider,
    } }));
    window.addEventListener("eip6963:requestProvider", announce);
    announce();
  }, { address: TEST_ACCOUNT });
}

/** Local API fixtures cover the real browser app's HTTP boundary. */
export async function installIntegrationApi(context, { webOrigin, rejectStudio = false } = {}) {
  const requests = [];
  // Wallet UI reads can use its configured public RPC. Keep those reads
  // deterministic as well; these browser fixtures never contact a chain.
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === webOrigin || /^https?:\/\/(?:127\.0\.0\.1|localhost):3001$/u.test(url.origin)) return route.fallback();
    let rpc;
    try { rpc = route.request().postDataJSON(); } catch { /* Non-RPC external resource. */ }
    const answer = (entry) => ({ jsonrpc: "2.0", id: entry?.id ?? 1, result: entry?.method === "eth_chainId" ? "0x2105" : entry?.method === "eth_blockNumber" ? "0x1" : "0x0" });
    return route.fulfill({ status: rpc ? 200 : 404, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(Array.isArray(rpc) ? rpc.map(answer) : answer(rpc)) });
  });
  await context.route(/^https?:\/\/(?:127\.0\.0\.1|localhost):3001\//u, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const body = request.postDataJSON();
    requests.push({ method: request.method(), pathname: url.pathname, query: url.searchParams.toString(), body });
    const json = (data, status = 200) => route.fulfill({ status, contentType: "application/json", headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*" }, body: JSON.stringify(data) });
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET, POST, OPTIONS" } });
    if (url.pathname === `/v1/links/${TEST_LINK_ID}`) return json({ link: customLink(webOrigin) });
    if (url.pathname === `/v1/links/${TEST_LINK_ID}/quote`) {
      const intent = customIntent();
      const preview = aggregatePreview(intent, [], {}, "2026-01-01T00:00:00.000Z", {
        stage: "indicative", warnings: ["Deterministic browser fixture; no live asset simulation."],
      });
      return json({ intent, preview });
    }
    if (url.pathname === `/v1/sessions/${TEST_SESSION_ID}`) return json({ session: customSession(webOrigin) });
    if (url.pathname === `/v1/sessions/${TEST_SESSION_ID}/intents`) return json({ intent: customIntent() }, 201);
    if (url.pathname === "/v1/intents" && request.method() === "POST") {
      if (rejectStudio) return json({ error: { code: "CONTRACT_INTEGRATION_REQUIRED", message: "Custom contracts are available only through your own project integration." } }, 403);
      return json({ intent: customIntent({ account: body?.accounts?.find((account) => account.startsWith("eip155:")) ?? TEST_ACCOUNT_ID, text: body?.text ?? CUSTOM_PROMPT }), preview: null }, 201);
    }
    if (url.pathname === `/v1/intents/${TEST_INTENT_ID}/steps/fixture-step/prepare`) return json(preparedCustomIntent());
    if (url.pathname === `/v1/intents/${TEST_INTENT_ID}` || url.pathname === `/v1/intents/${TEST_INTENT_ID}/refresh`) return json({ intent: customIntent() });
    if (url.pathname.endsWith("/preview")) return json({ error: { code: "PREVIEW_NOT_FOUND", message: "This deterministic fixture has no asset preview." } }, 404);
    if (url.pathname === "/v1/networks") return json({ networks: [] });
    if (url.pathname === "/v1/protocols") return json({ protocols: [] });
    if (url.pathname === "/v1/examples") return json({ examples: [] });
    if (url.pathname === "/health") return json({ status: "ok" });
    if (url.pathname.includes("/rpc/")) {
      const answer = (entry) => ({ jsonrpc: "2.0", id: entry.id, result: entry.method === "eth_chainId" ? "0x2105" : entry.method === "eth_blockNumber" ? "0x1" : "0x0" });
      return json(Array.isArray(body) ? body.map(answer) : answer(body ?? { id: 1 }));
    }
    return json({ error: { code: "FIXTURE_ROUTE_NOT_FOUND", message: "Not part of this deterministic browser fixture." } }, 404);
  });
  return requests;
}

/** A real parent/frame handshake, without loading a CDN or another site. */
export async function installIntegrationHost(context, { webOrigin, fragment }) {
  const hostUrl = `${webOrigin}/__e2e/integration-host`;
  const frameUrl = `${webOrigin}/embed?bridge=1&origin=${encodeURIComponent(webOrigin)}#${fragment}`;
  await context.route(hostUrl, (route) => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><html lang="en"><meta charset="utf-8"><title>Fixture integration host</title><body><h1>Fixture integration host</h1><p role="status" id="bridge-state">Connecting fixture frame</p><iframe title="Fixture Kletia integration" src="${frameUrl}" style="width:100%;height:1600px;border:0"></iframe><script>
      window.__kletiaHostEvents = [];
      const frame = document.querySelector('iframe');
      frame.addEventListener('load', () => {
        const channel = new MessageChannel();
        channel.port1.onmessage = ({data}) => { window.__kletiaHostEvents.push(data); if(data.type === 'ready') document.getElementById('bridge-state').textContent = 'Fixture frame connected'; };
        frame.contentWindow.postMessage({kletia:'connect',v:1}, ${JSON.stringify(webOrigin)}, [channel.port2]);
      });
    </script></body></html>`,
  }));
  return hostUrl;
}

export async function signingRequests(frame) {
  return frame.locator("html").evaluate(() => (window.__kletiaTestWalletRequests ?? []).filter((method) => /send|sign/iu.test(method)));
}

export { ETH };
