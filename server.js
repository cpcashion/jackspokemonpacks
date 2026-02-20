/**
 * Jack's Pokemon Packs — Integrated Server
 * 
 * Single Express server that:
 * 1. Serves the website (static HTML/CSS/JS)
 * 2. Runs marketplace scrapers (eBay, Mercari, OfferUp, Facebook)
 * 3. Analyzes listing images with Gemini Vision AI
 * 4. Looks up market prices
 * 5. Scores deals and broadcasts results via SSE
 */

import 'dotenv/config';
import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync } from 'fs';
import Database from 'better-sqlite3';
import { GoogleGenerativeAI } from '@google/generative-ai';
import axios from 'axios';
import cron from 'node-cron';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '3000', 10);
const SCAN_INTERVAL = parseInt(process.env.SCAN_INTERVAL_MINUTES || '3', 10);
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';

// ═══════════════════════════════════════════════════════════════
//  CONFIG
// ═══════════════════════════════════════════════════════════════

const SEARCH_TERMS = [
    'pokemon card',
    'pokemon cards lot',
    'pokemon tcg',
    'pokemon card rare',
    'charizard card',
    'pokemon first edition',
    'pokemon holographic card',
    'pokemon card vintage',
    'pokemon card psa',
    'pokemon card shadowless',
    'pokemon card collection',
    'pokemon booster box',
];

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

const RATE_LIMITS = { ebay: 1200, mercari: 2000, offerup: 2000, facebook: 5000, priceCheck: 1500 };

// ═══════════════════════════════════════════════════════════════
//  DATABASE
// ═══════════════════════════════════════════════════════════════

