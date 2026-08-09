const hre = require("hardhat");

async function main() {
  console.log("🚀 Deploying X402Factory to Arc Testnet...");

  const [deployer] = await hre.ethers.getSigners();
  console.log("👤 Deployer Address:", deployer.address);

  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log("💰 Deployer Balance:", hre.ethers.formatEther(balance), "ETH");

  const X402Factory = await hre.ethers.getContractFactory("X402Factory");
  const factory = await X402Factory.deploy();

  await factory.waitForDeployment();
  const factoryAddress = await factory.getAddress();

  console.log("✅ X402Factory deployed to:", factoryAddress);

  console.log("⏳ Waiting for 5 confirmations to verify contract...");
  await factory.deploymentTransaction().wait(5);

  try {
    await hre.run("verify:verify", {
      address: factoryAddress,
      constructorArguments: [],
    });
    console.log("✅ Contract verified on ArcScan!");
  } catch (error) {
    console.error("❌ Verification failed:", error.message);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
