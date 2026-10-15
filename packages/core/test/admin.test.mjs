import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { getAddress } from "viem";
import {
  ADMIN_CONTRACTS,
  ADMIN_DEPLOY_TARGETS,
  ADMIN_EVM_NETWORKS,
  ADMIN_NETWORK_CONSTANTS,
  ADMIN_NO_PROGRAM_NETWORKS,
  ADMIN_PINNED_DEPLOYMENTS,
  ADMIN_SIGN_IN_REQUEST_ID,
  ADMIN_SIGN_IN_STATEMENT,
  CHAINS,
  adminTargetId,
  adminTargetsFor,
} from "../dist/index.js";
import { ARTIFACTS } from "../../../tooling/export-contract-artifacts.mjs";

const root = new URL("../../../", import.meta.url);
const exported = JSON.parse(readFileSync(new URL("apps/api/src/admin/contract-artifacts/kletia-contracts.json", root), "utf8"));
const baseManifest = JSON.parse(readFileSync(new URL("contracts/base/deployments/base-mainnet-v2.json", root), "utf8"));
const arcManifest = JSON.parse(readFileSync(new URL("contracts/arc/deployments/arc-testnet.json", root), "utf8"));

test("admin targets: unique well-formed ids on EVM networks only", () => {
  const ids = ADMIN_DEPLOY_TARGETS.map((target) => target.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const target of ADMIN_DEPLOY_TARGETS) {
    assert.equal(target.id, adminTargetId(target.network, target.contractId, target.instance));
    assert.match(target.id, /^[a-z-]+:[a-z0-9-]+(?::[a-z0-9]+)?$/u);
    assert.equal(CHAINS[target.network].vm, "evm", target.id);
    assert.ok(ADMIN_EVM_NETWORKS.includes(target.network));
    assert.ok(ADMIN_CONTRACTS[target.contractId], target.id);
  }
  for (const network of ADMIN_NO_PROGRAM_NETWORKS) {
    assert.equal(CHAINS[network].vm, "svm");
    assert.equal(ADMIN_DEPLOY_TARGETS.filter((target) => target.network === network).length, 0);
  }
});

test("admin targets: dependencies exist on the same network with a lower order", () => {
  for (const target of ADMIN_DEPLOY_TARGETS) {
    for (const dependency of target.dependsOn) {
      const found = ADMIN_DEPLOY_TARGETS.find((entry) => entry.id === dependency);
      assert.ok(found, `${target.id} -> ${dependency}`);
      assert.equal(found.network, target.network);
      assert.ok(found.order < target.order, `${target.id} -> ${dependency}`);
    }
    const orders = adminTargetsFor(target.network).map((entry) => entry.order);
    assert.deepEqual(orders, [...orders].sort((a, b) => a - b));
  }
});

test("admin catalog: the Uniswap V3 adapter is never deployable", () => {
  for (const target of ADMIN_DEPLOY_TARGETS.filter((entry) => entry.contractId === "uniswap-v3-adapter")) {
    assert.notEqual(target.status, "deployable", target.id);
    assert.notEqual(target.status, "pinned", target.id);
  }
  assert.equal(ADMIN_CONTRACTS["uniswap-v3-adapter"].lifecycle, "quarantined");
});

test("admin catalog: constructor inputs equal the exported artifact ABI", () => {
  for (const spec of Object.values(ADMIN_CONTRACTS)) {
    if (spec.constructorInputs.length === 0) continue;
    const artifact = exported.artifacts[spec.artifactId];
    assert.ok(artifact, spec.artifactId);
    assert.equal(artifact.deployable, true, spec.artifactId);
    assert.ok(artifact.bytecode && artifact.maskedRuntimeHash, spec.artifactId);
    const constructor = artifact.abi.find((item) => item.type === "constructor");
    assert.deepEqual(
      spec.constructorInputs.map((input) => `${input.type} ${input.name}`),
      constructor.inputs.map((input) => `${input.type} ${input.name}`),
      spec.id,
    );
  }
  for (const spec of Object.values(ADMIN_CONTRACTS)) {
    if (!spec.artifactId) continue;
    const artifact = exported.artifacts[spec.artifactId];
    assert.ok(artifact, spec.artifactId);
    for (const fn of spec.reads) assert.ok(artifact.abi.some((item) => item.type === "function" && item.name === fn && item.inputs.length === 0), `${spec.id}.${fn}`);
    for (const action of spec.actions) assert.ok(artifact.abi.some((item) => item.type === "function" && item.name === action.fn), `${spec.id}.${action.fn}`);
  }
});

