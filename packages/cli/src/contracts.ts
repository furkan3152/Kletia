/**
 * `kletia contracts …` and `kletia sessions …`: register your own contracts
 * (EVM functions or Solana Actions) and create sessions for the embed.
 *
 * Like every command, these never prepare, sign or submit a transaction:
 * `contracts test` is a simulation on the API, and definitions are checked
 * locally with `validateContractDefinition` (the API runs the same checks)
 * before anything is sent.
 */
import { open, rm } from "node:fs/promises";
import {
  CHAINS,
  CONTRACT_LIMITS,
  abiItemSignature,
  classifyAbiFunction,
  isBeneficiaryArgName,
  isContractId,
  isSessionId,
  toChecksumAddress,
  validateContractDefinition,
  validateContractTestRequest,
  validateSessionCreateRequest,
  type AbiEventItem,
  type AbiFunctionItem,
  type AbiParameter,
  type ArgBinding,
  type ContractAbiItem,
  type ContractDefinition,
  type ContractInspection,
  type ContractReview,
  type ContractTestResult,
  type ContractView,
  type EventBinding,
  type EvmContractInspectionView,
  type EvmContractPins,
  type NetworkKey,
  type SessionCreateRequest,
  type SessionView,
  type SolanaProgramPin,
  type ValidationIssue,
} from "@kletia/core";
import { KletiaApiError, type ContractWithRevisions } from "@kletia/sdk";
import { listOption, stringOption, UsageError, type OptionSpec } from "./args.js";
import {
  accountId,
  CONFIRM_OPTION,
  EXIT_ERROR,
  EXIT_OK,
  networkKey,
  positional,
  signalOption,
  type Command,
  type CommandContext,
} from "./common.js";
import { amount, table, when, type Printer } from "./output.js";

/* ---------------------------------------------------------------- inputs */

/** Largest JSON file read (definitions are capped at 48 KB by the API). */
const MAX_FILE_BYTES = 256 * 1024;

const FILE_OPTION = {
  file: { type: "string", value: "<path>", description: "JSON file (`-` reads stdin)." },
} as const satisfies Record<string, OptionSpec>;

export async function readJson(context: CommandContext, path: string | undefined): Promise<unknown> {
  if (!path) throw new UsageError("--file <path> is required.", context.usage);
  let text: string;
  if (path === "-") {
    if (!context.io.readStdin) throw new UsageError("stdin is not available; pass --file <path>.", context.usage);
    text = await context.io.readStdin();
  } else {
    let handle;
    try {
      handle = await open(path, "r");
    } catch (error) {
      throw new UsageError(`Cannot read ${path} (${(error as NodeJS.ErrnoException).code ?? "error"}).`, context.usage);
    }
    try {
      if ((await handle.stat()).size > MAX_FILE_BYTES) throw new UsageError(`${path} is larger than ${MAX_FILE_BYTES / 1024} KB.`, context.usage);
      text = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  }
  if (text.length > MAX_FILE_BYTES) throw new UsageError(`The input is larger than ${MAX_FILE_BYTES / 1024} KB.`, context.usage);
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new UsageError(`${path === "-" ? "stdin" : path} is not valid JSON (${error instanceof Error ? error.message : "parse error"}).`, context.usage);
  }
}

function contractId(context: CommandContext): string {
  const id = positional(context, 0);
  if (!isContractId(id)) throw new UsageError(`"${id}" is not a contract id (ct_ followed by 24 hex characters).`, context.usage);
  return id;
}

function sessionId(context: CommandContext): string {
  const id = positional(context, 0);
  if (!isSessionId(id)) throw new UsageError(`"${id}" is not a session id (cs_ followed by 32 hex characters).`, context.usage);
  return id;
}

/**
 * A local check failed: reported like an API error (code, issues, docs
 * link) so scripts handle both the same way, but nothing was sent.
 */
export function refusedLocally(code: string, what: string, issues: readonly ValidationIssue[]): KletiaApiError {
  return new KletiaApiError({
    code,
    message: `${what} (checked locally; nothing was sent).`,
    status: 0,
    issues: issues.map((issue) => ({ path: issue.path, message: issue.message })),
  });
}

/* ---------------------------------------------------------------- output */

function short(value: string): string {
  return value.length > 16 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}

function statusLine(contract: ContractView): string {
  if (contract.status === "pending") return `pending until ${when(contract.activatesAt)}`;
  if (contract.status === "suspended") return `suspended (${contract.suspendedReason ?? "no reason given"})`;
  return contract.pendingRevision !== null ? `active; revision ${contract.pendingRevision} activates ${when(contract.activatesAt)}` : "active";
}

function integratorLine(integrator: ContractView["integrator"]): string {
  const site = integrator.website ? `${integrator.website}, ` : "";
  return `${integrator.name} (${site}${integrator.domainVerified ? "domain verified" : "domain not verified"})`;
}

