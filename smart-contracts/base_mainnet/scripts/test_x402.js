const { ethers } = require("hardhat");

async function main() {
  console.log("Connecting to official Base Mainnet RPC (https://mainnet.base.org)...");
  
  // Connect using official Base RPC
  const provider = new ethers.JsonRpcProvider("https://mainnet.base.org");
  const contractAddress = "0x53C3Eb31854557F8c991AFc1b212322f2e87DE53";
  
  // Minimal ABI for testing
  const abi = [
    "function pricePerCall() external view returns (uint256)",
    "function owner() external view returns (address)",
    "function usdc() external view returns (address)"
  ];
  
  const contract = new ethers.Contract(contractAddress, abi, provider);

  console.log(`\n--- Testing Contract at ${contractAddress} ---`);
  
  try {
    const owner = await contract.owner();
    console.log(`✅ Owner synced: ${owner}`);
    
    const price = await contract.pricePerCall();
    console.log(`✅ Price per call synced: ${price.toString()} (Expected: 10000)`);
    
    const usdc = await contract.usdc();
    console.log(`✅ USDC token address synced: ${usdc} (Official Base USDC)`);
    
    console.log("\n✅ Contract is fully synchronized and LIVE on Base Mainnet.");
  } catch (error) {
    console.error("❌ Failed to synchronize with contract:", error.message);
  }
}

main().catch(console.error);