mkdirSync(join(__dirname, 'data'), { recursive: true });
const db = new Database(join(__dirname, 'data', 'pokesniper.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS listings (
    id TEXT PRIMARY KEY, marketplace TEXT, title TEXT, price REAL,
    image_urls TEXT, listing_url TEXT, posted_at TEXT, seller TEXT,
    location TEXT, first_seen_at TEXT DEFAULT (datetime('now'))
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

function isListingSeen(id) { return !!db.prepare('SELECT 1 FROM listings WHERE id=?').get(id); }
function insertListing(l) {
    return db.prepare(`INSERT OR IGNORE INTO listings(id,marketplace,title,price,image_urls,listing_url,posted_at,seller,location)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(l.id, l.marketplace, l.title, l.price, JSON.stringify(l.imageUrls || []), l.listingUrl, l.postedAt, l.seller || '', l.location || '').changes > 0;
}
function insertCard(c) {
    return db.prepare(`INSERT INTO identified_cards(listing_id,card_name,card_set,card_number,rarity,condition_est,is_holo,is_1st_ed,confidence,market_price)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(c.listingId, c.cardName, c.cardSet || '', c.cardNumber || '', c.rarity || 'Unknown', c.conditionEst || 'Unknown', c.isHolo ? 1 : 0, c.is1stEd ? 1 : 0, c.confidence || 0, c.marketPrice).lastInsertRowid;
}
function insertDeal(d) {
    return db.prepare(`INSERT INTO deals(listing_id,card_id,listing_price,market_price,discount_pct,deal_tier,deal_score)
    VALUES(?,?,?,?,?,?,?)`).run(d.listingId, d.cardId, d.listingPrice, d.marketPrice, d.discountPct, d.dealTier, d.dealScore).lastInsertRowid;
}
function getRecentDeals(limit = 50) {
    return db.prepare(`SELECT d.*,l.title,l.listing_url,l.image_urls,l.marketplace,l.seller,
    c.card_name,c.card_set,c.card_number,c.rarity,c.condition_est,c.is_holo,c.is_1st_ed,c.confidence
    FROM deals d JOIN listings l ON d.listing_id=l.id LEFT JOIN identified_cards c ON d.card_id=c.id
    ORDER BY d.created_at DESC LIMIT ?`).all(limit);
}
function getStats() {
    const totalListings = db.prepare('SELECT COUNT(*) as c FROM listings').get().c;
    const totalDeals = db.prepare('SELECT COUNT(*) as c FROM deals').get().c;
    const todayDeals = db.prepare("SELECT COUNT(*) as c FROM deals WHERE created_at>datetime('now','-24 hours')").get().c;
    const best = db.prepare('SELECT MAX(discount_pct) as m FROM deals').get().m;
    return { totalListings, totalDeals, todayDeals, bestDiscount: best };
}
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
    geminiModel = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
    console.log('🤖 Vision AI: ✅ Enabled (Gemini 2.0 Flash)');
} else {
    console.log('🤖 Vision AI: ❌ Disabled — add GEMINI_API_KEY to .env');
}

const CARD_ID_PROMPT = `You are an expert Pokemon TCG card identifier. Analyze this image and identify any Pokemon cards.

Return ONLY valid JSON (no markdown fences):
{
  "cards": [{
    "card_name": "Pokemon name",
    "card_set": "Set name",
    "card_number": "e.g. 4/102",
    "rarity": "Common|Uncommon|Rare|Rare Holo|Rare Ultra|Secret Rare|Illustration Rare|Unknown",
    "condition_estimate": "Mint|Near Mint|Lightly Played|Unknown",
    "is_holographic": true/false,
    "is_first_edition": true/false,
    "estimated_value_usd": number,
    "confidence": 0.0 to 1.0,
    "notes": "any observations"
  }],
  "is_pokemon_card": true/false
}`;

const QUICK_CHECK_PROMPT = `Is this a Pokemon trading card image? Reply ONLY with valid JSON (no markdown):
{"is_pokemon_card": true/false, "card_name": "name or null", "estimated_value": 0, "worth_detailed_analysis": true/false}`;

async function fetchImageAsBase64(url) {
    try {
        if (!url || url.startsWith('data:')) return null;
        const resp = await axios.get(url, {
            responseType: 'arraybuffer', timeout: 10000,
            headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' }
        });
        const mime = (resp.headers['content-type'] || 'image/jpeg').split(';')[0].trim();
        return { base64: Buffer.from(resp.data).toString('base64'), mimeType: mime };
    } catch { return null; }
}

function parseAiJson(text) {
    try {
        const cleaned = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
        return JSON.parse(cleaned);
    } catch {
        const m = text.match(/\{[\s\S]*\}/);
        if (m) try { return JSON.parse(m[0]); } catch { }
        return null;
    }
}

async function quickCheckImage(imageUrl) {
    if (!geminiModel) return { is_pokemon_card: true, worth_detailed_analysis: true }; // assume yes if no AI
    try {
        const img = await fetchImageAsBase64(imageUrl);
        if (!img) return null;
        const result = await geminiModel.generateContent([QUICK_CHECK_PROMPT,
            { inlineData: { data: img.base64, mimeType: img.mimeType } }]);
        return parseAiJson(result.response.text());
    } catch { return null; }
}

async function analyzeCardImage(imageUrl) {
    if (!geminiModel) return null;
    try {
        const img = await fetchImageAsBase64(imageUrl);
        if (!img) return null;
        const result = await geminiModel.generateContent([CARD_ID_PROMPT,
            { inlineData: { data: img.base64, mimeType: img.mimeType } }]);
        return parseAiJson(result.response.text());
    } catch (err) {
        console.error('  [Vision] Error:', err.message);
        return null;
    }
}

// ═══════════════════════════════════════════════════════════════
//  PRICING
// ═══════════════════════════════════════════════════════════════

const priceCache = new Map();

function checkKnownCards(name, set) {
    const n = (name || '').toLowerCase(), s = (set || '').toLowerCase();
    for (const c of HIGH_VALUE_CARDS) {
        if (c.name.toLowerCase() === n && (!c.set || s.includes(c.set.toLowerCase()))) return c.minValue;
    }
    return null;
}

async function lookupPrice(cardName, cardSet, cardNumber) {
    if (!cardName) return null;
    const key = `${cardName}|${cardSet || ''}`.toLowerCase();
    const cached = priceCache.get(key);
    if (cached && Date.now() - cached.ts < 86400000) return cached.price;

    const dbCached = getCachedPrice(cardName, cardSet || '');
    if (dbCached) { priceCache.set(key, { price: dbCached, ts: Date.now() }); return dbCached; }

    const known = checkKnownCards(cardName, cardSet);
    if (known) { priceCache.set(key, { price: known, ts: Date.now() }); return known; }

    // Try TCGPlayer scrape
    try {
        await sleep(RATE_LIMITS.priceCheck);
        const q = [cardName, cardSet, cardNumber].filter(Boolean).join(' ');
        const url = `https://www.tcgplayer.com/search/pokemon/product?q=${encodeURIComponent(q)}&view=grid`;
        const resp = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36', Accept: 'text/html' }, timeout: 15000 });
        const { load } = await import('cheerio');
        const $ = load(resp.data);
        let price = null;
        $('[class*="product-card"], .search-result').each((i, el) => {
            if (i > 0 || price) return;
            const txt = $(el).find('[class*="market-price"], [class*="price"], .price').first().text();
            const m = txt.match(/\$?([\d,]+\.?\d*)/);
            if (m) price = parseFloat(m[1].replace(',', ''));
        });
        if (price) { priceCache.set(key, { price, ts: Date.now() }); return price; }
    } catch { }

    return null;
}

// ═══════════════════════════════════════════════════════════════
//  DEAL SCORER
// ═══════════════════════════════════════════════════════════════

function scoreDeal({ listingPrice, marketPrice, rarity, isHolo, is1stEd, postedAt, confidence }) {
    if (!marketPrice || marketPrice <= 0 || !listingPrice || listingPrice <= 0) return null;
    const disc = (marketPrice - listingPrice) / marketPrice;
    if (disc < 0.30) return null; // minimum 30% off
    let score = disc * 100;

    const mult = {
        'Secret Rare': 1.5, 'Illustration Rare': 1.4, 'Hyper Rare': 1.4, 'Rare Ultra': 1.3,
        'Rare Holo': 1.2, 'Rare': 1.1, 'Uncommon': 1.0, 'Common': 0.8
    };
    score *= mult[rarity] || 1.0;
    if (is1stEd) score *= 1.5;
    if (isHolo) score *= 1.1;
    if (postedAt) {
        const hrs = (Date.now() - new Date(postedAt).getTime()) / 3600000;
        if (hrs < 1) score *= 1.5;
        else if (hrs < 6) score *= 1.3;
        else if (hrs < 24) score *= 1.1;
    }
    if (confidence && confidence < 1) score *= (0.5 + confidence * 0.5);

    let tier;
    if (disc >= 0.70) tier = 'incredible';
    else if (disc >= 0.50) tier = 'great';
    else tier = 'good';

    return {
        discountPct: disc, dealTier: tier, dealScore: Math.round(score * 100) / 100,
        savings: +(marketPrice - listingPrice).toFixed(2)
    };
}

// ═══════════════════════════════════════════════════════════════
//  SCRAPERS
// ═══════════════════════════════════════════════════════════════

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function parsePrice(p) { if (typeof p === 'number') return p; return parseFloat((p || '').replace(/[^0-9.]/g, '')) || 0; }

// -- eBay --
async function scrapeEbay(searchTerm) {
    const listings = [];
    try {
        const encoded = encodeURIComponent(searchTerm);
        const url = `https://www.ebay.com/sch/i.html?_nkw=${encoded}&_sacat=183454&_sop=10&LH_BIN=1&rt=nc`;
        const resp = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                Accept: 'text/html', 'Accept-Language': 'en-US,en;q=0.9'
            }, timeout: 15000
        });
        const { load } = await import('cheerio');
        const $ = load(resp.data);
        $('li.s-item').each((i, el) => {
            if (i >= 30) return false;
            const $el = $(el);
            const title = $el.find('.s-item__title span').first().text().trim();
            const priceText = $el.find('.s-item__price').first().text().trim();
            const link = $el.find('.s-item__link').attr('href') || '';
            const imgSrc = $el.find('.s-item__image-img').attr('src') || '';
            const itemId = link.match(/\/itm\/(\d+)/)?.[1];
            if (title && title !== 'Shop on eBay' && itemId) {
                listings.push({
                    id: `ebay_${itemId}`, marketplace: 'ebay', title, price: parsePrice(priceText),
                    imageUrls: imgSrc ? [imgSrc] : [], listingUrl: link.split('?')[0],
                    postedAt: new Date().toISOString(), seller: '', location: ''
                });
            }
        });
    } catch (err) { console.error('  [eBay] Error:', err.message); }
    return listings;
}

