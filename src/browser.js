// §5.1 / §5.4 — Rendered fetch + offer screenshot in one page load.
//
// Issuer card pages are JavaScript-rendered, and the top of the rendered page
// is the offer creative: headline, card art, bonus, call to action. Loading
// the page once in headless Chromium therefore yields everything a scan
// needs — the visible text in reading order (for the offer locator), the
// HTML (for selector overrides and og:image), and a screenshot of the hero
// exactly as a customer sees it.
//
// Playwright is loaded lazily so the diff engine, parser and test suite keep
// working on a machine without the browser installed.

const VIEWPORT = { width: 1440, height: 960 };
const LOCALES = { us: 'en-US', eu: 'en-GB', uk: 'en-GB' };

// Cookie/consent banners cover the creative. Always take the
// privacy-preserving option; never accept optional cookies.
const CONSENT_DECLINE =
  /^(reject|decline|deny|refuse)( all)?( (optional|non-essential|additional|analytics|marketing))?( cookies)?$|^(only|use) (necessary|essential|required)( cookies)?( only)?$|^(necessary|essential|required) cookies only$|^continue without accepting$/i;

async function dismissConsent(page) {
  for (const role of ['button', 'link']) {
    try {
      const control = page.getByRole(role, { name: CONSENT_DECLINE }).first();
      if (await control.isVisible({ timeout: 800 })) {
        await control.click({ timeout: 2000 });
        await page.waitForTimeout(700);
        return true;
      }
    } catch {
      // Not found under this role — try the next.
    }
  }
  return false; // no banner, or none we can decline; the capture proceeds either way
}

/**
 * @returns {Promise<{ fetch: Function, close: Function }>}
 *   fetch(url, { market }) resolves to
 *   { ok, status, html, text, screenshot: Buffer|null, error }.
 */
export async function createBrowserFetcher({ timeoutMs = 45000 } = {}) {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    throw new Error(
      'Playwright is not installed. Run `npm install` and `npx playwright install chromium`.'
    );
  }
  const browser = await chromium.launch();

  async function fetchRendered(url, { market } = {}) {
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 1,
      locale: LOCALES[(market || '').toLowerCase()] ?? 'en-US',
      // Some issuers ship a CSP that blocks reading the rendered text back out.
      bypassCSP: true,
    });
    const page = await context.newPage();
    try {
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      // Give client-side rendering time to settle without hanging on pages
      // that never go network-idle (analytics beacons, chat widgets).
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      await dismissConsent(page);
      await page.waitForTimeout(1200);

      const status = response?.status() ?? null;
      const html = await page.content();
      // Some issuers (American Express) disable script evaluation outright;
      // the locator API still reads the rendered text there.
      const text = await page
        .evaluate(() => document.body?.innerText ?? '')
        .catch(() => page.locator('body').innerText({ timeout: 8000 }));
      if (status !== null && status >= 400) {
        return { ok: false, status, html, text, screenshot: null, error: `HTTP ${status}` };
      }
      const screenshot = await page.screenshot({ type: 'jpeg', quality: 82 });
      return { ok: true, status, html, text, screenshot, error: null };
    } catch (err) {
      return {
        ok: false,
        status: null,
        html: null,
        text: null,
        screenshot: null,
        error: err.message.split('\n')[0],
      };
    } finally {
      await context.close();
    }
  }

  return { fetch: fetchRendered, close: () => browser.close(), viewport: VIEWPORT };
}
