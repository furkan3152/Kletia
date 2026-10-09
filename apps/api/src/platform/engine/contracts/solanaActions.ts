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
 *   close authority, and the CPI scan (`innerInstructionRefusal`).
 * - CPI scan (simulated and landed inner instructions): the user's signature
 *   reaches only the registration's allowlisted programs and the built-in
 *   System / Token / Token-2022 / ATA / Memo programs, and on those only
 *   through instructions whose effect the balance checks see (transfers and
 *   burns from the user's own token accounts, account creation, closes back
 *   to the user). Native and loader programs (Stake, Vote, loaders, lookup
 *   tables, Config, ...) are refused anywhere in the CPI tree. A program
 *   outside the allowlist may run only when it never receives the user's
 *   wallet: Solana lets a CPI sign only for accounts it was given.
 * - Simulated account states: writable accounts the user can hold authority
 *   over outside SPL balances (native-program accounts such as stake
 *   accounts, System accounts other than the wallet, mints the user can mint
 *   or freeze, token accounts the user is only a delegate or close authority
 *   of) must not lose value or change hands.
 * - Wallets may add ComputeBudget and Lighthouse assertion instructions;
 *   Lighthouse MemoryWrite / MemoryClose (accounts the payer funds) are not
 *   tolerated, in the action server's transaction or added by the wallet.
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

/**
 * Native and loader programs a Solana Action may never reach, at the top
 * level or through CPI, whatever the allowlist says: with the user's
 * signature they withdraw or re-authorise stake accounts, upgrade programs
 * and take over lookup tables, vote and config accounts.
 */
export const ACTION_DENIED_PROGRAMS: ReadonlyMap<string, string> = new Map([
  ["Stake11111111111111111111111111111111111111", "the Stake program"],
  ["Vote111111111111111111111111111111111111111", "the Vote program"],
  ["BPFLoaderUpgradeab1e11111111111111111111111", "the upgradeable BPF loader"],
  ["BPFLoader2111111111111111111111111111111111", "the BPF loader"],
  ["BPFLoader1111111111111111111111111111111111", "the deprecated BPF loader"],
  ["LoaderV411111111111111111111111111111111111", "loader v4"],
  ["NativeLoader1111111111111111111111111111111", "the native loader"],
  [SOLANA_PROGRAM_IDS.addressLookupTable, "the Address Lookup Table program"],
  ["Config1111111111111111111111111111111111111", "the Config program"],
  ["Feature111111111111111111111111111111111111", "the Feature program"],
  ["ZkTokenProof1111111111111111111111111111111", "the ZK token proof program"],
  ["ZkE1Gama1Proof11111111111111111111111111111", "the ZK ElGamal proof program"],
]);

/**
 * Lighthouse instructions that only read accounts and call no other program:
 * the assertions (discriminators 2-17 of `LighthouseInstruction`) except
 * AssertMerkleTreeAccount (16, which calls the account-compression program).
 * MemoryWrite (0) and MemoryClose (1) create and close memory accounts funded
 * by the payer.
 */
export function isLighthouseAssertion(data: Uint8Array | null | undefined): boolean {
  const kind = data?.[0];
  return kind !== undefined && kind >= 2 && kind <= 17 && kind !== 16;
}
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
    const denied = ACTION_DENIED_PROGRAMS.get(program);
    if (denied) throw new PlatformError("PROGRAM_NOT_ALLOWED", `Instruction ${index + 1} calls ${denied}, which a Solana Action may never use.`, 422);
    if (!allowed.has(program) && !builtin.has(program)) {
      throw new PlatformError("PROGRAM_NOT_ALLOWED", `Instruction ${index + 1} calls ${program}, which is not in the registration's program allowlist.`, 422);
    }
    if (program === rules.primaryProgram) primary = true;
    if (allowed.has(program)) continue;
    if (program === LIGHTHOUSE_PROGRAM && !isLighthouseAssertion(instruction.data)) {
      throw rejected(`Instruction ${index + 1} is a Lighthouse instruction other than an assertion (MemoryWrite and MemoryClose create and close accounts the user pays for).`);
    }
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
    // Memo instructions and Lighthouse assertions move nothing.
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

