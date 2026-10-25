/**
 * Contract inspection before registration.
 */
import {
  CONTRACT_LIMITS,
  classifyAbiFunction,
  deniedTargetReason,
  findAssetByAddress,
  resolveChain,
  toChecksumAddress,
  isEvmAddress,
  isSolanaAddress,
  type AbiFunctionClassification,
  type AbiFunctionItem,
  type ContractAbiItem,
  type ContractInspection,
  type ContractInspectionHints,
} from "@kletia/core";
import type { EvmNetworkKey } from "../../index.js";
import { rawEthCall } from "../../engine/chains/evm.js";
import {
  configuredDenylist,
  contractChecks,
  contractEngine,
} from "../contractChecks.js";
import { invalidRequest, isRecord } from "../context.js";
import { assertContractsEnabled } from "./records.js";
import { evmNetwork, solanaNetwork } from "./validation.js";

/* ================================================================ inspect */

function evmFunctions(abi: readonly ContractAbiItem[] | null): AbiFunctionClassification[] {
  if (!abi) return [];
  const out: AbiFunctionClassification[] = [];
  for (const item of abi) {
    if (!isRecord(item) || item.type !== "function" || typeof item.name !== "string" || !Array.isArray(item.inputs)) continue;
    try {
      out.push(classifyAbiFunction(item as unknown as AbiFunctionItem));
    } catch {
      // Malformed ABI entries from the provider are skipped.
    }
    if (out.length >= 200) break;
  }
  return out;
}

/** `asset()` of ERC-4626. */
const ASSET_SELECTOR = "0x38d52e0f";
const ERC4626_DEPOSIT_EVENT = "Deposit(address,address,uint256,uint256)";

type AssetReader = (network: EvmNetworkKey, vault: string) => Promise<string | null>;

/** One `eth_call` of `asset()` at the latest block; null when it reverts or returns something other than a clean address word. */
const liveAssetReader: AssetReader = async (network, vault) => {
  const word = await rawEthCall(network, vault, ASSET_SELECTOR);
  if (!word || !/^0x0{24}[0-9a-fA-F]{40}$/u.test(word) || /^0x0{64}$/u.test(word)) return null;
  return toChecksumAddress(`0x${word.slice(26)}`);
};
let assetReader: AssetReader = liveAssetReader;

/** Replaces the `asset()` read of the ERC-4626 inspect hint (tests); `null` restores the live read. */
export function configureInspectAssetReader(custom: AssetReader | null): void {
  assetReader = custom ?? liveAssetReader;
}

/** Whether a verified ABI is an ERC-4626 vault: `asset()`, `deposit(uint256,address)` and the standard `Deposit` event. */
function looksLikeErc4626(abi: readonly ContractAbiItem[] | null): boolean {
  if (!abi) return false;
  const items = abi.filter((item): item is ContractAbiItem & { name: string; inputs: { type: string }[] } =>
    isRecord(item) && typeof item.name === "string" && Array.isArray(item.inputs));
  const signature = (item: { name: string; inputs: { type: string }[] }) => `${item.name}(${item.inputs.map((input) => input.type).join(",")})`;
  const has = (type: string, wanted: string) => items.some((item) => item.type === type && signature(item) === wanted);
  return has("function", "asset()") && has("function", "deposit(uint256,address)") && has("event", ERC4626_DEPOSIT_EVENT);
}

/** Inspect hints; a failed `asset()` read leaves the hint out (it only prefills a wizard). */
async function inspectionHints(network: EvmNetworkKey, address: string, abi: readonly ContractAbiItem[] | null, deployed: boolean): Promise<ContractInspectionHints | null> {
  if (!deployed || !looksLikeErc4626(abi)) return null;
  const asset = await assetReader(network, address).catch(() => null);
  if (!asset) return null;
  return { erc4626: { asset, registrySymbol: findAssetByAddress(network, asset)?.symbol ?? null } };
}

/** GET /v1/contracts/inspect: what registration would pin and allow (wizard helper; nothing is stored). */
export async function inspectContract(query: { network?: string; address?: string; programs?: string }): Promise<ContractInspection> {
  assertContractsEnabled();
  const chain = query.network ? resolveChain(query.network) : null;
  if (!chain) throw invalidRequest("network is required: a network key, CAIP-2 id or EVM chain id.", [{ path: "network", message: "Required." }]);
  const network = chain.key;
  const denylist = configuredDenylist();
  if (chain.vm === "evm") {
    const address = query.address ?? "";
    if (!isEvmAddress(address)) throw invalidRequest("address must be a 0x-prefixed 20-byte address.", [{ path: "address", message: "Invalid EVM address." }]);
    const denied = deniedTargetReason(network, address, denylist);
    const inspection = await contractEngine().inspectEvmContract(evmNetwork(network), address);
    const deployed = inspection.codeSize > 0 && !inspection.eip7702;
    const checks = contractChecks();
    const source = await checks.sourcify(network, address, true);
    const implementation = deployed && inspection.pins.proxy ? await checks.sourcify(network, inspection.pins.proxy.implementation, true) : null;
    const abi = implementation?.abi ?? source.abi;
    const hints = await inspectionHints(evmNetwork(network), address, abi, deployed);
    return {
      vm: "evm",
      network,
      address,
      deployed,
      codeSize: inspection.codeSize,
      eip7702: inspection.eip7702,
      denied,
      pins: deployed ? inspection.pins : null,
      verification: { source: source.verification, implementationSource: implementation?.verification ?? null },
      abi,
      functions: evmFunctions(abi),
      ...(hints ? { hints } : {}),
    };
  }
  const programs = (query.programs ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
  if (programs.length === 0 || programs.length > CONTRACT_LIMITS.programs || programs.some((program) => !isSolanaAddress(program))) {
    throw invalidRequest(`programs must list 1-${CONTRACT_LIMITS.programs} base58 program ids, comma separated.`, [{ path: "programs", message: "Invalid program list." }]);
  }
  const engine = contractEngine();
  const solana = solanaNetwork(network);
  const views = await Promise.all(
    [...new Set(programs)].map(async (program) => {
      const [pin, verification] = await Promise.all([
        engine.readSolanaProgramPins(solana, [program]).then((pins) => pins[0] ?? null).catch(() => null),
        contractChecks().ottersec(program),
      ]);
      return { program, pin, denied: deniedTargetReason(network, program, denylist), verification };
    }),
  );
  return { vm: "svm", network, programs: views };
}
