/**
 * deBridge DLN adapter: solver-filled cross-network orders between the EVM
 * networks and Solana where DlnSource is pinned in the registry.
 *
 * A DLN order gives exactly the step amount on the origin network and takes
 * an exact amount of the output asset on the destination network; DLN charges
 * a fixed fee in the origin's native asset on top (reported as `extraCosts`).
 * The API is untrusted. At plan and at prepare Kletia decodes the order it
 * returns and checks it against the step and the pinned contracts:
 * - EVM: the call goes to the pinned DlnSource (also the exact-approval
 *   spender); `createSaltedOrder` gives the input token and exact amount,
 *   takes the output token on the destination chain for the recipient, keeps
 *   patch / cancel rights with the user, carries no external call, affiliate
 *   fee or permit; the value is exactly the fixed fee (plus the amount for a
 *   native input), and the fixed fee equals DlnSource.globalFixedNativeFee()
 *   read on-chain (the cap).
 * - Solana: the transaction may only invoke ComputeBudget (known opcodes, a
 *   capped unit limit and priority fee) and the pinned DLN source program; `create_order_with_nonce` is decoded with the same checks
 *   (maker, state PDA, mint, amounts, receiver, authorities) and the fixed fee
 *   must equal the program state's `fixed_fee`. Kletia re-assembles the
 *   transaction from the validated instructions with a fresh blockhash.
 * The destination order authority is the user's account (the origin address
 * on another EVM network; for cross-VM routes the recipient, with a warning).
 *
 * Verification needs the CreatedOrder event of the pinned DlnSource matching
 * the landed calldata and a quoted order id (EVM), or the order-ids index
 * listing a quoted order for the signature (Solana). Settlement needs the
 * order fulfilled and, on the destination, the pinned DlnDestination's
 * FulfilledOrder event (EVM) or the recipient's credit (Solana).
 */
import { createHash } from "node:crypto";
import {
  address as solanaAddress,
  getCompiledTransactionMessageDecoder,
  getProgramDerivedAddress,
  getTransactionDecoder,
  getUtf8Encoder,
} from "@solana/kit";
import { decodeFunctionData, encodeFunctionData, erc20Abi, getAddress, parseAbi, type Hex, type Log } from "viem";
import {
  CHAINS,
  explorerTxUrl,
  formatAmount,
  fromBaseUnits,
  getProtocol,
  parseAccountId,
  venueContracts,
  WRAPPED_SOL_MINT,
  type AssetAmount,
  type IntentStep,
  type NetworkKey,
  type StepEvidence,
  type TransactionRequest,
} from "@kletia/core";
import {
  assembleSolanaTransaction,
  assertSolanaWalletRecipient,
  isSolanaNetworkKey,
  solanaRpc,
  type ExternalSolanaInstruction,
} from "../../../networks/solana/index.js";
import { rpcAbortSignal } from "../../../networks/solana/rpc.js";
import { PlatformError } from "../../errors.js";
import { assetAmount, assetFromRef, resolveAsset, type ResolvedAsset } from "../assets.js";
import {
  evmChainId,
  evmClient,
  isEvmNetwork,
  observeEvmTransaction,
  readAllowance,
  readEvmReceiptStatus,
  type EvmNetworkKey,
} from "../chains/evm.js";
import { assertSolanaTransactionOwner, computeBudgetMismatch, confirmSimulation, readSolanaCredit, SOLANA_PROGRAM_IDS } from "../chains/solana.js";
import { nativeUsdPrice } from "../prices.js";
import { decodeStepRef } from "../stepRef.js";
import { assertEvmBalance } from "./evmTransfer.js";
import {
  dlnTokenAddress,
  fetchDlnOrder,
  fetchDlnOrderIds,
  fetchDlnOrderStatus,
  type DlnOrderQuote,
} from "./debridgeClient.js";
import { accountBytes, accountBytes32, cushionedMinimum } from "./lifi.js";
import { cappedOutput } from "./relay.js";
import type { AdapterAction, PlannedStep, PreparedPayload, ProtocolAdapter, SettlementResult, VerificationResult, PlannedStepPreview } from "./types.js";
import {
  effectiveSolDelta,
  evmEvents,
  fillNotBefore,
  REFERENCE_STALE_MS,
  stepOwner,
  tokenDelta,
  verifyEvmReceipts,
  verifySolanaReferences,
} from "./verification.js";

/** Networks DLN serves in the registry (origins additionally need a pinned DlnSource). */
export const DLN_NETWORKS: readonly NetworkKey[] = Object.freeze([...(getProtocol("debridge-dln")?.networks ?? [])]);

const APPROVE_GAS = "70000";
const FIX_FEE_CACHE_MS = 5 * 60_000;
const ORDER_ID = /^0x[0-9a-f]{64}$/u;
/** Anchor discriminator of `create_order_with_nonce` (sha256("global:create_order_with_nonce")[0..8]). */
const CREATE_ORDER_WITH_NONCE = createHash("sha256").update("global:create_order_with_nonce").digest().subarray(0, 8);

export const DLN_SOURCE_ABI = parseAbi([
  "struct OrderCreation { address giveTokenAddress; uint256 giveAmount; bytes takeTokenAddress; uint256 takeAmount; uint256 takeChainId; bytes receiverDst; address givePatchAuthoritySrc; bytes orderAuthorityAddressDst; bytes allowedTakerDst; bytes externalCall; bytes allowedCancelBeneficiarySrc; }",
  "function createSaltedOrder(OrderCreation _orderCreation, uint64 _salt, bytes _affiliateFee, uint32 _referralCode, bytes _permitEnvelope, bytes _payload) payable returns (bytes32)",
  "function globalFixedNativeFee() view returns (uint88)",
]);

