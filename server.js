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

import {
    normalizeText,
    normalizeCardNumber,
    buildVariantKey,
    canonicalCondition,
    conditionMultiplier,
    copyValue,
    CONDITIONS,
    isTruthy,
} from './lib/identity.js';
import {
    quotesFromPokemonTcgCandidate,
    quotesFromTcgdexCard,
    aggregateQuotes,
    priceContextFor,
    fxStatus,
} from './lib/pricing.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '3000', 10);
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
const POKEMON_TCG_KEY = process.env.POKEMON_TCG_KEY || process.env.POKEMON_TCG_API_KEY || '';
const SCRYDEX_API_KEY = process.env.SCRYDEX_API_KEY || '';
const SCRYDEX_TEAM_ID = process.env.SCRYDEX_TEAM_ID || '';
const JUSTTCG_API_KEY = process.env.JUSTTCG_API_KEY || '';

// ═══════════════════════════════════════════════════════════════
//  DATABASE
// ═══════════════════════════════════════════════════════════════

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-key-please-change-in-prod';
const DB_URL = process.env.POSTGRES_URL || process.env.DATABASE_URL || process.env.DATABASE_POSTGRES_URL || 'postgres://localhost:5432/pokesniper';

/** Hosted Postgres needs SSL; a local or explicitly-disabled one must not use it. */
function shouldUseSsl(url) {
    if (/sslmode=disable/i.test(url)) return false;
    return !/@(localhost|127\.0\.0\.1|\[::1\])[:/]/i.test(url);
}

