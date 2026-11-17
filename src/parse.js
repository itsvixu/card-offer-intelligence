// §5.2 — Structured offer extraction: regex pass first, then optional LLM
// fallback for low-confidence results.
//
// The regex pass is deterministic and always runs. When it produces
// confidence: "low" (non-standard offer or ambiguous patterns), the LLM
// fallback (src/llm-extract.js) is invoked — but only if an
// ANTHROPIC_API_KEY is available, and its answer is only accepted when it
// actually found a bonus and a spend requirement. Anything still unresolved
// stays confidence: "low" so the diff engine routes it to NEEDS_REVIEW
// instead of silently classifying NO_CHANGE (§5.3, last row).

import { extractOfferWithLLM as defaultLLMExtract } from './llm-extract.js';

const CURRENCIES = { $: 'USD', '£': 'GBP', '€': 'EUR' };

// Up to two brand/filler words between the amount and the unit, e.g.
// "60,000 Membership Rewards® points", "100,000 bonus points".
const FILLER = '(?:\\s+[\\w®™]+){0,2}?';
const POINT_UNITS = '(points?|miles?|avios)\\b';
// "75,000" or the headline shorthand "75K".
const AMOUNT = '(\\d[\\d,]*K?)';

// Exported so the selector-free locator (src/locate.js) finds candidates with
// exactly the same patterns the parser will then read values from.
export const PATTERNS = {
  // "up to 60,000 Avios" / "as high as 100,000 points" — a ceiling, not a
  // guaranteed amount (§5.2).
  targetedBonus: new RegExp(
    `(?:up\\s+to|as\\s+high\\s+as)\\s+${AMOUNT}${FILLER}\\s+${POINT_UNITS}`,
    'i'
  ),
  // Negative lookbehind blocks currency-prefixed and partial numbers so
  // "$5,000 ... points" spend copy can't be misread as a bonus amount.
  fixedBonus: new RegExp(`(?<![$£€\\d.,])${AMOUNT}${FILLER}\\s+${POINT_UNITS}`, 'i'),
  percentCashBack: /(\d+(?:\.\d+)?)\s*%\s*cash\s?back/i,
  // "$200 cash back", "$200 bonus", "$100 cash rewards bonus",
  // "$200 bonus statement credit" — a currency-denominated welcome bonus.
  cashBonus:
    /([$£€])\s?(\d[\d,]*)\s+(?:cash\s?back|(?:cash\s+rewards\s+|cash\s+|welcome\s+)?bonus|statement\s+credit)\b/i,
  spend: [
    // Tolerates a footnote marker glued to the verb ("when you spend1 £2,000").
    /(?:spend|spending)[\d†‡*]?\s+([$£€])\s?(\d[\d,]*)/i,
    /([$£€])\s?(\d[\d,]*)\s+(?:in|on|of)\s+(?:eligible\s+|qualifying\s+|net\s+)?(?:purchases|spend)/i,
  ],
  spendWindow: [
    /first\s+(\d+)\s*(day|week|month)s?/i,
    /within\s+(\d+)\s*(day|week|month)s?/i,
  ],
  noAnnualFee: /(?:no|[$£€]\s?0)\s+annual\s+fee/i,
  annualFee: [
    /([$£€])\s?(\d[\d,]*)\s+annual\s+fee/i,
    // Tolerates a footnote marker glued to "fee" ("Annual Fee1 $95").
    /annual\s+fee[\d†‡*¹²³]{0,2}(?:\s+of)?[:\s]+([$£€])\s?(\d[\d,]*)/i,
  ],
  // Non-standard offers regex can detect but not quantify — e.g. Discover's
  // Cashback Match. Kept as an offer with confidence "low" (never dropped,
  // never treated as parsed-with-confidence).
  nonStandard: /cash\s?back\s+match/i,
};

const WINDOW_UNIT_DAYS = { day: 1, week: 7, month: 30 };

const NUMBER_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};
const NUMBER_WORD_RE = new RegExp(
  `\\b(${Object.keys(NUMBER_WORDS).join('|')})\\b(?=\\s+(?:day|week|month))`,
  'gi'
);

function toNumber(raw) {
  const cleaned = raw.replace(/,/g, '');
  return /k$/i.test(cleaned)
    ? Number.parseInt(cleaned, 10) * 1000
    : Number.parseInt(cleaned, 10);
}

