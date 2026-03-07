/**
 * Jack's Pokemon Packs — Portfolio Tracker Server
 * 
 * Express server that:
 * 1. Serves the portfolio dashboard (static HTML/CSS/JS)
 * 2. Stores cards permanently in a SQLite portfolio database
 * 3. Analyzes uploaded card photos with Gemini Vision AI
 * 4. Scrapes marketplace prices (eBay, Mercari, etc.)
 * 5. Tracks price history over time with background refresh
 */

import 'dotenv/config';
import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync } from 'fs';
import Database from 'better-sqlite3';
import { GoogleGenerativeAI } from '@google/generative-ai';
import axios from 'axios';
import puppeteer from 'puppeteer';
import multer from 'multer';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '3000', 10);
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';

// ═══════════════════════════════════════════════════════════════
//  SHARED PUPPETEER BROWSER
// ═══════════════════════════════════════════════════════════════

let browser = null;
async function getBrowser() {
    if (browser && browser.isConnected()) return browser;
    console.log('  [Puppeteer] Launching headless Chrome...');
    browser = await puppeteer.launch({
        headless: 'new',
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-extensions',
            '--window-size=1920,1080',
        ],
    });
    console.log('  [Puppeteer] Browser launched successfully.');
    return browser;
}

// ═══════════════════════════════════════════════════════════════
//  CONFIG
// ═══════════════════════════════════════════════════════════════

const HIGH_VALUE_CARDS = [
    { name: 'Charizard', set: 'Base Set', minValue: 200 },
    { name: 'Charizard', set: 'Base Set', variant: '1st Edition', minValue: 5000 },
    { name: 'Charizard', set: 'Base Set', variant: 'Shadowless', minValue: 1000 },
    { name: 'Blastoise', set: 'Base Set', minValue: 100 },
    { name: 'Venusaur', set: 'Base Set', minValue: 80 },
    { name: 'Pikachu Illustrator', set: 'Promo', minValue: 50000 },
    { name: 'Lugia', set: 'Neo Genesis', minValue: 150 },
    { name: 'Umbreon', set: 'Evolving Skies', variant: 'Alt Art', minValue: 200 },
    { name: 'Rayquaza', set: 'Gold Star', minValue: 1500 },
    { name: 'Mewtwo', set: 'Base Set', minValue: 50 },
    { name: 'Espeon', set: 'Gold Star', minValue: 2000 },
    { name: 'Mew', set: 'Gold Star', minValue: 800 },
];

const RATE_LIMITS = { ebay: 1000, mercari: 2000, offerup: 2000, facebook: 2000, priceCheck: 500 };

// ═══════════════════════════════════════════════════════════════
//  DATABASE
// ═══════════════════════════════════════════════════════════════

mkdirSync(join(__dirname, 'data'), { recursive: true });
const db = new Database(join(__dirname, 'data', 'pokesniper.db'));
db.pragma('journal_mode = WAL');

// Legacy tables (kept for backward compat)
db.exec(`
  CREATE TABLE IF NOT EXISTS listings (
    id TEXT PRIMARY KEY, marketplace TEXT, title TEXT, price REAL,
    image_urls TEXT, listing_url TEXT, posted_at TEXT, seller TEXT,
    location TEXT, first_seen_at TEXT DEFAULT (datetime('now')),
    watchers INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS identified_cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT, listing_id TEXT,
    card_name TEXT, card_set TEXT, card_number TEXT, rarity TEXT,
    condition_est TEXT, is_holo INTEGER DEFAULT 0, is_1st_ed INTEGER DEFAULT 0,
    confidence REAL DEFAULT 0, market_price REAL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (listing_id) REFERENCES listings(id)
  );
  CREATE TABLE IF NOT EXISTS deals (
    id INTEGER PRIMARY KEY AUTOINCREMENT, listing_id TEXT, card_id INTEGER,
    listing_price REAL, market_price REAL, discount_pct REAL,
    deal_tier TEXT, deal_score REAL, created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (listing_id) REFERENCES listings(id)
  );
  CREATE INDEX IF NOT EXISTS idx_deals_score ON deals(deal_score DESC);
  CREATE INDEX IF NOT EXISTS idx_listings_seen ON listings(first_seen_at);
`);

