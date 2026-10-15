// The admin panel's pure parts: arguments, the deploy checklist, previews,
// Safe proposals, fees, sessions (EVM and Solana) and the sign-in message
// check. Run with
//   node --test apps/web/src/app/pages/admin/__tests__/*.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { decodeFunctionData, encodeAbiParameters, encodeFunctionData, getAddress } from "viem";

import { buildDeployData, dependencyAddress, eoaAckPhrase, resolveArg, resolveArgs, validateRoles } from "../model/args.ts";
import { canonicalJson, payloadSha256 } from "../model/confirm.ts";
import { claimState, feeTotals, formatUnits, formatUsd, scanText } from "../model/fees.ts";
import { ADMIN_PANEL_NETWORKS, deploymentMatrix, NO_PROGRAMS_TEXT, planFor } from "../model/plan.ts";
import { buildAddressBook, decodeCall, nameFor, parseInput, RENOUNCE_DISABLED, SINGLE_STEP_WARNING, transferOwnerProblems, writeFunctions } from "../model/preview.ts";
import { hasSigned, missingSigners, packSignatures, safeAppUrl, safeTxTypedData, signatureProgress, sortSignatures, transactionBuilderJson } from "../model/safe.ts";
import {
  actorFor,
  adminOriginSupported,
  cannotActReason,
  countdownText,
  evmSignerFor,
  sessionEndsAt,
  sessionKind,
  walletSwitchedAway,
} from "../model/session.ts";
import { base58Encode, parseSignInMessage, signInProblems } from "../model/signIn.ts";
import {
  ADMIN_EVM,
  ADMIN_SOLANA,
  CATALOG,
  CONSTANTS,
  COSIGNER,
  GATEWAY_ABI,
  GOVERNANCE_SAFE,
  PROFILE_ARBITRUM,
  record,
  ROUTER_ABI,
  SAFE_EXEC_ABI,
  TREASURY_SAFE,
} from "./fixtures.mjs";

const ARB = { network: "arbitrum", testnet: false, profile: PROFILE_ARBITRUM, constants: CONSTANTS.arbitrum, records: [], pinned: CATALOG.pinned, signer: ADMIN_EVM };

/* ---------------- args ---------------- */

test("every argument source resolves: role, network constant, dependency, literal, wallet", () => {
  const inputs = CATALOG.contracts["intent-router-v2"].constructorInputs;
  const resolved = resolveArgs(inputs, ARB);
  assert.equal(resolved.ready, true, resolved.blocked);
  assert.deepEqual(resolved.values, {
    initialOwner: getAddress(ADMIN_EVM),
    initialGuardian: getAddress(COSIGNER),
    wrappedNative_: getAddress(CONSTANTS.arbitrum.wrappedNative),
    initialTreasury: getAddress(TREASURY_SAFE),
    initialFeeBps: "10",
  });
  const creator = resolveArg(CATALOG.contracts["arc-klet-token"].constructorInputs[1], { ...ARB, network: "arc" });
  assert.deepEqual({ ok: creator.ok, value: creator.value, origin: creator.origin }, { ok: true, value: getAddress(ADMIN_EVM), origin: "wallet" });
});

test("a missing role, constant or wallet disables the deploy with the reason", () => {
  const inputs = CATALOG.contracts["intent-router-v2"].constructorInputs;
  const noProfile = resolveArgs(inputs, { ...ARB, profile: null });
  assert.equal(noProfile.ready, false);
  assert.match(noProfile.blocked, /Set the owner address in the network profile first/u);
  const noWrapped = resolveArgs(inputs, { ...ARB, constants: { network: "arbitrum" } });
  assert.match(noWrapped.blocked, /No pinned wrappedNative/u);
  const noWallet = resolveArg(CATALOG.contracts["arc-klet-token"].constructorInputs[1], { ...ARB, signer: null });
  assert.equal(noWallet.ok, false);
  assert.match(noWallet.reason, /Connect the EVM admin wallet/u);
  // Base falls back to the catalog's default roles (the three Safes).
  const base = resolveArgs(inputs, { ...ARB, network: "base", profile: null, constants: CONSTANTS.base });
  assert.equal(base.ready, true);
  assert.equal(base.values.initialOwner, getAddress(GOVERNANCE_SAFE));
  assert.equal(base.args[0].origin, "default-role");
});

