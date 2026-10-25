/**
 * Prompt evidence for assets, recipients, destinations and the explicit
 * execution constraints (caps, slippage, gas, price impact, protocols).
 */
import type { NetworkId } from "../../config/networks.js";
import { assetAliasesForSymbol } from "../../assets/catalog.js";
import type { ParsedIntent } from "./schema.js";
import {
  escapeRegExp,
  hasExplicitlyNegatedAssetReference,
  hasPromptBoundAction,
  hasPromptBoundAddress,
  hasPromptBoundBaseAction,
  hasPromptBoundPrimaryAmount,
  hasPromptBoundWorkflowAction,
  normalizePromptDecimal,
  promptAssetOccurrences,
} from "./promptEvidence.js";

export function hasPromptBoundWorkflow(
  intent: ParsedIntent,
  text: string,
  network: NetworkId,
): boolean {
  const steps = intent.workflowSteps;
  if (!steps || steps.length < 2 || !hasPromptBoundAction("workflow", text)) {
    return false;
  }
  return steps.every((step) => {
    if (!hasPromptBoundWorkflowAction(step.action, text)) return false;
    for (const asset of [step.tokenIn, step.tokenOut]) {
      if (
        asset &&
        !hasPromptBoundAsset(
          asset,
          text,
          (step.network || network) as NetworkId,
          asset === step.tokenIn ? "tokenIn" : "tokenOut",
          { ...intent, action: step.action, tokenIn: step.tokenIn, tokenOut: step.tokenOut, amount: step.amount || "0" },
        )
      ) {
        return false;
      }
    }
    if (
      step.amountSource === "explicit" &&
      step.amount &&
      step.tokenIn &&
      !hasPromptBoundAmountForAsset(
        step.amount,
        step.tokenIn,
        text,
        (step.network || network) as NetworkId,
      )
    ) {
      return false;
    }
    return true;
  });
}

