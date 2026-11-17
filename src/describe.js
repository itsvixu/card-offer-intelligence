// Plain-language descriptions of offers and changes.
//
// The diff engine speaks in field names (`bonusAmount: 75000 → 100000`). The
// people reading the report and the dashboard are marketers and designers, so
// every change is also described the way they would say it: "Welcome bonus
// raised from 75,000 to 100,000 points". One module, so the email and the
// dashboard always use the same words.

const CURRENCY_SYMBOL = { USD: '$', GBP: '£', EUR: '€' };
const MARKET_CURRENCY = { us: 'USD', eu: 'GBP', uk: 'GBP' };

const num = (n) => Number(n).toLocaleString('en-US');

function currencyFor(offer, market) {
  return offer?.spendCurrency ?? MARKET_CURRENCY[(market || '').toLowerCase()] ?? 'USD';
}

export function money(amount, currency = 'USD') {
  return `${CURRENCY_SYMBOL[currency] ?? ''}${num(amount)}`;
}

export function formatWindow(days) {
  if (days == null) return null;
  if (days % 30 === 0) {
    const months = days / 30;
    return `${months} month${months === 1 ? '' : 's'}`;
  }
  return `${days} days`;
}

/** "75,000 points", "up to 100,000 Avios", "$200 cash". */
export function formatBonus(offer, market) {
  if (!offer) return null;
  const amount = offer.bonusAmount ?? offer.bonusAmountMax;
  if (amount == null) return null;
  const prefix = offer.bonusAmount == null ? 'up to ' : '';
  if (offer.bonusUnit === 'cash') return `${prefix}${money(amount, currencyFor(offer, market))} cash`;
  if (offer.bonusUnit === 'percent-cashback') return `${prefix}${amount}% cash back`;
  const unit = offer.bonusUnit === 'avios' ? 'Avios' : offer.bonusUnit ?? 'points';
  return `${prefix}${num(amount)} ${unit}`;
}

export function formatFee(offer, market) {
  if (offer?.annualFee == null) return null;
  return offer.annualFee === 0 ? 'No annual fee' : `${money(offer.annualFee, currencyFor(offer, market))} annual fee`;
}

/** One line: "75,000 points after $5,000 spend in 3 months · $95 annual fee". */
export function summarizeOffer(offer, market) {
  if (!offer) return 'No welcome offer on the page';
  const bonus = formatBonus(offer, market);
  const parts = [];
  if (bonus) {
    let line = bonus;
    if (offer.spendRequirement != null) {
      line += ` after ${money(offer.spendRequirement, currencyFor(offer, market))} spend`;
      const window = formatWindow(offer.spendWindowDays);
      if (window) line += ` in ${window}`;
    }
    parts.push(line);
  }
  const fee = formatFee(offer, market);
  if (fee) parts.push(fee);
  return parts.join(' · ') || 'Offer on the page could not be read with confidence';
}

function direction(before, after, up, down) {
  return after > before ? up : down;
}

