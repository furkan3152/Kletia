import {
  decodeFunctionData,
  encodeFunctionData,
  encodePacked,
  erc20Abi,
  formatUnits,
  getAddress,
  isAddressEqual,
  keccak256,
  parseUnits,
  stringToHex,
  toFunctionSelector,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";

export const ARC_OFFICIAL_ADDRESSES = Object.freeze({
  USDC: getAddress("0x3600000000000000000000000000000000000000"),
  EURC: getAddress("0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a"),
  MEMO: getAddress("0x5294E9927c3306DcBaDb03fe70b92e01cCede505"),
  MULTICALL3_FROM: getAddress("0x522fAf9A91c41c443c66765030741e4AaCe147D0"),
  CCTP_TOKEN_MESSENGER_V2: getAddress(
    "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA",
  ),
  CCTP_MESSAGE_TRANSMITTER_V2: getAddress(
    "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275",
  ),
  GATEWAY_WALLET: getAddress("0x0077777d7EBA4688BDeF3E311b846F25870A19B9"),
  GATEWAY_MINTER: getAddress("0x0022222ABE238Cc2C7Bb1f21003F0a260052475B"),
} satisfies Record<string, Address>);

export const ARC_OFFICIAL_CHAIN_ID = 5_042_002;
export const ARC_CCTP_DOMAIN = 26;
export const ARC_USDC_DECIMALS = 6;
export const ARC_ATOMIC_PAYOUT_MAX_RECIPIENTS = 25;

export const ARC_OFFICIAL_MAX_USDC_TOTAL = parseUnits(
  "1000000",
  ARC_USDC_DECIMALS,
);

export const ARC_OFFICIAL_MEMO_ABI = [
  {
    type: "function",
    name: "memo",
    stateMutability: "nonpayable",
    inputs: [
      { name: "target", type: "address" },
      { name: "data", type: "bytes" },
      { name: "memoId", type: "bytes32" },
      { name: "memoData", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

export const ARC_MULTICALL3_FROM_ABI = [
  {
    type: "function",
    name: "aggregate3",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "calls",
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "allowFailure", type: "bool" },
          { name: "callData", type: "bytes" },
        ],
      },
    ],
    outputs: [
      {
        name: "returnData",
        type: "tuple[]",
        components: [
          { name: "success", type: "bool" },
          { name: "returnData", type: "bytes" },
        ],
      },
    ],
  },
] as const;

const ERC20_TRANSFER_SELECTOR = toFunctionSelector("transfer(address,uint256)");
const OFFICIAL_MEMO_SELECTOR = toFunctionSelector(
  "memo(address,bytes,bytes32,bytes)",
);
const MULTICALL3_FROM_AGGREGATE3_SELECTOR = toFunctionSelector(
  "aggregate3((address,bool,bytes)[])",
);
const OPAQUE_REFERENCE_PATTERN = /^[A-Za-z][A-Za-z0-9._:-]{0,63}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export class ArcOfficialPlanError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = "ArcOfficialPlanError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface ArcOfficialPolicyCall {
  target: Address;
  selector: Hex;
  allowFailure: false;
}

export interface ArcOfficialPolicyEvidence {
  network: "arc-testnet";
  chainId: typeof ARC_OFFICIAL_CHAIN_ID;
  source: "https://docs.arc.io/arc/references/contract-addresses";
  executionAccount: Address;
  accountPolicy: "EOA_ONLY";
  requiresRuntimeEoaCodeCheck: true;
  valuePolicy: "ZERO_ONLY";
  asset: typeof ARC_OFFICIAL_ADDRESSES.USDC;
  assetDecimals: typeof ARC_USDC_DECIMALS;
  totalAtomic: string;
  maxTotalAtomic: string;
  atomicity: "SINGLE_CALL" | "ALL_OR_NOTHING";
  nestedCalls: ArcOfficialPolicyCall[];
  memo?: {
    id: Hex;
    requestId: string;
    reference: string;
    policy: "PUBLIC_OPAQUE_ASCII_REFERENCE";
    visibility: "PUBLIC_ONCHAIN";
    piiProtection: "FORMAT_ONLY_USER_MUST_EXCLUDE_PII";
    maxBytes: 64;
  };
}

export interface ArcOfficialTransactionPlan {
  action: "arc_official_memo_payment" | "arc_atomic_usdc_payout";
  name: string;
  router: Address;
  targetContract: Address;
  calldata: Hex;
  value: "0";
  expectedOutput: string;
  amountInWei: string;
  isNativeIn: false;
  tokenInAddress: typeof ARC_OFFICIAL_ADDRESSES.USDC;
  approvals: [];
  policyEvidence: ArcOfficialPolicyEvidence;
}

