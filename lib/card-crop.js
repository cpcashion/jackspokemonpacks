/**
 * Turning "there are sixteen cards in this photo" into sixteen cards.
 *
 * The original uploads that built this collection were photos of binder pages
 * and tabletop grids — a dozen or more cards in one frame. Each one was saved
 * as a single row whose picture was the whole grid, so a card the app had read
 * perfectly was filed under a thumbnail showing fifteen other cards, and the
 * fifteen were never added at all.
 *
 * The model already reads every card in the frame. What was missing was any
 * notion of *where* each one is, so this takes the bounding boxes it returns
 * and works out the pixel rectangle to cut. The geometry is separated from the
 * image library and the network so it can be tested directly: an off-by-one in
 * a crop is invisible — you still get a picture, just of the wrong card.
 */

/** Gemini returns box coordinates on a fixed 0-1000 grid, not in pixels. */
export const BOX_SCALE = 1000;

/**
 * Is this box usable at all?
 *
 * A model asked for coordinates will occasionally return a degenerate or
 * inverted rectangle. Cropping to one throws inside sharp, which would fail
 * the whole photo — so anything malformed is refused here and the caller falls
 * back to the uncropped image.
 */
export function isUsableBox(box) {
    if (!Array.isArray(box) || box.length !== 4) return false;
    if (!box.every(v => Number.isFinite(Number(v)))) return false;
    const [ymin, xmin, ymax, xmax] = box.map(Number);
    if (ymax <= ymin || xmax <= xmin) return false;
    // Must lie on the documented grid, with a little slack for a model that
    // rounds a touch past the edge.
    if (Math.min(ymin, xmin) < -20) return false;
    if (Math.max(ymax, xmax) > BOX_SCALE + 20) return false;
    // A box covering almost nothing is a misread, not a card.
    const area = ((ymax - ymin) / BOX_SCALE) * ((xmax - xmin) / BOX_SCALE);
    return area >= 0.0015;
}

/**
 * Convert a model box to a pixel rectangle, with a margin.
 *
 * The margin is deliberate. Model boxes tend to sit just inside the card, and a
 * crop taken exactly on the reported edge shaves off the border — which on a
 * Pokemon card is where the holo pattern and the set symbol live, both of which
 * matter for identifying it. A few percent of slack costs nothing and keeps the
 * card whole.
 *
 * @param {number[]} box    [ymin, xmin, ymax, xmax] on the 0-1000 grid
 * @param {number}   width  image width in pixels
 * @param {number}   height image height in pixels
 * @param {number}   [margin] fraction of the box's own size to add on each side
 * @returns {{left:number, top:number, width:number, height:number}|null}
 */
export function boxToRegion(box, width, height, margin = 0.04) {
    if (!isUsableBox(box) || !(width > 0) || !(height > 0)) return null;

    const [ymin, xmin, ymax, xmax] = box.map(Number);
    const padY = ((ymax - ymin) * margin);
    const padX = ((xmax - xmin) * margin);

    const clamp = (v, hi) => Math.max(0, Math.min(hi, v));
    const top = clamp(Math.round(((ymin - padY) / BOX_SCALE) * height), height);
    const left = clamp(Math.round(((xmin - padX) / BOX_SCALE) * width), width);
    const bottom = clamp(Math.round(((ymax + padY) / BOX_SCALE) * height), height);
    const right = clamp(Math.round(((xmax + padX) / BOX_SCALE) * width), width);

    const w = right - left;
    const h = bottom - top;
    // sharp refuses a zero-size extract, and a region a couple of pixels across
    // is not a card even if the arithmetic is sound.
    if (w < 8 || h < 8) return null;
    return { left, top, width: w, height: h };
}

/**
 * Does this photo show a spread of cards rather than one?
 *
 * Used to decide whether a photo is worth re-reading at full resolution. A
 * single card fills the frame and its own detail is legible in a downscaled
 * copy; sixteen cards in the same frame means each gets a sixteenth of those
 * pixels, and a card number set in 15px type on the original is unreadable by
 * the time it reaches the model.
 */
export function isMultiCard(cards) {
    return Array.isArray(cards) && cards.length > 1;
}

/**
 * Which cards in a multi-card photo were read too poorly to trust?
 *
 * These are the ones worth spending a second, full-resolution look on. Ordered
 * worst-first so a capped retry budget is spent where it does the most good.
 */
export function needsCloserLook(cards, { minConfidence = 0.75 } = {}) {
    return (cards || [])
        .map((card, index) => ({ card, index }))
        .filter(({ card }) => {
            if (!isUsableBox(card?.box_2d)) return false;
            const confidence = Number(card?.confidence) || 0;
            const number = String(card?.card_number || '').trim();
            // Either the model said it struggled, or the field that identifies
            // the printing never came through.
            return confidence < minConfidence || !number;
        })
        .sort((a, b) => (Number(a.card?.confidence) || 0) - (Number(b.card?.confidence) || 0));
}

/**
 * Merge a closer re-read into the card it refines.
 *
 * The second look is at higher resolution and is therefore believed about the
 * text it could read — but only where it actually read something. A re-read
 * that comes back blank must not erase what the first pass got right, which is
 * the obvious way for a "refinement" pass to make things worse.
 */
export function mergeCloserLook(original, closer) {
    if (!closer) return original;
    const merged = { ...original };
    for (const field of ['card_name', 'card_name_en', 'card_number', 'card_set', 'set_code', 'rarity', 'holo_type', 'language']) {
        const value = closer[field];
        if (typeof value === 'string' && value.trim()) merged[field] = value;
    }
    if (Number(closer.year) > 0) merged.year = closer.year;
    if (typeof closer.is_holographic === 'boolean') merged.is_holographic = closer.is_holographic;
    if (typeof closer.is_first_edition === 'boolean') merged.is_first_edition = closer.is_first_edition;
    // Confidence is taken from whichever look read the card better, since the
    // merged record is at least as good as either one alone.
    merged.confidence = Math.max(Number(original?.confidence) || 0, Number(closer?.confidence) || 0);
    // The box belongs to the original frame; a re-read of a crop describes the
    // crop's own coordinate space and would be meaningless here.
    merged.box_2d = original?.box_2d;
    return merged;
}
