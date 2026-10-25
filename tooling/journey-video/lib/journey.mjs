// The normal-user journey through the Kletia desk, chapter by chapter. Only
// the real UI is used: every step is a click, a key press or typed text a
// person could do, and each one asserts what that person should see. Fork
// limitations are said on screen in the captions, never hidden.

/** Sentences the journey types (also used to warm the forks before recording). */
export const SENTENCES = {
  swap: "swap 50 USDC to ETH on base with uniswap",
  lend: "deposit 100 USDC into aave on base",
  clarify: "swap 20 usdcc to eth on base",
  clarifyAnswered: "swap 20 USDC to ETH on base",
  bridge: "bridge 25 USDC from base to arbitrum",
  solanaSend: (recipient) => `send 1 USDC to ${recipient} on solana`,
  fees: "how much did I spend on fees today?",
  biggest: "what's my biggest position?",
};

const FORK = { fork: true, hold: 4200 };

function ui(d) {
  const page = d.page;
  return {
    page,
    nav: () => page.getByRole("navigation", { name: d.phone ? "Console views" : "Console" }),
    tasks: () => page.getByRole("region", { name: "Tasks in this tab" }),
    lastTask: () => page.getByRole("region", { name: "Tasks in this tab" }).locator(":scope > article").last(),
    composer: () => page.getByRole("textbox", { name: "Describe what should happen" }),
  };
}

async function openSection(d, name) {
  const { nav } = ui(d);
  await d.click(nav().getByRole("button", { name, exact: true }));
  await d.pause(900);
}

async function openView(d, section, view) {
  await openSection(d, section);
  const sub = d.page.getByRole("navigation", { name: `${section} views` });
  await d.click(sub.getByRole("button", { name: view, exact: true }));
  await d.pause(1200);
}

/** "New task", then the sentence typed into the composer and Enter. */
async function plan(d, sentence) {
  const { page, composer } = ui(d);
  const newTask = page.getByRole("button", { name: "New task" });
  if (await newTask.first().isVisible().catch(() => false)) await d.click(newTask.first());
  await d.type(composer(), sentence);
  await d.press("Enter");
}

/**
 * Waits for the plan of the newest task. A transient RPC timeout on the fork
 * shows the app's own Retry button; the journey presses it once, as a person
 * would, and records it.
 */
async function waitForPlan(d, description, { question = false, timeout = 120_000 } = {}) {
  const { lastTask } = ui(d);
  const deadline = Date.now() + timeout;
  let retried = false;
  for (;;) {
    const task = lastTask();
    const ready = question ? task.getByRole("group", { name: "One question" }) : task.getByRole("button", { name: "Review and sign" });
    if (await ready.first().isVisible().catch(() => false)) return d.check(true, description);
    const retry = task.getByRole("button", { name: "Retry" });
    if (!retried && (await retry.isVisible().catch(() => false))) {
      retried = true;
      const message = (await task.getByRole("alert").first().innerText().catch(() => "")).replace(/\s+/gu, " ");
      await d.note({ title: "Planning failed once and needed Retry", detail: message, severity: "fork" });
      await d.click(retry);
      continue;
    }
    if (Date.now() > deadline) return d.check(false, description);
    await d.pause(500);
  }
}

/** Approves a "The fare changed" gate when one is shown (noting what changed the first time). */
async function approveFareGate(d, task, count) {
  const gate = task.getByRole("button", { name: "Approve this fare" });
  if (!(await gate.isVisible().catch(() => false))) return false;
  if (count === 1) {
    const changed = (await task.getByRole("group", { name: /Approve the fare again/u }).getByRole("alert").first().innerText().catch(() => "")).replace(/\s+/gu, " ").trim();
    await d.note({ title: "The fare changed between review and signing; the desk asked to approve it again", detail: changed, severity: "rough edge" });
  }
  await d.caption("Fare changed", "The quote moved after the review, so the desk shows what changed and asks again before any signature.", { hold: 3200 });
  await d.click(gate);
  return true;
}

/**
 * Signs a planned task: Review and sign, the consent box, Confirm and sign,
 * then every wallet popup and any "Approve this fare" gate until the task
 * settles or fails. Returns "settled", "failed" or "timeout".
 */
