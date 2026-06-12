import { expect, test } from '@playwright/test';

test.describe('view-mode toggles (#10)', () => {
  test('Imagery + 3D toggles render, flip on click, and persist across reload', async ({ page, context }) => {
    // Clean slate — no leftover persisted state from a previous spec.
    await context.clearCookies();
    await page.goto('/map');

    const imagery = page.getByTestId('toggle-imagery');
    const terrain = page.getByTestId('toggle-terrain3d');
    await expect(imagery).toBeVisible();
    await expect(terrain).toBeVisible();
    await expect(imagery).toHaveAttribute('aria-pressed', 'false');
    await expect(terrain).toHaveAttribute('aria-pressed', 'false');

    await imagery.click();
    await expect(imagery).toHaveAttribute('aria-pressed', 'true');

    await terrain.click();
    await expect(terrain).toHaveAttribute('aria-pressed', 'true');

    // Reload — both toggles should remember they were on.
    await page.reload();
    const imageryAfter = page.getByTestId('toggle-imagery');
    const terrainAfter = page.getByTestId('toggle-terrain3d');
    await expect(imageryAfter).toHaveAttribute('aria-pressed', 'true');
    await expect(terrainAfter).toHaveAttribute('aria-pressed', 'true');

    // Toggle off — clears the persisted state and the map returns to default.
    await imageryAfter.click();
    await terrainAfter.click();
    await expect(imageryAfter).toHaveAttribute('aria-pressed', 'false');
    await expect(terrainAfter).toHaveAttribute('aria-pressed', 'false');
  });
});
