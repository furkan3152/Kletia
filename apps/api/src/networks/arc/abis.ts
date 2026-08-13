import { parseAbi } from "viem";

export const ARC_ERC20_ABI = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function allowance(address owner,address spender) view returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)",
]);

export const ARC_SWAP_ABI = parseAbi([
  "function consultKletPrice() view returns (uint256)",
  "function token() view returns (address)",
  "function reserveUSDC() view returns (uint256)",
  "function reserveToken() view returns (uint256)",
  "function usdcReserve() view returns (uint256)",
  "function tokenReserve() view returns (uint256)",
  "function previewSwapTokenForUSDC(uint256 tokenAmount) view returns (uint256 usdcAmount)",
  "function previewSwapUSDCForToken(uint256 usdcAmount) view returns (uint256 tokenAmount)",
  "function swapTokenForUSDC(uint256 tokenAmount) returns (uint256 usdcAmount)",
  "function swapUSDCForToken() payable returns (uint256 tokenAmount)",
  "function addLiquidity(uint256 maxTokenAmount) payable returns (uint256 tokenAmount,uint256 lpMinted)",
  "function removeLiquidity(uint256 lpAmount) returns (uint256 usdcAmount,uint256 tokenAmount)",
  "function balanceOf(address owner) view returns (uint256)",
]);

export const ARC_VAULT_ABI = parseAbi([
  "function apyBps() view returns (uint256)",
  "function totalDeposited() view returns (uint256)",
  "function vaultBalance() view returns (uint256)",
  "function deposits(address user) view returns (uint256 principal,uint256 lastAccrualTimestamp,uint256 accruedInterest)",
  "function pendingInterest(address user) view returns (uint256)",
  "function claimableAmount(address user) view returns (uint256)",
  "function deposit() payable",
  "function withdraw()",
]);

export const ARC_STAKING_ABI = parseAbi([
  "function aprBps() view returns (uint256)",
  "function totalStaked() view returns (uint256)",
  "function cooldownPeriod() view returns (uint256)",
  "function rewardPoolBalance() view returns (uint256)",
  "function pendingRewards(address user) view returns (uint256)",
  "function getStakerInfo(address user) view returns (uint256 stakedAmount,uint256 stakingTimestamp,uint256 accruedRewards,uint256 pendingUnstake,uint256 unstakeRequestTime,uint256 cooldownRemaining)",
  "function stake() payable",
  "function unstake(uint256 amount)",
  "function claimRewards()",
  "function claimUnstaked()",
]);

export const ARC_MEMO_TRANSFER_ABI = parseAbi([
  "function totalTransfers() view returns (uint256)",
  "function getTransfer(uint256 transferId) view returns ((uint256 id,address from,address to,uint256 amount,string memo,uint256 timestamp))",
  "function getSentTransferIds(address addr) view returns (uint256[])",
  "function sentTransferCount(address addr) view returns (uint256)",
  "function transferWithMemo(address to,string memo) payable returns (uint256 transferId)",
]);

export const ARC_BATCH_PAY_ABI = parseAbi([
  "function totalBatches() view returns (uint256)",
  "function getBatch(uint256 batchId) view returns ((uint256 id,address sender,uint256 totalAmount,uint256 recipientCount,string memo,uint256 timestamp))",
  "function getBatchIdsBySender(address sender) view returns (uint256[])",
]);

export const ARC_AGENT_REGISTRY_ABI = parseAbi([
  "function totalAgents() view returns (uint256)",
  "function getAgent(uint256 agentId) view returns ((uint256 id,string name,string description,string[] skills,string endpointUrl,address agentOwner,bool active,uint256 reputation,uint256 registeredAt,uint256 updatedAt))",
  "function getAgentsByOwner(address agentOwner) view returns (uint256[])",
  "function registerAgent(string name,string description,string[] skills,string endpointUrl) returns (uint256 agentId)",
]);

export const ARC_LENDING_ABI = parseAbi([
  "function currentBorrowRate() view returns (uint256)",
  "function currentLiquidityRate() view returns (uint256)",
  "function LTV_BIPS() view returns (uint256)",
  "function LIQ_THRESHOLD_BIPS() view returns (uint256)",
  "function borrowIndex() view returns (uint256)",
  "function liquidityIndex() view returns (uint256)",
  "function collateralBalance(address user) view returns (uint256)",
  "function getBorrowedBalance(address user) view returns (uint256)",
  "function getSuppliedBalance(address user) view returns (uint256)",
  "function healthFactor(address user) view returns (uint256)",
  "function _getMaxBorrow(address user) view returns (uint256)",
  "function _getKletPrice() view returns (uint256)",
  "function depositCollateral(uint256 amount)",
  "function withdrawCollateral(uint256 amount)",
  "function borrow(uint256 borrowAmount)",
  "function repay() payable",
  "function withdrawUSDC(uint256 amount)",
]);
