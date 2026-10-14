import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  BRIDGE_PROTOCOL_VERSION,
  DEFAULT_KLETIA_ORIGIN,
  EMBED_VERSION,
  FRAME_REFERRER_POLICY,
  FRAME_SANDBOX,
  MAX_FRAME_HEIGHT,
  OBSERVED_ATTRIBUTES,
  buildEmbedUrl,
  clampFrameHeight,
  kletiaOriginFromScript,
  parseMaxHeight,
  connectFrame,
  defineKletiaIntent,
  embedFragment,
  normalizeExamples,
  normalizeHostOrigin,
  normalizeKletiaOrigin,
  parseBridgeMessage,
  parseFrameHeight,
  readElementConfig,
} from "../dist/index.js";

const HOST = "https://shop.example";
const attributes = (values) => (name) => (Object.hasOwn(values, name) ? values[name] : null);
const query = (url) => Object.fromEntries(new URL(url).searchParams);
const event = (type, fields = {}) => ({ kletia: "event", v: BRIDGE_PROTOCOL_VERSION, type, ...fields });
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

test("loads without a DOM and matches the package version", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(EMBED_VERSION, manifest.version);
  assert.equal(defineKletiaIntent(), null);
});

test("the frame sandbox never grants top navigation and the referrer policy keeps ancestorOrigins", () => {
  const flags = FRAME_SANDBOX.split(" ");
  assert.deepEqual(flags.filter((flag) => /top-navigation|modals|downloads|pointer-lock/u.test(flag)), []);
  assert.ok(flags.includes("allow-scripts") && flags.includes("allow-same-origin") && flags.includes("allow-forms"));
  assert.notEqual(FRAME_REFERRER_POLICY, "no-referrer");
});

test("an element without attributes points at the hosted embed and opts into the bridge", () => {
  const config = readElementConfig(attributes({}));
  assert.equal(config.origin, DEFAULT_KLETIA_ORIGIN);
  assert.equal(config.height, 600);
  assert.equal(config.label, "Kletia intent widget");
  assert.equal(
    buildEmbedUrl(config.origin, config.options, HOST),
    "https://kletiaai.xyz/embed?bridge=1&origin=https%3A%2F%2Fshop.example",
  );
});

test("every attribute maps to its query parameter", () => {
  const config = readElementConfig(
    attributes({
      origin: "http://localhost:5174/",
      theme: "Dark",
      text: "  swap 1 SOL\nto   USDC ",
      examples: "stake 2 SOL with jito, swap 10 USDC to ETH on base",
      bg: "transparent",
      reference: "order-42",
      height: "720px",
      label: "Pay with Kletia",
    }),
  );
  assert.equal(config.origin, "http://localhost:5174");
  assert.equal(config.height, 720);
  assert.equal(config.label, "Pay with Kletia");
  const url = buildEmbedUrl(config.origin, config.options, "http://127.0.0.1:4173");
  assert.ok(url.startsWith("http://localhost:5174/embed?"));
  assert.deepEqual(query(url), {
    theme: "dark",
    text: "swap 1 SOL to USDC",
    examples: "stake 2 SOL with jito,swap 10 USDC to ETH on base",
    bg: "transparent",
    ref: "order-42",
    bridge: "1",
    origin: "http://127.0.0.1:4173",
  });
});

test("invalid attribute values are dropped instead of forwarded", () => {
  const url = buildEmbedUrl(
    DEFAULT_KLETIA_ORIGIN,
    { theme: "neon", text: "   ", examples: " , ,", bg: "red", reference: "has spaces" },
    HOST,
  );
  assert.deepEqual(query(url), { bridge: "1", origin: HOST });
  assert.equal(query(buildEmbedUrl(DEFAULT_KLETIA_ORIGIN, { theme: "auto" })).theme, undefined);
  assert.equal(query(buildEmbedUrl(DEFAULT_KLETIA_ORIGIN, { reference: "x".repeat(81) })).ref, undefined);
  assert.equal(query(buildEmbedUrl(DEFAULT_KLETIA_ORIGIN, { reference: "a.b:c_d-1" })).ref, "a.b:c_d-1");
});

