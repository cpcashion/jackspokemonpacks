/**
 * Jack's Pokemon Packs — Integrated Frontend
 * 
 * Handles:
 * 1. 3D holographic card effect (preserved from original)
 * 2. SSE connection for real-time scanner activity
 * 3. Live activity panel with AI analysis visualization
 * 4. Deal card rendering and filtering
 * 5. Smooth scroll navigation
 */

// ═══════════ STATE ═══════════

let eventSource = null;

// ═══════════ INIT ═══════════

document.addEventListener('DOMContentLoaded', () => {
    initCardEffect();
    initParticles();
    initIdleAnimation();
    initNavigation();
    connectSSE();
    fetchDeals();
    fetchCards();
    fetchStats();
    initFilters();

    setInterval(fetchStats, 15000);
});

// ═══════════ 3D CARD EFFECT (preserved) ═══════════

function initCardEffect() {
    const card = document.getElementById('pokemon-card');
    const container = document.getElementById('card-container');
    if (!card || !container) return;

    const config = { maxRotation: 25, scale: 1.05, transitionSpeed: 0.1 };
    let isHovering = false;
    let raf = null;

    function updateCard(rotateX, rotateY, mouseX, mouseY) {
        card.style.transform = `rotateX(${rotateX}deg) rotateY(${rotateY}deg) scale3d(${config.scale},${config.scale},${config.scale})`;
        card.style.setProperty('--mouse-x', `${((mouseX + 1) / 2) * 100}%`);
        card.style.setProperty('--mouse-y', `${((mouseY + 1) / 2) * 100}%`);
        card.style.setProperty('--holo-angle', `${Math.atan2(mouseY, mouseX) * (180 / Math.PI) + 135}deg`);
    }

    container.addEventListener('mouseenter', () => {
        isHovering = true;
        card.style.transition = `transform ${config.transitionSpeed}s ease-out`;
    });

    container.addEventListener('mouseleave', () => {
        isHovering = false;
        if (raf) cancelAnimationFrame(raf);
        card.style.transition = 'transform 0.5s ease-out';
        card.style.transform = 'rotateX(0deg) rotateY(0deg) scale3d(1,1,1)';
        card.style.setProperty('--mouse-x', '50%');
        card.style.setProperty('--mouse-y', '50%');
    });

    container.addEventListener('mousemove', (e) => {
        if (!isHovering) return;
        if (raf) cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
            const rect = container.getBoundingClientRect();
            const mx = (e.clientX - rect.left - rect.width / 2) / (rect.width / 2);
            const my = (e.clientY - rect.top - rect.height / 2) / (rect.height / 2);
            updateCard(-my * config.maxRotation, mx * config.maxRotation, mx, my);
        });
    });

    // Touch support
    container.addEventListener('touchstart', () => card.classList.add('active'), { passive: true });
    container.addEventListener('touchmove', (e) => {
        const t = e.touches[0], rect = container.getBoundingClientRect();
        const mx = ((t.clientX - rect.left) / rect.width) * 2 - 1;
        const my = ((t.clientY - rect.top) / rect.height) * 2 - 1;
        updateCard(-my * config.maxRotation, mx * config.maxRotation, mx, my);
    }, { passive: true });
    container.addEventListener('touchend', () => {
        card.classList.remove('active');
        card.style.transition = 'transform 0.5s ease-out';
        card.style.transform = 'rotateX(0deg) rotateY(0deg) scale3d(1,1,1)';
    });
}

function initParticles() {
    const container = document.getElementById('particles');
    if (!container) return;
    const colors = ['#fbbf24', '#a855f7', '#3b82f6', '#ec4899', '#22c55e'];
    for (let i = 0; i < 25; i++) {
        const p = document.createElement('div');
        p.className = 'particle';
        const size = Math.random() * 4 + 2;
        const color = colors[Math.floor(Math.random() * colors.length)];
        p.style.cssText = `width:${size}px;height:${size}px;left:${Math.random() * 100}%;background:${color};animation-delay:${Math.random() * 8}s;animation-duration:${Math.random() * 4 + 6}s;box-shadow:0 0 ${size * 2}px ${color};`;
        container.appendChild(p);
    }
}

