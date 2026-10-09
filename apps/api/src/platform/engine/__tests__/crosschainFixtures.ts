/**
 * Fixtures for the cross-network venue tests (crosschain*.test.ts): a fetch
 * double layered over the shared RPC mock that answers LI.FI, deBridge DLN,
 * Jupiter prices and the EVM / Solana reads the venues make (allowances,
 * balances, DLN's fixed fee, token and state accounts, blockhashes), plus
 * builders for real calldata, events and Solana transactions.
 */
import { createHash } from "node:crypto";
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  blockhash,
  compileTransaction,
  createTransactionMessage,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  encodeFunctionResult,
  erc20Abi,
  parseAbi,
  toFunctionSelector,
  type Hex,
} from "viem";
import {
  CHAINS,
  findAssetBySymbol,
  getAsset,
  nativeAssetId,
  parseAccountId,
  type IntentStep,
  type NetworkKey,
  type ParsedAccountId,
  type TransactionRequest,
} from "@kletia/core";
import { quoteBindingFor } from "../binding.js";
import { LIFI_DIAMOND_ABI, accountBytes, accountBytes32 } from "../adapters/lifi.js";
import { DLN_SOURCE_ABI } from "../adapters/debridge.js";
import type { AdapterAction } from "../adapters/types.js";
import type { ResolvedAsset } from "../assets.js";
import { EVM_ADDRESS, randomEvmHash, SOL_ADDRESS } from "./helpers.js";
import { installRpcMock, preparedStep, type RpcMock } from "./rpcMock.js";

export const LIFI_DIAMOND = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE";
export const FEE_FORWARDER = "0xCE40449B773a3E6E5e769ADb4e567179d4828cbd";
export const LIFI_FEE_RECIPIENT = "0xC06ebbefD94032B85424D51906e2A335EFAe264B";
export const NON_EVM_RECEIVER = "0x11f111f111f111F111f111f111F111f111f111F1";
export const DLN_SOURCE = "0xeF4fB24aD0916217251F553c0596F8Edc630EB66";
export const DLN_DESTINATION = "0xE7351Fd770A37282b91D153Ee690B63579D6dd7f";
export const DLN_SOLANA_SOURCE = "src5qyZHqTqecJV4aY6Cb6zDZLMDzrDKKezs22MPHr4";
/** PDA ["STATE"] of the DLN source program (derived and read back on mainnet). */
export const DLN_SOLANA_STATE = "HJEPgYkbqjetrphNHG2W33SjG9mB4PrXorW358MzfggY";
export const RELAY_DEPOSITORY = "0x4cD00E387622C35bDDB9b4c962C136462338BC31";
export const RELAY_ROUTER = "0xb92fe925DC43a0ECdE6c8b1a2709c170Ec4fFf4f";
export const RELAY_SOLANA_DEPOSITORY = "99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2";
export const USDC_SOL = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
/** Jupiter's ETH price proxy (Wormhole WETH) and wrapped SOL, as priced by engine/prices.ts. */
export const ETH_PROXY_MINT = "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs";
export const WSOL_MINT = "So11111111111111111111111111111111111111112";
export const DLN_EVM_FIX_FEE = 1_000_000_000_000_000n;
export const DLN_SOLANA_FIX_FEE = 15_000_000n;

const FEE_FORWARDER_ABI = parseAbi([
  "struct FeeDistribution { address recipient; uint256 amount; }",
  "function forwardERC20Fees(address _token, FeeDistribution[] _distributions)",
]);

