/**
 * Polygon reads and unsigned transactions for Polymarket (addresses pinned
 * in @kletia/core POLYMARKET_POLYGON): pUSD and USDC.e balances and
 * allowances, ERC-1155 operator approvals and share balances on
 * ConditionalTokens (v1) and PositionManager (v2), resolution reads, and
 * the approval, wrap, transfer and redeem calls the user's wallet makes.
 *
 * ABIs: ERC-20 / ERC-1155 standard functions; CollateralOnramp `wrap`
 * (docs "Polymarket USD"); collateral adapters' `redeemPositions` and the
 * V2 Router's `redeem(bytes31,uint256,uint256)` (docs "Manage Positions");
 * ConditionalTokens `payoutDenominator(bytes32)`. Each selector was found in
 * the deployed code on 2026-10-24 (docs/platform/predictions.md). The calls
 * are wallet-neutral: wallets.ts sends them from the account or through its
 * Polymarket Safe.
 */
import { POLYMARKET_POLYGON, type EvmTransactionRequest } from "@kletia/core";
import { decodeFunctionResult, encodeFunctionData, erc20Abi, getAddress, parseAbi, type Hex } from "viem";
import type { PredictionsIo } from "./io.js";

const erc1155Abi = parseAbi([
  "function isApprovedForAll(address account, address operator) view returns (bool)",
  "function setApprovalForAll(address operator, bool approved)",
  "function balanceOf(address account, uint256 id) view returns (uint256)",
]);
const onrampAbi = parseAbi(["function wrap(address _asset, address _to, uint256 _amount)"]);
const adapterAbi = parseAbi(["function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)"]);
const routerAbi = parseAbi(["function redeem(bytes31 conditionId, uint256 outcomeIndex, uint256 amount)"]);
const ctfAbi = parseAbi(["function payoutDenominator(bytes32 conditionId) view returns (uint256)"]);

const P = POLYMARKET_POLYGON;

/** Display name of a pinned contract, for step titles and disclosures. */
export const CONTRACT_NAMES: Readonly<Record<string, string>> = {
  [P.ctfExchange]: "Polymarket CTF Exchange",
  [P.negRiskCtfExchange]: "Polymarket Neg Risk CTF Exchange",
  [P.negRiskAdapter]: "Polymarket Neg Risk Adapter",
  [P.exchangeV3]: "Polymarket Exchange (V2 markets)",
  [P.router]: "Polymarket Router",
  [P.ctfCollateralAdapter]: "Polymarket CTF collateral adapter",
  [P.negRiskCtfCollateralAdapter]: "Polymarket neg-risk collateral adapter",
  [P.collateralOnramp]: "Polymarket CollateralOnramp",
};

const name = (address: string) => CONTRACT_NAMES[address] ?? address;
const units = (amount: bigint) => (Number(amount) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 6 });

/* ---------------------------------------------------------------- reads */

export async function erc20Balance(io: PredictionsIo, token: string, account: string): Promise<bigint> {
  const data = encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [getAddress(account)] });
  return decodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", data: await io.polygonCall(token, data) });
}

export async function erc20Allowance(io: PredictionsIo, token: string, account: string, spender: string): Promise<bigint> {
  const data = encodeFunctionData({ abi: erc20Abi, functionName: "allowance", args: [getAddress(account), getAddress(spender)] });
  return decodeFunctionResult({ abi: erc20Abi, functionName: "allowance", data: await io.polygonCall(token, data) });
}

export async function operatorApproved(io: PredictionsIo, ledger: string, account: string, operator: string): Promise<boolean> {
  const data = encodeFunctionData({ abi: erc1155Abi, functionName: "isApprovedForAll", args: [getAddress(account), getAddress(operator)] });
  return decodeFunctionResult({ abi: erc1155Abi, functionName: "isApprovedForAll", data: await io.polygonCall(ledger, data) });
}

export async function shareBalance(io: PredictionsIo, ledger: string, account: string, id: string): Promise<bigint> {
  const data = encodeFunctionData({ abi: erc1155Abi, functionName: "balanceOf", args: [getAddress(account), BigInt(id)] });
  return decodeFunctionResult({ abi: erc1155Abi, functionName: "balanceOf", data: await io.polygonCall(ledger, data) });
}

