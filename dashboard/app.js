// Card Offer Intelligence — dashboard.
// One fetch of /api/overview, then everything renders from that object.
// The URL hash holds the view (#changes, #cards, #attention) and the open
// card (#cards/chase-sapphire-preferred), so any state can be linked to.

const MARKETS = { all: 'All markets', us: 'US', uk: 'UK' };
const narrow = matchMedia('(max-width: 820px)');

// Issuer copy carries footnote markers glued to words ("spend1", "fee†").
// They matter on the issuer's page, not when quoted here.
const cleanWording = (text) =>
  text
    .replace(/(?<=[A-Za-z®)])[\d†‡*¹²³]+(?=[\s.,;:)]|$)/g, '')
    .replace(/\s+([.,;])/g, '$1')
    .split(' | ')
    .join(' · ');
const state = { data: null, market: 'all', query: '', sort: 'issuer', layout: 'grid' };

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---------- dates ----------
const DAY_MS = 86400000;
const fmtDay = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
const fmtDate = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const fmtTime = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });
const dayKey = (iso) => new Date(iso).toLocaleDateString('en-CA');

function relativeDay(iso) {
  const days = Math.round((new Date(dayKey(new Date().toISOString())) - new Date(dayKey(iso))) / DAY_MS);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 14) return `${days} days ago`;
  return `${Math.round(days / 7)} weeks ago`;
}

// The scheduled workflow runs Mondays and Thursdays at 08:00 UTC.
function nextScan() {
  const d = new Date();
  for (let i = 0; i < 8; i++) {
    const candidate = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + i, 8));
    if ([1, 4].includes(candidate.getUTCDay()) && candidate > d) return candidate;
  }
  return null;
}

// ---------- selectors ----------
const inMarket = (item) => state.market === 'all' || item.market === state.market;
const cards = () => state.data.cards.filter(inMarket);
const realChanges = () => state.data.changes.filter((c) => inMarket(c) && !c.isBaseline);
const baseline = () => state.data.changes.filter((c) => inMarket(c) && c.isBaseline);
const attention = () => state.data.attention.filter(inMarket);
const cardById = (id) => state.data.cards.find((c) => c.id === id);
const recent = (changes, days = 30) =>
  changes.filter((c) => Date.now() - new Date(c.detectedAt).getTime() <= days * DAY_MS);