function normalizeUnit(raw) {
  let unit = raw.toLowerCase();
  if (!unit.endsWith('s')) unit += 's';
  return unit; // point/points → points, mile/miles → miles, avios → avios
}

function firstMatch(patterns, text) {
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) return m;
  }
  return null;
}

/**
 * The deterministic regex pass. Returns null when the text contains no
 * recognizable offer at all (the DISCONTINUED signal), as opposed to a
 * low-confidence partial parse.
 */
export function parseOfferRegex(rawOfferText) {
  // "first three months" → "first 3 months"
  const text = (rawOfferText ?? '').replace(NUMBER_WORD_RE, (w) => NUMBER_WORDS[w.toLowerCase()]);

  const offer = {
    bonusAmount: null,
    bonusAmountMax: null,
    isTargeted: false,
    bonusUnit: null,
    spendRequirement: null,
    spendCurrency: null,
    spendWindowDays: null,
    annualFee: null,
    confidence: null,
    extractionMethod: 'regex',
  };

  const nonStandard = PATTERNS.nonStandard.test(text);

  const targeted = PATTERNS.targetedBonus.exec(text);
  if (targeted) {
    offer.bonusAmountMax = toNumber(targeted[1]);
    offer.isTargeted = true;
    offer.bonusUnit = normalizeUnit(targeted[2]);
  } else {
    const fixed = PATTERNS.fixedBonus.exec(text);
    if (fixed) {
      offer.bonusAmount = toNumber(fixed[1]);
      offer.bonusUnit = normalizeUnit(fixed[2]);
    } else {
      // A currency bonus ("$200 bonus") outranks a percentage, which on a
      // card page is usually the everyday earn rate, not the welcome offer.
      const cash = PATTERNS.cashBonus.exec(text);
      const percent = PATTERNS.percentCashBack.exec(text);
      if (cash) {
        offer.bonusAmount = toNumber(cash[2]);
        offer.bonusUnit = 'cash';
      } else if (percent) {
        offer.bonusAmount = Number.parseFloat(percent[1]);
        offer.bonusUnit = 'percent-cashback';
      }
    }
  }

  const spend = firstMatch(PATTERNS.spend, text);
  if (spend) {
    offer.spendCurrency = CURRENCIES[spend[1]];
    offer.spendRequirement = toNumber(spend[2]);
  }

  const window = firstMatch(PATTERNS.spendWindow, text);
  if (window) {
    offer.spendWindowDays = toNumber(window[1]) * WINDOW_UNIT_DAYS[window[2].toLowerCase()];
  }

  if (PATTERNS.noAnnualFee.test(text)) {
    offer.annualFee = 0;
  } else {
    const fee = firstMatch(PATTERNS.annualFee, text);
    if (fee) offer.annualFee = toNumber(fee[2]);
  }

  const hasBonus = offer.bonusAmount !== null || offer.bonusAmountMax !== null;

  // No bonus, no spend requirement, no non-standard signal → no offer here.
  // (An annual fee alone is card boilerplate, not an offer.)
  if (!hasBonus && offer.spendRequirement === null && !nonStandard) {
    return null;
  }

  offer.confidence =
    !nonStandard && hasBonus && offer.spendRequirement !== null && offer.spendWindowDays !== null
      ? 'high'
      : 'low';

  return offer;
}

/**
 * Parse raw offer text into the normalized offer object of §6.
 *
 * @param {string} rawOfferText
 * @param {object} [opts]
 * @param {string} [opts.apiKey]       For LLM fallback; defaults to process.env.ANTHROPIC_API_KEY
 * @param {Function} [opts.llmExtract] Injectable LLM extractor for tests; defaults to src/llm-extract.js
 * @returns {Promise<object|null>}
 */
export async function parseOfferText(rawOfferText, opts = {}) {
  const { apiKey = process.env.ANTHROPIC_API_KEY, llmExtract = defaultLLMExtract } = opts;

  const offer = parseOfferRegex(rawOfferText);
  if (!offer) return null;

  // §5.2: if confidence is low and we have an API key, try the LLM fallback.
  // Its answer replaces the regex result only when it found a real offer —
  // an "I couldn't parse this either" reply must never upgrade confidence.
  if (offer.confidence === 'low' && apiKey) {
    const llmResult = await llmExtract(rawOfferText, offer, apiKey);
    if (llmResult.success && llmResult.offer?.confidence === 'high') {
      return llmResult.offer;
    }
  }

  return offer;
}