// -- Mercari --
async function scrapeMercari(searchTerm) {
    const listings = [];
    try {
        const encoded = encodeURIComponent(searchTerm);
        const url = `https://www.mercari.com/search/?keyword=${encoded}&category_id=2536&sort=created_time&order=desc&status=on_sale`;
        const resp = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                Accept: 'text/html', 'Accept-Language': 'en-US,en;q=0.9'
            }, timeout: 15000
        });
        const { load } = await import('cheerio');
        const $ = load(resp.data);

        // Try Next.js data first
        const nextData = $('script#__NEXT_DATA__').text();
        if (nextData) {
            try {
                const parsed = JSON.parse(nextData);
                const items = parsed?.props?.pageProps?.searchResults?.items || parsed?.props?.pageProps?.items || [];
                for (const item of items.slice(0, 30)) {
                    listings.push({
                        id: `mercari_${item.id}`, marketplace: 'mercari', title: item.name || item.title || '',
                        price: parsePrice(item.price), imageUrls: (item.photos || []).map(p => p.url || p).filter(Boolean),
                        listingUrl: `https://www.mercari.com/us/item/${item.id}`, postedAt: item.created || new Date().toISOString()
                    });
                }
            } catch { }
        }

        // Fallback DOM
        if (!listings.length) {
            $('a[href*="/us/item/"]').each((i, el) => {
                if (i >= 30) return false;
                const $el = $(el);
                const href = $el.attr('href') || '';
                const id = href.match(/\/item\/([a-z0-9]+)/i)?.[1];
                const title = $el.find('[class*="ItemName"], [class*="title"]').text().trim() || $el.attr('aria-label') || '';
                const price = $el.find('[class*="Price"], [class*="price"]').text().trim();
                const img = $el.find('img').attr('src') || '';
                if (id && title) {
                    listings.push({
                        id: `mercari_${id}`, marketplace: 'mercari', title, price: parsePrice(price),
                        imageUrls: img ? [img] : [], listingUrl: `https://www.mercari.com${href}`, postedAt: new Date().toISOString()
                    });
                }
            });
        }
    } catch (err) { console.error('  [Mercari] Error:', err.message); }
    return listings;
}