async function reviewAndSign(d, { timeout = 240_000 } = {}) {
  const { lastTask } = ui(d);
  const task = lastTask();
  await d.click(task.getByRole("button", { name: "Review and sign" }));
  const consent = task.getByRole("checkbox", { name: /I reviewed the fare/u });
  await d.expectVisible(consent, "Review screen shows the fare and the consent box", { timeout: 90_000 });
  await d.caption("Review", "The review lists networks, fees, the minimum received and every signature before anything is signed.");
  await d.click(consent);
  await d.click(task.getByRole("button", { name: "Confirm and sign" }));
  const deadline = Date.now() + timeout;
  let fareGates = 0;
  for (;;) {
    const current = lastTask();
    if (await current.getByText("Settled. Every leg was seen on-chain.").isVisible().catch(() => false)) return "settled";
    if (await current.getByText(/^Failed\./u).first().isVisible().catch(() => false)) return "failed";
    const popup = await d.page.evaluate(() => window.__klWalletPopupRect?.("approve") ?? null).catch(() => null);
    if (popup) {
      await d.wallet("approve");
      continue;
    }
    if (fareGates < 3 && (await approveFareGate(d, current, fareGates + 1))) {
      fareGates += 1;
      continue;
    }
    if (Date.now() > deadline) return "timeout";
    await d.pause(500);
  }
}

/** Every transaction the wallet sent on `chainId` since `from` has a successful receipt on the fork (at least `count`). */
async function receiptsOnFork(d, from, chainId, count, description) {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const receipts = d.walletEvents.slice(from).filter((event) => event.kind === "receipt" && event.chainId === chainId);
    if (receipts.length >= count || Date.now() > deadline) return d.check(receipts.length >= count && receipts.every((event) => event.status === "success"), description);
    await d.pause(500);
  }
}

/* ------------------------------------------------------------- chapters */

async function home(d) {
  await d.chapter("Kletia home");
  await d.page.goto(`${d.webUrl}/`, { waitUntil: "domcontentloaded" });
  await d.expectVisible(d.page.getByRole("heading", { level: 1, name: /Route money across nine networks/u }), "Home page headline is visible");
  d.sync.start = (await d.card("Kletia: a normal user session", "Local forks of Base, Arbitrum, Polygon and Solana · a throwaway test wallet · nothing is sent to a real network", 3500)).hidden;
  await d.caption("kletiaai.xyz", "A normal user session on the Kletia desk. Everything signs with a throwaway test wallet against local forks of the real networks.", { hold: 4500 });
  await d.page.mouse.wheel(0, 500);
  await d.pause(1800);
  await d.page.mouse.wheel(0, -500);
  await d.pause(900);
}

async function enterApp(d) {
  await d.chapter("Enter the app");
  const open = d.page.getByRole("banner").getByRole("link", { name: "Open the console" });
  if (d.phone && !(await open.isVisible().catch(() => false))) {
    await d.click(d.page.getByRole("link", { name: "or open the console" }));
  } else {
    await d.click(open);
  }
  await d.expectVisible(d.page.getByRole("heading", { name: "Where should the money go?" }), "The desk opens at /app");
  await d.caption("The desk", "One sentence box for every network, a departure board and live network status.");
}

async function connectWallets(d) {
  await d.chapter("Connect the EVM wallet");
  await d.click(d.page.getByRole("button", { name: "Connect EVM wallet" }));
  const listed = d.page.getByRole("dialog").getByRole("button", { name: "Kletia Test Wallet" });
  await d.expectVisible(listed, "The connect modal lists Kletia Test Wallet like an installed extension");
  await d.caption("Connect", "The test wallet announces itself over EIP-6963, so the app's own modal lists it as installed.");
  await d.click(listed);
  await d.wallet("approve", { expect: /Connect/u });
  await d.expectVisible(d.page.getByRole("button", { name: /^EVM wallet Kletia Test Wallet/u }), "The EVM wallet pill shows the connected test wallet");
  if (!d.solana) return;
  await d.chapter("Connect the Solana wallet");
  await d.click(d.page.getByRole("button", { name: "Connect Solana wallet" }));
  const solana = d.page.getByRole("button", { name: /Kletia Test Wallet/u }).last();
  await d.expectVisible(solana, "The Solana picker detects the test wallet through Wallet Standard");
  await d.click(solana);
  await d.wallet("approve", { expect: /Solana/u });
  await d.expectVisible(d.page.getByRole("button", { name: /^Solana wallet Kletia Test Wallet/u }), "The Solana wallet pill shows the connected test wallet");
}

