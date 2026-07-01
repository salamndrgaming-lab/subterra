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

/** Digest of new features matched to an alert's AOI. `items` are the
 *  matched diff features (claims carry `serial`, permits `permitNo` +
 *  `operator`). Dev (no RESEND) logs instead of sending. */
export async function sendAlertDigestEmail(
  env: Env,
  email: string,
  alertName: string,
  eventKind: string,
  items: ReadonlyArray<{
    serial?: string;
    permitNo?: string;
    operator?: string;
    state?: string;
    lat: number;
    lng: number;
  }>,
): Promise<void> {
  const noun = eventKind === 'permit_filed' ? 'drilling permit' : 'mining claim';
  const subject = `Subterra alert · ${items.length} new ${noun}${items.length === 1 ? '' : 's'} in "${alertName}"`;
  const rows = items
    .slice(0, 50)
    .map((it) => {
      const id = it.serial ?? it.permitNo ?? '(unknown)';
      const extra = [it.operator, it.state].filter(Boolean).join(' · ');
      return `${id}${extra ? ` — ${extra}` : ''} @ ${it.lat.toFixed(4)}, ${it.lng.toFixed(4)}`;
    })
    .join('\n');
  const more = items.length > 50 ? `\n…and ${items.length - 50} more.` : '';
  const text = `${items.length} new ${noun}(s) in your watched area "${alertName}":\n\n${rows}${more}\n\nOpen Subterra to see them on the map.`;
  const html = alertDigestHtml(alertName, noun, items.length, rows.replace(/\n/g, '<br>'), more);

  if (!env.RESEND_API_KEY || !env.RESEND_FROM) {
    console.info(`[email:DEV] would send alert digest to ${email}: ${subject}\n${text}`);
    return;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${env.RESEND_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ from: env.RESEND_FROM, to: email, subject, html, text }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`resend alert send failed: ${res.status} ${body.slice(0, 300)}`);
  }
}

function alertDigestHtml(
  alertName: string,
  noun: string,
  count: number,
  rowsHtml: string,
  more: string,
): string {
  return `<!doctype html>
<html>
  <body style="font-family:-apple-system,Segoe UI,sans-serif;background:#0a0c10;color:#e2e8f0;padding:24px;">
    <div style="max-width:560px;margin:0 auto;background:#161b22;border:1px solid #30363d;border-radius:8px;padding:24px;">
      <h1 style="margin:0 0 8px 0;font-size:18px;color:#f59e0b;">${count} new ${escapeHtml(noun)}${count === 1 ? '' : 's'}</h1>
      <p style="margin:0 0 16px 0;font-size:14px;color:#8b97a6;">in your watched area &ldquo;${escapeHtml(alertName)}&rdquo;</p>
      <pre style="margin:0;font-family:ui-monospace,Menlo,monospace;font-size:12px;line-height:1.6;color:#e2e8f0;white-space:pre-wrap;">${rowsHtml}${escapeHtml(more)}</pre>
    </div>
  </body>
</html>`;
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
