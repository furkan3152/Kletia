/**
 * The user's own Polymarket wallet, found from their EVM wallet. Polymarket
 * gives every account a smart wallet whose address is a CREATE2 address of
 * the signing EOA (docs "Wallets and Authentication", "Contracts"):
 *
 * - Safe (browser-wallet accounts before May 4, 2026): Gnosis Safe 1.3.0
 *   from Polymarket's Safe factory, owned by the EOA. Kletia trades it
 *   (orders signatureType 2: maker = Safe, signer = EOA) and runs wallet
 *   calls through `execTransaction`, sent by the EOA with its pre-validated
 *   owner signature (Safe 1.3.0 `checkNSignatures`, v = 1 and msg.sender =
 *   owner), so the EOA pays POL gas and nothing else signs.
 * - Deposit Wallet (every account since May 4, 2026): ERC-1967 beacon or
 *   UUPS proxy from the Deposit Wallet factory with `owner()` = the EOA.
 *   Kletia trades it (signatureType 3, ERC-1271: the EOA signs an ERC-7739
 *   TypedDataSign wrapper); its own transactions run only through
 *   Polymarket's relayer, so approvals, withdrawals and redemption stay on
 *   polymarket.com.
 * - Proxy (email and Google sign-ins through Magic, before May 2026): an
 *   EIP-1167 clone from the proxy factory. Read only.
 *
 * Derivation inputs: @polymarket/client 0.14.0 `walletDerivation` and
 * @polymarket/builder-relayer-client 0.0.10 `derive.js` (Safe and proxy init
 * code hashes; Solady LibClone init code hashes of the Deposit Wallet). Each
 * derived address must have code on Polygon and, for a Safe or a Deposit
 * Wallet, name the EOA as its owner (`getOwners()` / `owner()`); anything
 * unread or different is not the user's wallet (fail closed, never a guess).
 * Polymarket's public profile (Gamma `/public-profile`) is a cross-check
 * only: it marks the wallet polymarket.com shows, and never adds one.
 */
import {
  POLYMARKET_POLYGON,
  POLYMARKET_SIGNATURE_TYPES,
  POLYMARKET_WALLET_FACTORIES as F,
  type EvmTransactionRequest,
  type PolymarketWallet,
  type PolymarketWalletAction,
  type PolymarketWalletKind,
} from "@kletia/core";
import {
  concat,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  getAddress,
  getCreate2Address,
  hashTypedData,
  isAddressEqual,
  keccak256,
  pad,
  parseAbi,
  toHex,
  zeroAddress,
  type Hex,
} from "viem";
import { PlatformError } from "../errors.js";
import { directTransaction, erc20Balance, type WalletCall } from "./chain.js";
import type { PredictionsIo } from "./io.js";
import { polymarketUrls } from "./polymarket.js";

const P = POLYMARKET_POLYGON;
const walletAbi = parseAbi([
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function nonce() view returns (uint256)",
  "function owner() view returns (address)",
  "function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)",
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)",
]);

/* ------------------------------------------------------------ derivation */

// Solady LibClone (v0.1.26) init code constants, as @polymarket/builder-relayer-client copies them.
const ERC1967_CONST1 = "0xcc3735a920a3ca505d382bbc545af43d6000803e6038573d6000fd5b3d6000f3";
const ERC1967_CONST2 = "0x5155f3363d3d373d3d363d7f360894a13ba1a3210667c828492db98dca3e2076";
const ERC1967_PREFIX = 0x61003d3d8160233d3973n;
const BEACON_CONST1 = "0xb3582b35133d50545afa5036515af43d6000803e604d573d6000fd5b3d6000f3";
const BEACON_CONST2 = "0x1b60e01b36527fa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6c";
const BEACON_CONST3 = "0x60195155f3363d3d373d3d363d602036600436635c60da";
const BEACON_PREFIX = 0x6100523d8160233d3973n;

const argsLength = (args: Hex) => BigInt((args.length - 2) / 2) << 56n;

function erc1967InitCodeHash(implementation: string, args: Hex): Hex {
  return keccak256(concat([toHex(ERC1967_PREFIX + argsLength(args), { size: 10 }), implementation as Hex, "0x6009", ERC1967_CONST2, ERC1967_CONST1, args]));
}

function beaconInitCodeHash(beacon: string, args: Hex): Hex {
  return keccak256(concat([toHex(BEACON_PREFIX + argsLength(args), { size: 10 }), beacon as Hex, BEACON_CONST3, BEACON_CONST2, BEACON_CONST1, args]));
}

