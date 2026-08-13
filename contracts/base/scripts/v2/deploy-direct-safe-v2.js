"use strict";

const fs = require("node:fs");
const path = require("node:path");
const hre = require("hardhat");
const dotenv = require("dotenv");

const { ethers } = hre;
const BASE_CHAIN_ID = 8_453n;
const GOVERNANCE_SAFE = "0x84f19Fdfd8C50C6349BFe86Cd90BE131387ab47D";
const GUARDIAN_SAFE = "0xCae3520A4348BEB2b74Ef52E8be2dE06f57fC0Bc";
const TREASURY_SAFE = "0x64261D1AC0133FB1BB2153e1dCa7B081cd9d05fC";
const EXISTING_UNISWAP_V2_ADAPTER =
  "0xb21C455ceE9ECb4BD0cf19A88d771065db45592b";
const BASE_WETH = "0x4200000000000000000000000000000000000006";
const EXPECTED_OWNERS = [
  "0xFf3a3CFC42D27E85DbA9Ea85f0bFEC34bd632f9A",
  "0x8c5281055B197443fF01dbBDFBf29fD63946cA1E",
].map((address) => ethers.getAddress(address));
const ROUTER_FEE_BPS = 10;
const MIN_BALANCE_BUFFER_WEI = ethers.parseEther("0.00012");
const ZERO_ADDRESS = ethers.ZeroAddress;
const MANIFEST_PATH = path.resolve(
  __dirname,
  "../../deployments/base-mainnet-v2.json",
);

const SAFE_ABI = [
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function nonce() view returns (uint256)",
  "function getTransactionHash(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 _nonce) view returns (bytes32)",
  "function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address payable refundReceiver,bytes signatures) returns (bool success)",
];
const ROUTER_ABI = [
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function guardian() view returns (address)",
  "function treasury() view returns (address)",
  "function pendingTreasury() view returns (address)",
  "function wrappedNative() view returns (address)",
  "function feeBps() view returns (uint16)",
  "function paused() view returns (bool)",
  "function configureAdapter(address adapter,bool enabled)",
  "function adapterConfig(address adapter) view returns (bool configured,bool enabled,address target,address spender,bytes32 adapterCodehash,bytes32 targetCodehash,bytes32 spenderCodehash,bytes32 adapterConfigurationHash,bytes32 configHash)",
];
const FACTORY_ABI = [
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function treasury() view returns (address)",
  "function pendingTreasury() view returns (address)",
  "function deploymentFee() view returns (uint256)",
];
const REGISTRY_ABI = [
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function guardian() view returns (address)",
];

function fail(message) {
  throw new Error(message);
}

function normalizedKey(value, label) {
  const raw = value?.trim();
  if (!raw) fail(`${label} is required.`);
  const key = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/u.test(key)) fail(`${label} is invalid.`);
  return key;
}

function sameAddress(left, right) {
  return ethers.getAddress(left) === ethers.getAddress(right);
}

function checkedCodehash(code) {
  if (code === "0x") fail("Expected deployed runtime bytecode.");
  return ethers.keccak256(code);
}

function loadSignerKeys() {
  const baseEnvironment = dotenv.parse(
    fs.readFileSync(path.resolve(__dirname, "../../.env")),
  );
  const arcEnvironment = dotenv.parse(
    fs.readFileSync(path.resolve(__dirname, "../../../arc/.env")),
  );
  return [
    normalizedKey(baseEnvironment.BASE_PRIVATE_KEY, "BASE_PRIVATE_KEY"),
    normalizedKey(arcEnvironment.ARC_PRIVATE_KEY, "ARC_PRIVATE_KEY"),
  ];
}

