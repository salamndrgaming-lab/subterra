'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuthStore } from '@/stores/auth-store';

export function LoginForm() {
  const router = useRouter();
  const setSession = useAuthStore((s) => s.setSession);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const m = useMutation({
    mutationFn: () => api.auth.login({ email, password }),
    onSuccess: (data) => {
      setSession(
        { ...data.user, isVerified: true, createdAt: new Date().toISOString(), lastLoginAt: new Date().toISOString() },
        data.tokens,
      );
      router.push('/map');
    },
  });

  return (
    <div className="w-full max-w-sm">
      <h1 className="font-display text-3xl text-text">Sign in</h1>
      <p className="mt-1 font-mono text-xs text-text-subtle">
        Map-first geospatial intelligence for prospectors. Your AOIs, projects, and alerts persist across sessions.
      </p>
      <form
        className="mt-6 space-y-3"
        onSubmit={(e) => { e.preventDefault(); m.mutate(); }}
      >
        <Field label="Email">
          <input
            type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            className="w-full rounded-md border border-border bg-bg-panel px-3 py-2 font-mono text-sm text-text focus:border-accent focus:outline-none"
          />
        </Field>
        <Field label="Password">
          <input
            type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            className="w-full rounded-md border border-border bg-bg-panel px-3 py-2 font-mono text-sm text-text focus:border-accent focus:outline-none"
          />
        </Field>
        {m.error && <ErrorMessage error={m.error} />}
        <button
          type="submit"
          disabled={m.isPending}
          className="w-full rounded-md bg-accent px-4 py-2 font-mono text-sm text-bg hover:brightness-110 disabled:opacity-50"
        >
          {m.isPending ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      <p className="mt-4 font-mono text-xs text-text-subtle">
        No account?{' '}
        <Link href="/auth/register" className="text-accent hover:underline">Create one</Link>.
      </p>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-text-muted">{label}</span>
      {children}
    </label>
  );
}

function ErrorMessage({ error }: { error: unknown }) {
  return (
    <div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
      {error instanceof Error ? error.message : 'Sign-in failed'}
    </div>
  );
}
