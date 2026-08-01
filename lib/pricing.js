/**
 * Market price resolution.
 *
 * The previous engine averaged every number it could find, which mixed EUR
 * Cardmarket prices with USD TCGplayer prices and silently fell back to the
 * holofoil price for non-holo cards. Both inflate a collection badly.
 *
 * This one:
 *   - normalises every quote to USD before comparing anything,
 *   - only ever compares like with like (US market vs EU market),
 *   - picks the price for the printing the card actually is, and when it has to
 *     guess a printing it guesses the *cheapest* one rather than the dearest,
 *   - takes a median rather than a mean so one bad quote cannot drag the number,
 *   - reports what it used, so a wrong price is explainable instead of magic.
 *
 * Every quote returned here is a Near Mint price. Condition haircuts are applied
 * per physical copy in lib/identity.js, not here.
 */

import { normalizeText, normalizeCardNumber, resolvePrinting, isTruthy } from './identity.js';

// ── Currency ────────────────────────────────────────────────────────────────

const FX_FALLBACK_USD_PER_EUR = 1.08;
const FX_TTL_MS = 12 * 60 * 60 * 1000;
let fxCache = { rate: FX_FALLBACK_USD_PER_EUR, ts: 0, live: false };

export async function getUsdPerEur(axios) {
    if (Date.now() - fxCache.ts < FX_TTL_MS && fxCache.live) return fxCache.rate;
    try {
        const resp = await axios.get('https://api.frankfurter.app/latest?from=EUR&to=USD', { timeout: 8000 });
        const rate = Number(resp.data?.rates?.USD);
        if (rate > 0.5 && rate < 3) {
            fxCache = { rate, ts: Date.now(), live: true };
            return rate;
        }
    } catch {
        // offline or blocked — fall through to the last known / fallback rate
    }
    fxCache = { rate: fxCache.rate || FX_FALLBACK_USD_PER_EUR, ts: Date.now(), live: false };
    return fxCache.rate;
}

export function fxStatus() {
    return { usdPerEur: fxCache.rate, live: fxCache.live, fetchedAt: fxCache.ts || null };
}

// ── Variant selection ───────────────────────────────────────────────────────

/**
 * Ordered list of TCGplayer price buckets to try for a given printing, most
 * specific first. Anything not on the list is a guess.
 */
function tcgplayerVariantPreference(printing, isFirstEdition) {
    if (isFirstEdition) {
        if (printing === 'normal') return ['1stEditionNormal', '1stEdition', '1stEditionHolofoil'];
        return ['1stEditionHolofoil', '1stEdition', '1stEditionNormal'];
    }
    switch (printing) {
        case 'reverse': return ['reverseHolofoil'];
        case 'holo': return ['holofoil', 'unlimitedHolofoil'];
        case 'normal': return ['normal', 'unlimited'];
        default: return [];
    }
}

/** market > mid > low. Never `high` — that is the asking ceiling, not a market price. */
/**
 * The one number on a TCGplayer price node that means "what this sells for".
 *
 * `market` is TCGplayer's own figure derived from recent completed sales — the
 * same number their site shows — so it is what we want and what the other
 * tracking apps quote. `mid` is the midpoint of current listings, which is a
 * reasonable stand-in when nothing has sold recently.
 *
 * `low` is deliberately NOT used. It is the cheapest active listing, which in
 * practice is a damaged copy, a mispriced one, or a seller with no feedback.
 * Falling back to it produced numbers that looked like market prices and were
 * systematically under them, with nothing on screen to say so.
 */
function priceFromVariantNode(node) {
    if (!node) return null;
    for (const key of ['market', 'marketPrice']) {
        const v = Number(node[key]);
        if (v > 0) return { price: v, basis: 'market' };
    }
    for (const key of ['mid', 'midPrice']) {
        const v = Number(node[key]);
        if (v > 0) return { price: v, basis: 'listings' };
    }
    return null;
}

/**
 * Pick a USD price out of a TCGplayer-shaped price object.
 * Returns { price, variant, variantMatched }.
 *
 * When the requested printing is missing we deliberately take the cheapest
 * available variant. Guessing high is how a binder of commons turns into a
 * four-figure portfolio.
 */
export function pickTcgplayerVariantPrice(prices, { printing, isFirstEdition } = {}) {
    if (!prices || typeof prices !== 'object') return null;

    for (const key of tcgplayerVariantPreference(printing, isFirstEdition)) {
        const found = priceFromVariantNode(prices[key]);
        if (found) return { price: found.price, variant: key, variantMatched: true, basis: found.basis };
    }

    // Nothing matched the printing. Everything below here is a fallback, and the
    // question is which wrong answer to give.
    const available = [];
    for (const [key, node] of Object.entries(prices)) {
        const found = priceFromVariantNode(node);
        if (found) available.push({ price: found.price, variant: key, basis: found.basis });
    }
    if (!available.length) return null;

    // One printing exists, so there was never any ambiguity to resolve.
    if (available.length === 1) {
        return { ...available[0], variantMatched: true, basis: available[0].basis };
    }

    // Several exist and we cannot tell which this card is. Taking the cheapest —
    // which this used to do, on the theory that under-valuing is safer — turns a
    // holo Charizard into its $1 non-holo twin, an error of two orders of
    // magnitude reported with no visible doubt. The median is the honest
    // estimate when the answer is genuinely unknown, and the caller drops
    // confidence to say so.
    available.sort((a, b) => a.price - b.price);
    const mid = available.length % 2
        ? available[(available.length - 1) / 2]
        : available[available.length / 2 - 1];
    return {
        price: median(available.map(a => a.price)),
        variant: `${mid.variant}~`,
        variantMatched: false,
        basis: mid.basis,
        variantsConsidered: available.length,
    };
}