export interface WalletCandidates {
  readonly safe: string;
  readonly proxy: string;
  /** Deposit Wallets deployed since the June 29, 2026 upgrade (beacon proxy). */
  readonly depositBeacon: string;
  /** Deposit Wallets deployed before it (UUPS proxy). */
  readonly depositUups: string;
}

/** Every address Polymarket's factories give `owner` (pure CREATE2; whether each exists is read on Polygon). */
export function polymarketWalletCandidates(owner: string): WalletCandidates {
  const eoa = getAddress(owner);
  const depositArgs = encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [getAddress(F.depositWalletFactory), pad(eoa, { dir: "left", size: 32 })]);
  const depositSalt = keccak256(depositArgs);
  return {
    safe: getCreate2Address({ from: F.safeFactory, salt: keccak256(encodeAbiParameters([{ type: "address" }], [eoa])), bytecodeHash: F.safeInitCodeHash as Hex }),
    proxy: getCreate2Address({ from: F.proxyFactory, salt: keccak256(encodePacked(["address"], [eoa])), bytecodeHash: F.proxyInitCodeHash as Hex }),
    depositBeacon: getCreate2Address({ from: F.depositWalletFactory, salt: depositSalt, bytecodeHash: beaconInitCodeHash(F.depositWalletBeacon, depositArgs) }),
    depositUups: getCreate2Address({ from: F.depositWalletFactory, salt: depositSalt, bytecodeHash: erc1967InitCodeHash(F.depositWalletImplementation, depositArgs) }),
  };
}

/** The kind of Polymarket wallet `address` is for `owner`, by derivation alone; null when it is none of them. */
export function walletKindOf(owner: string, address: string): PolymarketWalletKind | null {
  const candidates = polymarketWalletCandidates(owner);
  const is = (candidate: string) => isAddressEqual(candidate as Hex, address as Hex);
  if (is(candidates.safe)) return "safe";
  if (is(candidates.depositBeacon) || is(candidates.depositUups)) return "deposit";
  if (is(candidates.proxy)) return "proxy";
  return null;
}

/** The runtime code of a Polymarket proxy wallet: an EIP-1167 clone of the proxy implementation. */
const PROXY_RUNTIME = `0x363d3d373d3d3d363d73${F.proxyImplementation.slice(2)}5af43d82803e903d91602b57fd5bf3`.toLowerCase();

/* ----------------------------------------------------------------- reads */

async function read<T>(io: PredictionsIo, to: string, functionName: "getOwners" | "getThreshold" | "nonce" | "owner"): Promise<T> {
  const data = encodeFunctionData({ abi: walletAbi, functionName });
  return decodeFunctionResult({ abi: walletAbi, functionName, data: await io.polygonCall(to, data) }) as T;
}

/** ERC-1271 `isValidSignature` of a contract wallet: true only for the magic value 0x1626ba7e. */
export async function validContractSignature(io: PredictionsIo, wallet: string, hash: Hex, signature: Hex): Promise<boolean> {
  const data = encodeFunctionData({ abi: walletAbi, functionName: "isValidSignature", args: [hash, signature] });
  try {
    const result = decodeFunctionResult({ abi: walletAbi, functionName: "isValidSignature", data: await io.polygonCall(wallet, data) });
    return result.toLowerCase() === "0x1626ba7e";
  } catch (error) {
    // A revert is an invalid signature; an unreadable chain is not an answer.
    if (error instanceof PlatformError) throw error;
    return false;
  }
}

/** The Safe's next transaction nonce. */
export async function safeNonce(io: PredictionsIo, safe: string): Promise<bigint> {
  return read<bigint>(io, safe, "nonce");
}

interface Checked {
  readonly kind: PolymarketWalletKind;
  readonly address: string;
  /** Null: owned and usable; otherwise why it is not the owner's (or not usable). */
  readonly problem: string | null;
  readonly verifiedBy: string;
  readonly threshold: bigint;
}

const DERIVED = {
  safe: "Derived from your wallet with Polymarket's Safe factory (CREATE2)",
  deposit: "Derived from your wallet with Polymarket's Deposit Wallet factory (CREATE2)",
  proxy: "Derived from your wallet with Polymarket's proxy wallet factory (CREATE2)",
} as const;

