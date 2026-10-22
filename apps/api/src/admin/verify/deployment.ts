/**
 * Server-side verification of a browser deploy. The client
 * never marks a record verified: every check reads the chain.
 *
 * "verified" means correct AND admin-controlled: the effective owner/admin
 * (owner() with no pending owner, or the owner/creator constructor argument)
 * must be an allowlisted admin EVM wallet, the network profile's owner, or a
 * Safe whose on-chain getOwners() include an allowlisted admin wallet. A
 * record that passes every other check but not that one is "foreign": never
 * exported for pinning, never a dependency.
 */
import type {
  AdminConstructorInput,
  AdminContractId,
  AdminContractSpec,
  AdminDeployTarget,
  AdminDeploymentRecord,
  AdminEvmNetwork,
  AdminVerificationCheck,
} from "@kletia/core";
import {
  encodeAbiParameters,
  getAddress,
  isAddress,
  keccak256,
  type AbiParameter,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { randomHex } from "../../platform/http/secrets.js";
import {
  chainIdOf,
  dependencyCandidates,
  networkConstant,
  profileOwner,
  specOf,
  targetById,
  targetSatisfied,
} from "../catalog.js";
import { getArtifact, isDeployable, type DeployableArtifact } from "../contract-artifacts/index.js";
import type { AdminDeps, AdminSessionContext } from "../deps.js";
import { AdminHttpError, invalidRequest } from "../http/errors.js";
import type { AdminStore } from "../store/types.js";
import { EMPTY_CODEHASH, hasFunction, ownerKindOf, receiptOrPending, rpc, transactionOrPending, tryRead, ZERO_ADDRESS } from "./chain.js";
import { maskedRuntimeHash } from "./mask.js";

export interface RecordRequestBody {
  readonly targetId: string;
  readonly txHash: string;
  readonly constructorArgs: Readonly<Record<string, string>>;
  readonly notes?: string;
  readonly import?: boolean;
}

type CheckId = AdminVerificationCheck["id"];

class Checks {
  readonly list: AdminVerificationCheck[] = [];
  add(id: CheckId, ok: boolean, detail: string): void {
    this.list.push({ id, ok, detail });
  }
  get ok(): boolean {
    return this.list.every((check) => check.ok);
  }
}

const MIN_CONFIRMATIONS: Partial<Record<AdminEvmNetwork, bigint>> = { ethereum: 2n };

function constructorInputsOf(artifact: DeployableArtifact): readonly AbiParameter[] {
  const constructor = artifact.abi.find((item) => item.type === "constructor");
  return constructor && constructor.type === "constructor" ? constructor.inputs : [];
}

/** Normalized constructor args (checksummed addresses, decimal integers) by ABI input name. */
export function normalizeConstructorArgs(inputs: readonly AbiParameter[], raw: Readonly<Record<string, string>>): { values: unknown[]; normalized: Record<string, string> } {
  const names = inputs.map((input) => input.name ?? "");
  const extra = Object.keys(raw).filter((key) => !names.includes(key));
  if (extra.length > 0) throw invalidRequest(`Unknown constructor arguments: ${extra.join(", ")}.`);
  const values: unknown[] = [];
  const normalized: Record<string, string> = {};
  for (const input of inputs) {
    const name = input.name ?? "";
    const value = raw[name];
    if (typeof value !== "string") throw invalidRequest(`Constructor argument ${name} is missing.`);
    if (input.type === "address") {
      if (!isAddress(value, { strict: false })) throw invalidRequest(`Constructor argument ${name} must be an address.`);
      const address = getAddress(value);
      values.push(address);
      normalized[name] = address;
    } else if (/^uint(\d+)$/u.test(input.type)) {
      if (!/^(0|[1-9]\d{0,77})$/u.test(value)) throw invalidRequest(`Constructor argument ${name} must be a decimal integer.`);
      const bits = Number(/^uint(\d+)$/u.exec(input.type)?.[1] ?? "256");
      const parsed = BigInt(value);
      if (parsed >= 1n << BigInt(bits)) throw invalidRequest(`Constructor argument ${name} does not fit ${input.type}.`);
      values.push(parsed);
      normalized[name] = parsed.toString();
    } else if (input.type === "string") {
      if (value.length > 200) throw invalidRequest(`Constructor argument ${name} is too long.`);
      values.push(value);
      normalized[name] = value;
    } else {
      throw invalidRequest(`Constructor argument type ${input.type} is not supported by the panel.`);
    }
  }
  return { values, normalized };
}

/** Catalog rules on args: constants, dependencies, literal bounds, session address. Returns problems (empty when fine). */
async function argRuleProblems(
  store: AdminStore, network: AdminEvmNetwork, specInputs: readonly AdminConstructorInput[], args: Readonly<Record<string, string>>,
): Promise<string[]> {
  const problems: string[] = [];
  for (const input of specInputs) {
    const value = args[input.name];
    if (value === undefined) {
      problems.push(`${input.name} is not a constructor input of the artifact.`);
      continue;
    }
    const source = input.source;
    switch (source.kind) {
      case "network-constant": {
        const expected = networkConstant(network, source.key);
        if (!expected || expected.toLowerCase() !== value.toLowerCase()) problems.push(`${input.name} must be the pinned ${source.key} ${expected ?? "(none on this network)"}.`);
        break;
      }
      case "dependency": {
        const candidates = await dependencyCandidates(store, network, source.contractId, source.instance);
        if (!candidates.some((candidate) => candidate.toLowerCase() === value.toLowerCase())) {
          problems.push(`${input.name} must be a pinned or verified ${source.contractId} on ${network}.`);
        }
        break;
      }
      case "literal": {
        if (!source.editable && value !== source.value) problems.push(`${input.name} must be ${source.value}.`);
        if (input.type !== "string" && input.type !== "address") {
          const parsed = BigInt(value);
          if (source.min !== undefined && parsed < BigInt(source.min)) problems.push(`${input.name} must be at least ${source.min}.`);
          if (source.max !== undefined && parsed > BigInt(source.max)) problems.push(`${input.name} must be at most ${source.max}.`);
        }
        break;
      }
      case "session-address": {
        // An owner/creator role (KletiaToken is Ownable(creator)): checked by
        // admin_control, so a stranger here makes the record "foreign" (fresh
        // deploy or import alike), never "verified".
        break;
      }
      case "role": {
        if (value.toLowerCase() === ZERO_ADDRESS) problems.push(`${input.name} must not be the zero address.`);
        break;
      }
    }
  }
  return problems;
}

type ExpectedRead = readonly [fn: string, args: readonly unknown[], expected: string | boolean];

function roleReadsFor(contractId: AdminContractId, args: Readonly<Record<string, string>>): ExpectedRead[] {
  const forwarder = args.trustedForwarder;
  const trusted: ExpectedRead[] = forwarder ? [["isTrustedForwarder", [forwarder], true]] : [];
  switch (contractId) {
    case "intent-router-v2":
      return [
        ["guardian", [], args.initialGuardian ?? ""], ["treasury", [], args.initialTreasury ?? ""],
        ["wrappedNative", [], args.wrappedNative_ ?? ""], ["feeBps", [], args.initialFeeBps ?? ""], ["paused", [], false],
      ];
    case "launch-factory-v2":
      return [["treasury", [], args.initialTreasury ?? ""], ["deploymentFee", [], "0"]];
    case "x402-attestation-registry-v1":
      return [["guardian", [], args.initialGuardian ?? ""]];
    case "uniswap-v2-adapter":
      return [["target", [], args.router_ ?? ""], ["factory", [], args.factory_ ?? ""], ["wrappedNative", [], args.wrappedNative_ ?? ""]];
    case "arc-vault-v2":
      return [["guardian", [], args.initialGuardian ?? ""], ["apyBps", [], args.initialApyBps ?? ""], ...trusted];
    case "arc-staking":
      return [["aprBps", [], args._aprBps ?? ""], ["cooldownPeriod", [], args._cooldownPeriod ?? ""], ...trusted];
    case "arc-batch-pay":
      return [["maxRecipientsPerBatch", [], args._maxRecipients ?? ""], ...trusted];
    case "arc-swap":
      return [["token", [], args._token ?? ""], ...trusted];
    case "arc-lending":
      return [["kletToken", [], args._kletToken ?? ""], ["swapPool", [], args._swapPool ?? ""], ...trusted];
    case "arc-memo-transfer":
    case "arc-agent-registry":
      return trusted;
    default:
      return [];
  }
}

function sameValue(actual: unknown, expected: string | boolean): boolean {
  if (typeof expected === "boolean") return actual === expected;
  if (typeof actual === "string" && /^0x[0-9a-fA-F]{40}$/u.test(actual)) return actual.toLowerCase() === expected.toLowerCase();
  if (typeof actual === "bigint" || typeof actual === "number") return actual.toString() === expected;
  return String(actual) === expected;
}

/** Owner argument for constructor-role contracts: the input whose source is role owner. */
function ownerArgOf(spec: AdminContractSpec, args: Readonly<Record<string, string>>): string | null {
  const input = spec.constructorInputs.find((entry) => entry.source.kind === "role" && entry.source.role === "owner");
  return input ? (args[input.name] ?? null) : null;
}

/** Who counts as admin control on one network (see the module comment). */
export interface AdminControl {
  /** Lower-cased allowlisted admin EVM wallets. */
  readonly admins: ReadonlySet<string>;
  /** The network profile's owner (saved, else the catalog default), or null. */
  readonly profileOwner: string | null;
}

export async function adminControlOf(deps: AdminDeps, network: AdminEvmNetwork): Promise<AdminControl> {
  return { admins: new Set([...deps.config().evmAddresses].map((address) => address.toLowerCase())), profileOwner: await profileOwner(deps.store(), network) };
}

/** Why `controller` is admin-controlled, or null when it is not. Reads getOwners() of a Safe. */
async function adminControlReason(client: PublicClient, network: AdminEvmNetwork, controller: string, control: AdminControl): Promise<string | null> {
  const lower = controller.toLowerCase();
  if (lower === ZERO_ADDRESS) return null;
  if (control.admins.has(lower)) return "an allowlisted admin wallet";
  if (control.profileOwner && control.profileOwner.toLowerCase() === lower) return `the ${network} profile owner`;
  const kind = await ownerKindOf(client, network, controller);
  const admin = kind.kind === "safe" ? kind.safe?.owners.find((owner) => control.admins.has(owner.toLowerCase())) : undefined;
  return admin ? `a Safe with admin owner ${admin}` : null;
}

/** The admin_control check: the effective owner/admin of the contract is controlled by an admin. */
async function adminControlCheck(
  client: PublicClient, network: AdminEvmNetwork, spec: AdminContractSpec, artifact: DeployableArtifact,
  address: string, args: Readonly<Record<string, string>>, expectedOwner: string | null, control: AdminControl,
): Promise<AdminVerificationCheck> {
  const check = (ok: boolean, detail: string): AdminVerificationCheck => ({ id: "admin_control", ok, detail });
  let controller: string | null;
  if (spec.ownerSource !== "none") {
    // The owner check already compares owner() with this address and requires no pending owner.
    controller = expectedOwner;
    if (!controller) return check(false, "The owner is unknown.");
  } else {
    const creator = spec.constructorInputs.find((input) => input.source.kind === "session-address");
    if (hasFunction(artifact.abi, "owner")) {
      const owner = await tryRead(client, network, address, artifact.abi, "owner");
      if (!owner.ok || typeof owner.value !== "string") return check(false, "owner() is unreadable.");
      controller = getAddress(owner.value);
      if (hasFunction(artifact.abi, "pendingOwner")) {
        const pending = await tryRead(client, network, address, artifact.abi, "pendingOwner");
        if (!pending.ok || typeof pending.value !== "string" || pending.value.toLowerCase() !== ZERO_ADDRESS) {
          return check(false, `pendingOwner() is ${pending.ok ? String(pending.value) : "unreadable"}; an ownership transfer is open.`);
        }
      }
    } else if (creator) {
      controller = args[creator.name] ?? null;
      if (!controller) return check(false, `${creator.name} is missing.`);
    } else {
      return check(true, "No owner or admin role to control.");
    }
  }
  const reason = await adminControlReason(client, network, controller, control);
  return reason
    ? check(true, `Owner ${controller} is ${reason}.`)
    : check(false, `Owner ${controller} is not an allowlisted admin wallet, the ${network} profile owner or a Safe with an admin owner. Recorded as foreign.`);
}

/** verified when every check passes; foreign when only admin_control fails; else verification_failed. */
export function statusFromChecks(checks: readonly AdminVerificationCheck[]): "verified" | "foreign" | "verification_failed" {
  const failed = checks.filter((check) => !check.ok);
  if (failed.length === 0) return "verified";
  return failed.every((check) => check.id === "admin_control") ? "foreign" : "verification_failed";
}

export interface PostDeployResult {
  readonly checks: AdminVerificationCheck[];
  readonly onchainCodehash: string;
  readonly ownerKind: AdminDeploymentRecord["ownerKind"];
  readonly expectedOwner: string | null;
}

/** Checks 7-11 (runtime code, owner, role reads, owner kind, admin control) at the latest block. Shared with reverify. */
export async function postDeployChecks(
  client: PublicClient, network: AdminEvmNetwork, spec: AdminContractSpec, artifact: DeployableArtifact,
  address: string, args: Readonly<Record<string, string>>, deployer: string, control: AdminControl,
): Promise<PostDeployResult> {
  const checks = new Checks();
  const code = await rpc(network, () => client.getCode({ address: address as Address }));
  const runtime = (code ?? "0x") as Hex;
  const onchainCodehash = runtime === "0x" ? EMPTY_CODEHASH : keccak256(runtime);
  const masked = runtime === "0x" ? null : maskedRuntimeHash(runtime, artifact.immutableReferences);
  checks.add("runtime_code", masked === artifact.maskedRuntimeHash,
    masked === artifact.maskedRuntimeHash ? "Runtime code equals the artifact (immutables masked)." : runtime === "0x" ? "No code at the address." : "Runtime code differs from the artifact.");

  let expectedOwner: string | null = null;
  if (spec.ownerSource === "none") {
    checks.add("owner", true, "This contract has no owner check.");
  } else {
    expectedOwner = spec.ownerSource === "deployer" ? getAddress(deployer) : ownerArgOf(spec, args);
    const owner = await tryRead(client, network, address, artifact.abi, "owner");
    const ownerOk = owner.ok && typeof owner.value === "string" && expectedOwner !== null && owner.value.toLowerCase() === expectedOwner.toLowerCase();
    let pendingOk = true;
    if (hasFunction(artifact.abi, "pendingOwner")) {
      const pending = await tryRead(client, network, address, artifact.abi, "pendingOwner");
      pendingOk = pending.ok && typeof pending.value === "string" && pending.value.toLowerCase() === ZERO_ADDRESS;
    }
    checks.add("owner", ownerOk && pendingOk,
      !ownerOk ? `owner() is ${owner.ok ? String(owner.value) : "unreadable"}, expected ${expectedOwner ?? "unknown"}.` : !pendingOk ? "pendingOwner() is set." : `owner() is ${expectedOwner}.`);
  }

  const expectations = roleReadsFor(spec.id, args);
  const failures: string[] = [];
  for (const [fn, fnArgs, expected] of expectations) {
    const result = await tryRead(client, network, address, artifact.abi, fn, fnArgs);
    if (!result.ok || !sameValue(result.value, expected)) failures.push(`${fn}() is ${result.ok ? String(result.value) : "unreadable"}, expected ${String(expected)}`);
  }
  checks.add("role_reads", failures.length === 0, failures.length === 0 ? (expectations.length === 0 ? "No role reads for this contract." : `${expectations.length} role reads match.`) : `${failures.join("; ")}.`);

  let ownerKind: AdminDeploymentRecord["ownerKind"] = "none";
  if (expectedOwner) ownerKind = (await ownerKindOf(client, network, expectedOwner)).kind;
  const controlCheck = await adminControlCheck(client, network, spec, artifact, address, args, expectedOwner, control);
  checks.add(controlCheck.id, controlCheck.ok, controlCheck.detail);
  return { checks: checks.list, onchainCodehash, ownerKind, expectedOwner };
}

function deployableArtifactOf(spec: AdminContractSpec): DeployableArtifact {
  const artifact = getArtifact(spec.artifactId);
  if (!isDeployable(artifact)) throw new AdminHttpError(422, "ADMIN_TARGET_NOT_DEPLOYABLE", `${spec.name} has no deployable artifact.`);
  return artifact;
}

export interface RecordOutcome {
  readonly record: AdminDeploymentRecord;
  readonly created: boolean;
}

/** POST /deployments: verifies the creation transaction and stores the record (verified, foreign or verification_failed). */
export async function recordDeployment(deps: AdminDeps, session: AdminSessionContext, body: RecordRequestBody): Promise<RecordOutcome> {
  const store = deps.store();
  const target: AdminDeployTarget | null = targetById(body.targetId);
  if (!target) throw new AdminHttpError(404, "ADMIN_NOT_FOUND", `Unknown target ${body.targetId}.`);
  if (target.status === "quarantined" || target.status === "legacy" || target.status === "not-applicable") {
    throw new AdminHttpError(422, "ADMIN_TARGET_NOT_DEPLOYABLE", `${target.id} is ${target.status}: ${target.reason}`);
  }
  const spec = specOf(target.contractId);
  const artifact = deployableArtifactOf(spec);
  const network = target.network;
  const chainId = chainIdOf(network);
  const txHash = body.txHash.toLowerCase() as Hex;

  const existing = await store.findDeploymentByTx(chainId, txHash);
  if (existing) {
    if (existing.targetId !== target.id) throw new AdminHttpError(409, "ADMIN_RECORD_CONFLICT", "This transaction is recorded for another target.");
    return { record: existing, created: false };
  }
  for (const dependency of target.dependsOn) {
    if (!(await targetSatisfied(store, dependency))) {
      throw new AdminHttpError(409, "ADMIN_DEPENDENCY_MISSING", `Deploy and verify ${dependency} first.`, { dependency });
    }
  }
  const { values, normalized } = normalizeConstructorArgs(constructorInputsOf(artifact), body.constructorArgs);

  const client = deps.client(network);
  const checks = new Checks();
  const rpcChainId = await rpc(network, () => client.getChainId());
  if (rpcChainId !== chainId) {
    throw new AdminHttpError(502, "ADMIN_RPC_UNAVAILABLE", `The ${network} RPC answers chain id ${rpcChainId}, expected ${chainId}.`, { network });
  }
  checks.add("chain", true, `Chain id ${chainId}.`);
  const receipt = await receiptOrPending(client, network, txHash);
  const tip = await rpc(network, () => client.getBlockNumber());
  const needed = MIN_CONFIRMATIONS[network] ?? 1n;
  if (tip - receipt.blockNumber < needed) {
    throw new AdminHttpError(409, "ADMIN_TX_PENDING", "Waiting for confirmations. Retry in a moment.", { txHash, block: receipt.blockNumber.toString() });
  }
  if (receipt.status !== "success") {
    checks.add("tx_success", false, "The transaction reverted.");
    throw new AdminHttpError(422, "ADMIN_INVALID_REQUEST", "The deployment transaction reverted; nothing was recorded.", { checks: checks.list });
  }
  checks.add("tx_success", true, `Mined in block ${receipt.blockNumber}.`);
  checks.add("confirmations", true, `${(tip - receipt.blockNumber + 1n).toString()} confirmations.`);
  const tx = await transactionOrPending(client, network, txHash);
  if (tx.to !== null || !receipt.contractAddress) {
    checks.add("creation", false, "Not a contract creation (to is set).");
    throw new AdminHttpError(422, "ADMIN_INVALID_REQUEST", "Only a direct contract creation from a wallet can be recorded.", { checks: checks.list });
  }
  const address = getAddress(receipt.contractAddress);
  checks.add("creation", true, `Created ${address}.`);

  const clash = await store.findDeploymentByAddress(chainId, address);
  if (clash) throw new AdminHttpError(409, "ADMIN_RECORD_CONFLICT", "This address is already recorded with another transaction.");

  const deployer = getAddress(tx.from);
  const deployerOk = body.import === true || session.actors.some((actor) => actor.toLowerCase() === deployer.toLowerCase());
  checks.add("deployer", deployerOk, deployerOk
    ? `Deployed by ${deployer}${body.import ? " (import)" : ""}.`
    : `Deployed by ${deployer}, not by ${session.record.walletKind === "solana" ? "an admin EVM wallet" : "the signed-in wallet"}. Use import for deploys made outside the panel.`);

  const input = tx.input.toLowerCase();
  const bytecode = artifact.bytecode.toLowerCase();
  checks.add("init_code", input.startsWith(bytecode), input.startsWith(bytecode) ? "Init code equals the artifact." : "Init code differs from the artifact.");
  const encoded = encodeAbiParameters(constructorInputsOf(artifact), values).toLowerCase();
  const tail = input.startsWith(bytecode) ? `0x${input.slice(bytecode.length)}` : null;
  const ruleProblems = await argRuleProblems(store, network, spec.constructorInputs, normalized);
  const argsOk = tail === encoded && ruleProblems.length === 0;
  checks.add("constructor_args", argsOk, tail !== encoded ? "Encoded constructor arguments differ from the request." : ruleProblems.length > 0 ? ruleProblems.join(" ") : "Constructor arguments match.");

  const post = await postDeployChecks(client, network, spec, artifact, address, normalized, deployer, await adminControlOf(deps, network));
  const all = [...checks.list, ...post.checks];
  const now = deps.now().toISOString();
  const record: AdminDeploymentRecord = {
    id: `dep_${randomHex(12)}`, targetId: target.id, network, chainId, contractId: target.contractId,
    ...(target.instance ? { instance: target.instance } : {}),
    address, txHash, block: receipt.blockNumber.toString(), deployer, constructorArgs: normalized,
    ownerKind: post.ownerKind, expectedOwner: post.expectedOwner, artifactId: spec.artifactId,
    artifactMaskedRuntimeHash: artifact.maskedRuntimeHash, onchainCodehash: post.onchainCodehash, checks: all,
    status: statusFromChecks(all), wired: false,
    notes: (body.notes ?? "").slice(0, 500), createdBy: session.actor, createdAt: now, updatedAt: now,
  };
  await store.insertDeployment(record);
  return { record, created: true };
}

/** POST /deployments/:id/reverify: reruns checks 7-10 against the latest block. */
export async function reverifyDeployment(deps: AdminDeps, record: AdminDeploymentRecord): Promise<AdminDeploymentRecord> {
  const spec = specOf(record.contractId);
  const artifact = deployableArtifactOf(spec);
  const post = await postDeployChecks(
    deps.client(record.network), record.network, spec, artifact, record.address, record.constructorArgs, record.deployer, await adminControlOf(deps, record.network),
  );
  const replaced = new Set(post.checks.map((check) => check.id));
  const checks = [...record.checks.filter((check) => !replaced.has(check.id)), ...post.checks];
  // A record from before admin_control existed gains the check here (and may become foreign).
  const status = record.status === "archived" || record.status === "superseded" ? record.status : statusFromChecks(checks);
  return {
    ...record, checks, status, onchainCodehash: post.onchainCodehash, ownerKind: post.ownerKind, expectedOwner: post.expectedOwner,
    updatedAt: deps.now().toISOString(),
  };
}
