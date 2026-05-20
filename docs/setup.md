# Manual setup (one-time, ~30 minutes)

You do these once. After that everything is automated by CI.

## 1. Cloudflare account (free)

1. Visit https://dash.cloudflare.com/sign-up
2. Sign up with your email, verify
3. After login, **copy the Account ID** from the right sidebar of the dashboard

## 2. R2 bucket

1. Cloudflare dashboard → **R2 Object Storage** → "Create bucket"
2. Name: `subterra-tiles`
3. Click "Create" (no other settings)

## 3. D1 database

1. Cloudflare dashboard → **Workers & Pages → D1** → "Create database"
2. Name: `subterra`
3. **Copy the Database ID** that appears (looks like a UUID)
4. Open `apps/api/wrangler.toml` locally and paste the Database ID into the `database_id` field under `[[d1_databases]]`. (CI uses env vars too, but local `wrangler dev` reads this file.)

## 4. API token

1. Cloudflare dashboard → **My Profile → API Tokens** → "Create Token"
2. Use template **"Edit Cloudflare Workers"**
3. Add permissions: `Account → D1 → Edit`, `Account → R2 → Edit`, `Account → Cloudflare Pages → Edit`
4. **Copy the token** (only shown once)

## 5. GitHub secrets

In your GitHub repo: **Settings → Secrets and variables → Actions → "New repository secret"**.

Add these four:

| Name | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | the token from step 4 |
| `CLOUDFLARE_ACCOUNT_ID` | the Account ID from step 1 |
| `CLOUDFLARE_D1_DATABASE_ID` | the Database ID from step 3 |
| `CLOUDFLARE_R2_BUCKET` | `subterra-tiles` |

## 6. Stripe (Phase 7 — defer if you're not selling yet)

1. https://dashboard.stripe.com/register → sign up
2. **Developers → API keys** → reveal Secret key
3. GitHub Secrets → add `STRIPE_SECRET_KEY`
4. **Developers → Webhooks** → "Add endpoint"
5. Endpoint URL: `https://subterra-api.<your-cf-subdomain>.workers.dev/billing/webhook`
6. Events: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`
7. Copy the Signing secret → GitHub Secrets → `STRIPE_WEBHOOK_SECRET`
8. Run `node scripts/sync-stripe.ts` once to upsert the products in `infra/stripe-products.json` into your Stripe account.

## 7. Resend (Phase 6 — alert emails)

1. https://resend.com/signup
2. **API Keys → Create**
3. GitHub Secrets → add `RESEND_API_KEY`
4. Verify your sending domain (Resend dashboard walks you through DNS records)
5. Set `RESEND_FROM` env var to a verified sender like `alerts@subterra.app`

## 8. EIA OpenData (commodity prices)

1. https://www.eia.gov/opendata/register.php → free instant signup
2. GitHub Secrets → add `EIA_API_KEY`

## 9. Optional — your own domain

Buy on Cloudflare Registrar (~$10/yr) or any registrar. Add to Cloudflare DNS, then in **Workers & Pages → subterra → Custom domains** point it at the Pages project. CF handles SSL automatically.

If you skip this, you get `subterra.pages.dev` for free.

---

## Files YOU edit by hand

| File | Why | When |
|---|---|---|
| `.env.local` (root) | Local dev secrets — `cp .env.example .env.local` and fill in CF tokens for local dev. Optional; the SPA + Worker run without any of them. | Phase 0 |
| `apps/api/wrangler.toml` | Paste your D1 `database_id` from step 3 (CI overrides this for prod, but local dev reads the file). | Phase 0 |
| `etl/sources/_locator.json` | Your name, mailing address, phone — used to pre-fill every Notice-of-Location PDF. | Phase 5 |
| `infra/stripe-products.json` | Adjust pricing tiers if you don't like the defaults. | Phase 7 |

That's four files. Nothing else needs hand-edits.
