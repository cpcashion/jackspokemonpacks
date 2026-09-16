/**
 * Choosing the right picture of a card.
 *
 * The app shows stock artwork in preference to the photograph you took, which
 * is the only way a collection reads like a marketplace instead of a shoebox of
 * snapshots. That preference is also what makes a wrong picture dangerous: a
 * clean, sharp, confidently-rendered image of the wrong Steelix looks exactly
 * as authoritative as the right one, and nothing on screen admits the
 * difference.
 *
 * The old matcher searched by name, then took the first result whose `localId`
 * equalled the printed number. Card numbers are only unique *within a set* —
 * there is a card numbered 93 in dozens of sets — so "the first 93 named
 * Steelix" is a lottery among printings, and it won often enough to look like
 * it worked. Its own comment claimed it refused to guess. It guessed.
 *
 * What actually identifies a printing is the whole fraction. "093/132" says
 * card 93 of a set that has 132 cards in it, and the denominator is printed
 * right there on the card — it is evidence, not inference, which is why the
 * variant key is built from it too. A set's official card count is exactly that
 * denominator, so matching both halves names one printing and no other.
 *
 * Where the card carries no denominator — promos, mostly — the number alone
 * cannot pick a printing and the set name is the only thing left. That is a
 * weaker claim, so it is reported as one rather than being quietly treated the
 * same.
 */

/** How the artwork was settled, strongest first. */
export const MATCH_PRINTED = 'printed';   // number and denominator both agree
export const MATCH_SET_NAME = 'set-name'; // no denominator; the set name agreed
export const MATCH_NONE = 'none';

/**
 * Does this candidate carry the exact printed number of the card in hand?
 *
 * @param {{localId?: string|number, setOfficialCount?: number}} candidate
 * @param {{number: string, printedTotal: number}} printed  from parseCardNumber
 */
export function matchesPrintedNumber(candidate, printed) {
    if (!candidate || !printed) return false;
    const { number, printedTotal } = printed;
    if (!number || !printedTotal) return false;

    const localId = String(candidate.localId ?? '').trim().replace(/^0+/, '');
    if (!localId || localId !== String(number)) return false;

    return Number(candidate.setOfficialCount) === Number(printedTotal);
}

/** Does the candidate's set name agree with the one we were given? */
export function matchesSetName(candidate, cardSet) {
    const a = String(candidate?.setName || '').trim().toLowerCase();
    const b = String(cardSet || '').trim().toLowerCase();
    if (!a || !b) return false;
    return a.includes(b) || b.includes(a);
}

/**
 * Pick the artwork for a card, or refuse.
 *
 * @param {Array<{localId?, setOfficialCount?, setName?, image?}>} candidates
 * @param {{number: string, printedTotal: number}} printed
 * @param {string} [cardSet]
 * @returns {{candidate: object, match: string}|null}
 */
export function chooseArtwork(candidates, printed, cardSet = '') {
    const usable = (candidates || []).filter(c => c && c.image);
    if (!usable.length) return null;

    const exact = usable.filter(c => matchesPrintedNumber(c, printed));
    // More than one card claiming the same number in a set of the same size is
    // not a tie to break on a coin flip — it means the evidence did not
    // actually single a printing out.
    if (exact.length === 1) return { candidate: exact[0], match: MATCH_PRINTED };
    if (exact.length > 1) return null;

    // No denominator to go on. The set name is a guess the model made rather
    // than something printed, so it settles a picture only when nothing
    // stronger is available, and says so.
    if (!printed?.printedTotal && cardSet) {
        const byName = usable.filter(c => matchesSetName(c, cardSet));
        if (byName.length === 1) return { candidate: byName[0], match: MATCH_SET_NAME };
    }
    return null;
}