async function holdings(d) {
  await d.chapter("Holdings");
  let panel = d.page.getByRole("complementary", { name: "Holdings" });
  if (d.phone || !(await panel.isVisible().catch(() => false))) {
    await openView(d, "Portfolio", "Holdings");
    panel = d.page.getByRole("main");
  }
  await d.expectVisible(panel.getByText(/2500 USDC/u), "Holdings show the forked Base balance (2 ETH, 2500 USDC)", { timeout: 90_000 });
  if (d.solana) await d.expectVisible(panel.getByText(/5 SOL/u), "Holdings show the forked Solana balance (5 SOL, 500 USDC)", { timeout: 90_000 });
  await d.pointAt(panel.getByText(/2500 USDC/u).first());
  await d.caption("Holdings", "Balances are read live from the forks: the test wallet was funded there with anvil and surfpool cheatcodes.", { hold: 4000 });
  if (d.phone) await openSection(d, "Desk");
}

async function tracking(d) {
  await d.chapter("Sign in and turn on tracking");
  await openView(d, "Portfolio", "Dashboard");
  const value = d.page.getByRole("region", { name: "Value over time" });
  await d.click(value.getByRole("button", { name: "Turn on tracking" }));
  await d.click(value.getByRole("button", { name: "Kletia Test Wallet EVM" }));
  await d.expectVisible(value.getByRole("region", { name: "The message you will sign" }), "The sign-in message is shown before the wallet asks");
  await d.caption("Sign-In with Ethereum", "Tracking needs a wallet sign-in (EIP-4361). It moves no funds.");
  await d.click(value.getByRole("button", { name: "Sign in your wallet" }));
  await d.wallet("approve", { expect: /Signature/u });
  await d.click(d.page.getByRole("region", { name: "Value over time" }).getByRole("button", { name: "Turn on tracking" }), { timeout: 60_000 });
  await d.expectVisible(d.page.getByText("Tracking 1 wallet."), "Tracking is on for the signed-in wallet");
  await d.caption("Tracking on", "Kletia now keeps hourly value readings for this wallet.");
}

async function swap(d) {
  await d.chapter("Swap on Base");
  await openSection(d, "Desk");
  await d.caption("Swap", "A plain sentence. It names Uniswap: aggregator routes can use market-maker quotes signed for the live chain, and those revert on a fork.", FORK);
  await plan(d, SENTENCES.swap);
  await waitForPlan(d, "Swap plan is ready (Review and sign)");
  const task = ui(d).lastTask();
  await d.scrollTo(task.getByRole("region", { name: "Fare breakdown" }));
  await d.caption("The plan", "Itinerary and fare: what you pay, the least you get, every fee, and how each number was obtained.", { hold: 4000 });
  const mark = d.walletEvents.length;
  const outcome = await reviewAndSign(d);
  await d.check(outcome === "settled", "Swap settles: \"Settled. Every leg was seen on-chain.\"");
  await receiptsOnFork(d, mark, 8453, 2, "Approval and swap both succeeded on the Base fork");
  await d.expectVisible(ui(d).lastTask().getByText(/observed on-chain: .*ETH in your Base wallet/u), "Outcome shows the ETH observed on-chain");
  await d.scrollTo(ui(d).lastTask().getByRole("region", { name: "Receipt" }));
  await d.caption("Receipt", "Kletia signs a receipt once the block is final (about 16 minutes on Base). The page checks again by itself.");
  await d.caption("Explorer links", "BaseScan links point at the real chain: these transactions exist only on the local fork.", FORK);
}

