/**
 * MCP server at /v1/mcp: 2026-07-28 discovery, tool listing and calls,
 * stateless serving of 2025-era clients, the Origin rule, API key → auth
 * info, read-only tools and the CORS policy of the endpoint.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, it } from "node:test";
import { configurePlatform, getIntentStore } from "../../index.js";
import { ACCOUNTS, resetEngine, SOL_ACCOUNT } from "../../engine/__tests__/helpers.js";
import { assertError, call, OPERATOR_KEY, serve, useTestEnvironment, type TestServer } from "./support.js";

useTestEnvironment();
const { buildOpenApiDocument, createPlatformRouter, platformErrorHandler } = await import("../index.js");
const { configureContractEngine } = await import("../contractChecks.js");
const { createCorsMiddleware } = await import("../../../shared/http/cors.js");

const MODERN = "2026-07-28";
const META = {
  "io.modelcontextprotocol/protocolVersion": MODERN,
  "io.modelcontextprotocol/clientInfo": { name: "kletia-tests", version: "1.0.0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

interface RpcReply {
  readonly jsonrpc: "2.0";
  readonly id?: string | number | null;
  readonly result?: Record<string, unknown>;
  readonly error?: { readonly code: number; readonly message: string };
}

interface ToolResult {
  readonly content: { type: string; text: string }[];
  readonly structuredContent: Record<string, unknown>;
  readonly isError?: boolean;
}

let server: TestServer;
let developerKey: string;
let sequence = 0;

/** One modern JSON-RPC request; sent with the developer key (300/min) unless `anonymous` or another key is given. */
async function rpc(method: string, params: Record<string, unknown> = {}, options: { key?: string; anonymous?: boolean; headers?: Record<string, string>; name?: string } = {}) {
  sequence += 1;
  const key = options.anonymous ? undefined : (options.key ?? developerKey);
  return call<RpcReply>(server, "POST", "/mcp", {
    ...(key ? { key } : {}),
    headers: {
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": MODERN,
      "mcp-method": method,
      ...(options.name ? { "mcp-name": options.name } : {}),
      ...(options.headers ?? {}),
    },
    body: { jsonrpc: "2.0", id: sequence, method, params: { ...params, _meta: META } },
  });
}

/** server/discover as a browser on `origin` would send it to a deployment reached as `host`. */
function discoverFrom(origin: string | undefined, host = "api.kletia.test"): Promise<{ status: number; body: string }> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: META } });
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port: server.port,
        path: "/v1/mcp",
        method: "POST",
        headers: {
          host,
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(body)),
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": MODERN,
          "mcp-method": "server/discover",
          authorization: `Bearer ${developerKey}`,
          ...(origin !== undefined ? { origin } : {}),
        },
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          text += chunk;
        });
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body: text }));
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}

async function assertOriginRefused(origin: string, host?: string): Promise<void> {
  const reply = await discoverFrom(origin, host);
  assert.equal(reply.status, 403, `${origin} → ${reply.status} ${reply.body}`);
  assert.equal((JSON.parse(reply.body) as { error: { code: string } }).error.code, "MCP_ORIGIN_FORBIDDEN");
}

async function callTool(name: string, args: Record<string, unknown>, key?: string | null): Promise<ToolResult> {
  const reply = await rpc("tools/call", { name, arguments: args }, { name, ...(key === null ? { anonymous: true } : key ? { key } : {}) });
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  assert.equal(reply.body.error, undefined, JSON.stringify(reply.body.error));
  return reply.body.result as unknown as ToolResult;
}

before(async () => {
  resetEngine();
  server = await serve((app) => {
    app.use(createCorsMiddleware());
    app.use("/v1", createPlatformRouter(), platformErrorHandler);
  });
  const issued = await call<{ key: { key: string } }>(server, "POST", "/keys", { body: { name: "mcp" } });
  developerKey = issued.body.key.key;
});

after(async () => {
  configurePlatform({ adapters: null });
  await server.close();
});