function initIdleAnimation() {
    const card = document.getElementById('pokemon-card');
    const container = document.getElementById('card-container');
    if (!card || !container) return;
    let angle = 0, idle = true;
    container.addEventListener('mouseenter', () => idle = false);
    container.addEventListener('mouseleave', () => setTimeout(() => idle = true, 600));
    (function animate() {
        if (idle) {
            angle += 0.02;
            card.style.transform = `rotateX(${Math.sin(angle) * 3}deg) rotateY(${Math.cos(angle * 0.7) * 3}deg) scale3d(1,1,1)`;
        }
        requestAnimationFrame(animate);
    })();
}

// ═══════════ NAVIGATION ═══════════

function initNavigation() {
    const nav = document.getElementById('nav');
    const links = document.querySelectorAll('.nav-link');
    const sections = ['hero', 'scanner', 'deals'];

    window.addEventListener('scroll', () => {
        nav.classList.toggle('scrolled', window.scrollY > 50);

        // Update active nav link
        const scrollY = window.scrollY + 100;
        for (let i = sections.length - 1; i >= 0; i--) {
            const section = document.getElementById(sections[i]);
            if (section && scrollY >= section.offsetTop) {
                links.forEach(l => l.classList.remove('active'));
                links[i]?.classList.add('active');
                break;
            }
        }
    });
}

// ═══════════ SSE CONNECTION ═══════════

function connectSSE() {
    if (eventSource) eventSource.close();
    eventSource = new EventSource('/api/events');

    eventSource.onmessage = (e) => {
        try {
            const data = JSON.parse(e.data);
            switch (data.type) {
                case 'connected':
                    setNavStatus('Connected — Monitoring', true);
                    if (data.scanState) updateScanState(data.scanState);
                    break;
                case 'activity':
                    handleActivity(data);
                    break;
                case 'new_deal':
                    addDeal(data.deal);
                    showToast(data.deal);
                    fetchStats();
                    break;
                case 'status':
                    if (data.scanState) updateScanState(data.scanState);
                    break;
            }
        } catch (err) { console.error('SSE parse error:', err); }
    };

    eventSource.onerror = () => {
        setNavStatus('Reconnecting...', false);
        setTimeout(connectSSE, 5000);
    };
}

// ═══════════ ACTIVITY HANDLER ═══════════

function handleActivity(data) {
    const { activityType, message, details } = data;

    // Add to the activity log
    const logClass = getLogClass(activityType);
    const icon = getLogIcon(activityType);
    addLogEntry(icon, message, logClass);

    // Update the AI analysis panel for specific activity types
    switch (activityType) {
        case 'analyzing_image':
            showAiPanel(details.imageUrl, details.listingTitle, details.listingPrice);
            break;

        case 'ai_analyzing':
            showScanningOverlay(true);
            break;

        case 'card_identified':
            showScanningOverlay(false);
            showAiResult(details);
            break;

        case 'price_comparison':
            updateAiPrices(details.listingPrice, details.marketPrice);
            break;

        case 'deal_found':
            showAiVerdict(details.dealTier, details.discountPct);
            break;

        case 'no_deal':
            showAiVerdict('no-deal', 0);
            break;

        case 'skip_listing':
        case 'ai_no_result':
        case 'no_price':
            hideAiPanel();
            break;

        case 'cycle_start':
            setNavStatus('Scanning...', true);
            break;

        case 'cycle_complete':
            setNavStatus('Monitoring', true);
            break;
    }
}

function getLogClass(type) {
    const map = {
        deal_found: 'deal', error: 'error', scam_warning: 'error',
        analyzing_image: 'ai', ai_analyzing: 'ai', card_identified: 'ai',
        price_comparison: 'ai', scraper_start: 'scraper', scraper_done: 'scraper',
    };
    return map[type] || '';
}

