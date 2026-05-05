import type { Metadata } from 'next';
import { TopNav } from '@/components/top-nav';
import { StakingShell } from '@/components/staking/staking-shell';

export const metadata: Metadata = { title: 'Staking toolkit' };

export default function StakingPage() {
  return (
    <div className="flex h-screen flex-col bg-bg">
      <TopNav />
      <StakingShell />
    </div>
  );
}