test("intent and session ids travel in the fragment, never in the query", () => {
  const intent = `int_${"a".repeat(32)}`;
  const session = `cs_${"b".repeat(32)}`;
  const config = readElementConfig(attributes({ intent: ` ${intent} `, reference: "order-42" }));
  const url = buildEmbedUrl(config.origin, config.options, HOST);
  assert.equal(new URL(url).hash, `#intent=${intent}`);
  assert.equal(url.includes(`?intent`) || url.includes(`&intent`) || query(url).intent !== undefined, false);
  assert.deepEqual(query(url), { ref: "order-42", bridge: "1", origin: HOST });
  assert.equal(new URL(buildEmbedUrl(DEFAULT_KLETIA_ORIGIN, { session }, HOST)).hash, `#session=${session}`);
  // The intent wins when both are set; malformed ids are dropped, never forwarded.
  assert.equal(embedFragment({ intent, session }), `#intent=${intent}`);
  for (const bad of ["int_ABC", `int_${"a".repeat(31)}`, `${intent}&x=1`, "cs_123", "javascript:alert(1)", 7, null]) {
    assert.equal(embedFragment({ intent: bad, session: bad }), "", String(bad));
  }
  assert.equal(new URL(buildEmbedUrl(DEFAULT_KLETIA_ORIGIN, { session: "cs_nope" })).hash, "");
});

test("text and examples are cleaned and capped like the frame caps them", () => {
  const text = query(buildEmbedUrl(DEFAULT_KLETIA_ORIGIN, { text: `a\u0000b ${"x".repeat(600)}` })).text;
  assert.equal(text.length, 500);
  assert.ok(text.startsWith("a b x"));
  assert.deepEqual(normalizeExamples("one, two, One, ,three,four,five,six,seven"), ["one", "two", "three", "four", "five", "six"]);
  assert.deepEqual(normalizeExamples(["a,b", "c", 7, null]), ["a", "b", "c"]);
  assert.equal(normalizeExamples(["y".repeat(200)])[0].length, 120);
});

test("pages without an http(s) origin get no bridge parameters", () => {
  for (const host of [undefined, null, "", "null", "file://", "https://shop.example/", "javascript:alert(1)"]) {
    const params = query(buildEmbedUrl(DEFAULT_KLETIA_ORIGIN, {}, host));
    assert.equal(params.bridge, undefined, String(host));
    assert.equal(params.origin, undefined, String(host));
  }
  assert.equal(normalizeHostOrigin("http://127.0.0.1:4173"), "http://127.0.0.1:4173");
});

test("the Kletia origin must be https, or http on localhost", () => {
  assert.equal(normalizeKletiaOrigin(""), DEFAULT_KLETIA_ORIGIN);
  assert.equal(normalizeKletiaOrigin(null), DEFAULT_KLETIA_ORIGIN);
  assert.equal(normalizeKletiaOrigin("https://kletiaai.xyz/"), "https://kletiaai.xyz");
  assert.equal(normalizeKletiaOrigin("https://staging.kletiaai.xyz:8443"), "https://staging.kletiaai.xyz:8443");
  assert.equal(normalizeKletiaOrigin("http://localhost:5174"), "http://localhost:5174");
  assert.equal(normalizeKletiaOrigin("http://127.0.0.1:5174"), "http://127.0.0.1:5174");
  assert.equal(normalizeKletiaOrigin("http://[::1]:5174"), "http://[::1]:5174");
  for (const bad of [
    "http://kletiaai.xyz",
    "https://kletiaai.xyz/embed",
    "https://kletiaai.xyz/?theme=dark",
    "https://kletiaai.xyz/#x",
    "https://user:pass@kletiaai.xyz",
    "javascript:alert(1)",
    "data:text/html,hi",
    "kletiaai.xyz",
  ]) {
    assert.equal(normalizeKletiaOrigin(bad), null, bad);
  }
  assert.equal(readElementConfig(attributes({ origin: "http://evil.example" })).origin, null);
  assert.throws(() => buildEmbedUrl("http://evil.example"), TypeError);
});

