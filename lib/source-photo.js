/**
 * Telling a photograph of a collection from a photograph of a card.
 *
 * The collection was built by uploading pictures of whole binder pages and
 * tabletop layouts — six or eight cards across, three or four down — with the
 * intent that the app read every card in them. The scanner of the day instead
 * took the first card the model named and saved the entire photograph as that
 * card's picture. So a photo of twenty cards became one row, showing twenty
 * cards, that no marketplace could price. Those rows are not cards and should
 * never have been in the collection: they are *source material*, and the cards
 * are inside them.
 *
 * Deciding which stored photos are of that kind, without spending a vision call
 * on every row, comes down to shape. A Pokémon card is 63 × 88 mm — decidedly
 * upright, an aspect ratio near 0.72 — and a photograph of one, however
 * casually framed, stays upright. A grid of them does not: eight across and
 * three down is twice as wide as it is tall.
 *
 * The rule here is deliberately one-directional. Landscape means "not one
 * upright card", which is nearly always a spread. Portrait means nothing either
 * way, because a tall grid is also portrait — so those are left for the vision
 * pass to judge, which reads what is actually there. Being wrong in the
 * cautious direction leaves a row in the collection for a little longer; being
 * wrong in the confident direction would hide a card somebody owns.
 */

/** 63 × 88 mm, the standard Pokémon card. */
export const CARD_ASPECT = 63 / 88;

/**
 * How far from upright a photo must be before it is certainly not one card.
 *
 * Set at square. A single card photographed in landscape orientation would have
 * to be turned deliberately on its side, which is not how anybody photographs a
 * card they want identified — whereas a row of six or eight cards is landscape
 * by construction.
 */
export const LANDSCAPE_THRESHOLD = 1.0;

/**
 * Could this image be a single upright card?
 *
 * @param {{width:number, height:number}} size
 * @returns {boolean} false only when the shape rules it out
 */
export function couldBeSingleCard({ width, height } = {}) {
    if (!(width > 0) || !(height > 0)) return true;   // unknown shape decides nothing
    return width / height < LANDSCAPE_THRESHOLD;
}

/**
 * Which stored photos are spreads rather than single cards?
 *
 * @param {Array<{id:number, width:number, height:number}>} photos
 * @returns {number[]} ids that the shape alone rules out as a single card
 */
export function spreadPhotoIds(photos) {
    return (photos || [])
        .filter(p => !couldBeSingleCard(p))
        .map(p => p.id);
}