test("literal bounds: fee 0-100, APY at most 5000, whole numbers only", () => {
  const fee = CATALOG.contracts["intent-router-v2"].constructorInputs[4];
  for (const [value, ok] of [["0", true], ["100", true], ["101", false], ["-1", false], ["1.5", false], ["abc", false]]) {
    assert.equal(resolveArg(fee, { ...ARB, literals: { initialFeeBps: value } }).ok, ok, value);
  }
  assert.match(resolveArg(fee, { ...ARB, literals: { initialFeeBps: "101" } }).reason, /at most 100/u);
  const apy = CATALOG.contracts["arc-vault-v2"].constructorInputs[0];
  assert.equal(resolveArg(apy, { ...ARB, literals: { initialApyBps: "5000" } }).ok, true);
  assert.equal(resolveArg(apy, { ...ARB, literals: { initialApyBps: "5001" } }).ok, false);
  // uint16 overflow is refused even without a max.
  const wide = { ...fee, source: { kind: "literal", value: "70000", editable: false } };
  assert.match(resolveArg(wide, ARB).reason, /too large for uint16/u);
});

test("a dependency takes the newest verified record over the pinned address", () => {
  const older = record({ id: "dep_1", address: "0x1111111111111111111111111111111111111111", createdAt: "2026-10-14T00:00:00Z" });
  const newer = record({ id: "dep_2", address: "0x2222222222222222222222222222222222222222", createdAt: "2026-10-15T00:00:00Z" });
  const failed = record({ id: "dep_3", address: "0x3333333333333333333333333333333333333333", status: "verification_failed", createdAt: "2026-10-16T00:00:00Z" });
  const found = dependencyAddress("arbitrum", "uniswap-v2-adapter", "uniswap", [older, failed, newer], CATALOG.pinned);
  assert.deepEqual(found, { address: newer.address, origin: "record" });
  assert.deepEqual(dependencyAddress("base", "intent-router-v2", undefined, [], CATALOG.pinned), { address: CATALOG.pinned[0].address, origin: "pinned" });
  assert.equal(dependencyAddress("arbitrum", "intent-router-v2", undefined, [], CATALOG.pinned), null);
});

test("deploy data is the bytecode followed by the ABI-encoded constructor arguments", () => {
  const values = resolveArgs(CATALOG.contracts["intent-router-v2"].constructorInputs, ARB).values;
  const bytecode = "0x6080604052deadbeef";
  const data = buildDeployData(ROUTER_ABI, bytecode, values);
  const expected = encodeAbiParameters(ROUTER_ABI[0].inputs, [values.initialOwner, values.initialGuardian, values.wrappedNative_, values.initialTreasury, 10n]);
  assert.equal(data, `${bytecode}${expected.slice(2)}`);
  assert.throws(() => buildDeployData(ROUTER_ABI, bytecode, { ...values, initialFeeBps: undefined }), /Missing constructor argument initialFeeBps/u);
  assert.throws(() => buildDeployData(ROUTER_ABI, "0x", values), /no creation bytecode/u);
});

test("role checks: distinct roles on mainnets, no zero address, EOA owner acknowledgement", () => {
  const same = validateRoles({ owner: ADMIN_EVM, guardian: ADMIN_EVM, treasury: TREASURY_SAFE }, { testnet: false, ownerHasCode: false });
  assert.deepEqual(same.errors, []);
  assert.match(same.warnings.join(" "), /owner and the guardian are the same address\. Production policy/u);
  assert.equal(same.needsEoaAck, true);
  const testnet = validateRoles({ owner: ADMIN_EVM, guardian: ADMIN_EVM, treasury: ADMIN_EVM }, { testnet: true, ownerHasCode: false });
  assert.equal(testnet.needsEoaAck, false);
  assert.ok(testnet.warnings.every((line) => !line.includes("Production policy")));
  const bad = validateRoles({ owner: "0x0000000000000000000000000000000000000000", guardian: "nope", treasury: CONSTANTS.arbitrum.wrappedNative }, { testnet: false, wrappedNative: CONSTANTS.arbitrum.wrappedNative, ownerHasCode: null });
  assert.equal(bad.errors.length, 3, bad.errors.join(" | "));
  assert.equal(eoaAckPhrase("Arbitrum One"), "I accept an EOA owner on Arbitrum One");
});

/* ---------------- plan ---------------- */