test("height is the starting height in pixels, clamped, with 600 as the default", () => {
  assert.equal(parseFrameHeight("640"), 640);
  assert.equal(parseFrameHeight(" 640PX "), 640);
  assert.equal(parseFrameHeight("80"), 320);
  assert.equal(parseFrameHeight("99999"), 1600);
  assert.equal(parseFrameHeight(700.4), 700);
  for (const fallback of [null, undefined, "", "auto", "50%", "12em", "-5", Number.NaN]) {
    assert.equal(parseFrameHeight(fallback), 600, String(fallback));
  }
});

test("bridge messages are validated and reduced to the documented fields", () => {
  assert.deepEqual(parseBridgeMessage(event("ready", { height: 612.2 })), { name: "kletia:ready", detail: { height: 613 } });
  assert.deepEqual(parseBridgeMessage(event("resize", { height: 700 })), { name: "kletia:resize", detail: { height: 700 } });
  assert.deepEqual(parseBridgeMessage(event("intent.planned", { status: "planned", intentId: "int_x", reference: "order-42" })), {
    name: "kletia:intent-planned",
    detail: { status: "planned", reference: "order-42" },
  });
  assert.deepEqual(
    parseBridgeMessage(event("intent.created", { intentId: "int_abc123", status: "planned", reference: "order-42", account: "solana:…:7xKX" })),
    { name: "kletia:intent-created", detail: { intentId: "int_abc123", status: "planned", reference: "order-42" } },
  );
  assert.deepEqual(
    parseBridgeMessage(
      event("intent.step_updated", { intentId: "int_1", stepId: "s1", stepIndex: 0, network: "solana", status: "submitted", txHash: "0xabc" }),
    ),
    { name: "kletia:step-updated", detail: { intentId: "int_1", stepId: "s1", stepIndex: 0, network: "solana", status: "submitted" } },
  );
  assert.deepEqual(parseBridgeMessage(event("intent.completed", { intentId: "int_1", status: "completed" })), {
    name: "kletia:completed",
    detail: { intentId: "int_1", status: "completed" },
  });
  assert.deepEqual(parseBridgeMessage(event("error", { code: "USER_REJECTED", message: "The wallet\nrequest was declined." })), {
    name: "kletia:error",
    detail: { code: "USER_REJECTED", message: "The wallet request was declined." },
  });

  for (const bad of [
    null,
    "ready",
    { type: "ready", height: 10 },
    { ...event("ready", { height: 10 }), v: 2 },
    { ...event("ready", { height: 10 }), kletia: "connect" },
    event("ready", { height: -1 }),
    event("ready", { height: Number.POSITIVE_INFINITY }),
    event("resize", { height: "700" }),
    event("intent.created", { status: "planned" }),
    event("intent.created", { intentId: "<script>", status: "planned" }),
    event("intent.planned", { status: 7 }),
    event("intent.step_updated", { intentId: "int_1", stepId: "s1", stepIndex: 1.5, network: "solana", status: "submitted" }),
    event("intent.step_updated", { intentId: "int_1", stepId: "s1", stepIndex: 0, network: "Solana Mainnet", status: "submitted" }),
    event("intent.completed", { intentId: "int_1", status: "DONE" }),
    event("error", { code: "lowercase", message: "x" }),
    event("navigate", { url: "https://evil.example" }),
  ]) {
    assert.equal(parseBridgeMessage(bad), null, JSON.stringify(bad));
  }
});

/** A fake frame window: records connect attempts and hands the transferred port to the test. */
function fakeFrame() {
  const posts = [];
  return {
    posts,
    window: {
      postMessage(message, targetOrigin, transfer) {
        posts.push({ message, targetOrigin, ports: transfer });
      },
    },
  };
}

