/**
 * Spending a daily API allowance without running out.
 *
 * eBay's Browse API gives an application 5,000 calls a day. That sounds ample
 * until you count: pricing one card walks a ladder of up to four searches, each
 * firing two requests — fixed-price listings and auctions — so a single card can
 * cost eight calls, and a collection of 662 can cost 5,296. The first full
 * refresh would therefore exhaust the day's allowance somewhere near the end and
 * every card looked at afterwards would come back unpriced, for 24 hours, with
 * nothing on screen to distinguish that from the app being broken again.
 *
 * The allowance also resets on eBay's clock, not ours, and a free-tier web
 * service restarts often enough that an in-memory counter would forget most of
 * what it spent. So the count is persisted and keyed by UTC day.
 *
 * Two deliberate choices:
 *
 *   Headroom is reserved rather than spent. Running to exactly 5,000 leaves
 *   nothing for a scan — and a card photographed in the room matters far more
 *   than the next row of a background refresh.
 *
 *   Running out is reported, never silent. "The daily eBay allowance is spent"
 *   is a different fact from "no marketplace lists this card", and the second
 *   is what the app said for both before.
 */

/** eBay's documented default for an application token. */
export const EBAY_DAILY_LIMIT = 5000;

/**
 * Held back from bulk work, so an interactive scan or a manual re-price can
 * always reach eBay even after a long refresh.
 */
export const INTERACTIVE_RESERVE = 500;

/** The day an allowance belongs to, on the clock the provider resets by. */
export function budgetDay(now = new Date()) {
    return new Date(now).toISOString().slice(0, 10);
}

/**
 * A counter that survives restarts.
 *
 * Storage is injected — the server persists to app_meta, tests use a plain
 * object — so the arithmetic here can be checked without a database.
 */
export function createBudget({ limit = EBAY_DAILY_LIMIT, reserve = INTERACTIVE_RESERVE, load, save } = {}) {
    let day = '';
    let used = 0;
    let loaded = false;

    const rollover = async (now) => {
        const today = budgetDay(now);
        if (day === today && loaded) return;
        day = today;
        used = 0;
        loaded = true;
        if (load) {
            const stored = await load(today);
            used = Number(stored) || 0;
        }
    };

    return {
        /**
         * May `cost` more calls be made right now?
         *
         * @param {object} [opts]
         * @param {boolean} [opts.interactive] true for work a person is waiting
         *   on, which may dip into the reserve.
         */
        async canSpend(cost = 1, { interactive = false, now = new Date() } = {}) {
            await rollover(now);
            const ceiling = interactive ? limit : limit - reserve;
            return used + cost <= ceiling;
        },

        async spend(cost = 1, { now = new Date() } = {}) {
            await rollover(now);
            used += cost;
            if (save) await save(day, used);
            return used;
        },

        async state({ now = new Date() } = {}) {
            await rollover(now);
            return {
                day,
                used,
                limit,
                reserve,
                remaining: Math.max(0, limit - used),
                remainingForBulk: Math.max(0, limit - reserve - used),
                exhausted: used >= limit - reserve,
            };
        },
    };
}

/**
 * How many cards a remaining allowance can cover.
 *
 * Used to tell someone what a refresh will actually get through before it
 * starts, rather than having it stop silently part-way.
 */
export function cardsAffordable(remaining, callsPerCard = 4) {
    if (!(remaining > 0) || !(callsPerCard > 0)) return 0;
    return Math.floor(remaining / callsPerCard);
}