function sourceLine(contract: ContractView): string {
  const source = contract.verification.source;
  const implementation = contract.verification.implementationSource;
  if (contract.vm === "svm") {
    const programs = contract.verification.programs ?? [];
    return programs.map((program) => `${short(program.program)} ${program.verified === null ? "unknown" : program.verified ? "verified" : "not verified"}`).join(", ") || "-";
  }
  return `${source?.status ?? "unknown"}${implementation ? `, implementation ${implementation.status}` : ""}`;
}

function contractRows(list: readonly ContractView[]): string {
  return table(
    list.map((contract) => [
      contract.id,
      statusLine(contract),
      contract.network,
      contract.address ?? contract.origin ?? "-",
      String(contract.activeRevision ?? "-"),
      sourceLine(contract),
      contract.integrator.domainVerified ? "yes" : "no",
      contract.actions.map((action) => action.id).join(","),
    ]),
    ["contract", "status", "network", "target", "rev", "source", "domain", "actions"],
  );
}

function printContract(print: Printer, contract: ContractWithRevisions): void {
  print.out(`${contract.id}  ${integratorLine(contract.integrator)}`);
  print.out(`status ${statusLine(contract)}  revision ${contract.revision} (active ${contract.activeRevision ?? "-"})  visibility ${contract.visibility}`);
  if (contract.vm === "evm") {
    print.out(`evm on ${contract.network}: ${contract.address ?? "-"}`);
    const evm = Array.isArray(contract.pins) ? null : (contract.pins as EvmContractPins);
    if (evm) {
      const proxy = evm.proxy ? `; ${evm.proxy.kind} proxy → ${evm.proxy.implementation} (code ${short(evm.proxy.implementationCodeHash)})` : "";
      print.out(`pins: code ${short(evm.codeHash)} (${evm.codeSize} bytes) at block ${evm.blockNumber}${proxy}`);
      for (const pinned of evm.addresses) print.out(`  ${pinned.label}: ${pinned.address} (code ${short(pinned.codeHash)})`);
    }
  } else {
    print.out(`solana actions on ${contract.network}: ${contract.origin ?? "-"}`);
    const programs = Array.isArray(contract.pins) ? (contract.pins as readonly SolanaProgramPin[]) : [];
    for (const pin of programs) {
      print.out(`  program ${pin.program}: ${pin.upgradeAuthority ? `upgradeable by ${pin.upgradeAuthority}` : "not upgradeable"}${pin.lastDeploySlot ? `, deployed at slot ${pin.lastDeploySlot}` : ""}`);
    }
  }
  print.out(`source: ${sourceLine(contract)}`);
  print.out("");
  print.out(
    table(
      contract.actions.map((action) => [
        action.id,
        "function" in action ? `${action.function} ${action.selector}` : action.href,
        action.label,
        action.phrases ? `${action.phrases.verbs.join("/")} → ${action.phrases.aliases.join(", ")}` : "-",
      ]),
      ["action", "call", "label", "phrases"],
    ),
  );
  if (contract.revisions && contract.revisions.length > 0) {
    print.out("");
    print.out(`revisions: ${contract.revisions.map((revision) => `${revision.revision} (${when(revision.createdAt)}, ${revision.definitionHash.slice(0, 12)})`).join("; ")}`);
  }
}

const SOURCE_LABELS: Readonly<Record<string, string>> = {
  amount: "your amount",
  account: "your address",
  recipient: "recipient",
  token: "input token",
  self: "the contract",
  minimumOutput: "minimum output",
  deadline: "deadline",
  previousOutput: "previous step's output",
  param: "parameter",
};

