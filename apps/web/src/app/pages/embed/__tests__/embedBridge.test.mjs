// Pure tests for the /embed bridge (protocol v1). Run with Node 22.18 or later,
// which loads the TypeScript sources directly:
//   node --test apps/web/src/app/pages/embed/__tests__/*.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { connectFrame, parseBridgeMessage } from "../../../../../../../packages/embed/src/index.ts";
import {
  acceptConnect,
  createEmbedBridge,
  describeBridgeError,
  isHttpOrigin,
  readBridgeParams,
} from "../embedBridge.ts";

const HOST = "https://shop.example";
const connect = { kletia: "connect", v: 1 };
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

/** A recording port: what the frame posts to the host. */
function recordingPort() {
  const messages = [];
  return { messages, postMessage: (message) => messages.push(structuredClone(message)), close() {} };
}

/** Window facts for a frame whose parent is `parent`. */
function frameContext(overrides = {}) {
  const parent = overrides.parent ?? { name: "parent" };
  return {
    parent,
    self: { name: "frame" },
    ancestorOrigins: [HOST],
    expectedOrigin: HOST,
    connected: false,
    ...overrides,
  };
}

const connectEvent = (context, overrides = {}) => ({
  data: connect,
  origin: HOST,
  source: context.parent,
  ports: [recordingPort()],
  ...overrides,
});

test("a connect from the parent, its proven origin and one port is accepted", () => {
  const context = frameContext();
  const event = connectEvent(context);
  const decision = acceptConnect(event, context);
  assert.equal(decision.ok, true);
  assert.equal(decision.origin, HOST);
  assert.equal(decision.port, event.ports[0]);
});

test("a connect from any window but the parent is rejected", () => {
  const context = frameContext();
  for (const source of [{ name: "sibling ad frame" }, context.self, null, undefined]) {
    assert.deepEqual(acceptConnect(connectEvent(context, { source }), context), { ok: false, reason: "source_not_parent" });
  }
});

test("a page that is not framed never connects", () => {
  const self = { name: "top" };
  const context = frameContext({ parent: self, self });
  assert.deepEqual(acceptConnect(connectEvent(context), context), { ok: false, reason: "not_framed" });
});

test("the opaque null origin and malformed origins are rejected", () => {
  const context = frameContext();
  for (const origin of ["null", "", "file://", "https://shop.example/", "chrome-extension://abc", "HTTPS://SHOP.EXAMPLE"]) {
    assert.deepEqual(acceptConnect(connectEvent(context, { origin }), context), { ok: false, reason: "origin_invalid" }, origin);
  }
  assert.equal(isHttpOrigin("null"), false);
  assert.equal(isHttpOrigin("http://127.0.0.1:4173"), true);
});

test("the origin must match the origin query parameter", () => {
  const context = frameContext({ ancestorOrigins: ["https://evil.example"], expectedOrigin: HOST });
  assert.deepEqual(acceptConnect(connectEvent(context, { origin: "https://evil.example" }), context), {
    ok: false,
    reason: "origin_param_mismatch",
  });
  const missing = frameContext({ expectedOrigin: null });
  assert.deepEqual(acceptConnect(connectEvent(missing), missing), { ok: false, reason: "origin_param_missing" });
});

test("the origin must match location.ancestorOrigins[0] where the browser has it", () => {
  const nested = frameContext({ ancestorOrigins: ["https://other.example", HOST] });
  assert.deepEqual(acceptConnect(connectEvent(nested), nested), { ok: false, reason: "ancestor_mismatch" });
  // A parent iframe with referrerpolicy="no-referrer" masks its origin as "null".
  const masked = frameContext({ ancestorOrigins: ["null"] });
  assert.deepEqual(acceptConnect(connectEvent(masked), masked), { ok: false, reason: "ancestor_mismatch" });
  const empty = frameContext({ ancestorOrigins: [] });
  assert.deepEqual(acceptConnect(connectEvent(empty), empty), { ok: false, reason: "ancestor_mismatch" });
});

test("without ancestorOrigins (Firefox before 148) the parent check and origin parameter decide", () => {
  const context = frameContext({ ancestorOrigins: null });
  assert.equal(acceptConnect(connectEvent(context), context).ok, true);
  assert.deepEqual(acceptConnect(connectEvent(context, { origin: "https://evil.example" }), context), {
    ok: false,
    reason: "origin_param_mismatch",
  });
  const unproven = frameContext({ ancestorOrigins: null, expectedOrigin: null });
  assert.deepEqual(acceptConnect(connectEvent(unproven), unproven), { ok: false, reason: "origin_param_missing" });
});

