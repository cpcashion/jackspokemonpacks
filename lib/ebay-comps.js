/**
 * Turning eBay listings into a defensible price for one card.
 *
 * eBay is where these cards actually change hands, so it is the best available
 * answer to "what is this worth". It is also, taken naively, the worst: a
 * search for "Charizard 4/102" returns a PSA 10 at $12,000, a lot of 50 bulk
 * cards at $9.99, a custom-art proxy at $4, a Japanese printing, an empty
 * booster wrapper, and — somewhere in there — the raw English card we care
 * about. Averaging that produces a number with no meaning.
 *
 * So nearly all of this file is classification. The statistics at the end are
 * simple; deciding which listings are even about the same object is the work.
 *
 * On the sold-versus-asking problem
 * ---------------------------------
 * eBay's sold data lives behind the Marketplace Insights API, which is a
 * Limited Release that is not open to new applicants. The Finding API's
 * findCompletedItems, the old way in, was decommissioned in February 2025. So
 * completed sales are not available to us at any price, and pretending an
 * asking price is a sale price would be exactly the sort of confident wrong
 * number this codebase keeps having to remove.
 *
 * What the Browse API does return is two genuinely different things:
 *
 *   1. Auction listings with bids on them. A bid is a real buyer committing
 *      real money — revealed willingness to pay, not a seller's hope. This is
 *      the closest thing to sold data obtainable without the restricted API,
 *      and it is weighted accordingly.
 *   2. Buy-It-Now asking prices. Sellers list above what cards clear at, so the
 *      *middle* of the ask distribution is systematically high. The lower
 *      quartile approximates where things actually sell, and is treated as the
 *      weaker signal it is.
 *
 * Both are labelled in the output so the app can say which it used.
 */

// ── Classification ─────────────────────────────────────────────────

/** Grading companies whose slabs trade in a different market from raw cards. */
const GRADERS = ['psa', 'bgs', 'beckett', 'cgc', 'sgc', 'ace', 'tag', 'gma', 'hga', 'isa'];

const GRADE_PATTERNS = [
    // "PSA 10", "BGS 9.5", "CGC 8"
    new RegExp(`\\b(${GRADERS.join('|')})\\s*\\.?\\s*(10|[1-9](?:\\.5)?)\\b`, 'i'),
    // "GEM MINT 10", "GEM MT 10"
    /\bgem\s*(?:mt|mint)\s*(10|9(?:\.5)?)\b/i,
];

/** A slab with no number still trades as a slab. */
const GRADED_HINTS = /\b(graded|slab(bed)?|encapsulated|pop\s*report)\b/i;

/**
 * Multi-card listings. The single most common way a naive comp search reports a
 * $400 card as worth $12: a bulk lot whose title happens to name it.
 */
const LOT_PATTERNS = [
    /\blot\s*(of|:)?\s*\d+/i,
    /\b\d+\s*(cards?|pcs?|pieces?)\b/i,
    /\bx\s*\d{2,}\b/i,
    /\b(bundle|bulk|job\s*lot|collection\s*of|binder|mystery|repack|grab\s*bag)\b/i,
    /\b(\d+)\s*card\s*(lot|bundle|set)\b/i,
];

/** Not the card. Fan-made, reprinted, or outright counterfeit. */
const NOT_REAL_PATTERNS = [
    /\b(proxy|orica|custom|fan\s*(made|art)|replica|reprint|counterfeit|fake|not\s*official)\b/i,
    /\b(test\s*print|misprint\s*replica|digital|ptcgo|pokemon\s*go\s*code|code\s*card)\b/i,
    /\b(sticker|magnet|poster|plush|keychain|coin)\b/i,
];

/** Sealed product, which is a different thing entirely from a single card. */
const SEALED_PATTERNS = [
    /\b(booster\s*(pack|box)|elite\s*trainer|etb|sealed|blister|tin|bundle\s*box)\b/i,
    /\b(pack|box)\s*(fresh|sealed)\b/i,
];

/** Language markers that appear in titles, mapped to our canonical names. */
const LANGUAGE_MARKERS = [
    [/\b(japanese|japan|jpn|jp)\b/i, 'japanese'],
    [/\b(korean|korea|kr)\b/i, 'korean'],
    [/\b(chinese|china|simplified)\b/i, 'chinese-simplified'],
    [/\b(traditional\s*chinese|taiwan)\b/i, 'chinese-traditional'],
    [/\b(german|deutsch)\b/i, 'german'],
    [/\b(french|francais|français)\b/i, 'french'],
    [/\b(spanish|espanol|español)\b/i, 'spanish'],
    [/\b(italian|italiano)\b/i, 'italian'],
    [/\b(portuguese|portugues)\b/i, 'portuguese'],
    [/\b(russian)\b/i, 'russian'],
];

