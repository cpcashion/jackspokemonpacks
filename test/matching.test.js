/**
 * Card identification from printed evidence.
 *
 * The rule these tests exist to protect: what is *printed on the card* decides
 * which printing it is. What the model *guessed* about it can raise confidence
 * but must never be required and must never veto.
 *
 * The failure that motivated this: a Steelix reading "093/132" was labelled
 * "Temporal Forces" by the model. Temporal Forces has 162 cards, so no card in
 * it is numbered out of 132 — the guess was refutable by the card itself. But
 * the matcher discarded the denominator entirely, could not use the number to
 * place the card, fell back to the guessed set name, found nothing, and parked
 * the card in a queue for a human. A card that legible should never have
 * needed a person.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCardNumber, printedSetTotal, normalizeCardNumber } from '../lib/identity.js';
import {
    compareCandidate,
    isLikelyVerifiedMatch,
    scorePokemonCardCandidate,
    hasMeaningfulCardName,
} from '../lib/matching.js';

// ── The denominator ────────────────────────────────────────────────

test('the printed set size is read off the card number', () => {
    assert.equal(printedSetTotal('093/132'), 132);
    assert.equal(printedSetTotal('4/102'), 102);
    assert.equal(printedSetTotal('014/191'), 191);
    assert.equal(printedSetTotal('TG12/TG30'), 30);
    assert.equal(printedSetTotal('０９３/１３２'), 132, 'full-width numerals, as Japanese cards print them');
});

/**
 * A missing denominator means "no evidence", never "mismatch" — promos and
 * subset numbering often have none, and treating absence as a conflict would
 * reject cards that are perfectly identifiable by other means.
 */
test('a card with no denominator reports zero rather than guessing', () => {
    assert.equal(printedSetTotal('SWSH045'), 0);
    assert.equal(printedSetTotal('PROMO'), 0);
    assert.equal(printedSetTotal(''), 0);
    assert.equal(printedSetTotal(null), 0);
    assert.equal(printedSetTotal('93/'), 0);
});

test('parseCardNumber keeps both halves of what is printed', () => {
    assert.deepEqual(parseCardNumber('093/132'), { number: '93', printedTotal: 132 });
    assert.deepEqual(parseCardNumber('TG12/TG30'), { number: 'TG12', printedTotal: 30 });
    assert.deepEqual(parseCardNumber('SWSH045'), { number: 'SWSH45', printedTotal: 0 });
    // The numerator still normalises exactly as it did before.
    assert.equal(parseCardNumber('004/102').number, normalizeCardNumber('004/102'));
});

// ── Matching ───────────────────────────────────────────────────────
//
// These call the real matcher from lib/matching.js, with the object shapes the
// Pokémon TCG API actually returns.

const candidate = (over = {}) => ({
    name: 'Steelix',
    number: '93',
    rarity: 'Rare',
    set: { name: 'Mega Evolution', printedTotal: 132, total: 200, releaseDate: '2025/09/26' },
    ...over,
});

/** The real matcher, with `conflicts` aliased to keep these tests readable. */
function printedEvidenceAgrees(card, cand) {
    const m = compareCandidate(card, cand);
    return { ...m, conflicts: m.setSizeConflicts };
}

/** Would this candidate be accepted and priced against? */
const wouldVerify = (card, cand) =>
    isLikelyVerifiedMatch(scorePokemonCardCandidate(card, cand), cand, card);

test('the real Steelix is identified despite a wrong set-name guess', () => {
    const card = { card_name: 'Steelix', card_set: 'Temporal Forces', card_number: '093/132' };
    const m = printedEvidenceAgrees(card, candidate());

    assert.equal(m.number, true, 'the number printed on the card matches');
    assert.equal(m.setSize, true, 'and so does the size of the set it came from');
    assert.equal(m.conflicts, false);
    // Everything printed agrees. The wrong set name is simply not consulted.
});

test('a set-size conflict rules a candidate out, however well it otherwise scores', () => {
    const card = { card_name: 'Steelix', card_set: 'Temporal Forces', card_number: '093/132' };
    // A different Steelix, also numbered 93, from a 162-card set.
    const wrong = candidate({ set: { name: 'Temporal Forces', printedTotal: 162, total: 218, releaseDate: '2024/03/22' } });
    const m = printedEvidenceAgrees(card, wrong);

    assert.equal(m.number, true, 'the numerator alone is not enough to tell them apart');
    assert.equal(m.conflicts, true, 'but the set size proves this is a different printing');
    // This is precisely the confusion that produced a $206 valuation for a
    // card worth cents: same name, same numerator, different set.
});

test('a card with no denominator is not treated as conflicting with anything', () => {
    const card = { card_name: 'Pikachu', card_number: 'SWSH045' };
    const m = printedEvidenceAgrees(card, candidate({ name: 'Pikachu', number: 'SWSH045' }));
    assert.equal(m.conflicts, false, 'absent evidence is not contrary evidence');
    assert.equal(m.number, true);
    assert.equal(m.setSize, false, 'and it claims no set-size support it does not have');
});

test('a candidate with no printedTotal falls back to its total', () => {
    const card = { card_name: 'Steelix', card_number: '093/132' };
    const noPrinted = candidate({ set: { name: 'Mega Evolution', total: 132, releaseDate: '2025/09/26' } });
    assert.equal(printedEvidenceAgrees(card, noPrinted).setSize, true);
});

/**
 * Several printings sharing a name is the normal case, not an ambiguity: the
 * card in your hand says which one it is. Only a genuine tie on printed
 * evidence is undecidable.
 */