export const EVENTS_ABI = parseAbi([
  "struct BridgeData { bytes32 transactionId; string bridge; string integrator; address referrer; address sendingAssetId; address receiver; uint256 minAmount; uint256 destinationChainId; bool hasSourceSwaps; bool hasDestinationCall; }",
  "event LiFiTransferStarted(BridgeData bridgeData)",
  "struct Order { uint64 makerOrderNonce; bytes makerSrc; uint256 giveChainId; bytes giveTokenAddress; uint256 giveAmount; uint256 takeChainId; bytes takeTokenAddress; uint256 takeAmount; bytes receiverDst; bytes givePatchAuthoritySrc; bytes orderAuthorityAddressDst; bytes allowedTakerDst; bytes allowedCancelBeneficiarySrc; bytes externalCall; }",
  "event CreatedOrder(Order order, bytes32 orderId, bytes affiliateFee, uint256 nativeFixFee, uint256 percentFee, uint32 referralCode, bytes metadata)",
  "event FulfilledOrder(Order order, bytes32 orderId, address sender, address unlockAuthority)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

/* ---------------------------------------------------------------- assets */

export function asset(network: NetworkKey, symbol: string): ResolvedAsset {
  const descriptor = findAssetBySymbol(network, symbol) ?? getAsset(nativeAssetId(network));
  if (!descriptor || descriptor.symbol.toUpperCase() !== symbol.toUpperCase()) throw new Error(`no ${symbol} on ${network}`);
  return {
    network,
    id: descriptor.id,
    symbol: descriptor.symbol,
    name: descriptor.name,
    decimals: descriptor.decimals,
    address: descriptor.address,
    isNative: descriptor.address === null,
    canonical: true,
    verified: true,
    category: descriptor.category,
    ...(descriptor.group ? { group: descriptor.group } : {}),
  };
}

export function account(network: NetworkKey, value = CHAINS[network].vm === "svm" ? SOL_ADDRESS : EVM_ADDRESS): ParsedAccountId {
  const parsed = parseAccountId(`${CHAINS[network].id}:${value}`);
  if (!parsed) throw new Error(`bad account ${value}`);
  return parsed;
}

export function bridgeAction(
  from: NetworkKey,
  to: NetworkKey,
  options: { symbol?: string; out?: string; amount?: string; recipient?: string; slippageBps?: number } = {},
): AdapterAction {
  const symbol = options.symbol ?? "USDC";
  return {
    kind: "bridge",
    network: from,
    destinationNetwork: to,
    input: asset(from, symbol),
    output: asset(to, options.out ?? symbol),
    amount: options.amount ?? "25000000",
    account: account(from),
    recipient: account(to, options.recipient),
    slippageBps: options.slippageBps ?? 50,
  };
}

/* ------------------------------------------------------------ fetch mock */

export interface CrossChainMock {
  readonly rpc: RpcMock;
  /** LI.FI `/quote` factory (request query) and `/status` answers by tx hash. */
  lifiQuote: ((query: URLSearchParams) => unknown) | null;
  lifiQuoteStatus: number;
  readonly lifiStatus: Map<string, unknown>;
  /** deBridge `create-tx` factory, order ids per source tx, tracking records per order id. */
  dlnOrder: ((query: URLSearchParams) => unknown) | null;
  readonly dlnOrderIds: Map<string, string[]>;
  readonly dlnOrders: Map<string, unknown>;
  /** USD prices by Solana mint (Jupiter price API). */
  readonly prices: Map<string, number>;
  allowance: bigint;
  balance: bigint;
  /** DlnSource.globalFixedNativeFee() on every EVM network. */
  dlnFixFee: bigint;
  /** Solana `getAccountInfo` answers by address (null = account missing). */
  readonly solanaAccounts: Map<string, unknown>;
  /** Every provider URL requested, in order. */
  readonly calls: URL[];
  restore(): void;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const word = (value: bigint) => `0x${value.toString(16).padStart(64, "0")}`;
const MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11";
const MULTICALL3_ABI = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) payable returns (Result[] returnData)",
]);
const FIX_FEE_SELECTOR = toFunctionSelector("function globalFixedNativeFee()");