export interface OfficialMemoPaymentInput {
  user: Address | string;
  recipient: Address | string;
  amount: string;
  reference: string;
  requestId: string;
}

export interface AtomicUsdcPayout {
  recipient: Address | string;
  amount: string;
}

export interface AtomicUsdcPayoutInput {
  user: Address | string;
  payouts: readonly AtomicUsdcPayout[];
}

function normalizeAddress(
  value: Address | string,
  field: "user" | "recipient",
): Address {
  let normalized: Address;
  try {
    normalized = getAddress(String(value));
  } catch {
    throw new ArcOfficialPlanError(
      "ARC_OFFICIAL_INVALID_ADDRESS",
      `${field} must be a valid EVM address.`,
    );
  }

  if (isAddressEqual(normalized, zeroAddress)) {
    throw new ArcOfficialPlanError(
      "ARC_OFFICIAL_ZERO_ADDRESS",
      `${field} cannot be the zero address.`,
    );
  }

  return normalized;
}

function requireDistinctUserAndRecipient(user: Address, recipient: Address) {
  if (isAddressEqual(user, recipient)) {
    throw new ArcOfficialPlanError(
      "ARC_OFFICIAL_SELF_PAYMENT",
      "Sender and recipient cannot be the same address.",
    );
  }
}

function parseUsdcAmount(amount: string): bigint {
  const normalized = String(amount).trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(normalized)) {
    throw new ArcOfficialPlanError(
      "ARC_OFFICIAL_INVALID_USDC_AMOUNT",
      "USDC amount must be positive and contain at most 6 decimal places.",
    );
  }

  const atomic = parseUnits(normalized, ARC_USDC_DECIMALS);
  if (atomic <= 0n) {
    throw new ArcOfficialPlanError(
      "ARC_OFFICIAL_INVALID_USDC_AMOUNT",
      "USDC amount must be greater than zero.",
    );
  }
  if (atomic > ARC_OFFICIAL_MAX_USDC_TOTAL) {
    throw new ArcOfficialPlanError(
      "ARC_OFFICIAL_TOTAL_LIMIT",
      `Single plan total cannot exceed ${formatUnits(
        ARC_OFFICIAL_MAX_USDC_TOTAL,
        ARC_USDC_DECIMALS,
      )} USDC limit.`,
    );
  }

  return atomic;
}

function calldataSelector(data: Hex): Hex {
  if (!/^0x[0-9a-fA-F]{8,}$/.test(data)) {
    throw new ArcOfficialPlanError(
      "ARC_OFFICIAL_INVALID_CALLDATA",
      "Transaction calldata must include a selector.",
    );
  }
  return data.slice(0, 10).toLowerCase() as Hex;
}

function assertSelector(data: Hex, expected: Hex, context: string) {
  if (calldataSelector(data) !== expected.toLowerCase()) {
    throw new ArcOfficialPlanError(
      "ARC_OFFICIAL_SELECTOR_NOT_ALLOWED",
      `${context} is outside the selector allowlist.`,
    );
  }
}

function validateOpaqueReference(reference: string): string {
  if (
    typeof reference !== "string" ||
    !OPAQUE_REFERENCE_PATTERN.test(reference) ||
    Buffer.byteLength(reference, "utf8") > 64
  ) {
    throw new ArcOfficialPlanError(
      "ARC_OFFICIAL_UNSAFE_REFERENCE",
      "Reference must be a public identifier between 1-64 bytes, starting with a letter and containing only letters, digits, \".\", \"_\", \":\", or \"-\". Do not include personal data.",
    );
  }
  return reference;
}

function validateRequestId(requestId: string): string {
  if (typeof requestId !== "string" || !REQUEST_ID_PATTERN.test(requestId)) {
    throw new ArcOfficialPlanError(
      "ARC_OFFICIAL_INVALID_REQUEST_ID",
      "requestId must be a controlled identifier between 1-128 characters.",
    );
  }
  return requestId;
}

function memoIdFor(
  requestId: string,
  user: Address,
  recipient: Address,
  amountAtomic: bigint,
): Hex {
  return keccak256(
    encodePacked(
      ["string", "uint256", "string", "address", "address", "uint256"],
      [
        "kletia.arc.official-memo.v1",
        BigInt(ARC_OFFICIAL_CHAIN_ID),
        requestId,
        user,
        recipient,
        amountAtomic,
      ],
    ),
  );
}