test("the checklist follows the catalog order and gates on dependencies", () => {
  const empty = planFor("arbitrum", CATALOG, []);
  assert.equal(empty.kind, "evm");
  assert.deepEqual(empty.rows.map((row) => row.target.id), ["arbitrum:uniswap-v2-adapter:uniswap", "arbitrum:intent-router-v2", "arbitrum:launch-factory-v2"]);
  assert.deepEqual(empty.rows.map((row) => row.chip), ["ready", "ready", "waiting"]);
  assert.match(empty.rows[2].detail, /Waiting for KletiaIntentRouterV2/u);
  assert.equal(empty.rows[2].deploy, null);
  const after = planFor("arbitrum", CATALOG, [record({ targetId: "arbitrum:intent-router-v2", contractId: "intent-router-v2", instance: undefined, id: "dep_r" })]);
  assert.deepEqual(after.rows.map((row) => row.chip), ["ready", "verified", "ready"]);
  assert.equal(after.rows[1].deploy, "replace");
  const failed = planFor("arbitrum", CATALOG, [record({ status: "verification_failed" })]);
  assert.equal(failed.rows[0].chip, "failed");
  assert.equal(failed.rows[0].deploy, "deploy");
});

test("pinned, quarantined, legacy, not-applicable and the testnet badge", () => {
  const base = planFor("base", CATALOG, []);
  assert.deepEqual(base.rows.map((row) => row.chip), ["pinned", "quarantined", "legacy"]);
  assert.equal(base.rows[0].deploy, "replace");
  assert.match(base.rows[0].detail, /Live at 0xf9BaA05c/u);
  assert.equal(base.rows[1].deploy, null);
  assert.match(base.rows[1].detail, /EXPERIMENTAL_NOT_RELEASED/u);
  assert.equal(base.testnet, false);
  const arc = planFor("arc", CATALOG, []);
  assert.equal(arc.testnet, true);
  assert.deepEqual(arc.rows.map((row) => row.chip), ["not-applicable", "pinned", "ready"]);
  assert.equal(arc.rows[0].deploy, null);
});

test("Solana networks show the empty state, and every panel network has a tab", () => {
  for (const network of ["solana", "solana-devnet"]) assert.deepEqual(planFor(network, CATALOG, []), { kind: "no-programs", network, message: NO_PROGRAMS_TEXT });
  assert.equal(NO_PROGRAMS_TEXT, "No Kletia programs. Nothing to deploy.");
  assert.equal(ADMIN_PANEL_NETWORKS.length, 9);
  const matrix = deploymentMatrix(CATALOG, []);
  const router = matrix.find((row) => row.contractId === "intent-router-v2");
  assert.equal(router.cells.base, "P");
  assert.equal(router.cells.arbitrum, "D");
  assert.equal(router.cells.arc, "-");
  assert.equal(router.cells.ethereum, "-");
});

/* ---------------- preview ---------------- */

test("decodes setFeeBps, configureAdapter, withdraw and execTransaction", () => {
  const fee = decodeCall(ROUTER_ABI, encodeFunctionData({ abi: ROUTER_ABI, functionName: "setFeeBps", args: [25] }));
  assert.deepEqual(fee, { fn: "setFeeBps", signature: "setFeeBps(uint16)", args: [{ name: "newFeeBps", type: "uint16", value: "25" }] });
  const adapter = "0x1111111111111111111111111111111111111111";
  const configure = decodeCall(ROUTER_ABI, encodeFunctionData({ abi: ROUTER_ABI, functionName: "configureAdapter", args: [adapter, true] }));
  assert.equal(configure.signature, "configureAdapter(address,bool)");
  assert.deepEqual(configure.args.map((arg) => arg.value), [getAddress(adapter), "true"]);
  const withdraw = decodeCall(GATEWAY_ABI, encodeFunctionData({ abi: GATEWAY_ABI, functionName: "withdraw", args: [ADMIN_EVM] }));
  assert.equal(withdraw.args[0].value, getAddress(ADMIN_EVM));
  const inner = encodeFunctionData({ abi: ROUTER_ABI, functionName: "pause" });
  const exec = decodeCall(SAFE_EXEC_ABI, encodeFunctionData({
    abi: SAFE_EXEC_ABI,
    functionName: "execTransaction",
    args: [GOVERNANCE_SAFE, 0n, inner, 0, 0n, 0n, 0n, "0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000", "0x"],
  }));
  assert.equal(exec.fn, "execTransaction");
  assert.equal(exec.args.find((arg) => arg.name === "data").value, inner);
  assert.equal(decodeCall(ROUTER_ABI, "0xdeadbeef"), null);
  assert.equal(decodeCall(ROUTER_ABI, "not hex"), null);
});