test("a connect needs exactly one port and the exact message shape", () => {
  const context = frameContext();
  assert.deepEqual(acceptConnect(connectEvent(context, { ports: [] }), context), { ok: false, reason: "port_missing" });
  assert.deepEqual(acceptConnect(connectEvent(context, { ports: [recordingPort(), recordingPort()] }), context), {
    ok: false,
    reason: "port_missing",
  });
  for (const data of [null, "connect", { kletia: "connect" }, { kletia: "connect", v: 2 }, { type: "connect", v: 1 }]) {
    assert.deepEqual(acceptConnect(connectEvent(context, { data }), context), { ok: false, reason: "not_connect" });
  }
});

test("a second connect is ignored", () => {
  const context = frameContext({ connected: true });
  assert.deepEqual(acceptConnect(connectEvent(context), context), { ok: false, reason: "already_connected" });
});

test("bridge parameters require bridge=1 and a canonical http(s) origin", () => {
  assert.deepEqual(readBridgeParams("?bridge=1&origin=https%3A%2F%2Fshop.example&ref=order-42"), {
    enabled: true,
    hostOrigin: HOST,
    reference: "order-42",
  });
  assert.equal(readBridgeParams("?origin=https%3A%2F%2Fshop.example").enabled, false);
  assert.equal(readBridgeParams("?bridge=true&origin=https%3A%2F%2Fshop.example").enabled, false);
  for (const origin of ["null", "https://shop.example/", "javascript:alert(1)", ""]) {
    const params = readBridgeParams(`?bridge=1&origin=${encodeURIComponent(origin)}`);
    assert.equal(params.enabled, false, origin);
    assert.equal(params.hostOrigin, null, origin);
  }
  assert.equal(readBridgeParams("?bridge=1&origin=https%3A%2F%2Fshop.example&ref=a%20b").reference, null);
});

/** A frame with a fake window: the test plays the host by calling `deliver`. */
function frameHarness({ ancestorOrigins = [HOST], expectedOrigin = HOST, reference = null } = {}) {
  const parent = {
    postMessage() {
      assert.fail("the bridge must never post to window.parent");
    },
  };
  const self = { name: "frame" };
  let listener = null;
  const warnings = [];
  const bridge = createEmbedBridge({
    listen(next) {
      listener = next;
      return () => {
        listener = null;
      };
    },
    context: () => ({ parent, self, ancestorOrigins, expectedOrigin }),
    reference,
    warn: (message) => warnings.push(message),
  });
  return {
    bridge,
    parent,
    warnings,
    get listening() {
      return listener !== null;
    },
    deliver(event) {
      listener?.({ data: connect, origin: HOST, source: parent, ports: [recordingPort()], ...event });
    },
  };
}

const intent = (id, statuses, extra = {}) => ({
  id,
  status: "planned",
  request: { accounts: ["solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"] },
  steps: statuses.map((status, index) => ({
    id: `s${index + 1}`,
    index,
    network: "solana",
    status,
    recipient: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
    input: { symbol: "USDC", amount: "25000000", formatted: "25" },
    evidence: [{ reference: "5".repeat(87) }],
  })),
  ...extra,
});

test("nothing is posted before the host connects", () => {
  const frame = frameHarness();
  frame.bridge.start();
  frame.bridge.resize(640);
  frame.bridge.intentCreated(intent("int_early", ["ready"]), true);
  frame.bridge.error(new Error("boom"));
  frame.bridge.setNoticeVisible(true);
  const port = recordingPort();
  frame.deliver({ ports: [port] });
  // The first message is `ready`, carrying only the height measured before the connect.
  assert.deepEqual(port.messages, [{ kletia: "event", v: 1, type: "ready", height: 640 }]);
  assert.equal(frame.bridge.getSnapshot().status, "connected");
  assert.equal(frame.bridge.getSnapshot().origin, HOST);
});

test("ready waits for the first height measurement, and nothing is posted before it", () => {
  const frame = frameHarness();
  frame.bridge.start();
  const port = recordingPort();
  frame.deliver({ ports: [port] });
  assert.equal(frame.bridge.getSnapshot().status, "connected");
  frame.bridge.setNoticeVisible(true);
  frame.bridge.intentCreated(intent("int_too_early", ["ready"]), true);
  frame.bridge.error({ code: "USER_REJECTED" });
  assert.deepEqual(port.messages, []);
  frame.bridge.resize(512.4);
  frame.bridge.resize(513);
  frame.bridge.resize(530);
  assert.deepEqual(port.messages, [
    { kletia: "event", v: 1, type: "ready", height: 513 },
    { kletia: "event", v: 1, type: "resize", height: 530 },
  ]);
});

