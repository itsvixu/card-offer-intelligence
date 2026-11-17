// §5.1 — Extract the offer text region from a fetched page, scoped to a
// configured selector so unrelated page changes (nav, cookie banners, other
// promos) never reach the parser or the diff engine.
//
// Zero-dependency by design: the fixture suite and the diff engine must not
// depend on network installs. Supports the two selector shapes used in source
// configs: `.class-name` and `[attr="value"]`.

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildOpenTagRegex(selector) {
  let attrPattern;
  const classMatch = selector.match(/^\.([\w-]+)$/);
  const attrMatch = selector.match(/^\[([\w-]+)=["']?([^"'\]]+)["']?\]$/);
  if (classMatch) {
    // Class attr must contain the class as a whole token, not a substring
    // (".offer" must not match class="offer-inner").
    attrPattern = `class=["'][^"']*(?<![\\w-])${escapeRegex(classMatch[1])}(?![\\w-])[^"']*["']`;
  } else if (attrMatch) {
    attrPattern = `${escapeRegex(attrMatch[1])}=["']${escapeRegex(attrMatch[2])}["']`;
  } else {
    throw new Error(
      `Unsupported offerSelector "${selector}" — only .class and [attr="value"] selectors are supported`
    );
  }
  return new RegExp(`<([a-zA-Z][\\w-]*)\\b[^>]*${attrPattern}[^>]*>`, 'i');
}

export function htmlToText(fragment) {
  return fragment
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&reg;/gi, '®')
    .replace(/&trade;/gi, '™')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Find the offer region in a page and return its character offsets, without
 * extracting text. Shared by extractOfferRegion (offer parsing, §5.1) and
 * creative capture (§5.4, which needs the raw offsets to find images "near"
 * the offer region rather than the plain-text content).
 *
 * `regionFound: false` is a distinct outcome from "region found but no offer
 * in it" — the diff engine maps the former to NEEDS_REVIEW (stale selector,
 * §10) and only the latter can become DISCONTINUED.
 *
 * @returns {{ regionFound: boolean, start: number, end: number }}
 */
export function locateOfferRegion(html, selector) {
  const open = buildOpenTagRegex(selector).exec(html);
  if (!open) {
    return { regionFound: false, start: -1, end: -1 };
  }

  const tagName = open[1].toLowerCase();
  const contentStart = open.index + open[0].length;

  // Walk forward tracking nesting depth of the same tag name to find the
  // matching close tag.
  const tokenRe = new RegExp(`<${tagName}\\b[^>]*>|</${tagName}\\s*>`, 'gi');
  tokenRe.lastIndex = contentStart;
  let depth = 1;
  let token;
  while ((token = tokenRe.exec(html)) !== null) {
    depth += token[0].startsWith('</') ? -1 : 1;
    if (depth === 0) {
      return { regionFound: true, start: contentStart, end: token.index };
    }
  }
  // Unclosed tag — take everything to end of document rather than failing.
  return { regionFound: true, start: contentStart, end: html.length };
}

/**
 * Find the offer region in a page and return its visible text.
 * @returns {{ regionFound: boolean, rawOfferText: string | null }}
 */
export function extractOfferRegion(html, selector) {
  const region = locateOfferRegion(html, selector);
  if (!region.regionFound) {
    return { regionFound: false, rawOfferText: null };
  }
  return {
    regionFound: true,
    rawOfferText: htmlToText(html.slice(region.start, region.end)),
  };
}