const DLN_EVENTS_ABI = parseAbi([
  "struct Order { uint64 makerOrderNonce; bytes makerSrc; uint256 giveChainId; bytes giveTokenAddress; uint256 giveAmount; uint256 takeChainId; bytes takeTokenAddress; uint256 takeAmount; bytes receiverDst; bytes givePatchAuthoritySrc; bytes orderAuthorityAddressDst; bytes allowedTakerDst; bytes allowedCancelBeneficiarySrc; bytes externalCall; }",
  "event CreatedOrder(Order order, bytes32 orderId, bytes affiliateFee, uint256 nativeFixFee, uint256 percentFee, uint32 referralCode, bytes metadata)",
  "event FulfilledOrder(Order order, bytes32 orderId, address sender, address unlockAuthority)",
]);

function reject(message: string): never {
  throw new PlatformError("PROVIDER_TRANSACTION_INVALID", `deBridge order refused: ${message}`, 502);
}

function dlnChainId(network: NetworkKey): number {
  const id = CHAINS[network].settlement.debridgeChainId;
  if (id === undefined) throw new PlatformError("NETWORK_UNSUPPORTED", `deBridge DLN does not serve ${CHAINS[network].name}.`, 422);
  return id;
}

function pinned(network: NetworkKey, role: "dln-source" | "dln-destination"): string | null {
  const contracts = venueContracts("debridge-dln", network, role);
  return contracts.length === 1 ? (contracts[0] as string) : null;
}

function svm(network: NetworkKey): boolean {
  return CHAINS[network].vm === "svm";
}

