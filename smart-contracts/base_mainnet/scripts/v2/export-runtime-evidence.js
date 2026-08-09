"use strict";

const hre = require("hardhat");
const {
  CANONICAL_BASE_WETH,
  OFFICIAL_CANARY_DEPLOYMENTS,
  OFFICIAL_TYPED_CANARY_DEPLOYMENTS,
  UNISWAP_V2_ADAPTER_KIND,
  UNISWAP_V3_ADAPTER_KIND,
  canaryPolicyKey,
} = require("./lib/base-canary-policy");

const SCHEMA_VERSION_V1 =
  "kletia_base_intent_v2_deployment_v1";
const SCHEMA_VERSION_V2 =
  "kletia_base_intent_v2_deployment_v2";
const EXPECTED_CHAIN_ID = 8453n;

const EXPECTED_ACTION_KIND = hre.ethers.keccak256(
  hre.ethers.toUtf8Bytes("KLETIA_SWAP_EXACT_INPUT_V2"),
);
const EXPECTED_UNISWAP_V3_FORMAT_VERSION = hre.ethers.keccak256(
  hre.ethers.toUtf8Bytes(
    "KLETIA_UNISWAP_V3_EXACT_INPUT_PACKED_PATH_V1",
  ),
);
const PROPOSER_ROLE = hre.ethers.keccak256(
  hre.ethers.toUtf8Bytes("PROPOSER_ROLE"),
);
const CANCELLER_ROLE = hre.ethers.keccak256(
  hre.ethers.toUtf8Bytes("CANCELLER_ROLE"),
);
const EXECUTOR_ROLE = hre.ethers.keccak256(
  hre.ethers.toUtf8Bytes("EXECUTOR_ROLE"),
);
const MIN_TIMELOCK_DELAY_SECONDS = 172800n;
const MIN_SAFE_THRESHOLD = 2n;
const PROTOCOL_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/u;

const ROUTER_ABI = [
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function guardian() view returns (address)",
  "function treasury() view returns (address)",
  "function pendingTreasury() view returns (address)",
  "function wrappedNative() view returns (address)",
  "function wrappedNativeCodehash() view returns (bytes32)",
  "function feeBps() view returns (uint16)",
  "function MAX_FEE_BPS() view returns (uint16)",
  "function MAX_INTENT_TTL() view returns (uint48)",
  "function paused() view returns (bool)",
  "function adapterConfig(address adapter) view returns (bool configured,bool enabled,address target,address spender,bytes32 adapterCodehash,bytes32 targetCodehash,bytes32 spenderCodehash,bytes32 adapterConfigurationHash,bytes32 configHash)",
];

const TIMELOCK_ABI = [
  "function getMinDelay() view returns (uint256)",
  "function hasRole(bytes32 role,address account) view returns (bool)",
];

const SAFE_ABI = [
  "function getThreshold() view returns (uint256)",
  "function getOwners() view returns (address[])",
];

const UNISWAP_V2_ADAPTER_ABI = [
  "function actionKind() pure returns (bytes32)",
  "function target() view returns (address)",
  "function spender() view returns (address)",
  "function factory() view returns (address)",
  "function wrappedNative() view returns (address)",
  "function targetCodehash() view returns (bytes32)",
  "function factoryCodehash() view returns (bytes32)",
  "function wrappedNativeCodehash() view returns (bytes32)",
  "function configurationHash() view returns (bytes32)",
];

const ROUTER02_ABI = [
  "function factory() view returns (address)",
  "function WETH() view returns (address)",
];

const UNISWAP_V3_ADAPTER_ABI = [
  ...UNISWAP_V2_ADAPTER_ABI,
  "function ADAPTER_FORMAT_VERSION() pure returns (bytes32)",
];

const UNISWAP_V3_ROUTER02_ABI = [
  "function factory() view returns (address)",
  "function WETH9() view returns (address)",
];

function fail(message) {
  throw new Error(`V2_EVIDENCE_INVALID: ${message}`);
}

