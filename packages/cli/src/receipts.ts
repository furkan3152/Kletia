/**
 * `kletia receipt …`: read, share, verify and re-verify intent receipts.
 *
 * `verify` is offline (Web Crypto; a share link is fetched and decrypted
 * locally, its key never leaves this process). `reverify` re-reads every
 * anchor from public RPCs (read-only calls only) and needs `quorum` sources
 * to agree. Exit codes: 0 verified, 3 invalid (signature, digest, commitment,
 * key, share link, EAS envelope), 4 on-chain mismatch or conflicting
 * sources, 5 inconclusive (sources unavailable, groups sealed, pending).
 */
import { open, rm } from "node:fs/promises";
import type { ReceiptDocument, ReceiptKey, ReceiptPayload, ReceiptVerification } from "@kletia/core";
import {
  fetchReceiptKeys,
  openShareUrl,
  parseShareUrl,
  reverifyReceipt,
  verifyEasEnvelope,
  verifyReceipt,
  type EasVerification,
  type ReverifyReport,
} from "@kletia/sdk/receipts";
import { integerOption, listOption, stringOption, UsageError, type OptionSpec } from "./args.js";
import {
  CONFIRM_OPTION,
  durationSeconds,
  EXIT_INCONCLUSIVE,
  EXIT_INVALID,
  EXIT_MISMATCH,
  EXIT_OK,
  networkUrls,
  positional,
  signalOption,
  type Command,
  type CommandContext,
} from "./common.js";
import { readJson } from "./contracts.js";
import { table, when } from "./output.js";
import { abandonSecretSink, deliverSecret, openSecretSink } from "./secrets.js";

const PROFILES = ["route", "amounts", "proof", "full"] as const;
const MAX_KEYS_BYTES = 256 * 1024;

const KEYS_OPTION = {
  keys: { type: "string", value: "<file|url>", description: "Receipt keys you trust (JSON { keys } or a list; a URL such as <api>/v1/receipts/keys)." },
  intent: { type: "string", value: "<id>", description: "Also check that the receipt belongs to this intent id." },
} as const satisfies Record<string, OptionSpec>;

/* ----------------------------------------------------------------- inputs */

function isKeyLike(value: unknown): value is ReceiptKey {
  if (typeof value !== "object" || value === null) return false;
  const key = value as Record<string, unknown>;
  return key.kty === "OKP" && key.crv === "Ed25519" && typeof key.x === "string" && typeof key.kid === "string" && typeof key.status === "string" && typeof key.notBefore === "string";
}

function keysFrom(value: unknown, source: string, usage: string): ReceiptKey[] {
  const list = Array.isArray(value) ? value : typeof value === "object" && value !== null && Array.isArray((value as { keys?: unknown }).keys) ? (value as { keys: unknown[] }).keys : null;
  if (!list) throw new UsageError(`${source} holds no receipt keys ({ "keys": [...] }).`, usage);
  const keys = list.filter(isKeyLike);
  if (keys.length === 0) throw new UsageError(`${source} holds no Ed25519 receipt keys.`, usage);
  return keys;
}

