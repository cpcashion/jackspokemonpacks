/**
 * Jack's Pokemon Packs — Auto-Lister Frontend Logic
 * Manages the UI state machine, SSE connection, and dynamic renders.
 */

// ═══════════ STATE ═══════════
const STATE = {
    eventSource: null,
    files: [],
    topCards: [],
    listedStats: {
        count: 0,
        totalValue: 0
    }
};

// ═══════════ DOM ELEMENTS ═══════════
const DOM = {
    // Views
    viewPortal: document.getElementById('view-portal'),
    viewProcessing: document.getElementById('view-processing'),
    viewReview: document.getElementById('view-review'),

    // Portal Form
    form: document.getElementById('autoListForm'),
    dropZone: document.getElementById('dropZone'),
    fileInput: document.getElementById('cardPhotos'),
    filePreviews: document.getElementById('filePreviews'),
    btnSubmit: document.getElementById('btnStartPipeline'),

    // Processing Pipeline
    steps: {
        upload: document.getElementById('step-upload'),
        vision: document.getElementById('step-vision'),
        valuation: document.getElementById('step-valuation'),
        listing: document.getElementById('step-listing')
    },
    activityLog: document.getElementById('activityLog'),

    // AI Focus
    aiFocus: document.getElementById('aiFocus'),
    focusImage: document.getElementById('focusImage'),
    focusTitle: document.getElementById('focusTitle'),
    focusEstimate: document.getElementById('focusEstimate'),
    focusTier: document.getElementById('focusTier'),

    // Dashboard & Phase 3
    listedGrid: document.getElementById('listedGrid'),
    listedCount: document.getElementById('listedCount'),
    authForm: document.getElementById('ebayAuthForm'),
    btnAuth: document.getElementById('btnAuthEbay'),

    // Shared
    statusText: document.getElementById('systemStatus'),
    statusDot: document.querySelector('.status-indicator')
};

// ═══════════ INIT ═══════════
document.addEventListener('DOMContentLoaded', () => {
    initDragAndDrop();
    initForms();
    connectSSE();
});

function setStatus(text, isActive = false) {
    DOM.statusText.textContent = text;
    DOM.statusDot.classList.toggle('active', isActive);
}

function switchView(viewId) {
    DOM.viewPortal.classList.remove('active');
    DOM.viewProcessing.classList.remove('active');
    DOM.viewReview.classList.remove('active');

    if (viewId === 'processing') {
        DOM.viewProcessing.classList.add('active');
    } else if (viewId === 'review') {
        DOM.viewReview.classList.add('active');
    } else {
        DOM.viewPortal.classList.add('active');
    }
}

// ═══════════ FILE UPLOAD & FORMS ═══════════
function initDragAndDrop() {
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        DOM.dropZone.addEventListener(eventName, preventDefaults, false);
    });

    ['dragenter', 'dragover'].forEach(eventName => {
        DOM.dropZone.addEventListener(eventName, () => DOM.dropZone.classList.add('drag-over'), false);
    });

    ['dragleave', 'drop'].forEach(eventName => {
        DOM.dropZone.addEventListener(eventName, () => DOM.dropZone.classList.remove('drag-over'), false);
    });

    DOM.dropZone.addEventListener('drop', handleDrop, false);
    DOM.fileInput.addEventListener('change', handleFiles, false);
}

function preventDefaults(e) {
    e.preventDefault();
    e.stopPropagation();
}

function handleDrop(e) {
    const dt = e.dataTransfer;
    const files = dt.files;
    handleFiles({ target: { files } });
}

function handleFiles(e) {
    const newFiles = [...e.target.files];
    STATE.files = [...STATE.files, ...newFiles];
    renderPreviews();
}

function renderPreviews() {
    DOM.filePreviews.innerHTML = '';
    STATE.files.forEach(file => {
        if (!file.type.startsWith('image/')) return;

        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = () => {
            const img = document.createElement('img');
            img.src = reader.result;
            img.style.cssText = 'width: 60px; height: 60px; object-fit: cover; border-radius: 8px; border: 1px solid rgba(255,255,255,0.2); margin-right: 8px;';
            DOM.filePreviews.appendChild(img);
        }
    });
}