async function validateSafe(provider, address, exactOwners = false) {
  const safe = new ethers.Contract(address, SAFE_ABI, provider);
  const [owners, threshold, runtimeCode] = await Promise.all([
    safe.getOwners(),
    safe.getThreshold(),
    provider.getCode(address),
  ]);
  checkedCodehash(runtimeCode);
  if (threshold < 2n) fail(`Unsafe Safe threshold at ${address}.`);
  if (exactOwners) {
    const actual = owners.map(ethers.getAddress).sort();
    const expected = [...EXPECTED_OWNERS].sort();
    if (
      threshold !== 2n ||
      actual.length !== expected.length ||
      actual.some((owner, index) => owner !== expected[index])
    ) {
      fail("Governance Safe is not the expected direct 2-of-2 authority.");
    }
  }
  return safe;
}

function sortedSafeSignatures(wallets, digest) {
  return `0x${wallets
    .map((wallet) => ({
      owner: ethers.getAddress(wallet.address),
      signature: wallet.signingKey.sign(digest).serialized.slice(2),
    }))
    .sort((left, right) =>
      left.owner.toLowerCase().localeCompare(right.owner.toLowerCase()),
    )
    .map(({ signature }) => signature)
    .join("")}`;
}

async function executeSafeCall({ safe, wallets, submitter, to, data }) {
  const safeNonce = await safe.nonce();
  const values = [
    to,
    0n,
    data,
    0,
    0n,
    0n,
    0n,
    ZERO_ADDRESS,
    ZERO_ADDRESS,
    safeNonce,
  ];
  const digest = await safe.getTransactionHash(...values);
  const signatures = sortedSafeSignatures(wallets, digest);
  const args = [...values.slice(0, 9), signatures];
  const connected = safe.connect(submitter);
  if ((await connected.execTransaction.staticCall(...args)) !== true) {
    fail("Governance Safe execution simulation failed.");
  }
  const estimate = await connected.execTransaction.estimateGas(...args);
  const transaction = await connected.execTransaction(...args, {
    gasLimit: (estimate * 13n) / 10n,
  });
  const receipt = await transaction.wait();
  if (!receipt || receipt.status !== 1) fail("Governance Safe execution failed.");
  let observedNonce = await safe.nonce();
  for (
    let attempt = 0;
    observedNonce !== safeNonce + 1n && attempt < 10;
    attempt += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    observedNonce = await safe.nonce({ blockTag: "latest" });
  }
  if (observedNonce !== safeNonce + 1n) {
    fail("Governance Safe nonce did not advance exactly once.");
  }
  return { hash: transaction.hash, blockNumber: String(receipt.blockNumber) };
}

async function deploy(factoryName, constructorArguments, signer) {
  const factory = await ethers.getContractFactory(factoryName, signer);
  const contract = await factory.deploy(...constructorArguments);
  const transaction = contract.deploymentTransaction();
  if (!transaction) fail(`${factoryName} deployment transaction missing.`);
  const receipt = await transaction.wait();
  if (!receipt || receipt.status !== 1) fail(`${factoryName} deployment failed.`);
  await contract.waitForDeployment();
  return {
    address: ethers.getAddress(await contract.getAddress()),
    transactionHash: transaction.hash,
    blockNumber: String(receipt.blockNumber),
  };
}

