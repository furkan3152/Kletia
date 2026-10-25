/**
 * Entity resolution checks: recipients resolved from names must stay
 * bound to the calldata that pays them.
 */
import {
  decodeFunctionData,
  erc20Abi,
  getAddress,
  type Address,
  type Hex,
} from "viem";
import { NETWORKS, type NetworkId } from "../../config/networks.js";
import {
  NATIVE_TOKEN_SENTINEL,
} from "../../../networks/base/intent/routerV2.js";
import {
  ARC_MULTICALL3_FROM_ABI,
  ARC_OFFICIAL_ADDRESSES,
  ARC_OFFICIAL_MEMO_ABI,
  assertOfficialArcCallPlan,
} from "../../../networks/arc/officialExtensions.js";
import {
  type CheckedV2Intent,
  IntentResponseError,
  type ResultLike,
  type UnknownRecord,
} from "./types.js";
import {
  checkedCalldata,
  decimalValue,
  isRecord,
  sameAddress,
} from "./checks.js";

export function checkedEntityResolution(
  value: unknown,
  expected: {
    readonly network: NetworkId;
    readonly action: string;
    readonly requestId: string;
    readonly userAddress: Address;
  },
): UnknownRecord | undefined {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    value.policyVersion !== "kletia_entity_resolution_v1" ||
    value.network !== expected.network ||
    value.chainId !== NETWORKS[expected.network].chainId ||
    value.action !== expected.action ||
    value.requestId !== expected.requestId ||
    value.decision !== "eligible" ||
    value.scorePolicy !== "informational_only_hard_gates_take_precedence" ||
    typeof value.observedAt !== "string" ||
    !Number.isFinite(Date.parse(value.observedAt)) ||
    typeof value.userAddress !== "string"
  ) {
    throw new IntentResponseError(
      "INVALID_ENTITY_RESOLUTION_EVIDENCE",
      "Entity resolution evidence does not match the request, network, wallet, or action.",
    );
  }
  let evidenceUser: Address;
  try {
    evidenceUser = getAddress(value.userAddress);
  } catch {
    throw new IntentResponseError(
      "INVALID_ENTITY_RESOLUTION_EVIDENCE",
      "The wallet in the entity resolution evidence is invalid.",
    );
  }
  if (!sameAddress(evidenceUser, expected.userAddress)) {
    throw new IntentResponseError(
      "INVALID_ENTITY_RESOLUTION_EVIDENCE",
      "Entity resolution evidence is not linked to the active wallet.",
    );
  }
  if (
    !Array.isArray(value.assets) ||
    value.assets.length > 4 ||
    !Array.isArray(value.recipients) ||
    value.recipients.length > 25 ||
    !Array.isArray(value.warnings) ||
    value.warnings.length > 20
  ) {
    throw new IntentResponseError(
      "INVALID_ENTITY_RESOLUTION_EVIDENCE",
      "Entity resolution evidence collection boundaries are invalid.",
    );
  }
  const roles = new Set<string>();
  for (const asset of value.assets) {
    if (
      !isRecord(asset) ||
      typeof asset.role !== "string" ||
      !new Set(["tokenIn", "tokenOut", "collateralToken", "borrowToken"]).has(
        asset.role,
      ) ||
      roles.has(asset.role) ||
      typeof asset.canonicalSymbol !== "string" ||
      asset.canonicalSymbol.length < 1 ||
      asset.canonicalSymbol.length > 24 ||
      typeof asset.displayName !== "string" ||
      asset.displayName.length < 1 ||
      asset.displayName.length > 64 ||
      !Number.isInteger(asset.decimals) ||
      Number(asset.decimals) < 0 ||
      Number(asset.decimals) > 36 ||
      !Number.isFinite(asset.identityConfidence) ||
      Number(asset.identityConfidence) < 0 ||
      Number(asset.identityConfidence) > 100 ||
      !Number.isFinite(asset.trustScore) ||
      Number(asset.trustScore) < 0 ||
      Number(asset.trustScore) > 100 ||
      !new Set([
        "native",
        "erc20",
        "native_with_erc20_interface",
        "app_kit_symbol",
      ]).has(String(asset.representation)) ||
      !new Set([
        "canonical_symbol",
        "curated_alias",
        "exact_address",
        "portfolio_verified_address",
        "protocol_fixed_asset",
      ]).has(String(asset.matchedBy)) ||
      !isRecord(asset.security) ||
      !new Set([
        "manifest_verified",
        "registry_reviewed",
        "provider_passed",
      ]).has(String(asset.security.status)) ||
      !new Set(["Kletia reviewed registry", "GoPlus"]).has(
        String(asset.security.provider),
      ) ||
      typeof asset.security.observedAt !== "string" ||
      !Number.isFinite(Date.parse(asset.security.observedAt)) ||
      !isRecord(asset.actionCompatibility) ||
      asset.actionCompatibility.action !== expected.action ||
      asset.actionCompatibility.allowed !== true ||
      !Number.isInteger(asset.actionCompatibility.executionDecimals) ||
      Number(asset.actionCompatibility.executionDecimals) < 0 ||
      Number(asset.actionCompatibility.executionDecimals) > 36 ||
      !Array.isArray(asset.warnings) ||
      asset.warnings.length > 10
    ) {
      throw new IntentResponseError(
        "INVALID_ENTITY_RESOLUTION_EVIDENCE",
        "The asset record in the entity resolution evidence is invalid.",
      );
    }
    if (asset.address !== undefined) {
      try {
        getAddress(String(asset.address));
      } catch {
        throw new IntentResponseError(
          "INVALID_ENTITY_RESOLUTION_EVIDENCE",
          "The token address in the entity resolution evidence is invalid.",
        );
      }
    }
    if (asset.representation === "native" && asset.address !== undefined) {
      throw new IntentResponseError(
        "INVALID_ENTITY_RESOLUTION_EVIDENCE",
        "Native asset evidence cannot carry an ERC-20 address.",
      );
    }
    if (
      asset.security.status === "manifest_verified" &&
      (typeof asset.security.catalogRevision !== "string" ||
        asset.security.catalogRevision.length < 1 ||
        asset.security.catalogRevision.length > 64 ||
        typeof asset.security.primarySource !== "string" ||
        !/^https:\/\//u.test(asset.security.primarySource))
    ) {
      throw new IntentResponseError(
        "INVALID_ENTITY_RESOLUTION_EVIDENCE",
        "Manifest verification evidence is missing revision or primary source.",
      );
    }
    if (
      asset.security.status === "registry_reviewed" &&
      (typeof asset.security.catalogRevision !== "string" ||
        asset.security.catalogRevision.length < 1 ||
        asset.security.catalogRevision.length > 64)
    ) {
      throw new IntentResponseError(
        "INVALID_ENTITY_RESOLUTION_EVIDENCE",
        "Registry review evidence is missing manifest revision.",
      );
    }
    if (
      asset.security.status === "provider_passed" &&
      asset.security.provider !== "GoPlus"
    ) {
      throw new IntentResponseError(
        "INVALID_ENTITY_RESOLUTION_EVIDENCE",
        "Dynamic token evidence is not linked to the expected risk provider.",
      );
    }
    roles.add(asset.role);
  }
  for (const recipient of value.recipients) {
    if (
      !isRecord(recipient) ||
      recipient.role !== "recipient" ||
      typeof recipient.resolvedAddress !== "string" ||
      !new Set(["exact_address", "basename"]).has(
        String(recipient.matchedBy),
      ) ||
      typeof recipient.observedAt !== "string" ||
      !Number.isFinite(Date.parse(recipient.observedAt)) ||
      typeof recipient.expiresAt !== "number" ||
      !Number.isFinite(recipient.expiresAt)
    ) {
      throw new IntentResponseError(
        "INVALID_ENTITY_RESOLUTION_EVIDENCE",
        "Recipient resolution evidence is invalid.",
      );
    }
    if (
      recipient.matchedBy === "basename" &&
      (typeof recipient.basename !== "string" ||
        !/^[^\s.]+\.base(?:\.eth)?$/iu.test(recipient.basename) ||
        typeof recipient.resolver !== "string" ||
        typeof recipient.observedAtBlock !== "string")
    ) {
      throw new IntentResponseError(
        "INVALID_ENTITY_RESOLUTION_EVIDENCE",
        "Basename resolution evidence lacks resolver or block dependency.",
      );
    }
    try {
      getAddress(recipient.resolvedAddress);
    } catch {
      throw new IntentResponseError(
        "INVALID_ENTITY_RESOLUTION_EVIDENCE",
        "The address in the recipient resolution evidence is invalid.",
      );
    }
    if (
      recipient.matchedBy === "basename" &&
      recipient.expiresAt <= Date.now()
    ) {
      throw new IntentResponseError(
        "BASENAME_RESOLUTION_EXPIRED",
        "Basename resolution evidence has expired; recipient must be re-resolved.",
      );
    }
  }
  if (
    value.warnings.some(
      (warning) => typeof warning !== "string" || warning.length > 500,
    )
  ) {
    throw new IntentResponseError(
      "INVALID_ENTITY_RESOLUTION_EVIDENCE",
      "Entity resolution warnings are invalid.",
    );
  }
  return value;
}

