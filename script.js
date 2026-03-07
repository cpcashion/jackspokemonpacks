/**
 * Jack's Pokemon Portfolio — Frontend
 * Portfolio rendering, sparklines, upload modal, card detail drawer.
 */

// ═══════════════════════════════════════════════════
//  STATE
// ═══════════════════════════════════════════════════

const STATE = {
    cards: [],
    stats: { totalCards: 0, totalValue: 0, prevValue: 0 },
    sortField: 'price',
    sortDir: 'desc',
    files: [],
    eventSource: null,
};

// ═══════════════════════════════════════════════════
//  DOM
// ═══════════════════════════════════════════════════

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const DOM = {
    // Stats
    statTotalValue: $('#statTotalValue'),
    statTotalChange: $('#statTotalChange'),
    statTotalCards: $('#statTotalCards'),
    statGainer: $('#statGainer'),
    statGainerChange: $('#statGainerChange'),
    statLoser: $('#statLoser'),
    statLoserChange: $('#statLoserChange'),

    // Table
    emptyState: $('#emptyState'),
    tableWrapper: $('#tableWrapper'),
    portfolioBody: $('#portfolioBody'),

    // Upload Modal
    uploadModal: $('#uploadModal'),
    dropZone: $('#dropZone'),
    fileInput: $('#fileInput'),
    filePreviews: $('#filePreviews'),
    uploadContent: $('#uploadContent'),
    btnUploadSubmit: $('#btnUploadSubmit'),
    uploadStatus: $('#uploadStatus'),

    // Drawer
    drawerOverlay: $('#drawerOverlay'),
    cardDrawer: $('#cardDrawer'),
    drawerCardName: $('#drawerCardName'),
    drawerMeta: $('#drawerMeta'),
    priceChart: $('#priceChart'),
    drawerPriceList: $('#drawerPriceList'),

    // Toast
    statusToast: $('#statusToast'),
};

// ═══════════════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
    initEventListeners();
    connectSSE();
    fetchPortfolio();
});

function initEventListeners() {
    // Open upload modal
    $('#btnOpenUpload').addEventListener('click', openUploadModal);
    $('#btnEmptyUpload')?.addEventListener('click', openUploadModal);

    // Close modals
    $('#btnCloseModal').addEventListener('click', closeUploadModal);
    DOM.uploadModal.addEventListener('click', (e) => {
        if (e.target === DOM.uploadModal) closeUploadModal();
    });

    // Close drawer
    $('#btnCloseDrawer').addEventListener('click', closeDrawer);
    DOM.drawerOverlay.addEventListener('click', (e) => {
        if (e.target === DOM.drawerOverlay) closeDrawer();
    });

    // File upload
    DOM.dropZone.addEventListener('dragover', (e) => { e.preventDefault(); DOM.dropZone.classList.add('drag-over'); });
    DOM.dropZone.addEventListener('dragleave', () => DOM.dropZone.classList.remove('drag-over'));
    DOM.dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        DOM.dropZone.classList.remove('drag-over');
        handleFiles(e.dataTransfer.files);
    });
    DOM.fileInput.addEventListener('change', (e) => handleFiles(e.target.files));

    // Upload submit
    DOM.btnUploadSubmit.addEventListener('click', submitUpload);

    // Refresh prices
    $('#btnRefreshPrices').addEventListener('click', refreshPrices);

    // Sort headers
    $$('.sortable').forEach(th => {
        th.addEventListener('click', () => {
            const field = th.dataset.sort;
            if (STATE.sortField === field) {
                STATE.sortDir = STATE.sortDir === 'desc' ? 'asc' : 'desc';
            } else {
                STATE.sortField = field;
                STATE.sortDir = 'desc';
            }
            renderTable();
        });
    });

    // Keyboard
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closeUploadModal();
            closeDrawer();
        }
    });
}

// ═══════════════════════════════════════════════════
//  DATA FETCHING
// ═══════════════════════════════════════════════════

async function fetchPortfolio() {
    try {
        const resp = await fetch('/api/portfolio');
        const data = await resp.json();
        STATE.cards = data.cards || [];
        STATE.stats = data.stats || { totalCards: 0, totalValue: 0, prevValue: 0 };
        renderStats();
        renderTable();
    } catch (err) {
        console.error('Failed to fetch portfolio:', err);
    }
}

