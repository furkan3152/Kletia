// The WalletConnect project id check: only a real Reown id turns
// the WalletConnect option on; placeholders and malformed values hide it.
// Run with
//   node --test apps/web/src/shared/platform/__tests__/*.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { readFileSync } from "node:fs";

import { walletConnectBuildWarning, walletConnectProjectId } from "../walletConnectProjectId.ts";

test("a 32-character hexadecimal Reown project id is accepted (trimmed, lower case)", () => {
  assert.equal(walletConnectProjectId("0123456789abcdef0123456789abcdef"), "0123456789abcdef0123456789abcdef");
  assert.equal(walletConnectProjectId("  0123456789ABCDEF0123456789ABCDEF\n"), "0123456789abcdef0123456789abcdef");
});

test("placeholders, empty and malformed values hide WalletConnect", () => {
  for (const value of [
    undefined,
    null,
    42,
    "",
    "   ",
    "<REOWN_WALLETCONNECT_PROJECT_ID>",
    "<your project id>",
    "your_project_id",
    "YOUR_WALLETCONNECT_PROJECT_ID",
    "changeme",
    "0123456789abcdef0123456789abcde",
    "0123456789abcdef0123456789abcdef0",
    "0123456789abcdeg0123456789abcdef",
    '"0123456789abcdef0123456789abcdef"',
    "https://cloud.reown.com/app/0123456789abcdef0123456789abcdef",
  ]) {
    assert.equal(walletConnectProjectId(value), null, String(value));
  }
});

test("the build warns about a set but invalid id, and the admin panel does not count it as set", () => {
  assert.match(walletConnectBuildWarning("<REOWN_WALLETCONNECT_PROJECT_ID>"), /WalletConnect is hidden in this build/u);
  assert.match(walletConnectBuildWarning("your_project_id"), /32-character hexadecimal/u);
  for (const value of [undefined, "", "   ", "0123456789abcdef0123456789abcdef"]) assert.equal(walletConnectBuildWarning(value), null, String(value));
  const vite = readFileSync(new URL("../../../../vite.config.ts", import.meta.url), "utf8");
  assert.match(vite, /walletConnectBuildWarning\(config\.env\.VITE_WALLETCONNECT_PROJECT_ID\)/u);
  const admin = readFileSync(new URL("../../../app/pages/admin/sections/Environment.tsx", import.meta.url), "utf8");
  assert.match(admin, /walletConnectProjectId\(import\.meta\.env\.VITE_WALLETCONNECT_PROJECT_ID\) !== null/u);
});