async function lend(d) {
  await d.chapter("Lending deposit (Aave on Base)");
  await plan(d, SENTENCES.lend);
  await waitForPlan(d, "Aave deposit plan is ready");
  const mark = d.walletEvents.length;
  const outcome = await reviewAndSign(d);
  await d.check(outcome === "settled", "Aave deposit settles on the Base fork");
  await receiptsOnFork(d, mark, 8453, 2, "Approval and supply both succeeded on the Base fork");
  await d.expectVisible(ui(d).lastTask().getByText(/aBasUSDC at Aave V3/u), "Outcome shows the aBasUSDC position");
}

async function solanaSend(d) {
  if (!d.solana) return;
  await d.chapter("Solana transfer (surfpool fork)");
  await d.caption("Solana", "Solana runs on a surfpool fork of mainnet-beta. A Jupiter swap cannot be shown: Jupiter simulates on the real chain, where this wallet is empty.", FORK);
  await plan(d, SENTENCES.solanaSend(d.solanaRecipient));
  await waitForPlan(d, "Solana transfer plan is ready");
  const mark = d.walletEvents.length;
  const outcome = await reviewAndSign(d);
  await d.check(outcome === "settled", "Solana transfer settles on the surfpool fork");
  await d.check(Boolean(await d.walletEvent((event) => event.kind === "sol_sign_tx", { from: mark, timeout: 1000 })), "The Solana transaction was signed by the Wallet Standard wallet");
}

async function clarify(d) {
  await d.chapter("A sentence with a question");
  await plan(d, SENTENCES.clarify);
  await waitForPlan(d, "Kletia asks one question instead of guessing", { question: true });
  const task = ui(d).lastTask();
  await d.expectVisible(task.getByText("Did you mean USDC?"), "The question is the typo check: Did you mean USDC?");
  await d.caption("Question", "\"usdcc\" is not a token. Kletia asks rather than guess, and only when the answer changes the result.");
  await d.click(task.getByRole("radio", { name: /^USDC/u }));
  await waitForPlan(d, "After the answer the plan is ready");
  await d.expectVisible(ui(d).lastTask().getByRole("heading", { name: /Swap 20 USDC for ETH on Base/u }), "The task is now Swap 20 USDC for ETH on Base");
  await d.caption("Answered", "We leave this one unsigned and move on.");
}

async function bridge(d) {
  await d.chapter("Bridge Base to Arbitrum");
  await plan(d, SENTENCES.bridge);
  await waitForPlan(d, "Bridge plan is ready");
  const task = ui(d).lastTask();
  await d.scrollTo(task.getByRole("region", { name: "Itinerary" }));
  await d.caption("Bridge", "The itinerary shows who holds the money in transit and the refund if no relayer fills.", { hold: 3800 });
  await d.click(task.getByRole("button", { name: "Review and sign" }));
  const consent = task.getByRole("checkbox", { name: /I reviewed the fare/u });
  await d.expectVisible(consent, "Bridge review shows the consent box", { timeout: 90_000 });
  await d.click(consent);
  await d.click(task.getByRole("button", { name: "Confirm and sign" }));
  // First popup: the USDC approval (approved). Second: the bridge deposit (shown, then rejected).
  let popups = 0;
  let gates = 0;
  const deadline = Date.now() + 180_000;
  while (popups < 2 && Date.now() < deadline) {
    const current = ui(d).lastTask();
    if (gates < 3 && (await approveFareGate(d, current, gates + 1))) {
      gates += 1;
      continue;
    }
    const popup = await d.page.evaluate(() => window.__klWalletPopupRect?.("approve") ?? null).catch(() => null);
    if (!popup) {
      await d.pause(400);
      continue;
    }
    popups += 1;
    if (popups === 1) {
      await d.wallet("approve");
      continue;
    }
    await d.caption("Not on a fork", "Relayers watch the real Base chain, so a deposit made only on this fork would never be filled. We reject it in the wallet.", { ...FORK, hold: 4500 });
    await d.wallet("reject");
  }
  await d.check(popups === 2, "The wallet asks for the USDC approval, then for the bridge deposit");
  await d.expectVisible(ui(d).lastTask().getByText(/reject|Nothing (else )?(was|has been) signed|stopped|paused/iu).first(), "Rejecting in the wallet stops the bridge cleanly", { timeout: 60_000 });
}

