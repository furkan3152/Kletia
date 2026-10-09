/**
 * Network jobs of the asset-change preview (asset-preview design §5.2).
 *
 * A job is what one account executes on one EVM network that can be
 * simulated in one `eth_simulateV1` request: consecutive steps (graph order)
 * of the same account on the same network, each funded either from outside
 * this network or by a step of the same job, at most 8 blocks and 40 calls.
 * Every step is one block; blocks share state, so a swap's output really is
 * spent by the next step's block.
 *
 * A block is:
 *
 *   [balanceOf(owner) of the input and output tokens]          (before)
 *   [the step's transactions]                                   (approve…, call)
 *   [the same reads]                                            (after)
 *   [allowance(owner, spender) for every approval granted]
 *   [GasPriceOracle.getL1Fee(unsigned tx) per transaction]      (OP stack only)
 *
 * A block whose funding parent sits outside the job and has not settled
 * assumes the parent's funds (`assumeFunds`, overridden in simulate.ts).
 * Prepare-stage jobs never assume anything (S8): the wallet's real state is
 * what the user signs against.
 */
import { encodeFunctionData, erc20Abi, getAddress, parseAbi, serializeTransaction, type Hex } from "viem";
import {
  CHAINS,
  isStepDone,
  parseAccountId,
  parseAssetId,
  type AssetRef,
  type EvmTransactionRequest,
  type IntentGraph,
  type IntentStep,
  type PreviewStage,
  type TransactionRequest,
} from "@kletia/core";
import type { PlannedVenueFee } from "../adapters/types.js";
import { isEvmNetwork, type EvmNetworkKey } from "../chains/evm.js";
import type { SimulationCall } from "../contracts/simulateEvm.js";

/** Most blocks (steps) one simulation request carries. */
export const MAX_JOB_BLOCKS = 8;
/** Most calls (reads included) one simulation request carries. */
export const MAX_JOB_CALLS = 40;

/** OP-stack GasPriceOracle predeploy (Base, OP Mainnet). */
export const GAS_PRICE_ORACLE = "0x420000000000000000000000000000000000000F";
export const OP_STACK_NETWORKS: readonly EvmNetworkKey[] = ["base", "optimism"];
/** Arbitrum NodeInterface (not callable inside eth_simulateV1: read with a parallel eth_call). */
export const NODE_INTERFACE = "0x00000000000000000000000000000000000000C8";
export const ARBITRUM_NETWORKS: readonly EvmNetworkKey[] = ["arbitrum", "arbitrum-sepolia"];

export const GAS_PRICE_ORACLE_ABI = parseAbi(["function getL1Fee(bytes) view returns (uint256)"]);
export const NODE_INTERFACE_ABI = parseAbi([
  "function gasEstimateL1Component(address to, bool contractCreation, bytes data) payable returns (uint64 gasEstimateForL1, uint256 baseFee, uint256 l1BaseFeeEstimate)",
]);

const APPROVE_SELECTOR = "0x095ea7b3";

/** Where a step's transactions come from (design §5.1). */
export interface StepTransactions {
  readonly stepId: string;
  readonly transactions: readonly TransactionRequest[];
  /** `prepared`: exactly the payload handed to the wallet; `planned`: the quote's transactions at plan time. */
  readonly origin: "prepared" | "planned";
  /** Prepare stage: the payload's quote binding. */
  readonly quoteBinding?: string;
  readonly approvalSpender?: string;
  readonly venueFees?: readonly PlannedVenueFee[];
}

export interface ApprovalCall {
  readonly token: string;
  readonly spender: string;
  readonly amount: bigint;
}

export interface EvmBlockPlan {
  readonly step: IntentStep;
  readonly source: StepTransactions;
  readonly owner: string;
  readonly calls: readonly SimulationCall[];
  readonly index: {
    readonly before: readonly { readonly token: string; readonly at: number }[];
    readonly transactions: readonly number[];
    readonly after: readonly { readonly token: string; readonly at: number }[];
    readonly allowances: readonly { readonly token: string; readonly spender: string; readonly at: number }[];
    readonly l1Fees: readonly number[];
  };
  /** The approvals the transactions grant (decoded `approve(address,uint256)` calls). */
  readonly approvals: readonly ApprovalCall[];
  /** Funds the block assumes (the funding parent's output, not in the wallet yet); null for real state. */
  readonly assumeFunds: { readonly asset: AssetRef; readonly amount: string } | null;
}

