// §5.3 — Diff & classification logic, the core requirement of the system.
//
// Compares the newly parsed offer object against the last stored parsed
// object for a source. Structured fields only — never raw text, never
// keyword scanning. Any single structured field changing is sufficient to
// flag CHANGED.

export const CLASSIFICATION = {
  NEW: 'NEW',
  CHANGED: 'CHANGED',
  DISCONTINUED: 'DISCONTINUED',
  NO_CHANGE: 'NO_CHANGE',
  NEEDS_REVIEW: 'NEEDS_REVIEW',
};

// The structured fields compared between scans. bonusAmount/bonusAmountMax
// cover fixed vs. targeted offers; bonusUnit and spendCurrency guard against
// a same-number/different-meaning swap (75,000 points → 75,000 miles,
// $5,000 → £5,000) reading as NO_CHANGE.
export const COMPARED_FIELDS = [
  'bonusAmount',
  'bonusAmountMax',
  'bonusUnit',
  'spendRequirement',
  'spendCurrency',
  'spendWindowDays',
  'annualFee',
];

function normalize(value) {
  return value === undefined ? null : value;
}

function pickFields(offer, fields) {
  const out = {};
  for (const f of fields) out[f] = normalize(offer?.[f]);
  return out;
}

/**
 * Classify one source's scan against its previous snapshot.
 *
 * @param {object} args
 * @param {string} args.sourceId
 * @param {{ rawOfferText?: string, parsedOffer: object|null } | null} args.previous
 *   The last stored snapshot for this source, or null if none exists.
 * @param {{ regionFound?: boolean, rawOfferText?: string, parsedOffer: object|null }} args.current
 *   The current scan result. `regionFound: false` means the configured offer
 *   selector matched nothing on the page.
 * @returns {{ sourceId, classification, changedFields, previous, current, creativeUrl, notes }}
 *   The run classification record of §6.
 */
export function diffOffer({ sourceId, previous, current }) {
  const record = {
    sourceId,
    classification: null,
    changedFields: [],
    previous: {},
    current: {},
    creativeUrl: null,
    notes: '',
  };

  // §10: selector stopped matching → the page structure likely changed.
  // Never let this fall through to NO_CHANGE or DISCONTINUED.
  if (current?.regionFound === false) {
    record.classification = CLASSIFICATION.NEEDS_REVIEW;
    record.notes =
      current.regionNote ??
      'Offer selector matched nothing on the page — selector may be stale (page redesign?). ' +
        'Not classified as NO_CHANGE or DISCONTINUED because nothing was actually compared.';
    return record;
  }

  const prevOffer = previous?.parsedOffer ?? null;
  const currOffer = current?.parsedOffer ?? null;

  // No previous snapshot exists for this source.
  if (!previous) {
    if (currOffer) {
      record.classification = CLASSIFICATION.NEW;
      record.current = pickFields(currOffer, COMPARED_FIELDS);
      record.notes = 'First time seen — no previous snapshot for this source.';
    } else {
      record.classification = CLASSIFICATION.NEEDS_REVIEW;
      record.notes = 'First scan of this source found no parsable offer in the offer region.';
    }
    return record;
  }

  // A parsable offer existed before but none is found now.
  if (prevOffer && !currOffer) {
    record.classification = CLASSIFICATION.DISCONTINUED;
    record.previous = pickFields(prevOffer, COMPARED_FIELDS);
    record.notes =
      'Offer region still present but no parsable offer found — offer appears discontinued.';
    return record;
  }

  // Previous scan had no parsable offer; one exists now.
  if (!prevOffer && currOffer) {
    record.classification = CLASSIFICATION.NEW;
    record.current = pickFields(currOffer, COMPARED_FIELDS);
    record.notes = 'Offer appeared on a source that previously had none.';
    return record;
  }

  // Neither scan found an offer — nothing to compare, nothing new.
  if (!prevOffer && !currOffer) {
    record.classification = CLASSIFICATION.NO_CHANGE;
    record.notes = 'No parsable offer on either scan.';
    return record;
  }

  const changedFields = COMPARED_FIELDS.filter(
    (f) => normalize(prevOffer[f]) !== normalize(currOffer[f])
  );
  record.changedFields = changedFields;
  record.previous = pickFields(prevOffer, changedFields);
  record.current = pickFields(currOffer, changedFields);

  // §5.3 last row: never silently classify when we aren't confident we
  // compared like-for-like values. This outranks both CHANGED and NO_CHANGE —
  // a "change" between two low-confidence parses is as suspect as a "match".
  if (prevOffer.confidence === 'low' || currOffer.confidence === 'low') {
    const side =
      prevOffer.confidence === 'low' && currOffer.confidence === 'low'
        ? 'both snapshots'
        : prevOffer.confidence === 'low'
          ? 'the previous snapshot'
          : 'the current scan';
    record.classification = CLASSIFICATION.NEEDS_REVIEW;
    record.notes = `Parser confidence is low on ${side} — cannot confirm a like-for-like comparison.`;
    return record;
  }

  record.classification = changedFields.length
    ? CLASSIFICATION.CHANGED
    : CLASSIFICATION.NO_CHANGE;
  return record;
}
