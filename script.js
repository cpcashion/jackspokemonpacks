/* ═══════════════════════════════════════════════════════════════
   Jack's Pokémon Portfolio — Main Client Script
   ═══════════════════════════════════════════════════════════════ */

'use strict';

// ── STATE ────────────────────────────────────────────────────────
let portfolio = [];          // array of card objects from API
let currentSort = { key: 'price', dir: 'desc' };
let currentView = 'table';   // 'table' | 'grid'
let searchQuery = '';
let activeDrawerCard = null;
let chartInstance = null;
let priceChartDays = 7;
let toastTimeout = null;

// ── DOM REFS ─────────────────────────────────────────────────────
const topbarTotal       = document.getElementById('portfolioTotal');
const topbarChange      = document.getElementById('portfolioChange');
const statTotalCards    = document.getElementById('statTotalCards');
const statPortfolioVal  = document.getElementById('statPortfolioValue');
const stat24h           = document.getElementById('stat24hChange');
const statGainer        = document.getElementById('statBiggestGainer');
const statLoser         = document.getElementById('statBiggestLoser');

const emptyState        = document.getElementById('emptyState');
const tableView         = document.getElementById('tableView');
const gridView          = document.getElementById('gridView');
const tableBody         = document.getElementById('portfolioTableBody');
const lastUpdatedEl     = document.getElementById('lastUpdated');

const openUploadBtn     = document.getElementById('openUploadBtn');
const emptyUploadBtn    = document.getElementById('emptyUploadBtn');
const uploadModal       = document.getElementById('uploadModal');
const closeUploadBtn    = document.getElementById('closeUploadBtn');
const dropZone          = document.getElementById('dropZone');
const fileInput         = document.getElementById('fileInput');
const uploadQueue       = document.getElementById('uploadQueue');
const queueTitle        = document.getElementById('queueTitle');
const queueStatus       = document.getElementById('queueStatus');
const queueItems        = document.getElementById('queueItems');

const drawerOverlay     = document.getElementById('drawerOverlay');
const closeDrawerBtn    = document.getElementById('closeDrawerBtn');
const drawerCardName    = document.getElementById('drawerCardName');
const drawerCardMeta    = document.getElementById('drawerCardMeta');
const drawerCurrentPx   = document.getElementById('drawerCurrentPrice');
const drawerChange      = document.getElementById('drawerChange');
const drawerCardImg     = document.getElementById('drawerCardImg');
const deleteCardBtn     = document.getElementById('deleteCardBtn');

const tableViewBtn      = document.getElementById('tableViewBtn');
const gridViewBtn       = document.getElementById('gridViewBtn');
const searchInput       = document.getElementById('searchInput');
const refreshBtn        = document.getElementById('refreshPricesBtn');

// ── HELPERS ──────────────────────────────────────────────────────
function fmt(n) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtChange(current, previous) {
  if (!current || !previous || previous === 0) return null;
  const pct = ((current - previous) / previous) * 100;
  return pct;
}

function changeBadge(pct, includePrice, deltaPrice) {
  if (pct === null || pct === undefined) return `<span class="badge-neutral">—</span>`;
  const dir = pct >= 0 ? 'positive' : 'negative';
  const arrow = pct >= 0 ? '↑' : '↓';
  const formatted = `${arrow} ${Math.abs(pct).toFixed(1)}%`;
  if (includePrice && deltaPrice !== undefined) {
    const sign = deltaPrice >= 0 ? '+' : '-';
    return `<span class="badge-${dir}">${formatted} (${sign}${fmt(Math.abs(deltaPrice)).slice(1)})</span>`;
  }
  return `<span class="badge-${dir}">${formatted}</span>`;
}

function rarityClass(rarity) {
  if (!rarity) return '';
  const r = rarity.toLowerCase();
  if (r.includes('secret')) return 'rarity-secret';
  if (r.includes('ultra') || r.includes('v max') || r.includes('alt art')) return 'rarity-ultra';
  if (r.includes('illustration')) return 'rarity-ultra';
  if (r.includes('holo')) return 'rarity-holo';
  if (r.includes('rare')) return 'rarity-rare';
  if (r.includes('uncommon')) return 'rarity-uncommon';
  return 'rarity-common';
}

