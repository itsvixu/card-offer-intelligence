# Competitor Offer & Creative Monitoring Agent — Technical Spec

**Status:** Finalized — open questions resolved, ready for build (Claude Code)
**Feeds:** Card Offer Intelligence dashboard (US + European tabs)
**Cadence:** Twice weekly, unattended

---

## 1. Purpose

Automatically detect when a tracked competitor's credit card offer changes — a new
card, a changed bonus, a discontinued product — and, only when something has actually
changed, capture the associated creative (banner image + basic specs) for the design
team's review. Output lands in a format the existing dashboard can ingest via its
bulk-import feature.

## 2. The one requirement that shapes the whole design

> **Issuers frequently change only the offer amount and leave every other word on the
> page identical.** Chase's welcome bonus moving from 75,000 to 100,000 points, or
> Amex Gold's spend requirement moving from $6,000 to $8,000, involves zero new
> marketing copy — no "new," no "updated," no visual change to the page template.
>
> **Therefore the diff engine must compare structured, parsed offer values
> (bonus amount, spend requirement, spend window, annual fee) between scans — not
> search the raw text for change-indicating language.** Keyword/phrase matching
> ("new offer", "limited time") is treated as a weak secondary signal at best, never
> the primary trigger. This is the core correctness requirement of the whole system;
> see §5.3.

## 3. Non-goals

- This is **not** a general ad-discovery tool. It only monitors a defined, curated
  list of sources (issuer pages + a short list of affiliate/comparison sites) — it does
  not crawl the open web looking for creative.
- It does not track paid social/display ad placements (Meta, programmatic networks).
  That's a separate problem better solved by an ad-transparency API or a display-ad
  vendor, as discussed previously — out of scope here.
- It does not replace human review. Every flagged change is a candidate for the
  design/product team to confirm, not an auto-published fact.

## 4. Architecture overview

```
┌─────────────┐   twice-weekly   ┌──────────────────┐
│  Scheduler   │ ───────────────▶│  Scan Runner      │
│ (cron / GH   │                 │  (per source)     │
│  Actions)    │                 └────────┬──────────┘
└─────────────┘                           │
                                           ▼
                              ┌─────────────────────────┐
                              │ 1. Fetch page            │
                              │ 2. Extract offer text     │
                              │ 3. Parse → structured     │
                              │    offer object           │
                              └────────┬──────────────────┘
                                       ▼
                          ┌─────────────────────────────┐
                          │ 4. Diff vs. last snapshot     │
                          │    (structured fields, not     │
                          │    raw text)                   │
                          └────────┬────────────────────┘
                                   │ changed / new / discontinued
                                   ▼ (skip if unchanged)
                          ┌─────────────────────────────┐
                          │ 5. Capture creative on the     │
                          │    same page (image + basic     │
                          │    specs)                        │
                          └────────┬────────────────────┘
                                   ▼
                          ┌─────────────────────────────┐
                          │ 6. Write output:                │
                          │    - updated snapshot store      │
                          │    - dashboard bulk-import lines  │
                          │    - run report (for humans)      │
                          └─────────────────────────────┘
```

This cannot run inside a chat session or the dashboard artifact — it needs a real
scheduler and persistent storage between runs. Recommended: a small Claude Code–built
service, triggered by a GitHub Actions scheduled workflow (simplest, no infra to
manage) or a cloud function + scheduler (EventBridge/Cloud Scheduler) if it needs to
live alongside other internal services.

## 5. Pipeline stages

### 5.1 Fetch & snapshot

For each configured source (see §4 of the config schema below):

- Fetch the page (plain HTTP fetch for static/server-rendered pages; a headless
  browser like Playwright for JS-rendered issuer pages — check each source and record
  which it needs).
- Extract the relevant text region — ideally scoped to a CSS selector or DOM landmark
  identified during setup (e.g. `.welcome-offer`, `[data-testid="offer-copy"]`), not
  the whole page, to reduce noise from unrelated page changes (nav updates, cookie
  banners, unrelated promos).
- Store the raw HTML/text snapshot with a timestamp, keyed by source ID.

### 5.2 Structured offer extraction

Convert the raw offer text into a normalized object — this is what actually gets
diffed, not the text itself.

