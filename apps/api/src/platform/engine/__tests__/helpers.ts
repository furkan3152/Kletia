/**
 * Test seam for the engine: deterministic, offline protocol adapters that
 * plan with a fixed price table and prepare structurally valid payloads
 * (EVM calls from the step account, real unsigned v0 Solana transactions
 * fee-paid by the step account). Verification and settlement outcomes are
 * scripted per test through `stub`.
 */
import { randomBytes } from "node:crypto";
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  blockhash,
  compileTransaction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import {
  applySlippage,
  CHAINS,
  formatAssetId,
  type IntentStep,
  type NetworkKey,
  type StepEvidence,
  type TransactionRequest,
} from "@kletia/core";
import { configurePlatform } from "../service.js";
import { MemoryIntentStore } from "../store.js";
import { assetAmount, sameAsset, type ResolvedAsset } from "../assets.js";
import type {
  AdapterAction,
  PlannedStep,
  PreparedPayload,
  ProtocolAdapter,
  SettlementResult,
  VerificationResult,
  VerifyContext,
} from "../adapters/types.js";

export const EVM_ADDRESS = "0x4f183e308f24c81c05303821AD025812fBFd807D";
export const OTHER_EVM_ADDRESS = "0x1111111111111111111111111111111111111111";
export const SOL_ADDRESS = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
export const OTHER_SOL_ADDRESS = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";
export const EVM_ACCOUNT = `eip155:8453:${EVM_ADDRESS}`;
export const SOL_ACCOUNT = `solana:${CHAINS.solana.reference}:${SOL_ADDRESS}`;
export const ACCOUNTS = [EVM_ACCOUNT, SOL_ACCOUNT];

export const JUPITER_PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
export const RELAY_SOLANA_PROGRAM = "99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2";
export const RELAY_EVM_TARGET = "0xa5F565650890fBA1824Ee0F21EbBbF660a179934";
export const AAVE_POOL = "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5";

/** USD prices in cents per whole token, by symbol. */
const PRICES: Readonly<Record<string, bigint>> = {
  SOL: 15_000n,
  USDC: 100n,
  USDT: 100n,
  JITOSOL: 18_000n,
  MSOL: 17_500n,
  JUPSOL: 16_000n,
  ETH: 300_000n,
  WETH: 300_000n,
  CBBTC: 6_000_000n,
};

function rate(action: Pick<AdapterAction, "input" | "output" | "amount">): string {
  const inPrice = PRICES[action.input.symbol.toUpperCase()] ?? 100n;
  const outPrice = PRICES[action.output.symbol.toUpperCase()] ?? 100n;
  const out = (BigInt(action.amount) * inPrice * 10n ** BigInt(action.output.decimals)) /
    (outPrice * 10n ** BigInt(action.input.decimals));
  return out.toString();
}

export function randomRequestId(): string {
  return `0x${randomBytes(32).toString("hex")}`;
}

export function randomEvmHash(): string {
  return `0x${randomBytes(32).toString("hex")}`;
}

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function randomSolanaSignature(): string {
  // 64 random bytes in base58 are 86-88 characters; any 64-byte value is a valid signature shape.
  let value = BigInt(`0x${randomBytes(64).toString("hex")}`) | (1n << 504n);
  let out = "";
  while (value > 0n) {
    out = BASE58[Number(value % 58n)] + out;
    value /= 58n;
  }
  return out;
}

/** A real unsigned v0 wire transaction invoking `program`, fee-paid by `feePayer`. */
export function unsignedSolanaTransaction(feePayer: string, program: string, extraSigner?: string): string {
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (draft) => setTransactionMessageFeePayer(address(feePayer), draft),
    (draft) => setTransactionMessageLifetimeUsingBlockhash(
      { blockhash: blockhash("11111111111111111111111111111111"), lastValidBlockHeight: 1_000n },
      draft,
    ),
    (draft) => appendTransactionMessageInstructions(
      [
        {
          programAddress: address(program),
          accounts: extraSigner ? [{ address: address(extraSigner), role: AccountRole.READONLY_SIGNER }] : [],
          data: new Uint8Array([1, 2, 3]),
        },
      ],
      draft,
    ),
  );
  return getBase64EncodedWireTransaction(compileTransaction(message));
}

export interface StubControls {
  /** Scripted verification; default confirms with one receipt per reference. */
  verify: (context: VerifyContext) => VerificationResult | Promise<VerificationResult>;
  /** Scripted settlement; default settles with the minimum output. */
  poll: (step: IntentStep) => SettlementResult | Promise<SettlementResult>;
  /** Mutates a prepared payload before it is returned (adversarial adapters). */
  tamper: (payload: PreparedPayload, action: AdapterAction) => PreparedPayload;
  /** Number of EVM transactions Relay asks for (approve + deposit = 2). */
  relayEvmTransactions: number;
  /** Fee reported by every planned step, in USD. */
  feeUsd: number;
  calls: { verify: number; poll: number; prepare: number };
}