// -- OfferUp --
async function scrapeOfferUp(searchTerm) {
    const listings = [];
    try {
        const resp = await axios.get('https://offerup.com/api/search/v4/feed', {
            params: { q: searchTerm, platform: 'web', limit: 30, sort: '-posted' },
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
                Accept: 'application/json', Referer: 'https://offerup.com/'
            }, timeout: 15000
        });
        const items = resp.data?.data?.feed_items || resp.data?.feed_items || [];
        for (const fi of items.slice(0, 30)) {
            const item = fi.item || fi.listing || fi;
            if (!item?.id) continue;
            const photos = (item.photos || item.images || []);
            listings.push({
                id: `offerup_${item.id}`, marketplace: 'offerup', title: item.title || '',
                price: parsePrice(item.price || item.amount),
                imageUrls: photos.map(p => p.uuid ? `https://images.offerup.com/${p.uuid}/600x600` : (p.url || p)).filter(Boolean).slice(0, 5),
                listingUrl: `https://offerup.com/item/detail/${item.id}`,
                postedAt: item.post_date || new Date().toISOString(), seller: item.owner?.name || ''
            });
        }
    } catch (err) {
        // Web fallback
        try {
            const url = `https://offerup.com/search/?q=${encodeURIComponent(searchTerm)}&sort=-posted`;
            const resp = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html' }, timeout: 15000 });
            const { load } = await import('cheerio');
            const $ = load(resp.data);
            $('a[href*="/item/detail/"]').each((i, el) => {
                if (i >= 30) return false;
                const href = $(el).attr('href') || '';
                const id = href.match(/\/detail\/(\d+)/)?.[1];
                const title = $(el).find('[class*="title"], span').first().text().trim();
                const price = $(el).find('[class*="price"]').text().trim();
                const img = $(el).find('img').attr('src') || '';
                if (id) listings.push({
                    id: `offerup_${id}`, marketplace: 'offerup', title, price: parsePrice(price),
                    imageUrls: img ? [img] : [], listingUrl: `https://offerup.com${href}`, postedAt: new Date().toISOString()
                });
            });
        } catch (err2) { console.error('  [OfferUp] Error:', err2.message); }
    }
    return listings;
}