/** Reads what proves `address` (with `code`) is `owner`'s wallet of `kind`. Throws when Polygon cannot be read. */
async function checkWallet(io: PredictionsIo, owner: string, kind: PolymarketWalletKind, address: string, code: Hex): Promise<Checked> {
  const base = { kind, address: getAddress(address), threshold: 1n };
  if (kind === "proxy") {
    const clone = code.toLowerCase() === PROXY_RUNTIME;
    return { ...base, problem: clone ? null : "The address holds code that is not Polymarket's proxy wallet.", verifiedBy: `${DERIVED.proxy}; its clone code is on Polygon, and only your wallet can call it through the factory.` };
  }
  if (kind === "deposit") {
    const walletOwner = await read<string>(io, address, "owner");
    const owned = isAddressEqual(walletOwner as Hex, owner as Hex);
    return { ...base, problem: owned ? null : "Its owner() is another address now.", verifiedBy: `${DERIVED.deposit}; owner() on Polygon is your wallet.` };
  }
  const [owners, threshold] = await Promise.all([read<readonly string[]>(io, address, "getOwners"), read<bigint>(io, address, "getThreshold")]);
  const owned = owners.some((entry) => isAddressEqual(entry as Hex, owner as Hex));
  return { ...base, threshold, problem: owned ? null : "Its getOwners() no longer lists your wallet.", verifiedBy: `${DERIVED.safe}; getOwners() on Polygon lists your wallet.` };
}

/** Polymarket's public profile of `owner`: the wallet polymarket.com shows for it. Best effort (a cross-check, never a source). */
async function profileWallet(io: PredictionsIo, owner: string): Promise<{ readonly status: "listed" | "none" | "unavailable"; readonly wallet: string | null }> {
  try {
    const response = await io.request("Polymarket", `${polymarketUrls().gamma}/public-profile?address=${getAddress(owner)}`);
    if (response.status === 404) return { status: "none", wallet: null };
    const body = response.body as Record<string, unknown> | null;
    const wallet = response.status === 200 && body && typeof body.proxyWallet === "string" && /^0x[0-9a-fA-F]{40}$/u.test(body.proxyWallet) ? getAddress(body.proxyWallet) : null;
    return response.status === 200 ? { status: wallet ? "listed" : "none", wallet } : { status: "unavailable", wallet: null };
  } catch {
    return { status: "unavailable", wallet: null };
  }
}

const NOTES = {
  safe: null,
  safeShared: "This Safe needs more than one signature: Kletia builds one-owner transactions only, so trade, withdraw and wrap it on polymarket.com.",
  deposit: "Kletia signs this wallet's orders with your EVM wallet. Its own transactions (approvals, wrapping USDC.e, withdrawals, redemption) run only through Polymarket's relayer: do those on polymarket.com.",
  proxy: "A Proxy wallet belongs to an email or Google sign-in on polymarket.com (its key is held by Magic): its orders and transactions are signed there. Kletia shows its balance and positions only.",
} as const;

function walletOf(owner: string, checked: Checked, onProfile: boolean, balances: PolymarketWallet["balances"]): PolymarketWallet {
  const shared = checked.kind === "safe" && checked.threshold !== 1n;
  const tradable = (checked.kind === "safe" && !shared) || checked.kind === "deposit";
  const actions: PolymarketWalletAction[] = checked.kind === "safe" && !shared ? ["deposit", "withdraw", "wrap"] : ["deposit"];
  return {
    address: checked.address,
    kind: checked.kind,
    owner: getAddress(owner),
    signatureType: POLYMARKET_SIGNATURE_TYPES[checked.kind],
    tradable,
    verifiedBy: checked.verifiedBy,
    onProfile,
    balances,
    actions,
    note: shared ? NOTES.safeShared : NOTES[checked.kind],
  };
}

const units = (amount: bigint) => (Number(amount) / 1e6).toString();

async function balancesOf(io: PredictionsIo, address: string): Promise<PolymarketWallet["balances"]> {
  try {
    const [pusd, usdce] = await Promise.all([erc20Balance(io, P.pusd, address), erc20Balance(io, P.usdce, address)]);
    return { pusd: units(pusd), usdce: units(usdce) };
  } catch {
    return null;
  }
}

export interface PolymarketWalletsView {
  readonly owner: string;
  /** Verified wallets, the one Polymarket's profile names first. */
  readonly wallets: readonly PolymarketWallet[];
  readonly profile: {
    /** listed: the profile names a wallet Kletia verified; unverified: one it could not (not shown); none; unavailable. */
    readonly status: "listed" | "unverified" | "none" | "unavailable";
    readonly wallet: string | null;
  };
  /** Derived addresses that hold code but are not (or no longer) the owner's, and other remarks. */
  readonly notes: readonly string[];
}

