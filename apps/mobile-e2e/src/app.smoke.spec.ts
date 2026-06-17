import { test, expect } from '@playwright/test';

/**
 * Smoke test: the mobile app boots, the default route redirects to /home, and
 * the home page renders. Asserts on the Ionic toolbar title and welcome copy
 * (apps/mobile/src/app/home/home.page.html), not a brittle full snapshot.
 */
test('boots and renders the home page', async ({ page }) => {
  await page.goto('/');

  // Default route ('' -> redirect 'full' -> 'home').
  await expect(page).toHaveURL(/\/home$/);

  // ion-title renders the appName binding ('Vultus').
  await expect(page.locator('ion-title')).toHaveText('Vultus');

  // Home content placeholder copy.
  await expect(page.locator('ion-content')).toContainText('Welcome to Vultus');
});
