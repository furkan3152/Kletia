/**
 * Deterministic single-clause Base intent grammar.
 */
import { IntentSchema, type ParsedIntent } from "./schema.js";
import { hasPromptBoundBaseAction } from "./promptEvidence.js";
import {
  explicitDeployTokenIdentity,
  explicitDeployTokenSupply,
  explicitTokenLaunchId,
} from "./promptConstraints.js";
import {
  detectRiskTolerance,
  extractAmount,
  extractAmountForToken,
  extractBaseProtocol,
  extractMinimumOutputForToken,
  extractNamedBaseYieldProtocols,
  extractSlippagePercent,
  isExplicitProtocolTokenOccurrence,
  locateBaseTokens,
} from "./baseExtraction.js";
import {
  deterministicIntent,
  extractDurationInDays,
  isDeterministicPortfolioRead,
  parseDeterministicBasenameIntent,
} from "./clauses.js";

/**
 * High-confidence Base grammar. Clear financial commands stay available even
 * when the LLM provider is unavailable; ambiguous language still falls back to
 * the model and the normal completeness checks.
 */
export function parseRawDeterministicBaseIntent(
  userPrompt: string,
): ParsedIntent | null {
  const prompt = userPrompt.trim();
  if (!prompt || prompt.length > 2_000) return null;
  const lower = prompt.toLocaleLowerCase("tr-TR");
  if (/\barc(?:\s+testnet)?\b/i.test(lower)) return null;

  if (isDeterministicPortfolioRead(prompt)) {
    return deterministicIntent({
      action: "portfolio",
      amount: "0",
      message: "Reading the live Base portfolio and reviewed positions.",
    });
  }

  const directBridge = /^(?:bridge|move|köprüle|koprule)\s+(\d+(?:[.,]\d+)?)\s+(USDC|WETH|ETH)\s+(?:from\s+Base\s+)?to\s+Arbitrum(?:\s+One)?(?:\s+using\s+Across)?$/iu.exec(
    prompt,
  );
  if (directBridge) {
    const requestedAsset = directBridge[2].toUpperCase();
    if (requestedAsset === "ETH") {
      return IntentSchema.parse({
        isComplete: false,
        action: "bridge",
        amount: directBridge[1].replace(",", "."),
        tokenIn: "ETH",
        question: "The reviewed Base to Arbitrum bridge uses WETH or USDC. Use WETH instead of native ETH?",
        message: "The reviewed Base to Arbitrum bridge uses WETH or USDC. Use WETH instead of native ETH?",
      });
    }
    return deterministicIntent({
      action: "bridge",
      tokenIn: requestedAsset,
      amount: directBridge[1].replace(",", "."),
      destinationChain: "arbitrum",
      protocol: "across",
      message: "Preparing the reviewed Base to Arbitrum Across route.",
    });
  }

  const deployIdentity = explicitDeployTokenIdentity(prompt);
  const deploySupply = explicitDeployTokenSupply(prompt);
  if (
    deployIdentity &&
    deploySupply &&
    hasPromptBoundBaseAction("deploy_token", prompt)
  ) {
    const launchId = explicitTokenLaunchId(prompt);
    return deterministicIntent({
      action: "deploy_token",
      name: deployIdentity.name,
      symbol: deployIdentity.symbol,
      amount: deploySupply,
      ...(launchId === null ? {} : { launchId }),
      message: "Preparing the verified Base token deployment.",
    });
  }

  const x402UrlMatch = /https:\/\/[^\s<>"']+/iu.exec(prompt);
  const x402Methods = [
    ...new Set(
      Array.from(prompt.matchAll(/\b(GET|POST)\b/giu), (match) =>
        match[1].toUpperCase(),
      ),
    ),
  ];
  const x402CapMatch =
    /(?:pay\s+at\s+most|max(?:imum)?(?:\s+payment)?|cap(?:ped)?(?:\s+at)?|limit(?:ed)?(?:\s+to)?|en\s+fazla)\s*(\d+(?:[.,]\d+)?)\s*USDC\b/iu.exec(
      prompt,
    );
  if (
    /\bx402\b/iu.test(prompt) &&
    x402UrlMatch &&
    x402Methods.length === 1 &&
    x402CapMatch &&
    !/\b(?:then|after|next|and then)\b|sonra|ardından|ardindan/iu.test(prompt)
  ) {
    const url = x402UrlMatch[0].replace(/[),.;!?]+$/u, "");
    try {
      const parsedUrl = new URL(url);
      if (parsedUrl.protocol !== "https:") return null;
    } catch {
      return null;
    }
    return deterministicIntent({
      action: "x402_request",
      url,
      method: x402Methods[0] as "GET" | "POST",
      maxPayment: x402CapMatch[1].replace(",", "."),
      amount: "0",
      message: "Preparing a capped Base x402 request for wallet approval.",
    });
  }

  const basenameIntent = parseDeterministicBasenameIntent(prompt);
  if (basenameIntent) return basenameIntent;
  const tokens = locateBaseTokens(prompt).filter(
    (token) => !isExplicitProtocolTokenOccurrence(prompt, token),
  );
  const amount = extractAmount(prompt, tokens);
  let protocol = extractBaseProtocol(prompt);
  const riskTolerance = detectRiskTolerance(prompt);

  const isYieldComparison =
    /\b(best yield|compare (?:the )?(?:rates|yield)|yield compare|apy|apr|en iyi getiri|en yüksek faiz|en düşük borç faizi|borrow (?:rates?|cost)|borç faiz(?:ini|lerini)? karşılaştır|faiz(?:leri|lerini| oranlar[ıi]n[ıi])? karşılaştır|hangi protokol daha çok kazandır)/i.test(
      lower,
    );
  if (isYieldComparison && tokens.length >= 1) {
    const comparedProtocols = extractNamedBaseYieldProtocols(prompt);
    if (comparedProtocols.length > 1) {
      // A single protocol filter would silently turn “compare A, B and
      // C” into a one-row board. Multi-protocol comparisons deliberately
      // leave the filter open so every verified eligible market enters.
      protocol = undefined;
    }
    const compareBorrow =
      /(?:\b(?:borrow|kredi|lowest borrow|en düşük faiz)\b|borç)/i.test(lower);
    return deterministicIntent({
      action: "yield_compare",
      tokenIn: tokens[0].symbol,
      amount: "0",
      protocol,
      objective: compareBorrow ? "lowest_borrow_cost" : "best_rate",
      riskTolerance,
      message: "Comparing live Base lending rates and liquidity.",
    });
  }

  const isRemoveLiquidity =
    /(remove|withdraw|exit|çek|çıkar|kaldır|boz).{0,32}\b(liquidity|likidite|lp|pool|havuz)|\b(liquidity|likidite|lp|pool|havuz)(?:yi|yı|u|ü|dan|den|undan|ünden|ından|inden)?\b.{0,32}(remove|withdraw|exit|çek|çıkar|kaldır|boz)/i.test(
      lower,
    );
  const isAddLiquidity =
    !isRemoveLiquidity &&
    /(add|provide|deposit|ekle|sağla|yatır).{0,32}\b(liquidity|likidite|lp|pool|havuz)|\b(liquidity|likidite|lp|pool|havuz)(?:a|e|ya|ye|una|üne|ına|ine)?\b.{0,32}(add|provide|deposit|ekle|sağla|yatır)/i.test(
      lower,
    );
  if ((isAddLiquidity || isRemoveLiquidity) && tokens.length >= 2 && amount) {
    const secondaryAmount = isAddLiquidity
      ? extractAmountForToken(prompt, tokens[1])
      : undefined;
    return deterministicIntent({
      action: isRemoveLiquidity ? "remove_liquidity" : "add_liquidity",
      tokenIn: tokens[0].symbol,
      tokenOut: tokens[1].symbol,
      amount,
      secondaryAmount,
      protocol,
      riskTolerance,
      message:
        `Preparing factory-bound Base ` +
        `${isRemoveLiquidity ? "liquidity removal" : "liquidity addition"} routes.`,
    });
  }

  const isLiquidStake =
    /\b(liquid stake|liquid staking|likit stake|likit staking|l[r]?t al|l[r]?t edin)\b/i.test(
      lower,
    );
  const liquidToken = tokens.find(({ symbol }) =>
    ["WSTETH", "CBETH", "RETH", "WEETH", "EZETH", "WRSETH"].includes(symbol),
  );
  if (isLiquidStake && liquidToken && amount) {
    const unstake = /\b(unstake|boz|redeem|çık|sat)\b/i.test(lower);
    return deterministicIntent({
      action: unstake ? "liquid_unstake" : "liquid_stake",
      tokenIn: unstake ? liquidToken.symbol : "ETH",
      tokenOut: unstake ? "ETH" : liquidToken.symbol,
      amount,
      riskTolerance,
      message: `Preparing a live Base ${unstake ? "LST/LRT exit" : "LST/LRT acquisition"} route.`,
    });
  }

  const action = /\b(repay|pay back|borç öde|borcu öde|geri öde)\b/i.test(lower)
    ? "repay"
    : /\b(borrow|borç al|kredi çek)\b/i.test(lower)
      ? "borrow"
      : /\b(withdraw|geri çek|pozisyon(?:u)? çek|mevduat(?:ı)? çek|çek)\b/i.test(
            lower,
          )
        ? "withdraw"
        : /\b(lend|supply|deposit|earn|borç ver|faize yatır|mevduat yatır|yatır)\b/i.test(
              lower,
            )
          ? "lend"
          : null;
  if (action && tokens.length >= 1 && amount) {
    if (protocol === "seamless-staking") {
      protocol = "seamless-vault";
    }
    return deterministicIntent({
      action,
      tokenIn: tokens[0].symbol,
      amount,
      protocol,
      objective:
        action === "borrow"
          ? "lowest_borrow_cost"
          : action === "lend"
            ? "best_rate"
            : undefined,
      riskTolerance,
      message: `Preparing verified Base ${action} routes.`,
    });
  }

  const isStake = /\b(stake|staking|kilitle|lock)\b/i.test(lower);
  const stakingToken = tokens.find(({ symbol }) =>
    ["AERO", "WELL", "SEAM"].includes(symbol),
  );
  if (isStake && stakingToken && amount) {
    if (stakingToken.symbol === "WELL") {
      protocol = "moonwell-safety-module";
    } else if (stakingToken.symbol === "SEAM") {
      protocol = "seamless-staking";
    } else {
      protocol = protocol || "aerodrome";
    }
    const durationInDays = extractDurationInDays(prompt) ?? 30;
    return deterministicIntent({
      action: "stake",
      tokenIn: stakingToken.symbol,
      amount,
      protocol,
      durationInDays,
      riskTolerance,
      message: "Preparing a direct user-owned Base staking position.",
    });
  }

  const swapVerb =
    /\b(swap|swapp?ing|convert|converting|takas|değiştir|cevir|çevir|buy|satın al|al|sell|sat)\b/i.exec(
      lower,
    );
  if (swapVerb && tokens.length >= 2 && amount) {
    let tokenIn = tokens[0].symbol;
    let tokenOut = tokens[1].symbol;
    let inputToken = tokens[0];
    if (/\b(buy|satın al|al)\b/i.test(lower)) {
      const verbIndex = lower.search(/\b(buy|satın al|al)\b/i);
      const afterVerb = tokens.filter(({ index }) => index > verbIndex);
      if (lower.startsWith("buy") || lower.startsWith("satın al")) {
        tokenOut = afterVerb[0]?.symbol || tokens[0].symbol;
        tokenIn =
          tokens.find(({ symbol }) => symbol !== tokenOut)?.symbol ||
          tokens[1].symbol;
      } else {
        tokenIn = tokens[0].symbol;
        tokenOut = tokens[tokens.length - 1].symbol;
      }
    } else if (/\b(sell|sat)\b/i.test(lower)) {
      tokenIn = tokens[0].symbol;
      tokenOut = tokens[1].symbol;
    } else {
      const afterVerb = tokens.filter(
        ({ index }) => index > (swapVerb.index ?? -1),
      );
      if (afterVerb.length > 0) {
        inputToken = afterVerb[0];
        tokenIn = inputToken.symbol;
        tokenOut =
          afterVerb[1]?.symbol ||
          tokens.find(({ symbol }) => symbol !== tokenIn)?.symbol ||
          tokens[1].symbol;
      }
    }
    inputToken =
      tokens.find(
        ({ symbol, index }) =>
          symbol === tokenIn &&
          (index === inputToken.index ||
            extractAmountForToken(prompt, { symbol, index }) !== undefined),
      ) || inputToken;
    const explicitInputAmount = extractAmountForToken(prompt, inputToken);
    const swapAmount =
      explicitInputAmount || (amount === "MAX" ? amount : undefined);
    const outputToken = tokens.find(({ symbol }) => symbol === tokenOut);
    if (tokenIn !== tokenOut && swapAmount) {
      return deterministicIntent({
        action: "swap",
        tokenIn,
        tokenOut,
        amount: swapAmount,
        protocol,
        objective: "best_output",
        riskTolerance,
        slippage: extractSlippagePercent(prompt) || "1",
        minimumOutput: extractMinimumOutputForToken(prompt, outputToken),
        message: "Scanning live Base swap routes.",
      });
    }
  }

  return null;
}
