// The desk's tools and the end of the old console: every catalogue tool has a host, funding is fail-closed,
// Studio hands off to the desk without wallet code, the old console's files
// are gone and its CSS left the entry stylesheet.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { TOOLS } from "../tools/catalogue.ts";
import { deskHandoffHref, handoffDeparture } from "../tools/deskHandoff.ts";
import { ARC_FAUCET_URL, coinbaseOnrampUrl, fundingFor, requestCoinbaseOnramp } from "../tools/funding.ts";
import { TOOL_COPY } from "../tools/toolCopy.ts";

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, "../../..");
const read = (path) => readFileSync(resolve(src, path), "utf8");
const EVM = "0x1111111111111111111111111111111111111111";

test("every panel, form and read-only tool has a host: engine tools hand sentences back, Solana tools run in SolanaToolHost", () => {
  for (const tool of TOOLS.filter((entry) => entry.load)) {
    if (tool.engine) assert.ok(tool.promptProp, `${tool.id}: its sentences reach the composer with the ${tool.engine} engine pinned`);
    if (tool.promptProp) {
      const file = /import\("([^"]+)"\)/u.exec(tool.load.toString())[1];
      const source = readFileSync(`${join(src, "app/console/tools", file)}.tsx`, "utf8");
      assert.match(source, new RegExp(`\\b${tool.promptProp}\\b`, "u"), `${tool.id}: ${tool.exportName} takes ${tool.promptProp}`);
    }
  }
  assert.deepEqual(TOOLS.filter((tool) => tool.host === "solana").map((tool) => tool.id), ["jupiter-swap", "solana-send", "liquid-staking", "solana-lending-rates"]);
  for (const id of ["jupiter-swap", "solana-send", "liquid-staking"]) assert.equal(TOOLS.find((tool) => tool.id === id).kind, "form");
  assert.equal(TOOLS.find((tool) => tool.id === "solana-lending-rates").kind, "read-only");
  assert.deepEqual(TOOLS.filter((tool) => tool.networkProp).map((tool) => tool.id), ["address-risk"]);
  const panel = read("app/console/tools/ToolPanel.tsx");
  assert.match(panel, /actions\.fill\(text, \{ engine \}\)/u, "onPrompt(text, { engine }) fills the composer with the pin");
  assert.match(panel, /lazy\(/u, "every tool component is a lazy chunk");
});