function initForms() {
    // Phase 1: Upload & Analyze
    DOM.form.addEventListener('submit', async (e) => {
        e.preventDefault();

        if (STATE.files.length === 0) {
            alert('Please select or drop at least one image of your cards.');
            return;
        }

        DOM.btnSubmit.disabled = true;
        DOM.btnSubmit.innerHTML = '<span>Uploading...</span>';
        switchView('processing');
        activateStep('upload');
        logTerminal('info', `Initializing secure upload for ${STATE.files.length} images...`);

        const formData = new FormData();
        STATE.files.forEach(file => formData.append('photos', file));

        try {
            const resp = await fetch('/api/analyze-lot', {
                method: 'POST',
                body: formData
            });
            const data = await resp.json();

            if (data.success) {
                logTerminal('success', 'Upload complete. Launching AI Pipeline...');
            } else {
                logTerminal('error', `Upload failed: ${data.message}`);
                DOM.btnSubmit.disabled = false;
                DOM.btnSubmit.innerHTML = '<span>Initiate Apprasial Scan</span>';
            }
        } catch (err) {
            logTerminal('error', `Connection error: ${err.message}`);
        }
    });

    // Phase 3: Authenticate & List
    DOM.authForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        const username = document.getElementById('ebayUsername').value;
        const password = document.getElementById('ebayPassword').value;

        if (STATE.topCards.length === 0) {
            alert('No cards available to list.');
            return;
        }

        DOM.btnAuth.disabled = true;
        DOM.btnAuth.innerHTML = '<span>Listing...</span>';
        activateStep('listing');
        logTerminal('info', `Initiating eBay Agent for ${STATE.topCards.length} cards...`);

        try {
            const resp = await fetch('/api/list-on-ebay', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    username,
                    password,
                    cardsToList: STATE.topCards
                })
            });
            const data = await resp.json();

            if (!data.success) {
                logTerminal('error', `Listing failed: ${data.message}`);
                DOM.btnAuth.disabled = false;
                DOM.btnAuth.innerHTML = '<span>Create eBay Listings</span>';
            }
        } catch (err) {
            logTerminal('error', `Connection error: ${err.message}`);
        }
    });
}

// ═══════════ PIPELINE & TERMINAL ═══════════
function activateStep(stepName) {
    Object.values(DOM.steps).forEach(s => s.classList.remove('active', 'completed'));

    if (stepName === 'upload') {
        DOM.steps.upload.classList.add('active');
    } else if (stepName === 'vision') {
        DOM.steps.upload.classList.add('completed');
        DOM.steps.vision.classList.add('active');
    } else if (stepName === 'valuation') {
        DOM.steps.upload.classList.add('completed');
        DOM.steps.vision.classList.add('completed');
        DOM.steps.valuation.classList.add('active');
    } else if (stepName === 'listing') {
        DOM.steps.upload.classList.add('completed');
        DOM.steps.vision.classList.add('completed');
        DOM.steps.valuation.classList.add('completed');
        DOM.steps.listing.classList.add('active');
    }
}

function logTerminal(type, message) {
    const time = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const cssClass = {
        'info': 'info',
        'success': 'success',
        'error': 'error',
        'ai': 'ai'
    }[type] || 'info';

    const div = document.createElement('div');
    div.className = `log-line ${cssClass}`;
    div.innerHTML = `<span class="timestamp">[${time}]</span> ${escapeHtml(message)}`;

    // Clear placeholder
    const placeholder = DOM.activityLog.querySelector('.text-muted');
    if (placeholder) placeholder.remove();

    DOM.activityLog.appendChild(div);
    DOM.activityLog.scrollTop = DOM.activityLog.scrollHeight;

    // Keep max 100 lines
    while (DOM.activityLog.children.length > 100) {
        DOM.activityLog.removeChild(DOM.activityLog.firstChild);
    }
}