/* ------------------------------------------------------------- CPI scan */

/** Who the scan protects and which programs the registration trusts with the user's signature. */
export interface CpiScope {
  /** The registration's allowlisted programs (the integrator's own programs). */
  readonly programs: readonly string[];
  /**
   * Token account → owner before the transaction (else after it), from token
   * balances and account states. Unknown accounts were created and closed
   * inside the transaction.
   */
  readonly tokenOwners?: ReadonlyMap<string, string>;
}

/** A Token / System / ATA instruction in one shape: its type and named accounts. */
interface ScannedInstruction {
  readonly type: string;
  readonly fields: Readonly<Record<string, string | undefined>>;
  /** The user's wallet is among its accounts (raw) or anywhere in its parsed info. */
  readonly involvesUser: boolean;
}

const TOKEN_TYPES: readonly string[] = [
  "initializeMint", "initializeAccount", "initializeMultisig", "transfer", "approve", "revoke", "setAuthority", "mintTo", "burn",
  "closeAccount", "freezeAccount", "thawAccount", "transferChecked", "approveChecked", "mintToChecked", "burnChecked",
  "initializeAccount2", "syncNative", "initializeAccount3", "initializeMultisig2", "initializeMint2", "getAccountDataSize",
  "initializeImmutableOwner", "amountToUiAmount", "uiAmountToAmount",
];

/** Named accounts of raw token instructions (the RPC's parsed field names). */
const TOKEN_FIELDS: Readonly<Record<string, readonly string[]>> = {
  transfer: ["source", "destination", "authority"],
  transferChecked: ["source", "mint", "destination", "authority"],
  transferCheckedWithFee: ["source", "mint", "destination", "authority"],
  burn: ["account", "mint", "authority"],
  burnChecked: ["account", "mint", "authority"],
  mintTo: ["mint", "account", "mintAuthority"],
  mintToChecked: ["mint", "account", "mintAuthority"],
  approve: ["source", "delegate", "owner"],
  approveChecked: ["source", "mint", "delegate", "owner"],
  revoke: ["source", "owner"],
  setAuthority: ["account", "authority"],
  closeAccount: ["account", "destination", "owner"],
  freezeAccount: ["account", "mint", "freezeAuthority"],
  thawAccount: ["account", "mint", "freezeAuthority"],
};

/** Token instructions that use no authority of the user even when they name the user (account set-up, reads). */
const TOKEN_SAFE_WITH_USER = new Set([
  "initializeMint", "initializeMint2", "initializeAccount", "initializeAccount2", "initializeAccount3", "initializeMultisig",
  "initializeMultisig2", "syncNative", "getAccountDataSize", "initializeImmutableOwner", "amountToUiAmount", "uiAmountToAmount",
]);

const SYSTEM_TYPES: readonly string[] = [
  "createAccount", "assign", "transfer", "createAccountWithSeed", "advanceNonce", "withdrawFromNonce", "initializeNonce",
  "authorizeNonce", "allocate", "allocateWithSeed", "assignWithSeed", "transferWithSeed", "upgradeNonce",
];
const SYSTEM_NAMES: Readonly<Record<string, string>> = {
  assign: "Assign", allocate: "Allocate", allocateWithSeed: "AllocateWithSeed", assignWithSeed: "AssignWithSeed", transferWithSeed: "TransferWithSeed",
  advanceNonce: "AdvanceNonceAccount", withdrawFromNonce: "WithdrawNonceAccount", authorizeNonce: "AuthorizeNonceAccount",
};
const SYSTEM_FIELDS: Readonly<Record<string, readonly string[]>> = {
  createAccount: ["source", "newAccount"],
  transfer: ["source", "destination"],
  createAccountWithSeed: ["source", "newAccount", "base"],
};

