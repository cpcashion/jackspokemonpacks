/**
 * Telling "six cards" from "one card photographed six times".
 *
 * The copy count is the one number in this app that no marketplace can check.
 * A price can be looked up; how many Charizards are physically in the binder
 * cannot. So when a scan of a card already held adds a copy, an accidental
 * second photo of the same card silently inflates the collection — and since
 * value is quantity × price, it inflates the total too.
 *
 * There is a record to check it against. Every copy stores the thumbnail of the
 * scan that created it, so the question "are these two copies the same physical
 * card?" reduces to "are these two photos the same photo?" — which is
 * answerable.
 *
 * The method is a difference hash. Reduce each thumbnail to 9×8 greyscale and
 * record, for each pixel, whether it is brighter than its right-hand neighbour.
 * That yields 64 bits describing the *structure* of the image, which survives
 * the things that differ between two photos of one card — exposure, small
 * shifts, JPEG artefacts — and changes completely between two different cards.
 * Measured on synthetic re-shots: 0 bits differ for a re-shot, 31 for a
 * different card. The gap is wide enough that the threshold is not delicate.
 *
 * This module only ever *reports*. Deleting a copy someone actually owns is
 * worse than leaving a duplicate, so nothing here removes anything; the caller
 * shows the photos side by side and a person decides.
 */

/** Bits that may differ before two photos are treated as different cards. */
export const SAME_PHOTO_MAX_DISTANCE = 10;

/**
 * Copies created within this window of each other came from one upload. Two
 * photos of the same card minutes apart is a re-scan; two photos seconds apart
 * in one batch is far more likely the same card caught twice.
 */
export const SAME_BATCH_MS = 90 * 1000;

/**
 * 64-bit difference hash of an image.
 * @param {Buffer} buffer
 * @param {import('sharp')} sharp injected so this module stays testable
 * @returns {Promise<string|null>} 64 chars of '0'/'1', or null if unreadable
 */
export async function perceptualHash(buffer, sharp) {
    try {
        const px = await sharp(buffer, { failOn: 'none' })
            .greyscale()
            .resize(9, 8, { fit: 'fill' })
            .raw()
            .toBuffer();
        if (px.length < 72) return null;

        let bits = '';
        for (let y = 0; y < 8; y++) {
            for (let x = 0; x < 8; x++) {
                bits += px[y * 9 + x] > px[y * 9 + x + 1] ? '1' : '0';
            }
        }
        return bits;
    } catch {
        return null;
    }
}

/** How many bits two hashes differ by. 0 = identical structure. */
export function hammingDistance(a, b) {
    if (!a || !b || a.length !== b.length) return Infinity;
    let d = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
    return d;
}

/** Decode a `data:image/...;base64,...` URL to a Buffer. */
export function decodeDataUrl(dataUrl) {
    const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(String(dataUrl || ''));
    if (!match) return null;
    try {
        return match[2] ? Buffer.from(match[3], 'base64') : Buffer.from(decodeURIComponent(match[3]), 'utf8');
    } catch {
        return null;
    }
}

/**
 * Group one card's copies into sets that look like the same physical card.
 *
 * Copies with no photo are never grouped with anything. They were added by hand
 * or predate the thumbnail, so there is no evidence either way, and inventing
 * some would be worse than admitting none exists.
 *
 * @param {{id:number, hash:string|null, created_at:string|Date, condition?:string}[]} copies
 * @returns {{ids:number[], size:number, maxDistance:number, sameBatch:boolean}[]}
 *   one entry per suspected group of 2 or more
 */
export function groupLikelySamePhoto(copies, { maxDistance = SAME_PHOTO_MAX_DISTANCE } = {}) {
    const withPhotos = (copies || []).filter(c => c.hash);
    const seen = new Set();
    const groups = [];

    for (const copy of withPhotos) {
        if (seen.has(copy.id)) continue;

        // Transitive: A matches B and B matches C puts all three together, which
        // is what four photos of one card walking slowly around it looks like.
        const group = [copy];
        seen.add(copy.id);
        const queue = [copy];

        while (queue.length) {
            const current = queue.shift();
            for (const other of withPhotos) {
                if (seen.has(other.id)) continue;
                if (hammingDistance(current.hash, other.hash) <= maxDistance) {
                    seen.add(other.id);
                    group.push(other);
                    queue.push(other);
                }
            }
        }

        if (group.length < 2) continue;

        let maxSeen = 0;
        for (let i = 0; i < group.length; i++) {
            for (let j = i + 1; j < group.length; j++) {
                const d = hammingDistance(group[i].hash, group[j].hash);
                if (d !== Infinity) maxSeen = Math.max(maxSeen, d);
            }
        }

        const times = group.map(c => new Date(c.created_at).getTime()).filter(Number.isFinite);
        const sameBatch = times.length > 1 && (Math.max(...times) - Math.min(...times)) <= SAME_BATCH_MS;

        groups.push({
            ids: group.map(c => c.id).sort((a, b) => a - b),
            size: group.length,
            maxDistance: maxSeen,
            sameBatch,
        });
    }

    return groups.sort((a, b) => b.size - a.size);
}

/**
 * Turn the groups into a claim about the count.
 *
 * `suggestedQuantity` is what the count would be if every suspected group were
 * really one card: the copies that look unique, plus one for each group. It is
 * a suggestion precisely because someone may own two identical cards and have
 * photographed both — which looks exactly the same to a hash.
 */
export function summariseCard(card, copies, groups) {
    const duplicated = groups.reduce((n, g) => n + g.size - 1, 0);
    return {
        card_id: card.id,
        card_name: card.card_name,
        card_set: card.card_set,
        card_number: card.card_number,
        unit_price: Number(card.unit_price) || 0,
        quantity: copies.length,
        suggestedQuantity: copies.length - duplicated,
        duplicateCopies: duplicated,
        // What the collection total would drop by if every suggestion were
        // accepted — the reason this matters beyond tidiness.
        overstatedValue: Number(((Number(card.unit_price) || 0) * duplicated).toFixed(2)),
        groups,
    };
}
