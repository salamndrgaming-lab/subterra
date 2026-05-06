'use client';

import Link from 'next/link';
import { useAuthStore } from '@/stores/auth-store';
import { api } from '@/lib/api';

/**
 * Compact auth pill for the top navigation. Shows the signed-in user's
 * email with a one-click logout, or sign-in / sign-up links when anonymous.
 */
export function AuthStatus() {
  const user = useAuthStore((s) => s.user);
  const clear = useAuthStore((s) => s.clear);

  if (!user) {
    return (
      <div className="flex items-center gap-1">
        <Link
          href="/auth/login"
          className="rounded-md border border-border bg-bg-panel px-3 py-1.5 font-mono text-xs text-text-subtle hover:text-text"
        >
          Sign in
        </Link>
        <Link
          href="/auth/register"
          className="rounded-md bg-accent px-3 py-1.5 font-mono text-xs text-bg hover:brightness-110"
        >
          Create account
        </Link>
      </div>
    );
  }

  const handleLogout = async () => {
    try { await api.auth.logout(); } catch { /* ignore — clear local state regardless */ }
    clear();
  };

  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-bg-panel px-2 py-1 font-mono text-xs">
      <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden />
      <span className="max-w-[180px] truncate text-text" title={user.email}>{user.displayName ?? user.email}</span>
      <button
        onClick={handleLogout}
        className="rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-text-muted hover:text-text"
      >
        Sign out
      </button>
    </div>
  );
}
