#!/usr/bin/env node
// Builds data/demo/ — a copy of the real store with a SIMULATED change
// history layered on top, so the dashboard's change feed, timelines and
// review queue can be seen before weeks of real scans have accumulated.
//
// What is real: every card, its current offer, and its screenshot (copied
// from the last real scan). What is simulated: the earlier values, the dates
// changes were "detected", and the two attention items. The dashboard shows a
// permanent "Demo data" banner whenever it is serving this folder.
//
//   node scripts/seed-demo.js && node server.js --demo

import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SnapshotStore } from '../src/store.js';
import { describeChange } from '../src/describe.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REAL = join(ROOT, 'data');
const DEMO = join(ROOT, 'data/demo');

if (!existsSync(join(REAL, 'snapshots.sqlite'))) {
  console.error('No real scan found. Run `npm run scan` first — the demo is built from real captures.');
  process.exit(1);
}

rmSync(DEMO, { recursive: true, force: true });
mkdirSync(DEMO, { recursive: true });
cpSync(join(REAL, 'snapshots.sqlite'), join(DEMO, 'snapshots.sqlite'));
cpSync(join(REAL, 'captures'), join(DEMO, 'captures'), { recursive: true });

const store = new SnapshotStore(join(DEMO, 'snapshots.sqlite'));
const real = store.getLatestRun();
const sourceIds = real.report.results.map((r) => r.sourceId);
const current = Object.fromEntries(sourceIds.map((id) => [id, store.getLatestSnapshot(id)?.parsedOffer ?? null]));
const capture = Object.fromEntries(sourceIds.map((id) => [id, store.getLatestCapture(id)?.path ?? null]));

const DAY = 86400000;
const latest = new Date(real.finishedAt).getTime();
const at = (daysAgo) => new Date(latest - daysAgo * DAY).toISOString();

// Simulated earlier values. Each entry: the field that "used to be" different,
// and how many days before the latest scan the change was detected.
const STORY = [
  { id: 'chase-sapphire-preferred', daysAgo: 21, was: { bonusAmount: 60000 } },
  { id: 'amex-gold', daysAgo: 14, was: { spendRequirement: 6000 } },
  { id: 'citi-strata-premier', daysAgo: 14, was: { bonusAmount: 75000 } },
  { id: 'hsbc-premier-world-elite', daysAgo: 7, was: { bonusAmount: 40000, spendRequirement: 12000, spendWindowDays: 360 } },
  { id: 'capitalone-venture-x', daysAgo: 7, was: { annualFee: 450 } },
  { id: 'wellsfargo-active-cash', daysAgo: 0, was: { bonusAmount: 200 } },
].filter((s) => current[s.id]);

const REVIEW = { id: 'barclaycard-avios', note: 'The page shows two different welcome bonuses, so the offer could not be read with confidence.' };
const FAILED = { id: 'discover-it-cash-back', error: 'Page did not load within 45 seconds.' };

store.db.exec('DELETE FROM runs; DELETE FROM changes;');

const market = (id) => (/(barclaycard|hsbc|amex-uk)/.test(id) ? 'uk' : 'us');
const earlier = (id) => {
  const story = STORY.find((s) => s.id === id);
  return story ? { ...current[id], ...story.was } : current[id];
};

function putRun(daysAgo, results, failures = []) {
  const counts = { NEW: 0, CHANGED: 0, DISCONTINUED: 0, NO_CHANGE: 0, NEEDS_REVIEW: 0, FAILED: failures.length };
  for (const r of results) counts[r.classification]++;
  return store.putRun({ startedAt: at(daysAgo), finishedAt: at(daysAgo), counts, report: { results, failures } });
}

// Baseline, four weeks before the latest scan: every card first seen.
const baselineId = putRun(28, sourceIds.map((id) => ({ sourceId: id, classification: 'NEW', changedFields: [], notes: '' })));
for (const id of sourceIds) {
  const offer = earlier(id);
  store.putChange({
    runId: baselineId,
    sourceId: id,
    detectedAt: at(28),
    classification: 'NEW',
    changedFields: [],
    previousOffer: null,
    currentOffer: offer,
    headline: describeChange({ classification: 'NEW', offer, market: market(id) }),
    captureAfter: capture[id],
  });
}

// Later runs: one per distinct day in the story.
for (const daysAgo of [...new Set(STORY.map((s) => s.daysAgo))].sort((a, b) => b - a)) {
  const changing = STORY.filter((s) => s.daysAgo === daysAgo);
  const isLatest = daysAgo === 0;
  const results = sourceIds
    .filter((id) => !(isLatest && id === FAILED.id))
    .map((id) => {
      const story = changing.find((s) => s.id === id);
      if (story) return { sourceId: id, classification: 'CHANGED', changedFields: Object.keys(story.was), notes: '' };
      if (isLatest && id === REVIEW.id) return { sourceId: id, classification: 'NEEDS_REVIEW', changedFields: [], notes: REVIEW.note };
      return { sourceId: id, classification: 'NO_CHANGE', changedFields: [], notes: '' };
    });
  const failures = isLatest ? [{ sourceId: FAILED.id, stage: 'fetch', error: FAILED.error }] : [];
  const runId = putRun(daysAgo, results, failures);
  for (const story of changing) {
    const record = {
      classification: 'CHANGED',
      changedFields: Object.keys(story.was),
      previousOffer: earlier(story.id),
      offer: current[story.id],
      market: market(story.id),
    };
    store.putChange({
      runId,
      sourceId: story.id,
      detectedAt: at(daysAgo),
      classification: 'CHANGED',
      changedFields: record.changedFields,
      previousOffer: record.previousOffer,
      currentOffer: record.offer,
      headline: describeChange(record),
      captureAfter: capture[story.id],
    });
  }
}

store.close();
console.log(`Demo store written to ${DEMO} (${STORY.length} simulated changes over 4 weeks).`);