export function clampToRecipientResolutionExpiry(
  quoteExpiresAt: number,
  entityResolution: UnknownRecord | undefined,
): number {
  if (!entityResolution) return quoteExpiresAt;
  const recipients = entityResolution.recipients as UnknownRecord[];
  return Math.min(
    quoteExpiresAt,
    ...recipients.map((recipient) => Number(recipient.expiresAt)),
  );
}

export function assertV2EntityResolutionBinding(
  entityResolution: UnknownRecord | undefined,
  intent: CheckedV2Intent,
) {
  if (!entityResolution) return;
  const assets = entityResolution.assets as UnknownRecord[];
  const assertRole = (
    role: "tokenIn" | "tokenOut",
    expectedAddress: Address,
  ) => {
    const asset = assets.find((candidate) => candidate.role === role);
    if (!asset) {
      throw new IntentResponseError(
        "ENTITY_ROUTE_BINDING_MISSING",
        `Missing ${role} resolution proof on Base V2 route.`,
      );
    }
    const native = asset.representation === "native";
    if (native) {
      if (!sameAddress(expectedAddress, NATIVE_TOKEN_SENTINEL)) {
        throw new IntentResponseError(
          "ENTITY_ROUTE_BINDING_MISMATCH",
          `Base V2 ${role} native ID does not match the route token.`,
        );
      }
      return;
    }
    if (
      typeof asset.address !== "string" ||
      !sameAddress(getAddress(asset.address), expectedAddress)
    ) {
      throw new IntentResponseError(
        "ENTITY_ROUTE_BINDING_MISMATCH",
        `Base V2 ${role} address does not match the route token.`,
      );
    }
  };
  assertRole("tokenIn", intent.tokenIn);
  assertRole("tokenOut", intent.tokenOut);
}