const ATA_TYPES: readonly string[] = ["create", "createIdempotent", "recoverNested"];

function containsAddress(value: unknown, wanted: string, depth = 0): boolean {
  if (typeof value === "string") return value === wanted;
  if (depth > 4) return false;
  if (Array.isArray(value)) return value.some((entry) => containsAddress(entry, wanted, depth + 1));
  if (isRecord(value)) return Object.values(value).some((entry) => containsAddress(entry, wanted, depth + 1));
  return false;
}

/** Normalises a raw or parsed Token / Token-2022 instruction; null when unreadable. */
function scanToken(instruction: SolanaInnerInstruction, user: string): ScannedInstruction | null {
  if (instruction.parsed) {
    const { type, info } = instruction.parsed;
    const fields: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(info)) if (typeof value === "string") fields[key] = value;
    return { type, fields, involvesUser: containsAddress(info, user) };
  }
  const data = instruction.data;
  if (!data || data.length === 0) return null;
  const kind = data[0] as number;
  const type = kind === 26 && data[1] === 1 && instruction.program === SOLANA_PROGRAM_IDS.token2022
    ? "transferCheckedWithFee"
    : TOKEN_TYPES[kind] ?? `instruction ${kind}`;
  const fields: Record<string, string | undefined> = {};
  (TOKEN_FIELDS[type] ?? []).forEach((name, index) => {
    fields[name] = instruction.accounts[index];
  });
  return { type, fields, involvesUser: instruction.accounts.includes(user) };
}

/** Normalises a raw or parsed System instruction; null when unreadable. */
function scanSystem(instruction: SolanaInnerInstruction, user: string): ScannedInstruction | null {
  if (instruction.parsed) {
    const { type, info } = instruction.parsed;
    const fields: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(info)) if (typeof value === "string") fields[key] = value;
    return { type, fields, involvesUser: containsAddress(info, user) };
  }
  const kind = instruction.data ? u32(instruction.data) : null;
  if (kind === null) return null;
  const type = SYSTEM_TYPES[kind] ?? `instruction ${kind}`;
  const fields: Record<string, string | undefined> = {};
  (SYSTEM_FIELDS[type] ?? []).forEach((name, index) => {
    fields[name] = instruction.accounts[index];
  });
  return { type, fields, involvesUser: instruction.accounts.includes(user) };
}

/** Normalises a raw or parsed associated-token-account instruction; null when unreadable. */
function scanAssociatedToken(instruction: SolanaInnerInstruction, user: string): ScannedInstruction | null {
  if (instruction.parsed) return { type: instruction.parsed.type, fields: {}, involvesUser: containsAddress(instruction.parsed.info, user) };
  const data = instruction.data;
  if (!data) return null;
  const type = data.length === 0 ? "create" : data.length === 1 ? ATA_TYPES[data[0] as number] ?? `instruction ${data[0]}` : "unknown";
  return { type, fields: {}, involvesUser: instruction.accounts.includes(user) };
}

function tokenRefusal(scanned: ScannedInstruction, user: string, userTokenAccounts: ReadonlySet<string>, owners: ReadonlyMap<string, string>): string | null {
  const { type, fields, involvesUser } = scanned;
  const mine = (account: string | undefined) => account !== undefined && (account === user || userTokenAccounts.has(account));
  /** An account someone else owns (the user acts as its delegate or multisig signer); unknown accounts live only inside the transaction. */
  const foreign = (account: string | undefined) => {
    if (account === undefined || userTokenAccounts.has(account)) return false;
    const owner = owners.get(account);
    return owner !== undefined && owner !== user;
  };
  switch (type) {
    case "approve":
    case "approveChecked":
      return involvesUser || mine(fields.source) ? "A program approves a delegate on the user's token account." : null;
    case "setAuthority":
      return involvesUser || mine(fields.account) || mine(fields.mint) ? "A program changes an authority of the user's token account." : null;
    case "closeAccount":
      return fields.destination !== user && (involvesUser || userTokenAccounts.has(fields.account ?? "")) ? "A program closes the user's token account to someone else." : null;
    case "transfer":
    case "transferChecked":
    case "transferCheckedWithFee":
    case "burn":
    case "burnChecked":
      return involvesUser && foreign(fields.source ?? fields.account)
        ? `A program spends from ${fields.source ?? fields.account}, a token account the user only holds delegated or shared authority over.`
        : null;
    case "mintTo":
    case "mintToChecked":
      return involvesUser ? "A program mints a token with the user's mint authority." : null;
    case "freezeAccount":
    case "thawAccount":
      return involvesUser ? "A program freezes or thaws a token account with the user's authority." : null;
    default:
      return involvesUser && !TOKEN_SAFE_WITH_USER.has(type) ? `A program runs token ${type} with the user's authority.` : null;
  }
}

