// Embed builder model (integrator 4.4 and P3, portal 4.4.9): golden outputs
// for a fixed state, attribute escaping, integrity only from the manifest,
// flow mode with a publishable key, and no secret key in any output.
import assert from "node:assert/strict";
import test from "node:test";

import { clearSessionKey, setSessionKey } from "../keys/sessionKeyStore.ts";
import {
  builderErrors,
  builderOutput,
  contrastNotes,
  DEFAULT_BUILDER_STATE,
  elementAttributes,
  escapeAttribute,
  parseEmbedManifest,
  PREVIEW_SANDBOX_NOTE,
  previewErrorHint,
  previewOptions,
} from "../builder/builderModel.ts";

const STATE = {
  ...DEFAULT_BUILDER_STATE,
  text: 'swap 1 SOL to "USDC" <now> & go',
  examples: "swap 1 SOL to USDC,bridge 25 USDC from base to solana",
  networks: ["base", "solana"],
  sourceNetwork: "base",
  actions: ["swap", "bridge"],
  colors: { accent: "#0f766e", ink: "", surface: "", line: "" },
  radius: 8,
  font: "system",
  density: "compact",
  reference: "order-42",
};
const MANIFEST = { version: "0.1.0", script: { path: "/sdk/embed/0.1.0/kletia-embed.min.js", integrity: `sha384-${"A".repeat(64)}` } };
const ORIGINS = { web: "https://kletiaai.xyz", api: "https://api.kletiaai.xyz" };
const PUB = `kl_pub_${"Q7r".repeat(10)}aZ`;

const GOLDEN = {
  html: String.raw`<!-- Serve this page over http(s): a file:// page has no origin, so the widget cannot connect. -->
<script
  src="https://kletiaai.xyz/sdk/embed/0.1.0/kletia-embed.min.js"
  integrity="sha384-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
  crossorigin="anonymous"
></script>

<kletia-intent
  text="swap 1 SOL to &quot;USDC&quot; &lt;now&gt; &amp; go"
  examples="swap 1 SOL to USDC,bridge 25 USDC from base to solana"
  networks="base,solana"
  source-network="base"
  actions="swap,bridge"
  accent="0F766E"
  radius="8"
  font="system"
  density="compact"
  height="720"
  reference="order-42"
></kletia-intent>

<script type="module">
  const widget = document.querySelector("kletia-intent");
  // Notifications only: your server verifies GET /v1/intents/{id} before it fulfils anything.
  widget.addEventListener("kletia:ready", (event) => console.log("ready", event.detail.height));
  widget.addEventListener("kletia:intent-created", (event) => console.log("intent", event.detail.intentId, event.detail.status));
  widget.addEventListener("kletia:question", (event) => console.log("asking", event.detail.count, event.detail.reasons));
  widget.addEventListener("kletia:completed", (event) => console.log("done", event.detail.status));
  widget.addEventListener("kletia:error", (event) => console.warn(event.detail.code, event.detail.message));
</script>`,
  npm: String.raw`// npm install @kletia/embed
import { mountKletiaIntent } from "@kletia/embed";

mountKletiaIntent("#kletia-widget", {
  text: "swap 1 SOL to \"USDC\" \u003cnow\u003e \u0026 go",
  examples: ["swap 1 SOL to USDC", "bridge 25 USDC from base to solana"],
  networks: ["base", "solana"],
  sourceNetwork: "base",
  actions: ["swap", "bridge"],
  accent: "0F766E",
  radius: 8,
  font: "system",
  density: "compact",
  height: 720,
  reference: "order-42",
  // Notifications only: your server verifies GET /v1/intents/{id} before it fulfils anything.
  onIntentCreated: (detail) => console.log("intent", detail.intentId, detail.status),
  onQuestion: (detail) => console.log("asking", detail.count, detail.reasons),
  onError: (detail) => console.warn(detail.code, detail.message),
});`,
  react: String.raw`// npm install @kletia/widget @kletia/sdk @kletia/core react react-dom
import { KletiaIntentWidget } from "@kletia/widget";

// accounts: your visitor's wallet accounts (CAIP-10); signers: their wallet signers.
// Without signers the widget plans and reviews, and never executes.
export function Checkout({ accounts, signers }) {
  return (
    <KletiaIntentWidget
      accounts={accounts}
      signers={signers}
      defaultText={"swap 1 SOL to \"USDC\" \u003cnow\u003e \u0026 go"}
      examples={["swap 1 SOL to USDC", "bridge 25 USDC from base to solana"]}
      networks={["base", "solana"]}
      sourceNetwork={"base"}
      actions={["swap", "bridge"]}
      appearance={{
        light: {
          accent: "#0F766E",
        },
        radius: 8,
        font: "system",
        density: "compact",
      }}
      metadata={{
        hostRef: "order-42",
      }}
    />
  );
}`,
  iframe: String.raw`<!-- A plain frame reports no events; use <kletia-intent> for kletia:* events and auto-resize. -->
<!-- allow-scripts with allow-same-origin lets the widget keep wallet state and call the API. Browsers may log a warning about the pair; it matters only for a frame of your own origin, and /embed is Kletia's. -->
<iframe
  src="https://kletiaai.xyz/embed?text=swap+1+SOL+to+%22USDC%22+%3Cnow%3E+%26+go&amp;examples=swap+1+SOL+to+USDC%2Cbridge+25+USDC+from+base+to+solana&amp;networks=base%2Csolana&amp;source=base&amp;actions=swap%2Cbridge&amp;accent=0F766E&amp;radius=8&amp;font=system&amp;density=compact"
  title="Kletia intent widget"
  sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
  allow="clipboard-write"
  referrerpolicy="strict-origin-when-cross-origin"
  style="display:block;width:100%;height:720px;border:0"
></iframe>`,
};

