/**
 * Solana Actions (blinks) as the program integration path.
 *
 * Kletia fetches the action server's transaction for the user's account,
 * holds it to fixed rules before any wallet sees it, simulates it and
 * proves the landed result:
 *
 * - Fetch: `POST href` `{ account, data }` through the directory's
 *   SSRF-guarded transport. Only `transaction` responses (a missing `type`
 *   with a `transaction` counts) are accepted; `message`, `post`,
 *   `external-link` and `links.next` chaining are refused.
 * - Structure: wire size ≤ 1,232 bytes, legacy or v0, one signer = fee payer
 *   = user, every signature slot empty, no durable nonce, top-level programs
 *   ⊆ the allowlist ∪ {ComputeBudget, System, Token, Token-2022, ATA, Memo,
 *   Lighthouse} with restricted System / Token / ATA instructions, capped
 *   compute budget and priority fee, primary program invoked.
 * - Simulation: `simulateTransaction` with inner instructions and the post
 *   states of the user's accounts: no error, exact input debit, no other
 *   debit, declared output credited, the user's wallet still a plain System
 *   account, the user's token accounts keep owner, no delegate and their
 *   close authority, and no Approve / SetAuthority / Assign / Allocate
 *   touching the user's accounts anywhere in the CPI tree.
 */
import { createHash } from "node:crypto";
import {
  address as toAddress,
  getAddressDecoder,
  getAddressEncoder,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
  getProgramDerivedAddress,
  getTransactionDecoder,
  getTransactionEncoder,
  type Blockhash,
} from "@solana/kit";
import {
  CHAINS,
  CONTRACT_LIMITS,
  WRAPPED_SOL_MINT,
  type SolanaActionMetadata,
  type SolanaProgramPin,
} from "@kletia/core";
import { isPlatformError, PlatformError } from "../../errors.js";
import { type SolanaNetworkKey } from "../../../networks/solana/index.js";
import {
  readProgramPins,
  readU64,
  SOLANA_PROGRAM_IDS,
  type DecodedSolanaInstruction,
  type DecodedSolanaTransaction,
  type SolanaAccountState,
  type SolanaInnerInstruction,
  type SolanaInstructionView,
  type SolanaTokenBalance,
} from "../chains/solana.js";
import { isRecord } from "../util.js";
import type { ActionTransport } from "./directory.js";

export const LIGHTHOUSE_PROGRAM = "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95";
export const MEMO_PROGRAMS: readonly string[] = ["MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo"];
const TOKEN_PROGRAMS: readonly string[] = [SOLANA_PROGRAM_IDS.token, SOLANA_PROGRAM_IDS.token2022];
/** Spec version this client speaks (`X-Accept-Action-Version`). */
export const ACTION_VERSION = "2.4";

/* ----------------------------------------------------------------- program pins */

/** Pins of allowlisted programs (registration, reverify, every plan and prepare). */
export async function readSolanaProgramPins(network: SolanaNetworkKey, programs: readonly string[]): Promise<SolanaProgramPin[]> {
  return readProgramPins(network, programs);
}

/** Description of the first program pin that differs, or null when all match. */
export function compareSolanaProgramPins(pinned: readonly SolanaProgramPin[], current: readonly SolanaProgramPin[]): string | null {
  for (const pin of pinned) {
    const now = current.find((entry) => entry.program === pin.program);
    if (!now) return `Program ${pin.program} could not be read.`;
    if (now.loader !== pin.loader) return `Program ${pin.program} changed loader.`;
    if ((now.programData ?? null) !== (pin.programData ?? null)) return `Program ${pin.program} changed its program data account.`;
    if ((now.lastDeploySlot ?? null) !== (pin.lastDeploySlot ?? null)) return `Program ${pin.program} was redeployed (slot ${pin.lastDeploySlot ?? "?"} → ${now.lastDeploySlot ?? "?"}).`;
    if ((now.upgradeAuthority ?? null) !== (pin.upgradeAuthority ?? null)) return `Program ${pin.program} changed upgrade authority.`;
    if ((now.dataHash ?? null) !== (pin.dataHash ?? null)) return `Program ${pin.program} changed code.`;
  }
  return null;
}

/* --------------------------------------------------------------------- fetching */