**Hybrid extraction approach:**

1. **Regex pass first** (fast, free, deterministic). Issuer marketing copy is
   templated enough that patterns like these cover most cases:
   - Bonus: `(\d[\d,]*)\s*(points?|miles?|% ?cash ?back)`
   - Spend requirement: `\$?(\d[\d,]*)\s*(?:spend|purchases?|in purchases)`
   - Spend window: `(\d+)\s*(day|month)s?`
   - Annual fee: `\$(\d[\d,]*)\s*annual fee` or `no annual fee` → `0`
2. **LLM fallback** when regex confidence is low, the text doesn't match expected
   patterns, or the offer is non-standard (e.g. Discover's "Cashback Match" isn't a
   fixed number; Amex's "apply to find your personalized offer, up to X" is a ceiling,
   not a guaranteed amount). Use **Claude Sonnet 5** with a strict "return only this
   JSON schema" prompt — this is a short, well-scoped, cheap call; no need for Fable
   here.
3. Always store the **raw text snippet alongside the parsed values**, so a human
   reviewing a flagged change can see exactly what the page says, not just the
   numbers.

**Handling personalized/targeted offers:** store as `bonusAmountMax` with a
`isTargeted: true` flag rather than treating the ceiling as a guaranteed value. Diff
the max value the same way as a fixed bonus.

### 5.3 Diff & classification logic — the core requirement

Compare the newly parsed offer object against the **last stored parsed object** for
that source (not against the raw text, not against a keyword list):

| Check | Result |
|---|---|
| No previous snapshot exists for this source | **NEW** — first time seen |
| `bonusAmount` (or `bonusAmountMax`) differs | **CHANGED** |
| `spendRequirement` differs | **CHANGED** |
| `spendWindowDays` differs | **CHANGED** |
| `annualFee` differs | **CHANGED** |
| A parsable offer existed before but none is found now | **DISCONTINUED** (mirrors the Citi Custom Cash pattern already in the dashboard) |
| All structured fields match, raw text nearly identical | **NO_CHANGE** — skip creative capture, cheapest path |
| Parser confidence is `low` on either the old or new value | **NEEDS_REVIEW** — never silently classify as NO_CHANGE when we aren't confident we actually compared like-for-like values |

This table is deliberately field-by-field rather than "did the offer text change
overall" — a $2,000 change in spend requirement with an identical bonus amount (the
Amex Gold case from the dashboard) must flag exactly the same way a bonus-amount
change does. **Any single structured field changing is sufficient to flag CHANGED.**
Keyword scanning ("new", "updated", "limited time") may be logged as a supporting
signal in the run report but must never gate whether a change is flagged.

### 5.4 Creative capture (conditional — only on NEW / CHANGED / DISCONTINUED)

Skipping this step on NO_CHANGE is the main cost/efficiency lever of the whole
design — most scans of most sources on most weeks will be NO_CHANGE, and only the
minority that actually moved should trigger the more expensive image-finding work.

- Candidate image sources on the page: `og:image` meta tag, the largest image in the
  DOM near the offer text region, any image with alt text matching the card/issuer
  name.
- Where more than one candidate exists, a quick vision-model call (Sonnet 5 is
  sufficient — all current Claude models support vision) can confirm which candidate
  is actually the promotional banner rather than a nav logo or unrelated asset.
- Record the resolved image URL, plus whatever of {width, height, colors} can be
  cheaply derived (the dashboard already does this client-side on import — no need to
  duplicate that here, just pass the URL through).

### 5.5 Output & dashboard integration

Two outputs per run:

1. **Bulk-import lines** — one per NEW/CHANGED record, in the exact format the
   dashboard's bulk-import box already accepts:
   ```
   Chase Sapphire | https://example-source.com/path/to/banner.png
   Amex Gold | https://example-source.com/path/to/banner2.png
   ```
   This is the bridge that requires zero changes to the dashboard today — someone
   pastes this block into "Bulk import captures" twice a week.

   **NEEDS_REVIEW records are included in this block, not withheld** — a low-confidence
   parse still gets its bulk-import line so it isn't invisible to the design team, but
   it's listed under a separate "⚠️ Needs review" heading in the email (see below)
   rather than mixed in with the confident NEW/CHANGED lines, so it's visible without
   blocking the pipeline. Don't append review markers into the keyword text itself —
   that would break the dashboard's substring matching against issuer/product.
