/**
 * Cutting one photo of many cards into many cards.
 *
 * The failure these exist to prevent is a quiet one. A wrong crop still
 * produces a perfectly good JPEG — of the wrong card, or of the gap between two
 * cards — and nothing downstream can tell. So the geometry is pinned here,
 * away from sharp and away from the network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    boxToRegion,
    isUsableBox,
    isMultiCard,
    needsCloserLook,
    mergeCloserLook,
    BOX_SCALE, uprightRotation, looksSideways } from '../lib/card-crop.js';

test('a box on the model grid becomes the right pixel rectangle', () => {
    // The top-left quarter of a 1000x2000 image, with no margin.
    const region = boxToRegion([0, 0, 500, 500], 1000, 2000, 0);
    assert.deepEqual(region, { left: 0, top: 0, width: 500, height: 1000 });

    // The model grid is square but images are not: y maps to height, x to
    // width. Transposing them is the easy mistake and it crops the wrong card.
    const lower = boxToRegion([500, 0, 1000, 500], 1000, 2000, 0);
    assert.equal(lower.top, 1000, 'y is scaled by the image height');
    assert.equal(lower.left, 0);
});

/**
 * Model boxes sit just inside the card. Cropping exactly on the reported edge
 * shaves off the border, which is where the set symbol and the holo pattern
 * are — both of which the next pass needs to identify the printing.
 */
test('the crop is padded so the card border survives', () => {
    const tight = boxToRegion([100, 100, 300, 300], 1000, 1000, 0);
    const padded = boxToRegion([100, 100, 300, 300], 1000, 1000, 0.05);
    assert.ok(padded.left < tight.left, 'the crop starts earlier');
    assert.ok(padded.width > tight.width, 'and is wider');
});

test('padding never runs off the edge of the image', () => {
    const corner = boxToRegion([0, 0, 100, 100], 800, 600, 0.5);
    assert.ok(corner.left >= 0 && corner.top >= 0);

    const far = boxToRegion([900, 900, 1000, 1000], 800, 600, 0.5);
    assert.ok(far.left + far.width <= 800, `right edge ${far.left + far.width} exceeds 800`);
    assert.ok(far.top + far.height <= 600, `bottom edge ${far.top + far.height} exceeds 600`);
});

/**
 * sharp throws on a malformed extract region, which would fail the whole photo
 * — so every one of these has to be caught here and fall back to the uncropped
 * image instead.
 */
test('a malformed box is refused rather than cropped', () => {
    const bad = [
        undefined, null, [], [1, 2, 3], 'nope', [NaN, 0, 100, 100],
        [500, 0, 100, 100],      // inverted vertically
        [0, 500, 100, 100],      // inverted horizontally
        [0, 0, 0, 0],            // empty
        [-500, -500, -100, -100],// off the grid entirely
        [0, 0, 5000, 5000],      // far past the grid
        [0, 0, 3, 3],            // far too small to be a card
    ];
    for (const box of bad) {
        assert.equal(isUsableBox(box), false, `${JSON.stringify(box)} should be refused`);
        assert.equal(boxToRegion(box, 1000, 1000), null, `${JSON.stringify(box)} should not crop`);
    }
});

test('a box a hair outside the grid is tolerated rather than thrown away', () => {
    // Models round. Refusing these would drop real cards at the frame edge.
    assert.equal(isUsableBox([-5, -3, 400, 400]), true);
    assert.equal(isUsableBox([600, 600, BOX_SCALE + 8, BOX_SCALE + 8]), true);
    const region = boxToRegion([-5, -3, 400, 400], 1000, 1000);
    assert.ok(region.left >= 0 && region.top >= 0, 'and it still clamps into the image');
});

test('a photo of several cards is recognised as one', () => {
    assert.equal(isMultiCard([{}, {}]), true);
    assert.equal(isMultiCard([{}]), false);
    assert.equal(isMultiCard([]), false);
    assert.equal(isMultiCard(null), false);
});

/**
 * Sixteen cards in one frame means each gets a sixteenth of the pixels, and a
 * card number set in 15px type on the original is gone by the time the photo
 * has been downscaled for the model. Those are the cards worth a second look.
 */
test('the cards worth re-reading are the ones that came back weak', () => {
    const cards = [
        { card_name: 'Charizard', card_number: '4/102', confidence: 0.95, box_2d: [0, 0, 200, 200] },
        { card_name: 'Blastoise', card_number: '', confidence: 0.9, box_2d: [0, 200, 200, 400] },
        { card_name: 'Venusaur', card_number: '15/102', confidence: 0.4, box_2d: [0, 400, 200, 600] },
        { card_name: 'Mystery', card_number: '', confidence: 0.2, box_2d: [200, 0, 400, 200] },
    ];
    const weak = needsCloserLook(cards);
    assert.deepEqual(weak.map(w => w.card.card_name), ['Mystery', 'Venusaur', 'Blastoise'],
        'worst first, so a capped retry budget is spent where it helps most');
    assert.ok(!weak.some(w => w.card.card_name === 'Charizard'),
        'a card read clearly is not re-read');
});