function defaultControls(): StubControls {
  return {
    verify: (context) => ({
      status: "confirmed",
      evidence: context.references.map((reference): StepEvidence => ({
        kind: context.step.chain.startsWith("eip155:") ? "receipt" : "transaction",
        network: context.step.network,
        reference,
        observedAt: new Date(context.now).toISOString(),
        detail: "stub confirmed",
      })),
    }),
    poll: (step) => ({
      status: "settled",
      evidence: [
        {
          kind: "settlement",
          network: step.settlement?.destinationNetwork ?? step.network,
          reference: "stub-fill",
          observedAt: new Date().toISOString(),
          detail: "stub settled",
        },
      ],
      ...(step.minimumOutput ? { actualOutput: step.minimumOutput } : {}),
    }),
    tamper: (payload) => payload,
    relayEvmTransactions: 2,
    feeUsd: 0.05,
    calls: { verify: 0, poll: 0, prepare: 0 },
  };
}

export const stub: StubControls = defaultControls();

function planned(action: AdapterAction, protocol: PlannedStep["protocol"], output: ResolvedAsset, outUnits: string, extra: Partial<PlannedStep> = {}): PlannedStep {
  const minimum = applySlippage(outUnits, action.slippageBps);
  const cross = action.network !== action.destinationNetwork;
  return {
    protocol,
    title: `${protocol} ${action.kind} ${action.input.symbol}->${output.symbol}`,
    mode: "wallet",
    input: assetAmount(action.input, action.amount),
    expectedOutput: assetAmount(output, outUnits),
    minimumOutput: assetAmount(output, minimum),
    feesUsd: stub.feeUsd,
    estimatedSeconds: cross ? 30 : 10,
    settlement: cross ? { kind: "cross-network", destinationNetwork: action.destinationNetwork, expectedSeconds: 20 } : { kind: "same-network" },
    warnings: [],
    transactionCount: 1,
    slippageBps: action.slippageBps,
    ...extra,
  };
}

function prepared(action: AdapterAction, plan: PlannedStep, transactions: TransactionRequest[], programOrTarget: string[], trackingId?: string): PreparedPayload {
  const payload: PreparedPayload = {
    transactions,
    records: transactions.map((transaction, index) =>
      transaction.vm === "evm"
        ? { vm: "evm" as const, network: transaction.network, to: transaction.to, description: transaction.description }
        : { vm: "svm" as const, network: transaction.network, feePayer: transaction.feePayer, to: programOrTarget[index] as string, description: transaction.description }),
    input: plan.input,
    expectedOutput: plan.expectedOutput,
    minimumOutput: plan.minimumOutput,
    ...(plan.feesUsd !== undefined ? { feesUsd: plan.feesUsd } : {}),
    ...(trackingId ? { trackingId, quoteId: trackingId } : {}),
    warnings: [],
  };
  stub.calls.prepare += 1;
  return stub.tamper(payload, action);
}

function solanaPayload(action: AdapterAction, program: string): TransactionRequest {
  return {
    vm: "svm",
    network: action.network,
    feePayer: action.account.address,
    transaction: unsignedSolanaTransaction(action.account.address, program),
    encoding: "base64",
    lastValidBlockHeight: 1_000,
    description: `stub ${action.kind}`,
  };
}

function evmPayload(action: AdapterAction, to: string, data: string, value: string): TransactionRequest {
  return {
    vm: "evm",
    network: action.network,
    chainId: CHAINS[action.network].evmChainId as number,
    from: action.account.address,
    to,
    data,
    value,
    description: `stub ${action.kind}`,
  };
}

const verify = async (context: VerifyContext) => {
  stub.calls.verify += 1;
  return stub.verify(context);
};

const poll = async (step: IntentStep) => {
  stub.calls.poll += 1;
  return stub.poll(step);
};

export const stubJupiter: ProtocolAdapter = {
  id: "jupiter",
  protocols: ["jupiter"],
  label: "Stub Jupiter",
  supports: (route) => route.network === "solana" && route.destinationNetwork === "solana" &&
    (route.kind === "swap" || route.kind === "stake") && !sameAsset(route.input, route.output),
  plan: async (action) => planned(action, "jupiter", action.output, rate(action)),
  prepare: async ({ action }) => {
    const plan = planned(action, "jupiter", action.output, rate(action));
    return prepared(action, plan, [solanaPayload(action, JUPITER_PROGRAM)], [JUPITER_PROGRAM]);
  },
  verify,
};

