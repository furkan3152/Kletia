import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";

import { sanitizePrompt, validateAddress } from "./security.js";

function testApp(network: "base" | "arc") {
  const app = express();
  app.use(express.json());
  app.post(
    "/",
    (req, _res, next) => {
      req.kletiaNetwork = {
        id: network,
        chainId: network === "base" ? 8453 : 5042002,
      } as typeof req.kletiaNetwork;
      req.kletiaRequestId = "4df9c8eb-4c1d-4c45-a18b-d242796e990d";
      next();
    },
    validateAddress,
    sanitizePrompt,
    (req, res) => res.json({ success: true, address: req.body.userAddress }),
  );
  return app;
}

describe("intent address security boundary", () => {
  beforeEach(() => {
    delete process.env.WEBACY_API_KEY;
  });

  it("keeps non-URL Base intents available without fabricating a Webacy score", async () => {
    const response = await request(testApp("base")).post("/").send({
      userAddress: "0x8c5281055B197443fF01dbBDFBf29fD63946cA1E",
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      success: true,
      address: "0x8c5281055B197443fF01dbBDFBf29fD63946cA1E",
    });
    expect(response.body).not.toHaveProperty("riskScore");
  });

  it("blocks the deterministic Base denylist even without Webacy", async () => {
    const response = await request(testApp("base")).post("/").send({
      userAddress: "0xd90e2f925da726b50c4ed8d0fb90ad053324f31b",
    });

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({
      success: false,
      code: "HIGH_RISK_ADDRESS",
      decision: "blocked",
      riskScore: 100,
      source: "kletia_deterministic_denylist",
      network: "base",
      chainId: 8453,
    });
  });

  it("keeps URL-bearing Base intents fail-closed when Webacy is unavailable", async () => {
    const response = await request(testApp("base")).post("/").send({
      userAddress: "0x8c5281055B197443fF01dbBDFBf29fD63946cA1E",
      prompt: "Inspect https://127.0.0.1 without sending a transaction",
    });

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      success: false,
      code: "URL_SECURITY_UNAVAILABLE",
      network: "base",
      chainId: 8453,
    });
  });

  it("preserves Arc network identity while validating the wallet", async () => {
    const response = await request(testApp("arc")).post("/").send({
      userAddress: "0x8c5281055B197443fF01dbBDFBf29fD63946cA1E",
    });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
  });
});