function checkedAddress(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`${label} is required`);
  }
  try {
    const address = hre.ethers.getAddress(value.trim());
    if (address === hre.ethers.ZeroAddress) {
      fail(`${label} cannot be zero`);
    }
    return address;
  } catch {
    fail(`${label} is not a valid address`);
  }
}

function sameAddress(left, right) {
  return left.toLowerCase() === right.toLowerCase();
}

function sameHash(left, right) {
  return left.toLowerCase() === right.toLowerCase();
}

function checkedExpectedFeeBps(value) {
  const normalized =
    typeof value === "string" ? value.trim() : "";
  if (!/^(?:0|[1-9]\d*)$/u.test(normalized)) {
    fail(
      "KLETIA_V2_EXPECTED_FEE_BPS must be a decimal integer between 0 and 100",
    );
  }
  const expectedFeeBps = Number(normalized);
  if (
    !Number.isSafeInteger(expectedFeeBps) ||
    expectedFeeBps < 0 ||
    expectedFeeBps > 100
  ) {
    fail(
      "KLETIA_V2_EXPECTED_FEE_BPS must be a decimal integer between 0 and 100",
    );
  }
  return expectedFeeBps;
}

function validateExpectedRouterFeeBps(value, expectedFeeBps) {
  if (typeof value !== "bigint" || value < 0n || value > 100n) {
    fail("router fee is outside the V2 hard cap");
  }
  if (
    !Number.isSafeInteger(expectedFeeBps) ||
    expectedFeeBps < 0 ||
    expectedFeeBps > 100
  ) {
    fail("expected router fee policy is invalid");
  }
  const feeBps = Number(value);
  if (feeBps !== expectedFeeBps) {
    fail(
      `router fee ${feeBps} bps does not match expected ${expectedFeeBps} bps`,
    );
  }
  return feeBps;
}

function checkedEvidenceSchemaVersion(value) {
  const schemaVersion = value || SCHEMA_VERSION_V1;
  if (
    schemaVersion !== SCHEMA_VERSION_V1 &&
    schemaVersion !== SCHEMA_VERSION_V2
  ) {
    fail("evidence schema version is not supported");
  }
  return schemaVersion;
}

function officialDeploymentForInput(adapterInput, expectedKind) {
  if (!adapterInput || adapterInput.kind !== expectedKind) {
    fail("adapter kind does not match the evidence exporter");
  }
  const schemaVersion = checkedEvidenceSchemaVersion(
    adapterInput.evidenceSchemaVersion,
  );
  let policyKey;
  try {
    policyKey = canaryPolicyKey(
      adapterInput.kind,
      adapterInput.protocolId,
    );
  } catch {
    fail("adapter policy identity is invalid");
  }
  if (
    adapterInput.policyKey !== undefined &&
    adapterInput.policyKey !== policyKey
  ) {
    fail("adapter policy key mismatch");
  }

  let official;
  if (schemaVersion === SCHEMA_VERSION_V1) {
    if (expectedKind !== UNISWAP_V2_ADAPTER_KIND) {
      fail("evidence schema v1 does not support this adapter kind");
    }
    official = Object.hasOwn(
      OFFICIAL_CANARY_DEPLOYMENTS,
      adapterInput.protocolId,
    )
      ? OFFICIAL_CANARY_DEPLOYMENTS[adapterInput.protocolId]
      : undefined;
  } else {
    official = Object.hasOwn(
      OFFICIAL_TYPED_CANARY_DEPLOYMENTS,
      policyKey,
    )
      ? OFFICIAL_TYPED_CANARY_DEPLOYMENTS[policyKey]
      : undefined;
  }
  if (!official) {
    fail("adapter identity is not enabled by the selected canary policy");
  }
  return { official, policyKey, schemaVersion };
}

