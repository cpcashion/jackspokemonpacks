/**
 * The copy count is the one number no marketplace can verify, and value is
 * quantity × price — so a card photographed twice inflates the collection
 * total. These pin the detection, and just as importantly pin what it must
 * refuse to claim.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {
    perceptualHash,
    hammingDistance,
    decodeDataUrl,
    groupLikelySamePhoto,
    summariseCard,
    SAME_PHOTO_MAX_DISTANCE,
} from '../lib/photo-audit.js';

/** A distinctive fake "card": a coloured field with an off-centre panel. */
async function fakeCard({ bg, panel, panelTop = 40, panelLeft = 50 }) {
    return sharp({ create: { width: 300, height: 420, channels: 3, background: bg } })
        .composite([{
            input: await sharp({ create: { width: 200, height: 150, channels: 3, background: panel } }).png().toBuffer(),
            top: panelTop, left: panelLeft,
        }])
        .jpeg().toBuffer();
}

const CHARIZARD = { bg: { r: 30, g: 90, b: 200 }, panel: { r: 240, g: 200, b: 40 } };
const BLASTOISE = { bg: { r: 200, g: 40, b: 40 }, panel: { r: 20, g: 220, b: 120 }, panelTop: 200, panelLeft: 30 };

/** The same card photographed again: shifted, dimmer, recompressed. */
async function reshoot(buffer) {
    return sharp(buffer)
        .extract({ left: 5, top: 7, width: 290, height: 408 })
        .resize(300, 420)
        .modulate({ brightness: 0.9 })
        .jpeg({ quality: 70 })
        .toBuffer();
}

test('a re-shot of the same card hashes close; a different card does not', async () => {
    const a = await fakeCard(CHARIZARD);
    const again = await reshoot(a);
    const other = await fakeCard(BLASTOISE);

    const [hA, hAgain, hOther] = await Promise.all([a, again, other].map(b => perceptualHash(b, sharp)));

    assert.equal(hA.length, 64, 'a 64-bit hash');
    assert.ok(hammingDistance(hA, hAgain) <= SAME_PHOTO_MAX_DISTANCE,
        `re-shot should be within ${SAME_PHOTO_MAX_DISTANCE}, got ${hammingDistance(hA, hAgain)}`);
    assert.ok(hammingDistance(hA, hOther) > SAME_PHOTO_MAX_DISTANCE * 2,
        `different cards should be far apart, got ${hammingDistance(hA, hOther)}`);
});

test('unreadable input yields no hash rather than a wrong one', async () => {
    assert.equal(await perceptualHash(Buffer.from('not an image'), sharp), null);
    assert.equal(await perceptualHash(Buffer.alloc(0), sharp), null);
    assert.equal(hammingDistance(null, '0'.repeat(64)), Infinity);
    assert.equal(hammingDistance('01', '0101'), Infinity, 'different lengths are not comparable');
});

test('data URLs decode, and malformed ones do not throw', () => {
    const png = Buffer.from('iVBORw0KGgo=', 'base64');
    const decoded = decodeDataUrl(`data:image/png;base64,${png.toString('base64')}`);
    assert.ok(Buffer.isBuffer(decoded));
    assert.equal(decoded.toString('base64'), png.toString('base64'));

    assert.equal(decodeDataUrl(''), null);
    assert.equal(decodeDataUrl(null), null);
    assert.equal(decodeDataUrl('https://example.com/x.png'), null);
});

// ── Grouping ───────────────────────────────────────────────────────

const H = {
    // Two hashes 2 bits apart, and one far from both.
    a:    '1'.repeat(64),
    near: '00' + '1'.repeat(62),
    far:  '0'.repeat(64),
};
const at = (s) => new Date(`2026-07-30T12:00:${String(s).padStart(2, '0')}Z`).toISOString();

test('copies photographed from one card are grouped', () => {
    const groups = groupLikelySamePhoto([
        { id: 1, hash: H.a, created_at: at(0) },
        { id: 2, hash: H.near, created_at: at(3) },
        { id: 3, hash: H.far, created_at: at(5) },
    ]);
    assert.equal(groups.length, 1, 'one suspected group');
    assert.deepEqual(groups[0].ids, [1, 2]);
    assert.equal(groups[0].sameBatch, true, 'seconds apart is one upload');
    assert.ok(!groups.some(g => g.ids.includes(3)), 'the genuinely different card is left alone');
});

