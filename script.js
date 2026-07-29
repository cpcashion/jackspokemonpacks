/* ═══════════════════════════════════════════════════════════════
   Jack's Pokémon Collection — client
   ═══════════════════════════════════════════════════════════════ */

'use strict';

// ── STATE ────────────────────────────────────────────────────────

const state = {
  cards: [],
  stats: {},
  pricing: { conditions: [], fx: null },
  view: 'collection',
  layout: localStorage.getItem('layout') || 'grid',
  sort: { key: 'value', dir: 'desc' },
  query: '',
  openCardId: null,
  chartDays: 30,
  heroRange: 30,
  scanQueue: 0,
  scanned: [],
};

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

// ── FORMATTING ───────────────────────────────────────────────────

const money = (n) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  return v.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
};

/** Compact form for headline figures: $1.2k reads better than $1,234.56 in a tile. */
const moneyShort = (n) => {
  const v = Number(n) || 0;
  if (Math.abs(v) >= 10000) return '$' + (v / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return money(v);
};

const pct = (current, previous) => {
  if (!current || !previous) return null;
  return ((current - previous) / previous) * 100;
};

const trendClass = (p) => (p === null || Math.abs(p) < 0.05 ? 'flat' : p > 0 ? 'up' : 'down');
const trendText = (p) => {
  if (p === null) return '—';
  if (Math.abs(p) < 0.05) return '0.0%';
  return `${p > 0 ? '↑' : '↓'} ${Math.abs(p).toFixed(1)}%`;
};

const timeAgo = (ts) => {
  if (!ts) return 'never';
  const s = (Date.now() - new Date(ts).getTime()) / 1000;
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};

/** Turn a source key like `pokemontcg_tcgplayer` into something a human reads. */
const sourceLabel = (key) => {
  if (!key) return 'Unknown';
  return String(key)
    .replace(/_/g, ' ')
    .replace(/\btcgplayer\b/gi, 'TCGplayer')
    .replace(/\bcardmarket\b/gi, 'Cardmarket')
    .replace(/\bpokemontcg\b/gi, 'Pokémon TCG API')
    .replace(/\btcgdex\b/gi, 'TCGdex')
    .replace(/\bjusttcg\b/gi, 'JustTCG')
    .replace(/\bscrydex\b/gi, 'Scrydex')
    .replace(/\bconsensus\b/gi, 'consensus')
    .replace(/^./, (c) => c.toUpperCase());
};

// ── TOASTS ───────────────────────────────────────────────────────

function toast(message, kind = 'info', ms = 3600) {
  const node = el('div', 'toast');
  node.append(el('span', null, message));
  node.dataset.kind = kind;
  $('toasts').appendChild(node);
  setTimeout(() => {
    node.classList.add('out');
    setTimeout(() => node.remove(), 260);
  }, ms);
}

const buzz = (ms) => { try { navigator.vibrate?.(ms); } catch { /* unsupported */ } };

// ── ICONS ────────────────────────────────────────────────────────
// Line icons rather than emoji: emoji are colourful, inconsistent between
// platforms, and fight a monochrome interface.

const ICON_PATHS = {
  card: '<rect x="4" y="2.5" width="16" height="19" rx="2.5"/><path d="M8 8h8M8 12h5"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  camera: '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
};

/** Returns an <svg> element; callers treat it like any other node. */
function icon(name, size = 22) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.6');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.innerHTML = ICON_PATHS[name] || ICON_PATHS.card;
  return svg;
}

function cardPlaceholder() {
  const wrap = el('div', 'ph');
  wrap.appendChild(icon('card', 22));
  return wrap;
}

// ── API ──────────────────────────────────────────────────────────

async function api(path, options) {
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options?.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

async function loadCollection() {
  try {
    const data = await api('/api/portfolio');
    state.cards = data.cards || [];
    state.stats = data.stats || {};
    state.pricing = data.pricing || state.pricing;
    render();
    checkForSplitRows();
  } catch (err) {
    toast(`Could not load your collection: ${err.message}`, 'error');
  }
}

// ── THEME ────────────────────────────────────────────────────────

function applyTheme(mode) {
  if (mode === 'auto') {
    document.documentElement.removeAttribute('data-theme');
    localStorage.removeItem('theme');
  } else {
    document.documentElement.setAttribute('data-theme', mode);
    localStorage.setItem('theme', mode);
  }
  syncThemeButtons();
}

function currentTheme() {
  return localStorage.getItem('theme') || 'auto';
}

function syncThemeButtons() {
  const mode = currentTheme();
  document.querySelectorAll('[data-theme-set]').forEach((b) => {
    b.classList.toggle('active', b.dataset.themeSet === mode);
  });
}

$('themeBtn').addEventListener('click', () => {
  const resolved = document.documentElement.getAttribute('data-theme')
    || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  applyTheme(resolved === 'dark' ? 'light' : 'dark');
});

document.querySelectorAll('[data-theme-set]').forEach((b) => {
  b.addEventListener('click', () => applyTheme(b.dataset.themeSet));
});

// ── NAVIGATION ───────────────────────────────────────────────────

const VIEW_TITLES = { collection: 'Collection', sets: 'Sets', review: 'Needs review', settings: 'Settings' };

function showView(name) {
  if (name === 'scan') { openScanner(); return; }
  state.view = name;
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  document.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  $('viewTitle').textContent = VIEW_TITLES[name] || 'Collection';
  window.scrollTo({ top: 0 });
  render();
  if (name === 'settings') loadHealth();
}

document.querySelectorAll('[data-view]').forEach((b) => {
  b.addEventListener('click', () => showView(b.dataset.view));
});
$('railScanBtn').addEventListener('click', openScanner);
$('lensBtn').addEventListener('click', openScanner);

// ── SEARCH / SORT / LAYOUT ───────────────────────────────────────

let searchTimer = null;
$('searchInput').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  const value = e.target.value;
  searchTimer = setTimeout(() => { state.query = value.trim().toLowerCase(); render(); }, 130);
});

document.querySelectorAll('[data-layout]').forEach((b) => {
  b.classList.toggle('active', b.dataset.layout === state.layout);
  b.addEventListener('click', () => {
    state.layout = b.dataset.layout;
    localStorage.setItem('layout', state.layout);
    document.querySelectorAll('[data-layout]').forEach((x) => x.classList.toggle('active', x === b));
    render();
  });
});

document.querySelectorAll('[data-sort]').forEach((b) => {
  b.addEventListener('click', () => {
    const key = b.dataset.sort;
    // Tapping the active sort flips its direction, which is what people expect.
    state.sort = state.sort.key === key
      ? { key, dir: state.sort.dir === 'desc' ? 'asc' : 'desc' }
      : { key, dir: key === 'name' ? 'asc' : 'desc' };
    document.querySelectorAll('[data-sort]').forEach((x) => x.classList.toggle('active', x === b));
    render();
  });
});

function visibleCards() {
  const q = state.query;
  let cards = state.cards.filter((c) => (state.view === 'review' ? c.needs_review : !c.needs_review));

  if (q) {
    cards = cards.filter((c) =>
      [c.card_name, c.card_set, c.card_number, c.rarity].some((f) => String(f || '').toLowerCase().includes(q)));
  }

  const { key, dir } = state.sort;
  const sign = dir === 'asc' ? 1 : -1;
  cards.sort((a, b) => {
    if (key === 'name') return sign * String(a.card_name || '').localeCompare(String(b.card_name || ''));
    if (key === 'qty') return sign * ((a.quantity || 0) - (b.quantity || 0));
    if (key === 'change') return sign * ((pct(a.unit_price, a.prev_day_price) || 0) - (pct(b.unit_price, b.prev_day_price) || 0));
    return sign * ((a.total_value || 0) - (b.total_value || 0));
  });
  return cards;
}

// ── RENDER ───────────────────────────────────────────────────────

function render() {
  renderStats();
  renderCounts();
  if (state.view === 'review') renderReview();
  else if (state.view === 'sets') renderSets();
  else renderCollection();
}

function renderCounts() {
  const reviewCount = state.cards.filter((c) => c.needs_review).length;
  $('navCollectionCount').textContent = state.stats.totalCopies ?? 0;

  const setCount = new Set(state.cards.filter(c => !c.needs_review).map(c => c.card_set || 'Unknown set')).size;
  const navSets = $('navSetsCount');
  if (navSets) navSets.textContent = setCount;

  const navReview = $('navReviewCount');
  navReview.hidden = reviewCount === 0;
  navReview.textContent = reviewCount;

  const badge = $('tabReviewBadge');
  badge.hidden = reviewCount === 0;
  badge.textContent = reviewCount;

  $('railTotal').textContent = money(state.stats.totalValue || 0);
  const change = pct(state.stats.totalValue, state.stats.prevValue);
  const railChange = $('railChange');
  railChange.className = `rail-total-change ${trendClass(change)}`;
  railChange.textContent = change === null ? 'No history yet' : `${trendText(change)} today`;

  const fx = state.pricing?.fx;
  if (fx) {
    $('fxNote').textContent = fx.live
      ? `Euro prices converted at ${fx.usdPerEur} USD/EUR, refreshed ${timeAgo(fx.fetchedAt)}.`
      : `Live exchange rate unavailable — using a fallback of ${fx.usdPerEur} USD/EUR.`;
  }
}

