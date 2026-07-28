import test from 'node:test';
import assert from 'node:assert/strict';

import {
    pickTcgplayerVariantPrice,
    pickCardmarketPrice,
    quotesFromPokemonTcgCandidate,
    quotesFromTcgdexCard,
    aggregateQuotes,
    median,
    priceContextFor,
} from '../lib/pricing.js';

import {
    buildVariantKey,
    conditionMultiplier,
    copyValue,
    normalizeCardNumber,
    normalizePrinting,
    canonicalCondition,
} from '../lib/identity.js';

// Never hit the network in tests: a stub that fails loudly if FX is fetched
// unexpectedly, and a fixed rate when it is.
const axiosStub = { get: async () => ({ data: { rates: { USD: 1.1 } } }) };
const axiosOffline = { get: async () => { throw new Error('offline'); } };

test('variant pick: non-holo card does not inherit the holofoil price', () => {
    const prices = {
        normal: { market: 2.5 },
        holofoil: { market: 180 },
        reverseHolofoil: { market: 9 },
    };
    const picked = pickTcgplayerVariantPrice(prices, { printing: 'normal', isFirstEdition: false });
    assert.equal(picked.price, 2.5);
    assert.equal(picked.variant, 'normal');
    assert.equal(picked.variantMatched, true);
});

test('variant pick: reverse holo takes the reverse bucket', () => {
    const prices = { normal: { market: 2.5 }, holofoil: { market: 180 }, reverseHolofoil: { market: 9 } };
    const picked = pickTcgplayerVariantPrice(prices, { printing: 'reverse' });
    assert.equal(picked.price, 9);
});

test('variant pick: 1st edition prefers the 1st edition bucket', () => {
    const prices = { unlimitedHolofoil: { market: 300 }, '1stEditionHolofoil': { market: 5200 } };
    const picked = pickTcgplayerVariantPrice(prices, { printing: 'holo', isFirstEdition: true });
    assert.equal(picked.price, 5200);
    assert.equal(picked.variantMatched, true);
});

test('variant pick: unlimited holo does NOT take the 1st edition price', () => {
    const prices = { unlimitedHolofoil: { market: 300 }, '1stEditionHolofoil': { market: 5200 } };
    const picked = pickTcgplayerVariantPrice(prices, { printing: 'holo', isFirstEdition: false });
    assert.equal(picked.price, 300);
});

test('variant pick: unknown printing falls back to the CHEAPEST variant, flagged inexact', () => {
    const prices = { holofoil: { market: 180 }, normal: { market: 2.5 } };
    const picked = pickTcgplayerVariantPrice(prices, { printing: 'unknown' });
    assert.equal(picked.price, 2.5, 'guessing must not guess expensive');
    assert.equal(picked.variantMatched, false);
});

test('variant pick: never uses the `high` asking price', () => {
    const picked = pickTcgplayerVariantPrice({ normal: { high: 999, low: 4 } }, { printing: 'normal' });
    assert.equal(picked.price, 4);
});

test('variant pick: returns null when there are no prices at all', () => {
    assert.equal(pickTcgplayerVariantPrice(null, { printing: 'normal' }), null);
    assert.equal(pickTcgplayerVariantPrice({}, { printing: 'normal' }), null);
});

test('cardmarket: reverse holo uses the reverse keys', () => {
    const picked = pickCardmarketPrice(
        { trendPrice: 3, reverseHoloTrend: 11 },
        { printing: 'reverse' },
    );
    assert.equal(picked.price, 11);
});

test('aggregate: EUR quotes are converted to USD before being compared', async () => {
    const quotes = [
        { price: 100, currency: 'EUR', marketplace: 'cardmarket', source: 'cm', variant: 'trendPrice', variantMatched: true, url: '' },
    ];
    const out = await aggregateQuotes(quotes, { axios: axiosStub });
    assert.equal(out.price, 110);
    assert.equal(out.currency, 'USD');
    assert.equal(out.marketplace, 'cardmarket');
    assert.equal(out.usdPerEur, 1.1);
});