2. **Run report, emailed each cycle** — plain-text or markdown summary, sent to a
   configured recipient (store as a secret/env var, e.g. `REPORT_EMAIL_TO`; not a
   Slack integration for now). Structure:
   - Sources scanned, with NEW / CHANGED / DISCONTINUED / NEEDS_REVIEW counts
   - The field-level diff for each flagged source (e.g. `bonusAmount: 75000 → 100000`)
   - A distinct "⚠️ Needs review" section listing anything low-confidence, so it's
     visible even though it isn't blocking
   - Any sources that failed to fetch or parse, so those don't fail silently
   - The bulk-import block itself, ready to copy straight into the dashboard

## 6. Data schemas

**Source config entry:**
```json
{
  "sourceId": "chase-csp",
  "issuer": "Chase",
  "product": "Sapphire Preferred",
  "market": "us",
  "url": "https://creditcards.chase.com/rewards-credit-cards/sapphire/preferred",
  "offerSelector": ".welcome-offer-copy",
  "requiresBrowser": false,
  "sourceType": "issuer"
}
```
`sourceType` distinguishes `issuer` (the bank's own page) from `affiliate`
(NerdWallet, The Points Guy, Bankrate, Upgraded Points) — affiliate sources are useful
as a cross-check and for catching offers before an issuer's own page updates, but
should be weighted as secondary confirmation, not primary source of truth, since
affiliate sites sometimes lag or editorialize the numbers.

**Initial source list (confirmed):**
- **Issuer sources** — seed directly from the dashboard's existing `US_DATA`/`EU_DATA`
  records: each record's `sourceUrl` becomes a `sourceType: "issuer"` entry, carrying
  over the issuer/product/market fields already established during the dashboard's
  research phase — no need to re-derive these from scratch.
- **Affiliate sources** — NerdWallet, The Points Guy, Bankrate, and Upgraded Points,
  matched against the same set of tracked cards where each site covers them.

**Parsed offer object (stored and diffed):**
```json
{
  "sourceId": "chase-csp",
  "scanTimestamp": "2026-07-14T08:00:00Z",
  "rawOfferText": "Earn 100,000 bonus points after you spend $5,000 on purchases in the first 3 months",
  "parsedOffer": {
    "bonusAmount": 100000,
    "bonusAmountMax": null,
    "isTargeted": false,
    "bonusUnit": "points",
    "spendRequirement": 5000,
    "spendCurrency": "USD",
    "spendWindowDays": 90,
    "annualFee": 95,
    "confidence": "high",
    "extractionMethod": "regex"
  }
}
```

**Run classification record:**
```json
{
  "sourceId": "chase-csp",
  "classification": "CHANGED",
  "changedFields": ["bonusAmount"],
  "previous": { "bonusAmount": 75000 },
  "current": { "bonusAmount": 100000 },
  "creativeUrl": "https://...",
  "notes": ""
}
```

## 7. Model routing

| Stage | Suggested model | Why |
|---|---|---|
| Build the whole pipeline (this spec → working code) | **Claude Fable 5**, via Claude Code | Genuinely complex, multi-file, multi-stage build — long-horizon coding is exactly what Fable's premium is worth paying for, as a one-time/occasional cost |
| Regex extraction fallback (per-source, per-run) | **Claude Sonnet 5** | Short, well-scoped, structured-output task; no benefit from Fable's extra cost here |
| Vision confirmation of creative candidate | **Claude Sonnet 5** | Vision is available on all current models; this is a narrow classification, not deep reasoning |
| Ongoing maintenance / adding new sources | **Claude Sonnet 5**, escalate to Fable only if a source's page structure requires genuinely tricky multi-step reasoning to parse | Keep recurring costs low; reserve Fable for occasional hard problems |

## 8. Scheduling & infrastructure

Simplest viable option — GitHub Actions scheduled workflow:

```yaml
name: competitor-offer-scan
on:
  schedule:
    - cron: '0 8 * * 1,4'   # Monday & Thursday, 08:00 UTC
  workflow_dispatch: {}       # allow manual trigger for testing
jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm install
      - run: node run-scan.js
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      - name: Commit updated snapshot store
        run: |
          git config user.name "offer-scan-bot"
          git config user.email "actions@github.com"
          git add data/snapshots.sqlite
          git commit -m "Update offer snapshots $(date -u +%Y-%m-%dT%H:%M:%SZ)" || echo "No changes"
          git push
      - name: Email run report
        uses: dawidd6/action-send-mail@v3
        with:
          server_address: smtp.example.com
          username: ${{ secrets.SMTP_USER }}
          password: ${{ secrets.SMTP_PASS }}
          subject: "Competitor offer scan — $(date -u +%Y-%m-%d)"
          to: ${{ secrets.REPORT_EMAIL_TO }}
          from: offer-scan-bot
          body: file://output/run-report.md
      - uses: actions/upload-artifact@v4
        with:
          name: run-report
          path: output/run-report.md
```

**Decision: SQLite file, committed back to the repo.** The workflow checks out the
repo (pulling in the last-committed snapshot database), runs the scan against it, and
commits the updated file back as its own step — no external database to provision or
maintain. This is the right amount of infrastructure for the current volume; revisit
only if the source list grows substantially or multiple people/services need
concurrent write access.

Email delivery uses a plain SMTP-based GitHub Action rather than a Slack integration
for now — `REPORT_EMAIL_TO` is a deployment-time secret, filled in when this is set up
rather than hardcoded here.

## 9. Compliance & rate limiting

- Check ToS and `robots.txt` for every source before adding it, especially the
  affiliate/comparison sites — some restrict automated access more than issuer sites
  do.
- Twice-weekly per source is a gentle cadence, but still: add request delays between
  sources in the same run, set a descriptive User-Agent, and respect any `Crawl-delay`
  directives found.
- Log every fetch (success/failure/status code) in the run report so access issues
  surface immediately rather than failing silently for weeks.

## 10. Failure handling & edge cases

- **Page structure changes** (issuer redesigns their page): the offer selector stops
  matching → flag as `NEEDS_REVIEW` with a "selector may be stale" note, don't
  silently classify as NO_CHANGE or DISCONTINUED.
- **Rotating/category offers** (Discover's quarterly 5% categories): these change on
  a predictable schedule and aren't "welcome offer" changes in the same sense — track
  separately from the bonus/spend/fee diff if you want visibility into them, so they
  don't create alert fatigue in the main NEW/CHANGED feed.
- **Multiple offers on one page** (e.g. a card with both a standard and a targeted
  offer shown): capture both, don't collapse to one.
- **Currency handling for the European tab**: `spendCurrency`/fee currency must be
  tracked per source (GBP/EUR/USD) — never assume USD.

## 11. Testing & validation plan

Before trusting this on real sources, build a small fixture set: 5–10 saved HTML
snippets with **known before/after pairs**, including at least:
- A pure bonus-amount change with identical surrounding copy (the exact scenario that
  motivated this spec — this test must pass before anything else matters)
- A spend-requirement-only change (the Amex Gold pattern)
- A full page redesign with no actual offer change (should classify NO_CHANGE)
- A discontinued offer (page no longer has parsable offer text)
- A personalized/targeted offer with a ceiling value

Run the diff engine against these fixtures as an automated test suite, not just
ad hoc — this is cheap to build and is what actually proves the field-level diff
requirement in §5.3 works before it runs unattended twice a week.

## 12. Decisions

All open questions from the draft have been resolved:

1. **Source list** — confirmed as proposed: issuer pages seeded from the existing
   dashboard records, plus NerdWallet, The Points Guy, Bankrate, and Upgraded Points
   as affiliate cross-checks.
2. **Snapshot storage** — a committed SQLite file is sufficient for now (§8).
3. **Run report delivery** — email, to a single recipient configured via secret; no
   Slack integration for this iteration (§5.5, §8).
4. **NEEDS_REVIEW handling** — included in the bulk-import output rather than
   withheld, called out under a distinct heading in the emailed run report so it's
   visible without blocking anything downstream (§5.5).

Nothing is blocking a build from starting.
