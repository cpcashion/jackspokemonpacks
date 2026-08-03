/**
 * The rule that decides whether a card gets a number.
 *
 * This app has had this wrong in both directions. It priced everything by loose
 * name-and-number matching, and valued a common Steelix at $206 off a different
 * Steelix in a different set. The correction — refuse to price anything
 * unconfirmed — then hid cards it had identified perfectly, and the collection
 * total silently excluded them.
 *
 * These pin the third answer: always produce a number when the card is
 * identifiable, and carry how much to trust it alongside.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { tierFor, scaleConfidence, shouldReplace, asReasonClause, TIERS } from '../lib/price-tier.js';

test('a confirmed printing with a price is a market price', () => {
    const t = tierFor({ verified: true, price: 412.5 });
    assert.equal(t.tier, 'confirmed');
    assert.equal(t.label, 'Market price');
    assert.match(t.explanation, /exact printing/i);
});

/**
 * The case from the screenshots: Rockruff, read at 100% confidence, language
 * known, set named — and no value shown because the number did not line up
 * with the Chinese database.
 */
test('an identified card with an unconfirmed printing still gets a number', () => {
    const t = tierFor({
        verified: false,
        price: 3.2,
        why: 'the closest Chinese (Simplified) match is numbered 051, not 120/105',
    });
    assert.equal(t.tier, 'estimated', 'it is priced, not withheld');
    assert.equal(t.label, 'Estimated');
    assert.match(t.explanation, /051/, 'and it says exactly what did not line up');
});

/**
 * The bug that carried the collection past $20,000.
 *
 * A Rayquaza VMAX was shown at $1,253.94 under the words "Estimated — the card
 * database could not answer — Rate limited". The app was stating in the same
 * breath that it had a price and that it had learned nothing about the card.
 *
 * An estimate is defensible when the databases answered and the answer did not
 * quite fit: the name, number and language are still known, so a figure based
 * on them means something. When they could not be reached, none of that holds
 * and there is no estimate to be made — only an admission.
 */
test('a price is never estimated on the back of a lookup that never happened', () => {
    const unreachable = tierFor({
        verified: false,
        price: 1253.94,
        answered: false,
        why: 'the card database could not answer — Rate limited',
    });
    assert.equal(unreachable.tier, 'unpriced', 'no evidence means no price, whatever a marketplace said');
    assert.equal(unreachable.unreached, true);
    assert.match(unreachable.explanation, /could not be reached/i);
    assert.doesNotMatch(unreachable.explanation, /1253|1,253/, 'and the figure is not repeated back');

    // The same card, once the databases are answering again: the reply did not
    // fit, which IS a finding, and an estimate is then reasonable.
    const answered = tierFor({
        verified: false,
        price: 1253.94,
        answered: true,
        why: 'the closest match is numbered 217, not 218/203',
    });
    assert.equal(answered.tier, 'estimated');
    assert.match(answered.explanation, /217/);
});

test('a confirmed price is unaffected by whether other lookups answered', () => {
    for (const answered of [true, false]) {
        const t = tierFor({ verified: true, price: 412.5, answered });
        assert.equal(t.tier, 'confirmed', 'confirmation is itself an answer');
    }
});

test('no price from any source is reported as such, not as zero', () => {
    const t = tierFor({ verified: true, price: 0 });
    assert.equal(t.tier, 'unpriced');
    assert.equal(t.weight, 0);
    assert.match(t.label, /No price/);

    // A zero must never read as a valuation.
    for (const price of [0, null, undefined, NaN, -5]) {
        assert.equal(tierFor({ verified: true, price }).tier, 'unpriced', `price ${price}`);
    }
});

/**
 * Two separate uncertainties, both of which belong in the number the user sees:
 * how well the sources agreed, and whether they were asked about the right card.
 */