// -- Facebook Marketplace --
let fbBrowser = null;
async function scrapeFacebook(searchTerm) {
    const listings = [];
    try {
        const puppeteer = await import('puppeteer');
        if (!fbBrowser) {
            fbBrowser = await puppeteer.default.launch({
                headless: 'new',
                args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-notifications']
            });
        }
        const page = await fbBrowser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');
        await page.setViewport({ width: 1920, height: 1080 });
        await page.setRequestInterception(true);
        page.on('request', r => ['image', 'stylesheet', 'font', 'media'].includes(r.resourceType()) ? r.abort() : r.continue());

        const url = `https://www.facebook.com/marketplace/search?query=${encodeURIComponent(searchTerm)}&daysSinceListed=1&sortBy=creation_time_descend`;
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        await sleep(3000);
        try { const btn = await page.$('[aria-label="Close"]'); if (btn) await btn.click(); } catch { }

        const items = await page.evaluate(() => {
            const results = [];
            document.querySelectorAll('a[href*="/marketplace/item/"]').forEach((card, i) => {
                if (i >= 30) return;
                const href = card.getAttribute('href') || '';
                const itemId = href.match(/\/item\/(\d+)/)?.[1];
                if (!itemId) return;
                const spans = card.querySelectorAll('span');
                let title = '', price = '';
                spans.forEach(s => { const t = s.textContent.trim(); if (t.startsWith('$') && !price) price = t; else if (t.length > 3 && !title) title = t; });
                const img = card.querySelector('img');
                results.push({ id: itemId, title, price, img: img?.src || '', href: `https://www.facebook.com/marketplace/item/${itemId}` });
            });
            return results;
        });
        for (const item of items) {
            listings.push({
                id: `facebook_${item.id}`, marketplace: 'facebook', title: item.title, price: parsePrice(item.price),
                imageUrls: item.img ? [item.img] : [], listingUrl: item.href, postedAt: new Date().toISOString()
            });
        }
        await page.close();
    } catch (err) { console.error('  [Facebook] Error:', err.message); }
    return listings;
}

const SCRAPERS = [
    { name: 'ebay', fn: scrapeEbay, rateLimit: RATE_LIMITS.ebay, enabled: true },
    { name: 'mercari', fn: scrapeMercari, rateLimit: RATE_LIMITS.mercari, enabled: true },
    { name: 'offerup', fn: scrapeOfferUp, rateLimit: RATE_LIMITS.offerup, enabled: true },
    { name: 'facebook', fn: scrapeFacebook, rateLimit: RATE_LIMITS.facebook, enabled: true },
];