async function perps(d) {
  await d.chapter("Trade: GMX perps on the Arbitrum fork");
  await openView(d, "Trade", "Perps");
  const ticket = d.page.getByRole("region", { name: "Order ticket" });
  await d.expectVisible(ticket, "The perps order ticket is shown");
  await d.type(ticket.getByRole("textbox", { name: /^Collateral \(USDC\)/u }), "20");
  await d.click(ticket.getByRole("button", { name: "Get quote" }));
  await d.expectVisible(ticket.getByText("Expected entry"), "The GMX quote shows the entry, worst fill and liquidation price");
  await d.caption("Perps ticket", "ETH long, 20 USDC at 2x. The quote shows entry, the worst fill accepted, liquidation and fees.", { hold: 3800 });
  await d.click(ticket.getByRole("button", { name: "Review and sign" }));
  await d.click(ticket.getByRole("button", { name: "Start signing" }));
  const mark = d.walletEvents.length;
  const deadline = Date.now() + 180_000;
  for (;;) {
    const sends = d.walletEvents.slice(mark).filter((event) => event.kind === "send" && event.chainId === 42161);
    if (sends.length >= 2) break;
    const locked = await ticket.getByText(/Another task is signing/u).isVisible().catch(() => false);
    if (locked || Date.now() > deadline) break;
    const popup = await d.page.evaluate(() => window.__klWalletPopupRect?.("approve") ?? null).catch(() => null);
    if (popup) {
      await d.wallet("approve");
      continue;
    }
    // The step buttons come and go as the run advances; one that vanished under the cursor is simply looked up again.
    const next = ticket.getByRole("button", { name: /^(Next step|Continue|Start signing)$/u });
    if (await next.first().isVisible().catch(() => false)) await d.click(next.first(), { timeout: 5000 }).catch(() => undefined);
    await d.pause(500);
  }
  await receiptsOnFork(d, mark, 42161, 2, "Approve and createOrder both executed on the Arbitrum fork");
  await d.caption("Keeper", "GMX keepers execute orders from the live chain, so this order waits on the fork and never fills.", FORK);
}

async function limitOrder(d) {
  await d.chapter("Trade: native limit order (CoW Protocol on Base)");
  await openView(d, "Trade", "Orders");
  const form = d.page.getByRole("form", { name: "New order" });
  await d.select(form.getByRole("combobox", { name: "Network" }), "Base");
  await d.type(form.getByRole("textbox", { name: "Sell" }), "USDC", { clear: true });
  await d.type(form.getByRole("textbox", { name: "Buy" }), "WETH", { clear: true });
  await d.type(form.getByRole("textbox", { name: "Amount" }), "20");
  await d.type(form.getByRole("textbox", { name: /^Limit price/u }), "0.00045");
  await d.type(form.getByRole("textbox", { name: /^Expires after/u }), "7");
  await d.click(form.getByRole("button", { name: "Get quote" }));
  await d.expectVisible(d.page.getByRole("heading", { name: /Quote · CoW Protocol/u }), "The CoW quote shows the minimum received and expiry");
  await d.caption("Limit order", "Sell 20 USDC for at least 0.009 WETH within 7 days. CoW solvers fill it; nothing is paid upfront.", { hold: 3600 });
  const mark = d.walletEvents.length;
  await d.click(form.getByRole("button", { name: "Place order" }));
  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline) {
    if (d.walletEvents.slice(mark).some((event) => event.kind === "typed")) break;
    const popup = await d.page.evaluate(() => window.__klWalletPopupRect?.("approve") ?? null).catch(() => null);
    if (popup) await d.wallet("approve");
    else await d.pause(400);
  }
  const typed = d.walletEvents.slice(mark).find((event) => event.kind === "typed");
  await d.check(typed?.primaryType === "Order" && typed?.domain === "Gnosis Protocol", "The CoW order was signed as EIP-712 typed data (GPv2 Order)");
  await d.caption("Stopped at the order book", "The signed order would now be posted to CoW's order book on the real network. The harness guard blocks that post.", { ...FORK, hold: 4200 });
  const status = form.getByRole("status");
  await d.pause(3000);
  const text = (await status.innerText().catch(() => "")).trim();
  if (text) await d.note({ title: `After the blocked post the form says: "${text}"`, detail: "A generic API error is shown; the user is not told the order was not placed or why.", severity: "rough edge" });
}