export function installCrossChainMock(): CrossChainMock {
  const rpc = installRpcMock();
  const inner = globalThis.fetch;
  const mock: CrossChainMock = {
    rpc,
    lifiQuote: null,
    lifiQuoteStatus: 200,
    lifiStatus: new Map(),
    dlnOrder: null,
    dlnOrderIds: new Map(),
    dlnOrders: new Map(),
    prices: new Map(),
    allowance: 0n,
    balance: 10n ** 30n,
    dlnFixFee: DLN_EVM_FIX_FEE,
    solanaAccounts: new Map(),
    calls: [],
    restore: () => rpc.restore(),
  };
  const directCall = (to: string | undefined, data: Hex): string | null => {
    if (data.startsWith(FIX_FEE_SELECTOR) && to?.toLowerCase() === DLN_SOURCE.toLowerCase()) return word(mock.dlnFixFee);
    try {
      const decoded = decodeFunctionData({ abi: erc20Abi, data });
      if (decoded.functionName === "allowance") return word(mock.allowance);
      if (decoded.functionName === "balanceOf") return word(mock.balance);
    } catch {
      return null;
    }
    return null;
  };
  // The engine's viem clients batch reads through Multicall3 (aggregate3).
  const evmCall = (params: unknown[]): string | null => {
    const call = params[0] as { to?: string; data?: string };
    const data = (call.data ?? "") as Hex;
    if (call.to?.toLowerCase() === MULTICALL3 && data.startsWith(toFunctionSelector(MULTICALL3_ABI[0]))) {
      const decoded = decodeFunctionData({ abi: MULTICALL3_ABI, data });
      const results = decoded.args[0].map((entry) => {
        const value = directCall(entry.target, entry.callData);
        return { success: value !== null, returnData: (value ?? "0x") as Hex };
      });
      return encodeFunctionResult({ abi: MULTICALL3_ABI, functionName: "aggregate3", result: results });
    }
    return directCall(call.to, data);
  };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === "li.quest") {
      mock.calls.push(url);
      if (url.pathname === "/v1/quote" && mock.lifiQuote) {
        return mock.lifiQuoteStatus === 200 ? json(mock.lifiQuote(url.searchParams)) : json({ message: "rate limited" }, mock.lifiQuoteStatus);
      }
      if (url.pathname === "/v1/status") {
        const status = mock.lifiStatus.get(url.searchParams.get("txHash") ?? "");
        return status ? json(status) : json({ message: "Transaction hash not found", code: 1003 }, 404);
      }
      return json({ message: "unmocked" }, 500);
    }
    if (url.hostname === "dln.debridge.finance") {
      mock.calls.push(url);
      if (url.pathname === "/v1.0/dln/order/create-tx" && mock.dlnOrder) return json(mock.dlnOrder(url.searchParams));
      const ids = /^\/v1\.0\/dln\/tx\/([^/]+)\/order-ids$/u.exec(url.pathname);
      if (ids) return json({ orderIds: mock.dlnOrderIds.get(decodeURIComponent(ids[1] as string)) ?? [] });
      return json({ message: "unmocked" }, 500);
    }
    if (url.hostname === "dln-api.debridge.finance") {
      mock.calls.push(url);
      const order = /^\/api\/Orders\/(0x[0-9a-fA-F]{64})$/u.exec(url.pathname);
      const record = order ? mock.dlnOrders.get((order[1] as string).toLowerCase()) : undefined;
      return record ? json(record) : json({ message: "not found" }, 404);
    }
    if (url.pathname.endsWith("/price/v3")) {
      mock.calls.push(url);
      const ids = (url.searchParams.get("ids") ?? "").split(",");
      return json(Object.fromEntries(ids.filter((id) => mock.prices.has(id)).map((id) => [id, { usdPrice: mock.prices.get(id) }])));
    }
    const text = typeof init?.body === "string" ? init.body : "";
    let payload: unknown = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    if (payload && !Array.isArray(payload) && typeof payload === "object") {
      const request = payload as { id: unknown; method: string; params?: unknown[] };
      const result = (value: unknown) => json({ jsonrpc: "2.0", id: request.id, result: value });
      if (request.method === "eth_call") {
        const value = evmCall(request.params ?? []);
        if (value !== null) return result(value);
      }
      if (request.method === "eth_getBalance") return result(`0x${mock.balance.toString(16)}`);
      if (request.method === "getAccountInfo") {
        const key = String((request.params ?? [])[0]);
        if (mock.solanaAccounts.has(key)) return result({ context: { slot: 100 }, value: mock.solanaAccounts.get(key) });
        return result({ context: { slot: 100 }, value: null });
      }
      if (request.method === "getLatestBlockhash") {
        return result({ context: { slot: 100 }, value: { blockhash: SYSTEM_PROGRAM, lastValidBlockHeight: 1_000 } });
      }
    }
    return inner(input, init);
  }) as typeof fetch;
  return mock;
}

/** The jsonParsed token account of `owner` for `mint`. */
export function tokenAccountInfo(owner: string, mint: string): unknown {
  return {
    owner: TOKEN_PROGRAM,
    lamports: 2_039_280,
    executable: false,
    rentEpoch: 0,
    space: 165,
    data: { program: "spl-token", space: 165, parsed: { type: "account", info: { mint, owner, state: "initialized", tokenAmount: { amount: "0", decimals: 6 } } } },
  };
}