/** Closes every port a test created, even when an assertion fails, so the process can exit. */
function cleanup(t, frame, connection) {
  t.after(() => {
    connection.close();
    for (const post of frame.posts) for (const port of post.ports) port.close();
  });
}

test("connectFrame retries until the frame answers, then keeps only the winning port", async (t) => {
  const frame = fakeFrame();
  const events = [];
  let gaveUp = 0;
  const connection = connectFrame({
    target: () => frame.window,
    targetOrigin: "http://localhost:5174",
    onEvent: (item) => events.push(item),
    onGiveUp: () => (gaveUp += 1),
    retryDelays: [5, 300, 300],
    giveUpAfterMs: 300,
  });
  cleanup(t, frame, connection);
  assert.equal(connection.connected, false);
  assert.equal(frame.posts.length, 1, "the first attempt is synchronous");
  await tick(8);
  assert.equal(frame.posts.length, 2);
  for (const post of frame.posts) {
    assert.deepEqual(post.message, { kletia: "connect", v: 1 });
    assert.equal(post.targetOrigin, "http://localhost:5174");
    assert.equal(post.ports.length, 1);
  }

  const [first, second] = frame.posts.map((post) => post.ports[0]);
  // Anything but `ready` cannot open the connection.
  second.postMessage(event("resize", { height: 500 }));
  await tick();
  assert.equal(events.length, 0);
  second.postMessage(event("ready", { height: 640 }));
  await tick();
  assert.equal(connection.connected, true);
  assert.deepEqual(events, [{ name: "kletia:ready", detail: { height: 640 } }]);

  // A late answer on a losing port is ignored; the winner keeps talking.
  first.postMessage(event("ready", { height: 1 }));
  first.postMessage(event("intent.completed", { intentId: "int_1", status: "completed" }));
  second.postMessage(event("resize", { height: 700 }));
  second.postMessage({ kletia: "event", v: 1, type: "unknown" });
  await tick(5);
  assert.deepEqual(events.slice(1), [{ name: "kletia:resize", detail: { height: 700 } }]);

  await tick(350);
  assert.equal(frame.posts.length, 2, "no attempts after the frame answered");
  assert.equal(gaveUp, 0);
});

test("connectFrame gives up once when no attempt is answered", async (t) => {
  const frame = fakeFrame();
  let gaveUp = 0;
  let available = false;
  const connection = connectFrame({
    // The frame window is missing for the first attempt (e.g. not attached yet).
    target: () => (available ? frame.window : null),
    targetOrigin: "https://kletiaai.xyz",
    onEvent: () => assert.fail("no events expected"),
    onGiveUp: () => (gaveUp += 1),
    retryDelays: [2, 2],
    giveUpAfterMs: 10,
  });
  cleanup(t, frame, connection);
  available = true;
  await tick(40);
  assert.equal(frame.posts.length, 2);
  assert.equal(gaveUp, 1);
  assert.equal(connection.connected, false);
  // Ports are closed on give-up: a late answer goes nowhere.
  frame.posts[0].ports[0].postMessage(event("ready", { height: 600 }));
  await tick(5);
  assert.equal(connection.connected, false);
});

test("close() stops pending attempts", async (t) => {
  const frame = fakeFrame();
  const connection = connectFrame({
    target: () => frame.window,
    targetOrigin: "https://kletiaai.xyz",
    onEvent: () => assert.fail("no events after close"),
    onGiveUp: () => assert.fail("no give-up after close"),
    retryDelays: [2, 2, 2],
    giveUpAfterMs: 5,
  });
  cleanup(t, frame, connection);
  connection.close();
  frame.posts[0].ports[0].postMessage(event("ready", { height: 600 }));
  await tick(30);
  assert.equal(frame.posts.length, 1);
  assert.equal(connection.connected, false);
});