test("HTML, npm, React and iframe output for a fixed state (golden strings)", () => {
  for (const output of ["html", "npm", "react", "iframe"]) {
    assert.equal(builderOutput(output, STATE, ORIGINS, MANIFEST), GOLDEN[output], output);
  }
});

test("attribute values escape quotes, angle brackets and ampersands", () => {
  assert.equal(escapeAttribute(`a"b<c>d&e`), "a&quot;b&lt;c&gt;d&amp;e");
  const html = builderOutput("html", { ...STATE, reference: "" , text: `"><script>alert(1)</script>` }, ORIGINS, MANIFEST);
  assert.match(html, /text="&quot;&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;"/u);
  assert.doesNotMatch(html, /<script>alert/u);
});

test("the integrity comes only from the manifest; without one the HTML output is a notice", () => {
  const notice = builderOutput("html", STATE, ORIGINS, null);
  assert.doesNotMatch(notice, /<script|integrity=/u);
  assert.match(notice, /cannot pin an integrity hash/u);
  const manifest = parseEmbedManifest({
    schema: "kletia.embed-manifest/v1",
    version: "0.2.0",
    files: { "kletia-embed.min.js": { path: "/sdk/embed/0.2.0/kletia-embed.min.js", integrity: `sha384-${"B".repeat(64)}`, bytes: 1 } },
  });
  assert.deepEqual(manifest, { version: "0.2.0", script: { path: "/sdk/embed/0.2.0/kletia-embed.min.js", integrity: `sha384-${"B".repeat(64)}` } });
  assert.match(builderOutput("html", STATE, { web: "http://localhost:3832", api: "http://localhost:3831" }, manifest), /src="http:\/\/localhost:3832\/sdk\/embed\/0\.2\.0\/kletia-embed\.min\.js"\n  integrity="sha384-B{64}"/u);
  for (const bad of [
    null,
    { schema: "kletia.embed-manifest/v1", version: "0.2.0", files: { "kletia-embed.min.js": { path: "/sdk/embed/0.1.0/kletia-embed.min.js", integrity: `sha384-${"B".repeat(64)}` } } },
    { schema: "kletia.embed-manifest/v1", version: "0.2.0", files: { "kletia-embed.min.js": { path: "https://cdn.example/x.js", integrity: `sha384-${"B".repeat(64)}` } } },
    { schema: "kletia.embed-manifest/v1", version: "0.2.0", files: { "kletia-embed.min.js": { path: "/sdk/embed/0.2.0/kletia-embed.min.js", integrity: "sha256-abc" } } },
  ]) {
    assert.equal(parseEmbedManifest(bad), null);
  }
});

