/**
 * eBay comps.
 *
 * A search for "Charizard 4/102" returns a PSA 10 at $12,000, a bulk lot at
 * $9.99, a custom-art proxy at $4, a Japanese printing, an empty booster
 * wrapper, and somewhere in there the raw English card. Averaging that produces
 * a number with no meaning, so these tests are mostly about what gets thrown
 * away — using titles in the shapes sellers actually write them.
 *
 * The asymmetry that sets the tuning: a good listing wrongly excluded costs one
 * comp out of dozens. A graded slab wrongly included moves the estimate by an
 * order of magnitude.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    classifyTitle,
    titleMatchesCard,
    judgeListing,
    estimateFromComps,
    compsFromListings,
    buildSearchQuery,
    buildSearchQueries,
    quantile,
} from '../lib/ebay-comps.js';

const ZARD = { name: 'Charizard', number: '4', printedTotal: 102, language: 'english' };

// ── Reading a title ────────────────────────────────────────────────

test('graded slabs are recognised in the forms sellers write them', () => {
    const graded = [
        'Pokemon Charizard 4/102 Base Set PSA 10 GEM MINT',
        'Charizard Base Set 4/102 BGS 9.5',
        'Charizard 4/102 CGC 8.5 Base Set Holo',
        'Charizard 4/102 SGC 9',
        '1999 Pokemon Charizard #4 PSA10',
        'Charizard 4/102 GEM MT 10',
        'Charizard 4/102 Base Set graded slab',
    ];
    for (const t of graded) {
        assert.equal(classifyTitle(t).graded, true, `should be graded: "${t}"`);
    }

    const raw = [
        'Pokemon Charizard 4/102 Base Set Holo Rare NM',
        'Charizard 4/102 Unlimited Near Mint',
        'Charizard Base Set 4/102 lightly played',
    ];
    for (const t of raw) {
        assert.equal(classifyTitle(t).graded, false, `should be raw: "${t}"`);
    }
});

test('the grader and grade are read out when present', () => {
    assert.deepEqual(
        (({ grader, grade }) => ({ grader, grade }))(classifyTitle('Charizard 4/102 PSA 10 GEM MINT')),
        { grader: 'PSA', grade: 10 });
    assert.equal(classifyTitle('Charizard BGS 9.5 4/102').grade, 9.5);
    assert.equal(classifyTitle('Charizard 4/102 Base Set NM').grade, null);
});

/**
 * The single most common way a naive comp search reports a $400 card as worth
 * $12: a bulk lot whose title happens to name it.
 */
test('multi-card lots are recognised', () => {
    const lots = [
        'Lot of 50 Pokemon Cards Charizard Guaranteed',
        'Pokemon 100 Cards Bundle Charizard 4/102',
        'Charizard 4/102 + 20 cards bulk',
        'Pokemon Card Binder Collection of 200 inc Charizard',
        'Mystery Repack Charizard 4/102 chance',
        'Pokemon job lot Charizard 4/102',
    ];
    for (const t of lots) assert.equal(classifyTitle(t).isLot, true, `should be a lot: "${t}"`);

    assert.equal(classifyTitle('Pokemon Charizard 4/102 Base Set Holo').isLot, false);
});

test('proxies, customs and non-cards are recognised', () => {
    for (const t of [
        'Charizard 4/102 Custom Orica Proxy Card',
        'Charizard Base Set 4/102 fan made art card',
        'Charizard 4/102 replica reprint',
        'Pokemon Charizard 4/102 PTCGO code card',
        'Charizard 4/102 sticker',
    ]) {
        assert.equal(classifyTitle(t).isNotReal, true, `should be excluded: "${t}"`);
    }
    assert.equal(classifyTitle('Pokemon Charizard 4/102 Base Set Holo Rare').isNotReal, false);
});

test('sealed product is not a single card', () => {
    for (const t of [
        'Pokemon Base Set Booster Box Charizard',
        'Elite Trainer Box sealed Charizard promo',
        'Pokemon booster pack Charizard 4/102 art',
    ]) {
        assert.equal(classifyTitle(t).isSealed, true, `should be sealed: "${t}"`);
    }
});

