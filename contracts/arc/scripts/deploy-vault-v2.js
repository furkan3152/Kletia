const { ethers } = require("hardhat");

const ARC_CHAIN_ID = 5_042_002n;
const DEFAULT_FORWARDER = "0x7dE7A249673F2235A91E484CfCE49D00867B67Ec";

function requiredAddress(name, fallback) {
  const value = (process.env[name] || fallback || "").trim();
  if (!ethers.isAddress(value) || value === ethers.ZeroAddress) {
    throw new Error(`${name} must be a non-zero EVM address.`);
  }
  return ethers.getAddress(value);
}

function configuredApy() {
  const raw = (process.env.ARC_VAULT_V2_APY_BPS || "1000").trim();
  if (!/^\d+$/.test(raw)) throw new Error("ARC_VAULT_V2_APY_BPS is invalid.");
  const value = BigInt(raw);
  if (value > 5_000n) throw new Error("ARC_VAULT_V2_APY_BPS exceeds 5000.");
  return value;
}

async function main() {
  const [deployer] = await ethers.getSigners();
  if (!deployer) {
    throw new Error("ARC_PRIVATE_KEY is required for Vault V2 deployment.");
  }
  const network = await ethers.provider.getNetwork();
  if (network.chainId !== ARC_CHAIN_ID) {
    throw new Error(
      `Wrong chain: expected ${ARC_CHAIN_ID}, received ${network.chainId}.`,
    );
  }

  const forwarder = requiredAddress(
    "ARC_TRUSTED_FORWARDER_ADDRESS",
    DEFAULT_FORWARDER,
  );
  const owner = requiredAddress("ARC_VAULT_V2_OWNER", deployer.address);
  const guardian = requiredAddress("ARC_VAULT_V2_GUARDIAN", owner);
  const apyBps = configuredApy();

  const forwarderCode = await ethers.provider.getCode(forwarder);
  if (forwarderCode === "0x") {
    throw new Error("Configured Arc trusted forwarder has no runtime code.");
  }

  const factory = await ethers.getContractFactory(
    "contracts/KletiaArcVaultV2.sol:KletiaArcVaultV2",
  );
  const deployment = await factory.getDeployTransaction(
    forwarder,
    owner,
    guardian,
    apyBps,
  );
  const estimatedGas = await ethers.provider.estimateGas({
    ...deployment,
    from: deployer.address,
  });
  const feeData = await ethers.provider.getFeeData();
  const gasPrice = feeData.maxFeePerGas || feeData.gasPrice;
  if (!gasPrice) throw new Error("Arc gas price was unavailable.");
  const estimatedCost = estimatedGas * gasPrice;
  const balance = await ethers.provider.getBalance(deployer.address);
  if (balance < estimatedCost) {
    throw new Error("Arc deployer balance is below the estimated deployment cost.");
  }

  const vault = await factory.deploy(forwarder, owner, guardian, apyBps);
  const receipt = await vault.deploymentTransaction().wait(1);
  if (!receipt || receipt.status !== 1) {
    throw new Error("Vault V2 deployment was not confirmed successfully.");
  }
  const address = await vault.getAddress();
  const [liveOwner, liveGuardian, liveApy, trusted] = await Promise.all([
    vault.owner(),
    vault.guardian(),
    vault.apyBps(),
    vault.isTrustedForwarder(forwarder),
  ]);
  if (
    liveOwner !== owner ||
    liveGuardian !== guardian ||
    liveApy !== apyBps ||
    !trusted
  ) {
    throw new Error("Vault V2 post-deployment invariant mismatch.");
  }

  console.log(
    JSON.stringify(
      {
        status: "deployed_pending_verification_and_migration",
        network: "Arc Testnet",
        chainId: Number(ARC_CHAIN_ID),
        address,
        transactionHash: receipt.hash,
        deploymentBlock: receipt.blockNumber,
        constructorArguments: [forwarder, owner, guardian, apyBps.toString()],
        estimatedGas: estimatedGas.toString(),
        runtimeCodehash: ethers.keccak256(await ethers.provider.getCode(address)),
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      status: "failed_closed",
      error: error instanceof Error ? error.message : "Unknown deployment error.",
    }),
  );
  process.exitCode = 1;
});
