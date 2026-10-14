// Phase 2 of the /embed frame (integrator 4.8 and P8, clarify C4b): the
// publishable key and flow in the fragment, the project profile against the
// bridge-proven host, the verified brand (never from URL parameters), the
// defaults under the element's settings, and question events without values.
import assert from "node:assert/strict";
import test from "node:test";
import { CHAINS } from "@kletia/core";

import { createEmbedBridge, questionReport } from "../embedBridge.ts";
import { mergeAppearance, profileView, readEmbedFragment, readEmbedKey, readEmbedParams, readEmbedScope, searchWithDefaults } from "../embedParams.ts";

const KEY = `kl_pub_${"Q7r".repeat(10)}aZ`;
const HOST = "https://shop.example";
const SHA = "ab".repeat(32);

const profile = (overrides = {}) => ({
  projectId: "prj_key_2dce",
  brand: { name: "Acme Store", host: "acme.example", verified: true, logo: { sha256: SHA, type: "image/png" } },
  allowedOrigins: [HOST, "http://localhost:3000"],
  lane: "production",
  defaults: { networks: ["base", "solana"], actions: ["swap", "bridge"], sourceNetwork: "base", examples: ["swap 1 SOL to USDC"], appearance: { radius: 8, light: { accent: "#0F766E" } } },
  flows: [{ id: "deposit", label: "Deposit into Acme vault", networks: ["arbitrum-sepolia"] }],
  ...overrides,
});

test("the fragment carries a publishable key and a flow of exact shapes only", () => {
  assert.deepEqual(readEmbedKey(`#key=${KEY}`), { key: KEY, flow: null });
  assert.deepEqual(readEmbedKey(`#key=${KEY}&flow=deposit`), { key: KEY, flow: "deposit" });
  for (const hash of [
    `#key=kl_dev_${"a".repeat(32)}`,
    `#key=kl_agt_${"a".repeat(32)}`,
    `#key=${KEY}x`,
    `#key=${KEY}&key=${KEY}`,
    `#key=${KEY}&flow=Deposit`,
    `#key=${KEY}&flow=a&flow=b`,
    "#flow=deposit",
    "",
  ]) {
    assert.equal(readEmbedKey(hash), null, hash);
  }
  // The key never opens integrator work, and the query string is never read for it.
  assert.equal(readEmbedFragment(`#key=${KEY}`), null);
  assert.deepEqual(readEmbedParams(`?key=${KEY}`), { theme: "auto", text: "", examples: null, transparent: false });
});

test("the frame refuses a proven host the project did not allow", () => {
  const view = profileView(profile(), "https://evil.example", null);
  assert.deepEqual(view, { ok: false, code: "PUBLISHABLE_ORIGIN_FORBIDDEN", host: "evil.example" });
  // Exact origins only: scheme and port count.
  assert.equal(profileView(profile(), "http://shop.example", null).ok, false);
  assert.equal(profileView(profile(), "http://localhost:3001", null).ok, false);
  assert.equal(profileView(profile(), "http://localhost:3000", null).ok, true);
});

test("the bridge proves the host the profile is checked against: a connect from another origin never reaches the profile", () => {
  for (const [origin, allowed] of [[HOST, true], ["https://evil.example", false]]) {
    const parent = {};
    let listener = null;
    const bridge = createEmbedBridge({
      listen: (next) => ((listener = next), () => (listener = null)),
      context: () => ({ parent, self: {}, ancestorOrigins: [origin], expectedOrigin: origin }),
    });
    bridge.start();
    listener({ data: { kletia: "connect", v: 1 }, origin, source: parent, ports: [{ postMessage() {} }] });
    const snapshot = bridge.getSnapshot();
    assert.equal(snapshot.status, "connected");
    assert.equal(profileView(profile(), snapshot.origin, null).ok, allowed, origin);
  }
});

test("a stored flow must exist in the profile; a malformed profile fails closed", () => {
  assert.equal(profileView(profile(), HOST, "deposit").flow, "deposit");
  assert.deepEqual(profileView(profile(), HOST, "withdraw"), { ok: false, code: "FLOW_UNKNOWN" });
  for (const bad of [null, [], { projectId: "x", allowedOrigins: [HOST] }, { projectId: "prj_a" }, "profile"]) {
    assert.deepEqual(profileView(bad, HOST, null), { ok: false, code: "INVALID_RESPONSE" });
  }
});

