const hre = require("hardhat");

async function main() {
  console.log("Starting deployment...");

  const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

  const INITIAL_PRICE = 10000;

  console.log("Deploying X402Gateway...");
  const X402Gateway = await hre.ethers.getContractFactory("X402Gateway");
  const gateway = await X402Gateway.deploy(USDC_ADDRESS, INITIAL_PRICE);

  await gateway.waitForDeployment();
  const address = await gateway.getAddress();

  console.log(`X402Gateway deployed to: ${address}`);

  console.log("Waiting for block confirmations...");

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
