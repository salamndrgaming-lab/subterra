import type { Metadata } from 'next';
import { TopNav } from '@/components/top-nav';
import { LoginForm } from '@/components/auth/login-form';

export const metadata: Metadata = { title: 'Sign in' };

export default function LoginPage() {
  return (
    <div className="flex min-h-screen flex-col bg-bg">
      <TopNav />
      <main className="grid flex-1 place-items-center px-6 py-10">
        <LoginForm />
      </main>
    </div>
  );
}