function getLogIcon(type) {
    const map = {
        cycle_start: '🔄', cycle_complete: '✅', search_terms: '🔎',
        scraper_start: '📡', scraper_done: '✅', search_result: '📋',
        new_listings: '🆕', analyzing_image: '📸', ai_analyzing: '🤖',
        card_identified: '🎴', price_comparison: '💰', deal_found: '🎯',
        no_deal: '➖', skip_listing: '⏭️', ai_no_result: '❓',
        no_price: '❓', scam_warning: '⚠️', error: '❌',
    };
    return map[type] || '📌';
}

// ═══════════ AI PANEL ═══════════

function showAiPanel(imageUrl, title, listingPrice) {
    const panel = document.getElementById('aiCurrent');
    const img = document.getElementById('aiCurrentImg');
    const titleEl = document.getElementById('aiCurrentTitle');
    const resultEl = document.getElementById('aiResult');
    const verdictRow = document.getElementById('aiVerdictRow');

    panel.style.display = 'flex';
    if (imageUrl) img.src = imageUrl;
    img.onerror = () => img.src = '';
    titleEl.textContent = title || 'Analyzing listing...';
    resultEl.style.display = 'none';
    verdictRow.style.display = 'none';
    showScanningOverlay(true);

    // Removed scrollIntoView to prevent the page from jumping while scanning
}

function showScanningOverlay(show) {
    const overlay = document.getElementById('aiScanOverlay');
    if (overlay) overlay.style.display = show ? 'flex' : 'none';
}

function showAiResult(details) {
    const resultEl = document.getElementById('aiResult');
    resultEl.style.display = 'flex';

    setText('aiCardName', details.cardName || '—');
    setText('aiCardSet', details.cardSet || '—');
    setText('aiCardRarity', details.rarity || '—');
    setText('aiCardCondition', details.condition || '—');
    setText('aiCardConfidence', details.confidence ? `${(details.confidence * 100).toFixed(0)}%` : '—');

    if (details.listingPrice) {
        setText('aiListedPrice', `$${details.listingPrice.toFixed(2)}`);
    }
    if (details.aiEstimate) {
        setText('aiMarketPrice', `~$${parseFloat(details.aiEstimate).toFixed(2)} (AI est.)`);
    }
}

function updateAiPrices(listingPrice, marketPrice) {
    setText('aiListedPrice', `$${listingPrice.toFixed(2)}`);
    setText('aiMarketPrice', `$${marketPrice.toFixed(2)}`);
    document.getElementById('aiMarketPrice').style.textDecoration = 'line-through';
}

function showAiVerdict(tier, discountPct) {
    const row = document.getElementById('aiVerdictRow');
    const el = document.getElementById('aiVerdict');
    row.style.display = 'flex';

    const labels = {
        incredible: `🔥 INCREDIBLE — ${(discountPct * 100).toFixed(0)}% OFF!`,
        great: `💎 GREAT DEAL — ${(discountPct * 100).toFixed(0)}% OFF!`,
        good: `👍 GOOD DEAL — ${(discountPct * 100).toFixed(0)}% OFF`,
        'no-deal': '➖ Fair price — not a deal',
    };

    el.textContent = labels[tier] || 'Analyzed';
    el.className = `ai-verdict ${tier}`;
}

function hideAiPanel() {
    // Don't hide immediately — let it linger briefly
    setTimeout(() => {
        const panel = document.getElementById('aiCurrent');
        if (panel) panel.style.display = 'none';
    }, 2000);
}

// ═══════════ ACTIVITY LOG ═══════════

function addLogEntry(icon, message, cssClass) {
    const log = document.getElementById('activityLog');
    const placeholder = log.querySelector('.log-placeholder');
    if (placeholder) placeholder.remove();

    const entry = document.createElement('div');
    entry.className = `log-entry ${cssClass}`;

    const time = new Date().toLocaleTimeString();
    entry.innerHTML = `<span class="log-icon">${icon}</span><span class="log-time">${time}</span><span class="log-text">${escapeHtml(message)}</span>`;
    log.appendChild(entry);
    log.scrollTop = log.scrollHeight;

    // Keep max 80 entries
    while (log.children.length > 80) log.removeChild(log.firstChild);
}