export function assertArcExternalEntityResolutionBinding(
  entityResolution: UnknownRecord | undefined,
  rawResult: ResultLike,
  action: string,
) {
  if (!entityResolution) return;
  const assets = entityResolution.assets as UnknownRecord[];
  const recipients = entityResolution.recipients as UnknownRecord[];
  const tokenIn = assets.find((asset) => asset.role === "tokenIn");
  if (rawResult.executionKind === "circle_app_kit") {
    if (!isRecord(rawResult.executionPlan) || !tokenIn) {
      throw new IntentResponseError(
        "ENTITY_EXTERNAL_BINDING_MISSING",
        "App Kit execution plan is missing entity resolution evidence.",
      );
    }
    const plan = rawResult.executionPlan;
    const expectedToken = String(
      plan.tokenIn || plan.token || "",
    ).toUpperCase();
    const expectedDecimals = expectedToken === "CIRBTC" ? 8 : 6;
    if (
      String(tokenIn.canonicalSymbol).toUpperCase() !== expectedToken ||
      !isRecord(tokenIn.actionCompatibility) ||
      tokenIn.actionCompatibility.executionDecimals !== expectedDecimals
    ) {
      throw new IntentResponseError(
        "ENTITY_EXTERNAL_BINDING_MISMATCH",
        "App Kit token or atomic precision does not match resolution evidence.",
      );
    }
    if (plan.tokenOut !== undefined) {
      const tokenOut = assets.find((asset) => asset.role === "tokenOut");
      if (
        !tokenOut ||
        String(tokenOut.canonicalSymbol).toUpperCase() !==
          String(plan.tokenOut).toUpperCase()
      ) {
        throw new IntentResponseError(
          "ENTITY_EXTERNAL_BINDING_MISMATCH",
          "App Kit output token does not match resolution evidence.",
        );
      }
    }
    if (plan.recipient !== undefined) {
      const recipient = recipients.find(
        (candidate) => candidate.role === "recipient",
      );
      if (
        !recipient ||
        typeof recipient.resolvedAddress !== "string" ||
        !sameAddress(
          getAddress(recipient.resolvedAddress),
          getAddress(String(plan.recipient)),
        )
      ) {
        throw new IntentResponseError(
          "ENTITY_RECIPIENT_BINDING_MISMATCH",
          "App Kit recipient does not match the resolution evidence.",
        );
      }
    }
    return;
  }

  if (action === "official_memo_send" || action === "atomic_payout") {
    if (
      !tokenIn ||
      !isRecord(tokenIn.actionCompatibility) ||
      tokenIn.actionCompatibility.executionDecimals !== 6 ||
      !isRecord(rawResult.policyEvidence) ||
      rawResult.policyEvidence.assetDecimals !== 6 ||
      typeof tokenIn.address !== "string" ||
      typeof rawResult.policyEvidence.asset !== "string" ||
      !sameAddress(
        getAddress(tokenIn.address),
        getAddress(rawResult.policyEvidence.asset),
      )
    ) {
      throw new IntentResponseError(
        "ENTITY_OFFICIAL_ASSET_BINDING_MISMATCH",
        "Official Arc USDC plan address or 6-decimal precision does not match the resolution evidence.",
      );
    }
    assertOfficialRecipientBindings(entityResolution, rawResult, action);
  }
}

