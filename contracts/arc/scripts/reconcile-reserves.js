require("dotenv").config();
const ethers = require("ethers");

const ARC_CHAIN_ID = 5_042_002n;
const HORIZON_SECONDS = 30n * 24n * 60n * 60n;
const OPERATIONAL_BUFFER_SECONDS = 24n * 60n * 60n;
const PROJECTION_SECONDS = HORIZON_SECONDS + OPERATIONAL_BUFFER_SECONDS;
const BPS_DENOMINATOR = 10_000n;
const SECONDS_PER_YEAR = 31_536_000n;
const VAULT = "0xe2810DB53998f8A51bBf5Bf94c21208b174da174";
const VAULT_DEPLOYMENT_BLOCK = 52_436_232n;
const STAKING = "0xB85a7F6335D0544b4951e5f07Bcd326722b2BC07";
const STAKING_DEPLOYMENT_BLOCK = 52_436_191n;
const ARC_SCAN_API = "https://testnet.arcscan.app/api";
const DEPOSITED_TOPIC = ethers.id("Deposited(address,uint256,uint256)");
const STAKED_TOPIC = ethers.id("Staked(address,uint256,uint256)");
const provider = new ethers.JsonRpcProvider(
  process.env.ARC_RPC_URL?.trim() || "https://rpc.testnet.arc.network",
  Number(ARC_CHAIN_ID),
  { staticNetwork: true },
);

const vaultAbi = [
  "function owner() view returns (address)",
  "function apyBps() view returns (uint256)",
  "function totalDeposited() view returns (uint256)",
  "function deposits(address) view returns (uint256 principal,uint256 lastAccrualTimestamp,uint256 accruedInterest)",
  "function pendingInterest(address) view returns (uint256)",
  "function fundVault() payable",
];
const stakingAbi = [
  "function owner() view returns (address)",
  "function aprBps() view returns (uint256)",
  "function totalStaked() view returns (uint256)",
  "function rewardPoolBalance() view returns (uint256)",
  "function getStakerInfo(address) view returns (uint256 stakedAmount,uint256 stakingTimestamp,uint256 accruedRewards,uint256 pendingUnstake,uint256 unstakeRequestTime,uint256 cooldownRemaining)",
  "function fundRewards() payable",
];

function max(...values) {
  return values.reduce((highest, value) => (value > highest ? value : highest), 0n);
}

function userFromLog(log, address, topic) {
  if (
    ethers.getAddress(log.address) !== ethers.getAddress(address) ||
    log.topics?.[0]?.toLowerCase() !== topic.toLowerCase() ||
    !/^0x[0-9a-f]{64}$/iu.test(log.topics?.[1] || "")
  ) {
    throw new Error("Arc event-index response did not match the requested contract/topic.");
  }
  return ethers.getAddress(`0x${log.topics[1].slice(-40)}`);
}