// ── NEW: Portfolio tables ──
db.exec(`
  CREATE TABLE IF NOT EXISTS portfolio_cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    card_name TEXT NOT NULL,
    card_set TEXT DEFAULT '',
    card_number TEXT DEFAULT '',
    rarity TEXT DEFAULT 'Unknown',
    condition TEXT DEFAULT 'Unknown',
    is_holo INTEGER DEFAULT 0,
    is_first_edition INTEGER DEFAULT 0,
    confidence REAL DEFAULT 0,
    image_data TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    added_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS price_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    card_id INTEGER NOT NULL,
    price REAL NOT NULL,
    source TEXT DEFAULT 'market',
    recorded_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (card_id) REFERENCES portfolio_cards(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_price_history_card ON price_history(card_id, recorded_at DESC);
`);

// ── Portfolio DB helpers ──
function insertPortfolioCard(card) {
    return db.prepare(`INSERT INTO portfolio_cards (card_name, card_set, card_number, rarity, condition, is_holo, is_first_edition, confidence, image_data, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        card.card_name, card.card_set || '', card.card_number || '', card.rarity || 'Unknown',
        card.condition || 'Unknown', card.is_holo ? 1 : 0, card.is_first_edition ? 1 : 0,
        card.confidence || 0, card.image_data || '', card.notes || ''
    );
}

function insertPricePoint(cardId, price, source) {
    return db.prepare(`INSERT INTO price_history (card_id, price, source) VALUES (?, ?, ?)`)
        .run(cardId, price, source || 'market');
}

function getAllPortfolioCards() {
    return db.prepare(`
        SELECT pc.*,
            (SELECT ph.price FROM price_history ph WHERE ph.card_id = pc.id ORDER BY ph.recorded_at DESC LIMIT 1) as current_price,
            (SELECT ph.price FROM price_history ph WHERE ph.card_id = pc.id ORDER BY ph.recorded_at DESC LIMIT 1 OFFSET 1) as previous_price
        FROM portfolio_cards pc
        ORDER BY (SELECT ph.price FROM price_history ph WHERE ph.card_id = pc.id ORDER BY ph.recorded_at DESC LIMIT 1) DESC
    `).all();
}

function getCardPriceHistory(cardId) {
    return db.prepare(`SELECT price, source, recorded_at FROM price_history WHERE card_id = ? ORDER BY recorded_at ASC`).all(cardId);
}

function deletePortfolioCard(cardId) {
    db.prepare(`DELETE FROM price_history WHERE card_id = ?`).run(cardId);
    db.prepare(`DELETE FROM portfolio_cards WHERE id = ?`).run(cardId);
}

function getPortfolioStats() {
    const totalCards = db.prepare('SELECT COUNT(*) as c FROM portfolio_cards').get().c;
    const totalValue = db.prepare(`
        SELECT COALESCE(SUM(latest.price), 0) as total FROM (
            SELECT ph.price FROM portfolio_cards pc
            JOIN price_history ph ON ph.card_id = pc.id
            WHERE ph.id = (SELECT id FROM price_history WHERE card_id = pc.id ORDER BY recorded_at DESC LIMIT 1)
        ) latest
    `).get().total;
    const prevValue = db.prepare(`
        SELECT COALESCE(SUM(prev.price), 0) as total FROM (
            SELECT ph.price FROM portfolio_cards pc
            JOIN price_history ph ON ph.card_id = pc.id
            WHERE ph.id = (SELECT id FROM price_history WHERE card_id = pc.id ORDER BY recorded_at DESC LIMIT 1 OFFSET 1)
        ) prev
    `).get().total;
    return { totalCards, totalValue, prevValue };
}

// Legacy helpers
function getCachedPrice(name, set) {
    const r = db.prepare(`SELECT market_price FROM identified_cards WHERE card_name=? AND card_set=?
    AND market_price IS NOT NULL AND created_at>datetime('now','-24 hours') ORDER BY created_at DESC LIMIT 1`).get(name, set || '');
    return r ? r.market_price : null;
}

// ═══════════════════════════════════════════════════════════════
//  VISION AI (Gemini)
// ═══════════════════════════════════════════════════════════════

let geminiModel = null;
if (GEMINI_KEY && GEMINI_KEY !== 'your_gemini_api_key_here') {
    const genAI = new GoogleGenerativeAI(GEMINI_KEY);
    geminiModel = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    console.log('🤖 Vision AI: ✅ Enabled (Gemini 2.5 Flash)');
} else {
    console.log('🤖 Vision AI: ❌ Disabled — add GEMINI_API_KEY to .env');
}

const CARD_ID_PROMPT = `You are an expert Pokemon TCG card identifier. Analyze this image and identify any Pokemon cards.
Look closely at the card name, set symbol, card number, rarity, holographic patterns, 1st edition stamps, and condition.

Return ONLY valid JSON (no markdown fences):
{
  "cards": [{
    "card_name": "Pokemon name",
    "card_set": "Set name",
    "card_number": "e.g. 4/102",
    "rarity": "Common|Uncommon|Rare|Rare Holo|Rare Ultra|Secret Rare|Illustration Rare|Unknown",
    "condition_estimate": "Mint|Near Mint|Lightly Played|Moderately Played|Heavily Played|Damaged|Unknown",
    "is_holographic": true/false,
    "is_first_edition": true/false,
    "estimated_value_usd": number,
    "confidence": 0.0 to 1.0,
    "notes": "Any identifying features or damage"
  }],
  "is_pokemon_card": true/false
}`;

function parseAiJson(text) {
    try {
        const cleaned = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
        return JSON.parse(cleaned);
    } catch {
        const m = text.match(/\{[\s\S]*\}/);
        if (m) try { return JSON.parse(m[0]); } catch { }
        console.error(`  [parseAiJson] Failed to parse: ${text.substring(0, 100)}...`);
        return null;
    }
}

async function analyzeImageBuffer(buffer, mimeType) {
    if (!geminiModel) return null;
    try {
        const base64Data = buffer.toString('base64');
        const result = await geminiModel.generateContent([
            CARD_ID_PROMPT,
            { inlineData: { data: base64Data, mimeType } }
        ]);
        const text = result.response.text();
        return parseAiJson(text);
    } catch (err) {
        console.error('  [Vision Analysis] Error:', err.message);
        return null;
    }
}

// ═══════════════════════════════════════════════════════════════
//  PRICING
// ═══════════════════════════════════════════════════════════════

const priceCache = new Map();

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function parsePrice(p) { if (typeof p === 'number') return p; return parseFloat((p || '').replace(/[^0-9.]/g, '')) || 0; }

function checkKnownCards(name, set) {
    const n = (name || '').toLowerCase(), s = (set || '').toLowerCase();
    for (const c of HIGH_VALUE_CARDS) {
        if (c.name.toLowerCase() === n && (!c.set || s.includes(c.set.toLowerCase()))) return c.minValue;
    }
    return null;
}

// Rotating user agents
const USER_AGENTS = [
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:134.0) Gecko/20100101 Firefox/134.0',
];
function randomUA() { return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]; }

function makeHeaders(extra = {}) {
    return {
        'User-Agent': randomUA(),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Cache-Control': 'no-cache',
        ...extra
    };
}

async function lookupMarketPrice(cardName, cardSet, cardNumber) {
    if (!cardName) return null;
    const key = `${cardName}|${cardSet || ''}`.toLowerCase();

    const q = [cardName, cardSet, cardNumber].filter(Boolean).join(' ');
    const sourceUrl = `https://www.tcgplayer.com/search/pokemon/product?q=${encodeURIComponent(q)}&view=grid`;

    const cached = priceCache.get(key);
    if (cached && Date.now() - cached.ts < 86400000) return { price: cached.price, sourceUrl };

    const dbCached = getCachedPrice(cardName, cardSet || '');
    if (dbCached) {
        priceCache.set(key, { price: dbCached, ts: Date.now() });
        return { price: dbCached, sourceUrl };
    }

    const known = checkKnownCards(cardName, cardSet);
    if (known) {
        priceCache.set(key, { price: known, ts: Date.now() });
        return { price: known, sourceUrl };
    }

    // Try eBay scrape for a live price
    try {
        const listings = await scrapeEbayRSS(`${cardName} ${cardSet || ''} pokemon card`);
        if (listings.length > 0) {
            // Filter out lots and graded, get median price
            const filtered = listings.filter(l => {
                const t = l.title.toLowerCase();
                return !['lot', 'psa', 'bgs', 'cgc', 'graded', 'proxy', 'custom', 'orica', 'replica'].some(kw => t.includes(kw));
            });
            if (filtered.length > 0) {
                filtered.sort((a, b) => a.price - b.price);
                const medianPrice = filtered[Math.floor(filtered.length / 2)].price;
                priceCache.set(key, { price: medianPrice, ts: Date.now() });
                return { price: medianPrice, sourceUrl };
            }
        }
    } catch (err) {
        console.error(`  [Pricing] eBay scrape failed for ${cardName}:`, err.message);
    }

    // Try TCGPlayer scrape
    try {
        await sleep(RATE_LIMITS.priceCheck);
        const resp = await axios.get(sourceUrl, { headers: makeHeaders(), timeout: 20000 });
        const { load } = await import('cheerio');
        const $ = load(resp.data);
        let price = null;
        $('[class*="product-card"], .search-result').each((i, el) => {
            if (i > 0 || price) return;
            const txt = $(el).find('[class*="market-price"], [class*="price"], .price').first().text();
            const m = txt.match(/\$?([\d,]+\.?\d*)/);
            if (m) price = parseFloat(m[1].replace(',', ''));
        });
        if (price) {
            priceCache.set(key, { price, ts: Date.now() });
            return { price, sourceUrl };
        }
    } catch (err) {
        console.error(`  [Pricing] TCGPlayer scrape failed for ${cardName}:`, err.message);
    }

    return null;
}

// ═══════════════════════════════════════════════════════════════
//  SCRAPERS (eBay RSS only for price lookups — fast and reliable)
// ═══════════════════════════════════════════════════════════════

async function scrapeEbayRSS(searchTerm) {
    const listings = [];
    try {
        const encoded = encodeURIComponent(searchTerm);
        const url = `https://www.ebay.com/sch/i.html?_nkw=${encoded}&_sacat=183454&_sop=10&LH_BIN=1&_rss=1`;
        const resp = await axios.get(url, {
            headers: { 'User-Agent': randomUA(), 'Accept': 'application/rss+xml,application/xml,text/xml' },
            timeout: 20000,
        });
        const { load } = await import('cheerio');
        const $ = load(resp.data, { xmlMode: true });
        $('item').each((i, el) => {
            if (i >= 40) return false;
            const $el = $(el);
            const title = $el.find('title').text().trim();
            const link = $el.find('link').text().trim();
            const itemId = link.match(/\/itm\/(\d+)/)?.[1];
            const desc = $el.find('description').text();
            const priceMatch = desc.match(/Price:\s*US\s*\$([\d,.]+)/i) || desc.match(/\$([\d,.]+)/);
            const price = priceMatch ? parsePrice(priceMatch[1]) : 0;
            const imgMatch = desc.match(/src="([^"]*ebayimg[^"]*)"/i);
            const imgSrc = imgMatch ? imgMatch[1].replace(/s-l\d+/, 's-l500') : '';
            if (title && itemId && price > 0) {
                listings.push({
                    id: `ebay_${itemId}`, marketplace: 'ebay', title, price,
                    imageUrls: imgSrc ? [imgSrc] : [], listingUrl: link.split('?')[0],
                    postedAt: new Date().toISOString()
                });
            }
        });
    } catch (err) {
        console.error(`  [eBay-RSS] Error: ${err.message}`);
    }
    return listings;
}

// ═══════════════════════════════════════════════════════════════
//  SSE (Server-Sent Events) for real-time updates
// ═══════════════════════════════════════════════════════════════

const sseClients = new Set();

function broadcast(event) {
    const data = JSON.stringify(event);
    for (const client of sseClients) {
        try { client.write(`data: ${data}\n\n`); } catch { sseClients.delete(client); }
    }
}

function broadcastActivity(type, message) {
    broadcast({ type: 'activity', activityType: type, message, timestamp: new Date().toISOString() });
}

// ═══════════════════════════════════════════════════════════════
//  BACKGROUND PRICE REFRESH
// ═══════════════════════════════════════════════════════════════

let priceRefreshRunning = false;

async function refreshAllPrices() {
    if (priceRefreshRunning) {
        console.log('  [PriceRefresh] Already running, skipping.');
        return { skipped: true };
    }
    priceRefreshRunning = true;
    console.log('  [PriceRefresh] Starting price refresh for all portfolio cards...');
    broadcastActivity('refresh_start', 'Refreshing market prices...');

    const cards = db.prepare('SELECT * FROM portfolio_cards').all();
    let updated = 0;

    for (const card of cards) {
        try {
            const result = await lookupMarketPrice(card.card_name, card.card_set, card.card_number);
            if (result && result.price > 0) {
                insertPricePoint(card.id, result.price, 'market');
                updated++;
            } else if (card.id) {
                // If no live price found, check if we have any price at all — if not, use AI estimate
                const hasPrice = db.prepare('SELECT 1 FROM price_history WHERE card_id = ? LIMIT 1').get(card.id);
                if (!hasPrice) {
                    // No price exists at all, can't do much
                    console.log(`  [PriceRefresh] No price found for ${card.card_name}`);
                }
            }
            await sleep(1500); // Rate limit between cards
        } catch (err) {
            console.error(`  [PriceRefresh] Error for ${card.card_name}:`, err.message);
        }
    }

    priceRefreshRunning = false;
    console.log(`  [PriceRefresh] Complete. Updated ${updated}/${cards.length} cards.`);
    broadcastActivity('refresh_complete', `Updated prices for ${updated} cards`);
    broadcast({ type: 'portfolio_updated' });
    return { updated, total: cards.length };
}

// Auto-refresh every 6 hours
const REFRESH_INTERVAL = 6 * 60 * 60 * 1000;
setInterval(() => {
    refreshAllPrices().catch(err => console.error('[AutoRefresh] Error:', err.message));
}, REFRESH_INTERVAL);

// Initial refresh 30 seconds after startup (give server time to boot)
setTimeout(() => {
    refreshAllPrices().catch(err => console.error('[InitialRefresh] Error:', err.message));
}, 30000);

// ═══════════════════════════════════════════════════════════════
//  EXPRESS SERVER
// ═══════════════════════════════════════════════════════════════

const app = express();
app.use(express.json());

// Serve static files
app.use(express.static(__dirname));

// ── Portfolio API ──

// Get all portfolio cards with latest + previous prices
app.get('/api/portfolio', (req, res) => {
    try {
        const cards = getAllPortfolioCards();
        const stats = getPortfolioStats();
        res.json({ cards, stats });
    } catch (err) {
        console.error('Portfolio fetch error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Get price history for a single card
app.get('/api/portfolio/:id/history', (req, res) => {
    try {
        const history = getCardPriceHistory(parseInt(req.params.id));
        res.json({ history });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Delete a card from portfolio
app.delete('/api/portfolio/:id', (req, res) => {
    try {
        deletePortfolioCard(parseInt(req.params.id));
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Manually trigger price refresh
app.post('/api/portfolio/refresh-prices', async (req, res) => {
    try {
        res.json({ success: true, message: 'Price refresh started.' });
        refreshAllPrices().catch(err => console.error('Manual refresh error:', err));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Upload photos → AI identifies → saves to portfolio
app.post('/api/portfolio/upload', upload.array('photos'), async (req, res) => {
    try {
        const files = req.files;
        if (!files || files.length === 0) {
            return res.status(400).json({ success: false, message: 'No photos provided.' });
        }

        broadcastActivity('upload_start', `Analyzing ${files.length} photos...`);

        // Process asynchronously
        processPortfolioUpload(files).catch(err => {
            console.error('Portfolio upload error:', err);
            broadcastActivity('error', `Upload error: ${err.message}`);
        });

        res.json({ success: true, message: 'Processing started.' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

async function processPortfolioUpload(files) {
    let totalAdded = 0;

    for (const [index, file] of files.entries()) {
        try {
            broadcastActivity('analyzing', `Scanning photo ${index + 1} of ${files.length}...`);

            const analysis = await analyzeImageBuffer(file.buffer, file.mimetype);
            if (!analysis || !analysis.cards || analysis.cards.length === 0) {
                broadcastActivity('info', `No cards found in photo ${index + 1}.`);
                continue;
            }

            broadcastActivity('found', `Found ${analysis.cards.length} cards in photo ${index + 1}`);

            // Create a small thumbnail from the uploaded image
            const thumbBase64 = file.buffer.toString('base64');
            const thumbDataUrl = `data:${file.mimetype};base64,${thumbBase64}`;

            for (const card of analysis.cards) {
                // Insert card into portfolio
                const result = insertPortfolioCard({
                    card_name: card.card_name,
                    card_set: card.card_set || '',
                    card_number: card.card_number || '',
                    rarity: card.rarity || 'Unknown',
                    condition: card.condition_estimate || 'Unknown',
                    is_holo: card.is_holographic || false,
                    is_first_edition: card.is_first_edition || false,
                    confidence: card.confidence || 0,
                    image_data: analysis.cards.length === 1 ? thumbDataUrl : '',
                    notes: card.notes || ''
                });

                const cardId = result.lastInsertRowid;

                // Get initial market price
                let price = card.estimated_value_usd || 0;
                try {
                    const marketResult = await lookupMarketPrice(card.card_name, card.card_set, card.card_number);
                    if (marketResult && marketResult.price > 0) {
                        price = marketResult.price;
                    }
                } catch (err) {
                    console.error(`  Price lookup failed for ${card.card_name}:`, err.message);
                }

                // Record initial price
                if (price > 0) {
                    insertPricePoint(cardId, price, 'initial');
                }

                totalAdded++;
                broadcastActivity('card_added', `Added ${card.card_name} — $${price.toFixed(2)}`);
                await sleep(500); // Small delay between price lookups
            }
        } catch (err) {
            console.error(`Photo ${index + 1} error:`, err.message);
            broadcastActivity('error', `Error on photo ${index + 1}: ${err.message}`);
        }
    }

    broadcastActivity('upload_complete', `Added ${totalAdded} cards to your portfolio!`);
    broadcast({ type: 'portfolio_updated' });
}

// SSE endpoint
app.get('/api/events', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    sseClients.add(res);
    res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
    req.on('close', () => sseClients.delete(res));
});

// Fallback to index.html
app.get('*', (req, res) => { res.sendFile(join(__dirname, 'index.html')); });

// ═══════════════════════════════════════════════════════════════
//  START
// ═══════════════════════════════════════════════════════════════

console.log(`
╔══════════════════════════════════════════════════╗
║  📊 Jack's Pokemon Portfolio Tracker             ║
║  Live market values for your collection          ║
╚══════════════════════════════════════════════════╝
`);

app.listen(PORT, () => {
    console.log(`🌐 Dashboard running at http://localhost:${PORT}`);
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down...');
    db.close();
    process.exit(0);
});
