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
    BOX_SCALE,
} from '../lib/card-crop.js';

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
