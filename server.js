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
import { createHash } from 'crypto';
import { tmpdir } from 'os';
import pkg from 'pg';
const { Pool } = pkg;
import bcrypt from 'bcrypt';
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
import { auditHistoryRows } from './lib/history.js';
import {
    quotesFromPokemonTcgCandidate,
    quotesFromTcgdexCard,
    aggregateQuotes,
    priceContextFor,
    fxStatus,
    getUsdPerEur,
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

        -- Records one-time migrations so they cannot run twice.
        CREATE TABLE IF NOT EXISTS app_meta (
            key TEXT PRIMARY KEY,
            value TEXT DEFAULT '',
            applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `);

    await backfillVariantKeys();
    await backfillCardCopies();
    await queueLegacyPricesForRecheck();
}

async function hasRun(key) {
    const res = await pool.query('SELECT 1 FROM app_meta WHERE key = $1', [key]);
    return res.rows.length > 0;
}

async function markRun(key, value = '') {
    await pool.query(
        'INSERT INTO app_meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING',
        [key, String(value)]
    );
}

/**
 * Cards priced by the old pipeline carry a price but no provenance — no
 * confidence, no marketplace, no record of which printing was used. They are
 * not wrong so much as unverified, and the UI cannot tell the difference.
 *
 * Clearing last_price_check puts them at the front of the refresh queue so the
 * current engine re-prices them and fills in the evidence. Guarded by app_meta
 * because a card that genuinely cannot be priced would otherwise be re-queued
 * on every boot forever.
 */
async function queueLegacyPricesForRecheck() {
    const KEY = 'requeue_unverified_prices_v1';
    if (await hasRun(KEY)) return;

    const res = await pool.query(`
        UPDATE portfolio_cards
        SET last_price_check = NULL
        WHERE COALESCE(price_confidence, 0) = 0
          AND COALESCE(current_price, 0) > 0
    `);
    await markRun(KEY, res.rowCount);
    if (res.rowCount) {
        console.log(`  [Migrate] Queued ${res.rowCount} card(s) priced by the old engine for re-pricing`);
    }
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

// ── Fabricated price history ───────────────────────────────────────────────

/** See lib/history.js for how generated points are told apart from real ones. */
async function auditSyntheticHistory() {
    const res = await pool.query(`
        SELECT ph.id, ph.card_id, ph.recorded_at, pc.card_name
        FROM price_history ph
        JOIN portfolio_cards pc ON pc.id = ph.card_id
        ORDER BY ph.card_id, ph.recorded_at ASC
    `);
    return auditHistoryRows(res.rows);
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
    let unverified = 0;

    for (const card of cards) {
        totalValue += card.total_value;
        totalCopies += card.quantity;
        if (!(card.unit_price > 0)) unpriced += card.quantity;
        if (card.needs_review) needsReview++;
        // Priced, but by the old engine — no confidence or source was recorded.
        if (card.unit_price > 0 && !(Number(card.price_confidence) > 0)) unverified++;

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
        unverifiedPrices: unverified,
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

/**
 * @param {boolean} [strict] rethrow transport failures instead of returning
 *   null. A pricing lookup has to be able to tell "TCGdex has no listing for
 *   this card" from "TCGdex never answered"; an image lookup does not care.
 */
async function fetchTCGdexCard(cardName, cardSet, cardNumber, strict = false) {
    if (!cardName) return null;
    try {
        const searchName = encodeURIComponent(cardName.trim());
        const resp = await axios.get(`https://api.tcgdex.net/v2/en/cards?name=${searchName}`, {
            timeout: 10000,
            headers: { 'Accept': 'application/json' }
        });
        noteSource('tcgdex', { ok: true, status: resp.status, message: 'OK' });
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
        const failure = describeAxiosError(err);
        noteSource('tcgdex', failure);
        console.error(`  [TCGdex] Error looking up market card "${cardName}": ${failure.message}`);
        if (strict) throw err;
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

/**
 * The model identifies the card; it never prices it. Prices come from the market
 * APIs, because a language model asked for a dollar value will confidently
 * produce a plausible wrong one.
 *
 * The fields that matter most for pricing are the card number and the printing
 * (holo type / 1st edition), since those select the price bucket — hence the
 * emphasis on reading them off the card rather than inferring them.
 */
