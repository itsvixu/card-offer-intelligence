// §4 orchestration — for each configured source:
//   robots check → fetch → locate + parse the offer → diff against the stored
//   snapshot → keep a screenshot → persist.
// Ties together the fetchers, scan.js, the diff engine, the snapshot store and
// capture into one runnable scan. Output formatting (§5.5) and the dashboard
// consume what this produces.

import { scanHtml } from './scan.js';
import { diffOffer, CLASSIFICATION } from './diff-engine.js';
import { fetchPage as defaultFetchPage } from './fetch.js';
import { captureCreative as defaultCaptureCreative } from './creative.js';
import { describeChange } from './describe.js';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const CHANGE_EVENTS = new Set([
  CLASSIFICATION.NEW,
  CLASSIFICATION.CHANGED,
  CLASSIFICATION.DISCONTINUED,
]);

function emptyCounts() {
  return {
    [CLASSIFICATION.NEW]: 0,
    [CLASSIFICATION.CHANGED]: 0,
    [CLASSIFICATION.DISCONTINUED]: 0,
    [CLASSIFICATION.NO_CHANGE]: 0,
    [CLASSIFICATION.NEEDS_REVIEW]: 0,
    FAILED: 0,
  };
}

/**
 * Run one full scan pass over a list of sources.
 *
 * @param {object} args
 * @param {Array} args.sources     Source config entries (§6).
 * @param {import('./store.js').SnapshotStore} args.store
 * @param {Function} [args.fetchPage]        Injectable; defaults to plain fetch (src/fetch.js).
 *   May resolve with `text` (rendered visible text) and `screenshot` (Buffer).
 * @param {Function} [args.captureCreative]  Image-URL fallback when no screenshot exists.
 * @param {Function} [args.saveCapture]      ({ sourceId, scanTimestamp, buffer }) → stored path.
 * @param {Function} [args.isAllowed]        robots.txt check: (url) → Promise<boolean>.
 * @param {Function} [args.now]              Injectable clock returning an ISO string.
 * @param {number}  [args.delayMs]           Politeness delay between sources (§9).
 * @param {boolean} [args.persist]           Set false for a dry run.
 * @param {Function} [args.log]              Per-source line logger.
 * @returns {Promise<{ startedAt, finishedAt, records, fetchLog, failures, counts, runId }>}
 */