/** First edition and shadowless are separate, much dearer printings. */
const FIRST_EDITION = /\b(1st|first)\s*(ed(ition)?)\b/i;
const SHADOWLESS = /\bshadowless\b/i;

/**
 * Read everything decidable off a listing title.
 *
 * Titles are the only description eBay's search results give us, and sellers
 * write them for search engines rather than for parsers. The patterns above are
 * tuned to be *specific* rather than exhaustive: a listing wrongly excluded
 * costs one comp out of dozens, while a graded slab wrongly included can move
 * the estimate by an order of magnitude.
 */
export function classifyTitle(title) {
    const t = String(title || '');

    let graded = false;
    let grader = '';
    let grade = null;
    for (const pattern of GRADE_PATTERNS) {
        const m = pattern.exec(t);
        if (m) {
            graded = true;
            grader = /^(psa|bgs|beckett|cgc|sgc|ace|tag|gma|hga|isa)$/i.test(m[1]) ? m[1].toUpperCase() : '';
            grade = Number(m[2] ?? m[1]);
            break;
        }
    }
    if (!graded && GRADED_HINTS.test(t)) graded = true;

    let language = 'english';
    for (const [pattern, name] of LANGUAGE_MARKERS) {
        if (pattern.test(t)) { language = name; break; }
    }

    return {
        graded,
        grader,
        grade: Number.isFinite(grade) ? grade : null,
        isLot: LOT_PATTERNS.some(p => p.test(t)),
        isNotReal: NOT_REAL_PATTERNS.some(p => p.test(t)),
        isSealed: SEALED_PATTERNS.some(p => p.test(t)),
        isFirstEdition: FIRST_EDITION.test(t),
        isShadowless: SHADOWLESS.test(t),
        language,
    };
}

/**
 * Does this title plausibly name the card we asked about?
 *
 * eBay's relevance ranking is generous — it will happily return a Charizard
 * listing for a Charmander query — so the card's own name and number have to be
 * found in the title before a listing is allowed to influence its price.
 *
 * The number is the stronger check and is matched in the several shapes sellers
 * write it: "4/102", "004/102", "#4", "No. 4".
 */
export function titleMatchesCard(title, { name, number, printedTotal } = {}) {
    const t = String(title || '').toLowerCase();
    const cleanName = String(name || '').toLowerCase().trim();
    if (!cleanName) return { name: false, number: false, confident: false };

    // Names with punctuation ("Farfetch'd", "Ho-Oh") appear both ways.
    const loose = cleanName.replace(/[^a-z0-9]+/g, '[^a-z0-9]*');
    const nameHit = new RegExp(`\\b${loose}`, 'i').test(t);

    let numberHit = false;
    const n = String(number || '').replace(/^0+/, '');
    if (n) {
        const patterns = [
            new RegExp(`\\b0*${n}\\s*/\\s*0*${printedTotal || '\\d+'}\\b`),
            new RegExp(`#\\s*0*${n}\\b`),
            new RegExp(`\\bno\\.?\\s*0*${n}\\b`),
        ];
        numberHit = patterns.some(p => p.test(t));
    }

    return {
        name: nameHit,
        number: numberHit,
        // Both agreeing is what makes a comp trustworthy. A name alone matches
        // every printing of that Pokémon ever made.
        confident: nameHit && numberHit,
    };
}

/**
 * Decide whether one listing may inform this card's price, and say why not.
 *
 * The reasons are returned rather than swallowed because they are genuinely
 * interesting: "48 listings found, 41 rejected as graded slabs" tells you
 * something true about that card's market.
 */
export function judgeListing(listing, card) {
    const cls = classifyTitle(listing?.title);
    const match = titleMatchesCard(listing?.title, card);

    const reject = (reason) => ({ ok: false, reason, cls, match });

    if (!match.confident) return reject(match.name ? 'number not in title' : 'different card');
    if (cls.isNotReal) return reject('proxy, custom or non-card item');
    if (cls.isLot) return reject('multi-card lot');
    if (cls.isSealed) return reject('sealed product, not a single card');

    // A slab and a raw card are different objects trading in different markets,
    // and the gap is routinely 10x. Ours is raw unless a grade was recorded on
    // the copy, so graded listings are excluded — and vice versa.
    const wantGraded = Boolean(card?.graded);
    if (cls.graded !== wantGraded) {
        return reject(cls.graded ? 'graded slab, ours is raw' : 'raw card, ours is graded');
    }
    if (wantGraded && card?.grade && cls.grade && Number(card.grade) !== cls.grade) {
        return reject(`graded ${cls.grade}, ours is ${card.grade}`);
    }

    const wantLanguage = card?.language || 'english';
    if (cls.language !== wantLanguage) return reject(`${cls.language} printing, ours is ${wantLanguage}`);

    // 1st Edition and Shadowless are distinct printings at very different
    // prices, so a mismatch in either direction disqualifies the comp.
    if (Boolean(card?.isFirstEdition) !== cls.isFirstEdition) {
        return reject(cls.isFirstEdition ? '1st Edition, ours is not' : 'not 1st Edition, ours is');
    }

    return { ok: true, cls, match };
}