function noApprovalPlan(
  plan: Omit<
    ArcOfficialTransactionPlan,
    "targetContract" | "value" | "isNativeIn" | "tokenInAddress" | "approvals"
  >,
): ArcOfficialTransactionPlan {
  return {
    ...plan,
    targetContract: plan.router,
    value: "0",
    isNativeIn: false,
    tokenInAddress: ARC_OFFICIAL_ADDRESSES.USDC,
    approvals: [],
  };
}

export function buildOfficialMemoPaymentPlan(
  input: OfficialMemoPaymentInput,
): ArcOfficialTransactionPlan {
  const user = normalizeAddress(input.user, "user");
  const recipient = normalizeAddress(input.recipient, "recipient");
  requireDistinctUserAndRecipient(user, recipient);

  const amountAtomic = parseUsdcAmount(input.amount);
  const reference = validateOpaqueReference(input.reference);
  const requestId = validateRequestId(input.requestId);
  const transferCalldata = encodeFunctionData({
    abi: erc20Abi,
    functionName: "transfer",
    args: [recipient, amountAtomic],
  });
  assertSelector(transferCalldata, ERC20_TRANSFER_SELECTOR, "USDC transfer");

  const memoId = memoIdFor(requestId, user, recipient, amountAtomic);
  const calldata = encodeFunctionData({
    abi: ARC_OFFICIAL_MEMO_ABI,
    functionName: "memo",
    args: [
      ARC_OFFICIAL_ADDRESSES.USDC,
      transferCalldata,
      memoId,
      stringToHex(reference),
    ],
  });
  assertSelector(calldata, OFFICIAL_MEMO_SELECTOR, "Arc Memo");

  const plan = noApprovalPlan({
    action: "arc_official_memo_payment",
    name: "Arc Official Memo USDC Payment",
    router: ARC_OFFICIAL_ADDRESSES.MEMO,
    calldata,
    expectedOutput: `${formatUnits(
      amountAtomic,
      ARC_USDC_DECIMALS,
    )} USDC transfer; on-chain opaque reference: ${reference}`,
    amountInWei: amountAtomic.toString(),
    policyEvidence: {
      network: "arc-testnet",
      chainId: ARC_OFFICIAL_CHAIN_ID,
      source: "https://docs.arc.io/arc/references/contract-addresses",
      executionAccount: user,
      accountPolicy: "EOA_ONLY",
      requiresRuntimeEoaCodeCheck: true,
      valuePolicy: "ZERO_ONLY",
      asset: ARC_OFFICIAL_ADDRESSES.USDC,
      assetDecimals: ARC_USDC_DECIMALS,
      totalAtomic: amountAtomic.toString(),
      maxTotalAtomic: ARC_OFFICIAL_MAX_USDC_TOTAL.toString(),
      atomicity: "SINGLE_CALL",
      nestedCalls: [
        {
          target: ARC_OFFICIAL_ADDRESSES.USDC,
          selector: ERC20_TRANSFER_SELECTOR,
          allowFailure: false,
        },
      ],
      memo: {
        id: memoId,
        requestId,
        reference,
        policy: "PUBLIC_OPAQUE_ASCII_REFERENCE",
        visibility: "PUBLIC_ONCHAIN",
        piiProtection: "FORMAT_ONLY_USER_MUST_EXCLUDE_PII",
        maxBytes: 64,
      },
    },
  });

  assertOfficialArcCallPlan(plan);
  return plan;
}