/** DLN's Solana state account holding `fixedFee` at byte 40. */
export function dlnStateInfo(fixedFee: bigint = DLN_SOLANA_FIX_FEE, owner = DLN_SOLANA_SOURCE): unknown {
  const data = Buffer.alloc(512);
  data.writeBigUInt64LE(fixedFee, 40);
  return { owner, lamports: 4_000_000, executable: false, rentEpoch: 0, space: 512, data: [data.toString("base64"), "base64"] };
}

/* ------------------------------------------------------------------ LI.FI */

export interface LifiQuoteOptions {
  readonly tool?: "across" | "polymerStandard";
  readonly transactionId?: string;
  readonly to?: string;
  readonly value?: string;
  readonly fee?: bigint;
  readonly toAmountMin?: string;
  readonly reportedTool?: string;
  readonly bridge?: Partial<Record<string, unknown>>;
  readonly swap?: Partial<Record<string, unknown>>;
  readonly across?: Partial<Record<string, unknown>>;
  readonly polymer?: Partial<Record<string, unknown>>;
  /** Solana destination: the recipient's USDC account (Polymer mint recipient). */
  readonly solanaAta?: string;
}

/** A LI.FI `/quote` body for `action` whose calldata is a real diamond call. */
export function lifiQuoteBody(action: AdapterAction, options: LifiQuoteOptions = {}): Record<string, unknown> {
  const tool = options.tool ?? "across";
  const amount = BigInt(action.amount);
  const fee = options.fee ?? (amount * 25n) / 10_000n;
  const minAmount = amount - fee;
  const transactionId = options.transactionId ?? randomEvmHash();
  const destinationSvm = CHAINS[action.destinationNetwork].vm === "svm";
  const token = action.input.address as Hex;
  const bridgeData = {
    transactionId: transactionId as Hex,
    bridge: tool,
    integrator: "lifi-api",
    referrer: "0x0000000000000000000000000000000000000000" as Hex,
    sendingAssetId: token,
    receiver: (destinationSvm ? NON_EVM_RECEIVER : action.recipient.address) as Hex,
    minAmount,
    destinationChainId: BigInt(CHAINS[action.destinationNetwork].settlement.lifiChainId ?? 0),
    hasSourceSwaps: true,
    hasDestinationCall: false,
    ...options.bridge,
  };
  const swap = {
    callTo: FEE_FORWARDER as Hex,
    approveTo: FEE_FORWARDER as Hex,
    sendingAssetId: token,
    receivingAssetId: token,
    fromAmount: amount,
    callData: encodeFunctionData({ abi: FEE_FORWARDER_ABI, functionName: "forwardERC20Fees", args: [token, [{ recipient: LIFI_FEE_RECIPIENT as Hex, amount: fee }]] }),
    requiresDeposit: true,
    ...options.swap,
  };
  let data: Hex;
  let floor: bigint;
  if (tool === "across") {
    const multiplier = 999_600_000_000_000_000n;
    floor = (minAmount * multiplier) / 10n ** 18n;
    const across = {
      receiverAddress: accountBytes32(action.destinationNetwork, action.recipient.address),
      refundAddress: accountBytes32(action.network, action.account.address),
      sendingAssetId: accountBytes32(action.network, token),
      receivingAssetId: accountBytes32(action.destinationNetwork, action.output.address as string),
      outputAmount: floor,
      outputAmountMultiplier: multiplier,
      exclusiveRelayer: `0x${"00".repeat(32)}` as Hex,
      quoteTimestamp: Math.floor(Date.now() / 1000),
      fillDeadline: Math.floor(Date.now() / 1000) + 3_600,
      exclusivityParameter: 0,
      message: "0x" as Hex,
      ...options.across,
    };
    data = encodeFunctionData({ abi: LIFI_DIAMOND_ABI, functionName: "swapAndStartBridgeTokensViaAcrossV4", args: [bridgeData, [swap], across] });
  } else {
    floor = minAmount;
    const polymer = {
      polymerTokenFee: 0n,
      maxCCTPFee: 0n,
      nonEVMReceiver: destinationSvm ? accountBytes32("solana", action.recipient.address) : (`0x${"00".repeat(32)}` as Hex),
      solanaReceiverATA: destinationSvm && options.solanaAta ? accountBytes32("solana", options.solanaAta) : (`0x${"00".repeat(32)}` as Hex),
      minFinalityThreshold: 2000,
      refundRecipient: action.account.address as Hex,
      hookData: "0x" as Hex,
      ...options.polymer,
    };
    data = encodeFunctionData({ abi: LIFI_DIAMOND_ABI, functionName: "swapAndStartBridgeTokensViaPolymerCCTP", args: [bridgeData, [swap], polymer] });
  }
  const reported = options.reportedTool ?? tool;
  return {
    type: "lifi",
    tool: reported,
    transactionId,
    action: {
      fromChainId: CHAINS[action.network].settlement.lifiChainId,
      toChainId: CHAINS[action.destinationNetwork].settlement.lifiChainId,
      fromToken: { address: action.input.address },
      toToken: { address: action.output.address },
      fromAmount: action.amount,
      fromAddress: action.account.address,
      toAddress: action.recipient.address,
    },
    estimate: {
      tool: reported,
      approvalAddress: LIFI_DIAMOND,
      fromAmount: action.amount,
      toAmount: options.toAmountMin ?? floor.toString(),
      toAmountMin: options.toAmountMin ?? floor.toString(),
      executionDuration: tool === "across" ? 2 : 1080,
      feeCosts: [{ name: "LIFI Fixed Fee", amount: fee.toString(), amountUSD: "0.0625" }],
      gasCosts: [{ amountUSD: "0.004" }],
      fromAmountUSD: "25",
      toAmountUSD: "24.93",
    },
    transactionRequest: {
      to: options.to ?? LIFI_DIAMOND,
      from: action.account.address,
      chainId: CHAINS[action.network].evmChainId,
      value: options.value ?? "0x0",
      gasLimit: "0x7a120",
      data,
    },
  };
}