test("flow mode puts the publishable key and the flow on the element; the iframe refuses it", () => {
  const flow = { ...STATE, mode: "flow", publishableKey: PUB, flow: "deposit" };
  const attributes = Object.fromEntries(elementAttributes(flow));
  assert.equal(attributes.key, PUB);
  assert.equal(attributes.flow, "deposit");
  assert.equal(attributes.text, undefined, "a flow has no prompt");
  assert.match(builderOutput("npm", flow, ORIGINS, MANIFEST), new RegExp(`publishableKey: "${PUB}",\\n  flow: "deposit",`, "u"));
  assert.match(builderOutput("iframe", flow, ORIGINS, MANIFEST), /need <kletia-intent>/u);
  assert.deepEqual(builderErrors({ ...flow, flow: "Deposit" }).flow !== undefined, true);
  assert.equal(previewOptions(flow, "https://kletiaai.xyz").publishableKey, PUB);
});

test("no kl_dev_ or kl_agt_ substring in any output, even when the key store holds one or a field does", () => {
  const secret = `kl_dev_${"s".repeat(32)}`;
  setSessionKey(secret);
  try {
    const agent = `kl_agt_${"a".repeat(32)}`;
    const states = [
      STATE,
      { ...STATE, mode: "flow", publishableKey: secret, flow: "deposit" },
      { ...STATE, publishableKey: agent },
      { ...STATE, text: `use ${secret}`, examples: `pay with ${agent}`, reference: secret },
    ];
    for (const state of states) {
      for (const output of ["html", "npm", "react", "iframe"]) {
        assert.doesNotMatch(builderOutput(output, state, ORIGINS, MANIFEST), /kl_(?:dev|agt)_/u, `${output} ${state.mode}`);
      }
      assert.doesNotMatch(JSON.stringify(previewOptions(state, "https://kletiaai.xyz")), /kl_(?:dev|agt)_/u);
    }
    assert.match(builderErrors({ ...STATE, publishableKey: secret }).publishableKey, /secret key/u);
  } finally {
    clearSessionKey();
  }
});

test("session and intent ids must match their patterns", () => {
  assert.ok(builderErrors({ ...STATE, mode: "session", sessionId: "cs_123" }).sessionId);
  assert.equal(builderErrors({ ...STATE, mode: "session", sessionId: `cs_${"a".repeat(32)}` }).sessionId, undefined);
  assert.ok(builderErrors({ ...STATE, mode: "intent", intentId: `int_${"A".repeat(32)}` }).intentId);
  assert.ok(builderErrors({ ...STATE, networks: ["base", "arbitrum-sepolia"] }).networks);
});

test("contrast warnings come from the frame's resolver with a one-click fix", () => {
  const notes = contrastNotes({ ...STATE, theme: "light", colors: { accent: "", ink: "#777777", surface: "#888888", line: "" } });
  assert.ok(notes.length > 0);
  assert.ok(notes.some((note) => note.color === "surface" || note.color === "ink"));
  assert.deepEqual(contrastNotes({ ...DEFAULT_BUILDER_STATE }), []);
});

test("the preview explains PUBLISHABLE_ORIGIN_FORBIDDEN with this site's origin, and only that refusal", () => {
  const hint = previewErrorHint("PUBLISHABLE_ORIGIN_FORBIDDEN", "https://kletiaai.xyz");
  assert.match(hint, /runs on https:\/\/kletiaai\.xyz/u);
  assert.match(hint, /allowed origins in Project settings/u);
  assert.match(hint, /public tier/u);
  for (const code of ["RATE_LIMITED", "EMBED_ORIGIN_INVALID", "INTENT_UNSUPPORTED"]) assert.equal(previewErrorHint(code, "https://kletiaai.xyz"), null, code);
  assert.match(PREVIEW_SANDBOX_NOTE, /allow-scripts and allow-same-origin/u);
});