/** The review in the order users see it: who, what, permissions, result, provenance, notice. */
export function printReview(print: Printer, review: ContractReview): void {
  print.out(`Who: ${integratorLine(review.integrator)}`);
  if (review.call) {
    print.out(`What: ${review.call.label}`);
    print.out(`  ${review.call.function}${review.contract ? ` on ${review.contract.network} ${review.contract.address}` : ""}`);
    if (review.call.args.length > 0) {
      print.out(
        table(
          review.call.args.map((arg) => [`  ${arg.name || "-"}`, arg.display, SOURCE_LABELS[arg.source] ?? `fixed by ${review.integrator.name}`]),
        ),
      );
    }
    if (review.call.value) print.out(`  sends ${amount(review.call.value.formatted)} ${review.call.value.symbol}`);
  }
  if (review.action) {
    print.out(`What: ${review.action.title ?? review.action.url}`);
    print.out(`  ${review.action.instructionCount} instructions from ${review.action.domain}`);
  }
  print.out("Permissions:");
  if (review.approvals.length === 0) print.out("  no token approvals");
  for (const approval of review.approvals) {
    const existing = approval.existingAllowance ? ` (replaces an allowance of ${amount(approval.existingAllowance.formatted)})` : "";
    print.out(`  allow ${approval.spender} to spend exactly ${amount(approval.amount.formatted)} ${approval.amount.symbol}${existing}`);
  }
  const simulation = review.simulation;
  print.out(`Result (simulation ${simulation.status}${simulation.block ? ` at block ${simulation.block}` : simulation.slot ? ` at slot ${simulation.slot}` : ""}):`);
  for (const change of simulation.assetChanges) {
    // `formatted` is signed by the API ("-100", "+90.6"); older responses may omit the plus.
    const sign = /^[-+]/u.test(change.formatted) ? "" : "+";
    print.out(`  ${sign}${change.formatted} ${change.symbol}${change.listed ? "" : " (unlisted)"}`);
  }
  if (simulation.networkFee) {
    print.out(`  network fee ≈ ${amount(simulation.networkFee.formatted)} ${simulation.networkFee.symbol}${simulation.networkFee.usd !== undefined ? ` ($${simulation.networkFee.usd.toFixed(2)})` : ""}`);
  }
  for (const warning of simulation.warnings) print.out(`  warning: ${warning}`);
  if (review.contract) {
    const proxy = review.contract.proxy ? `; ${review.contract.proxy.kind} proxy → ${review.contract.proxy.implementation} (source ${review.contract.proxy.implementationSource})` : "";
    print.out(`Provenance: source ${review.contract.source}${proxy}; revision ${review.contract.revision}`);
  }
  if (review.action) {
    for (const program of review.action.programs) {
      print.out(`Provenance: program ${program.id} ${program.verified === null ? "unknown" : program.verified ? "verified" : "not verified"}${program.upgradeable ? `, upgradeable by ${program.upgradeAuthority ?? "?"}` : ""}`);
    }
  }
  for (const notice of review.notices) print.out(`Notice: ${notice}`);
}

function printTest(print: Printer, result: ContractTestResult): void {
  print.out(`Test of ${result.entry} on ${result.contract} (revision ${result.revision}) for ${result.account}`);
  const input = result.input ? `${amount(result.input.formatted)} ${result.input.symbol}` : "nothing";
  const output = result.expectedOutput
    ? `${amount(result.expectedOutput.formatted)} ${result.expectedOutput.symbol}${result.minimumOutput ? ` (min ${amount(result.minimumOutput.formatted)})` : ""}`
    : "no declared output";
  print.out(`in ${input} → out ${output}`);
  print.out("");
  print.out(
    table(
      result.transactions.map((transaction, index) => [
        String(index + 1),
        transaction.description,
        transaction.to ?? (transaction.programs ?? []).join(","),
        transaction.selector ?? "",
      ]),
      ["tx", "description", "to", "selector"],
    ),
  );
  const costs = [result.gas ? `gas ${result.gas}` : null, result.feesUsd !== undefined ? `fees ≈ $${result.feesUsd.toFixed(2)}` : null].filter(Boolean);
  if (costs.length > 0) print.out(costs.join("  "));
  print.out("");
  printReview(print, result.review);
  for (const warning of result.warnings) print.out(`warning: ${warning}`);
}

function printSession(print: Printer, session: SessionView): void {
  print.out(`${session.id}  ${session.status}  expires ${when(session.expiresAt)}  used ${session.used}/${session.maxIntents}`);
  print.out(`integrator: ${integratorLine(session.integrator)}`);
  print.out(`origins: ${session.allowedOrigins.join(", ")}`);
  if (session.embedUrl) print.out(`embed: ${session.embedUrl}`);
  if (session.amount) {
    print.out(`visitor amount for action ${session.amount.action + 1}: ${session.amount.min}-${session.amount.max}${session.amount.symbol ? ` ${session.amount.symbol}` : ""}${session.amount.default ? ` (default ${session.amount.default})` : ""}`);
  }
  session.actions.forEach((action, index) => {
    const where = action.toNetwork ? `${action.network}→${action.toNetwork}` : action.network;
    print.out(`  ${index + 1}. ${action.kind} on ${where}: ${action.label}${action.amount ? ` (${action.amount}${action.from ? ` ${action.from}` : ""})` : ""}`);
  });
}

/* -------------------------------------------------------------- commands */

const register: Command = {
  name: "contracts register",
  summary: "Register a contract or Solana Action from a JSON definition (checked locally first).",
  args: "--file <definition.json>",
  key: true,
  options: FILE_OPTION,
  positionals: { min: 0, max: 0 },
  run: async (context) => {
    const definition = await readJson(context, stringOption(context.values, "file"));
    const checked = validateContractDefinition(definition);
    if (!checked.ok) throw refusedLocally(checked.code, "The contract definition is invalid", checked.issues);
    // The file as written: the API normalises it the same way and stays the authority across versions.
    const { contract } = await context.client().contracts.register(definition as ContractDefinition, signalOption(context));
    if (context.json) {
      context.print.json(contract);
      return EXIT_OK;
    }
    printContract(context.print, contract);
    context.print.err(`Registered ${contract.id}: ${statusLine(contract)}.`);
    if (contract.integrator.website && !contract.integrator.domainVerified) {
      context.print.err(
        `Verify your domain: serve ${contract.integrator.website}/.well-known/kletia.json containing {"contracts":["${contract.id}"]}, then run \`kletia contracts reverify ${contract.id}\`.`,
      );
    }
    context.print.err(`Try it without signing: kletia contracts test ${contract.id} --entry ${contract.actions[0]?.id ?? "<action>"} --account <account> --amount <amount>`);
    return EXIT_OK;
  },
};

