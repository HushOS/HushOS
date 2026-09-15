import { expect, test } from '@playwright/test';

/*
 * The Content Security Policy is only as good as the code's respect for it: a
 * library probing `eval` shows up as a violation the console reports and
 * Lighthouse counts, even when the probe is caught. The pages that build and
 * run the most client-side validation are watched for any report at all.
 */
test('no page reports a Content Security Policy violation', async ({ page }) => {
    await page.addInitScript(() => {
        const seen: string[] = [];
        (window as unknown as { cspViolations: string[] }).cspViolations = seen;
        document.addEventListener('securitypolicyviolation', (event) =>
            seen.push(`${event.violatedDirective} ${event.sourceFile}:${event.lineNumber}`),
        );
    });
    await page.goto('/register', { waitUntil: 'networkidle' });
    // A rejected value runs the form's schema, the first Zod parse of the session.
    await page.getByRole('textbox', { name: /email/i }).fill('not-an-email');
    await page.locator('form button[type=submit]').click();
    await expect(page.getByText(/valid email|email address/i).first()).toBeVisible();
    await page.goto('/pricing', { waitUntil: 'networkidle' });
    await page.goto('/blog', { waitUntil: 'networkidle' });
    const violations = await page.evaluate(
        () => (window as unknown as { cspViolations: string[] }).cspViolations,
    );
    expect(violations).toEqual([]);
});