function endpointUnavailable(message: string): PlatformError {
  return new PlatformError("ACTION_ENDPOINT_UNAVAILABLE", message, 502);
}

function responseInvalid(message: string): PlatformError {
  return new PlatformError("ACTION_RESPONSE_INVALID", message, 502);
}

function header(headers: Record<string, string>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === wanted) return value;
  return undefined;
}

function plain(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu, " ").trim();
  return text ? text.slice(0, max) : undefined;
}

/** Placeholder-free URL of an action template: placeholder segments and query parameters are dropped. */
export function actionMetadataUrl(href: string): string {
  const url = new URL(href.replace(/\{[A-Za-z][A-Za-z0-9_]{0,31}\}/gu, "%7Bkletia%7D"));
  const segments = url.pathname.split("/").filter((segment) => !segment.includes("%7Bkletia%7D"));
  url.pathname = segments.join("/") || "/";
  for (const [key, value] of [...url.searchParams.entries()]) {
    if (value.includes("{kletia}")) url.searchParams.delete(key);
  }
  return url.href.replace(/%7Bkletia%7D/giu, "");
}

async function transportCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (isPlatformError(error)) throw error;
    throw endpointUnavailable("The action server did not answer.");
  }
}

/**
 * GETs an action's metadata (`ActionGetResponse`): title and label required,
 * `disabled` recorded, and the `X-Blockchain-Ids` header (when present) must
 * name the network.
 */
