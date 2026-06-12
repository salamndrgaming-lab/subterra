/** API base-URL resolution — single source of truth for every client
 *  module that talks to the Worker (manifest, auth, my-claims, api).
 *
 *  Resolution order:
 *   1. VITE_API_URL baked at build time (CI prod builds, .env.local dev).
 *   2. localhost page → local dev Worker (wrangler dev on :8787).
 *   3. *.subterra.pages.dev preview alias → preview Worker.
 *   4. anything else (prod Pages, custom domain) → prod Worker.
 *
 *  Steps 2-4 exist because Cloudflare Pages' Git integration builds
 *  feature-branch previews on Cloudflare's infra where our CI can't
 *  inject VITE_API_URL — without a runtime fallback those bundles
 *  ship with no API URL at all and the map renders empty ("no tiles
 *  yet") for every visitor. The workers.dev subdomain is stable per
 *  Cloudflare account; update the constant if the account changes. */

const WORKERS_SUBDOMAIN = 'salamndrgaming';
const PROD_API = `https://subterra-api.${WORKERS_SUBDOMAIN}.workers.dev`;
const PREVIEW_API = `https://subterra-api-preview.${WORKERS_SUBDOMAIN}.workers.dev`;

export function resolveApiBase(): string {
  const baked = import.meta.env.VITE_API_URL as string | undefined;
  if (baked) return baked.replace(/\/$/, '');

  if (typeof window === 'undefined') return PROD_API;
  const host = window.location.hostname;

  if (host === 'localhost' || host === '127.0.0.1') {
    return 'http://localhost:8787';
  }
  // Pages preview aliases: <hash>.subterra.pages.dev or
  // <branch-slug>.subterra.pages.dev. Production is the bare
  // subterra.pages.dev (or a custom domain → prod).
  if (host.endsWith('.subterra.pages.dev')) {
    return PREVIEW_API;
  }
  return PROD_API;
}

export const API_BASE = resolveApiBase();