export async function runScan({
  sources,
  store,
  fetchPage = defaultFetchPage,
  captureCreative = defaultCaptureCreative,
  saveCapture = null,
  isAllowed = null,
  now = () => new Date().toISOString(),
  delayMs = 1000,
  persist = true,
  log = () => {},
} = {}) {
  const startedAt = now();
  const records = [];
  const fetchLog = [];
  const failures = [];
  const counts = emptyCounts();

  const fail = (source, stage, error) => {
    counts.FAILED++;
    failures.push({
      sourceId: source.sourceId,
      issuer: source.issuer ?? null,
      product: source.product ?? null,
      url: source.url,
      stage,
      error,
    });
    log(`FAILED         ${source.sourceId} — ${stage}: ${error}`);
  };

  for (let i = 0; i < sources.length; i++) {
    const source = sources[i];
    if (i > 0 && delayMs > 0) await delay(delayMs); // gentle cadence between sources

    const scanTimestamp = now();

    // §9: honor robots.txt before touching the page.
    if (isAllowed && !(await isAllowed(source.url))) {
      fetchLog.push({ sourceId: source.sourceId, url: source.url, ok: false, status: null, error: 'robots.txt' });
      fail(source, 'robots', "Disallowed by the site's robots.txt — not fetched.");
      continue;
    }

    const res = await fetchPage(source.url, {
      requiresBrowser: source.requiresBrowser,
      render: source.render,
      market: source.market,
    });
    fetchLog.push({
      sourceId: source.sourceId,
      url: source.url,
      ok: res.ok,
      status: res.status,
      error: res.error,
    });

    if (!res.ok) {
      fail(source, 'fetch', res.error);
      continue;
    }

    let current;
    try {
      current = await scanHtml(res.html, source.offerSelector, {
        scanTimestamp,
        text: res.text,
        product: source.product,
      });
    } catch (err) {
      // e.g. an unsupported selector shape — a config problem, not a page change.
      fail(source, 'parse', err.message);
      continue;
    }

    const previous = store.getLatestSnapshot(source.sourceId);
    const record = diffOffer({ sourceId: source.sourceId, previous, current });
    // Carry source metadata, the full parsed offers and the raw snippet through
    // for the report and the dashboard (§5.2 #3).
    record.issuer = source.issuer ?? null;
    record.product = source.product ?? null;
    record.market = source.market ?? null;
    record.url = source.url;
    record.rawOfferText = current.rawOfferText;
    record.offer = current.parsedOffer ?? null;
    record.previousOffer = previous?.parsedOffer ?? null;
    record.otherOfferCount = current.otherOfferCount ?? 0;
    record.scanTimestamp = scanTimestamp;

    // §5.4: a screenshot is kept only when something changed (or when this
    // card has none yet). On NO_CHANGE the existing capture still shows the
    // current offer, so nothing new is stored — the cost lever of the design.
    const priorCapture = store.getLatestCapture?.(source.sourceId) ?? null;
    record.capturePath = priorCapture?.path ?? null;
    record.captureBefore = null;
    let capturedNow = false;
    if (
      res.screenshot &&
      saveCapture &&
      persist &&
      (record.classification !== CLASSIFICATION.NO_CHANGE || !priorCapture)
    ) {
      const path = await saveCapture({
        sourceId: source.sourceId,
        scanTimestamp,
        buffer: res.screenshot,
      });
      store.putCapture({ sourceId: source.sourceId, scanTimestamp, path });
      record.captureBefore = priorCapture?.path ?? null;
      record.capturePath = path;
      capturedNow = true;
    }

    // Without a screenshot (plain-HTTP sources), fall back to finding the
    // page's promotional image URL.
    if (record.classification !== CLASSIFICATION.NO_CHANGE && !capturedNow) {
      const capture = await captureCreative(res.html, {
        pageUrl: source.url,
        offerSelector: source.offerSelector,
        issuer: source.issuer,
        product: source.product,
      });
      record.creativeUrl = capture.creativeUrl;
      record.creativeMethod = capture.method;
      record.creativeCandidateCount = capture.candidates.length;
    }

    record.headline = describeChange(record);
    records.push(record);
    counts[record.classification]++;

    // Persist only when we actually observed the offer region. A broken
    // selector or a block page (regionFound === false, §10) must never
    // overwrite the last good snapshot — otherwise the next run would compare
    // against nothing and report a spurious NEW/DISCONTINUED.
    if (persist && current.regionFound) {
      store.putSnapshot({
        sourceId: source.sourceId,
        scanTimestamp,
        regionFound: current.regionFound,
        rawOfferText: current.rawOfferText,
        parsedOffer: current.parsedOffer,
      });
    }

    const diffText = record.changedFields.length ? ` — ${record.changedFields.join(', ')}` : '';
    log(`${record.classification.padEnd(14)} ${source.sourceId}${diffText}`);
  }

  const finishedAt = now();
  let runId = null;

  // Record the run and its change events, so the dashboard has a feed and a
  // per-card timeline rather than only "the latest state".
  if (persist && store.putRun) {
    runId = store.putRun({
      startedAt,
      finishedAt,
      counts,
      report: {
        results: records.map((r) => ({
          sourceId: r.sourceId,
          classification: r.classification,
          headline: r.headline,
          notes: r.notes,
          changedFields: r.changedFields,
        })),
        failures,
      },
    });
    for (const r of records) {
      if (!CHANGE_EVENTS.has(r.classification)) continue;
      store.putChange({
        runId,
        sourceId: r.sourceId,
        detectedAt: r.scanTimestamp,
        classification: r.classification,
        changedFields: r.changedFields,
        previousOffer: r.previousOffer,
        currentOffer: r.offer,
        headline: r.headline,
        captureBefore: r.captureBefore,
        captureAfter: r.capturePath,
      });
    }
  }

  return { startedAt, finishedAt, records, fetchLog, failures, counts, runId };
}
