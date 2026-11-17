// §9 — robots.txt rules.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPathAllowed, createRobotsChecker } from '../src/robots.js';

const ROBOTS = `
User-agent: *
Disallow: /account/
Disallow: /*.pdf$
Allow: /account/public

User-agent: CardOfferMonitor
Disallow: /secret
`;

test('our own group takes precedence over *', () => {
  assert.equal(isPathAllowed(ROBOTS, '/secret/page'), false);
  assert.equal(isPathAllowed(ROBOTS, '/account/settings'), true, '* rules do not apply when a specific group exists');
});

test('* group, longest match wins, wildcards and anchors', () => {
  const generic = ROBOTS.replace(/User-agent: CardOfferMonitor[\s\S]*/, '');
  assert.equal(isPathAllowed(generic, '/account/settings'), false);
  assert.equal(isPathAllowed(generic, '/account/public/x'), true);
  assert.equal(isPathAllowed(generic, '/terms.pdf'), false);
  assert.equal(isPathAllowed(generic, '/terms.pdf?v=2'), true);
  assert.equal(isPathAllowed(generic, '/credit-cards/gold'), true);
});

test('no robots.txt means no restriction, fetched once per origin', async () => {
  let calls = 0;
  const check = createRobotsChecker({ fetchImpl: async () => (calls++, { ok: false, status: 404 }) });
  assert.equal(await check('https://bank.example/cards/a'), true);
  assert.equal(await check('https://bank.example/cards/b'), true);
  assert.equal(calls, 1);
  assert.equal(await check('file:///tmp/x.html'), true);
});

test('a disallowed source is reported as a failure, never fetched', async () => {
  const { runScan } = await import('../src/pipeline.js');
  const { SnapshotStore } = await import('../src/store.js');
  const store = new SnapshotStore(':memory:');
  let fetched = false;
  const result = await runScan({
    sources: [{ sourceId: 'x', url: 'https://bank.example/secret' }],
    store,
    isAllowed: async () => false,
    fetchPage: async () => ((fetched = true), { ok: true, html: '' }),
    delayMs: 0,
  });
  assert.equal(fetched, false);
  assert.equal(result.failures[0].stage, 'robots');
  store.close();
});
