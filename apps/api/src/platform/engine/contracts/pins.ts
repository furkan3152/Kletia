/**
 * Code-identity pins of registered EVM contracts.
 *
 * A registration pins the target's code hash and, for a proxy, the
 * implementation (address + code hash), admin and beacon, read in this order:
 *
 * | Pattern | How |
 * |---|---|
 * | EIP-1967 implementation | slot `0x3608…2bbc` |
 * | EIP-1967 beacon | slot `0xa3f0…3d50` → `beacon.implementation()` |
 * | EIP-1822 (UUPS legacy) | slot `0xc5f1…bcf7` |
 * | ZeppelinOS legacy | slot `0x7050…f8c3` (admin `0x10d6…390b`); Base USDC |
 * | EIP-1167 minimal proxy | code `0x363d3d37…5bf3` |
 *
 * Base USDC answers zero on every EIP-1967 slot: an EIP-1967-only detector
 * would pin the USDC proxy as a plain contract and miss upgrades. Every
 * `addresses` entry (approval spenders, event emitters) is pinned the same
 * way. Pins are re-read at every plan (cached 30 s), at every prepare (fresh)
 * and at the receipt block on verify; any difference refuses the step.
 */
import { getAddress, keccak256 } from "viem";
import { type ContractAddressEntry, type EvmCodePin, type EvmContractPins, type EvmProxyKind, type EvmProxyPin } from "@kletia/core";
import { EMPTY_CODE_HASH, rawEthCall, readCode, readCodeHash, readLatestBlockNumber, readStorageSlot, type EvmNetworkKey } from "../chains/evm.js";

export const PROXY_SLOTS = Object.freeze({
  eip1967Implementation: "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
  eip1967Admin: "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103",
  eip1967Beacon: "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50",
  eip1822: "0xc5f16f0fcc639fa48a6947836d9850f504798523bf8c9a3a87d5876cf622bcf7",
  zeppelinosImplementation: "0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3",
  zeppelinosAdmin: "0x10d6a54a4754c8869d6886b5f5d7fbfa5b4522237ea5c60d11bc4e7a1ff9390b",
});

const EIP1167_CODE = /^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/u;
const EIP7702_CODE = /^0xef0100([0-9a-f]{40})$/u;
/** `implementation()` (beacons). */
const IMPLEMENTATION_SELECTOR = "0x5c60da1b";
/** `supportsInterface(0x48e2b093)`: the EIP-2535 diamond loupe. */
const DIAMOND_LOUPE_CALL = "0x01ffc9a748e2b09300000000000000000000000000000000000000000000000000000000";

/**
 * Inspection hints that refuse a registration (CONTRACT_PROXY_UNSUPPORTED):
 * diamonds, an implementation slot pointing at an address without code, an
 * unreadable beacon, several proxy patterns at once, or a slot holding
 * something other than an address.
 */
export const PROXY_REFUSAL_HINTS: readonly string[] = Object.freeze([
  "eip2535-diamond",
  "implementation-without-code",
  "beacon-implementation-unreadable",
  "multiple-proxy-patterns",
  "unrecognised-proxy-slot",
]);

export interface EvmContractInspection {
  readonly codeSize: number;
  /** EIP-7702 delegated EOA (`0xef0100` + address): refused, its code can change at any time. */
  readonly eip7702: boolean;
  readonly pins: EvmContractPins;
  /**
   * Observations about the proxy shape: the detected kind (`eip1967`,
   * `zeppelinos`, ...), `not-deployed`, `eip7702-delegation`,
   * `eip1967-admin-unset`, and the refusal hints of PROXY_REFUSAL_HINTS.
   */
  readonly proxyHints: string[];
}

function wordAddress(word: string): { readonly address: string | null; readonly clean: boolean } {
  const body = word.slice(2).padStart(64, "0");
  if (/^0{64}$/u.test(body)) return { address: null, clean: true };
  return { address: getAddress(`0x${body.slice(24)}`), clean: /^0{24}$/u.test(body.slice(0, 24)) };
}

interface CodeRead {
  readonly pin: EvmCodePin;
  readonly hints: string[];
  readonly code: string;
}