test('same name, different sets: the printed number picks one', () => {
    const card = { card_name: 'Steelix', card_number: '093/132' };
    const options = [
        candidate({ set: { name: 'Mega Evolution', printedTotal: 132, releaseDate: '2025/09/26' } }),
        candidate({ set: { name: 'Temporal Forces', printedTotal: 162, releaseDate: '2024/03/22' } }),
        candidate({ number: '108', set: { name: 'Lost Origin', printedTotal: 196, releaseDate: '2022/09/09' } }),
    ];
    const fits = options.filter((o) => {
        const m = printedEvidenceAgrees(card, o);
        return m.number && !m.conflicts;
    });
    assert.equal(fits.length, 1, 'exactly one printing fits everything on the card');
    assert.equal(fits[0].set.name, 'Mega Evolution');
});

test('Japanese numbering does not collide with English numbering', () => {
    // A Japanese Charizard numbered 013/102 must not match English 4/102 just
    // because the denominators happen to agree.
    const jp = { card_name: 'リザードン', card_name_en: 'Charizard', card_number: '013/102', language: 'japanese' };
    const en = candidate({ name: 'Charizard', number: '4', set: { name: 'Base', printedTotal: 102, releaseDate: '1999/01/09' } });
    const m = printedEvidenceAgrees(jp, en);
    assert.equal(m.setSize, true, 'the set sizes coincide');
    assert.equal(m.number, false, 'but the numbers do not, which is what decides it');
});

// ── The whole decision, end to end ─────────────────────────────────

/**
 * The four cards sitting unpriced in the app, with the fields the model read
 * off them. Each of these was handed to a person to resolve. None should have
 * been: everything needed to place them is printed on the card.
 */
test('the cards that were stuck in review are identified automatically', () => {
    const stuck = [
        {
            card: { card_name: 'Steelix', card_set: 'Temporal Forces', card_number: '093/132', rarity: 'Rare', confidence: 0.95 },
            match: candidate(),
            expect: 'Mega Evolution',
        },
        {
            card: { card_name: 'Rabsca', card_set: 'Special Deck', card_number: '014/191', confidence: 0.93 },
            match: candidate({ name: 'Rabsca', number: '14', set: { name: 'Surging Sparks', printedTotal: 191, total: 252, releaseDate: '2024/11/08' } }),
            expect: 'Surging Sparks',
        },
        {
            card: { card_name: 'Xerneas', card_set: 'XY Black Star', card_number: '064/132', confidence: 0.9 },
            match: candidate({ name: 'Xerneas', number: '64', set: { name: 'Mega Evolution', printedTotal: 132, total: 200, releaseDate: '2025/09/26' } }),
            expect: 'Mega Evolution',
        },
    ];

    for (const { card, match, expect } of stuck) {
        assert.equal(wouldVerify(card, match), true,
            `"${card.card_name} ${card.card_number}" should identify without a person, and resolve to ${expect}`);
    }
});

test('a guessed set name is never required to confirm a card', () => {
    // No set name at all — the model declined to guess, which the prompt now
    // explicitly prefers over guessing wrong.
    const card = { card_name: 'Steelix', card_set: '', card_number: '093/132', confidence: 0.9 };
    assert.equal(wouldVerify(card, candidate()), true,
        'name plus number plus set size is sufficient on its own');
});

test('a guessed set name is never enough to confirm the wrong card', () => {
    // The set name agrees, but the card says it came from a set of 132 and this
    // candidate is from a set of 162. The card wins.
    const card = { card_name: 'Steelix', card_set: 'Temporal Forces', card_number: '093/132', confidence: 0.99 };
    const wrong = candidate({ set: { name: 'Temporal Forces', printedTotal: 162, total: 218, releaseDate: '2024/03/22' } });
    assert.equal(wouldVerify(card, wrong), false,
        'a set-size conflict must override a matching name and number');
});

test('the right printing outscores a same-name, same-number impostor', () => {
    const card = { card_name: 'Steelix', card_set: 'Temporal Forces', card_number: '093/132', confidence: 0.95 };
    const right = candidate();
    const wrong = candidate({ set: { name: 'Temporal Forces', printedTotal: 162, total: 218, releaseDate: '2024/03/22' } });

    // Note the wrong one has the set name the model guessed, and still loses.
    assert.ok(scorePokemonCardCandidate(card, right) > scorePokemonCardCandidate(card, wrong),
        `right ${scorePokemonCardCandidate(card, right)} should beat wrong ${scorePokemonCardCandidate(card, wrong)}`);
});

test('promos with no denominator still confirm on softer evidence', () => {
    const card = { card_name: 'Pikachu', card_set: 'SWSH Black Star Promos', card_number: 'SWSH045', confidence: 0.9, year: 2021 };
    const promo = candidate({
        name: 'Pikachu', number: 'SWSH045',
        set: { name: 'SWSH Black Star Promos', printedTotal: 0, total: 307, releaseDate: '2021/02/22' },
    });
    assert.equal(wouldVerify(card, promo), true,
        'no denominator is printed, so the set name and year carry the match');
});

test('a misread name is never confirmed, whatever else agrees', () => {
    const card = { card_name: 'Steelox', card_set: 'Mega Evolution', card_number: '093/132', confidence: 0.99 };
    assert.equal(wouldVerify(card, candidate()), false,
        'the name has to match; nothing else substitutes for it');
});

test('placeholder names are refused in any language', () => {
    for (const junk of ['Pokemon', 'unknown', 'Trainer', 'ポケモン', '宝可梦', '포켓몬', '']) {
        assert.equal(hasMeaningfulCardName(junk), false, `"${junk}" is not a card name`);
    }
    for (const real of ['Steelix', 'リザードン', '古空棘鱼', '리자몽']) {
        assert.equal(hasMeaningfulCardName(real), true, `"${real}" is a card name`);
    }
});
