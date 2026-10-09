/**
 * What the user reviews before signing a call or action step
 * (`ContractReview`): who (integrator, domain verification), what (label,
 * function, decoded arguments with their source), permissions (exact
 * approvals), result (simulated asset changes, network fee), provenance
 * (Sourcify / OtterSec status, proxy and implementation, programs and their
 * upgrade authorities) and the fixed "Not audited by Kletia" notice.
 */
import {
  CHAINS,
  CONTRACT_REVIEW_NOTICE,
  contractActionInput,
  explorerAddressUrl,
  nativeAssetId,
  parseAccountId,
  resolveContractParams,
  toBaseUnits,
  validateContractTestRequest,
  type ContractTestRequest,
  type ContractTestResult,
  type ContractTestTransaction,
  type EvmContractAction,
  type SolanaActionEndpoint,
  type AssetAmount,
  type ContractReview,
  type ContractReviewApproval,
  type ContractReviewArg,
  type ContractReviewProgram,
  type NetworkKey,
  type SolanaProgramPin,
  type SourceVerificationStatus,
} from "@kletia/core";
import { PlatformError, unsupported } from "../../errors.js";
import type { AdapterAction, ContractCallSnapshot } from "../adapters/types.js";
import { assetFromRef, resolveAsset } from "../assets.js";
import { testEvmCall } from "../adapters/contractCall.js";
import { testSolanaAction } from "../adapters/solanaAction.js";
import { assertContractAmount } from "./caps.js";
import { contractDirectory, contractsEnabled, type RegisteredContract } from "./directory.js";
import { evmOutputToken, evmSnapshot, solanaSnapshot } from "./snapshot.js";

/** Integrator identity with the freshest domain status available. */
function integratorOf(snapshot: ContractCallSnapshot, registration?: RegisteredContract): ContractReview["integrator"] {
  return {
    name: snapshot.integrator.name,
    ...(snapshot.integrator.website ? { website: snapshot.integrator.website } : {}),
    domainVerified: registration ? registration.verification.domain.verified : snapshot.integrator.domainVerified,
  };
}

function shortAddress(value: string): string {
  return value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}

export interface EvmReviewInput {
  readonly snapshot: ContractCallSnapshot;
  readonly registration?: RegisteredContract;
  readonly network: NetworkKey;
  readonly args: readonly ContractReviewArg[];
  readonly value?: AssetAmount;
  readonly approvals: readonly ContractReviewApproval[];
  readonly simulation: ContractReview["simulation"];
  /** Set when the result goes to a third party (entries with `recipient: "any"`). */
  readonly thirdPartyRecipient?: string;
}

/** Review of an EVM call step. */
export function evmCallReview(input: EvmReviewInput): ContractReview {
  const { snapshot, registration } = input;
  const integrator = integratorOf(snapshot, registration);
  const verification = registration?.verification;
  const source: SourceVerificationStatus = verification?.source?.status ?? snapshot.review?.contract?.source ?? "unknown";
  const proxy = snapshot.pins?.proxy ?? null;
  const implementationSource: SourceVerificationStatus = verification?.implementationSource?.status ?? snapshot.review?.contract?.proxy?.implementationSource ?? "unknown";
  const notices = [CONTRACT_REVIEW_NOTICE];
  if (source === "unverified" || source === "unknown") notices.push("The contract's source code is not verified on Sourcify.");
  if (proxy) {
    notices.push(`This contract is a proxy (${proxy.kind}); Kletia pinned its implementation ${shortAddress(proxy.implementation)} and refuses the step if it changes.`);
    if (implementationSource === "unverified" || implementationSource === "unknown") notices.push("The proxy's implementation source code is not verified on Sourcify.");
  }
  if (!integrator.domainVerified) notices.push(`${integrator.name}'s domain is not verified.`);
  if (input.thirdPartyRecipient) notices.push(`The result goes to ${input.thirdPartyRecipient}, not to your account.`);
  for (const arg of input.args) {
    if (arg.source === "literal" && arg.type === "address" && !/^0x0{40}$/iu.test(arg.display)) {
      notices.push(`${arg.name} is a fixed address set by ${integrator.name} (${shortAddress(arg.display)}).`);
    }
  }
  const target = snapshot.target;
  return {
    kind: "evm-call",
    integrator,
    notices,
    contract: {
      network: input.network,
      address: target,
      explorerUrl: explorerAddressUrl(input.network, target),
      source,
      ...(proxy ? { proxy: { kind: proxy.kind, implementation: proxy.implementation, implementationSource } } : {}),
      registeredAt: registration?.createdAt ?? snapshot.review?.contract?.registeredAt ?? "",
      revision: snapshot.revision,
    },
    call: {
      label: snapshot.label ?? snapshot.entry,
      function: snapshot.fragment ? displaySignature(snapshot.fragment) : snapshot.function ?? "",
      args: input.args,
      ...(input.value ? { value: input.value } : {}),
    },
    approvals: input.approvals,
    simulation: input.simulation,
  };
}

