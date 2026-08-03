/**
 * Spending eBay's daily allowance without running out of it.
 *
 * The failure this prevents is one the app has made in other forms repeatedly:
 * doing something that cannot work and reporting it as a fact about the card.
 * An exhausted allowance and a card nobody sells look identical from the
 * outside, and only one of them is the card's fault.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createBudget,
    budgetDay,
    cardsAffordable,
    EBAY_DAILY_LIMIT,
    INTERACTIVE_RESERVE,
} from '../lib/api-budget.js';

const at = (iso) => new Date(iso);

test('the allowance is counted against the day the provider resets on', () => {
    assert.equal(budgetDay(at('2026-08-03T00:00:01Z')), '2026-08-03');
    assert.equal(budgetDay(at('2026-08-03T23:59:59Z')), '2026-08-03');
    // Late evening in the US is already tomorrow in UTC, which is the clock
    // eBay resets by — counting on local time would reset hours early and
    // overspend every night.
    assert.equal(budgetDay(at('2026-08-03T19:00:00-07:00')), '2026-08-04');
});

test('bulk work stops short of the limit, leaving the reserve intact', async () => {
    const budget = createBudget({ limit: 100, reserve: 20 });
    await budget.spend(79);

    assert.equal(await budget.canSpend(1), true, '80 of 100 is still inside the bulk ceiling');
    await budget.spend(1);
    assert.equal(await budget.canSpend(1), false, 'the last 20 are not for bulk work');

    const state = await budget.state();
    assert.equal(state.exhausted, true);
    assert.equal(state.remainingForBulk, 0);
    assert.equal(state.remaining, 20, 'but the reserve itself is untouched');
});

/**
 * A card photographed in the room matters more than the next row of a
 * background refresh, so a scan can always reach eBay even after a long one.
 */
test('a scan can spend the reserve that a refresh cannot', async () => {
    const budget = createBudget({ limit: 100, reserve: 20 });
    await budget.spend(85);

    assert.equal(await budget.canSpend(1), false, 'the refresh is done for today');
    assert.equal(await budget.canSpend(1, { interactive: true }), true, 'a person waiting is not');

    await budget.spend(15);
    assert.equal(await budget.canSpend(1, { interactive: true }), false, 'until the allowance is truly gone');
});

test('the count resets when the day does', async () => {
    const budget = createBudget({ limit: 100, reserve: 0 });
    await budget.spend(100, { now: at('2026-08-03T12:00:00Z') });
    assert.equal(await budget.canSpend(1, { now: at('2026-08-03T23:59:00Z') }), false);
    assert.equal(await budget.canSpend(1, { now: at('2026-08-04T00:00:30Z') }), true,
        'a new day is a new allowance');
});

/**
 * The free tier restarts often. An in-memory counter would forget what it spent
 * and the next boot would cheerfully spend it again.
 */
test('what was already spent survives a restart', async () => {
    const store = {};
    const make = () => createBudget({
        limit: 100,
        reserve: 0,
        load: async (day) => store[day],
        save: async (day, used) => { store[day] = used; },
    });

    const before = make();
    await before.spend(95, { now: at('2026-08-03T10:00:00Z') });

    // A fresh process, same day.
    const after = make();
    assert.equal(await after.canSpend(10, { now: at('2026-08-03T11:00:00Z') }), false,
        'the new process must not re-spend the old one\'s allowance');
    assert.equal((await after.state({ now: at('2026-08-03T11:00:00Z') })).used, 95);
});

test('a stored count from another day is not carried over', async () => {
    const store = { '2026-08-02': 4900 };
    const budget = createBudget({
        limit: 5000, reserve: 0,
        load: async (day) => store[day],
        save: async (day, used) => { store[day] = used; },
    });
    const state = await budget.state({ now: at('2026-08-03T00:05:00Z') });
    assert.equal(state.used, 0, 'yesterday\'s spending is yesterday\'s problem');
});

/**
 * The number that made this necessary: 662 cards, a ladder of up to four
 * searches each firing two requests, against an allowance of 5,000.
 */
test('the real collection does not fit in one day at worst case', () => {
    const worstCasePerCard = 8;
    assert.ok(662 * worstCasePerCard > EBAY_DAILY_LIMIT,
        'this is why a budget exists rather than a hope');

    const bulk = EBAY_DAILY_LIMIT - INTERACTIVE_RESERVE;
    assert.equal(cardsAffordable(bulk, worstCasePerCard), 562);
    assert.equal(cardsAffordable(bulk, 2), 2250, 'most cards answer on the first search and cost far less');
});

test('an exhausted allowance covers no cards at all, rather than a negative number', () => {
    assert.equal(cardsAffordable(0), 0);
    assert.equal(cardsAffordable(-50), 0);
    assert.equal(cardsAffordable(100, 0), 0);
});
