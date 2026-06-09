/** Sign-in page — single email field. POST → backend emails a magic
 *  link → user clicks → backend sets session cookie + redirects back to /map.
 *
 *  Page-level state machine:
 *    'idle'      → showing the form
 *    'sending'   → request in flight
 *    'sent'      → "check your email" surface
 *    'error'     → form re-shows with the error inline */

import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';

import { requestMagicLink } from '@/lib/auth';

type Status = 'idle' | 'sending' | 'sent' | 'error';

export function SignInPage() {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (!email.trim()) return;
    setStatus('sending');
    setErrorMsg(null);
    const result = await requestMagicLink(email.trim());
    if (result.ok) {
      setStatus('sent');
    } else {
      setErrorMsg(result.error ?? 'Failed to send sign-in link');
      setStatus('error');
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg p-6">
      <div className="w-full max-w-md rounded-lg border border-border bg-bg-surface p-6 shadow-2xl">
        <Link
          to="/"
          className="block font-mono text-[11px] uppercase tracking-wider text-text-muted hover:text-text"
        >
          ← Subterra
        </Link>
        <h1 className="mt-4 font-mono text-lg text-text">Sign in</h1>
        <p className="mt-1 font-mono text-[11px] text-text-muted">
          We&apos;ll email you a one-time sign-in link.
        </p>

        {status === 'sent' ? (
          <div
            data-testid="signin-sent"
            className="mt-6 rounded-md border border-success/40 bg-success/10 px-4 py-3 font-mono text-[12px] text-success"
          >
            Check <span className="text-text">{email}</span> for a sign-in link. It expires in
            15 minutes.
          </div>
        ) : (
          <form onSubmit={onSubmit} className="mt-5 space-y-3" data-testid="signin-form">
            <label className="block">
              <span className="font-mono text-[10px] uppercase tracking-wider text-text-muted">
                Email
              </span>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoFocus
                autoComplete="email"
                placeholder="you@example.com"
                data-testid="signin-email"
                className="mt-1 w-full rounded-md border border-border bg-bg-panel px-3 py-2 font-mono text-[13px] text-text placeholder:text-text-muted focus:border-accent focus:outline-none"
              />
            </label>
            {errorMsg && (
              <div
                data-testid="signin-error"
                className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 font-mono text-[11px] text-red-300"
              >
                {errorMsg}
              </div>
            )}
            <button
              type="submit"
              disabled={status === 'sending' || !email.trim()}
              data-testid="signin-submit"
              className="w-full rounded-md bg-accent px-3 py-2 font-mono text-[12px] font-semibold text-bg shadow hover:opacity-90 disabled:opacity-50"
            >
              {status === 'sending' ? 'Sending…' : 'Email me a sign-in link'}
            </button>
            <p className="font-mono text-[10px] leading-relaxed text-text-muted">
              No password, no tracking. The link expires in 15 minutes and can only be used
              once.
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
