import assert from "node:assert/strict";

import { computeSolverBidCommitment } from "../src/networks/stellar/runtime/solverMarket";

const releaseVector = {
  schemaVersion: "kletia_solver_bid_secret_v1",
  auctionContract: "CCFY5ZJJ5CILIOPD7LUYRRQ3XCO2OUUL3ZMZQER4IWQ6XO7ZLVWBBP5D",
  workflowRoot: `0x${"11".repeat(32)}`,
  solver: "GDKHTBTURCFYXVNBRIXTUFGIS76TOZGBOA52VAYFKTMWXELDBGA4E5CN",
  routeHash: `0x${"22".repeat(32)}`,
  quoteEvidenceHash: `0x${"33".repeat(32)}`,
  promisedOutputAtomic: "1234567",
  solverFeeAtomic: "1234",
  durationSeconds: 321,
  quoteExpiresAtLedger: 987654,
  salt: `0x${"44".repeat(32)}`,
} as const;

assert.equal(
  await computeSolverBidCommitment(releaseVector),
  "0x46f4ff28bb98647369cc77c774828e163b9414108035752867bbd3cdff2c82af",
  "The browser commitment must match the Rust contract release vector.",
);

await assert.rejects(
  computeSolverBidCommitment({
    ...releaseVector,
    salt: `0x${"00".repeat(32)}`,
  }),
  /salt cannot be zero/u,
);

console.log("Solver-market browser commitment matches the Soroban release vector.");