function sameEvm(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** DLN's encoding of an asset on its network (native assets are the zero address / System program). */
function tokenBytes(asset: ResolvedAsset): Hex {
  return accountBytes(asset.network, dlnTokenAddress(asset.isNative, asset.address, svm(asset.network)));
}

/**
 * The account allowed to cancel the order on the destination network. The
 * same EVM address on another EVM network is the user's own; across VMs it is
 * the user's own destination account from the intent (`destinationAccount`)
 * and, only when the intent names none, the recipient (flagged `crossVm` so
 * the step warns who holds the cancel right).
 */
function destinationAuthority(action: AdapterAction): { readonly address: string; readonly crossVm: boolean } {
  if (CHAINS[action.network].namespace === CHAINS[action.destinationNetwork].namespace) {
    return { address: action.account.address, crossVm: false };
  }
  const own = action.destinationAccount;
  if (own && own.chain.namespace === CHAINS[action.destinationNetwork].namespace) {
    return { address: own.address, crossVm: false };
  }
  return { address: action.recipient.address, crossVm: true };
}

/* ------------------------------------------------------------ fixed fee */

const fixFeeCache = new Map<NetworkKey, { value: bigint; expiresAt: number }>();

/** Clears cached on-chain fixed fees (tests). */
export function resetDlnFixFeeCache(): void {
  fixFeeCache.clear();
}

async function solanaStateAddress(): Promise<string> {
  const program = pinned("solana", "dln-source");
  if (!program) throw new PlatformError("NETWORK_UNSUPPORTED", "deBridge DLN has no pinned Solana program.", 422);
  const [state] = await getProgramDerivedAddress({ programAddress: solanaAddress(program), seeds: [getUtf8Encoder().encode("STATE")] });
  return String(state);
}

/**
 * The fixed fee DLN charges on `network`, read from the pinned contract:
 * DlnSource.globalFixedNativeFee() on EVM, the `fixed_fee` of the program
 * state account on Solana. A quote's fee must equal it.
 */
async function onchainFixFee(network: NetworkKey): Promise<bigint> {
  const cached = fixFeeCache.get(network);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  let value: bigint;
  try {
    if (isEvmNetwork(network)) {
      const source = pinned(network, "dln-source");
      if (!source) throw new Error("no pinned DlnSource");
      value = BigInt(await evmClient(network).readContract({ address: getAddress(source), abi: DLN_SOURCE_ABI, functionName: "globalFixedNativeFee" }));
    } else {
      const state = await solanaStateAddress();
      const program = pinned("solana", "dln-source");
      const info = await solanaRpc("solana")
        .getAccountInfo(solanaAddress(state), { encoding: "base64", commitment: "confirmed" })
        .send({ abortSignal: rpcAbortSignal() });
      const account = info.value;
      if (!account || String(account.owner) !== program) throw new Error("state account missing");
      const data = Buffer.from(String((account.data as unknown as [string, string])[0]), "base64");
      // Anchor layout: 8-byte discriminator, protocol_authority (32), fixed_fee (u64 LE).
      if (data.length < 48) throw new Error("state account too short");
      value = data.readBigUInt64LE(40);
    }
  } catch {
    throw new PlatformError("RPC_UNAVAILABLE", `deBridge's fixed fee on ${CHAINS[network].name} could not be read on-chain. Try again shortly.`, 502);
  }
  fixFeeCache.set(network, { value, expiresAt: Date.now() + FIX_FEE_CACHE_MS });
  return value;
}

/* ------------------------------------------------------------- decoding */

interface OrderExpectations {
  readonly action: AdapterAction;
  readonly quote: DlnOrderQuote;
  readonly dstAuthority: string;
}

/** Decodes and checks an EVM createSaltedOrder call; returns the salt (order nonce). */
export function checkEvmOrder(data: string, expect: OrderExpectations): bigint {
  const { action, quote } = expect;
  let decoded;
  try {
    decoded = decodeFunctionData({ abi: DLN_SOURCE_ABI, data: data as Hex });
  } catch {
    reject("the transaction is not a DlnSource order");
  }
  if (decoded.functionName !== "createSaltedOrder") reject("the transaction is not createSaltedOrder");
  const [order, salt, affiliateFee, , permitEnvelope] = decoded.args;
  const destination = action.destinationNetwork;
  const giveToken = action.input.isNative ? "0x0000000000000000000000000000000000000000" : (action.input.address as string);
  if (!sameEvm(order.giveTokenAddress, giveToken)) reject("the order gives another token");
  if (order.giveAmount !== BigInt(action.amount)) reject("the order gives another amount than the step");
  if (order.takeChainId !== BigInt(dlnChainId(destination))) reject("the order takes on another chain");
  if (order.takeTokenAddress.toLowerCase() !== tokenBytes(action.output)) reject("the order takes another token");
  if (order.takeAmount !== BigInt(quote.takeAmount) || order.takeAmount === 0n) reject("the order takes another amount than quoted");
  if (order.receiverDst.toLowerCase() !== accountBytes(destination, action.recipient.address)) reject("the order pays another recipient");
  if (!sameEvm(order.givePatchAuthoritySrc, action.account.address)) reject("another account may patch the order");
  if (order.orderAuthorityAddressDst.toLowerCase() !== accountBytes(destination, expect.dstAuthority)) {
    reject("another account controls the order on the destination network");
  }
  const cancel = order.allowedCancelBeneficiarySrc.toLowerCase();
  if (cancel !== "0x" && cancel !== accountBytes(action.network, action.account.address)) reject("a cancellation would refund another account");
  if (order.externalCall !== "0x") reject("the order carries an external call");
  if (affiliateFee !== "0x") reject("the order carries an affiliate fee");
  if (permitEnvelope !== "0x") reject("the order carries a permit");
  return salt;
}

/** Little-endian borsh reader for the DLN instruction arguments. */
class Reader {
  private offset = 0;
  constructor(private readonly data: Buffer) {}
  private take(length: number): Buffer {
    if (length < 0 || this.offset + length > this.data.length) throw new Error("truncated");
    const slice = this.data.subarray(this.offset, this.offset + length);
    this.offset += length;
    return slice;
  }
  u8(): number {
    return this.take(1)[0] as number;
  }
  u32(): number {
    return this.take(4).readUInt32LE(0);
  }
  u64(): bigint {
    return this.take(8).readBigUInt64LE(0);
  }
  /** A 32-byte big-endian integer (DLN's chain ids and amounts). */
  u256be(): bigint {
    return BigInt(`0x${this.take(32).toString("hex")}`);
  }
  hex(length: number): Hex {
    return `0x${this.take(length).toString("hex")}`;
  }
  bytes(): Hex {
    const length = this.u32();
    if (length > 1_024) throw new Error("bytes too long");
    return this.hex(length);
  }
  option<T>(read: () => T): T | null {
    const tag = this.u8();
    if (tag > 1) throw new Error("bad option tag");
    return tag === 1 ? read() : null;
  }
  done(): boolean {
    return this.offset === this.data.length;
  }
}

/** Account positions of `create_order_with_nonce` (DLN source IDL 3.0.0). */
const ACCOUNT = { maker: 0, state: 1, tokenMint: 2, systemProgram: 9, splTokenProgram: 10, associatedTokenProgram: 11 } as const;

interface DecodedSolanaOrder {
  readonly instructions: ExternalSolanaInstruction[];
  readonly program: string;
}

/**
 * Decodes the DLN Solana transaction and checks it against the step: only
 * ComputeBudget and the pinned DLN source program, one create_order_with_nonce
 * with the expected maker, state PDA, mint and arguments, no lookup tables.
 * Returns the instructions (to be re-assembled with a fresh blockhash).
 */
export async function checkSolanaOrder(hexData: string, expect: OrderExpectations): Promise<DecodedSolanaOrder> {
  const { action, quote } = expect;
  const program = pinned("solana", "dln-source");
  if (!program) throw new PlatformError("NETWORK_UNSUPPORTED", "deBridge DLN has no pinned Solana program.", 422);
  const owner = action.account.address;
  let message;
  try {
    const transaction = getTransactionDecoder().decode(Buffer.from(hexData.slice(2), "hex"));
    message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  } catch {
    reject("the Solana transaction cannot be decoded");
  }
  if (message.version !== 0 && message.version !== "legacy") reject("unsupported transaction version");
  if ("addressTableLookups" in message && (message.addressTableLookups?.length ?? 0) > 0) reject("the transaction uses address lookup tables");
  const keys = message.staticAccounts.map(String);
  const { numSignerAccounts, numReadonlySignerAccounts, numReadonlyNonSignerAccounts } = message.header;
  if (numSignerAccounts !== 1 || keys[0] !== owner) reject("the transaction is not signed solely by the step account");
  const writable = (index: number) => index < numSignerAccounts
    ? index < numSignerAccounts - numReadonlySignerAccounts
    : index < keys.length - numReadonlyNonSignerAccounts;
  const instructions: ExternalSolanaInstruction[] = [];
  let order: { accounts: string[]; data: Buffer } | null = null;
  for (const instruction of message.instructions) {
    const programId = keys[instruction.programAddressIndex];
    if (programId !== SOLANA_PROGRAM_IDS.computeBudget && programId !== program) reject(`the transaction invokes ${programId ?? "an unknown program"}`);
    const indices = instruction.accountIndices ?? [];
    if (indices.some((index) => index >= keys.length)) reject("an instruction references an account outside the transaction");
    const data = Buffer.from(instruction.data ?? new Uint8Array());
    // The priority fee is paid on top of the order and is not in extraCosts: it stays capped.
    const budget = programId === SOLANA_PROGRAM_IDS.computeBudget ? computeBudgetMismatch(data) : null;
    if (budget) reject(`a compute-budget instruction ${budget}`);
    instructions.push({
      programId: programId as string,
      keys: indices.map((index) => ({ pubkey: keys[index] as string, isSigner: index < numSignerAccounts, isWritable: writable(index) })),
      data: data.toString("hex"),
    });
    if (programId === program) {
      if (order) reject("the transaction creates more than one order");
      order = { accounts: indices.map((index) => keys[index] as string), data };
    }
  }
  if (!order) reject("the transaction creates no order");
  if (!order.data.subarray(0, 8).equals(CREATE_ORDER_WITH_NONCE)) reject("the DLN instruction is not create_order_with_nonce");
  const accounts = order.accounts;
  const mint = action.input.isNative ? WRAPPED_SOL_MINT : (action.input.address as string);
  if (accounts.length !== 12) reject("unexpected DLN instruction accounts");
  if (accounts[ACCOUNT.maker] !== owner) reject("the order maker is not the step account");
  if (accounts[ACCOUNT.state] !== (await solanaStateAddress())) reject("the order uses another DLN state account");
  if (accounts[ACCOUNT.tokenMint] !== mint) reject("the order gives another token");
  if (
    accounts[ACCOUNT.systemProgram] !== SOLANA_PROGRAM_IDS.system ||
    accounts[ACCOUNT.splTokenProgram] !== SOLANA_PROGRAM_IDS.token ||
    accounts[ACCOUNT.associatedTokenProgram] !== SOLANA_PROGRAM_IDS.associatedToken
  ) {
    reject("the order names unexpected programs");
  }
  const destination = action.destinationNetwork;
  try {
    const reader = new Reader(order.data.subarray(8));
    const giveAmount = reader.u64();
    const takeChainId = reader.u256be();
    const takeToken = reader.bytes();
    const takeAmount = reader.u256be();
    const receiverDst = reader.bytes();
    const externalCall = reader.option(() => reader.bytes());
    const givePatchAuthority = reader.hex(32);
    const cancelBeneficiary = reader.option(() => reader.hex(32));
    const orderAuthorityDst = reader.bytes();
    reader.option(() => reader.bytes()); // allowed taker: any solver may be named
    const affiliateFee = reader.option(() => ({ beneficiary: reader.hex(32), amount: reader.u64() }));
    reader.option(() => reader.u32()); // referral code
    reader.u64(); // nonce
    reader.bytes(); // metadata
    if (!reader.done()) reject("the DLN instruction has trailing data");
    if (giveAmount !== BigInt(action.amount)) reject("the order gives another amount than the step");
    if (takeChainId !== BigInt(dlnChainId(destination))) reject("the order takes on another chain");
    if (takeToken !== tokenBytes(action.output)) reject("the order takes another token");
    if (takeAmount !== BigInt(quote.takeAmount) || takeAmount === 0n) reject("the order takes another amount than quoted");
    if (receiverDst !== accountBytes(destination, action.recipient.address)) reject("the order pays another recipient");
    if (externalCall !== null) reject("the order carries an external call");
    if (givePatchAuthority !== accountBytes32("solana", owner)) reject("another account may patch the order");
    if (cancelBeneficiary !== null && cancelBeneficiary !== accountBytes32("solana", owner)) reject("a cancellation would refund another account");
    if (orderAuthorityDst !== accountBytes(destination, expect.dstAuthority)) reject("another account controls the order on the destination network");
    if (affiliateFee !== null) reject("the order carries an affiliate fee");
  } catch (error) {
    if (error instanceof PlatformError) throw error;
    reject("the DLN instruction arguments cannot be decoded");
  }
  return { instructions, program };
}

/* --------------------------------------------------------------- quotes */

interface CheckedOrder {
  readonly quote: DlnOrderQuote;
  readonly fixFee: AssetAmount;
  readonly fixFeeUsd: number | null;
  readonly dstAuthority: { readonly address: string; readonly crossVm: boolean };
  readonly source: string;
  readonly solana?: DecodedSolanaOrder;
  readonly allowance: bigint | null;
}

async function checkedOrder(action: AdapterAction, stage: "plan" | "prepare"): Promise<CheckedOrder> {
  const source = pinned(action.network, "dln-source");
  if (!source) throw new PlatformError("NETWORK_UNSUPPORTED", `deBridge DLN has no pinned DlnSource on ${CHAINS[action.network].name}.`, 422);
  if (isSolanaNetworkKey(action.destinationNetwork)) {
    await assertSolanaWalletRecipient(action.destinationNetwork, action.recipient.address);
  }
  const dstAuthority = destinationAuthority(action);
  const [quote, fee] = await Promise.all([
    fetchDlnOrder({
      srcChainId: dlnChainId(action.network),
      srcChainTokenIn: dlnTokenAddress(action.input.isNative, action.input.address, svm(action.network)),
      amount: action.amount,
      dstChainId: dlnChainId(action.destinationNetwork),
      dstChainTokenOut: dlnTokenAddress(action.output.isNative, action.output.address, svm(action.destinationNetwork)),
      recipient: action.recipient.address,
      sender: action.account.address,
      dstAuthority: dstAuthority.address,
    }),
    onchainFixFee(action.network),
  ]);
  // The fixed fee is capped by the pinned contract's own setting, never by the API.
  if (BigInt(quote.fixFee) !== fee) reject(`the fixed fee ${quote.fixFee} differs from the on-chain fee ${fee}`);
  // Same-asset order: a take above the give can never be filled, and an unfilled order must be cancelled on the destination.
  if (
    action.input.group !== undefined && action.input.group === action.output.group &&
    BigInt(quote.takeAmount) * 10n ** BigInt(action.input.decimals) > BigInt(action.amount) * 10n ** BigInt(action.output.decimals)
  ) {
    reject("the order takes more than it gives");
  }
  const expect = { action, quote, dstAuthority: dstAuthority.address };
  let solana: DecodedSolanaOrder | undefined;
  let allowance: bigint | null = null;
  if (isEvmNetwork(action.network)) {
    if (quote.tx.to === null || !sameEvm(quote.tx.to, source)) reject("the transaction does not target the pinned DlnSource");
    const value = BigInt(quote.tx.value ?? "0");
    const expected = fee + (action.input.isNative ? BigInt(action.amount) : 0n);
    if (value !== expected) reject("the transaction value is not exactly the fixed fee (plus a native amount)");
    checkEvmOrder(quote.tx.data, expect);
    if (!action.input.isNative) {
      const read = readAllowance(action.network, action.input.address as string, action.account.address, source);
      allowance = stage === "plan" ? await read.catch(() => 0n) : await read;
    }
  } else if (isSolanaNetworkKey(action.network)) {
    if (quote.tx.to !== null || quote.tx.value !== null) reject("a Solana order carries EVM fields");
    solana = await checkSolanaOrder(quote.tx.data, expect);
  } else {
    throw new PlatformError("NETWORK_UNSUPPORTED", "deBridge DLN does not serve this network.", 422);
  }
  const native = await resolveAsset(action.network, CHAINS[action.network].nativeAsset.symbol);
  const price = await nativeUsdPrice(action.network);
  const fixFeeUsd = price !== null && price > 0 ? Number(fromBaseUnits(fee, native.decimals)) * price : null;
  return {
    quote,
    fixFee: assetAmount(native, fee.toString(), fixFeeUsd ?? undefined),
    fixFeeUsd,
    dstAuthority,
    source,
    ...(solana ? { solana } : {}),
    allowance,
  };
}

/** The EVM payload of a checked order: an exact approval when the allowance is short, then createOrder (plan preview and prepare). */
function dlnEvmTransactions(action: AdapterAction, network: EvmNetworkKey, order: CheckedOrder): TransactionRequest[] {
  const amount = BigInt(action.amount);
  const chainId = evmChainId(network);
  const from = getAddress(action.account.address);
  const transactions: TransactionRequest[] = [];
  if (order.allowance !== null && order.allowance < amount) {
    transactions.push({
      vm: "evm",
      network,
      chainId,
      from,
      to: getAddress(action.input.address as string),
      data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [getAddress(order.source), amount] }),
      value: "0",
      gas: APPROVE_GAS,
      description: `Approve ${formatAmount(fromBaseUnits(action.amount, action.input.decimals))} ${action.input.symbol} for deBridge`,
    });
  }
  transactions.push({
    vm: "evm",
    network,
    chainId,
    from,
    to: getAddress(order.source),
    data: order.quote.tx.data,
    value: order.quote.tx.value ?? "0",
    description: title(action),
  });
  return transactions;
}

