import Link from 'next/link';
import { AuthStatus } from './auth/auth-status';

export function TopNav() {
  return (
    <header className="relative z-30 border-b border-border bg-bg/80 backdrop-blur">
      <nav className="mx-auto flex h-14 max-w-7xl items-center justify-between gap-6 px-6">
        <Link href="/" className="flex items-center gap-2.5">
          <Logo />
          <span className="font-display text-lg font-medium tracking-tight">Subterra</span>
        </Link>

        <div className="hidden items-center gap-1 md:flex">
          <NavLink href="/map">Map</NavLink>
          <NavLink href="/explore/mining">Mining</NavLink>
          <NavLink href="/explore/oilgas">Oil &amp; Gas</NavLink>
          <NavLink href="/explore/parcels">Parcels</NavLink>
          <NavLink href="/staking">Staking</NavLink>
          <NavLink href="/projects">Projects</NavLink>
        </div>

        <div className="flex items-center gap-2">
          <AuthStatus />
          <Link
            href="/settings"
            className="rounded-md px-3 py-1.5 font-mono text-xs text-text-subtle transition hover:text-text"
          >
            Settings
          </Link>
        </div>
      </nav>
    </header>
  );
}

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="rounded-md px-3 py-1.5 font-mono text-xs text-text-subtle transition hover:bg-bg-panel hover:text-text"
    >
      {children}
    </Link>
  );
}

function Logo() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden>
      <path d="M11 2 L20 18 L2 18 Z" stroke="#f59e0b" strokeWidth="1.5" />
      <path d="M11 8 L15 16 L7 16 Z" fill="#f59e0b" fillOpacity="0.4" />
      <circle cx="11" cy="11" r="1.2" fill="#f59e0b" />
    </svg>
  );
}