// ═══════════ DEALS & TRACKER ═══════════

const FIRST_151 = [
    "Bulbasaur", "Ivysaur", "Venusaur", "Charmander", "Charmeleon", "Charizard", "Squirtle", "Wartortle", "Blastoise", "Caterpie", "Metapod", "Butterfree", "Weedle", "Kakuna", "Beedrill", "Pidgey", "Pidgeotto", "Pidgeot", "Rattata", "Raticate", "Spearow", "Fearow", "Ekans", "Arbok", "Pikachu", "Raichu", "Sandshrew", "Sandslash", "Nidoran♀", "Nidorina", "Nidoqueen", "Nidoran♂", "Nidorino", "Nidoking", "Clefairy", "Clefable", "Vulpix", "Ninetales", "Jigglypuff", "Wigglytuff", "Zubat", "Golbat", "Oddish", "Gloom", "Vileplume", "Paras", "Parasect", "Venonat", "Venomoth", "Diglett", "Dugtrio", "Meowth", "Persian", "Psyduck", "Golduck", "Mankey", "Primeape", "Growlithe", "Arcanine", "Poliwag", "Poliwhirl", "Poliwrath", "Abra", "Kadabra", "Alakazam", "Machop", "Machoke", "Machamp", "Bellsprout", "Weepinbell", "Victreebel", "Tentacool", "Tentacruel", "Geodude", "Graveler", "Golem", "Ponyta", "Rapidash", "Slowpoke", "Slowbro", "Magnemite", "Magneton", "Farfetch'd", "Doduo", "Dodrio", "Seel", "Dewgong", "Grimer", "Muk", "Shellder", "Cloyster", "Gastly", "Haunter", "Gengar", "Onix", "Drowzee", "Hypno", "Krabby", "Kingler", "Voltorb", "Electrode", "Exeggcute", "Exeggutor", "Cubone", "Marowak", "Hitmonlee", "Hitmonchan", "Lickitung", "Koffing", "Weezing", "Rhyhorn", "Rhydon", "Chansey", "Tangela", "Kangaskhan", "Horsea", "Seadra", "Goldeen", "Seaking", "Staryu", "Starmie", "Mr. Mime", "Scyther", "Jynx", "Electabuzz", "Magmar", "Pinsir", "Tauros", "Magikarp", "Gyarados", "Lapras", "Ditto", "Eevee", "Vaporeon", "Jolteon", "Flareon", "Porygon", "Omanyte", "Omastar", "Kabuto", "Kabutops", "Aerodactyl", "Snorlax", "Articuno", "Zapdos", "Moltres", "Dratini", "Dragonair", "Dragonite", "Mewtwo", "Mew"
];

let currentFeed = 'deals'; // 'deals' or 'all' or 'first-edition' or 'tracker-151'
let allDeals = [];
let allCards = [];
let currentFilter = 'all';

async function fetchDeals() {
    try {
        const resp = await fetch('/api/deals?limit=5000');
        const deals = await resp.json();
        allDeals = deals;
        if (currentFeed === 'deals') renderDeals();
    } catch { }
}

async function fetchCards() {
    try {
        const resp = await fetch('/api/cards?limit=5000');
        const cards = await resp.json();
        allCards = cards;
        if (currentFeed === 'all') renderDeals();
    } catch { }
}

async function fetchStats() {
    try {
        const resp = await fetch('/api/stats');
        const stats = await resp.json();
        setText('statListings', formatNum(stats.totalListings || 0));
        setText('statAnalyzed', formatNum(stats.scanState?.cardsAnalyzed || 0));
        setText('statDeals', formatNum(stats.totalDeals || 0));
        if (stats.scanState) updateScanState(stats.scanState);
    } catch { }
}

function updateScanState(state) {
    if (state.nextCycleAt) {
        const diff = new Date(state.nextCycleAt) - Date.now();
        if (diff > 0) {
            const m = Math.floor(diff / 60000), s = Math.floor((diff % 60000) / 1000);
            setText('statNextScan', `${m}:${s.toString().padStart(2, '0')}`);
        } else {
            setText('statNextScan', 'Now');
        }
    }
    if (state.isRunning) setNavStatus('Scanning...', true);
}

