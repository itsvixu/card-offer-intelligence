// §5.5 — the emailed run report: plain-language headline, a "What changed"
// section with the page's own wording, review items and failures kept
// separate, and nothing silently dropped.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRunReport, buildRunReportJson, summarizeRun } from '../src/report.js';

const counts = (over = {}) => ({ NEW: 0, CHANGED: 0, DISCONTINUED: 0, NO_CHANGE: 0, NEEDS_REVIEW: 0, FAILED: 0, ...over });
const rec = (over = {}) => ({
  sourceId: 'chase-csp',
  issuer: 'Chase',
  product: 'Sapphire Preferred',
  market: 'us',
  classification: 'CHANGED',
  changedFields: ['bonusAmount'],
  headline: 'Welcome bonus raised from 75,000 to 100,000 points',
  rawOfferText: 'Earn 100,000 bonus points after you spend $5,000 in the first 3 months',
  url: 'https://creditcards.chase.com/sapphire',
  offer: { bonusAmount: 100000, bonusUnit: 'points', spendRequirement: 5000, spendCurrency: 'USD', spendWindowDays: 90, annualFee: 95 },
  notes: '',
  ...over,
});
const run = (records, failures = [], c = counts()) => ({
  startedAt: '2026-11-16T08:00:00Z',
  finishedAt: '2026-11-16T08:02:00Z',
  records,
  failures,
  counts: c,
});

test('summary sentence leads with changes and notes caveats', () => {
  const s = summarizeRun(run([rec()], [{ sourceId: 'x', error: 'HTTP 503' }], counts({ CHANGED: 1, NEEDS_REVIEW: 1, FAILED: 1 })));
  assert.equal(s, '1 offer change across 2 card pages (1 need a look, 1 could not be scanned).');
});

test('a quiet run says so plainly', () => {
  assert.equal(summarizeRun(run([rec({ classification: 'NO_CHANGE' })], [], counts({ NO_CHANGE: 1 }))), 'No offer changes across 1 card page.');
});

test('changes are described in plain language with the page wording quoted', () => {
  const md = buildRunReport(run([rec()], [], counts({ CHANGED: 1 })));
  assert.match(md, /## What changed/);
  assert.match(md, /\*\*Chase Sapphire Preferred\*\* — Welcome bonus raised from 75,000 to 100,000 points/);
  assert.match(md, /> Earn 100,000 bonus points/);
  assert.doesNotMatch(md, /bonusAmount/, 'internal field names never reach the reader');
});

test('newly tracked cards get a one-line offer summary', () => {
  const md = buildRunReport(run([rec({ classification: 'NEW' })], [], counts({ NEW: 1 })));
  assert.match(md, /## Newly tracked/);
  assert.match(md, /100,000 points after \$5,000 spend in 3 months · \$95 annual fee/);
});

test('review items sit in their own section, never under What changed', () => {
  const md = buildRunReport(
    run([rec(), rec({ sourceId: 'boa', issuer: 'Bank of America', product: 'Premium Rewards', classification: 'NEEDS_REVIEW', notes: 'Selector may be stale.' })], [], counts({ CHANGED: 1, NEEDS_REVIEW: 1 }))
  );
  const changed = md.split('## What changed')[1].split('## Needs a look')[0];
  assert.doesNotMatch(changed, /Bank of America/);
  assert.match(md.split('## Needs a look')[1], /Bank of America Premium Rewards\*\* — Selector may be stale\./);
});

test('failures are listed so they never fail silently', () => {
  const md = buildRunReport(run([], [{ sourceId: 'amex-gold', issuer: 'American Express', product: 'Gold Card', stage: 'fetch', error: 'timeout after 45000ms' }], counts({ FAILED: 1 })));
  assert.match(md, /## Could not be scanned/);
  assert.match(md, /American Express Gold Card\*\* — timeout after 45000ms/);
});

test('unchanged cards are named in one line rather than omitted', () => {
  const md = buildRunReport(run([rec({ classification: 'NO_CHANGE' })], [], counts({ NO_CHANGE: 1 })));
  assert.match(md, /Unchanged: Chase Sapphire Preferred\./);
});

test('JSON report separates flagged from review items and carries headlines', () => {
  const json = buildRunReportJson(
    run([rec(), rec({ sourceId: 'boa', classification: 'NEEDS_REVIEW', notes: 'x' })], [{ sourceId: 'f', stage: 'robots', error: 'Disallowed' }], counts({ CHANGED: 1, NEEDS_REVIEW: 1, FAILED: 1 }))
  );
  assert.equal(json.flagged.length, 1);
  assert.equal(json.flagged[0].headline, 'Welcome bonus raised from 75,000 to 100,000 points');
  assert.equal(json.needsReviewItems[0].sourceId, 'boa');
  assert.deepEqual(json.errors, [{ sourceId: 'f', stage: 'robots', error: 'Disallowed' }]);
  assert.equal(json.summary.totalScanned, 3);
});

test('an empty run produces a valid report', () => {
  const md = buildRunReport(run([], [], counts()));
  assert.match(md, /No offer changes across 0 card pages\./);
  assert.equal(buildRunReportJson(run([], [], counts())).flagged.length, 0);
});