/** The LiFiTransferStarted log the diamond emits for a decoded call. */
export function lifiStartedLog(data: Hex, overrides: Partial<Record<string, unknown>> = {}) {
  const decoded = decodeFunctionData({ abi: LIFI_DIAMOND_ABI, data });
  const bridge = { ...(decoded.args[0] as Record<string, unknown>), ...overrides };
  return {
    address: LIFI_DIAMOND,
    topics: encodeEventTopics({ abi: EVENTS_ABI, eventName: "LiFiTransferStarted" }) as string[],
    data: encodeAbiParameters(eventInputs("LiFiTransferStarted") as never, [bridge] as never),
  };
}

/** An ERC-20 Transfer log of `token` crediting `to`. */
export function transferLog(token: string, to: string, amount: bigint) {
  return {
    address: token,
    topics: encodeEventTopics({ abi: EVENTS_ABI, eventName: "Transfer", args: { from: "0x2222222222222222222222222222222222222222", to: to as Hex } }) as string[],
    data: word(amount),
  };
}

/* --------------------------------------------------------------- deBridge */

export interface DlnOrderOptions {
  readonly orderId?: string;
  readonly takeAmount?: bigint;
  readonly fixFee?: bigint;
  readonly to?: string;
  readonly value?: bigint;
  readonly salt?: bigint;
  readonly order?: Partial<Record<string, unknown>>;
  readonly affiliateFee?: Hex;
  readonly permit?: Hex;
  /** Destination authority (defaults to the account on EVM->EVM, the recipient across VMs). */
  readonly authority?: string;
}

export function dlnAuthority(action: AdapterAction): string {
  if (CHAINS[action.network].namespace === CHAINS[action.destinationNetwork].namespace) return action.account.address;
  return action.destinationAccount?.address ?? action.recipient.address;
}

function tokenOn(asset: ResolvedAsset): string {
  if (!asset.isNative) return asset.address as string;
  return CHAINS[asset.network].vm === "svm" ? SYSTEM_PROGRAM : "0x0000000000000000000000000000000000000000";
}

