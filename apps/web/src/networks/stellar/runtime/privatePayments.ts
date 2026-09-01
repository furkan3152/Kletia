import {
  getNetworkDetails,
  requestAccess,
} from "@stellar/freighter-api";
import { Networks, StrKey } from "@stellar/stellar-sdk";

const STELLAR_RPC_URL = "https://soroban-testnet.stellar.org";
const NETHERMIND_BOOTNODE_URL = "https://bootnode.dev-nethermind.xyz";
export const SPP_XLM_POOL =
  "CAWCZ6EO4PM5EZOH5K7XSW3R46DGLOT3XSEH36OA5EOZUSJ5XS7BX6XI";

export type PrivatePaymentsOperation =
  | "deposit"
  | "private_transfer"
  | "withdraw";

export type LocalShieldedIntentResolution =
  | {
      readonly status: "resolved";
      readonly operation: PrivatePaymentsOperation;
      readonly amount: string;
      readonly recipient?: string;
      readonly explanation: string;
    }
  | {
      readonly status: "clarification";
      readonly question: string;
      readonly missing: readonly ("operation" | "amount" | "recipient")[];
    };

export interface PrivatePaymentsBrowserCapability {
  readonly capability: "webassembly" | "worker" | "web_crypto" | "opfs";
  readonly ready: boolean;
  readonly detail: string;
}

export interface PrivatePaymentsBrowserReport {
  readonly ready: boolean;
  readonly capabilities: readonly PrivatePaymentsBrowserCapability[];
  readonly limitations: readonly string[];
}

interface SppStorage {
  fork(): SppStorage;
}

interface SppPool {
  balance(): Promise<bigint>;
  notes(): Promise<unknown>;
  deposit(amount: bigint): Promise<unknown>;
  transfer(recipient: string, amount: bigint): Promise<unknown>;
  withdraw(amount: bigint, recipient?: string | null): Promise<unknown>;
}

interface SppAccount {
  readonly userAddress: string;
  isRegistered(): Promise<boolean>;
  registerPublicKeys(): Promise<string>;
  pool(options: { poolContract: string }): Promise<SppPool>;
}

interface SppClient {
  backgroundSync(): Promise<void>;
  stopBackgroundSync(): void;
  sync(): Promise<void>;
  account(
    options: { networkPassphrase: string; userAddress: string },
    signer: unknown,
  ): Promise<SppAccount>;
}

interface SppSdk {
  default(): Promise<unknown>;
  Storage: { open(options?: { workerUrl?: string }): Promise<SppStorage> };
  Client: {
    new: (options: {
      rpcUrl: string;
      storage: SppStorage;
      bootnodeUrl?: string;
      proverWorkerUrl?: string;
    }) => Promise<SppClient>;
  };
  bootnodeRequired(rpcUrl: string, storage: SppStorage): Promise<boolean>;
  configureTelemetry?: (config: {
    level: "info";
    sink: "ringBuffer";
    revealSensitive: false;
  }) => void;
}

interface SppSignerModule {
  FreighterSigner: new () => unknown;
}

export interface PrivatePaymentsSession {
  readonly address: string;
  readonly poolContract: string;
  readonly registrationPublic: boolean;
  readonly archiveUsed: boolean;
  balance(): Promise<bigint>;
  noteCount(): Promise<number>;
  registerPublicKeys(): Promise<string>;
  execute(operation: PrivatePaymentsOperation, amount: bigint, recipient?: string): Promise<{
    readonly references: readonly string[];
    readonly rawResultAvailable: boolean;
  }>;
  refresh(): Promise<{ balance: bigint; noteCount: number }>;
  close(): void;
}

export class PrivatePaymentsArchiveConsentRequiredError extends Error {
  readonly code = "SPP_ARCHIVE_CONSENT_REQUIRED";

  constructor() {
    super(
      "The public Stellar RPC no longer retains the complete pool history. Explicit consent to the Nethermind archive is required before recovery or spending can continue.",
    );
    this.name = "PrivatePaymentsArchiveConsentRequiredError";
  }
}

function browserCapabilityReport(): PrivatePaymentsBrowserReport {
  const capabilities: readonly PrivatePaymentsBrowserCapability[] = [
    {
      capability: "webassembly",
      ready: typeof WebAssembly === "object",
      detail: "The proof runtime requires WebAssembly.",
    },
    {
      capability: "worker",
      ready: typeof Worker === "function",
      detail: "Proof generation and local indexing run in dedicated workers.",
    },
    {
      capability: "web_crypto",
      ready:
        typeof globalThis.crypto?.getRandomValues === "function" &&
        typeof globalThis.crypto?.subtle?.digest === "function",
      detail: "Key derivation and local cryptographic state require Web Crypto.",
    },
    {
      capability: "opfs",
      ready:
        typeof navigator !== "undefined" &&
        typeof navigator.storage?.getDirectory === "function",
      detail: "The private note index is persisted in browser OPFS.",
    },
  ];
  return {
    ready: capabilities.every((entry) => entry.ready),
    capabilities,
    limitations: [
      "The upstream implementation is an unaudited Testnet research alpha.",
      "Deposits and withdrawals remain public, including amount and public address.",
      "A Stellar transaction submitter or authorization address and timing can remain observable.",
      "A third-party archive can omit or forge historical events; regenerated local state is checked against the live pool root before spending.",
    ],
  };
}