test("the address book names the Safes, constants, pinned contracts and the admin wallet", () => {
  const book = buildAddressBook({ catalog: CATALOG, profiles: [PROFILE_ARBITRUM], sessionAddress: ADMIN_SOLANA, signer: ADMIN_EVM });
  assert.equal(nameFor(book, GOVERNANCE_SAFE.toLowerCase()), "Governance Safe");
  assert.equal(nameFor(book, TREASURY_SAFE), "Treasury Safe");
  assert.equal(nameFor(book, ADMIN_EVM), "Connected admin wallet");
  assert.equal(nameFor(book, CONSTANTS.arbitrum.uniswapV2Router), "Uniswap V2 Router02");
  assert.equal(nameFor(book, "0x39Eb74cB023e18c3e9C80ca46888a7Da22bFED7B"), "X402Gateway (0x39Eb74cB023e18c3e9C80ca46888a7Da22bFED7B) on base");
  assert.equal(nameFor(book, "0x9999999999999999999999999999999999999999"), null);
});

test("dangerous actions: single-step transferOwnership warns, renounceOwnership is never offered", () => {
  const gateway = writeFunctions(GATEWAY_ABI, CATALOG.contracts["x402-gateway"].actions, "ownable");
  const transfer = gateway.owner.find((item) => item.item.name === "transferOwnership");
  assert.equal(transfer.danger.singleStepTransfer, true);
  assert.equal(transfer.danger.message, SINGLE_STEP_WARNING);
  const renounce = gateway.other.find((item) => item.item.name === "renounceOwnership");
  assert.equal(renounce.disabled, RENOUNCE_DISABLED);
  const router = writeFunctions(ROUTER_ABI, CATALOG.contracts["intent-router-v2"].actions, "ownable2step");
  assert.deepEqual(router.owner.map((item) => item.item.name), ["pause", "setFeeBps", "transferOwnership"]);
  assert.equal(router.owner[2].danger.singleStepTransfer, false);
  assert.match(router.owner[2].danger.message, /must accept/u);
  assert.ok(router.other.some((item) => item.item.name === "invalidateUnorderedNonces"));
  assert.ok(!router.other.some((item) => item.item.name === "feeBps"), "views are not write functions");
});

test("typed inputs parse addresses, integers, booleans, bytes and JSON arrays", () => {
  assert.deepEqual(parseInput({ type: "uint16" }, "100"), { ok: true, value: 100n });
  assert.equal(parseInput({ type: "uint16" }, "65536").ok, false);
  assert.equal(parseInput({ type: "int8" }, "-128").ok, true);
  assert.equal(parseInput({ type: "int8" }, "128").ok, false);
  assert.equal(parseInput({ type: "address" }, "0x12").ok, false);
  assert.deepEqual(parseInput({ type: "bool" }, "true"), { ok: true, value: true });
  assert.equal(parseInput({ type: "bytes4" }, "0xdeadbeef").ok, true);
  assert.equal(parseInput({ type: "bytes4" }, "0xdead").ok, false);
  assert.deepEqual(parseInput({ type: "uint256[]" }, "[1, \"2\"]"), { ok: true, value: [1n, 2n] });
  assert.equal(parseInput({ type: "address[]" }, "{}").ok, false);
});

test("a single-step ownership transfer needs the address twice and refuses zero, the contract and tokens", () => {
  const contract = "0x39Eb74cB023e18c3e9C80ca46888a7Da22bFED7B";
  assert.deepEqual(transferOwnerProblems({ newOwner: COSIGNER, confirm: COSIGNER.toLowerCase(), contract, singleStep: true }), []);
  assert.match(transferOwnerProblems({ newOwner: COSIGNER, confirm: "", contract, singleStep: true }).join(), /second time/u);
  assert.deepEqual(transferOwnerProblems({ newOwner: COSIGNER, confirm: "", contract, singleStep: false }), []);
  assert.equal(transferOwnerProblems({ newOwner: contract, confirm: contract, contract, singleStep: true }).length, 1);
  assert.equal(transferOwnerProblems({ newOwner: "0x0000000000000000000000000000000000000000", confirm: "0x0000000000000000000000000000000000000000", contract, singleStep: true }).length, 1);
  const usdc = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  assert.match(transferOwnerProblems({ newOwner: usdc, confirm: usdc, contract, knownTokens: [usdc], singleStep: true })[0], /token/u);
});

