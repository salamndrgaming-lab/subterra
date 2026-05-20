import { Link } from 'react-router-dom';

export function NotFoundPage(): JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center bg-bg text-center">
      <div className="font-mono text-[10px] uppercase tracking-wider text-text-muted">404</div>
      <h1 className="mt-2 font-mono text-4xl text-text">Off the map.</h1>
      <p className="mt-2 max-w-md text-sm text-text-subtle">
        The page you requested doesn&apos;t exist. Try the map or head back home.
      </p>
      <div className="mt-6 flex gap-3">
        <Link to="/" className="rounded-md border border-border bg-bg-panel px-4 py-2 font-mono text-xs text-text">
          Home
        </Link>
        <Link to="/map" className="rounded-md bg-accent px-4 py-2 font-mono text-xs text-bg">
          Open the map →
        </Link>
      </div>
    </div>
  );
}