test('aggregate: a EUR quote is never averaged with a USD quote as if both were USD', async () => {
    // 50 EUR (=55 USD) and 57 USD describe the same card. The old engine averaged
    // 50 and 57 -> 53.50, which is neither market's price.
    const quotes = [
        { price: 50, currency: 'EUR', marketplace: 'cardmarket', source: 'cm', variant: 'trendPrice', variantMatched: true, url: '' },
        { price: 57, currency: 'USD', marketplace: 'tcgplayer', source: 'tcgp', variant: 'holofoil', variantMatched: true, url: 'u' },
    ];
    const out = await aggregateQuotes(quotes, { axios: axiosStub });
    // TCGplayer is the reference market, so the US price wins outright.
    assert.equal(out.price, 57);
    assert.equal(out.marketplace, 'tcgplayer');
    // ...but the Cardmarket quote is still reported, in USD, for comparison.
    assert.equal(out.allSourcePrices.cm.price, 55);
    assert.equal(out.allSourcePrices.cm.nativePrice, 50);
    assert.equal(out.allSourcePrices.cm.currency, 'EUR');
    assert.equal(out.allSourcePrices.cm.used, false);
});

test('aggregate: uses the median so a single wild quote cannot move the price', async () => {
    const mk = (price, source) => ({ price, currency: 'USD', marketplace: 'tcgplayer', source, variant: 'holofoil', variantMatched: true, url: '' });
    const out = await aggregateQuotes([mk(10, 'a'), mk(11, 'b'), mk(12, 'c')], { axios: axiosStub });
    assert.equal(out.price, 11);
});

test('aggregate: an absurd outlier is trimmed before the median', async () => {
    const mk = (price, source) => ({ price, currency: 'USD', marketplace: 'tcgplayer', source, variant: 'holofoil', variantMatched: true, url: '' });
    const out = await aggregateQuotes([mk(10, 'a'), mk(11, 'b'), mk(9000, 'c')], { axios: axiosStub });
    assert.equal(out.price, 10.5);
    assert.equal(out.allSourcePrices.c.used, false);
});

test('aggregate: exact variant matches beat inexact ones', async () => {
    const quotes = [
        { price: 180, currency: 'USD', marketplace: 'tcgplayer', source: 'guess', variant: 'holofoil', variantMatched: false, url: '' },
        { price: 3, currency: 'USD', marketplace: 'tcgplayer', source: 'exact', variant: 'normal', variantMatched: true, url: '' },
    ];
    const out = await aggregateQuotes(quotes, { axios: axiosStub });
    assert.equal(out.price, 3);
    assert.equal(out.variantMatched, true);
});

test('aggregate: returns null rather than inventing a price', async () => {
    assert.equal(await aggregateQuotes([], { axios: axiosStub }), null);
    assert.equal(await aggregateQuotes([{ price: 0, currency: 'USD' }], { axios: axiosStub }), null);
    assert.equal(await aggregateQuotes(null, { axios: axiosStub }), null);
});

test('aggregate: confidence drops for a lone inexact cardmarket quote', async () => {
    const strong = await aggregateQuotes([
        { price: 10, currency: 'USD', marketplace: 'tcgplayer', source: 'a', variant: 'normal', variantMatched: true, url: '' },
        { price: 10.5, currency: 'USD', marketplace: 'tcgplayer', source: 'b', variant: 'normal', variantMatched: true, url: '' },
    ], { axios: axiosStub });
    const weak = await aggregateQuotes([
        { price: 10, currency: 'EUR', marketplace: 'cardmarket', source: 'c', variant: 'avg30', variantMatched: false, url: '' },
    ], { axios: axiosStub });
    assert.ok(strong.confidence > weak.confidence, `${strong.confidence} should exceed ${weak.confidence}`);
});

test('aggregate: still works with the FX API unreachable', async () => {
    const out = await aggregateQuotes([
        { price: 100, currency: 'EUR', marketplace: 'cardmarket', source: 'cm', variant: 'trendPrice', variantMatched: true, url: '' },
    ], { axios: axiosOffline });
    assert.ok(out.price > 90 && out.price < 130, `fallback rate should still yield a sane price, got ${out.price}`);
});

test('pokemontcg candidate: produces one quote per marketplace', () => {
    const candidate = {
        tcgplayer: { url: 'https://tcgplayer.test/x', prices: { normal: { market: 4 }, holofoil: { market: 90 } } },
        cardmarket: { url: 'https://cardmarket.test/x', prices: { trendPrice: 3.4 } },
    };
    const quotes = quotesFromPokemonTcgCandidate(candidate, { printing: 'normal', isFirstEdition: false });
    assert.equal(quotes.length, 2);
    assert.equal(quotes[0].price, 4);
    assert.equal(quotes[0].currency, 'USD');
    assert.equal(quotes[1].currency, 'EUR');
});