export function readPrivatePaymentsBrowserReport(): PrivatePaymentsBrowserReport {
  return browserCapabilityReport();
}

function parseAmountAtomic(input: string): bigint {
  const normalized = input.trim();
  if (!/^(?:\d+\.?\d*|\.\d+)$/u.test(normalized)) {
    throw new Error("Enter a positive XLM amount with at most seven decimals.");
  }
  const [whole = "0", fraction = ""] = normalized.split(".");
  if (fraction.length > 7) {
    throw new Error("XLM supports at most seven decimal places.");
  }
  const atomic = BigInt(`${whole || "0"}${fraction.padEnd(7, "0")}`);
  if (atomic <= 0n) throw new Error("Amount must be greater than zero.");
  return atomic;
}

export function privatePaymentsAmountAtomic(input: string): bigint {
  return parseAmountAtomic(input);
}

/**
 * Compile the deliberately small shielded-payment grammar entirely in the
 * browser. The text, amount and recipient never cross the Kletia API or an LLM
 * boundary. This is intentionally not an open-ended AI parser: the only
 * operations the reviewed upstream pool can execute are deposit, private
 * transfer and public withdrawal, so ambiguity must become a local question.
 */
export function compileLocalShieldedIntent(
  input: string,
): LocalShieldedIntentResolution {
  const goal = input.normalize("NFKC").trim();
  const operationEvidence: Array<{
    operation: PrivatePaymentsOperation;
    pattern: RegExp;
  }> = [
    {
      operation: "deposit",
      pattern:
        /\b(?:deposit|shield|fund|move\s+into\s+(?:my\s+)?shielded)\b/iu,
    },
    {
      operation: "private_transfer",
      pattern:
        /\b(?:privately\s+send|private\s+transfer|shielded\s+(?:send|transfer))\b/iu,
    },
    {
      operation: "withdraw",
      pattern: /\b(?:withdraw|unshield|move\s+out\s+of\s+(?:my\s+)?shielded)\b/iu,
    },
  ];
  const operations = operationEvidence
    .filter((entry) => entry.pattern.test(goal))
    .map((entry) => entry.operation);
  const uniqueOperations = [...new Set(operations)];
  const amountMatches = [
    ...goal.matchAll(/(?:^|\s)(\d+(?:[.,]\d{1,7})?|[.,]\d{1,7})\s*XLM\b/giu),
  ].map((match) => match[1].replace(",", "."));
  const uniqueAmounts = [...new Set(amountMatches)];
  const recipientMatches = [
    ...goal.matchAll(/\bG[A-Z2-7]{55}\b/gu),
  ].map((match) => match[0]);
  const uniqueRecipients = [...new Set(recipientMatches)];
  const missing: Array<"operation" | "amount" | "recipient"> = [];

  if (uniqueOperations.length !== 1) missing.push("operation");
  if (uniqueAmounts.length !== 1) missing.push("amount");
  if (
    uniqueOperations[0] === "private_transfer" &&
    uniqueRecipients.length !== 1
  ) {
    missing.push("recipient");
  }
  if (uniqueRecipients.length > 1 && !missing.includes("recipient")) {
    missing.push("recipient");
  }
  if (missing.length > 0) {
    return {
      status: "clarification",
      missing,
      question:
        uniqueOperations.length > 1 || uniqueAmounts.length > 1 || uniqueRecipients.length > 1
          ? "The local instruction contains conflicting operations, amounts, or recipients. Keep exactly one of each required value."
          : `Add the missing ${missing.join(", ")} in this private form. Example: “Privately send 0.1 XLM to G…”.`,
    };
  }

  const operation = uniqueOperations[0];
  const amount = uniqueAmounts[0];
  parseAmountAtomic(amount);
  const recipient = uniqueRecipients[0];
  return {
    status: "resolved",
    operation,
    amount,
    ...(recipient ? { recipient } : {}),
    explanation:
      operation === "private_transfer"
        ? "The amount and recipient-output link are proved inside the shielded pool; the pool interaction and authorization timing remain observable."
        : "This operation crosses the public/shielded boundary, so its amount and public Stellar account remain visible onchain.",
  };
}

