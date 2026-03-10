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
import pkg from 'pg';
const { Pool } = pkg;
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import cookieParser from 'cookie-parser';
import { GoogleGenerativeAI } from '@google/generative-ai';
import axios from 'axios';
import multer from 'multer';
import sharp from 'sharp';
import { execSync } from 'child_process';
import * as cheerio from 'cheerio';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '3000', 10);
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
const POKEMON_TCG_KEY = process.env.POKEMON_TCG_API_KEY || '';
const SCRYDEX_API_KEY = process.env.SCRYDEX_API_KEY || '';
const SCRYDEX_TEAM_ID = process.env.SCRYDEX_TEAM_ID || '';

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

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-key-please-change-in-prod';
const DB_URL = process.env.DATABASE_URL || 'postgres://localhost:5432/pokesniper';

const pool = new Pool({
    connectionString: DB_URL,
    ssl: DB_URL.includes('localhost') ? false : { rejectUnauthorized: false }
});

async function initDB() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS portfolio_cards (
            id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
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
            year INTEGER DEFAULT 0,
            language TEXT DEFAULT 'English',
            holo_type TEXT DEFAULT 'Unknown',
            added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS price_history (
            id SERIAL PRIMARY KEY,
            card_id INTEGER REFERENCES portfolio_cards(id) ON DELETE CASCADE,
            price REAL NOT NULL,
            source TEXT DEFAULT 'market',
            recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_price_history_card ON price_history(card_id, recorded_at DESC);
    `);
}
initDB().catch(err => console.error("DB Init Error:", err));

// ── Portfolio DB helpers ──
async function insertPortfolioCard(card, userId) {
    const res = await pool.query(`
        INSERT INTO portfolio_cards (user_id, card_name, card_set, card_number, rarity, condition, is_holo, is_first_edition, confidence, image_data, image_url, notes, year, language, holo_type)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        RETURNING id
    `, [
        userId, card.card_name, card.card_set || '', card.card_number || '', card.rarity || 'Unknown',
        card.condition_estimate || card.condition || 'Unknown', card.is_holographic || card.is_holo ? 1 : 0, card.is_first_edition ? 1 : 0,
        card.confidence || 0, card.image_data || '', card.image_url || '', card.notes || '',
        card.year || 0, card.language || 'English', card.holo_type || 'Unknown'
    ]);
    return { lastInsertRowid: res.rows[0].id };
}

async function updateCardImageUrl(cardId, imageUrl) {
    await pool.query(`UPDATE portfolio_cards SET image_url = $1 WHERE id = $2`, [imageUrl, cardId]);
}

async function insertPricePoint(cardId, price, source) {
    await pool.query(`INSERT INTO price_history (card_id, price, source) VALUES ($1, $2, $3)`, [cardId, price, source || 'market']);
}

async function getAllPortfolioCards(userId) {
    // Determine the user's cards with current and previous prices safely
    const res = await pool.query(`
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
        WHERE pc.user_id = $1
        ORDER BY COALESCE(l.current_price, 0) DESC
    `, [userId]);
    return res.rows;
}

async function getCardPriceHistory(cardId, userId) {
    // Only return history if the card belongs to the user
    const check = await pool.query('SELECT user_id FROM portfolio_cards WHERE id = $1', [cardId]);
    if (check.rows.length === 0 || check.rows[0].user_id !== userId) return [];
    
    const res = await pool.query(`SELECT price, source, recorded_at FROM price_history WHERE card_id = $1 ORDER BY recorded_at ASC`, [cardId]);
    return res.rows;
}

async function deletePortfolioCard(cardId, userId) {
    // Secure delete
    await pool.query(`DELETE FROM portfolio_cards WHERE id = $1 AND user_id = $2`, [cardId, userId]);
}

async function getPortfolioStats(userId) {
    const cRes = await pool.query('SELECT COUNT(*) as c FROM portfolio_cards WHERE user_id = $1', [userId]);
    const totalCards = parseInt(cRes.rows[0].c, 10);
    
    // Total value based on latest prices for the user
    const totalRes = await pool.query(`
        SELECT COALESCE(SUM(latest.price), 0) as total FROM (
            SELECT ph.price FROM portfolio_cards pc
            JOIN price_history ph ON ph.card_id = pc.id
            WHERE pc.user_id = $1 AND ph.id = (SELECT id FROM price_history WHERE card_id = pc.id ORDER BY recorded_at DESC LIMIT 1)
        ) latest
    `, [userId]);
    const totalValue = parseFloat(totalRes.rows[0].total) || 0;

    const prevRes = await pool.query(`
        SELECT COALESCE(SUM(prev.price), 0) as total FROM (
            SELECT ph.price FROM portfolio_cards pc
            JOIN price_history ph ON ph.card_id = pc.id
            WHERE pc.user_id = $1 AND ph.id = (SELECT id FROM price_history WHERE card_id = pc.id ORDER BY recorded_at DESC LIMIT 1 OFFSET 1)
        ) prev
    `, [userId]);
    const prevValue = parseFloat(prevRes.rows[0].total) || 0;

    return { totalCards, totalValue, prevValue };
}

// Legacy helpers
async function getCachedPrice(name, set) {
    return null; // DB-less fallback or removed entirely to keep things clean.
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
    geminiModel = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    console.log('🤖 Vision AI: ✅ Enabled (Gemini 2.5 Flash)');
} else {
    console.log('🤖 Vision AI: ❌ Disabled — add GEMINI_API_KEY to .env');
}

const CARD_ID_PROMPT = `You are an expert Pokemon TCG card identifier. Analyze this image and identify any Pokemon cards.
Look closely at the card name, set symbol, card number, rarity, holographic patterns, 1st edition stamps, language, copyright year, and condition.

Return ONLY valid JSON (no markdown fences):
{
  "cards": [{
    "card_name": "Pokemon name",
    "card_set": "Set name",
    "card_number": "e.g. 4/102",
    "rarity": "Common|Uncommon|Rare|Rare Holo|Rare Ultra|Secret Rare|Illustration Rare|Unknown",
    "condition_estimate": "Mint|Near Mint|Lightly Played|Moderately Played|Heavily Played|Damaged|Unknown",
    "is_holographic": true/false,
    "holo_type": "Holofoil|Reverse Holo|Non-Holo|Cosmos Holo|Unknown",
    "year": 1999,
    "language": "English|Japanese|Spanish|etc",
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

async function convertToJpeg(buffer, filePath) {
    try {
        const converted = await sharp(buffer)
            .resize(2048, 2048, { fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 90 })
            .toBuffer();
        return converted;
    } catch (err) {
        if (!filePath) {
            console.error('  [Sharp] Conversion failed and no file path available for fallback:', err.message);
            return null;
        }
        console.log('  [Sharp] Decoding failed. Attempting OS-level RAW fallback (sips/convert)...');
        try {
            const outPath = filePath + '_converted.jpg';
            try {
                // Try macOS native sips
                execSync(`sips -s format jpeg -Z 2048 "${filePath}" --out "${outPath}"`, { stdio: 'ignore' });
            } catch (sipsErr) {
                // Try Linux ImageMagick
                execSync(`convert "${filePath}" -resize 2048x2048\\> "${outPath}"`, { stdio: 'ignore' });
            }
            const converted = readFileSync(outPath);
            try { rmSync(outPath, { force: true }); } catch {}
            return converted;
        } catch (fallbackErr) {
            console.error('  [Fallback Conversion] Failed:', fallbackErr.message);
            return null;
        }
    }
}

async function analyzeImageBuffer(buffer, mimeType) {
    if (!geminiModel) return null;
    try {
        const base64Data = buffer.toString('base64');
        const result = await geminiModel.generateContent({
            contents: [{
                role: 'user',
                parts: [
                    { text: CARD_ID_PROMPT },
                    { inlineData: { data: base64Data, mimeType: mimeType } }
                ]
            }],
            generationConfig: {
                responseMimeType: "application/json",
            }
        });
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

// ═══════════════════════════════════════════════════════════════
//  SCRYDEX API (primary price + image source)
// ═══════════════════════════════════════════════════════════════

function scrydexHeaders() {
    const h = { 'Accept': 'application/json' };
    if (SCRYDEX_API_KEY) h['X-Api-Key'] = SCRYDEX_API_KEY;
    if (SCRYDEX_TEAM_ID) h['X-Team-ID'] = SCRYDEX_TEAM_ID;
    return h;
}

async function fetchScrydexCard(cardName, cardSet, cardNumber) {
    try {
        // Build Lucene-style query
        let q = `name:"${cardName}"`;
        if (cardNumber) {
            const num = cardNumber.split('/')[0].replace(/^0+/, '');
            q += ` number:${num}`;
        }
        if (cardSet) {
            // Try matching set name (partial)
            q += ` expansion.name:"${cardSet}"`;
        }

        const url = `https://api.scrydex.com/pokemon/v1/cards?q=${encodeURIComponent(q)}&pageSize=5`;
        const resp = await axios.get(url, { headers: scrydexHeaders(), timeout: 12000 });
        const cards = resp.data?.data || [];
        return cards[0] || null;
    } catch (err) {
        // Try a simpler query if the complex one fails
        try {
            const url = `https://api.scrydex.com/pokemon/v1/cards?q=${encodeURIComponent(`name:"${cardName}"`)}&pageSize=5`;
            const resp = await axios.get(url, { headers: scrydexHeaders(), timeout: 12000 });
            const cards = resp.data?.data || [];
            return cards[0] || null;
        } catch (err2) {
            console.error(`  [Scrydex] Error for "${cardName}":`, err2.message);
            return null;
        }
    }
}

function extractScrydexPrice(card) {
    if (!card) return null;
    // Scrydex card objects have tcgplayer and/or cardmarket price data embedded
    const p = card.tcgplayer?.prices;
    if (p) {
        const price = p.holofoil?.market
            || p.reverseHolofoil?.market
            || p.normal?.market
            || p['1stEditionHolofoil']?.market
            || p.unlimited?.market
            || p.holofoil?.mid
            || p.normal?.mid
            || null;
        if (price && price > 0) return { price, source: 'scrydex_tcgplayer', url: p.url || card.tcgplayer?.url };
    }
    const cm = card.cardmarket?.prices;
    if (cm) {
        const price = cm.averageSellPrice || cm.trendPrice || cm.avg7 || null;
        if (price && price > 0) return { price, source: 'scrydex_cardmarket', url: card.cardmarket?.url };
    }
    return null;
}

function extractScrydexImage(card) {
    if (!card) return null;
    // Scrydex cards have images.large or images.small
    return card.images?.large || card.images?.small || null;
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

async function lookupMarketPrice(cardName, cardSet, cardNumber, year, language, holoType) {
    if (!cardName) return null;
    const key = `${cardName}|${cardSet || ''}|${cardNumber || ''}`.toLowerCase();

    const cached = priceCache.get(key);
    if (cached && Date.now() - cached.ts < 86400000) return { price: cached.price, source: cached.source };

    const known = checkKnownCards(cardName, cardSet);
    if (known) {
        priceCache.set(key, { price: known, source: 'reference', ts: Date.now() });
        return { price: known, source: 'reference' };
    }

    // ── Strategy 0: Scrydex API (best source — has TCGPlayer + CardMarket embedded prices) ──
    if (SCRYDEX_API_KEY && SCRYDEX_TEAM_ID) {
        try {
            const scrydexCard = await fetchScrydexCard(cardName, cardSet, cardNumber);
            const result = extractScrydexPrice(scrydexCard);
            if (result) {
                console.log(`  [Pricing] Scrydex for "${cardName}": $${result.price.toFixed(2)} (${result.source})`);
                priceCache.set(key, { ...result, ts: Date.now() });
                return result;
            }
        } catch (err) {
            console.error(`  [Pricing] Scrydex failed for "${cardName}":`, err.message);
        }
    }

    // ── Strategy 1: Pokemon TCG API (free tier — 1000 req/day, has TCGPlayer market prices) ──
    try {
        const headers = { 'Accept': 'application/json' };
        if (POKEMON_TCG_KEY) headers['X-Api-Key'] = POKEMON_TCG_KEY;

        // Build query — try card number + name, or just name
        const params = { pageSize: 10 };
        if (cardNumber) {
            const num = cardNumber.split('/')[0].replace(/^0+/, '');
            params.q = `name:"${cardName}" number:"${num}"`;
        } else {
            params.q = `name:"${cardName}"`;
            params.orderBy = '-tcgplayer.prices.holofoil.market';
        }

        const resp = await axios.get('https://api.pokemontcg.io/v2/cards', { params, headers, timeout: 15000 });
        const results = resp.data?.data || [];

        // Try to match set if we have one
        let match = null;
        if (cardSet && results.length > 1) {
            const setLower = cardSet.toLowerCase();
            match = results.find(c => (c.set?.name || '').toLowerCase().includes(setLower) || setLower.includes((c.set?.name || '').toLowerCase()));
        }
        if (!match) match = results[0];

        if (match) {
            // Extract market price from TCGPlayer data using the exact holoType if possible
            const prices = match.tcgplayer?.prices;
            let price = null;
            if (prices) {
                const htLower = (holoType || '').toLowerCase();
                // Exact matching attempts
                if (htLower.includes('reverse') && prices.reverseHolofoil?.market) {
                    price = prices.reverseHolofoil.market;
                } else if (htLower.includes('1st edition') && prices['1stEditionHolofoil']?.market) {
                    price = prices['1stEditionHolofoil'].market;
                } else if (htLower === 'holofoil' && prices.holofoil?.market) {
                    price = prices.holofoil.market;
                } else if (htLower === 'non-holo' && prices.normal?.market) {
                    price = prices.normal.market;
                }
                
                // Fallbacks
                if (!price) {
                    price = prices.holofoil?.market
                        || prices.reverseHolofoil?.market
                        || prices.normal?.market
                        || prices['1stEditionHolofoil']?.market
                        || prices.unlimited?.market
                        || null;
                }
            }
            // Fallback to cardmarket
            if (!price && match.cardmarket?.prices) {
                price = match.cardmarket.prices.averageSellPrice || match.cardmarket.prices.trendPrice || null;
            }

            if (price && price > 0) {
                console.log(`  [Pricing] Pokemon TCG API for "${cardName}": $${price.toFixed(2)} (${match.set?.name})`);
                const url = match.tcgplayer?.url || match.cardmarket?.url || null;
                priceCache.set(key, { price, source: 'pokemon_tcg_api', url, ts: Date.now() });
                return { price, source: 'pokemon_tcg_api', url };
            }
        }
    } catch (err) {
        console.error(`  [Pricing] Pokemon TCG API failed for "${cardName}":`, err.message);
    }

    // ── Strategy 2: eBay HTML Scraper (sold listings fallback) ──
    const searchQueries = [
        cardNumber ? `"${cardName}" ${cardNumber} pokemon card` : null,
        `"${cardName}" ${cardSet || ''} pokemon card`,
        `"${cardName}" pokemon card`,
    ].filter(Boolean);

    for (const query of searchQueries) {
        try {
            const listings = await scrapeEbayHTML(query);
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
                    const url = `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(query)}&LH_Sold=1&LH_Complete=1&_sop=13`;
                    priceCache.set(key, { price: medianPrice, source: 'ebay', url, ts: Date.now() });
                    return { price: medianPrice, source: 'ebay', url };
                } else if (filtered.length === 1) {
                    const price = filtered[0].price;
                    const url = `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(query)}&LH_Sold=1&LH_Complete=1&_sop=13`;
                    priceCache.set(key, { price, source: 'ebay', url, ts: Date.now() });
                    return { price, source: 'ebay', url };
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
//  SCRAPERS (eBay HTML only for price lookups — reliable fallback)
// ═══════════════════════════════════════════════════════════════

async function scrapeEbayHTML(searchTerm) {
    const listings = [];
    try {
        const encoded = encodeURIComponent(searchTerm);
        const url = `https://www.ebay.com/sch/i.html?_nkw=${encoded}&LH_Sold=1&LH_Complete=1&_sop=13`;
        const resp = await axios.get(url, {
            headers: { 
                'User-Agent': randomUA(), 
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9'
            },
            timeout: 20000,
        });
        const $ = cheerio.load(resp.data);
        $('.s-item__item').each((i, el) => {
            if (listings.length >= 10) return false;
            const $el = $(el);
            const title = $el.find('.s-item__title').text().trim();
            const text = $el.find('.s-item__price').text();
            const match = text.match(/\$([\d,.]+)/);
            if (title && match && !title.includes('Shop on eBay')) {
                const price = parsePrice(match[1]);
                if (price > 0.5) listings.push({ title, price });
            }
        });
        return listings;
    } catch (err) {
        console.error(`  [eBay-HTML] Error: ${err.message}`);
        return [];
    }
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

function broadcastActivity(type, message, data = null) {
    broadcast({ type: 'activity', activityType: type, message, data, timestamp: new Date().toISOString() });
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

    const res = await pool.query('SELECT * FROM portfolio_cards');
    const cards = res.rows;
    let updated = 0;

    for (const card of cards) {
        try {
            // Also back-fill missing TCGdex images
            if (!card.image_url) {
                const imageUrl = await fetchCardImageFromTCGdex(card.card_name, card.card_set, card.card_number);
                if (imageUrl) {
                    await updateCardImageUrl(card.id, imageUrl);
                    console.log(`  [PriceRefresh] Found image for ${card.card_name}`);
                }
            }

            const result = await lookupMarketPrice(card.card_name, card.card_set, card.card_number, card.year, card.language, card.holo_type);
            if (result && result.price > 0) {
                await insertPricePoint(card.id, result.price, result.source || 'market', result.url || '');
                // Also update the main card record with the latest info
                await pool.query('UPDATE portfolio_cards SET current_price = $1, price_source = $2, price_source_url = $3 WHERE id = $4', [result.price, result.source || 'market', result.url || '', card.id]);
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
app.use(cookieParser());

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

// ── Auth API ──
app.post('/api/auth/register', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
        
        const existing = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
        if (existing.rows.length > 0) return res.status(400).json({ error: 'Username taken' });

        const hash = await bcrypt.hash(password, 10);
        const result = await pool.query('INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id', [username, hash]);
        
        const token = jwt.sign({ id: result.rows[0].id, username }, JWT_SECRET, { expiresIn: '7d' });
        res.cookie('auth_token', token, { httpOnly: true, secure: !DB_URL.includes('localhost'), maxAge: 7*24*60*60*1000 });
        res.json({ success: true, username });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
        if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid credentials' });
        
        const user = result.rows[0];
        const match = await bcrypt.compare(password, user.password_hash);
        if (!match) return res.status(401).json({ error: 'Invalid credentials' });

        const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
        res.cookie('auth_token', token, { httpOnly: true, secure: !DB_URL.includes('localhost'), maxAge: 7*24*60*60*1000 });
        res.json({ success: true, username: user.username });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/auth/logout', (req, res) => {
    res.clearCookie('auth_token');
    res.json({ success: true });
});

const requireAuth = (req, res, next) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
        req.user = jwt.verify(token, JWT_SECRET);
        next();
    } catch {
        res.status(401).json({ error: 'Invalid token' });
    }
};

app.get('/api/auth/me', requireAuth, (req, res) => {
    res.json({ username: req.user.username });
});

// ── Portfolio API ──

// Get all portfolio cards with latest + previous prices
app.get('/api/portfolio', requireAuth, async (req, res) => {
    try {
        const cards = await getAllPortfolioCards(req.user.id);
        const stats = await getPortfolioStats(req.user.id);
        res.json({ cards, stats });
    } catch (err) {
        console.error('Portfolio fetch error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Get price history for a single card
app.get('/api/portfolio/:id/history', requireAuth, async (req, res) => {
    try {
        const history = await getCardPriceHistory(parseInt(req.params.id), req.user.id);
        res.json({ history });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Delete a card from portfolio
app.delete('/api/portfolio/:id', requireAuth, async (req, res) => {
    try {
        await deletePortfolioCard(parseInt(req.params.id), req.user.id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Manually trigger price refresh
app.post('/api/portfolio/refresh-prices', requireAuth, async (req, res) => {
    try {
        res.json({ success: true, message: 'Price refresh started.' });
        refreshAllPrices().catch(err => console.error('Manual refresh error:', err));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Upload photos → AI identifies → saves to portfolio
// Accepts field name 'cards' (from the frontend drop-zone) OR 'photos' (legacy)
app.post('/api/portfolio/upload', requireAuth, (req, res) => {
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
            const result = await processPortfolioUpload(files, req.user.id);
            res.json({ success: true, cards: result.cards, message: `Added ${result.totalAdded} card(s)` });
        } catch (err) {
            console.error('Portfolio upload error:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    });
});


// Ensure the `lastInsertRowid` is mapped correctly (sqlite vs pg)
async function processPortfolioUpload(files, userId) {
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
            let sendMime = file.mimetype;

            // Immediately convert raw/unsupported formats to JPEG so resizing/AI both work
            if (!GEMINI_SUPPORTED_TYPES.has(sendMime)) {
                console.log(`  [Vision] Converting ${sendMime} → JPEG for Gemini & Sharp...`);
                const converted = await convertToJpeg(buffer, file.path);
                if (converted) {
                    buffer = converted;
                    sendMime = 'image/jpeg';
                }
            }

            analysis = await analyzeImageBuffer(buffer, sendMime);

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

            // Inline synchronous market price fetch
            let finalPrice = card.estimated_value_usd || 0;
            let finalSource = 'ai_estimate';
            let finalUrl = '';
            try {
                const priceResult = await lookupMarketPrice(card.card_name, card.card_set, card.card_number, card.year, card.language, card.holo_type);
                if (priceResult && priceResult.price > 0) {
                    finalPrice = priceResult.price;
                    finalSource = priceResult.source;
                    finalUrl = priceResult.url || '';
                }
            } catch (err) {
                console.error(`  [Pricing] Error fetching inline price for ${card.card_name}:`, err.message);
            }

            const dbResult = await insertPortfolioCard({
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
            }, userId);

            // PostgreSQL returns the id in rows[0].id
            const cardId = dbResult.rows[0].id;

            if (finalPrice > 0) {
                await insertPricePoint(cardId, finalPrice, finalSource, finalUrl);
            }

            totalAdded++;

            const finalCardData = {
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
                current_price: finalPrice,
                estimated_value: finalPrice,
                price_source: finalSource,
                price_source_url: finalUrl,
            };

            addedCards.push(finalCardData);

            // Stream the newly found card to the frontend immediately!
            broadcastActivity('card_added_detail', `✅ ${card.card_name}`, finalCardData);
            broadcast({ type: 'card_added' });
        }
    }

    broadcastActivity('upload_complete', `Added ${totalAdded} card${totalAdded !== 1 ? 's' : ''} to your portfolio!`);


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
console.log('🕑 Scrydex API:    ', (SCRYDEX_API_KEY && SCRYDEX_TEAM_ID) ? '✅ Enabled (primary price source)' : '⚠️  No credentials — add SCRYDEX_API_KEY + SCRYDEX_TEAM_ID');
console.log('💰 Pokemon TCG API:', POKEMON_TCG_KEY ? '✅ Key loaded (fallback)' : '⚠️  No key (rate-limited fallback)');

app.listen(PORT, () => {
    console.log(`🌐 Dashboard running at http://localhost:${PORT}`);
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down...');
    await pool.end();
    process.exit(0);
});
