# Subterra — strategy notes toward $1M → $10M valuation

This doc is the long-horizon plan. The phase-by-phase roadmap in
`/root/.claude/plans/` is the *execution* document; this is the
*positioning* document. Updated as the product evolves.

## Where the money comes from

To hit a $10M+ valuation we need either ~$2M ARR (5× SaaS multiple)
or a strategic exit to a major (Rio, Newmont, Barrick, an oilfield
services co, or a GIS giant like Esri / Trimble). Both paths route
through the same near-term work; the optionality is real.

Realistic ARR mix at $2M:

| Tier | Price | Customers | ARR |
| --- | ---: | ---: | ---: |
| Free | $0 | ~10,000 | $0 (lead funnel) |
| Prospector | $49/mo | 1,200 | $706k |
| Operator | $499/mo | 150 | $898k |
| Enterprise | $2,499/mo+ | 15 | $450k |
| **Total** | | ~1,365 | **$2.05M** |

Hitting Prospector volume requires distribution (SEO, prospector
forums, sponsored geology podcasts). Operator + Enterprise require
account-managed sales, which we *don't* build until the product
proves it converts free → paid at >2%.

## Wedge — why anyone buys the first month

The "I'll lose this claim Sept 1" maintenance-fee tracker (Phase 4,
shipped) is the single most concrete subscription-justifier on the
catalog. Free-tier users get the data + tracker; paid users get
email/SMS reminders + bulk import + paying-on-our-behalf integration
(Stripe-funded BLM MLRS payment). Conversion test: tag 100 free
sign-ups with the tracker enabled, measure 30-day paid conversion.

## Near-term moat (next 3 months)

Layered data is the moat, not any single source:

1. **Stake-clarity overlay** (shipped) — instant "is this open?"
2. **Cross-section subsurface** (shipped) — instant "what's here?"
3. **Maintenance-fee tracker** (shipped) — habit-forming weekly visit
4. **Per-county parcels with price** (shipping pending ETL run) —
   answers "what is private ground worth here?" — no public site
   shows BLM federal land + private parcels + active claims +
   mineral occurrences on the same map
5. **Quaternary faults** (shipping pending ETL run) — seismic risk
   layer no prospecting tool currently offers

The combination is the moat. Recreating it requires bilateral
licensing with every state DWR + 50 county GIS offices + USGS +
Macrostrat + USFWS + Census + EIA + BLM MLRS. Each one is 1-2 weeks.

## Medium-term roadmap (next 6 months) — ranked by $-per-week

Each entry is a single shippable slice with an honest revenue case:

### 1. Phase 6 alerts (highest priority)
"New claim filed in your AOI" email → magic-link back to map. The
loop that makes Subterra recurring. Already plumbed in D1 + Resend
from Phase 4; needs the diff producer (already drafted as Tier-1 #2
in the feature catalog) and the cron worker.

Revenue case: makes Prospector ($49/mo) tier defensible. Without
alerts a prospector visits once, decides, leaves. With alerts they
get pinged when conditions change in their watched ground.

### 2. Phase 7 Stripe billing
Until this lands there's no payment path. Two routes:
1. Stripe Checkout for simple subscriptions
2. Per-claim maintenance-fee payment passthrough (Subterra ACHs the
   BLM, takes a 2% spread, eliminates the Sept 1 disaster)

Route 2 has a real moat — nobody else does it — but BLM payment APIs
are paperwork. Route 1 first.

### 3. Cover the western states
Currently NV+UT+AZ for water rights, NV-only for parcels. Expand to
CO, NM, ID, MT, WY, CA, OR, WA — these 11 states cover essentially
all western mining ground. Each state is 1-2 days of new ETL +
field-name mapping.

### 4. Auto-filing — Notice of Location PDF generator
The user draws their AOI, picks claim type (lode / placer /
millsite), pastes their info — Subterra spits out a printable PDF in
BLM-MLRS format ready to file at the county recorder. Charging $25
per filing on top of the subscription is fair (manual filling is
$200/hr lawyer time).

### 5. Operator intelligence
"Top operators within 50 mi", MSHA-linked safety + production
history, recent claim activity. Sells the Operator tier. MSHA data
is bulk-downloadable.

### 6. Mobile-native iOS app (or PWA-as-app)
Field prospectors live on phones. Vercel deploy + responsive layout
are the bridge; a real installable app (PWA via service worker is
already done!) is the next step. Camera-based geotag + offline tile
sync are existing catalog items.

