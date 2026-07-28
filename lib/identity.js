/**
 * Card identity + condition helpers.
 *
 * A "card" is a printing: name + set + number + printing + language + edition.
 * Condition is deliberately NOT part of identity — two copies of the same
 * printing in different condition are the same card, held twice. That split is
 * what lets the collection collapse duplicates instead of listing them twice.
 */

export function normalizeText(value) {
    return String(value || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

/**
 * "004/102" -> "4", "SWSH045" -> "SWSH45", "TG12/TG30" -> "TG12".
 * Collapses the printed-number formats the different APIs disagree about.
 */
export function normalizeCardNumber(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const firstPart = raw.split('/')[0].trim();
    const letters = firstPart.match(/^[A-Za-z]+/)?.[0] || '';
    const digits = firstPart.match(/\d+/)?.[0] || '';
    const cleanedDigits = digits ? String(parseInt(digits, 10)) : '';
    return `${letters.toUpperCase()}${cleanedDigits}`.trim();
}

/** Collapse the many holo spellings into the four printings that price differently. */
export function normalizePrinting(holoType, isHolo) {
    const h = normalizeText(holoType);
    if (h.includes('reverse')) return 'reverse';
    if (h.includes('cosmos') || h === 'holofoil' || h === 'holo') return 'holo';
    if (h.includes('non holo') || h === 'normal') return 'normal';
    if (isHolo === true || isHolo === 1) return 'holo';
    if (isHolo === false || isHolo === 0) return 'normal';
    return 'unknown';
}

export function normalizeLanguage(language) {
    const l = normalizeText(language);
    if (!l) return 'english';
    if (l.startsWith('jap') || l === 'jp' || l === 'ja') return 'japanese';
    return l;
}

export function isTruthy(v) {
    return v === true || v === 1 || v === '1' || v === 'true';
}

/**
 * Stable key for "is this the same printing?". Used to fold a re-scan of a card
 * Jack already owns into another copy rather than another row.
 */
export function buildVariantKey(card) {
    return [
        normalizeText(card.card_name),
        normalizeText(card.card_set),
        normalizeCardNumber(card.card_number),
        normalizePrinting(card.holo_type, card.is_holo ?? card.is_holographic),
        normalizeLanguage(card.language),
        isTruthy(card.is_first_edition ?? card.isFirstEdition) ? '1st' : 'unl',
    ].join('|');
}

/**
 * Market quotes from every source we use are Near Mint prices. These are the
 * standard raw-condition haircuts applied to a NM base; they are estimates and
 * the UI labels them as such.
 */
export const CONDITION_MULTIPLIERS = {
    'gem mint': 1.0,
    'mint': 1.0,
    'near mint': 1.0,
    'lightly played': 0.85,
    'moderately played': 0.7,
    'heavily played': 0.5,
    'damaged': 0.35,
    'poor': 0.3,
};

/** Unknown condition is treated as slightly-below-NM rather than assumed pristine. */
export const UNKNOWN_CONDITION_MULTIPLIER = 0.85;

export const CONDITIONS = [
    'Mint',
    'Near Mint',
    'Lightly Played',
    'Moderately Played',
    'Heavily Played',
    'Damaged',
    'Unknown',
];

export function conditionMultiplier(condition) {
    const c = normalizeText(condition);
    if (!c) return UNKNOWN_CONDITION_MULTIPLIER;
    if (CONDITION_MULTIPLIERS[c] !== undefined) return CONDITION_MULTIPLIERS[c];
    // tolerate abbreviations the AI or a human might type
    const abbrev = { nm: 1.0, m: 1.0, lp: 0.85, mp: 0.7, hp: 0.5, dmg: 0.35, d: 0.35 };
    if (abbrev[c] !== undefined) return abbrev[c];
    return UNKNOWN_CONDITION_MULTIPLIER;
}

export function canonicalCondition(condition) {
    const c = normalizeText(condition);
    const match = CONDITIONS.find(x => normalizeText(x) === c);
    if (match) return match;
    const abbrev = {
        nm: 'Near Mint', m: 'Mint', lp: 'Lightly Played',
        mp: 'Moderately Played', hp: 'Heavily Played', dmg: 'Damaged',
    };
    return abbrev[c] || 'Unknown';
}

/**
 * Value of one physical copy. A manual override always wins — it is the only
 * honest answer for graded slabs, whose market we do not track.
 */
export function copyValue(basePriceNM, copy) {
    const manual = Number(copy?.manual_value || 0);
    if (manual > 0) return manual;
    const base = Number(basePriceNM || 0);
    if (!(base > 0)) return 0;
    if (copy?.grade) return base; // graded: show raw market, flagged in the UI
    return base * conditionMultiplier(copy?.condition);
}
