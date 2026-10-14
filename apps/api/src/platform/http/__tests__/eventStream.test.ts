/**
 * GET /v1/events (integrator design 4.6, P9c): the key's events as
 * Server-Sent Events, routed like its webhooks. A `contract.registered`
 * (a real registration through POST /v1/contracts, checks stubbed) and a
 * `link.created` event reach the owner's stream as webhook envelopes;
 * `scope=subtree` adds a child agent key's events and `self` does not;
 * another key's events never arrive; `types` filters; Last-Event-ID
 * replays from the buffer; 2 streams per key; an expired key's stream ends
 * at the next heartbeat. Nothing touches the network.
 *
 *   cd apps/api && node --import tsx --test src/platform/http/__tests__/eventStream.test.ts
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import type { EvmContractPins } from "@kletia/core";
import { resetEngine } from "../../engine/__tests__/helpers.js";
import { assertError, call, serve, useTestEnvironment, waitFor, type TestServer } from "./support.js";

useTestEnvironment();
const { createPlatformRouter, platformErrorHandler } = await import("../index.js");
const { configureContractEngine } = await import("../contractChecks.js");
const { contractWriteLimiter } = await import("../limits.js");
const { apiKeyStore, issueAgentKey, issueDeveloperKey } = await import("../auth.js");
const { publishLinkEvent } = await import("../links/events.js");
const { EVENT_STREAMS_PER_KEY, openKeyStreamCount, resetEventStreamBuffer } = await import("../eventStream.js");

const HEARTBEAT_MS = 100;

interface Frame {
  readonly id: string;
  readonly event: string;
  readonly data: { readonly id: string; readonly type: string; readonly at: string; readonly data: Record<string, unknown> };
}

interface Stream {
  readonly status: number;
  readonly frames: Frame[];
  readonly text: () => string;
  readonly ended: () => boolean;
  close(): void;
}

let server: TestServer;
const open: Stream[] = [];

/** Opens GET /v1/events and parses frames as they arrive. */
async function stream(key: string, query = "", headers: Record<string, string> = {}): Promise<Stream> {
  const controller = new AbortController();
  const response = await fetch(`${server.base}/events${query}`, { headers: { authorization: `Bearer ${key}`, ...headers }, signal: controller.signal });
  const frames: Frame[] = [];
  let raw = "";
  let text = "";
  let ended = false;
  if (response.ok && response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          raw += decoder.decode(value, { stream: true });
          const blocks = raw.split("\n\n");
          raw = blocks.pop() ?? "";
          for (const block of blocks) {
            const fields = Object.fromEntries(block.split("\n").filter((line) => !line.startsWith(":") && line.includes(": ")).map((line) => [line.slice(0, line.indexOf(": ")), line.slice(line.indexOf(": ") + 2)]));
            if (fields.id && fields.event && fields.data) frames.push({ id: fields.id, event: fields.event, data: JSON.parse(fields.data) as Frame["data"] });
            text += `${block}\n\n`;
          }
        }
      } catch {
        // Aborted.
      } finally {
        ended = true;
      }
    })();
  } else {
    ended = true;
  }
  const handle: Stream = {
    status: response.status,
    frames,
    text: () => text,
    ended: () => ended,
    close: () => controller.abort(),
  };
  if (!response.ok) await response.body?.cancel().catch(() => undefined);
  open.push(handle);
  return handle;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

async function developer(name: string): Promise<{ id: string; key: string }> {
  const issued = await issueDeveloperKey(name);
  return { id: issued.id, key: issued.key };
}

async function agentOf(parentId: string): Promise<{ id: string; key: string }> {
  const parent = await apiKeyStore().findById(parentId);
  assert.ok(parent);
  const child = await issueAgentKey("stream-agent", parent, new Date(Date.now() + 3_600_000).toISOString(), 100);
  return { id: child.id, key: child.key };
}

function linkCreated(ownerKeyId: string): string {
  return publishLinkEvent("link.created", { linkId: `lk_${randomBytes(12).toString("hex")}`, ownerKeyId, revision: 1 }).id;
}

