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
import { createGzip } from 'zlib';
import { GoogleGenerativeAI } from '@google/generative-ai';
import axios from 'axios';
import multer from 'multer';
import sharp from 'sharp';
import { execSync } from 'child_process';
import * as cheerio from 'cheerio';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '3000', 10);
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
const POKEMON_TCG_KEY = process.env.POKEMON_TCG_KEY || process.env.POKEMON_TCG_API_KEY || '';
const SCRYDEX_API_KEY = process.env.SCRYDEX_API_KEY || '';
const SCRYDEX_TEAM_ID = process.env.SCRYDEX_TEAM_ID || '';
const JUSTTCG_API_KEY = process.env.JUSTTCG_API_KEY || '';

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

const RATE_LIMITS = { ebay: 1500, scraper: 2000, priceCheck: 500, justtcg: 300 };

// ═══════════════════════════════════════════════════════════════
//  DATABASE
// ═══════════════════════════════════════════════════════════════

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-key-please-change-in-prod';
const DB_URL = process.env.POSTGRES_URL || process.env.DATABASE_URL || process.env.DATABASE_POSTGRES_URL || 'postgres://localhost:5432/pokesniper';

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
            highest_recent_sale REAL DEFAULT 0,
            highest_recent_sale_source TEXT DEFAULT '',
            highest_recent_sale_url TEXT DEFAULT '',
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

    // Add missing columns if they don't exist
    try { await pool.query('ALTER TABLE portfolio_cards ADD COLUMN current_price REAL DEFAULT 0'); } catch {}
    try { await pool.query('ALTER TABLE portfolio_cards ADD COLUMN price_source TEXT DEFAULT \'\''); } catch {}
    try { await pool.query('ALTER TABLE portfolio_cards ADD COLUMN price_source_url TEXT DEFAULT \'\''); } catch {}
    try { await pool.query('ALTER TABLE price_history ADD COLUMN source_url TEXT DEFAULT \'\''); } catch {}
    try { await pool.query('ALTER TABLE portfolio_cards ADD COLUMN highest_recent_sale REAL DEFAULT 0'); } catch {}
    try { await pool.query('ALTER TABLE portfolio_cards ADD COLUMN highest_recent_sale_source TEXT DEFAULT \'\''); } catch {}
    try { await pool.query('ALTER TABLE portfolio_cards ADD COLUMN highest_recent_sale_url TEXT DEFAULT \'\''); } catch {}
    // New columns for multi-source pricing + batched cron
    try { await pool.query('ALTER TABLE portfolio_cards ADD COLUMN last_price_check TIMESTAMP'); } catch {}
    try { await pool.query('ALTER TABLE portfolio_cards ADD COLUMN price_sources JSONB DEFAULT \'{}\''); } catch {}
    try { await pool.query('ALTER TABLE portfolio_cards ADD COLUMN best_sold_price REAL DEFAULT 0'); } catch {}
    try { await pool.query('ALTER TABLE portfolio_cards ADD COLUMN best_sold_source TEXT DEFAULT \'\''); } catch {}
}
async function ensureDefaultUser() {
    const existing = await pool.query('SELECT id FROM users WHERE id = 1');
    if (existing.rows.length === 0) {
        const hash = await bcrypt.hash('unused', 10);
        await pool.query("INSERT INTO users (id, username, password_hash) VALUES (1, 'jack', $1) ON CONFLICT DO NOTHING", [hash]);
    }
}
initDB().then(() => ensureDefaultUser()).catch(err => console.error("DB Init Error:", err));

// ── Portfolio DB helpers ──
async function insertPortfolioCard(card, userId) {
    const res = await pool.query(`
        INSERT INTO portfolio_cards (user_id, card_name, card_set, card_number, rarity, condition, is_holo, is_first_edition, confidence, image_data, image_url, notes, year, language, holo_type, highest_recent_sale, highest_recent_sale_source, highest_recent_sale_url)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
        RETURNING id
    `, [
        userId, card.card_name, card.card_set || '', card.card_number || '', card.rarity || 'Unknown',
        card.condition_estimate || card.condition || 'Unknown', card.is_holographic || card.is_holo ? 1 : 0, card.is_first_edition ? 1 : 0,
        card.confidence || 0, card.image_data || '', card.image_url || '', card.notes || '',
        card.year || 0, card.language || 'English', card.holo_type || 'Unknown',
        card.highest_recent_sale || 0, card.highest_recent_sale_source || '', card.highest_recent_sale_url || ''
    ]);
    return res.rows[0].id;
}

async function updateCardImageUrl(cardId, imageUrl) {
    await pool.query(`UPDATE portfolio_cards SET image_url = $1 WHERE id = $2`, [imageUrl, cardId]);
}

async function updatePortfolioCardMarketData(cardId, marketData = {}) {
    await pool.query(`
        UPDATE portfolio_cards
        SET
            current_price = $1,
            price_source = $2,
            price_source_url = $3,
            highest_recent_sale = $4,
            highest_recent_sale_source = $5,
            highest_recent_sale_url = $6,
            last_price_check = NOW(),
            price_sources = COALESCE($8::jsonb, '{}'::jsonb),
            best_sold_price = $9,
            best_sold_source = $10
        WHERE id = $7
    `, [
        marketData.price || 0,
        marketData.source || '',
        marketData.url || '',
        marketData.highestRecentSale || 0,
        marketData.highestRecentSaleSource || '',
        marketData.highestRecentSaleUrl || '',
        cardId,
        JSON.stringify(marketData.allSourcePrices || {}),
        marketData.bestSoldPrice || marketData.highestRecentSale || 0,
        marketData.bestSoldSource || marketData.highestRecentSaleSource || ''
    ]);
}

async function insertPricePoint(cardId, price, source, sourceUrl = '') {
    try {
        const latest = await pool.query(`SELECT price, recorded_at FROM price_history WHERE card_id = $1 ORDER BY recorded_at DESC LIMIT 1`, [cardId]);
        if (latest.rows.length > 0) {
            const lastPrice = Number(latest.rows[0].price);
            const lastRecordedAt = new Date(latest.rows[0].recorded_at).getTime();
            const ageHours = (Date.now() - lastRecordedAt) / (1000 * 60 * 60);
            
            // Skip inserting if the price is exactly the same AND the last point was recorded less than 24 hours ago
            if (lastPrice === price && ageHours < 24) {
                return;
            }
        }
    } catch (err) {
        console.error('Error checking latest price point:', err);
    }
    await pool.query(`INSERT INTO price_history (card_id, price, source, source_url) VALUES ($1, $2, $3, $4)`, [cardId, price, source || 'market', sourceUrl]);
}

