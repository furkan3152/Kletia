import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { requireBaseNetwork } from "../../../shared/http/network.js";
import baseMcpRoutes from "./mcp.js";

const WALLET = "0x8c5281055B197443fF01dbBDFBf29fD63946cA1E";

function testApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/base-mcp", requireBaseNetwork, baseMcpRoutes);
  return app;
}

describe("Base MCP route boundary", () => {
  it("returns a non-custodial Base-only context for an explicit wallet", async () => {
    const response = await request(testApp()).get("/api/base-mcp/context").query({
      wallet: WALLET,
      network: "base",
      chainId: "8453",
    });

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toMatchObject({
      success: true,
      network: "base",
      chainId: 8453,
      wallet: {
        address: WALLET,
        ownershipAttestation: "not_verified_by_kletia",
      },
      boundary: {
        custody: "none",
        oauthVerifiedByKletia: false,
        failClosed: true,
      },
    });
  });

  it("rejects Arc context before the Base route executes", async () => {
    const response = await request(testApp()).get("/api/base-mcp/context").query({
      wallet: WALLET,
      network: "arc",
      chainId: "5042002",
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      success: false,
      code: "BASE_ONLY_ROUTE",
    });
  });

  it("requires the full network identity", async () => {
    const response = await request(testApp()).get("/api/base-mcp/context").query({
      wallet: WALLET,
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      success: false,
      code: "NETWORK_REQUIRED",
    });
  });

  it("refuses discovery terms in a GET URL", async () => {
    const response = await request(testApp())
      .get("/api/base-mcp/x402/discover")
      .query({ network: "base", chainId: "8453" });

    expect(response.status).toBe(405);
    expect(response.headers.allow).toBe("POST");
    expect(response.body.code).toBe("BASE_MCP_DISCOVERY_POST_REQUIRED");
  });

  it("builds a deterministic prepare-only plan without signing or sending", async () => {
    const query = {
      wallet: WALLET,
      url: "https://example.com/paid-resource",
      method: "GET",
      maxPayment: "0.05",
      network: "base",
      chainId: "8453",
    };
    const [first, second] = await Promise.all([
      request(testApp()).get("/api/base-mcp/x402/prepare").query(query),
      request(testApp()).get("/api/base-mcp/x402/prepare").query(query),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.prepareId).toBe(second.body.prepareId);
    expect(first.body).toMatchObject({
      success: true,
      network: "base",
      chainId: 8453,
      data: {
        executionKind: "base_mcp_x402",
        approvalRequired: true,
        mcpPlan: {
          network: "base",
          chainId: 8453,
          initiate: {
            tool: "initiate_x402_request",
            method: "GET",
            maxPayment: "0.05",
          },
          complete: { tool: "complete_x402_request" },
        },
      },
      boundary: { custody: "none", failClosed: true },
    });
  });

  it("rejects a private paid-resource host", async () => {
    const response = await request(testApp())
      .get("/api/base-mcp/x402/prepare")
      .query({
        wallet: WALLET,
        url: "https://127.0.0.1/private",
        method: "GET",
        maxPayment: "0.05",
        network: "base",
        chainId: "8453",
      });

    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
  });
});