/** Seconds a DLN order quote's transactions are previewed for. */
const PREVIEW_TTL_SECONDS = 60;

/** The create-order response the plan already fetched, for the plan-time preview (EVM origins). */
function dlnPreview(action: AdapterAction, order: CheckedOrder): PlannedStepPreview | undefined {
  if (!isEvmNetwork(action.network)) return undefined;
  const protocolFee = order.quote.protocolFeeUsd;
  return {
    transactions: dlnEvmTransactions(action, action.network, order),
    approvalSpender: order.source.toLowerCase(),
    ...(protocolFee !== null && protocolFee > 0
      ? { venueFees: [{ kind: "venue" as const, label: "deBridge protocol fee", usd: protocolFee, paid: "deducted" as const, certainty: "quoted" as const }] }
      : {}),
    expiresAt: Math.floor(Date.now() / 1000) + PREVIEW_TTL_SECONDS,
  };
}

function title(action: Pick<AdapterAction, "network" | "destinationNetwork" | "input" | "output" | "amount">): string {
  const amount = `${formatAmount(fromBaseUnits(action.amount, action.input.decimals))} ${action.input.symbol}`;
  const base = `Bridge ${amount} from ${CHAINS[action.network].name} to ${CHAINS[action.destinationNetwork].name} via deBridge`;
  return action.output.symbol.toUpperCase() === action.input.symbol.toUpperCase() ? base : `${base} as ${action.output.symbol}`;
}

