// Plain-language descriptions used by the report and the dashboard.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeChange, summarizeOffer, factRows } from '../src/describe.js';

const offer = (over = {}) => ({
  bonusAmount: 75000, bonusAmountMax: null, bonusUnit: 'points',
  spendRequirement: 5000, spendCurrency: 'USD', spendWindowDays: 90, annualFee: 95, ...over,
});
const changed = (fields, prev, curr, market = 'us') =>
  describeChange({ classification: 'CHANGED', changedFields: fields, previousOffer: prev, offer: curr, market });

test('bonus raise and cut', () => {
  assert.equal(changed(['bonusAmount'], offer(), offer({ bonusAmount: 100000 })), 'Welcome bonus raised from 75,000 to 100,000 points');
  assert.equal(changed(['bonusAmount'], offer(), offer({ bonusAmount: 60000 })), 'Welcome bonus cut from 75,000 to 60,000 points');
});

test('spend requirement (the Amex Gold pattern)', () => {
  assert.equal(changed(['spendRequirement'], offer({ spendRequirement: 6000 }), offer({ spendRequirement: 8000 })), 'Spend requirement raised from $6,000 to $8,000');
});

test('several fields are joined in one headline', () => {
  assert.equal(
    changed(['spendWindowDays', 'annualFee'], offer({ spendWindowDays: 90, annualFee: 95 }), offer({ spendWindowDays: 180, annualFee: 0 })),
    'Time to earn extended from 3 months to 6 months; Annual fee dropped from $95 to none'
  );
});

test('cash bonuses and pounds read naturally', () => {
  assert.equal(changed(['bonusAmount'], offer({ bonusUnit: 'cash', bonusAmount: 200 }), offer({ bonusUnit: 'cash', bonusAmount: 100 })), 'Welcome bonus cut from $200 to $100');
  assert.equal(summarizeOffer(offer({ bonusUnit: 'avios', bonusAmount: 25000, spendCurrency: 'GBP', spendRequirement: 3000, annualFee: null }), 'uk'), '25,000 Avios after £3,000 spend in 3 months');
});

test('fixed to targeted', () => {
  assert.equal(
    changed(['bonusAmount', 'bonusAmountMax'], offer(), offer({ bonusAmount: null, bonusAmountMax: 100000 })),
    'Bonus is now targeted, up to 100,000 points'
  );
});

test('withdrawn and new', () => {
  assert.match(describeChange({ classification: 'DISCONTINUED', previousOffer: offer(), market: 'us' }), /^Welcome offer withdrawn \(was 75,000 points/);
  assert.match(describeChange({ classification: 'NEW', offer: offer(), market: 'us' }), /^Now tracking: 75,000 points after \$5,000 spend in 3 months · \$95 annual fee$/);
});

test('fact rows mark what changed and which way, without judging it', () => {
  const rows = factRows(offer(), offer({ bonusAmount: 100000, annualFee: 0 }), 'us');
  const by = Object.fromEntries(rows.map((r) => [r.key, r]));
  assert.equal(by.bonus.changed, true);
  assert.equal(by.bonus.direction, 'up');
  assert.equal(by.fee.direction, 'down');
  assert.equal(by.spend.changed, false);
  assert.equal(by.fee.after, 'None');
});