/** Reads one address's pin at `block`: code hash, size and proxy shape. */
async function readCodePin(network: EvmNetworkKey, address: string, block: bigint): Promise<CodeRead> {
  const target = getAddress(address);
  const code = await readCode(network, target, block);
  const hints: string[] = [];
  const codeHash = code === "0x" ? EMPTY_CODE_HASH : keccak256(code);
  const codeSize = (code.length - 2) / 2;
  if (codeSize === 0) hints.push("not-deployed");
  if (EIP7702_CODE.test(code)) hints.push("eip7702-delegation");
  const words = await Promise.all([
    readStorageSlot(network, target, PROXY_SLOTS.eip1967Implementation, block),
    readStorageSlot(network, target, PROXY_SLOTS.eip1967Admin, block),
    readStorageSlot(network, target, PROXY_SLOTS.eip1967Beacon, block),
    readStorageSlot(network, target, PROXY_SLOTS.eip1822, block),
    readStorageSlot(network, target, PROXY_SLOTS.zeppelinosImplementation, block),
    readStorageSlot(network, target, PROXY_SLOTS.zeppelinosAdmin, block),
  ]);
  const [impl1967, admin1967, beacon1967, impl1822, implZos, adminZos] = words.map(wordAddress) as [
    ReturnType<typeof wordAddress>, ReturnType<typeof wordAddress>, ReturnType<typeof wordAddress>,
    ReturnType<typeof wordAddress>, ReturnType<typeof wordAddress>, ReturnType<typeof wordAddress>,
  ];
  if (words.map(wordAddress).some((entry) => entry.address !== null && !entry.clean)) hints.push("unrecognised-proxy-slot");
  const minimal = EIP1167_CODE.exec(code);
  const detected: { kind: EvmProxyKind; implementation: string | null; admin: string | null; beacon: string | null }[] = [];
  if (impl1967.address) detected.push({ kind: "eip1967", implementation: impl1967.address, admin: admin1967.address, beacon: null });
  if (beacon1967.address) detected.push({ kind: "eip1967-beacon", implementation: null, admin: admin1967.address, beacon: beacon1967.address });
  if (impl1822.address) detected.push({ kind: "eip1822", implementation: impl1822.address, admin: null, beacon: null });
  if (implZos.address) detected.push({ kind: "zeppelinos", implementation: implZos.address, admin: adminZos.address, beacon: null });
  if (minimal) detected.push({ kind: "eip1167", implementation: getAddress(`0x${minimal[1]}`), admin: null, beacon: null });
  if (detected.length > 1) hints.push("multiple-proxy-patterns");
  const chosen = detected[0];
  let proxy: EvmProxyPin | null = null;
  if (chosen) {
    hints.push(chosen.kind);
    if (chosen.kind === "eip1967" && !admin1967.address) hints.push("eip1967-admin-unset");
    let implementation = chosen.implementation;
    let beaconCodeHash: string | null = null;
    if (chosen.kind === "eip1967-beacon" && chosen.beacon) {
      beaconCodeHash = await readCodeHash(network, chosen.beacon, block);
      const returned = await rawEthCall(network, chosen.beacon, IMPLEMENTATION_SELECTOR, block);
      const parsed = returned && /^0x[0-9a-fA-F]{64}$/u.test(returned) ? wordAddress(returned) : null;
      if (!parsed?.address || !parsed.clean) hints.push("beacon-implementation-unreadable");
      implementation = parsed?.address ?? null;
    }
    const implementationCodeHash = implementation ? await readCodeHash(network, implementation, block) : EMPTY_CODE_HASH;
    if (implementationCodeHash === EMPTY_CODE_HASH) hints.push("implementation-without-code");
    proxy = {
      kind: chosen.kind,
      implementation: implementation ?? "0x0000000000000000000000000000000000000000",
      implementationCodeHash,
      admin: chosen.admin,
      beacon: chosen.beacon,
      beaconCodeHash,
    };
  }
  if (codeSize > 0 && !EIP7702_CODE.test(code)) {
    const loupe = await rawEthCall(network, target, DIAMOND_LOUPE_CALL, block);
    if (loupe && /^0x0{63}1$/u.test(loupe)) hints.push("eip2535-diamond");
  }
  return { pin: { address: target, codeHash, codeSize, proxy }, hints, code };
}

function entriesOf(extra: readonly (string | ContractAddressEntry)[] | undefined): ContractAddressEntry[] {
  return (extra ?? []).map((entry, index) =>
    typeof entry === "string" ? { label: `address-${index + 1}`, address: entry } : entry);
}

/**
 * Reads the pins of `address` and of every extra address at one block
 * (`blockNumber`, or the latest block). Throws only for RPC failures.
 */
export async function readEvmContractPins(
  network: EvmNetworkKey,
  address: string,
  extra?: readonly (string | ContractAddressEntry)[],
  blockNumber?: bigint,
): Promise<{ pins: EvmContractPins; hints: string[] }> {
  const block = blockNumber ?? (await readLatestBlockNumber(network));
  const entries = entriesOf(extra);
  const [main, ...others] = await Promise.all([
    readCodePin(network, address, block),
    ...entries.map((entry) => readCodePin(network, entry.address, block)),
  ]);
  const hints = [...(main as CodeRead).hints];
  others.forEach((read, index) => {
    for (const hint of read.hints) if (PROXY_REFUSAL_HINTS.includes(hint) || hint === "not-deployed" || hint === "eip7702-delegation") hints.push(`${entries[index]?.label}:${hint}`);
  });
  const { pin } = main as CodeRead;
  return {
    pins: {
      codeHash: pin.codeHash,
      codeSize: pin.codeSize,
      proxy: pin.proxy,
      addresses: others.map((read, index) => ({ label: (entries[index] as ContractAddressEntry).label, ...read.pin })),
      blockNumber: block.toString(),
      checkedAt: new Date().toISOString(),
    },
    hints,
  };
}

/**
 * Registration / reverify helper: pins plus everything P3 needs to refuse a
 * registration (not deployed, EIP-7702, unsupported proxy shapes).
 * `extra` are the definition's `addresses` (entries keep their labels; plain
 * strings are labelled `address-<n>`).
 */