function checkedAdapterInputs(
  encoded,
  requestedSchemaVersion = SCHEMA_VERSION_V1,
) {
  const schemaVersion = checkedEvidenceSchemaVersion(
    requestedSchemaVersion,
  );
  if (!encoded) fail("KLETIA_V2_ADAPTERS_JSON is required");
  let parsed;
  try {
    parsed = JSON.parse(encoded);
  } catch {
    fail("KLETIA_V2_ADAPTERS_JSON must be valid JSON");
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 32) {
    fail("adapter input must contain between 1 and 32 entries");
  }

  const seenPolicyKeys = new Set();
  const seenAdapters = new Set();
  const adapterInputs = parsed.map((entry, index) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      Object.keys(entry).some(
        (key) => !["kind", "protocolId", "adapter"].includes(key),
      )
    ) {
      fail(`adapter[${index}] has an unsupported shape`);
    }
    if (
      entry.kind !== UNISWAP_V2_ADAPTER_KIND &&
      entry.kind !== UNISWAP_V3_ADAPTER_KIND
    ) {
      fail(`adapter[${index}] kind is not supported`);
    }
    if (
      schemaVersion === SCHEMA_VERSION_V1 &&
      entry.kind !== UNISWAP_V2_ADAPTER_KIND
    ) {
      fail(`adapter[${index}] kind is not supported by evidence schema v1`);
    }
    if (
      typeof entry.protocolId !== "string" ||
      !PROTOCOL_ID_PATTERN.test(entry.protocolId)
    ) {
      fail(`adapter[${index}] protocolId is invalid`);
    }
    let policyKey;
    try {
      policyKey = canaryPolicyKey(entry.kind, entry.protocolId);
    } catch {
      fail(`adapter[${index}] policy identity is invalid`);
    }
    const official =
      schemaVersion === SCHEMA_VERSION_V1
        ? Object.hasOwn(
          OFFICIAL_CANARY_DEPLOYMENTS,
          entry.protocolId,
        )
          ? OFFICIAL_CANARY_DEPLOYMENTS[entry.protocolId]
          : undefined
        : Object.hasOwn(
          OFFICIAL_TYPED_CANARY_DEPLOYMENTS,
          policyKey,
        )
          ? OFFICIAL_TYPED_CANARY_DEPLOYMENTS[policyKey]
          : undefined;
    if (!official) {
      fail(`adapter[${index}] is not enabled by the selected canary policy`);
    }
    const adapter = checkedAddress(
      entry.adapter,
      `adapter[${index}].adapter`,
    );
    const adapterKey = adapter.toLowerCase();
    if (seenPolicyKeys.has(policyKey) || seenAdapters.has(adapterKey)) {
      fail(`adapter[${index}] duplicates a policy identity or adapter`);
    }
    seenPolicyKeys.add(policyKey);
    seenAdapters.add(adapterKey);
    return {
      kind: entry.kind,
      protocolId: entry.protocolId,
      adapter,
      evidenceSchemaVersion: schemaVersion,
      policyKey,
    };
  });

  if (
    schemaVersion === SCHEMA_VERSION_V2 &&
    !adapterInputs.some(
      ({ kind }) => kind === UNISWAP_V3_ADAPTER_KIND,
    )
  ) {
    fail("evidence schema v2 requires a reviewed Uniswap V3 adapter");
  }
  return adapterInputs;
}

async function runtimeCodehash(provider, address, blockTag, label) {
  const code = await provider.getCode(address, blockTag);
  if (code === "0x") fail(`${label} has no runtime bytecode`);
  return hre.ethers.keccak256(code);
}