function escapeHtml(unsafe) {
    return (unsafe || '').toString()
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

// ═══════════ SSE CONNECTION & STATE MAPPER ═══════════
function connectSSE() {
    if (STATE.eventSource) STATE.eventSource.close();
    STATE.eventSource = new EventSource('/api/events');

    STATE.eventSource.onmessage = (e) => {
        try {
            const data = JSON.parse(e.data);
            handleServerEvent(data);
        } catch (err) { console.error('SSE Error:', err); }
    };

    STATE.eventSource.onerror = () => {
        setStatus('Reconnecting...', false);
        setTimeout(connectSSE, 5000);
    };
}

function handleServerEvent(data) {
    if (data.type === 'connected') {
        setStatus('System Online', true);
        return;
    }

    if (data.type === 'listing_created') {
        addListingCard(data.card);
        return;
    }

    if (data.type === 'analysis_complete') {
        if (data.success) {
            STATE.topCards = data.cards;
            data.cards.forEach(c => addListingCard(c, true));
            switchView('review');
        }
        return;
    }

    if (data.type !== 'activity') return;

    const { activityType, message, details = {} } = data;

    // Map backend activity types to terminal styles
    let logStyle = 'info';
    if (['deal_found', 'scraper_done', 'cycle_complete'].includes(activityType)) logStyle = 'success';
    if (['analyzing_image', 'ai_analyzing', 'card_identified'].includes(activityType)) logStyle = 'ai';
    if (['error', 'scam_warning'].includes(activityType)) logStyle = 'error';

    logTerminal(logStyle, message);

    // Map backend activity to UI step progress and focus panel
    switch (activityType) {
        case 'analyzing_image':
            activateStep('vision');
            if (details.imageUrl) updateAiFocus(details.imageUrl, 'Detecting Card...', '--', '--');
            break;

        case 'card_identified':
            activateStep('valuation');
            const conf = details.confidence ? `(${(details.confidence * 100).toFixed(0)}%)` : '';
            updateAiFocus(null, `${details.cardName} ${conf}`, '--', '--');
            break;

        case 'price_comparison':
        case 'deal_found':
            if (details.marketPrice) {
                updateAiFocus(null, null, `$${details.marketPrice.toFixed(2)}`, details.dealTier || 'good');
            }
            break;

        case 'scraper_start':
        case 'search_terms':
            activateStep('listing');
            break;

        case 'cycle_complete':
        case 'error':
            activateStep('completed');
            setTimeout(() => { DOM.aiFocus.style.display = 'none'; }, 5000);
            break;
    }
}

// ═══════════ AI FOCUS PANEL ═══════════
function updateAiFocus(imgUrl, title, estimate, tier) {
    DOM.aiFocus.style.display = 'block';

    if (imgUrl) DOM.focusImage.src = imgUrl;
    if (title) DOM.focusTitle.textContent = title;
    if (estimate) DOM.focusEstimate.textContent = estimate;

    if (tier) {
        DOM.focusTier.textContent = tier.toUpperCase();
        DOM.focusTier.className = `stat-value card-tier ${tier}`;
    }
}

// ═══════════ DASHBOARD RENDERING ═══════════
async function fetchExistingListings() {
    try {
        const resp = await fetch('/api/deals?limit=100');
        const deals = await resp.json();
        deals.forEach(d => addListingCard(d, true));
    } catch (e) { console.error('Failed to fetch initial listings', e); }
}

function addListingCard(card, isHistory = false) {
    STATE.listedStats.count++;
    DOM.listedCount.textContent = STATE.listedStats.count;

    const el = document.createElement('div');
    el.className = 'listed-card';

    const price = card.listing_price || card.market_price || card.marketPrice || card.avg_price || 0;

    const explanationDiv = card.explanation
        ? `<div style="font-size: 0.85rem; color: var(--text-secondary); margin-top: 0.5rem; line-height: 1.3;"><i>${escapeHtml(card.explanation)}</i></div>`
        : '';

    const verifyLink = card.sourceUrl
        ? `<a href="${card.sourceUrl}" target="_blank" class="verify-link" style="color: var(--accent-primary); font-size: 0.85rem; text-decoration: none; display: block; margin-top: 0.75rem;">Verify Live Listing ↗</a>`
        : `<span style="color: var(--text-secondary); font-size: 0.85rem; display: block; margin-top: 0.75rem; font-style: italic;">AI Estimated Value</span>`;

    const imageElement = card.matchedImageUrl
        ? `<div style="width: 100%; display: flex; justify-content: center; margin-bottom: 1rem;"><img src="${escapeHtml(card.matchedImageUrl)}" style="max-height: 200px; object-fit: contain; border-radius: 8px;"></div>`
        : '';

    el.innerHTML = `
        <div class="card-header">
            <span class="card-tier ${card.dealTier || 'good'}">${card.dealTier || 'PREMIUM'} CARD</span>
            ${!isHistory ? '<span style="font-size: 10px; color: var(--accent-success);">● LISTED</span>' : ''}
        </div>
        ${imageElement}
        <div class="card-title">${escapeHtml(card.title || card.card_name)}</div>
        <div class="card-pricing">
            <div class="price-block listed" style="margin-bottom: 0;">
                <span>Market Value</span>
                <strong>$${parseFloat(price).toFixed(2)}</strong>
            </div>
            ${explanationDiv}
            ${verifyLink}
        </div>
    `;

    DOM.listedGrid.appendChild(el);
}
