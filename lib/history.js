/**
 * Detecting fabricated price history.
 *
 * Two one-off scripts that used to live in this repo (backfill_history.js and
 * clean_backfill.js) populated price_history by interpolating between a guessed
 * 30-day-old price and today's price, with random noise. Those points were
 * never observed in any market. They are why some charts show a suspiciously
 * smooth 30-day climb.
 *
 * They are identifiable: the scripts wrote recorded_at as `now - i * 86400000`,
 * so consecutive points sit exactly 24 hours apart to the millisecond. Genuine
 * points are written whenever a refresh happens to run and never line up that
 * neatly.
 *
 * The detector errs towards leaving data alone. Deleting a price that was really
 * observed is worse than leaving a fabricated one behind, and the purge that
 * consumes this is opt-in and previewed.
 */

const DAY_MS = 86400000;

/** A run this short can occur honestly; below it we do not accuse. */
export const SYNTHETIC_RUN_MIN_POINTS = 6;

/** Allows for clock jitter between the script's inserts. */
export const SYNTHETIC_GAP_TOLERANCE_MS = 1500;

/**
 * @param {{id:number, recorded_at:string|Date}[]} points history for ONE card
 * @returns {number[]} ids of points that look generated rather than observed
 */
export function findSyntheticRuns(points) {
    const stamped = (points || [])
        .map(p => ({ ...p, t: new Date(p.recorded_at).getTime() }))
        .filter(p => Number.isFinite(p.t))
        .sort((a, b) => a.t - b.t);

    // Pass 1: contiguous chains of points exactly one day apart.
    const anchors = [];
    let run = stamped.length ? [stamped[0]] : [];

    for (let i = 1; i < stamped.length; i++) {
        const gap = stamped[i].t - stamped[i - 1].t;
        if (Math.abs(gap - DAY_MS) <= SYNTHETIC_GAP_TOLERANCE_MS) {
            run.push(stamped[i]);
        } else {
            if (run.length >= SYNTHETIC_RUN_MIN_POINTS) anchors.push(run);
            run = [stamped[i]];
        }
    }
    if (run.length >= SYNTHETIC_RUN_MIN_POINTS) anchors.push(run);
    if (!anchors.length) return [];

    // Pass 2: a genuine price recorded mid-series breaks the chain and orphans
    // the generated points after it. Any point sitting a whole number of days
    // from a confirmed run belongs to that same generated series.
    const ids = new Set();
    for (const chain of anchors) {
        const anchor = chain[0].t;
        for (const point of stamped) {
            const days = (point.t - anchor) / DAY_MS;
            const offBy = Math.abs(days - Math.round(days)) * DAY_MS;
            if (offBy <= SYNTHETIC_GAP_TOLERANCE_MS) ids.add(point.id);
        }
    }
    return [...ids];
}

/**
 * Group flat history rows by card and report which points look generated.
 * @param {{id:number, card_id:number, card_name:string, recorded_at:string}[]} rows
 */
export function auditHistoryRows(rows) {
    const byCard = new Map();
    for (const row of rows || []) {
        if (!byCard.has(row.card_id)) byCard.set(row.card_id, { card_name: row.card_name, points: [] });
        byCard.get(row.card_id).points.push(row);
    }

    const cards = [];
    let ids = [];
    for (const [cardId, { card_name, points }] of byCard) {
        const found = findSyntheticRuns(points);
        if (found.length) {
            cards.push({ card_id: cardId, card_name, fabricated: found.length, total: points.length });
            ids = ids.concat(found);
        }
    }

    cards.sort((a, b) => b.fabricated - a.fabricated);
    return { cards, ids, pointCount: ids.length, totalPoints: (rows || []).length };
}