export interface EvmJob {
  readonly network: EvmNetworkKey;
  /** Lower-case address of the account that signs every block. */
  readonly owner: string;
  readonly blocks: readonly EvmBlockPlan[];
}

function evmTransactions(source: StepTransactions): EvmTransactionRequest[] | null {
  if (source.transactions.length === 0) return null;
  const evm = source.transactions.filter((transaction): transaction is EvmTransactionRequest => transaction.vm === "evm");
  return evm.length === source.transactions.length ? evm : null;
}

/** ERC-20 address of an asset id on an EVM network, or null (native / other VM). */
export function erc20Address(asset: string | undefined): string | null {
  const parsed = asset ? parseAssetId(asset) : null;
  return parsed && parsed.assetNamespace === "erc20" ? parsed.reference.toLowerCase() : null;
}

/** Decodes `approve(address,uint256)` calls among the transactions. */
export function approvalCalls(transactions: readonly EvmTransactionRequest[]): ApprovalCall[] {
  const out: ApprovalCall[] = [];
  for (const transaction of transactions) {
    const data = transaction.data.toLowerCase();
    if (!data.startsWith(APPROVE_SELECTOR) || data.length !== 10 + 128) continue;
    out.push({
      token: transaction.to.toLowerCase(),
      spender: `0x${data.slice(34, 74)}`,
      amount: BigInt(`0x${data.slice(74, 138)}`),
    });
  }
  return out;
}

/** Unsigned EIP-1559 serialization of a transaction (the bytes the OP-stack L1 fee is charged on). */
export function unsignedTransactionBytes(network: EvmNetworkKey, transaction: EvmTransactionRequest): Hex {
  return serializeTransaction({
    chainId: CHAINS[network].evmChainId as number,
    type: "eip1559",
    nonce: 1,
    to: getAddress(transaction.to),
    data: transaction.data as Hex,
    value: BigInt(transaction.value),
    gas: transaction.gas !== undefined && /^\d+$/u.test(transaction.gas) ? BigInt(transaction.gas) : 300_000n,
    maxFeePerGas: 1_000_000_000n,
    maxPriorityFeePerGas: 1_000_000n,
  });
}

function balanceRead(owner: string, token: string): SimulationCall {
  return { from: owner, to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [getAddress(owner)] }) };
}

/** Tokens whose balance the block reads before and after: the step's ERC-20 input and same-network ERC-20 output. */
function readTokens(step: IntentStep): string[] {
  const tokens: string[] = [];
  const input = erc20Address(step.input?.asset);
  if (input && step.kind !== "withdraw") tokens.push(input);
  const sameNetwork = !step.settlement || step.settlement.kind !== "cross-network";
  const outputAsset = (step.minimumOutput ?? step.expectedOutput)?.asset;
  const output = sameNetwork && outputAsset && parseAssetId(outputAsset)?.chain.key === step.network ? erc20Address(outputAsset) : null;
  if (output && !tokens.includes(output)) tokens.push(output);
  if (step.kind === "withdraw") {
    const underlying = erc20Address(step.input?.asset);
    if (underlying && !tokens.includes(underlying)) tokens.push(underlying);
  }
  return tokens;
}