const list: Command = {
  name: "contracts list",
  summary: "Your registrations (and project-visible ones of your project's keys).",
  key: true,
  options: {
    network: { type: "string", value: "<network>", description: "Only this network." },
    vm: { type: "string", value: "evm|svm", description: "Only EVM contracts or Solana Actions." },
    status: { type: "string", value: "pending|active|suspended", description: "Only this status." },
  },
  positionals: { min: 0, max: 0 },
  run: async (context) => {
    const network = stringOption(context.values, "network");
    const vm = stringOption(context.values, "vm");
    const status = stringOption(context.values, "status");
    if (vm !== undefined && vm !== "evm" && vm !== "svm") throw new UsageError("--vm must be evm or svm.", context.usage);
    if (status !== undefined && status !== "pending" && status !== "active" && status !== "suspended") {
      throw new UsageError("--status must be pending, active or suspended.", context.usage);
    }
    const contracts = await context.client().contracts.list(
      {
        ...(network ? { network: networkKey(network, context.usage) } : {}),
        ...(vm ? { vm } : {}),
        ...(status ? { status } : {}),
      },
      signalOption(context),
    );
    if (context.json) context.print.json(contracts);
    else if (contracts.length === 0) context.print.out("No registrations.");
    else context.print.out(contractRows(contracts));
    return EXIT_OK;
  },
};

const get: Command = {
  name: "contracts get",
  summary: "Show a registration: status, pins, source verification, actions and revisions.",
  args: "<contract id>",
  key: true,
  positionals: { min: 1, max: 1 },
  run: async (context) => {
    const contract = await context.client().contracts.get(contractId(context), signalOption(context));
    if (context.json) context.print.json(contract);
    else printContract(context.print, contract);
    return EXIT_OK;
  },
};

const update: Command = {
  name: "contracts update",
  summary: "Change a registration from a JSON patch; security-relevant changes make a new revision (delayed on mainnet).",
  args: "<contract id> --file <patch.json>",
  key: true,
  options: FILE_OPTION,
  positionals: { min: 1, max: 1 },
  run: async (context) => {
    const id = contractId(context);
    const patch = await readJson(context, stringOption(context.values, "file"));
    if (typeof patch !== "object" || patch === null || Array.isArray(patch) || Object.keys(patch).length === 0) {
      throw new UsageError("The patch must be a JSON object with the fields to change, e.g. { \"actions\": [...] }.", context.usage);
    }
    const contract = await context.client().contracts.update(id, patch, signalOption(context));
    if (context.json) context.print.json(contract);
    else {
      printContract(context.print, contract);
      context.print.err(`Updated ${contract.id}: ${statusLine(contract)}.`);
    }
    return EXIT_OK;
  },
};

const remove: Command = {
  name: "contracts delete",
  summary: "Delete a registration; intents planned on it stop preparing.",
  args: "<contract id> --yes",
  key: true,
  options: CONFIRM_OPTION,
  positionals: { min: 1, max: 1 },
  run: async (context) => {
    if (context.values.yes !== true) throw new UsageError("Deleting a registration cannot be undone; pass --yes.", context.usage);
    const id = contractId(context);
    await context.client().contracts.delete(id, signalOption(context));
    if (context.json) context.print.json({ deleted: id });
    else context.print.out(`Deleted ${id}.`);
    return EXIT_OK;
  },
};

function params(context: CommandContext): Record<string, string> | undefined {
  const entries = listOption(context.values, "param");
  if (entries.length === 0) return undefined;
  const out: Record<string, string> = {};
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    const name = separator > 0 ? entry.slice(0, separator).trim() : "";
    if (!name || Object.prototype.hasOwnProperty.call(out, name)) {
      throw new UsageError(`--param takes name=value once per name ("${entry}").`, context.usage);
    }
    out[name] = entry.slice(separator + 1).trim();
  }
  return out;
}