async function validateSafeShape(provider, address, blockTag, label) {
  await runtimeCodehash(provider, address, blockTag, label);
  const safe = new hre.ethers.Contract(address, SAFE_ABI, provider);
  let threshold;
  let owners;
  try {
    [threshold, owners] = await Promise.all([
      safe.getThreshold({ blockTag }),
      safe.getOwners({ blockTag }),
    ]);
  } catch {
    fail(`${label} does not expose the required Safe owner policy`);
  }
  if (
    threshold < MIN_SAFE_THRESHOLD ||
    !Array.isArray(owners) ||
    BigInt(owners.length) < threshold ||
    owners.length > 50
  ) {
    fail(`${label} has an unsafe threshold or owner set`);
  }
  const normalizedOwners = owners.map((owner, index) =>
    checkedAddress(owner, `${label}.owner[${index}]`),
  );
  if (
    new Set(
      normalizedOwners.map((owner) => owner.toLowerCase()),
    ).size !== normalizedOwners.length
  ) {
    fail(`${label} contains duplicate owners`);
  }
}

async function validateGovernanceTopology({
  provider,
  router,
  routerAddress,
  timelockAddress,
  governanceSafe,
  guardianSafe,
  treasurySafe,
  blockTag,
}) {
  const topology = [
    routerAddress,
    timelockAddress,
    governanceSafe,
    guardianSafe,
    treasurySafe,
  ];
  if (
    new Set(topology.map((address) => address.toLowerCase())).size !==
    topology.length
  ) {
    fail("router and governance topology addresses must be distinct");
  }

  await Promise.all([
    runtimeCodehash(
      provider,
      timelockAddress,
      blockTag,
      "governance timelock",
    ),
    validateSafeShape(
      provider,
      governanceSafe,
      blockTag,
      "governance Safe",
    ),
    validateSafeShape(
      provider,
      guardianSafe,
      blockTag,
      "guardian Safe",
    ),
    validateSafeShape(
      provider,
      treasurySafe,
      blockTag,
      "treasury Safe",
    ),
  ]);

  const timelock = new hre.ethers.Contract(
    timelockAddress,
    TIMELOCK_ABI,
    provider,
  );
  const [
    owner,
    pendingOwner,
    guardian,
    treasury,
    pendingTreasury,
    maxFeeBps,
    maxIntentTtl,
    minDelay,
    governanceCanPropose,
    governanceCanCancel,
    executionIsOpen,
    timelockIsAdmin,
    governanceIsAdmin,
    guardianCanPropose,
    guardianCanCancel,
    treasuryCanPropose,
    treasuryCanCancel,
  ] = await Promise.all([
    router.owner({ blockTag }),
    router.pendingOwner({ blockTag }),
    router.guardian({ blockTag }),
    router.treasury({ blockTag }),
    router.pendingTreasury({ blockTag }),
    router.MAX_FEE_BPS({ blockTag }),
    router.MAX_INTENT_TTL({ blockTag }),
    timelock.getMinDelay({ blockTag }),
    timelock.hasRole(PROPOSER_ROLE, governanceSafe, { blockTag }),
    timelock.hasRole(CANCELLER_ROLE, governanceSafe, { blockTag }),
    timelock.hasRole(EXECUTOR_ROLE, hre.ethers.ZeroAddress, {
      blockTag,
    }),
    timelock.hasRole(hre.ethers.ZeroHash, timelockAddress, {
      blockTag,
    }),
    timelock.hasRole(hre.ethers.ZeroHash, governanceSafe, {
      blockTag,
    }),
    timelock.hasRole(PROPOSER_ROLE, guardianSafe, { blockTag }),
    timelock.hasRole(CANCELLER_ROLE, guardianSafe, { blockTag }),
    timelock.hasRole(PROPOSER_ROLE, treasurySafe, { blockTag }),
    timelock.hasRole(CANCELLER_ROLE, treasurySafe, { blockTag }),
  ]);

  if (!sameAddress(pendingOwner, hre.ethers.ZeroAddress)) {
    fail("router pending owner must be zero");
  }

  if (
    !sameAddress(owner, timelockAddress) ||
    !sameAddress(guardian, guardianSafe) ||
    !sameAddress(treasury, treasurySafe) ||
    !sameAddress(pendingTreasury, hre.ethers.ZeroAddress) ||
    maxFeeBps !== 100n ||
    maxIntentTtl !== 3600n ||
    minDelay < MIN_TIMELOCK_DELAY_SECONDS ||
    !governanceCanPropose ||
    !governanceCanCancel ||
    !executionIsOpen ||
    !timelockIsAdmin ||
    governanceIsAdmin ||
    guardianCanPropose ||
    guardianCanCancel ||
    treasuryCanPropose ||
    treasuryCanCancel
  ) {
    fail("router governance or Timelock role topology mismatch");
  }
}

