import { expect, test } from '@playwright/test';

test.describe('auth — sign-in form', () => {
  test('signin page renders, validates email, surfaces success state', async ({ page }) => {
    // Intercept the magic-link request so the test doesn't need a live
    // Worker — just verify the form wires up to the right URL with the
    // right shape.
    let captured: { url: string; body: string | null } | null = null;
    await page.route('**/auth/request*', (route) => {
      captured = { url: route.request().url(), body: route.request().postData() };
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    });

    await page.goto('/signin');
    const form = page.getByTestId('signin-form');
    await expect(form).toBeVisible();

    const submit = page.getByTestId('signin-submit');
    // Browser-native required validation blocks empty submission — the
    // form's onSubmit handler also short-circuits if email is blank.
    await expect(submit).toBeDisabled();

    await page.getByTestId('signin-email').fill('test@example.com');
    await expect(submit).toBeEnabled();
    await submit.click();

    await expect(page.getByTestId('signin-sent')).toBeVisible();
    expect(captured).not.toBeNull();
    expect(captured!.url).toMatch(/\/auth\/request/);
    expect(captured!.body).toContain('"email":"test@example.com"');
  });

  test('header shows "Sign in" link when /auth/me returns no user', async ({ page }) => {
    await page.route('**/auth/me', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '{"user":null}' }),
    );
    await page.goto('/map');
    const link = page.getByTestId('auth-signin-link');
    await expect(link).toBeVisible({ timeout: 10_000 });
    await expect(link).toHaveAttribute('href', '/signin');
  });
});