// ═══════════════════════════════════════════════════
//  SSE
// ═══════════════════════════════════════════════════

function connectSSE() {
    if (STATE.eventSource) STATE.eventSource.close();
    STATE.eventSource = new EventSource('/api/events');

    STATE.eventSource.onmessage = (e) => {
        try {
            const data = JSON.parse(e.data);
            if (data.type === 'portfolio_updated') {
                fetchPortfolio();
            } else if (data.type === 'activity') {
                showToast(data.message);
            }
        } catch (err) { console.error('SSE parse error:', err); }
    };

    STATE.eventSource.onerror = () => {
        setTimeout(connectSSE, 5000);
    };
}

// ═══════════════════════════════════════════════════
//  RENDERING: STATS
// ═══════════════════════════════════════════════════

function renderStats() {
    const { totalCards, totalValue, prevValue } = STATE.stats;

    DOM.statTotalValue.textContent = formatCurrency(totalValue);
    DOM.statTotalCards.textContent = totalCards;

    // Total change
    if (prevValue > 0) {
        const change = totalValue - prevValue;
        const pctChange = (change / prevValue) * 100;
        DOM.statTotalChange.textContent = `${change >= 0 ? '+' : ''}${formatCurrency(change)} (${pctChange >= 0 ? '+' : ''}${pctChange.toFixed(1)}%)`;
        DOM.statTotalChange.className = `stat-change ${change >= 0 ? 'positive' : 'negative'}`;
    } else {
        DOM.statTotalChange.textContent = '';
    }

    // Biggest gainer / loser
    let biggestGainer = null, biggestLoser = null;
    let maxGain = -Infinity, maxLoss = Infinity;

    for (const card of STATE.cards) {
        if (card.current_price && card.previous_price && card.previous_price > 0) {
            const change = ((card.current_price - card.previous_price) / card.previous_price) * 100;
            if (change > maxGain) { maxGain = change; biggestGainer = card; }
            if (change < maxLoss) { maxLoss = change; biggestLoser = card; }
        }
    }

    if (biggestGainer && maxGain > 0) {
        DOM.statGainer.textContent = truncate(biggestGainer.card_name, 16);
        DOM.statGainerChange.textContent = `+${maxGain.toFixed(1)}%`;
        DOM.statGainerChange.className = 'stat-change positive';
    } else {
        DOM.statGainer.textContent = '—';
        DOM.statGainerChange.textContent = '';
    }

    if (biggestLoser && maxLoss < 0) {
        DOM.statLoser.textContent = truncate(biggestLoser.card_name, 16);
        DOM.statLoserChange.textContent = `${maxLoss.toFixed(1)}%`;
        DOM.statLoserChange.className = 'stat-change negative';
    } else {
        DOM.statLoser.textContent = '—';
        DOM.statLoserChange.textContent = '';
    }
}

// ═══════════════════════════════════════════════════
//  RENDERING: TABLE
// ═══════════════════════════════════════════════════