// ═══════════════════════════════════════════════════════════════
//  SSE (Server-Sent Events) for real-time activity
// ═══════════════════════════════════════════════════════════════

const sseClients = new Set();

function broadcast(event) {
    const data = JSON.stringify(event);
    for (const client of sseClients) {
        try { client.write(`data: ${data}\n\n`); } catch { sseClients.delete(client); }
    }
}

// Broadcast a log entry to the live activity panel
function broadcastActivity(type, message, details = {}) {
    broadcast({ type: 'activity', activityType: type, message, details, timestamp: new Date().toISOString() });
}

// ═══════════════════════════════════════════════════════════════
//  SCAN CYCLE — The main pipeline
// ═══════════════════════════════════════════════════════════════

let scanState = {
    isRunning: false, cycleCount: 0, lastCycleAt: null, nextCycleAt: null,
    totalListings: 0, totalDeals: 0, cardsAnalyzed: 0
};

async function runScanCycle() {
    if (scanState.isRunning) return;
    scanState.isRunning = true;
    scanState.cycleCount++;
    const cycleNum = scanState.cycleCount;

    broadcastActivity('cycle_start', `Scan cycle #${cycleNum} starting...`);
    broadcast({ type: 'status', scanState: { ...scanState } });

    // Pick random subset of search terms per cycle
    const shuffled = [...SEARCH_TERMS].sort(() => Math.random() - 0.5);
    const cycleTerms = shuffled.slice(0, 3);

    broadcastActivity('search_terms', `Searching for: ${cycleTerms.join(', ')}`);

    let cycleNewListings = 0;
    let cycleDeals = 0;

    for (const scraper of SCRAPERS) {
        if (!scraper.enabled) continue;

        broadcastActivity('scraper_start', `Scanning ${scraper.name.toUpperCase()}...`, { marketplace: scraper.name });

        let allListings = [];
        for (const term of cycleTerms) {
            try {
                await sleep(scraper.rateLimit);
                const results = await scraper.fn(term);
                allListings.push(...results);
                broadcastActivity('search_result', `${scraper.name}: "${term}" → ${results.length} listings`, { marketplace: scraper.name, count: results.length });
            } catch (err) {
                broadcastActivity('error', `${scraper.name} error: ${err.message}`, { marketplace: scraper.name });
            }
        }

        // Dedupe
        const seen = new Set();
        allListings = allListings.filter(l => { if (seen.has(l.id)) return false; seen.add(l.id); return true; });

        // Filter new
        const newListings = allListings.filter(l => !isListingSeen(l.id));
        for (const l of newListings) insertListing(l);
        cycleNewListings += newListings.length;
        scanState.totalListings += newListings.length;

        broadcastActivity('new_listings', `${scraper.name}: ${newListings.length} new listings (${allListings.length} total)`,
            { marketplace: scraper.name, newCount: newListings.length, totalCount: allListings.length });

        // Analyze new listings with Vision AI
        for (const listing of newListings) {
            if (!listing.imageUrls?.length) continue;
            const imageUrl = listing.imageUrls[0];

            // Broadcast: we're looking at this listing image
            broadcastActivity('analyzing_image', `Analyzing: "${listing.title.substring(0, 60)}..."`, {
                marketplace: listing.marketplace, listingTitle: listing.title,
                imageUrl, listingUrl: listing.listingUrl, listingPrice: listing.price,
            });

            // Quick check — is this even a pokemon card?
            const quick = await quickCheckImage(imageUrl);
            if (!quick || !quick.is_pokemon_card) {
                broadcastActivity('skip_listing', `Not a card image, skipping`, { listingTitle: listing.title });
                continue;
            }

            if (quick.worth_detailed_analysis === false && (!quick.estimated_value || quick.estimated_value < 20)) {
                broadcastActivity('skip_listing', `Low-value card, skipping`, { cardName: quick.card_name });
                continue;
            }

            // Full analysis
            broadcastActivity('ai_analyzing', `AI identifying card from image...`, { imageUrl, listingTitle: listing.title });
            await sleep(500);
            const result = await analyzeCardImage(imageUrl);
            scanState.cardsAnalyzed++;

            if (!result?.cards?.length) {
                broadcastActivity('ai_no_result', `Could not identify card`, { listingTitle: listing.title });
                continue;
            }

            for (const card of result.cards) {
                if (!card.card_name) continue;

                // Broadcast AI identification result
                broadcastActivity('card_identified', `Identified: ${card.card_name}`, {
                    cardName: card.card_name, cardSet: card.card_set, cardNumber: card.card_number,
                    rarity: card.rarity, condition: card.condition_estimate, isHolo: card.is_holographic,
                    is1stEd: card.is_first_edition, confidence: card.confidence,
                    aiEstimate: card.estimated_value_usd, imageUrl, listingPrice: listing.price,
                });

                // Look up market price
                let marketPrice = await lookupPrice(card.card_name, card.card_set, card.card_number);
                if (!marketPrice && card.estimated_value_usd) {
                    marketPrice = parseFloat(card.estimated_value_usd);
                    if (isNaN(marketPrice) || marketPrice <= 0) marketPrice = null;
                }

                if (!marketPrice) {
                    broadcastActivity('no_price', `No price data for ${card.card_name}`, { cardName: card.card_name });
                    continue;
                }

                // Broadcast price comparison
                broadcastActivity('price_comparison', `${card.card_name}: Listed $${listing.price.toFixed(2)} vs Market $${marketPrice.toFixed(2)}`, {
                    cardName: card.card_name, listingPrice: listing.price, marketPrice,
                    imageUrl, marketplace: listing.marketplace, listingUrl: listing.listingUrl,
                });

                // Insert card record
                const cardId = insertCard({
                    listingId: listing.id, cardName: card.card_name, cardSet: card.card_set,
                    cardNumber: card.card_number, rarity: card.rarity, conditionEst: card.condition_estimate,
                    isHolo: card.is_holographic, is1stEd: card.is_first_edition, confidence: card.confidence, marketPrice
                });

                // Score the deal
                const deal = scoreDeal({
                    listingPrice: listing.price, marketPrice, rarity: card.rarity,
                    isHolo: card.is_holographic, is1stEd: card.is_first_edition,
                    postedAt: listing.postedAt, confidence: card.confidence
                });

                if (deal) {
                    // Check for scams (95%+ off cards over $100)
                    if (listing.price / marketPrice < 0.05 && marketPrice > 100) {
                        broadcastActivity('scam_warning', `⚠️ Suspiciously cheap: ${card.card_name}`, { cardName: card.card_name, listingPrice: listing.price, marketPrice });
                        continue;
                    }

                    const dealId = insertDeal({
                        listingId: listing.id, cardId, listingPrice: listing.price,
                        marketPrice, discountPct: deal.discountPct, dealTier: deal.dealTier, dealScore: deal.dealScore
                    });

                    cycleDeals++;
                    scanState.totalDeals++;

                    const emoji = { incredible: '🔥', great: '💎', good: '👍' }[deal.dealTier];
                    broadcastActivity('deal_found', `${emoji} ${deal.dealTier.toUpperCase()} DEAL: ${card.card_name} — $${listing.price.toFixed(2)} (${(deal.discountPct * 100).toFixed(0)}% off!)`, {
                        dealId, dealTier: deal.dealTier, dealScore: deal.dealScore,
                        cardName: card.card_name, cardSet: card.card_set, rarity: card.rarity,
                        isHolo: card.is_holographic, is1stEd: card.is_first_edition,
                        listingPrice: listing.price, marketPrice, discountPct: deal.discountPct,
                        savings: deal.savings, imageUrl, marketplace: listing.marketplace,
                        listingUrl: listing.listingUrl, confidence: card.confidence,
                    });

                    // Also broadcast as a new deal for the deal grid
                    broadcast({
                        type: 'new_deal', deal: {
                            id: dealId, listing_id: listing.id, title: listing.title,
                            listing_url: listing.listingUrl, image_urls: JSON.stringify(listing.imageUrls),
                            marketplace: listing.marketplace, card_name: card.card_name, card_set: card.card_set,
                            rarity: card.rarity, is_holo: card.is_holographic ? 1 : 0, is_1st_ed: card.is_first_edition ? 1 : 0,
                            listing_price: listing.price, market_price: marketPrice,
                            discount_pct: deal.discountPct, deal_tier: deal.dealTier, deal_score: deal.dealScore,
                            confidence: card.confidence,
                        }
                    });
                } else {
                    broadcastActivity('no_deal', `Fair price for ${card.card_name} (not a deal)`, { cardName: card.card_name });
                }
            }
        }

        broadcastActivity('scraper_done', `${scraper.name.toUpperCase()} scan complete`, { marketplace: scraper.name });
    }

    scanState.isRunning = false;
    scanState.lastCycleAt = new Date().toISOString();
    scanState.nextCycleAt = new Date(Date.now() + SCAN_INTERVAL * 60000).toISOString();

    broadcastActivity('cycle_complete', `Cycle #${cycleNum} complete — ${cycleNewListings} new listings, ${cycleDeals} deals found`, {
        newListings: cycleNewListings, deals: cycleDeals
    });
    broadcast({ type: 'status', scanState: { ...scanState } });

    console.log(`✅ Cycle #${cycleNum}: ${cycleNewListings} new, ${cycleDeals} deals`);
}

