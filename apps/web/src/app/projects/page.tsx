import type { Metadata } from 'next';
import { TopNav } from '@/components/top-nav';
import { ProjectsShell } from '@/components/projects/projects-shell';

export const metadata: Metadata = { title: 'Projects' };

export default function ProjectsPage() {
  return (
    <div className="flex h-screen flex-col bg-bg">
      <TopNav />
      <ProjectsShell />
    </div>
  );
}