const CARD_ID_PROMPT = `You are an expert Pokemon TCG card identifier. Identify every physical Pokemon card visible in this image.

Read these directly off the card. Do not infer them from the artwork or from what is typical:
- Card name exactly as printed, including suffixes such as EX, GX, V, VMAX, VSTAR, ex.
- Card number, bottom of the card, exactly as printed (e.g. "4/102", "SWSH045", "TG12/TG30").
- Set: use the set symbol and the number's denominator. If you cannot identify the set with confidence, use "".
- Printing. This is critical and is decided by the foil pattern:
  * "Reverse Holo" - the card BORDER/background is foiled but the artwork is not.
  * "Holofoil" - the ARTWORK BOX is foiled.
  * "Cosmos Holo" - starry/cosmos foil pattern.
  * "Non-Holo" - no foil anywhere.
  If the foil pattern is not clearly visible, use "Unknown" rather than guessing.
- 1st Edition: true ONLY if the "1st Edition" stamp is actually visible on the card.
- Language, from the printed text. Copyright year, from the bottom of the card.
- Condition, from visible edge wear, surface scratches, whitening and centering.

Rules:
- Never invent a name, set or number. An empty string is always better than a guess.
- Ignore binder pages, sleeves, pack art, background objects and anything that is not a physical card.
- If a card is blurry, cropped, or obstructed, either omit it or give it a low confidence.
- Confidence reflects how clearly you could READ the card, not how sure you are the card exists.
- Do not estimate any monetary value. Prices are looked up separately.

Return ONLY valid JSON (no markdown fences):
{
  "cards": [{
    "card_name": "Pokemon name",
    "card_set": "Set name or empty string",
    "card_number": "e.g. 4/102",
    "rarity": "Common|Uncommon|Rare|Rare Holo|Rare Ultra|Secret Rare|Illustration Rare|Promo|Unknown",
    "condition_estimate": "Mint|Near Mint|Lightly Played|Moderately Played|Heavily Played|Damaged|Unknown",
    "is_holographic": true/false,
    "holo_type": "Holofoil|Reverse Holo|Non-Holo|Cosmos Holo|Unknown",
    "year": 1999,
    "language": "English|Japanese|Spanish|etc",
    "is_first_edition": true/false,
    "confidence": 0.0 to 1.0,
    "notes": "Identifying features, visible damage, or what was unreadable"
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

/**
 * Health of each external source, so a failure can be reported as what it
 * actually is. Without this, a rate limit, an outage and "this card genuinely
 * isn't in the database" all surfaced identically as "no card detected".
 */
const sourceHealth = new Map();

function noteSource(name, outcome) {
    sourceHealth.set(name, { ...outcome, at: new Date().toISOString() });
}

function describeAxiosError(err) {
    const status = err?.response?.status;
    if (status === 429) return { ok: false, status, kind: 'rate_limited', message: 'Rate limited' };
    if (status === 401 || status === 403) return { ok: false, status, kind: 'auth', message: 'Rejected — check the API key' };
    if (status) return { ok: false, status, kind: 'http', message: `HTTP ${status}` };
    if (err?.code === 'ECONNABORTED' || /timeout/i.test(err?.message || '')) return { ok: false, kind: 'timeout', message: 'Timed out' };
    return { ok: false, kind: 'network', message: err?.message || 'Unreachable' };
}

/**
 * A collector that cannot reach its source must say so rather than return an
 * empty list. Silently treating an outage as "this card has no listings" is
 * what made "Re-price" report `not_found` while every source was blocked —
 * indistinguishable, to the person holding the card, from doing nothing.
 */
class SourceUnavailable extends Error {
    constructor(failure) {
        super(failure.message);
        this.failure = failure;
    }
}

export function sourceHealthSnapshot() {
    return Object.fromEntries(sourceHealth);
}

/**
 * How long to stop calling a source that has just told us to back off.
 *
 * The keyless tier of the Pokémon TCG API rate limits hard, and once it starts
 * returning 429 every further request extends the penalty. Verifying a scanned
 * card and then pricing it both consult that API, so without this a rate limit
 * hit twice per card and stayed hit — which is what made card analysis appear
 * to be simply broken.
 */
const COOLDOWN_MS = { rate_limited: 60 * 1000, auth: 5 * 60 * 1000 };

/** How much longer this source is being left alone, in ms. 0 if it is fine. */
function sourceCooldownRemaining(name) {
    const health = sourceHealth.get(name);
    if (!health || health.ok) return 0;
    const window = COOLDOWN_MS[health.kind];
    if (!window) return 0;
    return Math.max(0, window - (Date.now() - new Date(health.at).getTime()));
}

/**
 * Candidate lookups are memoised briefly. Identifying a scanned card and then
 * pricing it both need the same candidates, and without this they each ran the
 * query set again — doubling the API calls for no new information.
 */
const candidateCache = new Map();
const CANDIDATE_TTL_MS = 10 * 60 * 1000;

/** Why the most recent candidate lookup for a card came back empty, if it did. */
const lastCandidateErrors = new Map();

async function fetchPokemonTcgCandidates(card) {
    if (!hasMeaningfulCardName(card.card_name)) return [];

    const cacheKey = buildVariantKey(card);
    const cached = candidateCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < CANDIDATE_TTL_MS) return cached.candidates;

    // Asking again inside the cooldown cannot succeed and only deepens the
    // penalty, so record why we did not ask and return.
    const cooling = sourceCooldownRemaining('pokemontcg');
    if (cooling > 0) {
        const health = sourceHealth.get('pokemontcg');
        lastCandidateErrors.set(cacheKey, {
            ...health,
            message: `${health.message} — waiting ${Math.ceil(cooling / 1000)}s before asking again`,
        });
        return [];
    }

    const headers = { 'Accept': 'application/json' };
    if (POKEMON_TCG_KEY) headers['X-Api-Key'] = POKEMON_TCG_KEY;

    const safeName = String(card.card_name || '').replace(/"/g, '\\"').trim();
    const safeSet = String(card.card_set || '').replace(/"/g, '\\"').trim();
    const normalizedNumber = normalizeCardNumber(card.card_number);

    // Most specific first. The loop below stops at the first query that answers,
    // rather than always running all four — the keyless tier of this API is
    // rate limited, and four queries per card multiplied across a collection is
    // what exhausted it and made every lookup fail.
    const queries = [];
    if (safeName && safeSet && normalizedNumber) queries.push(`name:"${safeName}" set.name:"${safeSet}" number:"${normalizedNumber}"`);
    if (safeName && normalizedNumber) queries.push(`name:"${safeName}" number:"${normalizedNumber}"`);
    if (safeName && safeSet) queries.push(`name:"${safeName}" set.name:"${safeSet}"`);
    if (safeName) queries.push(`name:"${safeName}"`);

    const unique = new Map();
    let lastError = null;

    for (const q of queries) {
        try {
            const resp = await axios.get('https://api.pokemontcg.io/v2/cards', {
                params: { q, pageSize: 15 },
                headers,
                timeout: 12000,
            });
            const results = resp.data?.data || [];
            for (const result of results) {
                if (result?.id && !unique.has(result.id)) unique.set(result.id, result);
            }
            noteSource('pokemontcg', { ok: true, status: resp.status, message: 'OK' });
            // A query that returned anything has told us what we needed.
            if (unique.size) break;
        } catch (err) {
            lastError = describeAxiosError(err);
            noteSource('pokemontcg', lastError);
            console.error(`  [PokemonTCG] "${card.card_name}" (${q}): ${lastError.message}`);
            // No point trying three more variations of a rate-limited request.
            if (lastError.kind === 'rate_limited' || lastError.kind === 'auth') break;
        }
    }

    const candidates = Array.from(unique.values());
    // A failed lookup is not a fact about the card, so it is never remembered:
    // caching "nothing found" after a rate limit is what made a later re-price
    // fail instantly and silently for the next ten minutes.
    if (candidates.length || !lastError) {
        candidateCache.set(cacheKey, { candidates, ts: Date.now(), error: null });
    }
    lastCandidateErrors.set(cacheKey, lastError);
    return candidates;
}

function candidateLookupError(card) {
    return lastCandidateErrors.get(buildVariantKey(card)) || null;
}

/** Drop any memoised candidates for a card, so the next lookup really goes out. */
function forgetCandidates(card) {
    candidateCache.delete(buildVariantKey(card));
    lastCandidateErrors.delete(buildVariantKey(card));
}

/** Whether the card database is currently answering at all. */
function cardDatabaseReachable() {
    const health = sourceHealth.get('pokemontcg');
    return !health || health.ok === true;
}

/**
 * @param {(stage:string, payload?:object) => void} [report] scan progress sink
 * @returns {object|null} the canonical card, or null with a reason reported
 */
async function verifyAndCanonicalizeCard(card, report = () => {}) {
    if (!card || !hasMeaningfulCardName(card.card_name)) {
        report('verify_failed', { reason: 'unreadable_name', message: 'Could not make out the card name.' });
        return null;
    }
    if (analysisLooksTooWeak(card)) {
        report('verify_failed', { reason: 'weak_read', message: 'The set and number were not legible enough to confirm the printing.' });
        return null;
    }

    const candidates = await fetchPokemonTcgCandidates(card);
    if (!candidates.length) {
        const failure = candidateLookupError(card);
        report('verify_failed', failure
            ? { reason: `database_${failure.kind}`, message: `The card database could not answer — ${failure.message}.` }
            : { reason: 'no_match', message: 'No card in the database matched that name, set and number.' });
        return null;
    }
    report('candidates', { count: candidates.length });

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
        report('verify_failed', {
            reason: 'ambiguous',
            message: `${sameNameCandidates.length} printings share that name — the set or number is needed to tell them apart.`,
        });
        return null;
    }

    const { bestCandidate, bestScore } = pickBestPokemonCardCandidate(card, candidates);

    if (!bestCandidate || !isLikelyVerifiedMatch(bestScore, bestCandidate, card)) {
        report('verify_failed', {
            reason: 'low_match',
            message: 'The closest database match was not close enough to trust.',
        });
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

/**
 * Classify a recognition failure. The Gemini SDK throws plain Errors rather
 * than HTTP errors, so the status has to be read out of the message — but a
 * quota error and an unreachable network are different problems for the person
 * holding the card, and reporting both as "no card found" sent them off
 * re-photographing a card that was never the issue.
 */
function describeAiError(err) {
    const message = String(err?.message || 'Unknown error');
    if (/\b429\b|quota|rate.?limit|RESOURCE_EXHAUSTED/i.test(message)) {
        return { kind: 'rate_limited', message: 'Card recognition has hit its rate limit. Wait a minute and scan again.' };
    }
    if (/\b40[13]\b|API.?key|PERMISSION_DENIED|UNAUTHENTICATED/i.test(message)) {
        return { kind: 'auth', message: 'Card recognition rejected our API key — it needs to be renewed in the server settings.' };
    }
    if (/\b50\d\b|UNAVAILABLE|overloaded/i.test(message)) {
        return { kind: 'upstream', message: 'Card recognition is temporarily overloaded. Try again in a moment.' };
    }
    if (/timeout|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNRESET|fetch failed|network/i.test(message)) {
        return { kind: 'network', message: 'Could not reach the card recognition service.' };
    }
    if (/SAFETY|blocked/i.test(message)) {
        return { kind: 'blocked', message: 'Card recognition refused to read that image.' };
    }
    return { kind: 'error', message: message.slice(0, 240) };
}

/**
 * @returns {{ok:true, analysis:object} | {ok:false, kind:string, message:string}}
 * Never null: the caller has to be able to tell "the AI saw no card" from
 * "the AI never answered".
 */
async function analyzeImageBuffer(buffer, mimeType) {
    if (!geminiModel) {
        noteSource('gemini', { ok: false, kind: 'not_configured', message: 'GEMINI_API_KEY is not set' });
        return {
            ok: false,
            kind: 'not_configured',
            message: 'Card recognition is not switched on for this server — GEMINI_API_KEY is missing.',
        };
    }
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
        const analysis = parseAiJson(text);
        if (!analysis) {
            noteSource('gemini', { ok: false, kind: 'unparseable', message: 'Reply was not valid JSON' });
            return { ok: false, kind: 'unparseable', message: 'Card recognition returned something unreadable. Try that photo again.' };
        }
        noteSource('gemini', { ok: true, message: 'OK' });
        return { ok: true, analysis };
    } catch (err) {
        const failure = describeAiError(err);
        noteSource('gemini', { ok: false, ...failure });
        console.error(`  [Vision Analysis] ${failure.kind}: ${err.message}`);
        return { ok: false, ...failure };
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
            const failure = describeAxiosError(err2);
            noteSource('scrydex', failure);
            console.error(`  [Scrydex] Error for "${cardName}": ${failure.message}`);
            throw new SourceUnavailable(failure);
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
        const failure = describeAxiosError(err);
        noteSource('justtcg', failure);
        console.error(`  [JustTCG] Error for "${cardName}": ${failure.message}`);
        throw new SourceUnavailable(failure);
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
    if (!candidates.length) {
        // fetchPokemonTcgCandidates handles its own retries, so the error it
        // recorded is the only evidence left that the request went wrong.
        const failure = candidateLookupError(card);
        if (failure) throw new SourceUnavailable(failure);
        return [];
    }
    const { bestCandidate } = pickBestPokemonCardCandidate(card, candidates);
    if (!bestCandidate) return [];
    return quotesFromPokemonTcgCandidate(bestCandidate, ctx);
}

async function collectTcgdexQuotes(card, ctx) {
    const tcgdexCard = await fetchTCGdexCard(card.card_name, card.card_set, card.card_number, true);
    return quotesFromTcgdexCard(tcgdexCard, ctx);
}

async function collectScrydexQuotes(card, ctx) {
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

/** Human labels for the price sources, for anything the app shows a person. */
const PRICE_SOURCE_LABELS = {
    pokemontcg: 'Pokémon TCG API (TCGplayer + Cardmarket)',
    tcgdex: 'TCGdex',
    scrydex: 'Scrydex',
    justtcg: 'JustTCG',
};

/**
 * Resolve one card's market price.
 *
 * `onSource` is called as each source is asked and again as it answers, so a
 * scan or a re-price can show which marketplaces are being consulted instead of
 * a spinner. The returned object carries the same information as `sources`, so
 * a caller that only wants the outcome does not have to listen.
 */
async function lookupMarketPrice(card, { onSource, fresh = false } = {}) {
    if (!card?.card_name) return null;

    const key = priceCacheKey(card);
    if (fresh) {
        priceCache.delete(key);
        forgetCandidates(card);
    }
    const cached = priceCache.get(key);
    if (cached && Date.now() - cached.ts < PRICE_CACHE_TTL_MS) {
        const { ts, ...rest } = cached;
        return { ...rest, cached: true };
    }

    const ctx = priceContextFor(card);

    const collectors = [
        { name: 'pokemontcg', configured: true, run: () => collectPokemonTcgQuotes(card, ctx) },
        { name: 'tcgdex', configured: true, run: () => collectTcgdexQuotes(card, ctx) },
        { name: 'scrydex', configured: Boolean(SCRYDEX_API_KEY && SCRYDEX_TEAM_ID), run: () => collectScrydexQuotes(card, ctx) },
        { name: 'justtcg', configured: Boolean(JUSTTCG_API_KEY), run: () => collectJustTcgQuotes(card) },
    ];

    const sources = [];
    const report = (entry) => {
        sources.push(entry);
        try { onSource?.(entry); } catch { /* a listener must never break a lookup */ }
    };

    for (const { name, configured } of collectors) {
        try { onSource?.({ name, label: PRICE_SOURCE_LABELS[name] || name, state: configured ? 'asking' : 'skipped', reason: configured ? '' : 'no API key' }); }
        catch { /* ignore */ }
    }

    const settled = await Promise.allSettled(collectors.map(async ({ name, configured, run }) => {
        const label = PRICE_SOURCE_LABELS[name] || name;
        if (!configured) {
            report({ name, label, state: 'skipped', quotes: 0, reason: 'no API key' });
            return [];
        }
        const startedAt = Date.now();
        try {
            const quotes = await run();
            report({ name, label, state: quotes.length ? 'answered' : 'empty', quotes: quotes.length, ms: Date.now() - startedAt });
            return quotes;
        } catch (err) {
            const failure = err instanceof SourceUnavailable ? err.failure : describeAxiosError(err);
            noteSource(name, failure);
            report({ name, label, state: 'failed', quotes: 0, ms: Date.now() - startedAt, reason: failure.message, kind: failure.kind });
            console.error(`  [Pricing] ${name} failed for "${card.card_name}":`, err.message);
            return [];
        }
    }));

    const quotes = settled.flatMap(r => (r.status === 'fulfilled' ? r.value : []));
    const result = await aggregateQuotes(quotes, { axios });
    const asked = sources.filter(s => s.state !== 'skipped');
    const allAskedFailed = asked.length > 0 && asked.every(s => s.state === 'failed');

    if (!result) {
        console.log(`  [Pricing] No usable quote for "${card.card_name}" (${quotes.length} raw quotes)`);
        const empty = {
            price: 0,
            source: allAskedFailed ? 'sources_unavailable' : 'not_found',
            url: '',
            confidence: 0,
            allSourcePrices: {},
            quotesSeen: quotes.length,
            quotesUsed: 0,
            sources,
            sourcesUnavailable: allAskedFailed,
        };
        // A price of zero because every source was down is not a fact about the
        // card, so it is not cached — otherwise the next six hours of re-prices
        // would answer instantly with the same nothing.
        if (!allAskedFailed) priceCache.set(key, { ...empty, ts: Date.now() });
        return empty;
    }
    result.sources = sources;
    result.sourcesUnavailable = false;

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

/**
 * Per-scan progress, streamed to whoever started that scan.
 *
 * The scanner used to sit on a live camera preview saying "analysis in
 * progress" with nothing behind it, so a slow card-database lookup was
 * indistinguishable from a hung one. Every stage the server actually goes
 * through is announced instead, including which price sources it is asking and
 * what each one answered — the client tags its upload with a scanId and
 * listens for its own.
 *
 * Returns a no-op when there is no scanId, so callers never have to branch.
 */
function scanReporter(scanId) {
    if (!scanId) return () => {};
    let seq = 0;
    return (stage, payload = {}) => {
        broadcast({ type: 'scan_progress', scanId, seq: ++seq, stage, at: Date.now(), ...payload });
    };
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

                const result = await lookupMarketPrice(card, { fresh: true });
                if (result && result.price > 0) {
                    await insertPricePoint(card.id, result.price, result.source || 'market', result.url || '');
                    await updatePortfolioCardMarketData(card.id, result);
                    updated++;
                } else if (!result?.sourcesUnavailable) {
                    // Mark as checked so we don't re-check endlessly — but not
                    // when the sources were simply unreachable, since then
                    // nothing was actually checked.
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
        let unavailable = 0;

        for (let i = 0; i < cards.length; i++) {
            const card = cards[i];
            try {
                if (!card.image_url || card.image_url.includes('undefined')) {
                    let imageUrl = await fetchCardImageFromTCGdex(card.card_name, card.card_set, card.card_number);
                    if (!imageUrl) imageUrl = await fetchCardImageFromPokemonTCG(card.card_name, card.card_set, card.card_number);
                    if (imageUrl) {
                        await updateCardImageUrl(card.id, imageUrl);
                        console.log(`  [PriceRefresh] Found image for ${card.card_name}`);
                    }
                }

                // `fresh` matters here: the whole point of a refresh is to go
                // out to the marketplaces again, and a warm in-process cache
                // would otherwise turn the run into a no-op.
                const result = await lookupMarketPrice(card, { fresh: true });
                if (result && result.price > 0) {
                    await insertPricePoint(card.id, result.price, result.source || 'market', result.url || '');
                    await updatePortfolioCardMarketData(card.id, result);
                    updated++;
                    broadcastActivity('price_update', `${card.card_name}: $${result.price.toFixed(2)} (${result.source})`);
                } else if (result?.sourcesUnavailable) {
                    // Do NOT mark it checked. A card skipped because every
                    // source was down has not been checked, and recording that
                    // it was sends it to the back of the queue for a day.
                    unavailable++;
                } else {
                    await markPriceChecked(card.id);
                }

                broadcast({
                    type: 'refresh_progress',
                    done: i + 1,
                    total: cards.length,
                    updated,
                    card_name: card.card_name,
                });

                // Every source refusing to answer means the next card will fare
                // no better; hammering them just deepens the rate limit.
                if (unavailable >= 5) {
                    console.error('  [PriceRefresh] Stopping early — no price source is answering.');
                    broadcastActivity('error', 'Stopped refreshing: no price source is answering right now.');
                    break;
                }

                if (!result?.cached) await sleep(1200);
            } catch (err) {
                console.error(`  [PriceRefresh] Error for ${card.card_name}:`, err.message);
                await markPriceChecked(card.id).catch(() => {});
            }
        }

        console.log(`  [PriceRefresh] Complete. Updated ${updated}/${cards.length} cards.`);
        broadcastActivity('refresh_complete',
            unavailable
                ? `Updated ${updated} card${updated === 1 ? '' : 's'}; ${unavailable} could not be reached.`
                : `Updated prices for ${updated} card${updated === 1 ? '' : 's'}`);
        broadcast({ type: 'portfolio_updated' });
        return { updated, total: cards.length, unavailable };
    } finally {
        priceRefreshRunning = false;
    }
}

// ═══════════════════════════════════════════════════════════════
//  SCHEDULED REFRESH
//
//  This used to be a plain setInterval(24h). The timer resets whenever the
//  process restarts, and a host restarts on every deploy — so on an app that
//  gets deployed every day or two, the refresh could go weeks without ever
//  firing. That is the difference between "prices update daily" and "prices
//  are from whenever the card was added".
//
//  Instead: remember when the last refresh finished, check often, and run when
//  it is actually due. A restart cannot lose the schedule.
// ═══════════════════════════════════════════════════════════════

const IS_VERCEL = !!process.env.VERCEL;

/** How often to re-check every card. Days, so it can be tuned without a deploy. */
const REFRESH_EVERY_DAYS = Math.max(0.25, Number(process.env.PRICE_REFRESH_DAYS) || 1);
const REFRESH_EVERY_MS = REFRESH_EVERY_DAYS * 24 * 60 * 60 * 1000;
const SCHEDULER_TICK_MS = 15 * 60 * 1000;
const LAST_REFRESH_KEY = 'last_full_refresh';

async function getLastRefreshAt() {
    try {
        const res = await pool.query('SELECT value FROM app_meta WHERE key = $1', [LAST_REFRESH_KEY]);
        const ts = res.rows[0]?.value ? Number(res.rows[0].value) : 0;
        return Number.isFinite(ts) ? ts : 0;
    } catch {
        return 0;
    }
}

async function setLastRefreshAt(ts) {
    await pool.query(`
        INSERT INTO app_meta (key, value, applied_at) VALUES ($1, $2, NOW())
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, applied_at = NOW()
    `, [LAST_REFRESH_KEY, String(ts)]);
}

export async function refreshSchedule() {
    const last = await getLastRefreshAt();
    const dueAt = last ? last + REFRESH_EVERY_MS : 0;
    return {
        everyDays: REFRESH_EVERY_DAYS,
        lastRefreshAt: last || null,
        nextRefreshAt: dueAt || null,
        overdue: Date.now() >= dueAt,
        running: priceRefreshRunning,
    };
}

async function runScheduledRefreshIfDue() {
    if (priceRefreshRunning) return;
    try {
        const last = await getLastRefreshAt();
        if (last && Date.now() - last < REFRESH_EVERY_MS) return;

        console.log(`  [Schedule] Price refresh is due (every ${REFRESH_EVERY_DAYS} day(s)) — starting.`);
        await refreshAllPrices();
        await setLastRefreshAt(Date.now());
    } catch (err) {
        console.error('  [Schedule] Refresh failed:', err.message);
    }
}

if (!IS_VERCEL) {
    // A short delay on boot so a restart storm does not stampede the APIs.
    setTimeout(() => { runScheduledRefreshIfDue(); }, 60 * 1000);
    setInterval(() => { runScheduledRefreshIfDue(); }, SCHEDULER_TICK_MS);
}

// ═══════════════════════════════════════════════════════════════
//  EXPRESS SERVER
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
//  BUILD IDENTITY
//
//  "Did the deploy actually go out?" should never need a git log to answer.
//  The build id is a hash of the three files the browser is actually served,
//  so it cannot disagree with what is running. It names the service worker's
//  cache, which means a new build automatically discards the old one instead
//  of leaving somebody pinned to a stale copy of the app.
// ═══════════════════════════════════════════════════════════════

function computeBuildId() {
    try {
        const hash = createHash('sha256');
        for (const file of ['index.html', 'script.js', 'styles.css']) {
            hash.update(readFileSync(join(__dirname, file)));
        }
        return hash.digest('hex').slice(0, 8);
    } catch {
        return 'unknown';
    }
}

const BUILD_ID = computeBuildId();
const BUILD_COMMIT = (process.env.RAILWAY_GIT_COMMIT_SHA || process.env.SOURCE_COMMIT || '').slice(0, 7);
const BOOTED_AT = new Date().toISOString();

/**
 * index.html, with its asset URLs stamped with the build id.
 *
 * Without this, a browser can hold a cached script.js from one build while
 * fetching index.html from another — and a half-updated app is worse than an
 * old one, because the old script looks for elements the new markup no longer
 * has and the whole page dies. Versioned URLs make that combination
 * impossible: a given index.html can only ever load the exact pair it shipped
 * with.
 */
function sendIndex(res) {
    try {
        const html = readFileSync(join(__dirname, 'index.html'), 'utf8')
            .replace('href="styles.css"', `href="/styles.css?v=${BUILD_ID}"`)
            .replace('src="script.js"', `src="/script.js?v=${BUILD_ID}"`)
            .replace('</head>', `  <meta name="app-build" content="${BUILD_ID}" />\n</head>`);
        res.setHeader('Content-Type', 'text/html; charset=UTF-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.send(html);
    } catch (err) {
        console.error('Failed to serve index.html:', err.message);
        res.status(500).send('Application unavailable');
    }
}

/** The service worker is served with its cache name stamped to this build. */
function sendServiceWorker(res) {
    try {
        // replaceAll, not replace: the token also appears in the file's own
        // comment, and replacing only the first occurrence would stamp the
        // comment and leave the constant as the literal placeholder.
        const source = readFileSync(join(__dirname, 'sw.js'), 'utf8').replaceAll('__BUILD_ID__', BUILD_ID);
        res.setHeader('Content-Type', 'application/javascript; charset=UTF-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.send(source);
    } catch (err) {
        res.status(500).send('// service worker unavailable');
    }
}

const app = express();
app.use(express.json());
app.use(cookieParser());

/** Cheap, unauthenticated: lets you confirm a deploy landed without logging in. */
app.get('/api/version', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ build: BUILD_ID, commit: BUILD_COMMIT || null, bootedAt: BOOTED_AT });
});

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
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

/**
 * Static assets, by allowlist.
 *
 * The previous `express.static(__dirname)` published the whole project
 * directory — server.js, package.json, lib/ and test/ were all downloadable.
 * Only the files the browser actually needs are served now.
 *
 * The app's own three files are sent with `no-cache`: not "never store", but
 * "always revalidate". A 304 still costs nothing, and it means a deploy is
 * visible on the next load instead of up to an hour later. Icons, which change
 * about never, keep a long cache.
 */
const PUBLIC_FILES = new Set(['/index.html', '/styles.css', '/script.js', '/sw.js', '/manifest.webmanifest']);
const staticHandler = express.static(__dirname, { index: false, dotfiles: 'ignore', maxAge: '1h', etag: true });

app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const isPublic = PUBLIC_FILES.has(req.path) || req.path.startsWith('/icons/');
    if (!isPublic) return next();

    if (req.path === '/sw.js') return sendServiceWorker(res);
    if (req.path === '/index.html') return sendIndex(res);

    // A ?v= URL names one exact build, so it can be cached hard and forever.
    // The same file without one might be anything, so it must be revalidated.
    if (req.path === '/styles.css' || req.path === '/script.js') {
        res.setHeader('Cache-Control', req.query.v ? 'public, max-age=31536000, immutable' : 'no-cache');
    } else if (PUBLIC_FILES.has(req.path)) {
        res.setHeader('Cache-Control', 'no-cache');
    }
    return staticHandler(req, res, next);
});

// No auth — single-user mode (Jack's portfolio)
const DEFAULT_USER_ID = 1;
const requireAuth = (req, res, next) => {
    req.user = { id: DEFAULT_USER_ID, username: 'jack' };
    next();
};

/**
 * Actually call every external dependency and report what happened.
 *
 * "The card analysis isn't working" has half a dozen possible causes that all
 * looked identical from the app: no Gemini key, a rejected key, the card
 * database rate limiting us, a network block. This probes each one and names
 * the failure, so the fix is obvious instead of guessed at.
 */
app.get('/api/diagnostics', requireAuth, async (req, res) => {
    const probe = async (name, label, fn, hint) => {
        const started = Date.now();
        try {
            const detail = await fn();
            return { name, label, ok: true, ms: Date.now() - started, detail };
        } catch (err) {
            const info = describeAxiosError(err);
            return { name, label, ok: false, ms: Date.now() - started, detail: info.message, kind: info.kind, hint };
        }
    };

    const checks = await Promise.all([
        probe('database', 'Collection database', async () => {
            const r = await pool.query('SELECT COUNT(*)::int AS c FROM portfolio_cards');
            return `${r.rows[0].c} cards stored`;
        }, 'Check DATABASE_URL'),

        probe('gemini', 'Card recognition (Gemini)', async () => {
            if (!geminiModel) throw new Error('No GEMINI_API_KEY set — scanning is disabled');
            const result = await geminiModel.generateContent('Reply with the single word: ready');
            const text = (result.response.text() || '').trim().slice(0, 40);
            return text ? `Responding — "${text}"` : 'Responded but returned nothing';
        }, 'Set GEMINI_API_KEY, and check the key is enabled for the Gemini API'),

        probe('pokemontcg', 'Card database (Pokémon TCG API)', async () => {
            const headers = { Accept: 'application/json' };
            if (POKEMON_TCG_KEY) headers['X-Api-Key'] = POKEMON_TCG_KEY;
            const r = await axios.get('https://api.pokemontcg.io/v2/cards', {
                params: { q: 'name:"Charizard" number:"4"', pageSize: 1 }, headers, timeout: 12000,
            });
            const hit = r.data?.data?.[0];
            return hit ? `Found ${hit.name} (${hit.set?.name})${POKEMON_TCG_KEY ? '' : ' — no API key, rate limited'}`
                       : 'Reachable but returned no results';
        }, 'Set POKEMON_TCG_KEY — without one this API rate limits quickly and every lookup fails'),

        probe('tcgdex', 'Card prices (TCGdex)', async () => {
            const r = await axios.get('https://api.tcgdex.net/v2/en/cards', {
                params: { name: 'Charizard' }, timeout: 12000,
            });
            return `${(r.data || []).length} results`;
        }, 'No key needed — a failure here means outbound network is blocked'),

        probe('fx', 'Exchange rate (EUR→USD)', async () => {
            const rate = await getUsdPerEur(axios);
            const status = fxStatus();
            return status.live ? `${rate} USD/EUR (live)` : `${rate} USD/EUR (fallback — live rate unavailable)`;
        }, 'Only affects Cardmarket prices'),
    ]);

    if (SCRYDEX_API_KEY && SCRYDEX_TEAM_ID) {
        checks.push(await probe('scrydex', 'Card prices (Scrydex)', async () => {
            const r = await axios.get('https://api.scrydex.com/pokemon/v1/cards', {
                params: { q: 'name:"Charizard"', pageSize: 1 }, headers: scrydexHeaders(), timeout: 12000,
            });
            return `${(r.data?.data || []).length} results`;
        }, 'Check SCRYDEX_API_KEY and SCRYDEX_TEAM_ID'));
    }
    if (JUSTTCG_API_KEY) {
        checks.push(await probe('justtcg', 'Card prices (JustTCG)', async () => {
            const r = await axios.get('https://api.justtcg.com/v1/cards', {
                params: { q: 'Charizard', game: 'pokemon', limit: 1 },
                headers: { 'x-api-key': JUSTTCG_API_KEY }, timeout: 12000,
            });
            return `${(r.data?.data || []).length} results`;
        }, 'Check JUSTTCG_API_KEY'));
    }

    const scanningWorks = checks.find(c => c.name === 'gemini')?.ok === true;
    const pricingWorks = checks.some(c => ['pokemontcg', 'tcgdex', 'scrydex', 'justtcg'].includes(c.name) && c.ok);

    res.setHeader('Cache-Control', 'no-store');
    res.json({
        build: BUILD_ID,
        checks,
        summary: {
            scanning: scanningWorks ? 'working' : 'broken',
            pricing: pricingWorks ? 'working' : 'broken',
        },
        recentSourceActivity: sourceHealthSnapshot(),
    });
});


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

/**
 * Re-price one card immediately and return the result, so a card showing an
 * unverified price can be fixed on the spot instead of waiting for the next
 * full refresh.
 */
/**
 * Re-price one card, on demand.
 *
 * This used to answer `{success:true, price:0, source:'not_found'}` whether the
 * card was genuinely unlisted, every source was rate limited, or the cached
 * nothing from ten minutes ago was replayed — so "Re-price" looked like it did
 * nothing at all. Now it forces a real lookup and says which it was.
 */
app.post('/api/portfolio/:id/reprice', requireAuth, async (req, res) => {
    const cardId = parseInt(req.params.id, 10);
    try {
        const owned = await pool.query('SELECT * FROM portfolio_cards WHERE id = $1 AND user_id = $2', [cardId, req.user.id]);
        if (!owned.rows.length) return res.status(404).json({ error: 'Card not found' });
        const card = owned.rows[0];
        const previousPrice = Number(card.current_price) || 0;

        // `fresh` clears both the price cache and the candidate memo: the point
        // of asking is to get a new answer, not a fast one.
        const market = await lookupMarketPrice(card, { fresh: true });
        const price = Number(market?.price) || 0;

        if (price > 0) {
            await insertPricePoint(cardId, price, market.source, market.url || '');
            await updatePortfolioCardMarketData(cardId, market);
        } else {
            await markPriceChecked(cardId);
        }

        let delta = Number((price - previousPrice).toFixed(2));
        let status = 'priced';
        let message;

        if (market?.sourcesUnavailable) {
            // Named per source and capped: "which one is down" is actionable,
            // a paragraph of repeated transport errors is not.
            const failures = (market.sources || []).filter(s => s.state === 'failed');
            const named = failures.slice(0, 2)
                .map(s => `${s.label.replace(/\s*\(.*\)$/, '')}: ${s.reason.split('—')[0].trim()}`)
                .join('; ');
            status = 'sources_unavailable';
            message = `No price source could be reached${named ? ` — ${named}` : ''}`
                + `${failures.length > 2 ? ` and ${failures.length - 2} more` : ''}. Your saved price is unchanged.`;
            // Nothing was learned, so nothing changed. Reporting a price of
            // zero here would read as "this card is now worthless".
            delta = 0;
        } else if (price === 0) {
            status = 'not_found';
            message = card.needs_review
                ? 'No listing matched. Confirm the set and card number on this card, then try again.'
                : 'No marketplace listing found for this exact printing.';
        } else if (Math.abs(delta) < 0.005) {
            status = 'unchanged';
            message = `Still $${price.toFixed(2)} — re-checked against ${market.quotesUsed} of ${market.quotesSeen} quotes.`;
        } else {
            message = `${previousPrice > 0 ? `$${previousPrice.toFixed(2)} → ` : ''}$${price.toFixed(2)} (${delta > 0 ? '+' : ''}$${delta.toFixed(2)}) from ${market.quotesUsed} of ${market.quotesSeen} quotes.`;
        }

        broadcast({ type: 'portfolio_updated' });
        res.json({
            success: true,
            status,
            message,
            // The card's price after this attempt. On an outage that is the one
            // it already had, not the zero the lookup came back with.
            price: status === 'sources_unavailable' ? previousPrice : price,
            previousPrice,
            delta,
            changed: status === 'priced',
            source: market?.source || 'not_found',
            marketplace: market?.marketplace || '',
            confidence: market?.confidence || 0,
            quotesUsed: market?.quotesUsed || 0,
            quotesSeen: market?.quotesSeen || 0,
            sources: market?.sources || [],
        });
    } catch (err) {
        console.error('Reprice error:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * Report price-history points that were fabricated by the old backfill scripts
 * rather than observed. Read-only; purging is a separate confirmed action.
 */
app.get('/api/portfolio/history-audit', requireAuth, async (req, res) => {
    try {
        const audit = await auditSyntheticHistory();
        res.json({ cards: audit.cards, pointCount: audit.pointCount, totalPoints: audit.totalPoints });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/portfolio/purge-synthetic-history', requireAuth, express.json(), async (req, res) => {
    try {
        if (req.body?.confirm !== true) {
            return res.status(400).json({ error: 'Refusing to delete history without confirm:true' });
        }
        const audit = await auditSyntheticHistory();
        if (!audit.ids.length) return res.json({ success: true, deleted: 0 });

        const result = await pool.query('DELETE FROM price_history WHERE id = ANY($1::int[])', [audit.ids]);
        broadcast({ type: 'portfolio_updated' });
        res.json({ success: true, deleted: result.rowCount, cardsAffected: audit.cards.length });
    } catch (err) {
        console.error('Purge error:', err);
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
            // A manual refresh also resets the schedule — no point re-running an
            // hour later just because the clock said so.
            refreshAllPrices()
                .then(() => setLastRefreshAt(Date.now()))
                .catch(err => console.error('Manual refresh error:', err));
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * Everything needed to answer "is this app actually keeping prices current?"
 * without reading logs: which sources are live, when prices last refreshed,
 * when the next one is due, and how much of the collection is verified.
 */
app.get('/api/health', requireAuth, async (req, res) => {
    try {
        const cards = await getAllPortfolioCards(req.user.id);
        const stats = computePortfolioStats(cards);
        const schedule = await refreshSchedule();

        const checked = cards.map(c => c.last_price_check).filter(Boolean).map(d => new Date(d).getTime());

        res.json({
            sources: [
                { name: 'Pokémon TCG API', live: true, detail: POKEMON_TCG_KEY ? 'API key set' : 'no key — rate limited', key: 'POKEMON_TCG_KEY' },
                { name: 'TCGdex', live: true, detail: 'free, no key needed', key: null },
                { name: 'Scrydex', live: Boolean(SCRYDEX_API_KEY && SCRYDEX_TEAM_ID), detail: 'needs SCRYDEX_API_KEY + SCRYDEX_TEAM_ID', key: 'SCRYDEX_API_KEY' },
                { name: 'JustTCG', live: Boolean(JUSTTCG_API_KEY), detail: 'needs JUSTTCG_API_KEY', key: 'JUSTTCG_API_KEY' },
            ],
            schedule,
            cards: {
                total: stats.totalCards,
                verified: stats.totalCards - stats.unverifiedPrices - stats.needsReview,
                unverified: stats.unverifiedPrices,
                needsReview: stats.needsReview,
                unpriced: stats.unpricedCopies,
            },
            oldestPriceCheck: checked.length ? new Date(Math.min(...checked)).toISOString() : null,
            newestPriceCheck: checked.length ? new Date(Math.max(...checked)).toISOString() : null,
            fx: fxStatus(),
        });
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

            // Process synchronously so we can return the results. Progress for
            // this particular scan streams over SSE under the client's scanId.
            const result = await processPortfolioUpload(files, req.user.id, {
                scanId: typeof req.body?.scanId === 'string' ? req.body.scanId.slice(0, 64) : '',
            });
            // `results` carries the rejections too, so the scanner can say why a
            // photo produced nothing instead of failing silently.
            res.json({
                success: true,
                cards: result.cards,
                results: result.results,
                message: `Added ${result.cards.length} card(s)`,
            });
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
    const report = scanReporter(options.scanId);

    broadcastActivity('analyzing', `Scanning ${files.length} photo${files.length > 1 ? 's' : ''} with AI...`);
    report('start', { photos: files.length });

    for (let index = 0; index < files.length; index++) {
        const file = files[index];
        const photo = { index, of: files.length };
        broadcastActivity('analyzing', `Scanning photo ${index + 1} of ${files.length}...`);
        report('reading', { ...photo, message: 'Preparing the photo' });

        let buffer, vision, thumbDataUrl = '';
        try {
            buffer = readFileSync(file.path);
            let sendMime = file.mimetype;

            if (!GEMINI_SUPPORTED_TYPES.has(sendMime)) {
                console.log(`  [Vision] Converting ${sendMime} → JPEG for Gemini & Sharp...`);
                report('converting', { ...photo, message: 'Converting the image' });
                const converted = await convertToJpeg(buffer, file.path);
                if (converted) {
                    buffer = converted;
                    sendMime = 'image/jpeg';
                }
            }

            // The thumbnail is made before the AI call so the client has
            // something of the actual card to show while it waits.
            try {
                const thumbBuffer = await sharp(buffer)
                    .resize(400, 560, { fit: 'inside', withoutEnlargement: true })
                    .jpeg({ quality: 80 })
                    .toBuffer();
                thumbDataUrl = `data:image/jpeg;base64,${thumbBuffer.toString('base64')}`;
                report('thumbnail', { ...photo, image_data: thumbDataUrl });
            } catch (e) { console.error(`  [Thumb] Failed for photo ${index + 1}:`, e.message); }

            report('identifying', { ...photo, message: 'Reading the card with AI' });
            vision = await analyzeImageBuffer(buffer, sendMime);

            try { rmSync(file.path, { force: true }); } catch { }
        } catch (err) {
            console.error(`Photo ${index + 1} error:`, err.message);
            try { rmSync(file.path, { force: true }); } catch { }
            report('photo_failed', { ...photo, reason: 'unreadable', message: 'Could not read that image.' });
            results.push({ status: 'error', reason: 'unreadable', message: 'Could not read that image.' });
            continue;
        }

        // An outage is not the same as an empty frame. Saying "no card found"
        // when the recognition service was down or rate limited sent people off
        // re-photographing a perfectly good card.
        if (!vision?.ok) {
            const message = vision?.message || 'Card recognition failed.';
            broadcastActivity('error', message);
            report('photo_failed', { ...photo, reason: vision?.kind || 'ai_failed', message, retryable: vision?.kind !== 'not_configured' });
            results.push({ status: 'error', reason: vision?.kind || 'ai_failed', message, image_data: thumbDataUrl });
            continue;
        }

        const analysis = vision.analysis;
        if (!analysis?.cards?.length || analysis?.is_pokemon_card === false) {
            broadcastActivity('info', `No Pokémon card detected in photo ${index + 1}.`);
            report('photo_failed', {
                ...photo,
                reason: 'no_card',
                message: 'No Pokémon card found in the frame. Fill more of the frame with the card and avoid glare.',
                retryable: true,
            });
            results.push({
                status: 'rejected',
                reason: 'no_card',
                message: 'No Pokémon card found in the frame. Fill more of the frame with the card and avoid glare.',
                image_data: thumbDataUrl,
            });
            continue;
        }

        for (const rawCard of analysis.cards) {
            report('identified', {
                ...photo,
                card: {
                    card_name: rawCard.card_name || '',
                    card_set: rawCard.card_set || '',
                    card_number: rawCard.card_number || '',
                    rarity: rawCard.rarity || '',
                    confidence: Number(rawCard.confidence) || 0,
                },
            });
            report('verifying', { ...photo, message: 'Confirming the printing against the card database' });

            const verified = await verifyAndCanonicalizeCard(rawCard, report);
            const card = verified || { ...rawCard, needs_review: true };

            if (verified) {
                report('verified', {
                    ...photo,
                    card: {
                        card_name: verified.card_name,
                        card_set: verified.card_set,
                        card_number: verified.card_number,
                        rarity: verified.rarity,
                        year: verified.year,
                        image_url: verified.image_url || '',
                        confidence: verified.confidence,
                    },
                });
            } else {
                if (!hasMeaningfulCardName(card.card_name)) {
                    report('photo_failed', { ...photo, reason: 'unreadable_card', message: 'Could not read the card name. Try again with less glare.', retryable: true });
                    results.push({
                        status: 'rejected',
                        reason: 'unreadable_card',
                        message: 'Could not read the card name. Try again with less glare.',
                        image_data: thumbDataUrl,
                    });
                    continue;
                }
                broadcastActivity('info', `Saved "${card.card_name}" for review — could not confirm it in the card database.`);
                report('unverified', { ...photo, card_name: card.card_name, message: 'Saving for review — the printing could not be confirmed' });
            }

            const saved = await saveScannedCard(card, {
                userId,
                thumbDataUrl,
                needsReview: !verified,
                forceSeparate: options.forceSeparate === true,
                report: (stage, payload) => report(stage, { ...photo, ...payload }),
            });

            totalAdded++;
            results.push(saved);
            report('saved', { ...photo, card: saved });
            broadcastActivity('card_added_detail', `${saved.is_new_copy ? '➕' : '✅'} ${saved.card_name}`, saved);
            broadcast({ type: 'card_added' });
        }
    }

    const added = results.filter(r => r.status === 'added');
    broadcastActivity('upload_complete', `Added ${added.length} card${added.length !== 1 ? 's' : ''} to your collection.`);
    report('done', { added: added.length, results });

    return { totalAdded, cards: added, results };
}

/**
 * Persist one identified card: either as a new printing or as another copy of a
 * printing already held.
 */
async function saveScannedCard(card, { userId, thumbDataUrl, needsReview, forceSeparate, report = () => {} }) {
    const variantKey = buildVariantKey(card);
    const existing = forceSeparate ? null : await findCardByVariant(variantKey, userId);

    if (existing) {
        report('duplicate', { card_name: existing.card_name, message: `Already in the collection — adding another copy` });
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
        report('pricing', { message: 'Checking marketplace prices' });
        try {
            market = await lookupMarketPrice(card, {
                onSource: (entry) => report('price_source', entry),
            });
        } catch (err) {
            console.error(`  [Pricing] Inline lookup failed for ${card.card_name}:`, err.message);
        }
        if (market?.price > 0) {
            report('priced', {
                price: market.price,
                source: market.source,
                marketplace: market.marketplace || '',
                confidence: market.confidence,
                low: market.low,
                high: market.high,
                quotesUsed: market.quotesUsed,
                quotesSeen: market.quotesSeen,
            });
        } else {
            report('unpriced', {
                message: market?.sourcesUnavailable
                    ? 'No price source could be reached — this card will be priced on the next refresh.'
                    : 'No marketplace listing found for this printing yet.',
            });
        }
    } else {
        report('pricing_skipped', { message: 'Not priced until the printing is confirmed' });
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
        refreshAllPrices()
            .then(() => setLastRefreshAt(Date.now()))
            .catch(err => console.error('[Cron] Refresh error:', err.message));
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
// Everything else is the app shell, served with build-stamped asset URLs.
app.get('*', (req, res) => sendIndex(res));

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
