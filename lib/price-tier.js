/**
 * How sure are we, and does that justify showing a number?
 *
 * This codebase has swung between two wrong answers to that question.
 *
 * First it priced everything, matching loosely on name and number, which valued
 * a common Steelix at $206 because a different Steelix in a different set
 * happened to share a numerator.
 *
 * The correction was to refuse to price anything whose exact printing could not
 * be confirmed. That is defensible in principle and useless in practice: a card
 * the app had read at 100% confidence — the right Pokémon, the right language,
 * a plausible set — showed no value at all, and the collection total silently
 * excluded it. Refusing to answer is not the same as being accurate. It just
 * moves the error somewhere the user cannot see it.
 *
 * The third answer, which is this file: always produce a number when the card
 * is identifiable, and say how much to trust it. A price carries a tier, the
 * tier carries a plain-language explanation, and the interface shows both. The
 * user is never asked to confirm anything — the app states what it knows.
 */

/** Ordered by how much the number can be relied on. */
export const TIERS = {
    /** The exact printing was confirmed against a card database. */
    confirmed: {
        rank: 3,
        label: 'Market price',
        weight: 1,
        explain: () => 'Priced against this exact printing.',
    },
    /**
     * The Pokémon, language and rough printing are known but the exact card
     * could not be pinned down — usually a set the databases do not carry yet,
     * or a numbering that does not line up across languages.
     */
    estimated: {
        rank: 2,
        label: 'Estimated',
        weight: 0.6,
        explain: (why) => `Estimated — ${why || 'the exact printing could not be confirmed'}. Based on cards matching the name, number and language.`,
    },
    /**
     * Nothing usable came back from any source. Rare, and worth saying plainly
     * rather than showing a zero that looks like a valuation.
     */
    unpriced: {
        rank: 0,
        label: 'No price found',
        weight: 0,
        // Always framed as an explanation rather than passing a raw reason
        // through, so the sentence reads the same whether the caller had a
        // specific cause or none at all.
        explain: (why) => why
            ? `No price found — ${why}.`
            : 'No marketplace quotes a price for this card yet.',
    },
};

/**
 * Fit a standalone sentence into the middle of another one.
 *
 * The verifier phrases its failures as sentences for a person ("The closest
 * Chinese match is numbered 051, not 120/105.") and those are exactly the words
 * worth showing beside an estimate — so they are reused rather than rewritten,
 * which is how they stay accurate as the verifier changes.
 */
export function asReasonClause(sentence) {
    const trimmed = String(sentence || '').trim().replace(/\.$/, '');
    if (!trimmed) return '';
    // Only lower the first letter when it is an ordinary word. "TCGdex", "No"
    // in "No Chinese card matched…" and set codes must survive intact.
    return /^[A-Z][a-z]/.test(trimmed) ? trimmed[0].toLowerCase() + trimmed.slice(1) : trimmed;
}

/**
 * Which tier a lookup earned.
 *
 * The `answered` flag is the difference between an estimate and a guess, and
 * getting it wrong is expensive. An estimate is defensible because the
 * databases were asked, replied, and the reply did not quite fit the card — the
 * name, number and language are still known, so a number based on them means
 * something. When the databases could not be reached at all, none of that
 * holds: nothing was learned about the card, and any figure is invention.
 *
 * This is not hypothetical. A Rayquaza VMAX was shown at $1,253.94, labelled
 * "Estimated — the card database could not answer — Rate limited", which is the
 * app stating in the same breath that it had a price and that it had no idea.
 * Cards like that inflated the collection total past $20,000.
 *
 * @param {object} opts
 * @param {boolean} opts.verified whether the printing was confirmed
 * @param {number}  opts.price    what the sources returned
 * @param {string}  [opts.why]    why verification failed, for the explanation
 * @param {boolean} [opts.answered] whether the databases actually replied
 */
export function tierFor({ verified, price, why, answered = true } = {}) {
    if (!(Number(price) > 0)) return { tier: 'unpriced', ...TIERS.unpriced, explanation: TIERS.unpriced.explain(why) };
    if (verified) return { tier: 'confirmed', ...TIERS.confirmed, explanation: TIERS.confirmed.explain(why) };
    if (!answered) {
        // Deliberately reported as having no price rather than as an estimate.
        // The card keeps whatever price it already had, and the next refresh
        // tries again — which is the honest outcome of a lookup that was never
        // made.
        return {
            tier: 'unpriced',
            ...TIERS.unpriced,
            explanation: 'No price yet — the card databases could not be reached to confirm which printing this is. The app will try again automatically.',
            unreached: true,
        };
    }
    return { tier: 'estimated', ...TIERS.estimated, explanation: TIERS.estimated.explain(why) };
}

/**
 * Scale a lookup's own confidence by how well the card was identified.
 *
 * These are two different uncertainties and both belong in the final number:
 * the pricing engine's confidence is about how well the sources agreed, and the
 * tier is about whether they were even asked about the right card. A tight
 * consensus on a card we are only 60% sure we identified is not a 90% answer.
 */
export function scaleConfidence(sourceConfidence, tier) {
    const weight = TIERS[tier]?.weight ?? 0;
    const scaled = (Number(sourceConfidence) || 0) * weight;
    return Number(Math.max(0, Math.min(1, scaled)).toFixed(2));
}

/**
 * Should this price replace what the card already has?
 *
 * A confirmed price always wins. An estimate must never overwrite a confirmed
 * one — a later refresh that happens to fail verification would otherwise
 * downgrade a card that was correctly priced yesterday, and the collection
 * would drift quietly downward over time.
 */
export function shouldReplace(existingTier, incomingTier) {
    const existing = TIERS[existingTier]?.rank ?? 0;
    const incoming = TIERS[incomingTier]?.rank ?? 0;
    return incoming >= existing;
}