/** Builds one block's calls (pure). */
export function planBlock(
  network: EvmNetworkKey,
  step: IntentStep,
  source: StepTransactions,
  owner: string,
  assumeFunds: EvmBlockPlan["assumeFunds"],
): EvmBlockPlan | null {
  const transactions = evmTransactions(source);
  if (!transactions) return null;
  const calls: SimulationCall[] = [];
  const push = (call: SimulationCall) => {
    calls.push(call);
    return calls.length - 1;
  };
  const tokens = readTokens(step);
  const before = tokens.map((token) => ({ token, at: push(balanceRead(owner, token)) }));
  const txIndexes = transactions.map((transaction) => push({
    from: transaction.from,
    to: transaction.to,
    data: transaction.data,
    value: BigInt(transaction.value),
  }));
  const after = tokens.map((token) => ({ token, at: push(balanceRead(owner, token)) }));
  const approvals = approvalCalls(transactions);
  const spenders = new Map<string, { token: string; spender: string }>();
  for (const approval of approvals) spenders.set(`${approval.token}:${approval.spender}`, approval);
  if (source.approvalSpender) {
    const input = erc20Address(step.input?.asset);
    if (input) spenders.set(`${input}:${source.approvalSpender.toLowerCase()}`, { token: input, spender: source.approvalSpender.toLowerCase() });
  }
  const allowances = [...spenders.values()].map(({ token, spender }) => ({
    token,
    spender,
    at: push({ from: owner, to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "allowance", args: [getAddress(owner), getAddress(spender)] }) }),
  }));
  const l1Fees = OP_STACK_NETWORKS.includes(network)
    ? transactions.map((transaction) => push({
        from: owner,
        to: GAS_PRICE_ORACLE,
        data: encodeFunctionData({ abi: GAS_PRICE_ORACLE_ABI, functionName: "getL1Fee", args: [unsignedTransactionBytes(network, transaction)] }),
      }))
    : [];
  return {
    step,
    source,
    owner,
    calls,
    index: { before, transactions: txIndexes, after, allowances, l1Fees },
    approvals,
    assumeFunds,
  };
}

function fundingParents(graph: IntentGraph, step: IntentStep): IntentStep[] {
  return graph.edges
    .filter((edge) => edge.to === step.id && edge.kind === "funds")
    .map((edge) => graph.steps.find((candidate) => candidate.id === edge.from))
    .filter((parent): parent is IntentStep => parent !== undefined);
}

/**
 * Groups the EVM steps that have transactions into network jobs (design §5.2).
 * `sources` maps step ids to their transactions; steps without one are not
 * simulated (they are quoted).
 */
export function buildEvmJobs(graph: IntentGraph, sources: ReadonlyMap<string, StepTransactions>, stage: PreviewStage): EvmJob[] {
  const jobs: { network: EvmNetworkKey; owner: string; blocks: EvmBlockPlan[] }[] = [];
  for (const step of graph.steps) {
    const source = sources.get(step.id);
    if (!source || !isEvmNetwork(step.network)) continue;
    const network: EvmNetworkKey = step.network;
    const account = parseAccountId(step.account);
    if (!account) continue;
    const owner = account.address.toLowerCase();
    const parents = fundingParents(graph, step);
    const inJob = (job: (typeof jobs)[number], parent: IntentStep) => job.blocks.some((block) => block.step.id === parent.id);
    let job = [...jobs].reverse().find((candidate) => candidate.network === network && candidate.owner === owner);
    const callsOf = (candidate: (typeof jobs)[number]) => candidate.blocks.reduce((total, block) => total + block.calls.length, 0);
    const joinable = job !== undefined &&
      job.blocks.length < MAX_JOB_BLOCKS &&
      parents.every((parent) => inJob(job as (typeof jobs)[number], parent) || parent.network !== network);
    const assumed = (target: (typeof jobs)[number] | undefined) => {
      if (stage === "prepare") return null;
      const outside = parents.find((parent) => !(target && inJob(target, parent)) && !isStepDone(parent));
      if (!outside || !step.input) return null;
      return { asset: { asset: step.input.asset, symbol: step.input.symbol, decimals: step.input.decimals }, amount: step.input.amount };
    };
    let block = joinable ? planBlock(network, step, source, owner, assumed(job)) : null;
    if (block && job && callsOf(job) + block.calls.length > MAX_JOB_CALLS) block = null;
    if (!block || !job || !joinable) {
      job = { network, owner, blocks: [] };
      block = planBlock(network, step, source, owner, assumed(job));
      if (!block || block.calls.length > MAX_JOB_CALLS) continue;
      jobs.push(job);
    }
    job.blocks.push(block);
  }
  return jobs.filter((job) => job.blocks.length > 0);
}
