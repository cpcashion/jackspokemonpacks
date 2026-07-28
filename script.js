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

const authGateway       = document.getElementById('authGateway');
const appContainer      = document.getElementById('appContainer');
const authForm          = document.getElementById('authForm');
const authUsername      = document.getElementById('authUsername');
const authPassword      = document.getElementById('authPassword');
const authError         = document.getElementById('authError');
const registerBtn       = document.getElementById('registerBtn');
const loginBtn          = document.getElementById('loginBtn');
const logoutBtn         = document.getElementById('logoutBtn');
const navUsername       = document.getElementById('navUsername');

// ── NAVIGATION REFS ──────────────────────────────────────────────
const sideNav         = document.getElementById('sideNav');
const sideNavOverlay  = document.getElementById('sideNavOverlay');
const hamburgerBtn    = document.getElementById('hamburgerBtn');
const closeSideNavBtn  = document.getElementById('closeSideNav');

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

function getPeriodChange(card, key) {
  return fmtChange(card.current_price, card[key]);
}

function getPeriodDelta(card, key) {
  if (!card.current_price || !card[key]) return null;
  return card.current_price - card[key];
}

function formatTrendText(card, key) {
  const pct = getPeriodChange(card, key);
  const delta = getPeriodDelta(card, key);
  if (pct === null || delta === null) return '—';
  const sign = delta >= 0 ? '+' : '-';
  return `${delta >= 0 ? '↑' : '↓'} ${Math.abs(pct).toFixed(2)}% (${sign}${fmt(Math.abs(delta))})`;
}

function changeBadge(pct, includePrice, deltaPrice) {
  if (pct === null || pct === undefined) return `<span class="badge-neutral">—</span>`;
  if (Math.abs(pct) < 0.01) {
    return `<span class="badge-neutral">0.0%</span>`;
  }
  const dir = pct > 0 ? 'positive' : 'negative';
  const arrow = pct > 0 ? '↑' : '↓';
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

// ── HEIC CONVERSION ────────────────────────────────────────────────
async function ensureJpeg(file) {
  const isHeic = file.name.match(/\.(heic|heif)$/i) || file.type === 'image/heic' || file.type === 'image/heif';
  if (!isHeic) return file;
  
  try {
    if (typeof heic2any === 'undefined') {
      console.warn('heic2any not loaded, attempting to upload raw HEIC');
      return file;
    }
    showToast('Converting HEIC photo...', 'info', 2000);
    const blob = await heic2any({
      blob: file,
      toType: 'image/jpeg',
      quality: 0.8
    });
    // handle heic2any returning array of blobs for multi-frame images
    const resultBlob = Array.isArray(blob) ? blob[0] : blob;
    return new File([resultBlob], file.name.replace(/\.(heic|heif)$/i, '.jpg'), { type: 'image/jpeg' });
  } catch (err) {
    console.error('HEIC conversion failed:', err);
    showToast('Could not convert HEIC, trying original...', 'info', 2000);
    return file;
  }
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
      av = getPeriodChange(a, 'prev_day_price') || 0;
      bv = getPeriodChange(b, 'prev_day_price') || 0;
    }
    return currentSort.dir === 'asc' ? av - bv : bv - av;
  });
  return cards;
}

