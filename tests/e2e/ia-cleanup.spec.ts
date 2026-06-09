import { expect, test } from '@playwright/test';

test.describe('IA cleanup — layer search + freshness', () => {
  test('search box filters layers and shows empty state for no matches', async ({ page }) => {
    await page.goto('/map');

    const layerRows = page.locator('[data-layer-id]');
    const initialCount = await layerRows.count();
    expect(initialCount).toBeGreaterThanOrEqual(10);

    const search = page.getByTestId('layer-search');
    await expect(search).toBeVisible();

    // Filter to anything matching "claims" — should reduce to a small set.
    await search.fill('claims');
    await expect(layerRows.first()).toBeVisible();
    const claimsCount = await layerRows.count();
    expect(claimsCount).toBeGreaterThanOrEqual(1);
    expect(claimsCount).toBeLessThan(initialCount);

    // Garbage query → empty-state surface.
    await search.fill('zzzzzzzz');
    await expect(page.getByTestId('layer-search-empty')).toBeVisible();

    // Clear → full list returns.
    await search.fill('');
    await expect(layerRows).toHaveCount(initialCount);
  });

  test('freshness pill renders once the manifest lands', async ({ page }) => {
    await page.goto('/map');
    const freshness = page.getByTestId('layers-freshness');
    // Manifest fetch typically completes in <5s on the preview/CDN combo.
    await expect(freshness).toBeVisible({ timeout: 15_000 });
    await expect(freshness).toContainText(/ago$/);
  });
});