test('language markers are read off the title', () => {
    assert.equal(classifyTitle('Japanese Pokemon Charizard Base Set').language, 'japanese');
    assert.equal(classifyTitle('Pokemon Charizard Korean 4/102').language, 'korean');
    assert.equal(classifyTitle('Charizard Deutsch Basis Set').language, 'german');
    assert.equal(classifyTitle('Pokemon Charizard 4/102 Base Set Holo').language, 'english',
        'no marker means English, which is the overwhelming default');
});

test('1st Edition and Shadowless are noticed', () => {
    assert.equal(classifyTitle('Charizard 4/102 1st Edition Base Set').isFirstEdition, true);
    assert.equal(classifyTitle('Charizard 4/102 First Ed Shadowless').isShadowless, true);
    assert.equal(classifyTitle('Charizard 4/102 Base Set Unlimited').isFirstEdition, false);
});

// ── Is it even the same card ───────────────────────────────────────

test('the card number is matched in the shapes sellers write it', () => {
    for (const t of [
        'Pokemon Charizard 4/102 Base Set',
        'Pokemon Charizard 004/102 Base Set',
        'Pokemon Charizard #4 Base Set Holo',
        'Pokemon Charizard No. 4 Base Set',
    ]) {
        assert.equal(titleMatchesCard(t, ZARD).confident, true, `should match: "${t}"`);
    }
});

test('a name alone is not enough, because it matches every printing ever made', () => {
    const m = titleMatchesCard('Pokemon Charizard VMAX Rainbow Rare', ZARD);
    assert.equal(m.name, true);
    assert.equal(m.number, false);
    assert.equal(m.confident, false, 'without the number this could be any of a hundred Charizards');
});

test('a different Pokemon is rejected outright', () => {
    assert.equal(titleMatchesCard('Pokemon Charmander 46/102 Base Set', ZARD).name, false);
});

test('punctuated names match however the seller wrote them', () => {
    const farfetchd = { name: "Farfetch'd", number: '27', printedTotal: 64 };
    for (const t of ["Pokemon Farfetch'd 27/64 Jungle", 'Pokemon Farfetchd 27/64 Jungle']) {
        assert.equal(titleMatchesCard(t, farfetchd).confident, true, `should match: "${t}"`);
    }
    const hooh = { name: 'Ho-Oh', number: '22', printedTotal: 64 };
    assert.equal(titleMatchesCard('Pokemon Ho Oh 22/64 holo', hooh).confident, true);
});

// ── The verdict, with reasons ──────────────────────────────────────

test('a raw card rejects slabs, and a slab rejects raw', () => {
    const slab = { title: 'Charizard 4/102 Base Set PSA 10' };
    assert.equal(judgeListing(slab, ZARD).ok, false);
    assert.match(judgeListing(slab, ZARD).reason, /graded/);

    // The same listing is exactly what we want when our copy is a PSA 10.
    const ourSlab = { ...ZARD, graded: true, grade: 10 };
    assert.equal(judgeListing(slab, ourSlab).ok, true);

    // But a PSA 9 is a different object from a PSA 10.
    assert.equal(judgeListing(slab, { ...ZARD, graded: true, grade: 9 }).ok, false);
});

test('a language mismatch is rejected in both directions', () => {
    const jp = { title: 'Japanese Pokemon Charizard 4/102 Base Set' };
    assert.match(judgeListing(jp, ZARD).reason, /japanese/);
    assert.equal(judgeListing(jp, { ...ZARD, language: 'japanese' }).ok, true);
});

test('a 1st Edition mismatch is rejected in both directions', () => {
    const firstEd = { title: 'Charizard 4/102 1st Edition Base Set Holo' };
    assert.match(judgeListing(firstEd, ZARD).reason, /1st Edition/);
    assert.equal(judgeListing(firstEd, { ...ZARD, isFirstEdition: true }).ok, true);
});

test('a clean raw listing is accepted', () => {
    assert.equal(judgeListing({ title: 'Pokemon Charizard 4/102 Base Set Holo Rare Near Mint' }, ZARD).ok, true);
});

// ── Choosing the number ────────────────────────────────────────────