describe("POST /v1/mcp (2026-07-28)", () => {
  it("answers server/discover with Kletia's identity, tools capability and instructions", async () => {
    const reply = await rpc("server/discover");
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.match(reply.headers.get("content-type") ?? "", /application\/json/u);
    assert.ok(reply.headers.get("x-request-id"), "the router's request id survives");
    assert.equal(reply.headers.get("cache-control"), "no-store");
    const result = reply.body.result ?? {};
    assert.deepEqual(result.supportedVersions, [MODERN]);
    assert.ok((result.capabilities as Record<string, unknown>).tools, "tools capability");
    assert.match(String(result.instructions), /create_signing_link/u);
    const meta = result._meta as Record<string, { name?: string }> | undefined;
    assert.equal(meta?.["io.modelcontextprotocol/serverInfo"]?.name, "kletia");
  });

  it("lists read-only tools (plus the two keyed creators), including the signing hand-off", async () => {
    const reply = await rpc("tools/list");
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const tools = (reply.body.result?.tools ?? []) as { name: string; annotations?: Record<string, unknown>; inputSchema: { type: string } }[];
    const names = tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      "check_intent",
      "create_intent",
      "create_link",
      "create_signing_link",
      "get_approval",
      "get_contract",
      "get_intent",
      "get_link",
      "get_policy",
      "get_portfolio",
      "get_quote",
      "get_receipt",
      "list_assets",
      "list_contracts",
      "list_intents",
      "list_links",
      "list_networks",
      "list_protocols",
      "plan_intent",
      "preview_intent",
      "quote_link",
      "test_contract_action",
    ]);
    // create_intent and create_link store an intent or a link for a human to sign (never a transaction).
    const writers = new Set(["create_intent", "create_link"]);
    for (const tool of tools) {
      assert.equal(tool.annotations?.readOnlyHint, !writers.has(tool.name), `${tool.name} readOnlyHint`);
      assert.equal(tool.annotations?.destructiveHint, false, `${tool.name} is not destructive`);
      assert.equal(tool.inputSchema.type, "object");
      assert.doesNotMatch(tool.name, /prepare|submit|sign_tx|send/u);
    }
  });

  it("calls tools against the engine and returns compact structured content", async () => {
    const networks = await callTool("list_networks", { environment: "mainnet" });
    const list = networks.structuredContent.networks as { key: string; environment: string; actions: string[] }[];
    assert.ok(list.length > 0 && list.every((network) => network.environment === "mainnet"));
    assert.ok(list.find((network) => network.key === "solana")?.actions.includes("swap"));
    assert.deepEqual(JSON.parse(networks.content[0]?.text ?? "{}"), networks.structuredContent);

    const quote = await callTool("get_quote", { network: "solana", from: "SOL", to: "USDC", amount: "1" });
    assert.equal((quote.structuredContent.best as { protocol: string }).protocol, "jupiter");
    assert.match(String((quote.structuredContent.best as { minimumOutput: string }).minimumOutput), /USDC$/u);

    const portfolio = await callTool("get_portfolio", { accountId: "not-an-account" });
    assert.equal(portfolio.isError, true);
  });

  it("plans as a dry run only: nothing is stored and no transaction is returned", async () => {
    const before = (await getIntentStore().listActive(500)).length;
    const plan = await callTool("plan_intent", { text: "swap 1 SOL to USDC", accounts: ACCOUNTS });
    assert.equal(plan.isError, undefined, JSON.stringify(plan));
    assert.equal(plan.structuredContent.dryRun, true);
    const steps = plan.structuredContent.steps as { network: string; protocol: string; input: string; account: string }[];
    assert.equal(steps[0]?.protocol, "jupiter");
    assert.equal(steps[0]?.input, "1 SOL");
    assert.deepEqual(plan.structuredContent.externalRecipients, []);
    const text = JSON.stringify(plan);
    for (const forbidden of ["transactions", "quoteBinding", "calldata", "\"data\"", "quoteRef"]) {
      assert.ok(!text.includes(forbidden), `plan output carries no ${forbidden}`);
    }
    assert.equal((await getIntentStore().listActive(500)).length, before);

    const external = await callTool("plan_intent", {
      actions: [{ kind: "transfer", network: "solana", from: "SOL", amount: "0.1", recipient: "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1" }],
      accounts: [SOL_ACCOUNT],
    });
    assert.deepEqual(external.structuredContent.externalRecipients, [`${SOL_ACCOUNT.slice(0, SOL_ACCOUNT.lastIndexOf(":"))}:5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1`]);

    // The planner re-homes the user's EVM address onto the bridge's destination: that is not an external recipient.
    const rehomed = await callTool("plan_intent", { text: "bridge 25 USDC from base to arbitrum", accounts: ACCOUNTS });
    assert.equal(rehomed.isError, undefined, JSON.stringify(rehomed));
    assert.match(String((rehomed.structuredContent.steps as { account?: string; recipient?: string }[])[0]?.recipient), /^eip155:42161:/u);
    assert.deepEqual(rehomed.structuredContent.externalRecipients, []);

    const deposit = await callTool("plan_intent", { text: "deposit 10 USDC into aave on base", accounts: ACCOUNTS });
    assert.equal(deposit.isError, undefined, JSON.stringify(deposit));
    assert.equal((deposit.structuredContent.steps as { venue?: string }[])[0]?.venue, "base:aave-v3:usdc", "agents see the registry venue");
  });

  it("turns platform errors into isError results with the stable code, hints and docs link", async () => {
    const result = await callTool("plan_intent", { text: "make me rich quickly", accounts: ACCOUNTS });
    assert.equal(result.isError, true);
    const error = (result.structuredContent.error ?? {}) as { code: string; hints?: string[]; docs?: string };
    assert.equal(error.code, "INTENT_UNSUPPORTED");
    assert.ok((error.hints?.length ?? 0) > 0);
    assert.equal(error.docs, "https://kletiaai.xyz/developers#error-INTENT_UNSUPPORTED");
    assert.match(result.content[0]?.text ?? "", /^INTENT_UNSUPPORTED: /u);
    const missing = await callTool("get_intent", { intentId: `int_${"0".repeat(32)}` });
    assert.equal((missing.structuredContent.error as { code: string }).code, "INTENT_NOT_FOUND");
  });

  it("validates tool arguments against the declared schema", async () => {
    const reply = await rpc("tools/call", { name: "get_quote", arguments: { network: "solana" } }, { name: "get_quote" });
    assert.equal(reply.status, 200);
    const result = reply.body.result as unknown as ToolResult | undefined;
    assert.ok(reply.body.error || result?.isError, "missing required arguments are refused");
  });

  it("maps the API key to auth info: list_intents needs a key and sees only that key's intents", async () => {
    const anonymous = await callTool("list_intents", {}, null);
    assert.equal((anonymous.structuredContent.error as { code: string }).code, "API_KEY_REQUIRED");
    const created = await call<{ intent: { id: string } }>(server, "POST", "/intents", { key: developerKey, body: { text: "swap 1 SOL to USDC", accounts: ACCOUNTS } });
    assert.equal(created.status, 201);
    const keyed = await callTool("list_intents", {});
    assert.deepEqual((keyed.structuredContent.intents as { id: string }[]).map((intent) => intent.id), [created.body.intent.id]);
    const operator = await callTool("list_intents", {}, OPERATOR_KEY);
    assert.deepEqual(operator.structuredContent.intents, []);
    const read = await callTool("get_intent", { intentId: created.body.intent.id });
    assert.equal(read.structuredContent.id, created.body.intent.id);
  });

  it("hands off with a Studio link and never more", async () => {
    const link = await callTool("create_signing_link", { text: "bridge 25 USDC from base to solana" });
    assert.equal(link.structuredContent.url, "https://kletiaai.xyz/studio?q=bridge+25+USDC+from+base+to+solana");
    assert.match(String(link.structuredContent.instructions), /own connected wallets/u);
    const control = await callTool("create_signing_link", { text: "swap\u0007 1 SOL" });
    assert.equal(control.isError, true);
  });

  it("rejects a mismatched Mcp-Name header and JSON-RPC batches", async () => {
    const mismatch = await rpc("tools/call", { name: "list_networks", arguments: {} }, { name: "get_quote" });
    assert.equal(mismatch.status, 400);
    assert.ok(mismatch.body.error, "header mismatch error");
    const batch = await call<RpcReply>(server, "POST", "/mcp", {
      key: developerKey,
      headers: { accept: "application/json, text/event-stream" },
      body: [{ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: META } }],
    });
    assert.equal(batch.status, 400);
    assert.equal(batch.body.error?.code, -32600);
  });
});