async function getAllPortfolioCards(userId) {
    const res = await pool.query(`
        SELECT pc.id, pc.user_id, pc.card_name, pc.card_set, pc.card_number,
            pc.rarity, pc.condition, pc.is_holo, pc.is_first_edition, pc.confidence,
            pc.image_url, pc.notes, pc.year, pc.language, pc.holo_type,
            pc.highest_recent_sale, pc.highest_recent_sale_source, pc.highest_recent_sale_url,
            pc.added_at, pc.current_price AS card_current_price, pc.price_source AS card_price_source,
            pc.price_source_url AS card_price_source_url,
            pc.price_sources, pc.best_sold_price, pc.best_sold_source, pc.last_price_check,
            CASE WHEN pc.image_data IS NOT NULL AND pc.image_data != '' AND (pc.image_url IS NULL OR pc.image_url = '') THEN true ELSE false END AS has_local_image,
            latest.price AS current_price,
            day_ref.price AS previous_price,
            day_ref.price AS prev_day_price,
            week_ref.price AS prev_7d_price,
            month_ref.price AS prev_30d_price,
            latest.source AS price_source,
            latest.source_url AS price_source_url
        FROM portfolio_cards pc
        LEFT JOIN LATERAL (
            SELECT ph.price, ph.source, ph.source_url, ph.recorded_at
            FROM price_history ph
            WHERE ph.card_id = pc.id
            ORDER BY ph.recorded_at DESC
            LIMIT 1
        ) latest ON true
        LEFT JOIN LATERAL (
            SELECT ph.price
            FROM price_history ph
            WHERE ph.card_id = pc.id AND ph.recorded_at <= NOW() - INTERVAL '1 day'
            ORDER BY ph.recorded_at DESC
            LIMIT 1
        ) day_ref ON true
        LEFT JOIN LATERAL (
            SELECT ph.price
            FROM price_history ph
            WHERE ph.card_id = pc.id AND ph.recorded_at <= NOW() - INTERVAL '7 days'
            ORDER BY ph.recorded_at DESC
            LIMIT 1
        ) week_ref ON true
        LEFT JOIN LATERAL (
            SELECT ph.price
            FROM price_history ph
            WHERE ph.card_id = pc.id AND ph.recorded_at <= NOW() - INTERVAL '30 days'
            ORDER BY ph.recorded_at DESC
            LIMIT 1
        ) month_ref ON true
        WHERE pc.user_id = $1
        ORDER BY COALESCE(latest.price, 0) DESC
    `, [userId]);
    return res.rows;
}

async function getCardPriceHistory(cardId, userId) {
    const res = await pool.query(`SELECT price, source, recorded_at FROM price_history WHERE card_id = $1 ORDER BY recorded_at ASC`, [cardId]);
    return res.rows;
}

function getHistoricalReferencePrice(history, days) {
    if (!history?.length) return null;
    const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
    let chosen = null;
    for (const point of history) {
        const ts = new Date(point.recorded_at).getTime();
        if (ts <= cutoff) chosen = point;
    }
    return chosen ? Number(chosen.price) : null;
}

function summarizePriceHistory(history) {
    const points = (history || []).map(h => ({
        ...h,
        price: Number(h.price || 0),
        ts: new Date(h.recorded_at).getTime()
    })).filter(h => h.price > 0 && Number.isFinite(h.ts));
    if (!points.length) {
        return {
            latest_price: null,
            points: 0,
            all_time_high: null,
            all_time_low: null,
            first_recorded_at: null,
            last_recorded_at: null,
            prev_24h_price: null,
            prev_7d_price: null,
            prev_30d_price: null
        };
    }
    const latest = points[points.length - 1];
    return {
        latest_price: latest.price,
        points: points.length,
        all_time_high: Math.max(...points.map(p => p.price)),
        all_time_low: Math.min(...points.map(p => p.price)),
        first_recorded_at: points[0].recorded_at,
        last_recorded_at: latest.recorded_at,
        prev_24h_price: getHistoricalReferencePrice(points, 1),
        prev_7d_price: getHistoricalReferencePrice(points, 7),
        prev_30d_price: getHistoricalReferencePrice(points, 30)
    };
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
                return localClean === numClean && r.image;
            });
            if (byNumber) return byNumber.image + '/high.webp';
        }

        // Try to match by set name
        if (cardSet) {
            // Need to fetch full card details to check set name
            const withImage = results.filter(r => r.image).slice(0, 5);
            for (const candidate of withImage) {
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

        // Fallback: use first result with image
        const firstWithImage = results.find(r => r.image);
        if (firstWithImage) return firstWithImage.image + '/high.webp';
        
        return null;
    } catch (err) {
        console.error(`  [TCGdex] Error looking up "${cardName}":`, err.message);
        return null;
    }
}

async function fetchTCGdexCard(cardName, cardSet, cardNumber) {
    if (!cardName) return null;
    try {
        const searchName = encodeURIComponent(cardName.trim());
        const resp = await axios.get(`https://api.tcgdex.net/v2/en/cards?name=${searchName}`, {
            timeout: 10000,
            headers: { 'Accept': 'application/json' }
        });
        const results = Array.isArray(resp.data) ? resp.data : [];
        if (!results.length) return null;

        const normalizedSet = normalizeText(cardSet);
        const normalizedNumber = normalizeCardNumber(cardNumber);

        const detailCache = new Map();
        const loadDetail = async (candidate) => {
            if (!candidate?.id) return null;
            if (detailCache.has(candidate.id)) return detailCache.get(candidate.id);
            try {
                const detail = await axios.get(`https://api.tcgdex.net/v2/en/cards/${candidate.id}`, {
                    timeout: 10000,
                    headers: { 'Accept': 'application/json' }
                });
                detailCache.set(candidate.id, detail.data || null);
                return detail.data || null;
            } catch {
                detailCache.set(candidate.id, null);
                return null;
            }
        };

        if (normalizedNumber) {
            for (const candidate of results) {
                const localId = normalizeCardNumber(candidate.localId);
                if (localId === normalizedNumber) {
                    const detail = await loadDetail(candidate);
                    if (!normalizedSet || normalizeText(detail?.set?.name) === normalizedSet) return detail;
                }
            }
        }

        if (normalizedSet) {
            for (const candidate of results) {
                const detail = await loadDetail(candidate);
                const candidateSet = normalizeText(detail?.set?.name);
                if (candidateSet && (candidateSet === normalizedSet || candidateSet.includes(normalizedSet) || normalizedSet.includes(candidateSet))) {
                    return detail;
                }
            }
        }

        const firstDetail = await loadDetail(results[0]);
        return firstDetail;
    } catch (err) {
        console.error(`  [TCGdex] Error looking up market card "${cardName}":`, err.message);
        return null;
    }
}

function extractTcgdexPrice(card, holoType) {
    const pricing = card?.pricing;
    if (!pricing) return null;

    const variantKeys = [];
    const htLower = normalizeText(holoType);
    if (htLower.includes('reverse')) variantKeys.push('reverse', 'reverseHolo', 'reverseHolofoil');
    if (htLower.includes('1st edition')) variantKeys.push('firstEdition', '1stEdition');
    if (htLower === 'holofoil' || htLower === 'cosmos holo') variantKeys.push('holo', 'holofoil');
    if (htLower === 'non holo' || htLower === 'non-holo') variantKeys.push('normal');
    variantKeys.push('normal', 'holo', 'reverse', 'unlimited');

    const pickFromTcgplayer = () => {
        const tcg = pricing.tcgplayer;
        if (!tcg) return null;
        for (const key of variantKeys) {
            const node = tcg[key];
            if (!node) continue;
            const marketPrice = node.marketPrice || node.midPrice || node.lowPrice || null;
            if (marketPrice && marketPrice > 0) {
                return {
                    price: marketPrice,
                    source: 'tcgdex_tcgplayer',
                    url: '',
                    highestRecentSale: 0,
                    highestRecentSaleSource: '',
                    highestRecentSaleUrl: ''
                };
            }
        }
        return null;
    };

    const pickFromCardmarket = () => {
        const cm = pricing.cardmarket;
        if (!cm) return null;
        const variantMap = [
            ['normal', ['avg30', 'trend', 'avg7', 'avg1', 'avg']],
            ['holo', ['avg30-holo', 'trend-holo', 'avg7-holo', 'avg1-holo']]
        ];
        for (const [kind, keys] of variantMap) {
            if (kind === 'holo' && !(htLower.includes('holo') || htLower.includes('reverse'))) continue;
            for (const key of keys) {
                const value = cm[key];
                if (value && value > 0) {
                    return {
                        price: value,
                        source: 'tcgdex_cardmarket',
                        url: '',
                        highestRecentSale: 0,
                        highestRecentSaleSource: '',
                        highestRecentSaleUrl: ''
                    };
                }
            }
        }
        return null;
    };

    return pickFromTcgplayer() || pickFromCardmarket();
}