export function hasPromptBoundAsset(
  value: unknown,
  text: string,
  network: NetworkId,
  role: "tokenIn" | "tokenOut" | "collateralToken" | "borrowToken",
  intent: ParsedIntent,
): boolean {
  const asset = String(value ?? "").trim();
  if (!asset) return false;
  const candidates = [asset, ...assetAliasesForSymbol(network, asset)].filter(
    (candidate, index, values) =>
      candidate.length > 0 &&
      candidate.length <= 128 &&
      values.findIndex(
        (value) =>
          value.toLocaleLowerCase("en-US") ===
          candidate.toLocaleLowerCase("en-US"),
      ) === index,
  );
  if (hasExplicitlyNegatedAssetReference(candidates, text)) return false;

  if (/^0x[a-fA-F0-9]{40}$/.test(asset)) {
    if (!hasPromptBoundAddress(asset, text)) return false;
    const escaped = escapeRegExp(asset);
    if (role === "tokenIn") {
      if (hasPromptBoundPrimaryAmount(intent, text, network)) {
        return true;
      }
      return new RegExp(
        `(?:max|all|everything|hepsi|tümü|tumu)` +
          `[^,;:.!?\\n]{0,32}${escaped}|` +
          `${escaped}[^,;:.!?\\n]{0,32}` +
          `(?:max|all|everything|hepsi|tümü|tumu)`,
        "iu",
      ).test(text);
    }
    if (role === "tokenOut") {
      if (
        intent.secondaryAmount !== undefined &&
        hasPromptBoundAmountForAsset(
          intent.secondaryAmount,
          asset,
          text,
          network,
        )
      ) {
        return true;
      }
      return new RegExp(
        `(?:to|into|for|->|buy|receive|get|al|satın\\s+al|` +
          `output|cikti|target)[^,;:.!?\n]{0,24}${escaped}`,
        "iu",
      ).test(text);
    }
    const roleWords =
      role === "collateralToken"
        ? "(?:collateral|teminat)"
        : "(?:borrow|debt|borç|borc)";
    return new RegExp(
      `${roleWords}[^,;:.!?\\n]{0,32}${escaped}|` +
        `${escaped}[^,;:.!?\\n]{0,32}${roleWords}`,
      "iu",
    ).test(text);
  }
  const mentioned = candidates.some(
    (candidate) => promptAssetOccurrences(candidate, text).length > 0,
  );
  if (!mentioned) return false;

  if (role === "tokenIn") {
    return true;
  }

  if (role === "tokenOut") {
    if (
      intent.action === "add_liquidity" ||
      intent.action === "remove_liquidity"
    ) {
      return true;
    }
    if (intent.action === "liquid_stake") {
      return hasPromptBoundPrimaryAmount(intent, text, network);
    }
    if (intent.action === "liquid_unstake" && asset.toUpperCase() === "ETH") {
      return true;
    }
    if (
      intent.minimumOutput !== undefined &&
      hasPromptBoundMinimumOutput(intent.minimumOutput, asset, text, network)
    ) {
      return true;
    }
    return candidates.some((candidate) => {
      const escaped = escapeRegExp(candidate).replace(/\s+/g, "\\s+");
      return new RegExp(
        `(?:\\b(?:to|into|for|buy|receive|get|target|hedef|` +
          `çıktı|cikti|almak\\s+için|almak\\s+icin)\\b|->)` +
          `[^,;:.!?\\n]{0,32}(?:^|[^\\p{L}\\p{N}_])${escaped}` +
          `(?=$|[^\\p{L}\\p{N}_])|` +
          `(?:^|[^\\p{L}\\p{N}_])${escaped}` +
          `(?:['’]?(?:yi|yı|yu|yü|i|ı|u|ü))?\\s*` +
          `(?:al|satın\\s+al|satin\\s+al|buy|receive|get)` +
          `(?=$|[^\\p{L}\\p{N}_])`,
        "iu",
      ).test(text);
    });
  }

  const roleWords =
    role === "collateralToken"
      ? "(?:collateral|teminat)"
      : "(?:borrow(?:ed)?|debt|loan|borç|borc)";
  return candidates.some((candidate) => {
    const escaped = escapeRegExp(candidate).replace(/\s+/g, "\\s+");
    return new RegExp(
      `${roleWords}[^,;:.!?\\n]{0,32}` +
        `(?:^|[^\\p{L}\\p{N}_])${escaped}` +
        `(?=$|[^\\p{L}\\p{N}_])|` +
        `(?:^|[^\\p{L}\\p{N}_])${escaped}` +
        `(?=$|[^\\p{L}\\p{N}_])[^,;:.!?\\n]{0,32}${roleWords}`,
      "iu",
    ).test(text);
  });
}

export function hasPromptBoundRecipientIdentity(
  value: unknown,
  text: string,
): boolean {
  if (hasPromptBoundAddress(value, text)) return true;
  const name = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.base(?:\.eth)?$/u.test(name)) {
    return false;
  }
  return new RegExp(
    `(?:^|[^a-z0-9-])${escapeRegExp(name)}(?=$|[^a-z0-9.-])`,
    "iu",
  ).test(text);
}

export function hasPromptBoundBasename(value: unknown, text: string): boolean {
  const label = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) {
    return false;
  }
  const escaped = escapeRegExp(label);
  return new RegExp(
    `(?:^|[^a-z0-9-])${escaped}\\.base\\.eth(?=$|[^a-z0-9.])|` +
      `\\b(?:base\\s+name|basename)\\b[^,;:.!?\\n]{0,32}` +
      `(?:^|[^a-z0-9-])${escaped}(?=$|[^a-z0-9-])|` +
      `(?:^|[^a-z0-9-])${escaped}(?=$|[^a-z0-9-])` +
      `[^,;:.!?\\n]{0,32}\\b(?:base\\s+name|basename)\\b`,
    "iu",
  ).test(text);
}

export function hasPromptBoundDestination(
  value: unknown,
  text: string,
  network: NetworkId,
): boolean {
  const destination = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-")
    .replace(/\s+/g, "-");
  const allowed =
    network === "base"
      ? new Set(["ethereum", "arbitrum", "optimism"])
      : new Set([
          "arbitrum-sepolia",
          "avalanche-fuji",
          "base-sepolia",
          "ethereum-sepolia",
          "optimism-sepolia",
        ]);
  if (!allowed.has(destination)) return false;
  const phrase = destination.split("-").map(escapeRegExp).join("[\\s_-]+");
  return new RegExp(
    `(?:^|[^\\p{L}\\p{N}_])${phrase}` +
      `(?:['’]?(?:a|e|ya|ye|da|de|dan|den))?` +
      `(?=$|[^\\p{L}\\p{N}_])`,
    "iu",
  ).test(text);
}