async function exportUniV2AdapterEvidence({
  provider,
  router,
  routerAddress,
  wrappedNative,
  wrappedNativeCodehash,
  adapterInput,
  blockTag,
}) {
  const adapter = new hre.ethers.Contract(
    adapterInput.adapter,
    UNISWAP_V2_ADAPTER_ABI,
    provider,
  );
  const [
    actionKind,
    target,
    spender,
    factory,
    adapterWrappedNative,
    declaredTargetCodehash,
    declaredFactoryCodehash,
    declaredWrappedNativeCodehash,
    adapterConfigurationHash,
    routerConfig,
  ] = await Promise.all([
    adapter.actionKind({ blockTag }),
    adapter.getFunction("target").staticCall({ blockTag }),
    adapter.spender({ blockTag }),
    adapter.factory({ blockTag }),
    adapter.wrappedNative({ blockTag }),
    adapter.targetCodehash({ blockTag }),
    adapter.factoryCodehash({ blockTag }),
    adapter.wrappedNativeCodehash({ blockTag }),
    adapter.configurationHash({ blockTag }),
    router.adapterConfig(adapterInput.adapter, { blockTag }),
  ]);

  const checkedTarget = checkedAddress(target, "adapter.target");
  const checkedSpender = checkedAddress(spender, "adapter.spender");
  const checkedFactory = checkedAddress(factory, "adapter.factory");
  const checkedAdapterWeth = checkedAddress(
    adapterWrappedNative,
    "adapter.wrappedNative",
  );
  if (!sameHash(actionKind, EXPECTED_ACTION_KIND)) {
    fail(`${adapterInput.protocolId} actionKind mismatch`);
  }
  const { official, policyKey, schemaVersion } =
    officialDeploymentForInput(
      adapterInput,
      UNISWAP_V2_ADAPTER_KIND,
    );
  if (
    !sameAddress(checkedTarget, official.router) ||
    !sameAddress(checkedSpender, official.router) ||
    !sameAddress(checkedFactory, official.factory)
  ) {
    fail(`${adapterInput.protocolId} official Base identity mismatch`);
  }
  if (!sameAddress(checkedAdapterWeth, wrappedNative)) {
    fail(`${adapterInput.protocolId} wrapped-native mismatch`);
  }

  const router02 = new hre.ethers.Contract(
    checkedTarget,
    ROUTER02_ABI,
    provider,
  );
  const [
    adapterCodehash,
    targetCodehash,
    spenderCodehash,
    factoryCodehash,
    routerFactory,
    routerWeth,
  ] = await Promise.all([
    runtimeCodehash(
      provider,
      adapterInput.adapter,
      blockTag,
      `${adapterInput.protocolId} adapter`,
    ),
    runtimeCodehash(
      provider,
      checkedTarget,
      blockTag,
      `${adapterInput.protocolId} target`,
    ),
    runtimeCodehash(
      provider,
      checkedSpender,
      blockTag,
      `${adapterInput.protocolId} spender`,
    ),
    runtimeCodehash(
      provider,
      checkedFactory,
      blockTag,
      `${adapterInput.protocolId} factory`,
    ),
    router02.factory({ blockTag }),
    router02.WETH({ blockTag }),
  ]);

  if (
    !routerConfig.configured ||
    !routerConfig.enabled ||
    !sameAddress(routerConfig.target, checkedTarget) ||
    !sameAddress(routerConfig.spender, checkedSpender) ||
    !sameHash(routerConfig.adapterCodehash, adapterCodehash) ||
    !sameHash(routerConfig.targetCodehash, targetCodehash) ||
    !sameHash(routerConfig.spenderCodehash, spenderCodehash) ||
    !sameHash(
      routerConfig.adapterConfigurationHash,
      adapterConfigurationHash,
    ) ||
    !sameHash(declaredTargetCodehash, targetCodehash) ||
    !sameHash(declaredFactoryCodehash, factoryCodehash) ||
    !sameHash(
      declaredWrappedNativeCodehash,
      wrappedNativeCodehash,
    ) ||
    !sameAddress(routerFactory, checkedFactory) ||
    !sameAddress(routerWeth, wrappedNative)
  ) {
    fail(`${adapterInput.protocolId} live identity/configuration mismatch`);
  }

  return {
    kind: UNISWAP_V2_ADAPTER_KIND,
    reviewStatus: "reviewed",
    protocolId: adapterInput.protocolId,
    ...(schemaVersion === SCHEMA_VERSION_V2
      ? { policyKey }
      : {}),
    enabled: true,
    adapter: adapterInput.adapter,
    target: checkedTarget,
    spender: checkedSpender,
    factory: checkedFactory,
    adapterCodehash,
    targetCodehash,
    spenderCodehash,
    factoryCodehash,
    adapterConfigurationHash,
    adapterConfigHash: routerConfig.configHash,
  };
}