/** The EVM createSaltedOrder call DLN returns for `action`. */
export function dlnEvmCall(action: AdapterAction, options: DlnOrderOptions = {}): { data: Hex; salt: bigint; creation: Record<string, unknown> } {
  const takeAmount = options.takeAmount ?? 24_669_417n;
  const destination = action.destinationNetwork;
  const creation = {
    giveTokenAddress: tokenOn(action.input) as Hex,
    giveAmount: BigInt(action.amount),
    takeTokenAddress: accountBytes(destination, tokenOn(action.output)),
    takeAmount,
    takeChainId: BigInt(CHAINS[destination].settlement.debridgeChainId ?? 0),
    receiverDst: accountBytes(destination, action.recipient.address),
    givePatchAuthoritySrc: action.account.address as Hex,
    orderAuthorityAddressDst: accountBytes(destination, options.authority ?? dlnAuthority(action)),
    allowedTakerDst: "0x555ce236c0220695b68341bc48c68d52210cc35b" as Hex,
    externalCall: "0x" as Hex,
    allowedCancelBeneficiarySrc: action.account.address.toLowerCase() as Hex,
    ...options.order,
  };
  const salt = options.salt ?? 1_791_525_114_427n;
  const data = encodeFunctionData({
    abi: DLN_SOURCE_ABI,
    functionName: "createSaltedOrder",
    args: [creation as never, salt, options.affiliateFee ?? "0x", 0, options.permit ?? "0x", "0x0101"],
  });
  return { data, salt, creation };
}

/** A DLN `create-tx` body; `tx.data` is either an EVM call or a hex Solana wire transaction. */
export function dlnOrderBody(action: AdapterAction, tx: { data: string; to?: string; value?: string }, options: DlnOrderOptions = {}): Record<string, unknown> {
  const svmOrigin = CHAINS[action.network].vm === "svm";
  return {
    estimation: {
      srcChainTokenIn: { chainId: CHAINS[action.network].settlement.debridgeChainId, address: tokenOn(action.input), amount: action.amount, approximateUsdValue: 25 },
      dstChainTokenOut: {
        chainId: CHAINS[action.destinationNetwork].settlement.debridgeChainId,
        address: tokenOn(action.output),
        amount: String(options.takeAmount ?? 24_669_417n),
        approximateUsdValue: Number(options.takeAmount ?? 24_669_417n) / 10 ** action.output.decimals,
      },
    },
    tx: svmOrigin ? { data: tx.data } : { to: tx.to ?? DLN_SOURCE, data: tx.data, value: tx.value ?? String(options.fixFee ?? DLN_EVM_FIX_FEE) },
    orderId: options.orderId ?? randomEvmHash(),
    fixFee: String(options.fixFee ?? (svmOrigin ? DLN_SOLANA_FIX_FEE : DLN_EVM_FIX_FEE)),
    order: { approximateFulfillmentDelay: 2, salt: 1, metadata: "0x" },
    protocolFeeApproximateUsdValue: 0.01,
  };
}

/** Borsh `create_order_with_nonce` arguments (DLN source IDL 3.0.0). */
export function dlnSolanaArgs(action: AdapterAction, options: DlnOrderOptions & {
  giveAmount?: bigint;
  receiver?: string;
  patchAuthority?: string;
  affiliate?: boolean;
  externalCall?: boolean;
} = {}): Buffer {
  const destination = action.destinationNetwork;
  const u64 = (value: bigint) => {
    const buffer = Buffer.alloc(8);
    buffer.writeBigUInt64LE(value);
    return buffer;
  };
  const u32 = (value: number) => {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32LE(value);
    return buffer;
  };
  const be32 = (value: bigint) => Buffer.from(value.toString(16).padStart(64, "0"), "hex");
  const bytes = (hex: string) => {
    const raw = Buffer.from(hex.replace(/^0x/u, ""), "hex");
    return Buffer.concat([u32(raw.length), raw]);
  };
  const discriminator = createHash("sha256").update("global:create_order_with_nonce").digest().subarray(0, 8);
  return Buffer.concat([
    discriminator,
    u64(options.giveAmount ?? BigInt(action.amount)),
    be32(BigInt(CHAINS[destination].settlement.debridgeChainId ?? 0)),
    bytes(accountBytes(destination, tokenOn(action.output))),
    be32(options.takeAmount ?? 23_990_823n),
    bytes(accountBytes(destination, options.receiver ?? action.recipient.address)),
    options.externalCall ? Buffer.concat([Buffer.from([1]), bytes("0x01")]) : Buffer.from([0]),
    Buffer.from(accountBytes32("solana", options.patchAuthority ?? action.account.address).slice(2), "hex"),
    Buffer.from([0]),
    bytes(accountBytes(destination, options.authority ?? dlnAuthority(action))),
    Buffer.concat([Buffer.from([1]), bytes("0x555ce236c0220695b68341bc48c68d52210cc35b")]),
    options.affiliate ? Buffer.concat([Buffer.from([1]), Buffer.alloc(32, 7), u64(1_000n)]) : Buffer.from([0]),
    Buffer.concat([Buffer.from([1]), u32(0)]),
    u64(1_791_525_154_050n),
    bytes("0x0101"),
  ]);
}