function decodedErc20TransferRecipient(calldata: Hex): Address {
  try {
    const decoded = decodeFunctionData({ abi: erc20Abi, data: calldata });
    if (
      decoded.functionName !== "transfer" ||
      !decoded.args ||
      decoded.args.length !== 2
    ) {
      throw new Error("not_transfer");
    }
    return getAddress(String(decoded.args[0]));
  } catch {
    throw new IntentResponseError(
      "ENTITY_OFFICIAL_CALLDATA_INVALID",
      "USDC transfer in Official Arc payment calldata could not be resolved.",
    );
  }
}

function assertOfficialRecipientBindings(
  entityResolution: UnknownRecord,
  rawResult: ResultLike,
  action: string,
) {
  try {
    assertOfficialArcCallPlan({
      ...rawResult,
      action:
        action === "official_memo_send"
          ? "arc_official_memo_payment"
          : "arc_atomic_usdc_payout",
    } as never);
  } catch {
    throw new IntentResponseError(
      "ENTITY_OFFICIAL_CALLDATA_INVALID",
      "Official Arc payment plan failed execution policy validation.",
    );
  }
  const recipients = entityResolution.recipients as UnknownRecord[];
  const calldata = checkedCalldata(rawResult.calldata, "officialArc.calldata");
  if (action === "official_memo_send") {
    let transferCalldata: Hex;
    try {
      const decoded = decodeFunctionData({
        abi: ARC_OFFICIAL_MEMO_ABI,
        data: calldata,
      });
      if (decoded.functionName !== "memo" || !decoded.args) {
        throw new Error("not_memo");
      }
      const [target, nested] = decoded.args;
      if (
        !sameAddress(getAddress(String(target)), ARC_OFFICIAL_ADDRESSES.USDC)
      ) {
        throw new Error("wrong_asset");
      }
      transferCalldata = nested as Hex;
    } catch {
      throw new IntentResponseError(
        "ENTITY_OFFICIAL_CALLDATA_INVALID",
        "Official Arc Memo calldata structure could not be resolved.",
      );
    }
    const actualRecipient = decodedErc20TransferRecipient(transferCalldata);
    const evidenceRecipient = recipients.find(
      (recipient) => recipient.transferIndex === undefined,
    );
    if (
      recipients.length !== 1 ||
      !evidenceRecipient ||
      typeof evidenceRecipient.resolvedAddress !== "string" ||
      !sameAddress(
        getAddress(evidenceRecipient.resolvedAddress),
        actualRecipient,
      )
    ) {
      throw new IntentResponseError(
        "ENTITY_RECIPIENT_BINDING_MISMATCH",
        "Official Arc Memo recipient does not match the resolution evidence.",
      );
    }
    return;
  }

  let calls: readonly {
    target: Address;
    allowFailure: boolean;
    callData: Hex;
  }[];
  try {
    const decoded = decodeFunctionData({
      abi: ARC_MULTICALL3_FROM_ABI,
      data: calldata,
    });
    if (decoded.functionName !== "aggregate3" || !decoded.args) {
      throw new Error("not_aggregate3");
    }
    calls = decoded.args[0] as typeof calls;
  } catch {
    throw new IntentResponseError(
      "ENTITY_OFFICIAL_CALLDATA_INVALID",
      "Atomic Arc payment calldata structure could not be resolved.",
    );
  }
  if (calls.length !== recipients.length) {
    throw new IntentResponseError(
      "ENTITY_RECIPIENT_BINDING_MISMATCH",
      "Atomic Arc payment recipient count does not match the resolution evidence.",
    );
  }
  calls.forEach((call, index) => {
    const evidenceRecipient = recipients.find(
      (recipient) => recipient.transferIndex === index,
    );
    const actualRecipient = decodedErc20TransferRecipient(call.callData);
    if (
      call.allowFailure !== false ||
      !sameAddress(getAddress(call.target), ARC_OFFICIAL_ADDRESSES.USDC) ||
      !evidenceRecipient ||
      typeof evidenceRecipient.resolvedAddress !== "string" ||
      !sameAddress(
        getAddress(evidenceRecipient.resolvedAddress),
        actualRecipient,
      )
    ) {
      throw new IntentResponseError(
        "ENTITY_RECIPIENT_BINDING_MISMATCH",
        "Atomic Arc payment recipient does not match the resolution evidence.",
      );
    }
  });
}

