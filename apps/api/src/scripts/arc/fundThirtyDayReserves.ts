import {
  createWalletClient,
  formatUnits,
  getAddress,
  http,
  parseAbi,
  parseAbiItem,
  parseUnits,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  ARC_CONTRACTS,
  NETWORKS,
  arcPublicClient,
} from "../../shared/config/networks.js";

const SECONDS_PER_DAY = 86_400n;
const SECONDS_PER_YEAR = 31_536_000n;
const BPS_DENOMINATOR = 10_000n;
const THIRTY_DAYS = 30n * SECONDS_PER_DAY;

const SETTLEMENT_BUFFER = 15n * 60n;
const FUNDING_HORIZON = THIRTY_DAYS + SETTLEMENT_BUFFER;
const MIN_SIGNER_GAS_BUFFER = parseUnits("0.05", 18);

const VAULT_DEPLOYMENT_BLOCK = 52_436_232n;
const STAKING_DEPLOYMENT_BLOCK = 52_436_191n;

const VAULT_ABI = parseAbi([
  "function owner() view returns (address)",
  "function apyBps() view returns (uint256)",
  "function totalDeposited() view returns (uint256)",
  "function deposits(address user) view returns (uint256 principal,uint256 lastAccrualTimestamp,uint256 accruedInterest)",
  "function claimableAmount(address user) view returns (uint256)",
  "function fundVault() payable",
]);

const STAKING_ABI = parseAbi([
  "function owner() view returns (address)",
  "function aprBps() view returns (uint256)",
  "function totalStaked() view returns (uint256)",
  "function rewardPoolBalance() view returns (uint256)",
  "function stakers(address user) view returns (uint256 stakedAmount,uint256 stakingTimestamp,uint256 accruedRewards,uint256 pendingUnstake,uint256 unstakeRequestTime)",
  "function getStakerInfo(address user) view returns (uint256 stakedAmount,uint256 stakingTimestamp,uint256 accruedRewards,uint256 pendingUnstake,uint256 unstakeRequestTime,uint256 cooldownRemaining)",
  "function pendingRewards(address user) view returns (uint256)",
  "function fundRewards() payable",
]);

const VAULT_DEPOSITED_EVENT = parseAbiItem(
  "event Deposited(address indexed user,uint256 amount,uint256 totalPrincipal)",
);
const STAKED_EVENT = parseAbiItem(
  "event Staked(address indexed user,uint256 amount,uint256 totalUserStake)",
);
const VAULT_DEPOSITED_TOPIC =
  "0x73a19dd210f1a7f902193214c0ee91dd35ee5b4d920cba8d519eca65a7b488ca";
const STAKED_TOPIC =
  "0x1449c6dd7851abc30abf37f57715f492010519147cc2652fbc38202c18a6ee90";
const RPC_TAIL_BLOCKS = 10_000n;

interface ReserveSnapshot {
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
  readonly totalDeposited: bigint;
  readonly vaultBalance: bigint;
  readonly vaultCurrentLiability: bigint;
  readonly vaultProjectedLiability: bigint;
  readonly vaultTarget: bigint;
  readonly vaultDelta: bigint;
  readonly totalStaked: bigint;
  readonly totalPendingUnstake: bigint;
  readonly stakingContractBalance: bigint;
  readonly rewardPoolBalance: bigint;
  readonly stakingCurrentLiability: bigint;
  readonly stakingProjectedLiability: bigint;
  readonly stakingTarget: bigint;
  readonly stakingDelta: bigint;
}

function formatNative(value: bigint): string {
  return formatUnits(value, 18);
}

function requiredPrivateKey(): Hex {
  const raw = (
    process.env.ARC_OWNER_PRIVATE_KEY ||
    process.env.PRIVATE_KEY ||
    process.env.ARC_PRIVATE_KEY
  )?.trim();
  if (!raw || !/^(?:0x)?[0-9a-fA-F]{64}$/u.test(raw)) {
    throw new Error("ARC_PRIVATE_KEY is missing or malformed.");
  }
  return (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
}

async function eventLogs(
  address: Address,
  event: ReturnType<typeof parseAbiItem>,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<Array<{ args?: { user?: Address } }>> {
  if (fromBlock > toBlock) return [];
  const logs: Array<{ args?: { user?: Address } }> = [];
  let cursor = fromBlock;
  let chunkSize = 50_000n;
  let rateLimitRetries = 0;

  const pause = (milliseconds: number) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, milliseconds);
    });

  while (cursor <= toBlock) {
    const end =
      cursor + chunkSize - 1n > toBlock ? toBlock : cursor + chunkSize - 1n;
    try {
      const page = await arcPublicClient.getLogs({
        address,
        event: event as never,
        fromBlock: cursor,
        toBlock: end,
        strict: true,
      });
      logs.push(...(page as Array<{ args?: { user?: Address } }>));
      cursor = end + 1n;
      rateLimitRetries = 0;
      if (chunkSize < 50_000n) chunkSize *= 2n;
      await pause(175);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/rate limit|too many requests|429/iu.test(message)) {
        rateLimitRetries += 1;
        if (rateLimitRetries > 12) throw error;
        await pause(Math.min(4_000, 350 * 2 ** (rateLimitRetries - 1)));
        continue;
      }
      if (chunkSize <= 1_000n) throw error;
      chunkSize /= 2n;
    }
  }
  return logs;
}