function showToast(msg, type = 'info', duration = 4000) {
  const container = document.querySelector('.toast-container') || (() => {
    const c = document.createElement('div');
    c.className = 'toast-container';
    document.body.appendChild(c);
    return c;
  })();
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  const icons = { success: '✅', error: '❌', info: 'ℹ️' };
  t.innerHTML = `<span>${icons[type] || ''}</span><span>${msg}</span>`;
  container.appendChild(t);
  setTimeout(() => t.remove(), duration);
}

// ── SPARKLINE SVG ─────────────────────────────────────────────────
function renderSparkline(priceHistory, positive) {
  const prices = (priceHistory || []).slice(-14).map(p => Number(p.price || 0));
  if (prices.length < 2) {
    return `<svg class="sparkline" width="80" height="28" viewBox="0 0 80 28">
      <line x1="0" y1="14" x2="80" y2="14" stroke="#e5e7eb" stroke-width="1.5" stroke-dasharray="4 3"/>
    </svg>`;
  }
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 1;
  const W = 80, H = 28, PAD = 3;
  const pts = prices.map((p, i) => {
    const x = PAD + (i / (prices.length - 1)) * (W - PAD * 2);
    const y = PAD + ((1 - (p - min) / range) * (H - PAD * 2));
    return `${x},${y}`;
  });
  const color = positive ? '#16a34a' : '#dc2626';
  const last = prices[prices.length - 1];
  const first = prices[0];
  const isPos = last >= first;
  const lineColor = isPos ? '#16a34a' : '#dc2626';
  return `<svg class="sparkline" width="80" height="28" viewBox="0 0 80 28">
    <polyline points="${pts.join(' ')}" fill="none" stroke="${lineColor}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

// ── PORTFOLIO RENDERING ───────────────────────────────────────────
function getFilteredSorted() {
  let cards = portfolio.filter(c => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return (
      (c.card_name || '').toLowerCase().includes(q) ||
      (c.card_set || '').toLowerCase().includes(q) ||
      (c.rarity || '').toLowerCase().includes(q)
    );
  });

  cards.sort((a, b) => {
    let av, bv;
    if (currentSort.key === 'name') {
      av = (a.card_name || '').toLowerCase();
      bv = (b.card_name || '').toLowerCase();
      return currentSort.dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
    }
    if (currentSort.key === 'price') {
      av = a.current_price || 0;
      bv = b.current_price || 0;
    }
    if (currentSort.key === 'change') {
      av = fmtChange(a.current_price, a.previous_price) || 0;
      bv = fmtChange(b.current_price, b.previous_price) || 0;
    }
    return currentSort.dir === 'asc' ? av - bv : bv - av;
  });
  return cards;
}

function renderTable(cards) {
  tableBody.innerHTML = '';
  cards.forEach(card => {
    const pct = fmtChange(card.current_price, card.previous_price);
    const delta = card.current_price && card.previous_price ? card.current_price - card.previous_price : null;
    const prices = card.price_history || [];
    const isPos = pct !== null && pct >= 0;

    const imgSrc = card.image_url || card.image_data || '';
    const thumbHtml = imgSrc
      ? `<img class="card-thumb" src="${imgSrc}" alt="${card.card_name}" loading="lazy" onerror="this.parentNode.innerHTML='<div class=\\'card-thumb-placeholder\\'>🃏</div>'">`
      : `<div class="card-thumb-placeholder">🃏</div>`;

    const sourceLabel = card.price_source || 'market';

    const tr = document.createElement('tr');
    tr.dataset.id = card.id;
    tr.innerHTML = `
      <td class="col-thumb">${thumbHtml}</td>
      <td class="col-name">
        <div class="card-name-cell">
          <div class="card-name">${card.card_name || 'Unknown'}</div>
          <div class="card-badges">
            ${card.is_holo ? '<span class="badge-holo">Holo</span>' : ''}
            ${card.is_first_edition ? '<span class="badge-first">1st Ed</span>' : ''}
          </div>
        </div>
      </td>
      <td class="col-set">${card.card_set || '—'}</td>
      <td class="col-rarity"><span class="${rarityClass(card.rarity)}">${card.rarity || '—'}</span></td>
      <td class="col-condition">${card.condition || '—'}</td>
      <td class="col-price">${fmt(card.current_price)}</td>
      <td class="col-change">${changeBadge(pct, false)}</td>
      <td class="col-sparkline">${renderSparkline(prices, isPos)}</td>
      <td class="col-source"><span class="source-badge">${sourceLabel}</span></td>
      <td class="col-actions">
        <button class="delete-row-btn" data-id="${card.id}" title="Remove card" onclick="event.stopPropagation();confirmDelete(${card.id})">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
        </button>
      </td>`;
    tr.addEventListener('click', () => openDrawer(card));
    tableBody.appendChild(tr);
  });
}

function renderGrid(cards) {
  gridView.innerHTML = '';
  cards.forEach(card => {
    const pct = fmtChange(card.current_price, card.previous_price);
    const imgSrc = card.image_url || card.image_data || '';
    const div = document.createElement('div');
    div.className = 'grid-card';
    div.innerHTML = `
      ${imgSrc
        ? `<div class="grid-card-img"><img src="${imgSrc}" alt="${card.card_name}" loading="lazy" onerror="this.parentNode.innerHTML='<div class=\\'grid-card-placeholder\\'>🃏</div>'"></div>`
        : `<div class="grid-card-placeholder">🃏</div>`}
      <div class="grid-card-body">
        <div class="grid-card-name">${card.card_name || 'Unknown'}</div>
        <div class="grid-card-set">${card.card_set || '—'}</div>
        <div class="grid-card-price-row">
          <span class="grid-card-price">${fmt(card.current_price)}</span>
          ${changeBadge(pct, false)}
        </div>
      </div>`;
    div.addEventListener('click', () => openDrawer(card));
    gridView.appendChild(div);
  });
}

function renderPortfolio() {
  const cards = getFilteredSorted();
  const hasCards = portfolio.length > 0;

  emptyState.style.display = hasCards || searchQuery ? 'none' : 'block';

  if (currentView === 'table') {
    tableView.style.display  = hasCards ? 'block' : 'none';
    gridView.style.display   = 'none';
    if (hasCards) renderTable(cards);
  } else {
    tableView.style.display  = 'none';
    gridView.style.display   = hasCards ? 'grid' : 'none';
    if (hasCards) renderGrid(cards);
  }

  if (searchQuery && cards.length === 0 && hasCards) {
    emptyState.style.display = 'block';
    document.querySelector('.empty-title').textContent = 'No cards match your search';
    document.querySelector('.empty-subtitle').textContent = `Try a different name or set.`;
  }
}

function updateStats() {
  let totalValue = 0, prevValue = 0;
  let maxGain = null, maxLoss = null;
  let maxGainCard = null, maxLossCard = null;

  portfolio.forEach(c => {
    const price = c.current_price || 0;
    const prev  = c.previous_price || 0;
    totalValue += price;
    prevValue  += prev;
    const pct = fmtChange(price, prev);
    if (pct !== null) {
      if (maxGain === null || pct > maxGain) { maxGain = pct; maxGainCard = c; }
      if (maxLoss === null || pct < maxLoss) { maxLoss = pct; maxLossCard = c; }
    }
  });

  const delta = totalValue - prevValue;
  const deltaPct = prevValue > 0 ? (delta / prevValue) * 100 : null;

  topbarTotal.textContent = fmt(totalValue);
  if (deltaPct !== null) {
    const cls = deltaPct >= 0 ? 'positive' : 'negative';
    const arrow = deltaPct >= 0 ? '↑' : '↓';
    topbarChange.textContent = `${arrow} ${Math.abs(deltaPct).toFixed(2)}%`;
    topbarChange.className = `portfolio-change ${cls}`;
  } else {
    topbarChange.textContent = '—';
    topbarChange.className = 'portfolio-change neutral';
  }

  statTotalCards.textContent = portfolio.length;
  statPortfolioVal.textContent = fmt(totalValue);

  if (deltaPct !== null) {
    const sign = delta >= 0 ? '+' : '';
    stat24h.textContent = `${sign}${fmt(delta)} (${delta >= 0 ? '+' : ''}${deltaPct.toFixed(2)}%)`;
    stat24h.className = `stat-value ${deltaPct >= 0 ? 'positive' : 'negative'}`;
  } else {
    stat24h.textContent = '—';
    stat24h.className = 'stat-value neutral';
  }

  if (maxGainCard) {
    statGainer.textContent = `${maxGainCard.card_name} +${maxGain.toFixed(1)}%`;
  } else {
    statGainer.textContent = '—';
  }

  if (maxLossCard) {
    statLoser.textContent = `${maxLossCard.card_name} ${maxLoss.toFixed(1)}%`;
  } else {
    statLoser.textContent = '—';
  }
}

// ── FETCH PORTFOLIO ───────────────────────────────────────────────
async function fetchPortfolio() {
  try {
    const res = await fetch('/api/portfolio');
    if (!res.ok) throw new Error(`Status ${res.status}`);
    const data = await res.json();
    portfolio = data.cards || [];
    // Also fetch history for sparklines
    await fetchSparklineData();
    updateStats();
    renderPortfolio();
    lastUpdatedEl.textContent = `Updated ${new Date().toLocaleTimeString()}`;
  } catch (err) {
    console.error('Failed to fetch portfolio:', err);
    showToast('Failed to load portfolio data', 'error');
  }
}

async function fetchSparklineData() {
  // Fetch 7-day history for each card (batch)
  const fetches = portfolio.map(async card => {
    try {
      const res = await fetch(`/api/portfolio/${card.id}/history`);
      if (res.ok) {
        const data = await res.json();
        card.price_history = data.history || [];
      }
    } catch { /* skip — sparkline will show flat line */ }
  });
  await Promise.allSettled(fetches);
}

// ── SORT ──────────────────────────────────────────────────────────
document.querySelectorAll('th.sortable').forEach(th => {
  th.addEventListener('click', () => {
    const key = th.dataset.sort;
    if (currentSort.key === key) {
      currentSort.dir = currentSort.dir === 'asc' ? 'desc' : 'asc';
    } else {
      currentSort.key = key;
      currentSort.dir = key === 'name' ? 'asc' : 'desc';
    }
    document.querySelectorAll('th.sortable').forEach(h => {
      h.classList.remove('sort-asc', 'sort-desc');
    });
    th.classList.add(currentSort.dir === 'asc' ? 'sort-asc' : 'sort-desc');
    renderPortfolio();
  });
});

// ── VIEW TOGGLE ───────────────────────────────────────────────────
tableViewBtn.addEventListener('click', () => {
  currentView = 'table';
  tableViewBtn.classList.add('active');
  gridViewBtn.classList.remove('active');
  renderPortfolio();
});
gridViewBtn.addEventListener('click', () => {
  currentView = 'grid';
  gridViewBtn.classList.add('active');
  tableViewBtn.classList.remove('active');
  renderPortfolio();
});

// ── SEARCH ────────────────────────────────────────────────────────
searchInput.addEventListener('input', () => {
  searchQuery = searchInput.value.trim();
  renderPortfolio();
});

// ── REFRESH PRICES ────────────────────────────────────────────────
refreshBtn.addEventListener('click', async () => {
  if (portfolio.length === 0) {
    showToast('No cards to refresh', 'info');
    return;
  }
  refreshBtn.classList.add('loading');
  refreshBtn.disabled = true;
  try {
    const res = await fetch('/api/portfolio/refresh-prices', { method: 'POST' });
    const data = await res.json();
    showToast(data.message || 'Prices refreshed!', 'success');
    await fetchPortfolio();
  } catch (err) {
    showToast('Failed to refresh prices', 'error');
  } finally {
    refreshBtn.classList.remove('loading');
    refreshBtn.disabled = false;
  }
});

// ── UPLOAD MODAL ──────────────────────────────────────────────────
function openModal() {
  uploadModal.classList.add('open');
  document.body.style.overflow = 'hidden';
}
function closeModal() {
  uploadModal.classList.remove('open');
  document.body.style.overflow = '';
  // Reset state if not uploading
  if (!document.querySelector('.queue-item')) {
    dropZone.style.display = 'block';
    uploadQueue.style.display = 'none';
    queueItems.innerHTML = '';
  }
}

openUploadBtn.addEventListener('click', openModal);
emptyUploadBtn.addEventListener('click', openModal);
closeUploadBtn.addEventListener('click', closeModal);
uploadModal.addEventListener('click', e => { if (e.target === uploadModal) closeModal(); });

// File input trigger
dropZone.addEventListener('click', () => fileInput.click());

// Drag and drop
['dragenter','dragover'].forEach(evt => {
  dropZone.addEventListener(evt, e => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });
});
['dragleave','dragend'].forEach(evt => {
  dropZone.addEventListener(evt, () => dropZone.classList.remove('drag-over'));
});
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/') || f.name.match(/\.(heic|heif|dng|cr2|nef|arw|raw)$/i));
  if (files.length) processFiles(files);
});
fileInput.addEventListener('change', () => {
  const files = Array.from(fileInput.files);
  if (files.length) processFiles(files);
  fileInput.value = '';
});

// ── FILE PROCESSING ───────────────────────────────────────────────
async function processFiles(files) {
  dropZone.style.display = 'none';
  uploadQueue.style.display = 'block';
  queueTitle.textContent = `Processing ${files.length} card${files.length > 1 ? 's' : ''}…`;
  queueStatus.textContent = '';
  queueItems.innerHTML = '';

  const itemEls = files.map((file, i) => {
    const el = document.createElement('div');
    el.className = 'queue-item';
    el.id = `qitem-${i}`;
    const preview = URL.createObjectURL(file);
    el.innerHTML = `
      <img class="queue-item-thumb" src="${preview}" alt="${file.name}">
      <div class="queue-item-info">
        <div class="queue-item-name">${file.name}</div>
        <div class="queue-item-status">Waiting…</div>
        <div class="queue-item-progress"><div class="queue-item-progress-bar" style="width:0%"></div></div>
      </div>
      <div class="queue-item-status-icon">⏳</div>`;
    queueItems.appendChild(el);
    return el;
  });

  let success = 0, fail = 0;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const el = itemEls[i];
    const statusEl = el.querySelector('.queue-item-status');
    const progress = el.querySelector('.queue-item-progress-bar');
    const icon = el.querySelector('.queue-item-status-icon');

    statusEl.textContent = 'Analyzing with AI…';
    progress.style.width = '30%';
    icon.textContent = '🔍';

    try {
      const formData = new FormData();
      formData.append('cards', file);

      progress.style.width = '60%';
      statusEl.textContent = 'Fetching market price…';

      const res = await fetch('/api/portfolio/upload', {
        method: 'POST',
        body: formData
      });

      progress.style.width = '90%';

      if (!res.ok) {
        let errMsg = `Upload failed (${res.status})`;
        try { const d = await res.json(); errMsg = d.error || errMsg; } catch {}
        throw new Error(errMsg);
      }

      const data = await res.json();
      progress.style.width = '100%';

      const cards = data.cards || data.results || [];
      if (cards.length > 0) {
        const c = cards[0];
        if (cards.length > 1) {
            statusEl.textContent = `✅ Found ${cards.length} cards (incl. ${c.card_name || 'Unknown'})`;
        } else {
            statusEl.textContent = `✅ ${c.card_name || 'Identified'} — ${fmt(c.current_price || c.estimated_value)}`;
        }
        icon.textContent = '✅';
        success += cards.length;
      } else {
        statusEl.textContent = '⚠️ No card detected in image';
        icon.textContent = '⚠️';
      }
    } catch (err) {
      statusEl.textContent = `❌ ${err.message}`;
      icon.textContent = '❌';
      progress.style.width = '100%';
      progress.style.background = '#dc2626';
      fail++;
    }
  }

  queueTitle.textContent = `Done! ${success} card${success !== 1 ? 's' : ''} added`;
  queueStatus.textContent = fail > 0 ? `${fail} failed` : '✓ All successful';
  queueStatus.style.color = fail > 0 ? '#dc2626' : '#16a34a';

  // Refresh portfolio
  await fetchPortfolio();

  // Reset upload form for next upload
  setTimeout(() => {
    dropZone.style.display = 'block';
    uploadQueue.style.display = 'none';
    queueItems.innerHTML = '';
  }, 5000);
}

// ── CARD DETAIL DRAWER ─────────────────────────────────────────────
function openDrawer(card) {
  activeDrawerCard = card;
  const pct = fmtChange(card.current_price, card.previous_price);
  const delta = card.current_price && card.previous_price ? card.current_price - card.previous_price : null;

  drawerCardName.textContent = card.card_name || 'Unknown Card';
  drawerCardMeta.textContent = [card.card_set, card.rarity, card.condition].filter(Boolean).join(' • ') || '—';
  drawerCurrentPx.textContent = fmt(card.current_price);

  if (pct !== null) {
    const sign = delta >= 0 ? '+' : '';
    drawerChange.textContent = `${delta >= 0 ? '↑' : '↓'} ${Math.abs(pct).toFixed(2)}% (${sign}${fmt(delta)})`;
    drawerChange.className = `drawer-change ${pct >= 0 ? 'badge-positive' : 'badge-negative'}`;
  } else {
    drawerChange.textContent = '';
  }

  const imgSrc = card.image_url || card.image_data || '';
  if (imgSrc) {
    drawerCardImg.src = imgSrc;
    drawerCardImg.style.display = 'block';
  } else {
    drawerCardImg.style.display = 'none';
  }

  // Detail fields
  setDetail('drawerSet', card.card_set);
  setDetail('drawerNumber', card.card_number);
  setDetail('drawerRarity', card.rarity);
  setDetail('drawerCondition', card.condition);
  setDetail('drawerHolo', card.is_holo ? '✓ Yes' : 'No');
  setDetail('drawer1stEd', card.is_first_edition ? '✓ Yes' : 'No');
  setDetail('drawerConfidence', card.confidence != null ? `${Math.round(card.confidence * 100)}%` : '—');
  setDetail('drawerPriceSource', card.price_source || '—');

  drawerOverlay.classList.add('open');
  document.body.style.overflow = 'hidden';

  // Load price chart
  priceChartDays = 7;
  document.querySelectorAll('.chart-tab').forEach(t => t.classList.remove('active'));
  document.querySelector('.chart-tab[data-days="7"]').classList.add('active');
  fetchAndDrawChart(card.id, 7);
}

function setDetail(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val || '—';
}

function closeDrawer() {
  drawerOverlay.classList.remove('open');
  document.body.style.overflow = '';
  activeDrawerCard = null;
  if (chartInstance) { chartInstance.destroy(); chartInstance = null; }
}

closeDrawerBtn.addEventListener('click', closeDrawer);
drawerOverlay.addEventListener('click', e => { if (e.target === drawerOverlay) closeDrawer(); });

// Chart tab switching
document.querySelectorAll('.chart-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.chart-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    priceChartDays = parseInt(tab.dataset.days);
    if (activeDrawerCard) fetchAndDrawChart(activeDrawerCard.id, priceChartDays);
  });
});

async function fetchAndDrawChart(cardId, days) {
  try {
    const res = await fetch(`/api/portfolio/${cardId}/history`);
    if (!res.ok) return;
    const data = await res.json();
    const history = (data.history || []);

    // Filter to `days` window
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const filtered = history.filter(h => new Date(h.recorded_at) >= cutoff);
    const pts = filtered.length >= 2 ? filtered : history.slice(-2);

    drawChart(pts);
  } catch (err) {
    console.error('Chart fetch failed:', err);
  }
}

function drawChart(pts) {
  const canvas = document.getElementById('priceChart');
  if (!canvas) return;

  if (chartInstance) chartInstance.destroy();

  const labels = pts.map(p => {
    const d = new Date(p.recorded_at);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  });
  const prices = pts.map(p => Number(p.price));
  const isUp = prices.length >= 2 ? prices[prices.length - 1] >= prices[0] : true;
  const color = isUp ? '#16a34a' : '#dc2626';

  chartInstance = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        data: prices,
        borderColor: color,
        backgroundColor: 'transparent',
        borderWidth: 2,
        pointRadius: pts.length <= 10 ? 3 : 0,
        pointBackgroundColor: color,
        tension: 0.3,
      }]
    },
    options: {
      responsive: true,
      animation: { duration: 300 },
      plugins: { legend: { display: false }, tooltip: {
        callbacks: {
          label: ctx => `$${Number(ctx.raw).toFixed(2)}`
        }
      }},
      scales: {
        x: { grid: { display: false }, ticks: { color: '#9ca3af', font: { size: 11 } } },
        y: {
          grid: { color: '#f3f4f6' },
          ticks: {
            color: '#9ca3af',
            font: { size: 11 },
            callback: v => `$${v.toFixed(0)}`
          }
        }
      }
    }
  });
}

// ── DELETE CARD ────────────────────────────────────────────────────
async function confirmDelete(cardId) {
  if (!confirm('Remove this card from your portfolio?')) return;
  try {
    const res = await fetch(`/api/portfolio/${cardId}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Delete failed');
    portfolio = portfolio.filter(c => c.id !== cardId);
    updateStats();
    renderPortfolio();
    showToast('Card removed from portfolio', 'success');
    if (activeDrawerCard && activeDrawerCard.id === cardId) closeDrawer();
  } catch {
    showToast('Failed to remove card', 'error');
  }
}