test("the Solana forms keep their pre-sign checks and lose the workspace chrome; the Interchange tokens replace Solana purple", () => {
  for (const name of ["SolanaSwap", "SolanaSend", "SolanaStake", "SolanaYields"]) {
    const source = read(`networks/solana/components/${name}.tsx`);
    assert.doesNotMatch(source, /PanelHeader|ConnectSolanaCta/u, `${name}: the host owns the header and the connect bar`);
    assert.doesNotMatch(source, /#9945FF|#14F195/u, `${name}: no Solana purple or registry green on controls`);
  }
  for (const name of ["SolanaSwap", "SolanaStake"]) assert.match(read(`networks/solana/components/${name}.tsx`), /useSwapFlow/u);
  assert.match(read("networks/solana/components/SolanaSend.tsx"), /useSolanaExecution/u);
  assert.match(read("networks/solana/hooks/useSwapFlow.ts"), /useSolanaExecution/u);
  const styles = read("networks/solana/styles.ts");
  assert.doesNotMatch(styles, /#9945FF|#14F195/u);
  assert.match(styles, /bg-\[#2F5BFF\]/u, "blue primary (the Card machine blue)");
  assert.match(styles, /outline-focus/u, "the site focus ring");
});

test("Allora and Arc lending follow the site theme instead of the console store's isDarkMode", () => {
  for (const path of ["integrations/allora/components/AlloraDashboard.tsx", "networks/arc/components/ArcLendingDashboard.tsx"]) {
    const source = read(path);
    assert.doesNotMatch(source, /isDarkMode|useAppStore/u, path);
    assert.match(source, /dark:/u, `${path} uses the dark class the site theme sets`);
  }
});

test("funding: onramp on Base, faucet on Arc, a bridge elsewhere; the onramp fails closed", async () => {
  assert.deepEqual(fundingFor("base"), { kind: "onramp", network: "base" });
  assert.deepEqual(fundingFor("arc"), { kind: "faucet", network: "arc", url: ARC_FAUCET_URL });
  assert.deepEqual(fundingFor("solana"), { kind: "bridge", network: "solana" });
  assert.equal(TOOLS.find((tool) => tool.id === "arc-faucet").href, ARC_FAUCET_URL);

  const url = new URL(coinbaseOnrampUrl("tok_abc-123.456", EVM));
  assert.equal(url.origin, "https://pay.coinbase.com");
  assert.equal(url.searchParams.get("sessionToken"), "tok_abc-123.456");
  assert.deepEqual(JSON.parse(url.searchParams.get("addresses")), { [EVM]: ["base"] });
  assert.throws(() => coinbaseOnrampUrl("tok&evil=1", EVM), /invalid session token/u);
  assert.throws(() => coinbaseOnrampUrl("tok_abcdefgh", "not-an-address"), /EVM address/u);

  const calls = [];
  const answer = (status, body) => async (input, init) => {
    calls.push({ input, init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  const ok = await requestCoinbaseOnramp(EVM, { backendUrl: "https://api.example", fetchImpl: answer(200, { status: "success", token: "tok_abcdefgh" }) });
  assert.equal(ok.ok, true);
  assert.equal(calls[0].input, "https://api.example/api/onramp-token");
  assert.equal(calls[0].init.headers["X-Kletia-Network"], "base");
  assert.equal(calls[0].init.headers["X-Kletia-Chain-Id"], "8453");
  assert.deepEqual(JSON.parse(calls[0].init.body), { address: EVM });
  for (const [status, body] of [[200, { status: "error" }], [500, { status: "success", token: "tok_abcdefgh" }], [200, { status: "success", token: "bad token" }], [200, null]]) {
    const result = await requestCoinbaseOnramp(EVM, { backendUrl: "https://api.example", fetchImpl: answer(status, body) });
    assert.equal(result.ok, false, JSON.stringify(body));
  }
  const thrown = await requestCoinbaseOnramp(EVM, { backendUrl: "https://api.example", fetchImpl: async () => { throw new Error("offline"); } });
  assert.equal(thrown.ok, false);
  const before = calls.length;
  assert.equal((await requestCoinbaseOnramp("nope", { backendUrl: "https://api.example", fetchImpl: answer(200, {}) })).ok, false);
  assert.equal(calls.length, before, "no request without an EVM address");
});

test("Studio hands off to the desk: /app?q=<sentence>&from=<departure> only when Auto might start elsewhere", () => {
  const plan = (text, network, departure) => ({ request: { text }, steps: network ? [{ network }] : [], interpretation: { source: "grammar", confidence: 1, ...(departure ? { departure } : {}) } });
  assert.equal(deskHandoffHref(plan("bridge 25 USDC from base to solana", "base")), "/app?q=bridge+25+USDC+from+base+to+solana&from=base");
  assert.equal(deskHandoffHref(plan("swap 1 SOL to USDC", "solana", { network: "solana", chosen: "auto" })), "/app?q=swap+1+SOL+to+USDC");
  assert.equal(deskHandoffHref(plan("bridge 25 USDC from base to solana", "base", { network: "base", chosen: "text" })), "/app?q=bridge+25+USDC+from+base+to+solana");
  assert.equal(handoffDeparture(plan("swap 10 USDC to WETH", "arbitrum", { network: "arbitrum", chosen: "inferred" })), "arbitrum");
  assert.equal(handoffDeparture(plan("send 1 USDC", "arc", { network: "base", chosen: "auto", bridged: true })), "arc");
  assert.equal(deskHandoffHref(plan("", "base")), "/app");
  assert.equal(deskHandoffHref(plan("x".repeat(501), "base")), "/app");
  assert.equal(deskHandoffHref(plan("a & b", null)), "/app?q=a+%26+b");

  const page = read("app/pages/studio/StudioPage.tsx");
  assert.doesNotMatch(page, /StudioExecutionPanel|import\(/u, "Studio loads no wallet panel");
  assert.match(page, /Run in the console/u);
  assert.match(page, /deskHandoffHref\(intent\)/u);
  assert.match(page, /prefetch=\{false\}/u, "the desk link never prefetches the console chunk on a site page");
  assert.equal(existsSync(resolve(src, "app/pages/studio/StudioExecutionPanel.tsx")), false);
  const workspace = read("app/pages/studio/StudioWorkspace.tsx");
  assert.doesNotMatch(workspace, /autoPlanned/u, "no one-shot ref: StrictMode's simulated unmount must not strand ?q=");
  assert.match(workspace, /submitRef\.current\(initialText\)/u);
});

test("the old console is deleted; the cards engine tasks render, crossNetworkPrompt and WalletDock stay", () => {
  const gone = [
    "app/App.tsx",
    "shared/components/layout",
    "shared/components/chat/ChatInput.tsx",
    "shared/components/chat/IntentStarter.tsx",
    "shared/components/chat/CrossNetworkHandoffCard.tsx",
    "shared/components/chat/InlineIntentPlanner.tsx",
    "shared/components/chat/crossNetworkHandoff.ts",
    "networks/solana/components/SolanaWorkspace.tsx",
    "networks/solana/components/SolanaAsk.tsx",
    "networks/solana/components/SolanaOverview.tsx",
    "networks/solana/solanaTabs.ts",
    "shared/hooks/useNetwork.ts",
  ];
  for (const path of gone) assert.equal(existsSync(resolve(src, path)), false, `${path} is deleted`);
  for (const path of ["shared/platform/crossNetworkPrompt.ts", "shared/components/chat/AgentsHandoffCard.tsx", "shared/components/chat/TerminalLogs.tsx", "shared/wallet/WalletDock.tsx"]) {
    assert.ok(existsSync(resolve(src, path)), `${path} stays`);
  }
  const networks = read("shared/config/networks.ts");
  for (const name of ["ConsoleWorkspace", "AppTab", "SOLANA_WORKSPACE", "getWorkspacePresentation", "navigation", "features", "funding"]) {
    assert.doesNotMatch(networks, new RegExp(`\\b${name}\\b`, "u"), `networks.ts no longer exports ${name}`);
  }
  assert.match(networks, /export const NETWORKS/u);
  assert.match(networks, /export const SUPPORTED_CHAINS/u);
  assert.match(read("app/routes/routeTable.ts"), /import\("\.\/ConsoleRoute"\)/u);
});

test("console-only CSS left the entry stylesheet for legacyConsole.css, imported by the engine bodies only", () => {
  const entry = read("app/styles.css");
  assert.doesNotMatch(entry, /arc-mode|\.arc-dashboard|\.arc-input|kl-msg-in|scrollbar-hide/u);
  const legacy = read("app/console/legacy/legacyConsole.css");
  assert.match(legacy, /\.kl-msg-in/u);
  assert.match(legacy, /\.arc-dashboard/u);
  assert.doesNotMatch(legacy, /arc-mode/u, "the arc-mode overrides are deleted, not moved");
  const importers = [];
  const walk = (dir) => {
    for (const entryName of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entryName.name);
      if (entryName.isDirectory()) walk(path);
      else if (/\.(tsx?|css)$/u.test(entryName.name) && /legacyConsole\.css/u.test(readFileSync(path, "utf8")) && !path.endsWith("legacyConsole.css")) importers.push(path.slice(src.length + 1));
    }
  };
  walk(src);
  assert.deepEqual(importers, ["app/console/legacy/LegacyMessageBody.tsx"]);
});

test("the tool panel copy is plain English: no emoji, no em dash", () => {
  const strings = [];
  const collect = (value) => {
    if (typeof value === "string") strings.push(value);
    else if (typeof value === "function") strings.push(String(value("X")));
    else if (value && typeof value === "object") Object.values(value).forEach(collect);
  };
  collect(TOOL_COPY);
  assert.ok(strings.length > 10);
  for (const text of strings) {
    assert.doesNotMatch(text, /\p{Extended_Pictographic}/u, text);
    assert.doesNotMatch(text, /—/u, text);
  }
});