test('a card with no box cannot be re-read, however weak', () => {
    const weak = needsCloserLook([{ card_name: 'Blur', confidence: 0.1 }]);
    assert.deepEqual(weak, [], 'there is nothing to crop to');
});

/**
 * The obvious way for a refinement pass to make things worse: a closer look
 * that comes back blank overwriting what the first pass read correctly.
 */
test('a closer look fills gaps without erasing what was already read', () => {
    const first = {
        card_name: 'Zygarde', card_name_en: 'Zygarde', card_number: '',
        card_set: '', confidence: 0.5, year: 2025, box_2d: [0, 0, 300, 200],
    };
    const closer = {
        card_name: 'Mega Zygarde ex', card_number: '120/088',
        card_set: 'Perfect Order', confidence: 0.95, year: 0,
    };
    const merged = mergeCloserLook(first, closer);

    assert.equal(merged.card_number, '120/088', 'the field the first pass missed is filled in');
    assert.equal(merged.card_name, 'Mega Zygarde ex', 'and a better read of the name wins');
    assert.equal(merged.card_name_en, 'Zygarde', 'a field the re-read left blank is kept');
    assert.equal(merged.year, 2025, 'and so is a year it reported as zero');
    assert.equal(merged.confidence, 0.95);
    assert.deepEqual(merged.box_2d, [0, 0, 300, 200],
        'the box stays in the original frame\'s coordinates, not the crop\'s');
});

test('a closer look that returns nothing changes nothing', () => {
    const first = { card_name: 'Pikachu', card_number: '58/102', confidence: 0.8 };
    assert.deepEqual(mergeCloserLook(first, null), first);
    assert.equal(mergeCloserLook(first, { card_name: '   ', card_number: '' }).card_name, 'Pikachu',
        'whitespace is not a reading');
});

/**
 * A card lying on its side is unreadable at grid size, which is the whole
 * point of cutting it out. These pin how far it gets turned.
 */
test('the model\'s reading of how the card sits is trusted when it gave one', () => {
    for (const d of [0, 90, 180, 270]) {
        assert.deepEqual(uprightRotation(d, { width: 100, height: 140 }), { degrees: d, certain: true });
    }
    // A sideways card the model called upright stays upright: it can see where
    // the name is and the box shape cannot.
    assert.deepEqual(uprightRotation(0, { width: 140, height: 100 }), { degrees: 0, certain: true });
});

test('an off-axis answer is snapped to a square turn rather than letterboxed', () => {
    assert.equal(uprightRotation(88).degrees, 90);
    assert.equal(uprightRotation(271).degrees, 270);
    assert.equal(uprightRotation(360).degrees, 0);
    assert.equal(uprightRotation(-90).degrees, 270);
});

test('with no answer, a landscape crop is still known to be on its side', () => {
    const guessed = uprightRotation(undefined, { width: 140, height: 100 });
    assert.equal(guessed.degrees, 90, 'a quarter turn beats leaving it sideways');
    assert.equal(guessed.certain, false, 'but which way up is genuinely unknown');

    // Portrait already: leave it alone rather than spin it on a hunch.
    assert.deepEqual(uprightRotation(undefined, { width: 100, height: 140 }), { degrees: 0, certain: true });
    assert.deepEqual(uprightRotation(null, undefined), { degrees: 0, certain: true });
});

/**
 * Straightening pictures already in the database is the only thing that helps
 * the cards already in the collection — but a wrong call here turns an upright
 * card onto its side, which is worse than doing nothing.
 */
test('a tight crop of a card lying down is recognised as sideways', () => {
    assert.equal(looksSideways({ width: 880, height: 630 }), true, 'a card\'s own proportions, turned');
    assert.equal(looksSideways({ width: 560, height: 400 }), true, 'loosely cut, still a card on its side');
});

test('an upright card is left alone, however it was cut', () => {
    assert.equal(looksSideways({ width: 630, height: 880 }), false);
    assert.equal(looksSideways({ width: 700, height: 980 }), false);
    assert.equal(looksSideways({ width: 500, height: 500 }), false, 'square decides nothing');
});

test('a landscape photograph of an upright card is not straightened', () => {
    // 16:9 and wider: the frame is landscape, the card inside it is not.
    assert.equal(looksSideways({ width: 1920, height: 1080 }), false);
    assert.equal(looksSideways({ width: 1600, height: 900 }), false);
    // A panorama of a whole shelf, likewise.
    assert.equal(looksSideways({ width: 3000, height: 1000 }), false);
});

test('a missing or nonsense size decides nothing', () => {
    assert.equal(looksSideways(), false);
    assert.equal(looksSideways({ width: 0, height: 0 }), false);
    assert.equal(looksSideways({ width: -5, height: 10 }), false);
});