const test: Command = {
  name: "contracts test",
  summary: "Dry-run an action for an account: simulation and the review users will see. Never signs.",
  args: "<contract id> --entry <action> --account <account> [--amount <decimal>]",
  key: true,
  options: {
    entry: { type: "string", value: "<action id>", description: "Action of the registration, e.g. deposit." },
    account: { type: "string", value: "<account>", description: "Account that would sign (CAIP-10 or <network>:<address>)." },
    amount: { type: "string", value: "<decimal>", description: "Amount of the action's input token." },
    param: { type: "string", multiple: true, value: "<name=value>", description: "Action parameter (repeatable)." },
    recipient: { type: "string", value: "<address>", description: "Third-party recipient (actions with recipient \"any\" only)." },
  },
  positionals: { min: 1, max: 1 },
  run: async (context) => {
    const id = contractId(context);
    const entry = stringOption(context.values, "entry");
    const account = stringOption(context.values, "account");
    if (!entry || !account) throw new UsageError("--entry and --account are required.", context.usage);
    const amountValue = stringOption(context.values, "amount");
    const recipient = stringOption(context.values, "recipient");
    const values = params(context);
    const request = {
      entry,
      account: accountId(account, context.usage),
      ...(amountValue !== undefined ? { amount: amountValue } : {}),
      ...(values ? { params: values } : {}),
      ...(recipient !== undefined ? { recipient } : {}),
    };
    const checked = validateContractTestRequest(request);
    if (!checked.ok) {
      throw new UsageError(checked.issues.map((issue) => `${issue.path ? `--${issue.path.split(".")[0]}` : "request"}: ${issue.message}`).join(" "), context.usage);
    }
    const result = await context.client().contracts.test(id, checked.value, signalOption(context));
    if (context.json) context.print.json(result);
    else printTest(context.print, result);
    return result.review.simulation.status === "ok" ? EXIT_OK : EXIT_ERROR;
  },
};

const reverify: Command = {
  name: "contracts reverify",
  summary: "Read the pins and checks again (after an intended upgrade, or once your domain file is up).",
  args: "<contract id>",
  key: true,
  positionals: { min: 1, max: 1 },
  run: async (context) => {
    const contract = await context.client().contracts.reverify(contractId(context), signalOption(context));
    if (context.json) context.print.json(contract);
    else {
      printContract(context.print, contract);
      context.print.err(`Re-verified ${contract.id}: ${statusLine(contract)}.`);
    }
    return EXIT_OK;
  },
};

function inspectQuery(context: CommandContext): { network: NetworkKey; address?: string; programs?: string[] } {
  const raw = stringOption(context.values, "network");
  if (!raw) throw new UsageError("--network is required.", context.usage);
  const network = networkKey(raw, context.usage);
  const address = stringOption(context.values, "address");
  const programs = listOption(context.values, "program");
  if (CHAINS[network].vm === "evm") {
    if (!address || programs.length > 0) throw new UsageError(`--address <0x…> is required on ${network} (--program is for Solana).`, context.usage);
    return { network, address };
  }
  if (programs.length === 0 || address) throw new UsageError(`--program <id> is required on ${network} (repeatable; --address is for EVM networks).`, context.usage);
  return { network, programs };
}

function printInspection(print: Printer, inspection: ContractInspection): void {
  if (inspection.vm === "svm") {
    print.out(
      table(
        inspection.programs.map((entry) => [
          entry.program,
          entry.denied ? `denied: ${entry.denied}` : "allowed",
          entry.pin ? (entry.pin.upgradeAuthority ? `upgradeable by ${entry.pin.upgradeAuthority}` : "not upgradeable") : "not found",
          entry.pin?.lastDeploySlot ?? "-",
          entry.verification.verified === null ? "unknown" : entry.verification.verified ? "verified" : "not verified",
        ]),
        ["program", "registration", "upgrades", "deployed at slot", "source"],
      ),
    );
    return;
  }
  print.out(`${inspection.network} ${inspection.address}`);
  if (inspection.denied) print.out(`denied: ${inspection.denied}`);
  if (inspection.eip7702) print.out("refused: an EIP-7702 delegated account, whose code its owner can swap at any time");
  if (!inspection.deployed) print.out("no contract code at this address");
  if (inspection.pins) {
    print.out(`code ${inspection.pins.codeHash} (${inspection.pins.codeSize} bytes) at block ${inspection.pins.blockNumber}`);
    const proxy = inspection.pins.proxy;
    if (proxy) {
      print.out(`proxy ${proxy.kind} → ${proxy.implementation} (code ${proxy.implementationCodeHash})${proxy.admin ? `, admin ${proxy.admin}` : ""}${proxy.beacon ? `, beacon ${proxy.beacon}` : ""}`);
    } else print.out("not a proxy");
  }
  const { source, implementationSource } = inspection.verification;
  print.out(`source ${source.status} (${source.provider})${implementationSource ? `, implementation ${implementationSource.status}` : ""}`);
  if (inspection.functions.length === 0) {
    print.out(inspection.abi ? "The ABI has no functions." : "No verified ABI: pass your ABI to `kletia contracts init --abi <file>`.");
    return;
  }
  print.out("");
  print.out(
    table(
      inspection.functions.map((fn) => [fn.allowed ? "ok" : "no", fn.signature, fn.selector, fn.stateMutability, fn.reason ?? fn.notes.join(" ")]),
      ["", "function", "selector", "mutability", "notes"],
    ),
  );
}

