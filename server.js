/**
 * Jack's Pokemon Packs — Portfolio Tracker Server v3
 *
 * Express server that:
 * 1. Serves the portfolio dashboard (static HTML/CSS/JS)
 * 2. Stores cards permanently in a SQLite portfolio database
 * 3. Analyzes uploaded card photos with Gemini Vision AI
 * 4. Fetches accurate market prices via Pokemon TCG API + eBay
 * 5. Tracks price history over time with background refresh
 */

import 'dotenv/config';
import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';
import { GoogleGenerativeAI } from '@google/generative-ai';
import axios from 'axios';
import multer from 'multer';
import sharp from 'sharp';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '3000', 10);
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
const POKEMON_TCG_KEY = process.env.POKEMON_TCG_API_KEY || '';

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
    image_url TEXT DEFAULT '',
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

// Add image_url column if it doesn't exist (migration for existing DBs)
try {
    db.exec(`ALTER TABLE portfolio_cards ADD COLUMN image_url TEXT DEFAULT ''`);
    console.log('  [DB] Added image_url column.');
} catch { /* column already exists */ }

// ── Portfolio DB helpers ──
function insertPortfolioCard(card) {
    return db.prepare(`INSERT INTO portfolio_cards (card_name, card_set, card_number, rarity, condition, is_holo, is_first_edition, confidence, image_data, image_url, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        card.card_name, card.card_set || '', card.card_number || '', card.rarity || 'Unknown',
        card.condition || 'Unknown', card.is_holo ? 1 : 0, card.is_first_edition ? 1 : 0,
        card.confidence || 0, card.image_data || '', card.image_url || '', card.notes || ''
    );
}

function updateCardImageUrl(cardId, imageUrl) {
    db.prepare(`UPDATE portfolio_cards SET image_url = ? WHERE id = ?`).run(imageUrl, cardId);
}

function insertPricePoint(cardId, price, source) {
    return db.prepare(`INSERT INTO price_history (card_id, price, source) VALUES (?, ?, ?)`)
        .run(cardId, price, source || 'market');
}

function getAllPortfolioCards() {
    // Use a CTE to get current and previous prices reliably (avoids OFFSET on subquery bug)
    return db.prepare(`
        WITH ranked_prices AS (
            SELECT
                card_id,
                price,
                source,
                recorded_at,
                ROW_NUMBER() OVER (PARTITION BY card_id ORDER BY recorded_at DESC) as rn
            FROM price_history
        ),
        latest AS (
            SELECT card_id, price as current_price, source as price_source FROM ranked_prices WHERE rn = 1
        ),
        prev AS (
            SELECT card_id, price as previous_price FROM ranked_prices WHERE rn = 2
        )
        SELECT pc.*,
            COALESCE(l.current_price, NULL) as current_price,
            COALESCE(p.previous_price, NULL) as previous_price,
            COALESCE(l.price_source, NULL) as price_source
        FROM portfolio_cards pc
        LEFT JOIN latest l ON l.card_id = pc.id
        LEFT JOIN prev   p ON p.card_id  = pc.id
        ORDER BY COALESCE(l.current_price, 0) DESC
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
//  TCGDEX IMAGE LOOKUP (free, no API key)
// ═══════════════════════════════════════════════════════════════

async function fetchCardImageFromTCGdex(cardName, cardSet, cardNumber) {
    try {
        const searchName = encodeURIComponent(cardName.trim());
        const resp = await axios.get(`https://api.tcgdex.net/v2/en/cards?name=${searchName}`, {
            timeout: 10000,
            headers: { 'Accept': 'application/json' }
        });
        const results = resp.data;
        if (!Array.isArray(results) || results.length === 0) return null;

        // Try to match by card number first (most specific)
        if (cardNumber) {
            const numClean = cardNumber.replace(/^0+/, '').split('/')[0];
            const byNumber = results.find(r => {
                const localClean = (r.localId || '').replace(/^0+/, '');
                return localClean === numClean;
            });
            if (byNumber) return byNumber.image + '/high.webp';
        }

        // Try to match by set name
        if (cardSet) {
            // Need to fetch full card details to check set name
            for (const candidate of results.slice(0, 5)) {
                try {
                    const detail = await axios.get(`https://api.tcgdex.net/v2/en/cards/${candidate.id}`, {
                        timeout: 8000,
                        headers: { 'Accept': 'application/json' }
                    });
                    if (detail.data.set && detail.data.set.name) {
                        const setNameLower = detail.data.set.name.toLowerCase();
                        const targetSetLower = cardSet.toLowerCase();
                        if (setNameLower.includes(targetSetLower) || targetSetLower.includes(setNameLower)) {
                            return candidate.image + '/high.webp';
                        }
                    }
                } catch { /* skip */ }
            }
        }

        // Fallback: use first result
        return results[0].image + '/high.webp';
    } catch (err) {
        console.error(`  [TCGdex] Error looking up "${cardName}":`, err.message);
        return null;
    }
}

// ═══════════════════════════════════════════════════════════════
//  VISION AI (Gemini)
// ═══════════════════════════════════════════════════════════════

let geminiModel = null;
if (GEMINI_KEY && GEMINI_KEY !== 'your_gemini_api_key_here') {
    const genAI = new GoogleGenerativeAI(GEMINI_KEY);
    geminiModel = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });
    console.log('🤖 Vision AI: ✅ Enabled (Gemini 2.0 Flash Exp)');
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

// MIME types that Gemini accepts directly
const GEMINI_SUPPORTED_TYPES = new Set([
    'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif'
]);

async function convertToJpeg(buffer) {
    try {
        const converted = await sharp(buffer)
            .jpeg({ quality: 90 })
            .toBuffer();
        return converted;
    } catch (err) {
        console.error('  [Sharp] Conversion failed:', err.message);
        return null;
    }
}

async function analyzeImageBuffer(buffer, mimeType) {
    if (!geminiModel) return null;
    try {
        let sendBuffer = buffer;
        let sendMime = mimeType;

        // Convert unsupported formats (DNG, CR2, NEF, ARW, etc.) to JPEG
        if (!GEMINI_SUPPORTED_TYPES.has(mimeType)) {
            console.log(`  [Vision] Converting ${mimeType} → JPEG for Gemini...`);
            const converted = await convertToJpeg(buffer);
            if (!converted) {
                console.error(`  [Vision] Could not convert ${mimeType} — skipping`);
                return null;
            }
            sendBuffer = converted;
            sendMime = 'image/jpeg';
        }

        const base64Data = sendBuffer.toString('base64');
        const result = await geminiModel.generateContent([
            CARD_ID_PROMPT,
            { inlineData: { data: base64Data, mimeType: sendMime } }
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

const uploadDir = join(tmpdir(), 'pokemon-uploads');
mkdirSync(uploadDir, { recursive: true });

const upload = multer({
    dest: uploadDir,
    limits: {
        fileSize: 100 * 1024 * 1024, // 100MB per file
        files: 50                     // up to 50 files at once
    }
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
    const key = `${cardName}|${cardSet || ''}|${cardNumber || ''}`.toLowerCase();

    const cached = priceCache.get(key);
    if (cached && Date.now() - cached.ts < 86400000) return { price: cached.price, source: cached.source };

    const known = checkKnownCards(cardName, cardSet);
    if (known) {
        priceCache.set(key, { price: known, source: 'reference', ts: Date.now() });
        return { price: known, source: 'reference' };
    }

    // ── Strategy 1: Pokemon TCG API (free tier — 1000 req/day, has TCGPlayer market prices) ──
    try {
        const headers = { 'Accept': 'application/json' };
        if (POKEMON_TCG_KEY) headers['X-Api-Key'] = POKEMON_TCG_KEY;

        // Build query — try card number + name, or just name
        let searchUrl;
        if (cardNumber) {
            const num = cardNumber.split('/')[0].replace(/^0+/, '');
            searchUrl = `https://api.pokemontcg.io/v2/cards?q=name:"${encodeURIComponent(cardName)}" number:${num}&pageSize=10`;
        } else {
            searchUrl = `https://api.pokemontcg.io/v2/cards?q=name:"${encodeURIComponent(cardName)}"&orderBy=-tcgplayer.prices.holofoil.market&pageSize=10`;
        }

        const resp = await axios.get(searchUrl, { headers, timeout: 15000 });
        const results = resp.data?.data || [];

        // Try to match set if we have one
        let match = null;
        if (cardSet && results.length > 1) {
            const setLower = cardSet.toLowerCase();
            match = results.find(c => (c.set?.name || '').toLowerCase().includes(setLower) || setLower.includes((c.set?.name || '').toLowerCase()));
        }
        if (!match) match = results[0];

        if (match) {
            // Extract market price from TCGPlayer data (prefer holofoil > normal > 1st edition)
            const prices = match.tcgplayer?.prices;
            let price = null;
            if (prices) {
                price = prices.holofoil?.market
                    || prices.reverseHolofoil?.market
                    || prices.normal?.market
                    || prices['1stEditionHolofoil']?.market
                    || prices.unlimited?.market
                    || null;
            }
            // Fallback to cardmarket
            if (!price && match.cardmarket?.prices) {
                price = match.cardmarket.prices.averageSellPrice || match.cardmarket.prices.trendPrice || null;
            }

            if (price && price > 0) {
                console.log(`  [Pricing] Pokemon TCG API for "${cardName}": $${price.toFixed(2)} (${match.set?.name})`);
                priceCache.set(key, { price, source: 'pokemon_tcg_api', ts: Date.now() });
                return { price, source: 'pokemon_tcg_api' };
            }
        }
    } catch (err) {
        console.error(`  [Pricing] Pokemon TCG API failed for "${cardName}":`, err.message);
    }

    // ── Strategy 2: eBay RSS (multiple query variants) ──
    const searchQueries = [
        cardNumber ? `"${cardName}" ${cardNumber} pokemon card` : null,
        `"${cardName}" ${cardSet || ''} pokemon card`,
        `"${cardName}" pokemon card`,
    ].filter(Boolean);

    for (const query of searchQueries) {
        try {
            const listings = await scrapeEbayRSS(query);
            if (listings.length > 0) {
                const filtered = listings.filter(l => {
                    const t = l.title.toLowerCase();
                    return !['lot', 'bundle', 'psa', 'bgs', 'cgc', 'graded', 'proxy', 'custom', 'orica', 'replica', 'fake', 'repack'].some(kw => t.includes(kw));
                });
                if (filtered.length >= 2) {
                    filtered.sort((a, b) => a.price - b.price);
                    const medianIdx = Math.floor(filtered.length / 2);
                    const medianPrice = filtered[medianIdx].price;
                    console.log(`  [Pricing] eBay median for "${cardName}": $${medianPrice.toFixed(2)} (${filtered.length} listings)`);
                    priceCache.set(key, { price: medianPrice, source: 'ebay', ts: Date.now() });
                    return { price: medianPrice, source: 'ebay' };
                } else if (filtered.length === 1) {
                    const price = filtered[0].price;
                    priceCache.set(key, { price, source: 'ebay', ts: Date.now() });
                    return { price, source: 'ebay' };
                }
            }
            await sleep(RATE_LIMITS.ebay);
        } catch (err) {
            console.error(`  [Pricing] eBay scrape failed for "${cardName}":`, err.message);
        }
    }

    console.log(`  [Pricing] No market price found for "${cardName}"`);
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
            // Also back-fill missing TCGdex images
            if (!card.image_url) {
                const imageUrl = await fetchCardImageFromTCGdex(card.card_name, card.card_set, card.card_number);
                if (imageUrl) {
                    updateCardImageUrl(card.id, imageUrl);
                    console.log(`  [PriceRefresh] Found image for ${card.card_name}`);
                }
            }

            const result = await lookupMarketPrice(card.card_name, card.card_set, card.card_number);
            if (result && result.price > 0) {
                insertPricePoint(card.id, result.price, result.source || 'market');
                updated++;
                broadcastActivity('price_update', `${card.card_name}: $${result.price.toFixed(2)} (${result.source})`);
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

// CORS — allow local dev
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

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
// Accepts field name 'cards' (from the frontend drop-zone) OR 'photos' (legacy)
app.post('/api/portfolio/upload', (req, res) => {
    const uploader = upload.fields([
        { name: 'cards', maxCount: 20 },
        { name: 'photos', maxCount: 20 },
    ]);
    uploader(req, res, async (err) => {
        if (err) {
            const message = err.code === 'LIMIT_FILE_SIZE'
                ? 'File too large. Max 100 MB per image.'
                : err.code === 'LIMIT_FILE_COUNT'
                    ? 'Too many files. Max 20 images per upload.'
                    : err.message || 'Upload failed.';
            console.error('Upload error:', err.message);
            return res.status(400).json({ success: false, error: message });
        }

        try {
            const files = [
                ...(req.files?.cards || []),
                ...(req.files?.photos || []),
            ];
            if (!files.length) {
                return res.status(400).json({ success: false, error: 'No photos provided.' });
            }

            broadcastActivity('upload_start', `Analyzing ${files.length} photo${files.length > 1 ? 's' : ''}...`);

            // Process synchronously so we can return the results
            const result = await processPortfolioUpload(files);
            res.json({ success: true, cards: result.cards, message: `Added ${result.totalAdded} card(s)` });
        } catch (err) {
            console.error('Portfolio upload error:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    });
});

async function processPortfolioUpload(files) {
    let totalAdded = 0;
    const addedCards = [];

    broadcastActivity('analyzing', `Scanning ${files.length} photo${files.length > 1 ? 's' : ''} with AI...`);

    // 1. Analyze images sequentially (prevents OOM on Render free tier)
    for (let index = 0; index < files.length; index++) {
        const file = files[index];
        broadcastActivity('analyzing', `Scanning photo ${index + 1} of ${files.length}...`);

        let buffer, analysis, thumbDataUrl = '';
        try {
            buffer = readFileSync(file.path);
            analysis = await analyzeImageBuffer(buffer, file.mimetype);

            // Create thumbnail
            try {
                const thumbBuffer = await sharp(buffer)
                    .resize(400, 560, { fit: 'inside', withoutEnlargement: true })
                    .jpeg({ quality: 80 })
                    .toBuffer();
                thumbDataUrl = `data:image/jpeg;base64,${thumbBuffer.toString('base64')}`;
            } catch (e) { console.error(`  [Thumb] Failed for photo ${index + 1}:`, e.message); }

            try { rmSync(file.path, { force: true }); } catch { }
        } catch (err) {
            console.error(`Photo ${index + 1} error:`, err.message);
            try { rmSync(file.path, { force: true }); } catch { }
            continue;
        }

        if (!analysis?.cards?.length) {
            broadcastActivity('info', `No Pokemon card detected in photo ${index + 1}.`);
            continue;
        }

        broadcastActivity('found', `Found ${analysis.cards.length} card(s) in photo ${index + 1}`);

        for (const card of analysis.cards) {
            // Look up official card image from TCGdex
            let imageUrl = '';
            try {
                imageUrl = await fetchCardImageFromTCGdex(card.card_name, card.card_set, card.card_number) || '';
            } catch { /* continue without image */ }

            const dbResult = insertPortfolioCard({
                card_name: card.card_name,
                card_set: card.card_set || '',
                card_number: card.card_number || '',
                rarity: card.rarity || 'Unknown',
                condition: card.condition_estimate || 'Unknown',
                is_holo: card.is_holographic || false,
                is_first_edition: card.is_first_edition || false,
                confidence: card.confidence || 0,
                image_data: thumbDataUrl,
                image_url: imageUrl,
                notes: card.notes || ''
            });

            const cardId = dbResult.lastInsertRowid;

            // Use AI estimate as initial price — background refresh will add real prices
            const aiPrice = card.estimated_value_usd || 0;
            if (aiPrice > 0) {
                insertPricePoint(cardId, aiPrice, 'ai_estimate');
            }

            totalAdded++;
            addedCards.push({
                id: cardId,
                card_name: card.card_name,
                card_set: card.card_set || '',
                card_number: card.card_number || '',
                rarity: card.rarity || 'Unknown',
                condition: card.condition_estimate || 'Unknown',
                is_holo: card.is_holographic || false,
                is_first_edition: card.is_first_edition || false,
                confidence: card.confidence || 0,
                image_url: imageUrl || '',
                image_data: thumbDataUrl ? thumbDataUrl.substring(0, 100) + '...' : '',  // truncate for response
                current_price: aiPrice,
                estimated_value: aiPrice,
                price_source: 'ai_estimate',
            });

            broadcastActivity('card_added', `✅ ${card.card_name} — $${aiPrice.toFixed(2)} (AI estimate)${imageUrl ? ' 🖼️' : ''}`);
        }
    }

    broadcastActivity('upload_complete', `Added ${totalAdded} card${totalAdded !== 1 ? 's' : ''} to your portfolio!`);
    broadcast({ type: 'card_added' });

    // Fire-and-forget: get real market prices after user sees cards
    if (totalAdded > 0) {
        setTimeout(() => {
            refreshAllPrices().catch(err => console.error('[Post-upload refresh] Error:', err.message));
        }, 2000);
    }

    return { totalAdded, cards: addedCards };
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
║  ⚡ Jack's Pokemon Portfolio Tracker v3          ║
║  AI Vision + Live Market Prices                  ║
╚══════════════════════════════════════════════════╝
`);
console.log('💰 Pokemon TCG API:', POKEMON_TCG_KEY ? '✅ Key loaded' : '⚠️  No key (rate-limited)');

app.listen(PORT, () => {
    console.log(`🌐 Dashboard running at http://localhost:${PORT}`);
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down...');
    db.close();
    process.exit(0);
});