function warnings(action: AdapterAction, order: CheckedOrder): string[] {
  const rent = isSolanaNetworkKey(action.network) ? " plus order account rent" : "";
  const notes = [`Route: deBridge DLN order; ${order.fixFee.formatted} ${order.fixFee.symbol} fixed fee${rent} on top of the amount.`];
  if (order.dstAuthority.crossVm) {
    notes.push(
      `If no solver fills the order, it can be cancelled only from ${order.dstAuthority.address} on ${CHAINS[action.destinationNetwork].name}; the refund goes back to the sending account.`,
    );
  }
  return notes;
}

function orderAmounts(action: AdapterAction, order: CheckedOrder) {
  // DLN takes an exact amount; the step minimum keeps a small re-quote cushion below it (see cushionedMinimum).
  return {
    input: assetAmount(action.input, action.amount, order.quote.inputUsd ?? undefined),
    expectedOutput: assetAmount(action.output, order.quote.takeAmount, order.quote.outputUsd ?? undefined),
    minimumOutput: assetAmount(action.output, cushionedMinimum(order.quote.takeAmount, action.slippageBps)),
  };
}

function feesUsd(order: CheckedOrder): number | undefined {
  if (order.fixFeeUsd === null) return undefined;
  return order.fixFeeUsd + (order.quote.protocolFeeUsd ?? 0);
}

