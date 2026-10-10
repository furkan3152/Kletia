import { expect, test } from "@playwright/test";
import { CHAINS } from "@kletia/core";

// These checks render the real application and public catalog. Quote/signing
// scenarios use explicit deterministic fixtures in integration.spec.mjs.
const routes = [
  { path: "/", heading: /Route money across/ },
  { path: "/app", heading: /^KLETIA(?: SOLANA| CONSOLE)?$/ },
  { path: "/studio", heading: /Write a route and see its legs/ },
  { path: "/developers", heading: /Put cross-network routes inside your own product/ },
  { path: "/protocols", heading: /protocols Kletia can route through/ },
  { path: "/networks", heading: /production networks and a test yard/ },
  { path: `/r/rcpt_${"0".repeat(32)}`, heading: /This receipt is not shared any more/ },
  { path: `/go/lk_${"0".repeat(24)}`, heading: /link/i },
  { path: "/approve", heading: /approval/i },
  { path: "/embed", heading: /Kletia intent widget/ },
];

test.beforeEach(async ({ page }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.__kletiaUncaughtErrors = errors;
  // Missing public capabilities are deterministic 404 fixtures. Avoid public
  // rate-limit retries making the missing-page check depend on other tests.
  await page.route(new RegExp(`/v1/receipts/rcpt_${"0".repeat(32)}(?:/|$)`), (route) => route.fulfill({
    status: 404, contentType: "application/json",
    body: JSON.stringify({ error: { code: "RECEIPT_NOT_FOUND", message: "Deterministic missing receipt fixture." } }),
  }));
  await page.route(new RegExp(`/v1/links/lk_${"0".repeat(24)}(?:/|$)`), (route) => route.fulfill({
    status: 404, contentType: "application/json",
    body: JSON.stringify({ error: { code: "LINK_NOT_FOUND", message: "Deterministic missing link fixture." } }),
  }));
});

test.afterEach(async ({ page }) => {
  expect(page.__kletiaUncaughtErrors, "No uncaught browser exception").toEqual([]);
});

for (const route of routes) {
  test(`${route.path} renders`, async ({ page }) => {
    await page.goto(route.path);
    await expect(page.getByRole("heading", { level: 1, name: route.heading })).toBeVisible();
    if (route.path === "/app") await expect(page.getByRole("heading", { name: "Solana overview", exact: true })).toBeVisible();
    await expect(page.getByText("Something went wrong", { exact: true })).toHaveCount(0);
  });
}

async function workspaceControls(page) {
  const group = page.getByRole("group", { name: "Select workspace and settlement lane" });
  if (!(await group.isVisible())) await page.getByRole("button", { name: "Open Kletia navigation" }).click();
  await expect(group).toBeVisible();
  return group;
}

test("new console visitors start on Solana and keep a chosen EVM workspace", async ({ page }) => {
  await page.goto("/app");
  await expect(page.getByRole("heading", { name: "Solana overview", exact: true })).toBeVisible();
  const workspaces = await workspaceControls(page);
  await expect(workspaces.getByRole("button", { name: "Solana Mainnet", exact: true })).toHaveAttribute("aria-pressed", "true");
  await workspaces.getByRole("button", { name: "Base Mainnet", exact: true }).click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("kletia-workspace"))).toBe("base");
  await page.reload();
  const remembered = await workspaceControls(page);
  await expect(remembered.getByRole("button", { name: "Base Mainnet", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("heading", { name: "Solana overview", exact: true })).toHaveCount(0);
});

test("legacy remembered network stays selected", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("kletia-network-mode", "arbitrum");
    localStorage.setItem("kletia-storage", JSON.stringify({ version: 6, state: { activeNetwork: "arbitrum" } }));
  });
  await page.goto("/app");
  const workspaces = await workspaceControls(page);
  await expect(workspaces.getByRole("button", { name: "Arbitrum One, public beta", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("heading", { name: "Solana overview", exact: true })).toHaveCount(0);
});

test("Studio starts with a Solana prompt and preserves an explicit prompt", async ({ page }) => {
  await page.goto("/studio");
  await expect(page.getByRole("textbox", { name: "Where should the money go?" })).toHaveValue("swap 0.1 SOL to USDC");
  // Invalid wording deliberately avoids any live market request while proving
  // that a shared prompt takes precedence over the starter.
  const prompt = "deterministic browser fixture unsupported wording";
  await page.goto(`/studio?q=${encodeURIComponent(prompt)}`);
  await expect(page.getByRole("textbox", { name: "Where should the money go?" })).toHaveValue(prompt);
});

test("developer explorer sends a catalog request and renders its deterministic response", async ({ page }) => {
  await page.route("**/v1/networks", (route) => route.fulfill({
    status: 200, contentType: "application/json", headers: { "x-kletia-test-fixture": "deterministic-catalog" },
    body: JSON.stringify({ networks: Object.values(CHAINS) }),
  }));
  await page.goto("/developers#op-listNetworks");
  const request = page.getByRole("form", { name: "Request for GET /v1/networks" });
  await expect(request).toBeVisible();
  const response = page.waitForResponse((value) => new URL(value.url()).pathname === "/v1/networks" && value.request().method() === "GET");
  await request.getByRole("button", { name: "Send request", exact: true }).click();
  const catalog = await response;
  expect(catalog.status()).toBe(200);
  const body = await catalog.json();
  expect(body.networks.some((network) => network.key === "solana")).toBe(true);
  await expect(page.getByText("200 OK", { exact: true })).toBeVisible();
});