/** A hex v0 Solana transaction with ComputeBudget + a DLN order instruction (and optional extra instructions). */
export function dlnSolanaTransaction(
  action: AdapterAction,
  args: Buffer,
  options: { maker?: string; state?: string; mint?: string; program?: string; extraProgram?: string } = {},
): string {
  const maker = options.maker ?? action.account.address;
  const mint = options.mint ?? (action.input.isNative ? WSOL_MINT : (action.input.address as string));
  const writable = (value: string) => ({ address: address(value), role: AccountRole.WRITABLE });
  const readonly = (value: string) => ({ address: address(value), role: AccountRole.READONLY });
  const placeholder = (seed: number) => {
    // Distinct valid addresses for the order PDAs and wallets.
    const keys = ["GZ6bY8sXP1SBHKoC56oM9VzfDQud9aYoVYrzSVGJw2kH", "9SHQTA66Ekh7ZgMnKWsjxXk6DwXku8przs45E8bcEe38", "ESNHJY531rT43eEhSMLN3X3aWrzUeSF29UYuswzP4CD",
      "CRcmtpKGPocuZJE3i9HFJUrFHGBYHXqL3Je73ESgJqfH", "9yfN3qv6tKxhniWcrQi7bP1kZgXmdd4dLm84rostKvQG", "E1wEhZUxu4EpiMGduUuNhvt6LTcXf7jHj96a514PQwH2"];
    return keys[seed] as string;
  };
  const order = {
    programAddress: address(options.program ?? DLN_SOLANA_SOURCE),
    accounts: [
      { address: address(maker), role: AccountRole.WRITABLE_SIGNER },
      readonly(options.state ?? DLN_SOLANA_STATE),
      readonly(mint),
      writable(placeholder(0)),
      readonly(placeholder(5)),
      writable(placeholder(1)),
      writable(placeholder(2)),
      writable(placeholder(3)),
      writable(placeholder(4)),
      readonly(SYSTEM_PROGRAM),
      readonly(TOKEN_PROGRAM),
      readonly(ATA_PROGRAM),
    ],
    data: new Uint8Array(args),
  };
  const instructions = [
    { programAddress: address(COMPUTE_BUDGET), accounts: [], data: new Uint8Array([2, 0x40, 0x0d, 0x03, 0x00]) },
    order,
    ...(options.extraProgram ? [{ programAddress: address(options.extraProgram), accounts: [], data: new Uint8Array([1]) }] : []),
  ];
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (draft) => setTransactionMessageFeePayer(address(maker), draft),
    (draft) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash(SYSTEM_PROGRAM), lastValidBlockHeight: 1_000n }, draft),
    (draft) => appendTransactionMessageInstructions(instructions, draft),
  );
  return `0x${Buffer.from(getTransactionEncoder().encode(compileTransaction(message))).toString("hex")}`;
}

/** Abi-encoded DLN Order event struct for a creation call. */
export function dlnEventOrder(action: AdapterAction, creation: Record<string, unknown>, salt: bigint, percentFee: bigint): Record<string, unknown> {
  return {
    makerOrderNonce: salt,
    makerSrc: action.account.address.toLowerCase(),
    giveChainId: BigInt(CHAINS[action.network].settlement.debridgeChainId ?? 0),
    giveTokenAddress: String(creation.giveTokenAddress).toLowerCase(),
    giveAmount: (creation.giveAmount as bigint) - percentFee,
    takeChainId: creation.takeChainId,
    takeTokenAddress: creation.takeTokenAddress,
    takeAmount: creation.takeAmount,
    receiverDst: creation.receiverDst,
    givePatchAuthoritySrc: String(creation.givePatchAuthoritySrc).toLowerCase(),
    orderAuthorityAddressDst: creation.orderAuthorityAddressDst,
    allowedTakerDst: creation.allowedTakerDst,
    allowedCancelBeneficiarySrc: creation.allowedCancelBeneficiarySrc,
    externalCall: creation.externalCall,
  };
}