const RELAY_NETWORKS: readonly NetworkKey[] = ["base", "arbitrum", "solana"];

export const stubRelay: ProtocolAdapter = {
  id: "relay",
  protocols: ["relay"],
  label: "Stub Relay",
  supports: (route) => RELAY_NETWORKS.includes(route.network) && RELAY_NETWORKS.includes(route.destinationNetwork) &&
    (route.kind === "bridge" ? route.network !== route.destinationNetwork
      : route.kind === "swap" && route.network === route.destinationNetwork && route.network !== "solana" && !sameAsset(route.input, route.output)),
  plan: async (action) => planned(action, "relay", action.output, rate(action), {
    quoteId: randomRequestId(),
    transactionCount: action.network === "solana" ? 1 : stub.relayEvmTransactions,
  }),
  prepare: async ({ action }) => {
    const plan = planned(action, "relay", action.output, rate(action));
    const requestId = randomRequestId();
    if (action.network === "solana") {
      return prepared(action, plan, [solanaPayload(action, RELAY_SOLANA_PROGRAM)], [RELAY_SOLANA_PROGRAM], action.network !== action.destinationNetwork ? requestId : undefined);
    }
    const deposit = evmPayload(action, RELAY_EVM_TARGET, `0x${requestId.slice(2)}`, action.input.isNative ? action.amount : "0");
    const transactions = stub.relayEvmTransactions === 2 && !action.input.isNative
      ? [evmPayload(action, action.input.address as string, "0x095ea7b3", "0"), deposit]
      : [deposit];
    return prepared(action, plan, transactions, [], action.network !== action.destinationNetwork ? requestId : undefined);
  },
  verify,
  poll,
};

export const stubEvmTransfer: ProtocolAdapter = {
  id: "erc20-transfer",
  protocols: ["erc20-transfer", "system-transfer"],
  label: "Stub EVM transfer",
  supports: (route) => route.kind === "transfer" && CHAINS[route.network].vm === "evm" && route.network === route.destinationNetwork,
  plan: async (action) => planned(action, action.input.isNative ? "system-transfer" : "erc20-transfer", action.input, action.amount),
  prepare: async ({ action }) => {
    const plan = planned(action, "erc20-transfer", action.input, action.amount);
    const transaction = action.input.isNative
      ? evmPayload(action, action.recipient.address, "0x", action.amount)
      : evmPayload(action, action.input.address as string, "0xa9059cbb", "0");
    return prepared(action, plan, [transaction], []);
  },
  verify,
};

export const stubSolanaTransfer: ProtocolAdapter = {
  id: "spl-token",
  protocols: ["spl-token", "system-transfer"],
  label: "Stub Solana transfer",
  supports: (route) => route.kind === "transfer" && CHAINS[route.network].vm === "svm" && route.network === route.destinationNetwork,
  plan: async (action) => planned(action, action.input.isNative ? "system-transfer" : "spl-token", action.input, action.amount),
  prepare: async ({ action }) => {
    const plan = planned(action, "spl-token", action.input, action.amount);
    const program = action.input.isNative ? "11111111111111111111111111111111" : "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
    return prepared(action, plan, [solanaPayload(action, program)], [program]);
  },
  verify,
};

const A_TOKEN = "0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB";

export const stubAave: ProtocolAdapter = {
  id: "aave-v3",
  protocols: ["aave-v3"],
  label: "Stub Aave",
  supports: (route) => route.kind === "deposit" && (route.network === "base" || route.network === "arbitrum"),
  plan: async (action) => {
    const position: ResolvedAsset = {
      ...action.input,
      id: formatAssetId(action.network, "erc20", A_TOKEN),
      symbol: `a${action.input.symbol}`,
      address: A_TOKEN,
      canonical: false,
    };
    return planned(action, "aave-v3", position, action.amount);
  },
  prepare: async ({ action }) => {
    const plan = await stubAave.plan(action);
    return prepared(action, plan, [evmPayload(action, AAVE_POOL, "0x617ba037", "0")], []);
  },
  verify,
};

export const STUB_ADAPTERS: readonly ProtocolAdapter[] = [stubJupiter, stubSolanaTransfer, stubEvmTransfer, stubRelay, stubAave];

/** Fresh in-memory store, stub adapters and default scripted outcomes. */
export function resetEngine(): MemoryIntentStore {
  Object.assign(stub, defaultControls());
  const store = new MemoryIntentStore();
  configurePlatform({ store, adapters: STUB_ADAPTERS });
  return store;
}