async function predict(d) {
  await d.chapter("Predict: Polymarket");
  await openView(d, "Trade", "Predict");
  const search = d.page.getByRole("searchbox", { name: "Search markets" });
  await d.type(search, "bitcoin");
  await d.press("Enter");
  const markets = d.page.getByRole("region", { name: "Markets" }).getByRole("listitem").getByRole("button", { name: /^Open /u });
  await d.expectVisible(markets, "Search returns Polymarket markets");
  await d.pause(1200);
  await d.click(markets.first());
  await d.expectVisible(d.page.getByRole("region", { name: /^Order book/u }), "The market opens with outcomes and the order book");
  await d.caption("Market", "Outcomes, 7-day move and the live order book, read from Polymarket.", { hold: 3200 });
  await d.click(d.page.getByRole("button", { name: /^Trade Yes/u }).first());
  const restricted = d.page.getByText(/restricted for new orders/u);
  if (await restricted.isVisible().catch(() => false)) {
    await d.scrollTo(restricted);
    await d.check(true, "Polymarket's location check is shown and respected (buying off)");
    await d.note({ title: "Predict: buying is off at this machine's location (Polymarket geoblock); Trade Yes gives no feedback next to the button", detail: "The restriction banner is at the top of the view; pressing Trade Yes only toggles the button.", severity: "rough edge" });
    await d.caption("Geoblock", "Polymarket reports this machine's location as restricted. Kletia respects it, so the run stops before a quote or signature.", { ...FORK, hold: 4500 });
    return;
  }
  const ticket = d.page.getByRole("textbox", { name: /^Spend \(USD/u });
  if (await d.expectVisible(ticket, "The ticket asks how much to spend", { timeout: 15_000 })) {
    await d.type(ticket, "5");
    await d.click(d.page.getByRole("button", { name: "Quote", exact: true }));
    await d.click(d.page.getByRole("button", { name: "Review and sign" }).last());
    await d.click(d.page.getByRole("button", { name: "Start signing" }));
    await d.page.waitForFunction(() => window.__klWalletPopupRect?.("approve") ?? null, null, { timeout: 90_000 }).catch(() => undefined);
    await d.caption("Up to the signature", "The order would be signed and relayed to Polymarket's live order book; on a fork run we stop at the wallet.", { ...FORK, hold: 4000 });
    await d.wallet("reject");
  }
}

async function automate(d) {
  await d.chapter("Automate: a weekly DCA");
  await openSection(d, "Automate");
  const area = d.page.getByRole("region", { name: "Automations", exact: true });
  const signIn = area.getByRole("button", { name: "Kletia Test Wallet EVM" });
  if (await signIn.isVisible().catch(() => false)) {
    await d.click(signIn);
    await d.click(area.getByRole("button", { name: "Sign in your wallet" }));
    await d.wallet("approve");
  }
  const form = d.page.getByRole("region", { name: "New automation" });
  await d.expectVisible(form, "The automation templates are shown");
  await d.click(form.getByRole("button", { name: "Buy every week" }));
  await d.type(form.getByRole("textbox", { name: "Amount in USD" }), "25", { clear: true });
  await d.click(form.getByRole("button", { name: "New automation" }));
  await d.expectVisible(d.page.getByText("Every week: buy $25 of ETH on base"), "The weekly DCA automation is listed as active");
  await d.caption("Automation", "Each run plans an intent and waits for the wallet's signature. Kletia never signs.");
}

async function portfolio(d) {
  await d.chapter("Portfolio: dashboard, history, activity");
  await openView(d, "Portfolio", "Dashboard");
  await d.expectVisible(d.page.getByText("Total value"), "The dashboard shows a total value", { timeout: 90_000 });
  await d.pause(1500);
  await d.scrollTo(d.page.getByRole("region", { name: "Allocation" }));
  await d.caption("Dashboard", "Every connected wallet on every network, with positions, loans and rates. Read-only.", { hold: 3500 });
  await openView(d, "Portfolio", "History");
  const history = d.page.getByRole("region", { name: "History", exact: true });
  const notConfigured = history.getByText(/not configured on this API/u);
  const rows = history.getByRole("row");
  await d.expectVisible(notConfigured.or(rows.nth(1)), "History shows rows or says honestly that no history provider is configured", { timeout: 60_000 });
  if (await notConfigured.isVisible().catch(() => false)) {
    await d.caption("History", "This rehearsal API has no history provider key (Etherscan, Alchemy or Helius), and the view says so. The fork transactions are in Activity.", { ...FORK, hold: 4500 });
  }
  await openView(d, "More", "Activity");
  const activity = d.page.getByRole("main").getByRole("listitem").filter({ hasText: "Swap 50 USDC for ETH on Base via Uniswap V3" });
  await d.expectVisible(activity, "Activity lists the fork swap");
  await d.expectVisible(activity.getByText("Confirmed"), "The fork swap is marked Confirmed");
  await d.caption("Activity", "This browser's own record of the transactions it sent to the forks.");
}

async function assistant(d) {
  await d.chapter("Ask the assistant");
  await openSection(d, "Desk");
  await plan(d, SENTENCES.fees);
  const answer = () => ui(d).lastTask().getByRole("region", { name: "From your wallet's data" });
  await d.expectVisible(answer(), "The fee question is answered from the wallet's data", { timeout: 90_000 });
  const text = (await answer().innerText().catch(() => "")).replace(/\s+/gu, " ");
  if (/history is not available|not configured|ETHERSCAN_API_KEY/u.test(text)) {
    await d.check(true, "Without a history provider the fee answer says so instead of guessing");
    await d.caption("Fees today", "Fees are summed from transaction history; without a provider key the assistant says it cannot know, and guesses nothing.", { ...FORK, hold: 4500 });
  } else {
    await d.check(/\$\d/u.test(text), "The fee answer contains a computed dollar amount");
    await d.caption("Fees today", "The fees paid today, summed from the wallet's history.");
  }
  await plan(d, SENTENCES.biggest);
  await d.expectVisible(answer().getByText(/Your biggest position is/u), "The assistant names the biggest position with its value", { timeout: 90_000 });
  await d.caption("Biggest position", "Answered from computed facts, with the facts used listed under it.", { hold: 3500 });
}

async function portal(d) {
  await d.chapter("Developers portal (glimpse)");
  await d.click(d.page.getByRole("button", { name: "Menu", exact: true }));
  await d.click(d.page.getByRole("link", { name: "Developers", exact: true }).first());
  await d.expectVisible(d.page.getByRole("heading", { level: 1 }).first(), "The developers portal opens");
  await d.caption("Portal", "The same engine as an API: keys, the embed builder, agents with their rule books, receipts.", { hold: 3500 });
  await d.page.mouse.wheel(0, 600);
  await d.pause(2000);
  const agents = d.page.getByRole("link", { name: /^Agent/u }).first();
  if (await agents.isVisible().catch(() => false)) {
    await d.click(agents);
    await d.pause(2500);
  }
  const back = d.page.getByRole("link", { name: "Open the console" }).first();
  if (await back.isVisible().catch(() => false)) await d.click(back);
  // The phone header has no console link: the browser's Back button, as often as needed.
  for (let step = 0; step < 3 && !new URL(d.page.url()).pathname.startsWith("/app"); step += 1) {
    await d.page.goBack();
    await d.pause(1200);
  }
  await d.expectVisible(d.page.getByRole("region", { name: "Tasks in this tab" }), "Back on the desk, the tab's tasks are still there");
  await d.pause(2500);
  await d.expectVisible(d.page.getByText(/Settled \d{2}:\d{2} UTC/u).first(), "Back on the desk, the settled tasks still show Settled", {
    timeout: 20_000,
    finding: { severity: "bug", title: "Leaving the desk (Menu, Developers) and coming back resets the tab's tasks: settled intents show Preview or 'leg 1 needs your signature' again" },
  });
}

/** Opens a task from the list on the desk by its title and returns its "Kletia signed receipt" text locator. */
async function openTask(d, title) {
  await d.click(d.page.getByRole("button", { name: new RegExp(`${title} .*(Open|Collapse)$`, "u") }).first());
  return d.page.getByRole("article", { name: new RegExp(title, "u") }).first().getByText(/Kletia signed receipt No\./u);
}

async function receipt(d) {
  await d.chapter("Signed receipts");
  await openSection(d, "Desk");
  if (d.solana) {
    const solana = await openTask(d, "Send 1 USDC to .* on Solana");
    await d.expectVisible(solana, "The Solana transfer's receipt is signed once its slot is finalized", { timeout: 180_000 });
    await d.scrollTo(solana);
    await d.caption("Receipt", "A signed receipt for the settled transfer: private until shared, downloadable, verifiable offline.", { hold: 4000 });
  }
  const swap = await openTask(d, "Swap 50 USDC for ETH on Base via Uniswap V3");
  if (await swap.waitFor({ state: "visible", timeout: 20_000 }).then(() => true, () => false)) {
    await d.check(true, "The Base swap's receipt is signed");
    await d.scrollTo(swap);
  } else {
    await d.scrollTo(d.page.getByRole("region", { name: "Receipt" }).last());
    await d.caption("Waiting for finality", "The Base swap's receipt is still queued: Kletia signs only for a final block, about 16 minutes on Base.", { ...FORK, hold: 4500 });
    await d.note({ title: "The Base swap's receipt is still queued at the end of the session (Base finality takes about 16 minutes)", severity: "fork", screenshot: false });
  }
}

async function disconnect(d) {
  await d.chapter("Disconnect");
  await d.click(d.page.getByRole("button", { name: /^EVM wallet Kletia Test Wallet/u }));
  await d.click(d.page.getByRole("dialog").getByRole("button", { name: /Disconnect/u }));
  await d.expectVisible(d.page.getByRole("button", { name: "Connect EVM wallet" }), "The EVM wallet is disconnected");
  if (d.solana) {
    const pill = d.page.getByRole("button", { name: /^Solana wallet Kletia Test Wallet/u });
    if (await pill.isVisible().catch(() => false)) {
      await d.click(pill);
      await d.click(d.page.getByRole("button", { name: /Disconnect/u }).first());
      await d.expectVisible(d.page.getByRole("button", { name: "Connect Solana wallet" }), "The Solana wallet is disconnected");
    }
  }
  await d.caption("Done", "Session over: wallets disconnected. The forks and the throwaway key are discarded when the harness exits.", { hold: 4000 });
  await d.clearCaption();
}

async function endCard(d) {
  d.sync.end = (await d.card("End of session", "Recorded by tooling/journey-video on local forks. Chapters and findings are next to this video.", 3000)).shown;
}

/** Read-only run against a deployed API: no fork, no signature, the plan screens only. */
async function readOnlyTour(d) {
  await d.chapter("Read-only plan (deployed API)");
  await openSection(d, "Desk");
  await d.caption("Read-only", "Against a deployed API this run never signs: it plans and reviews, then stops.", { hold: 3500 });
  for (const sentence of [SENTENCES.swap, SENTENCES.bridge]) {
    await plan(d, sentence);
    await waitForPlan(d, `Plan is ready: ${sentence}`);
  }
}

export async function runJourney(d) {
  const local = !d.readOnly;
  const steps = local
    ? [home, enterApp, connectWallets, holdings, tracking, swap, lend, solanaSend, clarify, bridge, perps, limitOrder, predict, automate, portfolio, assistant, receipt, portal, disconnect, endCard]
    : [home, enterApp, connectWallets, readOnlyTour, predict, disconnect, endCard];
  for (const step of steps) {
    try {
      await step(d);
    } catch (error) {
      await d.check(false, `${step.name}: ${String(error.message ?? error).split("\n")[0].slice(0, 160)}`);
    }
    await d.clearCaption();
  }
}