function renderTable() {
    const cards = [...STATE.cards];

    // Show/hide empty state
    if (cards.length === 0) {
        DOM.emptyState.style.display = 'flex';
        DOM.tableWrapper.style.display = 'none';
        return;
    }

    DOM.emptyState.style.display = 'none';
    DOM.tableWrapper.style.display = 'block';

    // Sort
    cards.sort((a, b) => {
        let valA, valB;
        if (STATE.sortField === 'name') {
            valA = (a.card_name || '').toLowerCase();
            valB = (b.card_name || '').toLowerCase();
            return STATE.sortDir === 'asc' ? valA.localeCompare(valB) : valB.localeCompare(valA);
        } else if (STATE.sortField === 'price') {
            valA = a.current_price || 0;
            valB = b.current_price || 0;
        } else if (STATE.sortField === 'change') {
            valA = getChangePct(a);
            valB = getChangePct(b);
        }
        return STATE.sortDir === 'asc' ? valA - valB : valB - valA;
    });

    // Update sort indicators
    $$('.sortable').forEach(th => {
        th.classList.remove('sorted-asc', 'sorted-desc');
        if (th.dataset.sort === STATE.sortField) {
            th.classList.add(STATE.sortDir === 'asc' ? 'sorted-asc' : 'sorted-desc');
        }
    });

    // Render rows
    DOM.portfolioBody.innerHTML = cards.map(card => {
        const price = card.current_price || 0;
        const prevPrice = card.previous_price || 0;
        const changePct = getChangePct(card);
        const changeDir = changePct > 0 ? 'positive' : changePct < 0 ? 'negative' : 'neutral';
        const changeArrow = changePct > 0 ? '↑' : changePct < 0 ? '↓' : '';
        const changeText = changePct !== 0 ? `${changePct > 0 ? '+' : ''}${changePct.toFixed(1)}%` : '—';

        const thumbHtml = card.image_data
            ? `<img class="card-thumb" src="${escapeAttr(card.image_data)}" alt="">`
            : `<div class="card-thumb-placeholder">🃏</div>`;

        return `
            <tr data-id="${card.id}" onclick="openCardDrawer(${card.id})">
                <td class="cell-card" data-label="">
                    <div class="card-cell">
                        ${thumbHtml}
                        <div>
                            <div class="card-name">${esc(card.card_name)}</div>
                            ${card.card_number ? `<div class="card-number">${esc(card.card_number)}</div>` : ''}
                        </div>
                    </div>
                </td>
                <td data-label="Set"><span class="rarity-badge">${esc(card.card_set || '—')}</span></td>
                <td data-label="Rarity"><span class="rarity-badge">${esc(card.rarity || '—')}</span></td>
                <td data-label="Condition"><span class="condition-badge">${esc(card.condition || '—')}</span></td>
                <td class="price-cell" data-label="Price">${formatCurrency(price)}</td>
                <td data-label="Change">
                    <span class="change-cell ${changeDir}">
                        <span class="change-arrow">${changeArrow}</span>
                        ${changeText}
                    </span>
                </td>
                <td class="sparkline-cell" data-label="Trend" id="spark-${card.id}"></td>
                <td class="col-actions" data-label="">
                    <button class="btn-delete" onclick="event.stopPropagation(); deleteCard(${card.id})" title="Remove">✕</button>
                </td>
            </tr>
        `;
    }).join('');

    // Load sparklines asynchronously
    cards.forEach(card => loadSparkline(card.id));
}

// ═══════════════════════════════════════════════════
//  SPARKLINES (inline SVG)
// ═══════════════════════════════════════════════════

async function loadSparkline(cardId) {
    const container = document.getElementById(`spark-${cardId}`);
    if (!container) return;

    try {
        const resp = await fetch(`/api/portfolio/${cardId}/history`);
        const data = await resp.json();
        const history = data.history || [];

        if (history.length < 2) {
            container.innerHTML = '<span style="color:var(--text-muted);font-size:0.75rem;">—</span>';
            return;
        }

        const prices = history.map(h => h.price);
        const w = 100, h = 32, pad = 2;
        const min = Math.min(...prices);
        const max = Math.max(...prices);
        const range = max - min || 1;

        const points = prices.map((p, i) => {
            const x = pad + (i / (prices.length - 1)) * (w - 2 * pad);
            const y = pad + (1 - (p - min) / range) * (h - 2 * pad);
            return `${x},${y}`;
        }).join(' ');

        const trending = prices[prices.length - 1] >= prices[0];
        const color = trending ? 'var(--green)' : 'var(--red)';

        container.innerHTML = `
            <svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
                <polyline fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" points="${points}"/>
            </svg>
        `;
    } catch {
        container.innerHTML = '';
    }
}

// ═══════════════════════════════════════════════════
//  UPLOAD MODAL
// ═══════════════════════════════════════════════════

function openUploadModal() {
    STATE.files = [];
    DOM.filePreviews.innerHTML = '';
    DOM.uploadContent.style.display = 'block';
    DOM.btnUploadSubmit.disabled = true;
    DOM.uploadStatus.textContent = 'AI will identify each card and fetch live market prices';
    DOM.uploadModal.classList.add('open');
}