const pool = new Pool({
    connectionString: DB_URL,
    ssl: shouldUseSsl(DB_URL) ? { rejectUnauthorized: false } : false
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

    await pool.query(`
        ALTER TABLE portfolio_cards ADD COLUMN IF NOT EXISTS current_price REAL DEFAULT 0;
        ALTER TABLE portfolio_cards ADD COLUMN IF NOT EXISTS price_source TEXT DEFAULT '';
        ALTER TABLE portfolio_cards ADD COLUMN IF NOT EXISTS price_source_url TEXT DEFAULT '';
        ALTER TABLE price_history      ADD COLUMN IF NOT EXISTS source_url TEXT DEFAULT '';
        ALTER TABLE portfolio_cards ADD COLUMN IF NOT EXISTS highest_recent_sale REAL DEFAULT 0;
        ALTER TABLE portfolio_cards ADD COLUMN IF NOT EXISTS highest_recent_sale_source TEXT DEFAULT '';
        ALTER TABLE portfolio_cards ADD COLUMN IF NOT EXISTS highest_recent_sale_url TEXT DEFAULT '';
        ALTER TABLE portfolio_cards ADD COLUMN IF NOT EXISTS last_price_check TIMESTAMP;
        ALTER TABLE portfolio_cards ADD COLUMN IF NOT EXISTS price_sources JSONB DEFAULT '{}';
        ALTER TABLE portfolio_cards ADD COLUMN IF NOT EXISTS best_sold_price REAL DEFAULT 0;
        ALTER TABLE portfolio_cards ADD COLUMN IF NOT EXISTS best_sold_source TEXT DEFAULT '';

        -- Identity + pricing provenance
        ALTER TABLE portfolio_cards ADD COLUMN IF NOT EXISTS variant_key TEXT DEFAULT '';
        ALTER TABLE portfolio_cards ADD COLUMN IF NOT EXISTS needs_review INTEGER DEFAULT 0;
        ALTER TABLE portfolio_cards ADD COLUMN IF NOT EXISTS price_confidence REAL DEFAULT 0;
        ALTER TABLE portfolio_cards ADD COLUMN IF NOT EXISTS price_marketplace TEXT DEFAULT '';
        ALTER TABLE portfolio_cards ADD COLUMN IF NOT EXISTS price_variant TEXT DEFAULT '';
        ALTER TABLE portfolio_cards ADD COLUMN IF NOT EXISTS price_variant_matched INTEGER DEFAULT 0;
        ALTER TABLE portfolio_cards ADD COLUMN IF NOT EXISTS price_low REAL DEFAULT 0;
        ALTER TABLE portfolio_cards ADD COLUMN IF NOT EXISTS price_high REAL DEFAULT 0;
    `);

    // One row per physical copy. Jack owns three Charizards; that is one card
    // and three copies, not three cards.
    await pool.query(`
        CREATE TABLE IF NOT EXISTS card_copies (
            id SERIAL PRIMARY KEY,
            card_id INTEGER NOT NULL REFERENCES portfolio_cards(id) ON DELETE CASCADE,
            condition TEXT DEFAULT 'Unknown',
            grade TEXT DEFAULT '',
            grader TEXT DEFAULT '',
            manual_value REAL DEFAULT 0,
            acquired_price REAL DEFAULT 0,
            acquired_at TIMESTAMP,
            notes TEXT DEFAULT '',
            image_data TEXT DEFAULT '',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_card_copies_card ON card_copies(card_id);
        CREATE INDEX IF NOT EXISTS idx_portfolio_variant ON portfolio_cards(user_id, variant_key);
    `);

    await backfillVariantKeys();
    await backfillCardCopies();
}

/**
 * Fill in variant_key for rows created before the column existed. Computed in
 * JS so there is exactly one definition of card identity in the codebase.
 */
async function backfillVariantKeys() {
    const res = await pool.query(`
        SELECT id, card_name, card_set, card_number, holo_type, is_holo, language, is_first_edition
        FROM portfolio_cards WHERE variant_key IS NULL OR variant_key = ''
    `);
    if (!res.rows.length) return;
    for (const row of res.rows) {
        await pool.query('UPDATE portfolio_cards SET variant_key = $1 WHERE id = $2', [buildVariantKey(row), row.id]);
    }
    console.log(`  [Migrate] Backfilled variant_key for ${res.rows.length} card(s)`);
}

/**
 * Give every pre-existing card exactly one copy, carrying over its condition and
 * photo. Purely additive: no card row is merged or deleted here. Folding actual
 * duplicates together is a separate, user-confirmed action.
 */
async function backfillCardCopies() {
    const res = await pool.query(`
        SELECT pc.id, pc.condition, pc.image_data, pc.added_at
        FROM portfolio_cards pc
        LEFT JOIN card_copies cc ON cc.card_id = pc.id
        WHERE cc.id IS NULL
    `);
    if (!res.rows.length) return;
    for (const row of res.rows) {
        await pool.query(
            `INSERT INTO card_copies (card_id, condition, image_data, acquired_at) VALUES ($1, $2, $3, $4)`,
            [row.id, canonicalCondition(row.condition), row.image_data || '', row.added_at || new Date()]
        );
    }
    console.log(`  [Migrate] Created ${res.rows.length} copy record(s) for existing cards`);
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
        INSERT INTO portfolio_cards (user_id, card_name, card_set, card_number, rarity, condition, is_holo, is_first_edition, confidence, image_data, image_url, notes, year, language, holo_type, variant_key, needs_review)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
        RETURNING id
    `, [
        userId, card.card_name, card.card_set || '', card.card_number || '', card.rarity || 'Unknown',
        canonicalCondition(card.condition_estimate || card.condition), (card.is_holographic || card.is_holo) ? 1 : 0, card.is_first_edition ? 1 : 0,
        card.confidence || 0, card.image_data || '', card.image_url || '', card.notes || '',
        card.year || 0, card.language || 'English', card.holo_type || 'Unknown',
        buildVariantKey(card), card.needs_review ? 1 : 0
    ]);
    return res.rows[0].id;
}

/** Find an existing card of the same printing, so a re-scan becomes another copy. */
async function findCardByVariant(variantKey, userId) {
    if (!variantKey) return null;
    const res = await pool.query(
        'SELECT * FROM portfolio_cards WHERE user_id = $1 AND variant_key = $2 ORDER BY id ASC LIMIT 1',
        [userId, variantKey]
    );
    return res.rows[0] || null;
}

async function addCardCopy(cardId, copy = {}) {
    const res = await pool.query(`
        INSERT INTO card_copies (card_id, condition, grade, grader, manual_value, acquired_price, acquired_at, notes, image_data)
        VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, NOW()), $8, $9)
        RETURNING *
    `, [
        cardId,
        canonicalCondition(copy.condition),
        copy.grade || '',
        copy.grader || '',
        Number(copy.manual_value) || 0,
        Number(copy.acquired_price) || 0,
        copy.acquired_at || null,
        copy.notes || '',
        copy.image_data || '',
    ]);
    return res.rows[0];
}

async function getCardCopies(cardId) {
    const res = await pool.query(
        'SELECT id, card_id, condition, grade, grader, manual_value, acquired_price, acquired_at, notes, created_at, (image_data <> \'\') AS has_photo FROM card_copies WHERE card_id = $1 ORDER BY id ASC',
        [cardId]
    );
    return res.rows;
}

async function updateCardImageUrl(cardId, imageUrl) {
    await pool.query(`UPDATE portfolio_cards SET image_url = $1 WHERE id = $2`, [imageUrl, cardId]);
}

/**
 * Persist a resolved market price plus the evidence behind it, so the UI can
 * explain the number instead of just asserting it.
 */
async function updatePortfolioCardMarketData(cardId, marketData = {}) {
    await pool.query(`
        UPDATE portfolio_cards
        SET current_price          = $2,
            price_source           = $3,
            price_source_url       = $4,
            price_confidence       = $5,
            price_marketplace      = $6,
            price_variant          = $7,
            price_variant_matched  = $8,
            price_low              = $9,
            price_high             = $10,
            price_sources          = COALESCE($11::jsonb, '{}'::jsonb),
            highest_recent_sale    = $10,
            best_sold_price        = $10,
            best_sold_source       = $3,
            last_price_check       = NOW()
        WHERE id = $1
    `, [
        cardId,
        Number(marketData.price) || 0,
        marketData.source || '',
        marketData.url || '',
        Number(marketData.confidence) || 0,
        marketData.marketplace || '',
        marketData.variant || '',
        marketData.variantMatched ? 1 : 0,
        Number(marketData.low) || 0,
        Number(marketData.high) || 0,
        JSON.stringify(marketData.allSourcePrices || {}),
    ]);
}

/** Marks a card as checked without touching its price — used when a lookup finds nothing. */
async function markPriceChecked(cardId) {
    await pool.query('UPDATE portfolio_cards SET last_price_check = NOW() WHERE id = $1', [cardId]);
}

// ── Duplicate consolidation ────────────────────────────────────────────────

/**
 * Rows that describe the same printing. Reported for review before anything is
 * touched — merging is destructive and is never done automatically.
 */
async function findDuplicateGroups(userId) {
    const res = await pool.query(`
        SELECT variant_key,
               COUNT(*)::int                        AS row_count,
               MIN(id)                              AS keep_id,
               ARRAY_AGG(id ORDER BY id)            AS ids,
               MIN(card_name)                       AS card_name,
               MIN(card_set)                        AS card_set,
               MIN(card_number)                     AS card_number,
               SUM((SELECT COUNT(*) FROM card_copies cc WHERE cc.card_id = pc.id))::int AS copy_count
        FROM portfolio_cards pc
        WHERE user_id = $1 AND variant_key <> ''
        GROUP BY variant_key
        HAVING COUNT(*) > 1
        ORDER BY COUNT(*) DESC
    `, [userId]);
    return res.rows;
}

/**
 * Fold duplicate rows into the oldest row of each group, preserving every copy
 * and every price point. Runs in a transaction: either a group merges fully or
 * not at all.
 */
async function mergeDuplicateGroups(userId, onlyVariantKeys = null) {
    const groups = await findDuplicateGroups(userId);
    const wanted = Array.isArray(onlyVariantKeys) && onlyVariantKeys.length
        ? groups.filter(g => onlyVariantKeys.includes(g.variant_key))
        : groups;

    let mergedGroups = 0;
    let removedRows = 0;
    let copiesMoved = 0;

    for (const group of wanted) {
        const keepId = group.keep_id;
        const dropIds = group.ids.filter(id => id !== keepId);
        if (!dropIds.length) continue;

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            // Any duplicate row still without a copy record contributes one, so a
            // merge can never reduce how many cards Jack is recorded as owning.
            await client.query(`
                INSERT INTO card_copies (card_id, condition, image_data, acquired_at)
                SELECT pc.id, pc.condition, pc.image_data, pc.added_at
                FROM portfolio_cards pc
                LEFT JOIN card_copies cc ON cc.card_id = pc.id
                WHERE pc.id = ANY($1::int[]) AND cc.id IS NULL
            `, [dropIds]);

            const moved = await client.query(
                'UPDATE card_copies SET card_id = $1 WHERE card_id = ANY($2::int[])',
                [keepId, dropIds]
            );
            await client.query(
                'UPDATE price_history SET card_id = $1 WHERE card_id = ANY($2::int[])',
                [keepId, dropIds]
            );
            // Keep artwork if the surviving row happens to be the one missing it.
            await client.query(`
                UPDATE portfolio_cards keep
                SET image_url = COALESCE(NULLIF(keep.image_url, ''), src.image_url)
                FROM (
                    SELECT image_url FROM portfolio_cards
                    WHERE id = ANY($2::int[]) AND image_url <> '' LIMIT 1
                ) src
                WHERE keep.id = $1
            `, [keepId, dropIds]);

            await client.query('DELETE FROM portfolio_cards WHERE id = ANY($1::int[]) AND user_id = $2', [dropIds, userId]);
            await client.query('COMMIT');

            mergedGroups++;
            removedRows += dropIds.length;
            copiesMoved += moved.rowCount;
        } catch (err) {
            await client.query('ROLLBACK');
            console.error(`  [Merge] Failed for ${group.variant_key}:`, err.message);
        } finally {
            client.release();
        }
    }

    return { mergedGroups, removedRows, copiesMoved, groupsAvailable: groups.length };
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
            pc.variant_key, pc.needs_review,
            pc.price_confidence, pc.price_marketplace, pc.price_variant,
            pc.price_variant_matched, pc.price_low, pc.price_high,
            pc.added_at, pc.current_price AS card_current_price, pc.price_source AS card_price_source,
            pc.price_source_url AS card_price_source_url,
            pc.price_sources, pc.last_price_check,
            CASE WHEN pc.image_data IS NOT NULL AND pc.image_data != '' AND (pc.image_url IS NULL OR pc.image_url = '') THEN true ELSE false END AS has_local_image,
            latest.price AS current_price,
            day_ref.price AS previous_price,
            day_ref.price AS prev_day_price,
            week_ref.price AS prev_7d_price,
            month_ref.price AS prev_30d_price,
            latest.source AS price_source,
            latest.source_url AS price_source_url,
            (
                SELECT json_agg(h ORDER BY h.recorded_at ASC) FROM (
                    SELECT price, recorded_at FROM price_history
                    WHERE card_id = pc.id
                    ORDER BY recorded_at DESC LIMIT 30
                ) h
            ) as price_history,
            (
                SELECT json_agg(c ORDER BY c.id ASC) FROM (
                    SELECT id, condition, grade, grader, manual_value, acquired_price,
                           acquired_at, notes, (image_data <> '') AS has_photo
                    FROM card_copies WHERE card_id = pc.id
                ) c
            ) as copies
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
    `, [userId]);

    return res.rows.map(decorateCardRow).sort((a, b) => b.total_value - a.total_value);
}

