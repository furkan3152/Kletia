import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build, buildSync } from "esbuild";
import { decodeFunctionData, encodeFunctionData, getAddress, toFunctionSelector } from "viem";

const require = createRequire(import.meta.url);
const arcRoot = fileURLToPath(new URL("../../", import.meta.url));
const V2 = {
  VITE_ARC_SWAP_V2_ADDRESS: "0x1111111111111111111111111111111111111111",
  VITE_ARC_STAKING_V2_ADDRESS: "0x2222222222222222222222222222222222222222",
  VITE_ARC_LENDING_V2_ADDRESS: "0x3333333333333333333333333333333333333333",
};
const LEGACY = {
  swap: getAddress("0x535EF89e3C3a74Cf1A76703972686cb7a2e34fe8"),
  staking: getAddress("0xB85a7F6335D0544b4951e5f07Bcd326722b2BC07"),
  lending: getAddress("0x2748a478Ec0f6D90FfdE89b27721f469126835F7"),
};

// Compile the real Vite config with deterministic public environment values.
// The addresses above are test fixtures, not deployment or economic evidence.
function loadArc(env = {}, withUi = false) {
  const entry = withUi
    ? `
      import React from "react";
      import { renderToStaticMarkup } from "react-dom/server";
      import { ArcDashboardWidget } from ${JSON.stringify(`${arcRoot}/components/ArcDashboardWidget.tsx`)};
      import { ArcLendingDashboard } from ${JSON.stringify(`${arcRoot}/components/ArcLendingDashboard.tsx`)};
      export * from ${JSON.stringify(`${arcRoot}/config.ts`)};
      export const renderWidget = (widget) => renderToStaticMarkup(React.createElement(ArcDashboardWidget, { minimal: true, activeWidget: widget, onWidgetClick() { throw new Error("No execution in this fixture."); } }));
      export const renderLending = () => renderToStaticMarkup(React.createElement(ArcLendingDashboard, { isDarkMode: false, onActionClick() { throw new Error("No execution in this fixture."); } }));
    `
    : `export * from ${JSON.stringify(`${arcRoot}/config.ts`)}; export * from ${JSON.stringify(`${arcRoot}/runtime/positionIntents.ts`)};`;
  const options = {
    stdin: { contents: entry, resolveDir: arcRoot, loader: "tsx" },
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    jsx: "automatic",
    external: ["viem", "react", "react/*", "react-dom/*", "lucide-react", "ethers"],
    define: { "import.meta.env": JSON.stringify({ VITE_BACKEND_URL: "http://127.0.0.1:3001", ...env }) },
    plugins: withUi ? [{
      name: "readonly-wallet-fixture",
      setup(build) {
        build.onResolve({ filter: /^wagmi$/ }, () => ({ path: "wagmi", namespace: "fixture" }));
        build.onResolve({ filter: /^\.\/ArcUnifiedBalanceCard$/ }, () => ({ path: "unified", namespace: "fixture" }));
        build.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({
          contents: path === "unified" ? "export const ArcUnifiedBalanceCard = () => null;" : `
            export const useAccount = () => ({ address: "0x4444444444444444444444444444444444444444", isConnected: true });
            export const useChainId = () => 5042002;
            export const useBalance = () => ({ data: { value: 0n } });
            export const useReadContract = () => ({ data: undefined });
            export const useReadContracts = () => ({ data: undefined });
          `,
          loader: "js",
        }));
      },
    }] : [],
  };
  const evaluate = (bundle) => {
    const module = { exports: {} };
    new Function("require", "module", "exports", bundle.outputFiles[0].text)(require, module, module.exports);
    return module.exports;
  };
  return withUi ? build(options).then(evaluate) : evaluate(buildSync(options));
}

function button(markup, label) {
  const match = Array.from(markup.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gu))
    .find((candidate) => candidate[2].includes(label));
  assert.ok(match, `Missing button: ${label}`);
  return { disabled: /\bdisabled=/u.test(match[1]) };
}

test("unconfigured Arc DeFi remains legacy read-only while the independent deployed Vault V2 stays active", () => {
  const arc = loadArc({ VITE_ARC_SWAP_V2_ADDRESS: " ", VITE_ARC_STAKING_V2_ADDRESS: "", VITE_ARC_LENDING_V2_ADDRESS: "" });
  assert.deepEqual(arc.ARC_NEW_CAPITAL_READY, { swap: false, staking: false, lending: false });
  assert.deepEqual(arc.ARC_DEFI_V2_ADDRESSES, { swap: null, staking: null, lending: null });
  for (const protocol of Object.keys(LEGACY)) assert.equal(arc.arcDefiPositionAddress(protocol, false), LEGACY[protocol]);
  assert.equal(arc.ARC_VAULT_EXECUTION_MODE, "vault_v2");
  assert.equal(arc.ARC_CONTRACTS.Vault, getAddress("0xBe385e3520C20D44697CC1bEEDc9DF759C3A184d"));
});