function systemRefusal(scanned: ScannedInstruction, user: string): string | null {
  const { type, fields, involvesUser } = scanned;
  switch (type) {
    case "createAccount":
    case "createAccountWithSeed":
      return fields.newAccount === user ? "A program re-creates the user's wallet as a program account." : null;
    case "transfer":
    case "initializeNonce":
    case "upgradeNonce":
      return null;
    default:
      return involvesUser ? `A program runs System ${SYSTEM_NAMES[type] ?? type} with the user's wallet.` : null;
  }
}

/**
 * Scans inner (CPI) instructions with the user's signature in mind. Refuses:
 * native and loader programs anywhere (Stake, Vote, loaders, lookup tables,
 * Config, ...); a program outside the allowlist and the built-ins that
 * receives the user's wallet (it could act with the user's signature);
 * Token / Token-2022 approvals, authority changes, mints, freezes and thaws
 * with the user's authority, spends from accounts the user only has
 * delegated authority over, closes of the user's token accounts to someone
 * else, and any other token instruction using the user's authority; System
 * instructions on the user's wallet other than transfers and account
 * creation (Assign, Allocate, seed and nonce variants). Unreadable entries
 * refuse too. Transfers and burns from the user's own token accounts are
 * left to the balance checks.
 */
export function innerInstructionRefusal(
  inner: readonly SolanaInnerInstruction[],
  user: string,
  userTokenAccounts: ReadonlySet<string>,
  scope: CpiScope = { programs: [] },
): string | null {
  const allowlisted = new Set(scope.programs);
  const owners = scope.tokenOwners ?? new Map<string, string>();
  for (const instruction of inner) {
    const program = instruction.program;
    if (!program) return "An inner instruction could not be read.";
    const denied = ACTION_DENIED_PROGRAMS.get(program);
    if (denied) return `A program invokes ${denied}, which a Solana Action may never reach.`;
    if (TOKEN_PROGRAMS.includes(program)) {
      const scanned = scanToken(instruction, user);
      if (!scanned) return "An inner token instruction could not be read.";
      const refusal = tokenRefusal(scanned, user, userTokenAccounts, owners);
      if (refusal) return refusal;
    } else if (program === SOLANA_PROGRAM_IDS.system) {
      const scanned = scanSystem(instruction, user);
      if (!scanned) return "An inner System instruction could not be read.";
      const refusal = systemRefusal(scanned, user);
      if (refusal) return refusal;
    } else if (program === SOLANA_PROGRAM_IDS.associatedToken) {
      const scanned = scanAssociatedToken(instruction, user);
      if (!scanned) return "An inner associated-token instruction could not be read.";
      if (scanned.involvesUser && !ATA_TYPES.includes(scanned.type)) return `A program runs associated-token ${scanned.type} with the user's wallet.`;
    } else if (MEMO_PROGRAMS.includes(program) || allowlisted.has(program)) {
      continue;
    } else if (instruction.parsed ? true : instruction.accounts.includes(user)) {
      // Solana lets a CPI sign only for accounts it receives: a program that never gets the user's wallet cannot use the user's signature.
      return `A program passes the user's wallet to ${program}, which is not in the registration's program allowlist (a program that receives the wallet can act with the user's signature).`;
    }
  }
  return null;
}

