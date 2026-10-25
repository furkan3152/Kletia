// Chromium for the journey: a preinstalled Playwright browser
// (`JOURNEY_CHROMIUM`), the test wallet's init script and binding, and a
// route guard so the page itself can only write to the local forks and the
// local API (see guardRules.mjs).
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { join } from "node:path";

import { outboundVerdict } from "./guardRules.mjs";

export const CHROMIUM = process.env.JOURNEY_CHROMIUM ?? "/opt/pw-browsers/chromium";

/** Playwright from the workspace, else the globally installed package. */
export function loadPlaywright() {
  const require = createRequire(import.meta.url);
  try {
    return require("playwright");
  } catch {
    const globalRoot = execSync("npm root -g", { encoding: "utf8" }).trim();
    return require(join(globalRoot, "playwright"));
  }
}

export async function launch({ wallet, viewport, videoDir, onBlocked, isMobile = false }) {
  const { chromium } = loadPlaywright();
  // Loopback (the forks, the API, the web build) never goes through a proxy.
  process.env.PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK = "1";
  const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: "127.0.0.1,localhost" } : undefined;
  const browser = await chromium.launch({ executablePath: CHROMIUM, headless: true, proxy, args: ["--disable-dev-shm-usage"] });
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 1,
    isMobile,
    hasTouch: isMobile,
    colorScheme: "dark",
    locale: "en-US",
    timezoneId: "UTC",
    ...(videoDir ? { recordVideo: { dir: videoDir, size: viewport } } : {}),
  });
  await context.exposeBinding("__klWalletBridge", wallet.binding);
  await context.addInitScript({ content: wallet.initScript });
  await context.route("**/*", async (route) => {
    const request = route.request();
    const verdict = outboundVerdict({ url: request.url(), method: request.method(), body: request.postData() ?? "" });
    if (verdict.allow) return route.continue();
    onBlocked?.({ method: request.method(), url: request.url(), reason: verdict.reason });
    return route.abort("blockedbyclient");
  });
  const page = await context.newPage();
  return { browser, context, page };
}