// ═══════════════════════════════════════════════════════════════
//  EXPRESS SERVER
// ═══════════════════════════════════════════════════════════════

const app = express();

// Serve static files (index.html, styles.css, script.js, card.png, etc.)
app.use(express.static(__dirname));

// API: recent deals
app.get('/api/deals', (req, res) => {
    const limit = parseInt(req.query.limit || '50', 10);
    const deals = getRecentDeals(limit);
    res.json(deals.map(d => ({ ...d, image_urls: d.image_urls ? JSON.parse(d.image_urls) : [] })));
});

// API: stats
app.get('/api/stats', (req, res) => {
    const stats = getStats();
    res.json({ ...stats, scanState });
});

// SSE: real-time event stream
app.get('/api/events', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    sseClients.add(res);
    res.write(`data: ${JSON.stringify({ type: 'connected', scanState })}\n\n`);
    req.on('close', () => sseClients.delete(res));
});

// Fallback to index.html for SPA
app.get('*', (req, res) => { res.sendFile(join(__dirname, 'index.html')); });

// ═══════════════════════════════════════════════════════════════
//  START
// ═══════════════════════════════════════════════════════════════

console.log(`
╔══════════════════════════════════════════════════╗
║  ⚡ Jack's Pokemon Packs — PokéSniper Agent      ║
║  AI-Powered Card Deal Finder                      ║
╚══════════════════════════════════════════════════╝
`);

app.listen(PORT, () => {
    console.log(`🌐 Website running at http://localhost:${PORT}`);
    console.log(`🔍 Scanning every ${SCAN_INTERVAL} minutes`);
    console.log('');

    // Run first scan after a short delay
    setTimeout(runScanCycle, 3000);

    // Schedule recurring scans
    cron.schedule(`*/${SCAN_INTERVAL} * * * *`, runScanCycle);

    scanState.nextCycleAt = new Date(Date.now() + 3000).toISOString();
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down...');
    if (fbBrowser) await fbBrowser.close();
    db.close();
    process.exit(0);
});
