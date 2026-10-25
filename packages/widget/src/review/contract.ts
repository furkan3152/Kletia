/**
 * The custom-contract step review.
 */
import { CONTRACT_REVIEW_NOTICE, type ContractReview } from "@kletia/core";
import {
  cleanText,
  httpsUrl,
  networkLabel,
  shortAddress,
  unsignedAmount,
} from "./text.js";

/* ===================================================== contract review */

const ARG_SOURCES: Readonly<Record<string, string>> = Object.freeze({
  amount: "your amount",
  account: "your address",
  recipient: "the recipient you chose",
  token: "the token of this step",
  self: "the contract's own address",
  minimumOutput: "your minimum output",
  deadline: "a deadline Kletia sets",
  previousOutput: "the previous leg's output",
  param: "a value you chose",
});

const SOURCE_TEXT: Readonly<Record<string, { readonly text: string; readonly verified: boolean }>> = Object.freeze({
  exact_match: { text: "Source verified (exact match)", verified: true },
  match: { text: "Source verified (partial match)", verified: true },
  unverified: { text: "Source not verified", verified: false },
  unknown: { text: "Source verification unknown", verified: false },
});

const PROXY_KIND: Readonly<Record<string, string>> = Object.freeze({
  eip1967: "EIP-1967 proxy",
  "eip1967-beacon": "EIP-1967 beacon proxy",
  eip1822: "EIP-1822 proxy",
  zeppelinos: "ZeppelinOS proxy",
  eip1167: "EIP-1167 minimal proxy",
});

export interface ContractReviewModel {
  readonly kind: ContractReview["kind"];
  readonly integrator: {
    readonly name: string;
    /** https only. */
    readonly website: string | null;
    readonly domain: string | null;
    readonly domainVerified: boolean;
  };
  readonly contract: {
    readonly networkName: string;
    readonly address: string;
    readonly explorerUrl: string | null;
    readonly source: string;
    readonly sourceVerified: boolean;
    readonly proxy: { readonly kind: string; readonly implementation: string; readonly source: string; readonly verified: boolean } | null;
    readonly revision: number | null;
  } | null;
  readonly call: {
    readonly label: string;
    readonly signature: string;
    readonly args: readonly { readonly key: string; readonly name: string; readonly type: string; readonly value: string; readonly source: string }[];
    readonly value: string | null;
  } | null;
  readonly action: {
    readonly title: string | null;
    readonly domain: string;
    readonly url: string | null;
    readonly instructionCount: number;
    readonly programs: readonly { readonly id: string; readonly verified: string; readonly upgradeable: string }[];
  } | null;
  /** "Allow Steakhouse USDC to spend exactly 100 USDC". */
  readonly permissions: readonly { readonly key: string; readonly text: string; readonly spender: string; readonly existing: string | null }[];
  readonly result: {
    readonly simulated: boolean;
    readonly changes: readonly { readonly key: string; readonly text: string; readonly debit: boolean; readonly unlisted: boolean }[];
    readonly networkFee: string | null;
    readonly where: string | null;
    readonly warnings: readonly string[];
  };
  /** The fixed notice first ("Not audited by Kletia. …"), then any further notices. */
  readonly notices: readonly string[];
  /** Signing needs an explicit acknowledgement (unverified source, unverified domain or program). */
  readonly needsAcknowledgement: boolean;
  readonly acknowledgementReasons: readonly string[];
}