test("the brand header comes only from a verified profile, with the logo on the project's own path", () => {
  const view = profileView(profile(), HOST, null);
  assert.deepEqual(view.brand, { name: "Acme Store", host: "acme.example", logoPath: `/v1/projects/prj_key_2dce/logo/${SHA}.png` });
  assert.equal(profileView(profile({ brand: { name: "Acme Store", host: "acme.example", verified: false } }), HOST, null).brand, null);
  assert.equal(profileView(profile({ brand: { name: "Acme Store", host: "acme.example", verified: "true" } }), HOST, null).brand, null);
  assert.equal(profileView(profile({ brand: null }), HOST, null).brand, null);
  // A logo of another project, a remote URL or an SVG is never shown.
  for (const logo of [`/v1/projects/prj_other/logo/${SHA}.png`, "https://evil.example/logo.png", { sha256: SHA, type: "image/svg+xml" }]) {
    assert.equal(profileView(profile({ brand: { name: "Acme", host: "acme.example", verified: true, logo } }), HOST, null).brand.logoPath, null);
  }
  // URL parameters cannot name a brand: the frame's parsers have no brand at all.
  assert.equal("brand" in readEmbedParams("?brand=Acme&header=brand&name=Acme"), false);
});

test("the testnet lane is reported for the ribbon", () => {
  assert.equal(profileView(profile({ lane: "testnet" }), HOST, null).testnet, true);
  assert.equal(profileView(profile(), HOST, null).testnet, false);
});

test("project defaults sit under the element's settings", () => {
  const { defaults } = profileView(profile(), HOST, null);
  const withDefaults = searchWithDefaults("?theme=dark", defaults);
  assert.deepEqual(readEmbedScope(withDefaults, CHAINS), { networks: ["base", "solana"], actions: ["swap", "bridge"], source: "base" });
  assert.deepEqual(readEmbedParams(withDefaults).examples, ["swap 1 SOL to USDC"]);
  // The element's own networks win (and the default source outside them is dropped by the usual parser).
  const own = searchWithDefaults("?networks=solana", defaults);
  assert.deepEqual(readEmbedScope(own, CHAINS), { networks: ["solana"], actions: ["swap", "bridge"], source: null });
  // Appearance: attributes over defaults, palettes merged per colour.
  assert.deepEqual(mergeAppearance(defaults.appearance, { light: { ink: "#141414" }, font: "mono" }), {
    radius: 8,
    light: { accent: "#0F766E", ink: "#141414" },
    font: "mono",
  });
  assert.deepEqual(mergeAppearance(defaults.appearance, { radius: 2, light: { accent: "#123456" } }), { radius: 2, light: { accent: "#123456" } });
  assert.deepEqual(mergeAppearance(null, { radius: 2 }), { radius: 2 });
});

test("question reports carry counts and reason codes, never values", () => {
  assert.deepEqual(questionReport({ reason: "AMOUNT_MISSING", kind: "amount", purpose: true }), { count: 1, reasons: ["AMOUNT_MISSING"] });
  assert.deepEqual(
    questionReport({ questions: [{ reason: "AMOUNT_MISSING", text: "How much SOL? You hold 2.5" }, { reason: "NETWORK_AMBIGUOUS", options: ["base"] }, { reason: "swap 1 SOL" }] }),
    { count: 3, reasons: ["AMOUNT_MISSING", "NETWORK_AMBIGUOUS"] },
  );
  assert.equal(questionReport([]), null);
  assert.equal(questionReport(null), null);

  const posted = [];
  const parent = {};
  let listener = null;
  const bridge = createEmbedBridge({
    listen: (next) => ((listener = next), () => (listener = null)),
    context: () => ({ parent, self: {}, ancestorOrigins: [HOST], expectedOrigin: HOST }),
  });
  bridge.start();
  bridge.question({ reason: "AMOUNT_MISSING" });
  listener({ data: { kletia: "connect", v: 1 }, origin: HOST, source: parent, ports: [{ postMessage: (message) => posted.push(message) }] });
  bridge.resize(480);
  bridge.question({ questions: [{ reason: "AMOUNT_MISSING", value: "2.49", address: "0xabc" }] });
  assert.deepEqual(posted.map((message) => message.type), ["ready", "question"], "nothing before ready");
  assert.deepEqual(posted[1], { kletia: "event", v: 1, type: "question", count: 1, reasons: ["AMOUNT_MISSING"] });
});