export function assertGenericEntityResolutionBinding(
  entityResolution: UnknownRecord | undefined,
  rawResult: ResultLike,
  action: string,
) {
  if (!entityResolution) return;
  const assets = entityResolution.assets as UnknownRecord[];
  const tokenIn = assets.find((asset) => asset.role === "tokenIn");
  const allRawApprovals = [
    ...(Array.isArray(rawResult.approvals) ? rawResult.approvals : []),
    ...(Array.isArray(rawResult.allRoutes)
      ? rawResult.allRoutes.flatMap((route) =>
          Array.isArray(route.approvals) ? route.approvals : [],
        )
      : []),
  ];
  const inputConsumingActions = new Set([
    "swap",
    "add_liquidity",
    "stake",
    "liquid_stake",
    "liquid_unstake",
    "lend",
    "repay",
    "bridge",
    "vault_deposit",
    "lending_deposit",
    "lending_repay",
    "memo_send",
    "transfer",
    "workflow",
  ]);
  if (inputConsumingActions.has(action) && !tokenIn) {
    throw new IntentResponseError(
      "ENTITY_ROUTE_BINDING_MISSING",
      "Execution route is missing tokenIn resolution evidence.",
    );
  }
  if (tokenIn && rawResult.isNativeIn === true) {
    if (
      tokenIn.representation !== "native" &&
      tokenIn.representation !== "native_with_erc20_interface"
    ) {
      throw new IntentResponseError(
        "ENTITY_NATIVE_BINDING_MISMATCH",
        "Native-value route does not match ERC-20 tokenIn evidence.",
      );
    }
    const nativeValue = decimalValue(
      rawResult.value ?? rawResult.amountInWei ?? "0",
      "entity.nativeValue",
    );
    if (BigInt(nativeValue) <= 0n) {
      throw new IntentResponseError(
        "ENTITY_NATIVE_BINDING_MISMATCH",
        "Native-value route does not carry a positive and proven value.",
      );
    }
  }
  if (
    action !== "remove_liquidity" &&
    rawResult.tokenInAddress !== undefined &&
    tokenIn &&
    tokenIn.representation !== "native" &&
    typeof tokenIn.address === "string"
  ) {
    if (
      typeof rawResult.tokenInAddress !== "string" ||
      !sameAddress(
        getAddress(rawResult.tokenInAddress),
        getAddress(tokenIn.address),
      )
    ) {
      throw new IntentResponseError(
        "ENTITY_ROUTE_BINDING_MISMATCH",
        "Execution tokenIn address does not match resolved input entity.",
      );
    }
  }

  if (
    tokenIn &&
    inputConsumingActions.has(action) &&
    rawResult.isNativeIn !== true &&
    tokenIn.representation !== "native" &&
    typeof tokenIn.address === "string"
  ) {
    const expectedInput = getAddress(tokenIn.address);
    const directAddressMatches =
      typeof rawResult.tokenInAddress === "string" &&
      sameAddress(getAddress(rawResult.tokenInAddress), expectedInput);
    const approvalMatches = allRawApprovals.some(
      (approval) =>
        isRecord(approval) &&
        typeof approval.token === "string" &&
        sameAddress(getAddress(approval.token), expectedInput),
    );
    if (!directAddressMatches && !approvalMatches) {
      throw new IntentResponseError(
        "ENTITY_ROUTE_BINDING_MISSING",
        "ERC-20 tokenIn identity is not bound to route address or approval.",
      );
    }
  }

  const tokenOut = assets.find((asset) => asset.role === "tokenOut");
  if (rawResult.tokenOutAddress !== undefined) {
    if (
      !tokenOut ||
      typeof tokenOut.address !== "string" ||
      typeof rawResult.tokenOutAddress !== "string" ||
      !sameAddress(
        getAddress(rawResult.tokenOutAddress),
        getAddress(tokenOut.address),
      )
    ) {
      throw new IntentResponseError(
        "ENTITY_ROUTE_BINDING_MISMATCH",
        "Execution tokenOut address does not match resolved output entity.",
      );
    }
  }

  if (action === "remove_liquidity") return;
  if (action === "transfer") {
    const recipients = entityResolution.recipients as UnknownRecord[];
    const recipient = recipients.find((candidate) => candidate.role === "recipient");
    if (
      recipients.length !== 1 ||
      !recipient ||
      typeof recipient.resolvedAddress !== "string"
    ) {
      throw new IntentResponseError(
        "ENTITY_RECIPIENT_BINDING_MISSING",
        "Transfer recipient resolution evidence is missing.",
      );
    }
    const resolvedRecipient = getAddress(recipient.resolvedAddress);
    if (rawResult.isNativeIn === true) {
      const target = getAddress(String(rawResult.targetContract || rawResult.target));
      if (!sameAddress(target, resolvedRecipient)) {
        throw new IntentResponseError(
          "ENTITY_RECIPIENT_BINDING_MISMATCH",
          "Native transfer target does not match the resolved recipient.",
        );
      }
    } else {
      const calldata = checkedCalldata(rawResult.calldata, "transfer.calldata");
      if (!sameAddress(decodedErc20TransferRecipient(calldata), resolvedRecipient)) {
        throw new IntentResponseError(
          "ENTITY_RECIPIENT_BINDING_MISMATCH",
          "ERC-20 transfer calldata does not match the resolved recipient.",
        );
      }
    }
  }
  const allowedApprovalTokens = new Set(
    assets.flatMap((asset) =>
      typeof asset.address === "string"
        ? [getAddress(asset.address).toLowerCase()]
        : [],
    ),
  );
  for (const approval of allRawApprovals) {
    if (!isRecord(approval) || typeof approval.token !== "string") {
      continue;
    }
    const approvalToken = getAddress(approval.token).toLowerCase();
    if (!allowedApprovalTokens.has(approvalToken)) {
      throw new IntentResponseError(
        "ENTITY_APPROVAL_BINDING_MISMATCH",
        "Approval token does not match any transaction entity in the resolution evidence.",
      );
    }
  }
}