async function validatePostState(provider, deployments) {
  const router = new ethers.Contract(deployments.router.address, ROUTER_ABI, provider);
  const factory = new ethers.Contract(deployments.factory.address, FACTORY_ABI, provider);
  const registry = new ethers.Contract(deployments.registry.address, REGISTRY_ABI, provider);
  const [
    routerOwner,
    routerPendingOwner,
    guardian,
    treasury,
    pendingTreasury,
    wrappedNative,
    feeBps,
    paused,
    adapterConfig,
    factoryOwner,
    factoryPendingOwner,
    factoryTreasury,
    factoryPendingTreasury,
    deploymentFee,
    registryOwner,
    registryPendingOwner,
    registryGuardian,
  ] = await Promise.all([
    router.owner(),
    router.pendingOwner(),
    router.guardian(),
    router.treasury(),
    router.pendingTreasury(),
    router.wrappedNative(),
    router.feeBps(),
    router.paused(),
    router.adapterConfig(EXISTING_UNISWAP_V2_ADAPTER),
    factory.owner(),
    factory.pendingOwner(),
    factory.treasury(),
    factory.pendingTreasury(),
    factory.deploymentFee(),
    registry.owner(),
    registry.pendingOwner(),
    registry.guardian(),
  ]);
  if (
    !sameAddress(routerOwner, GOVERNANCE_SAFE) ||
    !sameAddress(routerPendingOwner, ZERO_ADDRESS) ||
    !sameAddress(guardian, GUARDIAN_SAFE) ||
    !sameAddress(treasury, TREASURY_SAFE) ||
    !sameAddress(pendingTreasury, ZERO_ADDRESS) ||
    !sameAddress(wrappedNative, BASE_WETH) ||
    feeBps !== BigInt(ROUTER_FEE_BPS) ||
    paused ||
    !adapterConfig.configured ||
    !adapterConfig.enabled ||
    !sameAddress(factoryOwner, GOVERNANCE_SAFE) ||
    !sameAddress(factoryPendingOwner, ZERO_ADDRESS) ||
    !sameAddress(factoryTreasury, TREASURY_SAFE) ||
    !sameAddress(factoryPendingTreasury, ZERO_ADDRESS) ||
    deploymentFee !== 0n ||
    !sameAddress(registryOwner, GOVERNANCE_SAFE) ||
    !sameAddress(registryPendingOwner, ZERO_ADDRESS) ||
    !sameAddress(registryGuardian, GUARDIAN_SAFE)
  ) {
    fail("Direct-Safe V2 post-deployment state mismatch.");
  }
  const [routerCode, factoryCode, registryCode] = await Promise.all([
    provider.getCode(deployments.router.address),
    provider.getCode(deployments.factory.address),
    provider.getCode(deployments.registry.address),
  ]);
  return {
    routerCodehash: checkedCodehash(routerCode),
    factoryCodehash: checkedCodehash(factoryCode),
    registryCodehash: checkedCodehash(registryCode),
  };
}