/* ---------------- safe ---------------- */

test("SafeTx typed data has the Safe's domain and the ten fields", () => {
  const data = safeTxTypedData(8453, GOVERNANCE_SAFE.toLowerCase(), { to: CATALOG.pinned[0].address, value: "0", data: "0x8456cb59", nonce: "7" });
  assert.deepEqual(data.domain, { chainId: 8453, verifyingContract: getAddress(GOVERNANCE_SAFE) });
  assert.equal(data.primaryType, "SafeTx");
  assert.deepEqual(data.types.SafeTx.map((field) => field.name), ["to", "value", "data", "operation", "safeTxGas", "baseGas", "gasPrice", "gasToken", "refundReceiver", "nonce"]);
  assert.equal(data.message.nonce, 7n);
  assert.equal(data.message.operation, 0);
});

test("signatures are sorted by signer and concatenated; progress and missing signers", () => {
  const sigA = `0x${"aa".repeat(65)}`;
  const sigB = `0x${"bb".repeat(65)}`;
  const items = [{ signer: ADMIN_EVM, signature: sigA }, { signer: COSIGNER, signature: sigB }];
  assert.deepEqual(sortSignatures(items).map((item) => item.signer), [COSIGNER, ADMIN_EVM]);
  assert.equal(packSignatures(items), `0x${"bb".repeat(65)}${"aa".repeat(65)}`);
  assert.throws(() => packSignatures([{ signer: ADMIN_EVM, signature: "0x1234" }]), /not 65 bytes/u);
  const proposal = { signatures: [{ signer: ADMIN_EVM, signature: sigA, at: "" }], threshold: 2, owners: [ADMIN_EVM, COSIGNER] };
  assert.equal(signatureProgress(proposal), "1 of 2 signatures");
  assert.deepEqual(missingSigners(proposal), [COSIGNER]);
  assert.equal(hasSigned(proposal, ADMIN_EVM.toLowerCase()), true);
  assert.equal(hasSigned(proposal, null), false);
});

test("Safe{Wallet} links and the Transaction Builder file", () => {
  assert.equal(safeAppUrl("base", GOVERNANCE_SAFE.toLowerCase()), `https://app.safe.global/home?safe=base:${getAddress(GOVERNANCE_SAFE)}`);
  assert.equal(safeAppUrl("arc", GOVERNANCE_SAFE), null);
  const json = transactionBuilderJson({ safe: GOVERNANCE_SAFE, to: CATALOG.pinned[0].address, value: "0", data: "0x8456cb59", description: "Pause the router", createdAt: "2026-10-15T10:00:00Z" }, 8453);
  assert.equal(json.chainId, "8453");
  assert.equal(json.transactions.length, 1);
  assert.deepEqual(Object.keys(json.transactions[0]), ["to", "value", "data", "contractMethod", "contractInputsValues"]);
  assert.equal(json.meta.createdFromSafeAddress, getAddress(GOVERNANCE_SAFE));
});

/* ---------------- fees ---------------- */

const usdc = (amount, usd) => ({ token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol: "USDC", decimals: 6, amount, usd });
const feeRow = (overrides) => ({ network: "base", contractId: "intent-router-v2", address: CATALOG.pinned[0].address, kind: "pushed", amounts: [], recipient: TREASURY_SAFE, claim: null, scannedThroughBlock: null, scanKey: null, blocksLeft: null, testnet: false, note: null, ...overrides });

test("fee totals add pushed and accrued USD, skip testnets and count unpriced tokens", () => {
  const rows = [
    feeRow({ amounts: [usdc("12500000", 12.5), { token: "0xabc", symbol: "DOGE", decimals: 18, amount: "1", usd: null }] }),
    feeRow({ kind: "accrued", contractId: "x402-gateway", amounts: [usdc("3000000", 3)] }),
    feeRow({ network: "arc", testnet: true, amounts: [usdc("99000000", 99)] }),
    feeRow({ network: "arbitrum-sepolia", amounts: [usdc("5000000", 5)] }),
    feeRow({ kind: "treasury-holding", amounts: [usdc("100000000", 100)] }),
  ];
  assert.deepEqual(feeTotals(rows), { pushedUsd: 12.5, accruedUsd: 3, unpricedTokens: 1, testnetRows: 2 });
});

