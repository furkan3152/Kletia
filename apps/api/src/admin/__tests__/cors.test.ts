/**
 * Browser access to /api/admin: PATCH and X-Kletia-Admin pass the preflight
 * only for allowlisted origins, with credentials; the rest of /api keeps its
 * policy (no PATCH, no admin header).
 */
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import express from "express";
import { createCorsMiddleware } from "../../shared/http/cors.js";

let server: Server;
let base: string;

before(async () => {
  const app = express();
  app.use(createCorsMiddleware());
  app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(403).json({ error: error.message });
  });
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const list = (value: string | null) => (value ?? "").split(",").map((entry) => entry.trim().toLowerCase());

describe("admin CORS", () => {
  it("allows PATCH and X-Kletia-Admin with credentials for allowlisted origins", async () => {
    for (const path of ["/api/admin/deployments/dep_0123", "/API/admin/auth/nonce"]) {
      const preflight = await fetch(`${base}${path}`, {
        method: "OPTIONS",
        headers: { origin: "https://kletiaai.xyz", "access-control-request-method": "PATCH", "access-control-request-headers": "content-type,x-kletia-admin" },
      });
      assert.equal(preflight.headers.get("access-control-allow-origin"), "https://kletiaai.xyz");
      assert.equal(preflight.headers.get("access-control-allow-credentials"), "true");
      assert.ok(list(preflight.headers.get("access-control-allow-methods")).includes("patch"));
      assert.ok(list(preflight.headers.get("access-control-allow-headers")).includes("x-kletia-admin"));
    }
  });

  it("refuses foreign origins and leaves the rest of /api unchanged", async () => {
    const foreign = await fetch(`${base}/api/admin/auth/nonce`, { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-method": "POST" } });
    assert.equal(foreign.headers.get("access-control-allow-origin"), null);
    const other = await fetch(`${base}/api/intent`, { method: "OPTIONS", headers: { origin: "https://kletiaai.xyz", "access-control-request-method": "PATCH" } });
    assert.ok(!list(other.headers.get("access-control-allow-methods")).includes("patch"));
    assert.ok(!list(other.headers.get("access-control-allow-headers")).includes("x-kletia-admin"));
  });
});