export async function fetchSolanaActionMetadata(transport: ActionTransport, href: string, network: SolanaNetworkKey): Promise<SolanaActionMetadata> {
  const url = actionMetadataUrl(href);
  const response = await transportCall(() => transport.get(url));
  if (response.status < 200 || response.status >= 300) throw endpointUnavailable(`The action server answered HTTP ${response.status}.`);
  const body = response.json;
  if (!isRecord(body)) throw responseInvalid("The action metadata is not a JSON object.");
  if (body.error !== undefined && body.title === undefined) throw responseInvalid("The action server returned an error instead of metadata.");
  const title = plain(body.title, 120);
  const label = plain(body.label, 80);
  if (!title || !label) throw responseInvalid("The action metadata needs a title and a label.");
  if (body.type !== undefined && body.type !== "action" && body.type !== "completed") {
    throw new PlatformError("ACTION_RESPONSE_UNSUPPORTED", `Action metadata of type ${String(body.type).slice(0, 20)} is not supported.`, 422);
  }
  const blockchainIds = (header(response.headers, "x-blockchain-ids") ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
  if (blockchainIds.length > 0 && !blockchainIds.includes(CHAINS[network].id)) {
    throw new PlatformError("ACTION_RESPONSE_UNSUPPORTED", `The action serves ${blockchainIds.join(", ").slice(0, 120)}, not ${CHAINS[network].id}.`, 422);
  }
  const actionVersion = plain(header(response.headers, "x-action-version"), 20);
  const description = plain(body.description, 300);
  const icon = typeof body.icon === "string" && /^https:\/\//u.test(body.icon) ? body.icon.slice(0, 300) : undefined;
  return {
    url,
    title,
    label,
    ...(description ? { description } : {}),
    ...(icon ? { icon } : {}),
    disabled: body.disabled === true,
    ...(actionVersion ? { actionVersion } : {}),
    ...(blockchainIds.length > 0 ? { blockchainIds } : {}),
    fetchedAt: new Date().toISOString(),
  };
}

/** Fills an action template: `{amount}` (decimal), `{amountBaseUnits}` and declared params (URL-encoded). */
export function fillActionHref(template: string, values: { readonly amount?: string; readonly amountBaseUnits?: string; readonly params: Readonly<Record<string, string | number | boolean>> }): string {
  return template.replace(/\{([A-Za-z][A-Za-z0-9_]{0,31})\}/gu, (match, name: string) => {
    if (name === "amount" && values.amount !== undefined) return encodeURIComponent(values.amount);
    if (name === "amountBaseUnits" && values.amountBaseUnits !== undefined) return encodeURIComponent(values.amountBaseUnits);
    const param = values.params[name];
    if (param !== undefined) return encodeURIComponent(String(param));
    return match;
  });
}

/** Fills declared params only, keeping `{amount}` / `{amountBaseUnits}` (the step snapshot's `href`). */
export function fillActionParams(template: string, params: Readonly<Record<string, string | number | boolean>>): string {
  return fillActionHref(template, { params });
}

/**
 * POSTs `{ account, data }` to the filled action URL and returns the
 * unsigned base64 transaction. Refuses anything but a transaction response.
 */
export async function fetchActionTransaction(
  transport: ActionTransport,
  url: string,
  account: string,
  data: Readonly<Record<string, string | number | boolean>>,
): Promise<string> {
  if (/\{[A-Za-z]/u.test(url)) throw new PlatformError("ACTION_RESPONSE_INVALID", "The action URL still has unfilled placeholders.", 502);
  const response = await transportCall(() => transport.post(url, { account, ...(Object.keys(data).length > 0 ? { data } : {}) }));
  const body = response.json;
  if (response.status < 200 || response.status >= 300) {
    const message = isRecord(body) && typeof body.message === "string" ? `: ${plain(body.message, 160)}` : "";
    if (response.status >= 400 && response.status < 500 && message) {
      throw new PlatformError("ACTION_RESPONSE_INVALID", `The action server refused the request${message}`, 502);
    }
    throw endpointUnavailable(`The action server answered HTTP ${response.status}.`);
  }
  if (!isRecord(body)) throw responseInvalid("The action response is not a JSON object.");
  const type = body.type;
  if (type !== undefined && type !== "transaction") {
    throw new PlatformError("ACTION_RESPONSE_UNSUPPORTED", `Action responses of type ${String(type).slice(0, 20)} are not supported; Kletia executes transactions only.`, 422);
  }
  if (isRecord(body.links) && body.links.next !== undefined) {
    throw new PlatformError("ACTION_RESPONSE_UNSUPPORTED", "Chained actions (links.next) are not supported; chain steps through the intent instead.", 422);
  }
  if (typeof body.transaction !== "string") {
    if (body.error !== undefined || body.message !== undefined) throw responseInvalid(`The action server returned no transaction${typeof body.message === "string" ? `: ${plain(body.message, 160)}` : "."}`);
    throw responseInvalid("The action response has no transaction.");
  }
  if (body.transaction.length > 4_000 || !/^[A-Za-z0-9+/]+=*$/u.test(body.transaction)) throw responseInvalid("The action transaction is not base64.");
  return body.transaction;
}

/* ------------------------------------------------------------ structure rules */

function rejected(message: string): PlatformError {
  return new PlatformError("ACTION_TRANSACTION_REJECTED", message, 422);
}

export interface ActionRules {
  readonly user: string;
  readonly network: SolanaNetworkKey;
  /** Allowlisted top-level programs (registration `programs`). */
  readonly programs: readonly string[];
  readonly primaryProgram: string;
  readonly payees: readonly { readonly address: string; readonly maxLamports: string }[];
}

export interface ActionStructure {
  /** Lamports paid to declared payees by top-level System transfers. */
  readonly payeeLamports: bigint;
  /** Compute-unit limit × price, lamports (worst case when no limit is set). */
  readonly priorityFeeLamports: bigint;
  /** Writable non-signer accounts (pre-read for owner / delegate checks, post states simulated). */
  readonly writable: readonly string[];
}

/** Raw wire facts the decoder does not expose: size, signature slots, nonce use. */
export function wireFacts(base64: string): { readonly size: number; readonly signatures: number; readonly signed: boolean; readonly version: 0 | "legacy" } {
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(getBase64Encoder().encode(base64));
  } catch {
    throw responseInvalid("The action transaction is not base64.");
  }
  let transaction;
  try {
    transaction = getTransactionDecoder().decode(bytes);
  } catch {
    throw responseInvalid("The action transaction does not decode.");
  }
  const slots = Object.values(transaction.signatures);
  const signed = slots.some((signature) => signature !== null && signature !== undefined && [...signature].some((byte) => byte !== 0));
  const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  if (message.version !== 0 && message.version !== "legacy") throw rejected(`Transaction version ${String(message.version)} is not supported (legacy or v0 only).`);
  return { size: bytes.length, signatures: slots.length, signed, version: message.version };
}

function u32(data: Uint8Array, offset = 0): number | null {
  if (data.length < offset + 4) return null;
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset, true);
}

