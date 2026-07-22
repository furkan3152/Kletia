import { test, expect } from '@playwright/test';

test.describe('Kletia Omni-Engine E2E Tests', () => {
  test('should load the main page and display Kletia greeting', async ({ page }) => {
    // Uygulamanın anasayfasına git
    await page.goto('http://localhost:5173');

    // Başlığın doğru yüklendiğini kontrol et
    await expect(page).toHaveTitle(/Kletia Omni-Engine/);

    // AI'ın varsayılan karşılama mesajını kontrol et
    const greeting = page.locator('text=Selam dostum! Ben Kletia Omni-Engine.');
    await expect(greeting).toBeVisible();
  });

  test('should warn user if wallet is not connected before sending message', async ({ page }) => {
    await page.goto('http://localhost:5173');

    // Prompt kutusuna bir şey yaz
    const input = page.locator('input[type="text"]');
    await input.fill('100 USDC swap yap');

    // Gönder butonuna bas
    const sendButton = page.locator('button:has(svg.lucide-send)');
    await sendButton.click();

    // Uyarı mesajının geldiğini kontrol et
    const warning = page.locator('text=Lütfen önce sağ üstten cüzdanını bağla dostum.');
    await expect(warning).toBeVisible();
  });
});
