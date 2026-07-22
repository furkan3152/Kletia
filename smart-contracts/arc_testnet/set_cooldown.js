const { ethers } = require('ethers');
require('dotenv').config();

const ARC_CONTRACTS = {
  "Staking": "0xAd6D03D9Ab75df3e7BC301D18788b5908c2FB71B"
};

const STAKING_ABI = [
  "function setCooldownPeriod(uint256 newCooldown) external",
  "function cooldownPeriod() external view returns (uint256)"
];

async function main() {
  const provider = new ethers.JsonRpcProvider('https://testnet.rpc.arc.io');
  const stakingContract = new ethers.Contract(ARC_CONTRACTS.Staking, STAKING_ABI, wallet);

  console.log("Current cooldown:", await stakingContract.cooldownPeriod());
  
  const tx = await stakingContract.setCooldownPeriod(1);
  console.log("Tx sent:", tx.hash);
  await tx.wait();
  
  console.log("New cooldown:", await stakingContract.cooldownPeriod());
}

main().catch(console.error);