function route() {
  const [view = 'changes', id = null] = location.hash.replace(/^#/, '').split('/');
  return { view: ['changes', 'cards', 'attention'].includes(view) ? view : 'changes', id };
}

// ---------- pieces ----------
function shot(src, alt, { tag = 'div', attrs = '' } = {}) {
  const inner = src
    ? `<img src="${esc(src)}" alt="${esc(alt)}" loading="lazy" decoding="async">`
    : `<div class="shot-missing">No screenshot yet</div>`;
  return `<${tag} class="shot" ${attrs}>${inner}</${tag}>`;
}

const who = (c) =>
  `<div class="who"><b>${esc(c.issuer)}</b><span>${esc(c.product)}</span><span class="tag">${esc(MARKETS[c.market] ?? c.market)}</span></div>`;

function deltaRows(facts) {
  const rows = facts.filter((f) => f.changed);
  if (!rows.length) return '';
  return `<dl class="delta">${rows
    .map(
      (f) => `<div><dt>${esc(f.label)}</dt><dd>
        <span class="was">${esc(f.before ?? 'Not shown')}</span><span class="arrow" aria-hidden="true">→</span>
        <span class="now">${esc(f.after ?? 'Not shown')}</span>
        ${f.direction ? `<span class="dir">${f.direction === 'up' ? '↑ up' : '↓ down'}</span>` : ''}
      </dd></div>`
    )
    .join('')}</dl>`;
}

// ---------- lede ----------
function renderLede() {
  const { data } = state;
  const run = data.lastRun;
  const all = cards();
  const changes = recent(realChanges());
  const needs = attention();

  if (run) {
    const read = all.filter((c) => c.status !== 'failed' && c.status !== 'pending').length;
    const when = new Date(run.finishedAt);
    $('scanStatus').innerHTML =
      `<span class="dot ${needs.length ? 'warn' : ''}"></span>` +
      `Last scan ${esc(fmtDay.format(when))}, ${esc(fmtTime.format(when))} · ${read} of ${all.length} pages read`;
  } else {
    $('scanStatus').textContent = 'No scan yet';
  }

  let headline;
  let sub;
  if (!all.length) {
    headline = 'No cards in this market yet';
    sub = 'Add card pages to config/sources.json and run a scan.';
  } else if (changes.length) {
    headline = `${changes.length} offer ${changes.length === 1 ? 'change' : 'changes'} in the last 30 days`;
    const latest = changes[0];
    sub = `Most recent: ${latest.issuer} ${latest.product} — ${lowerFirst(latest.headline)}.`;
  } else {
    headline = 'No offers have changed yet';
    const since = all.map((c) => c.firstSeen).filter(Boolean).sort()[0];
    sub = `${all.length} cards have been tracked since ${since ? fmtDate.format(new Date(since)) : 'the first scan'}. Changes appear here as soon as a scan finds one.`;
  }
  const next = nextScan();
  if (next && run) sub += ` Next scan ${fmtDay.format(next)}.`;
  $('headline').textContent = headline;
  $('subhead').textContent = sub;

  const byMarket = Object.entries(
    all.reduce((acc, c) => ({ ...acc, [c.market]: (acc[c.market] ?? 0) + 1 }), {})
  )
    .map(([m, n]) => `${n} ${MARKETS[m] ?? m}`)
    .join(' · ');
  const issuers = new Set(all.map((c) => c.issuer)).size;
  $('stats').innerHTML = `
    <div><dt>Cards tracked</dt><dd>${all.length}<small>${esc(byMarket || '—')} · ${issuers} issuers</small></dd></div>
    <div><dt>Changes, last 30 days</dt><dd>${changes.length}<small>${changes.length ? `${new Set(changes.map((c) => c.sourceId)).size} cards affected` : 'Nothing has moved'}</small></dd></div>
    <div><dt>Needs a look</dt><dd>${needs.length}<small>${needs.length ? 'Could not be read with confidence' : 'Every page read cleanly'}</small></dd></div>`;
}

const lowerFirst = (s) => (s ? s[0].toLowerCase() + s.slice(1) : '');

function renderChrome() {
  const links = state.data.links ?? {};
  $('demoBanner').hidden = !state.data.demo;
  $('liveLink').innerHTML = links.live ? ` <a href="${esc(links.live)}">View live data →</a>` : '';
  $('caseStudyLink').hidden = !links.caseStudy;
  if (links.caseStudy) $('caseStudyLink').href = links.caseStudy;
  const markets = ['all', ...new Set(state.data.cards.map((c) => c.market))];
  $('marketControl').innerHTML = markets
    .map((m) => `<button type="button" data-market="${m}" aria-pressed="${state.market === m}">${esc(m === 'all' && narrow.matches ? 'All' : MARKETS[m] ?? m)}</button>`)
    .join('');

  const { view } = route();
  const tabs = [
    ['changes', 'Changes', realChanges().length || '', ''],
    ['cards', 'All cards', cards().length, ''],
    ['attention', 'Needs a look', attention().length || '', 'warn'],
  ];
  $('tabs').innerHTML = tabs
    .map(
      ([id, label, count, tone]) =>
        `<a href="#${id}" ${view === id ? 'aria-current="page"' : ''}>${label}${count !== '' ? `<span class="count ${tone}">${count}</span>` : ''}</a>`
    )
    .join('');
}

// ---------- changes ----------
function changeCard(c) {
  const card = cardById(c.sourceId);
  const alt = `${c.issuer} ${c.product} page as captured on ${fmtDate.format(new Date(c.detectedAt))}`;
  return `<article class="change">
    ${shot(c.captureAfter ?? card?.capture, alt, { tag: 'button', attrs: `type="button" data-open="${esc(c.sourceId)}" aria-label="Open ${esc(c.issuer)} ${esc(c.product)}"` })}
    <div class="change-body">
      ${who(c)}
      <h3>${esc(c.headline)}</h3>
      ${deltaRows(c.facts)}
      <div class="change-foot">
        <button type="button" class="btn" data-open="${esc(c.sourceId)}">View card</button>
        ${card ? `<a class="link" href="${esc(card.url)}" target="_blank" rel="noopener">${esc(card.host)} ↗</a>` : ''}
      </div>
    </div>
  </article>`;
}

function renderChanges() {
  const changes = realChanges();
  const base = baseline();
  let html = '';

  if (!changes.length) {
    const demo = state.data.links?.demo;
    html += `<div class="empty"><h2>Nothing has changed yet</h2>
      <p>Every tracked offer matches the last scan. When a bonus, spend requirement or fee moves,<br>it will show up here with the before and after values and a screenshot.</p>
      ${demo ? `<p style="margin-top:16px"><a class="btn" href="${esc(demo)}">See how changes appear (demo) →</a></p>` : ''}</div>`;
  } else {
    const days = new Map();
    for (const c of changes) {
      const key = dayKey(c.detectedAt);
      if (!days.has(key)) days.set(key, []);
      days.get(key).push(c);
    }
    html += [...days.values()]
      .map(
        (items) => `<section class="day">
          <div class="day-label"><time datetime="${esc(items[0].detectedAt)}">${esc(fmtDay.format(new Date(items[0].detectedAt)))}</time><span>${esc(relativeDay(items[0].detectedAt))}</span></div>
          <div class="day-items">${items.map(changeCard).join('')}</div>
        </section>`
      )
      .join('');
  }

  if (base.length) {
    const when = fmtDate.format(new Date(base[base.length - 1].detectedAt));
    html += `<section class="day"><div class="day-label"><time>${esc(when)}</time><span>Tracking began</span></div>
      <details class="baseline" ${changes.length ? '' : 'open'}>
        <summary>${base.length} cards captured as the starting point</summary>
        <ul>${base
          .map(
            (c) => `<li><button type="button" data-open="${esc(c.sourceId)}">${esc(c.issuer)} ${esc(c.product)}</button><span>${esc(c.headline.replace(/^Now tracking: /, ''))}</span></li>`
          )
          .join('')}</ul>
      </details></section>`;
  }
  $('view').innerHTML = html;
}

// ---------- all cards ----------
const SORTS = {
  issuer: ['Issuer, A to Z', (a, b) => `${a.issuer} ${a.product}`.localeCompare(`${b.issuer} ${b.product}`)],
  changed: ['Most recently changed', (a, b) => (b.lastChange?.detectedAt ?? '').localeCompare(a.lastChange?.detectedAt ?? '')],
  fee: ['Annual fee, high to low', (a, b) => (b.offer?.annualFee ?? -1) - (a.offer?.annualFee ?? -1)],
  spend: ['Spend required, high to low', (a, b) => (b.offer?.spendRequirement ?? -1) - (a.offer?.spendRequirement ?? -1)],
};

const fact = (card, key) => card.facts.find((f) => f.key === key)?.after ?? null;

function statusChips(card) {
  const chips = [];
  if (card.status === 'review') chips.push('<span class="chip warn">Needs a look</span>');
  if (card.status === 'failed') chips.push('<span class="chip warn">Last scan failed</span>');
  if (card.status === 'withdrawn') chips.push('<span class="chip warn">Offer withdrawn</span>');
  if (card.lastChange) chips.push(`<span class="chip">Changed ${esc(fmtDay.format(new Date(card.lastChange.detectedAt)).replace(/^\w+ /, ''))}</span>`);
  if (card.isTargeted) chips.push('<span class="chip quiet">Targeted offer</span>');
  return chips.join('');
}

function tile(card) {
  const terms = [
    fact(card, 'spend') && `after ${fact(card, 'spend')} spend${fact(card, 'window') ? ` in ${fact(card, 'window')}` : ''}`,
    fact(card, 'fee') && (fact(card, 'fee') === 'None' ? 'no annual fee' : `${fact(card, 'fee')} annual fee`),
  ].filter(Boolean);
  return `<button type="button" class="tile" data-open="${esc(card.id)}">
    ${shot(card.capture, `${card.issuer} ${card.product} page`)}
    <div class="tile-body">
      <div class="tile-issuer"><span>${esc(card.issuer)}</span><span>${esc(MARKETS[card.market] ?? card.market)}</span></div>
      <h3>${esc(card.product)}</h3>
      <div class="tile-bonus">${esc(fact(card, 'bonus') ?? 'No welcome offer read')}</div>
      <div class="tile-terms">${esc(terms.join(' · ') || '—')}</div>
      <div class="tile-foot">${statusChips(card)}</div>
    </div>
  </button>`;
}

function table(list) {
  const cell = (v) => (v ? esc(v) : '<span class="muted">—</span>');
  return `<div class="table-wrap"><table>
    <thead><tr><th>Card</th><th>Welcome bonus</th><th class="num">Spend required</th><th>Time to earn</th><th class="num">Annual fee</th><th>Last change</th></tr></thead>
    <tbody>${list
      .map(
        (c) => `<tr data-open="${esc(c.id)}" tabindex="0">
          <td>${who(c)}</td><td>${cell(fact(c, 'bonus'))}</td><td class="num">${cell(fact(c, 'spend'))}</td>
          <td>${cell(fact(c, 'window'))}</td><td class="num">${cell(fact(c, 'fee'))}</td>
          <td>${c.lastChange ? esc(fmtDate.format(new Date(c.lastChange.detectedAt))) : '<span class="muted">None yet</span>'}</td>
        </tr>`
      )
      .join('')}</tbody></table></div>`;
}

function renderCards() {
  const q = state.query.trim().toLowerCase();
  const list = cards()
    .filter((c) => !q || `${c.issuer} ${c.product} ${c.network ?? ''} ${c.category ?? ''}`.toLowerCase().includes(q))
    .sort(SORTS[state.sort][1]);

  const body = !list.length
    ? `<div class="empty"><h2>No cards match</h2><p>Try a different search.</p></div>`
    : state.layout === 'grid'
      ? `<div class="grid">${list.map(tile).join('')}</div>`
      : table(list);

  $('view').innerHTML = `<div class="toolbar">
      <input type="search" id="search" placeholder="Search issuer or card" value="${esc(state.query)}" aria-label="Search cards">
      <label>Sort <select id="sort">${Object.entries(SORTS)
        .map(([k, [label]]) => `<option value="${k}" ${state.sort === k ? 'selected' : ''}>${label}</option>`)
        .join('')}</select></label>
      <span class="spacer"></span>
      <div class="segmented" role="group" aria-label="Layout">
        <button type="button" data-layout="grid" aria-pressed="${state.layout === 'grid'}">Gallery</button>
        <button type="button" data-layout="table" aria-pressed="${state.layout === 'table'}">Compare</button>
      </div>
    </div>${body}`;
}

// ---------- needs a look ----------
function renderAttention() {
  const items = attention();
  if (!items.length) {
    $('view').innerHTML = `<div class="empty"><h2>Nothing needs a look</h2><p>Every page was read with confidence on the last scan.</p></div>`;
    return;
  }
  $('view').innerHTML = `<div class="attention">${items
    .map((a) => {
      const failed = a.kind === 'failed';
      return `<article class="att">
        ${shot(a.capture, `${a.issuer} ${a.product} page, last successful capture`)}
        <div>
          ${who(a)}
          <h3>${failed ? 'The page could not be scanned' : 'The offer could not be compared'}</h3>
          <p>${esc(a.reason)}</p>
          <p class="next">${failed
            ? 'The last known offer is still shown. It will be retried on the next scan.'
            : 'It is not being reported as changed or unchanged. Open the page to check the offer yourself.'}</p>
          <div class="att-actions">
            <a class="btn" href="${esc(a.url)}" target="_blank" rel="noopener">Open the page ↗</a>
            <button type="button" class="btn" data-open="${esc(a.sourceId)}">View card</button>
          </div>
        </div>
      </article>`;
    })
    .join('')}</div>`;
}

// ---------- detail sheet ----------
function renderSheet(card) {
  const history = state.data.changes.filter((c) => c.sourceId === card.id);
  const confidence =
    card.confidence === 'high' ? 'Read with confidence' : card.confidence === 'low' ? 'Low confidence — treat with care' : '—';
  $('sheet').innerHTML = `
    <div class="sheet-head">
      <div>${who(card)}<h2 id="sheetTitle">${esc(card.product)}</h2></div>
      <button type="button" class="close" data-close aria-label="Close">×</button>
    </div>
    <div class="sheet-body">
      ${card.statusNote && card.status !== 'ok' ? `<p class="note">${esc(card.statusNote)}</p>` : ''}
      <figure>
        ${card.capture
          ? `<a class="shot" href="${esc(card.capture)}" target="_blank" rel="noopener" aria-label="Open the full screenshot"><img src="${esc(card.capture)}" alt="${esc(card.issuer)} ${esc(card.product)} page as captured"></a>`
          : shot(null, '')}
        <figcaption class="caption"><span>${card.capturedAt ? `Captured ${esc(fmtDate.format(new Date(card.capturedAt)))} at 1440px wide` : 'No capture yet'}</span>
          <a class="link" href="${esc(card.url)}" target="_blank" rel="noopener">${esc(card.host)} ↗</a></figcaption>
      </figure>
      <section><h3>Current offer</h3>
        <dl class="facts">${card.facts.map((f) => `<div><dt>${esc(f.label)}</dt><dd>${esc(f.after ?? '—')}</dd></div>`).join('')}</dl>
      </section>
      ${card.pageWording ? `<section><h3>In the page's own words</h3><blockquote>${esc(cleanWording(card.pageWording))}</blockquote></section>` : ''}
      <section><h3>History</h3>
        ${history.length
          ? `<ol class="timeline">${history
              .map(
                (c) => `<li><time datetime="${esc(c.detectedAt)}">${esc(fmtDate.format(new Date(c.detectedAt)))}</time>
                  <p>${esc(c.isBaseline ? c.headline.replace(/^Now tracking: /, 'First captured: ') : c.headline)}</p></li>`
              )
              .join('')}</ol>`
          : '<p class="muted">No history yet.</p>'}
      </section>
      <section><h3>About this reading</h3>
        <dl class="meta">
          <dt>Last scanned</dt><dd>${card.lastScanned ? `${esc(fmtDate.format(new Date(card.lastScanned)))}, ${esc(fmtTime.format(new Date(card.lastScanned)))}` : '—'}</dd>
          <dt>Confidence</dt><dd>${esc(confidence)}</dd>
          <dt>Offer type</dt><dd>${card.isTargeted ? 'Targeted — the page shows a ceiling ("as high as"), not a guaranteed amount' : 'Public, fixed offer'}</dd>
          <dt>Network · category</dt><dd>${esc([card.network, card.category].filter(Boolean).join(' · ') || '—')}</dd>
        </dl>
      </section>
    </div>`;
}

function syncSheet() {
  const { view, id } = route();
  const sheet = $('sheet');
  const card = id ? cardById(id) : null;
  if (card) {
    renderSheet(card);
    if (!sheet.open) sheet.showModal();
    sheet.scrollTop = 0;
  } else if (sheet.open) {
    sheet.close();
  }
  return view;
}

// ---------- render + events ----------
function render() {
  if (!state.data) return;
  if (state.data.empty) {
    $('scanStatus').textContent = 'No scan yet';
    $('headline').textContent = 'Nothing has been scanned yet';
    $('subhead').textContent = '';
    $('view').innerHTML = `<div class="empty"><h2>Run the first scan</h2><p>${state.data.sourceCount} card pages are configured. Run <code>npm run scan</code>, then reload.</p></div>`;
    return;
  }
  renderChrome();
  renderLede();
  const view = syncSheet();
  ({ changes: renderChanges, cards: renderCards, attention: renderAttention })[view]();
}

const openCard = (id) => (location.hash = `${route().view}/${id}`);
const closeCard = () => (location.hash = route().view);

document.addEventListener('click', (e) => {
  const market = e.target.closest('[data-market]');
  if (market) return void ((state.market = market.dataset.market), render());
  const layout = e.target.closest('[data-layout]');
  if (layout) return void ((state.layout = layout.dataset.layout), render());
  if (e.target.closest('[data-close]')) return closeCard();
  const open = e.target.closest('[data-open]');
  if (open) return openCard(open.dataset.open);
  if (e.target === $('sheet')) closeCard(); // click on the backdrop
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.matches('tr[data-open]')) openCard(e.target.dataset.open);
});

document.addEventListener('input', (e) => {
  if (e.target.id !== 'search') return;
  state.query = e.target.value;
  renderCards();
  const input = $('search');
  input.focus();
  input.setSelectionRange(state.query.length, state.query.length);
});

document.addEventListener('change', (e) => {
  if (e.target.id === 'sort') {
    state.sort = e.target.value;
    renderCards();
  }
});

$('sheet').addEventListener('cancel', (e) => {
  e.preventDefault(); // Esc: close through the hash so Back still works
  closeCard();
});

window.addEventListener('hashchange', render);
narrow.addEventListener('change', render);

try {
  const res = await fetch('api/overview.json');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  state.data = await res.json();
  render();
} catch (err) {
  $('scanStatus').textContent = 'Could not load';
  $('headline').textContent = 'The dashboard could not reach its data';
  $('subhead').textContent = `Start it with "npm run dashboard" and reload. (${err.message})`;
}
