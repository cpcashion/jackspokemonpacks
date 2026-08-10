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
    parseCardNumber,
    printedSetTotal,
    normalizeLanguage,
    languageCode,
    languageLabel,
    languageBadge,
    languageIsCertain,
    isNonEnglish,
    hasNonLatinScript,
} from './lib/identity.js';
import { auditHistoryRows } from './lib/history.js';
import { typesFromCard, serializeTypes } from './lib/types.js';
import { buildSearchQueries, compsFromListings } from './lib/ebay-comps.js';
import { tierFor, scaleConfidence, shouldReplace, asReasonClause } from './lib/price-tier.js';
import { boxToRegion, isMultiCard, needsCloserLook, mergeCloserLook } from './lib/card-crop.js';
import { spreadPhotoIds } from './lib/source-photo.js';
import { buildZip, safeEntryName } from './lib/zip.js';
import {
    createBudget,
    cardsAffordable,
    EBAY_DAILY_LIMIT as EBAY_DEFAULT_DAILY_LIMIT,
} from './lib/api-budget.js';
import {
    perceptualHash,
    decodeDataUrl,
    groupLikelySamePhoto,
    summariseCard,
} from './lib/photo-audit.js';
import {
    hasMeaningfulCardName,
    cardNameCandidates,
    namesMatchExactly,
    compareCandidate,
    isLikelyVerifiedMatch,
    scorePokemonCardCandidate,
} from './lib/matching.js';
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
// eBay. App ID and Cert ID from https://developer.ebay.com — these are the
// OAuth client credentials, not an API key; the app exchanges them for a token.
const EBAY_APP_ID = process.env.EBAY_APP_ID || process.env.EBAY_CLIENT_ID || '';
const EBAY_CERT_ID = process.env.EBAY_CERT_ID || process.env.EBAY_CLIENT_SECRET || '';
const EBAY_MARKETPLACE = process.env.EBAY_MARKETPLACE || 'EBAY_US';
// eBay allows an application 5,000 Browse calls a day. Pricing one card can
// cost up to eight, so a collection of a few hundred can spend the lot in a
// single refresh — see lib/api-budget.js.
const EBAY_DAILY_LIMIT = Number(process.env.EBAY_DAILY_CALL_LIMIT) || EBAY_DEFAULT_DAILY_LIMIT;

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

        -- How much the number can be relied on ('confirmed' / 'estimated' /
        -- 'unpriced') and the sentence the UI shows to explain it. Every card
        -- that can be identified carries a price; this is how the app says how
        -- sure it is, instead of withholding the price and asking a person.
        ALTER TABLE portfolio_cards ADD COLUMN IF NOT EXISTS price_tier TEXT DEFAULT '';
        ALTER TABLE portfolio_cards ADD COLUMN IF NOT EXISTS price_explanation TEXT DEFAULT '';

        -- This row is not a card. It is a photograph of many cards — a binder
        -- page or a tabletop layout — that an earlier scanner mistook for a
        -- single card and filed in the collection. Rows carrying this flag are
        -- excluded from the collection, its totals and its counts, and exist
        -- only as the source the real cards are extracted from.
        ALTER TABLE portfolio_cards ADD COLUMN IF NOT EXISTS is_source_photo INTEGER DEFAULT 0;
        -- How many cards a look at the photo actually found, and whether the
        -- extraction has been done. Nulls mean "not examined yet".
        ALTER TABLE portfolio_cards ADD COLUMN IF NOT EXISTS source_cards_found INTEGER;
        ALTER TABLE portfolio_cards ADD COLUMN IF NOT EXISTS source_extracted_at TIMESTAMP;
        -- Which source photo a card came out of, so the spread it belongs to
        -- can be shown and a re-extraction cannot duplicate it.
        ALTER TABLE portfolio_cards ADD COLUMN IF NOT EXISTS source_photo_id INTEGER;

        -- A non-English card is stored under the name printed on it. The English
        -- name of the same Pokémon is kept alongside so it stays searchable and
        -- so an English-language card database can be queried at all.
        ALTER TABLE portfolio_cards ADD COLUMN IF NOT EXISTS card_name_en TEXT DEFAULT '';
        -- The short code printed near the number ("csb6C", "sv8a"). On Japanese,
        -- Chinese and Korean cards this identifies the set far more reliably
        -- than a translated set name.
        ALTER TABLE portfolio_cards ADD COLUMN IF NOT EXISTS set_code TEXT DEFAULT '';
        -- Which database confirmed the printing, so a re-verification can say.
        ALTER TABLE portfolio_cards ADD COLUMN IF NOT EXISTS verified_source TEXT DEFAULT '';
        -- Energy types as printed, comma separated. A dual-type card holds both.
        -- Trainer and Energy cards store their supertype here so that a grouping
        -- by type still accounts for every card in the collection.
        ALTER TABLE portfolio_cards ADD COLUMN IF NOT EXISTS types TEXT DEFAULT '';
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

    // A revision counter the database maintains about itself.
    //
    // The collection payload is cached to keep Neon's metered egress sane, and
    // a cache needs an invalidation rule that cannot be forgotten. App writes
    // announce themselves, but writes from OUTSIDE the app — a SQL console
    // edit, a migration, a test seeding rows directly — announce nothing, and
    // a cache keyed on announcements would serve a stale collection after any
    // of them. Statement-level triggers bump one counter on any change to the
    // three tables the payload is built from; reading it costs a few bytes,
    // which is the whole point.
    await pool.query(`
        CREATE OR REPLACE FUNCTION bump_collection_rev() RETURNS trigger AS $$
        BEGIN
            INSERT INTO app_meta (key, value) VALUES ('collection_rev', '1')
            ON CONFLICT (key) DO UPDATE
                SET value = (COALESCE(NULLIF(app_meta.value, ''), '0')::bigint + 1)::text,
                    applied_at = NOW();
            RETURN NULL;
        END $$ LANGUAGE plpgsql;
    `);
    for (const table of ['portfolio_cards', 'card_copies', 'price_history']) {
        await pool.query(`
            DROP TRIGGER IF EXISTS trg_${table}_rev ON ${table};
            CREATE TRIGGER trg_${table}_rev
                AFTER INSERT OR UPDATE OR DELETE ON ${table}
                FOR EACH STATEMENT EXECUTE FUNCTION bump_collection_rev();
        `);
    }

    await backfillVariantKeys();
    await backfillCardCopies();
    await queueLegacyPricesForRecheck();
    await clearPricesOnUnconfirmedCards();
    await queueUnpricedCardsForEstimates();
    await flagSpreadPhotos();
    await withdrawUnreachablePrices();
    await rebuildIdentityAndMerge();
    await dropUnconfirmedArtwork();
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
/**
 * Strip prices off cards whose printing was never confirmed.
 *
 * Re-pricing used to run a loose name-and-number search on cards awaiting
 * review and store whatever came back, so a card in Needs review could display
 * a confident figure that belonged to an entirely different printing — a common
 * Steelix showed as worth hundreds. Those numbers cannot be corrected, only
 * removed: the card has to be identified before it can be valued.
 *
 * The history goes with them, because it was recorded against the same
 * unconfirmed identity.
 */
async function clearPricesOnUnconfirmedCards() {
    const KEY = 'clear_unconfirmed_prices_v1';
    if (await hasRun(KEY)) return;

    const affected = await pool.query(`
        SELECT id FROM portfolio_cards
        WHERE COALESCE(needs_review, 0) = 1 AND COALESCE(current_price, 0) > 0
    `);
    const ids = affected.rows.map(r => r.id);

    if (ids.length) {
        await pool.query('DELETE FROM price_history WHERE card_id = ANY($1::int[])', [ids]);
        await pool.query(`
            UPDATE portfolio_cards
            SET current_price = 0, price_source = '', price_source_url = '',
                price_confidence = 0, price_marketplace = '', price_variant = '',
                price_variant_matched = 0, price_low = 0, price_high = 0,
                price_sources = '{}'::jsonb, highest_recent_sale = 0,
                best_sold_price = 0, best_sold_source = '', last_price_check = NULL
            WHERE id = ANY($1::int[])
        `, [ids]);
        console.log(`  [Migrate] Removed prices from ${ids.length} unconfirmed card(s) — they were matched loosely and could belong to a different printing`);
    }
    await markRun(KEY, ids.length);
}

/**
 * Send every card with no price back to the front of the refresh queue.
 *
 * `clearPricesOnUnconfirmedCards` above stripped prices off cards whose
 * printing was never confirmed, on the rule that an unconfirmed card gets no
 * price at all. That rule is gone: those cards are priced as estimates now, and
 * the ones it emptied have been sitting at no value ever since, along with
 * every card a scheduled run skipped for the same reason.
 *
 * Clearing last_price_check is all that is needed — the refresh picks up
 * never-checked cards first, and now prices them instead of stepping over them.
 */
async function queueUnpricedCardsForEstimates() {
    const KEY = 'queue_unpriced_for_estimates_v1';
    if (await hasRun(KEY)) return;

    // Every price already in the database was produced under the old rule,
    // which priced a card only after confirming its printing — so they are all
    // confirmed prices and must be stamped as such. Without this they carry no
    // tier, rank below everything in `shouldReplace`, and the first estimate to
    // come along would overwrite a price that was correct. That is exactly the
    // downward drift the tier ordering exists to prevent.
    await pool.query(`
        UPDATE portfolio_cards
        SET price_tier = 'confirmed'
        WHERE COALESCE(current_price, 0) > 0
          AND COALESCE(price_confidence, 0) > 0
          AND COALESCE(price_tier, '') = ''
    `);

    const res = await pool.query(`
        UPDATE portfolio_cards
        SET last_price_check = NULL
        WHERE COALESCE(current_price, 0) = 0
    `);
    await markRun(KEY, res.rowCount);
    if (res.rowCount) {
        console.log(`  [Migrate] Queued ${res.rowCount} unpriced card(s) — they will be valued, as estimates where the printing cannot be confirmed`);
    }
}

/**
 * Get the photographs of whole binder pages out of the collection.
 *
 * These rows are the app's original sin: pictures of twenty cards, each saved
 * as one card, sitting in the collection unpriced because no marketplace sells
 * "a photograph of twenty cards". They were never cards and they should never
 * have been listed as such.
 *
 * Shape decides it, and only in one direction. A Pokémon card is upright, and
 * so is any photograph of one; a row of six or eight cards is wider than it is
 * tall by construction. So a landscape photo is certainly not one card, while a
 * portrait one might be a tall spread and is left for the vision pass to judge.
 * Being cautious here costs a row staying visible a while longer. Being
 * confident here would hide a card Jack owns.
 *
 * Nothing is deleted. The row becomes a source photo, keeps its image, and the
 * cards inside it are extracted into rows of their own.
 */
/**
 * Strip the prices that were invented on the back of lookups that never ran.
 *
 * An earlier rule priced any card whose printing could not be confirmed and
 * labelled the result an estimate. It did not distinguish "the databases
 * answered and the answer did not fit this card" from "the databases could not
 * be reached", so a rate limit during a refresh produced a confident-looking
 * figure for a card nothing had been learned about. One Rayquaza VMAX showed
 * $1,253.94 with the explanation "the card database could not answer — Rate
 * limited" printed directly beneath it, and enough of those together carried
 * the collection past $20,000.
 *
 * Those figures cannot be corrected, only withdrawn: there was never any
 * evidence behind them. The cards go back to having no price and to the front
 * of the refresh queue, where they will be priced properly against a database
 * that is actually answering.
 */
async function withdrawUnreachablePrices() {
    const KEY = 'withdraw_unreachable_estimates_v1';
    if (await hasRun(KEY)) return;

    const affected = await pool.query(`
        SELECT id FROM portfolio_cards
        WHERE price_tier = 'estimated'
          AND COALESCE(current_price, 0) > 0
          AND (
            price_explanation ILIKE '%could not answer%'
            OR price_explanation ILIKE '%rate limited%'
            OR price_explanation ILIKE '%before asking again%'
            OR price_explanation ILIKE '%could not be reached%'
          )
    `);
    const ids = affected.rows.map(r => r.id);

    if (ids.length) {
        // The history goes too. It was recorded against the same non-evidence,
        // and leaving it would draw a chart of a price that never existed.
        await pool.query('DELETE FROM price_history WHERE card_id = ANY($1::int[])', [ids]);
        await pool.query(`
            UPDATE portfolio_cards
            SET current_price = 0, price_source = '', price_source_url = '',
                price_confidence = 0, price_marketplace = '', price_variant = '',
                price_variant_matched = 0, price_low = 0, price_high = 0,
                price_sources = '{}'::jsonb, highest_recent_sale = 0,
                best_sold_price = 0, best_sold_source = '',
                price_tier = '', price_explanation = '', last_price_check = NULL
            WHERE id = ANY($1::int[])
        `, [ids]);
        console.log(`  [Migrate] Withdrew ${ids.length} price(s) that were estimated while the card databases were unreachable`);
    }
    await markRun(KEY, ids.length);
}

async function flagSpreadPhotos() {
    const KEY = 'flag_spread_photos_v1';
    if (await hasRun(KEY)) return;

    const { rows } = await pool.query(`
        SELECT id, image_data FROM portfolio_cards
        WHERE COALESCE(is_source_photo, 0) = 0 AND image_data IS NOT NULL AND image_data <> ''
    `);

    const sized = [];
    for (const row of rows) {
        const buffer = dataUrlToBuffer(row.image_data);
        if (!buffer) continue;
        try {
            const meta = await sharp(buffer).metadata();
            sized.push({ id: row.id, width: meta.width || 0, height: meta.height || 0 });
        } catch { /* an unreadable thumbnail decides nothing */ }
    }

    const ids = spreadPhotoIds(sized);
    if (ids.length) {
        await pool.query(
            'UPDATE portfolio_cards SET is_source_photo = 1 WHERE id = ANY($1::int[])', [ids]);
        console.log(`  [Migrate] ${ids.length} row(s) are photos of several cards, not cards — moved out of the collection`);
    }
    await markRun(KEY, ids.length);
}

/**
 * Rebuild every card's identity, and fold together the rows that were split.
 *
 * Identity used to include the set NAME, which nothing prints — the model infers
 * it from a symbol, and infers inconsistently. One Meganium numbered 010/132 was
 * read once as "Scarlet & Violet-Temporal Forces" and once as "Paldea Evolved",
 * so it became two cards: two rows, two entries in the count, two prices in the
 * total, for one piece of cardboard.
 *
 * Copies need more care than rows do. Merging two rows normally combines their
 * copies, because two rows usually mean two physical cards — but not here. These
 * pairs came from the same shelf being read twice: once by the original scan and
 * once by the extraction pass, which was supposed to skip cards already held and
 * failed to only because the keys disagreed. A copy created that way is evidence
 * of the same card, not a second one.
 *
 * So the rule is: keep the copies of the row that was there first, and drop the
 * copies of a colliding row that extraction created. Anything else — two genuine
 * scans on different days — keeps both, because then two cards really might be
 * on the shelf and over-counting is the recoverable error.
 */
/**
 * Take back the artwork attached to cards whose printing was never confirmed.
 *
 * Artwork used to be fetched by a loose search that fell back to "first result
 * with an image", so a Tyrunt numbered 070 that could not be placed was
 * illustrated with the artwork of a Tyrunt numbered 044/086 — a different card,
 * shown in preference to the photograph Jack actually took, and looking every
 * bit as authoritative as a correct one.
 *
 * A picture of the wrong card is worse than no picture: it is a confident claim
 * about what you own. These revert to the scan photo, which is always a picture
 * of the real thing, and artwork returns if and when the printing is confirmed.
 */
async function dropUnconfirmedArtwork() {
    const KEY = 'drop_unconfirmed_artwork_v1';
    if (await hasRun(KEY)) return;

    const res = await pool.query(`
        UPDATE portfolio_cards
        SET image_url = ''
        WHERE COALESCE(needs_review, 0) = 1
          AND COALESCE(image_url, '') <> ''
    `);
    await markRun(KEY, res.rowCount);
    if (res.rowCount) {
        console.log(`  [Migrate] Removed artwork from ${res.rowCount} unconfirmed card(s) — it may have been a different printing`);
    }
}