describe("custom contracts over MCP", () => {
  const VAULT = "0x5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a";
  let contractId = "";
  before(async () => {
    configureContractEngine({
      engine: {
        inspectEvmContract: async () => ({
          codeSize: 512,
          eip7702: false,
          pins: { codeHash: `0x${"ab".repeat(32)}`, codeSize: 512, proxy: null, addresses: [], blockNumber: "1", checkedAt: new Date().toISOString() },
          proxyHints: [],
        }),
        testContractAction: async (contract, request) => ({
          contract: contract.id,
          revision: 1,
          entry: request.entry,
          network: "arbitrum-sepolia",
          account: request.account,
          transactions: [{ description: "Approve USDC", to: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d", selector: "0x095ea7b3" }, { description: "Deposit", to: VAULT, selector: "0x6e553f65" }],
          gas: "120000",
          review: {
            kind: "evm-call",
            integrator: { name: "Acme Yield", domainVerified: false },
            notices: ["Not audited by Kletia."],
            call: { label: "Deposit", function: "deposit(uint256 assets, address receiver)", args: [{ name: "assets", type: "uint256", display: "10 USDC", source: "amount" }] },
            approvals: [],
            simulation: { status: "ok", at: new Date().toISOString(), assetChanges: [{ asset: "eip155:421614/erc20:0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d", symbol: "USDC", decimals: 6, listed: true, delta: "-10000000", formatted: "-10" }], warnings: [] },
          },
          warnings: [],
        }),
      },
      checks: {
        sourcify: async () => ({ verification: { status: "exact_match", provider: "sourcify", checkedAt: new Date().toISOString() }, proxy: null, abi: null }),
        risk: async () => null,
      },
    });
    const registered = await call<{ contract: { id: string } }>(server, "POST", "/contracts", {
      key: developerKey,
      body: {
        vm: "evm",
        network: "arbitrum-sepolia",
        address: VAULT,
        integrator: { name: "Acme Yield", website: "https://acme.example" },
        abi: [
          { type: "function", name: "deposit", stateMutability: "nonpayable", inputs: [{ name: "assets", type: "uint256" }, { name: "receiver", type: "address" }], outputs: [] },
          { type: "event", name: "Deposit", inputs: [{ name: "owner", type: "address", indexed: true }, { name: "assets", type: "uint256", indexed: false }] },
        ],
        actions: [
          {
            id: "deposit",
            label: "Deposit into Acme vault",
            function: "deposit(uint256,address)",
            args: ["$amount", "$account"],
            input: { token: "USDC", approval: { spender: "$self" } },
            events: [{ event: "Deposit", emitter: "$self", where: { owner: "$account", assets: "$amount" } }],
            phrases: { verbs: ["deposit"], aliases: ["acme vault"] },
          },
        ],
      },
    });
    assert.equal(registered.status, 201, JSON.stringify(registered.body));
    contractId = registered.body.contract.id;
  });
  after(() => configureContractEngine({ engine: null, checks: null }));

  it("lists and reads the key's registrations compactly (no ABI, no pins beyond code hashes)", async () => {
    const anonymous = await callTool("list_contracts", {}, null);
    assert.equal((anonymous.structuredContent.error as { code: string }).code, "API_KEY_REQUIRED");
    const listed = await callTool("list_contracts", {});
    const entries = listed.structuredContent.contracts as { id: string; status: string; codeHash: string; entries: { id: string; aliases: string[] }[] }[];
    assert.deepEqual(entries.map((entry) => entry.id), [contractId]);
    assert.equal(entries[0]?.status, "active");
    assert.deepEqual(entries[0]?.entries[0]?.aliases, ["acme vault"]);
    assert.equal(entries[0]?.codeHash, `0x${"ab".repeat(32)}`);
    const text = JSON.stringify(listed);
    for (const forbidden of ["\"abi\"", "stateMutability", "blockNumber", "\"args\""]) assert.ok(!text.includes(forbidden), `no ${forbidden}`);
    const other = await call<{ key: { key: string } }>(server, "POST", "/keys", { body: { name: "mcp-other" } });
    const foreign = await callTool("get_contract", { contractId }, other.body.key.key);
    assert.equal((foreign.structuredContent.error as { code: string }).code, "CONTRACT_NOT_FOUND");
    const own = await callTool("get_contract", { contractId });
    assert.equal(own.structuredContent.id, contractId);
    assert.equal((await callTool("list_contracts", {}, other.body.key.key)).structuredContent.contracts instanceof Array, true);
  });

  it("test-simulates an entry without returning calldata", async () => {
    const result = await callTool("test_contract_action", { contractId, entry: "deposit", account: `eip155:421614:${VAULT.replace("5a", "6b")}`, amount: "10" });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    assert.equal(result.structuredContent.entry, "deposit");
    const review = result.structuredContent.review as { notices: string[]; simulation: { assetChanges: string[] } };
    assert.deepEqual(review.simulation.assetChanges, ["-10 USDC"]);
    assert.match(review.notices[0] ?? "", /Not audited/u);
    assert.ok(!JSON.stringify(result).includes("\"data\""), "no calldata");
    const anonymous = await callTool("test_contract_action", { contractId, entry: "deposit", account: `eip155:421614:${VAULT}` }, null);
    assert.equal((anonymous.structuredContent.error as { code: string }).code, "API_KEY_REQUIRED");
  });

  it("refuses signing links for intents that name a registered contract", async () => {
    const byAlias = await callTool("create_signing_link", { text: "deposit 10 USDC into acme vault on arbitrum sepolia" });
    assert.equal((byAlias.structuredContent.error as { code: string }).code, "CONTRACT_HANDOFF_UNSUPPORTED");
    const byId = await callTool("create_signing_link", { text: `deposit 10 USDC into ${contractId}` }, null);
    assert.equal((byId.structuredContent.error as { code: string }).code, "CONTRACT_HANDOFF_UNSUPPORTED");
    const plain = await callTool("create_signing_link", { text: "deposit 10 USDC into aave on base" });
    assert.equal(plain.isError, undefined);
  });
});

describe("POST /v1/mcp error contract", () => {
  interface Documented {
    readonly $ref?: string;
    readonly content?: Record<string, { schema: { $ref?: string; oneOf?: { $ref: string }[] } }>;
  }
  const document = buildOpenApiDocument() as unknown as {
    paths: Record<string, Record<string, { responses: Record<string, Documented> }>>;
    components: { responses: Record<string, Documented> };
  };

  /** Component schema names the document allows for a status's JSON body on POST /v1/mcp. */
  function documentedSchemas(status: number): string[] {
    let response = document.paths["/v1/mcp"]?.post?.responses[String(status)];
    if (response?.$ref) response = document.components.responses[response.$ref.split("/").pop() ?? ""];
    const schema = response?.content?.["application/json"]?.schema;
    if (!schema) return [];
    return (schema.oneOf ?? [schema]).map((entry) => (entry.$ref ?? "").split("/").pop() ?? "");
  }

  it("documents the status and body shape of every error it answers, JSON-RPC errors included", async () => {
    const legacyInit = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "x", version: "1" } } };
    const replies = {
      batch: await call(server, "POST", "/mcp", { key: developerKey, headers: { accept: "application/json, text/event-stream" }, body: [legacyInit] }),
      "invalid message": await call(server, "POST", "/mcp", { key: developerKey, headers: { accept: "application/json, text/event-stream" }, body: { jsonrpc: "2.0", id: { a: 1 }, method: "tools/list" } }),
      "not JSON": await call(server, "POST", "/mcp", { key: developerKey, headers: { "content-type": "application/json" }, raw: "{nope" }),
      "unknown method": await rpc("tools/unknown"),
      "Accept without event streams": await call(server, "POST", "/mcp", { key: developerKey, headers: { accept: "text/html" }, body: legacyInit }),
    };
    const statuses: Record<string, number> = {};
    for (const [label, reply] of Object.entries(replies)) {
      statuses[label] = reply.status;
      const body = reply.body as { jsonrpc?: string; id?: unknown; error?: { code?: unknown }; requestId?: unknown };
      const shape = body.jsonrpc === "2.0" ? "JsonRpcErrorResponse" : "Error";
      if (shape === "JsonRpcErrorResponse") {
        assert.ok(Number.isInteger(body.error?.code) && "id" in body, `${label}: a JSON-RPC error body`);
      } else {
        assert.ok(typeof body.error?.code === "string" && typeof body.requestId === "string", `${label}: a platform error body`);
      }
      assert.ok(documentedSchemas(reply.status).includes(shape), `${label}: ${reply.status} with a ${shape} body is documented (${documentedSchemas(reply.status).join(", ") || "status not documented"})`);
    }
    assert.deepEqual(statuses, { batch: 400, "invalid message": 400, "not JSON": 400, "unknown method": 404, "Accept without event streams": 406 });
  });
});