/** Contract checks and reads, stubbed: a registration needs no network. */
function installContractStubs(): void {
  const pins = (): EvmContractPins => ({ codeHash: `0x${"11".repeat(32)}`, codeSize: 2_048, proxy: null, addresses: [], blockNumber: "1000", checkedAt: new Date().toISOString() });
  configureContractEngine({
    engine: {
      inspectEvmContract: async () => ({ codeSize: 2_048, eip7702: false, pins: pins(), proxyHints: [] }),
      readSolanaProgramPins: async () => [],
      fetchSolanaActionMetadata: async (_transport, href) => ({ url: href, title: "Action", label: "Action", disabled: false, fetchedAt: new Date().toISOString() }),
      testContractAction: async () => {
        throw new Error("not used");
      },
      simulationCapability: async () => ({ base: "ok" }),
    },
    checks: {
      sourcify: async () => ({ verification: { status: "exact_match", provider: "sourcify", checkedAt: new Date().toISOString() }, proxy: null, abi: null }),
      ottersec: async (program) => ({ program, verified: null, provider: "ottersec", checkedAt: new Date().toISOString() }),
      domain: async () => false,
      risk: async () => null,
      actionOrigin: async () => undefined,
    },
  });
}

const DEFINITION = () => ({
  vm: "evm",
  network: "base",
  address: `0x${randomBytes(20).toString("hex")}`,
  integrator: { name: "Acme Yield", website: "https://acme.example" },
  abi: [
    { type: "function", name: "deposit", stateMutability: "nonpayable", inputs: [{ name: "assets", type: "uint256" }, { name: "receiver", type: "address" }], outputs: [{ name: "shares", type: "uint256" }] },
    {
      type: "event",
      name: "Deposit",
      anonymous: false,
      inputs: [
        { name: "sender", type: "address", indexed: true },
        { name: "owner", type: "address", indexed: true },
        { name: "assets", type: "uint256", indexed: false },
        { name: "shares", type: "uint256", indexed: false },
      ],
    },
  ],
  actions: [
    {
      id: "deposit",
      label: "Deposit into Acme USDC vault",
      function: "deposit(uint256,address)",
      args: ["$amount", "$account"],
      input: { token: "USDC", approval: { spender: "$self" } },
      output: { token: "$self", toleranceBps: 10 },
      events: [{ event: "Deposit", emitter: "$self", where: { owner: "$account", assets: "$amount" }, output: "shares" }],
      limits: { maxAmount: "25000" },
    },
  ],
});

before(async () => {
  resetEngine();
  installContractStubs();
  server = await serve((app) => {
    app.use("/v1", createPlatformRouter({ stream: { heartbeatMs: HEARTBEAT_MS } }), platformErrorHandler);
  });
});

after(async () => {
  configureContractEngine({ engine: null, checks: null });
  await server.close();
});

beforeEach(() => {
  contractWriteLimiter.reset();
  resetEventStreamBuffer();
});

afterEach(async () => {
  for (const handle of open.splice(0)) handle.close();
  await waitFor(() => openKeyStreamCount() === 0, 2_000, "streams released");
});

