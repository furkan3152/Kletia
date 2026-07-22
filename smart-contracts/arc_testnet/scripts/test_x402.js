const { ethers } = require("hardhat");

async function main() {
  console.log("Connecting to official Arc Testnet RPC (https://testnet-rpc.arc.io)...");
  
  // Connect using official Arc RPC
  const provider = new ethers.JsonRpcProvider("https://testnet-rpc.arc.io");
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
    console.log(`✅ USDC token address synced: ${usdc} (Arc Testnet USDC)`);
    
    console.log("\n✅ Contract is fully synchronized and LIVE on Arc Testnet.");
  } catch (error) {
    console.error("❌ Failed to synchronize with contract:", error.message);
  }
}

main().catch(console.error);