function addDeal(deal) {
    deal.image_urls = deal.image_urls ? (typeof deal.image_urls === 'string' ? JSON.parse(deal.image_urls) : deal.image_urls) : [];
    allDeals.unshift(deal);
    renderDeals();
}

function renderDeals() {
    const grid = document.getElementById('dealGrid');
    const empty = document.getElementById('emptyState');
    const filterContainer = document.getElementById('tierFilters');

    // Hide/Show tier filters based on active tab
    if (filterContainer) filterContainer.style.display = currentFeed === 'deals' ? 'flex' : 'none';

    if (currentFeed === 'tracker-151') {
        renderTracker151();
        return;
    }

    grid.className = 'deal-grid'; // Ensure standard grid class is active
    const sourceData = currentFeed === 'deals' ? allDeals : allCards;

    let filtered = [];
    if (currentFeed === 'first-edition') {
        filtered = allCards.filter(d => d.is_1st_ed === 1 || d.is_1st_ed === true);
    } else {
        filtered = sourceData.filter(d =>
            currentFeed === 'all' || currentFilter === 'all' || d.deal_tier === currentFilter
        );
    }

    if (!filtered.length) {
        grid.innerHTML = '';
        if (empty) { grid.appendChild(empty); empty.style.display = ''; }
        return;
    }

    if (empty) empty.style.display = 'none';
    grid.innerHTML = filtered.map(dealCardHTML).join('');
}

function dealCardHTML(d) {
    const images = d.image_urls || [];
    const img = images[0] || '';

    // Distinguish between a deal object and a raw card object
    const isDeal = !!d.deal_tier;
    const tier = d.deal_tier || 'none';
    const emoji = { incredible: '🔥', great: '💎', good: '👍' }[tier] || '🔍';

    const disc = d.discount_pct ? `${(d.discount_pct * 100).toFixed(0)}%` : '';
    const name = d.card_name || d.title || 'Unknown';
    const tags = [];

    if (d.is_holo) tags.push('<span class="tag holo">✦ Holo</span>');
    if (d.is_1st_ed) tags.push('<span class="tag first-edition">1st Ed</span>');
    if (d.rarity && d.rarity !== 'Unknown') tags.push(`<span class="tag rarity">${d.rarity}</span>`);
    if (d.condition_est && d.condition_est !== 'Unknown') tags.push(`<span class="tag condition">${d.condition_est}</span>`);
    if (d.watchers > 0) tags.push(`<span class="tag watchers">👀 ${d.watchers} Watching</span>`);

    return `<div class="deal-card ${isDeal ? `tier-${tier}` : 'tier-none'}">
        <span class="deal-tier-badge ${tier}" ${!isDeal ? 'style="display:none;"' : ''}>${emoji} ${tier.toUpperCase()}</span>
        <div class="deal-card-image">
            ${img ? `<img src="${img}" alt="${escapeHtml(name)}" loading="lazy" onerror="this.parentElement.innerHTML='<div class=\\'no-image\\'>🃏</div>'">` : '<div class="no-image">🃏</div>'}
            <span class="marketplace-badge">${d.marketplace || ''}</span>
        </div>
        <div class="deal-card-info">
            <div class="deal-card-name" title="${escapeHtml(name)}">${escapeHtml(name)}</div>
            <div class="deal-card-set">${escapeHtml(d.card_set || '')}</div>
            ${tags.length ? `<div class="deal-card-tags">${tags.join('')}</div>` : ''}
            <div class="deal-price-row">
                <span class="deal-listed-price">$${(d.listing_price || d.price || 0).toFixed(2)}</span>
                <span class="deal-market-price ${!d.market_price ? 'hidden' : ''}">$${(d.market_price || 0).toFixed(2)}</span>
            </div>
            
            <div class="date-listed-label" style="font-size: 11px; color: var(--text-muted); margin-top: 10px;">
                Listed: ${new Date(d.posted_at || d.created_at).toLocaleString()}
            </div>
            
            ${isDeal ? `
            <div class="discount-bar"><div class="discount-bar-fill" style="width:${Math.min((d.discount_pct || 0) * 100, 100)}%"></div></div>
            <div class="deal-discount-label">
                <span>Save $${((d.market_price || 0) - (d.listing_price || 0)).toFixed(2)}</span>
                <span class="deal-discount-value">${disc} OFF</span>
            </div>
            ` : ''}
            
            <a href="${d.listing_url || '#'}" target="_blank" rel="noopener" class="deal-buy-btn">BUY NOW →</a>
        </div>
    </div>`;
}