/** Cardmarket price objects are EUR and use a different key vocabulary. */
export function pickCardmarketPrice(prices, { printing } = {}) {
    if (!prices || typeof prices !== 'object') return null;

    const reverseKeys = ['reverseHoloTrend', 'reverseHoloAvg7', 'reverseHoloAvg30', 'reverseHoloAvg1'];
    const plainKeys = ['trendPrice', 'averageSellPrice', 'avg7', 'avg30', 'trend', 'avg1', 'avg'];

    const order = printing === 'reverse' ? [...reverseKeys, ...plainKeys] : plainKeys;
    const matchedSet = printing === 'reverse' ? new Set(reverseKeys) : new Set(plainKeys);

    for (const key of order) {
        const v = Number(prices[key]);
        if (v > 0) return { price: v, variant: key, variantMatched: matchedSet.has(key) };
    }
    return null;
}

// ── Quote collection ────────────────────────────────────────────────────────

/**
 * A quote is one marketplace's opinion, tagged with enough provenance that the
 * UI can explain the final number.
 * @typedef {{price:number, currency:'USD'|'EUR', marketplace:'tcgplayer'|'cardmarket',
 *            source:string, variant:string, variantMatched:boolean, url:string}} Quote
 */

export function quotesFromPokemonTcgCandidate(candidate, cardContext) {
    const quotes = [];
    if (!candidate) return quotes;

    const tcg = pickTcgplayerVariantPrice(candidate.tcgplayer?.prices, cardContext);
    if (tcg) {
        quotes.push({
            price: tcg.price,
            currency: 'USD',
            marketplace: 'tcgplayer',
            source: 'pokemontcg_tcgplayer',
            variant: tcg.variant,
            variantMatched: tcg.variantMatched,
            basis: tcg.basis,
            url: candidate.tcgplayer?.url || '',
        });
    }

    const cm = pickCardmarketPrice(candidate.cardmarket?.prices, cardContext);
    if (cm) {
        quotes.push({
            price: cm.price,
            currency: 'EUR',
            marketplace: 'cardmarket',
            source: 'pokemontcg_cardmarket',
            variant: cm.variant,
            variantMatched: cm.variantMatched,
            url: candidate.cardmarket?.url || '',
        });
    }
    return quotes;
}

/** TCGdex nests the same two marketplaces under `pricing` with its own key names. */
export function quotesFromTcgdexCard(card, cardContext) {
    const quotes = [];
    const pricing = card?.pricing;
    if (!pricing) return quotes;

    if (pricing.tcgplayer) {
        // TCGdex uses holo/reverse/normal rather than TCGplayer's own key names.
        const remapped = {
            normal: pricing.tcgplayer.normal,
            holofoil: pricing.tcgplayer.holo || pricing.tcgplayer.holofoil,
            reverseHolofoil: pricing.tcgplayer.reverse || pricing.tcgplayer.reverseHolo,
            '1stEditionHolofoil': pricing.tcgplayer.firstEdition || pricing.tcgplayer['1stEdition'],
            unlimited: pricing.tcgplayer.unlimited,
        };
        for (const k of Object.keys(remapped)) if (!remapped[k]) delete remapped[k];
        const tcg = pickTcgplayerVariantPrice(remapped, cardContext);
        if (tcg) {
            quotes.push({
                price: tcg.price,
                currency: 'USD',
                marketplace: 'tcgplayer',
                source: 'tcgdex_tcgplayer',
                variant: tcg.variant,
                variantMatched: tcg.variantMatched,
                url: '',
            });
        }
    }

    const cm = pickCardmarketPrice(pricing.cardmarket, cardContext);
    if (cm) {
        quotes.push({
            price: cm.price,
            currency: 'EUR',
            marketplace: 'cardmarket',
            source: 'tcgdex_cardmarket',
            variant: cm.variant,
            variantMatched: cm.variantMatched,
            url: '',
        });
    }
    return quotes;
}

// ── Aggregation ─────────────────────────────────────────────────────────────