export function hasPromptBoundAmountForAsset(
  amountValue: unknown,
  assetValue: unknown,
  text: string,
  network: NetworkId,
): boolean {
  const amount = normalizePromptDecimal(amountValue);
  const asset = String(assetValue ?? "").trim();
  if (!amount || !asset) return false;
  const references = [asset, ...assetAliasesForSymbol(network, asset)].filter(
    (value, index, values) =>
      value.length <= 128 &&
      values.findIndex(
        (candidate) => candidate.toLowerCase() === value.toLowerCase(),
      ) === index,
  );
  return references.some((reference) => {
    const escapedAsset = escapeRegExp(reference).replace(/\s+/g, "\\s+");
    const patterns = [
      new RegExp(
        `((?:\\d+(?:[.,]\\d+)?|[.,]\\d+))\\s+` +
          `(?:native\\s+)?${escapedAsset}(?=$|[^a-zA-Z0-9])`,
        "giu",
      ),
      new RegExp(
        `(?:^|[^a-zA-Z0-9])${escapedAsset}\\s+` +
          `(?:(?:amount|miktar(?:ı|i)?)\\s+)?` +
          `((?:\\d+(?:[.,]\\d+)?|[.,]\\d+))`,
        "giu",
      ),
    ];
    return patterns.some((pattern) =>
      Array.from(text.matchAll(pattern)).some(
        (match) => normalizePromptDecimal(match[1]) === amount,
      ),
    );
  });
}

export function explicitMemoReferences(text: string): Set<string> {
  const references = new Set<string>();
  const matcher =
    /\b(?:official\s+memo\s+reference|memo(?:\s+reference)?|reference|referans)\b\s*(?::|=|\bis\b)?\s*(?:"([^"]{1,128})"|'([^']{1,128})'|([^\s,;]{1,128}))/giu;
  for (const match of text.matchAll(matcher)) {
    references.add(String(match[1] || match[2] || match[3]).trim());
  }
  return references;
}

export function explicitPaymentCaps(text: string): Set<string> {
  const caps = new Set<string>();
  const patterns = [
    /(?:at\s+most|up\s+to|under|below|max(?:imum)?|cap|limit|en\s+fazla|tavan(?:ı|i)?)[^\d\n]{0,20}(\d+(?:[.,]\d+)?)\s*USDC/giu,
    /(\d+(?:[.,]\d+)?)\s*USDC[^,;:.!?\n]{0,24}(?:at\s+most|or\s+less|under|below|max(?:imum)?|cap|limit|altında|altinda|en\s+fazla|tavan)/giu,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = normalizePromptDecimal(match[1]);
      if (value) caps.add(value);
    }
  }
  return caps;
}

export function explicitSlippage(text: string): string | null {
  const match =
    /(?:slippage[^\d\n]{0,16}(\d+(?:[.,]\d+)?)\s*%|(\d+(?:[.,]\d+)?)\s*%\s*slippage)/iu.exec(
      text,
    );
  return normalizePromptDecimal(match?.[1] || match?.[2]);
}

export function hasPromptBoundMinimumOutput(
  value: unknown,
  tokenOut: unknown,
  text: string,
  network: NetworkId,
): boolean {
  const expected = normalizePromptDecimal(value);
  const asset = String(tokenOut ?? "").trim();
  if (!expected || !asset) return false;
  const references = [asset, ...assetAliasesForSymbol(network, asset)];
  return references.some((reference) => {
    const matcher = new RegExp(
      `(?:accept|receive|get|minimum|min(?:imum)?\\s+output|` +
        `en\\s+az|minimum\\s+çıktı|minimum\\s+cikti)` +
        `[^,;:.!?\\n]{0,48}(?:less\\s+than\\s+|at\\s+least\\s+)?` +
        `((?:\\d+(?:[.,]\\d+)?|[.,]\\d+))\\s+` +
        `${escapeRegExp(reference).replace(/\s+/g, "\\s+")}` +
        `(?=$|[^a-zA-Z0-9])`,
      "giu",
    );
    return Array.from(text.matchAll(matcher)).some(
      (match) => normalizePromptDecimal(match[1]) === expected,
    );
  });
}

