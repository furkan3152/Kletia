/**
 * Recipient name resolvers registered through the engine's name hook
 * (names.ts): ENS (`*.eth`, Ethereum mainnet registry), Basenames
 * (`*.base.eth`, Base registry) and SNS (`*.sns`, Solana Name Service).
 *
 * Policy, shared by every resolver:
 * - Names are ENSIP-15 normalised (EVM); every read is pinned to one block or
 *   slot, which is recorded as the resolution's reference.
 * - No offchain lookups: EVM reads are raw eth_calls, so a CCIP-Read
 *   (OffchainLookup) resolver is refused instead of followed.
 * - Coin types: an Ethereum recipient uses the ETH record (coin type 60). A
 *   recipient on another EVM network uses that chain's ENSIP-11 record, then
 *   the ENSIP-19 default-EVM record; the ETH record is a fallback only when
 *   the address is an externally owned account (no code, or only an EIP-7702
 *   delegation, on Ethereum and on the target) or a contract deployed on the
 *   target network, and the fallback is disclosed as a warning. A contract that exists only on Ethereum is
 *   refused: funds sent to it on another network could be lost.
 * - SNS resolves `.sns` names on-chain to the registry owner; `.sol` is
 *   refused while SNS pauses it for the registry migration. When the name has
 *   a SOL record or an active tokenized-name record (which can point
 *   elsewhere), the owner is accepted only if SNS's resolver agrees.
 * - Addresses are checked further by the planner (namespace, self-transfer)
 *   and the transfer adapters (Solana wallet-account check).
 *
 * `installNameResolvers()` registers all three once; call it at startup.
 */