export function median(values) {
    const sorted = [...values].filter(v => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
    if (!sorted.length) return null;
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Reduce raw quotes to one defensible USD Near Mint price.
 * Returns null when nothing usable was found — callers must not invent a price.
 */
export async function aggregateQuotes(quotes, { axios, context = {} } = {}) {
    const usable = (quotes || []).filter(q => q && Number(q.price) > 0);
    if (!usable.length) return null;

    const usdPerEur = usable.some(q => q.currency === 'EUR') ? await getUsdPerEur(axios) : 1;

    const normalised = usable.map(q => ({
        ...q,
        priceUsd: q.currency === 'EUR' ? Number(q.price) * usdPerEur : Number(q.price),
    }));

    // The US market (TCGplayer) is the reference these apps quote. Only fall back
    // to EU Cardmarket data when there is no US quote at all.
    // eBay quotes come from bids and listings on the exact card rather than a
    // catalogue figure, so they sit alongside TCGplayer rather than replacing
    // it: both describe the US market, and two independent readings of one
    // market agreeing is precisely the corroboration this engine looks for.
    const usQuotes = normalised.filter(q => q.marketplace === 'tcgplayer' || q.marketplace === 'ebay');
    const hasBoth = usQuotes.some(q => q.marketplace === 'ebay') && usQuotes.some(q => q.marketplace === 'tcgplayer');
    const marketplace = usQuotes.length
        ? (hasBoth ? 'tcgplayer+ebay' : usQuotes[0].marketplace)
        : 'cardmarket';
    let pool = usQuotes.length ? usQuotes : normalised;

    // Prefer quotes that actually matched the printing.
    const exact = pool.filter(q => q.variantMatched);
    const variantMatched = exact.length > 0;
    if (variantMatched) pool = exact;

    // Trim quotes that disagree with the consensus by more than 4x.
    const rough = median(pool.map(q => q.priceUsd));
    const kept = pool.filter(q => q.priceUsd <= rough * 4 && q.priceUsd >= rough / 4);
    const finalPool = kept.length ? kept : pool;

    const price = median(finalPool.map(q => q.priceUsd));
    if (!(price > 0)) return null;

    const lows = finalPool.map(q => q.priceUsd);
    const low = Math.min(...lows);
    const high = Math.max(...lows);
    const spread = price > 0 ? (high - low) / price : 0;

    // Confidence is about how much we should trust this number, and is shown.
    let confidence = 0.55;
    if (variantMatched) confidence += 0.2;
    if (marketplace.includes('tcgplayer')) confidence += 0.1;
    // A catalogue price and live eBay activity agreeing is the strongest
    // corroboration available: two independent readings of the same market.
    if (marketplace === 'tcgplayer+ebay') confidence += 0.1;
    if (finalPool.length >= 2) confidence += 0.1;
    if (finalPool.length >= 3) confidence += 0.05;
    if (spread > 0.5) confidence -= 0.15;
    if (spread > 1.0) confidence -= 0.15;
    // A printing worked out from the rarity rather than seen in the photo is a
    // good inference, not an observation, and the number leans on it entirely.
    if (context.printingInferred) confidence -= 0.1;
    // Quoted off current listings because nothing has sold recently. That is a
    // weaker claim about value than a completed-sale price.
    if (finalPool.some(q => q.basis === 'listings')) confidence -= 0.1;
    confidence = Math.max(0.1, Math.min(1, Number(confidence.toFixed(2))));

    const primary = finalPool.find(q => q.url) || finalPool[0];

    const bySource = {};
    for (const q of normalised) {
        bySource[q.source] = {
            price: Number(q.priceUsd.toFixed(2)),
            nativePrice: Number(Number(q.price).toFixed(2)),
            currency: q.currency,
            marketplace: q.marketplace,
            variant: q.variant,
            variantMatched: q.variantMatched,
            basis: q.basis || 'market',
            url: q.url || '',
            used: finalPool.includes(q),
            ts: new Date().toISOString(),
        };
    }

    return {
        price: Number(price.toFixed(2)),
        currency: 'USD',
        marketplace,
        variantMatched,
        variant: primary?.variant || '',
        source: finalPool.length > 1 ? `${marketplace}_consensus` : (primary?.source || marketplace),
        url: primary?.url || '',
        low: Number(low.toFixed(2)),
        high: Number(high.toFixed(2)),
        spread: Number(spread.toFixed(3)),
        confidence,
        quotesUsed: finalPool.length,
        quotesSeen: normalised.length,
        printingInferred: Boolean(context.printingInferred),
        printingBasis: context.printingBasis || '',
        // True when every quote came from current listings rather than a
        // completed sale, which is worth saying out loud next to the number.
        fromListingsOnly: finalPool.every(q => q.basis === 'listings'),
        usdPerEur: usdPerEur === 1 ? null : Number(usdPerEur.toFixed(4)),
        allSourcePrices: bySource,
    };
}

/** Context describing which printing we are pricing. */
/**
 * What the pricing engine needs to know about a card to pick the right price.
 *
 * The printing is resolved rather than merely normalised: when the foil pattern
 * could not be read off the photo — the single most common gap, because it
 * depends on how the light fell — the rarity settles it. "Rare Holo" is holo
 * regardless of what the photograph showed.
 */
export function priceContextFor(card) {
    const { printing, inferred, basis } = resolvePrinting(card || {});
    return {
        printing,
        isFirstEdition: isTruthy(card?.is_first_edition),
        printingInferred: inferred,
        printingBasis: basis,
    };
}

export { normalizeText, normalizeCardNumber };