describe("POST /v1/mcp (2025-era clients)", () => {
  it("serves initialize and tools/call statelessly", async () => {
    const headers = { accept: "application/json, text/event-stream", authorization: `Bearer ${developerKey}` };
    const init = await call<string>(server, "POST", "/mcp", {
      headers,
      body: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "legacy", version: "1" } } },
    });
    assert.equal(init.status, 200);
    const initText = typeof init.body === "string" ? init.body : JSON.stringify(init.body);
    assert.match(initText, /"protocolVersion":"2025-11-25"/u);
    assert.equal(init.headers.get("mcp-session-id"), null, "stateless: no session");
    const tool = await call<string>(server, "POST", "/mcp", {
      headers: { ...headers, "mcp-protocol-version": "2025-11-25" },
      body: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_protocols", arguments: { network: "solana" } } },
    });
    assert.equal(tool.status, 200);
    const toolText = typeof tool.body === "string" ? tool.body : JSON.stringify(tool.body);
    assert.match(toolText, /jupiter/u);
  });

  it("answers GET and DELETE with 405 (no server-initiated stream, no sessions)", async () => {
    assertError(await call(server, "GET", "/mcp"), 405, "METHOD_NOT_ALLOWED");
    assertError(await call(server, "DELETE", "/mcp"), 405, "METHOD_NOT_ALLOWED");
  });
});

