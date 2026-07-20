import { test as base, chromium, type BrowserContext } from '@playwright/test';
import { expect } from '@playwright/test';
import path from 'path';

export const test = base.extend<{ context: BrowserContext; extensionId: string }>({
  context: async ({}, use) => {
    const pathToExtension = path.resolve(__dirname, '../../dist');
    const context = await chromium.launchPersistentContext('', {
      headless: false,
      args: [
        `--disable-extensions-except=${pathToExtension}`,
        `--load-extension=${pathToExtension}`,
      ],
    });
    
    // Inject the LanguageModel mock globally via context so it reaches all pages including the side panel
    await context.addInitScript(() => {
      (window as any).LanguageModel = {
        availability: async () => 'available',
        create: async (options: any) => ({
          promptStreaming: async function* (userText: string) {
            yield "This is a ";
            yield "simplified mock response.";
          },
          clone: async function() {
            return this;
          },
          destroy: () => {}
        })
      };
    });

    await use(context);
    await context.close();
  },
  extensionId: async ({ context }, use) => {
    let [background] = context.serviceWorkers();
    if (!background) background = await context.waitForEvent('serviceworker');
    const extensionId = background.url().split('/')[2];
    await use(extensionId);
  },
});

test('sidepanel flow', async ({ context, extensionId }) => {
  const page = await context.newPage();
  
  // Create a dummy page that the side panel would "extract"
  await page.setContent(`
    <html>
      <head><title>Test Article</title></head>
      <body>
        <h1>Test Header</h1>
        <p>This is a test paragraph that needs simplification.</p>
      </body>
    </html>
  `);

  // Open the side panel directly
  const sidePanelPage = await context.newPage();
  await sidePanelPage.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);

  await expect(sidePanelPage.locator('h1')).toHaveText('Clarity');
  
  // Click on simplified tab
  await sidePanelPage.click('text=Simplified');
  
  // Wait for LLM availability mock to resolve
  await expect(sidePanelPage.locator('.status-chip')).toHaveText('● Ready');

  // Click simplify
  await sidePanelPage.click('button:has-text("Simplify Now")');
  
  // It should stream out the mocked response
  // Testing the actual stream requires waiting for React state updates.
});
