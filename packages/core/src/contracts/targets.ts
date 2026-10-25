/**
 * Addresses and programs that can never be a contract target.
 */
import { CHAINS, type NetworkKey } from "../chains.js";
import { isEvmAddress } from "../caip.js";
import { ASSETS } from "../assets.js";
import { VENUE_CONTRACTS } from "../protocols.js";

/* ================================================================= deny list */

/**
 * Solana programs a Solana Action transaction may use without being
 * allowlisted; they are handled by fixed instruction rules and can never be
 * registered as integrator programs.
 */
export const SOLANA_ACTION_BUILTIN_PROGRAMS: Readonly<Record<string, string>> = Object.freeze({
  "11111111111111111111111111111111": "System Program",
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: "SPL Token",
  TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: "Token-2022",
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: "Associated Token Account",
  ComputeBudget111111111111111111111111111111: "Compute Budget",
  MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr: "Memo",
  Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo: "Memo (v1)",
  AddressLookupTab1e1111111111111111111111111: "Address Lookup Table",
  L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95: "Lighthouse",
});

/** Native and loader programs that can never be allowlisted. */
const SOLANA_NATIVE_PROGRAMS: Readonly<Record<string, string>> = Object.freeze({
  BPFLoaderUpgradeab1e11111111111111111111111: "the upgradeable BPF loader",
  BPFLoader2111111111111111111111111111111111: "the BPF loader",
  BPFLoader1111111111111111111111111111111111: "the deprecated BPF loader",
  LoaderV411111111111111111111111111111111111: "loader v4",
  NativeLoader1111111111111111111111111111111: "the native loader",
  Stake11111111111111111111111111111111111111: "the Stake program",
  Vote111111111111111111111111111111111111111: "the Vote program",
  Config1111111111111111111111111111111111111: "the Config program",
  Ed25519SigVerify111111111111111111111111111: "the Ed25519 precompile",
  KeccakSecp256k11111111111111111111111111111: "the secp256k1 precompile",
  Secp256r1SigVerify1111111111111111111111111: "the secp256r1 precompile",
});

export function hasOwn(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

const EVM_DENIED_ADDRESSES: readonly { readonly address: string; readonly reason: string }[] = [
  { address: "0x0000000000000000000000000000000000000000", reason: "the zero address" },
  { address: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", reason: "the native-asset placeholder address" },
  { address: "0x000000000022D473030F116dDEE9F6B43aC78BA3", reason: "Permit2 (signature approvals of every token)" },
  { address: "0xcA11bde05977b3631167028862bE2a173976CA11", reason: "Multicall3 (executes arbitrary calls)" },
  { address: "0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02", reason: "a system contract (EIP-4788 beacon roots)" },
  { address: "0x0000F90827F1C53a10cb7A02335B175320002935", reason: "a system contract (EIP-2935 block hashes)" },
  { address: "0x00000961Ef480Eb55e80D19ad83579A64c007002", reason: "a system contract (EIP-7002 withdrawals)" },
  { address: "0x0000BBdDc7CE488642fb579F8B00f3a590007251", reason: "a system contract (EIP-7251 consolidations)" },
  { address: "0x4e59b44847b379578588920cA78FbF26c0B4956C", reason: "the deterministic deployment proxy (deploys arbitrary code)" },
  { address: "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789", reason: "the ERC-4337 EntryPoint v0.6 (executes arbitrary calls)" },
  { address: "0x0000000071727De22E5E9d8BAf0edAc6f37da032", reason: "the ERC-4337 EntryPoint v0.7 (executes arbitrary calls)" },
];
const EVM_DENIED_BY_ADDRESS = new Map(EVM_DENIED_ADDRESSES.map((entry) => [entry.address.toLowerCase(), entry.reason]));
const OP_STACK: readonly NetworkKey[] = ["base", "optimism"];
const ARBITRUM_STACK: readonly NetworkKey[] = ["arbitrum", "arbitrum-sepolia"];

function lowAddressReason(network: NetworkKey, value: bigint): string {
  if (value >= 0x01n && value <= 0x11n) return "an EVM precompile";
  if (value === 0x100n) return "the P-256 precompile (RIP-7212)";
  if (ARBITRUM_STACK.includes(network) && ((value >= 0x64n && value <= 0x6fn) || value === 0xc8n)) return "an Arbitrum precompile";
  if (network === "polygon" && value === 0x1010n) return "Polygon's native POL token contract";
  return "a reserved system address";
}

/**
 * Why `address` can never be registered or called on `network`, or null.
 * EVM: zero / placeholder addresses, registry tokens (`ASSETS`), venue
 * contracts (`VENUE_CONTRACTS`: routers and aggregators accept arbitrary
 * calldata), Permit2, Multicall3, ERC-4337 EntryPoints, the deterministic
 * deployer, system contracts, precompiles and every address up to 0xffff,
 * OP-stack predeploys (Base, OP) and Arbitrum precompiles. Solana: built-in,
 * native and loader programs and venue programs. `extra` adds configured
 * entries as `network:address` (e.g. `KLETIA_CONTRACT_DENYLIST`).
 * `YIELD_VENUES` are not denied.
 */
export function deniedTargetReason(network: NetworkKey, address: string, extra?: Iterable<string>): string | null {
  const chain = CHAINS[network];
  if (!chain) return "an unknown network";
  if (chain.vm === "svm") {
    if (hasOwn(SOLANA_ACTION_BUILTIN_PROGRAMS, address)) return `${SOLANA_ACTION_BUILTIN_PROGRAMS[address]} is a built-in program handled by fixed rules`;
    if (hasOwn(SOLANA_NATIVE_PROGRAMS, address)) return `${SOLANA_NATIVE_PROGRAMS[address]} cannot be allowlisted`;
    const venue = VENUE_CONTRACTS.find((entry) => entry.network === network && entry.address === address);
    if (venue) return `a ${venue.protocol} venue program`;
    const asset = ASSETS.find((entry) => entry.network === network && entry.address === address);
    if (asset) return `the ${asset.symbol} mint`;
  } else {
    if (!isEvmAddress(address)) return "not an EVM address";
    const lower = address.toLowerCase();
    const fixed = EVM_DENIED_BY_ADDRESS.get(lower);
    if (fixed) return fixed;
    const value = BigInt(lower);
    if (value <= 0xffffn) return lowAddressReason(network, value);
    const asset = ASSETS.find((entry) => entry.network === network && entry.address?.toLowerCase() === lower);
    if (asset) return `the ${asset.symbol} token (tokens are never called directly)`;
    const venue = VENUE_CONTRACTS.find((entry) => entry.network === network && entry.address.toLowerCase() === lower);
    if (venue) return `a ${venue.protocol} ${venue.role} contract (routers and aggregators accept arbitrary calldata)`;
    if (OP_STACK.includes(network) && lower.startsWith("0x42000000000000000000000000000000000000")) return "an OP-stack predeploy";
  }
  if (extra) {
    for (const entry of extra) {
      const colon = entry.indexOf(":");
      if (colon <= 0) continue;
      const entryNetwork = entry.slice(0, colon).trim();
      const entryAddress = entry.slice(colon + 1).trim();
      if (entryNetwork !== network) continue;
      const same = chain.vm === "evm" ? entryAddress.toLowerCase() === address.toLowerCase() : entryAddress === address;
      if (same) return "on this deployment's deny list";
    }
  }
  return null;
}
