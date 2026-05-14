import type { Metadata } from 'next';
import { TopNav } from '@/components/top-nav';
import { SettingsShell } from '@/components/settings/settings-shell';

export const metadata: Metadata = { title: 'Settings' };

export default function SettingsPage() {
  return (
    <div className="flex h-full flex-col bg-bg">
      <TopNav />
      <SettingsShell />
    </div>
  );
}
