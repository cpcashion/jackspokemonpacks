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
    // The set name is deliberately absent: sellers do not all write it, and
    // including it drops honest listings.
    assert.ok(!buildSearchQuery(ZARD).includes('Base Set'));
});