/** Display model of a custom-contract review (`step.call.review` or `payload.review`). */
export function contractReviewModel(review: ContractReview): ContractReviewModel {
  const integratorName = cleanText(review.integrator?.name, 80) || "Unnamed integrator";
  const website = httpsUrl(review.integrator?.website);
  const domainVerified = review.integrator?.domainVerified === true;
  const reasons: string[] = [];
  if (!domainVerified) reasons.push(`${integratorName} has not verified its website domain with Kletia.`);

  let contract: ContractReviewModel["contract"] = null;
  if (review.contract) {
    const source = SOURCE_TEXT[review.contract.source] ?? SOURCE_TEXT.unknown!;
    const proxy = review.contract.proxy
      ? (() => {
          const implementation = SOURCE_TEXT[review.contract!.proxy!.implementationSource] ?? SOURCE_TEXT.unknown!;
          return {
            kind: PROXY_KIND[review.contract!.proxy!.kind] ?? "Proxy",
            implementation: cleanText(review.contract!.proxy!.implementation, 80),
            source: implementation.text,
            verified: implementation.verified,
          };
        })()
      : null;
    if (!source.verified) reasons.push("The contract's source code is not verified.");
    if (proxy && !proxy.verified) reasons.push("The proxy's implementation source code is not verified.");
    const explorer = httpsUrl(review.contract.explorerUrl);
    contract = {
      networkName: networkLabel(review.contract.network),
      address: cleanText(review.contract.address, 80),
      explorerUrl: explorer ? explorer.href : null,
      source: source.text,
      sourceVerified: source.verified,
      proxy,
      revision: Number.isInteger(review.contract.revision) ? review.contract.revision : null,
    };
  }

  const call = review.call
    ? {
        label: cleanText(review.call.label, 80),
        signature: cleanText(review.call.function, 200),
        args: (review.call.args ?? []).map((arg, position) => ({
          key: `${position}`,
          name: cleanText(arg.name, 40) || `arg${position}`,
          type: cleanText(arg.type, 40),
          value: cleanText(arg.display, 200),
          source: arg.source === "literal" ? `fixed by ${integratorName}` : (ARG_SOURCES[arg.source] ?? "set by the integrator"),
        })),
        value: review.call.value && review.call.value.amount !== "0" ? `${unsignedAmount(review.call.value.formatted)} ${cleanText(review.call.value.symbol, 24)}` : null,
      }
    : null;

  let action: ContractReviewModel["action"] = null;
  if (review.action) {
    const url = httpsUrl(review.action.url);
    const programs = (review.action.programs ?? []).map((program) => {
      if (program.verified !== true) reasons.push(`Program ${shortAddress(program.id)} is not a verified build.`);
      return {
        id: cleanText(program.id, 64),
        verified: program.verified === true ? "Verified build" : program.verified === false ? "Not a verified build" : "Build verification unknown",
        upgradeable: program.upgradeable ? `Upgradeable${program.upgradeAuthority ? ` by ${shortAddress(program.upgradeAuthority)}` : ""}` : "Not upgradeable",
      };
    });
    action = {
      title: cleanText(review.action.title, 120) || null,
      domain: cleanText(review.action.domain, 120),
      url: url ? url.href : null,
      instructionCount: Number.isInteger(review.action.instructionCount) ? review.action.instructionCount : 0,
      programs,
    };
  }

  const permissions = (review.approvals ?? []).map((approval, position) => {
    const symbol = cleanText(approval.token?.symbol, 24) || "?";
    const spender = cleanText(approval.spender, 80);
    const spenderName = contract && spender.toLowerCase() === contract.address.toLowerCase() ? `${integratorName}'s contract` : shortAddress(spender);
    return {
      key: `${position}`,
      text: `Allow ${spenderName} to spend exactly ${unsignedAmount(approval.amount.formatted)} ${symbol}`,
      spender,
      existing: approval.existingAllowance ? `${unsignedAmount(approval.existingAllowance.formatted)} ${symbol} allowed before` : null,
    };
  });

  const simulation = review.simulation;
  const simulated = simulation?.status === "ok";
  if (!simulated) reasons.push("Kletia could not simulate this transaction.");
  const changes = (simulation?.assetChanges ?? []).map((change, position) => {
    const debit = change.delta.startsWith("-");
    const symbol = cleanText(change.symbol, 24) || "?";
    return {
      key: `${position}`,
      text: `${debit ? "−" : "+"}${unsignedAmount(change.formatted)} ${symbol}`,
      debit,
      unlisted: change.listed === false,
    };
  });

  const notices = [CONTRACT_REVIEW_NOTICE];
  for (const notice of review.notices ?? []) {
    const text = cleanText(notice, 400);
    if (text && text !== CONTRACT_REVIEW_NOTICE && !notices.includes(text)) notices.push(text);
  }

  return {
    kind: review.kind,
    integrator: { name: integratorName, website: website ? website.href : null, domain: website ? website.hostname : null, domainVerified },
    contract,
    call,
    action,
    permissions,
    result: {
      simulated,
      changes,
      networkFee: review.simulation?.networkFee ? `${unsignedAmount(review.simulation.networkFee.formatted)} ${cleanText(review.simulation.networkFee.symbol, 24)}` : null,
      where: simulation?.block ? `block ${cleanText(simulation.block, 24)}` : simulation?.slot ? `slot ${cleanText(simulation.slot, 24)}` : null,
      warnings: (simulation?.warnings ?? []).map((warning) => cleanText(warning, 300)).filter(Boolean),
    },
    notices,
    needsAcknowledgement: reasons.length > 0,
    acknowledgementReasons: reasons,
  };
}

/** Steps whose transactions run integrator code (custom contracts). */
export function isContractStep(step: { readonly kind: string; readonly protocol?: string; readonly call?: unknown }): boolean {
  return step.kind === "call" || step.kind === "action" || step.call !== undefined || step.protocol === "custom-call" || step.protocol === "solana-actions";
}
