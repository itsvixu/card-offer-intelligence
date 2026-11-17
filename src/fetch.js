// §5.1 / §9 — Page fetcher. Returns a structured result and never throws for a
// normal fetch problem (timeout, non-200, DNS): the pipeline logs every fetch
// outcome so access issues surface in the run report instead of failing
// silently for weeks (§9).
//
// Three URL schemes:
//   http(s):// — plain fetch (static / server-rendered pages)
//   file://    — read from disk (fixtures and offline demo runs)
//   requiresBrowser sources need a headless browser (Playwright); until one is
//   wired up they return a clear, recorded failure rather than a bad scan.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const DEFAULT_USER_AGENT =
  'CompetitorOfferMonitor/0.1 (+twice-weekly competitor offer scan; contact via REPORT_EMAIL_TO)';

/**
 * @returns {Promise<{ ok: boolean, status: number|null, html: string|null, error: string|null }>}
 */
export async function fetchPage(
  url,
  { requiresBrowser = false, userAgent = DEFAULT_USER_AGENT, timeoutMs = 15000, browserFetch = null } = {}
) {
  if (url.startsWith('file://')) {
    try {
      const html = await readFile(fileURLToPath(url), 'utf8');
      return { ok: true, status: 200, html, error: null };
    } catch (err) {
      return { ok: false, status: null, html: null, error: `file read failed: ${err.message}` };
    }
  }

  if (requiresBrowser) {
    // A pluggable browser fetcher can be injected once Playwright is added; the
    // pipeline stays identical and just gets rendered HTML back.
    if (browserFetch) {
      try {
        return { ok: true, status: 200, html: await browserFetch(url), error: null };
      } catch (err) {
        return { ok: false, status: null, html: null, error: `browser fetch failed: ${err.message}` };
      }
    }
    return {
      ok: false,
      status: null,
      html: null,
      error:
        'source is marked requiresBrowser but no headless-browser fetcher is configured — wire up Playwright to scan this source',
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': userAgent, Accept: 'text/html,application/xhtml+xml' },
      redirect: 'follow',
      signal: controller.signal,
    });
    const html = await res.text();
    return res.ok
      ? { ok: true, status: res.status, html, error: null }
      : { ok: false, status: res.status, html, error: `HTTP ${res.status}` };
  } catch (err) {
    const reason = err.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : err.message;
    return { ok: false, status: null, html: null, error: reason };
  } finally {
    clearTimeout(timer);
  }
}
