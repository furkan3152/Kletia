/**
 * Parses and validates an EVM contract definition.
 */
import { CHAINS, type NetworkKey } from "../chains.js";
import {
  isChecksumAddressValid,
  isEvmAddress,
  toChecksumAddress,
} from "../caip.js";
import { isBaseUnitAmount, isDecimalAmount, toBaseUnits } from "../amounts.js";
import type { AssetDescriptor } from "../assets.js";
import { CONTRACT_ADDRESS_LABEL_PATTERN, CONTRACT_LIMITS } from "./patterns.js";
import type {
  AbiEventItem,
  AbiFunctionItem,
  AbiParameter,
  ArgBinding,
  ContractAbiItem,
  ContractAddressEntry,
  EventBinding,
  EventWhereBinding,
  EvmActionInput,
  EvmActionOutput,
  EvmActionValue,
  EvmContractAction,
  EvmContractDefinition,
} from "./types.js";
import { forbiddenFunctionReason } from "./forbidden.js";
import { deniedTargetReason } from "./targets.js";
import { abiItemSignature, typeShape } from "./abi.js";
import { isRecord, resolveContractAsset } from "./origins.js";
import {
  type ActionContext,
  checkBinding,
  checkKeys,
  checkPhraseCollisions,
  type ContractValidationOptions,
  intRange,
  isLiteralBinding,
  type IssueList,
  literalProblem,
  parseAbiItem,
  parseCommonAction,
  parseIntegrator,
  parseLimits,
  parseParams,
  parsePhrases,
  parseTolerance,
  parseVisibility,
} from "./issues.js";

/* ------------------------------------------------------------------- EVM */

