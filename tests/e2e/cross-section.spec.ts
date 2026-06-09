import { expect, test } from '@playwright/test';

test.describe('cross-section picker (#8)', () => {
  test('toggle starts/cancels picking and shows the A-then-B banner', async ({ page, context }) => {
    await context.clearCookies();
    await page.goto('/map');

    const toggle = page.getByTestId('toggle-cross-section');
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('data-mode', 'off');

    await toggle.click();
    await expect(toggle).toHaveAttribute('data-mode', 'pickingA');
    const banner = page.getByTestId('cs-picker-banner');
    await expect(banner).toHaveText(/Click point A/);

    // Click on the map canvas to set point A.
    const canvas = page.getByTestId('map-container');
    await canvas.click({ position: { x: 400, y: 350 } });
    await expect(toggle).toHaveAttribute('data-mode', 'pickingB');
    await expect(banner).toHaveText(/Click point B/);

    // ESC should cancel and reset to 'off'.
    await page.keyboard.press('Escape');
    await expect(toggle).toHaveAttribute('data-mode', 'off');
  });
});