function renderStats() {
  const s = state.stats;
  const unverified = s.unverifiedPrices || 0;
  const banner = $('unverifiedBanner');
  banner.hidden = unverified === 0;
  if (unverified) {
    $('unverifiedBannerTitle').textContent =
      `${unverified} price${unverified === 1 ? '' : 's'} not verified`;
    $('unverifiedBannerText').textContent =
      'These were set by an earlier version that did not record where the number came from. Re-pricing checks them against the marketplaces and shows the evidence.';
  }
  renderHero();
}

/**
 * Reconstruct what the whole collection was worth on each of the last N days.
 *
 * Each card only records a price when it is checked, so for any given day we
 * take the most recent price at or before that day and value every copy of the
 * card at it. A card is worth nothing to the total before its first recorded
 * price — otherwise adding a card would look like the market moving.
 */
function portfolioSeries(days) {
  const priced = state.cards.filter(c => (c.price_history || []).length);
  if (!priced.length) return [];

  // Rather than repeat the condition table here, derive each card's multiplier
  // from figures the server already sent: copies priced off the market scale
  // with it, copies with a hand-set value do not.
  const prepared = priced.map(card => {
    const unit = Number(card.unit_price) || 0;
    const copies = card.copies || [];
    const fixed = copies.filter(c => Number(c.manual_value) > 0)
      .reduce((sum, c) => sum + Number(c.value || 0), 0);
    const scaling = copies.filter(c => !(Number(c.manual_value) > 0))
      .reduce((sum, c) => sum + Number(c.value || 0), 0);
    return {
      fixed,
      factor: unit > 0 ? scaling / unit : 0,
      points: (card.price_history || [])
        .map(h => ({ t: new Date(h.recorded_at).getTime(), v: Number(h.price) }))
        .filter(p => p.v > 0 && Number.isFinite(p.t))
        .sort((a, b) => a.t - b.t),
    };
  }).filter(c => c.points.length);

  const earliest = Math.min(...prepared.map(c => c.points[0].t));
  const now = Date.now();
  const span = days > 0 ? Math.min(days, Math.ceil((now - earliest) / 86400000) + 1) : Math.ceil((now - earliest) / 86400000) + 1;
  const buckets = Math.min(Math.max(span, 2), 120);
  const step = Math.max((now - Math.max(earliest, now - span * 86400000)) / (buckets - 1), 1);
  const from = now - step * (buckets - 1);

  const series = [];
  for (let i = 0; i < buckets; i++) {
    const t = from + step * i;
    let total = 0;
    for (const card of prepared) {
      // Before a card's first recorded price, value it at that first price.
      // The chart answers "how has what Jack owns moved?" — if cards blinked
      // into existence as they were scanned, the line would show him adding
      // cards and call it a 4,000% gain.
      let unit = card.points[0].v;
      for (const p of card.points) {
        if (p.t <= t) unit = p.v; else break;
      }
      total += unit * card.factor + card.fixed;
    }
    series.push({ t, v: Number(total.toFixed(2)) });
  }
  return series.filter(p => p.v > 0);
}

function renderHero() {
  const s = state.stats;
  $('heroValue').textContent = money(s.totalValue || 0);

  const series = portfolioSeries(state.heroRange);
  const first = series.length ? series[0].v : null;
  const last = series.length ? series[series.length - 1].v : null;
  const windowChange = first && last ? ((last - first) / first) * 100 : null;
  const windowDelta = first && last ? last - first : null;

  const changeEl = $('heroChange');
  changeEl.innerHTML = '';
  if (windowChange === null) {
    changeEl.append(el('span', 'muted', 'Tracking starts as prices are recorded'));
  } else {
    const label = state.heroRange === 0 ? 'all time' : `past ${state.heroRange} days`;
    changeEl.append(
      el('span', trendClass(windowChange), `${windowDelta >= 0 ? '+' : '−'}${money(Math.abs(windowDelta)).slice(1)}`),
      el('span', trendClass(windowChange), trendText(windowChange)),
      el('span', 'muted', label),
    );
  }

  const chartHost = $('heroChart');
  chartHost.innerHTML = '';
  chartHost.appendChild(series.length >= 2
    ? areaChart(series, windowChange === null || windowChange >= 0)
    : el('div', 'empty-note', 'The value chart fills in as daily prices are recorded.'));

  const facts = $('heroFacts');
  facts.innerHTML = '';
  const items = [
    [String(s.totalCopies || 0), `card${s.totalCopies === 1 ? '' : 's'}`, false],
    [String(s.totalCards || 0), 'unique', false],
    [String(s.duplicateCards || 0), 'duplicated', false],
  ];
  if (s.unpricedCopies) items.push([String(s.unpricedCopies), 'unpriced', true]);
  if (s.needsReview) items.push([String(s.needsReview), 'to review', true]);

  for (const [value, label, alert] of items) {
    const fact = el('div', `hero-fact${alert ? ' alert' : ''}`);
    fact.append(el('b', null, value), el('span', null, label));
    facts.appendChild(fact);
  }
}

/** Wide area chart for the hero. Emphasised endpoint, no axes — the figure
 *  above carries the number; the chart carries the shape. */
function areaChart(points, rising) {
  const NS = 'http://www.w3.org/2000/svg';
  const W = 700, H = 92;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'none');

  const values = points.map(p => p.v);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || Math.max(max * 0.08, 1);
  const x = (i) => (i / (points.length - 1)) * W;
  const y = (v) => 10 + (1 - (v - min) / range) * (H - 22);

  const stroke = rising ? 'var(--up)' : 'var(--down)';
  const id = `h${Math.random().toString(36).slice(2, 8)}`;

  const defs = document.createElementNS(NS, 'defs');
  const grad = document.createElementNS(NS, 'linearGradient');
  grad.setAttribute('id', id);
  grad.setAttribute('x1', '0'); grad.setAttribute('y1', '0');
  grad.setAttribute('x2', '0'); grad.setAttribute('y2', '1');
  const s1 = document.createElementNS(NS, 'stop');
  s1.setAttribute('offset', '0%'); s1.setAttribute('stop-color', stroke); s1.setAttribute('stop-opacity', '0.22');
  const s2 = document.createElementNS(NS, 'stop');
  s2.setAttribute('offset', '100%'); s2.setAttribute('stop-color', stroke); s2.setAttribute('stop-opacity', '0');
  grad.append(s1, s2);
  defs.appendChild(grad);
  svg.appendChild(defs);

  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.v).toFixed(1)}`).join(' ');

  const area = document.createElementNS(NS, 'path');
  area.setAttribute('d', `${line} L${W} ${H} L0 ${H} Z`);
  area.setAttribute('fill', `url(#${id})`);
  svg.appendChild(area);

  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', line);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', stroke);
  path.setAttribute('stroke-width', '2');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  path.setAttribute('vector-effect', 'non-scaling-stroke');
  svg.appendChild(path);

  return svg;
}

document.querySelectorAll('#heroRanges button').forEach((b) => {
  b.addEventListener('click', () => {
    state.heroRange = Number(b.dataset.range);
    document.querySelectorAll('#heroRanges button').forEach(x => x.classList.toggle('active', x === b));
    renderHero();
  });
});

/**
 * The merge banner only appears when there is actually something to merge.
 * Owning duplicates is normal and already shown as a ×N badge; a permanent
 * banner about it would just be noise.
 */
let splitRowCheck = null;

async function checkForSplitRows() {
  const banner = $('dupeBanner');
  try {
    splitRowCheck = await api('/api/portfolio/duplicates');
    const groups = splitRowCheck.groups || [];
    banner.hidden = groups.length === 0;
    if (groups.length) {
      const rows = groups.reduce((sum, g) => sum + g.row_count, 0);
      const one = groups.length === 1;
      $('dupeBannerTitle').textContent = one
        ? 'One card is listed twice'
        : `${groups.length} cards are listed more than once`;
      $('dupeBannerText').textContent =
        `${rows} separate rows describe ${one ? 'the same card' : `only ${groups.length} cards`}. ` +
        'Merging keeps every copy and all price history.';
      $('dupeBannerBtn').textContent = 'Review merge';
    }
  } catch {
    banner.hidden = true;
  }
}

function cardArt(card, cls) {
  const wrap = el('div', cls);
  if (card.image_url) {
    const img = el('img');
    img.loading = 'lazy';
    img.decoding = 'async';
    img.alt = card.card_name || 'Card';
    img.src = card.image_url;
    img.addEventListener('error', () => { img.replaceWith(cardPlaceholder()); }, { once: true });
    wrap.appendChild(img);
  } else if (card.has_local_image) {
    const img = el('img');
    img.loading = 'lazy';
    img.alt = card.card_name || 'Card';
    img.dataset.localFor = card.id;
    wrap.appendChild(img);
  } else {
    wrap.appendChild(cardPlaceholder());
  }
  return wrap;
}