test('confidence is scaled by how well the card was identified', () => {
    assert.equal(scaleConfidence(0.9, 'confirmed'), 0.9, 'a confirmed card keeps the engine\'s own confidence');
    assert.equal(scaleConfidence(0.9, 'estimated'), 0.54, 'a tight consensus on a card we half-identified is not a 90% answer');
    assert.equal(scaleConfidence(0.9, 'unpriced'), 0);
    assert.equal(scaleConfidence(0.9, 'nonsense'), 0, 'an unknown tier earns nothing');
    assert.equal(scaleConfidence(null, 'confirmed'), 0);
    assert.ok(scaleConfidence(2, 'confirmed') <= 1, 'never above 1');
});

/**
 * Without this a refresh that happened to fail verification would quietly
 * downgrade a card priced correctly yesterday, and the collection total would
 * drift downward over weeks with nothing to show why.
 */
test('an estimate never overwrites a confirmed price', () => {
    assert.equal(shouldReplace('confirmed', 'estimated'), false);
    assert.equal(shouldReplace('confirmed', 'unpriced'), false);
    assert.equal(shouldReplace('confirmed', 'confirmed'), true, 'a fresher confirmed price does replace');

    assert.equal(shouldReplace('estimated', 'confirmed'), true, 'confirming an estimate is an upgrade');
    assert.equal(shouldReplace('estimated', 'estimated'), true, 'a newer estimate replaces an older one');
    assert.equal(shouldReplace('estimated', 'unpriced'), false, 'losing a source does not erase the estimate');

    assert.equal(shouldReplace('unpriced', 'estimated'), true);
    assert.equal(shouldReplace('', 'estimated'), true, 'a card with no tier yet takes anything');
    assert.equal(shouldReplace(undefined, 'confirmed'), true);
});

/**
 * The reasons come from the verifier, which writes them as standalone
 * sentences for a person. They are reused verbatim rather than rewritten, so
 * they stay accurate as the verifier changes — this is the seam that has to
 * hold for that to read properly.
 */
test('a verifier message reads correctly inside the explanation', () => {
    // The real strings verifyAgainstTcgdex and verifyAgainstPokemonTcg emit.
    const cases = [
        ['Closest Chinese (Simplified) match is numbered 051, not 120/105.',
            'closest Chinese (Simplified) match is numbered 051, not 120/105'],
        ['The card database could not answer — rate limited.',
            'the card database could not answer — rate limited'],
        ['No card in the database matched that name, set and number.',
            'no card in the database matched that name, set and number'],
        ['The set and number were not legible enough to confirm the printing.',
            'the set and number were not legible enough to confirm the printing'],
    ];

    for (const [sentence, clause] of cases) {
        assert.equal(asReasonClause(sentence), clause);
        const { explanation } = tierFor({ verified: false, price: 4, why: asReasonClause(sentence) });
        assert.ok(explanation.startsWith('Estimated — '), explanation);
        assert.ok(!/ — [a-z]?[A-Z]{0,1}\.\./.test(explanation), `doubled punctuation: ${explanation}`);
    }
});

test('names and codes keep their capitals when a sentence is folded in', () => {
    assert.equal(asReasonClause('TCGdex has no listing for this set.'), 'TCGdex has no listing for this set');
    assert.equal(asReasonClause('No Chinese card matched "Rockruff" 120/105.'), 'no Chinese card matched "Rockruff" 120/105');
    assert.equal(asReasonClause(''), '');
    assert.equal(asReasonClause(null), '');
    assert.equal(asReasonClause('   '), '');
});

test('every tier explains itself in words a person can act on', () => {
    for (const [name, tier] of Object.entries(TIERS)) {
        const text = tier.explain('because reasons');
        assert.ok(text && text.length > 15, `${name} needs a real explanation, got "${text}"`);
        assert.ok(!/undefined|null|NaN/.test(text), `${name} leaked a placeholder: "${text}"`);
    }
    // And they cope with having no reason to give.
    for (const tier of Object.values(TIERS)) {
        assert.ok(tier.explain() && !/undefined/.test(tier.explain()));
    }
});
