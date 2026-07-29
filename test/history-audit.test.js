/**
 * The fabricated-history detector.
 *
 * Deleting a genuine recorded price is worse than leaving a fake one behind, so
 * these tests care most about false positives.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { findSyntheticRuns } from '../lib/history.js';

const DAY = 86400000;
const base = Date.UTC(2026, 0, 1, 12, 0, 0);

/** Points exactly one day apart, as the old backfill script wrote them. */
const generated = (count, startId = 1, anchor = base) =>
    Array.from({ length: count }, (_, i) => ({
        id: startId + i,
        recorded_at: new Date(anchor + i * DAY).toISOString(),
    }));

/** Points at arbitrary times, as a real refresh writes them. */
const observed = (offsetsHours, startId = 500, anchor = base) =>
    offsetsHours.map((h, i) => ({
        id: startId + i,
        recorded_at: new Date(anchor + h * 3600000).toISOString(),
    }));

test('flags a 31-point daily series', () => {
    const points = generated(31);
    const ids = findSyntheticRuns(points);
    assert.equal(ids.length, 31);
});

test('leaves genuine irregular points alone', () => {
    const points = observed([0, 19.5, 43.1, 70.8, 96.25, 121.6, 145.9, 170.2]);
    assert.deepEqual(findSyntheticRuns(points), []);
});

test('leaves a short run alone — a few daily prices can happen honestly', () => {
    assert.deepEqual(findSyntheticRuns(generated(4)), []);
});

test('catches the whole generated series even when a real price lands mid-way', () => {
    // A genuine refresh between two generated points breaks the daily chain;
    // the trailing generated points must still be recognised.
    const fake = generated(31, 1);
    const real = observed([12.4, 36.7], 900, base + 27 * DAY);
    const ids = findSyntheticRuns([...fake, ...real]);

    assert.equal(ids.length, 31, 'every generated point is found');
    for (const r of real) {
        assert.ok(!ids.includes(r.id), `genuine point ${r.id} must not be flagged`);
    }
});

test('a genuine point that happens to be a whole day from the series is a known cost', () => {
    // Documented behaviour: a real price recorded exactly 24h from the generated
    // series is indistinguishable from it. The purge is opt-in and previewed for
    // this reason.
    const fake = generated(31, 1);
    const coincidental = [{ id: 999, recorded_at: new Date(base + 40 * DAY).toISOString() }];
    const ids = findSyntheticRuns([...fake, ...coincidental]);
    assert.ok(ids.includes(999));
});

test('handles empty and single-point histories', () => {
    assert.deepEqual(findSyntheticRuns([]), []);
    assert.deepEqual(findSyntheticRuns(generated(1)), []);
});

test('tolerates a few hundred ms of clock jitter within a run', () => {
    const points = generated(20).map((p, i) => ({
        ...p,
        recorded_at: new Date(new Date(p.recorded_at).getTime() + (i % 3) * 200).toISOString(),
    }));
    assert.equal(findSyntheticRuns(points).length, 20);
});

test('two separate generated batches are both flagged', () => {
    const first = generated(10, 1, base);
    const second = generated(10, 100, base + 200 * DAY);
    const ids = findSyntheticRuns([...first, ...second]);
    assert.equal(ids.length, 20);
});