export function hasPromptBoundFee(value: unknown, text: string): boolean {
  const expected = normalizePromptDecimal(value);
  if (!expected) return false;
  const patterns = [
    /(?:max(?:imum)?\s+fee|fee\s+(?:cap|limit)|en\s+fazla\s+ücret|ücret\s+tavanı)[^\d\n]{0,20}(\d+(?:[.,]\d+)?)/giu,
    /(\d+(?:[.,]\d+)?)\s*USDC[^,;:.!?\n]{0,20}(?:max(?:imum)?\s+fee|fee\s+(?:cap|limit)|ücret\s+tavanı)/giu,
  ];
  return patterns.some((pattern) =>
    Array.from(text.matchAll(pattern)).some(
      (match) => normalizePromptDecimal(match[1]) === expected,
    ),
  );
}

export function explicitDeployTokenIdentity(
  text: string,
): { name: string; symbol: string } | null {
  const patterns = [
    /\b(?:create|deploy|launch)\s+(?:a\s+)?token\s+(?:named\s+)?(.{1,64}?)\s+(?:with\s+)?(?:ticker|symbol)\s+([a-zA-Z][a-zA-Z0-9]{0,9})(?=$|[\s,;.])/iu,
    /\b(?:create|deploy|launch)\s+(?:a\s+)?(?:token\s+(?:named\s+)?)?(.{1,64}?)\s*\(\s*([a-zA-Z][a-zA-Z0-9]{0,9})\s*\)/iu,
    /\b(?:create|deploy|launch)\s+(.{1,64}?)\s+(?:with\s+)?symbol\s+([a-zA-Z][a-zA-Z0-9]{0,9})(?=$|[\s,;.])/iu,
    /\b(.{1,64}?)\s+adlı\s+token(?:i)?\s+([a-zA-Z][a-zA-Z0-9]{0,9})\s+sembol(?:ü|u)/iu,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) {
      return {
        name: match[1].trim().replace(/\s+/g, " "),
        symbol: match[2].toUpperCase(),
      };
    }
  }
  return null;
}

export function explicitDeployTokenSupply(text: string): string | null {
  const match =
    /\bsupply\s+(?:of\s+)?(\d+(?:[.,]\d+)?)\b|\b(\d+(?:[.,]\d+)?)\s+(?:token\s+)?supply\b/iu.exec(
      text,
    );
  return normalizePromptDecimal(match?.[1] || match?.[2]);
}

export function explicitTokenLaunchId(text: string): string | null {
  const quoted =
    /\b(?:launch\s*id|launch\s+identifier|lansman\s+kimliği|lansman\s+kimligi)\b\s*(?:is|=|:)?\s*["']([^"'\r\n]{1,128})["']/iu.exec(
      text,
    );
  if (quoted) return quoted[1];
  const unquoted =
    /\b(?:launch\s*id|launch\s+identifier|lansman\s+kimliği|lansman\s+kimligi)\b\s*(?:is|=|:)?\s*([a-zA-Z0-9][a-zA-Z0-9._:-]{0,127})(?=$|[\s,;.])/iu.exec(
      text,
    );
  return unquoted?.[1] || null;
}

export function explicitTransferSpeed(text: string): "FAST" | "SLOW" | null {
  const match =
    /(?:^|[^\p{L}\p{N}_])(FAST|SLOW)(?:\s+(?:mode|modu))?(?=$|[^\p{L}\p{N}_])/iu.exec(
      text,
    );
  return match ? (match[1].toUpperCase() as "FAST" | "SLOW") : null;
}

