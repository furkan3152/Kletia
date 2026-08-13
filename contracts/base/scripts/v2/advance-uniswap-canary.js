const fs = require("node:fs");
const path = require("node:path");
const { ethers } = require("hardhat");

const BASE_CHAIN_ID = 8_453n;
const ZERO_BYTES32 = `0x${"00".repeat(32)}`;
const ENABLE_SALT = ethers.keccak256(
  ethers.toUtf8Bytes("KLETIA_UNISWAP_V2_CANARY_ENABLE_V1"),
);
const manifestPath = path.resolve(
  __dirname,
  "../../deployments/base-mainnet-v2.json",
);
const routerAbi = [
  "function adapterConfig(address) view returns (bool configured,bool enabled,address target,address spender,bytes32 adapterCodehash,bytes32 targetCodehash,bytes32 spenderCodehash,bytes32 adapterConfigurationHash,bytes32 configHash)",
  "function enableAdapter(address adapter)",
];
const timelockAbi = [
  "function getMinDelay() view returns (uint256)",
  "function hashOperation(address target,uint256 value,bytes data,bytes32 predecessor,bytes32 salt) view returns (bytes32)",
  "function isOperation(bytes32 id) view returns (bool)",
  "function isOperationReady(bytes32 id) view returns (bool)",
  "function isOperationDone(bytes32 id) view returns (bool)",
  "function getTimestamp(bytes32 id) view returns (uint256)",
  "function schedule(address target,uint256 value,bytes data,bytes32 predecessor,bytes32 salt,uint256 delay)",
  "function execute(address target,uint256 value,bytes payload,bytes32 predecessor,bytes32 salt) payable",
];

function manifest() {
  return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
}

function writeManifest(value) {
  fs.writeFileSync(manifestPath, `${JSON.stringify(value, null, 2)}\n`);
}

async function signerForExecution() {
  const [signer] = await ethers.getSigners();
  if (!signer) {
    throw new Error(
      "BASE_PRIVATE_KEY is required for an onchain execute action; status and Safe payload preparation are read-only.",
    );
  }
  return signer;
}

async function operationState(timelock, operationId) {
  const [exists, ready, done, timestamp] = await Promise.all([
    timelock.isOperation(operationId),
    timelock.isOperationReady(operationId),
    timelock.isOperationDone(operationId),
    timelock.getTimestamp(operationId),
  ]);
  return {
    operationId,
    exists,
    ready,
    done,
    timestamp: timestamp.toString(),
    readyAtIsoUtc:
      timestamp > 1n ? new Date(Number(timestamp) * 1000).toISOString() : null,
  };
}