describe("/v1/mcp Origin rule and CORS", () => {
  it("accepts no Origin and HTTPS origins, refuses null, malformed and remote plain-HTTP origins", async () => {
    assert.equal((await discoverFrom(undefined)).status, 200);
    assert.equal((await discoverFrom("https://agent.example")).status, 200);
    assert.equal((await discoverFrom("http://localhost:5174")).status, 200, "localhost in development");
    for (const origin of ["null", "http://evil.example", "https://user:pw@evil.example", "not an origin", "https://evil.example/path", "ftp://evil.example"]) {
      await assertOriginRefused(origin);
    }
  });

  it("narrows to KLETIA_MCP_ALLOWED_ORIGINS when set", async () => {
    process.env.KLETIA_MCP_ALLOWED_ORIGINS = "https://claude.ai, https://app.example";
    try {
      assert.equal((await discoverFrom("https://app.example")).status, 200);
      await assertOriginRefused("https://agent.example");
      assert.equal((await discoverFrom(undefined)).status, 200, "server-side agents send no Origin");
    } finally {
      delete process.env.KLETIA_MCP_ALLOWED_ORIGINS;
    }
  });

  it("only accepts local origins on a loopback host (self-hosted local server)", async () => {
    await assertOriginRefused("https://agent.example", `127.0.0.1:${server.port}`);
    await assertOriginRefused("https://agent.example", `localhost:${server.port}`);
    assert.equal((await discoverFrom("http://127.0.0.1:5174", `127.0.0.1:${server.port}`)).status, 200);
    assert.equal((await rpc("server/discover")).status, 200, "local agents without an Origin");
  });

  it("reflects MCP request headers on preflight and allows Idempotency-Key elsewhere on /v1", async () => {
    const preflight = await fetch(`${server.base}/mcp`, {
      method: "OPTIONS",
      headers: { origin: "https://agent.example", "access-control-request-method": "POST", "access-control-request-headers": "content-type,mcp-protocol-version,mcp-method,mcp-name,mcp-param-region" },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
    assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /mcp-param-region/u);
    const platform = await fetch(`${server.base}/intents`, {
      method: "OPTIONS",
      headers: { origin: "https://shop.example", "access-control-request-method": "POST", "access-control-request-headers": "idempotency-key" },
    });
    assert.match(platform.headers.get("access-control-allow-headers") ?? "", /Idempotency-Key/u);
    assert.doesNotMatch(platform.headers.get("access-control-allow-headers") ?? "", /mcp-param/u);
  });

  it("keeps the /v1 guards: rate limits, bad keys and body limits apply", async () => {
    assertError(await rpc("server/discover", {}, { key: `kl_dev_${"Z".repeat(32)}` }), 401, "INVALID_API_KEY");
    const big = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "plan_intent", arguments: { text: "x".repeat(70 * 1024) } } });
    assertError(await call(server, "POST", "/mcp", { key: developerKey, raw: big, headers: { "content-type": "application/json" } }), 413, "PAYLOAD_TOO_LARGE");
  });
});