/* ---------------------------------------------------------- settlement */

/** Order ids quoted for this step (plan and every prepare), most recent first. */
export function dlnOrderIds(step: IntentStep): string[] {
  const ids: string[] = [];
  const add = (value: string | undefined) => {
    const id = value?.toLowerCase();
    if (id && ORDER_ID.test(id) && !ids.includes(id)) ids.push(id);
  };
  add(step.settlement?.trackingId);
  for (const entry of [...step.evidence].reverse()) {
    if (entry.kind === "quote") add(entry.reference);
  }
  return ids;
}

type DlnEventOrder = {
  readonly makerOrderNonce: bigint;
  readonly makerSrc: Hex;
  readonly giveChainId: bigint;
  readonly giveTokenAddress: Hex;
  readonly giveAmount: bigint;
  readonly takeChainId: bigint;
  readonly takeTokenAddress: Hex;
  readonly takeAmount: bigint;
  readonly receiverDst: Hex;
  readonly orderAuthorityAddressDst: Hex;
  readonly externalCall: Hex;
};

/** The order a landed EVM deposit created: CreatedOrder of the pinned DlnSource matching the calldata. */
function createdOrder(
  step: IntentStep,
  receipts: readonly { readonly to: string | null; readonly input: string; readonly logs: readonly Log[] }[],
): { orderId: string; order: DlnEventOrder } | null {
  if (!isEvmNetwork(step.network)) return null;
  const source = pinned(step.network, "dln-source");
  const deposit = receipts[receipts.length - 1];
  if (!source || !deposit || !sameEvm(deposit.to ?? "", source)) return null;
  let creation;
  try {
    const decoded = decodeFunctionData({ abi: DLN_SOURCE_ABI, data: deposit.input as Hex });
    if (decoded.functionName !== "createSaltedOrder") return null;
    creation = { order: decoded.args[0], salt: decoded.args[1] };
  } catch {
    return null;
  }
  const quoted = dlnOrderIds(step);
  const maker = accountBytes(step.network, stepOwner(step));
  for (const event of evmEvents(receipts, { address: source, abi: DLN_EVENTS_ABI, eventName: "CreatedOrder" })) {
    const { order, orderId, percentFee } = event.args;
    const id = orderId.toLowerCase();
    if (!quoted.includes(id)) continue;
    if (
      order.makerOrderNonce === creation.salt &&
      order.makerSrc.toLowerCase() === maker &&
      order.giveChainId === BigInt(dlnChainId(step.network)) &&
      order.giveTokenAddress.toLowerCase() === creation.order.giveTokenAddress.toLowerCase() &&
      order.giveAmount + percentFee === creation.order.giveAmount &&
      order.takeChainId === creation.order.takeChainId &&
      order.takeTokenAddress.toLowerCase() === creation.order.takeTokenAddress.toLowerCase() &&
      order.takeAmount === creation.order.takeAmount &&
      order.receiverDst.toLowerCase() === creation.order.receiverDst.toLowerCase() &&
      order.orderAuthorityAddressDst.toLowerCase() === creation.order.orderAuthorityAddressDst.toLowerCase() &&
      order.externalCall === "0x"
    ) {
      return { orderId: id, order };
    }
  }
  return null;
}

/** Lowest guaranteed output among the payloads prepared for the step. */
function lowestFloor(step: IntentStep): bigint | null {
  const ref = decodeStepRef(step.quoteRef);
  const floors = [
    ...(ref?.floors ?? []).map((entry) => BigInt(entry.min)),
    ...(step.minimumOutput ? [BigInt(step.minimumOutput.amount)] : []),
  ];
  return floors.length > 0 ? floors.reduce((low, value) => (value < low ? value : low)) : null;
}

/** The order the deposit created, as on-chain evidence (EVM) or through the order-ids index (Solana). */
async function orderForDeposit(step: IntentStep, deposit: string): Promise<{ orderId: string; takeAmount: bigint | null } | "foreign" | null> {
  if (isEvmNetwork(step.network)) {
    const landed = await observeEvmTransaction(step.network, deposit);
    if (landed.state !== "landed" || landed.status !== "success") return null;
    const created = createdOrder(step, [landed]);
    return created ? { orderId: created.orderId, takeAmount: created.order.takeAmount } : null;
  }
  const listed = await fetchDlnOrderIds(deposit);
  const quoted = dlnOrderIds(step);
  const own = listed.find((id) => quoted.includes(id));
  if (own) return { orderId: own, takeAmount: null };
  return listed.length > 0 ? "foreign" : null;
}

