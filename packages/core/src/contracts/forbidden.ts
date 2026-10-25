/**
 * Function selectors and names Kletia refuses to call, and receiver-like
 * argument names.
 */
import { keccak256Hex } from "../caip.js";

/* ============================================================ keccak-256 (EVM) */

// keccak256Hex, toChecksumAddress and isChecksumAddressValid live in caip.ts (address checks).
export const utf8 = new TextEncoder();

/** 4-byte selector of a canonical function signature (`deposit(uint256,address)` → `0x6e553f65`). */
export function functionSelector(signature: string): string {
  return keccak256Hex(signature).slice(0, 10);
}

/** topic0 of a canonical event signature. */
export function eventTopic(signature: string): string {
  return keccak256Hex(signature);
}

/* ====================================================== forbidden functions */

export interface ForbiddenSelector {
  readonly selector: string;
  readonly signature: string;
  readonly reason: string;
}

/** Functions that can never be registered, by selector, whatever name the ABI gives them. */
export const FORBIDDEN_SELECTORS: readonly ForbiddenSelector[] = Object.freeze([
  { selector: "0x095ea7b3", signature: "approve(address,uint256)", reason: "approves the contract's own token to anyone" },
  { selector: "0x39509351", signature: "increaseAllowance(address,uint256)", reason: "raises a token allowance" },
  { selector: "0xa457c2d7", signature: "decreaseAllowance(address,uint256)", reason: "changes a token allowance" },
  { selector: "0xa22cb465", signature: "setApprovalForAll(address,bool)", reason: "approves every NFT of the caller (drain)" },
  { selector: "0xd505accf", signature: "permit(address,address,uint256,uint256,uint8,bytes32,bytes32)", reason: "signature approval (EIP-2612)" },
  { selector: "0x8fcbaf0c", signature: "permit(address,address,uint256,uint256,bool,uint8,bytes32,bytes32)", reason: "signature approval (DAI permit)" },
  { selector: "0xa9059cbb", signature: "transfer(address,uint256)", reason: "moves tokens" },
  { selector: "0x23b872dd", signature: "transferFrom(address,address,uint256)", reason: "moves tokens" },
  { selector: "0x42842e0e", signature: "safeTransferFrom(address,address,uint256)", reason: "moves NFTs" },
  { selector: "0xb88d4fde", signature: "safeTransferFrom(address,address,uint256,bytes)", reason: "moves NFTs" },
  { selector: "0xf242432a", signature: "safeTransferFrom(address,address,uint256,uint256,bytes)", reason: "moves ERC-1155 tokens" },
  { selector: "0x2eb2c2d6", signature: "safeBatchTransferFrom(address,address,uint256[],uint256[],bytes)", reason: "moves ERC-1155 tokens" },
  { selector: "0xe3ee160e", signature: "transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)", reason: "signature transfer (EIP-3009)" },
  { selector: "0xef55bec6", signature: "receiveWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)", reason: "signature transfer (EIP-3009)" },
  { selector: "0x3659cfe6", signature: "upgradeTo(address)", reason: "upgrades the contract" },
  { selector: "0x4f1ef286", signature: "upgradeToAndCall(address,bytes)", reason: "upgrades the contract" },
  { selector: "0x8f283970", signature: "changeAdmin(address)", reason: "changes the proxy admin" },
  { selector: "0xf2fde38b", signature: "transferOwnership(address)", reason: "changes the owner" },
  { selector: "0x715018a6", signature: "renounceOwnership()", reason: "changes the owner" },
  { selector: "0x8129fc1c", signature: "initialize()", reason: "initialises the contract (admin)" },
  { selector: "0xac9650d8", signature: "multicall(bytes[])", reason: "executes arbitrary calls" },
  { selector: "0x5ae401dc", signature: "multicall(uint256,bytes[])", reason: "executes arbitrary calls" },
  { selector: "0x252dba42", signature: "aggregate((address,bytes)[])", reason: "executes arbitrary calls (Multicall)" },
  { selector: "0x82ad56cb", signature: "aggregate3((address,bool,bytes)[])", reason: "executes arbitrary calls (Multicall3)" },
  { selector: "0x174dea71", signature: "aggregate3Value((address,bool,uint256,bytes)[])", reason: "executes arbitrary calls (Multicall3)" },
  { selector: "0xbce38bd7", signature: "tryAggregate(bool,(address,bytes)[])", reason: "executes arbitrary calls (Multicall)" },
  { selector: "0xb61d27f6", signature: "execute(address,uint256,bytes)", reason: "executes arbitrary calls" },
  { selector: "0x6a761202", signature: "execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)", reason: "executes arbitrary calls (Safe)" },
  { selector: "0x5c19a95c", signature: "delegate(address)", reason: "delegates voting power" },
  { selector: "0xc04a8a10", signature: "approveDelegation(address,uint256)", reason: "delegates credit" },
]);

/**
 * Name prefixes refused (case-insensitive, leading underscores ignored),
 * whatever the selector.
 */
export const FORBIDDEN_NAME_PREFIXES: readonly string[] = Object.freeze([
  "approve",
  "increaseallowance",
  "decreaseallowance",
  "setapprovalforall",
  "permit",
  "receivewithauthorization",
  "upgrade",
  "initialize",
  "reinitialize",
  "changeadmin",
  "transferownership",
  "renounceownership",
  "acceptownership",
  "setowner",
  "setimplementation",
  "multicall",
  "aggregate",
  "tryaggregate",
  "execute",
  "exec",
  "delegate",
  "selfdestruct",
  "kill",
]);

/** Exact names refused (the `transfer` family is matched exactly, not as a prefix). */
export const FORBIDDEN_FUNCTION_NAMES: readonly string[] = Object.freeze([
  "transfer",
  "transferfrom",
  "safetransferfrom",
  "safebatchtransferfrom",
  "transferwithauthorization",
]);

const FORBIDDEN_BY_SELECTOR = new Map(FORBIDDEN_SELECTORS.map((entry) => [entry.selector, entry]));

/** Why a function (by name and canonical signature) can never be registered; null when allowed. */
export function forbiddenFunctionReason(name: string, signature: string): string | null {
  const selector = functionSelector(signature);
  const bySelector = FORBIDDEN_BY_SELECTOR.get(selector);
  if (bySelector) return `${signature} has the selector ${selector} of ${bySelector.signature}, which ${bySelector.reason}.`;
  const normalized = name.replace(/^_+/u, "").toLowerCase();
  if (FORBIDDEN_FUNCTION_NAMES.includes(normalized)) return `${name} is a token transfer function.`;
  const prefix = FORBIDDEN_NAME_PREFIXES.find((candidate) => normalized.startsWith(candidate));
  if (prefix) return `${name} starts with "${prefix}": approvals, permits, transfers, ownership, upgrades, multicall and execute functions cannot be registered.`;
  return null;
}

/* ========================================================= beneficiary names */

/**
 * Address arguments with these names must bind to `$account` or `$recipient`
 * (a deposit can never be credited to anyone but the user).
 */
export const BENEFICIARY_ARG_PATTERN = /^_?(?:receiver|recipient|to|owner|beneficiary|onBehalfOf|account|user|for|dst|destination)$/iu;

export function isBeneficiaryArgName(name: string | undefined): boolean {
  return typeof name === "string" && BENEFICIARY_ARG_PATTERN.test(name);
}