const KIND_ORDER: Readonly<Record<PolymarketWalletKind, number>> = { deposit: 0, safe: 1, proxy: 2 };

/**
 * The Polymarket wallets of `owner`: every factory's address, kept when it
 * has code and names `owner` as its owner on Polygon. Throws
 * RPC_UNAVAILABLE when Polygon cannot be read (an unread wallet is never
 * reported as missing).
 */
export async function polymarketWalletsOf(owner: string, io: PredictionsIo): Promise<PolymarketWalletsView> {
  const eoa = getAddress(owner);
  const candidates = polymarketWalletCandidates(eoa);
  const entries: readonly [PolymarketWalletKind, string][] = [["safe", candidates.safe], ["deposit", candidates.depositBeacon], ["deposit", candidates.depositUups], ["proxy", candidates.proxy]];
  const [codes, profile] = await Promise.all([Promise.all(entries.map(([, address]) => io.polygonCode(address))), profileWallet(io, eoa)]);
  const found = entries.flatMap(([kind, address], index) => (codes[index] && codes[index] !== "0x" ? [{ kind, address, code: codes[index] }] : []));
  const checked = await Promise.all(found.map((entry) => checkWallet(io, eoa, entry.kind, entry.address, entry.code)));
  const notes = checked.filter((entry) => entry.problem !== null).map((entry) => `${entry.address} was derived from your wallet but is not counted: ${entry.problem}`);
  const owned = checked.filter((entry) => entry.problem === null);
  const balances = await Promise.all(owned.map((entry) => balancesOf(io, entry.address)));
  const wallets = owned
    .map((entry, index) => walletOf(eoa, entry, profile.wallet !== null && isAddressEqual(profile.wallet as Hex, entry.address as Hex), balances[index] ?? null))
    .sort((a, b) => Number(b.onProfile) - Number(a.onProfile) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
  const listed = profile.wallet !== null && wallets.some((wallet) => wallet.onProfile);
  const status = profile.status === "listed" && !listed && !isAddressEqual(profile.wallet as Hex, eoa) ? "unverified" : profile.status;
  if (status === "unverified") notes.push(`Polymarket's profile names ${profile.wallet}, which Kletia could not verify as your wallet's, so it is not shown.`);
  return { owner: eoa, wallets, profile: { status, wallet: profile.wallet }, notes };
}

const cache = new Map<string, { readonly at: number; readonly io: PredictionsIo; readonly view: Promise<PolymarketWalletsView> }>();
const CACHE_MS = 60_000;

/** polymarketWalletsOf for reads (positions, data extras, history labels): one minute per owner. Trading always reads fresh. */
export function cachedPolymarketWallets(owner: string, io: PredictionsIo): Promise<PolymarketWalletsView> {
  const key = owner.toLowerCase();
  const hit = cache.get(key);
  if (hit && hit.io === io && io.now() - hit.at < CACHE_MS) return hit.view;
  const view = polymarketWalletsOf(owner, io);
  if (cache.size > 500) cache.clear();
  cache.set(key, { at: io.now(), io, view });
  view.catch(() => cache.delete(key));
  return view;
}

/** Forgets cached discoveries (tests). */
export function resetWalletCache(): void {
  cache.clear();
}

/* --------------------------------------------------------------- holders */

/** Who holds the funds and shares of an order and sends its transactions. */
export type TradingHolder =
  | { readonly kind: "account"; readonly address: string; readonly owner: string }
  | { readonly kind: "safe" | "deposit"; readonly address: string; readonly owner: string };

const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

/** "Your Polymarket wallet 0x1234…ab12, owned by 0x5678…cd34". */
export function walletLine(holder: Pick<TradingHolder, "address" | "owner">): string {
  return `Your Polymarket wallet ${short(holder.address)}, owned by ${short(holder.owner)}`;
}

/**
 * The holder of a trade: `wallet` must be a Safe or Deposit Wallet of
 * `owner`, read fresh on Polygon (code, derivation and owner); omitted, the
 * owner trades for itself and must be a plain wallet.
 */
export async function tradingHolder(io: PredictionsIo, owner: string, wallet: string | undefined, plainWallet: (address: string) => Promise<boolean>): Promise<TradingHolder> {
  const eoa = getAddress(owner);
  if (wallet === undefined || isAddressEqual(wallet as Hex, eoa)) {
    if (await plainWallet(eoa)) return { kind: "account", address: eoa, owner: eoa };
    throw new PlatformError("PREDICTION_ACCOUNT_UNSUPPORTED", "This address is a smart-contract wallet. Connect the EVM wallet that signs for your Polymarket account and trade from the Polymarket wallet Kletia finds for it.", 422);
  }
  const kind = walletKindOf(eoa, wallet);
  if (kind === null) throw new PlatformError("PREDICTION_WALLET_NOT_FOUND", `${getAddress(wallet)} is not a Polymarket wallet of ${eoa}: none of Polymarket's factories derives it from this wallet.`, 422);
  if (kind === "proxy") throw new PlatformError("PREDICTION_ACCOUNT_UNSUPPORTED", NOTES.proxy, 422);
  const code = await io.polygonCode(wallet);
  if (code === "0x") throw new PlatformError("PREDICTION_WALLET_SETUP_REQUIRED", "This Polymarket wallet is not deployed yet. Open polymarket.com once with this EVM wallet to create it (Polymarket deploys it for free), then trade here.", 422);
  const checked = await checkWallet(io, eoa, kind, wallet, code);
  if (checked.problem !== null) throw new PlatformError("PREDICTION_WALLET_NOT_FOUND", `${checked.address} is not ${eoa}'s on Polygon now: ${checked.problem}`, 422);
  if (checked.threshold !== 1n) throw new PlatformError("PREDICTION_ACCOUNT_UNSUPPORTED", NOTES.safeShared, 422);
  return { kind, address: checked.address, owner: eoa };
}

/* ------------------------------------------------------- Safe transactions */

/** Safe 1.3.0 pre-validated signature of `owner`: r = owner, s = 0, v = 1 (valid when the owner itself sends the transaction). */
export function prevalidatedSignature(owner: string): Hex {
  return encodePacked(["bytes32", "bytes32", "uint8"], [pad(getAddress(owner).toLowerCase() as Hex, { size: 32 }), pad("0x00", { size: 32 }), 1]);
}

/** The Safe's EIP-712 SafeTx hash of a call (operation CALL, no gas refund), as the Safe's own `getTransactionHash` returns it. */
export function safeTransactionHash(safe: string, entry: Pick<WalletCall, "to" | "data">, nonce: bigint): Hex {
  return hashTypedData({
    domain: { chainId: P.chainId, verifyingContract: getAddress(safe) },
    types: {
      SafeTx: [
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "data", type: "bytes" },
        { name: "operation", type: "uint8" },
        { name: "safeTxGas", type: "uint256" },
        { name: "baseGas", type: "uint256" },
        { name: "gasPrice", type: "uint256" },
        { name: "gasToken", type: "address" },
        { name: "refundReceiver", type: "address" },
        { name: "nonce", type: "uint256" },
      ],
    },
    primaryType: "SafeTx",
    message: { to: getAddress(entry.to), value: 0n, data: entry.data, operation: 0, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: zeroAddress, refundReceiver: zeroAddress, nonce },
  });
}