/* -------------------------------------------------------------- adapter */

export const debridgeDlnAdapter: ProtocolAdapter = {
  id: "debridge-dln",
  protocols: ["debridge-dln"],
  label: "deBridge DLN",

  supports(route) {
    if (route.kind !== "bridge" || route.network === route.destinationNetwork) return false;
    if (!DLN_NETWORKS.includes(route.network) || !DLN_NETWORKS.includes(route.destinationNetwork)) return false;
    if (CHAINS[route.network].settlement.debridgeChainId === undefined || CHAINS[route.destinationNetwork].settlement.debridgeChainId === undefined) {
      return false;
    }
    if (!pinned(route.network, "dln-source") || !(isEvmNetwork(route.network) || route.network === "solana")) return false;
    // Canonical (registry) assets only: the order's give / take tokens are checked against them.
    return route.input.canonical && route.output.canonical;
  },

  async plan(action): Promise<PlannedStep> {
    const order = await checkedOrder(action, "plan");
    const preview = dlnPreview(action, order);
    const seconds = Math.max(order.quote.fulfillmentSeconds, 5);
    const approval = order.allowance !== null && order.allowance < BigInt(action.amount) ? 1 : 0;
    const fees = feesUsd(order);
    return {
      protocol: "debridge-dln",
      title: title(action),
      mode: "wallet",
      ...orderAmounts(action, order),
      ...(fees !== undefined ? { feesUsd: fees } : {}),
      extraCosts: [order.fixFee],
      estimatedSeconds: seconds + 15,
      settlement: { kind: "cross-network", destinationNetwork: action.destinationNetwork, expectedSeconds: seconds },
      warnings: warnings(action, order),
      quoteId: order.quote.orderId,
      transactionCount: 1 + approval,
      slippageBps: action.slippageBps,
      ...(preview ? { preview } : {}),
    };
  },

  async prepare({ action }): Promise<PreparedPayload> {
    const amount = BigInt(action.amount);
    if (isEvmNetwork(action.network)) {
      await assertEvmBalance(action.network, action.account.address, action.input.address, amount, action.input.symbol, action.input.decimals);
    }
    const order = await checkedOrder(action, "prepare");
    const description = title(action);
    let transactions: TransactionRequest[];
    let records: PreparedPayload["records"];
    if (isEvmNetwork(action.network)) {
      const network: EvmNetworkKey = action.network;
      transactions = dlnEvmTransactions(action, network, order);
      records = transactions.map((transaction) => ({
        vm: "evm" as const,
        network,
        to: transaction.vm === "evm" ? transaction.to : "",
        description: transaction.description,
      }));
    } else {
      const solana = order.solana;
      if (!solana || !isSolanaNetworkKey(action.network)) throw new PlatformError("NETWORK_UNSUPPORTED", "deBridge DLN does not serve this network.", 422);
      // Re-assembled from the validated instructions with a fresh blockhash (the API's blockhash expires within a minute).
      const prepared = await assembleSolanaTransaction({ network: action.network, feePayer: action.account.address, instructions: solana.instructions });
      const simulation = await confirmSimulation(action.network, prepared.transaction, prepared.simulation);
      if (simulation && !simulation.ok) {
        throw new PlatformError(
          "SIMULATION_FAILED",
          `The deBridge order would fail on-chain (${simulation.error.slice(0, 160)}). Check the balance of the sending account, including the ${order.fixFee.formatted} ${order.fixFee.symbol} fee.`,
          422,
        );
      }
      const info = assertSolanaTransactionOwner(prepared.transaction, action.account.address);
      if (info.programs.some((program) => program !== solana.program && program !== SOLANA_PROGRAM_IDS.computeBudget)) {
        reject("the assembled transaction invokes an unpinned program");
      }
      transactions = [{
        vm: "svm",
        network: action.network,
        feePayer: action.account.address,
        transaction: prepared.transaction,
        encoding: "base64",
        lastValidBlockHeight: prepared.lastValidBlockHeight,
        description,
      }];
      records = [{ vm: "svm" as const, network: action.network, feePayer: action.account.address, to: solana.program, description }];
    }
    const fees = feesUsd(order);
    return {
      transactions,
      records,
      ...orderAmounts(action, order),
      ...(fees !== undefined ? { feesUsd: fees } : {}),
      extraCosts: [order.fixFee],
      trackingId: order.quote.orderId,
      quoteId: order.quote.orderId,
      warnings: warnings(action, order),
    };
  },

  async verify(context): Promise<VerificationResult> {
    const { step } = context;
    if (step.chain.startsWith("eip155:")) {
      const { result } = await verifyEvmReceipts(context, (receipts) => {
        const created = createdOrder(step, receipts);
        if (!created) {
          return { failure: { code: "OUTCOME_NOT_PROVEN", message: "The pinned DlnSource did not emit CreatedOrder for a quoted order matching the deposit." } };
        }
        return {
          evidence: [{
            kind: "note",
            network: step.network,
            reference: created.orderId,
            observedAt: new Date(context.now).toISOString(),
            detail: `deBridge order ${created.orderId.slice(0, 10)}… created for ${fromBaseUnits(created.order.takeAmount, step.minimumOutput?.decimals ?? 0)} ${step.minimumOutput?.symbol ?? ""}.`.slice(0, 300),
          }],
        };
      });
      return result;
    }
    const input = step.input ? assetFromRef(step.input) : null;
    const owner = stepOwner(step);
    const { result } = await verifySolanaReferences(context, (observations) => {
      if (!input || !step.input) return { failure: { code: "STEP_INVALID", message: "The step has no recorded input." } };
      const spent = input.isNative ? -effectiveSolDelta(observations, owner) : -tokenDelta(observations, owner, input.address as string);
      if (spent < BigInt(step.input.amount)) {
        return { failure: { code: "REFERENCE_MISMATCH", message: `The order did not debit ${step.input.formatted} ${input.symbol} from the step account.` } };
      }
    });
    if (result.status !== "confirmed") return result;
    // Solana wallets re-sign payloads, so bind the deposit through DLN's order index to an order quoted for this step.
    const deposit = context.references[context.references.length - 1] as string;
    const match = await orderForDeposit(step, deposit);
    if (match === "foreign") {
      return { status: "failed", evidence: [], failure: { code: "REFERENCE_MISMATCH", message: "The transaction created a deBridge order that was not quoted for this step." } };
    }
    if (match === null) {
      return { status: "pending", evidence: [], reason: "deBridge has not indexed the order yet.", stale: context.now - context.submittedAt > REFERENCE_STALE_MS };
    }
    return result;
  },

  async poll(step: IntentStep): Promise<SettlementResult> {
    const destination = step.settlement?.destinationNetwork;
    const deposit = step.references?.[step.references.length - 1];
    const recipient = step.recipient ? parseAccountId(step.recipient) : null;
    const output = step.minimumOutput ? assetFromRef(step.minimumOutput) : null;
    if (!destination || !deposit || !recipient || !output) {
      return { status: "failed", evidence: [], failure: { code: "STEP_INVALID", message: "The bridge step lacks a deposit, recipient or output." } };
    }
    const match = await orderForDeposit(step, deposit);
    if (match === null || match === "foreign") return { status: "settling", evidence: [] };
    const floor = match.takeAmount ?? lowestFloor(step);
    if (floor === null) return { status: "settling", evidence: [] };
    const status = await fetchDlnOrderStatus(match.orderId);
    if (status.state === "OrderCancelled" || status.state === "SentOrderCancel" || status.state === "ClaimedOrderCancel") {
      return {
        status: "failed",
        evidence: [],
        failure: { code: "SETTLEMENT_REFUNDED", message: `The deBridge order was cancelled (${status.state}); the deposit returns to the sending account on ${CHAINS[step.network].name}.` },
      };
    }
    if (status.state !== "Fulfilled" && status.state !== "SentUnlock" && status.state !== "ClaimedUnlock") return { status: "settling", evidence: [] };
    const fill = status.fulfillTx;
    if (!fill) return { status: "settling", evidence: [] };
    let credited: bigint | null = null;
    if (isEvmNetwork(destination)) {
      const target = pinned(destination, "dln-destination");
      const receipt = await readEvmReceiptStatus(destination, fill).catch(() => null);
      if (!target || !receipt || receipt.status !== "success") return { status: "settling", evidence: [] };
      const fulfilled = evmEvents([receipt], { address: target, abi: DLN_EVENTS_ABI, eventName: "FulfilledOrder" })
        .find((event) => event.args.orderId.toLowerCase() === match.orderId);
      if (!fulfilled) return { status: "settling", evidence: [] };
      const order = fulfilled.args.order;
      if (
        order.receiverDst.toLowerCase() !== accountBytes(destination, recipient.address) ||
        order.takeTokenAddress.toLowerCase() !== tokenBytes(output) ||
        order.takeChainId !== BigInt(dlnChainId(destination)) ||
        order.takeAmount < floor
      ) {
        return { status: "failed", evidence: [], failure: { code: "SETTLEMENT_MISMATCH", message: "The deBridge fill does not pay the quoted recipient, asset or amount." } };
      }
      credited = order.takeAmount;
    } else if (isSolanaNetworkKey(destination)) {
      // The tracking API names the fill: it must land after the step was first prepared (the service claims it for
      // this step only) and the reported output is at most the order's take amount.
      const read = await readSolanaCredit(destination, fill, recipient.address, output.isNative ? null : (output.address as string)).catch(() => null);
      const notBefore = fillNotBefore(step);
      if (!read || read.status !== "success" || read.credited === null || read.credited < floor) return { status: "settling", evidence: [] };
      if (notBefore === null || read.blockTime === null || read.blockTime < notBefore) return { status: "settling", evidence: [] };
      credited = cappedOutput(read.credited, match.takeAmount ?? step.expectedOutput?.amount);
    } else {
      return { status: "settling", evidence: [] };
    }
    const evidence: StepEvidence = {
      kind: "settlement",
      network: destination,
      reference: fill,
      url: explorerTxUrl(destination, fill),
      observedAt: new Date().toISOString(),
      detail: `deBridge order ${match.orderId.slice(0, 10)}… filled on ${CHAINS[destination].name}; ${fromBaseUnits(credited, output.decimals)} ${output.symbol} to the recipient.`,
    };
    return { status: "settled", evidence: [evidence], actualOutput: assetAmount(output, credited.toString()) };
  },
};

