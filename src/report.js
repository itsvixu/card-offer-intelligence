// §5.5 — The emailed run report.
//
// Written for the marketing and design team, not for the pipeline: every
// change is stated in plain language ("Welcome bonus raised from 75,000 to
// 100,000 points") with the page's own wording quoted underneath. Screenshots
// and history live in the dashboard, which reads the same store directly, so
// nothing has to be copied from this report into anything else.

import { CLASSIFICATION } from './diff-engine.js';
import { summarizeOffer } from './describe.js';

function label(record) {
  return [record.issuer, record.product].filter(Boolean).join(' ') || record.sourceId;
}

function byClass(records, ...classes) {
  return records.filter((r) => classes.includes(r.classification));
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** One sentence describing the run, used as the report's opening line. */
export function summarizeRun({ records, failures, counts }) {
  const total = records.length + failures.length;
  const parts = [];
  if (counts.CHANGED) parts.push(plural(counts.CHANGED, 'offer change'));
  if (counts.DISCONTINUED) parts.push(plural(counts.DISCONTINUED, 'withdrawn offer'));
  if (counts.NEW) parts.push(plural(counts.NEW, 'card') + ' newly tracked');
  const headline = parts.length ? parts.join(', ') : 'No offer changes';
  const caveats = [];
  if (counts.NEEDS_REVIEW) caveats.push(`${counts.NEEDS_REVIEW} need a look`);
  if (counts.FAILED) caveats.push(`${counts.FAILED} could not be scanned`);
  return `${headline} across ${plural(total, 'card page')}${caveats.length ? ` (${caveats.join(', ')})` : ''}.`;
}

export function buildRunReport(result) {
  const { startedAt, records, failures } = result;
  const lines = [];
  const push = (s = '') => lines.push(s);

  push(`# Card offer scan — ${startedAt.slice(0, 10)}`);
  push('');
  push(summarizeRun(result));

  const changed = byClass(records, CLASSIFICATION.CHANGED, CLASSIFICATION.DISCONTINUED);
  if (changed.length) {
    push('');
    push('## What changed');
    for (const r of changed) {
      push('');
      push(`**${label(r)}** — ${r.headline}`);
      if (r.rawOfferText) push(`> ${r.rawOfferText}`);
      if (r.url) push(`Source: ${r.url}`);
    }
  }

  const fresh = byClass(records, CLASSIFICATION.NEW);
  if (fresh.length) {
    push('');
    push('## Newly tracked');
    push('');
    for (const r of fresh) push(`- **${label(r)}** — ${summarizeOffer(r.offer, r.market)}`);
  }

  const review = byClass(records, CLASSIFICATION.NEEDS_REVIEW);
  if (review.length) {
    push('');
    push('## Needs a look');
    push('');
    push('These could not be compared with confidence, so they are not reported as changed or unchanged.');
    push('');
    for (const r of review) push(`- **${label(r)}** — ${r.notes}${r.url ? ` (${r.url})` : ''}`);
  }

  if (failures.length) {
    push('');
    push('## Could not be scanned');
    push('');
    for (const f of failures) {
      push(`- **${[f.issuer, f.product].filter(Boolean).join(' ') || f.sourceId}** — ${f.error}`);
    }
  }

  const unchanged = byClass(records, CLASSIFICATION.NO_CHANGE);
  if (unchanged.length) {
    push('');
    push(`Unchanged: ${unchanged.map(label).join(', ')}.`);
  }

  push('');
  push('Screenshots and each card\'s history are in the dashboard (`npm run dashboard`).');
  push('');
  return lines.join('\n');
}

function toItem(r) {
  return {
    sourceId: r.sourceId,
    issuer: r.issuer ?? null,
    product: r.product ?? null,
    market: r.market ?? null,
    classification: r.classification,
    headline: r.headline ?? null,
    changedFields: r.changedFields,
    previous: r.previous,
    current: r.current,
    offer: r.offer ?? null,
    rawOfferText: r.rawOfferText ?? null,
    capturePath: r.capturePath ?? null,
    notes: r.notes,
  };
}

/** The same run as structured JSON, uploaded as a CI artifact. */
export function buildRunReportJson(result) {
  const { startedAt, finishedAt, records, failures, counts } = result;
  return {
    timestamp: finishedAt,
    startedAt,
    summaryText: summarizeRun(result),
    summary: {
      totalScanned: records.length + failures.length,
      new: counts.NEW,
      changed: counts.CHANGED,
      discontinued: counts.DISCONTINUED,
      unchanged: counts.NO_CHANGE,
      needsReview: counts.NEEDS_REVIEW,
      failed: counts.FAILED,
    },
    flagged: byClass(
      records,
      CLASSIFICATION.NEW,
      CLASSIFICATION.CHANGED,
      CLASSIFICATION.DISCONTINUED
    ).map(toItem),
    needsReviewItems: byClass(records, CLASSIFICATION.NEEDS_REVIEW).map(toItem),
    errors: failures.map((f) => ({ sourceId: f.sourceId, stage: f.stage, error: f.error })),
  };
}