test("rejected connects leave the bridge waiting and say why", () => {
  const frame = frameHarness({ ancestorOrigins: ["https://other.example"] });
  frame.bridge.start();
  const port = recordingPort();
  frame.deliver({ ports: [port] });
  frame.deliver({ source: { name: "sibling" }, ports: [port] });
  frame.deliver({ data: { hello: "world" }, ports: [port] });
  assert.deepEqual(port.messages, []);
  assert.equal(frame.bridge.getSnapshot().status, "waiting");
  assert.deepEqual(frame.warnings, [
    "Kletia embed: connect ignored (ancestor_mismatch).",
    "Kletia embed: connect ignored (source_not_parent).",
  ]);
  assert.equal(frame.listening, true);
});

test("the second connect is ignored and the first port keeps every message", () => {
  const frame = frameHarness();
  frame.bridge.resize(600);
  frame.bridge.start();
  const first = recordingPort();
  const second = recordingPort();
  frame.deliver({ ports: [first] });
  assert.equal(frame.listening, false, "the bridge stops listening once connected");
  frame.deliver({ ports: [second] });
  frame.bridge.start();
  assert.equal(frame.listening, false, "start() after a connect does not listen again");
  frame.bridge.resize(700);
  assert.deepEqual(second.messages, []);
  assert.deepEqual(first.messages.map((message) => message.type), ["ready", "resize"]);
});

test("connects that arrived before start() are judged by the same rules", () => {
  const frame = frameHarness();
  const sibling = recordingPort();
  const host = recordingPort();
  const retry = recordingPort();
  // As kept by the entry's early listener: an ad frame first, then the host and its retry.
  const early = [
    { data: connect, origin: HOST, source: { name: "ad" }, ports: [sibling] },
    { data: connect, origin: HOST, source: frame.parent, ports: [host] },
    { data: connect, origin: HOST, source: frame.parent, ports: [retry] },
  ];
  frame.bridge.resize(600);
  frame.bridge.start();
  for (const event of early) frame.bridge.offer(event);
  assert.deepEqual(sibling.messages, []);
  assert.deepEqual(host.messages, [{ kletia: "event", v: 1, type: "ready", height: 600 }]);
  assert.deepEqual(retry.messages, []);
  assert.equal(frame.listening, false);
  // The rejected sibling is reported; the host's own retry is not.
  assert.deepEqual(frame.warnings, ["Kletia embed: connect ignored (source_not_parent)."]);
});

test("intent ids are shared only for stored intents and only while the notice is shown", () => {
  const frame = frameHarness({ reference: "order-42" });
  frame.bridge.resize(700);
  frame.bridge.start();
  const port = recordingPort();
  frame.deliver({ ports: [port] });

  // Preview plans (no wallet) never carry an id.
  frame.bridge.intentCreated(intent("int_preview", ["ready"]), false);
  // A stored intent before the notice is on screen is not shared at all.
  frame.bridge.intentCreated(intent("int_hidden", ["ready"]), true);
  frame.bridge.intentUpdated(intent("int_hidden", ["submitted"]));
  frame.bridge.setNoticeVisible(true);
  frame.bridge.intentCreated(intent("int_live", ["ready", "pending"]), true);
  frame.bridge.intentUpdated(intent("int_live", ["awaiting_signature", "pending"]));
  frame.bridge.intentUpdated(intent("int_live", ["awaiting_signature", "pending"]));
  frame.bridge.intentUpdated(intent("int_other", ["submitted", "pending"]));
  frame.bridge.intentCompleted(intent("int_live", ["confirmed", "settled"], { status: "completed" }));
  frame.bridge.resize(812.3);
  frame.bridge.resize(813);

  assert.deepEqual(port.messages.slice(1), [
    { kletia: "event", v: 1, type: "intent.planned", status: "planned", reference: "order-42" },
    { kletia: "event", v: 1, type: "intent.created", intentId: "int_live", status: "planned", reference: "order-42" },
    { kletia: "event", v: 1, type: "intent.step_updated", intentId: "int_live", stepId: "s1", stepIndex: 0, network: "solana", status: "awaiting_signature" },
    { kletia: "event", v: 1, type: "intent.step_updated", intentId: "int_live", stepId: "s1", stepIndex: 0, network: "solana", status: "confirmed" },
    { kletia: "event", v: 1, type: "intent.step_updated", intentId: "int_live", stepId: "s2", stepIndex: 1, network: "solana", status: "settled" },
    { kletia: "event", v: 1, type: "intent.completed", intentId: "int_live", status: "completed" },
    { kletia: "event", v: 1, type: "resize", height: 813 },
  ]);
  const wire = JSON.stringify(port.messages);
  for (const secret of ["7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU", "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", "25000000", "5".repeat(87), "int_hidden", "int_preview"]) {
    assert.equal(wire.includes(secret), false, `the host never receives ${secret}`);
  }

  // Hiding the notice stops id-bearing messages again.
  frame.bridge.setNoticeVisible(false);
  frame.bridge.intentCreated(intent("int_after", ["ready"]), true);
  assert.equal(JSON.stringify(port.messages).includes("int_after"), false);
});