function renderTable(cards) {
  tableBody.innerHTML = '';
  cards.forEach(card => {
    const pct = getPeriodChange(card, 'prev_day_price');
    const delta = getPeriodDelta(card, 'prev_day_price');
    const prices = card.price_history || [];
    const isPos = pct !== null && pct >= 0;

    const imgSrc = card.image_url || '';
    const thumbHtml = imgSrc
      ? `<img class="card-thumb" src="${imgSrc}" alt="${card.card_name}" loading="lazy" onerror="this.parentNode.innerHTML='<div class=\\'card-thumb-placeholder\\'>🃏</div>'">`
      : (card.has_local_image
        ? `<img class="card-thumb" data-card-id="${card.id}" alt="${card.card_name}" loading="lazy" onerror="this.parentNode.innerHTML='<div class=\\'card-thumb-placeholder\\'>🃏</div>'">`
        : `<div class="card-thumb-placeholder">🃏</div>`);

    let sourceLabel = `<span class="source-badge">${card.price_source || 'market'}</span>`;
    if (card.price_source_url) {
      sourceLabel = `<a href="${card.price_source_url}" target="_blank" class="source-badge-link" onclick="event.stopPropagation()">${sourceLabel}</a>`;
    }

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
      <td class="col-source">${sourceLabel}</td>
      <td class="col-actions">
        <button class="delete-row-btn" data-id="${card.id}" title="Remove card" onclick="event.stopPropagation();confirmDelete(${card.id})">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
        </button>
      </td>`;
    tr.addEventListener('click', () => openDrawer(card));
    tableBody.appendChild(tr);
  });
  // Lazy-load base64 thumbnails for cards that only have local images
  lazyLoadLocalImages();
}

function lazyLoadLocalImages() {
  document.querySelectorAll('img[data-card-id]').forEach(img => {
    if (img.src) return; // already loaded
    const cardId = img.dataset.cardId;
    fetch(`/api/portfolio/${cardId}/image`).then(r => r.json()).then(d => {
      if (d.image_data) img.src = d.image_data;
    }).catch(() => {});
  });
}

function renderGrid(cards) {
  gridView.innerHTML = '';
  cards.forEach(card => {
    const pct = getPeriodChange(card, 'prev_day_price');
    const imgSrc = card.image_url || '';
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

  // Force grid on mobile regardless of button state
  const isMobile = window.innerWidth <= 700;
  const activeView = isMobile ? 'grid' : currentView;

  if (activeView === 'table') {
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
    const prev  = c.prev_day_price || 0;
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
    // OPTIMIZATION: Removed fetchSparklineData() - history is now batched in /api/portfolio
    updateStats();
    renderPortfolio();
    lastUpdatedEl.textContent = `Updated ${new Date().toLocaleTimeString()}`;
  } catch (err) {
    console.error('Failed to fetch portfolio:', err);
    showToast('Failed to load portfolio data', 'error');
  }
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
  if (window.innerWidth <= 700) return; // Disabled on mobile
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

// Auto-switch view on resize
window.addEventListener('resize', () => {
  // Debounce render if needed, but it's fast enough for now
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

// ── SCANNER MODAL ─────────────────────────────────────────────────
const scannerCameraTab = document.getElementById('scannerCameraTab');
const scannerUploadTab = document.getElementById('scannerUploadTab');
const scanResults = document.getElementById('scanResults');
const tabCamera = document.getElementById('tabCamera');
const tabUpload = document.getElementById('tabUpload');
const cameraVideo = document.getElementById('cameraVideo');
const viewfinderContainer = document.getElementById('viewfinderContainer');
const cameraPermission = document.getElementById('cameraPermission');
const cameraErrorEl = document.getElementById('cameraError');
const captureBtn = document.getElementById('captureBtn');
const captureFlash = document.getElementById('captureFlash');
const captureCanvas = document.getElementById('captureCanvas');
const scanStrip = document.getElementById('scanStrip');
const scanStripCards = document.getElementById('scanStripCards');
const scanCounter = document.getElementById('scanCounter');
const scanCountNum = document.getElementById('scanCountNum');
const flashBtn = document.getElementById('flashBtn');
const switchCameraBtn = document.getElementById('switchCameraBtn');
const galleryBtn = document.getElementById('galleryBtn');
const galleryInput = document.getElementById('galleryInput');
const guideHint = document.getElementById('guideHint');

let cameraStream = null;
let isCapturing = false;
let scanSessionCards = [];
let scanCount = 0;
let currentFacingMode = 'environment';
let torchEnabled = false;

function openModal() {
  uploadModal.classList.add('open');
  document.body.style.overflow = 'hidden';
  switchTab('camera');
}

function closeModal() {
  uploadModal.classList.remove('open');
  document.body.style.overflow = '';
  stopCamera();
  resetScanSession();
}

function resetScanSession() {
  scanSessionCards = [];
  scanCount = 0;
  scanStripCards.innerHTML = '';
  scanStrip.style.display = 'none';
  scanCounter.style.display = 'none';
  scanCountNum.textContent = '0';
  scanResults.style.display = 'none';
}

function switchTab(tab) {
  scannerCameraTab.style.display = 'none';
  scannerUploadTab.style.display = 'none';
  scanResults.style.display = 'none';
  tabCamera.classList.remove('active');
  tabUpload.classList.remove('active');
  if (tab === 'camera') {
    tabCamera.classList.add('active');
    scannerCameraTab.style.display = 'flex';
    initCamera();
  } else {
    tabUpload.classList.add('active');
    scannerUploadTab.style.display = 'flex';
    stopCamera();
  }
}

tabCamera.addEventListener('click', () => switchTab('camera'));
tabUpload.addEventListener('click', () => switchTab('upload'));

openUploadBtn.addEventListener('click', openModal);
emptyUploadBtn.addEventListener('click', openModal);
closeUploadBtn.addEventListener('click', closeModal);
uploadModal.addEventListener('click', e => {
  if (e.target === uploadModal) closeModal();
});

document.getElementById('switchToUploadBtn')?.addEventListener('click', () => switchTab('upload'));
document.getElementById('switchToUploadBtn2')?.addEventListener('click', () => switchTab('upload'));
document.getElementById('grantCameraBtn')?.addEventListener('click', () => initCamera(true));
document.getElementById('retryCameraBtn')?.addEventListener('click', () => initCamera(true));

// ── CAMERA MANAGEMENT ─────────────────────────────────────────────
async function initCamera(forceRequest = false) {
  cameraPermission.style.display = 'none';
  cameraErrorEl.style.display = 'none';
  viewfinderContainer.style.display = 'none';

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showCameraError('Camera Not Supported', 'Your browser doesn\'t support camera access. Try Chrome or Safari.');
    return;
  }

  if (!forceRequest) {
    try {
      const permResult = await navigator.permissions?.query({ name: 'camera' });
      if (permResult && permResult.state === 'prompt') {
        cameraPermission.style.display = 'flex';
        return;
      }
    } catch {}
  }

  try {
    stopCamera();
    const constraints = {
      video: { facingMode: currentFacingMode, width: { ideal: 2048 }, height: { ideal: 2048 } },
      audio: false
    };
    cameraStream = await navigator.mediaDevices.getUserMedia(constraints);
    cameraVideo.srcObject = cameraStream;
    await new Promise(resolve => {
      cameraVideo.onloadedmetadata = () => { cameraVideo.play(); resolve(); };
    });

    viewfinderContainer.style.display = 'flex';
    cameraPermission.style.display = 'none';
    cameraErrorEl.style.display = 'none';

    const track = cameraStream.getVideoTracks()[0];
    const capabilities = track.getCapabilities?.();
    flashBtn.style.display = capabilities?.torch ? 'flex' : 'none';

    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const cameras = devices.filter(d => d.kind === 'videoinput');
      switchCameraBtn.style.display = cameras.length > 1 ? 'flex' : 'none';
    } catch {}

    setTimeout(() => { if (guideHint) guideHint.style.opacity = '0.4'; }, 4000);
  } catch (err) {
    console.error('Camera init error:', err);
    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
      showCameraError('Camera Access Denied', 'Please allow camera access in your browser settings, or use the Upload tab.');
    } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
      showCameraError('No Camera Found', 'No camera was detected. Use the Upload tab instead.');
    } else {
      showCameraError('Camera Error', 'Could not access camera: ' + err.message);
    }
  }
}

function stopCamera() {
  if (cameraStream) { cameraStream.getTracks().forEach(t => t.stop()); cameraStream = null; }
  if (cameraVideo) cameraVideo.srcObject = null;
  torchEnabled = false;
  flashBtn.classList.remove('active');
}

function showCameraError(title, text) {
  cameraErrorEl.style.display = 'flex';
  viewfinderContainer.style.display = 'none';
  cameraPermission.style.display = 'none';
  document.getElementById('cameraErrorTitle').textContent = title;
  document.getElementById('cameraErrorText').textContent = text;
}

flashBtn.addEventListener('click', async () => {
  if (!cameraStream) return;
  const track = cameraStream.getVideoTracks()[0];
  try {
    torchEnabled = !torchEnabled;
    await track.applyConstraints({ advanced: [{ torch: torchEnabled }] });
    flashBtn.classList.toggle('active', torchEnabled);
  } catch { torchEnabled = false; flashBtn.classList.remove('active'); }
});

switchCameraBtn.addEventListener('click', () => {
  currentFacingMode = currentFacingMode === 'environment' ? 'user' : 'environment';
  initCamera(true);
});

// ── CAPTURE ───────────────────────────────────────────────────────
captureBtn.addEventListener('click', captureCard);

async function captureCard() {
  hideVerifyOverlay();
  if (isCapturing || !cameraStream) return;
  isCapturing = true;
  captureBtn.classList.add('capturing');

  captureFlash.classList.add('flash');
  setTimeout(() => captureFlash.classList.remove('flash'), 300);
  if (navigator.vibrate) navigator.vibrate(50);

  try {
    const video = cameraVideo;
    const canvas = captureCanvas;
    const w = video.videoWidth;
    const h = video.videoHeight;
    const scale = Math.min(2048 / w, 2048 / h, 1);
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.92));
    if (!blob) { showToast('Failed to capture image', 'error'); isCapturing = false; captureBtn.classList.remove('capturing'); return; }

    const scanId = Date.now();
    const thumbUrl = canvas.toDataURL('image/jpeg', 0.5);
    addScanStripItem(scanId, thumbUrl, 'Analyzing…', 'processing');
    scanStrip.style.display = 'block';
    scanCounter.style.display = 'flex';

    captureBtn.classList.remove('capturing');
    isCapturing = false;
    processCapturedImage(blob, scanId, thumbUrl);
  } catch (err) {
    console.error('Capture error:', err);
    showToast('Failed to capture: ' + err.message, 'error');
    isCapturing = false;
    captureBtn.classList.remove('capturing');
  }
}

async function processCapturedImage(blob, scanId, thumbUrl) {
  try {
    const formData = new FormData();
    formData.append('cards', blob, `scan_${scanId}.jpg`);
    const res = await fetch('/api/portfolio/upload', { method: 'POST', body: formData });
    if (!res.ok) {
      let errMsg = `Upload failed (${res.status})`;
      try { const d = await res.json(); errMsg = d.error || errMsg; } catch {}
      throw new Error(errMsg);
    }
    const data = await res.json();
    const cards = data.cards || [];
    if (cards.length > 0) {
      cards.forEach(card => { 
        handleUnifiedScanSuccess(card);
      });
      const c = cards[0];
      updateScanStripItem(scanId, { name: c.card_name || 'Unknown', price: c.current_price || c.estimated_value || 0, imageUrl: c.image_url || c.image_data || thumbUrl, status: 'success' });
      showToast(cards.length === 1 ? `✅ ${c.card_name} — ${fmt(c.current_price || c.estimated_value)}` : `✅ ${cards.length} cards found!`, 'success');
    } else {
      updateScanStripItem(scanId, { name: 'No card found', price: 0, imageUrl: thumbUrl, status: 'error' });
      showToast('No card detected — try adjusting angle or lighting', 'info');
    }
    await fetchPortfolio();
  } catch (err) {
    console.error('Process error:', err);
    updateScanStripItem(scanId, { name: err.message, price: 0, imageUrl: thumbUrl, status: 'error' });
    showToast('Scan failed: ' + err.message, 'error');
  }
}

function addScanStripItem(id, thumbUrl, text, status) {
  const item = document.createElement('div');
  item.className = `scan-card-item ${status}`;
  item.id = `scan-item-${id}`;
  item.innerHTML = `
    <img class="scan-card-item-img" src="${thumbUrl}" alt="Scanning…" />
    <div class="scan-card-item-info">
      <div class="scan-card-item-name">${text}</div>
      <div class="scan-card-item-status">🔍 Identifying…</div>
    </div>`;
  scanStripCards.appendChild(item);
  scanStripCards.scrollLeft = scanStripCards.scrollWidth;
}

function updateScanStripItem(id, data) {
  const item = document.getElementById(`scan-item-${id}`);
  if (!item) return;
  item.className = `scan-card-item ${data.status}`;
  if (data.imageUrl && data.status === 'success') {
    const img = item.querySelector('.scan-card-item-img');
    if (img) img.src = data.imageUrl;
  }
  const nameEl = item.querySelector('.scan-card-item-name');
  const statusEl = item.querySelector('.scan-card-item-status');
  if (nameEl) nameEl.textContent = data.name;
  if (data.status === 'success') {
    if (statusEl) { statusEl.className = 'scan-card-item-price'; statusEl.textContent = data.price > 0 ? fmt(data.price) : 'Unpriced'; }
  } else if (data.status === 'error') {
    if (statusEl) { statusEl.className = 'scan-card-item-status'; statusEl.textContent = '⚠️ Try again'; }
  }
}

// ── SCAN DONE → SHOW RESULTS ──────────────────────────────────────
document.getElementById('scanDoneBtn')?.addEventListener('click', showScanResults);

function showScanResults() {
  stopCamera();
  scannerCameraTab.style.display = 'none';
  scannerUploadTab.style.display = 'none';
  scanResults.style.display = 'flex';

  const totalCards = scanSessionCards.length;
  const resultsTitle = document.getElementById('resultsTitle');
  const resultsSubtitle = document.getElementById('resultsSubtitle');
  const resultsCardsEl = document.getElementById('resultsCards');

  if (totalCards === 0) {
    resultsTitle.textContent = 'No Cards Added';
    resultsSubtitle.textContent = 'No cards were identified. Try again with better lighting.';
    document.querySelector('.results-icon').textContent = '📸';
  } else {
    resultsTitle.textContent = totalCards === 1 ? 'Card Added!' : `${totalCards} Cards Added!`;
    const totalValue = scanSessionCards.reduce((sum, c) => sum + (c.current_price || c.estimated_value || 0), 0);
    resultsSubtitle.textContent = totalValue > 0 ? `Total value: ${fmt(totalValue)}` : `${totalCards} card${totalCards !== 1 ? 's' : ''} added to your portfolio`;
    document.querySelector('.results-icon').textContent = '🎉';
  }

  resultsCardsEl.innerHTML = '';
  scanSessionCards.forEach(card => {
    const imgSrc = card.image_url || card.image_data || '';
    const div = document.createElement('div');
    div.className = 'result-card';
    div.innerHTML = `
      ${imgSrc ? `<img class="result-card-img" src="${imgSrc}" alt="${card.card_name}" onerror="this.outerHTML='<div class=\\'result-card-img-placeholder\\'>🃏</div>'">`
        : '<div class="result-card-img-placeholder">🃏</div>'}
      <div class="result-card-info">
        <div class="result-card-name">${card.card_name || 'Unknown'}</div>
        <div class="result-card-set">${card.card_set || '—'} ${card.rarity ? '• ' + card.rarity : ''}</div>
      </div>
      <div class="result-card-price">${fmt(card.current_price || card.estimated_value)}</div>`;
    resultsCardsEl.appendChild(div);
  });
}

document.getElementById('resultsScanMoreBtn')?.addEventListener('click', () => {
  resetScanSession();
  scanResults.style.display = 'none';
  switchTab('camera');
});
document.getElementById('resultsDoneBtn')?.addEventListener('click', closeModal);

// ── GALLERY BUTTON (from camera tab) ──────────────────────────────
galleryBtn.addEventListener('click', () => galleryInput.click());
galleryInput.addEventListener('change', async () => {
  const files = Array.from(galleryInput.files);
  if (files.length) {
    for (const file of files) {
      const scanId = Date.now() + Math.random();
      const thumbUrl = URL.createObjectURL(file);
      addScanStripItem(scanId, thumbUrl, file.name, 'processing');
      scanStrip.style.display = 'block';
      scanCounter.style.display = 'flex';
      
      try {
        const jpegFile = await ensureJpeg(file);
        const formData = new FormData();
        formData.append('cards', jpegFile);
        const res = await fetch('/api/portfolio/upload', { method: 'POST', body: formData });
        const data = await res.json();
        const cards = data.cards || [];
        if (cards.length > 0) {
          cards.forEach(c => { 
            handleUnifiedScanSuccess(c);
          });
          updateScanStripItem(scanId, { name: cards[0].card_name || 'Unknown', price: cards[0].current_price || 0, imageUrl: cards[0].image_url || thumbUrl, status: 'success' });
        } else {
          updateScanStripItem(scanId, { name: 'No card found', price: 0, imageUrl: thumbUrl, status: 'error' });
        }
        await fetchPortfolio();
      } catch (err) {
        updateScanStripItem(scanId, { name: err.message, price: 0, imageUrl: thumbUrl, status: 'error' });
      }
    }
  }
  galleryInput.value = '';
});

// ── UPLOAD TAB FILE HANDLING ──────────────────────────────────────
dropZone.addEventListener('click', () => fileInput.click());
['dragenter','dragover'].forEach(evt => {
  dropZone.addEventListener(evt, e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
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

// ── FILE PROCESSING (Upload Tab) ──────────────────────────────────
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
    
    try {
      const jpegFile = await ensureJpeg(file);
      statusEl.textContent = 'Analyzing with AI…';
      progress.style.width = '30%';
      icon.textContent = '🔍';
      
      const formData = new FormData();
      formData.append('cards', jpegFile);
      progress.style.width = '60%';
      statusEl.textContent = 'Fetching market price…';
      const res = await fetch('/api/portfolio/upload', { method: 'POST', body: formData });
      progress.style.width = '90%';
      if (!res.ok) { let errMsg = `Upload failed (${res.status})`; try { const d = await res.json(); errMsg = d.error || errMsg; } catch {} throw new Error(errMsg); }
      const data = await res.json();
      progress.style.width = '100%';
      const cards = data.cards || data.results || [];
      if (cards.length > 0) {
        const c = cards[0];
        statusEl.textContent = cards.length > 1 ? `✅ Found ${cards.length} cards (incl. ${c.card_name || 'Unknown'})` : `✅ ${c.card_name || 'Identified'} — ${fmt(c.current_price || c.estimated_value)}`;
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
  await fetchPortfolio();
  setTimeout(() => {
    dropZone.style.display = 'block';
    uploadQueue.style.display = 'none';
    queueItems.innerHTML = '';
  }, 5000);
}


let verifyTimeout = null;

function handleUnifiedScanSuccess(card) {
  if (!card) return;
  
  // Track session cards
  scanCount++;
  scanCountNum.textContent = scanCount;
  scanSessionCards.push(card);
  
  // Log success
  console.log(`[Scan Success] Identified: ${card.card_name} (${card.card_set}) - Price: ${fmt(card.current_price || card.estimated_value)}`);
  
  // Trigger overlay
  showScanSuccessOverlay(card);
}

function showScanSuccessOverlay(card) {
  const overlay = document.getElementById("quickVerifyOverlay");
  const img = document.getElementById("verifyImg");
  const name = document.getElementById("verifyName");
  const price = document.getElementById("verifyPrice");

  if (!overlay || !card) return;

  if (verifyTimeout) clearTimeout(verifyTimeout);

  img.src = card.image_url || card.image_data || "";
  name.textContent = card.card_name || "Unknown Card";
  const metaEl = document.getElementById("verifyMeta");
  if (metaEl) metaEl.textContent = `${card.card_set || "—"} • ${card.rarity || "—"}`;
  price.textContent = fmt(card.current_price || card.estimated_value || 0);

  // Smooth reset for back-to-back scans: briefly remove active class to re-trigger transition
  overlay.classList.remove("active");
  void overlay.offsetWidth; // force reflow

  overlay.className = "quick-verify-overlay";
  const rarity = (card.rarity || "").toLowerCase();
  if (rarity.includes("secret")) overlay.classList.add("verify-rarity-secret");
  else if (rarity.includes("ultra") || rarity.includes("v max")) overlay.classList.add("verify-rarity-ultra");
  else if (rarity.includes("holo")) overlay.classList.add("verify-rarity-holo");
  else if (rarity.includes("rare")) overlay.classList.add("verify-rarity-rare");

  overlay.classList.add("active");

  verifyTimeout = setTimeout(() => {
    overlay.classList.remove("active");
  }, 3000);
}

function hideVerifyOverlay() {
  const overlay = document.getElementById("quickVerifyOverlay");
  if (overlay) overlay.classList.remove("active");
  if (verifyTimeout) clearTimeout(verifyTimeout);
}

// ── CARD DETAIL DRAWER ─────────────────────────────────────────────
function openDrawer(card) {
  activeDrawerCard = card;
  const pct = getPeriodChange(card, 'prev_day_price');
  const delta = getPeriodDelta(card, 'prev_day_price');
  const summary = card.history_summary || {};

  drawerCardName.textContent = card.card_name || 'Unknown Card';
  drawerCardMeta.textContent = [card.card_set, card.rarity, card.condition].filter(Boolean).join(' • ') || '—';
  drawerCurrentPx.textContent = fmt(card.current_price);

  if (pct !== null) {
    const sign = delta >= 0 ? '+' : '';
    drawerChange.textContent = `${delta >= 0 ? '↑' : '↓'} ${Math.abs(pct).toFixed(2)}% (${sign}${fmt(delta)})`;
    drawerChange.className = `drawer-change ${pct >= 0 ? 'badge-positive' : 'badge-negative'}`;
  } else {
    drawerChange.textContent = 'New Tracking';
    drawerChange.className = 'drawer-change badge-neutral';
  }

  const imgSrc = card.image_url || '';
  if (imgSrc) {
    drawerCardImg.src = imgSrc;
    drawerCardImg.style.display = 'block';
  } else if (card.has_local_image) {
    drawerCardImg.style.display = 'block';
    drawerCardImg.src = '';
    fetch(`/api/portfolio/${card.id}/image`).then(r => r.json()).then(d => {
      if (d.image_data) drawerCardImg.src = d.image_data;
    }).catch(() => { drawerCardImg.style.display = 'none'; });
  } else {
    drawerCardImg.style.display = 'none';
  }

  // Detail fields
  setDetail('drawerSet', card.card_set);
  setDetail('drawerNumber', card.card_number);
  setDetail('drawerRarity', card.rarity);
  setDetail('drawerCondition', card.condition);
  setDetail('drawerYear', card.year > 0 ? card.year : '—');
  setDetail('drawerLanguage', card.language);
  setDetail('drawerHolo', card.is_holo ? '✓ Yes' : 'No');
  setDetail('drawerHoloType', card.holo_type);
  setDetail('drawer1stEd', card.is_first_edition ? '✓ Yes' : 'No');
  setDetail('drawerConfidence', card.confidence != null ? `${Math.round(card.confidence * 100)}%` : '—');
  setDetail('drawerHighestSale', fmt(card.highest_recent_sale));
  setDetail('drawer24hTrend', formatTrendText(card, 'prev_day_price'));
  setDetail('drawer7dTrend', formatTrendText(card, 'prev_7d_price'));
  setDetail('drawer30dTrend', formatTrendText(card, 'prev_30d_price'));
  setDetail('drawerAllTimeHigh', fmt(summary.all_time_high));
  setDetail('drawerAllTimeLow', fmt(summary.all_time_low));
  const sourceBadgeHtml = card.price_source_url 
    ? `<a href="${card.price_source_url}" target="_blank" style="color:#3b82f6;text-decoration:none;">${card.price_source || 'market'} <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3"/></svg></a>`
    : (card.price_source || '—');
  const priceSourceEl = document.getElementById('drawerPriceSource');
  if (priceSourceEl) priceSourceEl.innerHTML = sourceBadgeHtml;

  drawerOverlay.classList.add('open');
  document.body.style.overflow = 'hidden';

  // Load price chart
  priceChartDays = 7;
  document.querySelectorAll('.chart-tab').forEach(t => t.classList.remove('active'));
  document.querySelector('.chart-tab[data-days="7"]').classList.add('active');
  
  // Hide empty state initially
  const emptyState = document.getElementById('chartEmptyState');
  if (emptyState) emptyState.style.display = 'none';
  
  fetchAndDrawChart(card.id, 7);

  // Load price comparison data
  renderPriceComparison(card);
}
const SOURCE_LABELS = {
  'tcgdex_tcgplayer': 'TCGdex → TCGplayer',
  'tcgdex_cardmarket': 'TCGdex → Cardmarket',
  'pokemon_tcg_api': 'Pokemon TCG API',
  'pokemon_tcg_api_fallback': 'Pokemon TCG API (Fallback)',
  'tcgplayer_reverse_holo': 'TCGplayer (Reverse Holo)',
  'tcgplayer_1st_edition': 'TCGplayer (1st Edition)',
  'tcgplayer_unlimited_holo': 'TCGplayer (Unlimited Holo)',
  'tcgplayer_unlimited': 'TCGplayer (Unlimited)',
  'tcgplayer_holo': 'TCGplayer (Holo)',
  'tcgplayer_normal': 'TCGplayer (Normal)',
  'justtcg_tcgplayer': 'JustTCG → TCGplayer',
  'scrydex_tcgplayer': 'Scrydex → TCGplayer',
  'scrydex_cardmarket': 'Scrydex → Cardmarket',
  'ebay_sold': 'eBay Sold Listings',
  'tcgplayer_direct': 'TCGplayer (Direct)',
  'cardmarket_direct': 'Cardmarket (Direct)',
  'cardmarket': 'Cardmarket',
  'trollandtoad': 'Troll and Toad',
  'tcgfish': 'TCGFish',
  'cardmavin': 'Card Mavin',
  'coolstuffinc': 'CoolStuffInc',
  'pricecharting': 'PriceCharting',
  'aggregated_market': 'Aggregated',
  'reference': 'Reference',
  'ai_estimate': 'AI Estimate',
  'market': 'Market'
};

function renderPriceComparison(card) {
  const tableEl = document.getElementById('priceComparisonTable');
  const badgeEl = document.getElementById('sourcesCheckedBadge');
  if (!tableEl) return;

  const sources = card.price_sources || {};
  const entries = Object.entries(sources).filter(([, v]) => v && v.price > 0);

  if (entries.length === 0) {
    tableEl.innerHTML = '<div style="color:#9ca3af;text-align:center;padding:0.75rem;font-size:0.75rem;">Click "Refresh Prices" to check 12 sources</div>';
    if (badgeEl) badgeEl.textContent = '';
    return;
  }

  // Sort by price descending (highest first = best sold price)
  entries.sort((a, b) => b[1].price - a[1].price);

  const bestPrice = entries[0][1].price;
  if (badgeEl) badgeEl.textContent = `${entries.length} sources found`;

  let html = '<div style="border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">';
  html += '<table style="width:100%;border-collapse:collapse;">';
  html += '<thead><tr style="background:#f9fafb;"><th style="text-align:left;padding:6px 10px;font-weight:500;color:#6b7280;font-size:0.75rem;">Source</th><th style="text-align:right;padding:6px 10px;font-weight:500;color:#6b7280;font-size:0.75rem;">Price</th></tr></thead>';
  html += '<tbody>';

  for (const [source, data] of entries) {
    const label = SOURCE_LABELS[source] || source;
    const isBest = data.price === bestPrice;
    const priceColor = isBest ? '#10b981' : '#111827';
    const bestBadge = isBest ? ' <span style="background:#10b981;color:white;padding:1px 5px;border-radius:4px;font-size:0.65rem;font-weight:600;">BEST</span>' : '';

    const link = data.url
      ? `<a href="${data.url}" target="_blank" style="color:#3b82f6;text-decoration:none;">${label} <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:middle;"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3"/></svg></a>`
      : `<span style="color:#374151;">${label}</span>`;

    html += `<tr style="border-top:1px solid #f3f4f6;">`;
    html += `<td style="padding:6px 10px;">${link}${bestBadge}</td>`;
    html += `<td style="padding:6px 10px;text-align:right;font-weight:${isBest ? '700' : '500'};color:${priceColor};font-variant-numeric:tabular-nums;">$${data.price.toFixed(2)}</td>`;
    html += `</tr>`;
  }

  html += '</tbody></table></div>';
  tableEl.innerHTML = html;
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
    const card = portfolio.find(c => c.id === cardId);
    if (card) {
        card.price_history = history; // Update local history
        card.history_summary = data.summary || null;
        // Update trend labels in drawer if currently open
        if (activeDrawerCard && activeDrawerCard.id === cardId) {
            setDetail('drawer24hTrend', formatTrendText(card, 'prev_day_price'));
            setDetail('drawer7dTrend', formatTrendText(card, 'prev_7d_price'));
            setDetail('drawer30dTrend', formatTrendText(card, 'prev_30d_price'));
            setDetail('drawerAllTimeHigh', fmt(card.history_summary?.all_time_high));
            setDetail('drawerAllTimeLow', fmt(card.history_summary?.all_time_low));
        }
    }

    let pts = history;
    if (days > 0) {
      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      const filtered = history.filter(h => new Date(h.recorded_at) >= cutoff);
      pts = filtered.length >= 2 ? filtered : history.slice(-2);
    }

    drawChart(pts);
  } catch (err) {
    console.error('Chart fetch failed:', err);
  }
}

function drawChart(pts) {
  const canvas = document.getElementById('priceChart');
  let emptyState = document.getElementById('chartEmptyState');
  
  if (!emptyState && canvas) {
    emptyState = document.createElement('div');
    emptyState.id = 'chartEmptyState';
    emptyState.className = 'chart-empty-state';
    emptyState.innerHTML = '<span class="empty-icon">📈</span><br><strong>Tracking Began Today</strong><p>Historical charts will populate tomorrow as daily market checks are recorded.</p>';
    canvas.parentElement.appendChild(emptyState);
  }

  if (!canvas) return;
  if (chartInstance) chartInstance.destroy();

  if (pts.length <= 1) {
    canvas.style.display = 'none';
    if (emptyState) emptyState.style.display = 'flex';
    return;
  } else {
    canvas.style.display = 'block';
    if (emptyState) emptyState.style.display = 'none';
  }

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
// Falls back to polling on serverless platforms (Vercel) where SSE isn't supported
let _ssePollingMode = false;

function connectSSE() {
  // First, probe the endpoint to see if we're in polling mode
  fetch('/api/events').then(r => {
    const ct = r.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      // Serverless mode — use polling instead of SSE
      _ssePollingMode = true;
      console.log('[SSE] Serverless detected, switching to polling');
      startPolling();
      return;
    }
    // Close this fetch (it was a probe) and open a real EventSource
    r.body?.cancel();
    openEventSource();
  }).catch(() => openEventSource());
}

function startPolling() {
  // Polling disabled in favor of Server-Sent Events (SSE)
  // which will trigger fetchPortfolio() automatically when the server broadcasts an update.
}

function openEventSource() {
  const evtSource = new EventSource('/api/events');
  evtSource.onmessage = async (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'card_added' || msg.type === 'prices_refreshed' || msg.type === 'portfolio_updated') {
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
    evtSource.close();
    setTimeout(connectSSE, 10000);
  };
}

// ── NO AUTH — single-user mode ────────────────────────────────────
async function checkAuth() {
  if (authGateway) authGateway.style.display = 'none';
  if (appContainer) appContainer.style.display = 'block';
  if (navUsername) navUsername.textContent = 'Jack';
  await fetchPortfolio();
  connectSSE();
  return true;
}

// ── SIDE NAVIGATION ACTIONS ──────────────────────────────────────
function openSideNav() {
  sideNav.classList.add('open');
  sideNavOverlay.classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeSideNav() {
  sideNav.classList.remove('open');
  sideNavOverlay.classList.remove('open');
  document.body.style.overflow = '';
}

// ── INIT ──────────────────────────────────────────────────────────
(async function init() {
  await checkAuth();

  // Navigation Event Listeners
  if (hamburgerBtn) hamburgerBtn.addEventListener('click', openSideNav);
  if (closeSideNavBtn) closeSideNavBtn.addEventListener('click', closeSideNav);
  if (sideNavOverlay) sideNavOverlay.addEventListener('click', closeSideNav);

  // Ensure Add Cards button in sidenav still works and closes sidenav
  if (openUploadBtn) {
    openUploadBtn.addEventListener('click', () => {
      closeSideNav();
      openModal();
    });
  }

  // Edit Card Modal Logic
  const editBtn = document.getElementById('editCardBtn');
  const editModal = document.getElementById('editCardModal');
  const cancelEditBtn = document.getElementById('cancelEditBtn');
  const saveEditBtn = document.getElementById('saveEditBtn');
  const editName = document.getElementById('editCardNameInput');
  const editSet = document.getElementById('editCardSetInput');
  const editNumber = document.getElementById('editCardNumberInput');

  if (editBtn && editModal) {
    editBtn.addEventListener('click', () => {
      if (!activeDrawerCard) return;
      editName.value = activeDrawerCard.card_name || '';
      editSet.value = activeDrawerCard.card_set || '';
      editNumber.value = activeDrawerCard.card_number || '';
      editModal.style.display = 'flex';
    });

    cancelEditBtn.addEventListener('click', () => {
      editModal.style.display = 'none';
    });

    saveEditBtn.addEventListener('click', async () => {
      if (!activeDrawerCard) return;
      saveEditBtn.disabled = true;
      saveEditBtn.textContent = 'Saving...';
      try {
        const res = await fetch(`/api/portfolio/${activeDrawerCard.id}/edit`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            card_name: editName.value.trim(),
            card_set: editSet.value.trim(),
            card_number: editNumber.value.trim()
          })
        });
        const data = await res.json();
        if (data.success) {
          showToast('Card updated! Re-fetching price in background...');
          editModal.style.display = 'none';
          setTimeout(fetchPortfolio, 1500); // refresh after a moment to let the background job start
        } else {
          showToast('Error: ' + data.error);
        }
      } catch (err) {
        showToast('Network error updating card.');
      }
      saveEditBtn.disabled = false;
      saveEditBtn.textContent = 'Save & Refresh';
    });
  }
})();