/** Scan photos live in the database as base64; fetch them only once on screen. */
function hydrateLocalImages(root) {
  root.querySelectorAll('img[data-local-for]').forEach((img) => {
    if (img.dataset.hydrated) return;
    img.dataset.hydrated = '1';
    fetch(`/api/portfolio/${img.dataset.localFor}/image`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d?.image_data) img.src = d.image_data; else img.replaceWith(cardPlaceholder()); })
      .catch(() => img.replaceWith(cardPlaceholder()));
  });
}

function sparkline(history) {
  const prices = (history || []).map((p) => Number(p.price)).filter((p) => p > 0).slice(-24);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '78');
  svg.setAttribute('height', '26');
  svg.setAttribute('viewBox', '0 0 78 26');

  if (prices.length < 2) {
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', '2'); line.setAttribute('y1', '13');
    line.setAttribute('x2', '76'); line.setAttribute('y2', '13');
    line.setAttribute('stroke', 'currentColor');
    line.setAttribute('stroke-opacity', '0.25');
    line.setAttribute('stroke-dasharray', '3 3');
    svg.appendChild(line);
    return svg;
  }

  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 1;
  const points = prices.map((p, i) => {
    const x = 2 + (i / (prices.length - 1)) * 74;
    const y = 3 + (1 - (p - min) / range) * 20;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  path.setAttribute('points', points);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', prices[prices.length - 1] >= prices[0] ? 'var(--up)' : 'var(--down)');
  path.setAttribute('stroke-width', '1.6');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(path);
  return svg;
}

function renderCollection() {
  const host = $('collectionBody');
  host.innerHTML = '';
  const cards = visibleCards();

  if (!state.cards.length) {
    host.appendChild(emptyState(
      icon('card'),
      'No cards yet',
      'Point your camera at a card and it will be identified, priced and added in a couple of seconds.',
      'Scan your first card',
      openScanner,
    ));
    return;
  }

  if (!cards.length) {
    host.appendChild(emptyState(icon('search'), 'Nothing matches that', `No cards match “${state.query}”.`));
    return;
  }

  host.appendChild(state.layout === 'grid' ? gridOf(cards) : listOf(cards));
  hydrateLocalImages(host);
}

function emptyState(glyph, title, text, actionLabel, onAction) {
  const box = el('div', 'empty glass');
  const iconWrap = el('div', 'empty-icon');
  iconWrap.appendChild(glyph);
  box.append(iconWrap, el('h2', null, title), el('p', null, text));
  if (actionLabel) {
    const btn = el('button', 'btn btn-primary', actionLabel);
    btn.addEventListener('click', onAction);
    box.appendChild(btn);
  }
  return box;
}

function gridOf(cards) {
  const grid = el('div', 'grid');
  for (const card of cards) {
    const change = pct(card.unit_price, card.prev_day_price);
    const btn = el('button', 'card glass glass-tap');
    btn.addEventListener('click', () => openSheet(card.id));

    const art = cardArt(card, 'card-art');
    if (card.quantity > 1) art.appendChild(el('div', 'qty', `×${card.quantity}`));

    // Only traits that single a card out. Nearly every card in a collection is
    // holo, so a "Holo" badge on all of them says nothing and just adds noise —
    // the printing is on the card's detail sheet where it matters.
    const flags = el('div', 'card-flags');
    if (card.needs_review) flags.appendChild(el('span', 'flag flag-review', 'Review'));
    if (card.is_first_edition) flags.appendChild(el('span', 'flag flag-1st', '1st Ed'));
    if (flags.children.length) art.appendChild(flags);

    const body = el('div', 'card-body');
    body.append(
      el('div', 'card-name', card.card_name || 'Unknown'),
      // Number first: it is short and it identifies the printing, so when the
      // line truncates the useful half survives.
      el('div', 'card-meta', [card.card_number, card.card_set].filter(Boolean).join(' · ') || '—'),
    );

    const priceRow = el('div', 'card-price-row');
    if (card.unit_price > 0) {
      priceRow.append(el('span', 'card-price', money(card.total_value)));
      priceRow.append(el('span', `card-delta ${trendClass(change)}`, trendText(change)));
    } else {
      priceRow.append(el('span', 'card-price unpriced', card.needs_review ? 'Needs review' : 'No price found'));
    }
    body.appendChild(priceRow);

    if (card.quantity > 1 && card.unit_price > 0) {
      body.appendChild(el('div', 'card-unit', `${card.quantity} copies · ${money(card.unit_price)} each`));
    }

    btn.append(art, body);
    grid.appendChild(btn);
  }
  return grid;
}

function listOf(cards) {
  const list = el('div', 'list glass');

  const head = el('div', 'row row-head');
  head.append(el('div'), el('div', null, 'Card'), el('div', 'row-set', 'Set'), el('div', 'row-qty', 'Qty'),
    el('div', 'row-num', 'Value'), el('div', 'row-delta', '24h'), el('div', 'row-spark'));
  list.appendChild(head);

  for (const card of cards) {
    const change = pct(card.unit_price, card.prev_day_price);
    const row = el('button', 'row');
    row.addEventListener('click', () => openSheet(card.id));

    row.appendChild(cardArt(card, 'row-thumb'));

    const nameCell = el('div');
    nameCell.append(el('div', 'row-name', card.card_name || 'Unknown'));
    const bits = [card.card_number, card.rarity].filter(Boolean).join(' · ');
    nameCell.append(el('div', 'row-sub', card.needs_review ? 'Needs review' : bits || '—'));
    row.appendChild(nameCell);

    row.appendChild(el('div', 'row-set', card.card_set || '—'));
    row.appendChild(el('div', 'row-qty', card.quantity > 1 ? `×${card.quantity}` : '1'));
    row.appendChild(el('div', 'row-num', card.unit_price > 0 ? money(card.total_value) : '—'));
    row.appendChild(el('div', `row-delta ${trendClass(change)}`, trendText(change)));

    const spark = el('div', 'row-spark');
    spark.appendChild(sparkline(card.price_history));
    row.appendChild(spark);

    list.appendChild(row);
  }
  return list;
}

/**
 * The collection grouped by set — the closest thing here to a Pokédex page.
 * Tapping a set searches for it, which reuses the filtering the grid already
 * does rather than inventing a second way to narrow the collection.
 */
function renderSets() {
  const host = $('setsBody');
  host.innerHTML = '';

  const groups = new Map();
  for (const card of state.cards) {
    if (card.needs_review) continue;
    const name = card.card_set || 'Unknown set';
    if (!groups.has(name)) groups.set(name, { name, cards: [], copies: 0, value: 0 });
    const g = groups.get(name);
    g.cards.push(card);
    g.copies += card.quantity;
    g.value += card.total_value;
  }

  let sets = [...groups.values()].sort((a, b) => b.value - a.value);
  if (state.query) sets = sets.filter(g => g.name.toLowerCase().includes(state.query));

  if (state.query && !sets.length) {
    host.appendChild(emptyState(icon('search'), 'No sets match that', `Nothing matches “${state.query}”.`));
    return;
  }

  if (!sets.length) {
    host.appendChild(emptyState(icon('card'), 'No sets yet',
      'Scan a few cards and they will be grouped by the set they came from.',
      'Scan a card', openScanner));
    return;
  }

  const wrap = el('div', 'sets');
  for (const g of sets) {
    const row = el('button', 'set glass glass-tap');
    row.addEventListener('click', () => {
      state.query = g.name.toLowerCase();
      $('searchInput').value = g.name;
      showView('collection');
    });

    // Three highest-value cards, fanned like cards in a sleeve.
    const stack = el('div', 'set-stack');
    for (const card of [...g.cards].sort((a, b) => b.total_value - a.total_value).slice(0, 3)) {
      const chip = el('div', 'chip');
      if (card.image_url) {
        const img = el('img');
        img.loading = 'lazy';
        img.alt = '';
        img.src = card.image_url;
        img.addEventListener('error', () => img.remove(), { once: true });
        chip.appendChild(img);
      }
      stack.appendChild(chip);
    }
    row.appendChild(stack);

    const body = el('div', 'set-body');
    body.append(
      el('div', 'set-name', g.name),
      el('div', 'set-meta', `${g.cards.length} unique · ${g.copies} card${g.copies === 1 ? '' : 's'} held`),
    );
    row.appendChild(body);

    const figures = el('div', 'set-figures');
    figures.append(
      el('div', 'set-value', money(g.value)),
      el('div', 'set-count', `${((g.value / (state.stats.totalValue || 1)) * 100).toFixed(0)}% of value`),
    );
    row.appendChild(figures);

    wrap.appendChild(row);
  }
  host.appendChild(wrap);

  const navSets = $('navSetsCount');
  if (navSets) navSets.textContent = sets.length;
}

function renderReview() {
  const host = $('reviewBody');
  host.innerHTML = '';
  const cards = visibleCards();
  if (!cards.length) {
    host.appendChild(emptyState(icon('check'), 'Nothing to review', 'Every card we scanned was matched to the card database.'));
    return;
  }
  host.appendChild(gridOf(cards));
  hydrateLocalImages(host);
}

// ── CARD SHEET ───────────────────────────────────────────────────

const sheet = $('sheet');
const scrim = $('scrim');

function cardById(id) { return state.cards.find((c) => c.id === id); }

/**
 * A card carrying a price but no confidence was priced by the old engine, which
 * recorded no provenance. The price may well be right; we simply cannot show
 * where it came from until it is re-priced.
 */
function isUnverifiedPrice(card) {
  return card.unit_price > 0 && !(Number(card.price_confidence) > 0);
}

async function repriceCard(cardId, button) {
  const original = button?.textContent;
  if (button) { button.disabled = true; button.textContent = 'Checking market…'; }
  try {
    const result = await api(`/api/portfolio/${cardId}/reprice`, { method: 'POST' });
    if (result.price > 0) {
      toast(`${money(result.price)} from ${result.quotesUsed} source${result.quotesUsed === 1 ? '' : 's'}`, 'success');
    } else {
      toast('No marketplace has a price for this printing right now', 'info', 5000);
    }
    await loadCollection();
    if (state.openCardId === cardId) renderSheetBody();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    if (button) { button.disabled = false; button.textContent = original; }
  }
}

function openSheet(id) {
  const card = cardById(id);
  if (!card) return;
  state.openCardId = id;
  state.chartDays = 30;

  $('sheetTitle').textContent = card.card_name || 'Unknown card';
  $('sheetSub').textContent = [card.card_set, card.card_number, card.rarity].filter(Boolean).join(' · ') || '—';

  renderSheetBody();
  sheet.classList.add('open');
  sheet.setAttribute('aria-hidden', 'false');
  scrim.classList.add('open');
  document.body.style.overflow = 'hidden';

  loadPriceDetail(id);
  loadChart(id);
}

function closeSheet() {
  state.openCardId = null;
  sheet.classList.remove('open');
  sheet.setAttribute('aria-hidden', 'true');
  scrim.classList.remove('open');
  sheet.style.transform = '';
  document.body.style.overflow = '';
}

$('sheetCloseBtn').addEventListener('click', closeSheet);
scrim.addEventListener('click', closeSheet);
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if ($('scanner').classList.contains('open')) closeScanner();
  else if (document.querySelector('.modal.open')) closeModals();
  else if (state.openCardId) closeSheet();
});