describe("GET /v1/events", () => {
  it("requires an API key and validates scope and types", async () => {
    assertError(await call(server, "GET", "/events"), 401, "API_KEY_REQUIRED");
    const owner = await developer("stream-validate");
    assertError(await call(server, "GET", "/events?scope=everyone", { key: owner.key }), 400, "INVALID_REQUEST");
    assertError(await call(server, "GET", "/events?types=link.created,nope.unknown", { key: owner.key }), 400, "INVALID_REQUEST");
  });

  it("streams the key's contract.registered and link.created events as webhook envelopes, and nobody else's", async () => {
    const owner = await developer("stream-owner");
    const stranger = await developer("stream-stranger");
    const mine = await stream(owner.key);
    assert.equal(mine.status, 200);
    await waitFor(() => mine.text().startsWith("retry: 3000"), 2_000, "retry line");
    const registered = await call<{ contract: { id: string } }>(server, "POST", "/contracts", { key: owner.key, body: DEFINITION() });
    assert.equal(registered.status, 201, JSON.stringify(registered.body));
    const linkId = linkCreated(owner.id);
    linkCreated(stranger.id);
    await waitFor(() => mine.frames.some((frame) => frame.event === "link.created"), 3_000, "link.created");
    await waitFor(() => mine.frames.some((frame) => frame.event === "contract.registered"), 3_000, "contract.registered");
    const contract = mine.frames.find((frame) => frame.event === "contract.registered") as Frame;
    assert.equal(contract.id, contract.data.id, "frame id is the envelope id");
    assert.equal(contract.data.type, "contract.registered");
    assert.ok(Date.parse(contract.data.at) > 0);
    assert.equal(contract.data.data.contractId, registered.body.contract.id);
    assert.equal(contract.data.data.ownerKeyId, owner.id);
    assert.deepEqual(Object.keys(contract.data).sort(), ["at", "data", "id", "type"]);
    const link = mine.frames.find((frame) => frame.event === "link.created") as Frame;
    assert.equal(link.id, linkId);
    await settle();
    assert.equal(mine.frames.filter((frame) => frame.event === "link.created").length, 1, "the stranger's link never arrives");
  });

  it("scope=subtree adds a child agent key's events; scope=self does not", async () => {
    const owner = await developer("stream-parent");
    const agent = await agentOf(owner.id);
    const self = await stream(owner.key);
    const subtree = await stream(owner.key, "?scope=subtree");
    const agentStream = await stream(agent.key);
    await waitFor(() => subtree.text().startsWith("retry:") && self.text().startsWith("retry:") && agentStream.text().startsWith("retry:"), 2_000, "streams open");
    const agentLink = linkCreated(agent.id);
    await waitFor(() => subtree.frames.some((frame) => frame.id === agentLink), 3_000, "subtree receives the agent's event");
    await waitFor(() => agentStream.frames.some((frame) => frame.id === agentLink), 3_000, "the agent's own stream receives it");
    await settle();
    assert.equal(self.frames.some((frame) => frame.id === agentLink), false, "self scope excludes descendants");
  });

  it("filters by types and replays after Last-Event-ID", async () => {
    const owner = await developer("stream-types");
    const first = linkCreated(owner.id);
    const second = publishLinkEvent("link.paused", { linkId: `lk_${randomBytes(12).toString("hex")}`, ownerKeyId: owner.id, revision: 2 }).id;
    const resumed = await stream(owner.key, "", { "last-event-id": first });
    await waitFor(() => resumed.frames.some((frame) => frame.id === second), 3_000, "replayed event");
    assert.equal(resumed.frames.some((frame) => frame.id === first), false, "only events after the id");
    resumed.close();
    const filtered = await stream(owner.key, "?types=link.paused");
    await waitFor(() => filtered.text().startsWith("retry:"), 2_000, "open");
    linkCreated(owner.id);
    const paused = publishLinkEvent("link.paused", { linkId: `lk_${randomBytes(12).toString("hex")}`, ownerKeyId: owner.id, revision: 3 }).id;
    await waitFor(() => filtered.frames.some((frame) => frame.id === paused), 3_000, "link.paused");
    await settle();
    assert.deepEqual(filtered.frames.map((frame) => frame.event), ["link.paused"]);
    assertError(await call(server, "GET", "/events?since=nope", { key: owner.key }), 400, "INVALID_REQUEST");
  });

  it(`allows ${EVENT_STREAMS_PER_KEY} streams per key, then 429 TOO_MANY_STREAMS`, async () => {
    const owner = await developer("stream-cap");
    for (let index = 0; index < EVENT_STREAMS_PER_KEY; index += 1) assert.equal((await stream(owner.key)).status, 200);
    const third = await call(server, "GET", "/events", { key: owner.key });
    assertError(third, 429, "TOO_MANY_STREAMS");
    assert.equal(third.headers.get("retry-after"), "30");
    const other = await developer("stream-cap-other");
    assert.equal((await stream(other.key)).status, 200, "another key has its own slots");
  });

  it("ends the stream at the next heartbeat once the key expired", async () => {
    const owner = await developer("stream-expiry");
    const record = await apiKeyStore().findById(owner.id);
    assert.ok(record);
    const handle = await stream(owner.key);
    await waitFor(() => handle.text().includes(": heartbeat"), 2_000, "a heartbeat");
    await apiKeyStore().setExpiry(owner.id, record.projectId, new Date(Date.now() - 1_000).toISOString());
    await waitFor(() => handle.ended(), 3_000, "stream ended");
    assert.match(handle.text(), /the API key is no longer valid/u);
  });
});