test("amounts print with grouping and trimmed decimals; claims explain why they are off", () => {
  assert.equal(formatUnits("1234567890000", 6), "1,234,567.89");
  assert.equal(formatUnits("1", 18), "0");
  assert.equal(formatUnits("1000000000000000000", 18), "1");
  assert.equal(formatUnits("1500000000000000", 18), "0.0015");
  assert.equal(formatUsd(1234.5), "$1,234.50");
  assert.equal(formatUsd(null), "unpriced");
  assert.deepEqual(claimState(feeRow({})), { available: false, reason: "Fees go to the treasury in each transaction." });
  const claim = { fn: "withdraw", via: "direct", caller: ADMIN_EVM, blockedReason: null };
  assert.deepEqual(claimState(feeRow({ kind: "accrued", claim, amounts: [usdc("0", 0)] })), { available: false, reason: "Nothing to withdraw." });
  assert.deepEqual(claimState(feeRow({ kind: "accrued", claim, amounts: [usdc("5", 0)] })), { available: true, reason: null });
  assert.deepEqual(claimState(feeRow({ kind: "accrued", claim: { ...claim, blockedReason: "Only while paused." }, amounts: [usdc("5", 0)] })).reason, "Only while paused.");
  assert.equal(scanText(feeRow({ scannedThroughBlock: "36000000", blocksLeft: "12000" })), "Scanning, 12,000 blocks left.");
  assert.equal(scanText(feeRow({ scannedThroughBlock: "36000000", blocksLeft: "0" })), "Scanned through block 36,000,000.");
  assert.equal(scanText(feeRow({})), null);
});

/* ---------------- session ---------------- */

const evmSession = { address: ADMIN_EVM, walletKind: "evm", chainId: 8453, expiresAt: "2026-10-15T18:00:00Z", idleExpiresAt: "2026-10-15T10:30:00Z", evmActors: [ADMIN_EVM] };
const solSession = { address: ADMIN_SOLANA, walletKind: "solana", chainId: null, expiresAt: "2026-10-15T18:00:00Z", idleExpiresAt: "2026-10-15T10:30:00Z", evmActors: [ADMIN_EVM] };

test("session kind, expiry countdown and the supported origins", () => {
  assert.equal(sessionKind(evmSession), "evm");
  assert.equal(sessionKind(solSession), "solana");
  assert.equal(sessionKind({ address: ADMIN_SOLANA }), "solana", "an older API without walletKind");
  assert.equal(sessionKind({ address: ADMIN_EVM }), "evm");
  assert.equal(sessionEndsAt(evmSession), Date.parse("2026-10-15T10:30:00Z"));
  const now = Date.parse("2026-10-15T10:00:00Z");
  assert.equal(countdownText(sessionEndsAt(evmSession), now), "30 min");
  assert.equal(countdownText(Date.parse("2026-10-15T17:12:00Z"), now), "7 h 12 min");
  assert.equal(countdownText(now + 30_000, now), "under a minute");
  assert.equal(countdownText(now - 1, now), "expired");
  for (const origin of ["https://kletiaai.xyz", "https://www.kletiaai.xyz", "http://localhost:5174", "http://127.0.0.1:3163"]) assert.equal(adminOriginSupported(origin), true, origin);
  for (const origin of ["https://kletia-frontend.onrender.com", "https://kletia.com", "http://kletiaai.xyz", "https://evil.kletiaai.xyz.example", "nonsense"]) assert.equal(adminOriginSupported(origin), false, origin);
});

test("a wallet switching to another account signs the session out; a disconnect does not", () => {
  assert.equal(walletSwitchedAway(evmSession, { evm: ADMIN_EVM.toLowerCase(), evmChainId: 1, solana: null }), false);
  assert.equal(walletSwitchedAway(evmSession, { evm: COSIGNER, evmChainId: 1, solana: null }), true);
  assert.equal(walletSwitchedAway(evmSession, { evm: null, evmChainId: null, solana: "x" }), false);
  assert.equal(walletSwitchedAway(solSession, { evm: COSIGNER, evmChainId: 1, solana: ADMIN_SOLANA }), false, "the EVM wallet is free in a Solana session");
  assert.equal(walletSwitchedAway(solSession, { evm: null, evmChainId: null, solana: ADMIN_SOLANA.toLowerCase() }), true, "base58 is case sensitive");
});

