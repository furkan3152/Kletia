/**
 * Step-up on every state-changing admin route: a session cookie alone can
 * only read. Each write needs a fresh (5 min, single-use) confirmation signed
 * by the session's own wallet over the method, path and body; logout is the
 * only exception. Refusals are audited.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { ADMIN_CONFIRM_ACTIONS, type AdminConfirmAction } from "@kletia/core";
import type { Router } from "express";
import { getAddress } from "viem";
import { createAdminRouter, STEP_UP_ACTION } from "../http/router.js";
import { call, confirmationFor, evmWallet, signInEvm, signInSolana, solanaWallet, startHarness, type Harness } from "./helpers.js";

let open: Harness[] = [];
async function harness(env: NodeJS.ProcessEnv): Promise<Harness> {
  const started = await startHarness({ env });
  open.push(started);
  return started;
}
afterEach(async () => {
  await Promise.all(open.map((entry) => entry.close()));
  open = [];
});

const SFP = `sfp_${"0".repeat(24)}`;
const DEP = `dep_${"0".repeat(24)}`;
const TX = `0x${"ab".repeat(32)}`;

/** One request per route class; each would change state if the step-up let it through. */
const WRITES: readonly { action: AdminConfirmAction; method: string; path: string; body: Record<string, unknown> }[] = [
  { action: "deployment.record", method: "POST", path: "/deployments", body: { targetId: "arbitrum:launch-factory-v2", txHash: TX, constructorArgs: {}, import: true } },
  { action: "deployment.reverify", method: "POST", path: `/deployments/${DEP}/reverify`, body: {} },
  { action: "action.verify", method: "POST", path: "/actions/verify", body: { network: "base", txHash: TX, contract: "0x39Eb74cB023e18c3e9C80ca46888a7Da22bFED7B", actionId: null } },
  { action: "safe.propose", method: "POST", path: "/safe-proposals", body: { network: "base", safe: "0x84f19Fdfd8C50C6349BFe86Cd90BE131387ab47D", to: "0xf9BaA05c71c2078A43f6831Eca88220b42932413", value: "0", data: "0x", description: "x" } },
  { action: "safe.sign", method: "POST", path: `/safe-proposals/${SFP}/signatures`, body: { signature: "0x00" } },
  { action: "safe.executed", method: "POST", path: `/safe-proposals/${SFP}/executed`, body: { txHash: TX } },
  { action: "safe.cancel", method: "POST", path: `/safe-proposals/${SFP}/cancel`, body: {} },
  { action: "fees.rescan", method: "POST", path: "/fees/rescan", body: { key: "base:0x0000000000000000000000000000000000000000" } },
  { action: "render.deploy", method: "POST", path: "/services/api/deploy", body: { clearCache: false } },
];

/** Non-GET routes that need no step-up: sign-in (no session yet) and logout (only ends sessions). */
const EXEMPT = new Set(["POST /auth/nonce", "POST /auth/verify", "POST /auth/logout", "POST /auth/logout-all"]);
/** Routes that verify their own action-specific confirmation inside the handler (unchanged payload format). */
const OWN_CONFIRMATION = new Set(["PATCH /deployments/:id", "PUT /network-profiles/:network"]);

describe("step-up coverage", () => {
  it("every state-changing route except sign-in and logout carries a step-up gate", () => {
    const router = createAdminRouter() as Router & { stack: { route?: { path: string; methods: Record<string, boolean>; stack: { handle: unknown }[] } }[] };
    const seen = new Set<string>();
    for (const layer of router.stack) {
      const route = layer.route;
      if (!route) continue;
      for (const method of Object.keys(route.methods).filter((name) => route.methods[name] && name !== "get" && name !== "head")) {
        const key = `${method.toUpperCase()} ${route.path}`;
        seen.add(key);
        if (EXEMPT.has(key) || OWN_CONFIRMATION.has(key)) continue;
        const gate = route.stack.find((entry) => typeof entry.handle === "function" && STEP_UP_ACTION in (entry.handle as object));
        assert.ok(gate, `${key} has no step-up`);
        assert.ok((ADMIN_CONFIRM_ACTIONS as readonly string[]).includes((gate.handle as unknown as Record<symbol, string>)[STEP_UP_ACTION] as string), key);
      }
    }
    for (const write of WRITES) {
      const pattern = [...seen].find((key) => new RegExp(`^${key.replace(/:[a-z]+/gu, "[^/]+")}$`, "u").test(`${write.method} ${write.path}`));
      assert.ok(pattern, `${write.method} ${write.path} is a route`);
    }
  });
});