test("a lending address alone cannot enable new debt without the upgraded swap dependency", () => {
  const lending = loadArc({ VITE_ARC_LENDING_V2_ADDRESS: V2.VITE_ARC_LENDING_V2_ADDRESS });
  assert.equal(lending.ARC_NEW_CAPITAL_READY.lending, false);
  const staking = loadArc({ VITE_ARC_STAKING_V2_ADDRESS: V2.VITE_ARC_STAKING_V2_ADDRESS });
  assert.deepEqual(staking.ARC_NEW_CAPITAL_READY, { swap: false, staking: true, lending: false });
  assert.deepEqual(loadArc(V2).ARC_NEW_CAPITAL_READY, { swap: true, staking: true, lending: true });
});

test("V2 activation preserves the original addresses for every explicit legacy position", () => {
  const arc = loadArc(V2);
  for (const protocol of Object.keys(LEGACY)) {
    assert.equal(arc.arcDefiPositionAddress(protocol, true), LEGACY[protocol]);
    assert.notEqual(arc.arcDefiPositionAddress(protocol, false), LEGACY[protocol]);
  }
  for (const [protocol, key] of [["swap", "VITE_ARC_SWAP_V2_ADDRESS"], ["staking", "VITE_ARC_STAKING_V2_ADDRESS"], ["lending", "VITE_ARC_LENDING_V2_ADDRESS"]]) {
    for (const address of [LEGACY[protocol], "0x0000000000000000000000000000000000000000", "invalid"]) {
      assert.throws(() => loadArc({ [key]: address }));
    }
  }
});

test("Swap V2 encodes the exact minimum-output and expiry signatures without changing atomic units", () => {
  const { ARC_SWAP_ABI } = loadArc(V2);
  const deadline = 2_000_000_000n;
  for (const [functionName, signature, args] of [
    ["swapUSDCForToken", "swapUSDCForToken(uint256,uint256)", [123_456_789_123_456_789n, deadline]],
    ["swapTokenForUSDC", "swapTokenForUSDC(uint256,uint256,uint256)", [10n ** 18n, 987_654_321_987_654_321n, deadline]],
  ]) {
    const data = encodeFunctionData({ abi: ARC_SWAP_ABI, functionName, args });
    assert.equal(data.slice(0, 10), toFunctionSelector(signature));
    assert.deepEqual(decodeFunctionData({ abi: ARC_SWAP_ABI, data }).args, args);
  }
});

test("existing-position prompts explicitly bind legacy exits and preserve the entered amount", () => {
  const { arcPositionExitPrompt } = loadArc(V2);
  for (const action of ["unstake", "claim_rewards", "claim_unstaked", "lending_repay", "lending_withdraw", "remove_liquidity"]) {
    const legacy = arcPositionExitPrompt(action, true, "0.123456789123456789");
    assert.match(legacy, /Kletia Legacy (?:Staking|Lending|Swap) on Arc Testnet/u);
    assert.doesNotMatch(arcPositionExitPrompt(action, false), /Legacy/u);
    if (!["claim_rewards", "claim_unstaked"].includes(action)) assert.ok(legacy.includes("0.123456789123456789"));
  }
});

test("visible Arc controls pause new capital while retaining legacy exits and the deployed Vault", async () => {
  const ui = await loadArc({}, true);
  for (const [widget, action] of [["swap", "Prepare Swap Intent"], ["staking", "Prepare Stake Intent"], ["liquidity", "Prepare Liquidity Intent"], ["lending", "Prepare Collateral Intent"], ["lending", "Prepare Borrow Intent"]]) {
    const markup = ui.renderWidget(widget);
    assert.equal(button(markup, action).disabled, true);
    assert.match(markup, /unavailable until the upgraded/u);
  }
  assert.equal(button(ui.renderWidget("staking"), "Prepare Unstake Intent").disabled, false);
  assert.equal(button(ui.renderWidget("liquidity"), "Prepare LP Withdrawal Intent").disabled, false);
  assert.equal(button(ui.renderWidget("vault"), "Prepare Vault Deposit Intent").disabled, false);
  const lending = ui.renderLending();
  assert.equal(button(lending, "Add Collateral").disabled, true);
  assert.equal(button(lending, "Borrow").disabled, true);
  assert.equal(button(lending, "Repay").disabled, false);
  assert.equal(button(lending, "Withdraw Collateral").disabled, false);
});

test("configured V2 controls offer reviewable new intents and explicit existing-position selectors", async () => {
  const ui = await loadArc(V2, true);
  for (const [widget, action] of [["swap", "Prepare Swap Intent"], ["staking", "Prepare Stake Intent"], ["liquidity", "Prepare Liquidity Intent"], ["lending", "Prepare Collateral Intent"]]) {
    assert.equal(button(ui.renderWidget(widget), action).disabled, false);
  }
  assert.match(ui.renderWidget("swap"), /minimum output and expiry/u);
  assert.match(ui.renderWidget("staking"), /Legacy contract \(original position\)/u);
  assert.match(ui.renderLending(), /Balances, debt and risk below refer to the V2/u);
});