async function wsolAccountOf(owner: string): Promise<string> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: toAddress(SOLANA_PROGRAM_IDS.associatedToken),
    seeds: [getAddressEncoder().encode(toAddress(owner)), getAddressEncoder().encode(toAddress(SOLANA_PROGRAM_IDS.token)), getAddressEncoder().encode(toAddress(WRAPPED_SOL_MINT))],
  });
  return String(pda);
}

/** Checks one ComputeBudget instruction; returns the unit limit / price it sets. */
function computeBudget(instruction: SolanaInstructionView): { limit?: bigint; price?: bigint } {
  const data = instruction.data;
  const kind = data[0];
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (kind === 1 && data.length === 5) {
    if (view.getUint32(1, true) > CONTRACT_LIMITS.solanaMaxHeapBytes) throw rejected("The transaction requests a heap frame above 256 KB.");
    return {};
  }
  if (kind === 2 && data.length === 5) {
    const limit = BigInt(view.getUint32(1, true));
    if (limit > BigInt(CONTRACT_LIMITS.solanaMaxComputeUnits)) throw rejected("The transaction requests more than 1,400,000 compute units.");
    return { limit };
  }
  if (kind === 3 && data.length === 9) return { price: view.getBigUint64(1, true) };
  if (kind === 4 && data.length === 5) return {};
  throw rejected("The transaction carries an unknown compute-budget instruction.");
}

/**
 * Holds a decoded action transaction to the structure rules. Throws
 * ACTION_TRANSACTION_REJECTED (or PROGRAM_NOT_ALLOWED for a foreign top-level
 * program) with the precise reason.
 */
export async function checkActionTransaction(base64: string, decoded: DecodedSolanaTransaction, rules: ActionRules): Promise<ActionStructure> {
  const facts = wireFacts(base64);
  if (facts.size > CONTRACT_LIMITS.solanaMaxTransactionBytes) throw rejected(`The transaction is ${facts.size} bytes; the limit is ${CONTRACT_LIMITS.solanaMaxTransactionBytes}.`);
  if (decoded.signers.length !== 1 || facts.signatures !== 1) throw rejected("The transaction needs signatures from more than the user's account.");
  if (decoded.feePayer !== rules.user || decoded.signers[0] !== rules.user) throw rejected("The transaction is not fee-paid and signed solely by the user's account.");
  if (facts.signed) throw rejected("The transaction arrived pre-signed; Kletia only accepts unsigned single-signer transactions.");
  const allowed = new Set([...rules.programs]);
  const builtin = new Set([
    SOLANA_PROGRAM_IDS.computeBudget, SOLANA_PROGRAM_IDS.system, ...TOKEN_PROGRAMS, SOLANA_PROGRAM_IDS.associatedToken, ...MEMO_PROGRAMS, LIGHTHOUSE_PROGRAM,
  ]);
  const instructions = decoded.instructions;
  const first = instructions[0];
  if (first && first.program === SOLANA_PROGRAM_IDS.system && u32(first.data) === 4) throw rejected("Durable-nonce transactions (AdvanceNonceAccount) never expire and are refused.");
  let limit: bigint | null = null;
  let price = 0n;
  let payeeLamports = 0n;
  let primary = false;
  const wsol = await wsolAccountOf(rules.user);
  const payees = new Map(rules.payees.map((payee) => [payee.address, BigInt(payee.maxLamports)]));
  const paid = new Map<string, bigint>();
  for (const [index, instruction] of instructions.entries()) {
    const program = instruction.program;
    if (!allowed.has(program) && !builtin.has(program)) {
      throw new PlatformError("PROGRAM_NOT_ALLOWED", `Instruction ${index + 1} calls ${program}, which is not in the registration's program allowlist.`, 422);
    }
    if (program === rules.primaryProgram) primary = true;
    if (allowed.has(program)) continue;
    if (program === SOLANA_PROGRAM_IDS.computeBudget) {
      const set = computeBudget(instruction);
      if (set.limit !== undefined) limit = set.limit;
      if (set.price !== undefined) price = set.price;
    } else if (program === SOLANA_PROGRAM_IDS.system) {
      checkSystemInstruction(instruction, index, rules, wsol, instructions, payees, paid);
    } else if (TOKEN_PROGRAMS.includes(program)) {
      checkTokenInstruction(instruction, index, rules);
    } else if (program === SOLANA_PROGRAM_IDS.associatedToken) {
      const kind = instruction.data.length === 0 ? 0 : instruction.data[0];
      if ((kind !== 0 && kind !== 1) || instruction.data.length > 1) throw rejected(`Instruction ${index + 1} is an associated-token instruction other than Create / CreateIdempotent.`);
      if (instruction.accounts[0] !== rules.user) throw rejected(`Instruction ${index + 1} creates a token account paid by another account.`);
    }
    // Memo and Lighthouse instructions move nothing.
  }
  if (!primary) throw rejected(`The transaction does not invoke the action's program ${rules.primaryProgram}.`);
  for (const amount of paid.values()) payeeLamports += amount;
  const units = limit ?? BigInt(CONTRACT_LIMITS.solanaMaxComputeUnits);
  const priorityFeeLamports = (units * price + 999_999n) / 1_000_000n;
  if (priorityFeeLamports > BigInt(CONTRACT_LIMITS.solanaMaxPriorityFeeLamports)) {
    throw rejected(`The transaction sets a priority fee of ${priorityFeeLamports} lamports; the cap is ${CONTRACT_LIMITS.solanaMaxPriorityFeeLamports}.`);
  }
  const writable = new Set<string>();
  for (const instruction of instructions) {
    for (const meta of instruction.metas) if (meta.writable && !meta.signer && meta.address !== rules.user) writable.add(meta.address);
  }
  if (writable.size > 99) throw rejected("The transaction writes more accounts than Kletia can check.");
  return { payeeLamports, priorityFeeLamports, writable: [...writable] };
}

