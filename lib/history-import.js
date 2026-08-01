/**
 * Importing price history the app did not live through.
 *
 * The charts can only draw what is in `price_history`, and until now the only
 * thing that ever wrote to that table was this app's own daily refresh. So a
 * "90 days" chart on a three-week-old install shows three weeks — and labels it
 * ninety. The data is not wrong so much as absent, and no amount of care in the
 * pricing engine fixes an empty table.
 *
 * There is no way to derive the missing months from a current price. An earlier
 * version of this codebase tried: it interpolated between a guessed 30-day-ago
 * value and today's, added random noise, and wrote the result in as though it
 * had been observed. Those points were deleted and the detector that finds them
 * still lives in lib/history.js. Real history has to come from someone who was
 * recording at the time.
 *
 * That means a paid source. TCGplayer's own API stopped accepting new
 * developers after the eBay acquisition, and none of the free tiers carry
 * history. So this module defines what a history provider has to supply and
 * leaves the choice of vendor to configuration — the app works without one, and
 * says plainly that its charts start when it did.
 *
 * Every imported point is tagged with the provider that supplied it, so an
 * imported price is never mistaken for one this app observed, and a provider
 * that turns out to be wrong can be removed again by source name alone.
 */

/** Marks points that came from outside rather than from our own refresh. */
export const IMPORTED_PREFIX = 'imported:';

export function isImportedSource(source) {
    return String(source || '').startsWith(IMPORTED_PREFIX);
}

export function importedSourceName(provider) {
    return `${IMPORTED_PREFIX}${provider}`;
}

/**
 * Normalise one provider's history payload into points we can store.
 *
 * Deliberately strict. A history import writes directly into the series the
 * charts draw, so anything malformed is dropped rather than coerced: a bad
 * timestamp becomes a point in 1970 that flattens every chart it touches, and a
 * zero price reads as a card that briefly became worthless.
 *
 * @param {{date?: string, timestamp?: number, price?: number, market?: number}[]} raw
 * @param {{ maxAgeDays?: number }} [opts]
 * @returns {{recordedAt: Date, price: number}[]} oldest first, one per day
 */
export function normaliseHistory(raw, { maxAgeDays = 400 } = {}) {
    const now = Date.now();
    const oldestAllowed = now - maxAgeDays * 86400000;
    const byDay = new Map();

    for (const row of Array.isArray(raw) ? raw : []) {
        const price = Number(row?.price ?? row?.market ?? row?.marketPrice);
        if (!(price > 0) || !Number.isFinite(price)) continue;

        const stamp = row?.timestamp != null
            ? Number(row.timestamp) * (String(row.timestamp).length <= 10 ? 1000 : 1)
            : Date.parse(row?.date ?? row?.recorded_at ?? '');
        if (!Number.isFinite(stamp)) continue;
        // A future point, or one older than the window, is a parsing accident
        // rather than data — both would distort the chart's axis.
        if (stamp > now + 86400000 || stamp < oldestAllowed) continue;

        // One point per calendar day. Providers vary between hourly and daily
        // granularity, and the charts are daily, so collapse to the last
        // reading of each day rather than letting one provider's sampling rate
        // decide how dense the line looks.
        const day = new Date(stamp).toISOString().slice(0, 10);
        const existing = byDay.get(day);
        if (!existing || stamp > existing.stamp) byDay.set(day, { stamp, price });
    }

    return [...byDay.values()]
        .sort((a, b) => a.stamp - b.stamp)
        .map(p => ({ recordedAt: new Date(p.stamp), price: Number(p.price.toFixed(2)) }));
}

/**
 * Which imported points to keep, given what the app already recorded.
 *
 * Our own observations always win: they were taken against a printing we had
 * verified, with provenance we can explain. An import only fills the gap before
 * the app started watching, so it can never overwrite or contradict a day the
 * app was already there for.
 *
 * @param {{recordedAt: Date, price: number}[]} imported
 * @param {{recorded_at: string|Date}[]} existing points already in the table
 */
export function pointsToInsert(imported, existing) {
    const ownDays = new Set(
        (existing || [])
            .map(p => new Date(p.recorded_at))
            .filter(d => Number.isFinite(d.getTime()))
            .map(d => d.toISOString().slice(0, 10)),
    );
    return (imported || []).filter(p => !ownDays.has(p.recordedAt.toISOString().slice(0, 10)));
}

/**
 * A summary a person can act on, rather than a row count.
 */
export function summariseImport(points) {
    if (!points.length) return { points: 0, days: 0, from: null, to: null };
    const from = points[0].recordedAt;
    const to = points[points.length - 1].recordedAt;
    return {
        points: points.length,
        days: Math.round((to - from) / 86400000) + 1,
        from: from.toISOString(),
        to: to.toISOString(),
    };
}