const auction = (price, bids) => ({
    title: 'Pokemon Charizard 4/102 Base Set Holo',
    buyingOptions: ['AUCTION'], bidCount: bids, currentBidPrice: { value: String(price) },
});
const bin = (price) => ({
    title: 'Pokemon Charizard 4/102 Base Set Holo',
    buyingOptions: ['FIXED_PRICE'], price: { value: String(price) },
});

/**
 * The core judgement. A bid is a buyer committing real money; an asking price
 * is a seller's hope. When both exist, the bids decide.
 */
test('auction bids outrank asking prices', () => {
    const e = estimateFromComps([
        auction(300, 5), auction(320, 3), auction(310, 8),
        bin(900), bin(950), bin(1000),
    ]);
    assert.equal(e.basis, 'auction bids');
    assert.equal(e.price, 310, 'the median bid, not the asks');
    assert.equal(e.samples, 3);
    assert.equal(e.asksSeen, 3, 'and it says how many asks it set aside');
});

/**
 * Sellers list above what cards clear at, so the middle of the ask distribution
 * is systematically high. The bottom of it is closer to reality.
 */
test('with no bids, the lower end of asking prices is used', () => {
    const e = estimateFromComps([bin(100), bin(120), bin(140), bin(400), bin(500)]);
    assert.equal(e.basis, 'asking prices');
    assert.ok(e.price < 140, `should sit at the low end, got ${e.price}`);
    assert.ok(e.price >= 100);
    assert.match(e.note, /above what cards clear at/);
});

test('an auction with no bids is an asking price, not a signal', () => {
    const e = estimateFromComps([
        { title: 'x', buyingOptions: ['AUCTION'], bidCount: 0, price: { value: '50' } },
        bin(60), bin(70),
    ]);
    assert.equal(e.basis, 'asking prices', 'a starting price nobody has bid on is just an ask');
});

test('one or two asking prices is an anecdote, not a market', () => {
    assert.equal(estimateFromComps([bin(100)]), null);
    assert.equal(estimateFromComps([bin(100), bin(120)]), null);
    assert.equal(estimateFromComps([]), null);
    // But a single real bid is still a real buyer.
    assert.equal(estimateFromComps([auction(300, 4)]).price, 300);
});

test('wild outliers are trimmed', () => {
    const e = estimateFromComps([auction(300, 2), auction(310, 3), auction(320, 1), auction(99999, 1)]);
    assert.ok(e.price < 400, `the $99,999 listing must not drag the estimate, got ${e.price}`);
});

test('quantile interpolates rather than picking a neighbour', () => {
    assert.equal(quantile([10, 20, 30, 40], 0.5), 25);
    assert.equal(quantile([10, 20, 30], 0), 10);
    assert.equal(quantile([10, 20, 30], 1), 30);
    assert.equal(quantile([], 0.5), null);
});

// ── The whole pipeline ─────────────────────────────────────────────

/**
 * A realistic search result: mostly noise, with a few real comps in it.
 */
test('a realistic mixed result set yields a defensible number', () => {
    const listings = [
        { title: 'Pokemon Charizard 4/102 Base Set PSA 10 GEM MINT', price: { value: '12000' }, buyingOptions: ['FIXED_PRICE'] },
        { title: 'Lot of 50 Pokemon Cards inc Charizard 4/102', price: { value: '9.99' }, buyingOptions: ['FIXED_PRICE'] },
        { title: 'Charizard 4/102 Custom Orica Proxy', price: { value: '4.00' }, buyingOptions: ['FIXED_PRICE'] },
        { title: 'Japanese Charizard 4/102 Base Set', price: { value: '200' }, buyingOptions: ['FIXED_PRICE'] },
        { title: 'Pokemon Booster Box Base Set Charizard', price: { value: '8000' }, buyingOptions: ['FIXED_PRICE'] },
        { title: 'Pokemon Charmander 46/102 Base Set', price: { value: '5' }, buyingOptions: ['FIXED_PRICE'] },
        // The three real ones.
        { title: 'Pokemon Charizard 4/102 Base Set Holo Rare NM', buyingOptions: ['AUCTION'], bidCount: 12, currentBidPrice: { value: '395' } },
        { title: 'Charizard 004/102 Base Set Unlimited Holo LP', buyingOptions: ['AUCTION'], bidCount: 7, currentBidPrice: { value: '360' } },
        { title: 'Pokemon Charizard #4 Base Set holo played', buyingOptions: ['AUCTION'], bidCount: 3, currentBidPrice: { value: '410' } },
    ];

    const result = compsFromListings(listings, ZARD);
    assert.equal(result.considered, 9);
    assert.equal(result.accepted, 3, 'only the three raw English singles survive');
    assert.equal(result.estimate.basis, 'auction bids');
    assert.equal(result.estimate.price, 395);

    // The rejections are informative and are reported rather than swallowed.
    assert.ok(result.rejectedBecause['graded slab, ours is raw'] >= 1);
    assert.ok(result.rejectedBecause['multi-card lot'] >= 1);
    assert.ok(result.rejectedBecause['different card'] >= 1);
});