async function arcScanLogs(address, topic, fromBlock, toBlock) {
  const query = new URLSearchParams({
    module: "logs",
    action: "getLogs",
    fromBlock: fromBlock.toString(),
    toBlock: toBlock.toString(),
    address,
    topic0: topic,
  });
  const response = await fetch(`${ARC_SCAN_API}?${query}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`ArcScan log HTTP ${response.status}.`);
  const body = await response.json();
  if (!Array.isArray(body.result)) {
    if (String(body.result || "").toLowerCase().includes("no records")) return [];
    throw new Error(`ArcScan log response invalid: ${body.message || "unknown"}.`);
  }
  if (body.result.length < 1_000) return body.result;
  if (fromBlock === toBlock) throw new Error("ArcScan single-block log cap reached.");
  const midpoint = (fromBlock + toBlock) / 2n;
  const [left, right] = await Promise.all([
    arcScanLogs(address, topic, fromBlock, midpoint),
    arcScanLogs(address, topic, midpoint + 1n, toBlock),
  ]);
  return [...left, ...right];
}

async function indexedUsers(address, topic, deploymentBlock, pinnedBlock) {
  const historical = await arcScanLogs(
    address,
    topic,
    deploymentBlock,
    pinnedBlock,
  );
  const tailFrom = max(deploymentBlock, pinnedBlock - 9_999n);
  const tail = await provider.getLogs({
    address,
    topics: [topic],
    fromBlock: tailFrom,
    toBlock: pinnedBlock,
  });
  const users = new Set();
  for (const log of [...historical, ...tail]) {
    users.add(userFromLog(log, address, topic));
  }
  return [...users];
}

async function vaultSnapshot(contract, users, blockTag) {
  const apyBps = await contract.apyBps({ blockTag });
  const totalDeposited = await contract.totalDeposited({ blockTag });
  const balance = await provider.getBalance(VAULT, blockTag);
  const positions = [];
  for (const user of users) {
    const deposit = await contract.deposits(user, { blockTag });
    const pending = await contract.pendingInterest(user, { blockTag });
    positions.push({ principal: deposit.principal, pending });
  }
  const active = positions.filter(({ principal }) => principal > 0n);
  const principal = active.reduce((sum, position) => sum + position.principal, 0n);
  if (principal !== totalDeposited) {
    throw new Error("Vault indexed-user principal does not reconcile with totalDeposited.");
  }
  const pendingInterest = active.reduce((sum, position) => sum + position.pending, 0n);
  const horizonInterest = active.reduce(
    (sum, position) =>
      sum +
      (position.principal * apyBps * HORIZON_SECONDS) /
        (BPS_DENOMINATOR * SECONDS_PER_YEAR),
    0n,
  );
  const projectedInterest = active.reduce(
    (sum, position) =>
      sum +
      (position.principal * apyBps * PROJECTION_SECONDS) /
        (BPS_DENOMINATOR * SECONDS_PER_YEAR),
    0n,
  );
  const coverageTarget = principal + pendingInterest + horizonInterest;
  const target = principal + pendingInterest + projectedInterest;
  return {
    blockTag,
    activeUsers: active.length,
    apyBps,
    principal,
    pendingInterest,
    horizonInterest,
    projectedInterest,
    coverageTarget,
    coverageSurplus: balance > coverageTarget ? balance - coverageTarget : 0n,
    coverageSatisfied: balance >= coverageTarget,
    target,
    balance,
    delta: target > balance ? target - balance : 0n,
  };
}

async function stakingSnapshot(contract, users, blockTag) {
  const aprBps = await contract.aprBps({ blockTag });
  const totalStaked = await contract.totalStaked({ blockTag });
  const rewardPool = await contract.rewardPoolBalance({ blockTag });
  const balance = await provider.getBalance(STAKING, blockTag);
  const positions = [];
  for (const user of users) {
    const info = await contract.getStakerInfo(user, { blockTag });
    positions.push({
      staked: info.stakedAmount,
      pendingRewards: info.accruedRewards,
      pendingUnstake: info.pendingUnstake,
    });
  }
  const staked = positions.reduce((sum, position) => sum + position.staked, 0n);
  if (staked !== totalStaked) {
    throw new Error("Staking indexed-user balances do not reconcile with totalStaked.");
  }
  const pendingUnstake = positions.reduce(
    (sum, position) => sum + position.pendingUnstake,
    0n,
  );
  const pendingRewards = positions.reduce(
    (sum, position) => sum + position.pendingRewards,
    0n,
  );
  const horizonRewards = positions.reduce(
    (sum, position) =>
      sum +
      (position.staked * aprBps * HORIZON_SECONDS) /
        (BPS_DENOMINATOR * SECONDS_PER_YEAR),
    0n,
  );
  const projectedRewards = positions.reduce(
    (sum, position) =>
      sum +
      (position.staked * aprBps * PROJECTION_SECONDS) /
        (BPS_DENOMINATOR * SECONDS_PER_YEAR),
    0n,
  );
  const coverageTargetPool = pendingRewards + horizonRewards;
  const coveragePhysicalTarget = totalStaked + pendingUnstake + coverageTargetPool;
  const targetPool = pendingRewards + projectedRewards;
  const physicalTarget = totalStaked + pendingUnstake + targetPool;
  const poolDelta = targetPool > rewardPool ? targetPool - rewardPool : 0n;
  const physicalDelta = physicalTarget > balance ? physicalTarget - balance : 0n;
  return {
    blockTag,
    indexedUsers: positions.length,
    aprBps,
    totalStaked,
    pendingUnstake,
    pendingRewards,
    horizonRewards,
    projectedRewards,
    coverageTargetPool,
    coveragePhysicalTarget,
    coverageSurplus:
      rewardPool > coverageTargetPool && balance > coveragePhysicalTarget
        ? rewardPool - coverageTargetPool < balance - coveragePhysicalTarget
          ? rewardPool - coverageTargetPool
          : balance - coveragePhysicalTarget
        : 0n,
    coverageSatisfied:
      rewardPool >= coverageTargetPool && balance >= coveragePhysicalTarget,
    targetPool,
    rewardPool,
    physicalTarget,
    balance,
    delta: max(poolDelta, physicalDelta),
  };
}

async function sendFunding(contract, functionName, value, label) {
  if (value === 0n) return null;
  await contract[functionName].staticCall({ value });
  const estimatedGas = await contract[functionName].estimateGas({ value });
  const transaction = await contract[functionName]({
    value,
    gasLimit: (estimatedGas * 120n) / 100n,
  });
  const receipt = await transaction.wait(1);
  if (!receipt || receipt.status !== 1) throw new Error(`${label} funding failed.`);
  return { hash: receipt.hash, blockNumber: receipt.blockNumber };
}

function publicSnapshot(snapshot) {
  return Object.fromEntries(
    Object.entries(snapshot).map(([key, value]) => [
      key,
      typeof value === "bigint" ? value.toString() : value,
    ]),
  );
}

async function main() {
  const action = (process.env.KLETIA_RESERVE_ACTION || "status").trim();
  if (action !== "status" && action !== "fund") {
    throw new Error("KLETIA_RESERVE_ACTION must be status or fund.");
  }
  const privateKey = process.env.ARC_PRIVATE_KEY?.trim();
  if (action === "fund" && !privateKey) {
    throw new Error("ARC_PRIVATE_KEY is required for reserve funding.");
  }
  const signer = privateKey ? new ethers.Wallet(privateKey, provider) : null;
  const network = await provider.getNetwork();
  if (network.chainId !== ARC_CHAIN_ID) throw new Error("Wrong Arc chain.");
  const vault = new ethers.Contract(VAULT, vaultAbi, provider);
  const staking = new ethers.Contract(STAKING, stakingAbi, provider);
  const vaultOwner = await vault.owner();
  const stakingOwner = await staking.owner();
  if (action === "fund") {
    if (!signer) throw new Error("Arc reserve funding signer is unavailable.");
    if (
      vaultOwner.toLowerCase() !== signer.address.toLowerCase() ||
      stakingOwner.toLowerCase() !== signer.address.toLowerCase()
    ) {
      throw new Error("Arc signer is not the exact Vault and Staking owner.");
    }
  }

  const historyBlock = await provider.getBlockNumber();
  const vaultUsers = await indexedUsers(
    VAULT,
    DEPOSITED_TOPIC,
    VAULT_DEPLOYMENT_BLOCK,
    BigInt(historyBlock),
  );
  const stakingUsers = await indexedUsers(
    STAKING,
    STAKED_TOPIC,
    STAKING_DEPLOYMENT_BLOCK,
    BigInt(historyBlock),
  );

  const vaultBlock = await provider.getBlockNumber();
  const beforeVault = await vaultSnapshot(vault, vaultUsers, vaultBlock);
  const vaultFunding =
    action === "fund"
      ? await sendFunding(
          vault.connect(signer),
          "fundVault",
          beforeVault.delta,
          "Vault",
        )
      : null;
  const vaultPostBlock = vaultFunding?.blockNumber || vaultBlock;
  const afterVault = await vaultSnapshot(vault, vaultUsers, vaultPostBlock);
  if (!afterVault.coverageSatisfied) {
    throw new Error("Vault remains below the configured coverage horizon.");
  }

  const stakingBlock = await provider.getBlockNumber();
  const beforeStaking = await stakingSnapshot(staking, stakingUsers, stakingBlock);
  const stakingFunding =
    action === "fund"
      ? await sendFunding(
          staking.connect(signer),
          "fundRewards",
          beforeStaking.delta,
          "Staking",
        )
      : null;
  const stakingPostBlock = stakingFunding?.blockNumber || stakingBlock;
  const afterStaking = await stakingSnapshot(staking, stakingUsers, stakingPostBlock);
  if (
    !afterStaking.coverageSatisfied ||
    afterStaking.balance <
      afterStaking.totalStaked +
        afterStaking.pendingUnstake +
        afterStaking.rewardPool
  ) {
    throw new Error("Staking reserve remains below current liabilities.");
  }

  console.log(
    JSON.stringify(
      {
        status: action === "fund" ? "reserves_reconciled" : "reserve_status",
        action,
        chainId: Number(ARC_CHAIN_ID),
        signer: signer?.address || null,
        owners: {
          vault: vaultOwner,
          staking: stakingOwner,
        },
        horizonSeconds: HORIZON_SECONDS.toString(),
        operationalBufferSeconds: OPERATIONAL_BUFFER_SECONDS.toString(),
        projectionSeconds: PROJECTION_SECONDS.toString(),
        vault: {
          users: vaultUsers.length,
          before: publicSnapshot(beforeVault),
          funding: vaultFunding,
          after: publicSnapshot(afterVault),
        },
        staking: {
          users: stakingUsers.length,
          before: publicSnapshot(beforeStaking),
          funding: stakingFunding,
          after: publicSnapshot(afterStaking),
        },
      },
      null,
      2,
    ),
  );
}

const keepAlive = setInterval(() => {}, 1_000);
main()
  .catch((error) => {
    console.error(
      JSON.stringify({
        status: "failed_closed",
        error: error instanceof Error ? error.message : "Unknown reserve error.",
      }),
    );
    process.exitCode = 1;
  })
  .finally(() => clearInterval(keepAlive));
