// End-to-end pipeline: fetch → scan → diff → persist, and — the point of the
// snapshot store — correct behaviour when the same source is scanned across
// multiple runs. Uses a fake fetcher returning saved fixture HTML for
// determinism, plus one test exercising the real file:// fetcher.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SnapshotStore } from '../src/store.js';
import { runScan } from '../src/pipeline.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const html = (name, file) => readFileSync(join(fixturesDir, name, file), 'utf8');

// Fake fetcher: map url -> { html } for success or { error, status } for failure.
function fakeFetcher(map) {
  return async (url) => {
    const entry = map[url];
    if (!entry) return { ok: false, status: 404, html: null, error: 'HTTP 404' };
    if (entry.error) return { ok: false, status: entry.status ?? null, html: null, error: entry.error };
    return { ok: true, status: 200, html: entry.html, error: null };
  };
}

const source = (over = {}) => ({
  sourceId: 'chase-csp',
  url: 'u',
  offerSelector: '.welcome-offer-copy',
  requiresBrowser: false,
  issuer: 'Chase',
  product: 'Sapphire Preferred',
  market: 'us',
  ...over,
});

test('persists across runs: NEW on first scan, CHANGED when the bonus moves', async () => {
  const store = new SnapshotStore(':memory:');
  const sources = [source()];

  const run1 = await runScan({
    sources,
    store,
    fetchPage: fakeFetcher({ u: { html: html('bonus-amount-change', 'before.html') } }),
    delayMs: 0,
  });
  assert.equal(run1.records[0].classification, 'NEW');
  assert.equal(run1.counts.NEW, 1);

  const run2 = await runScan({
    sources,
    store,
    fetchPage: fakeFetcher({ u: { html: html('bonus-amount-change', 'after.html') } }),
    delayMs: 0,
  });
  assert.equal(run2.records[0].classification, 'CHANGED');
  assert.deepEqual(run2.records[0].changedFields, ['bonusAmount']);
  assert.deepEqual(run2.records[0].previous, { bonusAmount: 75000 });
  assert.deepEqual(run2.records[0].current, { bonusAmount: 100000 });
  store.close();
});

test('a re-scan of an unchanged page is NO_CHANGE', async () => {
  const store = new SnapshotStore(':memory:');
  const sources = [source({ sourceId: 'amex-gold', offerSelector: '[data-testid="offer-copy"]' })];
  const fetchPage = fakeFetcher({ u: { html: html('spend-requirement-change', 'before.html') } });

  await runScan({ sources, store, fetchPage, delayMs: 0 });
  const rerun = await runScan({ sources, store, fetchPage, delayMs: 0 });
  assert.equal(rerun.records[0].classification, 'NO_CHANGE');
  store.close();
});

test('a fetch failure is logged, not thrown, and never advances the snapshot', async () => {
  const store = new SnapshotStore(':memory:');
  const sources = [source()];

  await runScan({
    sources,
    store,
    fetchPage: fakeFetcher({ u: { html: html('bonus-amount-change', 'before.html') } }),
    delayMs: 0,
  });

  const failed = await runScan({
    sources,
    store,
    fetchPage: fakeFetcher({ u: { error: 'HTTP 503', status: 503 } }),
    delayMs: 0,
  });
  assert.equal(failed.counts.FAILED, 1);
  assert.equal(failed.records.length, 0);
  assert.equal(failed.failures[0].stage, 'fetch');
  assert.equal(failed.fetchLog[0].ok, false);

  // Because the failed run left the store untouched, the next good scan of the
  // SAME offer is NO_CHANGE — a transient outage must not manufacture a NEW.
  const recovered = await runScan({
    sources,
    store,
    fetchPage: fakeFetcher({ u: { html: html('bonus-amount-change', 'before.html') } }),
    delayMs: 0,
  });
  assert.equal(recovered.records[0].classification, 'NO_CHANGE');
  store.close();
});

test('a broken selector is NEEDS_REVIEW and preserves the last good snapshot', async () => {
  const store = new SnapshotStore(':memory:');
  const sources = [source({ sourceId: 'boa', offerSelector: '.offer-details' })];

  // before.html has .offer-details → a good baseline scan.
  await runScan({
    sources,
    store,
    fetchPage: fakeFetcher({ u: { html: html('stale-selector', 'before.html') } }),
    delayMs: 0,
  });

  // after.html renamed the container → selector matches nothing.
  const broke = await runScan({
    sources,
    store,
    fetchPage: fakeFetcher({ u: { html: html('stale-selector', 'after.html') } }),
    delayMs: 0,
  });
  assert.equal(broke.records[0].classification, 'NEEDS_REVIEW');
  assert.match(broke.records[0].notes, /selector may be stale/i);

  // Selector fixed / page reverts: still diffs against the ORIGINAL snapshot
  // (the broken run didn't overwrite it) → NO_CHANGE, not a spurious NEW.
  const back = await runScan({
    sources,
    store,
    fetchPage: fakeFetcher({ u: { html: html('stale-selector', 'before.html') } }),
    delayMs: 0,
  });
  assert.equal(back.records[0].classification, 'NO_CHANGE');
  store.close();
});

