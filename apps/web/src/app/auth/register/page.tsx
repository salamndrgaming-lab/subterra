import type { Metadata } from 'next';
import { TopNav } from '@/components/top-nav';
import { RegisterForm } from '@/components/auth/register-form';

export const metadata: Metadata = { title: 'Create account' };

export default function RegisterPage() {
  return (
    <div className="flex min-h-screen flex-col bg-bg">
      <TopNav />
      <main className="grid flex-1 place-items-center px-6 py-10">
        <RegisterForm />
      </main>
    </div>
  );
}
