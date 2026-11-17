// The dashboard's data model: one object built from the scan store and the
// source config. Shared by the local server (server.js) and the static site
// build (scripts/build-site.js), so both always show the same thing.

import { existsSync } from 'node:fs';
import { SnapshotStore } from './store.js';
import { describeChange, factRows, summarizeOffer } from './describe.js';

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

// Relative, so the dashboard also works under a sub-path (GitHub Pages).
let captureBase = 'captures/';
const captureUrl = (path) => (path ? `${captureBase}${path}` : null);

function changeView(change, source, firstRunId) {
  const market = source?.market ?? null;
  return {
    id: change.id,
    sourceId: change.sourceId,
    issuer: source?.issuer ?? null,
    product: source?.product ?? change.sourceId,
    market,
    detectedAt: change.detectedAt,
    classification: change.classification,
    // Regenerated from the stored offers so wording improvements apply to history too.
    headline: describeChange({
      classification: change.classification,
      changedFields: change.changedFields,
      offer: change.currentOffer,
      previousOffer: change.previousOffer,
      market,
    }),
    facts: factRows(change.previousOffer, change.currentOffer, market),
    captureBefore: captureUrl(change.captureBefore),
    captureAfter: captureUrl(change.captureAfter),
    // Every card is "new" on the very first scan; that is a baseline, not news.
    isBaseline: change.classification === 'NEW' && change.runId === firstRunId,
  };
}

/**
 * @param {object} opts
 * @param {string} opts.dbPath
 * @param {Array} opts.sources
 * @param {boolean} [opts.demo]
 * @param {string} [opts.captureBase]  URL prefix for screenshots.
 * @param {object} [opts.links]        Cross-links shown by the dashboard (demo, live, caseStudy).
 */
export function buildOverview({ dbPath, sources, demo = false, captureBase: base = 'captures/', links = {} }) {
  captureBase = base;
  if (!existsSync(dbPath)) {
    return { empty: true, demo, links, cards: [], changes: [], attention: [], lastRun: null, sourceCount: sources.length };
  }
  const store = new SnapshotStore(dbPath, { readOnly: true });
  try {
    const lastRun = store.getLatestRun();
    const firstRunId = store.getFirstRunId();
    const bySource = new Map(sources.map((s) => [s.sourceId, s]));
    const results = new Map((lastRun?.report?.results ?? []).map((r) => [r.sourceId, r]));
    const failures = new Map((lastRun?.report?.failures ?? []).map((f) => [f.sourceId, f]));
    const allChanges = store.getChanges({ limit: 500 });

    const cards = sources.map((source) => {
      const snap = store.getLatestSnapshot(source.sourceId);
      const offer = snap?.parsedOffer ?? null;
      const capture = store.getLatestCapture(source.sourceId);
      const result = results.get(source.sourceId);
      const failure = failures.get(source.sourceId);
      const history = allChanges.filter((c) => c.sourceId === source.sourceId);
      const lastChange = history.find((c) => !(c.classification === 'NEW' && c.runId === firstRunId));

      let status = 'ok';
      let statusNote = null;
      if (failure) {
        status = 'failed';
        statusNote = failure.error;
      } else if (result?.classification === 'NEEDS_REVIEW') {
        status = 'review';
        statusNote = result.notes;
      } else if (snap && !offer) {
        status = 'withdrawn';
        statusNote = 'No welcome offer on the page at the last scan.';
      } else if (!snap) {
        status = 'pending';
        statusNote = 'Not scanned yet.';
      }

      return {
        id: source.sourceId,
        issuer: source.issuer,
        product: source.product,
        market: source.market,
        network: source.network ?? null,
        category: source.category ?? null,
        url: source.url,
        host: hostOf(source.url),
        offer,
        summary: summarizeOffer(offer, source.market),
        facts: factRows(null, offer, source.market),
        pageWording: snap?.rawOfferText ?? null,
        confidence: offer?.confidence ?? null,
        isTargeted: Boolean(offer?.isTargeted),
        lastScanned: snap?.scanTimestamp ?? null,
        capture: captureUrl(capture?.path),
        capturedAt: capture?.scanTimestamp ?? null,
        status,
        statusNote,
        firstSeen: history.length ? history[history.length - 1].detectedAt : snap?.scanTimestamp ?? null,
        lastChange: lastChange ? changeView(lastChange, source, firstRunId) : null,
      };
    });

    const attention = cards
      .filter((c) => c.status === 'review' || c.status === 'failed')
      .map((c) => ({
        sourceId: c.id,
        issuer: c.issuer,
        product: c.product,
        market: c.market,
        kind: c.status,
        reason: c.statusNote,
        url: c.url,
        capture: c.capture,
      }));

    return {
      empty: false,
      demo,
      links,
      sourceCount: sources.length,
      runCount: store.countRuns(),
      lastRun: lastRun
        ? { startedAt: lastRun.startedAt, finishedAt: lastRun.finishedAt, counts: lastRun.counts }
        : null,
      cards,
      changes: allChanges
        .filter((c) => bySource.has(c.sourceId))
        .map((c) => changeView(c, bySource.get(c.sourceId), firstRunId)),
      attention,
    };
  } finally {
    store.close();
  }
}