// Look up official high-res image from Pokemon TCG API (fallback)
async function fetchCardImageFromPokemonTCG(cardName, cardSet, cardNumber) {
    if (!cardName) return null;
    try {
        const headers = { 'Accept': 'application/json' };
        if (POKEMON_TCG_KEY) headers['X-Api-Key'] = POKEMON_TCG_KEY;

        const params = { pageSize: 5 };
        if (cardNumber) {
            const num = cardNumber.split('/')[0].replace(/^0+/, '');
            params.q = `name:"${cardName}" number:"${num}"`;
        } else if (cardSet) {
             params.q = `name:"${cardName}" set.name:"*${cardSet}*"`;
        } else {
            params.q = `name:"${cardName}"`;
        }
        const resp = await axios.get('https://api.pokemontcg.io/v2/cards', { params, headers, timeout: 8000 });
        const results = resp.data?.data || [];
        if (results.length > 0) {
           return results[0].images?.large || results[0].images?.small || null;
        }
    } catch (err) {
        console.error(`  [ImageScrape] Pokemon TCG API Failed for "${cardName}":`, err.message);
    }
    return null;
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
Be conservative. Do not guess, infer, or invent card names, sets, numbers, or values. Only include a card when the physical printed card details are actually visible in the image.
Ignore binder pages, pack art, sleeves, background objects, partial text that is not clearly readable, and any artwork that is not a physical Pokemon card.
If the image is blurry, obstructed, or ambiguous, return an empty cards array and is_pokemon_card false.

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

function normalizeText(value) {
    return String(value || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function normalizeCardNumber(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const firstPart = raw.split('/')[0].trim();
    const letters = firstPart.match(/^[A-Za-z]+/)?.[0] || '';
    const digits = firstPart.match(/\d+/)?.[0] || '';
    const cleanedDigits = digits ? String(parseInt(digits, 10)) : '';
    return `${letters.toUpperCase()}${cleanedDigits}`.trim();
}

function hasMeaningfulCardName(name) {
    const normalized = normalizeText(name);
    if (!normalized) return false;
    return ![
        'pokemon',
        'pokemon card',
        'unknown',
        'unknown card',
        'trainer',
        'energy'
    ].includes(normalized);
}

function isLikelyVerifiedMatch(score, candidate, card) {
    const aiName = normalizeText(card.card_name);
    const candidateName = normalizeText(candidate?.name);
    const aiNumber = normalizeCardNumber(card.card_number);
    const candidateNumber = normalizeCardNumber(candidate?.number);
    const aiSet = normalizeText(card.card_set);
    const candidateSet = normalizeText(candidate?.set?.name);
    const exactName = aiName && candidateName && aiName === candidateName;
    const exactNumber = aiNumber && candidateNumber && aiNumber === candidateNumber;
    const exactSet = aiSet && candidateSet && (aiSet === candidateSet || aiSet.includes(candidateSet) || candidateSet.includes(aiSet));
    return score >= 7 && exactName && (exactNumber || (exactSet && (card.confidence || 0) >= 0.85));
}

function scorePokemonCardCandidate(card, candidate) {
    const aiName = normalizeText(card.card_name);
    const candidateName = normalizeText(candidate?.name);
    const aiSet = normalizeText(card.card_set);
    const candidateSet = normalizeText(candidate?.set?.name);
    const aiNumber = normalizeCardNumber(card.card_number);
    const candidateNumber = normalizeCardNumber(candidate?.number);

    let score = 0;

    if (aiName && candidateName) {
        if (aiName === candidateName) score += 4;
        else if (candidateName.includes(aiName) || aiName.includes(candidateName)) score += 2;
    }

    if (aiNumber && candidateNumber && aiNumber === candidateNumber) score += 5;

    if (aiSet && candidateSet) {
        if (aiSet === candidateSet) score += 3;
        else if (candidateSet.includes(aiSet) || aiSet.includes(candidateSet)) score += 1;
    }

    if (card.year && candidate?.set?.releaseDate?.startsWith(String(card.year))) score += 1;

    return score;
}

function extractMarketPriceFromPokemonCandidate(candidate, card) {
    if (!candidate) return null;
    const holoType = card?.holo_type || 'Unknown';
    const isFirstEd = card?.is_first_edition === true || card?.is_first_edition === 'true' || card?.is_first_edition === 1;
    const prices = candidate.tcgplayer?.prices;
    let price = null;
    let source = '';
    let url = candidate.tcgplayer?.url || candidate.cardmarket?.url || '';
    if (prices) {
        const htLower = normalizeText(holoType);
        if (htLower.includes('reverse') && prices.reverseHolofoil?.market) {
            price = prices.reverseHolofoil.market;
            source = 'tcgplayer_reverse_holo';
        } else if (isFirstEd && prices['1stEditionHolofoil']?.market) {
            price = prices['1stEditionHolofoil'].market;
            source = 'tcgplayer_1st_edition';
        } else if (!isFirstEd && prices.unlimitedHolofoil?.market) {
            price = prices.unlimitedHolofoil.market;
            source = 'tcgplayer_unlimited_holo';
        } else if (!isFirstEd && prices.unlimited?.market) {
            price = prices.unlimited.market;
            source = 'tcgplayer_unlimited';
        } else if ((htLower === 'holofoil' || htLower === 'cosmos holo') && prices.holofoil?.market) {
            price = prices.holofoil.market;
            source = 'tcgplayer_holo';
        } else if ((htLower === 'non holo' || htLower === 'non-holo') && prices.normal?.market) {
            price = prices.normal.market;
            source = 'tcgplayer_normal';
        }

        if (!price) {
            price = prices.holofoil?.market || prices.reverseHolofoil?.market || prices.normal?.market;
            if (!price) {
                // If it's 1st edition, prioritize 1st edition fallback. Otherwise prioritize unlimited fallback.
                if (isFirstEd) {
                    price = prices['1stEditionHolofoil']?.market || prices['1stEdition']?.market || prices.unlimitedHolofoil?.market || prices.unlimited?.market;
                } else {
                    price = prices.unlimitedHolofoil?.market || prices.unlimited?.market || prices['1stEditionHolofoil']?.market || prices['1stEdition']?.market;
                }
            }
            if (!price) {
                price = prices.holofoil?.mid || prices.normal?.mid || null;
            }
            if (price) source = 'pokemon_tcg_api_fallback';
        }
    }
    if (!price && candidate.cardmarket?.prices) {
        price = candidate.cardmarket.prices.averageSellPrice
            || candidate.cardmarket.prices.trendPrice
            || candidate.cardmarket.prices.avg7
            || null;
        if (price) {
            source = 'cardmarket';
            url = candidate.cardmarket?.url || url;
        }
    }
    if (!price || price <= 0) return null;
    return {
        price,
        source: source || 'pokemon_tcg_api',
        url,
        highestRecentSale: price,
        highestRecentSaleSource: source || 'pokemon_tcg_api',
        highestRecentSaleUrl: url || ''
    };
}

function pickBestPokemonCardCandidate(card, candidates) {
    let bestCandidate = null;
    let bestScore = -1;
    for (const candidate of candidates || []) {
        const score = scorePokemonCardCandidate(card, candidate);
        if (score > bestScore) {
            bestCandidate = candidate;
            bestScore = score;
        }
    }
    return { bestCandidate, bestScore };
}

function hasDistinctVariantEvidence(card) {
    return Boolean(normalizeCardNumber(card?.card_number)) || Boolean(normalizeText(card?.card_set));
}

async function fetchPokemonTcgCandidates(card) {
    if (!hasMeaningfulCardName(card.card_name)) return [];

    const headers = { 'Accept': 'application/json' };
    if (POKEMON_TCG_KEY) headers['X-Api-Key'] = POKEMON_TCG_KEY;

    const queries = [];
    const safeName = String(card.card_name || '').replace(/"/g, '\\"').trim();
    const safeSet = String(card.card_set || '').replace(/"/g, '\\"').trim();
    const normalizedNumber = normalizeCardNumber(card.card_number);

    if (safeName && safeSet && normalizedNumber) queries.push(`name:"${safeName}" set.name:"${safeSet}" number:"${normalizedNumber}"`);
    if (safeName && safeSet) queries.push(`name:"${safeName}" set.name:"${safeSet}"`);
    if (safeName && normalizedNumber) queries.push(`name:"${safeName}" number:"${normalizedNumber}"`);
    if (safeName) queries.push(`name:"${safeName}"`);

    const unique = new Map();

    for (const q of queries) {
        try {
            const resp = await axios.get('https://api.pokemontcg.io/v2/cards', {
                params: { q, pageSize: 15 },
                headers,
                timeout: 12000
            });
            const results = resp.data?.data || [];
            for (const result of results) {
                if (result?.id && !unique.has(result.id)) unique.set(result.id, result);
            }
            if (unique.size >= 15) break;
        } catch (err) {
            console.error(`  [Verify] Pokemon TCG lookup failed for "${card.card_name}" with query "${q}":`, err.message);
        }
    }

    return Array.from(unique.values());
}

async function verifyAndCanonicalizeCard(card) {
    if (!card || !hasMeaningfulCardName(card.card_name)) return null;
    if (analysisLooksTooWeak(card)) return null;

    const candidates = await fetchPokemonTcgCandidates(card);
    if (!candidates.length) return null;

    const normalizedAiName = normalizeText(card.card_name);
    const sameNameCandidates = candidates.filter(c => normalizeText(c?.name) === normalizedAiName);
    const exactNumberCandidates = sameNameCandidates.filter(c => normalizeCardNumber(c?.number) === normalizeCardNumber(card.card_number));
    const exactSetCandidates = sameNameCandidates.filter(c => {
        const setA = normalizeText(c?.set?.name);
        const setB = normalizeText(card.card_set);
        return setA && setB && (setA === setB || setA.includes(setB) || setB.includes(setA));
    });

    if (sameNameCandidates.length > 1 && exactNumberCandidates.length === 0 && exactSetCandidates.length !== 1) {
        console.log(`  [Verify] Ambiguous same-name variant rejected for "${card.card_name}"`);
        return null;
    }

    const { bestCandidate, bestScore } = pickBestPokemonCardCandidate(card, candidates);

    if (!bestCandidate || !isLikelyVerifiedMatch(bestScore, bestCandidate, card)) {
        return null;
    }

    return {
        ...card,
        card_name: bestCandidate.name || card.card_name,
        card_set: bestCandidate.set?.name || card.card_set || '',
        card_number: bestCandidate.number || card.card_number || '',
        rarity: bestCandidate.rarity || card.rarity || 'Unknown',
        year: parseInt((bestCandidate.set?.releaseDate || '').slice(0, 4), 10) || card.year || 0,
        language: card.language || 'English',
        image_url: bestCandidate.images?.large || bestCandidate.images?.small || '',
        tcgplayer_url: bestCandidate.tcgplayer?.url || '',
        cardmarket_url: bestCandidate.cardmarket?.url || '',
        verified_market_data: extractMarketPriceFromPokemonCandidate(bestCandidate, card),
        confidence: Math.max(Number(card.confidence) || 0, bestScore >= 10 ? 0.98 : bestScore >= 8 ? 0.92 : 0.85)
    };
}

function analysisLooksTooWeak(card) {
    const confidence = Number(card?.confidence) || 0;
    const hasNumber = Boolean(normalizeCardNumber(card?.card_number));
    const hasSet = Boolean(normalizeText(card?.card_set));
    return confidence < 0.65 || (!hasNumber && !hasSet);
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
                temperature: 0.1,
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

// ═══════════════════════════════════════════════════════════════
//  JUSTTCG API (TCGplayer pricing with condition breakdown)
// ═══════════════════════════════════════════════════════════════

async function fetchJustTCGPrice(cardName, cardSet, cardNumber) {
    if (!JUSTTCG_API_KEY) return null;
    try {
        const q = cardNumber && cardSet
            ? `${cardName} ${cardSet} ${cardNumber}`
            : cardNumber
                ? `${cardName} ${cardNumber}`
                : `${cardName} ${cardSet || ''}`;
        const url = `https://api.justtcg.com/v1/cards?q=${encodeURIComponent(q.trim())}&game=pokemon&condition=NM&limit=5`;
        const resp = await axios.get(url, {
            headers: { 'x-api-key': JUSTTCG_API_KEY },
            timeout: 10000
        });
        const cards = resp.data?.data || [];
        if (!cards.length) return null;

        // Find best matching card
        const needle = normalizeText(cardName);
        const setNeedle = normalizeText(cardSet);
        const numNeedle = normalizeCardNumber(cardNumber);
        let best = cards[0];
        for (const c of cards) {
            const cName = normalizeText(c.name);
            const cSet = normalizeText(c.set_name || c.set || '');
            const cNum = normalizeCardNumber(c.number);
            const isNameMatch = cName === needle || cName.includes(needle);
            const isSetMatch = !setNeedle || (cSet && cSet.includes(setNeedle));
            const isNumMatch = !numNeedle || cNum === numNeedle;

            if (isNameMatch && isSetMatch && isNumMatch) {
                best = c;
                break;
            }
        }

        const variant = best.variants?.find(v => v.condition === 'Near Mint' && v.price > 0)
            || best.variants?.find(v => v.price > 0);
        if (!variant || !variant.price) return null;

        return {
            price: variant.price,
            source: 'justtcg_tcgplayer',
            url: `https://www.tcgplayer.com/product/${best.tcgplayerId}`,
            condition: variant.condition,
            printing: variant.printing
        };
    } catch (err) {
        console.error(`  [JustTCG] Error for "${cardName}":`, err.message);
        return null;
    }
}

// ═══════════════════════════════════════════════════════════════
//  WEB SCRAPERS — Additional price sources
// ═══════════════════════════════════════════════════════════════

async function scrapeTCGplayerPrice(cardName, cardSet, cardNumber) {
    try {
        const q = `${cardName} ${cardSet || ''} ${cardNumber || ''}`.trim();
        const url = `https://www.tcgplayer.com/search/pokemon/product?q=${encodeURIComponent(q)}&view=grid`;
        const resp = await axios.get(url, { headers: makeHeaders(), timeout: 12000 });
        const $ = cheerio.load(resp.data);

        let price = null;
        // TCGplayer search results show market prices
        $('.search-result__market-price, .product-card__market-price').each((i, el) => {
            const text = $(el).text();
            const match = text.match(/\$([\d,.]+)/);
            if (match && !price) {
                const p = parsePrice(match[1]);
                if (p > 0.10) price = p;
            }
        });
        if (!price) {
            // Try alternative selectors
            $('[class*="price"]').each((i, el) => {
                const text = $(el).text();
                const match = text.match(/Market\s*Price[:\s]*\$([\d,.]+)/i);
                if (match && !price) {
                    const p = parsePrice(match[1]);
                    if (p > 0.10) price = p;
                }
            });
        }
        if (!price) return null;
        return { price, source: 'tcgplayer_direct', url };
    } catch (err) {
        console.error(`  [TCGplayer-Scrape] Error: ${err.message}`);
        return null;
    }
}

async function scrapeCardmarketPrice(cardName, cardSet) {
    try {
        const q = `${cardName} ${cardSet || ''}`.trim();
        const url = `https://www.cardmarket.com/en/Pokemon/Products/Search?searchString=${encodeURIComponent(q)}`;
        const resp = await axios.get(url, { headers: makeHeaders(), timeout: 12000 });
        const $ = cheerio.load(resp.data);

        let price = null;
        // Cardmarket shows trend prices in EUR
        $('.col-price, .price-container, [class*="trend"]').each((i, el) => {
            const text = $(el).text();
            const match = text.match(/([\d,.]+)\s*€/) || text.match(/€\s*([\d,.]+)/);
            if (match && !price) {
                const p = parseFloat(match[1].replace(',', '.'));
                if (p > 0.05) price = Number((p * 1.08).toFixed(2)); // EUR to USD approx
            }
        });
        if (!price) return null;
        return { price, source: 'cardmarket_direct', url };
    } catch (err) {
        console.error(`  [Cardmarket-Scrape] Error: ${err.message}`);
        return null;
    }
}

async function scrapeTrollAndToad(cardName, cardSet) {
    try {
        const q = `${cardName} ${cardSet || ''}`.trim();
        const url = `https://www.trollandtoad.com/category.php?selected-cat=7061&search-words=${encodeURIComponent(q)}`;
        const resp = await axios.get(url, { headers: makeHeaders(), timeout: 12000 });
        const $ = cheerio.load(resp.data);

        let price = null;
        // Troll and Toad shows prices in their product listing
        $('.product-col .product-info, .result-price, [class*="price"]').each((i, el) => {
            const text = $(el).text();
            const match = text.match(/\$([\d,.]+)/);
            if (match && !price) {
                const p = parsePrice(match[1]);
                if (p > 0.10) price = p;
            }
        });
        if (!price) return null;
        return { price, source: 'trollandtoad', url };
    } catch (err) {
        console.error(`  [TrollAndToad] Error: ${err.message}`);
        return null;
    }
}

async function scrapeTCGFish(cardName, cardSet) {
    try {
        const q = `${cardName} ${cardSet || ''}`.trim();
        const url = `https://www.tcgfish.com/search?q=${encodeURIComponent(q)}&game=pokemon`;
        const resp = await axios.get(url, { headers: makeHeaders(), timeout: 12000 });
        const $ = cheerio.load(resp.data);

        let price = null;
        $('[class*="price"], [class*="Price"]').each((i, el) => {
            const text = $(el).text();
            const match = text.match(/\$([\d,.]+)/);
            if (match && !price) {
                const p = parsePrice(match[1]);
                if (p > 0.10) price = p;
            }
        });
        if (!price) return null;
        return { price, source: 'tcgfish', url };
    } catch (err) {
        console.error(`  [TCGFish] Error: ${err.message}`);
        return null;
    }
}

async function scrapeCardMavin(cardName, cardSet, cardNumber) {
    try {
        const q = `${cardName} ${cardNumber || ''} pokemon card`.trim();
        const url = `https://www.cardmavin.com/search?q=${encodeURIComponent(q)}`;
        const resp = await axios.get(url, { headers: makeHeaders(), timeout: 12000 });
        const $ = cheerio.load(resp.data);

        let price = null;
        // Card Mavin shows "Fair Market Value" and eBay sold aggregation
        $('[class*="price"], [class*="value"], .card-price').each((i, el) => {
            const text = $(el).text();
            const match = text.match(/\$([\d,.]+)/);
            if (match && !price) {
                const p = parsePrice(match[1]);
                if (p > 0.10) price = p;
            }
        });
        if (!price) return null;
        return { price, source: 'cardmavin', url };
    } catch (err) {
        console.error(`  [CardMavin] Error: ${err.message}`);
        return null;
    }
}

async function scrapeCoolStuffInc(cardName, cardSet) {
    try {
        const q = `${cardName} ${cardSet || ''}`.trim();
        const url = `https://www.coolstuffinc.com/main_search.php?pa=searchOnName&token=${encodeURIComponent(q)}`;
        const resp = await axios.get(url, { headers: makeHeaders(), timeout: 12000 });
        const $ = cheerio.load(resp.data);

        let price = null;
        $('.product-price, [class*="price"]').each((i, el) => {
            const text = $(el).text();
            const match = text.match(/\$([\d,.]+)/);
            if (match && !price) {
                const p = parsePrice(match[1]);
                if (p > 0.10) price = p;
            }
        });
        if (!price) return null;
        return { price, source: 'coolstuffinc', url };
    } catch (err) {
        console.error(`  [CoolStuffInc] Error: ${err.message}`);
        return null;
    }
}

async function scrapePriceCharting(cardName, cardSet) {
    try {
        const q = `${cardName} ${cardSet || ''} pokemon`.trim();
        const url = `https://www.pricecharting.com/search-products?q=${encodeURIComponent(q)}&type=prices`;
        const resp = await axios.get(url, { headers: makeHeaders(), timeout: 12000 });
        const $ = cheerio.load(resp.data);

        let price = null;
        // PriceCharting shows "ungraded" prices in the search results
        $('td.price, .js-price, [data-price]').each((i, el) => {
            const text = $(el).attr('data-price') || $(el).text();
            const match = text.match(/\$?([\d,.]+)/);
            if (match && !price) {
                const p = parsePrice(match[1]);
                if (p > 0.10) price = p;
            }
        });
        if (!price) return null;
        return { price, source: 'pricecharting', url };
    } catch (err) {
        console.error(`  [PriceCharting] Error: ${err.message}`);
        return null;
    }
}

// ═══════════════════════════════════════════════════════════════

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

function filterComparableListings(listings, cardName, cardSet, cardNumber) {
    const nameNeedle = normalizeText(cardName);
    const setNeedle = normalizeText(cardSet);
    const numberNeedle = normalizeCardNumber(cardNumber);
    return (listings || []).filter(listing => {
        const title = normalizeText(listing.title);
        if (!title || (nameNeedle && !title.includes(nameNeedle))) return false;
        const compactTitle = title.replace(/\s+/g, '');
        const compactNumber = numberNeedle.toLowerCase();
        const hasNumberMatch = compactNumber ? compactTitle.includes(compactNumber) : false;
        const hasSetMatch = setNeedle ? title.includes(setNeedle) : false;
        
        if (numberNeedle && !hasNumberMatch) return false;
        if (setNeedle && !hasSetMatch) {
            if (!hasNumberMatch) return false;
            if (compactNumber.length <= 2) return false; // Too risky to match just "14" across sets
        }
        
        return !['lot', 'bundle', 'psa', 'bgs', 'cgc', 'graded', 'proxy', 'custom', 'orica', 'replica', 'fake', 'repack'].some(kw => title.includes(kw));
    });
}

function summarizeComparableSales(listings) {
    const sorted = [...(listings || [])].filter(l => l.price > 0).sort((a, b) => a.price - b.price);
    if (!sorted.length) return null;
    const medianIdx = Math.floor(sorted.length / 2);
    return {
        marketPrice: sorted[medianIdx].price,
        highestRecentSale: sorted[sorted.length - 1].price,
        sampleSize: sorted.length
    };
}

async function lookupMarketPrice(card) {
    const { card_name: cardName, card_set: cardSet, card_number: cardNumber, year, language, holo_type: holoType } = card;
    if (!cardName) return null;
    const key = `${cardName}|${cardSet || ''}|${cardNumber || ''}`.toLowerCase();

    const cached = priceCache.get(key);
    if (cached && Date.now() - cached.ts < 86400000) return { ...cached };

    const known = checkKnownCards(cardName, cardSet);
    if (known) {
        priceCache.set(key, { price: known, source: 'reference', ts: Date.now() });
        return { price: known, source: 'reference' };
    }

    // ── Query ALL sources in parallel ────────────────────────────
    const sourcePromises = [];

    // 1. TCGdex (→ TCGplayer + Cardmarket)
    sourcePromises.push((async () => {
        try {
            const tcgdexCard = await fetchTCGdexCard(cardName, cardSet, cardNumber);
            return extractTcgdexPrice(tcgdexCard, holoType);
        } catch { return null; }
    })());

    // 2. PokemonTCG API
    if (POKEMON_TCG_KEY) {
        if (!hasDistinctVariantEvidence({ card_set: cardSet, card_number: cardNumber })) {
            sourcePromises.push(Promise.resolve(null));
        } else {
            sourcePromises.push((async () => {
                try {
                    const candidates = await fetchPokemonTcgCandidates({ card_name: cardName, card_set: cardSet, card_number: cardNumber, year });
                    if (candidates.length) {
                        const { bestCandidate, bestScore } = pickBestPokemonCardCandidate({ card_name: cardName, card_set: cardSet, card_number: cardNumber, year }, candidates);
                        if (bestCandidate && isLikelyVerifiedMatch(bestScore, bestCandidate, {
                            card_name: cardName, card_set: cardSet, card_number: cardNumber, year, confidence: 0.95
                        })) {
                            return extractMarketPriceFromPokemonCandidate(bestCandidate, card);
                        }
                    }
                    return null;
                } catch { return null; }
            })());
        }
    } else {
        sourcePromises.push(Promise.resolve(null));
    }

    // 3. Scrydex API
    if (SCRYDEX_API_KEY && SCRYDEX_TEAM_ID) {
        sourcePromises.push((async () => {
            try {
                const scrydexCard = await fetchScrydexCard(cardName, cardSet, cardNumber);
                const result = extractScrydexPrice(scrydexCard);
                if (result) return { ...result, highestRecentSale: result.price, highestRecentSaleSource: result.source, highestRecentSaleUrl: result.url || '' };
                return null;
            } catch { return null; }
        })());
    } else {
        sourcePromises.push(Promise.resolve(null));
    }

    // 4. JustTCG (TCGplayer live pricing)
    sourcePromises.push((async () => {
        try { return await fetchJustTCGPrice(cardName, cardSet, cardNumber); }
        catch { return null; }
    })());

    // 5. eBay Sold Listings
    sourcePromises.push((async () => {
        try {
            const query = cardNumber
                ? `"${cardName}" ${cardNumber} pokemon card`
                : `"${cardName}" ${cardSet || ''} pokemon card`;
            const listings = await scrapeEbayHTML(query);
            if (listings.length > 0) {
                const filtered = filterComparableListings(listings, cardName, cardSet, cardNumber);
                const summary = summarizeComparableSales(filtered);
                if (summary) {
                    const url = `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(query)}&LH_Sold=1&LH_Complete=1&_sop=13`;
                    return { price: summary.marketPrice, source: 'ebay_sold', url, highestRecentSale: summary.highestRecentSale, highestRecentSaleSource: 'ebay_sold', highestRecentSaleUrl: url };
                }
            }
            return null;
        } catch { return null; }
    })());

    // Wait for primary API sources
    const primaryResults = await Promise.allSettled(sourcePromises);

    // ── Collect all valid prices ────────────────────────────────
    let validPrices = [];
    const allSourcePrices = {}; // Per-source price breakdown for the UI

    for (const res of primaryResults) {
        if (res.status === 'fulfilled' && res.value && res.value.price > 0) {
            validPrices.push(res.value);
            allSourcePrices[res.value.source] = {
                price: res.value.price,
                url: res.value.url || '',
                ts: new Date().toISOString()
            };
        }
    }

    const sourcesChecked = primaryResults.length;

    if (validPrices.length > 0) {
        validPrices.sort((a, b) => a.price - b.price);
        
        let refinedPrices = validPrices;
        
        if (validPrices.length >= 3) {
            const median = validPrices[Math.floor(validPrices.length / 2)].price;
            refinedPrices = validPrices.filter(p => p.price <= median * 3 && p.price >= median * 0.33);
        } else if (validPrices.length === 2) {
            // If we only have 2 sources and they wildly disagree, pick the conservative lower price
            if (validPrices[1].price > validPrices[0].price * 3) {
                refinedPrices = [validPrices[0]];
            }
        }

        if (refinedPrices.length > 0) {
            const avgPrice = refinedPrices.reduce((sum, p) => sum + p.price, 0) / refinedPrices.length;
            const bestSource = refinedPrices.find(p => p.url) || refinedPrices[0];

            // Find the best (highest) sold price across all sources
            const bestSoldPrice = Math.max(...refinedPrices.map(p => p.highestRecentSale || p.price));
            const bestSoldEntry = refinedPrices.find(p => (p.highestRecentSale || p.price) === bestSoldPrice) || bestSource;

            const finalResult = {
                price: Number(avgPrice.toFixed(2)),
                source: refinedPrices.length > 1 ? 'aggregated_market' : bestSource.source,
                url: bestSource.url || '',
                highestRecentSale: bestSoldPrice,
                highestRecentSaleSource: bestSoldEntry.source || 'aggregated_market',
                highestRecentSaleUrl: bestSoldEntry.url || bestSource.url || '',
                bestSoldPrice,
                bestSoldSource: bestSoldEntry.source || '',
                allSourcePrices,
                sourcesChecked,
                sourcesFound: validPrices.length
            };

            console.log(`  [Pricing] Aggregated for "${cardName}": $${finalResult.price.toFixed(2)} from ${refinedPrices.length}/${sourcesChecked} sources (best sold: $${bestSoldPrice.toFixed(2)})`);
            priceCache.set(key, { ...finalResult, ts: Date.now() });
            return finalResult;
        }
    }

    if (sourcesChecked >= 5) {
        console.log(`  [Pricing] No market price found for "${cardName}" (checked ${sourcesChecked} sources). Setting to 0.`);
        const emptyResult = {
            price: 0,
            source: 'not_found',
            url: '',
            highestRecentSale: 0,
            highestRecentSaleSource: '',
            highestRecentSaleUrl: '',
            bestSoldPrice: 0,
            bestSoldSource: '',
            allSourcePrices: {},
            sourcesChecked,
            sourcesFound: 0
        };
        priceCache.set(key, { ...emptyResult, ts: Date.now() });
        return emptyResult;
    }

    console.log(`  [Pricing] No market price found for "${cardName}" (checked ${sourcesChecked} sources)`);
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

// Batched refresh: process N cards (for Vercel cron, N=5 to fit in 10s timeout)
async function refreshBatchPrices(batchSize = 5) {
    if (priceRefreshRunning) {
        console.log('  [PriceRefresh] Already running, skipping.');
        return { skipped: true };
    }
    priceRefreshRunning = true;

    try {
        // Pick the N cards that haven't been checked in the longest (or never)
        const res = await pool.query(`
            SELECT id, card_name, card_set, card_number, rarity, condition, is_holo, is_first_edition, confidence, image_url, year, language, holo_type, current_price
            FROM portfolio_cards
            ORDER BY
                last_price_check ASC NULLS FIRST,
                CASE WHEN COALESCE(current_price, 0) = 0 THEN 0 ELSE 1 END ASC,
                id ASC
            LIMIT $1
        `, [batchSize]);

        const cards = res.rows;
        let updated = 0;

        console.log(`  [PriceRefresh] Processing batch of ${cards.length} cards...`);

        for (const card of cards) {
            try {
                // Back-fill missing images
                if (!card.image_url || card.image_url.includes('undefined')) {
                    let imageUrl = await fetchCardImageFromTCGdex(card.card_name, card.card_set, card.card_number);
                    if (!imageUrl) imageUrl = await fetchCardImageFromPokemonTCG(card.card_name, card.card_set, card.card_number);
                    if (imageUrl) await updateCardImageUrl(card.id, imageUrl);
                }

                const result = await lookupMarketPrice(card);
                if (result && result.price >= 0 && result.source) {
                    if (result.price > 0) {
                        await insertPricePoint(card.id, result.price, result.source || 'market', result.url || '');
                    }
                    await updatePortfolioCardMarketData(card.id, result);
                    updated++;
                } else {
                    // Still mark as checked so we don't re-check endlessly
                    await pool.query('UPDATE portfolio_cards SET last_price_check = NOW() WHERE id = $1', [card.id]);
                }
            } catch (err) {
                console.error(`  [PriceRefresh] Error for ${card.card_name}:`, err.message);
                await pool.query('UPDATE portfolio_cards SET last_price_check = NOW() WHERE id = $1', [card.id]);
            }
        }

        console.log(`  [PriceRefresh] Batch complete. Updated ${updated}/${cards.length} cards.`);
        return { updated, total: cards.length, batchSize };
    } finally {
        priceRefreshRunning = false;
    }
}

// Full refresh (for non-Vercel environments only)
async function refreshAllPrices() {
    if (priceRefreshRunning) {
        console.log('  [PriceRefresh] Already running, skipping.');
        return { skipped: true };
    }
    priceRefreshRunning = true;
    console.log('  [PriceRefresh] Starting full price refresh...');
    broadcastActivity('refresh_start', 'Refreshing market prices...');

    const res = await pool.query(`
        SELECT id, card_name, card_set, card_number, rarity, condition, is_holo, is_first_edition, confidence, image_url, year, language, holo_type, current_price
        FROM portfolio_cards
        ORDER BY last_price_check ASC NULLS FIRST, id ASC
    `);
    const cards = res.rows;
    let updated = 0;

    for (const card of cards) {
        try {
            if (!card.image_url || card.image_url.includes('undefined')) {
                let imageUrl = await fetchCardImageFromTCGdex(card.card_name, card.card_set, card.card_number);
                if (!imageUrl) imageUrl = await fetchCardImageFromPokemonTCG(card.card_name, card.card_set, card.card_number);
                if (imageUrl) {
                    await updateCardImageUrl(card.id, imageUrl);
                    console.log(`  [PriceRefresh] Found image for ${card.card_name}`);
                }
            }

            const result = await lookupMarketPrice(card);
            if (result && result.price > 0) {
                await insertPricePoint(card.id, result.price, result.source || 'market', result.url || '');
                await updatePortfolioCardMarketData(card.id, result);
                updated++;
                broadcastActivity('price_update', `${card.card_name}: $${result.price.toFixed(2)} (${result.source})`);
            } else {
                await pool.query('UPDATE portfolio_cards SET last_price_check = NOW() WHERE id = $1', [card.id]);
            }
            await sleep(1500);
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

// Auto-refresh every 24 hours (only in long-running server mode, not Vercel serverless)
const IS_VERCEL = !!process.env.VERCEL;
if (!IS_VERCEL) {
    const REFRESH_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours
    setInterval(() => {
        refreshAllPrices().catch(err => console.error('[AutoRefresh] Error:', err.message));
    }, REFRESH_INTERVAL);
}

// ═══════════════════════════════════════════════════════════════
//  EXPRESS SERVER
// ═══════════════════════════════════════════════════════════════

const app = express();
app.use(express.json());
app.use(cookieParser());

// Compress all responses to reduce bandwidth
app.use((req, res, next) => {
    const acceptEncoding = req.headers['accept-encoding'] || '';
    if (!acceptEncoding.includes('gzip')) return next();
    const origJson = res.json.bind(res);
    res.json = (body) => {
        const data = JSON.stringify(body);
        if (data.length < 1024) return origJson(body); // skip small responses
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Encoding', 'gzip');
        const gz = createGzip();
        gz.pipe(res);
        gz.end(data);
    };
    next();
});

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

// No auth — single-user mode (Jack's portfolio)
const DEFAULT_USER_ID = 1;
const requireAuth = (req, res, next) => {
    req.user = { id: DEFAULT_USER_ID, username: 'jack' };
    next();
};

app.get('/api/auth/me', (req, res) => {
    res.json({ username: 'jack' });
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
        const summary = summarizePriceHistory(history);
        res.json({ history, summary });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get card image (base64 fallback for cards without image_url)
app.get('/api/portfolio/:id/image', requireAuth, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT image_data FROM portfolio_cards WHERE id = $1',
            [parseInt(req.params.id)]
        );
        if (!result.rows.length || !result.rows[0].image_data) {
            return res.status(404).json({ error: 'No image' });
        }
        res.json({ image_data: result.rows[0].image_data });
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

// Edit card details (set, number, etc)
app.post('/api/portfolio/:id/edit', requireAuth, express.json(), async (req, res) => {
    try {
        const { card_name, card_set, card_number } = req.body;
        await pool.query(
            `UPDATE portfolio_cards SET card_name = $1, card_set = $2, card_number = $3, last_price_check = NULL WHERE id = $4 AND user_id = $5`,
            [card_name, card_set, card_number, parseInt(req.params.id), req.user.id]
        );
        // Delete history so we start fresh with the new card variant
        await pool.query(`DELETE FROM price_history WHERE card_id = $1`, [parseInt(req.params.id)]);
        // Trigger a background refresh for this specific card
        updatePortfolioCardMarketData(parseInt(req.params.id), {}).catch(err => console.error("Edit Refresh Error:", err));
        res.json({ success: true });
    } catch (err) {
        console.error('Edit error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Manually trigger price refresh
app.post('/api/portfolio/refresh-prices', requireAuth, async (req, res) => {
    try {
        res.json({ success: true, message: 'Price refresh started (12 sources).' });
        if (IS_VERCEL) {
            // On Vercel, do a small batch synchronously
            refreshBatchPrices(5).catch(err => console.error('Manual refresh error:', err));
        } else {
            refreshAllPrices().catch(err => console.error('Manual refresh error:', err));
        }
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

        if (analysis?.is_pokemon_card === false || !analysis?.cards?.length) {
            broadcastActivity('info', `No Pokemon card detected in photo ${index + 1}.`);
            continue;
        }

        const verifiedCards = [];
        for (const rawCard of analysis.cards) {
            const verifiedCard = await verifyAndCanonicalizeCard(rawCard);
            if (verifiedCard) verifiedCards.push(verifiedCard);
        }

        if (!verifiedCards.length) {
            broadcastActivity('info', `Could not confidently verify a Pokemon card in photo ${index + 1}.`);
            continue;
        }

        broadcastActivity('found', `Verified ${verifiedCards.length} card(s) in photo ${index + 1}`);

        for (const card of verifiedCards) {
            // Look up official card image from TCGdex, fallback to Pokemon TCG API
            let imageUrl = card.image_url || '';
            try {
                if (!imageUrl) {
                    imageUrl = await fetchCardImageFromTCGdex(card.card_name, card.card_set, card.card_number) || '';
                }
                if (!imageUrl) {
                    imageUrl = await fetchCardImageFromPokemonTCG(card.card_name, card.card_set, card.card_number) || '';
                }
            } catch { /* continue without image */ }

            // Inline synchronous market price fetch
            let finalPrice = 0;
            let finalSource = 'unpriced';
            let finalUrl = '';
            let finalHighestRecentSale = 0;
            let finalHighestRecentSaleSource = '';
            let finalHighestRecentSaleUrl = '';
            try {
                const priceResult = card.verified_market_data || await lookupMarketPrice(card);
                if (priceResult && priceResult.price > 0) {
                    finalPrice = priceResult.price;
                    finalSource = priceResult.source;
                    finalUrl = priceResult.url || '';
                    finalHighestRecentSale = priceResult.highestRecentSale || priceResult.price || 0;
                    finalHighestRecentSaleSource = priceResult.highestRecentSaleSource || priceResult.source || '';
                    finalHighestRecentSaleUrl = priceResult.highestRecentSaleUrl || priceResult.url || '';
                }
            } catch (err) {
                console.error(`  [Pricing] Error fetching inline price for ${card.card_name}:`, err.message);
            }

            const cardId = await insertPortfolioCard({
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
                notes: card.notes || '',
                year: card.year || 0,
                language: card.language || 'English',
                holo_type: card.holo_type || 'Unknown',
                highest_recent_sale: finalHighestRecentSale,
                highest_recent_sale_source: finalHighestRecentSaleSource,
                highest_recent_sale_url: finalHighestRecentSaleUrl
            }, userId);

            if (finalPrice > 0) {
                await insertPricePoint(cardId, finalPrice, finalSource, finalUrl);
                await updatePortfolioCardMarketData(cardId, {
                    price: finalPrice,
                    source: finalSource,
                    url: finalUrl,
                    highestRecentSale: finalHighestRecentSale,
                    highestRecentSaleSource: finalHighestRecentSaleSource,
                    highestRecentSaleUrl: finalHighestRecentSaleUrl
                });
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
                image_data: thumbDataUrl || '',
                current_price: finalPrice,
                estimated_value: finalPrice,
                price_source: finalSource,
                price_source_url: finalUrl,
                highest_recent_sale: finalHighestRecentSale,
                highest_recent_sale_source: finalHighestRecentSaleSource,
                highest_recent_sale_url: finalHighestRecentSaleUrl,
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



// SSE endpoint (works in long-running server; Vercel clients fall back to polling)
app.get('/api/events', (req, res) => {
    if (IS_VERCEL) {
        // Vercel serverless can't hold SSE connections — return a one-shot status
        return res.json({ type: 'connected', mode: 'polling' });
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    sseClients.add(res);
    res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
    req.on('close', () => sseClients.delete(res));
});

// Vercel Cron endpoint — triggers price refresh (secured by CRON_SECRET)
app.get('/api/cron/refresh-prices', async (req, res) => {
    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret && req.headers.authorization !== `Bearer ${cronSecret}`) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    try {
        // Kick off the refresh asynchronously so we don't timeout the HTTP response
        refreshAllPrices().catch(err => console.error('[Cron] Refresh error:', err.message));
        res.json({ success: true, message: "Background refresh started" });
    } catch (err) {
        console.error('[Cron] Refresh error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Get per-source price breakdown for a card
app.get('/api/portfolio/:id/prices', requireAuth, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT price_sources, best_sold_price, best_sold_source, current_price, price_source FROM portfolio_cards WHERE id = $1',
            [parseInt(req.params.id)]
        );
        if (!result.rows.length) return res.status(404).json({ error: 'Card not found' });
        const card = result.rows[0];
        res.json({
            sources: card.price_sources || {},
            bestSoldPrice: card.best_sold_price || 0,
            bestSoldSource: card.best_sold_source || '',
            currentPrice: card.current_price || 0,
            priceSource: card.price_source || ''
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Fallback to index.html
app.get('*', (req, res) => { res.sendFile(join(__dirname, 'index.html')); });

// ═══════════════════════════════════════════════════════════════
//  START
// ═══════════════════════════════════════════════════════════════

console.log(`
╔══════════════════════════════════════════════════╗
║  ⚡ Jack's Pokemon Portfolio Tracker v4          ║
║  Multi-Source Price Comparison (12 Sources)      ║
╚══════════════════════════════════════════════════╝
`);
console.log('📊 Price Sources:');
console.log('   TCGdex API:      ✅ Enabled (free, no key)');
console.log('   JustTCG API:    ', JUSTTCG_API_KEY ? '✅ Key loaded' : '⚠️  No key — add JUSTTCG_API_KEY');
console.log('   Pokemon TCG API:', POKEMON_TCG_KEY ? '✅ Key loaded' : '⚠️  No key — add POKEMON_TCG_KEY');
console.log('   Scrydex API:    ', (SCRYDEX_API_KEY && SCRYDEX_TEAM_ID) ? '✅ Enabled' : '⚠️  No credentials');
console.log('   eBay Scraper:    ✅ Enabled');
console.log('   TCGplayer:       ✅ Enabled (scraper)');
console.log('   Cardmarket:      ✅ Enabled (scraper)');
console.log('   Troll and Toad:  ✅ Enabled (scraper)');
console.log('   TCGFish:         ✅ Enabled (scraper)');
console.log('   Card Mavin:      ✅ Enabled (scraper)');
console.log('   CoolStuffInc:    ✅ Enabled (scraper)');
console.log('   PriceCharting:   ✅ Enabled (scraper)');

// Only start listening in non-Vercel (long-running server) mode
if (!IS_VERCEL) {
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🌐 Dashboard running at http://0.0.0.0:${PORT}`);
    });

    process.on('SIGINT', async () => {
        console.log('\n🛑 Shutting down...');
        await pool.end();
        process.exit(0);
    });
}

// Export for Vercel serverless
export default app;
