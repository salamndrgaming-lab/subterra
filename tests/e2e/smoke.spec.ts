import { expect, test } from '@playwright/test';

test.describe('Phase 0 smoke', () => {
  test('landing page renders the Subterra hero', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('text=The map of')).toBeVisible();
    await expect(page.getByTestId('status-pill')).toContainText('Phase 0');
  });

  test('map page mounts a MapLibre canvas and loads the basemap', async ({ page }) => {
    await page.goto('/map');
    await expect(page.getByTestId('map-container')).toBeVisible();
    // OpenFreeMap loads in <10s on any decent network; status pill flips green.
    await expect(page.getByTestId('map-status')).toContainText('basemap loaded', {
      timeout: 15_000,
    });
    // Layer sidebar lists every registry entry.
    const layerRows = page.locator('[data-layer-id]');
    await expect(layerRows.first()).toBeVisible();
    expect(await layerRows.count()).toBeGreaterThanOrEqual(10);
  });

  test('404 page shows for unknown routes', async ({ page }) => {
    await page.goto('/no-such-route');
    await expect(page.locator('text=Off the map')).toBeVisible();
  });
});