test('when everything is rejected it says so rather than inventing a price', () => {
    const result = compsFromListings([
        { title: 'Lot of 100 Pokemon Cards', price: { value: '20' } },
        { title: 'Pokemon Pikachu 58/102', price: { value: '5' } },
    ], ZARD);
    assert.equal(result.estimate, null);
    assert.equal(result.accepted, 0);
});

test('the search query names the card without over-specifying', () => {
    assert.equal(buildSearchQuery(ZARD), 'pokemon Charizard 4/102');
    assert.equal(buildSearchQuery({ ...ZARD, isFirstEdition: true }), 'pokemon Charizard 4/102 1st edition');
    assert.equal(buildSearchQuery({ ...ZARD, language: 'japanese' }), 'pokemon Charizard 4/102 japanese');
    // The set name is deliberately absent from the first query: sellers do not
    // all write it, and including it drops honest listings. It gets its own
    // rung further down the ladder instead.
    assert.ok(!buildSearchQuery(ZARD).includes('Base Set'));
});

/**
 * The Mega Zygarde bug, which is the reason any of this is a ladder.
 *
 * That card had 1,415 completed sales at a $75 median and the app reported no
 * price at all. Its number is printed "120/088" — a numerator larger than the
 * denominator, which set-total padding makes common on modern secret rares —
 * and the single query we sent asked for "120/88". eBay matches title text, so
 * it found nothing, and one empty search was the whole answer.
 */
test('the printed number is searched exactly as printed, padding and all', () => {
    const zygarde = {
        name: 'Mega Zygarde ex',
        number: '120',
        rawNumber: '120/088',
        printedTotal: 88,
        setName: 'Perfect Order',
        language: 'english',
    };
    const queries = buildSearchQueries(zygarde).map(x => x.q);

    assert.ok(queries[0].includes('120/088'),
        `the first search must use the number as printed, got "${queries[0]}"`);
    assert.ok(queries.some(q => q.includes('120/88')),
        'and the unpadded form is still tried, for sellers who trim the zeroes');
    assert.ok(queries.some(q => q.includes('Perfect Order')),
        'and the set name, for titles that carry no number at all');
});

/**
 * Our language slugs are internal names. "chinese-simplified" appears in no
 * listing title ever written, so sending it as a search term guaranteed zero
 * results for every Chinese card in the collection.
 */
test('language is searched in the words sellers actually type', () => {
    const base = { name: 'Rockruff', number: '120', rawNumber: '120/105', printedTotal: 105, setName: 'Cyber Judge' };
    for (const [slug, word] of [['chinese-simplified', 'chinese'], ['chinese-traditional', 'chinese'], ['japanese', 'japanese'], ['korean', 'korean']]) {
        const queries = buildSearchQueries({ ...base, language: slug }).map(x => x.q);
        assert.ok(queries.some(q => q.includes(word)), `"${word}" is what a seller writes`);
        // Only meaningful where the slug is not already the word a seller uses.
        if (slug !== word) {
            assert.ok(queries.every(q => !q.includes(slug)), `"${slug}" must never be sent as a search term`);
        }
    }
});

