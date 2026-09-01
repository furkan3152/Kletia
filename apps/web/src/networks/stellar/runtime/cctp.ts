import {
  Address as StellarAddress,
  Contract,
  Networks,
  StrKey,
  Transaction,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import {
  encodeFunctionData,
  erc20Abi,
  pad,
  parseUnits,
  toHex,
  zeroHash,
  type Address,
  type Hex,
} from "viem";

import type { StellarRouteKind } from "../../../cross-chain/v2/types";

export const TESTNET_CCTP = Object.freeze({
  arc: {
    chainId: 5_042_002,
    domain: 26,
    usdc: "0x3600000000000000000000000000000000000000" as Address,
    tokenMessenger: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA" as Address,
  },
  stellar: {
    domain: 27,
    rpcUrl: "https://soroban-testnet.stellar.org",
    usdcSac: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    tokenMessengerMinter: "CDNG7HXAPBWICI2E3AUBP3YZWZELJLYSB6F5CC7WLDTLTHVM74SLRTHP",
    forwarder: "CA66Q2WFBND6V4UEB7RD4SAXSVIWMD6RA4X3U32ELVFGXV5PJK4T4VSZ",
  },
  arbitrumSepolia: {
    chainId: 421_614,
    domain: 3,
    usdc: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d" as Address,
    messageTransmitter: "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275" as Address,
  },
});

const TOKEN_MESSENGER_ABI = [
  {
    type: "function",
    name: "depositForBurn",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "destinationDomain", type: "uint32" },
      { name: "mintRecipient", type: "bytes32" },
      { name: "burnToken", type: "address" },
      { name: "destinationCaller", type: "bytes32" },
      { name: "maxFee", type: "uint256" },
      { name: "minFinalityThreshold", type: "uint32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "depositForBurnWithHook",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "destinationDomain", type: "uint32" },
      { name: "mintRecipient", type: "bytes32" },
      { name: "burnToken", type: "address" },
      { name: "destinationCaller", type: "bytes32" },
      { name: "maxFee", type: "uint256" },
      { name: "minFinalityThreshold", type: "uint32" },
      { name: "hookData", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

const MESSAGE_TRANSMITTER_ABI = [
  {
    type: "function",
    name: "receiveMessage",
    stateMutability: "nonpayable",
    inputs: [
      { name: "message", type: "bytes" },
      { name: "attestation", type: "bytes" },
    ],
    outputs: [{ name: "success", type: "bool" }],
  },
] as const;

export interface BrowserTransactionCall {
  target: Address;
  calldata: Hex;
  value: 0n;
}

const MAX_STELLAR_TRANSACTION_FEE_STROOPS = 10_000_000n;
const MIN_STELLAR_INCLUSION_FEE_STROOPS = 100n;

export class StellarTransactionIndeterminateError extends Error {
  readonly transactionHash: string;

  constructor(transactionHash: string) {
    super("Stellar transaction result is indeterminate; recover its status without resubmitting.");
    this.name = "StellarTransactionIndeterminateError";
    this.transactionHash = transactionHash;
  }
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function u32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
}

function decodeHex(value: Hex): Uint8Array {
  const normalized = value.slice(2);
  const bytes = new Uint8Array(normalized.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(normalized.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

export function buildCctpForwarderHookData(stellarRecipient: string): Hex {
  const valid =
    StrKey.isValidEd25519PublicKey(stellarRecipient) ||
    StrKey.isValidContract(stellarRecipient) ||
    StrKey.isValidMed25519PublicKey(stellarRecipient);
  if (!valid) throw new Error("CCTP forward recipient must be a valid Stellar strkey.");
  const recipient = new TextEncoder().encode(stellarRecipient);
  return toHex(concatBytes(new Uint8Array(24), u32(0), u32(recipient.length), recipient));
}

export function stellarContractToBytes32(contractId: string): Hex {
  if (!StrKey.isValidContract(contractId)) {
    throw new Error("The Stellar CCTP Forwarder contract ID is invalid.");
  }
  return toHex(new Uint8Array(StrKey.decodeContract(contractId)), { size: 32 });
}

export function maxStandardCctpFee(
  amountAtomic: bigint,
  standardFeeBps: number,
): bigint {
  if (!Number.isFinite(standardFeeBps) || standardFeeBps < 0 || standardFeeBps > 10_000) {
    throw new Error("Circle fee evidence is invalid.");
  }
  const feeHundredthBps = BigInt(Math.round(standardFeeBps * 100));
  const protocolFee =
    (amountAtomic * feeHundredthBps + 999_999n) / 1_000_000n;
  return (protocolFee * 120n + 99n) / 100n;
}

export function buildArcCctpApproval(amount: string): BrowserTransactionCall {
  const atomic = parseUnits(amount, 6);
  return {
    target: TESTNET_CCTP.arc.usdc,
    calldata: encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [TESTNET_CCTP.arc.tokenMessenger, atomic],
    }),
    value: 0n,
  };
}

export function buildArcCctpBurn(input: {
  amount: string;
  route: StellarRouteKind;
  stellarRecipient: string;
  arbitrumRecipient: Address;
  standardFeeBps: number;
}): BrowserTransactionCall {
  const atomic = parseUnits(input.amount, 6);
  const maxFee = maxStandardCctpFee(atomic, input.standardFeeBps);
  if (input.route === "direct_cctp") {
    return {
      target: TESTNET_CCTP.arc.tokenMessenger,
      calldata: encodeFunctionData({
        abi: TOKEN_MESSENGER_ABI,
        functionName: "depositForBurn",
        args: [
          atomic,
          TESTNET_CCTP.arbitrumSepolia.domain,
          pad(input.arbitrumRecipient, { size: 32 }),
          TESTNET_CCTP.arc.usdc,
          zeroHash,
          maxFee,
          2_000,
        ],
      }),
      value: 0n,
    };
  }
  const forwarder = stellarContractToBytes32(TESTNET_CCTP.stellar.forwarder);
  return {
    target: TESTNET_CCTP.arc.tokenMessenger,
    calldata: encodeFunctionData({
      abi: TOKEN_MESSENGER_ABI,
      functionName: "depositForBurnWithHook",
      args: [
        atomic,
        TESTNET_CCTP.stellar.domain,
        forwarder,
        TESTNET_CCTP.arc.usdc,
        forwarder,
        maxFee,
        2_000,
        buildCctpForwarderHookData(input.stellarRecipient),
      ],
    }),
    value: 0n,
  };
}

export function buildArbitrumCctpMint(
  message: Hex,
  attestation: Hex,
): BrowserTransactionCall {
  return {
    target: TESTNET_CCTP.arbitrumSepolia.messageTransmitter,
    calldata: encodeFunctionData({
      abi: MESSAGE_TRANSMITTER_ABI,
      functionName: "receiveMessage",
      args: [message, attestation],
    }),
    value: 0n,
  };
}

export function buildArbitrumAaveApproval(amountAtomic: bigint): BrowserTransactionCall {
  if (amountAtomic <= 0n) throw new Error("Aave approval amount is invalid.");
  return {
    target: TESTNET_CCTP.arbitrumSepolia.usdc,
    calldata: encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: ["0xBfC91D59fdAA134A4ED45f7B584cAf96D7792Eff", amountAtomic],
    }),
    value: 0n,
  };
}

export function buildArbitrumAaveSupply(
  amountAtomic: bigint,
  owner: Address,
): BrowserTransactionCall {
  if (amountAtomic <= 0n) throw new Error("Aave supply amount is invalid.");
  const pool = "0xBfC91D59fdAA134A4ED45f7B584cAf96D7792Eff" as Address;
  return {
    target: pool,
    calldata: encodeFunctionData({
      abi: [{
        type: "function",
        name: "supply",
        stateMutability: "nonpayable",
        inputs: [
          { name: "asset", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "onBehalfOf", type: "address" },
          { name: "referralCode", type: "uint16" },
        ],
        outputs: [],
      }] as const,
      functionName: "supply",
      args: [TESTNET_CCTP.arbitrumSepolia.usdc, amountAtomic, owner, 0],
    }),
    value: 0n,
  };
}

/**
 * js-xdr generated types expose base64 serialisation under slightly different
 * names across union and struct arms. Reading it structurally keeps the
 * fingerprint stable without silently accepting a value we cannot serialise.
 */
function xdrBase64(value: unknown, field: string): string {
  const candidate = value as {
    toXDR?: (format: "base64") => string;
    toXdr?: (format: "base64") => string;
  };
  if (typeof candidate?.toXDR === "function") return candidate.toXDR("base64");
  if (typeof candidate?.toXdr === "function") return candidate.toXdr("base64");
  throw new Error(
    `The Stellar ${field} could not be serialised, so the invocation could not be verified before signing.`,
  );
}

/**
 * Canonical fingerprint of the parts of a Soroban invocation that must not
 * change between the simulation a user reviewed and the transaction they sign:
 * the exact invoked contract, function and arguments, the full nested
 * authorization tree, and the declared ledger footprint.
 *
 * The transaction fee is deliberately excluded. Fee is separately capped and can
 * legitimately be re-derived between passes; treating it as an invocation change
 * would produce false rejections without adding an authorization guarantee.
 */
function sorobanInvocationFingerprint(transaction: Transaction): string {
  const [operation] = transaction.operations;
  if (transaction.operations.length !== 1 || operation?.type !== "invokeHostFunction") {
    throw new Error(
      "A Kletia Stellar contract call must be exactly one InvokeHostFunction operation.",
    );
  }
  const envelope = transaction.toEnvelope();
  if (envelope.type !== "envelopeTypeTx") {
    throw new Error(
      "A Kletia Stellar contract call must use a standard v1 transaction envelope.",
    );
  }
  const transactionExtension = envelope.value.tx.ext;
  if (transactionExtension.type !== "sorobanData") {
    throw new Error(
      "The simulated Stellar transaction is missing its Soroban resource footprint.",
    );
  }
  return JSON.stringify({
    hostFunction: xdrBase64(operation.func, "host function"),
    // Every nested require_auth context, in order. Adding, removing or
    // retargeting a nested call changes this value.
    auth: (operation.auth ?? []).map((entry, index) =>
      xdrBase64(entry, `authorization entry ${index}`),
    ),
    ledgerFootprint: xdrBase64(
      transactionExtension.sorobanData.resources.footprint,
      "Soroban ledger footprint",
    ),
  });
}

export async function prepareStellarContractCall(input: {
  source: string;
  contractId: string;
  method: string;
  args: xdr.ScVal[];
}): Promise<string> {
  const server = new rpc.Server(TESTNET_CCTP.stellar.rpcUrl);
  const [account, feeStats] = await Promise.all([
    server.getAccount(input.source),
    server.getFeeStats(),
  ]);
  const observedInclusionFee = BigInt(feeStats.sorobanInclusionFee.p95);
  const inclusionFee = observedInclusionFee > MIN_STELLAR_INCLUSION_FEE_STROOPS
    ? observedInclusionFee
    : MIN_STELLAR_INCLUSION_FEE_STROOPS;
  if (inclusionFee > MAX_STELLAR_TRANSACTION_FEE_STROOPS) {
    throw new Error("The live Stellar inclusion fee exceeds Kletia's 1 XLM safety cap.");
  }
  const transaction = new TransactionBuilder(account, {
    fee: inclusionFee.toString(),
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(new Contract(input.contractId).call(input.method, ...input.args))
    .setTimeout(120)
    .build();

  // Pass 1 - recording simulation. This discovers the authorization tree,
  // footprint and resource fee, but is only a pre-signature snapshot.
  const recording = await server.simulateTransaction(transaction);
  if (rpc.Api.isSimulationError(recording)) {
    throw new Error("Stellar recording simulation rejected the transaction.");
  }
  const prepared = rpc.assembleTransaction(transaction, recording).build();
  if (BigInt(prepared.fee) > MAX_STELLAR_TRANSACTION_FEE_STROOPS) {
    throw new Error("The simulated Stellar resource fee exceeds Kletia's 1 XLM safety cap.");
  }

  // Pass 2 - enforcing simulation. The hydrated transaction is re-simulated
  // with its discovered auth entries already attached. A recording simulation
  // that succeeds does not prove the *assembled* authorization tree is the one
  // the network will accept, so nothing is offered for signature until the
  // enforcing pass succeeds and reproduces the identical invocation.
  const enforcing = await server.simulateTransaction(prepared);
  if (rpc.Api.isSimulationError(enforcing)) {
    throw new Error(
      "Stellar enforcing simulation rejected the assembled authorization tree; nothing was offered for signature.",
    );
  }
  const enforcingPrepared = rpc.assembleTransaction(prepared, enforcing).build();
  if (
    sorobanInvocationFingerprint(prepared) !==
    sorobanInvocationFingerprint(enforcingPrepared)
  ) {
    throw new Error(
      "The Stellar invocation, authorization tree or footprint changed between the recording and enforcing simulation; the call was discarded instead of signed.",
    );
  }
  if (BigInt(enforcingPrepared.fee) > MAX_STELLAR_TRANSACTION_FEE_STROOPS) {
    throw new Error("The enforcing Stellar resource fee exceeds Kletia's 1 XLM safety cap.");
  }
  return enforcingPrepared.toXdr();
}

export async function prepareStellarMintAndForward(input: {
  source: string;
  message: Hex;
  attestation: Hex;
}): Promise<string> {
  return prepareStellarContractCall({
    source: input.source,
    contractId: TESTNET_CCTP.stellar.forwarder,
    method: "mint_and_forward",
    args: [
      xdr.ScVal.scvBytes(decodeHex(input.message)),
      xdr.ScVal.scvBytes(decodeHex(input.attestation)),
    ],
  });
}

export async function prepareStellarCctpApproval(input: {
  source: string;
  amount: string;
}): Promise<string> {
  const server = new rpc.Server(TESTNET_CCTP.stellar.rpcUrl);
  const latest = await server.getLatestLedger();
  return prepareStellarContractCall({
    source: input.source,
    contractId: TESTNET_CCTP.stellar.usdcSac,
    method: "approve",
    args: [
      new StellarAddress(input.source).toScVal(),
      new StellarAddress(TESTNET_CCTP.stellar.tokenMessengerMinter).toScVal(),
      nativeToScVal(parseUnits(input.amount, 7), { type: "i128" }),
      nativeToScVal(latest.sequence + 720, { type: "u32" }),
    ],
  });
}

export async function prepareStellarCctpBurn(input: {
  source: string;
  amount: string;
  arbitrumRecipient: Address;
  standardFeeBps: number;
}): Promise<string> {
  const canonicalAmount = parseUnits(input.amount, 6);
  const amount = canonicalAmount * 10n;
  const canonicalMaxFee = maxStandardCctpFee(
    canonicalAmount,
    input.standardFeeBps,
  );
  const recipient = decodeHex(pad(input.arbitrumRecipient, { size: 32 }));
  return prepareStellarContractCall({
    source: input.source,
    contractId: TESTNET_CCTP.stellar.tokenMessengerMinter,
    method: "deposit_for_burn",
    args: [
      new StellarAddress(input.source).toScVal(),
      nativeToScVal(amount, { type: "i128" }),
      nativeToScVal(TESTNET_CCTP.arbitrumSepolia.domain, { type: "u32" }),
      xdr.ScVal.scvBytes(recipient),
      new StellarAddress(TESTNET_CCTP.stellar.usdcSac).toScVal(),
      xdr.ScVal.scvBytes(new Uint8Array(32)),
      nativeToScVal(canonicalMaxFee * 10n, {
        type: "i128",
      }),
      nativeToScVal(2_000, { type: "u32" }),
    ],
  });
}

export async function submitSignedStellarTransaction(
  signedXdr: string,
  expectedUnsignedXdr: string,
): Promise<string> {
  const server = new rpc.Server(TESTNET_CCTP.stellar.rpcUrl);
  const transaction = TransactionBuilder.fromXdr(signedXdr, Networks.TESTNET);
  const expectedTransaction = TransactionBuilder.fromXdr(
    expectedUnsignedXdr,
    Networks.TESTNET,
  );
  const signedHash = transaction.hash();
  const expectedHash = expectedTransaction.hash();
  if (
    signedHash.length !== expectedHash.length ||
    signedHash.some((byte, index) => byte !== expectedHash[index])
  ) {
    throw new Error(
      "The wallet changed the reviewed Stellar transaction body; the signed envelope was not submitted.",
    );
  }
  if (transaction.signatures.length === 0) {
    throw new Error("The Stellar wallet returned an unsigned transaction envelope.");
  }
  const localHash = Array.from(transaction.hash())
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const submitted = await server.sendTransaction(transaction).catch(() => {
    throw new StellarTransactionIndeterminateError(localHash);
  });
  if (submitted.status === "ERROR") {
    throw new Error("Stellar RPC rejected the signed transaction.");
  }
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const result = await server.getTransaction(submitted.hash);
    if (result.status === "SUCCESS") return submitted.hash;
    if (result.status === "FAILED") {
      throw new Error("Stellar transaction failed onchain.");
    }
    await new Promise((resolve) => window.setTimeout(resolve, 2_000));
  }
  throw new StellarTransactionIndeterminateError(submitted.hash || localHash);
}