function checkSystemInstruction(
  instruction: DecodedSolanaInstruction,
  index: number,
  rules: ActionRules,
  wsol: string,
  instructions: readonly DecodedSolanaInstruction[],
  payees: ReadonlyMap<string, bigint>,
  paid: Map<string, bigint>,
): void {
  const kind = u32(instruction.data);
  if (kind !== 2 || instruction.data.length !== 12) {
    throw rejected(`Instruction ${index + 1} is a System instruction other than Transfer (Assign, Allocate, CreateAccount, nonce and seed variants are refused).`);
  }
  const lamports = readU64(instruction.data, 4) ?? 0n;
  const [from, to] = instruction.accounts;
  if (from !== rules.user) throw rejected(`Instruction ${index + 1} transfers SOL from another account.`);
  if (to === wsol) {
    const synced = instructions.slice(index + 1).some((later) =>
      later.program === SOLANA_PROGRAM_IDS.token && later.data.length === 1 && later.data[0] === 17 && later.accounts[0] === wsol);
    if (!synced) throw rejected(`Instruction ${index + 1} sends SOL to the user's wrapped-SOL account without a SyncNative after it.`);
    return;
  }
  const cap = to ? payees.get(to) : undefined;
  if (cap === undefined) throw rejected(`Instruction ${index + 1}: System transfer to an undeclared third party (${to ?? "unknown"}).`);
  const total = (paid.get(to as string) ?? 0n) + lamports;
  if (total > cap) throw rejected(`Instruction ${index + 1} pays ${to} ${total} lamports, above its declared cap of ${cap}.`);
  paid.set(to as string, total);
}

function checkTokenInstruction(instruction: DecodedSolanaInstruction, index: number, rules: ActionRules): void {
  const kind = instruction.data[0];
  if (kind === 17 && instruction.data.length === 1) return; // SyncNative
  if (kind === 9 && instruction.data.length === 1) {
    const [, destination, owner] = instruction.accounts;
    if (owner !== rules.user || destination !== rules.user) throw rejected(`Instruction ${index + 1} closes a token account to someone other than the user.`);
    return;
  }
  if (kind === 18 && instruction.data.length === 33) {
    const owner = String(getAddressDecoder().decode(instruction.data.subarray(1, 33)));
    if (owner !== rules.user) throw rejected(`Instruction ${index + 1} initialises a token account owned by someone other than the user.`);
    return;
  }
  throw rejected(`Instruction ${index + 1} is a token instruction other than SyncNative, CloseAccount or InitializeAccount3 (Approve, SetAuthority, Transfer and Burn are refused at top level).`);
}