function writeManifest({ previous, deployments, safeExecution, hashes, blockNumber }) {
  const history = {
    governance: previous.governance,
    contracts: previous.contracts,
    uniswapCanary: previous.uniswapCanary,
    supersededAtBlock: blockNumber,
    reason: "Replaced by direct 2-of-2 Governance Safe authority at the user's request.",
  };
  const next = {
    ...previous,
    schemaVersion: "kletia_base_v2_direct_safe_deployment_v1",
    observedAtBlock: blockNumber,
    releaseState: {
      ...previous.releaseState,
      adapterLifecycle: "configured_enabled",
      runtimeEvidence: null,
      cutoverReady: false,
    },
    governance: {
      ...previous.governance,
      mode: "direct_2_of_2_safe",
      timelock: null,
    },
    contracts: {
      ...previous.contracts,
      intentRouterV2: {
        address: deployments.router.address,
        deploymentTransaction: deployments.router.transactionHash,
        deploymentBlock: deployments.router.blockNumber,
        runtimeCodehash: hashes.routerCodehash,
        owner: GOVERNANCE_SAFE,
        guardian: GUARDIAN_SAFE,
        treasury: TREASURY_SAFE,
        wrappedNative: BASE_WETH,
        feeBps: ROUTER_FEE_BPS,
        paused: false,
        verifiedExact: false,
      },
      launchFactoryV2: {
        address: deployments.factory.address,
        deploymentTransaction: deployments.factory.transactionHash,
        deploymentBlock: deployments.factory.blockNumber,
        runtimeCodehash: hashes.factoryCodehash,
        owner: GOVERNANCE_SAFE,
        treasury: TREASURY_SAFE,
        pendingTreasury: ZERO_ADDRESS,
        deploymentFee: "0",
        verifiedExact: false,
      },
      x402AttestationRegistryV1: {
        address: deployments.registry.address,
        deploymentTransaction: deployments.registry.transactionHash,
        deploymentBlock: deployments.registry.blockNumber,
        runtimeCodehash: hashes.registryCodehash,
        owner: GOVERNANCE_SAFE,
        guardian: GUARDIAN_SAFE,
        verifiedExact: false,
      },
    },
    directSafeConfiguration: {
      adapter: EXISTING_UNISWAP_V2_ADAPTER,
      enabled: true,
      safeExecutionTransaction: safeExecution.hash,
      safeExecutionBlock: safeExecution.blockNumber,
    },
    supersededDeployments: [
      ...(Array.isArray(previous.supersededDeployments)
        ? previous.supersededDeployments
        : []),
      history,
    ],
  };
  fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(next, null, 2)}\n`, {
    mode: 0o644,
  });
}

async function main() {
  const provider = ethers.provider;
  const network = await provider.getNetwork();
  if (network.chainId !== BASE_CHAIN_ID) {
    fail(`Wrong chain: expected Base ${BASE_CHAIN_ID}, received ${network.chainId}.`);
  }
  const wallets = loadSignerKeys().map((key) => new ethers.Wallet(key, provider));
  const actualOwners = wallets.map(({ address }) => ethers.getAddress(address)).sort();
  const expectedOwners = [...EXPECTED_OWNERS].sort();
  if (
    actualOwners.length !== expectedOwners.length ||
    actualOwners.some((address, index) => address !== expectedOwners[index])
  ) {
    fail("Local signers do not match the Governance Safe owner set.");
  }
  const submitter = wallets.find(({ address }) => sameAddress(address, EXPECTED_OWNERS[0]));
  if (!submitter) fail("Base transaction submitter is unavailable.");

  const [safe] = await Promise.all([
    validateSafe(provider, GOVERNANCE_SAFE, true),
    validateSafe(provider, GUARDIAN_SAFE),
    validateSafe(provider, TREASURY_SAFE),
    provider.getCode(EXISTING_UNISWAP_V2_ADAPTER).then(checkedCodehash),
    provider.getCode(BASE_WETH).then(checkedCodehash),
  ]);
  const balance = await provider.getBalance(submitter.address);
  if (balance < MIN_BALANCE_BUFFER_WEI) {
    fail(
      `Insufficient Base deployment gas: fund ${submitter.address} to at least ${ethers.formatEther(MIN_BALANCE_BUFFER_WEI)} ETH before retrying.`,
    );
  }

  const previous = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const router = await deploy(
    "KletiaIntentRouterV2",
    [GOVERNANCE_SAFE, GUARDIAN_SAFE, BASE_WETH, TREASURY_SAFE, ROUTER_FEE_BPS],
    submitter,
  );
  const factory = await deploy(
    "KletiaLaunchFactoryV2",
    [GOVERNANCE_SAFE, TREASURY_SAFE],
    submitter,
  );
  const registry = await deploy(
    "KletiaX402ServiceAttestationRegistryV1",
    [GOVERNANCE_SAFE, GUARDIAN_SAFE],
    submitter,
  );
  const deployments = { router, factory, registry };
  const routerInterface = new ethers.Interface(ROUTER_ABI);
  const safeExecution = await executeSafeCall({
    safe,
    wallets,
    submitter,
    to: router.address,
    data: routerInterface.encodeFunctionData("configureAdapter", [
      EXISTING_UNISWAP_V2_ADAPTER,
      true,
    ]),
  });
  const hashes = await validatePostState(provider, deployments);
  const blockNumber = String(await provider.getBlockNumber());
  writeManifest({ previous, deployments, safeExecution, hashes, blockNumber });
  process.stdout.write(
    `${JSON.stringify({
      status: "deployed_configured_waiting_for_verification_and_evidence",
      chainId: Number(BASE_CHAIN_ID),
      governanceMode: "direct_2_of_2_safe",
      router: router.address,
      launchFactory: factory.address,
      x402Registry: registry.address,
      adapter: EXISTING_UNISWAP_V2_ADAPTER,
      safeExecutionTransaction: safeExecution.hash,
      observedAtBlock: blockNumber,
    })}\n`,
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "Unknown deployment failure.";
  console.error(message.replace(/[\r\n]+/gu, " ").slice(0, 800));
  process.exitCode = 1;
});