function eventInputs(name: "LiFiTransferStarted" | "CreatedOrder" | "FulfilledOrder") {
  const event = EVENTS_ABI.find((item) => item.type === "event" && item.name === name);
  if (!event || event.type !== "event") throw new Error(name);
  return event.inputs;
}

export function createdOrderLog(order: Record<string, unknown>, orderId: string, percentFee: bigint) {
  return {
    address: DLN_SOURCE,
    topics: encodeEventTopics({ abi: EVENTS_ABI, eventName: "CreatedOrder" }) as string[],
    data: encodeAbiParameters(eventInputs("CreatedOrder") as never, [order, orderId, "0x", DLN_EVM_FIX_FEE, percentFee, 0, "0x"] as never),
  };
}

export function fulfilledOrderLog(order: Record<string, unknown>, orderId: string) {
  return {
    address: DLN_DESTINATION,
    topics: encodeEventTopics({ abi: EVENTS_ABI, eventName: "FulfilledOrder" }) as string[],
    data: encodeAbiParameters(eventInputs("FulfilledOrder") as never, [order, orderId, "0x3333333333333333333333333333333333333333", "0x4444444444444444444444444444444444444444"] as never),
  };
}

/* ------------------------------------------------------- verification steps */

export const PREPARED_AT = Date.parse("2026-10-09T08:00:00.000Z");
export const seconds = (ms: number) => Math.floor(ms / 1000);

/** A submitted EVM bridge step prepared with `transactions` (binding + quote evidence for each tracking id). */
export function evmBridgeStep(
  action: AdapterAction,
  protocol: "lifi" | "debridge-dln",
  transactions: readonly TransactionRequest[],
  options: { trackingIds?: readonly string[]; minimum?: string; references?: readonly string[] } = {},
): IntentStep {
  const binding = quoteBindingFor(transactions);
  const at = new Date(PREPARED_AT).toISOString();
  const output = action.output;
  return preparedStep({
    kind: "bridge",
    protocol,
    network: action.network,
    chain: CHAINS[action.network].id,
    account: action.account.id,
    recipient: action.recipient.id,
    input: { asset: action.input.id, symbol: action.input.symbol, decimals: action.input.decimals, amount: action.amount, formatted: "25" },
    minimumOutput: { asset: output.id, symbol: output.symbol, decimals: output.decimals, amount: options.minimum ?? "24000000", formatted: "24" },
    settlement: { kind: "cross-network", destinationNetwork: action.destinationNetwork, ...(options.trackingIds?.[0] ? { trackingId: options.trackingIds[0] } : {}) },
    prepared: {
      quoteBinding: binding,
      preparedAt: at,
      expiresAt: seconds(PREPARED_AT) + 90,
      transactions: transactions.map((transaction) => ({ vm: "evm", network: action.network, to: transaction.vm === "evm" ? transaction.to : "", description: "tx" })),
    },
    evidence: [
      { kind: "quote", network: action.network, reference: binding, observedAt: at },
      ...(options.trackingIds ?? []).map((reference) => ({ kind: "quote" as const, network: action.network, reference, observedAt: at })),
    ],
    ...(options.references ? { references: [...options.references], status: "settling" as const } : {}),
  });
}

/** Lands `transactions` on the mock chain (same target, calldata and value), the last one with `logs`. */
export function landPrepared(
  rpc: RpcMock,
  transactions: readonly TransactionRequest[],
  logs: readonly { address: string; topics: readonly string[]; data: string }[],
  status: "success" | "reverted" = "success",
): string[] {
  return transactions.map((transaction, index) => {
    if (transaction.vm !== "evm") throw new Error("evm only");
    const hash = randomEvmHash();
    rpc.evm.set(hash.toLowerCase(), {
      hash,
      from: transaction.from,
      to: transaction.to,
      input: transaction.data,
      value: BigInt(transaction.value),
      chainId: transaction.chainId,
      status: index === transactions.length - 1 ? status : "success",
      blockNumber: 5_000n + BigInt(rpc.evm.size),
      timestamp: seconds(PREPARED_AT) + 30,
      logs: index === transactions.length - 1 ? logs : [],
    });
    return hash;
  });
}