function extractReferences(value: unknown, output = new Set<string>()): Set<string> {
  if (typeof value === "string" && /^[a-f0-9]{64}$/iu.test(value)) {
    output.add(value.toLowerCase());
    return output;
  }
  if (Array.isArray(value)) {
    value.forEach((entry) => extractReferences(entry, output));
    return output;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (/^(?:hash|txHash|transactionHash)$/iu.test(key)) {
        extractReferences(entry, output);
      } else if (entry && typeof entry === "object") {
        extractReferences(entry, output);
      }
    }
  }
  return output;
}

async function assertFreighterBinding(expectedAddress: string): Promise<void> {
  const [access, network] = await Promise.all([requestAccess(), getNetworkDetails()]);
  if (
    access.error ||
    !StrKey.isValidEd25519PublicKey(access.address) ||
    access.address !== expectedAddress
  ) {
    throw new Error("The active Freighter account no longer matches this shielded session.");
  }
  if (network.error || network.networkPassphrase !== Networks.TESTNET) {
    throw new Error("Switch Freighter to Stellar Testnet before continuing.");
  }
}

async function noteCount(pool: SppPool): Promise<number> {
  const notes = await pool.notes();
  return Array.isArray(notes) ? notes.length : 0;
}

export async function openPrivatePaymentsSession(input: {
  readonly expectedAddress: string;
  readonly archiveConsent: boolean;
}): Promise<PrivatePaymentsSession> {
  const browser = browserCapabilityReport();
  if (!browser.ready) {
    throw new Error(
      `This browser cannot run the shielded proof surface: ${browser.capabilities
        .filter((entry) => !entry.ready)
        .map((entry) => entry.capability)
        .join(", ")}.`,
    );
  }
  if (!StrKey.isValidEd25519PublicKey(input.expectedAddress)) {
    throw new Error("Connect a valid Stellar Testnet account first.");
  }
  await assertFreighterBinding(input.expectedAddress);

  const [sdkModule, signerModule] = await Promise.all([
    import("stellar-private-payments"),
    import("stellar-private-payments/freighter"),
  ]);
  const sdk = sdkModule as unknown as SppSdk;
  const signers = signerModule as unknown as SppSignerModule;
  await sdk.default();
  sdk.configureTelemetry?.({
    level: "info",
    sink: "ringBuffer",
    revealSensitive: false,
  });

  const vendorBase = `${window.location.origin}/vendor/stellar-private-payments/dist`;
  const storage = await sdk.Storage.open({
    workerUrl: `${vendorBase}/workers/storage-worker.js`,
  });
  const archiveRequired = await sdk.bootnodeRequired(STELLAR_RPC_URL, storage);
  if (archiveRequired && !input.archiveConsent) {
    throw new PrivatePaymentsArchiveConsentRequiredError();
  }
  const client = await sdk.Client.new({
    rpcUrl: STELLAR_RPC_URL,
    storage,
    proverWorkerUrl: `${vendorBase}/workers/prover-worker.js`,
    ...(archiveRequired ? { bootnodeUrl: NETHERMIND_BOOTNODE_URL } : {}),
  });
  await client.backgroundSync();
  const signer = new signers.FreighterSigner();
  const account = await client.account(
    {
      networkPassphrase: Networks.TESTNET,
      userAddress: input.expectedAddress,
    },
    signer,
  );
  if (account.userAddress !== input.expectedAddress) {
    client.stopBackgroundSync();
    throw new Error("The SPP account binding did not match the connected wallet.");
  }
  const pool = await account.pool({ poolContract: SPP_XLM_POOL });
  await client.sync();

  let registrationPublic = await account.isRegistered();
  return {
    address: input.expectedAddress,
    poolContract: SPP_XLM_POOL,
    get registrationPublic() {
      return registrationPublic;
    },
    archiveUsed: archiveRequired,
    balance: () => pool.balance(),
    noteCount: () => noteCount(pool),
    registerPublicKeys: async () => {
      await assertFreighterBinding(input.expectedAddress);
      const reference = await account.registerPublicKeys();
      registrationPublic = true;
      return reference;
    },
    execute: async (operation, amount, recipient) => {
      await assertFreighterBinding(input.expectedAddress);
      let result: unknown;
      if (operation === "deposit") {
        result = await pool.deposit(amount);
      } else if (operation === "private_transfer") {
        if (!recipient || !StrKey.isValidEd25519PublicKey(recipient)) {
          throw new Error("A valid registered Stellar recipient is required.");
        }
        result = await pool.transfer(recipient, amount);
      } else {
        if (recipient && !StrKey.isValidEd25519PublicKey(recipient)) {
          throw new Error("Withdraw to a valid Stellar account.");
        }
        result = await pool.withdraw(amount, recipient || null);
      }
      return {
        references: [...extractReferences(result)],
        rawResultAvailable: result !== null && result !== undefined,
      };
    },
    refresh: async () => {
      await client.sync();
      return {
        balance: await pool.balance(),
        noteCount: await noteCount(pool),
      };
    },
    close: () => client.stopBackgroundSync(),
  };
}