/**
 * Four photos walking around one card: each is close to the last but the first
 * and last may not be close to each other. They are still one card.
 */
test('grouping is transitive, so a slow drift stays one group', () => {
    const drift = (n) => '0'.repeat(n) + '1'.repeat(64 - n);
    const groups = groupLikelySamePhoto([
        { id: 1, hash: drift(0), created_at: at(0) },
        { id: 2, hash: drift(6), created_at: at(1) },
        { id: 3, hash: drift(12), created_at: at(2) },
        { id: 4, hash: drift(18), created_at: at(3) },
    ]);
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0].ids, [1, 2, 3, 4]);
    assert.ok(groups[0].maxDistance > SAME_PHOTO_MAX_DISTANCE,
        'the extremes are further apart than the threshold, which is the point of transitivity');
});

/**
 * The important refusal. A copy added by hand, or one predating the thumbnail,
 * carries no evidence — and absent evidence must never be read as a match.
 */
test('copies with no photo are never grouped', () => {
    const groups = groupLikelySamePhoto([
        { id: 1, hash: null, created_at: at(0) },
        { id: 2, hash: null, created_at: at(1) },
        { id: 3, hash: '', created_at: at(2) },
    ]);
    assert.deepEqual(groups, [], 'no photo means no claim');
});

test('one copy is never a duplicate of itself', () => {
    assert.deepEqual(groupLikelySamePhoto([{ id: 1, hash: H.a, created_at: at(0) }]), []);
    assert.deepEqual(groupLikelySamePhoto([]), []);
    assert.deepEqual(groupLikelySamePhoto(null), []);
});

test('photos far apart in time are still flagged, but not as one batch', () => {
    const groups = groupLikelySamePhoto([
        { id: 1, hash: H.a, created_at: '2026-07-01T10:00:00Z' },
        { id: 2, hash: H.near, created_at: '2026-07-20T18:30:00Z' },
    ]);
    assert.equal(groups.length, 1, 'the same photo weeks later is still worth surfacing');
    assert.equal(groups[0].sameBatch, false, 'but it is not one upload, so it is weaker evidence');
});

// ── The claim ──────────────────────────────────────────────────────

test('the summary quantifies what the count and the total would become', () => {
    const card = { id: 7, card_name: 'Charizard', card_set: 'Base Set', card_number: '4/102', unit_price: 412.5 };
    const copies = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }, { id: 6 }];
    const groups = [{ ids: [1, 2, 3, 4, 5, 6], size: 6, maxDistance: 3, sameBatch: true }];

    const s = summariseCard(card, copies, groups);
    assert.equal(s.quantity, 6, 'what the app currently says');
    assert.equal(s.suggestedQuantity, 1, 'six photos of one card is one card');
    assert.equal(s.duplicateCopies, 5);
    assert.equal(s.overstatedValue, 2062.5, '5 phantom copies × $412.50');
});

test('two real cards each photographed twice suggests two, not one', () => {
    const card = { id: 8, card_name: 'Pikachu', unit_price: 10 };
    const copies = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
    const groups = [
        { ids: [1, 2], size: 2, maxDistance: 1, sameBatch: true },
        { ids: [3, 4], size: 2, maxDistance: 2, sameBatch: true },
    ];
    const s = summariseCard(card, copies, groups);
    assert.equal(s.suggestedQuantity, 2, 'two distinct cards survive');
    assert.equal(s.overstatedValue, 20);
});

test('a card with nothing suspicious reports no change', () => {
    const card = { id: 9, card_name: 'Snorlax', unit_price: 31.75 };
    const copies = [{ id: 1 }, { id: 2 }];
    const s = summariseCard(card, copies, []);
    assert.equal(s.suggestedQuantity, s.quantity);
    assert.equal(s.duplicateCopies, 0);
    assert.equal(s.overstatedValue, 0);
});