test("errors reach the host as a code and a fixed message, never the raw text", () => {
  const frame = frameHarness();
  frame.bridge.resize(700);
  frame.bridge.start();
  const port = recordingPort();
  frame.deliver({ ports: [port] });
  frame.bridge.error(Object.assign(new Error("Insufficient USDC in 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"), { code: "INTENT_UNSUPPORTED" }));
  frame.bridge.error({ name: "KletiaExecutionError", cause: { code: 4001, message: "User rejected" } });
  frame.bridge.error(new Error("socket hang up at 10.0.0.12"));
  assert.deepEqual(
    port.messages.slice(1).map(({ code }) => code),
    ["INTENT_UNSUPPORTED", "USER_REJECTED", "EMBED_ERROR"],
  );
  const wire = JSON.stringify(port.messages);
  assert.equal(wire.includes("7xKX"), false);
  assert.equal(wire.includes("10.0.0.12"), false);
  assert.deepEqual(describeBridgeError({ code: "not a code" }), {
    code: "EMBED_ERROR",
    message: "The widget could not finish the request. GET /v1/errors describes the code.",
  });
});

test("protocol round trip: @kletia/embed's host connector accepts every frame message", async (t) => {
  const frame = frameHarness({ reference: "order-42" });
  frame.bridge.start();
  frame.bridge.resize(655);
  const received = [];
  const transferred = [];
  const connection = connectFrame({
    target: () => ({
      postMessage(message, targetOrigin, ports) {
        assert.equal(targetOrigin, "https://kletiaai.xyz");
        transferred.push(...ports);
        // The browser delivers the connect with the parent as source and the page's real origin.
        frame.deliver({ data: message, ports });
      },
    }),
    targetOrigin: "https://kletiaai.xyz",
    onEvent: (event) => received.push(event),
    retryDelays: [],
    giveUpAfterMs: 1000,
  });
  t.after(() => {
    connection.close();
    for (const port of transferred) port.close();
  });

  frame.bridge.setNoticeVisible(true);
  frame.bridge.intentCreated(intent("int_preview", ["ready"]), false);
  frame.bridge.intentCreated(intent("int_rt", ["ready"]), true);
  frame.bridge.intentUpdated(intent("int_rt", ["submitted"]));
  frame.bridge.intentCompleted(intent("int_rt", ["confirmed"], { status: "completed" }));
  frame.bridge.error({ code: "USER_REJECTED" });
  frame.bridge.resize(700);
  // MessagePort delivery is asynchronous and slower on a loaded machine (CI): wait for all
  // eight messages instead of a fixed delay, with a deadline that still fails a stuck bridge.
  for (const deadline = Date.now() + 2000; received.length < 8 && Date.now() < deadline; ) await tick(5);

  assert.equal(connection.connected, true);
  assert.deepEqual(received, [
    { name: "kletia:ready", detail: { height: 655 } },
    { name: "kletia:intent-planned", detail: { status: "planned", reference: "order-42" } },
    { name: "kletia:intent-created", detail: { intentId: "int_rt", status: "planned", reference: "order-42" } },
    { name: "kletia:step-updated", detail: { intentId: "int_rt", stepId: "s1", stepIndex: 0, network: "solana", status: "submitted" } },
    { name: "kletia:step-updated", detail: { intentId: "int_rt", stepId: "s1", stepIndex: 0, network: "solana", status: "confirmed" } },
    { name: "kletia:completed", detail: { intentId: "int_rt", status: "completed" } },
    { name: "kletia:error", detail: { code: "USER_REJECTED", message: "The visitor declined the wallet request." } },
    { name: "kletia:resize", detail: { height: 700 } },
  ]);
  // Messages a v1 host does not know are dropped rather than forwarded.
  assert.equal(parseBridgeMessage({ kletia: "event", v: 1, type: "navigate", url: "https://evil.example" }), null);
});