function closeUploadModal() {
    DOM.uploadModal.classList.remove('open');
    STATE.files = [];
}

function handleFiles(fileList) {
    const newFiles = [...fileList].filter(f => f.type.startsWith('image/'));
    STATE.files = [...STATE.files, ...newFiles];

    DOM.filePreviews.innerHTML = '';
    STATE.files.forEach(file => {
        const reader = new FileReader();
        reader.onload = () => {
            const img = document.createElement('img');
            img.src = reader.result;
            DOM.filePreviews.appendChild(img);
        };
        reader.readAsDataURL(file);
    });

    DOM.btnUploadSubmit.disabled = STATE.files.length === 0;

    if (STATE.files.length > 0) {
        DOM.uploadContent.style.display = 'none';
    } else {
        DOM.uploadContent.style.display = 'block';
    }
}

async function submitUpload() {
    if (STATE.files.length === 0) return;

    DOM.btnUploadSubmit.disabled = true;
    DOM.btnUploadSubmit.innerHTML = '<span class="spinner"></span><span>Scanning cards...</span>';
    DOM.uploadStatus.textContent = 'Analyzing with Vision AI — this may take a minute...';

    const formData = new FormData();
    STATE.files.forEach(f => formData.append('photos', f));

    try {
        const resp = await fetch('/api/portfolio/upload', {
            method: 'POST',
            body: formData,
        });
        const data = await resp.json();
        if (data.success) {
            DOM.uploadStatus.textContent = 'Processing... cards will appear as they are identified.';
        } else {
            DOM.uploadStatus.textContent = `Error: ${data.message}`;
            DOM.btnUploadSubmit.disabled = false;
            DOM.btnUploadSubmit.innerHTML = '<span>Scan & Add to Portfolio</span>';
        }
    } catch (err) {
        DOM.uploadStatus.textContent = `Connection error: ${err.message}`;
        DOM.btnUploadSubmit.disabled = false;
        DOM.btnUploadSubmit.innerHTML = '<span>Scan & Add to Portfolio</span>';
    }
}

// ═══════════════════════════════════════════════════
//  CARD DETAIL DRAWER
// ═══════════════════════════════════════════════════

async function openCardDrawer(cardId) {
    const card = STATE.cards.find(c => c.id === cardId);
    if (!card) return;

    DOM.drawerCardName.textContent = card.card_name;

    // Meta
    DOM.drawerMeta.innerHTML = `
        <div class="meta-item"><div class="meta-label">Set</div><div class="meta-value">${esc(card.card_set || '—')}</div></div>
        <div class="meta-item"><div class="meta-label">Number</div><div class="meta-value">${esc(card.card_number || '—')}</div></div>
        <div class="meta-item"><div class="meta-label">Rarity</div><div class="meta-value">${esc(card.rarity || '—')}</div></div>
        <div class="meta-item"><div class="meta-label">Condition</div><div class="meta-value">${esc(card.condition || '—')}</div></div>
        <div class="meta-item"><div class="meta-label">Current Price</div><div class="meta-value">${formatCurrency(card.current_price || 0)}</div></div>
        <div class="meta-item"><div class="meta-label">Added</div><div class="meta-value">${formatDate(card.added_at)}</div></div>
    `;

    DOM.drawerOverlay.classList.add('open');

    // Fetch price history and draw chart
    try {
        const resp = await fetch(`/api/portfolio/${cardId}/history`);
        const data = await resp.json();
        const history = data.history || [];

        drawPriceChart(history);

        // Price list
        DOM.drawerPriceList.innerHTML = '<h3>Price Log</h3>' +
            history.slice().reverse().slice(0, 20).map(h => `
                <div class="price-entry">
                    <span class="price-date">${formatDateTime(h.recorded_at)}</span>
                    <span class="price-amount">${formatCurrency(h.price)}</span>
                </div>
            `).join('');
    } catch (err) {
        console.error('Failed to load price history:', err);
    }
}

function closeDrawer() {
    DOM.drawerOverlay.classList.remove('open');
}