test("a Solana session reads everything but needs an allowlisted EVM wallet to sign on-chain", () => {
  const none = evmSignerFor(solSession, { evm: null, evmChainId: null, solana: ADMIN_SOLANA });
  assert.equal(none.ready, false);
  assert.match(none.reason, /Connect the EVM admin wallet to sign on-chain actions\. Your Solana session stays signed in\./u);
  const stranger = evmSignerFor(solSession, { evm: COSIGNER, evmChainId: 8453, solana: ADMIN_SOLANA });
  assert.equal(stranger.ready, false);
  assert.match(stranger.reason, /not an admin wallet/u);
  assert.deepEqual(evmSignerFor(solSession, { evm: ADMIN_EVM, evmChainId: 8453, solana: ADMIN_SOLANA }), { ready: true, address: ADMIN_EVM, chainId: 8453 });
  assert.match(evmSignerFor(evmSession, { evm: null, evmChainId: null, solana: null }).reason, /Reconnect the EVM admin wallet/u);
});

test("who can act on a contract is decided against the wallet that would sign", () => {
  const safeOwned = { owner: GOVERNANCE_SAFE, pendingOwner: null, ownerKind: "safe", safe: { threshold: 2, owners: [ADMIN_EVM, COSIGNER], nonce: "3" } };
  assert.equal(actorFor(safeOwned, ADMIN_EVM.toLowerCase()), "via-safe");
  assert.equal(actorFor(safeOwned, null), "no");
  assert.equal(actorFor({ owner: ADMIN_EVM, pendingOwner: null, ownerKind: "eoa" }, ADMIN_EVM), "direct");
  assert.equal(actorFor({ owner: COSIGNER, pendingOwner: ADMIN_EVM, ownerKind: "eoa" }, ADMIN_EVM), "pending-owner");
  assert.equal(actorFor({ owner: COSIGNER, pendingOwner: null, ownerKind: "eoa" }, ADMIN_EVM), "no");
  assert.match(cannotActReason({ owner: COSIGNER, ownerKind: "eoa" }, ADMIN_EVM, evmSession), /Owned by 0x8c52…cA1E\. Connect that wallet \(add it to KLETIA_ADMIN_ADDRESSES\)/u);
  assert.match(cannotActReason({ owner: COSIGNER, ownerKind: "eoa" }, null, solSession), /Solana session can read and record, not sign on EVM networks/u);
});

/* ---------------- sign-in message ---------------- */

const SIWS = [
  "kletiaai.xyz wants you to sign in with your Solana account:",
  ADMIN_SOLANA,
  "",
  "Sign in to the Kletia admin panel. This signature does not move funds or approve a transaction.",
  "",
  "URI: https://kletiaai.xyz/admin",
  "Version: 1",
  "Nonce: abcdefghijklmnopqrstuvwx",
  "Issued At: 2026-10-15T10:00:00.000Z",
  "Expiration Time: 2026-10-15T10:05:00.000Z",
  "Request ID: adm_login",
].join("\n");

const SIWE = [
  "kletiaai.xyz wants you to sign in with your Ethereum account:",
  ADMIN_EVM,
  "",
  "Sign in to the Kletia admin panel. This signature does not move funds or approve a transaction.",
  "",
  "URI: https://kletiaai.xyz/admin",
  "Version: 1",
  "Chain ID: 8453",
  "Nonce: abcdefghijklmnopqrstuvwx",
  "Issued At: 2026-10-15T10:00:00.000Z",
  "Expiration Time: 2026-10-15T10:05:00.000Z",
  "Request ID: adm_login",
].join("\n");

test("both sign-in messages parse into the same fields", () => {
  const sol = parseSignInMessage(SIWS);
  assert.equal(sol.kind, "solana");
  assert.equal(sol.domain, "kletiaai.xyz");
  assert.equal(sol.address, ADMIN_SOLANA);
  assert.match(sol.statement, /does not move funds/u);
  assert.equal(sol.chainId, null);
  assert.equal(sol.expirationTime, "2026-10-15T10:05:00.000Z");
  const evm = parseSignInMessage(SIWE);
  assert.equal(evm.kind, "evm");
  assert.equal(evm.chainId, 8453);
  assert.equal(evm.requestId, "adm_login");
  assert.equal(parseSignInMessage("hello"), null);
});