/** The call run by the owner's Safe: `execTransaction` sent by the owner (it pays POL gas), no refund, no delegatecall. */
export function safeExecTransaction(owner: string, safe: string, entry: WalletCall): EvmTransactionRequest {
  const data = encodeFunctionData({
    abi: walletAbi,
    functionName: "execTransaction",
    args: [getAddress(entry.to), 0n, entry.data, 0, 0n, 0n, 0n, zeroAddress, zeroAddress, prevalidatedSignature(owner)],
  });
  return { vm: "evm", network: "polygon", chainId: P.chainId, from: getAddress(owner), to: getAddress(safe), data, value: "0", description: `${walletLine({ address: safe, owner })}: ${entry.description}` };
}

/** One call as the holder's transaction: sent by the account, or run through its Safe. A Deposit Wallet has none (relayer only). */
export function holderTransaction(holder: TradingHolder, entry: WalletCall): EvmTransactionRequest {
  if (holder.kind === "account") return directTransaction(holder.owner, entry);
  if (holder.kind === "safe") return safeExecTransaction(holder.owner, holder.address, entry);
  throw new PlatformError("PREDICTION_WALLET_SETUP_REQUIRED", `${walletLine(holder)} needs this step: ${entry.description}. A Deposit Wallet's own transactions run only through Polymarket's relayer, so do it on polymarket.com with this EVM wallet (free, no gas), then come back.`, 422);
}