import { createHash } from "node:crypto";
import {
  address as solanaAddress,
  getAddressDecoder,
  getAddressEncoder,
  getProgramDerivedAddress,
  isOffCurveAddress,
} from "@solana/kit";
import {
  BaseError,
  decodeErrorResult,
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  parseAbi,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { namehash, normalize, packetToBytes, toCoinType } from "viem/ens";
import { CHAINS, venueContracts, type NetworkKey } from "@kletia/core";
import {
  ETH_COIN_TYPE,
  BASENAMES_RESOLVERS,
  readBasenameRecords,
  type BasenameRecords,
} from "../../networks/base/intent/basenameResolver.js";
import { solanaRpc } from "../../networks/solana/index.js";
import { fetchProviderJson, isRecord } from "../../networks/solana/http.js";
import { rpcAbortSignal } from "../../networks/solana/rpc.js";
import { PlatformError } from "../errors.js";
import { evmClient, isEvmNetwork, type EvmNetworkKey } from "./chains/evm.js";
import { nameResolvers, registerNameResolver, type NameResolution, type NameResolver } from "./names.js";
import { shortAddress } from "./util.js";

/** EVM networks whose recipients ENS and Basenames resolve. */
const EVM_NAME_NETWORKS: readonly NetworkKey[] = ["ethereum", "base", "arbitrum", "optimism", "polygon"];
/** ENSIP-19 default EVM coin type: one address for every EVM chain. */
export const DEFAULT_EVM_COIN_TYPE = 0x80000000n;

/* ------------------------------------------------------------ coin types */

/** Coin types to try, in order, for a recipient on `network` (the ETH record is handled by the fallback policy). */
export function preferredCoinTypes(network: NetworkKey): bigint[] {
  if (network === "ethereum") return [ETH_COIN_TYPE];
  const chainId = CHAINS[network].evmChainId;
  if (chainId === undefined) return [];
  return [toCoinType(chainId), DEFAULT_EVM_COIN_TYPE];
}

interface CoinTypeChoice {
  readonly address: Address;
  readonly coinType: bigint;
  readonly warnings: readonly string[];
}

/**
 * What lives at `address`: nothing, an EIP-7702 delegation designator
 * (0xef0100 + target: still an externally owned account) or contract code.
 */
async function accountKind(client: PublicClient, address: Address): Promise<"eoa" | "contract"> {
  const code = await client.request({ method: "eth_getCode", params: [address, "latest"] });
  if (typeof code !== "string" || code === "0x" || code === "0x0") return "eoa";
  return /^0xef0100[0-9a-f]{40}$/iu.test(code) ? "eoa" : "contract";
}

export interface EvmNameDependencies {
  /** RPC client per EVM network (defaults to the engine's clients). */
  readonly client: (network: EvmNetworkKey) => PublicClient;
}

const defaultEvmDependencies: EvmNameDependencies = { client: evmClient };

/**
 * Applies the coin-type policy to a name's records. `record(coinType)` reads
 * one record (null when unset). Returns null when no acceptable record exists.
 */
async function chooseAddress(
  name: string,
  network: NetworkKey,
  record: (coinType: bigint) => Promise<Address | null>,
  dependencies: EvmNameDependencies,
): Promise<CoinTypeChoice | null> {
  for (const coinType of preferredCoinTypes(network)) {
    const address = await record(coinType);
    if (address) return { address, coinType, warnings: [] };
  }
  if (network === "ethereum") return null;
  const address = await record(ETH_COIN_TYPE);
  if (!address || !isEvmNetwork(network)) return null;
  const chain = CHAINS[network].name;
  const [onTarget, onEthereum] = await Promise.all([
    accountKind(dependencies.client(network), address),
    accountKind(dependencies.client("ethereum"), address),
  ]);
  if (onTarget === "contract") {
    return { address, coinType: ETH_COIN_TYPE, warnings: [`${name} has no ${chain}-specific address; using its Ethereum address record, a contract deployed on ${chain}.`] };
  }
  if (onEthereum === "eoa") {
    return { address, coinType: ETH_COIN_TYPE, warnings: [`${name} has no ${chain}-specific address; using its Ethereum address record (an externally owned account, so the same key controls it on ${chain}).`] };
  }
  throw new PlatformError(
    "RECIPIENT_NAME_UNRESOLVED",
    `${name} has no ${chain} address, and its Ethereum address is a contract that does not exist on ${chain}; funds sent there could be lost. Use the recipient's ${chain} address.`,
    422,
    [{ path: "recipient", message: "No address record for this network." }],
  );
}

function coinTypeLabel(coinType: bigint): string {
  if (coinType === ETH_COIN_TYPE) return "coin type 60 (ETH)";
  if (coinType === DEFAULT_EVM_COIN_TYPE) return "default EVM coin type";
  return `coin type ${coinType.toString()}`;
}

function normalizeEnsName(name: string): string {
  try {
    return normalize(name);
  } catch {
    throw new PlatformError("RECIPIENT_INVALID", `"${name.slice(0, 64)}" is not a valid ENS name.`, 422);
  }
}

/* ------------------------------------------------------------------- ENS */

const UNIVERSAL_RESOLVER_ABI = parseAbi([
  "function resolve(bytes name, bytes data) view returns (bytes, address)",
  "error ResolverNotFound(bytes name)",
  "error ResolverNotContract(bytes name, address resolver)",
  "error UnsupportedResolverProfile(bytes4 selector)",
  "error ResolverError(bytes errorData)",
  "error ReverseAddressMismatch(string primary, bytes primaryAddress)",
  "error HttpError(uint16 status, string message)",
  "error OffchainLookup(address sender, string[] urls, bytes callData, bytes4 callbackFunction, bytes extraData)",
]);
const ADDR_ABI = parseAbi([
  "function addr(bytes32 node) view returns (address)",
  "function addr(bytes32 node, uint256 coinType) view returns (bytes)",
]);

type UniversalResult =
  | { readonly kind: "record"; readonly resolver: Address; readonly address: Address | null }
  | { readonly kind: "no-resolver" }
  | { readonly kind: "offchain" }
  | { readonly kind: "unsupported" };

function revertData(error: BaseError): Hex | null {
  const deepest = error.walk() as { data?: unknown };
  const data = typeof deepest.data === "object" && deepest.data !== null ? (deepest.data as { data?: unknown }).data : deepest.data;
  return typeof data === "string" && /^0x[0-9a-fA-F]*$/u.test(data) ? (data as Hex) : null;
}

/**
 * One Universal Resolver read (raw eth_call at `block`): the resolver it found
 * and the record, or why there is none. RPC failures throw.
 */
async function universalResolve(client: PublicClient, name: string, coinType: bigint, block: bigint): Promise<UniversalResult> {
  const universal = venueContracts("ens", "ethereum", "universal-resolver")[0];
  if (!universal) throw new PlatformError("NAME_RESOLVER_INVALID", "No ENS Universal Resolver is pinned for Ethereum.", 500);
  const node = namehash(name);
  const inner = coinType === ETH_COIN_TYPE
    ? encodeFunctionData({ abi: ADDR_ABI, functionName: "addr", args: [node] })
    : encodeFunctionData({ abi: ADDR_ABI, functionName: "addr", args: [node, coinType] });
  const data = encodeFunctionData({ abi: UNIVERSAL_RESOLVER_ABI, functionName: "resolve", args: [toHex(packetToBytes(name)), inner] });
  let raw: unknown;
  try {
    raw = await client.request({ method: "eth_call", params: [{ to: getAddress(universal), data }, toHex(block)] });
  } catch (error) {
    const reverted = error instanceof BaseError ? revertData(error) : null;
    if (!reverted) throw error;
    let errorName = "";
    try {
      errorName = decodeErrorResult({ abi: UNIVERSAL_RESOLVER_ABI, data: reverted }).errorName;
    } catch {
      errorName = "";
    }
    if (errorName === "OffchainLookup" || errorName === "HttpError") return { kind: "offchain" };
    if (errorName === "ResolverNotFound" || errorName === "ResolverNotContract") return { kind: "no-resolver" };
    return { kind: "unsupported" };
  }
  const [result, resolver] = decodeFunctionResult({ abi: UNIVERSAL_RESOLVER_ABI, functionName: "resolve", data: raw as Hex });
  let address: Address | null = null;
  try {
    if (coinType === ETH_COIN_TYPE) {
      const value = decodeFunctionResult({ abi: ADDR_ABI, functionName: "addr", args: [node], data: result });
      address = value && getAddress(value) !== zeroAddress ? getAddress(value) : null;
    } else {
      const value = decodeFunctionResult({ abi: ADDR_ABI, functionName: "addr", args: [node, coinType], data: result });
      address = typeof value === "string" && value.length === 42 && getAddress(value) !== zeroAddress ? getAddress(value) : null;
    }
  } catch {
    address = null;
  }
  return { kind: "record", resolver: getAddress(resolver), address };
}

/** ENS names on Ethereum mainnet, through the pinned Universal Resolver (no CCIP-Read). */
export function createEnsResolver(dependencies: EvmNameDependencies = defaultEvmDependencies): NameResolver {
  return {
    id: "ens",
    protocol: "ens",
    suffixes: [".eth"],
    networks: EVM_NAME_NETWORKS,
    async resolve(rawName, network): Promise<NameResolution | null> {
      const name = normalizeEnsName(rawName);
      const client = dependencies.client("ethereum");
      const block = await client.getBlockNumber();
      let resolver: Address | null = null;
      const record = async (coinType: bigint) => {
        const result = await universalResolve(client, name, coinType, block);
        if (result.kind === "offchain") {
          throw new PlatformError(
            "RECIPIENT_NAME_UNRESOLVED",
            `${name} uses an offchain (CCIP-Read) resolver, which Kletia does not follow. Use the recipient's address.`,
            422,
            [{ path: "recipient", message: "Offchain resolvers are not supported." }],
          );
        }
        if (result.kind !== "record") return null;
        resolver = result.resolver;
        return result.address;
      };
      const choice = await chooseAddress(name, network, record, dependencies);
      if (!choice) return null;
      return {
        name,
        address: choice.address,
        protocol: "ens",
        detail: `ENS resolver ${shortAddress(resolver ?? zeroAddress)} via the Universal Resolver, ${coinTypeLabel(choice.coinType)}, Ethereum block ${block.toString()}`,
        reference: block.toString(),
        ...(choice.warnings.length > 0 ? { warnings: choice.warnings } : {}),
      };
    },
  };
}

/* ------------------------------------------------------------- Basenames */

export interface BasenameDependencies extends EvmNameDependencies {
  readonly read: (name: string, coinTypes: readonly bigint[]) => Promise<BasenameRecords | null>;
}

const defaultBasenameDependencies: BasenameDependencies = {
  ...defaultEvmDependencies,
  read: (name, coinTypes) => readBasenameRecords(name, coinTypes, evmClient("base")),
};

/** Basenames (`*.base.eth`) through the Base registry's resolver for the name. */
export function createBasenamesResolver(dependencies: BasenameDependencies = defaultBasenameDependencies): NameResolver {
  return {
    id: "basenames",
    protocol: "basenames",
    suffixes: [".base.eth"],
    networks: EVM_NAME_NETWORKS,
    async resolve(rawName, network): Promise<NameResolution | null> {
      const name = normalizeEnsName(rawName);
      const wanted = [...new Set([...preferredCoinTypes(network), ETH_COIN_TYPE])];
      const records = await dependencies.read(name, wanted);
      if (!records) return null;
      const choice = await chooseAddress(name, network, async (coinType) => records.addresses.get(coinType) ?? null, dependencies);
      if (!choice) return null;
      const known = BASENAMES_RESOLVERS.some((resolver) => resolver.toLowerCase() === records.resolver.toLowerCase());
      const warnings = [
        ...choice.warnings,
        ...(known ? [] : [`${name} uses a custom resolver (${shortAddress(records.resolver)}) chosen by its owner, not a Basenames resolver.`]),
      ];
      return {
        name: records.name,
        address: choice.address,
        protocol: "basenames",
        detail: `Base registry resolver ${shortAddress(records.resolver)}, ${coinTypeLabel(choice.coinType)}, Base block ${records.block.toString()}`,
        reference: records.block.toString(),
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    },
  };
}

/* ------------------------------------------------------------------- SNS */

const SNS_NAME_PROGRAM = venueContracts("sns", "solana", "name-program")[0] ?? "namesLPneVptA9Z5rqUDD9tMTWEJwofgaYwp8cawRkX";
/** Root of `.sns` names (the legacy `.sol` root account; SNS renamed it when `.sol` moved to its new registry). */
const SNS_ROOT = venueContracts("sns", "solana", "tld-parent")[0] ?? "58PwtjSDuFHuUkYjH9BYnnQKHfwo9reZhC2zMJv9JPkx";
/** Name tokenizer: an active NFT record makes the NFT holder the effective owner. */
const SNS_TOKENIZER = "nftD3vbNkNqfj2Sd3HZwbpw4BxxKWr4AjGb9X38JeZk";
/** SNS records V2 class: PDA([records program], records program HP3D4D1ZCmohQGFVms2SS4LCANgJyksBf5s1F77FuFjZ). */
const SNS_RECORDS_V2_CLASS = "2pMnqHvei2N5oDcVGCRdZx48gqti199wr5CsyTTafsbo";
const SNS_PROXY_URL = "https://sdk-proxy-v2.sns.id";
const NFT_RECORD_ACTIVE = 2;
const NAME_HEADER_BYTES = 96;
const DEFAULT_PUBKEY = "11111111111111111111111111111111";

interface SnsAccount {
  readonly owner: string;
  readonly data: Uint8Array;
}

export interface SnsDependencies {
  /** Accounts at one slot (null entries for missing accounts). */
  readonly readAccounts: (addresses: readonly string[]) => Promise<{ readonly slot: bigint; readonly accounts: readonly (SnsAccount | null)[] }>;
  /** SNS's own resolution (records and tokenized names), consulted only when such records exist. */
  readonly resolveWithSns: (name: string) => Promise<string | null>;
}

async function readSnsAccounts(addresses: readonly string[]) {
  const response = await solanaRpc("solana")
    .getMultipleAccounts(addresses.map((entry) => solanaAddress(entry)), { encoding: "base64", commitment: "confirmed" })
    .send({ abortSignal: rpcAbortSignal() });
  return {
    slot: BigInt(response.context.slot),
    accounts: response.value.map((account) => account
      ? { owner: String(account.owner), data: new Uint8Array(Buffer.from(String(account.data[0] ?? ""), "base64")) }
      : null),
  };
}

async function snsProxyResolve(name: string): Promise<string | null> {
  const body = await fetchProviderJson<unknown>(`${SNS_PROXY_URL}/resolve/${encodeURIComponent(name)}`, { provider: "SNS", maxBytes: 4_096 });
  return isRecord(body) && body.s === "ok" && typeof body.result === "string" ? body.result : null;
}

const defaultSnsDependencies: SnsDependencies = { readAccounts: readSnsAccounts, resolveWithSns: snsProxyResolve };

const encoder = getAddressEncoder();
const decoder = getAddressDecoder();

async function nameAccountKey(name: string, nameClass: string | null, parent: string | null): Promise<string> {
  const hashed = createHash("sha256").update(`SPL Name Service${name}`, "utf8").digest();
  const [key] = await getProgramDerivedAddress({
    programAddress: solanaAddress(SNS_NAME_PROGRAM),
    seeds: [hashed, nameClass ? encoder.encode(solanaAddress(nameClass)) : new Uint8Array(32), parent ? encoder.encode(solanaAddress(parent)) : new Uint8Array(32)],
  });
  return String(key);
}

/** Accounts SNS-IP 5 resolution reads for `label.sns`: the name, its NFT record and its SOL records (V1, V2). */
export async function snsAccountKeys(label: string): Promise<{ domain: string; nftRecord: string; solRecordV1: string; solRecordV2: string }> {
  const domain = await nameAccountKey(label, null, SNS_ROOT);
  const [nftRecord] = await getProgramDerivedAddress({
    programAddress: solanaAddress(SNS_TOKENIZER),
    seeds: [new TextEncoder().encode("nft_record"), encoder.encode(solanaAddress(domain))],
  });
  return {
    domain,
    nftRecord: String(nftRecord),
    solRecordV1: await nameAccountKey("\x01SOL", null, domain),
    solRecordV2: await nameAccountKey("\x02SOL", SNS_RECORDS_V2_CLASS, domain),
  };
}

/** SNS `.sns` names on Solana mainnet, resolved on-chain to the registry owner. */
export function createSnsResolver(dependencies: SnsDependencies = defaultSnsDependencies): NameResolver {
  return {
    id: "sns",
    protocol: "sns",
    suffixes: [".sns", ".sol"],
    networks: ["solana"],
    async resolve(name): Promise<NameResolution | null> {
      if (name.endsWith(".sol")) {
        throw new PlatformError(
          "RECIPIENT_NAME_UNSUPPORTED",
          `.sol names are paused by SNS while it moves them to its new registry. Use the same name with .sns (${name.slice(0, -4)}.sns) or the recipient's address.`,
          422,
          [{ path: "recipient", message: ".sol resolution is paused." }],
        );
      }
      const labels = name.split(".");
      if (labels.length !== 2 || !labels[0]) {
        throw new PlatformError("RECIPIENT_NAME_UNSUPPORTED", `Kletia resolves top-level .sns names only, not subdomains like ${name.slice(0, 64)}.`, 422);
      }
      const keys = await snsAccountKeys(labels[0]);
      const { slot, accounts } = await dependencies.readAccounts([keys.domain, keys.nftRecord, keys.solRecordV1, keys.solRecordV2]);
      const [domain, nftRecord, solRecordV1, solRecordV2] = accounts;
      if (!domain) return null;
      const data = domain.data;
      if (domain.owner !== SNS_NAME_PROGRAM || data.length < NAME_HEADER_BYTES ||
          String(decoder.decode(data.subarray(0, 32))) !== SNS_ROOT || String(decoder.decode(data.subarray(64, 96))) !== DEFAULT_PUBKEY) {
        throw new PlatformError("RECIPIENT_NAME_UNRESOLVED", `${name} is not a registered .sns name.`, 422);
      }
      const owner = String(decoder.decode(data.subarray(32, 64)));
      if (owner === DEFAULT_PUBKEY || isOffCurveAddress(solanaAddress(owner))) {
        throw new PlatformError(
          "RECIPIENT_NAME_UNRESOLVED",
          `${name} is owned by a program account, not a wallet. Use the recipient's wallet address.`,
          422,
          [{ path: "recipient", message: "The name's owner is not a wallet." }],
        );
      }
      // A SOL record or an active tokenized name can point elsewhere: accept the owner only when SNS resolves to it too.
      const overridden = (nftRecord !== null && nftRecord.data[0] === NFT_RECORD_ACTIVE) || solRecordV1 !== null || solRecordV2 !== null;
      if (overridden) {
        const resolved = await dependencies.resolveWithSns(name);
        if (resolved !== owner) {
          throw new PlatformError(
            "RECIPIENT_NAME_UNRESOLVED",
            `${name} points to a wallet through an SNS record or tokenized name that Kletia does not verify on-chain. Use the recipient's address.`,
            422,
            [{ path: "recipient", message: "The name's records override its owner." }],
          );
        }
      }
      return {
        name,
        address: owner,
        protocol: "sns",
        detail: `SNS name account ${shortAddress(keys.domain)} (registry owner${overridden ? ", confirmed by SNS's resolver" : ""}), slot ${slot.toString()}`,
        reference: slot.toString(),
      };
    },
  };
}

/* ---------------------------------------------------------------- install */

export const ensNameResolver = createEnsResolver();
export const basenamesNameResolver = createBasenamesResolver();
export const snsNameResolver = createSnsResolver();
export const NAME_RESOLVERS: readonly NameResolver[] = Object.freeze([ensNameResolver, basenamesNameResolver, snsNameResolver]);

/**
 * Registers ENS, Basenames and SNS with the name hook (idempotent: a
 * resolver id that is already registered is skipped). Returns a function that
 * removes the resolvers this call registered.
 */
export function installNameResolvers(resolvers: readonly NameResolver[] = NAME_RESOLVERS): () => void {
  const registered = new Set(nameResolvers().map((resolver) => resolver.id));
  const removers = resolvers
    .filter((resolver) => !registered.has(resolver.id))
    .map((resolver) => registerNameResolver(resolver));
  return () => {
    for (const remove of removers) remove();
  };
}