test("the panel refuses to ask for a signature over another site, address, chain or an expired message", () => {
  const now = Date.parse("2026-10-15T10:01:00Z");
  assert.deepEqual(signInProblems(parseSignInMessage(SIWS), { kind: "solana", host: "kletiaai.xyz", address: ADMIN_SOLANA, now }), []);
  assert.deepEqual(signInProblems(parseSignInMessage(SIWE), { kind: "evm", host: "kletiaai.xyz", address: ADMIN_EVM.toLowerCase(), chainId: 8453, now }), []);
  assert.match(signInProblems(parseSignInMessage(SIWS), { kind: "solana", host: "evil.example", address: ADMIN_SOLANA, now }).join(), /names kletiaai\.xyz, not evil\.example/u);
  assert.match(signInProblems(parseSignInMessage(SIWS), { kind: "solana", host: "kletiaai.xyz", address: ADMIN_SOLANA.toLowerCase(), now }).join(), /another address/u);
  assert.match(signInProblems(parseSignInMessage(SIWE), { kind: "evm", host: "kletiaai.xyz", address: ADMIN_EVM, chainId: 1, now }).join(), /another chain/u);
  assert.match(signInProblems(parseSignInMessage(SIWS), { kind: "solana", host: "kletiaai.xyz", address: ADMIN_SOLANA, now: Date.parse("2026-10-15T11:00:00Z") }).join(), /already expired/u);
  assert.match(signInProblems(parseSignInMessage(SIWE), { kind: "solana", host: "kletiaai.xyz", address: ADMIN_EVM, now }).join(), /Ethereum account/u);
  assert.equal(signInProblems(null, { kind: "evm", host: "x", address: ADMIN_EVM, now }).length, 1);
});

test("base58 encodes Solana signatures (leading zeros, known vectors)", () => {
  assert.equal(base58Encode(new Uint8Array([])), "");
  assert.equal(base58Encode(new Uint8Array([0, 0, 1])), "112");
  assert.equal(base58Encode(new TextEncoder().encode("hello world")), "StV1DL6CwTryKyV");
  // The admin's Solana address round-trips: 32 bytes decoded by the reference alphabet.
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let value = 0n;
  for (const char of ADMIN_SOLANA) value = value * 58n + BigInt(alphabet.indexOf(char));
  const bytes = new Uint8Array(32);
  for (let index = 31; index >= 0; index -= 1) {
    bytes[index] = Number(value & 0xffn);
    value >>= 8n;
  }
  assert.equal(base58Encode(bytes), ADMIN_SOLANA);
});

/* ---------------- confirmation hash ---------------- */

test("the confirmation payload hash is SHA-256 of canonical JSON without the confirmation", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: null }], c: "x" }, u: undefined }), '{"a":{"c":"x","d":[1,{"y":null,"z":1}]},"b":1}');
  const body = { owner: ADMIN_EVM, guardian: COSIGNER, treasury: TREASURY_SAFE, eoaOwnerAcknowledged: true };
  const hash = payloadSha256({ ...body, confirmation: { message: "m", signature: "s" } });
  assert.equal(hash, payloadSha256({ treasury: TREASURY_SAFE, eoaOwnerAcknowledged: true, guardian: COSIGNER, owner: ADMIN_EVM }));
  assert.match(hash, /^[0-9a-f]{64}$/u);
});

test("decodeFunctionData agrees with the preview on calldata built by the panel", () => {
  const data = encodeFunctionData({ abi: ROUTER_ABI, functionName: "transferOwnership", args: [COSIGNER] });
  assert.equal(decodeFunctionData({ abi: ROUTER_ABI, data }).functionName, decodeCall(ROUTER_ABI, data).fn);
});

test("wallet errors read as one sentence; a rejection says so plainly", async () => {
  const { walletErrorText } = await import("../model/session.ts");
  assert.equal(walletErrorText(Object.assign(new Error("User rejected the request."), { code: 4001 })), "You rejected the request in your wallet.");
  assert.equal(walletErrorText(Object.assign(new Error("x"), { name: "UserRejectedRequestError" })), "You rejected the request in your wallet.");
  assert.equal(walletErrorText(new Error("insufficient funds for gas * price + value")), "The wallet does not hold enough native gas for this transaction.");
  assert.equal(walletErrorText(Object.assign(new Error("long\ndetails"), { shortMessage: "Execution reverted: Ownable: caller is not the owner" })), "Execution reverted: Ownable: caller is not the owner");
  assert.equal(walletErrorText(new Error("first line\nsecond")), "first line");
});
