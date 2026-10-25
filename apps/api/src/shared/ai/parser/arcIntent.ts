/**
 * Deterministic Arc intent parsing.
 */
import { IntentSchema, type ParsedIntent } from "./schema.js";
import {
  bindPrivateFieldSlots,
  deterministicIntent,
  hasOrderedIntentConnector,
  isDeterministicPortfolioRead,
  preparePrivateFieldSlots,
} from "./clauses.js";
import {
  ARC_NATURAL_AMOUNT,
  ARC_WIDGET_ADDRESS,
  ARC_WIDGET_AMOUNT,
  canonicalArcAppKitToken,
  normalizeScaledArcAmount,
  parseArcNaturalClause,
  parseDeterministicArcWorkflowIntent,
} from "./arcClauses.js";

/**
 * High-confidence grammar for text emitted by the canonical Arc widgets.
 * Matching is deliberately anchored: edited or ambiguous natural language
 * continues through the normal model/schema path instead of being guessed.
 */
function parsePreparedDeterministicArcIntent(
  userPrompt: string,
): ParsedIntent | null {
  const prompt = preparePrivateFieldSlots(userPrompt)
    .trim()
    .replace(/[.!]+$/u, "");
  if (!prompt || prompt.length > 2_000) return null;

  const finish = (intent: ParsedIntent | null): ParsedIntent | null =>
    bindPrivateFieldSlots(intent, userPrompt);

  if (isDeterministicPortfolioRead(prompt)) {
    return finish(deterministicIntent({
      action: "portfolio",
      amount: "0",
      message: "Reading the live Arc wallet and protocol positions.",
    }));
  }

  const naturalSend = new RegExp(
    `^(?:send|pay|transfer|gönder|gonder|öde|ode|aktar)\\s+${ARC_NATURAL_AMOUNT}\\s+(USDC|EURC)(?:\\s+on\\s+Arc(?:\\s+Testnet)?)?\\s+(?:to|->)\\s*(${ARC_WIDGET_ADDRESS})$`,
    "iu",
  ).exec(prompt);
  if (naturalSend) {
    return finish(deterministicIntent({
      action: "appkit_send",
      tokenIn: naturalSend[3].toUpperCase(),
      amount: normalizeScaledArcAmount(naturalSend[1], naturalSend[2]),
      recipient: naturalSend[5],
      message: "Preparing the reviewed Arc App Kit transfer.",
    }));
  }

  const incompleteNaturalSend = new RegExp(
    `^(?:send|pay|transfer|gönder|gonder|öde|ode|aktar)\\s+${ARC_NATURAL_AMOUNT}\\s+(USDC|EURC)(?:\\s+on\\s+Arc(?:\\s+Testnet)?)?$`,
    "iu",
  ).exec(prompt);
  if (incompleteNaturalSend) {
    const amount = normalizeScaledArcAmount(
      incompleteNaturalSend[1],
      incompleteNaturalSend[2],
    );
    return finish(IntentSchema.parse({
      isComplete: false,
      action: "appkit_send",
      tokenIn: incompleteNaturalSend[3].toUpperCase(),
      amount,
      question: "Which EVM address should receive this Arc transfer?",
      message: "Add the recipient address to continue.",
    }));
  }

  const naturalBridge = new RegExp(
    `^(?:bridge|move)\\s+${ARC_NATURAL_AMOUNT}\\s+(?:native\\s+)?USDC(?:\\s+from\\s+Arc(?:\\s+Testnet)?)?\\s+to\\s+((?:Base|Ethereum|Arbitrum|Optimism)\\s+Sepolia|Avalanche\\s+Fuji)(?:\\s+(?:for|to)\\s+(${ARC_WIDGET_ADDRESS}))?$`,
    "iu",
  ).exec(prompt);
  if (naturalBridge) {
    const destination = naturalBridge[3]
      .trim()
      .toLowerCase()
      .replace(/\s+/gu, "-");
    const amount = normalizeScaledArcAmount(
      naturalBridge[1],
      naturalBridge[2],
    );
    const recipient = naturalBridge[5];
    if (!recipient) {
      return finish(IntentSchema.parse({
        isComplete: false,
        action: "appkit_bridge",
        tokenIn: "USDC",
        amount,
        destinationChain: destination,
        transferSpeed: "SLOW",
        question: "Which EVM address should receive the bridged USDC?",
        message: "Add the destination EVM address to prepare the Arc App Kit bridge.",
      }));
    }
    return finish(deterministicIntent({
      action: "appkit_bridge",
      tokenIn: "USDC",
      amount,
      destinationChain: destination,
      recipient,
      transferSpeed: "SLOW",
      message: "Preparing the Arc App Kit testnet bridge.",
    }));
  }

  const workflow = parseDeterministicArcWorkflowIntent(prompt);
  if (workflow) return finish(workflow);

  if (hasOrderedIntentConnector(prompt)) return null;

  const naturalAction = parseArcNaturalClause(prompt);
  if (naturalAction.status === "invalid") {
    return finish(IntentSchema.parse({
      isComplete: false,
      action: "unknown",
      amount: "0",
      question: naturalAction.question,
      message: naturalAction.question,
    }));
  }
  if (naturalAction.status === "matched") {
    const step = naturalAction.step;
    const action = ({
      lend: "lending_deposit",
      borrow: "lending_borrow",
      repay: "lending_repay",
    } as Record<string, string>)[step.action] || step.action;
    return finish(deterministicIntent({
      action,
      tokenIn: step.tokenIn,
      tokenOut: step.tokenOut,
      amount: step.amount || "0",
      protocol: step.protocol,
      objective: step.action === "swap" ? "best_output" : undefined,
      slippage: step.action === "swap" ? "1" : undefined,
      message: `Preparing the reviewed Arc ${action.replace(/_/gu, " ")} route.`,
    }));
  }

  let match =
    /(?:^|\b)(\d+(?:[.,]\d+)?)\s+(?:native\s+)?(USDC|KLET)\s+(?:ile|to|into|for|->)\s+(?:native\s+)?(USDC|KLET)(?:['’]?(?:yi|yı|yu|yü|i|ı|u|ü))?\s+(?:al|satın\s+al|satin\s+al|swap(?:la)?|takasla|çevir|cevir|convert|buy|sell)\b/iu.exec(
      prompt,
    );
  if (match) {
    const tokenIn = match[2].toUpperCase();
    const tokenOut = match[3].toUpperCase();
    if (tokenIn === tokenOut) return null;
    return finish(deterministicIntent({
      action: "swap",
      tokenIn,
      tokenOut,
      amount: match[1].replace(",", "."),
      objective: "best_output",
      slippage: "1",
      message: "Preparing the live Arc Kletia swap route.",
    }));
  }

  match =
    /^(?:I\s+want\s+to\s+)?(?:place|put|deposit|supply)\s+(\d+(?:[.,]\d+)?)\s+(?:native\s+)?(USDC|KLET)\s+(?:into|in|to)\s+(?:the\s+)?Kletia\s+lending\s+market\s+on\s+Arc\s+Testnet\s+as\s+collateral;\s*prepare\s+(?:a|the)\s+reviewable\s+route\s+before\s+wallet\s+approval$/iu.exec(
      prompt,
    );
  if (match) {
    return finish(deterministicIntent({
      action: "lending_deposit",
      tokenIn: match[2].toUpperCase(),
      amount: match[1].replace(",", "."),
      message: "Preparing the Arc lending collateral route for validation.",
    }));
  }

  match = new RegExp(
    `^Deposit ${ARC_WIDGET_AMOUNT} KLET as collateral in Kletia Lending on Arc Testnet; prepare the route and simulate it before wallet approval$`,
    "i",
  ).exec(prompt);
  if (match) {
    return finish(deterministicIntent({
      action: "lending_deposit",
      tokenIn: "KLET",
      amount: match[1],
      message: "Preparing the Arc KLET collateral deposit.",
    }));
  }

  match = new RegExp(
    `^Borrow ${ARC_WIDGET_AMOUNT} native USDC from Kletia Lending on Arc Testnet; prepare the route and simulate it before wallet approval$`,
    "i",
  ).exec(prompt);
  if (match) {
    return finish(deterministicIntent({
      action: "lending_borrow",
      tokenIn: "USDC",
      amount: match[1],
      message: "Preparing the Arc native USDC borrow.",
    }));
  }

  match = new RegExp(
    `^Repay ${ARC_WIDGET_AMOUNT} native USDC to Kletia Lending on Arc Testnet; prepare the route and simulate it before wallet approval$`,
    "i",
  ).exec(prompt);
  if (match) {
    return finish(deterministicIntent({
      action: "lending_repay",
      tokenIn: "USDC",
      amount: match[1],
      message: "Preparing the Arc native USDC repayment.",
    }));
  }

  match = new RegExp(
    `^Withdraw ${ARC_WIDGET_AMOUNT} KLET collateral from Kletia Lending on Arc Testnet; prepare the route and simulate it before wallet approval$`,
    "i",
  ).exec(prompt);
  if (match) {
    return finish(deterministicIntent({
      action: "lending_withdraw",
      tokenIn: "KLET",
      amount: match[1],
      message: "Preparing the Arc KLET collateral withdrawal.",
    }));
  }

  match = new RegExp(
    `^Swap ${ARC_WIDGET_AMOUNT} (native USDC|KLET) to (KLET|native USDC) on Arc Testnet using the live on-chain Kletia route; simulate it before wallet approval$`,
    "i",
  ).exec(prompt);
  if (match) {
    const tokenIn = match[2].toLowerCase() === "native usdc" ? "USDC" : "KLET";
    const tokenOut = match[3].toLowerCase() === "native usdc" ? "USDC" : "KLET";
    if (tokenIn === tokenOut) return null;
    return finish(deterministicIntent({
      action: "swap",
      tokenIn,
      tokenOut,
      amount: match[1],
      objective: "best_output",
      slippage: "1",
      message: "Preparing the live Arc Kletia swap route.",
    }));
  }

  match = new RegExp(
    `^Deposit ${ARC_WIDGET_AMOUNT} native USDC into the Kletia Vault on Arc Testnet; prepare the time-locked vault route and simulate it before wallet approval$`,
    "i",
  ).exec(prompt);
  if (match) {
    return finish(deterministicIntent({
      action: "vault_deposit",
      tokenIn: "USDC",
      amount: match[1],
      message: "Preparing the Arc vault deposit.",
    }));
  }

  if (
    /^Withdraw my full Kletia Vault position, including available principal and interest, on Arc Testnet; simulate it before wallet approval$/i.test(
      prompt,
    )
  ) {
    return deterministicIntent({
      action: "vault_withdraw",
      tokenIn: "USDC",
      amount: "0",
      message: "Preparing the full Arc vault withdrawal.",
    });
  }

  if (
    /^Withdraw my full legacy Kletia Vault position for migration on Arc Testnet; preserve every other depositor's principal and simulate it before wallet approval$/i.test(
      prompt,
    )
  ) {
    return deterministicIntent({
      action: "vault_legacy_withdraw",
      tokenIn: "USDC",
      amount: "0",
      message: "Preparing the legacy Arc vault migration withdrawal.",
    });
  }

  match = new RegExp(
    `^Stake ${ARC_WIDGET_AMOUNT} native USDC in Kletia Staking on Arc Testnet; prepare the route and simulate it before wallet approval$`,
    "i",
  ).exec(prompt);
  if (match) {
    return finish(deterministicIntent({
      action: "stake",
      tokenIn: "USDC",
      amount: match[1],
      message: "Preparing the Arc native USDC stake.",
    }));
  }

  match = new RegExp(
    `^Unstake ${ARC_WIDGET_AMOUNT} native USDC from Kletia Staking on Arc Testnet and start the contract-defined cooldown; simulate it before wallet approval$`,
    "i",
  ).exec(prompt);
  if (match) {
    return finish(deterministicIntent({
      action: "unstake",
      tokenIn: "USDC",
      amount: match[1],
      message: "Preparing the Arc unstake cooldown request.",
    }));
  }

  if (
    /^Claim all available rewards from Kletia Staking on Arc Testnet; simulate it before wallet approval$/i.test(
      prompt,
    )
  ) {
    return deterministicIntent({
      action: "claim_rewards",
      amount: "0",
      message: "Preparing the available Arc staking rewards claim.",
    });
  }

  if (
    /^Claim my cooled-down unstaked native USDC from Kletia Staking on Arc Testnet; simulate it before wallet approval$/i.test(
      prompt,
    )
  ) {
    return deterministicIntent({
      action: "claim_unstaked",
      amount: "0",
      message: "Preparing the cooled-down Arc unstake claim.",
    });
  }

  match = new RegExp(
    `^Add ${ARC_WIDGET_AMOUNT} native USDC liquidity to the KLET/USDC pool on Arc Testnet and spend at most ${ARC_WIDGET_AMOUNT} KLET; calculate and show the live requirement and enforce that hard cap before wallet approval$`,
    "i",
  ).exec(prompt);
  if (match) {
    return finish(deterministicIntent({
      action: "add_liquidity",
      tokenIn: "USDC",
      tokenOut: "KLET",
      amount: match[1],
      secondaryAmount: match[2],
      message: "Preparing the live-reserve Arc liquidity route.",
    }));
  }

  // The liquidity widget's LP exit: burns LP tokens of the Kletia Swap pool for its reserve share.
  match = new RegExp(
    `^Remove ${ARC_WIDGET_AMOUNT} LP tokens? from Kletia Swap on Arc Testnet(?:; simulate it before wallet approval)?$`,
    "i",
  ).exec(prompt);
  if (match) {
    return finish(deterministicIntent({
      action: "remove_liquidity",
      amount: match[1],
      message: "Preparing the Arc liquidity withdrawal.",
    }));
  }

  match = new RegExp(
    `^Send ${ARC_WIDGET_AMOUNT} native USDC to ${ARC_WIDGET_ADDRESS} through Kletia Memo Pay on Arc Testnet with the permanent public on-chain memo (.+); simulate it before wallet approval$`,
    "i",
  ).exec(prompt);
  if (match) {
    let memo: unknown;
    try {
      memo = JSON.parse(match[3]);
    } catch {
      return null;
    }
    if (
      typeof memo !== "string" ||
      !memo.trim() ||
      new TextEncoder().encode(memo.trim()).length > 256
    ) {
      return null;
    }
    return finish(deterministicIntent({
      action: "memo_send",
      tokenIn: "USDC",
      tokenOut: match[2],
      recipient: match[2],
      amount: match[1],
      name: memo.trim(),
      message: "Preparing the Arc memo transfer.",
    }));
  }

  const atomicPrefix = "Atomically pay ";
  const atomicSuffix =
    " on Arc Testnet through the official Multicall3From route; fail the whole batch if any payment fails and simulate it before wallet approval";
  if (prompt.startsWith(atomicPrefix) && prompt.endsWith(atomicSuffix)) {
    const payoutText = prompt.slice(atomicPrefix.length, -atomicSuffix.length);
    const entries = payoutText
      .split(/\s*,\s*/)
      .map((entry) =>
        new RegExp(
          `^${ARC_WIDGET_AMOUNT} native USDC to ${ARC_WIDGET_ADDRESS}$`,
          "i",
        ).exec(entry),
      );
    if (entries.length > 0 && entries.length <= 25 && entries.every(Boolean)) {
      const transfers = entries.map((entry) => ({
        amount: entry![1],
        recipient: entry![2],
      }));
      const uniqueRecipients = new Set(
        transfers.map(({ recipient }) => recipient.toLowerCase()),
      );
      if (uniqueRecipients.size === transfers.length) {
        return finish(deterministicIntent({
          action: "atomic_payout",
          tokenIn: "USDC",
          amount: "0",
          transfers,
          message: "Preparing the official Arc atomic payout.",
        }));
      }
    }
  }

  match = new RegExp(
    `^Swap ${ARC_WIDGET_AMOUNT} (USDC|EURC|cirBTC) to (USDC|EURC|cirBTC) on Arc Testnet, use (\\d+(?:\\.\\d+)?)% slippage and do not accept less than ${ARC_WIDGET_AMOUNT} (USDC|EURC|cirBTC)$`,
    "i",
  ).exec(prompt);
  if (match) {
    const tokenIn = canonicalArcAppKitToken(match[2]);
    const tokenOut = canonicalArcAppKitToken(match[3]);
    const minimumToken = canonicalArcAppKitToken(match[6]);
    if (tokenIn === tokenOut || tokenOut !== minimumToken) return null;
    return finish(deterministicIntent({
      action: "stable_swap",
      tokenIn,
      tokenOut,
      amount: match[1],
      slippage: match[4],
      minimumOutput: match[5],
      message: "Preparing the Arc App Kit stable swap.",
    }));
  }

  match = new RegExp(
    `^Bridge ${ARC_WIDGET_AMOUNT} USDC from Arc Testnet to (Base|Ethereum|Arbitrum|Optimism) Sepolia for ${ARC_WIDGET_ADDRESS} using (SLOW|FAST) mode$`,
    "i",
  ).exec(prompt);
  if (match) {
    return finish(deterministicIntent({
      action: "appkit_bridge",
      tokenIn: "USDC",
      amount: match[1],
      destinationChain: `${match[2].toLowerCase()}-sepolia`,
      recipient: match[3],
      transferSpeed: match[4].toUpperCase(),
      message: "Preparing the Arc App Kit testnet bridge.",
    }));
  }

  match = new RegExp(
    `^Send ${ARC_WIDGET_AMOUNT} (USDC|EURC) on Arc Testnet to ${ARC_WIDGET_ADDRESS} through Circle App Kit$`,
    "i",
  ).exec(prompt);
  if (match) {
    return finish(deterministicIntent({
      action: "appkit_send",
      tokenIn: match[2].toUpperCase(),
      amount: match[1],
      recipient: match[3],
      message: "Preparing the Arc App Kit transfer.",
    }));
  }

  match = new RegExp(
    `^Pay ${ARC_WIDGET_AMOUNT} USDC on Arc to ${ARC_WIDGET_ADDRESS} with official memo reference (\\S{1,128})$`,
    "i",
  ).exec(prompt);
  if (match) {
    return finish(deterministicIntent({
      action: "official_memo_send",
      tokenIn: "USDC",
      amount: match[1],
      recipient: match[2],
      memo: match[3],
      message: "Preparing the official Arc memo payment.",
    }));
  }

  if (
    /^Show my Arc portfolio and explain which Arc money routes are available without sending a transaction$/i.test(
      prompt,
    )
  ) {
    return deterministicIntent({
      action: "portfolio",
      amount: "0",
      message: "Reading the Arc portfolio and route availability.",
    });
  }

  if (
    /^Show my Arc staking, vault and lending positions using live onchain data$/i.test(
      prompt,
    )
  ) {
    return deterministicIntent({
      action: "portfolio",
      amount: "0",
      message: "Reading the live Arc staking, vault, and lending positions.",
    });
  }

  return null;
}

export function parseDeterministicArcIntent(
  userPrompt: string,
): ParsedIntent | null {
  const parserPrompt = preparePrivateFieldSlots(userPrompt);
  return bindPrivateFieldSlots(
    parsePreparedDeterministicArcIntent(parserPrompt),
    userPrompt,
  );
}