/** ConditionalTokens' payout denominator: 0 until the condition is reported (resolved). */
export async function ctfPayoutDenominator(io: PredictionsIo, conditionId: string): Promise<bigint> {
  const data = encodeFunctionData({ abi: ctfAbi, functionName: "payoutDenominator", args: [conditionId as Hex] });
  return decodeFunctionResult({ abi: ctfAbi, functionName: "payoutDenominator", data: await io.polygonCall(P.conditionalTokens, data) });
}

/** True for a plain wallet: no code, or only an EIP-7702 delegation designator (the key still signs for itself). */
export async function isPlainWallet(io: PredictionsIo, account: string): Promise<boolean> {
  const code = (await io.polygonCode(account)).toLowerCase();
  return code === "0x" || (code.startsWith("0xef0100") && code.length === 2 + 46);
}

/* ---------------------------------------------------------------- calls */

/**
 * One contract call a wallet makes. A plain wallet sends it as it is; a
 * Polymarket Safe runs it through `execTransaction` (wallets.ts).
 */
export interface WalletCall {
  readonly to: string;
  readonly data: Hex;
  readonly description: string;
}

const call = (to: string, data: Hex, description: string): WalletCall => ({ to: getAddress(to), data, description });

export function approveCall(token: "pUSD" | "USDC.e", spender: string, amount: bigint): WalletCall {
  return call(token === "pUSD" ? P.pusd : P.usdce, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [getAddress(spender), amount] }), `Approve ${units(amount)} ${token} to ${name(spender)} (exact amount)`);
}

export function transferCall(token: "pUSD" | "USDC.e", to: string, amount: bigint, toName: string): WalletCall {
  return call(token === "pUSD" ? P.pusd : P.usdce, encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [getAddress(to), amount] }), `Send ${units(amount)} ${token} to ${toName}`);
}

export function operatorCall(ledger: string, operator: string): WalletCall {
  const what = ledger === P.positionManager ? "Polymarket V2 positions" : "Polymarket outcome shares (ConditionalTokens)";
  return call(ledger, encodeFunctionData({ abi: erc1155Abi, functionName: "setApprovalForAll", args: [getAddress(operator), true] }), `Let ${name(operator)} move your ${what}`);
}

export function operatorDisclosure(ledger: string, operator: string): string {
  const what = ledger === P.positionManager ? "every Polymarket V2 position" : "every Polymarket outcome share held on ConditionalTokens";
  return `An operator approval (setApprovalForAll), which the ERC-1155 standard has no amount for: ${name(operator)} may move ${what} this wallet holds, until you revoke it (setApprovalForAll false). Polymarket's own app sets the same approval; it is required to sell or redeem.`;
}

/** CollateralOnramp `wrap`: USDC.e of the caller into pUSD for `recipient` (the caller itself). */
export function wrapCall(recipient: string, amount: bigint): WalletCall {
  return call(P.collateralOnramp, encodeFunctionData({ abi: onrampAbi, functionName: "wrap", args: [getAddress(P.usdce), getAddress(recipient), amount] }), `Wrap ${units(amount)} USDC.e into pUSD (CollateralOnramp, 1:1)`);
}

/** v1 redemption through the collateral adapter (both outcomes, paid in pUSD to the caller). */
export function redeemCtfCall(conditionId: string, negRisk: boolean): WalletCall {
  const adapter = negRisk ? P.negRiskCtfCollateralAdapter : P.ctfCollateralAdapter;
  const data = encodeFunctionData({ abi: adapterAbi, functionName: "redeemPositions", args: [getAddress(P.pusd), `0x${"0".repeat(64)}`, conditionId as Hex, [1n, 2n]] });
  return call(adapter, data, "Redeem resolved shares for pUSD");
}

/** v2 redemption through the Router: one outcome, an exact amount (docs: derive the 31-byte condition id from the position id). */
export function redeemV2Call(positionId: string, amount: bigint): WalletCall {
  const id = BigInt(positionId);
  const condition = `0x${(id >> 8n).toString(16).padStart(62, "0")}` as Hex;
  const outcomeIndex = id & 255n;
  const data = encodeFunctionData({ abi: routerAbi, functionName: "redeem", args: [condition, outcomeIndex, amount] });
  return call(P.router, data, `Redeem ${units(amount)} resolved shares for pUSD`);
}

/** The call as a transaction the account itself sends on Polygon. */
export function directTransaction(account: string, entry: WalletCall): EvmTransactionRequest {
  return { vm: "evm", network: "polygon", chainId: P.chainId, from: getAddress(account), to: entry.to, data: entry.data, value: "0", description: entry.description };
}