async function exportUniswapV3AdapterEvidence({
  provider,
  router,
  wrappedNative,
  wrappedNativeCodehash,
  adapterInput,
  blockTag,
}) {
  const { official, policyKey, schemaVersion } =
    officialDeploymentForInput(
      adapterInput,
      UNISWAP_V3_ADAPTER_KIND,
    );
  if (schemaVersion !== SCHEMA_VERSION_V2) {
    fail("Uniswap V3 evidence requires deployment schema v2");
  }

  const adapterAddress = checkedAddress(
    adapterInput.adapter,
    `${adapterInput.protocolId} adapter`,
  );
  const adapter = new hre.ethers.Contract(
    adapterAddress,
    UNISWAP_V3_ADAPTER_ABI,
    provider,
  );
  const [
    actionKind,
    adapterFormatVersion,
    target,
    spender,
    factory,
    adapterWrappedNative,
    declaredTargetCodehash,
    declaredFactoryCodehash,
    declaredWrappedNativeCodehash,
    adapterConfigurationHash,
    routerConfig,
  ] = await Promise.all([
    adapter.actionKind({ blockTag }),
    adapter.ADAPTER_FORMAT_VERSION({ blockTag }),
    adapter.getFunction("target").staticCall({ blockTag }),
    adapter.spender({ blockTag }),
    adapter.factory({ blockTag }),
    adapter.wrappedNative({ blockTag }),
    adapter.targetCodehash({ blockTag }),
    adapter.factoryCodehash({ blockTag }),
    adapter.wrappedNativeCodehash({ blockTag }),
    adapter.configurationHash({ blockTag }),
    router.adapterConfig(adapterAddress, { blockTag }),
  ]);

  const checkedTarget = checkedAddress(target, "adapter.target");
  const checkedSpender = checkedAddress(spender, "adapter.spender");
  const checkedFactory = checkedAddress(factory, "adapter.factory");
  const checkedAdapterWeth = checkedAddress(
    adapterWrappedNative,
    "adapter.wrappedNative",
  );
  if (!sameHash(actionKind, EXPECTED_ACTION_KIND)) {
    fail(`${adapterInput.protocolId} actionKind mismatch`);
  }
  if (
    !sameHash(
      adapterFormatVersion,
      EXPECTED_UNISWAP_V3_FORMAT_VERSION,
    )
  ) {
    fail(`${adapterInput.protocolId} V3 adapter format mismatch`);
  }
  if (
    !sameAddress(checkedTarget, official.router) ||
    !sameAddress(checkedSpender, official.router) ||
    !sameAddress(checkedFactory, official.factory)
  ) {
    fail(`${adapterInput.protocolId} official Base V3 identity mismatch`);
  }
  if (!sameAddress(checkedAdapterWeth, wrappedNative)) {
    fail(`${adapterInput.protocolId} wrapped-native mismatch`);
  }

  const router02 = new hre.ethers.Contract(
    checkedTarget,
    UNISWAP_V3_ROUTER02_ABI,
    provider,
  );
  const [
    adapterCodehash,
    targetCodehash,
    spenderCodehash,
    factoryCodehash,
    routerFactory,
    routerWeth,
  ] = await Promise.all([
    runtimeCodehash(
      provider,
      adapterAddress,
      blockTag,
      `${adapterInput.protocolId} V3 adapter`,
    ),
    runtimeCodehash(
      provider,
      checkedTarget,
      blockTag,
      `${adapterInput.protocolId} V3 target`,
    ),
    runtimeCodehash(
      provider,
      checkedSpender,
      blockTag,
      `${adapterInput.protocolId} V3 spender`,
    ),
    runtimeCodehash(
      provider,
      checkedFactory,
      blockTag,
      `${adapterInput.protocolId} V3 factory`,
    ),
    router02.factory({ blockTag }),
    router02.WETH9({ blockTag }),
  ]);

  if (
    !routerConfig.configured ||
    !routerConfig.enabled ||
    !sameAddress(routerConfig.target, checkedTarget) ||
    !sameAddress(routerConfig.spender, checkedSpender) ||
    !sameHash(routerConfig.adapterCodehash, adapterCodehash) ||
    !sameHash(routerConfig.targetCodehash, targetCodehash) ||
    !sameHash(routerConfig.spenderCodehash, spenderCodehash) ||
    !sameHash(
      routerConfig.adapterConfigurationHash,
      adapterConfigurationHash,
    ) ||
    !sameHash(declaredTargetCodehash, targetCodehash) ||
    !sameHash(declaredFactoryCodehash, factoryCodehash) ||
    !sameHash(
      declaredWrappedNativeCodehash,
      wrappedNativeCodehash,
    ) ||
    !sameAddress(routerFactory, checkedFactory) ||
    !sameAddress(routerWeth, wrappedNative)
  ) {
    fail(`${adapterInput.protocolId} live V3 identity/configuration mismatch`);
  }

  return {
    kind: UNISWAP_V3_ADAPTER_KIND,
    reviewStatus: "reviewed",
    protocolId: adapterInput.protocolId,
    policyKey,
    enabled: true,
    adapter: adapterAddress,
    target: checkedTarget,
    spender: checkedSpender,
    factory: checkedFactory,
    adapterCodehash,
    targetCodehash,
    spenderCodehash,
    factoryCodehash,
    adapterFormatVersion,
    adapterConfigurationHash,
    adapterConfigHash: routerConfig.configHash,
  };
}

