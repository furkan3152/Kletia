/**
 * Parses and validates a Solana Actions definition.
 */
import { CHAINS, type NetworkKey } from "../chains.js";
import { isSolanaAddress } from "../caip.js";
import { isBaseUnitAmount } from "../amounts.js";
import type { AssetDescriptor } from "../assets.js";
import { CONTRACT_LIMITS } from "./patterns.js";
import type {
  SolanaActionDefinition,
  SolanaActionEndpoint,
  SolanaActionOutput,
  SolanaActionPayee,
} from "./types.js";
import { deniedTargetReason } from "./targets.js";
import {
  CONTROL_CHARS,
  isPlainText,
  isRecord,
  normalizeWebOrigin,
  resolveContractAsset,
} from "./origins.js";
import {
  checkKeys,
  checkPhraseCollisions,
  type ContractValidationOptions,
  type IssueList,
  parseCommonAction,
  parseIntegrator,
  parseLimits,
  parseParams,
  parsePhrases,
  parseTolerance,
  parseVisibility,
} from "./issues.js";

/* ------------------------------------------------------------------- Solana */

const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9_]{0,31})\}/gu;

export function parseSolanaDefinition(input: Record<string, unknown>, network: NetworkKey, issues: IssueList, options: ContractValidationOptions): SolanaActionDefinition | null {
  checkKeys(input, ["vm", "network", "integrator", "visibility", "origin", "programs", "payees", "actions"], "", issues);
  const mainnet = CHAINS[network].environment === "mainnet";
  const integrator = parseIntegrator(input.integrator, mainnet, issues);
  const visibility = parseVisibility(input.visibility, issues);
  const origin = normalizeWebOrigin(input.origin, { allowPort: true });
  if (!origin) issues.add("ACTION_URL_FORBIDDEN", "origin", "Must be an https origin with a public host name (port 443 or 1024+), without credentials, path, query or fragment.");

  const programs: string[] = [];
  if (!Array.isArray(input.programs) || input.programs.length === 0 || input.programs.length > CONTRACT_LIMITS.programs) {
    issues.add("PROGRAM_NOT_ALLOWED", "programs", `List 1-${CONTRACT_LIMITS.programs} program ids.`);
  } else {
    input.programs.forEach((program, index) => {
      if (typeof program !== "string" || !isSolanaAddress(program)) {
        issues.add("PROGRAM_NOT_ALLOWED", `programs[${index}]`, "Must be a base58 program id.");
        return;
      }
      if (programs.includes(program)) {
        issues.add("PROGRAM_NOT_ALLOWED", `programs[${index}]`, "Duplicate program.");
        return;
      }
      const denied = deniedTargetReason(network, program, options.denylist);
      if (denied) issues.add("PROGRAM_NOT_ALLOWED", `programs[${index}]`, `${program}: ${denied}.`);
      programs.push(program);
    });
  }

  const payees: SolanaActionPayee[] = [];
  if (input.payees !== undefined) {
    if (!Array.isArray(input.payees) || input.payees.length > CONTRACT_LIMITS.payees) {
      issues.invalid("payees", `Must be a list of at most ${CONTRACT_LIMITS.payees} { label, address, maxLamports } entries.`);
    } else {
      input.payees.forEach((payee, index) => {
        const at = `payees[${index}]`;
        if (!isRecord(payee)) {
          issues.invalid(at, "Must be { label, address, maxLamports }.");
          return;
        }
        checkKeys(payee, ["label", "address", "maxLamports"], at, issues);
        const { label, address, maxLamports } = payee;
        if (!isPlainText(label, 32)) {
          issues.invalid(`${at}.label`, "Must be 1-32 printable characters.");
          return;
        }
        if (typeof address !== "string" || !isSolanaAddress(address) || programs.includes(address) || payees.some((entry) => entry.address === address)) {
          issues.invalid(`${at}.address`, "Must be a base58 address, not an allowlisted program, listed once.");
          return;
        }
        if (!isBaseUnitAmount(maxLamports) || BigInt(maxLamports) <= 0n || BigInt(maxLamports) >= 1n << 64n) {
          issues.invalid(`${at}.maxLamports`, "Must be a positive integer string (lamports).");
          return;
        }
        payees.push({ label, address, maxLamports });
      });
    }
  }

  const actions: SolanaActionEndpoint[] = [];
  const ids = new Set<string>();
  if (!Array.isArray(input.actions) || input.actions.length === 0 || input.actions.length > CONTRACT_LIMITS.actionsPerRegistration) {
    issues.invalid("actions", `Must be a list of 1-${CONTRACT_LIMITS.actionsPerRegistration} actions.`);
  } else {
    input.actions.forEach((raw, actionIndex) => {
      const at = `actions[${actionIndex}]`;
      if (!isRecord(raw)) {
        issues.invalid(at, "Action must be an object.");
        return;
      }
      checkKeys(raw, ["id", "label", "href", "primaryProgram", "input", "output", "params", "phrases", "limits"], at, issues);
      const common = parseCommonAction(raw, at, ids, issues);
      const params = parseParams(raw.params, `${at}.params`, issues);

      let inputAsset: AssetDescriptor | null = null;
      if (raw.input !== undefined) {
        if (!isRecord(raw.input)) issues.invalid(`${at}.input`, "Must be { token }.");
        else {
          checkKeys(raw.input, ["token"], `${at}.input`, issues);
          inputAsset = typeof raw.input.token === "string" ? resolveContractAsset(network, raw.input.token) : null;
          if (!inputAsset) issues.invalid(`${at}.input.token`, "Use a registry asset on this network (GET /v1/assets): a symbol, a CAIP-19 id, or native.");
        }
      }

      let href: string | null = null;
      const rawHref = raw.href;
      if (typeof rawHref !== "string" || rawHref.length > CONTRACT_LIMITS.hrefLength || CONTROL_CHARS.test(rawHref) || /\s/u.test(rawHref)) {
        issues.add("ACTION_URL_FORBIDDEN", `${at}.href`, `Must be a URL up to ${CONTRACT_LIMITS.hrefLength} characters on the registered origin.`);
      } else if (origin) {
        const placeholders = [...rawHref.matchAll(PLACEHOLDER)].map((match) => match[1] as string);
        const stripped = rawHref.replace(PLACEHOLDER, "x");
        let url: URL | null = null;
        try {
          url = new URL(stripped);
        } catch {
          url = null;
        }
        const allowed = new Set(["amount", "amountBaseUnits", ...params.map((param) => param.name)]);
        if (!rawHref.startsWith(`${origin}/`) || !url || url.origin !== origin || url.username || url.password || url.hash || stripped.includes("#")) {
          issues.add("ACTION_URL_FORBIDDEN", `${at}.href`, `Must start with ${origin}/ (no credentials or fragment).`);
        } else if (/[{}]/u.test(stripped)) {
          issues.add("ACTION_URL_FORBIDDEN", `${at}.href`, "Placeholders are {amount}, {amountBaseUnits} or {<param>} only.");
        } else if (/\\|%2e/iu.test(stripped) || (stripped.slice(origin.length).split("?")[0] ?? "").split("/").some((segment) => segment === ".." || segment === ".")) {
          issues.add("ACTION_URL_FORBIDDEN", `${at}.href`, "Backslashes and dot segments are not allowed.");
        } else {
          const unknown = placeholders.filter((name) => !allowed.has(name));
          const amountPlaceholder = placeholders.some((name) => name === "amount" || name === "amountBaseUnits");
          if (unknown.length) issues.add("ACTION_URL_FORBIDDEN", `${at}.href`, `Unknown placeholders: ${unknown.join(", ")} (declare params).`);
          else if (inputAsset && !amountPlaceholder) issues.invalid(`${at}.href`, "A spending action must carry {amount} or {amountBaseUnits}.");
          else if (!inputAsset && amountPlaceholder) issues.invalid(`${at}.href`, "{amount} needs an input token.");
          else href = rawHref;
        }
      }

      const primaryProgram = raw.primaryProgram;
      if (typeof primaryProgram !== "string" || !programs.includes(primaryProgram)) {
        issues.add("PROGRAM_NOT_ALLOWED", `${at}.primaryProgram`, "Must be one of programs.");
      }

      let output: SolanaActionOutput | undefined;
      if (raw.output !== undefined) {
        if (!isRecord(raw.output)) issues.invalid(`${at}.output`, "Must be { mint, toleranceBps }.");
        else {
          checkKeys(raw.output, ["mint", "toleranceBps"], `${at}.output`, issues);
          const toleranceBps = parseTolerance(raw.output.toleranceBps, `${at}.output.toleranceBps`, issues);
          if (typeof raw.output.mint !== "string" || !isSolanaAddress(raw.output.mint) || programs.includes(raw.output.mint)) {
            issues.invalid(`${at}.output.mint`, "Must be an SPL mint address.");
          } else if (inputAsset?.address === raw.output.mint) {
            issues.invalid(`${at}.output.mint`, "The output must differ from the input token (deltas would cancel out).");
          } else output = { mint: raw.output.mint, toleranceBps };
        }
      }
      const phrases = parsePhrases(raw.phrases, `${at}.phrases`, issues);
      const limits = parseLimits(raw.limits, `${at}.limits`, inputAsset, mainnet, issues);
      if (!common || !href || typeof primaryProgram !== "string" || !programs.includes(primaryProgram)) return;
      actions.push({
        id: common.id,
        label: common.label,
        href,
        primaryProgram,
        ...(inputAsset ? { input: { token: (raw.input as Record<string, unknown>).token as string } } : {}),
        ...(output ? { output } : {}),
        ...(params.length ? { params } : {}),
        ...(phrases ? { phrases } : {}),
        ...(limits && (limits.minAmount || limits.maxAmount) ? { limits } : {}),
      });
    });
  }
  checkPhraseCollisions(actions, issues);
  if (!integrator || !origin) return null;
  return {
    vm: "svm",
    network,
    integrator,
    visibility,
    origin,
    programs,
    ...(payees.length ? { payees } : {}),
    actions,
  };
}