test('real fetchPage reads file:// sources (offline fixtures / demo path)', async () => {
  const store = new SnapshotStore(':memory:');
  const url = pathToFileURL(join(fixturesDir, 'bonus-amount-change', 'after.html')).href;
  const run = await runScan({ sources: [source({ url })], store, delayMs: 0 }); // default real fetcher
  assert.equal(run.fetchLog[0].ok, true);
  assert.equal(run.records[0].classification, 'NEW');
  store.close();
});

test('a requiresBrowser source with no browser fetcher is a recorded failure, not a crash', async () => {
  const store = new SnapshotStore(':memory:');
  const sources = [source({ url: 'https://example.com/js-page', requiresBrowser: true })];
  const run = await runScan({ sources, store, delayMs: 0 });
  assert.equal(run.counts.FAILED, 1);
  assert.match(run.failures[0].error, /headless.browser|requiresBrowser/i);
  store.close();
});

// §5.4 — creative capture is conditional on the classification, the main
// cost/efficiency lever of the pipeline. These tests inject a fake
// captureCreative to count calls and inspect arguments without touching the
// real regex/vision machinery (covered separately in creative.test.js).
function countingCapture(returnUrl = 'https://x/banner.png') {
  const calls = [];
  const fn = async (html, args) => {
    calls.push(args);
    return { creativeUrl: returnUrl, candidates: [{ url: returnUrl }], method: 'single-candidate' };
  };
  fn.calls = calls;
  return fn;
}

test('NEW record triggers creative capture and stores the resolved URL', async () => {
  const store = new SnapshotStore(':memory:');
  const capture = countingCapture('https://x/csp-banner.png');
  const run = await runScan({
    sources: [source()],
    store,
    fetchPage: fakeFetcher({ u: { html: html('bonus-amount-change', 'before.html') } }),
    captureCreative: capture,
    delayMs: 0,
  });
  assert.equal(capture.calls.length, 1);
  assert.equal(capture.calls[0].pageUrl, 'u');
  assert.equal(capture.calls[0].offerSelector, '.welcome-offer-copy');
  assert.equal(capture.calls[0].issuer, 'Chase');
  assert.equal(run.records[0].creativeUrl, 'https://x/csp-banner.png');
  store.close();
});

test('NO_CHANGE never calls creative capture — the cost/efficiency lever of §5.4', async () => {
  const store = new SnapshotStore(':memory:');
  const fetchPage = fakeFetcher({ u: { html: html('spend-requirement-change', 'before.html') } });
  const capture = countingCapture();

  await runScan({ sources: [source({ offerSelector: '[data-testid="offer-copy"]' })], store, fetchPage, captureCreative: capture, delayMs: 0 });
  assert.equal(capture.calls.length, 1, 'first scan is NEW, so it should capture once');

  const rerun = await runScan({ sources: [source({ offerSelector: '[data-testid="offer-copy"]' })], store, fetchPage, captureCreative: capture, delayMs: 0 });
  assert.equal(rerun.records[0].classification, 'NO_CHANGE');
  assert.equal(capture.calls.length, 1, 'NO_CHANGE must not trigger a second capture call');
  store.close();
});

test('DISCONTINUED and NEEDS_REVIEW also trigger creative capture', async () => {
  const store = new SnapshotStore(':memory:');
  const capture = countingCapture();

  await runScan({
    sources: [source({ sourceId: 'citi', offerSelector: '.offer-banner' })],
    store,
    fetchPage: fakeFetcher({ u: { html: html('discontinued-offer', 'before.html') } }),
    captureCreative: capture,
    delayMs: 0,
  });
  const discontinuedRun = await runScan({
    sources: [source({ sourceId: 'citi', offerSelector: '.offer-banner' })],
    store,
    fetchPage: fakeFetcher({ u: { html: html('discontinued-offer', 'after.html') } }),
    captureCreative: capture,
    delayMs: 0,
  });
  assert.equal(discontinuedRun.records[0].classification, 'DISCONTINUED');
  assert.equal(capture.calls.length, 2, 'NEW then DISCONTINUED — both capture');

  const reviewRun = await runScan({
    sources: [source({ sourceId: 'boa', offerSelector: '.offer-details' })],
    store,
    fetchPage: fakeFetcher({ u: { html: html('stale-selector', 'after.html') } }),
    captureCreative: capture,
    delayMs: 0,
  });
  assert.equal(reviewRun.records[0].classification, 'NEEDS_REVIEW');
  assert.equal(capture.calls.length, 3, 'NEEDS_REVIEW also captures');
  store.close();
});