test("every appearance and scope attribute maps to its frame parameter", () => {
  const values = {
    accent: "#7c3aed", "accent-ink": "FFFFFF", surface: "#fafafa", ink: "#111111", line: "#333333",
    "accent-dark": "#a78bfa", "accent-ink-dark": "#000000", "surface-dark": "#0b0b0f", "ink-dark": "#eeeeee", "line-dark": "#555555",
    radius: "8", border: "2", shadow: "Soft", font: "rounded", density: "compact", header: "none",
    networks: "base, solana,base", actions: "swap,bridge", "source-network": "solana",
  };
  for (const name of Object.keys(values)) assert.ok(OBSERVED_ATTRIBUTES.includes(name), name);
  const url = buildEmbedUrl(DEFAULT_KLETIA_ORIGIN, readElementConfig(attributes(values)).options);
  assert.deepEqual(query(url), {
    accent: "7C3AED", "accent-dark": "A78BFA", "accent-ink": "FFFFFF", "accent-ink-dark": "000000", surface: "FAFAFA", "surface-dark": "0B0B0F",
    ink: "111111", "ink-dark": "EEEEEE", line: "333333", "line-dark": "555555",
    radius: "8", border: "2", shadow: "soft", font: "rounded", density: "compact", header: "none",
    networks: "base,solana", actions: "swap,bridge", source: "solana",
  });
});

test("invalid appearance and scope values are dropped, never forwarded", () => {
  const url = buildEmbedUrl(DEFAULT_KLETIA_ORIGIN, {
    accent: "red;}", surface: "url(https://evil.example/x)", ink: "#12345g", line: "#fff",
    radius: "17", border: "0", shadow: "glow", font: "papyrus", density: "tiny", header: "brand",
    networks: "../x, BASE ,x;y", actions: "borrow,call", sourceNetwork: "solana",
  });
  assert.deepEqual(query(url), { networks: "base" });
  // A source outside the listed networks is dropped; auto always passes.
  assert.equal(query(buildEmbedUrl(DEFAULT_KLETIA_ORIGIN, { networks: ["base"], sourceNetwork: "solana" })).source, undefined);
  assert.equal(query(buildEmbedUrl(DEFAULT_KLETIA_ORIGIN, { networks: ["base"], sourceNetwork: "auto" })).source, "auto");
  assert.equal(query(buildEmbedUrl(DEFAULT_KLETIA_ORIGIN, { sourceNetwork: "Arbitrum" })).source, "arbitrum");
  assert.equal(query(buildEmbedUrl(DEFAULT_KLETIA_ORIGIN, { networks: Array.from({ length: 12 }, (_, i) => `n${i}`) })).networks.split(",").length, 9);
});

test("there is no clarify switch: clarifying questions are always on", () => {
  assert.ok(!OBSERVED_ATTRIBUTES.includes("clarify"));
  assert.equal(query(buildEmbedUrl(DEFAULT_KLETIA_ORIGIN, { clarify: "off" })).clarify, undefined);
});

test("max-height caps the frame (320-4000, default 1600)", () => {
  assert.equal(parseMaxHeight(null), MAX_FRAME_HEIGHT);
  assert.equal(parseMaxHeight("900px"), 900);
  assert.equal(parseMaxHeight("9000"), 4000);
  assert.equal(parseMaxHeight("100"), 320);
  assert.equal(parseMaxHeight("tall"), MAX_FRAME_HEIGHT);
  assert.equal(readElementConfig(attributes({ "max-height": "700" })).maxHeight, 700);
  assert.equal(clampFrameHeight(2400, 700), 700);
  assert.equal(clampFrameHeight(2400), 1600);
});

