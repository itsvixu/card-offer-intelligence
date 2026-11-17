// Parser tests, anchored on the spec's own §6 example offer text.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOfferText } from '../src/parse.js';

test('parses the §6 schema example text', async () => {
  const parsed = await parseOfferText(
    'Earn 100,000 bonus points after you spend $5,000 on purchases in the first 3 months'
  );
  assert.equal(parsed.bonusAmount, 100000);
  assert.equal(parsed.bonusAmountMax, null);
  assert.equal(parsed.isTargeted, false);
  assert.equal(parsed.bonusUnit, 'points');
  assert.equal(parsed.spendRequirement, 5000);
  assert.equal(parsed.spendCurrency, 'USD');
  assert.equal(parsed.spendWindowDays, 90);
  assert.equal(parsed.confidence, 'high');
  assert.equal(parsed.extractionMethod, 'regex');
});

test('"no annual fee" parses to 0, not null', async () => {
  const parsed = await parseOfferText(
    'Earn 50,000 miles after you spend $3,000 on purchases in the first 3 months. No annual fee.'
  );
  assert.equal(parsed.annualFee, 0);
});

test('targeted ceiling ("up to") → bonusAmountMax + isTargeted, not a guaranteed bonusAmount', async () => {
  const parsed = await parseOfferText(
    'Apply to see your personalised offer: earn up to 60,000 Avios when you spend £5,000 in your first 3 months.'
  );
  assert.equal(parsed.bonusAmount, null);
  assert.equal(parsed.bonusAmountMax, 60000);
  assert.equal(parsed.isTargeted, true);
  assert.equal(parsed.bonusUnit, 'avios');
  assert.equal(parsed.spendCurrency, 'GBP');
});

test('spend amount is never misread as a bonus amount', async () => {
  const parsed = await parseOfferText(
    'Earn 60,000 Membership Rewards® points after you spend $6,000 in eligible purchases within the first 6 months.'
  );
  assert.equal(parsed.bonusAmount, 60000);
  assert.equal(parsed.spendRequirement, 6000);
  assert.equal(parsed.spendWindowDays, 180);
});

test('text with no recognizable offer → null (the DISCONTINUED signal)', async () => {
  assert.equal(
    await parseOfferText('This card is not currently available for new applications.'),
    null
  );
});

test('non-standard offer (Cashback Match) → low confidence, never dropped', async () => {
  const parsed = await parseOfferText(
    'Unlimited Cashback Match — we automatically match all the cash back you earned your first year.'
  );
  assert.notEqual(parsed, null);
  assert.equal(parsed.confidence, 'low');
});

test('low-confidence regex pass → LLM fallback called if apiKey present, returns high-confidence result', async () => {
  const llmExtract = async (rawText, prevOffer, apiKey) => {
    assert.equal(rawText, 'Unlimited Cashback Match — we automatically match all the cash back.');
    assert.equal(apiKey, 'test-key');
    return {
      success: true,
      offer: {
        bonusAmount: 100,
        bonusAmountMax: null,
        isTargeted: false,
        bonusUnit: 'cashback',
        spendRequirement: null,
        spendCurrency: 'USD',
        spendWindowDays: null,
        annualFee: 0,
        confidence: 'high',
        extractionMethod: 'llm',
      },
    };
  };

  const parsed = await parseOfferText(
    'Unlimited Cashback Match — we automatically match all the cash back.',
    { apiKey: 'test-key', llmExtract }
  );
  assert.equal(parsed.confidence, 'high');
  assert.equal(parsed.extractionMethod, 'llm');
  assert.equal(parsed.bonusAmount, 100);
});

test('low-confidence regex pass → LLM fallback fails, regex result returned as-is', async () => {
  const llmExtract = async () => ({ success: false, offer: null, error: 'http-500' });

  const parsed = await parseOfferText(
    'Unlimited Cashback Match — we automatically match all the cash back.',
    { apiKey: 'test-key', llmExtract }
  );
  assert.equal(parsed.confidence, 'low');
  assert.equal(parsed.extractionMethod, 'regex');
});