function renderTracker151() {
    const grid = document.getElementById('dealGrid');
    const empty = document.getElementById('emptyState');
    if (empty) empty.style.display = 'none';

    grid.className = 'tracker-151-grid';

    const foundNames = new Set(
        allCards.map(c => c.card_name).filter(Boolean).map(n => n.toLowerCase())
    );

    let foundCount = 0;
    const slotsHtml = FIRST_151.map((pokemon, index) => {
        const pkmnLower = pokemon.toLowerCase();

        // Find if any card in our database includes this pokemon's name
        const isFound = Array.from(foundNames).some(name => {
            // Match exact names or names that start with the pokemon name (e.g., "Charizard EX")
            const parts = name.split(/[^a-z0-9]/);
            return parts.includes(pkmnLower) || name.includes(` ${pkmnLower} `) || name.startsWith(`${pkmnLower} `) || name === pkmnLower;
        });

        if (isFound) foundCount++;

        return `
        <div class="tracker-slot ${isFound ? 'found' : 'missing'}">
            <div class="tracker-number">#${(index + 1).toString().padStart(3, '0')}</div>
            <div class="tracker-name">${pokemon}</div>
        </div>
        `;
    }).join('');

    const pct = Math.round((foundCount / 151) * 100);

    grid.innerHTML = `
        <div class="tracker-stats-banner">
            <h3>Original 151 Pokedex</h3>
            <div class="tracker-progress-bar">
                <div class="tracker-progress-fill" style="width: ${pct}%"></div>
            </div>
            <div class="tracker-fraction">${foundCount} / 151</div>
        </div>
        ${slotsHtml}
    `;
}

// ═══════════ FILTERS & TABS ═══════════

function initFilters() {
    // Tier Filters (Only for Deals feed)
    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentFilter = btn.dataset.filter;
            renderDeals();
        });
    });

    // Feed Tabs (Deals vs All Finds)
    document.querySelectorAll('.feed-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.feed-tab').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentFeed = btn.dataset.feed;

            // Depending on which tab, display that data
            if ((currentFeed === 'all' || currentFeed === 'first-edition' || currentFeed === 'tracker-151') && !allCards.length) {
                fetchCards();
            } else {
                renderDeals();
            }
        });
    });
}

// ═══════════ TOAST ═══════════

function showToast(deal) {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = 'toast';
    const emoji = { incredible: '🔥', great: '💎', good: '👍' }[deal.deal_tier] || '📦';
    toast.innerHTML = `<div class="toast-title">${emoji} ${(deal.deal_tier || 'deal').toUpperCase()} Deal!</div>
        <div class="toast-body">${escapeHtml(deal.card_name || deal.title || 'Pokemon Card')} — $${(deal.listing_price || 0).toFixed(2)}</div>`;
    container.appendChild(toast);
    setTimeout(() => { toast.classList.add('toast-out'); setTimeout(() => toast.remove(), 300); }, 6000);
}

// ═══════════ HELPERS ═══════════

function setNavStatus(text, ok) {
    const el = document.getElementById('navStatusText');
    const dot = document.querySelector('.nav-pulse');
    if (el) el.textContent = text;
    if (dot) dot.style.background = ok ? 'var(--accent-green)' : 'var(--accent-fire)';
}

function setText(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }

function formatNum(n) {
    if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
    return n.toString();
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
}