function describeField(field, prev, curr, market) {
  const before = prev?.[field];
  const after = curr?.[field];
  const currency = currencyFor(curr ?? prev, market);
  const unit = (o) => (o?.bonusUnit === 'avios' ? 'Avios' : o?.bonusUnit === 'cash' ? '' : o?.bonusUnit ?? 'points');
  const bonusValue = (o, v) =>
    o?.bonusUnit === 'cash' ? money(v, currencyFor(o, market)) : num(v);

  switch (field) {
    case 'bonusAmount':
    case 'bonusAmountMax': {
      const label = field === 'bonusAmountMax' ? 'Targeted bonus ceiling' : 'Welcome bonus';
      if (before == null && after != null) {
        return field === 'bonusAmountMax'
          ? `Bonus is now targeted, up to ${bonusValue(curr, after)} ${unit(curr)}`.trim()
          : `${label} is now a fixed ${bonusValue(curr, after)} ${unit(curr)}`.trim();
      }
      if (after == null) return null; // the paired field carries the story
      return `${label} ${direction(before, after, 'raised', 'cut')} from ${bonusValue(prev, before)} to ${bonusValue(curr, after)} ${unit(curr)}`.trim();
    }
    case 'bonusUnit':
      return before && after ? `Bonus now paid in ${after} (was ${before})` : null;
    case 'spendRequirement':
      if (before == null) return `Spend requirement added: ${money(after, currency)}`;
      if (after == null) return 'Spend requirement removed';
      return `Spend requirement ${direction(before, after, 'raised', 'lowered')} from ${money(before, currencyFor(prev, market))} to ${money(after, currency)}`;
    case 'spendCurrency':
      return before && after ? `Spend currency changed from ${before} to ${after}` : null;
    case 'spendWindowDays':
      if (before == null || after == null) return null;
      return `Time to earn ${direction(before, after, 'extended', 'shortened')} from ${formatWindow(before)} to ${formatWindow(after)}`;
    case 'annualFee':
      if (before == null) return `Annual fee now shown: ${after === 0 ? 'none' : money(after, currency)}`;
      if (after == null) return 'Annual fee no longer shown';
      if (after === 0) return `Annual fee dropped from ${money(before, currency)} to none`;
      return `Annual fee ${direction(before, after, 'raised', 'cut')} from ${money(before, currency)} to ${money(after, currency)}`;
    default:
      return null;
  }
}

/**
 * A headline for one classification record.
 * @param {object} record  diffOffer's record, with `offer` / `previousOffer`
 *   (the full parsed offers) and `market` attached by the pipeline.
 */
export function describeChange(record) {
  const { classification, changedFields = [], offer, previousOffer, market } = record;
  switch (classification) {
    case 'NEW':
      return `Now tracking: ${summarizeOffer(offer, market)}`;
    case 'DISCONTINUED':
      return `Welcome offer withdrawn (was ${summarizeOffer(previousOffer, market)})`;
    case 'CHANGED': {
      const lines = changedFields
        .map((f) => describeField(f, previousOffer, offer, market))
        .filter(Boolean);
      return lines.length ? lines.join('; ') : 'Offer terms changed';
    }
    case 'NEEDS_REVIEW':
      return 'Could not be compared with confidence';
    default:
      return 'No change';
  }
}

/** Per-field sentences, for places that list changes one per line. */
export function describeChangedFields(record) {
  return (record.changedFields ?? [])
    .map((f) => ({ field: f, text: describeField(f, record.previousOffer, record.offer, record.market) }))
    .filter((x) => x.text);
}

/**
 * The four facts people compare, as display text, for one or two offers.
 * `changed` marks rows whose text differs between the two.
 */
export function factRows(previousOffer, offer, market) {
  const facts = (o) =>
    o
      ? {
          bonus: formatBonus(o, market),
          spend: o.spendRequirement != null ? money(o.spendRequirement, currencyFor(o, market)) : null,
          window: formatWindow(o.spendWindowDays),
          fee: o.annualFee == null ? null : o.annualFee === 0 ? 'None' : money(o.annualFee, currencyFor(o, market)),
        }
      : { bonus: null, spend: null, window: null, fee: null };
  const before = facts(previousOffer);
  const after = facts(offer);
  const labels = { bonus: 'Welcome bonus', spend: 'Spend required', window: 'Time to earn', fee: 'Annual fee' };
  const raw = (o) =>
    o
      ? {
          bonus: o.bonusAmount ?? o.bonusAmountMax,
          spend: o.spendRequirement,
          window: o.spendWindowDays,
          fee: o.annualFee,
        }
      : {};
  const rawBefore = raw(previousOffer);
  const rawAfter = raw(offer);
  return Object.keys(labels).map((key) => {
    const changed = Boolean(previousOffer) && before[key] !== after[key];
    const comparable = changed && rawBefore[key] != null && rawAfter[key] != null;
    return {
      key,
      label: labels[key],
      before: before[key],
      after: after[key],
      changed,
      direction: comparable ? (rawAfter[key] > rawBefore[key] ? 'up' : 'down') : null,
    };
  });
}
