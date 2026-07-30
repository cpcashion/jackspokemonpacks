/**
 * Deciding which printing a scanned card is.
 *
 * The governing rule: what is *printed on the card* decides identity; what the
 * model *guessed* about it may raise confidence but can never be required and
 * can never veto a match.
 *
 * That distinction is the whole reason this module exists. A Steelix reading
 * "093/132" was labelled "Temporal Forces" by the model. Temporal Forces has
 * 162 cards, so no card in it is numbered out of 132 — the guess was refutable
 * by the card itself. But the old matcher discarded the denominator, so it
 * could not place the card by its number, fell back to the guessed set name,
 * found nothing, and parked a perfectly legible card in a queue for a human to
 * sort out by hand.
 *
 * Lives apart from server.js so it can be tested without booting a server.
 */
import {
    normalizeText,
    parseCardNumber,
    isNonEnglish,
} from './identity.js';

/** Placeholders the AI falls back to, in the languages it might answer in. */
export const PLACEHOLDER_NAMES = new Set([
    'pokemon', 'pokemon card', 'unknown', 'unknown card', 'trainer', 'energy',
    'ポケモン', 'たね', 'トレーナー', 'エネルギー',
    '宝可梦', '寶可夢', '训练家', '訓練家', '能量',
    '포켓몬', '트레이너', '에너지',
]);

export function hasMeaningfulCardName(name) {
    const normalized = normalizeText(name);
    if (!normalized) return false;
    return !PLACEHOLDER_NAMES.has(normalized);
}

/**
 * Every name this card could be looked up under: what is printed on it, and —
 * for a non-English card — the English name of the same Pokémon.
 *
 * A Chinese card reads "古空棘鱼"; no amount of normalisation will match that
 * against an English-language card database. The English name the AI supplies
 * alongside it is the only bridge, so identity comparisons accept either.
 */
export function cardNameCandidates(card) {
    return [card?.card_name, card?.card_name_en]
        .map(normalizeText)
        .filter(Boolean)
        .filter((n, i, all) => all.indexOf(n) === i);
}

/** Does either of this card's names match the candidate's, exactly? */
export function namesMatchExactly(card, candidateName) {
    const target = normalizeText(candidateName);
    return Boolean(target) && cardNameCandidates(card).includes(target);
}

/**
 * Compare one card the AI read against one candidate from a card database, and
 * report which pieces of evidence actually line up.
 *
 * The distinction that matters here is between what is *printed on the card*
 * and what was *guessed about it*. The name and the number, including the
 * denominator, are printed. The set name is a guess — the model infers it from
 * a symbol a few pixels across — and treating a guess as though it were
 * evidence is what sent perfectly legible cards to a human for review.
 *
 * "Steelix 093/132" is the case in point. No card in Temporal Forces, which
 * has 162 cards, is numbered out of 132, so the guessed set name is not just
 * unhelpful, it is refutable by the card itself.
 */
export function compareCandidate(card, candidate) {
    const printed = parseCardNumber(card.card_number);
    const theirs = parseCardNumber(candidate?.number);
    const candidateTotal = Number(candidate?.set?.printedTotal) || Number(candidate?.set?.total) || 0;

    const aiSet = normalizeText(card.card_set);
    const candidateSet = normalizeText(candidate?.set?.name);

    return {
        name: namesMatchExactly(card, candidate?.name),
        number: Boolean(printed.number && theirs.number && printed.number === theirs.number),
        // Printed on the card, and a far better set discriminator than a name:
        // it is the size of the set the card came out of.
        setSize: Boolean(printed.printedTotal && candidateTotal && printed.printedTotal === candidateTotal),
        // Positively wrong, as opposed to merely unknown. Only meaningful when
        // both totals are present.
        setSizeConflicts: Boolean(printed.printedTotal && candidateTotal && printed.printedTotal !== candidateTotal),
        setName: Boolean(aiSet && candidateSet && (aiSet === candidateSet || aiSet.includes(candidateSet) || candidateSet.includes(aiSet))),
        year: Boolean(card.year && candidate?.set?.releaseDate?.startsWith(String(card.year))),
    };
}

/**
 * Is this match good enough to price against?
 *
 * The bar is deliberately expressed in terms of printed evidence. A set name
 * the model guessed can raise confidence but can never be required, and can
 * never block a match — which is the change that stops cards piling up in a
 * review queue for a human to resolve by hand.
 */
export function isLikelyVerifiedMatch(score, candidate, card) {
    const m = compareCandidate(card, candidate);
    if (!m.name) return false;

    // The card says it came out of a set of N. This candidate came out of a set
    // of a different size, so whatever it is, it is not this card.
    if (m.setSizeConflicts) return false;

    // Name + number + set size is everything printed on the card agreeing. No
    // set name required, and none wanted.
    if (m.number && m.setSize) return true;

    // A non-English card is matched against an English database, whose set
    // names and numbering belong to a different print run, so the number is the
    // only thing that can corroborate the name.
    if (isNonEnglish(card.language)) return m.number && score >= 7;

    // No denominator printed (promos, subsets like SWSH045 or TG12/TG30). Fall
    // back to the softer evidence, which is what this always used to rely on.
    if (m.number && (m.setName || m.year)) return true;
    if (m.number && score >= 9) return true;
    return m.setName && score >= 7 && (card.confidence || 0) >= 0.85;
}

export function scorePokemonCardCandidate(card, candidate) {
    const m = compareCandidate(card, candidate);
    const candidateName = normalizeText(candidate?.name);

    let score = 0;

    if (candidateName) {
        const names = cardNameCandidates(card);
        if (names.includes(candidateName)) score += 4;
        else if (names.some(n => candidateName.includes(n) || n.includes(candidateName))) score += 2;
    }

    if (m.number) score += 5;
    // Weighted above the set name on purpose: one is printed on the card, the
    // other was inferred from a symbol a few pixels across.
    if (m.setSize) score += 4;
    if (m.setSizeConflicts) score -= 6;
    if (m.setName) score += 3;
    else if (normalizeText(card.card_set) && normalizeText(candidate?.set?.name)) score += 0;
    if (m.year) score += 1;

    return score;
}
