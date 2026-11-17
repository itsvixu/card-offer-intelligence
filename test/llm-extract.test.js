// §5.2 / §7 LLM extraction fallback — Sonnet 5 call shape, error handling,
// and heuristic fallback when no API key is present.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractOfferWithLLM } from '../src/llm-extract.js';

test('no API key → returns error and no offer, no network call', async () => {
  const result = await extractOfferWithLLM(
    'Earn 100,000 points after you spend $5,000.',
    {},
    undefined, // no apiKey
    async () => {
      throw new Error('fetch should not have been called');
    }
  );
  assert.equal(result.success, false);
  assert.equal(result.offer, null);
  assert.equal(result.error, 'no-api-key');
});

test('successful LLM parse returns high-confidence offer with extractionMethod=llm', async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      content: [
        {
          type: 'text',
          text: '{"bonusAmount": 100000, "bonusAmountMax": null, "isTargeted": false, "bonusUnit": "points", "spendRequirement": 5000, "spendCurrency": "USD", "spendWindowDays": 90, "annualFee": 95}',
        },
      ],
    }),
  });

  const result = await extractOfferWithLLM(
    'Earn 100,000 bonus points after you spend $5,000 on purchases in the first 3 months. $95 annual fee.',
    {},
    'fake-key',
    fetchImpl
  );
  assert.equal(result.success, true);
  assert.equal(result.offer.bonusAmount, 100000);
  assert.equal(result.offer.confidence, 'high');
  assert.equal(result.offer.extractionMethod, 'llm');
});

test('LLM parse with all nulls stays low confidence, so it still routes to NEEDS_REVIEW', async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      content: [
        {
          type: 'text',
          text: '{"bonusAmount": null, "bonusAmountMax": null, "isTargeted": false, "bonusUnit": null, "spendRequirement": null, "spendCurrency": null, "spendWindowDays": null, "annualFee": null}',
        },
      ],
    }),
  });

  const result = await extractOfferWithLLM(
    'This offer is very complex and we could not parse it.',
    {},
    'fake-key',
    fetchImpl
  );
  assert.equal(result.success, true);
  assert.equal(result.offer.bonusAmount, null);
  assert.equal(result.offer.confidence, 'low');
});

test('non-ok API response returns error, no offer', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 500,
    json: async () => ({}),
  });

  const result = await extractOfferWithLLM(
    'Earn 100,000 points.',
    {},
    'fake-key',
    fetchImpl
  );
  assert.equal(result.success, false);
  assert.equal(result.offer, null);
  assert.match(result.error, /http-/);
});

test('network error returns error, no offer', async () => {
  const fetchImpl = async () => {
    throw new Error('ECONNRESET');
  };

  const result = await extractOfferWithLLM(
    'Earn 100,000 points.',
    {},
    'fake-key',
    fetchImpl
  );
  assert.equal(result.success, false);
  assert.equal(result.offer, null);
  assert.equal(result.error, 'ECONNRESET');
});

test('response with no JSON in text returns error', async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      content: [{ type: 'text', text: 'This is just plain text, no JSON.' }],
    }),
  });

  const result = await extractOfferWithLLM('Earn 100,000 points.', {}, 'fake-key', fetchImpl);
  assert.equal(result.success, false);
  assert.equal(result.error, 'no-json-in-response');
});

test('LLM extracts targeted ceiling as bonusAmountMax + isTargeted', async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      content: [
        {
          type: 'text',
          text: '{"bonusAmount": null, "bonusAmountMax": 75000, "isTargeted": true, "bonusUnit": "points", "spendRequirement": 3000, "spendCurrency": "USD", "spendWindowDays": 90, "annualFee": 0}',
        },
      ],
    }),
  });

  const result = await extractOfferWithLLM(
    'Apply to see your personalized offer: earn up to 75,000 points after spending $3,000. No annual fee.',
    {},
    'fake-key',
    fetchImpl
  );
  assert.equal(result.success, true);
  assert.equal(result.offer.bonusAmount, null);
  assert.equal(result.offer.bonusAmountMax, 75000);
  assert.equal(result.offer.isTargeted, true);
});

test('LLM prompt is sent correctly to the API', async () => {
  let capturedRequest = null;
  const fetchImpl = async (url, opts) => {
    capturedRequest = { url, body: JSON.parse(opts.body) };
    return {
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: '{}' }] }),
    };
  };

  await extractOfferWithLLM('Earn 100,000 points.', {}, 'fake-key', fetchImpl);

  assert.equal(capturedRequest.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(capturedRequest.body.model, 'claude-sonnet-5');
  assert.match(capturedRequest.body.messages[0].content, /Earn 100,000 points/);
  assert.match(capturedRequest.body.messages[0].content, /bonusAmount/);
});