function renderSheetBody() {
  const card = cardById(state.openCardId);
  const body = $('sheetBody');
  body.innerHTML = '';
  if (!card) return;

  // Hero: value, what it is made of, and how much to trust it.
  const hero = el('div', 'sheet-hero');
  hero.appendChild(cardArt(card, 'sheet-art'));

  const figures = el('div', 'sheet-figures');
  figures.append(el('div', 'figure-label', card.quantity > 1 ? `${card.quantity} copies worth` : 'Market value'));
  figures.append(el('div', 'figure-value', card.unit_price > 0 ? money(card.total_value) : '—'));

  if (card.unit_price > 0 && card.quantity > 1) {
    figures.append(el('div', 'figure-note', `${money(card.unit_price)} each at Near Mint, adjusted per copy below`));
  } else if (card.unit_price > 0) {
    figures.append(el('div', 'figure-note', `${money(card.unit_price)} Near Mint · adjusted for condition`));
  } else {
    figures.append(el('div', 'figure-note', card.needs_review
      ? 'Not priced — we could not confirm this card. Correct it and it will price itself.'
      : 'No market data found for this printing.'));
  }

  const pills = el('div', 'figure-pills');
  const conf = Number(card.price_confidence) || 0;

  if (card.unit_price > 0) {
    if (isUnverifiedPrice(card)) {
      // A price with no recorded provenance came from the old pipeline. It is
      // unverified, not zero-confidence — saying "0%" about a real price is a
      // lie in the other direction.
      pills.appendChild(el('span', 'pill pill-warn', 'Not verified yet'));
    } else {
      const level = conf >= 0.8 ? 'good' : conf >= 0.55 ? 'warn' : 'bad';
      const pill = el('span', `pill pill-${level}`);
      pill.append(el('span', 'pill-dot'), el('span', null, `${Math.round(conf * 100)}% confidence`));
      pills.appendChild(pill);
      if (card.price_marketplace) pills.appendChild(el('span', 'pill', sourceLabel(card.price_marketplace)));
      if (!card.price_variant_matched) pills.appendChild(el('span', 'pill pill-warn', 'Printing assumed'));
    }
  }
  if (card.needs_review) pills.appendChild(el('span', 'pill pill-warn', 'Unconfirmed card'));
  if (card.has_mixed_conditions) pills.appendChild(el('span', 'pill', 'Mixed conditions'));
  if (pills.children.length) figures.appendChild(pills);

  if (isUnverifiedPrice(card) || card.unit_price === 0) {
    const repriceBtn = el('button', 'btn btn-glass btn-sm', 'Re-price now');
    repriceBtn.style.marginTop = '10px';
    repriceBtn.addEventListener('click', () => repriceCard(card.id, repriceBtn));
    figures.appendChild(repriceBtn);
  }

  hero.appendChild(figures);
  body.appendChild(hero);

  // Copies
  const copiesPanel = el('div', 'panel glass');
  const copiesTitle = el('div', 'section-title');
  copiesTitle.append(el('span', null, `Copies you own (${card.quantity})`));
  const addBtn = el('button', 'btn btn-quiet btn-sm', '+ Add copy');
  addBtn.addEventListener('click', () => openCopyModal(card.id, null));
  copiesTitle.appendChild(addBtn);
  copiesPanel.appendChild(copiesTitle);

  const copies = el('div', 'copies');
  copies.style.marginTop = '11px';
  (card.copies || []).forEach((copy, i) => {
    const row = el('div', 'copy');
    row.append(el('div', 'copy-n', `#${i + 1}`));

    const main = el('div', 'copy-main');
    main.append(el('div', 'copy-cond', copy.grade ? `${copy.grade} (graded)` : (copy.condition || 'Unknown')));
    const notes = [];
    if (copy.manual_value > 0) notes.push('value set by hand');
    else if (!copy.grade && copy.condition && copy.condition !== 'Near Mint' && copy.condition !== 'Mint') notes.push('condition-adjusted');
    if (copy.acquired_price > 0) notes.push(`paid ${money(copy.acquired_price)}`);
    if (copy.notes) notes.push(copy.notes);
    if (notes.length) main.append(el('div', 'copy-note', notes.join(' · ')));
    row.appendChild(main);

    row.append(el('div', 'copy-val', copy.value > 0 ? money(copy.value) : '—'));

    const actions = el('div', 'copy-actions');
    if (copy.id) {
      const edit = el('button');
      edit.title = 'Edit this copy';
      edit.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>';
      edit.addEventListener('click', () => openCopyModal(card.id, copy));
      const del = el('button', 'danger');
      del.title = 'Remove this copy';
      del.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>';
      del.addEventListener('click', () => removeCopy(card, copy));
      actions.append(edit, del);
    }
    row.appendChild(actions);
    copies.appendChild(row);
  });
  copiesPanel.appendChild(copies);
  body.appendChild(copiesPanel);

  // Chart
  const chartPanel = el('div', 'panel glass');
  const chartTitle = el('div', 'section-title');
  chartTitle.append(el('span', null, 'Price history'));
  chartPanel.appendChild(chartTitle);

  const tabs = el('div', 'chart-tabs');
  tabs.style.marginTop = '10px';
  for (const [label, days] of [['7D', 7], ['30D', 30], ['90D', 90], ['All', 0]]) {
    const tab = el('button', days === state.chartDays ? 'active' : '', label);
    tab.addEventListener('click', () => {
      state.chartDays = days;
      tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === tab));
      loadChart(card.id);
    });
    tabs.appendChild(tab);
  }
  chartPanel.appendChild(tabs);
  const chartHost = el('div', 'chart-wrap');
  chartHost.id = 'chartHost';
  chartHost.appendChild(el('div', 'chart-empty', 'Loading…'));
  chartPanel.appendChild(chartHost);
  body.appendChild(chartPanel);

  // Where the price came from
  const sourcePanel = el('div', 'panel glass');
  sourcePanel.id = 'sourcePanel';
  sourcePanel.appendChild(el('div', 'section-title', 'Where this price comes from'));
  const sourceHost = el('div', 'sources');
  sourceHost.id = 'sourceHost';
  sourceHost.style.marginTop = '11px';
  sourceHost.appendChild(el('div', 'chart-empty', 'Loading…'));
  sourcePanel.appendChild(sourceHost);
  body.appendChild(sourcePanel);

  // Details
  const detailPanel = el('div', 'panel glass');
  detailPanel.appendChild(el('div', 'section-title', 'Card details'));
  const details = el('div', 'details');
  details.style.marginTop = '11px';
  const rows = [
    ['Set', card.card_set || '—'],
    ['Number', card.card_number || '—'],
    ['Rarity', card.rarity || '—'],
    ['Printing', card.holo_type || 'Unknown'],
    ['1st Edition', card.is_first_edition ? 'Yes' : 'No'],
    ['Language', card.language || '—'],
    ['Year', card.year ? String(card.year) : '—'],
    ['Price checked', timeAgo(card.last_price_check)],
  ];
  for (const [k, v] of rows) {
    const cell = el('div', 'detail');
    cell.append(el('div', 'detail-k', k), el('div', 'detail-v', v));
    details.appendChild(cell);
  }
  detailPanel.appendChild(details);
  body.appendChild(detailPanel);

  const removeBtn = el('button', 'btn btn-glass btn-danger btn-block', 'Remove this card entirely');
  removeBtn.addEventListener('click', () => removeCard(card));
  body.appendChild(removeBtn);

  hydrateLocalImages(body);
}

