// Unit tests for §5.3 — every row of the classification table, driven with
// parsed offer objects directly (the fixture suite covers HTML end-to-end).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffOffer, CLASSIFICATION, COMPARED_FIELDS } from '../src/diff-engine.js';

const offer = (overrides = {}) => ({
  bonusAmount: 75000,
  bonusAmountMax: null,
  isTargeted: false,
  bonusUnit: 'points',
  spendRequirement: 5000,
  spendCurrency: 'USD',
  spendWindowDays: 90,
  annualFee: 95,
  confidence: 'high',
  extractionMethod: 'regex',
  ...overrides,
});

const snapshot = (parsedOffer, rawOfferText = 'raw offer text') => ({ rawOfferText, parsedOffer });
const scan = (parsedOffer, { regionFound = true, rawOfferText = 'raw offer text' } = {}) => ({
  regionFound,
  rawOfferText,
  parsedOffer,
});

test('no previous snapshot → NEW', () => {
  const record = diffOffer({ sourceId: 's', previous: null, current: scan(offer()) });
  assert.equal(record.classification, CLASSIFICATION.NEW);
  assert.equal(record.current.bonusAmount, 75000);
});

test('no previous snapshot and no parsable offer → NEEDS_REVIEW, not NEW', () => {
  const record = diffOffer({ sourceId: 's', previous: null, current: scan(null) });
  assert.equal(record.classification, CLASSIFICATION.NEEDS_REVIEW);
});

test('bonusAmount differs → CHANGED with field-level diff', () => {
  const record = diffOffer({
    sourceId: 's',
    previous: snapshot(offer({ bonusAmount: 75000 })),
    current: scan(offer({ bonusAmount: 100000 })),
  });
  assert.equal(record.classification, CLASSIFICATION.CHANGED);
  assert.deepEqual(record.changedFields, ['bonusAmount']);
  assert.deepEqual(record.previous, { bonusAmount: 75000 });
  assert.deepEqual(record.current, { bonusAmount: 100000 });
});

test('spendRequirement differs (bonus identical) → CHANGED, exactly like a bonus change', () => {
  const record = diffOffer({
    sourceId: 's',
    previous: snapshot(offer({ spendRequirement: 6000 })),
    current: scan(offer({ spendRequirement: 8000 })),
  });
  assert.equal(record.classification, CLASSIFICATION.CHANGED);
  assert.deepEqual(record.changedFields, ['spendRequirement']);
});

test('spendWindowDays differs → CHANGED', () => {
  const record = diffOffer({
    sourceId: 's',
    previous: snapshot(offer({ spendWindowDays: 90 })),
    current: scan(offer({ spendWindowDays: 180 })),
  });
  assert.equal(record.classification, CLASSIFICATION.CHANGED);
  assert.deepEqual(record.changedFields, ['spendWindowDays']);
});

test('annualFee differs → CHANGED', () => {
  const record = diffOffer({
    sourceId: 's',
    previous: snapshot(offer({ annualFee: 95 })),
    current: scan(offer({ annualFee: 0 })),
  });
  assert.equal(record.classification, CLASSIFICATION.CHANGED);
  assert.deepEqual(record.changedFields, ['annualFee']);
});

test('bonusAmountMax differs on a targeted offer → CHANGED', () => {
  const record = diffOffer({
    sourceId: 's',
    previous: snapshot(offer({ bonusAmount: null, bonusAmountMax: 60000, isTargeted: true })),
    current: scan(offer({ bonusAmount: null, bonusAmountMax: 100000, isTargeted: true })),
  });
  assert.equal(record.classification, CLASSIFICATION.CHANGED);
  assert.deepEqual(record.changedFields, ['bonusAmountMax']);
});

test('fixed offer becomes targeted ceiling → CHANGED on both bonus fields', () => {
  const record = diffOffer({
    sourceId: 's',
    previous: snapshot(offer({ bonusAmount: 90000, bonusAmountMax: null })),
    current: scan(offer({ bonusAmount: null, bonusAmountMax: 90000, isTargeted: true })),
  });
  assert.equal(record.classification, CLASSIFICATION.CHANGED);
  assert.deepEqual(record.changedFields, ['bonusAmount', 'bonusAmountMax']);
});

test('same number, different currency → CHANGED (never assume USD, §10)', () => {
  const record = diffOffer({
    sourceId: 's',
    previous: snapshot(offer({ spendCurrency: 'USD' })),
    current: scan(offer({ spendCurrency: 'GBP' })),
  });
  assert.equal(record.classification, CLASSIFICATION.CHANGED);
  assert.deepEqual(record.changedFields, ['spendCurrency']);
});

test('multiple fields change → all listed, in COMPARED_FIELDS order', () => {
  const record = diffOffer({
    sourceId: 's',
    previous: snapshot(offer()),
    current: scan(offer({ bonusAmount: 100000, annualFee: 795, spendRequirement: 6000 })),
  });
  assert.equal(record.classification, CLASSIFICATION.CHANGED);
  assert.deepEqual(record.changedFields, ['bonusAmount', 'spendRequirement', 'annualFee']);
});

test('all structured fields match → NO_CHANGE even if raw text differs completely', () => {
  const record = diffOffer({
    sourceId: 's',
    previous: snapshot(offer(), 'Earn 75,000 bonus points after you spend $5,000...'),
    current: scan(offer(), {
      rawOfferText: 'NEW! LIMITED TIME! Updated offer: 75,000 points when you spend $5,000...',
    }),
  });
  assert.equal(record.classification, CLASSIFICATION.NO_CHANGE);
  assert.deepEqual(record.changedFields, []);
});

test('parsable offer before, none now → DISCONTINUED', () => {
  const record = diffOffer({ sourceId: 's', previous: snapshot(offer()), current: scan(null) });
  assert.equal(record.classification, CLASSIFICATION.DISCONTINUED);
  assert.equal(record.previous.bonusAmount, 75000);
});

test('no offer before, offer now → NEW', () => {
  const record = diffOffer({ sourceId: 's', previous: snapshot(null), current: scan(offer()) });
  assert.equal(record.classification, CLASSIFICATION.NEW);
});

test('low confidence on previous value → NEEDS_REVIEW, never silent NO_CHANGE', () => {
  const record = diffOffer({
    sourceId: 's',
    previous: snapshot(offer({ confidence: 'low' })),
    current: scan(offer()),
  });
  assert.equal(record.classification, CLASSIFICATION.NEEDS_REVIEW);
});

test('low confidence on current value → NEEDS_REVIEW even when fields differ, diff still reported', () => {
  const record = diffOffer({
    sourceId: 's',
    previous: snapshot(offer()),
    current: scan(offer({ bonusAmount: 100000, confidence: 'low' })),
  });
  assert.equal(record.classification, CLASSIFICATION.NEEDS_REVIEW);
  assert.deepEqual(record.changedFields, ['bonusAmount']);
});

test('selector matched nothing → NEEDS_REVIEW with stale-selector note (§10)', () => {
  const record = diffOffer({
    sourceId: 's',
    previous: snapshot(offer()),
    current: scan(null, { regionFound: false, rawOfferText: null }),
  });
  assert.equal(record.classification, CLASSIFICATION.NEEDS_REVIEW);
  assert.match(record.notes, /selector may be stale/i);
});

test('COMPARED_FIELDS covers every §5.3 structured field', () => {
  for (const f of ['bonusAmount', 'bonusAmountMax', 'spendRequirement', 'spendWindowDays', 'annualFee']) {
    assert.ok(COMPARED_FIELDS.includes(f), `missing ${f}`);
  }
});