const inspect: Command = {
  name: "contracts inspect",
  summary: "What registration would pin and allow: code hash, proxy, source verification, functions with allow/deny marks.",
  args: "--network <network> (--address <0x…> | --program <id>…)",
  key: true,
  options: {
    network: { type: "string", value: "<network>", description: "Network of the contract or programs." },
    address: { type: "string", value: "<0x…>", description: "EVM contract address." },
    program: { type: "string", multiple: true, value: "<id>", description: "Solana program id (repeatable, up to 6)." },
  },
  positionals: { min: 0, max: 0 },
  run: async (context) => {
    const query = inspectQuery(context);
    const inspection = await context.client().contracts.inspect(
      query.programs ? { network: query.network, programs: query.programs } : { network: query.network, address: query.address as string },
      signalOption(context),
    );
    if (context.json) context.print.json(inspection);
    else printInspection(context.print, inspection);
    return EXIT_OK;
  },
};

/* ------------------------------------------------------------------ init */

const AMOUNT_ARG = /^_?(?:amount|assets|value|wad|amt|qty|quantity|amountIn)$/iu;
const DEADLINE_ARG = /^_?deadline$/iu;

function todo(param: AbiParameter, index: number): string {
  return `TODO: bind ${param.name || `argument ${index + 1}`} (${param.type}) to $amount, $account, $param.<name>, … or { "literal": … }`;
}

/** Best-guess bindings: only the unambiguous ones; everything else is a TODO the validator reports. */
function guessBinding(param: AbiParameter, index: number, state: { amount: string | null }): ArgBinding | string {
  const name = param.name ?? "";
  if (param.type === "address") return isBeneficiaryArgName(name) ? "$account" : todo(param, index);
  if (/^uint\d*$/u.test(param.type)) {
    if (state.amount === null && AMOUNT_ARG.test(name)) {
      state.amount = name;
      return "$amount";
    }
    if (DEADLINE_ARG.test(name)) return "$deadline";
    return todo(param, index);
  }
  if (param.type === "bytes") return { literal: "0x" };
  if (param.type === "tuple" && param.components) {
    return { tuple: param.components.map((member, position) => guessBinding(member, position, state)) as ArgBinding[] };
  }
  return todo(param, index);
}