test('tcgdex card: remaps its own variant names onto TCGplayer buckets', () => {
    const card = { pricing: { tcgplayer: { normal: { marketPrice: 5 }, holo: { marketPrice: 88 } }, cardmarket: { avg30: 4.2 } } };
    const normal = quotesFromTcgdexCard(card, { printing: 'normal' });
    assert.equal(normal.find(q => q.marketplace === 'tcgplayer').price, 5);
    const holo = quotesFromTcgdexCard(card, { printing: 'holo' });
    assert.equal(holo.find(q => q.marketplace === 'tcgplayer').price, 88);
});

test('median handles empty, odd and even inputs', () => {
    assert.equal(median([]), null);
    assert.equal(median([5]), 5);
    assert.equal(median([1, 2, 3]), 2);
    assert.equal(median([1, 2, 3, 4]), 2.5);
    assert.equal(median([0, -3, 4]), 4, 'non-positive values are ignored');
});

test('priceContextFor reads printing and edition off a card row', () => {
    assert.deepEqual(
        priceContextFor({ holo_type: 'Reverse Holo', is_first_edition: 1 }),
        { printing: 'reverse', isFirstEdition: true },
    );
    assert.deepEqual(
        priceContextFor({ holo_type: 'Unknown', is_holo: 0, is_first_edition: false }),
        { printing: 'normal', isFirstEdition: false },
    );
});

// ── identity ───────────────────────────────────────────────────────────────

test('variant key: the same printing scanned twice collapses to one key', () => {
    const a = buildVariantKey({ card_name: 'Charizard', card_set: 'Base Set', card_number: '4/102', holo_type: 'Holofoil', language: 'English', is_first_edition: false });
    const b = buildVariantKey({ card_name: 'charizard ', card_set: 'Base  Set', card_number: '004/102', holo_type: 'holo', language: 'english', is_first_edition: 0 });
    assert.equal(a, b);
});

test('variant key: printings that price differently stay distinct', () => {
    const base = { card_name: 'Charizard', card_set: 'Base Set', card_number: '4/102', language: 'English' };
    const keys = new Set([
        buildVariantKey({ ...base, holo_type: 'Holofoil', is_first_edition: false }),
        buildVariantKey({ ...base, holo_type: 'Holofoil', is_first_edition: true }),
        buildVariantKey({ ...base, holo_type: 'Reverse Holo', is_first_edition: false }),
        buildVariantKey({ ...base, holo_type: 'Holofoil', is_first_edition: false, language: 'Japanese' }),
    ]);
    assert.equal(keys.size, 4);
});

test('normalizeCardNumber copes with the formats the APIs disagree about', () => {
    assert.equal(normalizeCardNumber('004/102'), '4');
    assert.equal(normalizeCardNumber('4'), '4');
    assert.equal(normalizeCardNumber('SWSH045'), 'SWSH45');
    assert.equal(normalizeCardNumber('TG12/TG30'), 'TG12');
    assert.equal(normalizeCardNumber(''), '');
});

test('normalizePrinting falls back to the holo flag', () => {
    assert.equal(normalizePrinting('Unknown', true), 'holo');
    assert.equal(normalizePrinting('Unknown', false), 'normal');
    assert.equal(normalizePrinting(null, null), 'unknown');
});

test('condition multipliers scale a NM base', () => {
    assert.equal(conditionMultiplier('Near Mint'), 1);
    assert.equal(conditionMultiplier('Heavily Played'), 0.5);
    assert.equal(conditionMultiplier('nonsense'), 0.85, 'unknown condition is not assumed mint');
});

test('copyValue: manual override wins, condition otherwise applies', () => {
    assert.equal(copyValue(100, { condition: 'Near Mint' }), 100);
    assert.equal(copyValue(100, { condition: 'Lightly Played' }), 85);
    assert.equal(copyValue(100, { condition: 'Damaged', manual_value: 12 }), 12);
    assert.equal(copyValue(0, { condition: 'Near Mint' }), 0);
    assert.equal(copyValue(100, { grade: 'PSA 9' }), 100, 'graded slabs are not condition-discounted');
});

test('canonicalCondition tidies free text', () => {
    assert.equal(canonicalCondition('nm'), 'Near Mint');
    assert.equal(canonicalCondition('LIGHTLY PLAYED'), 'Lightly Played');
    assert.equal(canonicalCondition('whatever'), 'Unknown');
});