export function explicitMaxGas(text: string): string | null {
  const match =
    /(?:max(?:imum)?\s+gas(?:\s+(?:price|fee))?|gas\s+(?:cap|limit)|azami\s+gas)[^\d\n]{0,20}(?<![-+])(\d+(?:[.,]\d+)?)(?![a-z0-9.,])/iu.exec(
      text,
    );
  return normalizePromptDecimal(match?.[1]);
}

export function explicitMaxPriceImpactBps(text: string): number | null {
  const bps =
    /(?:max(?:imum)?\s+price\s+impact|price\s+impact\s+(?:cap|limit)|maksimum\s+fiyat\s+etkisi)[^\d\n]{0,20}(?<![-+])(\d+)\s*(?:bps|basis\s+points?)/iu.exec(
      text,
    );
  if (bps) {
    const value = Number(bps[1]);
    return Number.isSafeInteger(value) ? value : null;
  }
  const percent =
    /(?:max(?:imum)?\s+price\s+impact|price\s+impact\s+(?:cap|limit)|maksimum\s+fiyat\s+etkisi)[^\d\n]{0,20}(?<![-+])(\d+(?:[.,]\d+)?)\s*%/iu.exec(
      text,
    );
  if (!percent) return null;
  const value = Number(percent[1].replace(",", ".")) * 100;
  return Number.isSafeInteger(value) ? value : null;
}

function hasExplicitMaxGasConstraint(text: string): boolean {
  return /(?:max(?:imum)?\s+gas(?:\s+(?:price|fee))?|gas\s+(?:cap|limit)|azami\s+gas)\b/iu.test(
    text,
  );
}

function hasExplicitMaxPriceImpactConstraint(text: string): boolean {
  return /(?:max(?:imum)?\s+price\s+impact|price\s+impact\s+(?:cap|limit)|maksimum\s+fiyat\s+etkisi)\b/iu.test(
    text,
  );
}

export function baseExecutionConstraintFailure(text: string): string | null {
  if (hasExplicitMaxGasConstraint(text)) {
    const maxGas = explicitMaxGas(text);
    if (maxGas === null || Number(maxGas) <= 0) {
      return "Maximum gas limit could not be safely parsed; you must specify it again with a positive decimal value.";
    }
  }
  if (hasExplicitMaxPriceImpactConstraint(text)) {
    const maxPriceImpactBps = explicitMaxPriceImpactBps(text);
    if (
      maxPriceImpactBps === null ||
      maxPriceImpactBps < 1 ||
      maxPriceImpactBps > 5_000
    ) {
      return "Maximum price impact must be an explicit limit between 1-5000 bps; no route was prepared.";
    }
  }
  return null;
}

function baseActionsInClause(text: string): Set<string> {
  const actions = new Set<string>();
  const yieldComparison =
    /\b(?:yield\s+compare|compare\b[^,;:.!?\n]{0,64}\b(?:rates?|yield)|(?:apy|apr)\b|(?:getiri|faiz)[^,;:.!?\n]{0,64}(?:karşılaştır|karsilastir)|(?:karşılaştır|karsilastir)[^,;:.!?\n]{0,64}(?:getiri|faiz))\b/iu.test(
      text,
    );
  const basename =
    /\.base\.eth\b/iu.test(text) &&
    /\b(?:register|buy|purchase|renew|extend|kaydet|kayıt\s+et|satın\s+al|yenile|uzat)\b/iu.test(
      text,
    );
  const deployToken = hasPromptBoundBaseAction("deploy_token", text);
  const addLiquidity = hasPromptBoundBaseAction("add_liquidity", text);
  const removeLiquidity = hasPromptBoundBaseAction("remove_liquidity", text);
  const liquidStake = hasPromptBoundBaseAction("liquid_stake", text);
  const liquidUnstake = hasPromptBoundBaseAction("liquid_unstake", text);

  if (addLiquidity) actions.add("add_liquidity");
  if (removeLiquidity) actions.add("remove_liquidity");
  if (liquidStake) actions.add("liquid_stake");
  if (liquidUnstake) actions.add("liquid_unstake");

  if (hasPromptBoundBaseAction("repay", text)) actions.add("repay");
  if (!yieldComparison && hasPromptBoundBaseAction("borrow", text)) {
    actions.add("borrow");
  }

  const explicitLendingAction =
    /\b(?:lend|earn|borç\s+ver|faize\s+yatır|mevduat(?:a)?\s+yatır)\b/iu.test(
      text,
    );
  const supplyAction = /\bsupply\b/iu.test(text);
  const genericDeposit = /\b(?:deposit|yatır)\b/iu.test(text);
  if (
    !yieldComparison &&
    (explicitLendingAction ||
      (supplyAction && !deployToken) ||
      (genericDeposit && !addLiquidity))
  ) {
    actions.add("lend");
  }

  if (hasPromptBoundBaseAction("withdraw", text) && !removeLiquidity) {
    actions.add("withdraw");
  }
  if (
    hasPromptBoundBaseAction("stake", text) &&
    !liquidStake &&
    !liquidUnstake
  ) {
    actions.add("stake");
  }
  if (hasPromptBoundBaseAction("swap", text) && !basename) {
    actions.add("swap");
  }
  if (hasPromptBoundBaseAction("bridge", text)) actions.add("bridge");
  if (deployToken) {
    actions.add("deploy_token");
  }
  if (basename) {
    if (hasPromptBoundBaseAction("basename_renew", text)) {
      actions.add("basename_renew");
    } else {
      actions.add("basename_register");
    }
  }
  if (hasPromptBoundBaseAction("x402_request", text)) {
    actions.add("x402_request");
  } else if (hasPromptBoundBaseAction("x402_discover", text)) {
    actions.add("x402_discover");
  }
  if (yieldComparison) {
    actions.add("yield_compare");
  }
  return actions;
}