function actionId(name: string, taken: Set<string>): string {
  const base = (`${/^[a-z]/iu.test(name) ? "" : "fn-"}${name}`).toLowerCase().replace(/[^a-z0-9_-]/gu, "-").slice(0, 36) || "action";
  let id = base;
  for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`;
  taken.add(id);
  return id;
}

function humanLabel(name: string): string {
  const words = name.replace(/^_+/u, "").replace(/([a-z0-9])([A-Z])/gu, "$1 $2").replace(/[_-]+/gu, " ").trim();
  return (words.charAt(0).toUpperCase() + words.slice(1)).slice(0, CONTRACT_LIMITS.labelLength) || name;
}

const SIMPLE_TYPE = /^(?:address|bool|u?int\d*|bytes(?:[1-9]|[12]\d|3[0-2]))$/u;

/**
 * An event named after the function (`deposit` → `Deposit`, `stake` →
 * `Staked`) with an input that identifies the user. Anything less certain is
 * left as a TODO: an unrelated event must never be offered as proof of success.
 */
function guessEvent(fn: AbiFunctionItem, events: readonly AbiEventItem[], amountArg: string | null): EventBinding | null {
  const ambiguous = (event: AbiEventItem) => events.filter((other) => other.name === event.name).length > 1;
  const name = fn.name.replace(/^_+/u, "").toLowerCase();
  const related = (event: AbiEventItem) => {
    const eventName = event.name.toLowerCase();
    return name.length >= 3 && (eventName === name || eventName.startsWith(name) || name.startsWith(eventName));
  };
  for (const event of events.filter(related)) {
    if (event.anonymous) continue;
    const user = event.inputs.find((input) => input.type === "address" && isBeneficiaryArgName(input.name));
    if (!user?.name) continue;
    const where: Record<string, "$account" | "$amount"> = { [user.name]: "$account" };
    const amountInput = amountArg ? event.inputs.find((input) => input.name === amountArg && SIMPLE_TYPE.test(input.type) && input.type.startsWith("uint")) : undefined;
    if (amountInput?.name) where[amountInput.name] = "$amount";
    return { event: ambiguous(event) ? abiItemSignature(event) : event.name, emitter: "$self", where };
  }
  return null;
}

interface StarterOptions {
  readonly functions: readonly string[];
  readonly name?: string;
  readonly website?: string;
}

function starterDefinition(inspection: EvmContractInspectionView, abi: readonly ContractAbiItem[], options: StarterOptions, usage: string): Record<string, unknown> {
  const functions = abi.filter((item): item is AbiFunctionItem => item.type === "function");
  const events = abi.filter((item): item is AbiEventItem => item.type === "event");
  const classified = functions.map((fn) => ({ fn, verdict: classifyAbiFunction(fn) }));
  let chosen = classified.filter((entry) => entry.verdict.allowed);
  if (options.functions.length > 0) {
    chosen = [];
    for (const wanted of options.functions) {
      const matches = classified.filter((entry) => entry.fn.name === wanted || entry.verdict.signature === wanted);
      if (matches.length === 0) throw new UsageError(`The ABI has no function "${wanted}".`, usage);
      for (const match of matches) {
        if (!match.verdict.allowed) throw new UsageError(`${match.verdict.signature} cannot be registered: ${match.verdict.reason}`, usage);
        if (!chosen.includes(match)) chosen.push(match);
      }
    }
  }
  if (chosen.length === 0) throw new Error("The ABI has no function that can be registered (approvals, transfers, admin and read-only functions are refused).");
  chosen = chosen.slice(0, CONTRACT_LIMITS.actionsPerRegistration);
  const mainnet = CHAINS[inspection.network].environment === "mainnet";
  const taken = new Set<string>();
  const actions = chosen.map(({ fn, verdict }) => {
    const state = { amount: null as string | null };
    const args = fn.inputs.map((input, index) => guessBinding(input, index, state));
    const spends = state.amount !== null;
    const payable = fn.stateMutability === "payable";
    const event = guessEvent(fn, events, state.amount);
    return {
      id: actionId(fn.name, taken),
      label: humanLabel(fn.name),
      function: verdict.signature,
      args,
      ...(spends && !payable ? { input: { token: `TODO: registry symbol on ${inspection.network}, e.g. USDC`, approval: { spender: "$self" } } } : {}),
      ...(spends && payable ? { input: { token: "native" } } : {}),
      ...(payable ? { value: { bind: spends ? "$amount" : "TODO: wei", max: "TODO: largest value in wei" } } : {}),
      events: [event ?? { event: "TODO: an event of the ABI that proves success", emitter: "$self", where: {} }],
      ...(spends && mainnet ? { limits: { maxAmount: "TODO: largest amount per step" } } : {}),
    };
  });
  // The ABI is an allowlist: the chosen functions, then the events (those the actions reference first).
  // Error items are left out so the starter keeps room under the item cap.
  const used = new Set(chosen.map(({ fn }) => fn));
  const referenced = new Set(actions.flatMap((action) => action.events.map((event) => event.event)));
  const isReferenced = (event: AbiEventItem) => referenced.has(event.name) || referenced.has(abiItemSignature(event));
  const items: ContractAbiItem[] = [
    ...functions.filter((fn) => used.has(fn)),
    ...events.filter(isReferenced),
    ...events.filter((event) => !isReferenced(event)),
  ];
  return {
    vm: "evm",
    network: inspection.network,
    address: toChecksumAddress(inspection.address),
    integrator: {
      name: options.name ?? "TODO: your company",
      ...(options.website ? { website: options.website } : mainnet ? { website: "TODO: https://your.site" } : {}),
    },
    visibility: "private",
    abi: items.slice(0, CONTRACT_LIMITS.abiItems),
    actions,
  };
}

/** An ABI file: a JSON ABI array, or a build artifact with an `abi` field (Foundry, Hardhat). */
function abiFrom(value: unknown, usage: string): ContractAbiItem[] {
  const abi = Array.isArray(value) ? value : typeof value === "object" && value !== null && Array.isArray((value as { abi?: unknown }).abi) ? (value as { abi: unknown[] }).abi : null;
  if (!abi) throw new UsageError("--abi must be a JSON ABI array or a build artifact with an \"abi\" field.", usage);
  return abi.filter((item): item is ContractAbiItem => typeof item === "object" && item !== null && ["function", "event", "error"].includes((item as { type?: string }).type ?? ""));
}

const init: Command = {
  name: "contracts init",
  summary: "Write a starter definition from the contract's verified ABI (or --abi), with TODOs for what needs a decision.",
  args: "--network <network> --address <0x…> [--out contract.json]",
  key: true,
  options: {
    network: { type: "string", value: "<network>", description: "EVM network of the contract." },
    address: { type: "string", value: "<0x…>", description: "Contract address." },
    out: { type: "string", value: "<path>", description: "File to write (default contract.json; never overwritten)." },
    abi: { type: "string", value: "<path>", description: "ABI file when the source is not verified on Sourcify." },
    function: { type: "string", multiple: true, value: "<name>", description: "Function to expose (repeatable; default every allowed one, up to 10)." },
    name: { type: "string", value: "<name>", description: "Integrator name shown to users." },
    website: { type: "string", value: "<https://…>", description: "Integrator website (required on mainnet; verified by domain file)." },
  },
  positionals: { min: 0, max: 0 },
  run: async (context) => {
    const raw = stringOption(context.values, "network");
    const address = stringOption(context.values, "address");
    if (!raw || !address) throw new UsageError("--network and --address are required.", context.usage);
    const network = networkKey(raw, context.usage);
    if (CHAINS[network].vm !== "evm") {
      throw new UsageError("contracts init writes EVM definitions; for Solana Actions start from the example in the contracts guide.", context.usage);
    }
    const abiPath = stringOption(context.values, "abi");
    const abiFile = abiPath ? abiFrom(await readJson(context, abiPath), context.usage) : null;
    const out = stringOption(context.values, "out") ?? "contract.json";
    // Claim the output file first, so nothing is inspected for a file that cannot be written.
    let handle;
    try {
      handle = await open(out, "wx", 0o644);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      throw new UsageError(code === "EEXIST" ? `${out} already exists; choose another --out.` : `Cannot create ${out} (${code ?? "error"}).`, context.usage);
    }
    let written = false;
    try {
      const inspection = await context.client().contracts.inspect({ network, address }, signalOption(context));
      if (inspection.vm !== "evm") throw new Error("The API returned a Solana inspection for an EVM network.");
      if (inspection.denied) throw new Error(`${network}:${address} cannot be registered: ${inspection.denied}`);
      if (inspection.eip7702) throw new Error(`${network}:${address} is an EIP-7702 delegated account; its code can be swapped at any time, so it cannot be registered.`);
      if (!inspection.deployed) throw new Error(`There is no contract code at ${address} on ${network}.`);
      const abi = abiFile ?? (inspection.abi ? [...inspection.abi] : null);
      if (!abi) throw new Error(`The source of ${address} is not verified on Sourcify, so its ABI is unknown: pass --abi <file>.`);
      const definition = starterDefinition(
        inspection,
        abi,
        {
          functions: listOption(context.values, "function"),
          ...(stringOption(context.values, "name") ? { name: stringOption(context.values, "name") as string } : {}),
          ...(stringOption(context.values, "website") ? { website: stringOption(context.values, "website") as string } : {}),
        },
        context.usage,
      );
      await handle.writeFile(`${JSON.stringify(definition, null, 2)}\n`, "utf8");
      written = true;
      const checked = validateContractDefinition(definition);
      const issues = checked.ok ? [] : checked.issues;
      if (context.json) {
        context.print.json({ file: out, definition, issues });
        return EXIT_OK;
      }
      const actions = (definition.actions as readonly { id: string }[]).map((action) => action.id).join(", ");
      context.print.out(`Wrote ${out} for ${network}:${definition.address as string} (actions: ${actions}).`);
      if (inspection.pins?.proxy) context.print.out(`It is a ${inspection.pins.proxy.kind} proxy; the implementation ${inspection.pins.proxy.implementation} is pinned too.`);
      if (issues.length === 0) context.print.out(`It validates locally. Next: kletia contracts register --file ${out}`);
      else {
        context.print.out(`Decide these before \`kletia contracts register --file ${out}\`:`);
        for (const issue of issues) context.print.out(`  ${issue.path}: ${issue.message}`);
      }
      return EXIT_OK;
    } finally {
      await handle.close().catch(() => undefined);
      // A failed init leaves no empty file behind.
      if (!written) await rm(out, { force: true }).catch(() => undefined);
    }
  },
};