export function buildAtomicUsdcPayoutPlan(
  input: AtomicUsdcPayoutInput,
): ArcOfficialTransactionPlan {
  const user = normalizeAddress(input.user, "user");
  if (!Array.isArray(input.payouts) || input.payouts.length === 0) {
    throw new ArcOfficialPlanError(
      "ARC_OFFICIAL_PAYOUTS_REQUIRED",
      "At least one USDC recipient is required.",
    );
  }
  if (input.payouts.length > ARC_ATOMIC_PAYOUT_MAX_RECIPIENTS) {
    throw new ArcOfficialPlanError(
      "ARC_OFFICIAL_TOO_MANY_RECIPIENTS",
      `An atomic plan can have at most ${ARC_ATOMIC_PAYOUT_MAX_RECIPIENTS} recipients.`,
    );
  }

  const seenRecipients = new Set<string>();
  let totalAtomic = 0n;
  const calls = input.payouts.map((payout) => {
    const recipient = normalizeAddress(payout.recipient, "recipient");
    requireDistinctUserAndRecipient(user, recipient);
    const recipientKey = recipient.toLowerCase();
    if (seenRecipients.has(recipientKey)) {
      throw new ArcOfficialPlanError(
        "ARC_OFFICIAL_DUPLICATE_RECIPIENT",
        `The same recipient can appear only once in an atomic payment plan: ${recipient}`,
      );
    }
    seenRecipients.add(recipientKey);

    const amountAtomic = parseUsdcAmount(payout.amount);
    if (totalAtomic > ARC_OFFICIAL_MAX_USDC_TOTAL - amountAtomic) {
      throw new ArcOfficialPlanError(
        "ARC_OFFICIAL_TOTAL_LIMIT",
        `The total atomic payment cannot exceed ${formatUnits(
          ARC_OFFICIAL_MAX_USDC_TOTAL,
          ARC_USDC_DECIMALS,
        )} USDC.`,
      );
    }
    totalAtomic += amountAtomic;

    const callData = encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [recipient, amountAtomic],
    });
    assertSelector(callData, ERC20_TRANSFER_SELECTOR, "USDC transfer");

    return {
      target: ARC_OFFICIAL_ADDRESSES.USDC,
      allowFailure: false as const,
      callData,
    };
  });

  const calldata = encodeFunctionData({
    abi: ARC_MULTICALL3_FROM_ABI,
    functionName: "aggregate3",
    args: [calls],
  });
  assertSelector(
    calldata,
    MULTICALL3_FROM_AGGREGATE3_SELECTOR,
    "Arc Multicall3From aggregate3",
  );

  const plan = noApprovalPlan({
    action: "arc_atomic_usdc_payout",
    name: "Arc Official Atomic USDC Payout",
    router: ARC_OFFICIAL_ADDRESSES.MULTICALL3_FROM,
    calldata,
    expectedOutput: `Total ${formatUnits(
      totalAtomic,
      ARC_USDC_DECIMALS,
    )} USDC to ${calls.length} recipients; all succeed or all revert`,
    amountInWei: totalAtomic.toString(),
    policyEvidence: {
      network: "arc-testnet",
      chainId: ARC_OFFICIAL_CHAIN_ID,
      source: "https://docs.arc.io/arc/references/contract-addresses",
      executionAccount: user,
      accountPolicy: "EOA_ONLY",
      requiresRuntimeEoaCodeCheck: true,
      valuePolicy: "ZERO_ONLY",
      asset: ARC_OFFICIAL_ADDRESSES.USDC,
      assetDecimals: ARC_USDC_DECIMALS,
      totalAtomic: totalAtomic.toString(),
      maxTotalAtomic: ARC_OFFICIAL_MAX_USDC_TOTAL.toString(),
      atomicity: "ALL_OR_NOTHING",
      nestedCalls: calls.map(() => ({
        target: ARC_OFFICIAL_ADDRESSES.USDC,
        selector: ERC20_TRANSFER_SELECTOR,
        allowFailure: false,
      })),
    },
  });

  assertOfficialArcCallPlan(plan);
  return plan;
}