function displaySignature(fragment: NonNullable<ContractCallSnapshot["fragment"]>): string {
  return `${fragment.name}(${fragment.inputs.map((input) => (input.name ? `${input.type} ${input.name}` : input.type)).join(", ")})`;
}

export interface SolanaReviewInput {
  readonly snapshot: ContractCallSnapshot;
  readonly registration?: RegisteredContract;
  readonly url: string;
  readonly title?: string;
  readonly programs: readonly SolanaProgramPin[];
  readonly instructionCount: number;
  readonly simulation: ContractReview["simulation"];
}

/** Review of a Solana Action step. */
export function solanaActionReview(input: SolanaReviewInput): ContractReview {
  const { snapshot, registration } = input;
  const integrator = integratorOf(snapshot, registration);
  let domain = "";
  try {
    domain = new URL(input.url).host;
  } catch {
    domain = snapshot.origin ?? "";
  }
  const statuses = registration?.verification.programs ?? [];
  const programs: ContractReviewProgram[] = input.programs.map((pin) => ({
    id: pin.program,
    verified: statuses.find((entry) => entry.program === pin.program)?.verified ?? null,
    upgradeable: pin.upgradeAuthority !== null,
    upgradeAuthority: pin.upgradeAuthority,
  }));
  const notices = [CONTRACT_REVIEW_NOTICE, `Kletia sent your address to ${domain} to build this transaction.`];
  for (const program of programs) {
    if (program.verified !== true) notices.push(`Program ${shortAddress(program.id)} source is not verified (OtterSec).`);
    if (program.upgradeable && program.upgradeAuthority) notices.push(`Program ${shortAddress(program.id)} is upgradeable by ${shortAddress(program.upgradeAuthority)}.`);
  }
  if (!integrator.domainVerified) notices.push(`${integrator.name}'s domain is not verified.`);
  return {
    kind: "solana-action",
    integrator,
    notices,
    approvals: [],
    action: {
      url: input.url,
      domain,
      ...(input.title ? { title: input.title } : {}),
      programs,
      instructionCount: input.instructionCount,
    },
    simulation: input.simulation,
  };
}

/** A review for a snapshot the planner has not simulated yet (replaced by the adapter). */
export function pendingReview(snapshot: ContractCallSnapshot, at: string): ContractReview {
  return {
    kind: snapshot.vm === "evm" ? "evm-call" : "solana-action",
    integrator: snapshot.integrator,
    notices: [CONTRACT_REVIEW_NOTICE],
    approvals: [],
    simulation: { status: "unavailable", at, assetChanges: [], warnings: ["Not simulated yet."] },
  };
}

/* ------------------------------------------------------------------ test */

/**
 * `POST /v1/contracts/{id}/test` (and the MCP tool): the full plan + prepare
 * pipeline of one entry for an account: fresh pins, deny list, parameters,
 * limits, mandatory simulation (SIMULATION_UNAVAILABLE without an endpoint)
 * and the review. Works while the registration is pending. Never stored and
 * never returns calldata or a transaction to persist. When the account holds
 * less than the amount, EVM simulations credit it through a balance override
 * (and say so in the warnings).
 */