/* -------------------------------------------------------------- sessions */

const sessionsCreate: Command = {
  name: "sessions create",
  summary: "Create an embed session from a JSON template (fixed actions, allowed origins, TTL); prints its embed URL.",
  args: "--file <session.json>",
  key: true,
  options: FILE_OPTION,
  positionals: { min: 0, max: 0 },
  run: async (context) => {
    const request = await readJson(context, stringOption(context.values, "file"));
    const checked = validateSessionCreateRequest(request);
    if (!checked.ok) throw refusedLocally("INVALID_REQUEST", "The session template is invalid", checked.issues);
    const session = await context.client().sessions.create(request as SessionCreateRequest, signalOption(context));
    if (context.json) context.print.json(session);
    else printSession(context.print, session);
    return EXIT_OK;
  },
};

const sessionsGet: Command = {
  name: "sessions get",
  summary: "Show a session as the embed sees it (public).",
  args: "<session id>",
  positionals: { min: 1, max: 1 },
  run: async (context) => {
    const session = await context.client().sessions.get(sessionId(context), signalOption(context));
    if (context.json) context.print.json(session);
    else printSession(context.print, session);
    return EXIT_OK;
  },
};

export const CONTRACT_COMMANDS: readonly Command[] = Object.freeze([
  init,
  inspect,
  register,
  list,
  get,
  update,
  test,
  reverify,
  remove,
  sessionsCreate,
  sessionsGet,
]);
