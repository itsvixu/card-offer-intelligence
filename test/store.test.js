// §8 snapshot store — round-trip, latest-wins, null-offer preservation, and
// on-disk persistence across store instances (the property GitHub Actions
// relies on when it commits the file back and checks it out next run).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SnapshotStore } from '../src/store.js';

const offer = { bonusAmount: 75000, spendRequirement: 5000, confidence: 'high' };

test('getLatestSnapshot returns null for an unseen source', () => {
  const s = new SnapshotStore(':memory:');
  assert.equal(s.getLatestSnapshot('never-scanned'), null);
  s.close();
});

test('round-trips a parsed offer', () => {
  const s = new SnapshotStore(':memory:');
  s.putSnapshot({
    sourceId: 'a',
    scanTimestamp: '2026-07-11T00:00:00Z',
    regionFound: true,
    rawOfferText: 'Earn 75,000 points...',
    parsedOffer: offer,
  });
  const got = s.getLatestSnapshot('a');
  assert.equal(got.rawOfferText, 'Earn 75,000 points...');
  assert.equal(got.regionFound, true);
  assert.deepEqual(got.parsedOffer, offer);
  s.close();
});

test('getLatestSnapshot returns the most recent row, not the first', () => {
  const s = new SnapshotStore(':memory:');
  s.putSnapshot({ sourceId: 'a', scanTimestamp: 't1', regionFound: true, rawOfferText: 'old', parsedOffer: { bonusAmount: 75000 } });
  s.putSnapshot({ sourceId: 'a', scanTimestamp: 't2', regionFound: true, rawOfferText: 'new', parsedOffer: { bonusAmount: 100000 } });
  assert.equal(s.getLatestSnapshot('a').parsedOffer.bonusAmount, 100000);
  s.close();
});

test('preserves a null parsedOffer (region found but no offer) distinct from "unseen"', () => {
  const s = new SnapshotStore(':memory:');
  s.putSnapshot({ sourceId: 'a', scanTimestamp: 't', regionFound: true, rawOfferText: 'no offer here', parsedOffer: null });
  const got = s.getLatestSnapshot('a');
  assert.notEqual(got, null, 'a stored null-offer row is not the same as never-scanned');
  assert.equal(got.parsedOffer, null);
  s.close();
});

test('persists to a file across separate store instances', () => {
  const path = join(tmpdir(), `snap-${process.pid}-${Date.now()}.sqlite`);
  try {
    const s1 = new SnapshotStore(path);
    s1.putSnapshot({ sourceId: 'a', scanTimestamp: 't', regionFound: true, rawOfferText: 'x', parsedOffer: offer });
    s1.close();

    const s2 = new SnapshotStore(path);
    assert.deepEqual(s2.getLatestSnapshot('a').parsedOffer, offer);
    s2.close();
  } finally {
    rmSync(path, { force: true });
  }
});
