// Selector-free offer location.
//
// The original design needed a hand-written CSS selector per source, which
// breaks on every redesign and has to be discovered by a person. Rendered
// issuer pages turn out to share a much more durable property: read top to
// bottom, the first statement that pairs a welcome bonus with a spend
// requirement is the card's own offer. Later ones are cross-sells for sibling
// cards ("You might also like…") and footnote restatements.
//
// So: take the page's visible text in reading order, find the first complete
// bonus + spend statement, and hand just that snippet (plus the nearest
// annual-fee phrase) to the parser. A selector remains available as an
// override for any page where this rule picks the wrong statement.

import { PATTERNS } from './parse.js';

const SPEND_WITHIN_CHARS = 200; // a spend requirement this close belongs to the bonus
const FEE_LOOKAHEAD_CHARS = 3000;
const FEE_LOOKBEHIND_CHARS = 400;
const MAX_SNIPPET_CHARS = 340;

function globalize(re) {
  return new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
}

const BONUS_RES = [PATTERNS.targetedBonus, PATTERNS.fixedBonus, PATTERNS.cashBonus].map(globalize);
const FEE_RES = [PATTERNS.noAnnualFee, ...PATTERNS.annualFee].map(globalize);

function firstSpendWithin(text) {
  let best = null;
  for (const re of PATTERNS.spend) {
    const m = re.exec(text);
    if (m && (best === null || m.index < best.index)) best = m;
  }
  return best;
}

function allMatches(regexes, text) {
  const out = [];
  for (const re of regexes) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      out.push({ index: m.index, end: m.index + m[0].length, text: m[0] });
      if (m[0].length === 0) re.lastIndex++;
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

/**
 * @param {string} pageText  Visible page text in reading order (innerText).
 * @returns {{ rawOfferText: string, complete: boolean, otherOfferCount: number } | null}
 *   null when the page contains no bonus statement at all.
 */
export function locateOffer(pageText) {
  const lines = (pageText ?? '')
    .split('\n')
    // Drop screen-reader labels for superscript footnotes ("Footnote link 1"),
    // which otherwise land in the middle of the offer sentence.
    .map((l) => l.replace(/\bfootnote\s+link\s+\d+\b/gi, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (!lines.length) return null;

  // Flatten to one string, remembering where each line starts — headings on
  // rendered pages rarely end in punctuation, so line starts are the natural
  // statement boundaries.
  const lineStarts = [];
  let flat = '';
  for (const line of lines) {
    lineStarts.push(flat.length);
    flat += line + ' ';
  }

  const bonuses = allMatches(BONUS_RES, flat);
  const candidates = [];
  for (const bonus of bonuses) {
    const after = flat.slice(bonus.end, bonus.end + SPEND_WITHIN_CHARS);
    const spend = firstSpendWithin(after);
    candidates.push({
      bonus,
      spendEnd: spend ? bonus.end + spend.index + spend[0].length : null,
    });
  }

  const complete = candidates.filter((c) => c.spendEnd !== null);
  const nonStandard = PATTERNS.nonStandard.exec(flat);
  // Several bonus mentions can lead into the same spend requirement (a
  // headline, then the full sentence). Take the first spend requirement on
  // the page and the bonus mention nearest to it.
  const chosen = complete.length
    ? complete.filter((c) => c.spendEnd === complete[0].spendEnd).pop()
    : null;

  const lineStartOf = (index) => lineStarts.filter((s) => s <= index).pop() ?? 0;
  const lineEndOf = (index) => {
    const next = lineStarts.find((s) => s > index);
    return next === undefined ? flat.length : next;
  };

  let snippet;
  let start;
  if (chosen) {
    start = lineStartOf(chosen.bonus.index);
    // A long paragraph line: start at the sentence that holds the bonus.
    if (chosen.bonus.index - start > 160) {
      const before = flat.slice(start, chosen.bonus.index);
      const boundary = Math.max(before.lastIndexOf('. '), before.lastIndexOf('! '), before.lastIndexOf(': '));
      start = boundary === -1 ? chosen.bonus.index - 60 : start + boundary + 2;
    }
    // End with the line that holds the spend amount; if the time window
    // ("in the first 3 months") sits on the following line, take that too.
    let end = lineEndOf(chosen.spendEnd);
    const hasWindow = (t) => PATTERNS.spendWindow.some((re) => re.test(t)) || /first\s+\w+\s+months?/i.test(t);
    if (!hasWindow(flat.slice(start, end)) && hasWindow(flat.slice(end, lineEndOf(end)))) {
      end = lineEndOf(end);
    }
    // Within a paragraph, stop at the end of the sentence.
    const tail = flat.slice(chosen.spendEnd, end);
    const stop = tail.search(/[.!?][*†‡\d]*\s|\s[–—]\s/);
    if (stop !== -1) end = chosen.spendEnd + stop;
    snippet = flat.slice(start, Math.min(end, start + MAX_SNIPPET_CHARS)).trim();
  } else if (nonStandard) {
    start = lineStartOf(nonStandard.index);
    snippet = flat.slice(start, start + 220).trim();
  } else if (candidates.length) {
    // A bonus with no spend requirement nearby: keep it, the parser will mark
    // it low-confidence so a person looks at it.
    const c = candidates[0];
    start = lineStartOf(c.bonus.index);
    snippet = flat.slice(start, Math.min(c.bonus.end + 120, start + MAX_SNIPPET_CHARS)).trim();
  } else {
    return null;
  }

  // Nearest annual-fee phrase: prefer the first one after the offer (issuers
  // print it under the headline), else the closest one just before it.
  const fees = allMatches(FEE_RES, flat);
  const feeAfter = fees.find((f) => f.index >= start && f.index - start <= FEE_LOOKAHEAD_CHARS);
  const feeBefore = fees.filter((f) => f.index < start && start - f.index <= FEE_LOOKBEHIND_CHARS).pop();
  const fee = feeAfter ?? feeBefore ?? null;
  const feeAlreadyInSnippet = fee && fee.index >= start && fee.end <= start + snippet.length;

  return {
    rawOfferText: fee && !feeAlreadyInSnippet ? `${snippet} | ${fee.text}` : snippet,
    complete: Boolean(chosen),
    // Distinct complete statements further down the page — cross-sells or a
    // second offer for the same card (§10). Surfaced so a reviewer can tell.
    otherOfferCount: Math.max(0, new Set(complete.map((c) => c.bonus.text.toLowerCase())).size - 1),
  };
}