### 7. AI-powered "where would you stake?" assistant
Natural-language search ("show me lithium plays near rail in
Nevada with no active claims") backed by Claude API + the structured
layer registry. Highly differentiated, no competitor has it.

## Long-term moves (12-24 months) — high-leverage bets

### A. Premium data integrations
- **Satellite multispectral mineral detection** (Sentinel-2 + ASTER
  alteration band ratios pulled into a "hydrothermal alteration"
  layer)
- **LiDAR-derived geomorphology** for placer + paleochannel targets
- **NGGDP drill-hole database** — the holy grail for vectoring
- **Historical mining production by district** — NV / AZ / NM
  publish annual production reports; turn into "this district
  produced 50 Moz historically" badges

### B. API tier + white-label
Mining juniors want our data inside their own GIS workflows.
$2,499/mo enterprise + $0.05 per /eligibility call. White-label
deploys with their branding on top of our infra for $15k/year.

### C. Marketplace
Connect claim holders with buyers / investors. Stripe Connect for
payouts. Legal complexity (state-by-state mining-claim transfer
rules) but huge optionality — every transaction is a 3-5% take.

### D. Permitting workflow management
Track NEPA / BLM permit applications / state mining permits through
their lifecycle. Operator-tier feature ($499/mo) for juniors who
file 10+ permits per year.

### E. Investment-grade reports
For each AOI, generate a PDF resource estimate (heuristic, with
clear caveats) suitable for sharing with investors. Charge $99 per
report. Targets the "prospector who wants to raise $50k to develop"
audience.

## What we deliberately DON'T build

- **Real-time chat / community features** — wrong audience (paranoid
  about competitors), high moderation cost, no clear revenue path.
- **Generic GIS editing** — QGIS is free; we can't beat it; we'd
  bleed users to it. Our edge is curation + opinion, not features.
- **Consumer / hobbyist app** — niche misalignment with the
  subscription pricing the product can support.
- **Multi-currency** — US-only is fine until $1M ARR; expanding to
  Canada or Australia is a 6-month project, not worth it pre-PMF.

## Risk register

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Cloudflare R2 egress pricing changes | Medium | High | Tile size already capped at 500 KB/tile, switch to CDN-fronted asset bucket if egress becomes >$200/mo |
| ETL source slug-shuffling | High (already happened) | Medium | All URLs env-overridable; per-source `failed` status surface lands this commit |
| BLM API rate-limiting | Medium | Medium | Current ETL respects 6 concurrent + retry with backoff; could move to a backed CDN cache |
| Competitor (Esri / Mining Intelligence Network) bundles equivalent layers | Medium | High | Move fast on the proprietary combination (faults + parcels + claims + price + permitting workflow on one map) |
| Anthropic API cost explosion if NL search becomes hot | Low | Low | Cache aggressive on query plans; rate-limit free tier |
| Single-developer bus factor | High | Catastrophic | Document, test, automate; second engineer at $250k ARR |
| Stripe / Resend / Cloudflare account suspension | Low | Catastrophic | Daily R2 backup of D1 + features.db to an S3 mirror; alternative-provider playbook documented |

## Conversion funnel targets (Q1 2027)

| Stage | Target | How we measure |
| --- | ---: | --- |
| Site visit | 10,000/mo | Pages analytics |
| Map page reached | 60% (6k) | Plausible event |
| Sign-up | 8% (480) | D1 user count |
| Saved AOI | 50% (240) | D1 aois count |
| Returned in 7d | 30% (72) | Magic-link redeem rate |
| Returned in 30d | 15% (36) | Cohort analysis |
| Paid conversion | 5% (24/mo) | Stripe |
| Annual paid LTV | 14 months × $49 | Stripe + churn |

At those numbers we hit ~$14k MRR / $170k ARR after 12 months from
launch — the "first $1M valuation" anchor — purely from Prospector
sign-ups, with zero account-managed sales.

## What "production-grade" looks like

Some items are platform plumbing, not features, but they gate
enterprise + investor confidence:

- 99.9% uptime SLA on /manifest + /tiles (Cloudflare gives us this for
  free; we need monitoring proof)
- Sentry / Logflare on the Worker + the SPA
- Daily D1 + features.db backups to a separate region/provider
- E2E tests for the critical paths (sign-in, claim tracking, payment)
  — currently we have ~3 smoke tests
- A status page (status.subterra.app) backed by uptime monitors
- Postmortems written + published when something breaks

These cost 1 month of work spread across the next 12. Worth it.