/* ----------------------------------------------------- simulated account states */

interface MintState {
  readonly mintAuthority: string | null;
  readonly supply: bigint;
  readonly freezeAuthority: string | null;
}

/** SPL mint layout (first 82 bytes; Token-2022 extensions follow with account type byte 1). */
function decodeMint(state: SolanaAccountState | null): MintState | null {
  if (!state || !TOKEN_PROGRAMS.includes(state.owner)) return null;
  const data = state.data;
  if (data.length !== 82 && !(data.length > 165 && data[165] === 1)) return null;
  const decoder = getAddressDecoder();
  const option = (offset: number) => (u32(data, offset) === 1 ? String(decoder.decode(data.subarray(offset + 4, offset + 36))) : null);
  return { mintAuthority: option(0), supply: readU64(data, 36) ?? 0n, freezeAuthority: option(46) };
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

/**
 * Backstop over the simulated post state of one writable account (not the
 * user's wallet, which is checked apart): accounts the user can hold
 * authority over outside SPL balances must not lose value or change hands.
 * Native-program accounts (stake, vote, lookup tables, program data) and
 * System accounts other than the wallet only change with their authority's
 * signature, which here is the user's; a mint the user can mint or freeze
 * must keep its supply and authorities; a token account the user is only a
 * delegate or close authority of must keep its balance. Accounts created by
 * the transaction are not checked here.
 */
export function authorityStateRefusal(account: string, pre: SolanaAccountState | null, post: SolanaAccountState | null, user: string): string | null {
  if (!pre || pre.lamports === 0n) return null;
  const changed = !post || post.owner !== pre.owner || post.lamports < pre.lamports || !sameBytes(post.data, pre.data);
  const denied = ACTION_DENIED_PROGRAMS.get(pre.owner);
  if (denied) return changed ? `The transaction would change ${account}, an account of ${denied}.` : null;
  if (pre.owner === SOLANA_PROGRAM_IDS.system) {
    return changed ? `The transaction would take SOL from or reassign ${account}, a System account other than the user's wallet.` : null;
  }
  if (!TOKEN_PROGRAMS.includes(pre.owner)) return null;
  const mint = decodeMint(pre);
  if (mint && (mint.mintAuthority === user || mint.freezeAuthority === user)) {
    const after = decodeMint(post);
    if (!after || after.supply > mint.supply || after.mintAuthority !== mint.mintAuthority || after.freezeAuthority !== mint.freezeAuthority) {
      return `The transaction would mint or change the authorities of ${account}, a mint the user controls.`;
    }
  }
  const token = decodeTokenAccount(pre);
  if (token && token.owner !== user && (token.delegate === user || token.closeAuthority === user)) {
    const after = decodeTokenAccount(post);
    if (!after || !post || (readU64(post.data, 64) ?? 0n) < (readU64(pre.data, 64) ?? 0n)) {
      return `The transaction would spend or close ${account}, a token account the user is only a delegate or close authority of.`;
    }
  }
  return null;
}

/**
 * Wallet additions a landed transaction may carry beyond the prepared
 * instructions are ComputeBudget and Lighthouse assertions only. A
 * Lighthouse instruction other than an assertion, or one that issued inner
 * instructions, makes the landed transaction a different one.
 */
export function walletAdditionRefusal(instructions: readonly SolanaInstructionView[], inner: readonly SolanaInnerInstruction[]): string | null {
  for (const [index, instruction] of instructions.entries()) {
    if (instruction.program !== LIGHTHOUSE_PROGRAM) continue;
    if (!isLighthouseAssertion(instruction.data)) return `Instruction ${index + 1} is a Lighthouse instruction other than an assertion; wallets may add only compute-budget and Lighthouse assertion instructions.`;
    if (inner.some((entry) => entry.index === index)) return `Instruction ${index + 1} (Lighthouse) invoked other programs; wallets may add only compute-budget and Lighthouse assertion instructions.`;
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