async function rebuildIdentityAndMerge() {
    const KEY = 'variant_key_without_set_name_v1';
    if (await hasRun(KEY)) return;

    const { rows } = await pool.query(`
        SELECT id, card_name, card_set, set_code, card_number, holo_type, is_holo,
               language, is_first_edition, variant_key
        FROM portfolio_cards
    `);

    let rekeyed = 0;
    for (const row of rows) {
        const key = buildVariantKey(row);
        if (key !== row.variant_key) {
            await pool.query('UPDATE portfolio_cards SET variant_key = $1 WHERE id = $2', [key, row.id]);
            rekeyed++;
        }
    }
    if (rekeyed) console.log(`  [Migrate] Re-derived identity for ${rekeyed} card(s) from what is printed on them`);

    // Rows that extraction created and that now collide with an older row are
    // the same physical card seen twice, so the whole row goes — not merely its
    // copies. Emptying a row instead would achieve nothing: the merge below
    // deliberately gives any copy-less row a copy back, on the principle that a
    // row represents a card Jack owns, and the two steps would cancel out.
    // Deleting the row removes it from the merge's consideration entirely, and
    // card_copies and price_history cascade with it.
    const collided = await pool.query(`
        DELETE FROM portfolio_cards dupe
        USING portfolio_cards orig
        WHERE orig.user_id = dupe.user_id
          AND orig.variant_key = dupe.variant_key
          AND orig.id < dupe.id
          AND dupe.source_photo_id IS NOT NULL
          AND dupe.variant_key <> ''
          AND COALESCE(dupe.is_source_photo, 0) = 0
    `);
    if (collided.rowCount) {
        console.log(`  [Migrate] Removed ${collided.rowCount} row(s) that extraction added for cards already held`);
    }

    const users = await pool.query('SELECT DISTINCT user_id FROM portfolio_cards');
    let merged = 0;
    let removed = 0;
    for (const { user_id } of users.rows) {
        const result = await mergeDuplicateGroups(user_id);
        merged += result.mergedGroups;
        removed += result.removedRows;
    }
    if (removed) {
        console.log(`  [Migrate] Folded ${removed} duplicate row(s) into ${merged} card(s) — one row per printed card`);
    }
    await markRun(KEY, removed);
}

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
        INSERT INTO portfolio_cards (user_id, card_name, card_name_en, card_set, set_code, card_number, rarity, condition, is_holo, is_first_edition, confidence, image_data, image_url, notes, year, language, holo_type, variant_key, needs_review, verified_source, types)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
        RETURNING id
    `, [
        userId, card.card_name, card.card_name_en || '', card.card_set || '', card.set_code || '',
        card.card_number || '', card.rarity || 'Unknown',
        canonicalCondition(card.condition_estimate || card.condition), (card.is_holographic || card.is_holo) ? 1 : 0, card.is_first_edition ? 1 : 0,
        card.confidence || 0, card.image_data || '', card.image_url || '', card.notes || '',
        card.year || 0, normalizeLanguage(card.language), card.holo_type || 'Unknown',
        buildVariantKey(card), card.needs_review ? 1 : 0, card.verified_source || '', card.types || ''
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
            price_tier             = $12,
            price_explanation      = $13,
            highest_recent_sale    = $10,
            best_sold_price        = $10,
            best_sold_source       = $3,
            last_price_check       = NOW()
            -- needs_review is deliberately not touched here. It records that
            -- the printing was never confirmed, which is still true of a card
            -- priced as an estimate, and it is what makes the next refresh try
            -- to confirm it again. Clearing it on a price would freeze every
            -- estimate as an estimate forever.
            --
            -- Nothing shows it to the user: the app reports what it knows and
            -- asks for nothing. getAllPortfolioCards reports "has no price"
            -- under that name for the client, which is a different fact.
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
        marketData.tier || '',
        marketData.explanation || '',
    ]);
}

/**
 * Fill in a card's types if we never captured them.
 *
 * Costs nothing extra: the refresh is about to price this card, which means
 * looking up the same candidates, and those lookups are memoised. So this rides
 * along on a request that was going to happen anyway rather than adding a
 * second pass over the collection.
 */
async function backfillTypesIfMissing(card) {
    if (card.types) return null;
    try {
        let types = '';
        if (isNonEnglish(card.language)) {
            const found = await fetchTCGdexCard(card.card_name, card.card_set, card.card_number, {
                lang: languageCode(card.language),
                fallbackName: card.card_name_en || '',
            });
            types = serializeTypes(typesFromCard(found || {}));
        } else {
            const candidates = await fetchPokemonTcgCandidates(card);
            if (!candidates.length) return null;
            const { bestCandidate } = pickBestPokemonCardCandidate(card, candidates);
            types = serializeTypes(typesFromCard(bestCandidate || {}));
        }
        if (types) await pool.query('UPDATE portfolio_cards SET types = $2 WHERE id = $1', [card.id, types]);
        return types || null;
    } catch {
        // Types are a nicety; never let one failing lookup abort a price refresh.
        return null;
    }
}

/** Marks a card as checked without touching its price — used when a lookup finds nothing. */
async function markPriceChecked(cardId) {
    await pool.query('UPDATE portfolio_cards SET last_price_check = NOW() WHERE id = $1', [cardId]);
}

/**
 * Drop a price that belonged to a different printing.
 *
 * Called when a card's identity changes. Keeping the old figure is how a card
 * ended up sitting in Needs review displaying a confident price — a number
 * that was correct for the card it used to be recorded as, and wrong for the
 * card it now is. Its history is deleted for the same reason.
 */
async function clearStalePrice(cardId) {
    await pool.query(`
        UPDATE portfolio_cards
        SET current_price         = 0,
            price_source          = '',
            price_source_url      = '',
            price_confidence      = 0,
            price_marketplace     = '',
            price_variant         = '',
            price_variant_matched = 0,
            price_low             = 0,
            price_high            = 0,
            price_sources         = '{}'::jsonb,
            highest_recent_sale   = 0,
            best_sold_price       = 0,
            best_sold_source      = '',
            last_price_check      = NOW()
        WHERE id = $1
    `, [cardId]);
}

/**
 * Write a confirmed printing back onto a card and take it out of Needs review.
 *
 * The variant key is recomputed here because the identity may have moved — a
 * card confirmed as a different set is a different printing, and leaving the
 * old key would let it be folded into the wrong group as a duplicate.
 */
async function applyVerifiedIdentity(cardId, verified) {
    await pool.query(`
        UPDATE portfolio_cards
        SET card_name       = $2,
            card_name_en    = $3,
            card_set        = $4,
            set_code        = $5,
            card_number     = $6,
            rarity          = $7,
            year            = $8,
            language        = $9,
            image_url       = CASE WHEN $10 <> '' THEN $10 ELSE image_url END,
            confidence      = $11,
            variant_key     = $12,
            verified_source = $13,
            -- Only overwrite when the database actually told us something, so a
            -- re-verify against a source without type data cannot erase it.
            types           = CASE WHEN $14 <> '' THEN $14 ELSE types END,
            needs_review    = 0
        WHERE id = $1
    `, [
        cardId,
        verified.card_name || '',
        verified.card_name_en || '',
        verified.card_set || '',
        verified.set_code || '',
        verified.card_number || '',
        verified.rarity || 'Unknown',
        verified.year || 0,
        normalizeLanguage(verified.language),
        verified.image_url || '',
        Number(verified.confidence) || 0,
        buildVariantKey(verified),
        verified.verified_source || '',
        verified.types || '',
    ]);
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
        WHERE user_id = $1 AND variant_key <> '' AND COALESCE(is_source_photo, 0) = 0
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
        SELECT pc.id, pc.user_id, pc.card_name, pc.card_name_en, pc.card_set, pc.set_code, pc.card_number,
            pc.rarity, pc.condition, pc.is_holo, pc.is_first_edition, pc.confidence,
            pc.image_url, pc.notes, pc.year, pc.language, pc.holo_type,
            pc.variant_key, pc.verified_source, pc.types,
            -- Two different facts, and conflating them is what put a card the
            -- app had read perfectly into a queue for a person.
            --
            -- printing_confirmed is about identification and drives the retry:
            -- an unconfirmed card is re-verified on every refresh, so an
            -- estimate can become a market price when a database catches up.
            --
            -- needs_review is what the client displays, and it means only
            -- "no price at all". An estimate is a value, so a card carrying one
            -- is not outstanding — and even a card with no price is waiting on
            -- a marketplace, never on the user.
            (COALESCE(pc.needs_review, 0) = 0) AS printing_confirmed,
            pc.price_confidence, pc.price_marketplace, pc.price_variant,
            pc.price_variant_matched, pc.price_low, pc.price_high,
            pc.price_tier, pc.price_explanation,
            pc.added_at, pc.current_price AS card_current_price, pc.price_source AS card_price_source,
            pc.price_source_url AS card_price_source_url,
            pc.price_sources, pc.last_price_check,
            -- Simply "is there a scan photo". This used to be false whenever
            -- artwork existed, which left the client no way to fall back to
            -- the real photograph when the artwork could not be trusted.
            (pc.image_data IS NOT NULL AND pc.image_data <> '') AS has_local_image,
            -- Is there a photograph of this card at all: either the scan that
            -- created it, or one attached to a copy. This is the difference
            -- between a card in the binder and a card the app merely believes
            -- in, and it is the first question to ask of a suspect entry.
            (
                (pc.image_data IS NOT NULL AND pc.image_data <> '')
                OR EXISTS (SELECT 1 FROM card_copies cc2 WHERE cc2.card_id = pc.id AND cc2.image_data <> '')
            ) AS has_photo,
            latest.price AS current_price,
            day_ref.price AS previous_price,
            day_ref.price AS prev_day_price,
            week_ref.price AS prev_7d_price,
            month_ref.price AS prev_30d_price,
            latest.source AS price_source,
            latest.source_url AS price_source_url,
            -- The first observation ever, plus the last 120 daily closes.
            --
            -- This used to be the raw last 30 rows, which quietly broke every
            -- window longer than the recording cadence: a card priced daily
            -- for 100 days had no point older than a month in the payload, so
            -- the client's 90-day and all-time movement treated the whole
            -- mature collection as "newly priced". One close per day is what
            -- the charts draw anyway; the first-ever point is what all-time
            -- movement measures from. Payload stays bounded at ~121 points.
            (
                SELECT json_agg(h ORDER BY h.recorded_at ASC) FROM (
                    (
                        SELECT price, recorded_at FROM price_history
                        WHERE card_id = pc.id
                        ORDER BY recorded_at ASC LIMIT 1
                    )
                    UNION ALL
                    (
                        SELECT price, recorded_at FROM (
                            SELECT DISTINCT ON (date_trunc('day', recorded_at))
                                   price, recorded_at
                            FROM price_history
                            WHERE card_id = pc.id
                            ORDER BY date_trunc('day', recorded_at) DESC, recorded_at DESC
                            LIMIT 120
                        ) daily
                    )
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
        -- Source photos are excluded here, which is what takes them out of the
        -- collection, the totals, the set and type groupings and the Unpriced
        -- tab all at once. They are pictures of many cards, not cards, and are
        -- served separately by /api/portfolio/source-photos.
        WHERE pc.user_id = $1 AND COALESCE(pc.is_source_photo, 0) = 0
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
        // Two different facts, and conflating them is what put a card the app
        // had read perfectly into a queue for a person.
        //
        // `printing_confirmed` (from the query) is about identification, and
        // drives the retry: an unconfirmed card is re-verified on every refresh
        // so an estimate can become a market price once a database catches up.
        //
        // `needs_review` is what the client displays and means only "no price
        // at all". It is derived from the same `unitPrice` the app shows, so
        // the label can never disagree with the number beside it. An estimate
        // is a value, so a card carrying one is not outstanding — and a card
        // with no price is waiting on a marketplace, never on the user.
        needs_review: !(unitPrice > 0),
        has_mixed_conditions: new Set(perCopy.map(c => c.condition || 'Unknown')).size > 1,
        // Language belongs on screen for anything that is not English: a
        // Japanese Charizard and an English one are different cards worth
        // different money, and the list should not make them look alike.
        language_label: languageLabel(row.language),
        language_badge: languageBadge(row.language),
        is_non_english: isNonEnglish(row.language),
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
    let estimatedCards = 0;
    let estimatedValue = 0;
    let confirmedCards = 0;
    let confirmedValue = 0;
    let unverifiedCards = 0;
    let unverifiedValue = 0;
    let withPhoto = 0;
    let withoutPhoto = 0;

    for (const card of cards) {
        totalValue += card.total_value;

        // Solid accounting starts with what is actually evidenced. A card whose
        // printing was confirmed against a database and priced against that
        // printing is a number worth adding up; an estimate is a reasonable
        // guess and belongs in its own column, not folded silently into the
        // headline.
        if (card.unit_price > 0) {
            if (card.price_tier === 'confirmed') {
                confirmedCards++;
                confirmedValue += card.total_value;
            } else if (card.price_tier !== 'estimated') {
                // Priced with no tier at all: the old engine's work, kept
                // visible rather than quietly counted as something it is not.
                unverifiedCards++;
                unverifiedValue += card.total_value;
            }
        }
        // Whether a photograph of the card exists at all — the difference
        // between a card in a binder and a card the app believes in.
        if (card.has_photo) withPhoto++; else withoutPhoto++;
        totalCopies += card.quantity;
        if (!(card.unit_price > 0)) unpriced += card.quantity;
        // Outstanding means "no price", not "unconfirmed printing" — an
        // unconfirmed card is priced as an estimate and counts in the total
        // like any other. Read off the price rather than the flag so a row
        // written before this change cannot report a chore that is already done.
        if (!(card.unit_price > 0)) needsReview++;
        if (card.price_tier === 'estimated') {
            estimatedCards++;
            estimatedValue += card.total_value;
        }
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
        // How much of the total rests on estimates rather than confirmed
        // printings. Shown in the app so a headline figure is never read as
        // more certain than it is.
        estimatedCards,
        estimatedValue: Number(estimatedValue.toFixed(2)),
        // The figure that can be stood behind: every card confirmed to a
        // printing and priced against it. Shown as the headline, with the
        // estimates beside it rather than inside it.
        confirmedCards,
        confirmedValue: Number(confirmedValue.toFixed(2)),
        unverifiedCards,
        unverifiedValue: Number(unverifiedValue.toFixed(2)),
        cardsWithPhoto: withPhoto,
        cardsWithoutPhoto: withoutPhoto,
        totalValue: Number(totalValue.toFixed(2)),
        prevValue: Number(prevValue.toFixed(2)),
        acquiredCost: Number(acquiredCost.toFixed(2)),
    };
}

// ═══════════════════════════════════════════════════════════════
//  TCGDEX IMAGE LOOKUP (free, no API key)
// ═══════════════════════════════════════════════════════════════

/**
 * Artwork for one card — or nothing.
 *
 * This used to end with "fallback: use first result with image", which meant a
 * search for a Tyrunt numbered 070 could return the artwork of a Tyrunt
 * numbered 044/086. That picture then went into image_url, and because the app
 * shows artwork in preference to the photo you took, the card in your
 * collection was illustrated by a different card entirely.
 *
 * A picture of the wrong card is worse than no picture at all: it is a claim,
 * made confidently, that this is what you own. So the number has to agree, or
 * nothing comes back.
 */
async function fetchCardImageFromTCGdex(cardName, cardSet, cardNumber, lang = 'en') {
    try {
        const searchName = encodeURIComponent(cardName.trim());
        const resp = await axios.get(`https://api.tcgdex.net/v2/${lang}/cards?name=${searchName}`, {
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
                    const detail = await axios.get(`https://api.tcgdex.net/v2/${lang}/cards/${candidate.id}`, {
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

        // No fallback. If neither the printed number nor the set name picked a
        // card out, we do not know which of these printings is in your hand,
        // and guessing produces a picture of somebody else's card.
        return null;
    } catch (err) {
        console.error(`  [TCGdex] Error looking up "${cardName}":`, err.message);
        return null;
    }
}

/**
 * Look one card up in TCGdex.
 *
 * TCGdex publishes each language separately at /v2/{lang}/, which makes it the
 * one source here that can confirm a Japanese, Korean or Chinese printing at
 * all — the Pokémon TCG API is English-only. A non-English card is therefore
 * searched in its own language, under its own printed name, and only falls
 * back to English if that finds nothing.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.strict] rethrow transport failures instead of
 *   returning null. A pricing lookup has to be able to tell "TCGdex has no
 *   listing for this card" from "TCGdex never answered"; an image lookup does
 *   not care.
 * @param {string} [opts.lang] TCGdex language code, e.g. "ja", "zh-cn".
 * @param {string} [opts.fallbackName] name to retry with in English when the
 *   localised search comes back empty.
 */