async function collectUsers(
  address: Address,
  event: ReturnType<typeof parseAbiItem>,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<Set<Address>> {
  const users = new Set<Address>();
  for (const log of await eventLogs(address, event, fromBlock, toBlock)) {
    if (log.args?.user) users.add(getAddress(log.args.user));
  }
  return users;
}

async function collectHistoricalUsersFromArcScan(
  address: Address,
  topic0: Hex,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<Set<Address>> {
  if (fromBlock > toBlock) return new Set<Address>();
  const query = new URLSearchParams({
    module: "logs",
    action: "getLogs",
    fromBlock: fromBlock.toString(),
    toBlock: toBlock.toString(),
    address,
    topic0,
  });
  const response = await fetch(`https://testnet.arcscan.app/api?${query}`, {
    signal: AbortSignal.timeout(20_000),
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(
      `ArcScan historical log request failed with HTTP ${response.status}.`,
    );
  }
  const payload = (await response.json()) as {
    status?: string;
    message?: string;
    result?: unknown;
  };
  if (!Array.isArray(payload.result)) {
    throw new Error(
      `ArcScan historical log response is invalid: ${payload.message ?? "unknown"}.`,
    );
  }
  if (payload.result.length >= 1_000) {
    throw new Error(
      "ArcScan historical log result reached its 1000-row safety limit.",
    );
  }
  const users = new Set<Address>();
  for (const item of payload.result) {
    if (!item || typeof item !== "object") {
      throw new Error("ArcScan returned a malformed historical log item.");
    }
    const record = item as {
      address?: unknown;
      blockNumber?: unknown;
      topics?: unknown;
    };
    const topics = record.topics;
    const itemBlock =
      typeof record.blockNumber === "string" ? BigInt(record.blockNumber) : -1n;
    if (
      typeof record.address !== "string" ||
      getAddress(record.address) !== getAddress(address) ||
      itemBlock < fromBlock ||
      itemBlock > toBlock ||
      !Array.isArray(topics) ||
      typeof topics[0] !== "string" ||
      topics[0].toLowerCase() !== topic0.toLowerCase() ||
      typeof topics[1] !== "string" ||
      !/^0x[0-9a-fA-F]{64}$/u.test(topics[1])
    ) {
      throw new Error(
        "ArcScan historical event topics do not match the requested event.",
      );
    }
    users.add(getAddress(`0x${topics[1].slice(-40)}`));
  }
  return users;
}

async function collectUsersWithVerifiedTail(
  address: Address,
  event: ReturnType<typeof parseAbiItem>,
  topic0: Hex,
  deploymentBlock: bigint,
  latestBlock: bigint,
): Promise<Set<Address>> {
  const tailFrom =
    latestBlock >= RPC_TAIL_BLOCKS ? latestBlock - RPC_TAIL_BLOCKS + 1n : 0n;
  const historicalTo =
    tailFrom > deploymentBlock ? tailFrom - 1n : deploymentBlock - 1n;
  const users = await collectHistoricalUsersFromArcScan(
    address,
    topic0,
    deploymentBlock,
    historicalTo,
  );
  addUsers(
    users,
    await collectUsers(
      address,
      event,
      tailFrom > deploymentBlock ? tailFrom : deploymentBlock,
      latestBlock,
    ),
  );
  return users;
}

function addUsers(target: Set<Address>, additions: Set<Address>): void {
  for (const user of additions) target.add(user);
}

function accruedAmountAt(
  principal: bigint,
  rateBps: bigint,
  since: bigint,
  targetTimestamp: bigint,
): bigint {
  if (principal === 0n || since === 0n) return 0n;
  if (since > targetTimestamp) {
    throw new Error(
      "Arc liability checkpoint is after the pinned target timestamp.",
    );
  }
  return (
    (principal * rateBps * (targetTimestamp - since)) /
    (BPS_DENOMINATOR * SECONDS_PER_YEAR)
  );
}

async function snapshot(
  vaultUsers: ReadonlySet<Address>,
  stakingUsers: ReadonlySet<Address>,
  horizonSeconds: bigint,
): Promise<ReserveSnapshot> {
  const blockNumber = await arcPublicClient.getBlockNumber({ cacheTime: 0 });
  const block = await arcPublicClient.getBlock({ blockNumber });
  if (!block.hash) throw new Error("Arc latest block has no hash.");
  const currentTimestamp = block.timestamp;
  const targetTimestamp = currentTimestamp + horizonSeconds;

  const [
    apyBps,
    totalDeposited,
    vaultBalance,
    aprBps,
    totalStaked,
    rewardPoolBalance,
    stakingContractBalance,
    vaultStates,
    stakingStates,
  ] = await Promise.all([
    arcPublicClient.readContract({
      address: ARC_CONTRACTS.Vault,
      abi: VAULT_ABI,
      functionName: "apyBps",
      blockNumber,
    }),
    arcPublicClient.readContract({
      address: ARC_CONTRACTS.Vault,
      abi: VAULT_ABI,
      functionName: "totalDeposited",
      blockNumber,
    }),
    arcPublicClient.getBalance({
      address: ARC_CONTRACTS.Vault,
      blockNumber,
    }),
    arcPublicClient.readContract({
      address: ARC_CONTRACTS.Staking,
      abi: STAKING_ABI,
      functionName: "aprBps",
      blockNumber,
    }),
    arcPublicClient.readContract({
      address: ARC_CONTRACTS.Staking,
      abi: STAKING_ABI,
      functionName: "totalStaked",
      blockNumber,
    }),
    arcPublicClient.readContract({
      address: ARC_CONTRACTS.Staking,
      abi: STAKING_ABI,
      functionName: "rewardPoolBalance",
      blockNumber,
    }),
    arcPublicClient.getBalance({
      address: ARC_CONTRACTS.Staking,
      blockNumber,
    }),
    Promise.all(
      [...vaultUsers].map((user) =>
        arcPublicClient.readContract({
          address: ARC_CONTRACTS.Vault,
          abi: VAULT_ABI,
          functionName: "deposits",
          args: [user],
          blockNumber,
        }),
      ),
    ),
    Promise.all(
      [...stakingUsers].map((user) =>
        arcPublicClient.readContract({
          address: ARC_CONTRACTS.Staking,
          abi: STAKING_ABI,
          functionName: "stakers",
          args: [user],
          blockNumber,
        }),
      ),
    ),
  ]);

  const mappedPrincipal = vaultStates.reduce(
    (sum, value) => sum + value[0],
    0n,
  );
  const mappedActiveStake = stakingStates.reduce(
    (sum, value) => sum + value[0],
    0n,
  );
  const totalPendingUnstake = stakingStates.reduce(
    (sum, value) => sum + value[3],
    0n,
  );
  if (mappedPrincipal !== totalDeposited) {
    throw new Error(
      "Vault user principal does not reconcile to totalDeposited.",
    );
  }
  if (mappedActiveStake !== totalStaked) {
    throw new Error("Staking user balances do not reconcile to totalStaked.");
  }
  if (
    stakingContractBalance <
    totalStaked + totalPendingUnstake + rewardPoolBalance
  ) {
    throw new Error("Staking physical balance is below booked liabilities.");
  }
  const vaultCurrentLiability = vaultStates.reduce(
    (sum, value) =>
      sum +
      value[0] +
      value[2] +
      accruedAmountAt(value[0], apyBps, value[1], currentTimestamp),
    0n,
  );
  const vaultTarget = vaultStates.reduce(
    (sum, value) =>
      sum +
      value[0] +
      value[2] +
      accruedAmountAt(value[0], apyBps, value[1], targetTimestamp),
    0n,
  );
  const stakingCurrentLiability = stakingStates.reduce(
    (sum, value) =>
      sum +
      value[2] +
      accruedAmountAt(value[0], aprBps, value[1], currentTimestamp),
    0n,
  );
  const stakingTarget = stakingStates.reduce(
    (sum, value) =>
      sum +
      value[2] +
      accruedAmountAt(value[0], aprBps, value[1], targetTimestamp),
    0n,
  );
  const vaultProjectedLiability = vaultTarget - vaultCurrentLiability;
  const stakingProjectedLiability = stakingTarget - stakingCurrentLiability;

  return {
    blockNumber,
    blockHash: block.hash,
    totalDeposited,
    vaultBalance,
    vaultCurrentLiability,
    vaultProjectedLiability,
    vaultTarget,
    vaultDelta: vaultTarget > vaultBalance ? vaultTarget - vaultBalance : 0n,
    totalStaked,
    totalPendingUnstake,
    stakingContractBalance,
    rewardPoolBalance,
    stakingCurrentLiability,
    stakingProjectedLiability,
    stakingTarget,
    stakingDelta:
      stakingTarget > rewardPoolBalance
        ? stakingTarget - rewardPoolBalance
        : 0n,
  };
}

function printableSnapshot(value: ReserveSnapshot) {
  return {
    blockNumber: value.blockNumber.toString(),
    blockHash: value.blockHash,
    totalDeposited: formatNative(value.totalDeposited),
    vaultBalance: formatNative(value.vaultBalance),
    vaultCurrentLiability: formatNative(value.vaultCurrentLiability),
    vaultProjectedLiability: formatNative(value.vaultProjectedLiability),
    vaultTarget: formatNative(value.vaultTarget),
    vaultDelta: formatNative(value.vaultDelta),
    totalStaked: formatNative(value.totalStaked),
    totalPendingUnstake: formatNative(value.totalPendingUnstake),
    stakingContractBalance: formatNative(value.stakingContractBalance),
    rewardPoolBalance: formatNative(value.rewardPoolBalance),
    stakingCurrentLiability: formatNative(value.stakingCurrentLiability),
    stakingProjectedLiability: formatNative(value.stakingProjectedLiability),
    stakingTarget: formatNative(value.stakingTarget),
    stakingDelta: formatNative(value.stakingDelta),
  };
}

async function main(): Promise<void> {
  const execute = process.argv.includes("--execute");
  const planningHorizon = process.argv.includes("--verify-30d")
    ? THIRTY_DAYS
    : FUNDING_HORIZON;
  const privateKey = requiredPrivateKey();
  const account = privateKeyToAccount(privateKey);
  const walletClient = createWalletClient({
    account,
    chain: NETWORKS.arc.chain,
    transport: http(NETWORKS.arc.rpcUrl),
  });

  const [chainId, vaultCode, stakingCode, vaultOwner, stakingOwner] =
    await Promise.all([
      arcPublicClient.getChainId(),
      arcPublicClient.getCode({ address: ARC_CONTRACTS.Vault }),
      arcPublicClient.getCode({ address: ARC_CONTRACTS.Staking }),
      arcPublicClient.readContract({
        address: ARC_CONTRACTS.Vault,
        abi: VAULT_ABI,
        functionName: "owner",
      }),
      arcPublicClient.readContract({
        address: ARC_CONTRACTS.Staking,
        abi: STAKING_ABI,
        functionName: "owner",
      }),
    ]);
  if (chainId !== NETWORKS.arc.chainId) {
    throw new Error(
      `Arc chain mismatch: expected 5042002, received ${chainId}.`,
    );
  }
  if (
    !vaultCode ||
    vaultCode === "0x" ||
    !stakingCode ||
    stakingCode === "0x"
  ) {
    throw new Error("Arc Vault or Staking runtime bytecode is missing.");
  }
  if (
    getAddress(vaultOwner) !== account.address ||
    getAddress(stakingOwner) !== account.address
  ) {
    throw new Error(
      "ARC_PRIVATE_KEY signer is not the live Vault and Staking owner.",
    );
  }

  const initialBlock = await arcPublicClient.getBlockNumber({ cacheTime: 0 });
  const vaultUsers = await collectUsersWithVerifiedTail(
    ARC_CONTRACTS.Vault,
    VAULT_DEPOSITED_EVENT,
    VAULT_DEPOSITED_TOPIC,
    VAULT_DEPLOYMENT_BLOCK,
    initialBlock,
  );
  const stakingUsers = await collectUsersWithVerifiedTail(
    ARC_CONTRACTS.Staking,
    STAKED_EVENT,
    STAKED_TOPIC,
    STAKING_DEPLOYMENT_BLOCK,
    initialBlock,
  );
  if (vaultUsers.size === 0 || stakingUsers.size === 0) {
    throw new Error("Arc liability user enumeration returned an empty set.");
  }

  const before = await snapshot(vaultUsers, stakingUsers, planningHorizon);
  const signerBalance = await arcPublicClient.getBalance({
    address: account.address,
  });
  const requiredBalance =
    before.vaultDelta + before.stakingDelta + MIN_SIGNER_GAS_BUFFER;
  if (signerBalance < requiredBalance) {
    throw new Error(
      `Arc owner balance is insufficient: need at least ${formatNative(requiredBalance)} native USDC.`,
    );
  }

  if (before.vaultDelta > 0n) {
    await arcPublicClient.simulateContract({
      account,
      address: ARC_CONTRACTS.Vault,
      abi: VAULT_ABI,
      functionName: "fundVault",
      value: before.vaultDelta,
    });
  }
  if (before.stakingDelta > 0n) {
    await arcPublicClient.simulateContract({
      account,
      address: ARC_CONTRACTS.Staking,
      abi: STAKING_ABI,
      functionName: "fundRewards",
      value: before.stakingDelta,
    });
  }

  console.log(
    JSON.stringify(
      {
        status: execute ? "ready_to_execute" : "simulated_only",
        chainId,
        signer: account.address,
        vaultUsers: vaultUsers.size,
        stakingUsers: stakingUsers.size,
        fundingHorizonSeconds: planningHorizon.toString(),
        snapshot: printableSnapshot(before),
      },
      null,
      2,
    ),
  );
  if (!execute) return;

  let vaultHash: Hex | null = null;
  let stakingHash: Hex | null = null;
  const beforeVaultSend = await snapshot(
    vaultUsers,
    stakingUsers,
    FUNDING_HORIZON,
  );
  if (beforeVaultSend.vaultDelta > 0n) {
    const { request } = await arcPublicClient.simulateContract({
      account,
      address: ARC_CONTRACTS.Vault,
      abi: VAULT_ABI,
      functionName: "fundVault",
      value: beforeVaultSend.vaultDelta,
    });
    vaultHash = await walletClient.writeContract(request);
    const receipt = await arcPublicClient.waitForTransactionReceipt({
      hash: vaultHash,
      confirmations: 1,
      timeout: 120_000,
    });
    if (receipt.status !== "success") {
      throw new Error(`Arc Vault funding reverted: ${vaultHash}`);
    }
  }
  const beforeStakingSend = await snapshot(
    vaultUsers,
    stakingUsers,
    FUNDING_HORIZON,
  );
  if (beforeStakingSend.stakingDelta > 0n) {
    const { request } = await arcPublicClient.simulateContract({
      account,
      address: ARC_CONTRACTS.Staking,
      abi: STAKING_ABI,
      functionName: "fundRewards",
      value: beforeStakingSend.stakingDelta,
    });
    stakingHash = await walletClient.writeContract(request);
    const receipt = await arcPublicClient.waitForTransactionReceipt({
      hash: stakingHash,
      confirmations: 1,
      timeout: 120_000,
    });
    if (receipt.status !== "success") {
      throw new Error(`Arc Staking funding reverted: ${stakingHash}`);
    }
  }

  const verificationBlock = await arcPublicClient.getBlockNumber({
    cacheTime: 0,
  });
  if (verificationBlock > initialBlock) {
    const [newVaultUsers, newStakingUsers] = await Promise.all([
      collectUsers(
        ARC_CONTRACTS.Vault,
        VAULT_DEPOSITED_EVENT,
        initialBlock + 1n,
        verificationBlock,
      ),
      collectUsers(
        ARC_CONTRACTS.Staking,
        STAKED_EVENT,
        initialBlock + 1n,
        verificationBlock,
      ),
    ]);
    addUsers(vaultUsers, newVaultUsers);
    addUsers(stakingUsers, newStakingUsers);
  }
  const after = await snapshot(vaultUsers, stakingUsers, THIRTY_DAYS);
  const vaultCovered = after.vaultBalance >= after.vaultTarget;
  const stakingCovered = after.rewardPoolBalance >= after.stakingTarget;
  if (!vaultCovered || !stakingCovered) {
    throw new Error(
      "Arc reserve post-state does not cover a full 30-day horizon.",
    );
  }

  console.log(
    JSON.stringify(
      {
        status: "funded_and_verified",
        chainId,
        transactions: {
          vault: vaultHash,
          staking: stakingHash,
        },
        coverage: {
          vaultCovered,
          stakingCovered,
          snapshot: printableSnapshot(after),
        },
      },
      null,
      2,
    ),
  );
}

main().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : "Unknown Arc funding error.";
  console.error(
    JSON.stringify({
      status: "failed_closed",
      error: message,
    }),
  );
  process.exitCode = 1;
});