async function main() {
  const provider = hre.ethers.provider;
  const network = await provider.getNetwork();
  if (network.chainId !== EXPECTED_CHAIN_ID) {
    fail(`expected Base mainnet 8453, received ${network.chainId}`);
  }

  const routerAddress = checkedAddress(
    process.env.KLETIA_V2_ROUTER_ADDRESS,
    "KLETIA_V2_ROUTER_ADDRESS",
  );
  const schemaVersion = checkedEvidenceSchemaVersion(
    process.env.KLETIA_V2_EVIDENCE_SCHEMA_VERSION?.trim() ||
      SCHEMA_VERSION_V1,
  );
  const adapterInputs = checkedAdapterInputs(
    process.env.KLETIA_V2_ADAPTERS_JSON,
    schemaVersion,
  );
  const expectedFeeBps = checkedExpectedFeeBps(
    process.env.KLETIA_V2_EXPECTED_FEE_BPS,
  );
  const timelockAddress = checkedAddress(
    process.env.KLETIA_V2_TIMELOCK_ADDRESS,
    "KLETIA_V2_TIMELOCK_ADDRESS",
  );
  const governanceSafe = checkedAddress(
    process.env.KLETIA_V2_GOVERNANCE_SAFE,
    "KLETIA_V2_GOVERNANCE_SAFE",
  );
  const guardianSafe = checkedAddress(
    process.env.KLETIA_V2_GUARDIAN_SAFE,
    "KLETIA_V2_GUARDIAN_SAFE",
  );
  const treasurySafe = checkedAddress(
    process.env.KLETIA_V2_TREASURY_SAFE,
    "KLETIA_V2_TREASURY_SAFE",
  );
  const blockTag = await provider.getBlockNumber();
  if (!Number.isSafeInteger(blockTag) || blockTag <= 0) {
    fail("provider returned an invalid block number");
  }

  const router = new hre.ethers.Contract(
    routerAddress,
    ROUTER_ABI,
    provider,
  );
  await validateGovernanceTopology({
    provider,
    router,
    routerAddress,
    timelockAddress,
    governanceSafe,
    guardianSafe,
    treasurySafe,
    blockTag,
  });
  const [
    wrappedNativeValue,
    declaredWrappedNativeCodehash,
    feeBpsValue,
    paused,
    routerCodehash,
  ] = await Promise.all([
    router.wrappedNative({ blockTag }),
    router.wrappedNativeCodehash({ blockTag }),
    router.feeBps({ blockTag }),
    router.paused({ blockTag }),
    runtimeCodehash(provider, routerAddress, blockTag, "V2 router"),
  ]);
  if (paused) fail("router is paused");

  const wrappedNative = checkedAddress(
    wrappedNativeValue,
    "router.wrappedNative",
  );
  if (!sameAddress(wrappedNative, CANONICAL_BASE_WETH)) {
    fail("router does not use canonical Base WETH");
  }
  const wrappedNativeCodehash = await runtimeCodehash(
    provider,
    wrappedNative,
    blockTag,
    "wrapped native",
  );
  if (
    !sameHash(
      declaredWrappedNativeCodehash,
      wrappedNativeCodehash,
    )
  ) {
    fail("router wrapped-native codehash mismatch");
  }
  const feeBps = validateExpectedRouterFeeBps(
    feeBpsValue,
    expectedFeeBps,
  );

  const adapters = [];
  for (const adapterInput of adapterInputs) {
    const exportContext = {
      provider,
      router,
      routerAddress,
      wrappedNative,
      wrappedNativeCodehash,
      adapterInput,
      blockTag,
    };
    if (adapterInput.kind === UNISWAP_V2_ADAPTER_KIND) {
      adapters.push(
        await exportUniV2AdapterEvidence(exportContext),
      );
    } else if (adapterInput.kind === UNISWAP_V3_ADAPTER_KIND) {
      adapters.push(
        await exportUniswapV3AdapterEvidence(exportContext),
      );
    } else {
      fail("adapter kind has no evidence exporter");
    }
  }

  const evidence = {
    schemaVersion,
    validationStatus: "validated",
    chainId: Number(EXPECTED_CHAIN_ID),
    observedAtBlock: String(blockTag),
    router: routerAddress,
    routerCodehash,
    wrappedNative,
    wrappedNativeCodehash,
    feeBps,
    adapters,
  };
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
}

function reportMainFailure(error) {
  const message =
    error instanceof Error ? error.message : "unknown evidence failure";
  console.error(message.replace(/[\r\n]+/gu, " ").slice(0, 500));
  process.exitCode = 1;
}

if (require.main === module) {
  main().catch(reportMainFailure);
}

module.exports = {
  SCHEMA_VERSION_V1,
  SCHEMA_VERSION_V2,
  checkedAdapterInputs,
  checkedEvidenceSchemaVersion,
  checkedExpectedFeeBps,
  exportUniV2AdapterEvidence,
  exportUniswapV3AdapterEvidence,
  main,
  officialDeploymentForInput,
  runtimeCodehash,
  validateGovernanceTopology,
  validateExpectedRouterFeeBps,
  validateSafeShape,
};
