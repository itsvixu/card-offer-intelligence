// §5.4 / §7 vision confirmation — the heuristic fallback (no API key), and
// the real API call shape when a key is present, using an injected fetchImpl
// so this suite never touches the network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { confirmCreativeCandidate } from '../src/vision.js';

const candidates = [
  { url: 'https://x/logo.png', source: 'largest-near-offer', alt: '' },
  { url: 'https://x/og.png', source: 'og:image', alt: '' },
  { url: 'https://x/alt.png', source: 'alt-text-match', alt: 'Chase Sapphire' },
];

function unreachableFetch() {
  return async () => {
    throw new Error('fetch should not have been called without an API key');
  };
}

test('no API key → heuristic fallback, no network call attempted', async () => {
  const result = await confirmCreativeCandidate({
    candidates,
    apiKey: undefined,
    fetchImpl: unreachableFetch(),
  });
  assert.equal(result.method, 'heuristic-fallback');
  // og:image outranks alt-text-match and largest-near-offer in the fallback order.
  assert.equal(result.url, 'https://x/og.png');
});

test('heuristic fallback prefers alt-text-match over largest-near-offer when no og:image exists', async () => {
  const noOg = candidates.filter((c) => c.source !== 'og:image');
  const result = await confirmCreativeCandidate({ candidates: noOg, apiKey: undefined, fetchImpl: unreachableFetch() });
  assert.equal(result.url, 'https://x/alt.png');
});

test('with an API key, calls the Messages API and uses the returned index', async () => {
  let capturedBody = null;
  const fetchImpl = async (url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return {
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: '{"index": 2}' }] }),
    };
  };
  const result = await confirmCreativeCandidate({
    candidates,
    issuer: 'Chase',
    product: 'Sapphire',
    apiKey: 'fake-key-for-test',
    fetchImpl,
  });
  assert.equal(result.method, 'vision');
  assert.equal(result.url, 'https://x/alt.png');
  assert.equal(capturedBody.model, 'claude-sonnet-5');
  assert.equal(capturedBody.messages[0].content.length, 1 + candidates.length); // prompt + one image block per candidate
});

test('a non-ok API response falls back to the heuristic instead of throwing', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({}) });
  const result = await confirmCreativeCandidate({ candidates, apiKey: 'fake-key', fetchImpl });
  assert.equal(result.method, 'heuristic-fallback');
});

test('a network error falls back to the heuristic instead of throwing', async () => {
  const fetchImpl = async () => {
    throw new Error('ECONNRESET');
  };
  const result = await confirmCreativeCandidate({ candidates, apiKey: 'fake-key', fetchImpl });
  assert.equal(result.method, 'heuristic-fallback');
});

test('an out-of-range index from the model falls back to the heuristic', async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ content: [{ type: 'text', text: '{"index": 99}' }] }),
  });
  const result = await confirmCreativeCandidate({ candidates, apiKey: 'fake-key', fetchImpl });
  assert.equal(result.method, 'heuristic-fallback');
});
