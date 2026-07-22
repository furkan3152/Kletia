const hre = require("hardhat");

async function main() {
  console.log("Deploying X402Factory to Base Mainnet...");

  const Factory = await hre.ethers.getContractFactory("X402Factory");
  const factory = await Factory.deploy();

  await factory.waitForDeployment();
  const address = await factory.getAddress();

  console.log("X402Factory deployed to:", address);

  // Wait a bit before verifying
  console.log("Waiting for block confirmations...");
  const tx = factory.deploymentTransaction();
  if (tx) {
      await tx.wait(5); // wait for 5 confirmations
  }

  console.log("Verifying contract on Basescan...");
  try {
    await hre.run("verify:verify", {
      address: address,
      constructorArguments: [],
    });
    console.log("Verification successful!");
  } catch (error) {
    console.error("Verification failed:", error);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
