// §5.4 — Creative capture, conditional on the diff NOT being NO_CHANGE.
// Skipping this stage on NO_CHANGE is the main cost/efficiency lever of the
// whole pipeline; the pipeline only calls captureCreative for
// NEW/CHANGED/DISCONTINUED/NEEDS_REVIEW records.
//
// Finds the promotional banner image from three candidate sources named in
// the spec, dedupes them, and — only when more than one distinct candidate
// survives — defers to a vision model (src/vision.js) to pick the real
// banner over a nav logo or unrelated asset. A single unambiguous candidate
// skips the vision call entirely (§5.4: "where more than one candidate
// exists").
//
// Per §5.4's closing note, this only ever needs to resolve a URL — the
// dashboard already derives width/height/colors client-side on import — so
// this module never fetches image bytes, only markup already in hand.

import { locateOfferRegion } from './extract.js';
import { confirmCreativeCandidate as defaultVisionConfirm } from './vision.js';

// How much surrounding markup counts as "near" the offer region when hunting
// for the largest nearby image — approximates DOM proximity without a full
// parser, consistent with this project's zero-dependency, regex-based design.
const NEARBY_WINDOW_CHARS = 4000;

function resolveUrl(raw, pageUrl) {
  try {
    return new URL(raw, pageUrl).href;
  } catch {
    return raw;
  }
}

function findOgImage(html, pageUrl) {
  const metaRe = /<meta\b[^>]*>/gi;
  let m;
  while ((m = metaRe.exec(html)) !== null) {
    const tag = m[0];
    if (!/property=["']og:image["']/i.test(tag)) continue;
    const content = /content=["']([^"']+)["']/i.exec(tag);
    if (content) {
      return { url: resolveUrl(content[1], pageUrl), source: 'og:image', alt: '' };
    }
  }
  return null;
}

function parseImgTags(fragment, pageUrl) {
  const imgRe = /<img\b[^>]*>/gi;
  const out = [];
  let m;
  while ((m = imgRe.exec(fragment)) !== null) {
    const tag = m[0];
    const src = /\bsrc=["']([^"']+)["']/i.exec(tag);
    if (!src) continue;
    const width = /\bwidth=["']?(\d+)/i.exec(tag);
    const height = /\bheight=["']?(\d+)/i.exec(tag);
    const alt = /\balt=["']([^"']*)["']/i.exec(tag);
    out.push({
      url: resolveUrl(src[1], pageUrl),
      width: width ? Number(width[1]) : null,
      height: height ? Number(height[1]) : null,
      alt: alt ? alt[1] : '',
    });
  }
  return out;
}

function findLargestNearRegion(html, region, pageUrl) {
  if (!region.regionFound) return null;
  const start = Math.max(0, region.start - NEARBY_WINDOW_CHARS);
  const end = Math.min(html.length, region.end + NEARBY_WINDOW_CHARS);
  const imgs = parseImgTags(html.slice(start, end), pageUrl);
  if (!imgs.length) return null;

  const withDims = imgs.filter((i) => i.width && i.height);
  const chosen = withDims.length
    ? withDims.reduce((a, b) => (a.width * a.height >= b.width * b.height ? a : b))
    : imgs[0]; // no declared dimensions anywhere nearby — fall back to proximity order

  return { url: chosen.url, source: 'largest-near-offer', alt: chosen.alt };
}

function significantTokens(...names) {
  return names
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2); // drop short noise tokens ("it", "of")
}

function findAltMatch(html, pageUrl, issuer, product) {
  const tokens = significantTokens(issuer, product);
  if (!tokens.length) return null;
  for (const img of parseImgTags(html, pageUrl)) {
    const altLower = img.alt.toLowerCase();
    if (altLower && tokens.some((t) => altLower.includes(t))) {
      return { url: img.url, source: 'alt-text-match', alt: img.alt };
    }
  }
  return null;
}

// Multiple heuristics can point at the same image (e.g. og:image and the
// alt-matched image are often identical) — merge those into one candidate so
// an unambiguous page never triggers an unnecessary vision call.
function dedupe(candidates) {
  const byUrl = new Map();
  for (const c of candidates) {
    if (!c) continue;
    const existing = byUrl.get(c.url);
    if (existing) existing.source += `+${c.source}`;
    else byUrl.set(c.url, { ...c });
  }
  return [...byUrl.values()];
}

/**
 * @param {string} html
 * @param {object} args
 * @param {string} args.pageUrl        Used to resolve relative image URLs.
 * @param {string} args.offerSelector  Same selector used for offer extraction.
 * @param {string} [args.issuer]
 * @param {string} [args.product]
 * @param {Function} [args.visionConfirm]  Injectable for tests; defaults to src/vision.js.
 * @returns {Promise<{ creativeUrl: string|null, candidates: Array, method: string }>}
 */
export async function captureCreative(
  html,
  { pageUrl, offerSelector, issuer, product, visionConfirm = defaultVisionConfirm } = {}
) {
  // Sources in locate mode have no selector, so there is no region to search
  // around — og:image and alt-text matching still apply.
  const region = offerSelector
    ? locateOfferRegion(html, offerSelector)
    : { regionFound: false, start: -1, end: -1 };
  const candidates = dedupe([
    findOgImage(html, pageUrl),
    findLargestNearRegion(html, region, pageUrl),
    findAltMatch(html, pageUrl, issuer, product),
  ]);

  if (candidates.length === 0) {
    return { creativeUrl: null, candidates: [], method: 'none-found' };
  }
  if (candidates.length === 1) {
    return { creativeUrl: candidates[0].url, candidates, method: 'single-candidate' };
  }

  const confirmed = await visionConfirm({ candidates, issuer, product });
  return {
    creativeUrl: confirmed?.url ?? candidates[0].url,
    candidates,
    method: confirmed?.method ?? 'vision',
  };
}