/* ------------------------------------------------------------ decoding */

/** decodeSolanaTransaction with action-specific error codes. */
export async function decodeActionTransaction(network: SolanaNetworkKey, base64: string, decode: (network: SolanaNetworkKey, base64: string) => Promise<DecodedSolanaTransaction>): Promise<DecodedSolanaTransaction> {
  try {
    return await decode(network, base64);
  } catch (error) {
    if (isPlatformError(error) && error.code === "PROVIDER_TRANSACTION_REJECTED") throw rejected(error.message.replace(/provider/giu, "action"));
    if (isPlatformError(error) && error.code === "PROVIDER_TRANSACTION_INVALID") throw responseInvalid(error.message.replace(/provider/giu, "action"));
    throw error;
  }
}

/* ---------------------------------------------------------- simulation */

export interface ActionSimulationRules {
  readonly user: string;
  /** Step input: SPL mint (null for native SOL) and base units; null for non-spending entries. */
  readonly input: { readonly mint: string | null; readonly amount: bigint } | null;
  /** Declared output mint. */
  readonly output: { readonly mint: string } | null;
  /** Lamports the structure check allowed to declared payees. */
  readonly payeeLamports: bigint;
  /** SOL tolerance for rent created or reclaimed inside the transaction. */
  readonly rentTolerance: bigint;
}

export interface ActionOutcome {
  /** SOL movement of the user without the fee, wrapped SOL folded in. */
  readonly solDelta: bigint;
  readonly fee: bigint;
  /** Net token movement of the user per mint. */
  readonly tokenDeltas: ReadonlyMap<string, bigint>;
  /** Decimals seen per mint (token balances). */
  readonly decimals: ReadonlyMap<string, number>;
  readonly outputCredit: bigint | null;
}

export interface TokenAccountState {
  readonly mint: string;
  readonly owner: string;
  readonly delegate: string | null;
  readonly closeAuthority: string | null;
}

/** SPL token account layout (first 165 bytes; Token-2022 extensions follow). */
export function decodeTokenAccount(state: SolanaAccountState | null): TokenAccountState | null {
  if (!state || !TOKEN_PROGRAMS.includes(state.owner) || state.data.length < 165) return null;
  if (state.data.length > 165 && state.data[165] !== 2) return null; // Token-2022: account type byte 2 = Account
  const decoder = getAddressDecoder();
  const data = state.data;
  const option = (offset: number) => (u32(data, offset) === 1 ? String(decoder.decode(data.subarray(offset + 4, offset + 36))) : null);
  return {
    mint: String(decoder.decode(data.subarray(0, 32))),
    owner: String(decoder.decode(data.subarray(32, 64))),
    delegate: option(72),
    closeAuthority: option(129),
  };
}

const SYSTEM_DANGEROUS = new Map<number, string>([[1, "Assign"], [8, "Allocate"], [9, "AllocateWithSeed"], [10, "AssignWithSeed"]]);
const SYSTEM_PARSED_DANGEROUS = new Set(["assign", "assignWithSeed", "allocate", "allocateWithSeed"]);

function infoAddress(info: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = info[key];
  return typeof value === "string" ? value : null;
}

/**
 * Scans inner (CPI) instructions: any Token Approve / ApproveChecked /
 * SetAuthority touching the user's token accounts or authority, a CloseAccount
 * of a user token account to someone else, or a System Assign / Allocate of the
 * user's wallet refuses the transaction. Unreadable entries refuse too.
 */
