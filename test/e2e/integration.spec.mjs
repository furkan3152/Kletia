import { expect, test } from "@playwright/test";

import {
  CUSTOM_PROMPT,
  INTEGRATOR_LABEL,
  installIntegrationApi,
  installIntegrationHost,
  installTestWallet,
  signingRequests,
  TEST_ACCOUNT_ID,
  TEST_INTENT_ID,
  TEST_LINK_ID,
  TEST_SESSION_ID,
} from "./fixtures/integration.mjs";

const WEB_ORIGIN = new URL(process.env.KLETIA_E2E_WEB_URL || "http://127.0.0.1:5174").origin;

test.beforeEach(async ({ page }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.__kletiaUncaughtErrors = errors;
});

test.afterEach(async ({ page }) => {
  expect(page.__kletiaUncaughtErrors, "No uncaught browser exception").toEqual([]);
});

async function connectFixtureWallet(frame) {
  await frame.getByRole("button", { name: "Connect an EVM wallet", exact: true }).click();
  await frame.getByRole("button", { name: /Fixture EVM wallet|Browser Wallet|Injected|MetaMask/iu }).first().click();
  await expect(frame.getByRole("button", { name: /EVM wallet .*Open account options/iu })).toBeVisible();
}

async function expectPreparedReview(frame, requests) {
  await expect(frame.getByRole("button", { name: "Execute", exact: true })).toBeEnabled();
  await frame.getByRole("button", { name: "Execute", exact: true }).click();
  const review = frame.getByRole("group", { name: "Confirm the custom contract before signing", exact: true });
  await expect(review).toBeVisible();
  await expect(review.getByText("Not audited by Kletia", { exact: true })).toBeVisible();
  await expect(review.getByRole("button", { name: "Sign this step", exact: true })).toBeVisible();
  expect(requests.filter((request) => request.pathname.endsWith("/prepare"))).toHaveLength(1);
  expect(await signingRequests(frame)).toEqual([]);
}

test("a custom public link explains its project boundary and never opens the wallet launcher", async ({ context, page }) => {
  const requests = await installIntegrationApi(context, { webOrigin: WEB_ORIGIN });
  await page.goto(`${WEB_ORIGIN}/go/${TEST_LINK_ID}`);
  await expect(page.getByRole("heading", { name: "Fixture project contract link", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue with my wallet", exact: true })).toBeDisabled();
  await expect(page.getByText("This link calls a custom contract. Continue through the publisher's own project integration.", { exact: true })).toBeVisible();
  // Wait for the asynchronously loaded quote to render, so a premature exit
  // cannot hide an invalid preview fixture or a render-time exception.
  await expect(page.getByText(/Indicative fare for a stand-in account\./u)).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect an EVM wallet", exact: true })).toHaveCount(0);
  expect(requests.filter((request) => request.pathname.endsWith("/prepare") || request.pathname.endsWith("/intents"))).toEqual([]);
});

test("Studio shows the project-only refusal for an ordinary custom text request without offering execution", async ({ context, page }) => {
  const requests = await installIntegrationApi(context, { webOrigin: WEB_ORIGIN, rejectStudio: true });
  await page.goto(`${WEB_ORIGIN}/studio`);
  await page.getByRole("textbox", { name: "Where should the money go?" }).fill(CUSTOM_PROMPT);
  await page.getByRole("button", { name: "Print the plan", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Custom contracts are available only through your own project integration." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Execute with my wallets", exact: true })).toHaveCount(0);
  expect(requests.filter((request) => request.pathname === "/v1/intents")).toHaveLength(1);
  expect(requests.find((request) => request.pathname === "/v1/intents").query).toContain("dryRun=true");
  expect(requests.filter((request) => request.pathname.endsWith("/prepare"))).toEqual([]);
});

test("an ordinary hosted text plan cannot sign a custom contract returned by the API", async ({ context, page }) => {
  await installTestWallet(context);
  const requests = await installIntegrationApi(context, { webOrigin: WEB_ORIGIN });
  await page.goto(`${WEB_ORIGIN}/embed`);
  await connectFixtureWallet(page);
  await page.getByRole("textbox", { name: "What should happen?" }).fill(CUSTOM_PROMPT);
  await page.getByRole("button", { name: "Plan", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Fixture custom contract plan", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Execute", exact: true }).click();
  await expect(page.getByText(/Custom contracts can only be executed through the developer's own project integration\./u)).toBeVisible();
  await expect(page.getByRole("group", { name: "Confirm the custom contract before signing", exact: true })).toHaveCount(0);
  expect(requests.filter((request) => request.pathname.endsWith("/prepare"))).toHaveLength(1);
  expect(await signingRequests(page)).toEqual([]);
});

test("the integrator's exact stored intent reaches its prepared review with no wallet signature", async ({ context, page }) => {
  await installTestWallet(context);
  const requests = await installIntegrationApi(context, { webOrigin: WEB_ORIGIN });
  const hostUrl = await installIntegrationHost(context, { webOrigin: WEB_ORIGIN, fragment: `intent=${TEST_INTENT_ID}` });
  await page.goto(hostUrl);
  await expect(page.getByRole("status")).toHaveText("Fixture frame connected");
  const frame = page.frameLocator('iframe[title="Fixture Kletia integration"]');
  await expect(frame.getByRole("heading", { name: "Fixture custom contract plan", exact: true })).toBeVisible();
  await connectFixtureWallet(frame);
  await expectPreparedReview(frame, requests);
});

test("a proven host session creates the wallet-bound integrator intent and reaches its prepared review", async ({ context, page }) => {
  await installTestWallet(context);
  const requests = await installIntegrationApi(context, { webOrigin: WEB_ORIGIN });
  const hostUrl = await installIntegrationHost(context, { webOrigin: WEB_ORIGIN, fragment: `session=${TEST_SESSION_ID}` });
  await page.goto(hostUrl);
  await expect(page.getByRole("status")).toHaveText("Fixture frame connected");
  const frame = page.frameLocator('iframe[title="Fixture Kletia integration"]');
  await expect(frame.getByText(INTEGRATOR_LABEL, { exact: true })).toBeVisible();
  await connectFixtureWallet(frame);
  await frame.getByRole("button", { name: "Plan with my wallet", exact: true }).click();
  await expect(frame.getByRole("heading", { name: "Fixture custom contract plan", exact: true })).toBeVisible();
  const created = requests.filter((request) => request.pathname === `/v1/sessions/${TEST_SESSION_ID}/intents`);
  expect(created).toHaveLength(1);
  expect(created[0].body.hostOrigin).toBe(WEB_ORIGIN);
  expect(created[0].body.accounts).toContain(TEST_ACCOUNT_ID);
  await expectPreparedReview(frame, requests);
});

test("a session opened without a proven embedding host cannot plan or prompt a wallet", async ({ context, page }) => {
  const requests = await installIntegrationApi(context, { webOrigin: WEB_ORIGIN });
  await page.goto(`${WEB_ORIGIN}/embed#session=${TEST_SESSION_ID}`);
  await expect(page.getByText("This checkout must be opened from the site that created it, through the Kletia embed element. Nothing was planned or signed.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Plan with my wallet", exact: true })).toHaveCount(0);
  expect(requests.filter((request) => request.pathname.endsWith("/intents") || request.pathname.endsWith("/prepare"))).toEqual([]);
});
