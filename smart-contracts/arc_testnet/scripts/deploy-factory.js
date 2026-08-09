const hre = require("hardhat");

async function main() {
  console.log("Deploying X402Factory to Arc Testnet...");

  const X402Factory = await hre.ethers.getContractFactory("X402Factory");
  const factory = await X402Factory.deploy();

  await factory.waitForDeployment();
  const address = await factory.getAddress();

  console.log("X402Factory deployed to:", address);

  console.log("Waiting for block confirmations...");
  await factory.deploymentTransaction().wait(5);

  console.log("Verifying contract on ArcScan...");
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