export function assertOfficialArcCallPlan(
  plan: ArcOfficialTransactionPlan,
): void {
  const evidence = plan.policyEvidence;
  const executionAccount = normalizeAddress(evidence.executionAccount, "user");
  if (
    evidence.network !== "arc-testnet" ||
    evidence.chainId !== ARC_OFFICIAL_CHAIN_ID ||
    evidence.source !==
      "https://docs.arc.io/arc/references/contract-addresses" ||
    evidence.accountPolicy !== "EOA_ONLY" ||
    evidence.requiresRuntimeEoaCodeCheck !== true ||
    evidence.valuePolicy !== "ZERO_ONLY" ||
    evidence.assetDecimals !== ARC_USDC_DECIMALS ||
    evidence.maxTotalAtomic !== ARC_OFFICIAL_MAX_USDC_TOTAL.toString() ||
    !isAddressEqual(evidence.asset, ARC_OFFICIAL_ADDRESSES.USDC)
  ) {
    throw new ArcOfficialPlanError(
      "ARC_OFFICIAL_POLICY_EVIDENCE_MISMATCH",
      "Official Arc plan's fixed policy evidence is invalid.",
    );
  }
  if (plan.value !== "0") {
    throw new ArcOfficialPlanError(
      "ARC_OFFICIAL_NONZERO_VALUE",
      "Official Arc extension plan cannot carry native value.",
    );
  }
  if (!isAddressEqual(plan.tokenInAddress, ARC_OFFICIAL_ADDRESSES.USDC)) {
    throw new ArcOfficialPlanError(
      "ARC_OFFICIAL_ASSET_NOT_ALLOWED",
      "Only official USDC is allowed in the official Arc extension plan.",
    );
  }
  if (plan.approvals.length !== 0) {
    throw new ArcOfficialPlanError(
      "ARC_OFFICIAL_APPROVAL_NOT_ALLOWED",
      "Transfer-based official Arc plans must not generate approvals.",
    );
  }

  if (plan.action === "arc_official_memo_payment") {
    if (
      !isAddressEqual(plan.router, ARC_OFFICIAL_ADDRESSES.MEMO) ||
      !isAddressEqual(plan.targetContract, plan.router)
    ) {
      throw new ArcOfficialPlanError(
        "ARC_OFFICIAL_ROUTER_NOT_ALLOWED",
        "Memo plans can only target the official Arc Memo contract.",
      );
    }
    assertSelector(plan.calldata, OFFICIAL_MEMO_SELECTOR, "Arc Memo");

    const decoded = decodeFunctionData({
      abi: ARC_OFFICIAL_MEMO_ABI,
      data: plan.calldata,
    });
    const [target, innerCalldata, memoId, memoData] = decoded.args;
    if (!isAddressEqual(target, ARC_OFFICIAL_ADDRESSES.USDC)) {
      throw new ArcOfficialPlanError(
        "ARC_OFFICIAL_NESTED_TARGET_NOT_ALLOWED",
        "Memo internal calls can only target the official Arc USDC contract.",
      );
    }
    assertSelector(innerCalldata, ERC20_TRANSFER_SELECTOR, "Memo USDC");
    const transfer = decodeFunctionData({
      abi: erc20Abi,
      data: innerCalldata,
    });
    if (transfer.functionName !== "transfer") {
      throw new ArcOfficialPlanError(
        "ARC_OFFICIAL_SELECTOR_NOT_ALLOWED",
        "Memo internal calls can only be USDC transfers.",
      );
    }
    const [recipient, amountAtomic] = transfer.args;
    requireDistinctUserAndRecipient(executionAccount, recipient);
    const memoEvidence = evidence.memo;
    if (!memoEvidence) {
      throw new ArcOfficialPlanError(
        "ARC_OFFICIAL_MEMO_EVIDENCE_MISMATCH",
        "Memo policy evidence is missing.",
      );
    }
    const safeReference = validateOpaqueReference(memoEvidence.reference);
    const requestId = validateRequestId(memoEvidence.requestId);
    const expectedMemoId = memoIdFor(
      requestId,
      executionAccount,
      recipient,
      amountAtomic,
    );
    if (
      memoId !== memoEvidence.id ||
      memoId !== expectedMemoId ||
      memoData !== stringToHex(safeReference) ||
      memoEvidence.policy !== "PUBLIC_OPAQUE_ASCII_REFERENCE" ||
      memoEvidence.visibility !== "PUBLIC_ONCHAIN" ||
      memoEvidence.piiProtection !== "FORMAT_ONLY_USER_MUST_EXCLUDE_PII" ||
      memoEvidence.maxBytes !== 64 ||
      evidence.atomicity !== "SINGLE_CALL" ||
      evidence.nestedCalls.length !== 1 ||
      !isAddressEqual(
        evidence.nestedCalls[0].target,
        ARC_OFFICIAL_ADDRESSES.USDC,
      ) ||
      evidence.nestedCalls[0].selector.toLowerCase() !==
        ERC20_TRANSFER_SELECTOR.toLowerCase() ||
      evidence.nestedCalls[0].allowFailure !== false
    ) {
      throw new ArcOfficialPlanError(
        "ARC_OFFICIAL_MEMO_EVIDENCE_MISMATCH",
        "Memo calldata does not match the policy evidence.",
      );
    }
    if (
      amountAtomic.toString() !== plan.amountInWei ||
      amountAtomic.toString() !== evidence.totalAtomic
    ) {
      throw new ArcOfficialPlanError(
        "ARC_OFFICIAL_TOTAL_MISMATCH",
        "Memo transfer amount does not match the plan total.",
      );
    }
    return;
  }

  if (plan.action !== "arc_atomic_usdc_payout") {
    throw new ArcOfficialPlanError(
      "ARC_OFFICIAL_ACTION_NOT_ALLOWED",
      "Unknown official Arc extension action.",
    );
  }
  if (
    !isAddressEqual(plan.router, ARC_OFFICIAL_ADDRESSES.MULTICALL3_FROM) ||
    !isAddressEqual(plan.targetContract, plan.router)
  ) {
    throw new ArcOfficialPlanError(
      "ARC_OFFICIAL_ROUTER_NOT_ALLOWED",
      "Atomic payout can only target the official Arc Multicall3From contract.",
    );
  }
  assertSelector(
    plan.calldata,
    MULTICALL3_FROM_AGGREGATE3_SELECTOR,
    "Arc Multicall3From aggregate3",
  );

  const decoded = decodeFunctionData({
    abi: ARC_MULTICALL3_FROM_ABI,
    data: plan.calldata,
  });
  const calls = decoded.args[0];
  if (
    calls.length === 0 ||
    calls.length > ARC_ATOMIC_PAYOUT_MAX_RECIPIENTS ||
    evidence.atomicity !== "ALL_OR_NOTHING" ||
    evidence.memo !== undefined
  ) {
    throw new ArcOfficialPlanError(
      "ARC_OFFICIAL_INVALID_CALL_COUNT",
      "Atomic payout internal call count is outside the policy limits.",
    );
  }

  let decodedTotal = 0n;
  const decodedRecipients = new Set<string>();
  for (const [index, call] of calls.entries()) {
    if (!isAddressEqual(call.target, ARC_OFFICIAL_ADDRESSES.USDC)) {
      throw new ArcOfficialPlanError(
        "ARC_OFFICIAL_NESTED_TARGET_NOT_ALLOWED",
        "Atomic payout internal calls can only target the official Arc USDC contract.",
      );
    }
    if (call.allowFailure) {
      throw new ArcOfficialPlanError(
        "ARC_OFFICIAL_PARTIAL_FAILURE_NOT_ALLOWED",
        "Atomic payout internal calls must have allowFailure set to false.",
      );
    }
    assertSelector(
      call.callData,
      ERC20_TRANSFER_SELECTOR,
      "Atomik payout USDC",
    );

    const transfer = decodeFunctionData({
      abi: erc20Abi,
      data: call.callData,
    });
    if (transfer.functionName !== "transfer") {
      throw new ArcOfficialPlanError(
        "ARC_OFFICIAL_SELECTOR_NOT_ALLOWED",
        "Atomic payout can only contain USDC transfer calls.",
      );
    }
    const [recipient, amountAtomic] = transfer.args;
    requireDistinctUserAndRecipient(executionAccount, recipient);
    const recipientKey = recipient.toLowerCase();
    if (decodedRecipients.has(recipientKey)) {
      throw new ArcOfficialPlanError(
        "ARC_OFFICIAL_DUPLICATE_RECIPIENT",
        "Duplicate recipient found in decoded atomic plan.",
      );
    }
    decodedRecipients.add(recipientKey);

    if (amountAtomic <= 0n) {
      throw new ArcOfficialPlanError(
        "ARC_OFFICIAL_INVALID_USDC_AMOUNT",
        "Decoded USDC transfer amount must be positive.",
      );
    }
    if (decodedTotal > ARC_OFFICIAL_MAX_USDC_TOTAL - amountAtomic) {
      throw new ArcOfficialPlanError(
        "ARC_OFFICIAL_TOTAL_LIMIT",
        "Decoded atomic payout exceeds the safe total limit.",
      );
    }
    decodedTotal += amountAtomic;

    const callEvidence = evidence.nestedCalls[index];
    if (
      !callEvidence ||
      !isAddressEqual(callEvidence.target, ARC_OFFICIAL_ADDRESSES.USDC) ||
      callEvidence.selector.toLowerCase() !==
        ERC20_TRANSFER_SELECTOR.toLowerCase() ||
      callEvidence.allowFailure !== false
    ) {
      throw new ArcOfficialPlanError(
        "ARC_OFFICIAL_POLICY_EVIDENCE_MISMATCH",
        "Atomic payout internal call does not match the policy evidence.",
      );
    }
  }

  if (
    decodedTotal.toString() !== plan.amountInWei ||
    decodedTotal.toString() !== evidence.totalAtomic ||
    calls.length !== evidence.nestedCalls.length
  ) {
    throw new ArcOfficialPlanError(
      "ARC_OFFICIAL_TOTAL_MISMATCH",
      "Atomic payout calldata does not match the plan total or policy evidence.",
    );
  }
}