describe("step-up on writes", () => {
  it("refuses every write class with a cookie alone, audits it, and changes nothing", async () => {
    const account = evmWallet();
    const h = await harness({ KLETIA_ADMIN_ADDRESSES: account.address, RENDER_API_KEY: "rnd_sentinel_key_value" });
    h.env = { RENDER_API_KEY: "rnd_sentinel_key_value" };
    const { cookie } = await signInEvm(h, account);
    for (const write of WRITES) {
      const reply = await call(h, write.method, write.path, { cookie, body: write.body });
      assert.equal(reply.status, 403, `${write.path} ${JSON.stringify(reply.body)}`);
      assert.equal(reply.body.error.code, "ADMIN_CONFIRMATION_REQUIRED", write.path);
      const forged = await call(h, write.method, write.path, { cookie, body: { ...write.body, confirmation: { message: "Nonce: AAAAAAAAAAAAAAAAAAAAAAAA", signature: "0x00" } } });
      assert.equal(forged.status, 403, write.path);
    }
    const denied = (await h.store.listAudit(100, null)).filter((row) => row.outcome === "denied");
    for (const write of WRITES) {
      const rows = denied.filter((row) => row.action === write.action);
      assert.equal(rows.length, 2, write.action);
      assert.deepEqual(rows[0]?.target, { route: `${write.method} ${write.path}`, reason: "confirmation" });
      assert.equal(rows[0]?.address, getAddress(account.address));
    }
    assert.equal(h.fetchCalls.length, 0, "no Render call");
    assert.equal((await h.store.listDeployments({})).length, 0);
    assert.equal((await h.store.listProposals({})).length, 0);
  });

  it("passes a correct confirmation through to the route (which then answers on its own)", async () => {
    const account = evmWallet();
    const h = await harness({ KLETIA_ADMIN_ADDRESSES: account.address });
    const { cookie } = await signInEvm(h, account);
    for (const write of WRITES.filter((entry) => entry.path.includes(SFP) || entry.path.includes(DEP))) {
      const reply = await call(h, write.method, write.path, { cookie, confirm: { signer: account, action: write.action }, body: write.body });
      assert.equal(reply.status, 404, `${write.path}: past the step-up, the record does not exist`);
      assert.equal(reply.body.error.code, "ADMIN_NOT_FOUND");
    }
  });

  it("binds the confirmation to the action, path, body, wallet, a single use and five minutes", async () => {
    const account = evmWallet();
    const h = await harness({ KLETIA_ADMIN_ADDRESSES: account.address });
    const { cookie } = await signInEvm(h, account);
    const path = `/safe-proposals/${SFP}/cancel`;
    const refused = async (confirmation: unknown, target = path) => {
      const reply = await call(h, "POST", target, { cookie, body: { confirmation } });
      assert.equal(reply.status, 403, JSON.stringify(reply.body));
      assert.equal(reply.body.error.code, "ADMIN_CONFIRMATION_REQUIRED");
    };
    // Another action name for the same request.
    await refused(await confirmationFor(h, cookie, account, "safe.sign", "POST", path, {}));
    // Another path (a different proposal).
    await refused(await confirmationFor(h, cookie, account, "safe.cancel", "POST", `/safe-proposals/sfp_${"1".repeat(24)}/cancel`, {}));
    // Another body.
    const otherBody = await confirmationFor(h, cookie, account, "fees.rescan", "POST", "/fees/rescan", { key: "a" });
    const bodyReply = await call(h, "POST", "/fees/rescan", { cookie, body: { key: "b", confirmation: otherBody } });
    assert.equal(bodyReply.status, 403);
    // Signed by another key than the session's wallet.
    const good = await confirmationFor(h, cookie, account, "safe.cancel", "POST", path, {});
    await refused({ message: good.message, signature: await evmWallet().signMessage({ message: good.message }) });
    // Single use: the nonce above was consumed by the refused attempt.
    await refused(good);
    // Expired after five minutes.
    const late = await confirmationFor(h, cookie, account, "safe.cancel", "POST", path, {});
    h.now = new Date(h.now.getTime() + 5 * 60 * 1000 + 1000);
    await refused(late);
  });

  it("accepts a Solana session's own ed25519 confirmation and refuses an EVM one", async () => {
    const wallet = solanaWallet();
    const evm = evmWallet();
    const h = await harness({ KLETIA_ADMIN_SOLANA_ADDRESSES: wallet.address, KLETIA_ADMIN_ADDRESSES: evm.address });
    const { cookie } = await signInSolana(h, wallet);
    const path = `/safe-proposals/${SFP}/cancel`;
    const evmNonce = await call(h, "POST", "/auth/nonce", { cookie, body: { address: evm.address, purpose: "confirm", action: "safe.cancel", payloadSha256: "0".repeat(64) } });
    assert.equal(evmNonce.status, 400, "a confirmation must be signed by the signed-in wallet");
    const ok = await call(h, "POST", path, { cookie, confirm: { signer: wallet, action: "safe.cancel" } });
    assert.equal(ok.status, 404, JSON.stringify(ok.body));
  });

  it("keeps logout and reads cookie-only", async () => {
    const account = evmWallet();
    const h = await harness({ KLETIA_ADMIN_ADDRESSES: account.address });
    const { cookie } = await signInEvm(h, account);
    for (const path of ["/overview", "/deployments", "/safe-proposals", "/audit", "/network-profiles"]) {
      assert.equal((await call(h, "GET", path, { cookie })).status, 200, path);
    }
    assert.equal((await call(h, "POST", "/auth/logout-all", { cookie })).status, 204);
    const again = await signInEvm(h, account);
    assert.equal((await call(h, "POST", "/auth/logout", { cookie: again.cookie })).status, 204);
  });
});