export function conflictingBaseActions(text: string): string[] {
  if (hasPromptBoundBaseAction("deploy_token", text)) {
    return [...baseActionsInClause(text)];
  }
  const clauses = text
    .split(
      /\s*(?:;|,(?=\s*[\p{L}])|\b(?:and\s+then|then|after\s+that|ve\s+sonra|ardından|ardindan|sonra|and|ve)\b)\s*/iu,
    )
    .filter(Boolean);
  const actions = new Set<string>();
  for (const clause of clauses.length > 0 ? clauses : [text]) {
    for (const action of baseActionsInClause(clause)) {
      actions.add(action);
    }
  }
  return [...actions];
}

export function isExplicitlyExcludedProtocol(protocol: string, text: string): boolean {
  const escaped = escapeRegExp(protocol).replace(/\\-/g, "[-_\\s]");
  return new RegExp(
    `(?:\\b(?:exclude|avoid|except|without|not\\s+using|` +
      `do\\s+not\\s+use|don['’]?t\\s+use|hariç|haric|kullanma)\\b` +
      `[^,;:.!?\\n]{0,48}(?:^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])|` +
      `\\bnot\\s+(?:the\\s+)?${escaped}(?=$|[^a-z0-9])|` +
      `(?:^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])` +
      `[^,;:.!?\\n]{0,48}\\b(?:exclude|excluded|hariç|haric|olmasın|olmasin)\\b)`,
    "iu",
  ).test(text);
}

export function explicitlyAllowsUncuratedX402(text: string): boolean {
  return /\b(?:uncurated|unverified|broader\s+(?:catalog|results?)|all\s+(?:catalog|services?)|include\s+unverified|do\s+not\s+limit\s+to\s+curated|curated\s*[:=]\s*false|kürasyonsuz|kurasyonsuz|doğrulanmamış|dogrulanmamis|tüm\s+servisler)\b/iu.test(
    text,
  );
}

export function normalizedPromptIdentity(value: unknown): string {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("tr-TR");
}

export function buildPromptBindingText(
  currentPrompt: string,
  _conversationHistory: unknown[],
): string {
  // Conversation history is client-provided context, not transaction
  // authorization. Only the current user turn may bind executable fields.
  // A future multi-turn flow must carry a server-signed pending-intent object
  // instead of recycling raw prior chat text.
  return currentPrompt;
}

export function promptBindingFailure(message: string): ParsedIntent {
  return {
    isComplete: false,
    action: "chat",
    message,
    question: message,
    amount: "0",
    durationInDays: 0,
  };
}