async function loadPriceDetail(cardId) {
  const host = $('sourceHost');
  if (!host) return;
  try {
    const data = await api(`/api/portfolio/${cardId}/prices`);
    if (state.openCardId !== cardId) return;
    host.innerHTML = '';

    const entries = Object.entries(data.sources || {});
    if (!entries.length) {
      host.appendChild(el('div', 'chart-empty', 'No market quotes were recorded for this card yet.'));
      return;
    }

    for (const [key, s] of entries) {
      const row = el('div', `source-row${s.used ? '' : ' unused'}`);
      const name = el('div', 'source-name', sourceLabel(key));
      row.appendChild(name);
      if (s.currency && s.currency !== 'USD') {
        row.appendChild(el('span', 'source-native', `${s.nativePrice} ${s.currency}`));
      }
      if (!s.variantMatched) row.appendChild(el('span', 'pill pill-warn', 'other printing'));
      row.appendChild(el('div', 'source-price', money(s.price)));
      host.appendChild(row);
    }

    const summary = el('div', 'copy-note');
    summary.style.marginTop = '4px';
    const bits = [];
    if (data.low && data.high && data.low !== data.high) bits.push(`Sources ranged ${money(data.low)}–${money(data.high)}`);
    if (data.variant) bits.push(`priced as ${data.variant}`);
    bits.push(`checked ${timeAgo(data.checkedAt)}`);
    summary.textContent = bits.join(' · ');
    host.appendChild(summary);

    if (data.priceSourceUrl) {
      const link = el('a', 'pill', 'Open on the marketplace ↗');
      link.href = data.priceSourceUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.style.marginTop = '6px';
      link.style.alignSelf = 'flex-start';
      host.appendChild(link);
    }
  } catch {
    host.innerHTML = '';
    host.appendChild(el('div', 'chart-empty', 'Could not load the price breakdown.'));
  }
}

async function loadChart(cardId) {
  const host = $('chartHost');
  if (!host) return;
  try {
    const data = await api(`/api/portfolio/${cardId}/history`);
    if (state.openCardId !== cardId) return;

    let points = (data.history || []).map((h) => ({ t: new Date(h.recorded_at).getTime(), v: Number(h.price) }))
      .filter((p) => p.v > 0 && Number.isFinite(p.t));

    if (state.chartDays > 0) {
      const cutoff = Date.now() - state.chartDays * 86400000;
      const windowed = points.filter((p) => p.t >= cutoff);
      if (windowed.length >= 2) points = windowed;
    }

    host.innerHTML = '';
    host.appendChild(points.length >= 2
      ? lineChart(points)
      : el('div', 'chart-empty', 'Only one price recorded so far. The chart fills in as daily prices are collected.'));
  } catch {
    host.innerHTML = '';
    host.appendChild(el('div', 'chart-empty', 'Could not load price history.'));
  }
}

/** Small dependency-free area chart — no CDN, themes with CSS variables. */
function lineChart(points) {
  const NS = 'http://www.w3.org/2000/svg';
  const W = 320, H = 148, PAD_X = 4, PAD_Y = 10;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'chart-svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'none');

  const values = points.map((p) => p.v);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || Math.max(max * 0.1, 1);
  const x = (i) => PAD_X + (i / (points.length - 1)) * (W - PAD_X * 2);
  const y = (v) => PAD_Y + (1 - (v - min) / range) * (H - PAD_Y * 2);

  const rising = values[values.length - 1] >= values[0];
  const stroke = rising ? 'var(--up)' : 'var(--down)';
  const id = `g${Math.random().toString(36).slice(2, 8)}`;

  const defs = document.createElementNS(NS, 'defs');
  const grad = document.createElementNS(NS, 'linearGradient');
  grad.setAttribute('id', id);
  grad.setAttribute('x1', '0'); grad.setAttribute('y1', '0');
  grad.setAttribute('x2', '0'); grad.setAttribute('y2', '1');
  const s1 = document.createElementNS(NS, 'stop');
  s1.setAttribute('offset', '0%'); s1.setAttribute('stop-color', stroke); s1.setAttribute('stop-opacity', '0.28');
  const s2 = document.createElementNS(NS, 'stop');
  s2.setAttribute('offset', '100%'); s2.setAttribute('stop-color', stroke); s2.setAttribute('stop-opacity', '0');
  grad.append(s1, s2);
  defs.appendChild(grad);
  svg.appendChild(defs);

  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.v).toFixed(1)}`).join(' ');

  const area = document.createElementNS(NS, 'path');
  area.setAttribute('d', `${line} L${x(points.length - 1).toFixed(1)} ${H} L${x(0).toFixed(1)} ${H} Z`);
  area.setAttribute('fill', `url(#${id})`);
  svg.appendChild(area);

  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', line);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', stroke);
  path.setAttribute('stroke-width', '2');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  path.setAttribute('vector-effect', 'non-scaling-stroke');
  svg.appendChild(path);

  const dot = document.createElementNS(NS, 'circle');
  dot.setAttribute('cx', x(points.length - 1).toFixed(1));
  dot.setAttribute('cy', y(values[values.length - 1]).toFixed(1));
  dot.setAttribute('r', '3');
  dot.setAttribute('fill', stroke);
  svg.appendChild(dot);

  const wrap = el('div');
  wrap.appendChild(svg);
  const legend = el('div', 'copy-note');
  legend.style.marginTop = '6px';
  legend.textContent = `${money(min)} – ${money(max)} over ${points.length} recorded price${points.length === 1 ? '' : 's'}`;
  wrap.appendChild(legend);
  return wrap;
}

// Drag-to-dismiss on mobile, the way a native sheet behaves.
(function enableSheetDrag() {
  let startY = 0;
  let delta = 0;
  let dragging = false;

  const start = (e) => {
    if (window.innerWidth > 860) return;
    dragging = true;
    delta = 0;
    startY = e.touches ? e.touches[0].clientY : e.clientY;
    sheet.classList.add('dragging');
  };
  const move = (e) => {
    if (!dragging) return;
    const y = e.touches ? e.touches[0].clientY : e.clientY;
    delta = Math.max(0, y - startY);
    sheet.style.transform = `translateY(${delta}px)`;
  };
  const end = () => {
    if (!dragging) return;
    dragging = false;
    sheet.classList.remove('dragging');
    sheet.style.transform = '';
    if (delta > 110) closeSheet();
  };

  for (const node of [$('sheetHead'), $('sheetGrip')]) {
    node.addEventListener('touchstart', start, { passive: true });
    node.addEventListener('touchmove', move, { passive: true });
    node.addEventListener('touchend', end);
  }
})();

// ── COPIES ───────────────────────────────────────────────────────

let copyContext = { cardId: null, copyId: null };

function openCopyModal(cardId, copy) {
  copyContext = { cardId, copyId: copy?.id || null };
  $('copyModalTitle').textContent = copy ? 'Edit this copy' : 'Add another copy';

  const select = $('copyCondition');
  select.innerHTML = '';
  const conditions = state.pricing?.conditions?.length
    ? state.pricing.conditions
    : ['Mint', 'Near Mint', 'Lightly Played', 'Moderately Played', 'Heavily Played', 'Damaged', 'Unknown'];
  for (const c of conditions) {
    const opt = el('option', null, c);
    opt.value = c;
    select.appendChild(opt);
  }
  select.value = copy?.condition || 'Near Mint';

  $('copyGrade').value = copy?.grade || '';
  $('copyPaid').value = copy?.acquired_price > 0 ? copy.acquired_price : '';
  $('copyManual').value = copy?.manual_value > 0 ? copy.manual_value : '';
  $('copyNotes').value = copy?.notes || '';

  openModal('copyModal');
}

$('copySaveBtn').addEventListener('click', async () => {
  const payload = {
    condition: $('copyCondition').value,
    grade: $('copyGrade').value.trim(),
    acquired_price: Number($('copyPaid').value) || 0,
    manual_value: Number($('copyManual').value) || 0,
    notes: $('copyNotes').value.trim(),
  };
  try {
    if (copyContext.copyId) {
      await api(`/api/portfolio/copies/${copyContext.copyId}`, { method: 'PATCH', body: JSON.stringify(payload) });
      toast('Copy updated', 'success');
    } else {
      await api(`/api/portfolio/${copyContext.cardId}/copies`, { method: 'POST', body: JSON.stringify(payload) });
      toast('Copy added', 'success');
    }
    closeModals();
    await loadCollection();
    if (state.openCardId) renderSheetBody();
  } catch (err) {
    toast(err.message, 'error');
  }
});

