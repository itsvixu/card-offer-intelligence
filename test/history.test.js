// Run history, change events and screenshots: what the dashboard reads.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SnapshotStore } from '../src/store.js';
import { runScan } from '../src/pipeline.js';

const page = (bonus) => `<main><h1>Sapphire Preferred</h1><p>Earn ${bonus} bonus points after you spend $5,000 on purchases in the first 3 months. $95 annual fee.</p></main>`;
const source = { sourceId: 'csp', issuer: 'Chase', product: 'Sapphire Preferred', market: 'us', url: 'https://x.example/csp' };

function harness() {
  const store = new SnapshotStore(':memory:');
  const saved = [];
  let clock = 0;
  const scan = (bonus, extra = {}) =>
    runScan({
      sources: [source],
      store,
      delayMs: 0,
      now: () => new Date(Date.UTC(2026, 10, 1) + clock++ * 60000).toISOString(),
      fetchPage: async () => ({ ok: true, status: 200, html: page(bonus), text: null, screenshot: Buffer.from('jpg') }),
      saveCapture: async ({ sourceId, scanTimestamp }) => {
        const path = `${sourceId}/${scanTimestamp}.jpg`;
        saved.push(path);
        return path;
      },
      ...extra,
    });
  return { store, saved, scan };
}

test('locate mode needs no selector and reads the offer from the page', async () => {
  const { store, scan } = harness();
  const run = await scan('75,000');
  assert.equal(run.records[0].classification, 'NEW');
  assert.equal(store.getLatestSnapshot('csp').parsedOffer.bonusAmount, 75000);
  store.close();
});

test('a screenshot is kept on NEW and CHANGED, not on NO_CHANGE', async () => {
  const { store, saved, scan } = harness();
  await scan('75,000');
  await scan('75,000');
  assert.equal(saved.length, 1, 'NO_CHANGE reuses the existing capture');
  const changed = await scan('100,000');
  assert.equal(saved.length, 2);
  assert.equal(changed.records[0].captureBefore, saved[0]);
  assert.equal(changed.records[0].capturePath, saved[1]);
  store.close();
});

test('every run is recorded and change events carry before/after offers and captures', async () => {
  const { store, scan } = harness();
  await scan('75,000');
  await scan('75,000');
  await scan('100,000');
  assert.equal(store.countRuns(), 3);
  const [latest, first] = store.getChanges();
  assert.equal(store.getChanges().length, 2, 'NO_CHANGE runs add no change events');
  assert.equal(latest.classification, 'CHANGED');
  assert.equal(latest.headline, 'Welcome bonus raised from 75,000 to 100,000 points');
  assert.equal(latest.previousOffer.bonusAmount, 75000);
  assert.equal(latest.currentOffer.bonusAmount, 100000);
  assert.ok(latest.captureBefore && latest.captureAfter);
  assert.equal(first.classification, 'NEW');
  assert.deepEqual(store.getLatestRun().counts.CHANGED, 1);
  store.close();
});

test('a page that no longer names the card is NEEDS_REVIEW, not DISCONTINUED', async () => {
  const { store, scan } = harness();
  await scan('75,000');
  const blocked = await runScan({
    sources: [source],
    store,
    delayMs: 0,
    fetchPage: async () => ({ ok: true, status: 200, html: '<p>Access denied</p>', text: 'Access denied' }),
  });
  assert.equal(blocked.records[0].classification, 'NEEDS_REVIEW');
  assert.match(blocked.records[0].notes, /no longer mentions this card/);
  assert.equal(store.getLatestSnapshot('csp').parsedOffer.bonusAmount, 75000, 'last good snapshot kept');
  store.close();
});

test('dry runs record nothing', async () => {
  const { store, saved, scan } = harness();
  await scan('75,000', { persist: false });
  assert.equal(store.countRuns(), 0);
  assert.equal(saved.length, 0);
  assert.equal(store.getLatestSnapshot('csp'), null);
  store.close();
});