function drawPriceChart(history) {
    const canvas = DOM.priceChart;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;

    const rect = canvas.parentElement.getBoundingClientRect();
    const w = rect.width;
    const h = 180;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, w, h);

    if (history.length < 2) {
        ctx.fillStyle = '#9ca3af';
        ctx.font = '13px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Not enough data yet', w / 2, h / 2);
        return;
    }

    const prices = history.map(p => p.price);
    const min = Math.min(...prices) * 0.95;
    const max = Math.max(...prices) * 1.05;
    const range = max - min || 1;
    const padX = 8, padY = 16;

    const trending = prices[prices.length - 1] >= prices[0];
    const lineColor = trending ? '#16a34a' : '#dc2626';
    const fillColor = trending ? 'rgba(22,163,74,0.06)' : 'rgba(220,38,38,0.06)';

    // Grid lines
    ctx.strokeStyle = '#f0f0f0';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
        const y = padY + (i / 4) * (h - 2 * padY);
        ctx.beginPath();
        ctx.moveTo(padX, y);
        ctx.lineTo(w - padX, y);
        ctx.stroke();
    }

    // Price line
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();

    const points = prices.map((p, i) => ({
        x: padX + (i / (prices.length - 1)) * (w - 2 * padX),
        y: padY + (1 - (p - min) / range) * (h - 2 * padY)
    }));

    points.forEach((pt, i) => {
        if (i === 0) ctx.moveTo(pt.x, pt.y);
        else ctx.lineTo(pt.x, pt.y);
    });
    ctx.stroke();

    // Fill under curve
    ctx.lineTo(points[points.length - 1].x, h - padY);
    ctx.lineTo(points[0].x, h - padY);
    ctx.closePath();
    ctx.fillStyle = fillColor;
    ctx.fill();

    // Price labels
    ctx.fillStyle = '#9ca3af';
    ctx.font = '10px Inter, sans-serif';
    ctx.textAlign = 'right';
    for (let i = 0; i <= 4; i++) {
        const y = padY + (i / 4) * (h - 2 * padY);
        const val = max - (i / 4) * range;
        ctx.fillText('$' + val.toFixed(2), w - padX, y - 3);
    }
}

// ═══════════════════════════════════════════════════
//  ACTIONS
// ═══════════════════════════════════════════════════

async function deleteCard(cardId) {
    if (!confirm('Remove this card from your portfolio?')) return;
    try {
        await fetch(`/api/portfolio/${cardId}`, { method: 'DELETE' });
        showToast('Card removed');
        fetchPortfolio();
    } catch (err) {
        showToast('Error removing card');
    }
}

async function refreshPrices() {
    const btn = $('#btnRefreshPrices');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span><span>Refreshing...</span>';
    showToast('Refreshing market prices...');

    try {
        await fetch('/api/portfolio/refresh-prices', { method: 'POST' });
    } catch (err) {
        showToast('Error refreshing prices');
    }

    // Re-enable after a delay (the actual refresh runs in the background)
    setTimeout(() => {
        btn.disabled = false;
        btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg><span>Refresh Prices</span>`;
    }, 3000);
}

// Make functions globally accessible for inline onclick handlers
window.openCardDrawer = openCardDrawer;
window.deleteCard = deleteCard;

// ═══════════════════════════════════════════════════
//  UTILITIES
// ═══════════════════════════════════════════════════

function getChangePct(card) {
    if (!card.current_price || !card.previous_price || card.previous_price === 0) return 0;
    return ((card.current_price - card.previous_price) / card.previous_price) * 100;
}

function formatCurrency(val) {
    return '$' + parseFloat(val || 0).toFixed(2);
}

function formatDate(dateStr) {
    if (!dateStr) return '—';
    return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatDateTime(dateStr) {
    if (!dateStr) return '—';
    return new Date(dateStr).toLocaleString('en-US', {
        month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
    });
}

function truncate(str, len) {
    if (!str) return '';
    return str.length > len ? str.substring(0, len) + '…' : str;
}

function esc(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
}

function escapeAttr(str) {
    return (str || '').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function showToast(message) {
    DOM.statusToast.textContent = message;
    DOM.statusToast.classList.add('visible');
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => {
        DOM.statusToast.classList.remove('visible');
    }, 3000);
}
