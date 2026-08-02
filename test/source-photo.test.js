/**
 * Telling a photograph of a collection from a photograph of a card.
 *
 * The collection was built from pictures of whole binder pages — six or eight
 * cards across, three or four down. Each became a single row in the collection,
 * showing twenty cards, that no marketplace could price. They are not cards.
 *
 * The cost of being wrong is asymmetric, and these pin that asymmetry: calling
 * a real card a spread would hide something somebody owns, so the shape test
 * only ever rules a single card *out*, never in.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    couldBeSingleCard,
    spreadPhotoIds,
    CARD_ASPECT,
} from '../lib/source-photo.js';

/** A grid of upright cards, as photographed. */
const grid = (columns, rows) => ({ width: Math.round(columns * CARD_ASPECT * 1000), height: rows * 1000 });

test('a photo of one card is never mistaken for a spread', () => {
    const singles = [
        { width: 630, height: 880, what: 'the card exactly' },
        { width: 3024, height: 4032, what: 'a phone photo, portrait' },
        { width: 1200, height: 1600, what: 'cropped to the capture guide' },
        { width: 800, height: 1400, what: 'framed loosely, very tall' },
    ];
    for (const s of singles) {
        assert.equal(couldBeSingleCard(s), true, `${s.what} must stay in the collection`);
    }
});

/**
 * The shapes the user actually described: "rows of eight or six and columns of
 * three or four". Every one of those is wider than it is tall.
 */
test('the binder-page layouts are ruled out as single cards', () => {
    for (const [columns, rows] of [[6, 3], [8, 3], [6, 4], [8, 4], [4, 2], [5, 3]]) {
        assert.equal(couldBeSingleCard(grid(columns, rows)), false,
            `${columns}x${rows} is a spread, not a card`);
    }
});

/**
 * A tall grid is portrait, exactly like a single card, so shape cannot settle
 * it. Those are deliberately left alone here and decided by actually looking at
 * the image — guessing would hide real cards.
 */
test('a tall spread is left for the vision pass rather than guessed at', () => {
    assert.equal(couldBeSingleCard(grid(3, 5)), true, '3x5 is portrait; shape cannot tell');
    assert.equal(couldBeSingleCard(grid(2, 4)), true, '2x4 likewise');
});

test('an image of unknown size is never ruled out', () => {
    for (const size of [undefined, {}, { width: 0, height: 0 }, { width: 100 }, { height: 100 }]) {
        assert.equal(couldBeSingleCard(size), true, `${JSON.stringify(size)} decides nothing`);
    }
});

/**
 * Worth stating why there is no card-count estimate here. A 2x1 grid, a 4x2 and
 * a 6x3 are all exactly the same shape, so aspect ratio fixes the ratio of
 * columns to rows and says nothing at all about how many cards there are. The
 * count comes from looking at the image, and the interface asks for the work
 * without claiming a number it cannot know.
 */
test('spreadPhotoIds picks out exactly the landscape photos', () => {
    const photos = [
        { id: 1, ...grid(8, 3) },
        { id: 2, width: 3024, height: 4032 },
        { id: 3, ...grid(6, 4) },
        { id: 4, width: 630, height: 880 },
        { id: 5, width: 0, height: 0 },
    ];
    assert.deepEqual(spreadPhotoIds(photos), [1, 3]);
    assert.deepEqual(spreadPhotoIds([]), []);
    assert.deepEqual(spreadPhotoIds(null), []);
});