test("admin catalog: the artifact export list equals the catalog artifact ids", () => {
  const catalogIds = new Set(Object.values(ADMIN_CONTRACTS).map((spec) => spec.artifactId).filter(Boolean));
  assert.deepEqual(new Set(ARTIFACTS.map(([id]) => id)), catalogIds);
  assert.deepEqual(Object.keys(exported.artifacts), ARTIFACTS.map(([id]) => id));
});

test("admin catalog: pinned and constant addresses are checksummed and equal the manifests", () => {
  for (const entry of ADMIN_PINNED_DEPLOYMENTS) {
    assert.equal(entry.address, getAddress(entry.address), entry.address);
    if (entry.owner) assert.equal(entry.owner, getAddress(entry.owner));
  }
  for (const constants of Object.values(ADMIN_NETWORK_CONSTANTS)) {
    for (const key of ["wrappedNative", "uniswapV2Router", "uniswapV2Factory", "arcForwarder", "arcKlet", "arcSwap"]) {
      if (constants[key]) assert.equal(constants[key], getAddress(constants[key]), `${constants.network}.${key}`);
    }
  }
  const pinned = (network, contractId) => ADMIN_PINNED_DEPLOYMENTS.filter((entry) => entry.network === network && entry.contractId === contractId);
  const c = baseManifest.contracts;
  assert.equal(pinned("base", "intent-router-v2")[0].address, c.intentRouterV2.address);
  assert.equal(pinned("base", "intent-router-v2")[0].runtimeCodehash, c.intentRouterV2.runtimeCodehash);
  assert.equal(pinned("base", "uniswap-v2-adapter")[0].address, c.uniswapV2CompatibleAdapter.address);
  assert.equal(pinned("base", "launch-factory-v2")[0].address, c.launchFactoryV2.address);
  assert.equal(pinned("base", "x402-attestation-registry-v1")[0].address, c.x402AttestationRegistryV1.address);
  assert.equal(pinned("base", "x402-factory")[0].address, baseManifest.supportingContracts.x402Factory.address);
  assert.deepEqual(pinned("base", "x402-gateway").map((entry) => entry.address), baseManifest.supportingContracts.x402Gateways.addresses);
  assert.equal(pinned("base", "legacy-smart-router")[0].address, baseManifest.legacyFeeRouterCleanup.router);
  assert.equal(pinned("base", "legacy-timelock")[0].address, baseManifest.supersededDeployments[0].governance.timelock.address);
  assert.deepEqual(ADMIN_NETWORK_CONSTANTS.base.defaultRoles, {
    owner: baseManifest.governance.governanceSafe.address, guardian: baseManifest.governance.guardianSafe.address, treasury: baseManifest.governance.treasurySafe.address,
  });
  assert.deepEqual(ADMIN_NETWORK_CONSTANTS.base.safeOwners[baseManifest.governance.governanceSafe.address], baseManifest.governance.owners);
  const arc = arcManifest;
  assert.equal(pinned("arc", "arc-forwarder")[0].address, arc.trustRoots.erc2771Forwarder.address);
  assert.equal(pinned("arc", "arc-klet-token")[0].address, arc.trustRoots.kletToken.address);
  for (const [key, contractId] of [["swap", "arc-swap"], ["lending", "arc-lending"], ["batchPay", "arc-batch-pay"], ["vault", "arc-vault-v2"], ["memoTransfer", "arc-memo-transfer"], ["agentRegistry", "arc-agent-registry"], ["staking", "arc-staking"]]) {
    assert.equal(pinned("arc", contractId)[0].address, arc.applicationContracts[key].address, contractId);
  }
  assert.equal(pinned("arc", "arc-vault-v1")[0].address, arc.legacyDeployments.vaultV1.address);
  assert.equal(pinned("arc", "arc-otc")[0].address, arc.legacyDeployments.otc.address);
});

test("admin sign-in constants", () => {
  assert.equal(ADMIN_SIGN_IN_REQUEST_ID, "adm_login");
  assert.match(ADMIN_SIGN_IN_STATEMENT, /does not move funds/u);
});