/**
 * Attach the derived numbers the UI needs. Value is summed per physical copy so
 * three Lightly Played copies are not valued as three Near Mint ones.
 */
function decorateCardRow(row) {
    const copies = Array.isArray(row.copies) && row.copies.length
        ? row.copies
        // Defensive: a card should always have at least one copy after migration,
        // but never report a card Jack owns as owning zero of it.
        : [{ id: null, condition: row.condition || 'Unknown', grade: '', manual_value: 0, synthetic: true }];

    const unitPrice = Number(row.current_price ?? row.card_current_price ?? 0) || 0;
    const perCopy = copies.map(c => ({ ...c, value: Number(copyValue(unitPrice, c).toFixed(2)) }));
    const totalValue = perCopy.reduce((sum, c) => sum + c.value, 0);

    return {
        ...row,
        copies: perCopy,
        quantity: perCopy.length,
        unit_price: unitPrice,
        total_value: Number(totalValue.toFixed(2)),
        has_mixed_conditions: new Set(perCopy.map(c => c.condition || 'Unknown')).size > 1,
    };
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

/**
 * Portfolio totals derived from the same decorated rows the UI renders, so the
 * header total can never disagree with the sum of the list. Counts distinguish
 * unique printings from physical cards held.
 */
function computePortfolioStats(cards) {
    let totalValue = 0;
    let prevValue = 0;
    let totalCopies = 0;
    let unpriced = 0;
    let needsReview = 0;
    let acquiredCost = 0;

    for (const card of cards) {
        totalValue += card.total_value;
        totalCopies += card.quantity;
        if (!(card.unit_price > 0)) unpriced += card.quantity;
        if (card.needs_review) needsReview++;

        // Yesterday's value at today's holdings, so a change figure reflects the
        // market moving rather than Jack adding cards.
        const prevUnit = Number(card.prev_day_price || 0);
        prevValue += prevUnit > 0
            ? card.copies.reduce((sum, c) => sum + copyValue(prevUnit, c), 0)
            : card.total_value;

        acquiredCost += card.copies.reduce((sum, c) => sum + (Number(c.acquired_price) || 0), 0);
    }

    return {
        totalCards: cards.length,
        totalCopies,
        duplicateCards: cards.filter(c => c.quantity > 1).length,
        unpricedCopies: unpriced,
        needsReview,
        totalValue: Number(totalValue.toFixed(2)),
        prevValue: Number(prevValue.toFixed(2)),
        acquiredCost: Number(acquiredCost.toFixed(2)),
    };
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
        // Pricing is deliberately NOT taken from this candidate. It runs through
        // lookupMarketPrice so a scanned card and a refreshed card are priced by
        // exactly the same rules.
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
const PRICE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

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
//  PRICE RESOLUTION
//
//  Every source below is queried in parallel and returns "quotes". A quote is
//  one marketplace's opinion in its own currency. lib/pricing.js normalises,
//  filters and reduces them to a single USD Near Mint price plus the evidence
//  behind it. Nothing here is allowed to invent a price: if no source answers,
//  the card stays unpriced and says so.
// ═══════════════════════════════════════════════════════════════

/** Cache key must include the printing — a reverse holo is not a holo. */
function priceCacheKey(card) {
    return buildVariantKey(card);
}

async function collectPokemonTcgQuotes(card, ctx) {
    const candidates = await fetchPokemonTcgCandidates(card);
    if (!candidates.length) return [];
    const { bestCandidate } = pickBestPokemonCardCandidate(card, candidates);
    if (!bestCandidate) return [];
    return quotesFromPokemonTcgCandidate(bestCandidate, ctx);
}

async function collectTcgdexQuotes(card, ctx) {
    const tcgdexCard = await fetchTCGdexCard(card.card_name, card.card_set, card.card_number);
    return quotesFromTcgdexCard(tcgdexCard, ctx);
}

async function collectScrydexQuotes(card, ctx) {
    if (!SCRYDEX_API_KEY || !SCRYDEX_TEAM_ID) return [];
    const scrydexCard = await fetchScrydexCard(card.card_name, card.card_set, card.card_number);
    if (!scrydexCard) return [];
    // Scrydex mirrors the TCGplayer/Cardmarket shapes, so the same extractors apply.
    return quotesFromPokemonTcgCandidate(scrydexCard, ctx)
        .map(q => ({ ...q, source: q.source.replace('pokemontcg', 'scrydex') }));
}

async function collectJustTcgQuotes(card) {
    const result = await fetchJustTCGPrice(card.card_name, card.card_set, card.card_number);
    if (!result?.price) return [];
    return [{
        price: result.price,
        currency: 'USD',
        marketplace: 'tcgplayer',
        source: 'justtcg_tcgplayer',
        variant: result.printing || 'NM',
        // JustTCG is queried at Near Mint but not per-printing, so it is a
        // marketplace-level quote rather than a variant-exact one.
        variantMatched: false,
        url: result.url || '',
    }];
}

async function lookupMarketPrice(card) {
    if (!card?.card_name) return null;

    const key = priceCacheKey(card);
    const cached = priceCache.get(key);
    if (cached && Date.now() - cached.ts < PRICE_CACHE_TTL_MS) {
        const { ts, ...rest } = cached;
        return { ...rest, cached: true };
    }

    const ctx = priceContextFor(card);

    const collectors = [
        ['pokemontcg', () => collectPokemonTcgQuotes(card, ctx)],
        ['tcgdex', () => collectTcgdexQuotes(card, ctx)],
        ['scrydex', () => collectScrydexQuotes(card, ctx)],
        ['justtcg', () => collectJustTcgQuotes(card)],
    ];

    const settled = await Promise.allSettled(collectors.map(async ([name, run]) => {
        try {
            return await run();
        } catch (err) {
            console.error(`  [Pricing] ${name} failed for "${card.card_name}":`, err.message);
            return [];
        }
    }));

    const quotes = settled.flatMap(r => (r.status === 'fulfilled' ? r.value : []));
    const result = await aggregateQuotes(quotes, { axios });

    if (!result) {
        console.log(`  [Pricing] No usable quote for "${card.card_name}" (${quotes.length} raw quotes)`);
        const empty = {
            price: 0,
            source: 'not_found',
            url: '',
            confidence: 0,
            allSourcePrices: {},
            quotesSeen: quotes.length,
            quotesUsed: 0,
        };
        priceCache.set(key, { ...empty, ts: Date.now() });
        return empty;
    }

    console.log(
        `  [Pricing] "${card.card_name}" ${ctx.printing}${ctx.isFirstEdition ? '/1st' : ''} → ` +
        `$${result.price.toFixed(2)} via ${result.source} ` +
        `(${result.quotesUsed}/${result.quotesSeen} quotes, confidence ${result.confidence})`
    );

    priceCache.set(key, { ...result, ts: Date.now() });
    return result;
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
            WHERE COALESCE(needs_review, 0) = 0
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
                if (result && result.price > 0) {
                    await insertPricePoint(card.id, result.price, result.source || 'market', result.url || '');
                    await updatePortfolioCardMarketData(card.id, result);
                    updated++;
                } else {
                    // Still mark as checked so we don't re-check endlessly
                    await markPriceChecked(card.id);
                }
            } catch (err) {
                console.error(`  [PriceRefresh] Error for ${card.card_name}:`, err.message);
                await markPriceChecked(card.id);
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

    // The flag must be cleared even if the query below throws, or every later
    // refresh silently short-circuits until the process restarts.
    try {
        const res = await pool.query(`
            SELECT id, card_name, card_set, card_number, rarity, condition, is_holo, is_first_edition, confidence, image_url, year, language, holo_type, current_price
            FROM portfolio_cards
            WHERE COALESCE(needs_review, 0) = 0
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
                    await markPriceChecked(card.id);
                }
                if (!result?.cached) await sleep(1200);
            } catch (err) {
                console.error(`  [PriceRefresh] Error for ${card.card_name}:`, err.message);
                await markPriceChecked(card.id).catch(() => {});
            }
        }

        console.log(`  [PriceRefresh] Complete. Updated ${updated}/${cards.length} cards.`);
        broadcastActivity('refresh_complete', `Updated prices for ${updated} cards`);
        broadcast({ type: 'portfolio_updated' });
        return { updated, total: cards.length };
    } finally {
        priceRefreshRunning = false;
    }
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
        const stats = computePortfolioStats(cards);
        res.json({ cards, stats, pricing: { fx: fxStatus(), conditions: CONDITIONS } });
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

/**
 * Correct a card's identity and immediately re-price it.
 *
 * Editing printing fields (holo type, 1st edition, language) matters as much as
 * the name: they are what selects the price bucket. The previous version called
 * updatePortfolioCardMarketData with an empty object, which zeroed the price
 * instead of refreshing it.
 */
app.post('/api/portfolio/:id/edit', requireAuth, express.json(), async (req, res) => {
    const cardId = parseInt(req.params.id, 10);
    try {
        const current = await pool.query('SELECT * FROM portfolio_cards WHERE id = $1 AND user_id = $2', [cardId, req.user.id]);
        if (!current.rows.length) return res.status(404).json({ error: 'Card not found' });
        const before = current.rows[0];

        const merged = {
            card_name: req.body.card_name ?? before.card_name,
            card_set: req.body.card_set ?? before.card_set,
            card_number: req.body.card_number ?? before.card_number,
            holo_type: req.body.holo_type ?? before.holo_type,
            language: req.body.language ?? before.language,
            rarity: req.body.rarity ?? before.rarity,
            is_first_edition: req.body.is_first_edition !== undefined
                ? (req.body.is_first_edition ? 1 : 0)
                : before.is_first_edition,
            is_holo: req.body.is_holo !== undefined ? (req.body.is_holo ? 1 : 0) : before.is_holo,
        };
        const variantKey = buildVariantKey(merged);
        const identityChanged = variantKey !== before.variant_key;

        await pool.query(`
            UPDATE portfolio_cards
            SET card_name = $2, card_set = $3, card_number = $4, holo_type = $5,
                language = $6, rarity = $7, is_first_edition = $8, is_holo = $9,
                variant_key = $10, needs_review = 0, last_price_check = NULL
            WHERE id = $1 AND user_id = $11
        `, [
            cardId, merged.card_name, merged.card_set, merged.card_number, merged.holo_type,
            merged.language, merged.rarity, merged.is_first_edition, merged.is_holo,
            variantKey, req.user.id,
        ]);

        // Price history belongs to the old printing; keep it only if the
        // identity is unchanged (e.g. a typo fix in the set name).
        if (identityChanged) {
            await pool.query('DELETE FROM price_history WHERE card_id = $1', [cardId]);
        }

        const market = await lookupMarketPrice(merged);
        if (market && market.price > 0) {
            await insertPricePoint(cardId, market.price, market.source, market.url || '');
            await updatePortfolioCardMarketData(cardId, market);
        } else {
            await markPriceChecked(cardId);
        }

        broadcast({ type: 'portfolio_updated' });
        res.json({
            success: true,
            identityChanged,
            price: market?.price || 0,
            source: market?.source || 'not_found',
            confidence: market?.confidence || 0,
        });
    } catch (err) {
        console.error('Edit error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ── Copies (duplicates) ──

app.get('/api/portfolio/:id/copies', requireAuth, async (req, res) => {
    try {
        res.json({ copies: await getCardCopies(parseInt(req.params.id, 10)) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/** Record another physical copy of a card already held. */
app.post('/api/portfolio/:id/copies', requireAuth, express.json(), async (req, res) => {
    const cardId = parseInt(req.params.id, 10);
    try {
        const owned = await pool.query('SELECT id FROM portfolio_cards WHERE id = $1 AND user_id = $2', [cardId, req.user.id]);
        if (!owned.rows.length) return res.status(404).json({ error: 'Card not found' });

        await addCardCopy(cardId, req.body || {});
        const copies = await getCardCopies(cardId);
        broadcast({ type: 'portfolio_updated' });
        res.json({ success: true, copies, quantity: copies.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.patch('/api/portfolio/copies/:copyId', requireAuth, express.json(), async (req, res) => {
    const copyId = parseInt(req.params.copyId, 10);
    try {
        const owned = await pool.query(
            `SELECT cc.id, cc.card_id FROM card_copies cc
             JOIN portfolio_cards pc ON pc.id = cc.card_id
             WHERE cc.id = $1 AND pc.user_id = $2`,
            [copyId, req.user.id]
        );
        if (!owned.rows.length) return res.status(404).json({ error: 'Copy not found' });

        const b = req.body || {};
        await pool.query(`
            UPDATE card_copies
            SET condition      = COALESCE($2, condition),
                grade          = COALESCE($3, grade),
                grader         = COALESCE($4, grader),
                manual_value   = COALESCE($5, manual_value),
                acquired_price = COALESCE($6, acquired_price),
                notes          = COALESCE($7, notes)
            WHERE id = $1
        `, [
            copyId,
            b.condition !== undefined ? canonicalCondition(b.condition) : null,
            b.grade !== undefined ? String(b.grade) : null,
            b.grader !== undefined ? String(b.grader) : null,
            b.manual_value !== undefined ? Number(b.manual_value) || 0 : null,
            b.acquired_price !== undefined ? Number(b.acquired_price) || 0 : null,
            b.notes !== undefined ? String(b.notes) : null,
        ]);

        const copies = await getCardCopies(owned.rows[0].card_id);
        broadcast({ type: 'portfolio_updated' });
        res.json({ success: true, copies, quantity: copies.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * Remove one physical copy. Removing the last copy removes the card itself —
 * owning zero of something is not a holding.
 */
app.delete('/api/portfolio/copies/:copyId', requireAuth, async (req, res) => {
    const copyId = parseInt(req.params.copyId, 10);
    try {
        const owned = await pool.query(
            `SELECT cc.id, cc.card_id FROM card_copies cc
             JOIN portfolio_cards pc ON pc.id = cc.card_id
             WHERE cc.id = $1 AND pc.user_id = $2`,
            [copyId, req.user.id]
        );
        if (!owned.rows.length) return res.status(404).json({ error: 'Copy not found' });
        const cardId = owned.rows[0].card_id;

        await pool.query('DELETE FROM card_copies WHERE id = $1', [copyId]);
        const remaining = await getCardCopies(cardId);
        if (!remaining.length) {
            await deletePortfolioCard(cardId, req.user.id);
        }
        broadcast({ type: 'portfolio_updated' });
        res.json({ success: true, quantity: remaining.length, cardRemoved: remaining.length === 0 });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Duplicate consolidation ──

/**
 * Cards added before the copies model exist as separate rows. This reports what
 * would be merged; nothing is changed until POST /merge-duplicates is called.
 */
app.get('/api/portfolio/duplicates', requireAuth, async (req, res) => {
    try {
        res.json({ groups: await findDuplicateGroups(req.user.id) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/portfolio/merge-duplicates', requireAuth, express.json(), async (req, res) => {
    try {
        if (req.body?.confirm !== true) {
            return res.status(400).json({ error: 'Refusing to merge without confirm:true' });
        }
        const result = await mergeDuplicateGroups(req.user.id, req.body?.variantKeys);
        broadcast({ type: 'portfolio_updated' });
        res.json({ success: true, ...result });
    } catch (err) {
        console.error('Merge error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Manually trigger price refresh
app.post('/api/portfolio/refresh-prices', requireAuth, async (req, res) => {
    try {
        res.json({ success: true, message: 'Refreshing prices…' });
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


/**
 * Turn uploaded photos into portfolio entries.
 *
 * Two behaviours worth calling out:
 *
 * 1. A scan of a card already in the collection adds a *copy*, not a second row.
 *    Jack has duplicates; the collection should say "x3", not list Charizard
 *    three times.
 *
 * 2. A card the TCG database cannot confirm is no longer thrown away. It is
 *    saved with needs_review set and the AI's best guess intact, so a photo you
 *    took never silently vanishes. You confirm or correct it in the app.
 */
async function processPortfolioUpload(files, userId, options = {}) {
    const results = [];
    let totalAdded = 0;

    broadcastActivity('analyzing', `Scanning ${files.length} photo${files.length > 1 ? 's' : ''} with AI...`);

    for (let index = 0; index < files.length; index++) {
        const file = files[index];
        broadcastActivity('analyzing', `Scanning photo ${index + 1} of ${files.length}...`);

        let buffer, analysis, thumbDataUrl = '';
        try {
            buffer = readFileSync(file.path);
            let sendMime = file.mimetype;

            if (!GEMINI_SUPPORTED_TYPES.has(sendMime)) {
                console.log(`  [Vision] Converting ${sendMime} → JPEG for Gemini & Sharp...`);
                const converted = await convertToJpeg(buffer, file.path);
                if (converted) {
                    buffer = converted;
                    sendMime = 'image/jpeg';
                }
            }

            analysis = await analyzeImageBuffer(buffer, sendMime);

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
            results.push({ status: 'error', reason: 'unreadable', message: 'Could not read that image.' });
            continue;
        }

        if (!analysis?.cards?.length || analysis?.is_pokemon_card === false) {
            broadcastActivity('info', `No Pokémon card detected in photo ${index + 1}.`);
            results.push({
                status: 'rejected',
                reason: 'no_card',
                message: 'No Pokémon card found in the frame. Fill more of the frame with the card and avoid glare.',
                image_data: thumbDataUrl,
            });
            continue;
        }

        for (const rawCard of analysis.cards) {
            const verified = await verifyAndCanonicalizeCard(rawCard);
            const card = verified || { ...rawCard, needs_review: true };

            if (!verified) {
                if (!hasMeaningfulCardName(card.card_name)) {
                    results.push({
                        status: 'rejected',
                        reason: 'unreadable_card',
                        message: 'Could not read the card name. Try again with less glare.',
                        image_data: thumbDataUrl,
                    });
                    continue;
                }
                broadcastActivity('info', `Saved "${card.card_name}" for review — could not confirm it in the card database.`);
            }

            const saved = await saveScannedCard(card, {
                userId,
                thumbDataUrl,
                needsReview: !verified,
                forceSeparate: options.forceSeparate === true,
            });

            totalAdded++;
            results.push(saved);
            broadcastActivity('card_added_detail', `${saved.is_new_copy ? '➕' : '✅'} ${saved.card_name}`, saved);
            broadcast({ type: 'card_added' });
        }
    }

    const added = results.filter(r => r.status === 'added');
    broadcastActivity('upload_complete', `Added ${added.length} card${added.length !== 1 ? 's' : ''} to your collection.`);

    return { totalAdded, cards: added, results };
}

/**
 * Persist one identified card: either as a new printing or as another copy of a
 * printing already held.
 */
async function saveScannedCard(card, { userId, thumbDataUrl, needsReview, forceSeparate }) {
    const variantKey = buildVariantKey(card);
    const existing = forceSeparate ? null : await findCardByVariant(variantKey, userId);

    if (existing) {
        const copy = await addCardCopy(existing.id, {
            condition: card.condition_estimate || card.condition,
            image_data: thumbDataUrl,
            notes: card.notes || '',
        });
        const copies = await getCardCopies(existing.id);
        const unitPrice = Number(existing.current_price) || 0;

        return {
            status: 'added',
            is_new_copy: true,
            id: existing.id,
            copy_id: copy.id,
            quantity: copies.length,
            card_name: existing.card_name,
            card_set: existing.card_set,
            card_number: existing.card_number,
            rarity: existing.rarity,
            condition: copy.condition,
            image_url: existing.image_url || '',
            image_data: thumbDataUrl || '',
            current_price: unitPrice,
            unit_price: unitPrice,
            total_value: Number(copies.reduce((sum, c) => sum + copyValue(unitPrice, c), 0).toFixed(2)),
            price_source: existing.price_source || '',
            price_confidence: Number(existing.price_confidence) || 0,
            needs_review: Boolean(existing.needs_review),
            message: `Copy ${copies.length} of ${existing.card_name}`,
        };
    }

    let imageUrl = card.image_url || '';
    try {
        if (!imageUrl) imageUrl = await fetchCardImageFromTCGdex(card.card_name, card.card_set, card.card_number) || '';
        if (!imageUrl) imageUrl = await fetchCardImageFromPokemonTCG(card.card_name, card.card_set, card.card_number) || '';
    } catch { /* the scan photo stands in until a refresh finds artwork */ }

    const cardId = await insertPortfolioCard({
        card_name: card.card_name,
        card_set: card.card_set || '',
        card_number: card.card_number || '',
        rarity: card.rarity || 'Unknown',
        condition: card.condition_estimate || card.condition,
        is_holo: card.is_holographic || card.is_holo || false,
        is_first_edition: card.is_first_edition || false,
        confidence: card.confidence || 0,
        image_data: thumbDataUrl,
        image_url: imageUrl,
        notes: card.notes || '',
        year: card.year || 0,
        language: card.language || 'English',
        holo_type: card.holo_type || 'Unknown',
        needs_review: needsReview,
    }, userId);

    await addCardCopy(cardId, {
        condition: card.condition_estimate || card.condition,
        image_data: thumbDataUrl,
        notes: card.notes || '',
    });

    // Unverified cards are not priced: without a confirmed printing any number
    // would be a guess, and a guessed price is worse than no price.
    let market = null;
    if (!needsReview) {
        try {
            market = await lookupMarketPrice(card);
        } catch (err) {
            console.error(`  [Pricing] Inline lookup failed for ${card.card_name}:`, err.message);
        }
    }

    if (market && market.price > 0) {
        await insertPricePoint(cardId, market.price, market.source, market.url || '');
        await updatePortfolioCardMarketData(cardId, market);
    } else {
        await markPriceChecked(cardId);
    }

    const unitPrice = market?.price || 0;
    const condition = canonicalCondition(card.condition_estimate || card.condition);

    return {
        status: 'added',
        is_new_copy: false,
        id: cardId,
        quantity: 1,
        card_name: card.card_name,
        card_set: card.card_set || '',
        card_number: card.card_number || '',
        rarity: card.rarity || 'Unknown',
        condition,
        is_holo: Boolean(card.is_holographic || card.is_holo),
        is_first_edition: Boolean(card.is_first_edition),
        confidence: card.confidence || 0,
        image_url: imageUrl || '',
        image_data: thumbDataUrl || '',
        current_price: unitPrice,
        unit_price: unitPrice,
        total_value: Number(copyValue(unitPrice, { condition }).toFixed(2)),
        price_source: market?.source || 'unpriced',
        price_source_url: market?.url || '',
        price_confidence: market?.confidence || 0,
        price_marketplace: market?.marketplace || '',
        needs_review: Boolean(needsReview),
        message: needsReview
            ? `Saved "${card.card_name}" for review — not found in the card database`
            : undefined,
    };
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

/**
 * Everything behind a card's price: every quote we received (in its own currency
 * and in USD), which ones were used, and how confident the result is.
 */
app.get('/api/portfolio/:id/prices', requireAuth, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT price_sources, current_price, price_source, price_source_url,
                   price_confidence, price_marketplace, price_variant,
                   price_variant_matched, price_low, price_high, last_price_check
            FROM portfolio_cards WHERE id = $1 AND user_id = $2
        `, [parseInt(req.params.id, 10), req.user.id]);
        if (!result.rows.length) return res.status(404).json({ error: 'Card not found' });
        const card = result.rows[0];
        res.json({
            sources: card.price_sources || {},
            currentPrice: Number(card.current_price) || 0,
            priceSource: card.price_source || '',
            priceSourceUrl: card.price_source_url || '',
            confidence: Number(card.price_confidence) || 0,
            marketplace: card.price_marketplace || '',
            variant: card.price_variant || '',
            variantMatched: Boolean(card.price_variant_matched),
            low: Number(card.price_low) || 0,
            high: Number(card.price_high) || 0,
            checkedAt: card.last_price_check,
            fx: fxStatus(),
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

const PRICE_SOURCES = [
    ['Pokemon TCG API', true, POKEMON_TCG_KEY ? 'key loaded' : 'no key (lower rate limit)'],
    ['TCGdex API', true, 'free, no key required'],
    ['Scrydex API', Boolean(SCRYDEX_API_KEY && SCRYDEX_TEAM_ID), 'set SCRYDEX_API_KEY + SCRYDEX_TEAM_ID'],
    ['JustTCG API', Boolean(JUSTTCG_API_KEY), 'set JUSTTCG_API_KEY'],
];

console.log(`
╔══════════════════════════════════════════════════╗
║  ⚡ Jack's Pokemon Portfolio Tracker              ║
╚══════════════════════════════════════════════════╝
`);
console.log('📊 Price sources (all quotes normalised to USD, Near Mint):');
for (const [name, enabled, note] of PRICE_SOURCES) {
    console.log(`   ${name.padEnd(16)} ${enabled ? '✅' : '⚠️ '} ${note}`);
}
const liveSources = PRICE_SOURCES.filter(([, enabled]) => enabled).length;
if (liveSources < 2) {
    console.log('   ⚠️  Only one price source is live — prices will have low confidence.');
}

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
