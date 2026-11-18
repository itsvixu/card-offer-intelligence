# Card Offer Intelligence

Twice a week this opens 14 competitor credit card pages in a real browser and reads
each welcome offer. It compares the offer with the last scan and, when anything has
moved, records the change in plain language with a screenshot of the page. The
dashboard shows what changed and what each card's offer is today.

**[Live dashboard](https://itsvixu.github.io/card-offer-intelligence/) · [Demo with change history](https://itsvixu.github.io/card-offer-intelligence/demo/) · [Case study](https://itsvixu.github.io/card-offer-intelligence/case-study.html)**

![The change feed](docs/changes.jpg)

## The problem

My team needed to know what competitors were offering new cardholders. We gathered it
by hand, it took a lot of time, and a person had to check every figure.

The spec started from the idea that issuers often change only the amount and leave
every other word on the page as it was. An alert for changed wording would miss those
changes, so the scanner compares figures. When I first ran it in November, four of the
six cards that were also in our July data showed a different offer or figure on the
issuer's page. Chase Sapphire Preferred was 100,000 points in July and 75,000 on the
page.

Each offer is read into four facts: the welcome bonus, the spend required, the time to
earn it and the annual fee. A redesigned page with the same figures isn't flagged. A
$2,000 change to a spend requirement is.

## Design decisions

The first screen shows what changed since the last scan. The full list of cards is one
tab away, and a quiet week says so.

Each change sits beside a screenshot of the live page, with the issuer's own wording
underneath, so checking it takes a few seconds. I still want a person checking what
the scanner finds.

The scanner compares fields with names like `bonusAmount`. The dashboard and the
emailed report both say "Welcome bonus raised from 60,000 to 75,000 points", and they
get that sentence from one shared module.

Changes are marked with an arrow up or down. I left out red and green because a
competitor raising a bonus isn't good or bad news in itself.

If a page can't be read with confidence, the card goes to *Needs a look* with the
reason and isn't reported as changed or unchanged. Where an offer says "as high as
100,000 points", the dashboard labels it as a ceiling.

The first version of the scanner needed a CSS selector for every page, and those broke
when an issuer redesigned. The current one reads the page in order and takes the first
statement that pairs a bonus with a spend requirement as the card's own offer. Later
ones are usually other cards. A new card needs only a URL.

![All cards](docs/cards.jpg)

![Card detail](docs/card-detail.jpg)

## Run it

Requires Node 22.5 or later.

```sh
npm install
npx playwright install chromium   # headless browser, about 100 MB, one-off

npm start          # scan all cards, then open the dashboard at http://localhost:4173
npm run demo       # dashboard with four weeks of simulated history (see below)
npm run site       # build the static site (live + demo + case study) into site/
npm test           # 103 tests, no network needed
```

Other commands:

```sh
npm run scan                     # scan only; writes data/ and output/run-report.md
npm run dashboard                # dashboard only, over the last scan
node run-scan.js --dry-run       # scan and classify, store nothing
```

**About the demo.** Real change history takes weeks of scans to build up. `npm run demo`
copies the real store and adds six simulated changes over four weeks, plus one failed
page and one that needs a look, so the change feed and timelines have content. Cards,
current offers, and screenshots are all real. The dashboard shows a permanent "Demo
data" banner in this mode.

## Unattended runs and the published site

Two workflows in [`.github/workflows/`](.github/workflows/):

- **`competitor-offer-scan.yml`** scans every Monday and Thursday at 08:00 UTC. It
  commits the store and any new screenshots back to the repo, so the history lives in
  git, then rebuilds and publishes the site to GitHub Pages.
- **`publish-site.yml`** runs the tests and republishes the site whenever `main`
  changes.

The published site is static. `scripts/build-site.js` writes the dashboard's data to
JSON next to the page, so no server is needed.

Optional secrets: `ANTHROPIC_API_KEY` lets an offer the parser can't read get a second
reading from Claude before it goes to *Needs a look*. Add `SMTP_SERVER`, `SMTP_PORT`,
`SMTP_USER`, `SMTP_PASS` and `REPORT_EMAIL_TO` to email the report. Without them, the
email step is skipped.

## Tracked cards

US: Chase Sapphire Preferred, Sapphire Reserve and Freedom Unlimited; American Express
Gold and Platinum; Capital One Venture and Venture X; Citi Strata Premier; Discover it
Cash Back; Wells Fargo Active Cash.

UK: Barclaycard Avios and Avios Plus; American Express British Airways Premium Plus;
HSBC Premier World Elite.

To add a card, add an entry to [`config/sources.json`](config/sources.json): an id,
issuer, product, market (`us` or `uk`) and URL. `offerSelector` is an optional override
for a page where the automatic reading picks the wrong statement.

## How it works

```
robots.txt check → render page (Playwright) → find the offer → parse 4 facts
   → compare with last scan → screenshot if changed → store → report + dashboard
```

| Module | Role |
|---|---|
| `src/browser.js` | Renders the page, declines optional cookies, returns text, HTML and a screenshot |
| `src/locate.js` | Finds the card's own offer in the page text, with no selector |
| `src/parse.js` | Reads bonus, spend, time and fee. An optional Claude fallback handles unreadable offers |
| `src/diff-engine.js` | Field-by-field comparison: NEW, CHANGED, DISCONTINUED, NO_CHANGE or NEEDS_REVIEW |
| `src/pipeline.js` | Runs the scan and keeps screenshots only when something changed |
| `src/store.js` | SQLite store of snapshots, runs, change events and captures |
| `src/describe.js` | Turns changes into plain language for the report and dashboard |
| `src/robots.js` | Never fetches a page that robots.txt disallows |
| `src/overview.js` | The dashboard's data, shared by the local server and the static build |
| `server.js`, `dashboard/` | Read-only server and the dashboard (no framework, no build step) |
| `scripts/build-site.js` | Static site for GitHub Pages: live dashboard, demo and case study |

## Limits

- It reads public offers. Personalised offers behind a login or an eligibility check
  are out of reach.
- Bank of America returned a 403 and NerdWallet turns automated requests away, so
  neither is tracked. A blocked or redirected page goes to *Needs a look* and is never
  reported as a withdrawn offer.
- Screenshots are taken at a 1440 px desktop width and show the top of the page.
- Storage grows by about 150 KB each time an offer changes, for the new screenshot.