test("the default origin is the Kletia origin the script was loaded from", () => {
  assert.equal(kletiaOriginFromScript("https://kletia.example/sdk/embed/0.2.0/kletia-embed.min.js"), "https://kletia.example");
  assert.equal(kletiaOriginFromScript("https://kletia.example/sdk/embed/0.2.0/index.js"), "https://kletia.example");
  assert.equal(kletiaOriginFromScript("http://localhost:5174/sdk/embed/0.2.0-rc.1/kletia-embed.min.js?v=1"), "http://localhost:5174");
  for (const other of [
    "https://cdn.jsdelivr.net/npm/@kletia/embed@0.2.0/dist/kletia-embed.min.js",
    "https://kletia.example/sdk/embed/latest/kletia-embed.min.js",
    "https://kletia.example/static/sdk/embed/0.2.0/kletia-embed.min.js",
    "http://evil.example/sdk/embed/0.2.0/kletia-embed.min.js",
    "file:///tmp/sdk/embed/0.2.0/index.js",
    undefined,
  ]) {
    assert.equal(kletiaOriginFromScript(other), null, String(other));
  }
  // Outside a browser (and for scripts loaded from anywhere else) the hosted origin stays the default.
  assert.equal(normalizeKletiaOrigin(""), DEFAULT_KLETIA_ORIGIN);
  assert.equal(normalizeKletiaOrigin("", "https://kletia.example"), "https://kletia.example");
  assert.equal(normalizeKletiaOrigin("https://other.example", "https://kletia.example"), "https://other.example");
});

// ---------------------------------------------------------------------------
// Publishable key and stored flow, questions
// ---------------------------------------------------------------------------

const PUB = `kl_pub_${"Ab3".repeat(10)}xy`;

test("the key and flow attributes travel in the fragment, shape-checked; a secret key never does", () => {
  const url = buildEmbedUrl("https://kletia.example", readElementConfig(attributes({ key: PUB, flow: "deposit-usdc" })).options, HOST);
  assert.equal(new URL(url).hash, `#key=${PUB}&flow=deposit-usdc`);
  assert.equal(new URL(url).searchParams.get("key"), null, "never in the query string");
  assert.equal(embedFragment({ publishableKey: PUB }), `#key=${PUB}`);
  assert.equal(embedFragment({ publishableKey: PUB, flow: "Bad Flow" }), `#key=${PUB}`);
  assert.equal(embedFragment({ flow: "deposit" }), "", "a flow needs the key");
  for (const bad of [`kl_dev_${"a".repeat(32)}`, `kl_agt_${"a".repeat(32)}`, "kl_pub_short", `kl_pub_${"a".repeat(32)}&intent=x`, ` ${PUB}x`]) {
    assert.equal(embedFragment({ publishableKey: bad, flow: "deposit" }), "", bad);
    assert.doesNotMatch(buildEmbedUrl("https://kletia.example", { publishableKey: bad }), /kl_(?:dev|agt)_/u);
  }
  // Integrator-created work wins over the key.
  const session = `cs_${"b".repeat(32)}`;
  assert.equal(embedFragment({ session, publishableKey: PUB, flow: "deposit" }), `#session=${session}`);
  assert.ok(OBSERVED_ATTRIBUTES.includes("key") && OBSERVED_ATTRIBUTES.includes("flow"));
});

test("kletia:question carries a count and reason codes only, never values", () => {
  assert.deepEqual(parseBridgeMessage(event("question", { count: 2, reasons: ["AMOUNT_MISSING", "AMOUNT_MISSING", "NETWORK_AMBIGUOUS"] })), {
    name: "kletia:question",
    detail: { count: 2, reasons: ["AMOUNT_MISSING", "NETWORK_AMBIGUOUS"] },
  });
  const leaky = parseBridgeMessage(event("question", { count: 1, reasons: ["swap 1 SOL", "0xabc", "AMOUNT_MISSING"], text: "swap 1 SOL", amount: "1" }));
  assert.deepEqual(leaky, { name: "kletia:question", detail: { count: 1, reasons: ["AMOUNT_MISSING"] } });
  for (const bad of [{ count: 0, reasons: [] }, { count: 1.5, reasons: [] }, { count: 1 }, { count: "1", reasons: [] }, { count: 99, reasons: [] }]) {
    assert.equal(parseBridgeMessage(event("question", bad)), null, JSON.stringify(bad));
  }
});
