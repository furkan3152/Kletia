/**
 * What a browser sees from the path-switched CORS middleware: the /v1
 * preflight for PATCH (custom contract edits from the developer portal), the
 * actual PATCH response, and the unchanged first-party policy.
 */
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { after, before, describe, it } from "node:test";
import express from "express";
import { createCorsMiddleware } from "../../../shared/http/cors.js";

let server: Server;
let base: string;

before(async () => {
  const app = express();
  app.use(createCorsMiddleware());
  app.patch("/v1/contracts/:id", (_req, res) => {
    res.json({ ok: true });
  });
  // The first-party policy answers errors for foreign origins; keep them out of the default handler's HTML.
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

const methods = (response: Response) => (response.headers.get("access-control-allow-methods") ?? "").split(",").map((method) => method.trim().toUpperCase());

describe("browser access to PATCH /v1/contracts/{id}", () => {
  it("passes the preflight from any origin, without credentials", async () => {
    for (const origin of ["https://kletiaai.xyz", "https://integrator.example"]) {
      for (const path of ["/v1/contracts/ctr_0123456789abcdef", "/V1/contracts/ctr_0123456789abcdef"]) {
        const preflight = await fetch(`${base}${path}`, {
          method: "OPTIONS",
          headers: { origin, "access-control-request-method": "PATCH", "access-control-request-headers": "content-type,x-kletia-key,idempotency-key" },
        });
        assert.equal(preflight.status, 204, `${origin} ${path}`);
        assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
        assert.ok(methods(preflight).includes("PATCH"), preflight.headers.get("access-control-allow-methods") ?? "");
        const headers = (preflight.headers.get("access-control-allow-headers") ?? "").toLowerCase();
        for (const header of ["content-type", "x-kletia-key", "idempotency-key"]) assert.ok(headers.includes(header), header);
        assert.equal(preflight.headers.get("access-control-allow-credentials"), null);
      }
    }
  });

  it("lets the browser read the PATCH response", async () => {
    const response = await fetch(`${base}/v1/contracts/ctr_0123456789abcdef`, {
      method: "PATCH",
      headers: { origin: "https://kletiaai.xyz", "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
  });

  it("leaves the first-party policy as it was (allowlisted origins, credentials, no PATCH)", async () => {
    const preflight = await fetch(`${base}/api/anything`, {
      method: "OPTIONS",
      headers: { origin: "https://kletiaai.xyz", "access-control-request-method": "PATCH" },
    });
    assert.equal(preflight.headers.get("access-control-allow-origin"), "https://kletiaai.xyz");
    assert.equal(preflight.headers.get("access-control-allow-credentials"), "true");
    assert.ok(!methods(preflight).includes("PATCH"));
    const foreign = await fetch(`${base}/api/anything`, { method: "OPTIONS", headers: { origin: "https://integrator.example", "access-control-request-method": "GET" } });
    assert.equal(foreign.headers.get("access-control-allow-origin"), null);
  });
});