export async function inspectEvmContract(
  network: EvmNetworkKey,
  address: string,
  extra?: readonly (string | ContractAddressEntry)[],
): Promise<EvmContractInspection> {
  const { pins, hints } = await readEvmContractPins(network, address, extra);
  return {
    codeSize: pins.codeSize,
    eip7702: hints.includes("eip7702-delegation"),
    pins,
    proxyHints: hints,
  };
}

/** Why an inspection refuses a registration as an unsupported proxy (CONTRACT_PROXY_UNSUPPORTED), or null. */
export function proxyRefusalReason(inspection: Pick<EvmContractInspection, "proxyHints">): string | null {
  const hint = inspection.proxyHints.find((entry) => PROXY_REFUSAL_HINTS.some((refusal) => entry === refusal || entry.endsWith(`:${refusal}`)));
  if (!hint) return null;
  const messages: Record<string, string> = {
    "eip2535-diamond": "it is an EIP-2535 diamond (facets can change without a pinned implementation)",
    "implementation-without-code": "its implementation slot points at an address without code",
    "beacon-implementation-unreadable": "its beacon does not report an implementation",
    "multiple-proxy-patterns": "it matches several proxy patterns at once",
    "unrecognised-proxy-slot": "a proxy slot holds something other than an address",
  };
  const [label, name] = hint.includes(":") ? hint.split(":") as [string, string] : [null, hint];
  return `${label ? `Address ${label}: ` : ""}${messages[name] ?? name}.`;
}

function same(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a ?? "").toLowerCase() === (b ?? "").toLowerCase();
}

function short(value: string | null | undefined): string {
  if (!value) return "none";
  return value.length > 14 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
}

function codeDiff(what: string, pinned: Pick<EvmCodePin, "codeHash" | "proxy">, current: Pick<EvmCodePin, "codeHash" | "proxy">): string | null {
  if (!same(pinned.codeHash, current.codeHash)) return `${what} code hash changed (${short(pinned.codeHash)} → ${short(current.codeHash)})`;
  const a = pinned.proxy;
  const b = current.proxy;
  if (!a && !b) return null;
  if (!a || !b) return `${what} proxy shape changed (${a?.kind ?? "plain"} → ${b?.kind ?? "plain"})`;
  if (a.kind !== b.kind) return `${what} proxy kind changed (${a.kind} → ${b.kind})`;
  if (!same(a.implementation, b.implementation)) return `${what} implementation changed (${short(a.implementation)} → ${short(b.implementation)})`;
  if (!same(a.implementationCodeHash, b.implementationCodeHash)) return `${what} implementation code hash changed (${short(a.implementationCodeHash)} → ${short(b.implementationCodeHash)})`;
  if (!same(a.admin, b.admin)) return `${what} proxy admin changed (${short(a.admin)} → ${short(b.admin)})`;
  if (!same(a.beacon, b.beacon)) return `${what} beacon changed (${short(a.beacon)} → ${short(b.beacon)})`;
  if (!same(a.beaconCodeHash, b.beaconCodeHash)) return `${what} beacon code hash changed (${short(a.beaconCodeHash)} → ${short(b.beaconCodeHash)})`;
  return null;
}

/** Description of the first difference between two pin sets, or null when they match (block and time ignored). */
export function compareEvmPins(pinned: EvmContractPins, current: EvmContractPins): string | null {
  const main = codeDiff("The contract's", pinned, current);
  if (main) return main;
  if (pinned.addresses.length !== current.addresses.length) return "The pinned address list changed.";
  for (const entry of pinned.addresses) {
    const other = current.addresses.find((candidate) => same(candidate.address, entry.address));
    if (!other) return `Pinned address ${entry.label} (${short(entry.address)}) is missing.`;
    const diff = codeDiff(`Address ${entry.label}'s`, entry, other);
    if (diff) return diff;
  }
  return null;
}

const PLAN_CACHE_MS = 30_000;
const planCache = new Map<string, { readonly at: number; readonly pins: EvmContractPins }>();

/**
 * Current pins for comparison against a snapshot. Plan reads may come from a
 * 30-second cache per (network, address set); prepare passes `fresh`.
 */
export async function currentEvmPins(
  network: EvmNetworkKey,
  address: string,
  extra: readonly ContractAddressEntry[],
  options: { readonly fresh?: boolean; readonly blockNumber?: bigint } = {},
): Promise<EvmContractPins> {
  const key = `${network}:${[address, ...extra.map((entry) => `${entry.label}=${entry.address}`)].join(",").toLowerCase()}`;
  const cached = planCache.get(key);
  if (!options.fresh && options.blockNumber === undefined && cached && Date.now() - cached.at < PLAN_CACHE_MS) return cached.pins;
  const { pins } = await readEvmContractPins(network, address, extra, options.blockNumber);
  if (options.blockNumber === undefined) planCache.set(key, { at: Date.now(), pins });
  return pins;
}

/** Forgets cached plan-time pins (tests). */
export function resetPinCache(): void {
  planCache.clear();
}
