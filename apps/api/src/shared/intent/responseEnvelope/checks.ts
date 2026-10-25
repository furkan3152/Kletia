/**
 * Primitive checks shared by every envelope: records, addresses, hex,
 * decimals, calldata, quote expiry and approvals.
 */
import { getAddress, type Address, type Hex } from "viem";
import {
  isNetworkPolicyTargetAllowed,
  isNetworkTargetAllowed,
  type NetworkId,
} from "../../config/networks.js";
import { IntentResponseError, type UnknownRecord } from "./types.js";

export function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function sameAddress(left: Address, right: Address): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

export function sameHex(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

export function hasOnlyKeys(
  record: UnknownRecord,
  expected: ReadonlySet<string>,
): boolean {
  const keys = Object.keys(record);
  return (
    keys.length === expected.size && keys.every((key) => expected.has(key))
  );
}

export function decimalValue(value: unknown, fieldName: string): string {
  if (typeof value === "bigint" && value >= 0n) return value.toString();
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value.toString();
  }
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  throw new IntentResponseError(
    "INVALID_TRANSACTION_VALUE",
    `${fieldName} must be a non-negative integer.`,
  );
}

export function checkedCalldata(
  value: unknown,
  fieldName: string,
  allowEmpty = false,
): Hex {
  if (
    typeof value !== "string" ||
    !(
      (allowEmpty && value === "0x") ||
      /^0x(?:[0-9a-fA-F]{2}){4,}$/.test(value)
    )
  ) {
    throw new IntentResponseError(
      "INVALID_TRANSACTION_CALLDATA",
      `${fieldName} must be valid EVM calldata of at least 4 bytes.`,
    );
  }
  return value as Hex;
}

export function checkedQuoteExpiry(
  value: unknown,
  fallback: number,
  fieldName: string,
): number {
  if (value === undefined || value === null) return fallback;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= Date.now()
  ) {
    throw new IntentResponseError(
      "INVALID_QUOTE_EXPIRY",
      `${fieldName} must be a future millisecond timestamp.`,
    );
  }
  return Math.min(value, fallback);
}

export function checkedAddress(
  network: NetworkId,
  target: string,
  action?: string,
): Address {
  let normalized: Address;
  try {
    normalized = getAddress(target);
  } catch {
    throw new IntentResponseError(
      "INVALID_TRANSACTION_TARGET",
      "Transaction target is not a valid EVM address.",
    );
  }

  if (!isNetworkTargetAllowed(network, normalized, action)) {
    throw new IntentResponseError(
      "TARGET_NOT_ALLOWED",
      `Disallowed transaction target for ${network} network: ${normalized}`,
    );
  }
  return normalized;
}

export function checkedApprovals(
  value: unknown,
  spender: Address,
): Array<
  Record<string, unknown> & {
    token: Address;
    spender: Address;
    amount: string;
  }
> {
  if (!Array.isArray(value)) return [];
  return value.map((approval, index) => {
    if (
      typeof approval !== "object" ||
      approval === null ||
      Array.isArray(approval)
    ) {
      throw new IntentResponseError(
        "INVALID_ROUTE_APPROVAL",
        `route.approvals[${index}] is not a valid approval object.`,
      );
    }
    const record = approval as Record<string, unknown>;
    let token: Address;
    let approvalSpender: Address;
    try {
      token = getAddress(String(record.token));
      approvalSpender = getAddress(String(record.spender));
    } catch {
      throw new IntentResponseError(
        "INVALID_ROUTE_APPROVAL",
        `route.approvals[${index}] does not contain a valid token/spender.`,
      );
    }
    if (approvalSpender !== spender) {
      throw new IntentResponseError(
        "APPROVAL_SPENDER_MISMATCH",
        "Approval spender must match the transaction route target.",
      );
    }
    const amount = decimalValue(
      record.amount,
      `route.approvals[${index}].amount`,
    );
    if (amount === "0") {
      throw new IntentResponseError(
        "INVALID_ROUTE_APPROVAL",
        "Approval with zero amount cannot be added to the transaction plan.",
      );
    }
    return {
      ...record,
      token,
      spender: approvalSpender,
      amount,
    };
  });
}

export function checkedPolicyTargets(
  value: unknown,
  network: NetworkId,
  action: string,
): Address[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) {
    throw new IntentResponseError(
      "INVALID_POLICY_TARGETS",
      "Route internal policy targets must be a valid array.",
    );
  }
  return [
    ...new Map(
      value.map((target) => {
        let checked: Address;
        try {
          checked = getAddress(String(target));
        } catch {
          throw new IntentResponseError(
            "INVALID_POLICY_TARGETS",
            "One of the route internal policy targets is not a valid EVM address.",
          );
        }
        if (!isNetworkPolicyTargetAllowed(network, checked)) {
          throw new IntentResponseError(
            "POLICY_TARGET_NOT_ALLOWED",
            `Disallowed internal policy target for ${network} network: ${checked}`,
          );
        }
        return [checked.toLowerCase(), checked] as const;
      }),
    ).values(),
  ];
}