async function removeCopy(card, copy) {
  const last = card.quantity <= 1;
  const question = last
    ? `Remove the last copy of ${card.card_name}? This removes the card from your collection.`
    : `Remove one copy of ${card.card_name}? You will have ${card.quantity - 1} left.`;
  if (!confirm(question)) return;

  try {
    const result = await api(`/api/portfolio/copies/${copy.id}`, { method: 'DELETE' });
    toast(result.cardRemoved ? 'Card removed' : 'Copy removed', 'success');
    if (result.cardRemoved) closeSheet();
    await loadCollection();
    if (state.openCardId) renderSheetBody();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function removeCard(card) {
  if (!confirm(`Remove ${card.card_name} and all ${card.quantity} cop${card.quantity === 1 ? 'y' : 'ies'} from your collection?`)) return;
  try {
    await api(`/api/portfolio/${card.id}`, { method: 'DELETE' });
    toast('Card removed', 'success');
    closeSheet();
    await loadCollection();
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ── EDIT CARD ────────────────────────────────────────────────────

$('sheetEditBtn').addEventListener('click', () => {
  const card = cardById(state.openCardId);
  if (!card) return;
  $('editName').value = card.card_name || '';
  $('editSet').value = card.card_set || '';
  $('editNumber').value = card.card_number || '';
  $('editHolo').value = ['Unknown', 'Non-Holo', 'Holofoil', 'Reverse Holo', 'Cosmos Holo'].includes(card.holo_type)
    ? card.holo_type : 'Unknown';
  $('editLanguage').value = card.language || 'English';
  $('editFirstEd').checked = Boolean(card.is_first_edition);
  openModal('editModal');
});

$('editSaveBtn').addEventListener('click', async () => {
  const id = state.openCardId;
  if (!id) return;
  const btn = $('editSaveBtn');
  btn.disabled = true;
  btn.textContent = 'Re-pricing…';
  try {
    const holo = $('editHolo').value;
    const result = await api(`/api/portfolio/${id}/edit`, {
      method: 'POST',
      body: JSON.stringify({
        card_name: $('editName').value.trim(),
        card_set: $('editSet').value.trim(),
        card_number: $('editNumber').value.trim(),
        holo_type: holo,
        language: $('editLanguage').value.trim() || 'English',
        is_first_edition: $('editFirstEd').checked,
        is_holo: holo === 'Holofoil' || holo === 'Reverse Holo' || holo === 'Cosmos Holo',
      }),
    });
    closeModals();
    toast(result.price > 0 ? `Re-priced at ${money(result.price)}` : 'Saved, but no market price was found', result.price > 0 ? 'success' : 'info');
    await loadCollection();
    if (state.openCardId) {
      const card = cardById(state.openCardId);
      if (card) openSheet(card.id); else closeSheet();
    }
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save & re-price';
  }
});

// ── MODALS ───────────────────────────────────────────────────────

function openModal(id) {
  $(id).classList.add('open');
  $(id).setAttribute('aria-hidden', 'false');
  scrim.classList.add('open');
}

function closeModals() {
  document.querySelectorAll('.modal.open').forEach((m) => {
    m.classList.remove('open');
    m.setAttribute('aria-hidden', 'true');
  });
  if (!state.openCardId) scrim.classList.remove('open');
}

document.querySelectorAll('[data-close-modal]').forEach((b) => b.addEventListener('click', closeModals));

// ── MERGE DUPLICATES ─────────────────────────────────────────────

$('openMergeBtn').addEventListener('click', openMergeModal);
$('dupeBannerBtn').addEventListener('click', openMergeModal);

async function openMergeModal() {
  openModal('mergeModal');
  const body = $('mergeBody');
  body.innerHTML = '';
  $('mergeIntro').textContent = 'Checking your collection…';
  $('mergeConfirmBtn').disabled = true;

  try {
    const { groups } = await api('/api/portfolio/duplicates');
    body.innerHTML = '';

    if (!groups.length) {
      $('mergeIntro').textContent = 'Nothing to merge — every printing already sits on a single card.';
      return;
    }

    const rows = groups.reduce((sum, g) => sum + g.row_count, 0);
    const one = groups.length === 1;
    $('mergeIntro').textContent =
      `${one ? 'One printing is' : `${groups.length} printings are`} split across ${rows} separate rows. ` +
      'Merging keeps every copy and all price history, and puts them under one card.';

    for (const g of groups) {
      const row = el('label', 'dupe-group');
      const box = el('input');
      box.type = 'checkbox';
      box.checked = true;
      box.value = g.variant_key;
      row.appendChild(box);

      const info = el('div', 'dupe-group-body');
      info.append(el('div', 'dupe-group-name', g.card_name || 'Unknown'));
      info.append(el('div', 'dupe-group-meta', [g.card_set, g.card_number].filter(Boolean).join(' · ') || '—'));
      row.appendChild(info);

      row.appendChild(el('div', 'dupe-group-count', `${g.row_count} rows → 1`));
      body.appendChild(row);
    }

    $('mergeConfirmBtn').disabled = false;
  } catch (err) {
    $('mergeIntro').textContent = `Could not check for duplicates: ${err.message}`;
  }
}

$('mergeConfirmBtn').addEventListener('click', async () => {
  const keys = [...$('mergeBody').querySelectorAll('input:checked')].map((i) => i.value);
  if (!keys.length) { toast('Nothing selected', 'info'); return; }

  const btn = $('mergeConfirmBtn');
  btn.disabled = true;
  btn.textContent = 'Merging…';
  try {
    const result = await api('/api/portfolio/merge-duplicates', {
      method: 'POST',
      body: JSON.stringify({ confirm: true, variantKeys: keys }),
    });
    closeModals();
    toast(`Merged ${result.mergedGroups} card${result.mergedGroups === 1 ? '' : 's'}, ${result.removedRows} duplicate rows folded in`, 'success');
    await loadCollection();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Merge selected';
  }
});

// ── REFRESH ──────────────────────────────────────────────────────

async function refreshPrices(button) {
  const original = button?.textContent;
  if (button) { button.disabled = true; button.textContent = 'Refreshing…'; }
  try {
    await api('/api/portfolio/refresh-prices', { method: 'POST' });
    toast('Refreshing prices in the background', 'info');
    setTimeout(loadCollection, 6000);
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    if (button) { button.disabled = false; button.textContent = original; }
  }
}

$('refreshBtn').addEventListener('click', (e) => refreshPrices(e.currentTarget));
$('settingsRefreshBtn').addEventListener('click', (e) => refreshPrices(e.currentTarget));
$('unverifiedBannerBtn').addEventListener('click', (e) => refreshPrices(e.currentTarget));

// ── TRACKING STATUS ──────────────────────────────────────────────

const whenFrom = (ts) => {
  if (!ts) return 'never';
  const diff = new Date(ts).getTime() - Date.now();
  const hours = Math.round(Math.abs(diff) / 3600000);
  const label = hours < 48 ? `${hours}h` : `${Math.round(hours / 24)} days`;
  return diff > 0 ? `in ${label}` : `${label} ago`;
};

async function loadHealth() {
  const host = $('healthBody');
  if (!host) return;
  try {
    const h = await api('/api/health');
    host.innerHTML = '';
    host.className = '';

    const live = h.sources.filter((s) => s.live);
    const rows = [
      ['Price sources live', `${live.length} of ${h.sources.length} — ${live.map((s) => s.name).join(', ')}`,
        live.length >= 3 ? 'good' : 'warn'],
      ['Prices last refreshed', h.schedule.lastRefreshAt ? whenFrom(h.schedule.lastRefreshAt) : 'not yet — first run is due',
        h.schedule.lastRefreshAt ? 'good' : 'warn'],
      ['Next automatic refresh', h.schedule.running ? 'running now'
        : h.schedule.overdue ? 'due — starts within 15 minutes'
        : whenFrom(h.schedule.nextRefreshAt), 'good'],
      ['Refresh frequency', `every ${h.schedule.everyDays} day${h.schedule.everyDays === 1 ? '' : 's'}`, 'good'],
      ['Cards with a verified price', `${h.cards.verified} of ${h.cards.total}`,
        h.cards.verified === h.cards.total ? 'good' : 'warn'],
    ];

    // Label above value: these values are sentences, not figures, and squeezing
    // them into a right-aligned column truncates the labels on a phone.
    for (const [label, value, tone] of rows) {
      const row = el('div', 'health-row');
      row.append(el('div', 'health-label', label));
      const v = el('div', 'health-value', value);
      if (tone === 'warn') v.classList.add('warn');
      row.appendChild(v);
      host.appendChild(row);
    }

    const missing = h.sources.filter((s) => !s.live);
    if (missing.length) {
      const note = el('div', 'field-hint');
      note.style.marginTop = '10px';
      note.textContent =
        `More sources make each price more reliable. Still to add: ${missing.map((s) => s.key).join(', ')} ` +
        '— set them as environment variables on your host and redeploy.';
      host.appendChild(note);
    }
  } catch (err) {
    host.textContent = `Could not load tracking status: ${err.message}`;
  }
}

// ── PRICE HISTORY AUDIT ──────────────────────────────────────────

$('auditHistoryBtn').addEventListener('click', openAuditModal);

async function openAuditModal() {
  openModal('auditModal');
  const body = $('auditBody');
  body.innerHTML = '';
  $('auditIntro').textContent = 'Checking…';
  $('auditPurgeBtn').disabled = true;

  try {
    const audit = await api('/api/portfolio/history-audit');
    body.innerHTML = '';

    if (!audit.pointCount) {
      $('auditIntro').textContent =
        `All ${audit.totalPoints} recorded prices look genuine. Nothing to clean up.`;
      return;
    }

    $('auditIntro').textContent =
      `${audit.pointCount} of ${audit.totalPoints} recorded prices were invented rather than observed — ` +
      'they sit exactly 24 hours apart, which is the signature of the old backfill script. ' +
      'Deleting them leaves only real prices, so charts will look sparse until they fill in again.';

    for (const c of audit.cards) {
      const row = el('div', 'dupe-group');
      const info = el('div', 'dupe-group-body');
      info.append(el('div', 'dupe-group-name', c.card_name || 'Unknown'));
      info.append(el('div', 'dupe-group-meta', `${c.total} recorded prices`));
      row.append(info, el('div', 'dupe-group-count', `${c.fabricated} invented`));
      body.appendChild(row);
    }

    $('auditPurgeBtn').disabled = false;
  } catch (err) {
    $('auditIntro').textContent = `Could not check price history: ${err.message}`;
  }
}

$('auditPurgeBtn').addEventListener('click', async () => {
  if (!confirm('Delete every invented price point? Charts will only show prices actually recorded from here on.')) return;
  const btn = $('auditPurgeBtn');
  btn.disabled = true;
  btn.textContent = 'Deleting…';
  try {
    const result = await api('/api/portfolio/purge-synthetic-history', {
      method: 'POST',
      body: JSON.stringify({ confirm: true }),
    });
    closeModals();
    toast(`Removed ${result.deleted} invented price points`, 'success');
    await loadCollection();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Delete invented points';
  }
});

// ═══════════════════════════════════════════════════════════════
//  SCANNER
// ═══════════════════════════════════════════════════════════════

const scanner = $('scanner');
const video = $('cameraVideo');
const canvas = $('captureCanvas');

let stream = null;
let facing = 'environment';
let torchOn = false;
let capturing = false;

function openScanner() {
  scanner.classList.add('open');
  document.body.style.overflow = 'hidden';
  state.scanned = [];
  renderTray();
  startCamera();
}

function closeScanner() {
  scanner.classList.remove('open');
  document.body.style.overflow = '';
  stopCamera();
  setTrayOpen(false);
  hideHit();

  const saved = state.scanned.filter((s) => s.status === 'ok' || s.status === 'dupe');
  if (saved.length) loadCollection();

  // Unconfirmed cards live in the Review tab, so the collection can look
  // unchanged after a scan. Say where they went rather than leave you guessing.
  const pending = saved.filter((s) => s.needsReview).length;
  if (pending) {
    toast(`${pending} card${pending === 1 ? '' : 's'} need${pending === 1 ? 's' : ''} confirming — see Needs review`, 'info', 6000);
  }
}

$('scannerCloseBtn').addEventListener('click', closeScanner);

async function startCamera() {
  hideScannerMessage();
  if (!navigator.mediaDevices?.getUserMedia) {
    showScannerMessage(icon('camera'), 'Live camera not supported',
      'This browser cannot open a live viewfinder. You can still use your phone’s camera app or pick a photo.');
    return;
  }

  try {
    stopCamera();
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: facing }, width: { ideal: 2560 }, height: { ideal: 1440 } },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();

    const track = stream.getVideoTracks()[0];
    const caps = track.getCapabilities?.() || {};
    $('torchBtn').hidden = !caps.torch;

    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      $('flipBtn').hidden = devices.filter((d) => d.kind === 'videoinput').length < 2;
    } catch { /* device list is not essential */ }

    startAimAssist();
  } catch (err) {
    const denied = err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError';
    showScannerMessage(
      denied ? icon('lock') : icon('camera'),
      denied ? 'Camera access blocked' : 'No camera available',
      denied
        ? 'Allow camera access for this site in your browser settings, or use your phone’s camera app instead.'
        : 'We could not open a camera on this device. Your phone’s camera app and photo library still work.',
    );
  }
}

function stopCamera() {
  stopAimAssist();
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  video.srcObject = null;
  torchOn = false;
  $('torchBtn').classList.remove('active');
}

function showScannerMessage(glyph, title, text) {
  const iconHost = $('scannerMsgIcon');
  iconHost.innerHTML = '';
  iconHost.appendChild(glyph);
  $('scannerMsgTitle').textContent = title;
  $('scannerMsgText').textContent = text;
  $('scannerMsg').classList.add('show');
}

function hideScannerMessage() { $('scannerMsg').classList.remove('show'); }

$('scannerRetryBtn').addEventListener('click', startCamera);
$('scannerNativeBtn').addEventListener('click', () => $('nativeCameraInput').click());
$('scannerPickBtn').addEventListener('click', () => $('libraryInput').click());
$('pickBtn').addEventListener('click', () => $('libraryInput').click());

$('torchBtn').addEventListener('click', async () => {
  if (!stream) return;
  const track = stream.getVideoTracks()[0];
  try {
    torchOn = !torchOn;
    await track.applyConstraints({ advanced: [{ torch: torchOn }] });
    $('torchBtn').classList.toggle('active', torchOn);
  } catch {
    torchOn = false;
    $('torchBtn').classList.remove('active');
    toast('This camera has no controllable torch', 'info');
  }
});

$('flipBtn').addEventListener('click', () => {
  facing = facing === 'environment' ? 'user' : 'environment';
  startCamera();
});

/**
 * Aim assist. Samples the centre of the frame and reports how much fine detail
 * is present: a blurred or empty frame has little, a sharp card in focus has a
 * lot. It only colours the guide and updates the hint — it never blocks a
 * capture, because a hard gate on a heuristic is worse than no gate.
 */
let aimTimer = null;
const aimCanvas = document.createElement('canvas');

function startAimAssist() {
  stopAimAssist();
  aimCanvas.width = 96;
  aimCanvas.height = 96;
  const ctx = aimCanvas.getContext('2d', { willReadFrequently: true });

  aimTimer = setInterval(() => {
    if (!video.videoWidth) return;
    const side = Math.min(video.videoWidth, video.videoHeight) * 0.5;
    ctx.drawImage(video,
      (video.videoWidth - side) / 2, (video.videoHeight - side) / 2, side, side,
      0, 0, 96, 96);

    const { data } = ctx.getImageData(0, 0, 96, 96);
    let sum = 0;
    let sumSq = 0;
    const n = 96 * 96;
    for (let i = 0; i < data.length; i += 4) {
      const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      sum += lum;
      sumSq += lum * lum;
    }
    const mean = sum / n;
    const variance = sumSq / n - mean * mean;

    const dark = mean < 42;
    const sharp = variance > 480;
    scanner.classList.toggle('aim-ok', sharp && !dark);
    $('guideHint').textContent = dark
      ? 'Too dark — try the torch'
      : sharp ? 'Looks good — tap to capture' : 'Fill the frame with one card';
  }, 420);
}

function stopAimAssist() {
  if (aimTimer) clearInterval(aimTimer);
  aimTimer = null;
  scanner.classList.remove('aim-ok');
}

/**
 * Capture. The frame is cropped to the on-screen guide rectangle before upload.
 *
 * This matters more than it sounds: `object-fit: cover` means the video is
 * cropped on screen, so the guide covers a different part of the sensor image
 * than it appears to. Sending the whole frame instead hands the model the table,
 * the binder and your hand along with the card, which is a common cause of
 * misreads.
 */
const CROP_PAD = 0.04; // a little context around the card helps, a lot hurts

/**
 * Pure geometry: given the sensor size, the on-screen stage and the guide
 * rectangle, work out which part of the sensor image the guide is covering.
 * Kept separate from the DOM so it can be tested with plain numbers.
 */
function mapGuideToSource({ videoW, videoH, stage, frame, pad = CROP_PAD }) {
  if (!videoW || !videoH || !stage.width || !stage.height) return null;

  const scale = Math.max(stage.width / videoW, stage.height / videoH);
  const offsetX = (stage.width - videoW * scale) / 2;
  const offsetY = (stage.height - videoH * scale) / 2;

  let sx = (frame.left - stage.left - offsetX) / scale;
  let sy = (frame.top - stage.top - offsetY) / scale;
  let sw = frame.width / scale;
  let sh = frame.height / scale;

  sx -= sw * pad;
  sy -= sh * pad;
  sw += sw * pad * 2;
  sh += sh * pad * 2;

  sx = Math.max(0, Math.min(sx, videoW - 1));
  sy = Math.max(0, Math.min(sy, videoH - 1));
  sw = Math.max(1, Math.min(sw, videoW - sx));
  sh = Math.max(1, Math.min(sh, videoH - sy));

  // Upscale small crops so fine print stays readable, capped so uploads stay small.
  const longest = Math.max(sw, sh);
  const outScale = Math.min(Math.min(1600, longest * 2) / longest, 3);

  return { sx, sy, sw, sh, outW: Math.round(sw * outScale), outH: Math.round(sh * outScale) };
}

function cropToGuide() {
  const geo = mapGuideToSource({
    videoW: video.videoWidth,
    videoH: video.videoHeight,
    stage: $('stage').getBoundingClientRect(),
    frame: $('guideFrame').getBoundingClientRect(),
  });
  if (!geo) return null;

  canvas.width = geo.outW;
  canvas.height = geo.outH;
  canvas.getContext('2d').drawImage(video, geo.sx, geo.sy, geo.sw, geo.sh, 0, 0, geo.outW, geo.outH);
  return canvas;
}

// Exposed for the browser test suite; nothing in the app reads it.
window.__test = { mapGuideToSource };

$('shutterBtn').addEventListener('click', capture);

async function capture() {
  if (capturing || !stream) return;
  capturing = true;
  const shutter = $('shutterBtn');
  shutter.classList.add('busy');

  $('flash').classList.add('fire');
  setTimeout(() => $('flash').classList.remove('fire'), 340);
  buzz(35);

  try {
    const cropped = cropToGuide();
    if (!cropped) throw new Error('Camera is not ready yet');

    const blob = await new Promise((resolve) => cropped.toBlob(resolve, 'image/jpeg', 0.92));
    if (!blob) throw new Error('Could not read the frame');

    const preview = cropped.toDataURL('image/jpeg', 0.4);
    // Deliberately not awaited: you can keep shooting while this one is analysed.
    submitScan(blob, preview, `scan_${Date.now()}.jpg`);
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    // Released quickly so burst-scanning a stack of cards feels immediate.
    setTimeout(() => { capturing = false; shutter.classList.remove('busy'); }, 320);
  }
}

$('nativeCameraInput').addEventListener('change', (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  files.forEach((f) => submitScan(f, URL.createObjectURL(f), f.name));
});

$('libraryInput').addEventListener('change', (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;
  if (!scanner.classList.contains('open')) openScanner();
  files.forEach((f) => submitScan(f, URL.createObjectURL(f), f.name));
});

/** Upload one image and reflect its outcome in the tray and the live result card. */
async function submitScan(blob, previewUrl, filename) {
  const id = `s${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  state.scanned.unshift({ id, status: 'working', preview: previewUrl, name: 'Reading the card…' });
  state.scanQueue++;
  renderTray();

  try {
    const form = new FormData();
    form.append('cards', blob, filename);
    const res = await fetch('/api/portfolio/upload', { method: 'POST', body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);

    const results = data.results || [];
    const added = results.filter((r) => r.status === 'added');

    if (!added.length) {
      const reason = results[0]?.message || 'No card was found in that photo.';
      updateScan(id, { status: 'error', name: 'Not recognised', note: reason });
      showHit(null, reason);
      buzz([25, 60, 25]);
      return;
    }

    const first = added[0];
    updateScan(id, {
      status: first.is_new_copy ? 'dupe' : 'ok',
      name: first.card_name,
      note: first.is_new_copy
        ? `Copy ${first.quantity} of one you already own`
        : [first.card_set, first.card_number].filter(Boolean).join(' · ') || 'Added',
      price: first.unit_price,
      image: first.image_url || previewUrl,
      needsReview: first.needs_review,
    });
    showHit(first, null, previewUrl);
    buzz(first.is_new_copy ? [20, 40, 20] : 45);

    // Extra cards found in the same photo still belong in the tray.
    for (const extra of added.slice(1)) {
      state.scanned.unshift({
        id: `${id}x${extra.id}`,
        status: extra.is_new_copy ? 'dupe' : 'ok',
        preview: extra.image_url || previewUrl,
        name: extra.card_name,
        note: extra.is_new_copy ? `Copy ${extra.quantity}` : (extra.card_set || ''),
        price: extra.unit_price,
      });
    }
  } catch (err) {
    updateScan(id, { status: 'error', name: 'Scan failed', note: err.message });
    showHit(null, err.message);
  } finally {
    state.scanQueue--;
    renderTray();
  }
}

function updateScan(id, patch) {
  const item = state.scanned.find((s) => s.id === id);
  if (item) Object.assign(item, patch, { image: patch.image || item.preview });
  renderTray();
}

function renderTray() {
  const count = state.scanned.filter((s) => s.status === 'ok' || s.status === 'dupe').length;
  const badge = $('trayCount');
  badge.hidden = count === 0;
  badge.textContent = count;

  const working = state.scanQueue > 0;
  $('scannerTitle').textContent = working
    ? `Analysing ${state.scanQueue} card${state.scanQueue === 1 ? '' : 's'}…`
    : count ? `${count} card${count === 1 ? '' : 's'} added` : 'Scan a card';

  $('trayTitle').textContent = count ? `Added this session (${count})` : 'This session';

  const list = $('trayList');
  list.innerHTML = '';
  for (const item of state.scanned) {
    const row = el('div', `tray-item ${item.status === 'ok' ? '' : item.status}`.trim());

    const img = el('img');
    img.alt = '';
    img.src = item.image || item.preview || '';
    row.appendChild(img);

    const body = el('div', 'tray-item-body');
    body.append(el('div', 'tray-item-name', item.name || 'Scanning…'));
    const status = el('div', 'tray-item-status');
    if (item.status === 'working') {
      status.appendChild(el('span', 'spinner'));
      status.append(' Identifying…');
    } else {
      status.textContent = item.note || '';
    }
    body.appendChild(status);
    row.appendChild(body);

    if (item.price > 0) row.appendChild(el('div', 'tray-item-price', money(item.price)));
    list.appendChild(row);
  }
}

// The tray is translucent, so anything left underneath it bleeds through.
function setTrayOpen(open) {
  $('tray').classList.toggle('open', open);
  scanner.classList.toggle('tray-open', open);
  if (open) hideHit();
}

$('trayBtn').addEventListener('click', () => setTrayOpen(!$('tray').classList.contains('open')));
$('trayCloseBtn').addEventListener('click', () => setTrayOpen(false));

let hitTimer = null;

function showHit(card, failureText, fallbackImage) {
  const hit = $('hit');
  const img = $('hitImg');
  clearTimeout(hitTimer);
  // The tray already lists everything; a result card under it would show through.
  if ($('tray').classList.contains('open')) return;

  if (!card) {
    hit.className = 'hit miss show';
    img.hidden = true;
    img.removeAttribute('src');
    $('hitName').textContent = 'No card identified';
    $('hitMeta').textContent = failureText || 'Try again with less glare';
    $('hitPrice').textContent = '';
    $('hitTag').textContent = 'Try again';
  } else {
    hit.className = `hit show${card.is_new_copy ? ' dupe' : ''}`;
    const src = card.image_url || card.image_data || fallbackImage || '';
    img.hidden = !src;
    if (src) img.src = src;
    $('hitName').textContent = card.card_name || 'Unknown';
    $('hitMeta').textContent = [card.card_set, card.card_number].filter(Boolean).join(' · ') || '—';
    $('hitPrice').textContent = card.unit_price > 0 ? money(card.unit_price) : '—';
    $('hitTag').textContent = card.needs_review
      ? 'Needs review'
      : card.is_new_copy ? `Copy ${card.quantity}` : 'Added';
  }

  scanner.classList.add('has-hit');
  hitTimer = setTimeout(hideHit, 4200);
}

function hideHit() {
  $('hit').classList.remove('show');
  scanner.classList.remove('has-hit');
}

// ── LIVE UPDATES ─────────────────────────────────────────────────

function connectEvents() {
  try {
    const source = new EventSource('/api/events');
    source.onmessage = (e) => {
      let payload;
      try { payload = JSON.parse(e.data); } catch { return; }
      if (payload.type === 'portfolio_updated' || payload.type === 'card_added') loadCollection();
      if (payload.activityType === 'refresh_complete') toast(payload.message, 'success');
    };
    source.onerror = () => {
      source.close();
      // Serverless hosts cannot hold the connection open; poll instead.
      setInterval(loadCollection, 60000);
    };
  } catch {
    setInterval(loadCollection, 60000);
  }
}

// ── SERVICE WORKER ───────────────────────────────────────────────

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* offline shell is optional */ });
  });
}

// ── BOOT ─────────────────────────────────────────────────────────

syncThemeButtons();
loadCollection();
connectEvents();
window.addEventListener('resize', () => { if (state.cards.length) render(); });
