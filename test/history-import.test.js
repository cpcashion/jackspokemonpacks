/**
 * Importing history the app did not live through.
 *
 * This writes straight into the series the charts draw, which makes it the most
 * dangerous kind of write in the codebase: a bad point does not error, it
 * silently changes what the collection appears to have been worth. An earlier
 * version of this project fabricated exactly this table by interpolating from a
 * guess, so the bar here is deliberately high — anything malformed is dropped
 * rather than coerced into something plausible.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    normaliseHistory,
    pointsToInsert,
    summariseImport,
    isImportedSource,
    importedSourceName,
} from '../lib/history-import.js';

const day = (iso) => `${iso}T12:00:00Z`;

test('a well-formed payload becomes points, oldest first', () => {
    const points = normaliseHistory([
        { date: day('2026-07-03'), price: 12 },
        { date: day('2026-07-01'), price: 10 },
        { date: day('2026-07-02'), price: 11 },
    ]);
    assert.deepEqual(points.map(p => p.price), [10, 11, 12]);
    assert.equal(points[0].recordedAt.toISOString().slice(0, 10), '2026-07-01');
});

test('both field spellings providers use are accepted', () => {
    assert.equal(normaliseHistory([{ date: day('2026-07-01'), market: 5 }])[0].price, 5);
    assert.equal(normaliseHistory([{ date: day('2026-07-01'), marketPrice: 6 }])[0].price, 6);
    // Unix seconds and milliseconds both appear in the wild.
    const secs = Math.floor(Date.parse(day('2026-07-01')) / 1000);
    assert.equal(normaliseHistory([{ timestamp: secs, price: 7 }])[0].price, 7);
    assert.equal(normaliseHistory([{ timestamp: secs * 1000, price: 8 }])[0].price, 8);
});

/**
 * Each of these would draw a chart rather than raise an error, which is exactly
 * why they are rejected at the door.
 */
test('malformed points are dropped, not coerced', () => {
    const points = normaliseHistory([
        { date: day('2026-07-01'), price: 10 },   // keep
        { date: 'not a date', price: 10 },        // unparseable
        { date: day('2026-07-02'), price: 0 },    // a card is never worth zero
        { date: day('2026-07-03'), price: -5 },   // nor less than zero
        { date: day('2026-07-04') },              // no price at all
        { price: 10 },                            // no date at all
        { date: day('2026-07-05'), price: 'abc' },
        null,
        undefined,
    ]);
    assert.equal(points.length, 1, 'only the good one survives');
    assert.equal(points[0].price, 10);
});

test('points outside a plausible window are dropped', () => {
    const future = new Date(Date.now() + 30 * 86400000).toISOString();
    const ancient = '1970-01-02T00:00:00Z';
    const points = normaliseHistory([
        { date: future, price: 10 },
        { date: ancient, price: 10 },
    ]);
    assert.deepEqual(points, [], 'a 1970 point flattens every chart it touches');
});

test('several readings in one day collapse to the last', () => {
    const points = normaliseHistory([
        { date: '2026-07-01T02:00:00Z', price: 10 },
        { date: '2026-07-01T18:00:00Z', price: 14 },
        { date: '2026-07-01T09:00:00Z', price: 12 },
    ]);
    assert.equal(points.length, 1, 'the charts are daily');
    assert.equal(points[0].price, 14, 'and the last reading of the day is the close');
});

test('an empty or junk payload yields nothing rather than throwing', () => {
    for (const input of [[], null, undefined, 'nope', 42, {}]) {
        assert.deepEqual(normaliseHistory(input), []);
    }
});

// ── Precedence over what the app saw for itself ────────────────────

/**
 * The rule that keeps an import honest: our own observations were taken against
 * a printing we verified, with provenance we can explain on screen. An import
 * fills the gap before the app was watching and never overwrites a day it was.
 */
test('imported points never overwrite a day the app recorded itself', () => {
    const imported = normaliseHistory([
        { date: day('2026-07-01'), price: 10 },
        { date: day('2026-07-02'), price: 11 },
        { date: day('2026-07-03'), price: 12 },
    ]);
    const existing = [{ recorded_at: day('2026-07-02') }];

    const toInsert = pointsToInsert(imported, existing);
    assert.deepEqual(toInsert.map(p => p.recordedAt.toISOString().slice(0, 10)),
        ['2026-07-01', '2026-07-03'],
        'the day we watched is left exactly as we recorded it');
});

test('with no existing history everything is inserted', () => {
    const imported = normaliseHistory([{ date: day('2026-07-01'), price: 10 }]);
    assert.equal(pointsToInsert(imported, []).length, 1);
    assert.equal(pointsToInsert(imported, null).length, 1);
});

test('unparseable existing timestamps do not block an import', () => {
    const imported = normaliseHistory([{ date: day('2026-07-01'), price: 10 }]);
    assert.equal(pointsToInsert(imported, [{ recorded_at: 'garbage' }]).length, 1);
});

// ── Provenance ─────────────────────────────────────────────────────

/**
 * An imported price must never be mistakable for one this app observed — both
 * so the UI can say where a number came from, and so a provider that turns out
 * to be wrong can be removed again by source name alone.
 */
test('imported points are tagged with their provider', () => {
    const name = importedSourceName('pricecharting');
    assert.equal(isImportedSource(name), true);
    assert.match(name, /pricecharting/);

    for (const ours of ['tcgplayer', 'tcgplayer_consensus', 'market', '']) {
        assert.equal(isImportedSource(ours), false, `"${ours}" is our own observation`);
    }
});

test('the summary describes the span, not just a count', () => {
    const points = normaliseHistory([
        { date: day('2026-06-01'), price: 10 },
        { date: day('2026-06-30'), price: 12 },
    ]);
    const s = summariseImport(points);
    assert.equal(s.points, 2);
    assert.equal(s.days, 30, 'inclusive of both ends');
    assert.match(s.from, /^2026-06-01/);
    assert.match(s.to, /^2026-06-30/);

    assert.deepEqual(summariseImport([]), { points: 0, days: 0, from: null, to: null });
});
