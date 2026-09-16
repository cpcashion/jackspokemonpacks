/**
 * Which picture gets shown for a card.
 *
 * The failure these pin: stock artwork is shown in preference to the owner's
 * own photograph, so a wrong picture is not a cosmetic slip — it is the app
 * asserting, sharply and confidently, that you own a card you do not. The old
 * matcher took the first search result whose number matched, and card numbers
 * repeat across sets, so "Steelix 93" picked among a dozen printings by
 * whichever the API happened to return first.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseArtwork, matchesPrintedNumber, matchesSetName, MATCH_PRINTED, MATCH_SET_NAME } from '../lib/artwork.js';
import { parseCardNumber } from '../lib/identity.js';

const steelix = (setOfficialCount, setName, image = 'img') =>
    ({ localId: '93', setOfficialCount, setName, image });

test('the denominator picks the printing out, and the bare number does not', () => {
    const printed = parseCardNumber('093/132');
    const candidates = [
        steelix(162, 'Temporal Forces'),      // same number, different set
        steelix(132, 'Mega Evolution'),       // the one actually in hand
        steelix(198, 'Scarlet & Violet'),
    ];

    const picked = chooseArtwork(candidates, printed);
    assert.ok(picked, 'a card with a denominator resolves');
    assert.equal(picked.candidate.setName, 'Mega Evolution');
    assert.equal(picked.match, MATCH_PRINTED);
});

test('a number that matches nothing printed gets no picture at all', () => {
    const printed = parseCardNumber('093/132');
    // Every candidate is numbered 93, none is from a 132-card set.
    const picked = chooseArtwork([steelix(162, 'A'), steelix(198, 'B')], printed);
    assert.equal(picked, null, 'showing somebody else\'s Steelix is worse than showing none');
});

test('two cards with the same number in equally-sized sets is not a tie to break', () => {
    const printed = parseCardNumber('093/132');
    const picked = chooseArtwork([steelix(132, 'One'), steelix(132, 'Two')], printed);
    assert.equal(picked, null, 'ambiguous evidence settles nothing');
});

test('leading zeros and numeric ids do not stop a match', () => {
    const printed = parseCardNumber('019/086');
    assert.equal(matchesPrintedNumber({ localId: '019', setOfficialCount: 86 }, printed), true);
    assert.equal(matchesPrintedNumber({ localId: 19, setOfficialCount: 86 }, printed), true);
    assert.equal(matchesPrintedNumber({ localId: '19', setOfficialCount: 87 }, printed), false,
        'a set one card larger is a different set');
});

test('a promo with no denominator falls back to the set name, and admits it', () => {
    const printed = parseCardNumber('070');
    const candidates = [
        { localId: '70', setName: 'Mega Evolution Promos', image: 'a' },
        { localId: '70', setName: 'Scarlet & Violet Promos', image: 'b' },
    ];
    const picked = chooseArtwork(candidates, printed, 'Mega Evolution Promos');
    assert.equal(picked.match, MATCH_SET_NAME, 'a weaker claim is labelled as one');
    assert.equal(picked.candidate.image, 'a');

    assert.equal(chooseArtwork(candidates, printed, ''), null,
        'with no set name either, nothing identifies it');
});

test('a candidate with no image is never chosen, however well it matches', () => {
    const printed = parseCardNumber('093/132');
    assert.equal(chooseArtwork([{ localId: '93', setOfficialCount: 132 }], printed), null);
});

test('the set name is compared loosely, but never stands in for a denominator', () => {
    assert.equal(matchesSetName({ setName: 'Mega Evolution' }, 'mega evolution'), true);
    assert.equal(matchesSetName({ setName: 'Base Set' }, 'Base'), true);
    assert.equal(matchesSetName({ setName: '' }, 'Base'), false);

    // A denominator that disagrees is not rescued by a matching set name.
    const printed = parseCardNumber('093/132');
    const picked = chooseArtwork([steelix(162, 'Mega Evolution')], printed, 'Mega Evolution');
    assert.equal(picked, null);
});
