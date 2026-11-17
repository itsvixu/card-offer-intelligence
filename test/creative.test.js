// §5.4 creative capture — candidate extraction (og:image, largest-near-offer,
// alt-text match), dedupe, and the vision-call gate (only when >1 candidate
// survives). visionConfirm is injected in every test so nothing here ever
// touches the network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureCreative } from '../src/creative.js';

const PAGE_URL = 'https://creditcards.chase.com/rewards-credit-cards/sapphire/preferred';

function failIfCalled() {
  return async () => {
    throw new Error('visionConfirm should not have been called');
  };
}

test('og:image alone is the single candidate — no vision call needed', async () => {
  const html = `
    <head><meta property="og:image" content="/assets/csp-banner.png" /></head>
    <body><div class="welcome-offer-copy">Earn 100,000 points.</div></body>
  `;
  const result = await captureCreative(html, {
    pageUrl: PAGE_URL,
    offerSelector: '.welcome-offer-copy',
    visionConfirm: failIfCalled(),
  });
  assert.equal(result.method, 'single-candidate');
  assert.equal(result.creativeUrl, 'https://creditcards.chase.com/assets/csp-banner.png');
});

test('largest image near the offer region is chosen over a smaller nearby image', async () => {
  const html = `
    <body>
      <img src="/nav-logo.png" width="24" height="24" alt="logo" />
      <section class="hero">
        <img src="/csp-card-art.png" width="800" height="500" alt="card art" />
        <div class="welcome-offer-copy">Earn 100,000 points.</div>
      </section>
    </body>
  `;
  const result = await captureCreative(html, {
    pageUrl: PAGE_URL,
    offerSelector: '.welcome-offer-copy',
    visionConfirm: failIfCalled(),
  });
  // Both images are within the proximity window here; size must break the tie.
  assert.equal(result.creativeUrl, 'https://creditcards.chase.com/csp-card-art.png');
});

test('alt-text matching the issuer/product name is found as a candidate', async () => {
  const html = `
    <body>
      <img src="/promo.png" alt="Chase Sapphire Preferred card art" />
      <div class="welcome-offer-copy">Earn 100,000 points.</div>
    </body>
  `;
  const result = await captureCreative(html, {
    pageUrl: PAGE_URL,
    offerSelector: '.welcome-offer-copy',
    issuer: 'Chase',
    product: 'Sapphire Preferred',
    visionConfirm: failIfCalled(),
  });
  assert.equal(result.method, 'single-candidate');
  assert.equal(result.creativeUrl, 'https://creditcards.chase.com/promo.png');
});

test('same image found by multiple heuristics dedupes to one candidate (no vision call)', async () => {
  const html = `
    <head><meta property="og:image" content="/csp-banner.png" /></head>
    <body>
      <img src="/csp-banner.png" width="800" height="500" alt="Chase Sapphire Preferred" />
      <div class="welcome-offer-copy">Earn 100,000 points.</div>
    </body>
  `;
  const result = await captureCreative(html, {
    pageUrl: PAGE_URL,
    offerSelector: '.welcome-offer-copy',
    issuer: 'Chase',
    product: 'Sapphire Preferred',
    visionConfirm: failIfCalled(),
  });
  assert.equal(result.method, 'single-candidate');
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].source, 'og:image+largest-near-offer+alt-text-match');
});

test('two genuinely distinct candidates trigger the vision call, which picks the banner', async () => {
  // og:image points at the site's generic social-share logo; the real promo
  // banner sits right next to the offer copy and matches by both position
  // and alt text (so it dedupes to one candidate) — leaving two DISTINCT
  // candidates overall, which is what should force a vision call.
  const html = `
    <head><meta property="og:image" content="/site-logo.png" /></head>
    <body>
      <section class="hero">
        <img src="/csp-real-banner.png" width="400" height="200" alt="Chase Sapphire Preferred" />
        <div class="welcome-offer-copy">Earn 100,000 points.</div>
      </section>
    </body>
  `;
  let calledWith = null;
  const result = await captureCreative(html, {
    pageUrl: PAGE_URL,
    offerSelector: '.welcome-offer-copy',
    issuer: 'Chase',
    product: 'Sapphire Preferred',
    visionConfirm: async ({ candidates }) => {
      calledWith = candidates;
      const banner = candidates.find((c) => c.url.includes('real-banner'));
      return { url: banner.url, method: 'vision' };
    },
  });
  assert.equal(calledWith.length, 2, 'vision should see both distinct candidates');
  assert.equal(result.method, 'vision');
  assert.equal(result.creativeUrl, 'https://creditcards.chase.com/csp-real-banner.png');
});

test('no candidates found anywhere on the page → creativeUrl null, no crash', async () => {
  const html = `<body><div class="welcome-offer-copy">Earn 100,000 points.</div></body>`;
  const result = await captureCreative(html, {
    pageUrl: PAGE_URL,
    offerSelector: '.welcome-offer-copy',
    visionConfirm: failIfCalled(),
  });
  assert.equal(result.creativeUrl, null);
  assert.equal(result.method, 'none-found');
  assert.deepEqual(result.candidates, []);
});

test('a broken selector (region not found) still allows og:image / alt-text candidates', async () => {
  const html = `
    <head><meta property="og:image" content="/csp-banner.png" /></head>
    <body><div class="renamed-offer-container">Earn 100,000 points.</div></body>
  `;
  const result = await captureCreative(html, {
    pageUrl: PAGE_URL,
    offerSelector: '.welcome-offer-copy', // stale — won't match .renamed-offer-container
    visionConfirm: failIfCalled(),
  });
  assert.equal(result.creativeUrl, 'https://creditcards.chase.com/csp-banner.png');
});

test('relative image URLs resolve against the page URL', async () => {
  const html = `<head><meta property="og:image" content="../shared/banner.png" /></head><body></body>`;
  const result = await captureCreative(html, {
    pageUrl: 'https://example.com/cards/gold/index.html',
    offerSelector: '.welcome-offer-copy',
    visionConfirm: failIfCalled(),
  });
  // base is /cards/gold/index.html → its directory is /cards/gold/ → ".." steps
  // up to /cards/, so the resolved path is /cards/shared/banner.png.
  assert.equal(result.creativeUrl, 'https://example.com/cards/shared/banner.png');
});