/**
 * Every rung after the first is looser, and looseness has to be paid for
 * somewhere. The set-name rungs waive the number requirement, so the set name
 * has to appear in the title instead — a bare name matches every printing of
 * that Pokémon ever made and can never be enough.
 */
test('a looser search demands the set name in place of the number', () => {
    const card = { name: 'Charizard', number: '4', rawNumber: '4/102', printedTotal: 102, setName: 'Base Set', language: 'english' };
    const looser = buildSearchQueries(card).filter(x => x.requireNumber === false);
    assert.ok(looser.length, 'there is a rung that does not require the number');
    assert.ok(looser.every(x => x.strict === false), 'and it is marked as not strict');

    // With the number waived, the set name carries the match.
    const withSet = titleMatchesCard('Pokemon Charizard Base Set Holo', { ...card, setName: 'Base Set', requireNumber: false });
    assert.equal(withSet.confident, true, 'name plus set name is acceptable on a loose rung');

    const bareName = titleMatchesCard('Pokemon Charizard Holo Rare', { ...card, setName: 'Base Set', requireNumber: false });
    assert.equal(bareName.confident, false, 'a bare name is never enough, on any rung');
});

/**
 * A name in a non-Latin script had every character stripped by the loose-match
 * builder, leaving a regex that matched any title at all — so a Japanese card
 * would accept comps for entirely unrelated cards.
 */
test('a CJK name is matched literally rather than matching everything', () => {
    const card = { name: '\u30ea\u30b6\u30fc\u30c9\u30f3', number: '4', printedTotal: 102, language: 'japanese' };
    assert.equal(titleMatchesCard('\u30dd\u30b1\u30e2\u30f3 \u30ea\u30b6\u30fc\u30c9\u30f3 4/102', card).confident, true,
        'the Japanese name present in the title matches');
    assert.equal(titleMatchesCard('Pokemon Blastoise 2/102 Holo', card).name, false,
        'a title without that name must not match — it used to match everything');
});

/**
 * When every search has been tried and two live listings is all that exists,
 * two listings is the answer. "No price found" on a card with real listings
 * was the worse error, and it is the one the user reported.
 */
/**
 * "Traditional Chinese" contains the word "Chinese", so the looser pattern
 * matched it first and every Traditional listing was filed as Simplified. That
 * both hid Traditional cards from their own comps and let them contaminate the
 * Simplified ones — two different printings at two different prices, averaged.
 */
test('Traditional and Simplified Chinese are told apart', () => {
    const language = t => classifyTitle(t).language;
    assert.equal(language('Pokemon Charizard Traditional Chinese 4/102'), 'chinese-traditional');
    assert.equal(language('Pokemon Charizard Chinese Traditional 4/102'), 'chinese-traditional');
    assert.equal(language('Pokemon Charizard Taiwan 4/102'), 'chinese-traditional');
    assert.equal(language('Pokemon Charizard Simplified Chinese 4/102'), 'chinese-simplified');
    assert.equal(language('Pokemon Charizard Chinese 4/102'), 'chinese-simplified');
    // And the others are unaffected.
    assert.equal(language('Pokemon Charizard Japanese 4/102'), 'japanese');
    assert.equal(language('Pokemon Charizard 4/102'), 'english');
});

test('a scarce card is priced cautiously rather than not at all', () => {
    const listings = [
        { title: 'Pokemon Charizard 4/102 Base Set', price: { value: '900' } },
        { title: 'Pokemon Charizard 4/102 Base Set Holo', price: { value: '1100' } },
    ];

    // The default is still to refuse: two asks is an anecdote, and the caller
    // should widen the search before settling.
    assert.equal(compsFromListings(listings, ZARD).estimate, null);

    // Once the ladder is exhausted, the anecdote is quoted — the cheaper of
    // the two, since a single ask is a hope rather than a price.
    const thin = compsFromListings(listings, ZARD, { thin: true });
    assert.ok(thin.estimate, 'a price is produced rather than nothing');
    assert.equal(thin.estimate.price, 900, 'the cheapest, being the one a buyer reaches first');
    assert.equal(thin.estimate.thin, true, 'and it is flagged so its confidence is cut');
    assert.match(thin.estimate.note, /2 live listings/);
});