/** `--keys`: a file, or a URL fetched once (https, or http on localhost). */
async function suppliedKeys(context: CommandContext): Promise<ReceiptKey[] | undefined> {
  const source = stringOption(context.values, "keys");
  if (!source) return undefined;
  if (/^https?:\/\//iu.test(source)) {
    const url = new URL(source);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !local) throw new UsageError("--keys URLs must use https (http only for localhost).", context.usage);
    const fetcher = context.io.fetch ?? fetch;
    const response = await fetcher(url.toString(), { method: "GET", headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    const text = await response.text();
    if (!response.ok || text.length > MAX_KEYS_BYTES) throw new Error(`Could not read keys from ${url.origin}${url.pathname} (HTTP ${response.status}).`);
    return keysFrom(JSON.parse(text) as unknown, `${url.origin}${url.pathname}`, context.usage);
  }
  return keysFrom(await readJson(context, source), source, context.usage);
}

function documentFrom(value: unknown, source: string, usage: string): ReceiptDocument {
  const record = typeof value === "object" && value !== null ? (value as { receipt?: unknown; payload?: unknown }) : null;
  const root = record && record.payload === undefined && typeof record.receipt === "object" ? record.receipt : value;
  if (typeof root !== "object" || root === null || typeof (root as { payload?: unknown }).payload !== "object") {
    throw new UsageError(`${source} is not a receipt (expected { "receipt": { "payload", "digest", "signature", … } }).`, usage);
  }
  return root as ReceiptDocument;
}

interface LoadedReceipt {
  readonly document: ReceiptDocument;
  /** Problems found before verification (a share link that does not open). */
  readonly verification?: ReceiptVerification;
  readonly share?: { readonly receiptId: string; readonly shareId: string; readonly groups: readonly string[] };
  readonly keys: readonly ReceiptKey[];
  readonly keySource: "supplied" | "api+web" | "pinned";
  readonly notes: readonly string[];
}

function apiBaseUrl(context: CommandContext): string {
  return context.client().baseUrl;
}

/** A file (`-` = stdin) or a share link; keys from --keys, else (online) both origins, else (offline) the pins only. */
async function loadReceipt(context: CommandContext, input: string, online: boolean): Promise<LoadedReceipt> {
  const supplied = await suppliedKeys(context);
  const share = parseShareUrl(input);
  const fetchImpl = context.io.fetch ? { fetch: context.io.fetch } : {};
  let keys: readonly ReceiptKey[] = supplied ?? [];
  let keySource: LoadedReceipt["keySource"] = supplied ? "supplied" : "pinned";
  const notes: string[] = [];
  if (!supplied && (online || share)) {
    const fetched = await fetchReceiptKeys({ baseUrl: apiBaseUrl(context), ...fetchImpl, ...signalOption(context) });
    keys = fetched.keys;
    keySource = "api+web";
    notes.push(...fetched.errors);
    if (fetched.dropped.length > 0) notes.push(`Not confirmed by both origins, so not trusted: ${fetched.dropped.join(", ")}.`);
  }
  if (share) {
    const opened = await openShareUrl(input, { client: context.client(), keys, fetchKeys: false, ...fetchImpl, ...signalOption(context) });
    return { document: opened.receipt, verification: opened.verification, share: opened.share, keys, keySource, notes };
  }
  if (/^https?:\/\//iu.test(input)) throw new UsageError("Not a receipt share link (https://…/r/rcpt_…#s=rsh_…&k=…).", context.usage);
  return { document: documentFrom(await readJson(context, input), input, context.usage), keys, keySource, notes };
}

/* ----------------------------------------------------------------- output */

function short(value: string): string {
  return value.length > 18 ? `${value.slice(0, 10)}…${value.slice(-6)}` : value;
}

function receiptHeader(payload: ReceiptPayload, digest: string): string[] {
  const intent = payload.intent;
  return [
    `${payload.receiptId}  sequence ${payload.sequence}  ${intent.status}${intent.terminal ? " (terminal)" : " (may be superseded)"}  issued ${payload.issuedOn}`,
    `digest ${digest}  kid ${payload.issuer.kid}`,
    `networks ${intent.networks.join(", ")}  steps ${payload.steps.map((step) => `${step.id} ${step.kind} on ${step.network} via ${step.protocol} (${step.status})`).join("; ")}`,
  ];
}

function verificationLines(verification: ReceiptVerification, keySource: string): string[] {
  const lines = [
    `${verification.valid ? "VALID" : "INVALID"}: key ${verification.key.status} (${verification.key.provenance === "none" ? "unknown" : verification.key.provenance}, keys ${keySource})`,
    `disclosed ${verification.disclosed.length} group${verification.disclosed.length === 1 ? "" : "s"}, sealed ${verification.sealed.length}`,
  ];
  if (verification.intentMatches !== null) lines.push(`intent id ${verification.intentMatches ? "matches" : "does NOT match"}`);
  if (verification.inclusion) lines.push(`log inclusion: batch ${verification.inclusion.batch} ${verification.inclusion.valid ? "valid" : "INVALID"}`);
  for (const problem of verification.problems) lines.push(`problem ${problem.code}${problem.path ? ` at ${problem.path}` : ""}: ${problem.message}`);
  for (const warning of verification.warnings) lines.push(`warning ${warning.code}: ${warning.message}`);
  if (verification.problems.some((problem) => problem.code === "KEY_UNKNOWN")) {
    lines.push("No trusted key signed this receipt: pass --keys <file|url> with keys you trust (compare <api>/v1/receipts/keys with https://kletiaai.xyz/.well-known/kletia-receipt-keys.json).");
  }
  return lines;
}

/** EAS envelope, when the receipt carries one (viem is optional). */
async function easCheck(document: ReceiptDocument): Promise<EasVerification | "none" | "skipped"> {
  if (!(document.attestations as { eas?: unknown } | undefined)?.eas) return "none";
  try {
    return await verifyEasEnvelope(document);
  } catch (error) {
    if (error instanceof Error && /needs the optional dependency viem/u.test(error.message)) return "skipped";
    throw error;
  }
}

/* --------------------------------------------------------------- commands */

const receiptGet: Command = {
  name: "receipt get",
  summary: "The latest receipt of an intent (or --sequence), with every disclosure you keep; exit 5 while it is pending.",
  args: "<intent id>",
  options: {
    sequence: { type: "string", value: "<n>", description: "An earlier sequence." },
    wait: { type: "string", value: "<seconds>", description: "Wait for it while pending (finality takes minutes on most networks)." },
    out: { type: "string", value: "<path>", description: "Write { receipt } to this file (mode 600; must not exist)." },
  },
  positionals: { min: 1, max: 1 },
  run: async (context) => {
    const id = positional(context, 0);
    const sequence = integerOption(context.values, "sequence", 1, 1_000_000, context.usage);
    const waitSeconds = integerOption(context.values, "wait", 1, 86_400, context.usage);
    const out = stringOption(context.values, "out");
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    if (out) {
      try {
        handle = await open(out, "wx", 0o600);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        throw new UsageError(code === "EEXIST" ? `${out} already exists; choose a new file.` : `Cannot create ${out} (${code ?? "error"}).`, context.usage);
      }
    }
    const onPending = (pending: { reason: string; expectedBy: string | null }) => {
      if (!context.json) context.print.err(`Pending (${pending.reason})${pending.expectedBy ? `, expected by ${when(pending.expectedBy)}` : ""}…`);
    };
    let result;
    try {
      result = await context.client().receipts.get(id, {
        ...(sequence !== undefined ? { sequence } : {}),
        ...(waitSeconds !== undefined ? { wait: { timeoutMs: waitSeconds * 1000, onPending } } : {}),
        ...signalOption(context),
      });
      if (handle && result.receipt) await handle.writeFile(`${JSON.stringify({ receipt: result.receipt }, null, 2)}\n`, "utf8");
    } catch (error) {
      await handle?.close();
      if (out) await rm(out, { force: true });
      throw error;
    }
    await handle?.close();
    if (out && !result.receipt) await rm(out, { force: true });
    if (context.json) context.print.json(result);
    else if (result.receipt) {
      for (const line of receiptHeader(result.receipt.payload, result.receipt.digest)) context.print.out(line);
      context.print.out(`disclosures kept: ${Object.keys(result.receipt.disclosures ?? {}).length}${result.receipt.inclusion ? `  log batch ${result.receipt.inclusion.batch.seq}` : "  not in a log batch yet"}`);
      if (result.pending) context.print.err(`A newer state is pending (${result.pending.reason}).`);
      if (out) context.print.err(`Written to ${out} (mode 600). Check it with: kletia receipt verify ${out}`);
    } else {
      const pending = result.pending;
      context.print.out(`No receipt yet: ${pending?.reason ?? "pending"}${pending?.expectedBy ? `, expected by ${when(pending.expectedBy)}` : ""}${pending ? `; retry in ${pending.retryAfterSeconds}s` : ""}.`);
    }
    return result.receipt ? EXIT_OK : EXIT_INCONCLUSIVE;
  },
};

const receiptVerify: Command = {
  name: "receipt verify",
  summary: "Offline check of a receipt file or a share link: digest, Ed25519 signature, key, every disclosure (exit 0 valid, 3 invalid).",
  args: "<file|share url>",
  options: KEYS_OPTION,
  positionals: { min: 1, max: 1 },
  run: async (context) => {
    const input = positional(context, 0);
    const loaded = await loadReceipt(context, input, false);
    const intentId = stringOption(context.values, "intent");
    const decryptFailed = loaded.verification?.problems.some((problem) => problem.code === "SHARE_DECRYPT_FAILED") === true;
    const verification = decryptFailed && loaded.verification ? loaded.verification : await verifyReceipt(loaded.document, { keys: loaded.keys, ...(intentId ? { intentId } : {}) });
    const eas = await easCheck(loaded.document);
    const easInvalid = typeof eas === "object" && !eas.valid;
    const valid = verification.valid && !easInvalid;
    if (context.json) context.print.json({ valid, verification, eas, keySource: loaded.keySource, ...(loaded.share ? { share: loaded.share } : {}), notes: loaded.notes });
    else {
      for (const line of receiptHeader(loaded.document.payload, verification.digest || loaded.document.digest)) context.print.out(line);
      for (const line of verificationLines(verification, loaded.keySource)) context.print.out(line);
      if (eas === "skipped") context.print.out("EAS envelope: not checked (install viem to check it)");
      else if (typeof eas === "object") context.print.out(`EAS envelope: ${eas.valid ? `valid, attester ${eas.signer}` : `INVALID (ATTESTATION_INVALID): ${eas.problems.join(" ")}`}`);
      for (const note of loaded.notes) context.print.err(`note: ${note}`);
    }
    return valid ? EXIT_OK : EXIT_INVALID;
  },
};

function reverifyExit(report: ReverifyReport): number {
  if (!report.offline.valid) return EXIT_INVALID;
  if (report.verdict === "mismatch" || report.anchors.some((anchor) => anchor.result === "conflict")) return EXIT_MISMATCH;
  return report.verdict === "verified" ? EXIT_OK : EXIT_INCONCLUSIVE;
}

const receiptReverify: Command = {
  name: "receipt reverify",
  summary: "Re-read every anchor of a receipt from public RPCs (read-only); exit 0 verified, 3 invalid, 4 mismatch or conflict, 5 inconclusive.",
  args: "<file|share url>",
  options: {
    ...KEYS_OPTION,
    rpc: { type: "string", multiple: true, value: "<network>=<url>", description: "Endpoint to use for a network (repeatable; replaces the defaults for that network)." },
    quorum: { type: "string", value: "<n>", description: "Distinct sources that must agree (default 2)." },
    providers: { type: "boolean", description: "Also ask the bridge providers' public status APIs (informational)." },
    "archive-rpc": { type: "string", multiple: true, value: "<network>=<url>", description: "Archive endpoint: check custom-contract code pins at the receipt's block." },
    "no-finality": { type: "boolean", description: "Skip the finality check." },
    timeout: { type: "string", value: "<seconds>", description: "Per-call timeout (default 15)." },
  },
  positionals: { min: 1, max: 1 },
  run: async (context) => {
    const input = positional(context, 0);
    const rpcs = networkUrls(listOption(context.values, "rpc"), "rpc", context.usage);
    const archive = Object.fromEntries(Object.entries(networkUrls(listOption(context.values, "archive-rpc"), "archive-rpc", context.usage)).map(([network, urls]) => [network, urls?.[0]]));
    const quorum = integerOption(context.values, "quorum", 1, 8, context.usage);
    const timeoutSeconds = integerOption(context.values, "timeout", 1, 120, context.usage);
    const loaded = await loadReceipt(context, input, true);
    if (loaded.verification && loaded.verification.problems.some((problem) => problem.code === "SHARE_DECRYPT_FAILED")) {
      if (context.json) context.print.json({ verdict: "mismatch", offline: loaded.verification });
      else for (const line of verificationLines(loaded.verification, loaded.keySource)) context.print.out(line);
      return EXIT_INVALID;
    }
    const intentId = stringOption(context.values, "intent");
    const report = await reverifyReceipt(loaded.document, {
      keys: loaded.keys,
      fetchKeys: false,
      rpcs,
      archiveRpcs: archive,
      ...(quorum !== undefined ? { quorum } : {}),
      ...(timeoutSeconds !== undefined ? { timeoutMs: timeoutSeconds * 1000 } : {}),
      ...(context.values.providers === true ? { providers: true } : {}),
      ...(context.values["no-finality"] === true ? { checkFinality: false } : {}),
      ...(intentId ? { intentId } : {}),
      ...(context.io.fetch ? { fetch: context.io.fetch } : {}),
      ...signalOption(context),
    });
    if (context.json) context.print.json({ ...report, keySource: loaded.keySource, notes: [...loaded.notes, ...report.notes] });
    else {
      for (const line of receiptHeader(loaded.document.payload, loaded.document.digest)) context.print.out(line);
      context.print.out(`VERDICT ${report.verdict.toUpperCase()}${report.singleSource ? " (single source for at least one network)" : ""}`);
      if (!report.offline.valid) for (const line of verificationLines(report.offline, loaded.keySource)) context.print.out(line);
      if (report.anchors.length > 0) {
        context.print.out("");
        context.print.out(
          table(
            report.anchors.map((anchor) => [
              anchor.step,
              anchor.role,
              anchor.chain,
              short(anchor.ref),
              anchor.result,
              anchor.finalized === null ? "-" : anchor.finalized ? "finalized" : "not finalized",
              anchor.sources.map((source) => `${source.url} ${source.result}${source.detail && source.result !== "match" ? ` (${source.detail.slice(0, 60)})` : ""}`).join("; "),
            ]),
            ["step", "role", "chain", "ref", "result", "finality", "sources"],
          ),
        );
      }
      for (const binding of report.bindings) if (binding.result !== "not_applicable") context.print.out(`binding ${binding.step}: ${binding.result}${binding.detail ? ` (${binding.detail})` : ""}`);
      for (const pin of report.codePins) context.print.out(`code pin ${pin.step} ${pin.role} ${pin.address}: ${pin.result}${pin.detail ? ` (${pin.detail})` : ""}`);
      if (report.anchoring) context.print.out(`log anchor on Base: ${report.anchoring.result}${report.anchoring.timestamp ? ` at ${new Date(report.anchoring.timestamp * 1000).toISOString()}` : ""} (batch ${short(report.anchoring.batchDigest)})`);
      for (const provider of report.providers) context.print.out(`provider ${provider.step} ${provider.name}: ${provider.result}${provider.status ? ` (${provider.status})` : ""}`);
      if (report.sealedSteps.length > 0) context.print.out(`sealed evidence: ${report.sealedSteps.join(", ")}`);
      // verificationLines already printed the offline warnings of an invalid receipt.
      const shown = report.offline.valid ? [] : report.offline.warnings;
      for (const warning of report.warnings) if (!shown.includes(warning)) context.print.out(`warning ${warning.code}: ${warning.message}`);
      for (const note of [...loaded.notes, ...report.notes]) context.print.err(`note: ${note}`);
    }
    return reverifyExit(report);
  },
};

const receiptShare: Command = {
  name: "receipt share",
  summary: "Share a receipt: prints the share link once (its key is in the fragment and is not kept by Kletia).",
  args: "<intent id> [--profile route|amounts|proof|full | --groups <a,b>]",
  options: {
    profile: { type: "string", value: "<profile>", description: "route (default: skeleton only), amounts, proof or full." },
    groups: { type: "string", multiple: true, value: "<paths>", description: "Explicit groups, e.g. intent.outcome,steps.*.evidence." },
    sequence: { type: "string", value: "<n>", description: "Share an earlier sequence." },
    expires: { type: "string", value: "<duration|never>", description: "How long the link opens (1h to 365d, default 30d), or never." },
    out: { type: "string", value: "<path>", description: "Write the link to this file (mode 600; must not exist)." },
    reveal: { type: "boolean", description: "Print the link on this terminal." },
  },
  positionals: { min: 1, max: 1 },
  run: async (context) => {
    const id = positional(context, 0);
    const profile = stringOption(context.values, "profile");
    const groups = listOption(context.values, "groups");
    if (profile !== undefined && groups.length > 0) throw new UsageError("Pass --profile or --groups, not both.", context.usage);
    if (profile !== undefined && !(PROFILES as readonly string[]).includes(profile)) throw new UsageError(`--profile must be one of ${PROFILES.join(", ")}.`, context.usage);
    const sequence = integerOption(context.values, "sequence", 1, 1_000_000, context.usage);
    const expires = stringOption(context.values, "expires");
    const expiresInSeconds = expires === undefined ? undefined : expires === "never" ? null : durationSeconds(expires, "expires", context.usage);
    if (typeof expiresInSeconds === "number" && (expiresInSeconds < 3_600 || expiresInSeconds > 31_536_000)) throw new UsageError("--expires must be between 1h and 365d (or never).", context.usage);
    const sink = await openSecretSink(context, "out");
    let created;
    try {
      created = await context.client().receipts.share(
        id,
        {
          ...(profile ? { profile: profile as (typeof PROFILES)[number] } : {}),
          ...(groups.length > 0 ? { groups } : {}),
          ...(sequence !== undefined ? { sequence } : {}),
          ...(expiresInSeconds !== undefined ? { expiresInSeconds } : {}),
        },
        signalOption(context),
      );
    } catch (error) {
      await abandonSecretSink(sink);
      throw error;
    }
    const { url, ...record } = created.share;
    if (!url) {
      await abandonSecretSink(sink);
      throw new Error("The API did not return the share link.");
    }
    const groupText = record.groups.length > 0 ? record.groups.join(", ") : "skeleton only";
    await deliverSecret(context, sink, url, record, "url", `Shared ${record.receiptId} (sequence ${record.sequence}; ${groupText}) ${record.expiresAt ? `until ${when(record.expiresAt)}` : "with no expiry"}. Revoke with: kletia receipt unshare ${id} ${record.id}`);
    return EXIT_OK;
  },
};

const receiptShares: Command = {
  name: "receipt shares",
  summary: "Active shares of an intent's receipts (never their keys).",
  args: "<intent id>",
  positionals: { min: 1, max: 1 },
  run: async (context) => {
    const list = await context.client().receipts.shares(positional(context, 0), signalOption(context));
    if (context.json) context.print.json(list);
    else context.print.out(table(list.map((share) => [share.id, share.receiptId, String(share.sequence), share.groups.length > 0 ? share.groups.join(",") : "skeleton", share.expiresAt ? when(share.expiresAt) : "never"]), ["share", "receipt", "seq", "groups", "expires"]));
    return EXIT_OK;
  },
};

const receiptUnshare: Command = {
  name: "receipt unshare",
  summary: "Revoke a share link (it stops opening at once).",
  args: "<intent id> <share id>",
  positionals: { min: 2, max: 2 },
  run: async (context) => {
    const shareId = positional(context, 1);
    if (!/^rsh_[0-9a-f]{24}$/u.test(shareId)) throw new UsageError(`"${shareId}" is not a share id (rsh_ followed by 24 hex characters).`, context.usage);
    await context.client().receipts.unshare(positional(context, 0), shareId, signalOption(context));
    if (context.json) context.print.json({ revoked: shareId });
    else context.print.out(`Revoked ${shareId}.`);
    return EXIT_OK;
  },
};

const receiptWithdraw: Command = {
  name: "receipt withdraw",
  summary: "Delete the stored disclosures of an intent's receipts and every share (the signed payloads remain).",
  args: "<intent id> --yes",
  options: CONFIRM_OPTION,
  positionals: { min: 1, max: 1 },
  run: async (context) => {
    if (context.values.yes !== true) throw new UsageError("Withdrawn disclosures cannot be restored; pass --yes.", context.usage);
    const id = positional(context, 0);
    await context.client().receipts.withdraw(id, signalOption(context));
    if (context.json) context.print.json({ withdrawn: id });
    else context.print.out(`Withdrew the disclosures and shares of ${id}'s receipts.`);
    return EXIT_OK;
  },
};

const receiptKeys: Command = {
  name: "receipt keys",
  summary: "Receipt signing keys the API publishes (and EAS attesters); trust a key once the web origin's mirror lists it too.",
  options: { check: { type: "boolean", description: "Cross-check with https://kletiaai.xyz/.well-known/kletia-receipt-keys.json." } },
  positionals: { min: 0, max: 0 },
  run: async (context) => {
    const set = await context.client().receipts.keys(signalOption(context));
    const checked = context.values.check === true ? await fetchReceiptKeys({ baseUrl: apiBaseUrl(context), ...(context.io.fetch ? { fetch: context.io.fetch } : {}), ...signalOption(context) }) : null;
    if (context.json) context.print.json({ ...set, ...(checked ? { trusted: checked.keys.map((key) => key.kid), notes: [...checked.errors] } : {}) });
    else {
      context.print.out(
        table(
          set.keys.map((key) => [key.kid, key.status, key.notBefore, key.revokedOn ?? "-", checked ? (checked.keys.some((trusted) => trusted.kid === key.kid) ? "both origins" : "API only") : "-"]),
          ["kid", "status", "not before", "revoked on", "mirror"],
        ),
      );
      for (const attester of set.attesters) context.print.out(`EAS attester ${attester.address} on ${attester.chain} (schema ${short(attester.schemaUid)}, ${attester.status})`);
      for (const note of checked?.errors ?? []) context.print.err(`note: ${note}`);
    }
    return EXIT_OK;
  },
};

const receiptLog: Command = {
  name: "receipt log",
  summary: "Transparency-log batches, one batch, or the inclusion proof of a digest.",
  args: "[<seq>] [--inclusion <digest>]",
  options: {
    inclusion: { type: "string", value: "<digest>", description: "Inclusion proof of a receipt digest." },
    unanchored: { type: "boolean", description: "Only batches with no recorded anchor." },
    limit: { type: "string", value: "<1-100>", description: "How many batches (default 20)." },
  },
  positionals: { min: 0, max: 1 },
  run: async (context) => {
    const client = context.client();
    const digest = stringOption(context.values, "inclusion");
    if (digest !== undefined) {
      if (!/^[0-9a-f]{64}$/u.test(digest)) throw new UsageError("--inclusion takes a receipt digest (64 lower-case hex characters).", context.usage);
      const inclusion = await client.receipts.inclusion(digest, signalOption(context));
      if (context.json) context.print.json(inclusion);
      else context.print.out(`batch ${inclusion.batch.seq} (size ${inclusion.batch.size}, closed ${inclusion.batch.closedOn})  leaf ${inclusion.leafIndex}  path ${inclusion.path.length} hashes  anchor ${inclusion.anchor ? inclusion.anchor.tx : "none recorded"}`);
      return EXIT_OK;
    }
    const seqText = context.positionals[0];
    if (seqText !== undefined) {
      if (!/^[1-9]\d{0,14}$/u.test(seqText)) throw new UsageError("<seq> is a positive batch number.", context.usage);
      const response = await client.receipts.batch(Number(seqText), signalOption(context));
      if (context.json) context.print.json(response);
      else {
        const batch = response.batch;
        context.print.out(`batch ${batch.seq}  size ${batch.batch.size}  closed ${batch.batch.closedOn}  root ${batch.batch.root}`);
        context.print.out(`batchDigest ${batch.batchDigest}  previous ${batch.batch.previous ?? "none"}`);
        context.print.out(`anchor ${batch.anchor ? `${batch.anchor.tx} at ${new Date(batch.anchor.timestamp * 1000).toISOString()}` : "none recorded"}`);
      }
      return EXIT_OK;
    }
    const limit = integerOption(context.values, "limit", 1, 100, context.usage);
    const batches = await client.receipts.log({ ...(limit !== undefined ? { limit } : {}), ...(context.values.unanchored === true ? { unanchored: true } : {}), ...signalOption(context) });
    if (context.json) context.print.json(batches);
    else context.print.out(table(batches.map((batch) => [String(batch.seq), String(batch.batch.size), batch.batch.closedOn, short(batch.batchDigest), batch.anchor ? "anchored" : "-"]), ["seq", "size", "closed", "digest", "anchor"]));
    return EXIT_OK;
  },
};

export const RECEIPT_COMMANDS: readonly Command[] = Object.freeze([
  receiptGet,
  receiptVerify,
  receiptReverify,
  receiptShare,
  receiptShares,
  receiptUnshare,
  receiptWithdraw,
  receiptKeys,
  receiptLog,
]);