export function parseEvmDefinition(input: Record<string, unknown>, network: NetworkKey, issues: IssueList, options: ContractValidationOptions): EvmContractDefinition | null {
  checkKeys(input, ["vm", "network", "address", "integrator", "visibility", "abi", "addresses", "actions"], "", issues);
  const mainnet = CHAINS[network].environment === "mainnet";
  const integrator = parseIntegrator(input.integrator, mainnet, issues);
  const visibility = parseVisibility(input.visibility, issues);

  let address: string | null = null;
  if (typeof input.address !== "string" || !isEvmAddress(input.address)) {
    issues.invalid("address", "Must be a 0x address.");
  } else if (!isChecksumAddressValid(input.address)) {
    issues.invalid("address", "The address checksum is wrong (mixed case must be EIP-55).");
  } else {
    const denied = deniedTargetReason(network, input.address, options.denylist);
    if (denied) issues.add("CONTRACT_DENIED", "address", `This address is ${denied}.`);
    address = toChecksumAddress(input.address);
  }

  const addresses: ContractAddressEntry[] = [];
  const labels = new Map<string, string>();
  if (input.addresses !== undefined) {
    if (!Array.isArray(input.addresses) || input.addresses.length > CONTRACT_LIMITS.extraAddresses) {
      issues.invalid("addresses", `Must be a list of at most ${CONTRACT_LIMITS.extraAddresses} { label, address } entries.`);
    } else {
      input.addresses.forEach((entry, index) => {
        const at = `addresses[${index}]`;
        if (!isRecord(entry)) {
          issues.invalid(at, "Must be { label, address }.");
          return;
        }
        checkKeys(entry, ["label", "address"], at, issues);
        const { label, address: entryAddress } = entry;
        if (typeof label !== "string" || !CONTRACT_ADDRESS_LABEL_PATTERN.test(label) || label === "self") {
          issues.invalid(`${at}.label`, `Must match ${CONTRACT_ADDRESS_LABEL_PATTERN.source} (not "self").`);
          return;
        }
        if (labels.has(label)) {
          issues.invalid(`${at}.label`, "Duplicate label.");
          return;
        }
        if (typeof entryAddress !== "string" || !isEvmAddress(entryAddress) || !isChecksumAddressValid(entryAddress)) {
          issues.invalid(`${at}.address`, "Must be a 0x address (EIP-55 when mixed case).");
          return;
        }
        if ((address && entryAddress.toLowerCase() === address.toLowerCase()) || [...labels.values()].includes(entryAddress.toLowerCase())) {
          issues.invalid(`${at}.address`, "Duplicate address (the target is $self).");
          return;
        }
        const denied = deniedTargetReason(network, entryAddress, options.denylist);
        if (denied) issues.add("CONTRACT_DENIED", `${at}.address`, `This address is ${denied}.`);
        labels.set(label, entryAddress.toLowerCase());
        addresses.push({ label, address: toChecksumAddress(entryAddress) });
      });
    }
  }

  const abi: ContractAbiItem[] = [];
  if (!Array.isArray(input.abi) || input.abi.length === 0 || input.abi.length > CONTRACT_LIMITS.abiItems) {
    issues.invalid("abi", `Must be a list of 1-${CONTRACT_LIMITS.abiItems} ABI items.`);
  } else {
    input.abi.forEach((item, index) => {
      const parsed = parseAbiItem(item, `abi[${index}]`, issues);
      if (parsed) abi.push(parsed);
    });
  }
  const functions = new Map<string, { item: AbiFunctionItem; index: number }>();
  const eventsByName = new Map<string, AbiEventItem[]>();
  const eventsBySignature = new Map<string, AbiEventItem>();
  abi.forEach((item, index) => {
    const signature = abiItemSignature(item);
    if (item.type === "function") {
      if (functions.has(signature)) {
        issues.invalid(`abi[${index}]`, `Duplicate function ${signature}.`);
        return;
      }
      functions.set(signature, { item, index });
      const forbidden = forbiddenFunctionReason(item.name, signature);
      if (forbidden) issues.add("CONTRACT_FUNCTION_FORBIDDEN", `abi[${index}]`, forbidden);
    } else if (item.type === "event") {
      if (eventsBySignature.has(signature)) {
        issues.invalid(`abi[${index}]`, `Duplicate event ${signature}.`);
        return;
      }
      eventsBySignature.set(signature, item);
      eventsByName.set(item.name, [...(eventsByName.get(item.name) ?? []), item]);
    }
  });

  const actions: EvmContractAction[] = [];
  const usedFunctions = new Set<string>();
  const ids = new Set<string>();
  const knownLabel = (reference: unknown): reference is string => reference === "$self" || (typeof reference === "string" && labels.has(reference));
  if (!Array.isArray(input.actions) || input.actions.length === 0 || input.actions.length > CONTRACT_LIMITS.actionsPerRegistration) {
    issues.invalid("actions", `Must be a list of 1-${CONTRACT_LIMITS.actionsPerRegistration} actions.`);
  } else {
    input.actions.forEach((raw, actionIndex) => {
      const at = `actions[${actionIndex}]`;
      if (!isRecord(raw)) {
        issues.invalid(at, "Action must be an object.");
        return;
      }
      checkKeys(raw, ["id", "label", "function", "args", "input", "value", "output", "events", "params", "recipient", "phrases", "limits"], at, issues);
      const common = parseCommonAction(raw, at, ids, issues);

      // function
      const signature = raw.function;
      const resolved = typeof signature === "string" ? functions.get(signature) : undefined;
      if (!resolved) {
        issues.invalid(`${at}.function`, "Must be the canonical signature (name(type,...)) of a function item in abi.");
      } else {
        usedFunctions.add(signature as string);
        const mutability = resolved.item.stateMutability;
        if (mutability === "view" || mutability === "pure") {
          issues.add("CONTRACT_FUNCTION_FORBIDDEN", `${at}.function`, `${resolved.item.name} is read-only (${mutability}); only state-changing functions can be registered.`);
        }
      }

      // input
      let inputAsset: AssetDescriptor | null = null;
      let parsedInput: EvmActionInput | undefined;
      if (raw.input !== undefined) {
        if (!isRecord(raw.input)) issues.invalid(`${at}.input`, "Must be { token, approval }.");
        else {
          checkKeys(raw.input, ["token", "approval"], `${at}.input`, issues);
          inputAsset = typeof raw.input.token === "string" ? resolveContractAsset(network, raw.input.token) : null;
          if (!inputAsset) {
            issues.invalid(`${at}.input.token`, "Use a registry asset on this network (GET /v1/assets): a symbol, a CAIP-19 id, or native.");
          }
          let approval: { spender: string } | undefined;
          if (raw.input.approval !== undefined) {
            const spender = isRecord(raw.input.approval) ? raw.input.approval.spender : undefined;
            if (isRecord(raw.input.approval)) checkKeys(raw.input.approval, ["spender"], `${at}.input.approval`, issues);
            if (!knownLabel(spender)) issues.add("CONTRACT_BINDING_INVALID", `${at}.input.approval.spender`, "Must be $self or a label from addresses.");
            else approval = { spender };
            if (inputAsset && inputAsset.address === null) issues.add("CONTRACT_BINDING_INVALID", `${at}.input.approval`, "Native input needs no approval.");
          }
          if (inputAsset) parsedInput = { token: raw.input.token as string, ...(approval ? { approval } : {}) };
        }
      }
      const inputKind = inputAsset ? (inputAsset.address === null ? "native" : "erc20") : null;

      // output
      let parsedOutput: EvmActionOutput | undefined;
      if (raw.output !== undefined) {
        if (!isRecord(raw.output)) issues.invalid(`${at}.output`, "Must be { token, toleranceBps, rebasing? }.");
        else {
          checkKeys(raw.output, ["token", "toleranceBps", "rebasing"], `${at}.output`, issues);
          const token = raw.output.token;
          const toleranceBps = parseTolerance(raw.output.toleranceBps, `${at}.output.toleranceBps`, issues);
          if (raw.output.rebasing !== undefined && typeof raw.output.rebasing !== "boolean") issues.invalid(`${at}.output.rebasing`, "Must be true or false.");
          // Only `true` is stored, so definitions without the flag keep their definitionHash.
          const rebasing = raw.output.rebasing === true ? { rebasing: true as const } : {};
          if (knownLabel(token)) parsedOutput = { token, toleranceBps, ...rebasing };
          else if (typeof token === "string" && isEvmAddress(token) && isChecksumAddressValid(token) && BigInt(token) > 0xffffn) {
            if (inputAsset?.address && inputAsset.address.toLowerCase() === token.toLowerCase()) {
              issues.invalid(`${at}.output.token`, "The output must differ from the input token (deltas would cancel out).");
            } else parsedOutput = { token: toChecksumAddress(token), toleranceBps, ...rebasing };
          } else {
            issues.invalid(`${at}.output.token`, "Must be $self, a label from addresses, or an ERC-20 address (native outputs cannot be proven from logs).");
          }
        }
      }

      // params
      const params = parseParams(raw.params, `${at}.params`, issues);
      const ctx: ActionContext = {
        issues,
        inputKind,
        hasOutput: parsedOutput !== undefined,
        params: new Map(params.map((param) => [param.name, param])),
        usedParams: new Set(),
        usesAmount: false,
      };

      // args
      const args: ArgBinding[] = [];
      if (!Array.isArray(raw.args)) issues.add("CONTRACT_BINDING_INVALID", `${at}.args`, "Must list one binding per ABI input.");
      else if (resolved) {
        const inputs = resolved.item.inputs;
        if (raw.args.length !== inputs.length) {
          issues.add("CONTRACT_BINDING_INVALID", `${at}.args`, `${resolved.item.name} takes ${inputs.length} arguments; got ${raw.args.length} bindings.`);
        } else {
          raw.args.forEach((binding, index) => {
            checkBinding(binding, inputs[index] as AbiParameter, `${at}.args[${index}]`, ctx, false);
            args.push(binding as ArgBinding);
          });
        }
      }

      // value
      let parsedValue: EvmActionValue | undefined;
      const payable = resolved?.item.stateMutability === "payable";
      if (raw.value !== undefined) {
        if (!isRecord(raw.value)) issues.add("CONTRACT_BINDING_INVALID", `${at}.value`, "Must be { bind, max }.");
        else {
          checkKeys(raw.value, ["bind", "max"], `${at}.value`, issues);
          const { bind, max } = raw.value;
          const maxOk = isBaseUnitAmount(max) && BigInt(max) < 1n << 256n;
          if (!maxOk) issues.add("CONTRACT_BINDING_INVALID", `${at}.value.max`, "Required: the wei cap as a decimal integer string.");
          if (bind === "$amount") {
            if (inputKind !== "native") issues.add("CONTRACT_BINDING_INVALID", `${at}.value.bind`, "$amount as value needs input.token native.");
            else ctx.usesAmount = true;
          } else if (isBaseUnitAmount(bind)) {
            if (maxOk && BigInt(bind) > BigInt(max as string)) issues.add("CONTRACT_BINDING_INVALID", `${at}.value.bind`, "Exceeds value.max.");
            if (inputKind === "native") issues.add("CONTRACT_BINDING_INVALID", `${at}.value.bind`, "A native input is sent as value: bind $amount.");
          } else {
            issues.add("CONTRACT_BINDING_INVALID", `${at}.value.bind`, "Must be $amount or a wei literal.");
          }
          if (resolved && !payable) issues.add("CONTRACT_BINDING_INVALID", `${at}.value`, `${resolved.item.name} is not payable.`);
          if (typeof bind === "string" && maxOk) parsedValue = { bind, max: max as string };
          if (inputAsset && inputKind === "native" && maxOk && isRecord(raw.limits) && isDecimalAmount(raw.limits.maxAmount)) {
            try {
              if (BigInt(toBaseUnits(raw.limits.maxAmount, inputAsset.decimals)) > BigInt(max as string)) {
                issues.add("CONTRACT_BINDING_INVALID", `${at}.limits.maxAmount`, "Exceeds value.max.");
              }
            } catch {
              // reported by parseLimits
            }
          }
        }
      } else if (payable) {
        issues.add("CONTRACT_BINDING_INVALID", `${at}.value`, `${resolved?.item.name} is payable: declare value { bind, max }.`);
      }
      if (inputKind === "native" && (!payable || raw.value === undefined)) {
        issues.add("CONTRACT_BINDING_INVALID", `${at}.input.token`, "A native input needs a payable function with value { bind: \"$amount\", max }.");
      }
      if (inputKind === "erc20" && !ctx.usesAmount && resolved) {
        issues.add("CONTRACT_BINDING_INVALID", `${at}.args`, "An action with an ERC-20 input must bind $amount to an argument (verification decodes the amount from the call).");
      }

      // events
      const events: EventBinding[] = [];
      if (!Array.isArray(raw.events) || raw.events.length === 0 || raw.events.length > CONTRACT_LIMITS.eventsPerAction) {
        issues.add("CONTRACT_BINDING_INVALID", `${at}.events`, `Declare 1-${CONTRACT_LIMITS.eventsPerAction} success events.`);
      } else {
        raw.events.forEach((rawEvent, eventIndex) => {
          const eventAt = `${at}.events[${eventIndex}]`;
          if (!isRecord(rawEvent)) {
            issues.add("CONTRACT_BINDING_INVALID", eventAt, "Must be { event, emitter, where, output }.");
            return;
          }
          checkKeys(rawEvent, ["event", "emitter", "where", "output"], eventAt, issues);
          const reference = rawEvent.event;
          let item: AbiEventItem | undefined;
          if (typeof reference === "string" && reference.includes("(")) item = eventsBySignature.get(reference);
          else if (typeof reference === "string") {
            const candidates = eventsByName.get(reference) ?? [];
            if (candidates.length > 1) {
              issues.add("CONTRACT_BINDING_INVALID", `${eventAt}.event`, `Several events are named ${reference}: use the full signature.`);
              return;
            }
            item = candidates[0];
          }
          if (!item) {
            issues.add("CONTRACT_BINDING_INVALID", `${eventAt}.event`, "Must be the name or canonical signature of an event item in abi.");
            return;
          }
          if (item.anonymous) {
            issues.add("CONTRACT_BINDING_INVALID", `${eventAt}.event`, "Anonymous events cannot prove success.");
            return;
          }
          if (!knownLabel(rawEvent.emitter)) {
            issues.add("CONTRACT_BINDING_INVALID", `${eventAt}.emitter`, "Must be $self or a label from addresses.");
            return;
          }
          if (!isRecord(rawEvent.where) || Object.keys(rawEvent.where).length === 0) {
            issues.add("CONTRACT_BINDING_INVALID", `${eventAt}.where`, "Bind at least one event input to $account or $recipient.");
            return;
          }
          const where = new Map<string, EventWhereBinding>();
          let bindsUser = false;
          for (const [field, binding] of Object.entries(rawEvent.where)) {
            const whereAt = `${eventAt}.where.${field}`;
            const matches = item.inputs.filter((entry) => entry.name === field);
            if (matches.length !== 1) {
              issues.add("CONTRACT_BINDING_INVALID", whereAt, `Not a (unique) input of ${item.name}.`);
              continue;
            }
            const eventInput = matches[0] as AbiParameter;
            const shape = typeShape(eventInput.type);
            if (!shape || shape.dims.length > 0 || shape.base === "tuple" || shape.base === "string" || shape.base === "bytes" || shape.base === "function") {
              issues.add("CONTRACT_BINDING_INVALID", whereAt, `Only address, bool, uint, int and bytesN inputs can be matched (not ${eventInput.type}).`);
              continue;
            }
            if (typeof binding === "string") {
              if (!["$account", "$recipient", "$amount", "$token", "$self"].includes(binding)) {
                issues.add("CONTRACT_BINDING_INVALID", whereAt, "Use $account, $recipient, $amount, $token, $self or { \"literal\": ... }.");
                continue;
              }
              const range = intRange(shape.base);
              const expectsUint = binding === "$amount";
              if (expectsUint ? !(range && !range.signed) : shape.base !== "address") {
                issues.add("CONTRACT_BINDING_INVALID", whereAt, `${binding} cannot match a ${eventInput.type} input.`);
                continue;
              }
              if (binding === "$amount" && !inputKind) issues.add("CONTRACT_BINDING_INVALID", whereAt, "$amount needs an input token.");
              if (binding === "$token" && inputKind !== "erc20") issues.add("CONTRACT_BINDING_INVALID", whereAt, "$token needs an ERC-20 input token.");
              if (binding === "$account" || binding === "$recipient") bindsUser = true;
              where.set(field, binding as EventWhereBinding);
            } else if (isLiteralBinding(binding)) {
              const problem = literalProblem(shape.base, binding.literal);
              if (problem) {
                issues.add("CONTRACT_BINDING_INVALID", whereAt, problem);
                continue;
              }
              where.set(field, { literal: binding.literal });
            } else {
              issues.add("CONTRACT_BINDING_INVALID", whereAt, "Use $account, $recipient, $amount, $token, $self or { \"literal\": ... }.");
            }
          }
          if (!bindsUser) issues.add("CONTRACT_BINDING_INVALID", `${eventAt}.where`, "At least one input must bind $account or $recipient, so an unrelated emission cannot prove success.");
          let output: string | undefined;
          if (rawEvent.output !== undefined) {
            const outputInput = typeof rawEvent.output === "string" ? item.inputs.filter((entry) => entry.name === rawEvent.output) : [];
            const range = outputInput.length === 1 ? intRange((outputInput[0] as AbiParameter).type) : null;
            if (!range || range.signed) issues.add("CONTRACT_BINDING_INVALID", `${eventAt}.output`, "Must name a uint input of the event.");
            else if (!parsedOutput) issues.add("CONTRACT_BINDING_INVALID", `${eventAt}.output`, "Declare the action's output token first.");
            else output = rawEvent.output as string;
          }
          events.push({ event: abiItemSignature(item), emitter: rawEvent.emitter, where: Object.fromEntries(where), ...(output ? { output } : {}) });
        });
      }

      for (const param of params) {
        if (!ctx.usedParams.has(param.name)) issues.invalid(`${at}.params`, `Parameter ${param.name} is never bound.`);
      }
      let recipient: "account" | "any" = "account";
      if (raw.recipient !== undefined) {
        if (raw.recipient !== "account" && raw.recipient !== "any") issues.invalid(`${at}.recipient`, "Must be account or any.");
        else recipient = raw.recipient;
      }
      const phrases = parsePhrases(raw.phrases, `${at}.phrases`, issues);
      const limits = parseLimits(raw.limits, `${at}.limits`, inputAsset, mainnet, issues);
      if (!common || !resolved) return;
      actions.push({
        id: common.id,
        label: common.label,
        function: signature as string,
        args,
        ...(parsedInput ? { input: parsedInput } : {}),
        ...(parsedValue ? { value: parsedValue } : {}),
        ...(parsedOutput ? { output: parsedOutput } : {}),
        events,
        ...(params.length ? { params } : {}),
        recipient,
        ...(phrases ? { phrases } : {}),
        ...(limits && (limits.minAmount || limits.maxAmount) ? { limits } : {}),
      });
    });
  }
  for (const [signature, { index }] of functions) {
    if (!usedFunctions.has(signature)) issues.invalid(`abi[${index}]`, `${signature} is not used by any action: remove it (the ABI is an allowlist).`);
  }
  checkPhraseCollisions(actions, issues);
  if (!integrator || !address) return null;
  return {
    vm: "evm",
    network,
    address,
    integrator,
    visibility,
    abi,
    ...(addresses.length ? { addresses } : {}),
    actions,
  };
}