export function innerInstructionRefusal(inner: readonly SolanaInnerInstruction[], user: string, userTokenAccounts: ReadonlySet<string>): string | null {
  const mine = (account: string | null | undefined) => account === user || (account !== null && account !== undefined && userTokenAccounts.has(account));
  for (const instruction of inner) {
    if (!instruction.program) return "An inner instruction could not be read.";
    if (TOKEN_PROGRAMS.includes(instruction.program)) {
      if (instruction.parsed) {
        const { type, info } = instruction.parsed;
        if (type === "approve" || type === "approveChecked") {
          if (mine(infoAddress(info, "source")) || mine(infoAddress(info, "owner")) || mine(infoAddress(info, "multisigOwner"))) return "A program approves a delegate on the user's token account.";
        } else if (type === "setAuthority") {
          if (mine(infoAddress(info, "account")) || mine(infoAddress(info, "mint")) || mine(infoAddress(info, "authority")) || mine(infoAddress(info, "multisigAuthority"))) return "A program changes an authority of the user's token account.";
        } else if (type === "closeAccount") {
          if (userTokenAccounts.has(infoAddress(info, "account") ?? "") && infoAddress(info, "destination") !== user) return "A program closes the user's token account to someone else.";
        }
        continue;
      }
      const data = instruction.data;
      if (!data || data.length === 0) return "An inner token instruction could not be read.";
      const [first, second, third, fourth] = instruction.accounts;
      if (data[0] === 4 && (mine(first) || mine(third))) return "A program approves a delegate on the user's token account.";
      if (data[0] === 13 && (mine(first) || mine(fourth))) return "A program approves a delegate on the user's token account.";
      if (data[0] === 6 && (mine(first) || mine(second))) return "A program changes an authority of the user's token account.";
      if (data[0] === 9 && first !== undefined && userTokenAccounts.has(first) && second !== user) return "A program closes the user's token account to someone else.";
    } else if (instruction.program === SOLANA_PROGRAM_IDS.system) {
      if (instruction.parsed) {
        if (SYSTEM_PARSED_DANGEROUS.has(instruction.parsed.type) && infoAddress(instruction.parsed.info, "account") === user) {
          return `A program runs System ${instruction.parsed.type} on the user's wallet.`;
        }
        continue;
      }
      const data = instruction.data;
      if (!data) return "An inner System instruction could not be read.";
      const kind = u32(data);
      const name = kind === null ? undefined : SYSTEM_DANGEROUS.get(kind);
      if (name && instruction.accounts[0] === user) return `A program runs System ${name} on the user's wallet.`;
    }
  }
  return null;
}

function sumByMint(balances: readonly SolanaTokenBalance[], owner: string): Map<string, bigint> {
  const out = new Map<string, bigint>();
  for (const entry of balances) if (entry.owner === owner) out.set(entry.mint, (out.get(entry.mint) ?? 0n) + entry.amount);
  return out;
}

/** Token deltas of `owner` per mint and decimals seen, from pre / post token balances. */
export function tokenDeltasOf(pre: readonly SolanaTokenBalance[], post: readonly SolanaTokenBalance[], owner: string): { deltas: Map<string, bigint>; decimals: Map<string, number> } {
  const before = sumByMint(pre, owner);
  const after = sumByMint(post, owner);
  const deltas = new Map<string, bigint>();
  for (const mint of new Set([...before.keys(), ...after.keys()])) deltas.set(mint, (after.get(mint) ?? 0n) - (before.get(mint) ?? 0n));
  const decimals = new Map<string, number>();
  for (const entry of [...pre, ...post]) if (entry.decimals !== null) decimals.set(entry.mint, entry.decimals);
  return { deltas, decimals };
}

/**
 * Applies the amount rules to the user's movements: exact SPL input debit
 * (SOL within the rent tolerance, net of declared payees), no other debit,
 * the declared output credited. Returns the refusal, or null.
 */
export function outcomeRefusal(outcome: Pick<ActionOutcome, "solDelta" | "tokenDeltas" | "outputCredit">, rules: ActionSimulationRules): string | null {
  const input = rules.input;
  const solSpent = -outcome.solDelta - rules.payeeLamports;
  if (input && input.mint === null) {
    if (solSpent > input.amount + rules.rentTolerance || solSpent < input.amount - rules.rentTolerance) {
      return `The transaction spends ${solSpent} lamports of SOL, not the step amount ${input.amount} (rent tolerance ${rules.rentTolerance}).`;
    }
  } else if (solSpent > rules.rentTolerance) {
    return `The transaction takes ${solSpent} lamports of SOL beyond the fee, declared payees and account rent.`;
  }
  for (const [mint, delta] of outcome.tokenDeltas) {
    if (mint === WRAPPED_SOL_MINT) continue; // folded into the SOL movement
    if (input && input.mint === mint) {
      if (delta !== -input.amount) return `The transaction moves ${delta} base units of the input token, not exactly -${input.amount}.`;
      continue;
    }
    if (delta < 0n) return `The transaction also debits another token from the user (${mint}).`;
  }
  if (input && input.mint !== null && !outcome.tokenDeltas.has(input.mint)) return "The transaction does not debit the input token.";
  if (rules.output && (outcome.outputCredit === null || outcome.outputCredit <= 0n)) return "The declared output is not credited to the user.";
  return null;
}

