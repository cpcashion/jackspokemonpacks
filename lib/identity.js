/**
 * Card identity + condition helpers.
 *
 * A "card" is a printing: name + set + number + printing + language + edition.
 * Condition is deliberately NOT part of identity — two copies of the same
 * printing in different condition are the same card, held twice. That split is
 * what lets the collection collapse duplicates instead of listing them twice.
 */

/**
 * Fold a printed string to a comparable form, in any script Pok\u00e9mon prints in.
 *
 * This used to strip everything outside [a-z0-9], which silently reduced every
 * Japanese, Chinese, Korean, Russian and Greek card name to the empty string.
 * A card whose name normalised to nothing was reported as unreadable, and \u2014
 * worse \u2014 every such card produced an identical variant key, so two unrelated
 * Japanese cards looked like two copies of one printing.
 *
 * The two normalisation passes are both load-bearing:
 *
 *  - NFKD then stripping U+0300\u2013U+036F folds Latin accents (Pok\u00e9mon \u2192 pokemon)
 *    and full-width forms to half-width, which Japanese cards use for numbers.
 *  - NFC afterwards is what makes it safe for kana. NFKD decomposes \u304c into \u304b
 *    plus a combining dakuten (U+3099), which is outside the range stripped
 *    above and so would survive as a separate codepoint \u2014 leaving a string that
 *    looks identical but never compares equal to a composed \u304c.
 */
