/**
 * Email sending via Resend.
 *
 * In dev (no RESEND_API_KEY configured) we log the magic-link body to
 * the Worker console instead of failing. That lets local sign-in work
 * without configuring the API key — copy the URL from the log, paste
 * into the browser.
 *
 * Production sets RESEND_API_KEY + RESEND_FROM via wrangler secrets.
 */

import type { Env } from './index';

export async function sendMagicLinkEmail(
  env: Env,
  email: string,
  verifyUrl: string,
): Promise<void> {
  const subject = 'Sign in to Subterra';
  const html = magicLinkHtml(verifyUrl);
  const text = magicLinkText(verifyUrl);

  if (!env.RESEND_API_KEY || !env.RESEND_FROM) {
    console.info(
      `[email:DEV] would send magic link to ${email}\n` +
        `         subject: ${subject}\n` +
        `         link:    ${verifyUrl}`,
    );
    return;
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${env.RESEND_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: env.RESEND_FROM,
      to: email,
      subject,
      html,
      text,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`resend send failed: ${res.status} ${body.slice(0, 300)}`);
  }
}

function magicLinkHtml(verifyUrl: string): string {
  // Plain, minimal HTML — no images, no tracking pixels, no third-party
  // fonts. Major email clients render this as-is.
  return `<!doctype html>
<html>
  <body style="font-family:-apple-system,Segoe UI,sans-serif;background:#0a0c10;color:#e2e8f0;padding:24px;">
    <div style="max-width:520px;margin:0 auto;background:#161b22;border:1px solid #30363d;border-radius:8px;padding:24px;">
      <h1 style="margin:0 0 16px 0;font-size:18px;color:#f59e0b;">Sign in to Subterra</h1>
      <p style="margin:0 0 24px 0;font-size:14px;line-height:1.5;">
        Click the button below to sign in. The link expires in 15 minutes
        and can only be used once.
      </p>
      <p style="margin:0 0 24px 0;">
        <a href="${escapeHtml(verifyUrl)}"
           style="display:inline-block;background:#f59e0b;color:#0a0c10;text-decoration:none;font-weight:600;padding:10px 18px;border-radius:6px;">
          Sign in
        </a>
      </p>
      <p style="margin:0;font-size:12px;color:#8b949e;line-height:1.5;">
        If the button doesn't work, paste this URL into your browser:<br>
        <span style="word-break:break-all;color:#e2e8f0;">${escapeHtml(verifyUrl)}</span>
      </p>
      <p style="margin:24px 0 0 0;font-size:12px;color:#8b949e;">
        If you didn't ask to sign in, you can ignore this email.
      </p>
    </div>
  </body>
</html>`;
}

function magicLinkText(verifyUrl: string): string {
  return [
    'Sign in to Subterra',
    '',
    'Click the link below to sign in. It expires in 15 minutes and can',
    'only be used once.',
    '',
    verifyUrl,
    '',
    "If you didn't ask to sign in, you can ignore this email.",
  ].join('\n');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
