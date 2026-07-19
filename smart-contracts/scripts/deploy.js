const hre = require("hardhat");

async function main() {
  console.log("Starting deployment...");

  // Base Mainnet USDC Address
  const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  // Initial price: 0.01 USDC (USDC has 6 decimals, so 10,000)
  const INITIAL_PRICE = 10000;

  console.log("Deploying X402Gateway...");
  const X402Gateway = await hre.ethers.getContractFactory("X402Gateway");
  const gateway = await X402Gateway.deploy(USDC_ADDRESS, INITIAL_PRICE);

  await gateway.waitForDeployment();
  const address = await gateway.getAddress();
  
  console.log(`X402Gateway deployed to: ${address}`);

  console.log("Waiting for block confirmations...");
  // Wait for 5 blocks to ensure Etherscan has indexed the contract
  const deploymentReceipt = await gateway.deploymentTransaction().wait(5);

  console.log("Verifying contract on BaseScan...");
  try {
    await hre.run("verify:verify", {
      address: address,
      constructorArguments: [USDC_ADDRESS, INITIAL_PRICE],
    });
    console.log("Contract verified successfully!");
  } catch (error) {
    console.error("Verification failed:", error);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