export async function testContractAction(contract: RegisteredContract, request: ContractTestRequest): Promise<ContractTestResult> {
  const validated = validateContractTestRequest(request);
  if (!validated.ok) throw new PlatformError("INVALID_REQUEST", "The contract test request is invalid.", 400, validated.issues);
  if (!contractsEnabled()) throw new PlatformError("CONTRACTS_DISABLED", "Custom contract and Solana Action steps are disabled on this deployment.", 503);
  const body = validated.value;
  const definition = contract.definition;
  const network = definition.network;
  const account = parseAccountId(body.account);
  if (!account || account.chain.key !== network) {
    throw new PlatformError("INVALID_REQUEST", `account must be a CAIP-10 account on ${CHAINS[network].name}.`, 400, [{ path: "account", message: "Wrong network." }]);
  }
  const entry = (definition.actions as readonly (EvmContractAction | SolanaActionEndpoint)[]).find((candidate) => candidate.id === body.entry);
  if (!entry) throw new PlatformError("CONTRACT_ACTION_UNKNOWN", `${contract.id} has no action "${body.entry}".`, 422, [{ path: "entry", message: "Unknown entry." }]);
  const directory = contractDirectory();
  const targets = definition.vm === "evm" ? [definition.address, ...(definition.addresses ?? []).map((item) => item.address)] : definition.programs;
  for (const target of targets) {
    const denied = directory?.denied(network, target) ?? null;
    if (denied) throw new PlatformError("CONTRACT_DENIED", `${target} is ${denied}; Kletia does not call it.`, 422);
  }
  const params = resolveContractParams(entry.params, body.params);
  if (!params.ok) throw new PlatformError("CONTRACT_PARAM_INVALID", "Invalid parameters for this action.", 422, params.issues);
  const descriptor = contractActionInput(network, entry);
  const input = descriptor ? await resolveAsset(network, descriptor.id) : null;
  let amount = "0";
  if (input) {
    if (!body.amount) throw new PlatformError("AMOUNT_REQUIRED", `${entry.label} spends ${input.symbol}: give an amount.`, 400, [{ path: "amount", message: "Required." }]);
    try {
      amount = toBaseUnits(body.amount, input.decimals);
    } catch {
      throw new PlatformError("AMOUNT_INVALID", `${body.amount} ${input.symbol} has more than ${input.decimals} decimal places.`, 422, [{ path: "amount", message: "Too precise." }]);
    }
    await assertContractAmount(entry.limits, input, BigInt(amount), contract.verification.domain.verified, entry.label, "amount");
  } else if (body.amount) {
    throw unsupported(`${entry.label} spends nothing; remove the amount.`, [], [{ path: "amount", message: "This action takes no amount." }]);
  }
  const recipientMode = definition.vm === "evm" ? (entry as EvmContractAction).recipient ?? "account" : "account";
  let recipient = account;
  if (body.recipient) {
    const parsed = parseAccountId(body.recipient.includes(":") ? body.recipient : `${CHAINS[network].id}:${body.recipient}`);
    if (!parsed || parsed.chain.key !== network) throw new PlatformError("INVALID_REQUEST", "recipient must be an address on the registration's network.", 400, [{ path: "recipient", message: "Invalid." }]);
    if (recipientMode !== "any" && parsed.address.toLowerCase() !== account.address.toLowerCase()) {
      throw unsupported(`${entry.label} pays the acting account.`, [], [{ path: "recipient", message: "Third-party recipients are not allowed by this action." }]);
    }
    recipient = parsed;
  }
  const outputToken = definition.vm === "evm" ? evmOutputToken(definition, entry as EvmContractAction) : (entry as SolanaActionEndpoint).output?.mint ?? null;
  const output = outputToken ? await resolveAsset(network, outputToken) : null;
  const pending = contract.activeRevision === null ? { ...contract, activeRevision: 1 } : contract;
  const snapshot = definition.vm === "evm"
    ? evmSnapshot(pending, entry as EvmContractAction, params.values, output)
    : solanaSnapshot(pending, entry as SolanaActionEndpoint, params.values, output);
  const native = CHAINS[network].nativeAsset;
  const placeholder = input ?? assetFromRef({ asset: nativeAssetId(network), symbol: native.symbol, decimals: native.decimals });
  const action: AdapterAction = {
    kind: definition.vm === "evm" ? "call" : "action",
    network,
    destinationNetwork: network,
    input: placeholder,
    output: output ?? placeholder,
    amount,
    account,
    recipient,
    slippageBps: 50,
    call: { snapshot, input, output, registration: contract, funded: false, stage: "test" },
  };
  const now = Date.now();
  if (definition.vm === "evm") {
    const run = await testEvmCall(action, now);
    const transactions: ContractTestTransaction[] = run.transactions.map((transaction) => ({
      description: transaction.description,
      to: transaction.to,
      selector: transaction.data.slice(0, 10),
      value: transaction.value,
    }));
    return {
      contract: contract.id,
      revision: snapshot.revision,
      entry: entry.id,
      network,
      account: account.id,
      ...(run.input ? { input: run.input } : {}),
      ...(run.expectedOutput ? { expectedOutput: run.expectedOutput } : {}),
      ...(run.minimumOutput ? { minimumOutput: run.minimumOutput } : {}),
      transactions,
      ...(run.gas !== null ? { gas: run.gas.toString() } : {}),
      ...(run.feesUsd !== undefined ? { feesUsd: run.feesUsd } : {}),
      review: run.review,
      warnings: run.warnings,
    };
  }
  const run = await testSolanaAction(action, now);
  return {
    contract: contract.id,
    revision: snapshot.revision,
    entry: entry.id,
    network,
    account: account.id,
    ...(run.input ? { input: run.input } : {}),
    ...(run.expectedOutput ? { expectedOutput: run.expectedOutput } : {}),
    ...(run.minimumOutput ? { minimumOutput: run.minimumOutput } : {}),
    transactions: [{ description: `${entry.label} (${definition.integrator.name})`, programs: run.programs }],
    ...(run.feesUsd !== undefined ? { feesUsd: run.feesUsd } : {}),
    review: run.review,
    warnings: run.warnings,
  };
}