export function normalizeText(value) {
    return String(value || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .normalize('NFC')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();
}

/**
 * "004/102" -> "4", "SWSH045" -> "SWSH45", "TG12/TG30" -> "TG12".
 * Collapses the printed-number formats the different APIs disagree about.
 *
 * The NFKC pass is what makes Japanese and Chinese cards work: they print
 * full-width numerals ("０１４"), and `\d` matches ASCII digits only, so
 * without folding them to half-width first the number read as empty and the
 * card could never be matched on the one field that identifies its printing.
 */
export function normalizeCardNumber(value) {
    const raw = String(value || '').normalize('NFKC').trim();
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

/**
 * Every language The Pokémon Company prints in, keyed by the canonical name we
 * store, with the ISO-ish code the card databases use.
 *
 * Language is part of a card's identity, not a display preference: a Japanese
 * Charizard and an English Charizard are different printings that trade at
 * different prices in different marketplaces. Simplified and Traditional
 * Chinese are separate print runs and are kept separate here too.
 */
export const LANGUAGES = {
    english: { code: 'en', label: 'English', badge: 'EN' },
    japanese: { code: 'ja', label: 'Japanese', badge: 'JP' },
    korean: { code: 'ko', label: 'Korean', badge: 'KR' },
    'chinese-simplified': { code: 'zh-cn', label: 'Chinese (Simplified)', badge: 'CN' },
    'chinese-traditional': { code: 'zh-tw', label: 'Chinese (Traditional)', badge: 'TW' },
    french: { code: 'fr', label: 'French', badge: 'FR' },
    german: { code: 'de', label: 'German', badge: 'DE' },
    spanish: { code: 'es', label: 'Spanish', badge: 'ES' },
    italian: { code: 'it', label: 'Italian', badge: 'IT' },
    portuguese: { code: 'pt', label: 'Portuguese', badge: 'PT' },
    dutch: { code: 'nl', label: 'Dutch', badge: 'NL' },
    polish: { code: 'pl', label: 'Polish', badge: 'PL' },
    russian: { code: 'ru', label: 'Russian', badge: 'RU' },
    thai: { code: 'th', label: 'Thai', badge: 'TH' },
    indonesian: { code: 'id', label: 'Indonesian', badge: 'ID' },
};

/** Anything a person, an AI or an API might call each language. */
const LANGUAGE_ALIASES = new Map(Object.entries({
    en: 'english', eng: 'english', us: 'english', 'english us': 'english', 'english uk': 'english',
    ja: 'japanese', jp: 'japanese', jpn: 'japanese', jap: 'japanese', nihongo: 'japanese', '日本語': 'japanese',
    ko: 'korean', kor: 'korean', '한국어': 'korean',
    zh: 'chinese-simplified', 'zh cn': 'chinese-simplified', 'zh hans': 'chinese-simplified',
    cn: 'chinese-simplified', chs: 'chinese-simplified',
    chinese: 'chinese-simplified', 'simplified chinese': 'chinese-simplified',
    'chinese simplified': 'chinese-simplified', mandarin: 'chinese-simplified',
    '简体中文': 'chinese-simplified', '中文': 'chinese-simplified',
    'zh tw': 'chinese-traditional', 'zh hant': 'chinese-traditional', cht: 'chinese-traditional',
    tw: 'chinese-traditional', taiwanese: 'chinese-traditional',
    'traditional chinese': 'chinese-traditional', 'chinese traditional': 'chinese-traditional',
    '繁體中文': 'chinese-traditional',
    fr: 'french', fra: 'french', 'francais': 'french',
    de: 'german', ger: 'german', deu: 'german', deutsch: 'german',
    es: 'spanish', spa: 'spanish', 'espanol': 'spanish',
    it: 'italian', ita: 'italian', italiano: 'italian',
    pt: 'portuguese', por: 'portuguese', 'pt br': 'portuguese', 'pt pt': 'portuguese',
    'portugues': 'portuguese', brazilian: 'portuguese',
    nl: 'dutch', nld: 'dutch', nederlands: 'dutch',
    pl: 'polish', pol: 'polish', polski: 'polish',
    ru: 'russian', rus: 'russian', 'русский': 'russian',
    th: 'thai', tha: 'thai', 'ไทย': 'thai',
    id: 'indonesian', ind: 'indonesian', 'bahasa indonesia': 'indonesian',
}));

/**
 * @returns {string} a key of LANGUAGES. Unrecognised input falls back to
 *   English, which is what the overwhelming majority of the collection is —
 *   but note that `languageIsCertain` exists so a guess is never mistaken for
 *   something read off the card.
 */
export function normalizeLanguage(language) {
    const l = normalizeText(language);
    if (!l) return 'english';
    if (LANGUAGES[l]) return l;
    const alias = LANGUAGE_ALIASES.get(l);
    if (alias) return alias;
    // "Japanese (Japan)", "Chinese - Simplified", "English/French" and similar.
    for (const [needle, canonical] of LANGUAGE_ALIASES) {
        if (needle.length > 2 && l.includes(needle)) return canonical;
    }
    for (const key of Object.keys(LANGUAGES)) {
        if (l.includes(key.split('-')[0])) return key;
    }
    return 'english';
}

/** The code the card databases use for a language, e.g. "ja", "zh-cn". */
export function languageCode(language) {
    return LANGUAGES[normalizeLanguage(language)]?.code || 'en';
}

/** How a language should be shown to a person. */
export function languageLabel(language) {
    return LANGUAGES[normalizeLanguage(language)]?.label || 'English';
}

/**
 * Two-letter form for a card tile. "Chinese (Simplified)" across a badge is
 * wider than the card art it sits on; the full label belongs in the detail
 * sheet, where there is room to be unambiguous.
 */
export function languageBadge(language) {
    return LANGUAGES[normalizeLanguage(language)]?.badge || 'EN';
}

/**
 * Whether the text actually named a language we know, as opposed to being
 * blank or unrecognised and defaulted to English. Used so a card is never
 * quietly priced as English when its language was never established.
 */
export function languageIsCertain(language) {
    const l = normalizeText(language);
    if (!l) return false;
    if (LANGUAGES[l]) return true;
    if (LANGUAGE_ALIASES.has(l)) return true;
    for (const [needle] of LANGUAGE_ALIASES) if (needle.length > 2 && l.includes(needle)) return true;
    return Object.keys(LANGUAGES).some(key => l.includes(key.split('-')[0]));
}

/** True for anything other than an English printing. */
export function isNonEnglish(language) {
    return normalizeLanguage(language) !== 'english';
}

/**
 * A script other than Latin means the printed name will never match an
 * English-language card database, however it is normalised — so the English
 * name has to come from somewhere else.
 */
export function hasNonLatinScript(value) {
    return /[^\p{Script=Latin}\p{N}\p{P}\p{Z}\p{M}]/u.test(String(value || ''));
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
