export const X402FactoryABI = [
  {
    "anonymous": false,
    "inputs": [
      { "indexed": true, "internalType": "address", "name": "gatewayAddress", "type": "address" },
      { "indexed": true, "internalType": "address", "name": "owner", "type": "address" },
      { "indexed": false, "internalType": "address", "name": "usdc", "type": "address" },
      { "indexed": false, "internalType": "uint256", "name": "initialPrice", "type": "uint256" }
    ],
    "name": "GatewayCreated",
    "type": "event"
  },
  {
    "inputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }],
    "name": "allGateways",
    "outputs": [{ "internalType": "contract X402Gateway", "name": "", "type": "address" }],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "allGatewaysLength",
    "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      { "internalType": "address", "name": "_usdc", "type": "address" },
      { "internalType": "uint256", "name": "_initialPrice", "type": "uint256" }
    ],
    "name": "createGateway",
    "outputs": [{ "internalType": "address", "name": "gateway", "type": "address" }],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [{ "internalType": "address", "name": "", "type": "address" }, { "internalType": "uint256", "name": "", "type": "uint256" }],
    "name": "getGatewaysByOwner",
    "outputs": [{ "internalType": "contract X402Gateway", "name": "", "type": "address" }],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [{ "internalType": "address", "name": "owner", "type": "address" }],
    "name": "getOwnerGateways",
    "outputs": [{ "internalType": "contract X402Gateway[]", "name": "", "type": "address[]" }],
    "stateMutability": "view",
    "type": "function"
  }
];

export const X402GatewayABI = [
  {
    "inputs": [
      { "internalType": "address", "name": "_usdc", "type": "address" },
      { "internalType": "uint256", "name": "_initialPrice", "type": "uint256" },
      { "internalType": "address", "name": "_initialOwner", "type": "address" }
    ],
    "stateMutability": "nonpayable",
    "type": "constructor"
  },
  {
    "anonymous": false,
    "inputs": [
      { "indexed": true, "internalType": "address", "name": "payer", "type": "address" },
      { "indexed": false, "internalType": "uint256", "name": "amount", "type": "uint256" },
      { "indexed": false, "internalType": "string", "name": "endpoint", "type": "string" }
    ],
    "name": "PaymentReceived",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [{ "indexed": false, "internalType": "uint256", "name": "newPrice", "type": "uint256" }],
    "name": "PriceUpdated",
    "type": "event"
  },
  {
    "inputs": [],
    "name": "owner",
    "outputs": [{ "internalType": "address", "name": "", "type": "address" }],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [{ "internalType": "string", "name": "endpoint", "type": "string" }],
    "name": "pay",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "pricePerCall",
    "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [{ "internalType": "uint256", "name": "_newPrice", "type": "uint256" }],
    "name": "setPrice",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [{ "internalType": "address", "name": "to", "type": "address" }],
    "name": "withdraw",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  }
];

export const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // Base Mainnet
export const X402_FACTORY_ADDRESS = "0xD6e7bAc04a9969f75AEA3f17b5b82db1C988DD46";