/* --------------------------------------------------------- binding / blockhash */

/**
 * Digest of a transaction's instructions without ComputeBudget and Lighthouse
 * (wallets such as Phantom add or tune those): program, accounts and data in
 * order. A landed transaction must have the digest of a prepared payload.
 */
export function actionInstructionDigest(instructions: readonly SolanaInstructionView[]): string {
  const list = instructions
    .filter((instruction) => instruction.program !== SOLANA_PROGRAM_IDS.computeBudget && instruction.program !== LIGHTHOUSE_PROGRAM)
    .map((instruction) => `${instruction.program}|${instruction.accounts.join(",")}|${Buffer.from(instruction.data).toString("hex")}`);
  return createHash("sha256").update(list.join("\n")).digest("hex");
}

/** Prefix of evidence references that carry a prepared instruction digest. */
export const INSTRUCTION_DIGEST_PREFIX = "ix1:";

function compactU16(bytes: Uint8Array, offset: number): { value: number; size: number } {
  let value = 0;
  let size = 0;
  for (;;) {
    const byte = bytes[offset + size];
    if (byte === undefined || size > 2) throw responseInvalid("The action transaction does not decode.");
    value |= (byte & 0x7f) << (7 * size);
    size += 1;
    if ((byte & 0x80) === 0) break;
  }
  return { value, size };
}

/**
 * Replaces the recent blockhash of an unsigned wire transaction, leaving every
 * other byte (instructions included) untouched.
 */
export function withBlockhash(base64: string, blockhash: string): string {
  const bytes = Uint8Array.from(getBase64Encoder().encode(base64));
  const signatures = compactU16(bytes, 0);
  const messageStart = signatures.size + signatures.value * 64;
  const versioned = ((bytes[messageStart] ?? 0) & 0x80) !== 0;
  const headerStart = messageStart + (versioned ? 1 : 0);
  const keys = compactU16(bytes, headerStart + 3);
  const offset = headerStart + 3 + keys.size + keys.value * 32;
  if (offset + 32 > bytes.length) throw responseInvalid("The action transaction does not decode.");
  const next = Uint8Array.from(bytes);
  next.set(getAddressEncoder().encode(toAddress(blockhash)), offset);
  const before = getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(bytes).messageBytes);
  const after = getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(next).messageBytes) as typeof before & { lifetimeToken?: string };
  if (String(after.lifetimeToken) !== blockhash || after.staticAccounts.join() !== before.staticAccounts.join() || after.version !== before.version) {
    throw responseInvalid("The action transaction could not be re-blockhashed.");
  }
  return Buffer.from(next).toString("base64");
}

/** Compile-time anchor: the message codecs used above stay in sync with kit. */
export type ActionMessageCodecs = [typeof getCompiledTransactionMessageEncoder, typeof getTransactionEncoder, Blockhash];

/** Static account keys of a wire transaction (simulation balance arrays index them first). */
export function staticKeysOf(base64: string): string[] {
  const bytes = Uint8Array.from(getBase64Encoder().encode(base64));
  const message = getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(bytes).messageBytes);
  return message.staticAccounts.map(String);
}

const PLAN_PIN_CACHE_MS = 30_000;
const programPinCache = new Map<string, { readonly at: number; readonly pins: SolanaProgramPin[] }>();

/** Current program pins (plan: cached 30 s; prepare / test: fresh). */
export async function currentProgramPins(network: SolanaNetworkKey, programs: readonly string[], fresh: boolean): Promise<SolanaProgramPin[]> {
  const key = `${network}:${[...programs].sort().join(",")}`;
  const cached = programPinCache.get(key);
  if (!fresh && cached && Date.now() - cached.at < PLAN_PIN_CACHE_MS) return cached.pins;
  const pins = await readProgramPins(network, programs);
  programPinCache.set(key, { at: Date.now(), pins });
  return pins;
}

/** Forgets cached program pins (tests). */
export function resetProgramPinCache(): void {
  programPinCache.clear();
}
