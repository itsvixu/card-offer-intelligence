// Pipeline glue for stages 2–3 of §4: fetched page → offer text → parsed
// offer object.
//
// Two ways to find the offer text:
//   - selector mode: the source config names an `offerSelector`, and the offer
//     is read from that region of the HTML (an explicit override);
//   - locate mode (default): no selector — the first complete bonus + spend
//     statement in the page's reading order is the offer (src/locate.js).

import { extractOfferRegion, htmlToText } from './extract.js';
import { locateOffer } from './locate.js';
import { parseOfferText } from './parse.js';

// With no selector there is no "selector matched nothing" signal, so a page
// with no offer needs another way to tell "the offer was withdrawn" from "this
// is not the card page any more" (a bot wall, a redirect to the homepage). If
// the page no longer even names the product, nothing was really compared.
function pageNamesProduct(pageText, product) {
  if (!product) return pageText.length > 500;
  const tokens = product.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2);
  if (!tokens.length) return pageText.length > 500;
  const haystack = pageText.toLowerCase();
  return tokens.some((t) => haystack.includes(t));
}

/**
 * Scan a fetched page for a source's offer.
 * @param {string} html
 * @param {string|null|undefined} offerSelector  Omit for locate mode.
 * @param {object} [opts]
 * @param {string} [opts.scanTimestamp]
 * @param {string} [opts.text]     Rendered visible text (innerText), when the page came from a browser.
 * @param {string} [opts.product]  Product name, used by locate mode's sanity check.
 * @param {string} [opts.apiKey]   For LLM fallback; defaults to process.env.ANTHROPIC_API_KEY
 * @returns {Promise<{ regionFound: boolean, rawOfferText: string|null, parsedOffer: object|null, scanTimestamp: string|null }>}
 */
export async function scanHtml(
  html,
  offerSelector,
  { scanTimestamp = null, apiKey = undefined, text = undefined, product = undefined } = {}
) {
  if (offerSelector) {
    const { regionFound, rawOfferText } = extractOfferRegion(html, offerSelector);
    return {
      regionFound,
      rawOfferText,
      parsedOffer: regionFound ? await parseOfferText(rawOfferText, { apiKey }) : null,
      scanTimestamp,
    };
  }

  const pageText = text ?? htmlToText(html ?? '');
  const located = locateOffer(pageText);
  if (!located) {
    const regionFound = pageNamesProduct(pageText, product);
    return {
      regionFound,
      regionNote: regionFound
        ? undefined
        : 'The page no longer mentions this card, so it may be a block page or a redirect. ' +
          'Not classified as NO_CHANGE or DISCONTINUED because nothing was actually compared.',
      rawOfferText: null,
      parsedOffer: null,
      scanTimestamp,
    };
  }
  return {
    regionFound: true,
    rawOfferText: located.rawOfferText,
    parsedOffer: await parseOfferText(located.rawOfferText, { apiKey }),
    otherOfferCount: located.otherOfferCount,
    scanTimestamp,
  };
}