// ── Turning accepted listings into a price ─────────────────────────

/** Auctions with this many bids are treated as revealed demand. */
export const MIN_BIDS_FOR_SIGNAL = 1;

function numeric(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
}

export function quantile(sorted, q) {
    if (!sorted.length) return null;
    const pos = (sorted.length - 1) * q;
    const base = Math.floor(pos);
    const rest = pos - base;
    return sorted[base + 1] !== undefined
        ? sorted[base] + rest * (sorted[base + 1] - sorted[base])
        : sorted[base];
}

/** Drop points more than 4x from the middle, which are almost always miscategorised. */
function trimOutliers(values) {
    if (values.length < 3) return values;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = quantile(sorted, 0.5);
    return sorted.filter(v => v <= mid * 4 && v >= mid / 4);
}

/**
 * Reduce accepted listings to one estimate.
 *
 * The two kinds of listing are kept apart because they mean different things:
 *
 *   Auction bids are what somebody actually agreed to pay. The median of those
 *   is the best estimate available.
 *
 *   Buy-It-Now asks are what sellers hope for, and the distribution is skewed
 *   upward — the cards that clear are the cheap end of it. The 30th percentile
 *   is used rather than the median for exactly that reason, and only when there
 *   are no bids to go on.
 */
export function estimateFromComps(accepted) {
    const bids = [];
    const asks = [];

    for (const item of accepted) {
        const bidPrice = numeric(item?.currentBidPrice?.value);
        const bidCount = Number(item?.bidCount) || 0;
        const isAuction = (item?.buyingOptions || []).includes('AUCTION');

        if (isAuction && bidCount >= MIN_BIDS_FOR_SIGNAL && bidPrice) {
            bids.push(bidPrice);
        } else {
            const ask = numeric(item?.price?.value);
            if (ask) asks.push(ask);
        }
    }

    const bidPool = trimOutliers(bids);
    const askPool = trimOutliers(asks);

    if (bidPool.length) {
        const sorted = [...bidPool].sort((a, b) => a - b);
        return {
            price: Number(quantile(sorted, 0.5).toFixed(2)),
            basis: 'auction bids',
            // A live auction is a floor, not a settled price — it can still be
            // bid up before it closes.
            note: 'median of live auction bids, which are real buyers committing',
            samples: bidPool.length,
            asksSeen: askPool.length,
            low: Number(Math.min(...sorted).toFixed(2)),
            high: Number(Math.max(...sorted).toFixed(2)),
        };
    }

    if (askPool.length >= 3) {
        const sorted = [...askPool].sort((a, b) => a - b);
        return {
            price: Number(quantile(sorted, 0.3).toFixed(2)),
            basis: 'asking prices',
            note: 'lower end of current asking prices; sellers list above what cards clear at',
            samples: askPool.length,
            asksSeen: askPool.length,
            low: Number(Math.min(...sorted).toFixed(2)),
            high: Number(Math.max(...sorted).toFixed(2)),
        };
    }

    // One or two asking prices is not a market, it is an anecdote.
    return null;
}

/**
 * The whole pipeline: raw eBay results in, one estimate plus its workings out.
 */
export function compsFromListings(listings, card) {
    const accepted = [];
    const rejected = [];

    for (const listing of listings || []) {
        const verdict = judgeListing(listing, card);
        if (verdict.ok) accepted.push(listing);
        else rejected.push({ title: listing?.title || '', reason: verdict.reason });
    }

    const estimate = estimateFromComps(accepted);
    const reasons = {};
    for (const r of rejected) reasons[r.reason] = (reasons[r.reason] || 0) + 1;

    return {
        estimate,
        considered: (listings || []).length,
        accepted: accepted.length,
        rejected: rejected.length,
        // Kept because it is genuinely informative: a card where 41 of 48
        // listings were graded slabs is telling you about that card's market.
        rejectedBecause: reasons,
    };
}

/**
 * The search string to send eBay.
 *
 * Deliberately not over-specified. eBay matches titles, and sellers do not all
 * write the set name — including it drops honest listings. The name and number
 * are what identify the card, and everything else is filtered afterwards, where
 * the rules are ours rather than eBay's relevance ranking.
 */
export function buildSearchQuery(card) {
    const parts = ['pokemon', card?.name];
    if (card?.number) {
        parts.push(card.printedTotal ? `${card.number}/${card.printedTotal}` : String(card.number));
    }
    if (card?.language && card.language !== 'english') parts.push(card.language);
    if (card?.isFirstEdition) parts.push('1st edition');
    return parts.filter(Boolean).join(' ').trim();
}
