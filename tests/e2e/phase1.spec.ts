import { expect, test } from '@playwright/test';

test.describe('Phase 1 — pmtiles vector source', () => {
  test('shows "no tiles yet" pill when manifest 404s', async ({ page }) => {
    // Mock the Worker so we get a deterministic 404.
    await page.route('**/manifest', (route) =>
      route.fulfill({ status: 404, body: JSON.stringify({ error: 'no_manifest' }) }),
    );
    await page.goto('/map');
    await expect(page.getByTestId('map-container')).toBeVisible();
    await expect(page.getByTestId('pill-no')).toContainText('no tiles yet', {
      timeout: 10_000,
    });
  });

  test('shows tile version + claim count when a manifest is published', async ({ page }) => {
    await page.route('**/manifest', (route) =>
      route.fulfill({
        status: 200,
        body: JSON.stringify({
          version: 42,
          publishedAt: '2026-05-20T00:00:00Z',
          pmtilesUrl: 'https://tiles.example/test.pmtiles',
          featuresDbUrl: 'https://tiles.example/test.db',
          checksums: { pmtiles: 'aa', featuresDb: 'bb' },
          counts: { mining_claims: 1234567 },
        }),
        headers: { 'content-type': 'application/json' },
      }),
    );
    await page.goto('/map');
    await expect(page.getByTestId('pill-tiles')).toContainText('tiles v42', { timeout: 10_000 });
    // Sidebar surfaces the per-layer count for mining-claims.
    const row = page.locator('[data-layer-id="mining-claims"]');
    await expect(row).toContainText('1,234,567');
  });

  test('toggling a layer in the sidebar updates its data-visible attribute', async ({ page }) => {
    await page.route('**/manifest', (route) =>
      route.fulfill({ status: 404, body: JSON.stringify({ error: 'no_manifest' }) }),
    );
    await page.goto('/map');
    const row = page.locator('[data-layer-id="mining-claims"]');
    const before = await row.getAttribute('data-visible');
    await row.click();
    const after = await row.getAttribute('data-visible');
    expect(after).not.toBe(before);
  });
});