deleteCardBtn.addEventListener('click', () => {
  if (activeDrawerCard) confirmDelete(activeDrawerCard.id);
});

// Make confirmDelete accessible globally (called from inline onclick)
window.confirmDelete = confirmDelete;

// ── SSE (Server-Sent Events) live updates ─────────────────────────
function connectSSE() {
  const evtSource = new EventSource('/api/events');
  evtSource.onmessage = async (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'card_added' || msg.type === 'prices_refreshed') {
        await fetchPortfolio();
      }
      
      // Real-time upload UI stream
      if (msg.type === 'activity' && document.getElementById('uploadModal').classList.contains('open')) {
        if (msg.activityType === 'card_added_detail' && msg.data) {
          const c = msg.data;
          const qItems = document.getElementById('queueItems');
          if (qItems) {
            const div = document.createElement('div');
            div.className = 'queue-card-detail';
            const imgSrc = c.image_url || c.image_data || '';
            div.innerHTML = `
              ${imgSrc ? `<img src="${imgSrc}" class="queue-mini-img" onerror="this.outerHTML='<div class=\\'queue-mini-placeholder\\'>🃏</div>'">` : `<div class="queue-mini-placeholder">🃏</div>`}
              <div class="queue-mini-info">
                <div class="queue-mini-name">${c.card_name || 'Unknown'} <span class="queue-mini-set">${c.card_set || ''}</span></div>
                <div class="queue-mini-price">${fmt(c.current_price)} <span class="source-badge" style="font-size:0.65rem;">${c.price_source || 'market'}</span></div>
              </div>
            `;
            qItems.appendChild(div);
            qItems.scrollTop = qItems.scrollHeight;
          }
        }
      }
    } catch {}
  };
  evtSource.onerror = () => {
    // SSE disconnected — retry after 10 seconds
    evtSource.close();
    setTimeout(connectSSE, 10000);
  };
}

// ── INIT ──────────────────────────────────────────────────────────
(async function init() {
  await fetchPortfolio();
  connectSSE();
})();