async function fetchTCGdexCard(cardName, cardSet, cardNumber, opts = {}) {
    // Historically this took a positional `strict` boolean.
    const { strict = false, lang = 'en', fallbackName = '' } =
        typeof opts === 'boolean' ? { strict: opts } : opts;
    if (!cardName) return null;
    try {
        const attempts = [{ lang, name: cardName }];
        if (lang !== 'en' && fallbackName && fallbackName !== cardName) {
            attempts.push({ lang: 'en', name: fallbackName });
        }

        let results = [];
        let activeLang = lang;
        for (const attempt of attempts) {
            const searchName = encodeURIComponent(attempt.name.trim());
            const resp = await axios.get(`https://api.tcgdex.net/v2/${attempt.lang}/cards?name=${searchName}`, {
                timeout: 10000,
                headers: { 'Accept': 'application/json' }
            });
            noteSource('tcgdex', { ok: true, status: resp.status, message: 'OK' });
            const found = Array.isArray(resp.data) ? resp.data : [];
            if (found.length) { results = found; activeLang = attempt.lang; break; }
        }
        if (!results.length) return null;

        const normalizedSet = normalizeText(cardSet);
        const normalizedNumber = normalizeCardNumber(cardNumber);

        const detailCache = new Map();
        const loadDetail = async (candidate) => {
            if (!candidate?.id) return null;
            if (detailCache.has(candidate.id)) return detailCache.get(candidate.id);
            try {
                const detail = await axios.get(`https://api.tcgdex.net/v2/${activeLang}/cards/${candidate.id}`, {
                    timeout: 10000,
                    headers: { 'Accept': 'application/json' }
                });
                const data = detail.data ? { ...detail.data, tcgdexLang: activeLang } : null;
                detailCache.set(candidate.id, data);
                return data;
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
        const failure = describeAxiosError(err, { usesKey: false });
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
        // Taking results[0] blindly is how a card ends up illustrated by a
        // different printing of the same Pokemon. The printed number decides it,
        // denominator included: a card reading 070/086 did not come from a set
        // of 165, whatever else matches.
        const fits = results.find(c => {
            const m = compareCandidate({ card_name: cardName, card_set: cardSet, card_number: cardNumber }, c);
            return m.name && !m.setSizeConflicts && (m.number || m.setName);
        });
        if (fits) return fits.images?.large || fits.images?.small || null;
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

MANY OF THESE IMAGES CONTAIN SEVERAL CARDS AT ONCE — a binder page, a grid laid out on a table, a fan of cards. Return one entry for EVERY card you can see, not just the most prominent one. A photo of sixteen cards must return sixteen entries. Work through the image systematically, row by row, so none is skipped. Two cards showing the same Pokemon are two entries, not one.

For each card also return box_2d: the card's bounding box in the image as [ymin, xmin, ymax, xmax], each value 0-1000 relative to the image size. This is what lets each card be cropped out and shown on its own, so give it for every card even when there is only one. Bound the card itself, not the sleeve or the binder pocket around it.

Pokemon cards are printed in English, Japanese, Korean, Simplified Chinese, Traditional Chinese, French, German, Spanish, Italian, Portuguese, Dutch, Polish, Russian, Thai and Indonesian. Read whichever language the card is actually in. Never refuse a card because it is not in English.

Read these directly off the card. Do not infer them from the artwork or from what is typical:
- card_name: the name EXACTLY as printed, in the card's own script. For a Japanese card that means the Japanese name (e.g. "リザードン"), for Simplified Chinese the Chinese name (e.g. "古空棘鱼"). Include suffixes as printed: EX, GX, V, VMAX, VSTAR, ex.
- card_name_en: the SAME Pokemon's official English name (e.g. "リザードン" -> "Charizard", "古空棘鱼" -> "Relicanth", "리자몽" -> "Charizard"). Include the English form of any suffix. For a card already in English, repeat card_name here. This field is what lets the card be looked up, so give your best answer rather than an empty string whenever you can recognise the Pokemon.
- card_number: bottom of the card, exactly as printed, INCLUDING the part after the slash (e.g. "4/102", "093/132", "TG12/TG30", "014/131"). The number after the slash is how the set is identified, so never drop it. If the card genuinely has no slash, give what is printed ("SWSH045", "PROMO").
- set_code: the short code printed near the number if there is one (e.g. "csb6C", "sv8a", "SV3", "S12a"). Japanese, Chinese and Korean cards carry this and it identifies the set far more reliably than a name. Use "" if none is printed.
- card_set: the set name. Use the set symbol, the set code and the number's denominator. If you cannot identify the set with confidence, use "" — an empty set name costs nothing, because the card number's denominator identifies the set on its own. A wrong guess is worse than no guess.
- Printing. This is critical and is decided by the foil pattern:
  * "Reverse Holo" - the card BORDER/background is foiled but the artwork is not.
  * "Holofoil" - the ARTWORK BOX is foiled.
  * "Cosmos Holo" - starry/cosmos foil pattern.
  * "Non-Holo" - no foil anywhere.
  If the foil pattern is not clearly visible, use "Unknown" rather than guessing.
- 1st Edition: true ONLY if the "1st Edition" stamp is actually visible on the card.
- language: which language the card is printed in, from the script and the text. Be precise between "Chinese (Simplified)" and "Chinese (Traditional)". Only say "English" if the card really is English.
- year: copyright year from the bottom of the card.
- Condition, from visible edge wear, surface scratches, whitening and centering.

Rules:
- Never invent a name, set or number. An empty string is always better than a guess.
- card_name_en is the one exception: an English name you are confident of from recognising the Pokemon is wanted even though it is not printed on the card. If you cannot tell which Pokemon it is, use "".
- Ignore binder pages, sleeves, pack art, background objects and anything that is not a physical card.
- If a card is blurry, cropped, or obstructed, either omit it or give it a low confidence.
- Confidence reflects how clearly you could READ the card, not how sure you are the card exists.
- Do not estimate any monetary value. Prices are looked up separately.

Return ONLY valid JSON (no markdown fences):
{
  "cards": [{
    "box_2d": [ymin, xmin, ymax, xmax],
    "card_name": "name exactly as printed, in its own script",
    "card_name_en": "official English name of the same Pokemon",
    "card_set": "Set name or empty string",
    "set_code": "printed set code or empty string",
    "card_number": "e.g. 4/102",
    "rarity": "Common|Uncommon|Rare|Rare Holo|Rare Ultra|Secret Rare|Illustration Rare|Promo|Unknown",
    "condition_estimate": "Mint|Near Mint|Lightly Played|Moderately Played|Heavily Played|Damaged|Unknown",
    "is_holographic": true/false,
    "holo_type": "Holofoil|Reverse Holo|Non-Holo|Cosmos Holo|Unknown",
    "year": 1999,
    "language": "English|Japanese|Korean|Chinese (Simplified)|Chinese (Traditional)|French|German|Spanish|Italian|Portuguese|Dutch|Polish|Russian|Thai|Indonesian",
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

/**
 * Signatures of an outbound-network policy refusing the request, rather than
 * the API refusing it. Both arrive as a 403, and telling them apart matters:
 * one is fixed by a new key, the other by an egress rule, and reporting the
 * wrong one sends you off rotating a key that was never the problem.
 */
const NETWORK_BLOCK_PATTERNS = [
    /host not permitted/i,
    /request rejected/i,
    /tunneling socket could not be established/i,
    /blocked by .*(policy|firewall|proxy)/i,
    /forbidden by (proxy|gateway)/i,
];

function looksLikeNetworkBlock(err) {
    const body = err?.response?.data;
    const text = typeof body === 'string' ? body : '';
    const haystack = `${text} ${err?.message || ''}`;
    // A real API answers 403 with JSON and its own headers; a proxy answers
    // with a short plaintext refusal and almost nothing else.
    return NETWORK_BLOCK_PATTERNS.some(p => p.test(haystack));
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.usesKey] whether this source authenticates at all.
 *   TCGdex needs no key, so "check the API key" is meaningless advice for it.
 */
function describeAxiosError(err, { usesKey = true } = {}) {
    const status = err?.response?.status;

    if (looksLikeNetworkBlock(err)) {
        return {
            ok: false, status, kind: 'blocked',
            message: 'Blocked before it left this server — an outbound network rule, not an API key',
        };
    }
    if (status === 429) return { ok: false, status, kind: 'rate_limited', message: 'Rate limited' };
    if (status === 401 || status === 403) {
        return {
            ok: false, status, kind: 'auth',
            message: usesKey ? 'Rejected — check the API key' : `Refused the request (HTTP ${status})`,
        };
    }
    if (status) return { ok: false, status, kind: 'http', message: `HTTP ${status}` };
    if (err?.code === 'ECONNABORTED' || /timeout/i.test(err?.message || '')) return { ok: false, kind: 'timeout', message: 'Timed out' };
    return { ok: false, kind: 'network', message: err?.message || 'Unreachable' };
}

/** Which sources authenticate, for the message above. */
const SOURCE_USES_KEY = {
    pokemontcg: true,   // optional, but a key is what raises the rate limit
    tcgdex: false,
    scrydex: true,
    justtcg: true,
    fx: false,
};

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

/**
 * The name to search an English-language card database with.
 *
 * api.pokemontcg.io carries English printings only, so querying it with the
 * name printed on a Japanese or Chinese card returns nothing no matter how it
 * is spelled. The English name the AI reports alongside the printed one is
 * what makes the lookup possible at all.
 */
function englishSearchName(card) {
    const printed = String(card?.card_name || '').trim();
    const english = String(card?.card_name_en || '').trim();
    if (english && hasMeaningfulCardName(english)) {
        // Prefer the English name whenever the printed one cannot possibly
        // match: a non-Latin script, or a card we know is not English.
        if (hasNonLatinScript(printed) || isNonEnglish(card?.language) || !printed) return english;
    }
    return printed || english;
}

async function fetchPokemonTcgCandidates(card) {
    if (!hasMeaningfulCardName(englishSearchName(card))) return [];

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
            // Built from `baseMessage`, never from `message`. This record is
            // handed back to noteSource further up the call chain, so deriving
            // it from the message would make each pass append to the last: one
            // card's explanation ended up reading "Rate limited — waiting 59s
            // before asking again — waiting 57s before asking again —" thirty
            // times over, having accumulated once per card in the refresh.
            baseMessage: health.baseMessage || health.message,
            message: `${health.baseMessage || health.message} — waiting ${Math.ceil(cooling / 1000)}s before asking again`,
        });
        return [];
    }

    const headers = { 'Accept': 'application/json' };
    if (POKEMON_TCG_KEY) headers['X-Api-Key'] = POKEMON_TCG_KEY;

    const safeName = englishSearchName(card).replace(/"/g, '\\"').trim();
    const safeSet = String(card.card_set || '').replace(/"/g, '\\"').trim();
    const { number: normalizedNumber, printedTotal } = parseCardNumber(card.card_number);
    // A non-English card's set name comes from a different print run and will
    // not exist in an English database, so searching by it wastes a request.
    const setIsSearchable = Boolean(safeSet) && !isNonEnglish(card.language);

    // Most specific first, and specificity is measured in printed evidence.
    // "093/132" pins the set to one of 132 cards, which is a far tighter filter
    // than a set name the model guessed from a symbol — and unlike the guess it
    // cannot be wrong. The loop stops at the first query that answers, because
    // the rate limit is the binding constraint on a large collection.
    const queries = [];
    if (safeName && normalizedNumber && printedTotal) queries.push(`name:"${safeName}" number:"${normalizedNumber}" set.printedTotal:${printedTotal}`);
    if (safeName && normalizedNumber) queries.push(`name:"${safeName}" number:"${normalizedNumber}"`);
    if (safeName && setIsSearchable && normalizedNumber) queries.push(`name:"${safeName}" set.name:"${safeSet}" number:"${normalizedNumber}"`);
    if (safeName && setIsSearchable) queries.push(`name:"${safeName}" set.name:"${safeSet}"`);
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
 * Confirm a card the AI read against a real card database, and return it in
 * canonical form.
 *
 * Which database depends on the language, and that is not a detail:
 *
 *  - api.pokemontcg.io carries English printings only. Its numbering is the
 *    English numbering. A Japanese Charizard printed 013/102 in a Japanese set
 *    has no relationship to English 4/102, so matching a non-English card
 *    against it would either fail or — worse — succeed against the wrong card
 *    and attach an English-market price to a Japanese printing.
 *  - TCGdex publishes each language separately, with the numbers actually
 *    printed on those cards, so it is the only source that can confirm a
 *    Japanese, Korean or Chinese printing.
 *
 * Whichever one confirms it, the printed name and language are preserved. A
 * card is stored as the thing Jack is holding, not as its English equivalent.
 *
 * @param {(stage:string, payload?:object) => void} [report] scan progress sink
 * @returns {object|null} the canonical card, or null with a reason reported
 */
async function verifyAndCanonicalizeCard(card, report = () => {}) {
    if (!card || !hasMeaningfulCardName(card.card_name || card.card_name_en)) {
        report('verify_failed', { reason: 'unreadable_name', message: 'Could not make out the card name.' });
        return null;
    }
    if (analysisLooksTooWeak(card)) {
        report('verify_failed', { reason: 'weak_read', message: 'The set and number were not legible enough to confirm the printing.' });
        return null;
    }

    if (isNonEnglish(card.language)) {
        report('verifying_language', {
            language: languageLabel(card.language),
            message: `Looking this up as a ${languageLabel(card.language)} printing`,
        });
        return verifyAgainstTcgdex(card, report);
    }
    return verifyAgainstPokemonTcg(card, report);
}

/**
 * Verify, and keep hold of why it failed.
 *
 * The reason is not diagnostic noise: it is the sentence shown beside an
 * estimated price — "Estimated — the closest Chinese (Simplified) match is
 * numbered 051, not 120/105." The verifier already phrases these for a person,
 * so this only stops them being thrown away, which is what used to happen right
 * before the card was filed under "needs review" with no explanation at all.
 */
async function verifyWithReason(card, report = () => {}) {
    let why = '';
    let reason = '';
    const verified = await verifyAndCanonicalizeCard(card, (stage, payload = {}) => {
        if (stage === 'verify_failed' && payload.message) {
            why = payload.message;
            reason = payload.reason || '';
        }
        report(stage, payload);
    });
    return {
        verified,
        why: verified ? '' : asReasonClause(why),
        reason: verified ? '' : reason,
        // Did we actually learn anything about this card?
        //
        // "The closest match is numbered 051, not 120/105" is a finding: the
        // databases were asked and answered, and the answer did not fit. A rate
        // limit or an outage is the opposite — nothing was learned, because
        // nothing was asked. Estimating a price off the second kind is how a
        // Rayquaza VMAX came to be valued at $1,253.94 on the strength of a
        // lookup that never happened.
        answered: verified ? true : !isTransientFailure(reason),
    };
}

/** Failures that say nothing about the card, only about the moment. */
function isTransientFailure(reason) {
    return String(reason || '').startsWith('database_');
}

/** Confirm a non-English printing against TCGdex in its own language. */
async function verifyAgainstTcgdex(card, report) {
    const lang = languageCode(card.language);
    const label = languageLabel(card.language);
    let found = null;
    try {
        found = await fetchTCGdexCard(card.card_name, card.card_set, card.card_number, {
            lang,
            fallbackName: card.card_name_en || '',
            strict: true,
        });
    } catch (err) {
        const failure = describeAxiosError(err);
        report('verify_failed', {
            reason: `database_${failure.kind}`,
            message: `The ${label} card database could not answer — ${failure.message}.`,
        });
        return null;
    }

    if (!found) {
        report('verify_failed', {
            reason: 'no_match',
            message: `No ${label} card matched "${card.card_name}" ${card.card_number || ''}`.trim() + '.',
        });
        return null;
    }

    // The printed number is the one strong signal here: TCGdex's localId is
    // what is on the card, in that language's own numbering.
    const printed = normalizeCardNumber(card.card_number);
    const theirs = normalizeCardNumber(found.localId);
    if (printed && theirs && printed !== theirs) {
        report('verify_failed', {
            reason: 'number_mismatch',
            message: `Closest ${label} match is numbered ${found.localId}, not ${card.card_number}.`,
        });
        return null;
    }

    if (!namesMatchExactly(card, found.name)) {
        report('verify_failed', {
            reason: 'low_match',
            message: `The closest ${label} match was "${found.name}", which is not close enough to trust.`,
        });
        return null;
    }

    return {
        ...card,
        // Kept as printed. This is a Japanese/Chinese/Korean card and storing
        // it under its English name would misrepresent what Jack owns.
        card_name: card.card_name || found.name,
        card_name_en: card.card_name_en || '',
        card_set: found.set?.name || card.card_set || '',
        card_number: card.card_number || found.localId || '',
        rarity: found.rarity || card.rarity || 'Unknown',
        year: card.year || 0,
        language: normalizeLanguage(card.language),
        image_url: found.image ? `${found.image}/high.webp` : '',
        tcgplayer_url: '',
        cardmarket_url: '',
        verified_source: `tcgdex_${found.tcgdexLang || lang}`,
        types: serializeTypes(typesFromCard(found)),
        confidence: Math.max(Number(card.confidence) || 0, printed && theirs ? 0.95 : 0.85),
    };
}

/** Confirm an English printing against the Pokémon TCG API. */
async function verifyAgainstPokemonTcg(card, report) {
    const candidates = await fetchPokemonTcgCandidates(card);
    if (!candidates.length) {
        const failure = candidateLookupError(card);
        report('verify_failed', failure
            ? { reason: `database_${failure.kind}`, message: `The card database could not answer — ${failure.message}.` }
            : { reason: 'no_match', message: 'No card in the database matched that name, set and number.' });
        return null;
    }
    report('candidates', { count: candidates.length });

    /**
     * Resolve, rather than refuse.
     *
     * This used to bail out whenever more than one printing shared a name,
     * handing the card to a person to sort out. But "several Pikachus exist" is
     * not ambiguity — the card in your hand says which one it is. Ranking the
     * candidates against the printed number and set size decides it; the only
     * genuine ambiguity is a tie between two candidates that fit the printed
     * evidence equally well, which is rare and is the one case still refused.
     */
    const ranked = candidates
        .map(c => ({ candidate: c, score: scorePokemonCardCandidate(card, c), match: compareCandidate(card, c) }))
        .sort((a, b) => b.score - a.score);

    const best = ranked[0];
    const runnerUp = ranked[1];

    if (best && runnerUp && best.score === runnerUp.score && isLikelyVerifiedMatch(best.score, best.candidate, card)) {
        // Two printings fit everything printed on the card equally well. Prefer
        // the earlier release, which is the original printing; a reprint that
        // genuinely cannot be told apart from it is close enough in identity
        // that pricing the original is the better answer than pricing nothing.
        const date = (r) => r.candidate?.set?.releaseDate || '9999';
        if (date(best) !== date(runnerUp)) {
            ranked.sort((a, b) => (b.score - a.score) || (date(a) < date(b) ? -1 : 1));
        }
    }

    const bestCandidate = ranked[0]?.candidate || null;
    const bestScore = ranked[0]?.score ?? -1;

    if (!bestCandidate || !isLikelyVerifiedMatch(bestScore, bestCandidate, card)) {
        const printed = parseCardNumber(card.card_number);
        const closest = ranked[0];
        let message = 'The closest database match was not close enough to trust.';

        // Say what specifically did not line up. "Could not confirm" with no
        // detail is what made this feel like a chore with no way to finish it.
        if (closest) {
            const m = closest.match;
            if (m.setSizeConflicts) {
                const theirTotal = Number(closest.candidate?.set?.printedTotal) || Number(closest.candidate?.set?.total) || 0;
                message = `Card reads ${card.card_number}, but the closest match is from a set of ${theirTotal} cards. Re-scan with the number in frame.`;
            } else if (!m.name) {
                message = `No card named "${card.card_name}" in the database — the name may have been misread.`;
            } else if (!m.number && printed.number) {
                message = `Found ${closest.candidate?.name} but nothing numbered ${card.card_number}. The number may have been misread.`;
            }
        }
        report('verify_failed', { reason: 'low_match', message });
        return null;
    }

    return {
        ...card,
        card_name: bestCandidate.name || card.card_name,
        card_name_en: bestCandidate.name || card.card_name_en || '',
        card_set: bestCandidate.set?.name || card.card_set || '',
        card_number: bestCandidate.number || card.card_number || '',
        rarity: bestCandidate.rarity || card.rarity || 'Unknown',
        year: parseInt((bestCandidate.set?.releaseDate || '').slice(0, 4), 10) || card.year || 0,
        language: 'english',
        image_url: bestCandidate.images?.large || bestCandidate.images?.small || '',
        tcgplayer_url: bestCandidate.tcgplayer?.url || '',
        cardmarket_url: bestCandidate.cardmarket?.url || '',
        verified_source: 'pokemontcg',
        types: serializeTypes(typesFromCard(bestCandidate)),
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

/**
 * Long edge, in pixels, of the image actually sent for recognition.
 *
 * A modern phone photo is 12 MP or more. Uploading one of those to the model on
 * every shutter press dominated the time from tap to result, and none of that
 * detail is used: what has to be legible is a name in ~40px type, a card number
 * in ~15px type, and a foil pattern. 1280px on the long edge keeps all three
 * readable — including CJK glyphs, which need more pixels than Latin text —
 * while cutting the bytes sent by roughly an order of magnitude.
 *
 * The client already crops to the capture guide and caps its own output, so this
 * mainly affects photos chosen from the library and the native camera.
 */
const AI_IMAGE_MAX_EDGE = 1280;

/**
 * Shrink an image for recognition. Returns the original buffer unchanged if
 * anything goes wrong: a slower scan is better than a failed one.
 */
async function prepareImageForAi(buffer) {
    try {
        const image = sharp(buffer, { failOn: 'none' });
        const meta = await image.metadata();
        const longEdge = Math.max(meta.width || 0, meta.height || 0);
        if (!longEdge || longEdge <= AI_IMAGE_MAX_EDGE) return { buffer, mime: null, resized: false };

        const out = await image
            .rotate() // honour EXIF orientation before dropping the metadata
            .resize(AI_IMAGE_MAX_EDGE, AI_IMAGE_MAX_EDGE, { fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 88, mozjpeg: true })
            .toBuffer();
        return {
            buffer: out,
            mime: 'image/jpeg',
            resized: true,
            from: longEdge,
            savedBytes: buffer.length - out.length,
        };
    } catch (err) {
        console.error('  [AI prep] Could not resize, sending as-is:', err.message);
        return { buffer, mime: null, resized: false };
    }
}

/** Decode a stored `data:` thumbnail back to bytes. */
function dataUrlToBuffer(dataUrl) {
    const m = /^data:([^;]+);base64,(.+)$/s.exec(String(dataUrl || ''));
    if (!m) return null;
    try {
        const buf = Buffer.from(m[2], 'base64');
        return buf.length ? buf : null;
    } catch {
        return null;
    }
}

/**
 * Cut one card out of a photo of several.
 *
 * Returns null rather than throwing on any failure: a card shown under the
 * whole grid is a cosmetic problem, and failing the scan over it would be a
 * real one. The caller falls back to the full-frame thumbnail.
 */
async function cropCardThumbnail(buffer, box, { width = 900, height = 1260 } = {}) {
    try {
        const meta = await sharp(buffer).metadata();
        const region = boxToRegion(box, meta.width, meta.height);
        if (!region) return null;
        const out = await sharp(buffer)
            .rotate()
            .extract(region)
            .resize(width, height, { fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 82, mozjpeg: true })
            .toBuffer();
        return `data:image/jpeg;base64,${out.toString('base64')}`;
    } catch (err) {
        console.error('  [Crop] Could not cut card from photo:', err.message);
        return null;
    }
}

/**
 * Cards in a grid photo get a fraction of the frame each, and the scan pipeline
 * downscales to 1280px before the model ever sees it. Sixteen cards across that
 * is roughly 320px per card, which is not enough for a card number set in small
 * type — so the weakly-read ones are cut out of the ORIGINAL, full-resolution
 * buffer and read again on their own.
 *
 * Capped, because each re-read is a separate model call: a binder page of
 * thirty cards must not turn into thirty-one requests.
 */
const CLOSER_LOOK_LIMIT = 8;

async function refineWeakCards(buffer, cards, mime, report = () => {}) {
    const weak = needsCloserLook(cards).slice(0, CLOSER_LOOK_LIMIT);
    if (!weak.length) return { cards, refined: 0 };

    report('closer_look', {
        count: weak.length,
        message: `Re-reading ${weak.length} card${weak.length === 1 ? '' : 's'} close up`,
    });

    const out = [...cards];
    let refined = 0;

    for (const { card, index } of weak) {
        try {
            const meta = await sharp(buffer).metadata();
            const region = boxToRegion(card.box_2d, meta.width, meta.height, 0.06);
            if (!region) continue;
            const crop = await sharp(buffer).rotate().extract(region)
                .resize(AI_IMAGE_MAX_EDGE, AI_IMAGE_MAX_EDGE, { fit: 'inside', withoutEnlargement: true })
                .jpeg({ quality: 90, mozjpeg: true })
                .toBuffer();

            const closer = await analyzeImageBuffer(crop, 'image/jpeg');
            const first = closer?.ok ? closer.analysis?.cards?.[0] : null;
            if (!first) continue;

            out[index] = mergeCloserLook(card, first);
            refined++;
        } catch (err) {
            console.error(`  [Closer look] ${card?.card_name || 'card'}:`, err.message);
        }
    }

    if (refined) report('closer_look_done', { refined, message: `Read ${refined} more clearly close up` });
    return { cards: out, refined };
}

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
//  EBAY — where these cards actually change hands
//
//  Every other source here reports a catalogue price. eBay reports what people
//  are doing. That makes it the most valuable signal available and also the
//  most dangerous: the results for one card mix graded slabs, bulk lots,
//  proxies, sealed product and other languages, and averaging them produces a
//  number with no meaning. lib/ebay-comps.js does the filtering; this part
//  only fetches.
//
//  Sold prices are not obtainable. eBay's Marketplace Insights API is the sole
//  first-party source of completed sales and is a Limited Release closed to new
//  applicants; the Finding API's findCompletedItems was decommissioned in
//  February 2025. What the Browse API does give is live auctions with bids on
//  them, which are real buyers committing real money — the closest thing to
//  sold data we can legitimately reach.
// ═══════════════════════════════════════════════════════════════

let ebayToken = { value: '', expiresAt: 0 };

/**
 * Client-credentials token, cached until shortly before it expires.
 *
 * eBay tokens last two hours and minting one costs a round trip, so a refresh
 * over a large collection would otherwise spend a meaningful fraction of its
 * time re-authenticating.
 */
/**
 * eBay's daily allowance, counted across restarts.
 *
 * Persisted to app_meta rather than held in memory: the free tier restarts
 * whenever the service wakes from a spin-down, and a counter that forgot would
 * let each boot spend the whole allowance again.
 */
const ebayBudget = createBudget({
    limit: EBAY_DAILY_LIMIT,
    load: async (day) => {
        try {
            const r = await pool.query('SELECT value FROM app_meta WHERE key = $1', [`ebay_calls_${day}`]);
            return Number(r.rows[0]?.value) || 0;
        } catch { return 0; }
    },
    save: async (day, used) => {
        try {
            await pool.query(
                `INSERT INTO app_meta (key, value) VALUES ($1, $2)
                 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, applied_at = NOW()`,
                [`ebay_calls_${day}`, String(used)]);
        } catch { /* a lost count is better than a failed price lookup */ }
    },
});

async function ebayAccessToken() {
    if (!EBAY_APP_ID || !EBAY_CERT_ID) return null;
    if (ebayToken.value && Date.now() < ebayToken.expiresAt) return ebayToken.value;

    const basic = Buffer.from(`${EBAY_APP_ID}:${EBAY_CERT_ID}`).toString('base64');
    const resp = await axios.post(
        'https://api.ebay.com/identity/v1/oauth2/token',
        'grant_type=client_credentials&scope=' + encodeURIComponent('https://api.ebay.com/oauth/api_scope'),
        {
            headers: {
                Authorization: `Basic ${basic}`,
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            timeout: 12000,
        },
    );

    const expiresIn = Number(resp.data?.expires_in) || 7200;
    ebayToken = {
        value: resp.data?.access_token || '',
        // A minute of headroom, so a token cannot expire mid-refresh.
        expiresAt: Date.now() + (expiresIn - 60) * 1000,
    };
    noteSource('ebay', { ok: true, message: 'Authenticated' });
    return ebayToken.value;
}

/**
 * Live listings for one search string: both Buy-It-Now and auctions.
 *
 * eBay returns only fixed-price listings unless auctions are asked for
 * explicitly, and auctions are the half we care about most — so both are
 * fetched and merged.
 */
async function fetchEbayListings(card, q, { interactive = false } = {}) {
    const token = await ebayAccessToken();
    if (!token) return null;
    if (!q) return null;

    // Each search costs two calls: fixed-price listings and auctions are
    // separate requests. Checked before spending rather than after, so the
    // allowance cannot go negative mid-refresh.
    if (!(await ebayBudget.canSpend(2, { interactive }))) {
        throw new SourceUnavailable({
            ok: false,
            kind: 'quota',
            message: `eBay's daily allowance of ${EBAY_DAILY_LIMIT} calls is spent — it resets at midnight UTC`,
        });
    }
    await ebayBudget.spend(2);

    const headers = {
        Authorization: `Bearer ${token}`,
        'X-EBAY-C-MARKETPLACE-ID': EBAY_MARKETPLACE,
        Accept: 'application/json',
    };
    // 183454 is Trading Card Singles. Constraining the category removes most of
    // the sealed product and merchandise before the title filters have to.
    const base = {
        q,
        category_ids: '183454',
        limit: 100,
        filter: 'conditionIds:{4000|3000|2750|1000|1500|2000|2500|5000|6000}',
    };

    const [fixed, auctions] = await Promise.allSettled([
        axios.get('https://api.ebay.com/buy/browse/v1/item_summary/search', { params: base, headers, timeout: 15000 }),
        axios.get('https://api.ebay.com/buy/browse/v1/item_summary/search', {
            params: { ...base, filter: 'buyingOptions:{AUCTION}' }, headers, timeout: 15000,
        }),
    ]);

    const listings = [];
    for (const r of [fixed, auctions]) {
        if (r.status === 'fulfilled') listings.push(...(r.value.data?.itemSummaries || []));
    }
    if (fixed.status === 'rejected' && auctions.status === 'rejected') throw fixed.reason;

    noteSource('ebay', { ok: true, message: `${listings.length} listings` });
    // The same item can appear in both responses.
    const unique = new Map();
    for (const item of listings) if (item?.itemId) unique.set(item.itemId, item);
    return [...unique.values()];
}

/**
 * eBay's contribution to a card's price, as quotes the aggregator understands.
 *
 * The condition of the copy is deliberately NOT passed in. eBay comps describe
 * the printing, and lib/identity.js discounts each copy for its own condition
 * afterwards — applying both would discount twice.
 */
async function collectEbayQuotes(card, { interactive = false } = {}) {
    const subject = {
        name: card.card_name_en || card.card_name,
        number: normalizeCardNumber(card.card_number),
        rawNumber: card.card_number || '',
        printedTotal: printedSetTotal(card.card_number),
        setName: card.card_set || '',
        // Printed on the card, unlike the set name, and the only identifier a
        // promo or a brand-new subset has.
        setCode: card.set_code || '',
        language: normalizeLanguage(card.language),
        isFirstEdition: isTruthy(card.is_first_edition),
        // Graded slabs trade in a separate market; only match like with like.
        graded: Boolean(card.graded),
        grade: card.grade || null,
    };

    const queries = buildSearchQueries(subject);
    if (!queries.length) return [];

    // Walk the ladder until something holds.
    //
    // A single query was the whole bug behind "no price found" on a card with
    // 1,415 completed sales: eBay matches title text, sellers write the number
    // in several shapes, and one guess at which shape missed. Each rung is
    // tried in turn and the first that yields a defensible estimate wins, so
    // the common case still costs exactly one round trip.
    //
    // Every listing seen along the way is kept. If no rung produces an estimate
    // on its own, the pooled set gets one last pass with the thin-evidence rule
    // enabled — because two real listings at $8 is a better answer than none.
    let best = null;
    let bestQuery = '';
    const seen = new Map();
    const attempts = [];
    let lastError = null;

    for (const { q, requireNumber, strict } of queries) {
        let listings;
        try {
            listings = await fetchEbayListings(card, q, { interactive });
        } catch (err) {
            lastError = err;
            // A spent allowance is not a per-search failure: every remaining
            // rung would fail identically, so the ladder stops rather than
            // logging the same refusal four times over.
            if (err instanceof SourceUnavailable && err.failure?.kind === 'quota') break;
            attempts.push({ q, error: describeAxiosError(err, { usesKey: true }).message });
            continue;
        }
        if (!listings) return [];

        for (const item of listings) if (item?.itemId) seen.set(item.itemId, item);

        const result = compsFromListings(listings, { ...subject, requireNumber });
        attempts.push({ q, strict, considered: result.considered, accepted: result.accepted, priced: Boolean(result.estimate) });

        if (result.estimate) {
            best = { ...result, strict, query: q };
            bestQuery = q;
            break;
        }
    }

    // Nothing was reachable at all — that is an outage, not a priceless card,
    // and the two must not look alike.
    if (!best && lastError && !seen.size) {
        const failure = describeAxiosError(lastError, { usesKey: true });
        noteSource('ebay', failure);
        throw new SourceUnavailable(failure);
    }

    if (!best && seen.size) {
        const pooled = compsFromListings([...seen.values()], { ...subject, requireNumber: false }, { thin: true });
        if (pooled.estimate) best = { ...pooled, strict: false, query: `${queries.length} searches pooled` };
        else best = pooled;
    }

    if (best) {
        lastEbayWorkings.set(buildVariantKey(card), { ...best, attempts });
    }
    if (!best?.estimate) return [];

    const { estimate } = best;
    const fromBids = estimate.basis === 'auction bids';
    return [{
        price: estimate.price,
        currency: 'USD',
        marketplace: 'ebay',
        source: `ebay_${estimate.basis.replace(/\s+/g, '_')}`,
        variant: '',
        // A bid is a buyer committing to this exact card, which is a stronger
        // claim about the printing than a catalogue lookup makes — but only
        // when the search that found it demanded the printed number. A looser
        // rung found a card by name and set, which is not the same claim.
        variantMatched: fromBids && best.strict === true,
        basis: fromBids ? 'market' : 'listings',
        url: bestQuery ? `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(bestQuery)}` : '',
        samples: estimate.samples,
        // Carried through so the aggregator can discount a price that rests on
        // one or two listings rather than a market.
        thin: Boolean(estimate.thin),
    }];
}

/** The last comp breakdown per card, so the UI can show the workings. */
const lastEbayWorkings = new Map();
export function ebayWorkingsFor(card) {
    return lastEbayWorkings.get(buildVariantKey(card)) || null;
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

    // Candidates the card itself refutes are dropped before anything is priced.
    //
    // This matters more now that an unconfirmed card is priced rather than
    // skipped. "Highest score wins" has no floor, so without this a Steelix
    // printed 093/132 could be priced against a different Steelix numbered 93
    // in a 162-card set — the $206 valuation of a card worth cents. A set size
    // that disagrees is proof of a different printing, not a weaker match, and
    // an estimate that used one would make the label a lie: it promises a price
    // based on cards matching the name, number and language.
    const usable = candidates.filter(c => !compareCandidate(card, c).setSizeConflicts);
    if (!usable.length) return [];

    const { bestCandidate } = pickBestPokemonCardCandidate(card, usable);
    if (!bestCandidate) return [];
    return quotesFromPokemonTcgCandidate(bestCandidate, ctx);
}

async function collectTcgdexQuotes(card, ctx) {
    const tcgdexCard = await fetchTCGdexCard(card.card_name, card.card_set, card.card_number, {
        strict: true,
        lang: languageCode(card.language),
        fallbackName: card.card_name_en || '',
    });
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
    ebay: 'eBay (live listings and bids)',
};

/**
 * Resolve one card's market price.
 *
 * `onSource` is called as each source is asked and again as it answers, so a
 * scan or a re-price can show which marketplaces are being consulted instead of
 * a spinner. The returned object carries the same information as `sources`, so
 * a caller that only wants the outcome does not have to listen.
 */
async function lookupMarketPrice(card, { onSource, fresh = false, interactive = false } = {}) {
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
    const nonEnglish = isNonEnglish(card.language);
    const langLabel = languageLabel(card.language);

    // A price is only a price for the printing it was quoted on. The Pokémon
    // TCG API and JustTCG both index the English TCGplayer catalogue, so their
    // numbers describe the English card — applying one to a Japanese or Chinese
    // printing would be a confident, plausible, wrong answer, which is worse
    // than no answer. Those sources are therefore not consulted at all for a
    // non-English card; TCGdex is, because it is queried in that language.
    const collectors = [
        {
            name: 'pokemontcg',
            configured: !nonEnglish,
            reason: nonEnglish ? `English-only catalogue — cannot price a ${langLabel} printing` : '',
            run: () => collectPokemonTcgQuotes(card, ctx),
        },
        { name: 'tcgdex', configured: true, run: () => collectTcgdexQuotes(card, ctx) },
        {
            name: 'ebay',
            configured: Boolean(EBAY_APP_ID && EBAY_CERT_ID),
            reason: 'no eBay credentials — set EBAY_APP_ID and EBAY_CERT_ID',
            run: () => collectEbayQuotes(card, { interactive }),
        },
        {
            name: 'scrydex',
            configured: Boolean(SCRYDEX_API_KEY && SCRYDEX_TEAM_ID) && !nonEnglish,
            reason: !SCRYDEX_API_KEY || !SCRYDEX_TEAM_ID ? 'no API key'
                : `English-only catalogue — cannot price a ${langLabel} printing`,
            run: () => collectScrydexQuotes(card, ctx),
        },
        {
            name: 'justtcg',
            configured: Boolean(JUSTTCG_API_KEY) && !nonEnglish,
            reason: !JUSTTCG_API_KEY ? 'no API key'
                : `English-only catalogue — cannot price a ${langLabel} printing`,
            run: () => collectJustTcgQuotes(card),
        },
    ];

    const sources = [];
    const report = (entry) => {
        sources.push(entry);
        try { onSource?.(entry); } catch { /* a listener must never break a lookup */ }
    };

    for (const { name, configured, reason } of collectors) {
        try {
            onSource?.({
                name, label: PRICE_SOURCE_LABELS[name] || name,
                state: configured ? 'asking' : 'skipped',
                reason: configured ? '' : (reason || 'not available'),
            });
        } catch { /* ignore */ }
    }

    const settled = await Promise.allSettled(collectors.map(async ({ name, configured, reason, run }) => {
        const label = PRICE_SOURCE_LABELS[name] || name;
        if (!configured) {
            report({ name, label, state: 'skipped', quotes: 0, reason: reason || 'not available' });
            return [];
        }
        const startedAt = Date.now();
        try {
            const quotes = await run();
            report({ name, label, state: quotes.length ? 'answered' : 'empty', quotes: quotes.length, ms: Date.now() - startedAt });
            return quotes;
        } catch (err) {
            const failure = err instanceof SourceUnavailable
                ? err.failure
                : describeAxiosError(err, { usesKey: SOURCE_USES_KEY[name] !== false });
            noteSource(name, failure);
            report({ name, label, state: 'failed', quotes: 0, ms: Date.now() - startedAt, reason: failure.message, kind: failure.kind });
            console.error(`  [Pricing] ${name} failed for "${card.card_name}":`, err.message);
            return [];
        }
    }));

    const quotes = settled.flatMap(r => (r.status === 'fulfilled' ? r.value : []));
    const result = await aggregateQuotes(quotes, { axios, context: ctx });
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

/**
 * Price a card and say how far to trust the answer.
 *
 * This is the only way anything should ask for a price. `lookupMarketPrice`
 * knows what the marketplaces said; it does not know how sure we are that they
 * were asked about the right card. That second question used to be answered by
 * not calling it at all when the printing was unconfirmed, which is why cards
 * the app had read perfectly showed no value and were parked in a review queue.
 *
 * Now every identifiable card gets a number, carrying the tier and the sentence
 * that explains it. Nobody is asked to confirm anything.
 */
async function priceCard(card, { verified, why = '', answered = true, onSource, fresh = false, interactive = false } = {}) {
    const market = await lookupMarketPrice(card, { onSource, fresh, interactive });
    const price = Number(market?.price) || 0;

    // When there is no price the reason worth showing is why the lookup came
    // back empty, not why verification fell short — the user cannot act on the
    // latter and it would read as though the card is unpriceable.
    const tier = tierFor({
        verified,
        price,
        answered,
        why: price > 0 ? why : (market?.sourcesUnavailable ? 'no price source could be reached' : why),
    });

    // An unconfirmed card whose databases could not be reached is reported as
    // having no price, whatever a marketplace happened to say. The figure is
    // dropped rather than shown, because a number nothing corroborates is worse
    // than an admission — this is what put four-figure cards in the collection
    // total on the back of lookups that never completed.
    if (!(price > 0) || tier.unreached) {
        return {
            ...(market || {}),
            price: 0,
            tier: tier.tier,
            tierLabel: tier.label,
            explanation: tier.unreached ? tier.explanation : explainNoPrice(market),
            unreached: Boolean(tier.unreached),
        };
    }

    return {
        ...market,
        tier: tier.tier,
        tierLabel: tier.label,
        explanation: tier.explanation,
        // Two uncertainties, both in the number the user sees: how well the
        // sources agreed, and whether they were asked about the right card.
        confidence: scaleConfidence(market.confidence, tier.tier),
        sourceConfidence: market.confidence,
    };
}

/**
 * Say why a card has no price, naming the sources rather than the outcome.
 *
 * "No marketplace quotes a price for this card yet" is true and useless. It
 * reads as a fact about the card when it is usually a fact about the server:
 * a card printed in 2026 will not be in any free catalogue for months, and eBay
 * — the one source that lists it the day it exists — is skipped entirely when
 * no credentials are configured. Somebody looking at that message has no way to
 * know the only source that could have helped was never asked.
 */
function explainNoPrice(market) {
    const sources = market?.sources || [];
    if (!sources.length) return 'No price yet — no price source was reached.';

    const label = (s) => (s.label || s.name).replace(/\s*\(.*\)$/, '');
    /** "a", "a and b", "a, b and c" — a list a person would actually write. */
    const listOf = (names) => names.length <= 1
        ? (names[0] || '')
        : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
    const missingKeys = sources.filter(s => s.state === 'skipped' && /credential|API key|no key/i.test(s.reason || ''));
    const failed = sources.filter(s => s.state === 'failed');
    const empty = sources.filter(s => s.state === 'empty' || s.state === 'answered');

    // The actionable case first: a source that could have answered was never
    // asked, because the server is missing its keys.
    if (missingKeys.length) {
        const names = listOf(missingKeys.map(label));
        return `No price yet — ${names} ${missingKeys.length === 1 ? 'was' : 'were'} not asked, because `
            + `${missingKeys.length === 1 ? 'its' : 'their'} credentials are not configured on the server. `
            + `${empty.length ? `The ${empty.length} source${empty.length === 1 ? '' : 's'} that were asked have no listing for this printing. ` : ''}`
            + 'A card this new is often only on eBay.';
    }

    if (failed.length && !empty.length) {
        return `No price yet — every source failed to answer (${listOf(failed.map(label))}). The app will try again.`;
    }

    const asked = sources.filter(s => s.state !== 'skipped').map(label);
    if (asked.length) {
        return `No price yet — ${listOf(asked)} ${asked.length === 1 ? 'has' : 'have'} no listing for this exact printing. `
            + 'The app tries again on every refresh.';
    }
    return 'No price yet — no price source was available to ask.';
}

/**
 * Save a price only when it is at least as trustworthy as the one already
 * stored, so a refresh that happens to miss verification cannot quietly
 * downgrade a card that was priced correctly yesterday.
 */
async function storePriceIfBetter(cardId, priced, existingTier) {
    if (!(priced?.price > 0)) return false;
    if (!shouldReplace(existingTier, priced.tier)) return false;
    await insertPricePoint(cardId, priced.price, priced.source || 'market', priced.url || '');
    await updatePortfolioCardMarketData(cardId, priced);
    return true;
}

// ═══════════════════════════════════════════════════════════════
//  SSE (Server-Sent Events) for real-time updates
// ═══════════════════════════════════════════════════════════════

const sseClients = new Set();

/**
 * The collection payload, cached between writes.
 *
 * Building /api/portfolio costs a fan of Neon queries and about 1.1MB of
 * egress at the collection's real size — and Neon meters egress at 5GB a
 * month on the free plan. The payload only actually changes when something is
 * written, and every write path already announces itself over SSE, so the
 * broadcast below doubles as the cache invalidation: one choke point, no
 * write path to forget.
 */
const portfolioCache = new Map();
const PORTFOLIO_CACHE_MS = 5 * 60 * 1000;
const PORTFOLIO_MUTATIONS = new Set(['portfolio_updated', 'card_added']);

function invalidatePortfolioCache() {
    portfolioCache.clear();
}

function broadcast(event) {
    if (PORTFOLIO_MUTATIONS.has(event?.type)) invalidatePortfolioCache();
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
let reviewRecheckRunning = false;
let gridRescanRunning = false;

/**
 * How long to wait between cards during a bulk refresh.
 *
 * The Pokémon TCG API allows far more requests with a key than without, and
 * the old fixed 1.2s gap was calibrated for neither: each card issues one or
 * two requests, so 1.2s put a keyless run at 50–100 requests a minute against
 * a limit of roughly 30. The refresh was rate-limiting itself, and a
 * rate-limited lookup returns nothing, which is indistinguishable from a card
 * having no price. Pacing to the tier we are actually on is the fix.
 */
const REFRESH_PACE_MS = POKEMON_TCG_KEY ? 700 : 2500;

/**
 * Wait out a rate-limit cooldown rather than burning cards against it.
 *
 * Without this, hitting a limit mid-run marked five cards unreachable in quick
 * succession and aborted the whole refresh. A limit is a "come back shortly",
 * not a failure, so the run pauses and continues.
 */
async function pacePriceRequests() {
    const cooling = sourceCooldownRemaining('pokemontcg');
    if (cooling > 0) {
        const wait = Math.min(cooling, 90 * 1000);
        console.log(`  [PriceRefresh] Rate limited — pausing ${Math.ceil(wait / 1000)}s before continuing.`);
        broadcastActivity('info', `Rate limited by the card database — pausing ${Math.ceil(wait / 1000)}s.`);
        await sleep(wait);
        return;
    }
    await sleep(REFRESH_PACE_MS);
}


// Batched refresh: process N cards (for Vercel cron, N=5 to fit in 10s timeout)
async function refreshBatchPrices(batchSize = 5) {
    if (priceRefreshRunning) {
        console.log('  [PriceRefresh] Already running, skipping.');
        return { skipped: true };
    }
    priceRefreshRunning = true;

    try {
        // Pick the N cards that haven't been checked in the longest (or never).
        //
        // Unconfirmed cards are in scope here too. Excluding them meant the
        // cards most in need of a price were the only ones a scheduled run
        // never looked at. This path does not re-verify — that costs a lookup
        // this batch has no time budget for, and the full refresh does it — so
        // an unconfirmed card is priced as an estimate and re-verified there.
        const res = await pool.query(`
            SELECT id, card_name, card_name_en, card_set, set_code, card_number, rarity, condition, is_holo, is_first_edition, confidence, image_url, year, language, holo_type, current_price, needs_review, price_tier, price_explanation, types
            FROM portfolio_cards
            -- A source photo is not a card: never listed, never priced.
            WHERE COALESCE(is_source_photo, 0) = 0
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
                // Artwork only for a confirmed printing: the picture is shown
                // in preference to Jack's own photo, so on an unconfirmed card
                // it would assert an identity nothing has established.
                if (!card.needs_review && (!card.image_url || card.image_url.includes('undefined'))) {
                    let imageUrl = await fetchCardImageFromTCGdex(card.card_name, card.card_set, card.card_number);
                    if (!imageUrl) imageUrl = await fetchCardImageFromPokemonTCG(card.card_name, card.card_set, card.card_number);
                    if (imageUrl) await updateCardImageUrl(card.id, imageUrl);
                }

                const result = await priceCard(card, {
                    verified: !card.needs_review,
                    why: 'the exact printing could not be confirmed',
                    fresh: true,
                });
                if (result && result.price > 0) {
                    if (await storePriceIfBetter(card.id, result, card.price_tier)) updated++;
                    else await markPriceChecked(card.id);
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
        // Unconfirmed cards are included, not skipped.
        //
        // They used to be excluded, which meant a card the scanner could not
        // place stayed unplaced forever unless a person went and pressed
        // something. That is the app handing its own unfinished work to the
        // user. A card database gains sets over time and the matching code
        // improves, so the right behaviour is to quietly try again on every
        // scheduled run until it resolves.
        const res = await pool.query(`
            SELECT id, card_name, card_name_en, card_set, set_code, card_number, rarity, condition, is_holo, is_first_edition, confidence, image_url, year, language, holo_type, current_price, needs_review, price_tier, price_explanation, types
            FROM portfolio_cards
            -- A source photo is not a card: never listed, never priced.
            WHERE COALESCE(is_source_photo, 0) = 0
            ORDER BY COALESCE(needs_review, 0) DESC, last_price_check ASC NULLS FIRST, id ASC
        `);
        const cards = res.rows;
        let updated = 0;
        let unavailable = 0;
        let resolved = 0;
        let typed = 0;

        for (let i = 0; i < cards.length; i++) {
            const card = cards[i];
            try {
                // Artwork only for a confirmed printing: the picture is shown
                // in preference to Jack's own photo, so on an unconfirmed card
                // it would assert an identity nothing has established.
                if (!card.needs_review && (!card.image_url || card.image_url.includes('undefined'))) {
                    let imageUrl = await fetchCardImageFromTCGdex(card.card_name, card.card_set, card.card_number);
                    if (!imageUrl) imageUrl = await fetchCardImageFromPokemonTCG(card.card_name, card.card_set, card.card_number);
                    if (imageUrl) {
                        await updateCardImageUrl(card.id, imageUrl);
                        console.log(`  [PriceRefresh] Found image for ${card.card_name}`);
                    }
                }

                // An unconfirmed card gets one more attempt at being identified
                // before it is priced — a database gains sets over time, so a
                // card that could not be placed last week may place today.
                //
                // If it still does not, the refresh carries on and prices it as
                // an estimate rather than skipping it. Skipping is what left
                // cards sitting at no value indefinitely, each run quietly
                // deciding to do nothing.
                let subject = card;
                let unverifiedReason = '';
                let databasesAnswered = true;
                if (card.needs_review) {
                    forgetCandidates(card);
                    const { verified, why, answered } = await verifyWithReason({
                        ...card,
                        confidence: Math.max(Number(card.confidence) || 0, 0.9),
                    });
                    if (verified) {
                        await applyVerifiedIdentity(card.id, verified);
                        subject = { ...card, ...verified, needs_review: 0 };
                        resolved++;
                        broadcastActivity('info', `Identified ${verified.card_name} (${verified.card_set}) — priced against that exact printing.`);
                    } else {
                        unverifiedReason = why || 'the exact printing could not be confirmed';
                        databasesAnswered = answered;
                    }
                }

                // Cards added before types were captured get them here, on the
                // back of the lookup the pricing below is about to make anyway.
                if (!subject.types) {
                    const types = await backfillTypesIfMissing(subject);
                    if (types) { subject = { ...subject, types }; typed++; }
                }

                // `fresh` matters here: the whole point of a refresh is to go
                // out to the marketplaces again, and a warm in-process cache
                // would otherwise turn the run into a no-op.
                const result = await priceCard(subject, {
                    verified: !subject.needs_review,
                    why: unverifiedReason,
                    answered: databasesAnswered,
                    fresh: true,
                });
                if (result && result.price > 0) {
                    // `storePriceIfBetter` rather than a plain write: a refresh
                    // that failed verification this time must not overwrite a
                    // price that was confirmed on an earlier run, or the
                    // collection total would drift downward with nothing to
                    // show why.
                    if (await storePriceIfBetter(card.id, result, card.price_tier)) {
                        updated++;
                        broadcastActivity('price_update', `${card.card_name}: $${result.price.toFixed(2)} (${result.tierLabel.toLowerCase()}, ${result.source})`);
                    } else {
                        await markPriceChecked(card.id);
                    }
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

                // The day's eBay allowance is spent. Carrying on would price
                // the remaining cards from catalogues alone and record that
                // thinner answer as though it were the best available, so the
                // run stops here and resumes tomorrow — the queue is ordered by
                // last checked, so it picks up exactly where it left off.
                const spend = await ebayBudget.state();
                if (spend.exhausted && EBAY_APP_ID && EBAY_CERT_ID) {
                    const left = cards.length - (i + 1);
                    console.log(`  [PriceRefresh] eBay allowance spent (${spend.used}/${spend.limit}); pausing with ${left} card(s) to go.`);
                    broadcastActivity('info',
                        `Priced ${updated} card${updated === 1 ? '' : 's'}. eBay's daily allowance is now spent, `
                        + `so the remaining ${left} will be picked up tomorrow — the queue resumes where it stopped.`);
                    break;
                }

                if (!result?.cached) await pacePriceRequests();
            } catch (err) {
                console.error(`  [PriceRefresh] Error for ${card.card_name}:`, err.message);
                await markPriceChecked(card.id).catch(() => {});
            }
        }

        console.log(`  [PriceRefresh] Complete. Updated ${updated}/${cards.length} cards, identified ${resolved}, typed ${typed}.`);
        broadcastActivity('refresh_complete', [
            `Updated prices for ${updated} card${updated === 1 ? '' : 's'}`,
            resolved ? `identified ${resolved} that had been awaiting review` : '',
            unavailable ? `${unavailable} could not be reached` : '',
        ].filter(Boolean).join('; ') + '.');
        broadcast({ type: 'portfolio_updated' });
        return { updated, total: cards.length, unavailable, resolved, typed };
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
            const info = describeAxiosError(err, { usesKey: SOURCE_USES_KEY[name] !== false });
            return {
                name, label, ok: false, ms: Date.now() - started,
                detail: info.message, kind: info.kind,
                // A request stopped before it left the building is not a
                // credentials problem, and saying "check the key" would send
                // you to rotate one that was working fine.
                hint: info.kind === 'blocked'
                    ? 'This host is being refused by an outbound network rule. Allow it in the platform\'s egress settings — no key change will help.'
                    : hint,
            };
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
        }, POKEMON_TCG_KEY
            ? 'A key is set. If this is rejected, the key is wrong or revoked — get a new one at https://pokemontcg.io'
            : 'Set POKEMON_TCG_KEY — without one this API rate limits quickly and every lookup fails'),

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
    if (EBAY_APP_ID && EBAY_CERT_ID) {
        checks.push(await probe('ebay', 'Live market (eBay)', async () => {
            const token = await ebayAccessToken();
            if (!token) throw new Error('Credentials were rejected');
            const r = await axios.get('https://api.ebay.com/buy/browse/v1/item_summary/search', {
                params: { q: 'pokemon charizard 4/102', category_ids: '183454', limit: 5 },
                headers: { Authorization: `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': EBAY_MARKETPLACE },
                timeout: 12000,
            });
            return `${r.data?.total ?? 0} listings found for a test card`;
        }, 'Check EBAY_APP_ID and EBAY_CERT_ID are the PRODUCTION keyset, not sandbox'));
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
        // One tiny query decides whether the expensive fan of queries runs.
        // The stamp moves on ANY write to the underlying tables — the app's
        // own, a migration's, or a SQL console's — so the cache can be
        // aggressive without ever being able to lie.
        const rev = await pool.query("SELECT value FROM app_meta WHERE key = 'collection_rev'");
        const stamp = rev.rows[0]?.value || '0';

        const cached = portfolioCache.get(req.user.id);
        if (cached && cached.stamp === stamp && Date.now() - cached.at < PORTFOLIO_CACHE_MS) {
            res.setHeader('X-Cache', 'HIT');
            return res.json(cached.payload);
        }
        const cards = await getAllPortfolioCards(req.user.id);
        const stats = computePortfolioStats(cards);
        const payload = { cards, stats, pricing: { fx: fxStatus(), conditions: CONDITIONS } };
        portfolioCache.set(req.user.id, { at: Date.now(), stamp, payload });
        res.setHeader('X-Cache', 'MISS');
        res.json(payload);
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
/**
 * Where one card came from, and whether anything of Jack's is behind it.
 *
 * This exists because of a question the app could not answer: "I don't think I
 * own that card — did I upload that image?" Nothing on screen distinguished a
 * card photographed in the room from a card the app inferred and then
 * illustrated with stock artwork downloaded from a database. The two looked
 * identical, so a wrong entry was indistinguishable from a right one.
 *
 * They are different things and this says which:
 *
 *   picture_shown  what the tile and sheet display. `database` means official
 *                  artwork fetched from api.pokemontcg.io or tcgdex.net — a
 *                  picture of the card, not a picture of YOUR card.
 *   scan_photo     whether a photograph taken during a scan is on file. This is
 *                  the only evidence the physical card was ever in front of a
 *                  camera. `false` means it was never scanned.
 *   from_spread    the id of the multi-card photo it was extracted from, if it
 *                  came out of one rather than a scan of its own.
 */
app.get('/api/portfolio/:id/provenance', requireAuth, async (req, res) => {
    try {
        const { rows } = await pool.query(`
            SELECT pc.id, pc.card_name, pc.card_set, pc.card_number, pc.added_at,
                   pc.image_url, pc.verified_source, pc.source_photo_id, pc.confidence,
                   pc.price_tier, pc.price_source,
                   (pc.image_data IS NOT NULL AND pc.image_data <> '') AS card_photo,
                   (SELECT COUNT(*)::int FROM card_copies cc
                     WHERE cc.card_id = pc.id AND cc.image_data <> '') AS copy_photos,
                   (SELECT MIN(cc.created_at) FROM card_copies cc WHERE cc.card_id = pc.id) AS first_copy_at
            FROM portfolio_cards pc
            WHERE pc.id = $1 AND pc.user_id = $2
        `, [parseInt(req.params.id, 10), req.user.id]);

        if (!rows.length) return res.status(404).json({ error: 'Card not found' });
        const r = rows[0];
        const hasScanPhoto = Boolean(r.card_photo) || r.copy_photos > 0;

        // Which host the artwork came from, named rather than implied — the
        // point of the answer is that it is somebody else's picture.
        let artworkFrom = '';
        if (r.image_url) {
            if (/pokemontcg\.io/i.test(r.image_url)) artworkFrom = 'the Pokémon TCG database (images.pokemontcg.io)';
            else if (/tcgdex/i.test(r.image_url)) artworkFrom = 'TCGdex (assets.tcgdex.net)';
            else artworkFrom = new URL(r.image_url).host;
        }

        res.json({
            success: true,
            id: r.id,
            card_name: r.card_name,
            added_at: r.added_at,
            first_seen_at: r.first_copy_at || r.added_at,
            picture_shown: r.image_url ? 'database' : (hasScanPhoto ? 'your photo' : 'none'),
            artwork_url: r.image_url || '',
            artwork_from: artworkFrom,
            scan_photo: hasScanPhoto,
            scan_photo_count: (r.card_photo ? 1 : 0) + r.copy_photos,
            from_spread: r.source_photo_id || null,
            identified_by: r.verified_source || '',
            read_confidence: Number(r.confidence) || 0,
            price_tier: r.price_tier || '',
            price_source: r.price_source || '',
        });
    } catch (err) {
        console.error('Provenance error:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * Scan photos, without paying Neon for every look at them.
 *
 * The photos live inside Postgres, and Neon's free plan meters what leaves the
 * database — 5GB a month. This endpoint used to SELECT the image out of Neon on
 * every single view, so browsing the collection billed the full weight of every
 * photo against that meter again and again until the project was suspended and
 * the whole app went down with "Your project has exceeded the data transfer
 * quota".
 *
 * Two layers now stand between a view and the meter:
 *
 *  - an in-process cache, so each photo leaves Neon roughly once per boot
 *    rather than once per look;
 *  - an ETag with a week of browser caching, so a phone that has seen a photo
 *    does not even ask again — and when it revalidates, the 304 carries no
 *    image bytes from anywhere.
 */
const imageCache = new Map();
const IMAGE_CACHE_MAX_BYTES = 64 * 1024 * 1024;
let imageCacheBytes = 0;

function cacheImage(id, imageData) {
    const size = imageData.length;
    if (size > IMAGE_CACHE_MAX_BYTES / 4) return;   // one huge photo must not evict everything
    while (imageCacheBytes + size > IMAGE_CACHE_MAX_BYTES && imageCache.size) {
        const oldest = imageCache.keys().next().value;
        imageCacheBytes -= imageCache.get(oldest).imageData.length;
        imageCache.delete(oldest);
    }
    const etag = `"${createHash('sha1').update(imageData).digest('hex').slice(0, 20)}"`;
    imageCache.set(id, { imageData, etag });
    imageCacheBytes += size;
    return imageCache.get(id);
}

/** Call wherever image_data is rewritten, or a stale photo outlives its card. */
function forgetCachedImage(id) {
    const hit = imageCache.get(id);
    if (hit) {
        imageCacheBytes -= hit.imageData.length;
        imageCache.delete(id);
    }
}

app.get('/api/portfolio/:id/image', requireAuth, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        let hit = imageCache.get(id);
        if (!hit) {
            const result = await pool.query(
                'SELECT image_data FROM portfolio_cards WHERE id = $1', [id]);
            if (!result.rows.length || !result.rows[0].image_data) {
                return res.status(404).json({ error: 'No image' });
            }
            hit = cacheImage(id, result.rows[0].image_data)
                || { imageData: result.rows[0].image_data, etag: '' };
        } else {
            // Refresh recency for the byte-bounded eviction above.
            imageCache.delete(id); imageCache.set(id, hit);
        }

        if (hit.etag) {
            res.setHeader('ETag', hit.etag);
            res.setHeader('Cache-Control', 'private, max-age=604800');
            if (req.headers['if-none-match'] === hit.etag) return res.status(304).end();
        }
        res.json({ image_data: hit.imageData });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Delete a card from portfolio
app.delete('/api/portfolio/:id', requireAuth, async (req, res) => {
    try {
        await deletePortfolioCard(parseInt(req.params.id), req.user.id);
        forgetCachedImage(parseInt(req.params.id, 10));
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
            card_name_en: req.body.card_name_en ?? before.card_name_en ?? '',
            card_set: req.body.card_set ?? before.card_set,
            set_code: req.body.set_code ?? before.set_code ?? '',
            card_number: req.body.card_number ?? before.card_number,
            holo_type: req.body.holo_type ?? before.holo_type,
            language: normalizeLanguage(req.body.language ?? before.language),
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
            SET card_name = $2, card_name_en = $3, card_set = $4, set_code = $5,
                card_number = $6, holo_type = $7,
                language = $8, rarity = $9, is_first_edition = $10, is_holo = $11,
                -- needs_review is not cleared here, only by a successful
                -- re-verify below. An edit is a claim about the card, not a
                -- confirmation of it, and the retry that would eventually turn
                -- an estimate into a market price hangs off this flag.
                variant_key = $12, last_price_check = NULL
            WHERE id = $1 AND user_id = $13
        `, [
            cardId, merged.card_name, merged.card_name_en, merged.card_set, merged.set_code,
            merged.card_number, merged.holo_type,
            merged.language, merged.rarity, merged.is_first_edition, merged.is_holo,
            variantKey, req.user.id,
        ]);

        // The price and its history belong to the old printing. A typo fix in a
        // set name leaves the identity alone and keeps both; a genuine change of
        // printing invalidates them, and carrying the old figure forward is how
        // a card came to show a confident price for something it is not.
        if (identityChanged) {
            await pool.query('DELETE FROM price_history WHERE card_id = $1', [cardId]);
            await clearStalePrice(cardId);
        }

        // The correction is honoured as given and the card is re-verified
        // against it, because a confirmed printing is worth far more than an
        // estimate. Failing to confirm no longer costs the card its price
        // though — someone who has just typed in the right set and number
        // should not be told their correction produced nothing.
        forgetCandidates(merged);
        const { verified, why, answered } = await verifyWithReason({ ...merged, confidence: 0.95 });
        let priceNote = '';

        const subject = verified ? { ...merged, ...verified } : merged;
        if (verified) {
            await applyVerifiedIdentity(cardId, verified);
        } else {
            // Set explicitly rather than left alone: a card edited into a
            // printing that cannot be confirmed is unconfirmed now, even if it
            // was confirmed a moment ago, and the refresh should keep trying.
            await pool.query('UPDATE portfolio_cards SET needs_review = 1 WHERE id = $1', [cardId]);
        }

        const market = await priceCard(subject, {
            verified: Boolean(verified),
            why: why || 'the exact printing could not be confirmed',
            answered,
            fresh: true,
            interactive: true,
        });

        if (market?.price > 0) {
            await insertPricePoint(cardId, market.price, market.source, market.url || '');
            await updatePortfolioCardMarketData(cardId, market);
            priceNote = verified
                ? `Confirmed and priced at $${market.price.toFixed(2)}.`
                : `Saved your correction and priced at $${market.price.toFixed(2)}. ${market.explanation}`;
        } else {
            await markPriceChecked(cardId);
            priceNote = verified
                ? 'Confirmed, but no marketplace quotes a price for this printing.'
                : 'Saved your correction, but no marketplace quotes a price for this card yet. It will be tried again on the next refresh.';
        }

        const after = await pool.query('SELECT current_price, price_source, price_confidence, needs_review FROM portfolio_cards WHERE id = $1', [cardId]);
        const row = after.rows[0] || {};

        broadcast({ type: 'portfolio_updated' });
        res.json({
            success: true,
            identityChanged,
            confirmed: Boolean(verified),
            message: priceNote,
            price: Number(row.current_price) || 0,
            source: row.price_source || 'not_found',
            confidence: Number(row.price_confidence) || 0,
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

        // Re-pricing a card that was never confirmed means re-verifying it
        // first: the fields may have been corrected by hand since, and a
        // confirmed printing is worth far more than an estimate.
        //
        // But failing to confirm no longer ends the request. It used to return
        // `status:'unconfirmed'` with no price at all, on the theory that a
        // price we cannot pin to a printing is not worth having — which left
        // the user pressing Re-price on a card that had been read perfectly and
        // watching nothing happen. It is priced either way now; only the label
        // differs.
        let subject = card;
        let clearedReview = false;
        let unverifiedReason = card.price_explanation || '';
        let databasesAnswered = true;
        if (card.needs_review) {
            forgetCandidates(card);
            const { verified, why, answered } = await verifyWithReason({
                ...card,
                // The stored confidence is the AI's read of the photo. Re-verifying
                // works from the fields as they now stand, which the person may
                // have corrected by hand, so it must not be gated on that.
                confidence: Math.max(Number(card.confidence) || 0, 0.9),
            });
            if (verified) {
                await applyVerifiedIdentity(cardId, verified);
                subject = { ...card, ...verified, needs_review: 0 };
                clearedReview = true;
            } else {
                unverifiedReason = why || 'the exact printing could not be confirmed';
                databasesAnswered = answered;
            }
        }

        // `fresh` clears both the price cache and the candidate memo: the point
        // of asking is to get a new answer, not a fast one.
        const market = await priceCard(subject, {
            verified: !subject.needs_review,
            why: unverifiedReason,
            answered: databasesAnswered,
            fresh: true,
            interactive: true,
        });
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
            message = isNonEnglish(subject.language)
                // Not a failure to find the card — a real gap in the data. The
                // English marketplaces are deliberately not substituted here.
                ? `Confirmed as a ${languageLabel(subject.language)} printing, but no marketplace quotes a price for it. English prices are not used as a stand-in because they are not this card's price.`
                : 'No marketplace listing found for this exact printing.';
        } else if (Math.abs(delta) < 0.005) {
            status = 'unchanged';
            message = `Still $${price.toFixed(2)} — re-checked against ${market.quotesUsed} of ${market.quotesSeen} quotes.`;
        } else {
            message = `${previousPrice > 0 ? `$${previousPrice.toFixed(2)} → ` : ''}$${price.toFixed(2)} (${delta > 0 ? '+' : ''}$${delta.toFixed(2)}) from ${market.quotesUsed} of ${market.quotesSeen} quotes.`;
        }

        if (clearedReview) {
            message = `Confirmed as ${subject.card_name}`
                + `${subject.card_set ? ` (${subject.card_set}${subject.card_number ? ` ${subject.card_number}` : ''})` : ''}`
                + `. ${message}`;
        } else if (market?.tier === 'estimated' && price > 0) {
            // Said once, plainly, so the number is not mistaken for a confirmed
            // market price — and so pressing Re-price again is understood to be
            // pointless rather than untried.
            message = `${message} ${market.explanation}`;
        }

        broadcast({ type: 'portfolio_updated' });
        res.json({
            success: true,
            status,
            message,
            clearedReview,
            // The card's price after this attempt. On an outage that is the one
            // it already had, not the zero the lookup came back with.
            price: status === 'sources_unavailable' ? previousPrice : price,
            previousPrice,
            delta,
            changed: status === 'priced',
            source: market?.source || 'not_found',
            marketplace: market?.marketplace || '',
            confidence: market?.confidence || 0,
            tier: market?.tier || 'unpriced',
            tierLabel: market?.tierLabel || '',
            explanation: market?.explanation || '',
            // Only a card with no price at all is still waiting on anything,
            // and even then it is waiting on a marketplace, not on the user.
            needsReview: !(price > 0) && Boolean(card.needs_review),
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
 * Re-check every card in Needs review.
 *
 * Correcting cards one at a time is the wrong shape for a shelf of cards the
 * scanner could not confirm — especially since the most common reason was a
 * fixable one (a non-English card the identity code could not read at all).
 * This walks the whole list, re-verifies each, and prices the ones that now
 * confirm. Cards that still cannot be confirmed are left unpriced rather than
 * given a plausible wrong number.
 */
app.post('/api/portfolio/recheck-review', requireAuth, async (req, res) => {
    if (reviewRecheckRunning) {
        return res.status(409).json({ error: 'A re-check is already running.' });
    }
    reviewRecheckRunning = true;
    try {
        const { rows } = await pool.query(
            `SELECT * FROM portfolio_cards
             WHERE user_id = $1 AND COALESCE(needs_review, 0) = 1 AND COALESCE(is_source_photo, 0) = 0
             ORDER BY id ASC`,
            [req.user.id]);

        res.json({ success: true, started: rows.length, message: `Re-checking ${rows.length} card${rows.length === 1 ? '' : 's'}…` });

        // The response is already sent; this continues in the background and
        // reports itself over SSE, because a shelf of cards takes minutes.
        (async () => {
            let confirmed = 0;
            let priced = 0;
            let estimated = 0;
            let stillUnknown = 0;

            for (let i = 0; i < rows.length; i++) {
                const card = rows[i];
                try {
                    forgetCandidates(card);
                    const { verified, why, answered } = await verifyWithReason({
                        ...card,
                        confidence: Math.max(Number(card.confidence) || 0, 0.9),
                    });

                    if (verified) {
                        await applyVerifiedIdentity(card.id, verified);
                        confirmed++;
                    }

                    // Priced either way. A card that cannot be confirmed is not
                    // a card we know nothing about — the name, number and
                    // language are all in hand, which is enough for an estimate
                    // and far more useful than another run of nothing.
                    const market = await priceCard(verified ? { ...card, ...verified } : card, {
                        verified: Boolean(verified),
                        why: why || 'the exact printing could not be confirmed',
                        answered,
                        fresh: true,
                    });

                    if (await storePriceIfBetter(card.id, market, card.price_tier)) {
                        priced++;
                        if (market.tier === 'estimated') estimated++;
                    } else {
                        if (!(market?.price > 0)) stillUnknown++;
                        await markPriceChecked(card.id).catch(() => {});
                    }
                } catch (err) {
                    console.error(`  [Recheck] ${card.card_name}:`, err.message);
                    stillUnknown++;
                }

                broadcast({
                    type: 'recheck_progress',
                    done: i + 1, total: rows.length, confirmed, priced, stillUnknown,
                    card_name: card.card_name,
                });
                await pacePriceRequests();
            }

            broadcastActivity('recheck_complete',
                `Re-checked ${rows.length} card${rows.length === 1 ? '' : 's'}: `
                + `${confirmed} confirmed against an exact printing, ${priced} priced`
                + `${estimated ? ` (${estimated} as estimates)` : ''}`
                + `${stillUnknown ? `, ${stillUnknown} with no marketplace price yet` : ''}.`);
            broadcast({ type: 'portfolio_updated' });
        })().catch(err => console.error('Recheck error:', err))
            .finally(() => { reviewRecheckRunning = false; });
    } catch (err) {
        reviewRecheckRunning = false;
        console.error('Recheck error:', err);
        if (!res.headersSent) res.status(500).json({ error: err.message });
    }
});

/**
 * Check the copy counts against the photos that produced them.
 *
 * Quantity is the only number here no marketplace can verify, and the
 * collection total is quantity × price — so a card photographed twice does not
 * merely clutter the list, it overstates what the collection is worth. Every
 * copy kept the thumbnail of the scan that created it, so the question is
 * answerable from data the app already holds.
 *
 * Read-only. Deleting a copy someone owns is worse than leaving a duplicate, so
 * this only reports; the correction is a separate, explicit call.
 */
/**
 * The source photos: pictures of many cards, listed as photos rather than cards.
 *
 * These are what the collection was built from — binder pages and tabletop
 * layouts, six or eight cards across. They are deliberately absent from
 * /api/portfolio, so the app can show them as what they are: material still
 * waiting to be read, not twenty-card "cards" that no marketplace can price.
 */
/**
 * The books: every card, what it is worth, and what that figure rests on.
 *
 * This exists because the collection reached $20,000 and could not account for
 * it. The question "where did this card come from and why does it say that
 * number" had no answer in the app, so speculation and evidence looked
 * identical once they were both a row in a list.
 *
 * Each card is placed in exactly one bucket, and the buckets sum to the total.
 * A card is in the first bucket it qualifies for, so nothing is counted twice:
 *
 *   confirmed  the printing was matched to a database and priced against it
 *   estimated  priced, but the exact printing was never confirmed
 *   unpriced   no marketplace quotes it yet
 *
 * Separately, and independently of price: does a photograph of this card exist?
 * A card with no photo was never scanned — it came out of a spread photo, or an
 * import — and that is the first thing to check when an entry looks wrong.
 */
/**
 * The raw row counts, straight from SQL, next to the database they came from.
 *
 * Because the app said 1,474 cards while the Neon console showed 657 rows, and
 * there was no way to tell which was wrong — or whether the two were even
 * looking at the same database. Render and the Neon console can easily point at
 * different branches, and nothing in the app said which one it had connected to.
 *
 * Every number here is a plain COUNT(*) with no joins, no filters and no
 * derivation, so it can be compared against the console directly. The host and
 * database name are reported too; the credentials are not.
 */
app.get('/api/portfolio/reconcile', requireAuth, async (req, res) => {
    try {
        const counts = await pool.query(`
            SELECT
                (SELECT COUNT(*)::int FROM portfolio_cards)                                          AS rows_all_users,
                (SELECT COUNT(*)::int FROM portfolio_cards WHERE user_id = $1)                       AS rows_yours,
                (SELECT COUNT(*)::int FROM portfolio_cards WHERE user_id = $1
                   AND COALESCE(is_source_photo,0) = 1)                                              AS source_photos,
                (SELECT COUNT(*)::int FROM portfolio_cards WHERE user_id = $1
                   AND COALESCE(is_source_photo,0) = 0)                                              AS cards_listed,
                (SELECT COUNT(*)::int FROM card_copies cc JOIN portfolio_cards pc ON pc.id = cc.card_id
                   WHERE pc.user_id = $1 AND COALESCE(pc.is_source_photo,0) = 0)                     AS copies,
                (SELECT COUNT(DISTINCT variant_key)::int FROM portfolio_cards
                   WHERE user_id = $1 AND COALESCE(is_source_photo,0) = 0 AND variant_key <> '')     AS distinct_printings,
                (SELECT COUNT(*)::int FROM price_history)                                            AS price_points,
                (SELECT COUNT(*)::int FROM users)                                                    AS users
        `, [req.user.id]);

        // Which database this process is actually talking to. Answering from
        // the live connection rather than from the environment variable, so a
        // stale or overridden setting cannot misreport it.
        const where = await pool.query(
            'SELECT current_database() AS db, inet_server_addr()::text AS addr, version() AS version');
        let host = '';
        try {
            const url = new URL(process.env.DATABASE_URL || '');
            host = url.host;   // host:port only; no user, no password
        } catch { /* not a URL we can parse; leave it blank rather than guess */ }

        res.json({
            success: true,
            counts: counts.rows[0],
            database: {
                host,
                name: where.rows[0].db,
                server: (where.rows[0].version || '').split(' ').slice(0, 2).join(' '),
            },
            note: 'Every count is a plain SELECT COUNT(*) — compare them against the Neon console directly. '
                + 'If they disagree, the two are looking at different databases or branches.',
        });
    } catch (err) {
        console.error('Reconcile error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/portfolio/accounting', requireAuth, async (req, res) => {
    try {
        const cards = await getAllPortfolioCards(req.user.id);

        /**
         * Four states, not three. A card carrying a price but no tier was
         * priced by an earlier engine that recorded no provenance — no source,
         * no confidence, no printing. That is not a confirmed price and it is
         * not an estimate either; calling it either one is how the books came
         * to disagree with the collection totals, which is precisely the
         * "no solid accounting" being complained about. It gets its own line
         * and gets re-priced on the next refresh.
         */
        const bucket = (card) => {
            if (!(card.unit_price > 0)) return 'unpriced';
            if (card.price_tier === 'confirmed') return 'confirmed';
            if (card.price_tier === 'estimated') return 'estimated';
            return 'unverified';
        };

        const buckets = { confirmed: [], estimated: [], unverified: [], unpriced: [] };
        for (const card of cards) buckets[bucket(card)].push(card);

        const summarise = (list) => ({
            cards: list.length,
            copies: list.reduce((n, c) => n + c.quantity, 0),
            value: Number(list.reduce((n, c) => n + c.total_value, 0).toFixed(2)),
            withoutPhoto: list.filter(c => !c.has_photo).length,
        });

        const describe = (card) => ({
            id: card.id,
            card_name: card.card_name,
            card_set: card.card_set,
            card_number: card.card_number,
            language: card.language_label,
            quantity: card.quantity,
            unit_price: card.unit_price,
            total_value: card.total_value,
            tier: card.price_tier || '',
            source: card.price_source || '',
            confidence: card.price_confidence || 0,
            explanation: card.price_explanation || '',
            has_photo: Boolean(card.has_photo),
            from_source_photo: card.source_photo_id || null,
        });

        res.json({
            success: true,
            // Ordered most valuable first: a wrong number matters in proportion
            // to its size, so the entries worth auditing are at the top.
            confirmed: { ...summarise(buckets.confirmed), items: buckets.confirmed.map(describe) },
            estimated: { ...summarise(buckets.estimated), items: buckets.estimated.map(describe) },
            unverified: { ...summarise(buckets.unverified), items: buckets.unverified.map(describe) },
            unpriced: { ...summarise(buckets.unpriced), items: buckets.unpriced.map(describe) },
            withoutPhoto: cards.filter(c => !c.has_photo).map(describe),
            total: Number(cards.reduce((n, c) => n + c.total_value, 0).toFixed(2)),
        });
    } catch (err) {
        console.error('Accounting error:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * Every photo Jack ever uploaded, back out as one archive.
 *
 * The photos live inside Postgres as base64 data URLs; there is no folder on
 * Render or Neon to point a download at, and asking someone to copy base64 out
 * of a SQL console is not an answer. One click, one ZIP.
 *
 * Worth stating on the way out: these are the images AS STORED. Early scans
 * kept only a 400px thumbnail and discarded the original, so for those this is
 * everything that still exists — which is exactly why re-uploading fresh,
 * full-resolution photos is the right move, and why they are stored larger now.
 */
app.get('/api/portfolio/photos.zip', requireAuth, async (req, res) => {
    try {
        const cards = await pool.query(`
            SELECT id, card_name, image_data, COALESCE(is_source_photo, 0) AS is_source, added_at
            FROM portfolio_cards
            WHERE user_id = $1 AND image_data IS NOT NULL AND image_data <> ''
            ORDER BY id ASC
        `, [req.user.id]);
        const copies = await pool.query(`
            SELECT cc.id, cc.card_id, cc.image_data, cc.created_at, pc.card_name
            FROM card_copies cc
            JOIN portfolio_cards pc ON pc.id = cc.card_id
            WHERE pc.user_id = $1 AND cc.image_data IS NOT NULL AND cc.image_data <> ''
            ORDER BY cc.id ASC
        `, [req.user.id]);

        const files = [];
        const push = (name, dataUrl, mtime) => {
            const buffer = dataUrlToBuffer(dataUrl);
            if (buffer) files.push({ name, data: buffer, mtime: mtime ? new Date(mtime) : undefined });
        };
        for (const row of cards.rows) {
            const slug = safeEntryName(row.card_name, `card-${row.id}`);
            push(row.is_source
                ? `source-photos/photo-${row.id}.jpg`
                : `cards/${row.id}-${slug}.jpg`, row.image_data, row.added_at);
        }
        for (const row of copies.rows) {
            const slug = safeEntryName(row.card_name, `card-${row.card_id}`);
            push(`copies/${row.card_id}-${slug}-copy-${row.id}.jpg`, row.image_data, row.created_at);
        }

        const zip = buildZip(files);
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', 'attachment; filename="jackspokemon-photos.zip"');
        res.setHeader('Content-Length', zip.length);
        res.end(zip);
    } catch (err) {
        console.error('Photo export error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/portfolio/source-photos', requireAuth, async (req, res) => {
    try {
        const { rows } = await pool.query(`
            SELECT pc.id, pc.image_data, pc.source_cards_found, pc.source_extracted_at, pc.added_at,
                   (SELECT COUNT(*)::int FROM portfolio_cards c WHERE c.source_photo_id = pc.id) AS extracted
            FROM portfolio_cards pc
            -- A row with no stored image has nothing to show and nothing to
            -- read, so it is not offered as work.
            WHERE pc.user_id = $1 AND COALESCE(pc.is_source_photo, 0) = 1
              AND pc.image_data IS NOT NULL AND pc.image_data <> ''
            ORDER BY pc.id ASC
        `, [req.user.id]);

        res.json({
            success: true,
            photos: rows.map(r => ({
                id: r.id,
                image_data: r.image_data,
                cards_found: r.source_cards_found,
                extracted: r.extracted,
                done: Boolean(r.source_extracted_at),
            })),
            pending: rows.filter(r => !r.source_extracted_at).length,
            recognitionReady: Boolean(geminiModel),
        });
    } catch (err) {
        console.error('Source photos error:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * Read every card out of every source photo.
 *
 * This is the job the original uploads were for: a picture of a shelf goes in,
 * and every card in it comes out identified, cropped to itself and priced.
 *
 * Three properties it has to hold to be safe to run on a live collection:
 *
 *  - It only ever adds. A photo it cannot read leaves the collection exactly as
 *    it found it; losing a card Jack owns is far worse than failing to find one.
 *  - Cards are matched by the same variant key the scanner uses, so re-running
 *    it cannot double anything. One photograph is evidence of one shelf, not of
 *    a second copy of everything on it.
 *  - A row that turns out to hold exactly one card was never a spread at all —
 *    the shape test guessed wrong — so it goes back into the collection as the
 *    card it always was.
 */
app.post('/api/portfolio/extract-source-photos', requireAuth, async (req, res) => {
    if (gridRescanRunning) return res.status(409).json({ error: 'An extraction is already running.' });
    if (!geminiModel) return res.status(503).json({ error: 'Card recognition is not configured on this server.' });

    gridRescanRunning = true;
    try {
        const { rows } = await pool.query(`
            SELECT id, image_data FROM portfolio_cards
            WHERE user_id = $1 AND COALESCE(is_source_photo, 0) = 1 AND source_extracted_at IS NULL
              AND image_data IS NOT NULL AND image_data <> ''
            ORDER BY id ASC
        `, [req.user.id]);

        res.json({
            success: true,
            started: rows.length,
            message: rows.length
                ? `Reading ${rows.length} photo${rows.length === 1 ? '' : 's'} — every card in them will be added and priced…`
                : 'No source photos are waiting to be read.',
        });

        (async () => {
            let added = 0;
            let alreadyHeld = 0;
            let cardsSeen = 0;
            let restored = 0;
            let unreadable = 0;

            for (let i = 0; i < rows.length; i++) {
                const row = rows[i];
                broadcast({
                    type: 'extract_progress',
                    done: i, total: rows.length, added, cardsSeen,
                    message: `Reading photo ${i + 1} of ${rows.length}`,
                });

                try {
                    const buffer = dataUrlToBuffer(row.image_data);
                    if (!buffer) { unreadable++; continue; }

                    const vision = await analyzeImageBuffer(buffer, 'image/jpeg');
                    if (!vision?.ok) { unreadable++; continue; }

                    let cards = (vision.analysis?.cards || []).filter(c => hasMeaningfulCardName(c.card_name));
                    if (!cards.length) { unreadable++; continue; }

                    // The shape test only rules a single card out, never in, so
                    // a row it flagged that holds exactly one card was a card
                    // all along. Put it back rather than stranding it.
                    if (cards.length === 1) {
                        await pool.query(
                            'UPDATE portfolio_cards SET is_source_photo = 0, source_cards_found = 1, source_extracted_at = NOW() WHERE id = $1',
                            [row.id]);
                        restored++;
                        continue;
                    }

                    // Weakly-read cards get a second look at the crop, which is
                    // the only way a card number in small type survives being
                    // one twentieth of a frame.
                    const refined = await refineWeakCards(buffer, cards, 'image/jpeg');
                    cards = refined.cards;
                    cardsSeen += cards.length;

                    broadcastActivity('info', `Photo ${i + 1}: ${cards.length} cards found — adding them.`);

                    for (const rawCard of cards) {
                        if (!hasMeaningfulCardName(rawCard.card_name)) continue;

                        const { verified, why, answered } = await verifyWithReason(rawCard);
                        const card = verified || { ...rawCard, needs_review: true };

                        const existing = await findCardByVariant(buildVariantKey(card), req.user.id);
                        if (existing) { alreadyHeld++; continue; }

                        const crop = await cropCardThumbnail(buffer, rawCard.box_2d);
                        const saved = await saveScannedCard(card, {
                            userId: req.user.id,
                            thumbDataUrl: crop || '',
                            needsReview: !verified,
                            unverifiedReason: why,
                            databasesAnswered: answered,
                            forceSeparate: true,
                        });
                        if (saved?.id) {
                            await pool.query(
                                'UPDATE portfolio_cards SET source_photo_id = $2 WHERE id = $1', [saved.id, row.id]);
                        }
                        added++;
                        broadcastActivity('card_added_detail', `➕ ${card.card_name}`, saved);
                    }

                    await pool.query(
                        'UPDATE portfolio_cards SET source_cards_found = $2, source_extracted_at = NOW() WHERE id = $1',
                        [row.id, cards.length]);
                } catch (err) {
                    console.error(`  [Extract] photo ${row.id}:`, err.message);
                    unreadable++;
                }

                broadcast({ type: 'portfolio_updated' });
            }

            const parts = [];
            if (added) parts.push(`${added} card${added === 1 ? '' : 's'} added`);
            if (alreadyHeld) parts.push(`${alreadyHeld} already in the collection`);
            if (restored) parts.push(`${restored} turned out to be single cards and went back`);
            if (unreadable) parts.push(`${unreadable} could not be read`);
            broadcastActivity('extract_complete',
                parts.length
                    ? `Read ${rows.length} photo${rows.length === 1 ? '' : 's'}: ${parts.join(', ')}.`
                    : 'Nothing new was found in those photos.');
            broadcast({ type: 'portfolio_updated' });
        })().catch(err => console.error('Extraction error:', err))
            .finally(() => { gridRescanRunning = false; });
    } catch (err) {
        gridRescanRunning = false;
        console.error('Extraction error:', err);
        if (!res.headersSent) res.status(500).json({ error: err.message });
    }
});

app.get('/api/portfolio/photo-audit', requireAuth, async (req, res) => {
    try {
        const { rows } = await pool.query(`
            SELECT cc.id, cc.card_id, cc.condition, cc.created_at, cc.image_data,
                   pc.card_name, pc.card_set, pc.card_number, pc.current_price
            FROM card_copies cc
            JOIN portfolio_cards pc ON pc.id = cc.card_id
            WHERE pc.user_id = $1 AND COALESCE(pc.is_source_photo, 0) = 0
            ORDER BY cc.card_id ASC, cc.id ASC
        `, [req.user.id]);

        const byCard = new Map();
        for (const row of rows) {
            if (!byCard.has(row.card_id)) {
                byCard.set(row.card_id, {
                    card: {
                        id: row.card_id, card_name: row.card_name, card_set: row.card_set,
                        card_number: row.card_number, unit_price: Number(row.current_price) || 0,
                    },
                    copies: [],
                });
            }
            byCard.get(row.card_id).copies.push(row);
        }

        const cards = [];
        for (const { card, copies } of byCard.values()) {
            // Only a card held more than once can have a miscount.
            if (copies.length < 2) continue;

            const hashed = [];
            for (const copy of copies) {
                const buffer = decodeDataUrl(copy.image_data);
                hashed.push({
                    id: copy.id,
                    condition: copy.condition,
                    created_at: copy.created_at,
                    hash: buffer ? await perceptualHash(buffer, sharp) : null,
                    // The thumbnail goes back with it so the two can be shown
                    // side by side. A claim about someone's collection should be
                    // checkable by looking, not taken on trust.
                    image_data: copy.image_data || '',
                });
            }

            const groups = groupLikelySamePhoto(hashed);
            if (!groups.length) continue;

            const summary = summariseCard(card, copies, groups);
            summary.groups = groups.map(g => ({
                ...g,
                copies: g.ids.map(id => {
                    const c = hashed.find(h => h.id === id);
                    return { id, condition: c?.condition || 'Unknown', created_at: c?.created_at, image_data: c?.image_data || '' };
                }),
            }));
            cards.push(summary);
        }

        cards.sort((a, b) => b.overstatedValue - a.overstatedValue);

        res.json({
            cards,
            cardsAffected: cards.length,
            duplicateCopies: cards.reduce((n, c) => n + c.duplicateCopies, 0),
            overstatedValue: Number(cards.reduce((n, c) => n + c.overstatedValue, 0).toFixed(2)),
            copiesWithoutPhotos: rows.filter(r => !r.image_data).length,
            totalCopies: rows.length,
        });
    } catch (err) {
        console.error('Photo audit error:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * Act on the audit: keep one copy from each group, remove the rest.
 *
 * Takes explicit copy ids rather than re-running the detection, so what is
 * deleted is exactly what was shown on screen. A threshold that shifted between
 * looking and confirming must not be able to delete something never seen.
 */
app.post('/api/portfolio/photo-audit/resolve', requireAuth, express.json(), async (req, res) => {
    if (req.body?.confirm !== true) {
        return res.status(400).json({ error: 'Refusing to remove copies without confirm:true' });
    }
    const removeIds = Array.isArray(req.body?.removeCopyIds)
        ? req.body.removeCopyIds.map(Number).filter(Number.isInteger)
        : [];
    if (!removeIds.length) return res.json({ success: true, removed: 0 });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Ownership is resolved here, so another user's copy id cannot be
        // smuggled in through the request body.
        const owned = await client.query(`
            SELECT cc.id, cc.card_id FROM card_copies cc
            JOIN portfolio_cards pc ON pc.id = cc.card_id
            WHERE cc.id = ANY($1::int[]) AND pc.user_id = $2
        `, [removeIds, req.user.id]);
        const ids = owned.rows.map(r => r.id);
        const affectedCards = [...new Set(owned.rows.map(r => r.card_id))];

        // A card must never be left with zero copies: that is a card Jack owns
        // disappearing from the collection, which is worse than a wrong count.
        for (const cardId of affectedCards) {
            const total = await client.query('SELECT COUNT(*)::int AS c FROM card_copies WHERE card_id = $1', [cardId]);
            const removing = owned.rows.filter(r => r.card_id === cardId).length;
            if (removing >= total.rows[0].c) {
                await client.query('ROLLBACK');
                return res.status(400).json({
                    error: 'That would remove every copy of a card. At least one has to remain.',
                    cardId,
                });
            }
        }

        const result = await client.query('DELETE FROM card_copies WHERE id = ANY($1::int[])', [ids]);
        await client.query('COMMIT');

        broadcast({ type: 'portfolio_updated' });
        res.json({ success: true, removed: result.rowCount, cardsAffected: affectedCards.length });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('Photo audit resolve error:', err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
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
        const ebaySpend = await ebayBudget.state();

        const checked = cards.map(c => c.last_price_check).filter(Boolean).map(d => new Date(d).getTime());

        res.json({
            sources: [
                { name: 'Pokémon TCG API', live: true, detail: POKEMON_TCG_KEY ? 'API key set' : 'no key — rate limited', key: 'POKEMON_TCG_KEY' },
                { name: 'TCGdex', live: true, detail: 'free, no key needed', key: null },
                { name: 'Scrydex', live: Boolean(SCRYDEX_API_KEY && SCRYDEX_TEAM_ID), detail: 'needs SCRYDEX_API_KEY + SCRYDEX_TEAM_ID', key: 'SCRYDEX_API_KEY' },
                { name: 'JustTCG', live: Boolean(JUSTTCG_API_KEY), detail: 'needs JUSTTCG_API_KEY', key: 'JUSTTCG_API_KEY' },
                {
                    name: 'eBay live market', live: Boolean(EBAY_APP_ID && EBAY_CERT_ID),
                    detail: EBAY_APP_ID && EBAY_CERT_ID
                        // The allowance is stated because running out looks
                        // exactly like the card having no market, and only one
                        // of those is worth doing anything about.
                        ? `live listings and auction bids · ${ebaySpend.used} of ${ebaySpend.limit} calls used today`
                          + `${ebaySpend.exhausted ? ' — allowance spent, resets at midnight UTC' : ''}`
                        : 'needs EBAY_APP_ID + EBAY_CERT_ID — the only source that sees what buyers are doing',
                    key: 'EBAY_APP_ID',
                    quota: ebaySpend,
                },
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

            // A 12 MP phone photo carries far more detail than reading a card
            // name and number needs, and uploading all of it was the single
            // largest cost between the shutter and the answer.
            const prepared = await prepareImageForAi(buffer);
            if (prepared.resized) {
                console.log(`  [Vision] ${prepared.from}px → ${AI_IMAGE_MAX_EDGE}px, ${Math.round(prepared.savedBytes / 1024)}KB less to upload`);
            }

            // The thumbnail and the recognition call are independent, so they run
            // together: the client gets a picture of the card to look at while
            // the model is still thinking, rather than after.
            // Stored at a size a vision model can still read on a second
            // pass. 400px was fine as a picture and useless as evidence — the
            // card number was gone — and those thumbnails are all that remain
            // of the early uploads. Storage cost is real but bounded: ~150KB a
            // card at this size, tens of MB across the whole collection.
            const thumbnail = sharp(prepared.buffer)
                .resize(900, 1260, { fit: 'inside', withoutEnlargement: true })
                .jpeg({ quality: 82 })
                .toBuffer()
                .then((thumbBuffer) => {
                    thumbDataUrl = `data:image/jpeg;base64,${thumbBuffer.toString('base64')}`;
                    report('thumbnail', { ...photo, image_data: thumbDataUrl });
                })
                .catch((e) => { console.error(`  [Thumb] Failed for photo ${index + 1}:`, e.message); });

            report('identifying', { ...photo, message: 'Reading the card with AI' });
            [vision] = await Promise.all([
                analyzeImageBuffer(prepared.buffer, prepared.mime || sendMime),
                thumbnail,
            ]);

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

        // A photo of a binder page or a tabletop grid. Every card in it is a
        // card Jack owns, so every one is added — and each gets its own picture
        // cut out of the frame, rather than fifteen rows all illustrated by the
        // same photo of sixteen cards.
        let scanCards = analysis.cards;
        const multi = isMultiCard(scanCards);
        if (multi) {
            report('multi_card', {
                ...photo,
                count: scanCards.length,
                message: `${scanCards.length} cards in this photo — adding each one`,
            });
            broadcastActivity('info', `Found ${scanCards.length} cards in photo ${index + 1}.`);

            // Read from the ORIGINAL buffer, not the downscaled copy the first
            // pass used: the whole reason a card in a grid reads poorly is that
            // it only had a fraction of those pixels to begin with.
            const refined = await refineWeakCards(buffer, scanCards, sendMime,
                (stage, payload) => report(stage, { ...photo, ...payload }));
            scanCards = refined.cards;
        }

        for (const rawCard of scanCards) {
            // Each card is illustrated by itself where the model said where it
            // is; a full-frame thumbnail stands in when it did not.
            let cardThumb = thumbDataUrl;
            if (multi) {
                const cropped = await cropCardThumbnail(buffer, rawCard.box_2d);
                if (cropped) cardThumb = cropped;
            }

            report('identified', {
                ...photo,
                image_data: cardThumb,
                card: {
                    card_name: rawCard.card_name || '',
                    card_name_en: rawCard.card_name_en || '',
                    card_set: rawCard.card_set || '',
                    set_code: rawCard.set_code || '',
                    card_number: rawCard.card_number || '',
                    rarity: rawCard.rarity || '',
                    language: languageLabel(rawCard.language),
                    is_non_english: isNonEnglish(rawCard.language),
                    confidence: Number(rawCard.confidence) || 0,
                },
            });
            report('verifying', { ...photo, message: 'Confirming the printing against the card database' });

            const { verified, why: unverifiedReason, answered: databasesAnswered } = await verifyWithReason(rawCard, report);
            const card = verified || { ...rawCard, needs_review: true };

            if (verified) {
                report('verified', {
                    ...photo,
                    card: {
                        card_name: verified.card_name,
                        card_name_en: verified.card_name_en || '',
                        card_set: verified.card_set,
                        card_number: verified.card_number,
                        rarity: verified.rarity,
                        year: verified.year,
                        language: languageLabel(verified.language),
                        is_non_english: isNonEnglish(verified.language),
                        image_url: verified.image_url || '',
                        confidence: verified.confidence,
                    },
                    via: verified.verified_source || '',
                });
            } else {
                if (!hasMeaningfulCardName(card.card_name)) {
                    report('photo_failed', { ...photo, reason: 'unreadable_card', message: 'Could not read the card name. Try again with less glare.', retryable: true });
                    results.push({
                        status: 'rejected',
                        reason: 'unreadable_card',
                        message: 'Could not read the card name. Try again with less glare.',
                        image_data: cardThumb,
                    });
                    continue;
                }
                // Not a failure and not a chore for anyone: the card is
                // identified, the exact printing is not, and it will be priced
                // as an estimate with that reason attached.
                broadcastActivity('info', `Added "${card.card_name}" — pricing as an estimate, ${unverifiedReason || 'the exact printing could not be confirmed'}.`);
                report('estimating', {
                    ...photo,
                    card_name: card.card_name,
                    reason: unverifiedReason,
                    message: `Pricing as an estimate — ${unverifiedReason || 'the exact printing could not be confirmed'}`,
                });
            }

            const saved = await saveScannedCard(card, {
                userId,
                thumbDataUrl: cardThumb,
                needsReview: !verified,
                unverifiedReason,
                databasesAnswered,
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
async function saveScannedCard(card, { userId, thumbDataUrl, needsReview, unverifiedReason = '', databasesAnswered = true, forceSeparate, report = () => {} }) {
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
            card_name_en: existing.card_name_en || '',
            language: normalizeLanguage(existing.language),
            language_label: languageLabel(existing.language),
            is_non_english: isNonEnglish(existing.language),
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

    // Artwork is only fetched for a card whose printing was actually confirmed.
    //
    // The picture is shown in preference to the photo you took, so it is a
    // claim about what you own — and on an unconfirmed card that claim has
    // nothing behind it. A Tyrunt numbered 070 that could not be placed was
    // being illustrated with a different Tyrunt's artwork, which looked exactly
    // as authoritative as a correct one. Your own photograph is always a
    // picture of your actual card, so it stands until the printing is settled.
    let imageUrl = needsReview ? '' : (card.image_url || '');
    if (!needsReview) {
        try {
            // A Japanese card should show Japanese artwork, so TCGdex is asked in
            // the card's own language first.
            if (!imageUrl) imageUrl = await fetchCardImageFromTCGdex(card.card_name, card.card_set, card.card_number, languageCode(card.language)) || '';
            // The English fallbacks only make sense with an English name to search.
            const english = card.card_name_en || (isNonEnglish(card.language) ? '' : card.card_name);
            if (!imageUrl && english) imageUrl = await fetchCardImageFromTCGdex(english, card.card_set, card.card_number) || '';
            if (!imageUrl && english) imageUrl = await fetchCardImageFromPokemonTCG(english, card.card_set, card.card_number) || '';
        } catch { /* the scan photo stands in until a refresh finds artwork */ }
    }

    const cardId = await insertPortfolioCard({
        card_name: card.card_name,
        card_name_en: card.card_name_en || '',
        card_set: card.card_set || '',
        set_code: card.set_code || '',
        card_number: card.card_number || '',
        verified_source: card.verified_source || '',
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

    // Every card that could be read gets priced. Whether the exact printing was
    // confirmed decides how the number is *labelled*, not whether it exists —
    // withholding it left cards the app had read at 100% confidence showing no
    // value and silently missing from the collection total.
    let market = null;
    report('pricing', {
        message: needsReview
            ? 'Checking marketplace prices — the exact printing is unconfirmed, so this will be an estimate'
            : 'Checking marketplace prices',
    });
    try {
        market = await priceCard(card, {
            verified: !needsReview,
            why: unverifiedReason || 'the exact printing could not be confirmed',
            answered: databasesAnswered,
            // Somebody is standing there with the card in their hand. This may
            // spend the reserve a bulk refresh is not allowed to touch.
            interactive: true,
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
            tier: market.tier,
            tier_label: market.tierLabel,
            explanation: market.explanation,
            low: market.low,
            high: market.high,
            quotesUsed: market.quotesUsed,
            quotesSeen: market.quotesSeen,
        });
    } else {
        report('unpriced', {
            tier: 'unpriced',
            message: market?.sourcesUnavailable
                ? 'No price source could be reached — this card will be priced on the next refresh.'
                : 'No marketplace listing found for this printing yet.',
        });
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
        card_name_en: card.card_name_en || '',
        language: normalizeLanguage(card.language),
        language_label: languageLabel(card.language),
        is_non_english: isNonEnglish(card.language),
        card_set: card.card_set || '',
        set_code: card.set_code || '',
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
        price_tier: market?.tier || 'unpriced',
        price_tier_label: market?.tierLabel || '',
        price_explanation: market?.explanation || '',
        // A priced card needs nothing from anyone. The tier says how sure the
        // number is, which is what a review would have established anyway.
        needs_review: Boolean(needsReview) && !(market?.price > 0),
        message: market?.price > 0
            ? undefined
            : `Added "${card.card_name}" — no marketplace price yet, it will be tried again on the next refresh`,
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
        // Respects the schedule rather than forcing a refresh. On a host that
        // sleeps when idle the in-process timer cannot fire, so this endpoint
        // is also what keeps the service awake — and a pinger frequent enough
        // to do that is far more frequent than prices need re-checking. Forcing
        // every call would mean a full pass over the collection every ten
        // minutes. `?force=1` is there for when you actually mean now.
        const force = req.query.force === '1' || req.query.force === 'true';
        const schedule = await refreshSchedule();

        if (!force && !schedule.overdue) {
            return res.json({
                success: true, started: false, reason: 'not_due',
                message: `Next refresh due ${schedule.nextRefreshAt}. Pass ?force=1 to run now.`,
                nextRefreshAt: schedule.nextRefreshAt,
            });
        }
        if (schedule.running) {
            return res.json({ success: true, started: false, reason: 'already_running', message: 'A refresh is already in progress.' });
        }

        // Not awaited: a full pass takes minutes and the scheduler calling us
        // should not be held open for it.
        refreshAllPrices()
            .then(() => setLastRefreshAt(Date.now()))
            .catch(err => console.error('[Cron] Refresh error:', err.message));
        res.json({ success: true, started: true, forced: force, message: 'Background refresh started' });
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