async function main() {
  const action = (process.env.KLETIA_V2_CANARY_ACTION || "status").trim();
  const deployment = manifest();
  const network = await ethers.provider.getNetwork();
  if (network.chainId !== BASE_CHAIN_ID) {
    throw new Error(
      `Wrong chain: expected Base ${BASE_CHAIN_ID}, received ${network.chainId}.`,
    );
  }

  const routerAddress = ethers.getAddress(
    deployment.contracts.intentRouterV2.address,
  );
  const adapterAddress = ethers.getAddress(
    deployment.contracts.uniswapV2CompatibleAdapter.address,
  );
  const timelockAddress = ethers.getAddress(
    deployment.governance.timelock.address,
  );
  const router = new ethers.Contract(routerAddress, routerAbi, ethers.provider);
  const timelock = new ethers.Contract(
    timelockAddress,
    timelockAbi,
    ethers.provider,
  );
  const configure = deployment.uniswapCanary.configureOperation;
  const configureState = await operationState(
    timelock,
    configure.operationId,
  );
  const adapterConfig = await router.adapterConfig(adapterAddress);
  const minDelay = await timelock.getMinDelay();
  const enableData = router.interface.encodeFunctionData("enableAdapter", [
    adapterAddress,
  ]);
  const enableOperationId = await timelock.hashOperation(
    routerAddress,
    0,
    enableData,
    ZERO_BYTES32,
    ENABLE_SALT,
  );
  const enableState = await operationState(timelock, enableOperationId);

  const baseStatus = {
    chainId: Number(BASE_CHAIN_ID),
    router: routerAddress,
    adapter: adapterAddress,
    timelock: timelockAddress,
    adapterConfigured: adapterConfig.configured,
    adapterEnabled: adapterConfig.enabled,
    configureOperation: configureState,
    enableOperation: enableState,
  };

  if (action === "status") {
    console.log(JSON.stringify({ status: "read_only", ...baseStatus }, null, 2));
    return;
  }

  if (action === "prepare-configure-execution") {
    if (!configureState.ready || configureState.done) {
      throw new Error("Configure operation is not ready for one-time execution.");
    }
    const executeData = timelock.interface.encodeFunctionData("execute", [
      configure.target,
      configure.value,
      configure.data,
      configure.predecessor,
      configure.salt,
    ]);
    console.log(
      JSON.stringify(
        {
          status: "wallet_transaction_ready",
          ...baseStatus,
          transaction: {
            chainId: Number(BASE_CHAIN_ID),
            to: timelockAddress,
            value: "0",
            data: executeData,
          },
          expectedPostState: {
            adapterConfigured: true,
            adapterEnabled: false,
          },
        },
        null,
        2,
      ),
    );
    return;
  }

  if (action === "prepare-enable") {
    if (!adapterConfig.configured || adapterConfig.enabled) {
      throw new Error(
        "Enable schedule payload is available only after configure completed and before enable completed.",
      );
    }
    if (enableState.exists) {
      throw new Error("The deterministic enable operation is already scheduled.");
    }
    const scheduleData = timelock.interface.encodeFunctionData("schedule", [
      routerAddress,
      0,
      enableData,
      ZERO_BYTES32,
      ENABLE_SALT,
      minDelay,
    ]);
    console.log(
      JSON.stringify(
        {
          status: "safe_transaction_ready_for_two_signatures",
          ...baseStatus,
          governanceSafe: deployment.governance.governanceSafe.address,
          safeTransaction: {
            to: timelockAddress,
            value: "0",
            data: scheduleData,
            operation: 0,
          },
          scheduledOperation: {
            operationId: enableOperationId,
            target: routerAddress,
            value: "0",
            data: enableData,
            predecessor: ZERO_BYTES32,
            salt: ENABLE_SALT,
            delay: minDelay.toString(),
          },
        },
        null,
        2,
      ),
    );
    return;
  }

  if (action === "prepare-enable-execution") {
    if (!enableState.ready || enableState.done) {
      throw new Error("Enable operation is not ready for one-time execution.");
    }
    const executeData = timelock.interface.encodeFunctionData("execute", [
      routerAddress,
      0,
      enableData,
      ZERO_BYTES32,
      ENABLE_SALT,
    ]);
    console.log(
      JSON.stringify(
        {
          status: "wallet_transaction_ready",
          ...baseStatus,
          transaction: {
            chainId: Number(BASE_CHAIN_ID),
            to: timelockAddress,
            value: "0",
            data: executeData,
          },
          expectedPostState: {
            adapterConfigured: true,
            adapterEnabled: true,
          },
        },
        null,
        2,
      ),
    );
    return;
  }

  const signer = await signerForExecution();
  const connectedTimelock = timelock.connect(signer);
  if (action === "execute-configure") {
    if (!configureState.ready || configureState.done) {
      throw new Error("Configure operation is not ready for one-time execution.");
    }
    await connectedTimelock.execute.staticCall(
      configure.target,
      configure.value,
      configure.data,
      configure.predecessor,
      configure.salt,
    );
    const transaction = await connectedTimelock.execute(
      configure.target,
      configure.value,
      configure.data,
      configure.predecessor,
      configure.salt,
    );
    const receipt = await transaction.wait(1);
    if (!receipt || receipt.status !== 1) {
      throw new Error("Configure execution was not confirmed successfully.");
    }
    const nextConfig = await router.adapterConfig(adapterAddress);
    if (!nextConfig.configured || nextConfig.enabled) {
      throw new Error("Unexpected adapter state after configure execution.");
    }
    configure.status = "done";
    configure.executeTransaction = receipt.hash;
    configure.executeBlock = String(receipt.blockNumber);
    deployment.releaseState.adapterLifecycle =
      "configured_enable_not_scheduled";
    writeManifest(deployment);
    console.log(
      JSON.stringify(
        {
          status: "configure_executed",
          transactionHash: receipt.hash,
          blockNumber: receipt.blockNumber,
          nextAction:
            "Run canary:v2:prepare-enable and submit the exact Safe transaction for two signatures.",
        },
        null,
        2,
      ),
    );
    return;
  }

  if (action === "execute-enable") {
    if (!enableState.ready || enableState.done) {
      throw new Error("Enable operation is not ready for one-time execution.");
    }
    await connectedTimelock.execute.staticCall(
      routerAddress,
      0,
      enableData,
      ZERO_BYTES32,
      ENABLE_SALT,
    );
    const transaction = await connectedTimelock.execute(
      routerAddress,
      0,
      enableData,
      ZERO_BYTES32,
      ENABLE_SALT,
    );
    const receipt = await transaction.wait(1);
    if (!receipt || receipt.status !== 1) {
      throw new Error("Enable execution was not confirmed successfully.");
    }
    const nextConfig = await router.adapterConfig(adapterAddress);
    if (!nextConfig.configured || !nextConfig.enabled) {
      throw new Error("Adapter was not enabled after the confirmed operation.");
    }
    deployment.uniswapCanary.enableOperation = {
      operationId: enableOperationId,
      target: routerAddress,
      value: "0",
      data: enableData,
      predecessor: ZERO_BYTES32,
      salt: ENABLE_SALT,
      status: "done",
      executeTransaction: receipt.hash,
      executeBlock: String(receipt.blockNumber),
    };
    deployment.releaseState.adapterLifecycle =
      "enabled_runtime_evidence_required";
    writeManifest(deployment);
    console.log(
      JSON.stringify(
        {
          status: "enable_executed",
          transactionHash: receipt.hash,
          blockNumber: receipt.blockNumber,
          nextAction: "Run npm run evidence:v2:base:deployment.",
        },
        null,
        2,
      ),
    );
    return;
  }

  throw new Error(`Unsupported KLETIA_V2_CANARY_ACTION: ${action}`);
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      status: "failed_closed",
      error: error instanceof Error ? error.message : "Unknown canary error.",
    }),
  );
  process.exitCode = 1;
});
