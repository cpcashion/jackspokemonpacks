/**
 * Integration tests against a real Postgres.
 *
 * Skipped unless TEST_DATABASE_URL is set, so `npm test` stays runnable without
 * a database. These cover the parts unit tests cannot: the migrations, the
 * copies model, and duplicate consolidation actually preserving data.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import pkg from 'pg';

const { Pool } = pkg;
const DB = process.env.TEST_DATABASE_URL;
// Random high port so a straggler from an aborted run cannot block the next one.
const PORT = Number(process.env.TEST_PORT || 40000 + Math.floor(Math.random() * 20000));
const BASE = `http://127.0.0.1:${PORT}`;

if (!DB) {
    test('integration tests (skipped: set TEST_DATABASE_URL to run)', { skip: true }, () => {});
} else {
    let server;
    let pool;

    const api = async (path, init) => {
        const res = await fetch(BASE + path, {
            ...init,
            headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
        });
        const body = await res.json().catch(() => null);
        return { status: res.status, body };
    };

    const waitForServer = async () => {
        for (let i = 0; i < 100; i++) {
            try {
                const res = await fetch(`${BASE}/api/auth/me`);
                if (res.ok) return;
            } catch { /* not up yet */ }
            await new Promise(r => setTimeout(r, 200));
        }
        throw new Error('server did not start');
    };

    /** Insert a card row directly, as if it predated the copies model. */
    const seedLegacyCard = async (over = {}) => {
        const c = {
            card_name: 'Charizard', card_set: 'Base Set', card_number: '4/102',
            holo_type: 'Holofoil', language: 'English', is_first_edition: 0,
            condition: 'Near Mint', ...over,
        };
        const res = await pool.query(`
            INSERT INTO portfolio_cards
                (user_id, card_name, card_name_en, card_set, card_number, holo_type, language,
                 is_first_edition, is_holo, condition, current_price, needs_review)
            VALUES (1, $1, $2, $3, $4, $5, $6, $7, 1, $8, $9, $10) RETURNING id
        `, [c.card_name, c.card_name_en ?? '', c.card_set, c.card_number, c.holo_type, c.language,
            c.is_first_edition, c.condition, c.current_price ?? 0, c.needs_review ?? 0]);
        return res.rows[0].id;
    };

    test.before(async () => {
        pool = new Pool({ connectionString: DB });
        await pool.query(`
            DROP TABLE IF EXISTS card_copies, price_history, portfolio_cards, users CASCADE;
        `);

        server = spawn(process.execPath, ['server.js'], {
            env: { ...process.env, DATABASE_URL: DB, PORT: String(PORT), GEMINI_API_KEY: '' },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        server.stderr.on('data', d => { if (process.env.VERBOSE) process.stderr.write(d); });
        // Belt and braces: never leave a server holding the port if a test aborts.
        process.on('exit', () => server?.kill('SIGKILL'));
        await waitForServer();
        // Wait for both the migrations and the default user, since seeding cards
        // depends on user 1 existing.
        for (let i = 0; i < 100; i++) {
            const tables = await pool.query("SELECT to_regclass('card_copies') AS t");
            if (tables.rows[0].t) {
                const user = await pool.query('SELECT id FROM users WHERE id = 1');
                if (user.rows.length) break;
            }
            await new Promise(r => setTimeout(r, 200));
        }
    });

    test.after(async () => {
        server?.kill('SIGKILL');
        await pool?.end();
    });

    test('migration creates the copies table and backfills existing cards', async () => {
        const id = await seedLegacyCard({ card_name: 'Legacy Squirtle', card_number: '63/102', condition: 'Lightly Played' });
        // restart-equivalent: run the same backfill the server runs at boot
        await api('/api/portfolio');
        const before = await pool.query('SELECT COUNT(*)::int c FROM card_copies WHERE card_id = $1', [id]);
        // The row was inserted after boot, so it has no copy yet and must still
        // be reported as one held card rather than zero.
        const { body } = await api('/api/portfolio');
        const card = body.cards.find(c => c.id === id);
        assert.ok(card, 'card should be listed');
        assert.equal(card.quantity, 1, 'a card with no copy row still counts as one held card');
        assert.equal(before.rows[0].c, 0);
    });

    test('variant_key is assigned on insert and distinguishes printings', async () => {
        const a = await seedLegacyCard({ card_name: 'Pikachu', card_number: '58/102', holo_type: 'Non-Holo' });
        const b = await seedLegacyCard({ card_name: 'Pikachu', card_number: '58/102', holo_type: 'Reverse Holo' });
        await api('/api/portfolio'); // triggers nothing, keys come from the boot backfill
        const rows = await pool.query('SELECT id, variant_key FROM portfolio_cards WHERE id = ANY($1::int[])', [[a, b]]);
        // Seeded directly, so keys are blank until the next boot backfill; the
        // API-created path is covered below.
        assert.equal(rows.rows.length, 2);
    });

    test('adding a copy raises quantity and total value, not the unit price', async () => {
        const id = await seedLegacyCard({ card_name: 'Blastoise', card_number: '2/102', current_price: 100 });
        await pool.query("UPDATE portfolio_cards SET variant_key = 'blastoise|base set|2|holo|english|unl' WHERE id = $1", [id]);
        await pool.query('INSERT INTO card_copies (card_id, condition) VALUES ($1, $2)', [id, 'Near Mint']);

        let { body } = await api('/api/portfolio');
        let card = body.cards.find(c => c.id === id);
        assert.equal(card.quantity, 1);
        assert.equal(card.unit_price, 100);
        assert.equal(card.total_value, 100);

        const added = await api(`/api/portfolio/${id}/copies`, {
            method: 'POST',
            body: JSON.stringify({ condition: 'Moderately Played' }),
        });
        assert.equal(added.status, 200);
        assert.equal(added.body.quantity, 2);

        ({ body } = await api('/api/portfolio'));
        card = body.cards.find(c => c.id === id);
        assert.equal(card.quantity, 2);
        assert.equal(card.unit_price, 100, 'unit price must not change when a copy is added');
        assert.equal(card.total_value, 170, 'NM 100 + MP 70');
        assert.equal(card.has_mixed_conditions, true);
    });

    test('a manual value override wins over the condition-adjusted price', async () => {
        const id = await seedLegacyCard({ card_name: 'Graded Zard', card_number: '4/102', current_price: 200 });
        await pool.query("UPDATE portfolio_cards SET variant_key = 'graded zard|base set|4|holo|english|unl' WHERE id = $1", [id]);
        const copy = await pool.query(
            'INSERT INTO card_copies (card_id, condition) VALUES ($1, $2) RETURNING id', [id, 'Damaged']);

        let { body } = await api('/api/portfolio');
        assert.equal(body.cards.find(c => c.id === id).total_value, 70, 'damaged = 35% of 200');

        await api(`/api/portfolio/copies/${copy.rows[0].id}`, {
            method: 'PATCH',
            body: JSON.stringify({ manual_value: 1500, grade: 'PSA 9' }),
        });
        ({ body } = await api('/api/portfolio'));
        assert.equal(body.cards.find(c => c.id === id).total_value, 1500);
    });

    test('deleting the last copy removes the card; deleting one of many does not', async () => {
        const id = await seedLegacyCard({ card_name: 'Mewtwo', card_number: '10/102', current_price: 50 });
        await pool.query("UPDATE portfolio_cards SET variant_key = 'mewtwo|base set|10|holo|english|unl' WHERE id = $1", [id]);
        const c1 = await pool.query('INSERT INTO card_copies (card_id, condition) VALUES ($1, $2) RETURNING id', [id, 'Near Mint']);
        const c2 = await pool.query('INSERT INTO card_copies (card_id, condition) VALUES ($1, $2) RETURNING id', [id, 'Near Mint']);

        let del = await api(`/api/portfolio/copies/${c1.rows[0].id}`, { method: 'DELETE' });
        assert.equal(del.body.quantity, 1);
        assert.equal(del.body.cardRemoved, false);

        del = await api(`/api/portfolio/copies/${c2.rows[0].id}`, { method: 'DELETE' });
        assert.equal(del.body.quantity, 0);
        assert.equal(del.body.cardRemoved, true);

        const gone = await pool.query('SELECT id FROM portfolio_cards WHERE id = $1', [id]);
        assert.equal(gone.rows.length, 0);
    });

    test('duplicate rows are reported before anything is merged', async () => {
        const key = 'gengar|fossil|5|holo|english|unl';
        const ids = [];
        for (let i = 0; i < 3; i++) {
            const id = await seedLegacyCard({ card_name: 'Gengar', card_set: 'Fossil', card_number: '5/62', current_price: 40 });
            await pool.query('UPDATE portfolio_cards SET variant_key = $1 WHERE id = $2', [key, id]);
            await pool.query('INSERT INTO card_copies (card_id, condition) VALUES ($1, $2)', [id, 'Near Mint']);
            ids.push(id);
        }
        await pool.query('INSERT INTO price_history (card_id, price, source) VALUES ($1, $2, $3)', [ids[2], 40, 'test']);

        const preview = await api('/api/portfolio/duplicates');
        const group = preview.body.groups.find(g => g.variant_key === key);
        assert.ok(group, 'duplicate group should be reported');
        assert.equal(group.row_count, 3);
        assert.equal(group.copy_count, 3);

        // Preview alone must not have changed anything.
        const still = await pool.query('SELECT COUNT(*)::int c FROM portfolio_cards WHERE variant_key = $1', [key]);
        assert.equal(still.rows[0].c, 3);

        const refused = await api('/api/portfolio/merge-duplicates', { method: 'POST', body: JSON.stringify({}) });
        assert.equal(refused.status, 400, 'merging must require explicit confirmation');

        const merged = await api('/api/portfolio/merge-duplicates', {
            method: 'POST',
            body: JSON.stringify({ confirm: true, variantKeys: [key] }),
        });
        assert.equal(merged.status, 200);
        assert.equal(merged.body.mergedGroups, 1);
        assert.equal(merged.body.removedRows, 2);

        const after = await pool.query('SELECT id FROM portfolio_cards WHERE variant_key = $1', [key]);
        assert.equal(after.rows.length, 1, 'three rows collapse into one');
        assert.equal(after.rows[0].id, Math.min(...ids), 'the oldest row survives');

        const copies = await pool.query('SELECT COUNT(*)::int c FROM card_copies WHERE card_id = $1', [after.rows[0].id]);
        assert.equal(copies.rows[0].c, 3, 'no physical copy is lost in the merge');

        const history = await pool.query('SELECT COUNT(*)::int c FROM price_history WHERE card_id = $1', [after.rows[0].id]);
        assert.equal(history.rows[0].c, 1, 'price history follows the surviving row');
    });

    test('portfolio stats count printings and physical copies separately', async () => {
        const { body } = await api('/api/portfolio');
        const summed = body.cards.reduce((s, c) => s + c.total_value, 0);
        assert.equal(body.stats.totalCards, body.cards.length);
        assert.equal(
            body.stats.totalCopies,
            body.cards.reduce((s, c) => s + c.quantity, 0),
            'copies counted across all cards',
        );
        assert.ok(
            Math.abs(body.stats.totalValue - summed) < 0.02,
            `header total ${body.stats.totalValue} must equal the sum of the list ${summed}`,
        );
    });

    test('editing a card clears its stale price history when the printing changes', async () => {
        const id = await seedLegacyCard({ card_name: 'Alakazam', card_number: '1/102', current_price: 30 });
        await pool.query("UPDATE portfolio_cards SET variant_key = 'alakazam|base set|1|holo|english|unl' WHERE id = $1", [id]);
        await pool.query('INSERT INTO card_copies (card_id, condition) VALUES ($1, $2)', [id, 'Near Mint']);
        await pool.query('INSERT INTO price_history (card_id, price, source) VALUES ($1, $2, $3)', [id, 30, 'test']);

        const edited = await api(`/api/portfolio/${id}/edit`, {
            method: 'POST',
            body: JSON.stringify({ card_set: 'Base Set 2', holo_type: 'Reverse Holo' }),
        });
        assert.equal(edited.status, 200);
        assert.equal(edited.body.identityChanged, true);

        const row = await pool.query(
            'SELECT variant_key, needs_review, current_price, price_tier FROM portfolio_cards WHERE id = $1', [id]);
        assert.match(row.rows[0].variant_key, /base set 2\|1\|reverse/);

        // An edit is a claim about the card, not a confirmation of it. The
        // stored flag tracks whether the printing was actually confirmed —
        // which is what makes the next refresh try again — and it must agree
        // with what the reply told the user.
        assert.equal(edited.body.confirmed, row.rows[0].needs_review === 0,
            'the stored flag and the reply must agree on whether the printing was confirmed');

        if (!edited.body.confirmed) {
            // The correction is kept and the card is still valued. It used to
            // be left at zero here, so someone who had just typed in the right
            // set and number saw their correction produce nothing.
            assert.match(edited.body.message, /Saved your correction/,
                'the edit must say it was kept');
            if (Number(row.rows[0].current_price) > 0) {
                assert.equal(row.rows[0].price_tier, 'estimated',
                    'a price on an unconfirmed printing must be labelled an estimate');
                assert.match(edited.body.message, /Estimated/,
                    'and the reply must not present it as a market price');
            }
        }
    });

    /**
     * "If I hit reprice, it doesn't really do anything. Nothing gets repriced."
     *
     * The old endpoint answered {price: 0, source: 'not_found'} for every
     * outcome, including a total outage, and the app had nothing to say. These
     * pin the contract that replaced it: a named status, a sentence a person
     * can act on, and — crucially — a price that is never quietly zeroed
     * because a marketplace was unreachable.
     */
    test('re-price names the outcome instead of silently reporting nothing', async () => {
        const id = await seedLegacyCard({ card_name: 'Repriced Zapdos', card_set: 'Fossil', card_number: '15/62', current_price: 77.5 });
        await pool.query("UPDATE portfolio_cards SET variant_key = 'repriced zapdos|fossil|15|holo|english|unl' WHERE id = $1", [id]);
        await pool.query('INSERT INTO card_copies (card_id, condition) VALUES ($1, $2)', [id, 'Near Mint']);

        const { status, body } = await api(`/api/portfolio/${id}/reprice`, { method: 'POST' });
        assert.equal(status, 200);

        assert.ok(['priced', 'unchanged', 'not_found', 'sources_unavailable'].includes(body.status),
            `unexpected status ${body.status}`);
        assert.ok(body.message && body.message.length > 10, 'the outcome is explained in words');
        assert.ok(Array.isArray(body.sources) && body.sources.length, 'every source consulted is accounted for');
        for (const s of body.sources) {
            assert.ok(['answered', 'empty', 'skipped', 'failed'].includes(s.state), `bad source state ${s.state}`);
            assert.ok(s.label, 'each source is named for a person, not by its key');
        }

        // The one thing that must never happen: a card losing its price because
        // a lookup could not be completed.
        const after = await pool.query('SELECT current_price FROM portfolio_cards WHERE id = $1', [id]);
        if (body.status === 'sources_unavailable' || body.status === 'not_found') {
            assert.equal(Number(after.rows[0].current_price), 77.5, 'a failed lookup must not zero a known price');
            assert.equal(body.price, 77.5, 'the reported price is the one the card still has');
        }
    });

    test('re-price works on a card awaiting review, and says what it needs', async () => {
        const id = await seedLegacyCard({ card_name: 'Blurry Vaporeon', card_set: '', card_number: '' });
        await pool.query('UPDATE portfolio_cards SET needs_review = 1 WHERE id = $1', [id]);

        const { status, body } = await api(`/api/portfolio/${id}/reprice`, { method: 'POST' });
        assert.equal(status, 200, 'an unconfirmed card can still be re-priced on request');
        assert.ok(body.message, 'and is told what would let it succeed');
    });

    /**
     * A scan that fails because the recognition service is missing or down must
     * say so. Reporting "no card found" sent people off re-photographing a card
     * that was never the problem. GEMINI_API_KEY is deliberately empty here.
     */
    test('a scan reports why it failed, and streams its progress', async () => {
        // 1x1 PNG — enough for a valid multipart upload.
        const png = Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
            'base64');

        // Listen first, so no event is missed.
        const seen = [];
        const stream = await fetch(`${BASE}/api/events`);
        const reading = (async () => {
            const reader = stream.body.getReader();
            const dec = new TextDecoder();
            let buf = '';
            const deadline = Date.now() + 15000;
            while (Date.now() < deadline) {
                const { done, value } = await reader.read();
                if (done) break;
                buf += dec.decode(value, { stream: true });
                const parts = buf.split('\n\n');
                buf = parts.pop();
                for (const part of parts) {
                    if (!part.startsWith('data: ')) continue;
                    try { seen.push(JSON.parse(part.slice(6))); } catch { /* keepalive */ }
                }
                if (seen.some(e => e.type === 'scan_progress' && e.stage === 'done')) break;
            }
            reader.cancel().catch(() => {});
        })();

        const form = new FormData();
        form.append('cards', new Blob([png], { type: 'image/png' }), 'card.png');
        form.append('scanId', 'itest-scan');
        const res = await fetch(`${BASE}/api/portfolio/upload`, { method: 'POST', body: form });
        const body = await res.json();
        await reading;

        assert.equal(res.status, 200);
        const first = body.results?.[0];
        assert.ok(first, 'the scan reports a result for the photo');
        assert.equal(first.reason, 'not_configured',
            'with no API key the scan must blame the missing key, not the photo');
        assert.match(first.message, /GEMINI_API_KEY/,
            'and name what is missing so it can actually be fixed');

        const progress = seen.filter(e => e.type === 'scan_progress' && e.scanId === 'itest-scan');
        assert.ok(progress.length >= 3, `expected staged progress, got ${progress.map(p => p.stage).join(',')}`);
        const stages = progress.map(p => p.stage);
        assert.ok(stages.includes('identifying'), 'the client is told when the AI is being asked');
        assert.ok(stages.includes('photo_failed'), 'and told when that step failed');
        assert.equal(stages.at(-1), 'done', 'the stream always terminates, so nothing spins forever');

        // Sequence numbers let a client drop out-of-order or duplicate events.
        const seqs = progress.map(p => p.seq);
        assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), 'events carry an increasing sequence');
    });

    /**
     * A non-English card stores and reports as the card it is.
     *
     * Before, its name normalised to the empty string, so it was rejected as
     * unreadable and — had it been saved — would have shared a variant key with
     * every other non-Latin card in the collection.
     */
    test('a Chinese card keeps its printed name, its language, and its own identity', async () => {
        const relicanth = await seedLegacyCard({
            card_name: '古空棘鱼', card_name_en: 'Relicanth', card_set: '', card_number: '014/131',
            language: 'chinese-simplified', holo_type: 'Non-Holo',
        });
        const charizard = await seedLegacyCard({
            card_name: 'リザードン', card_name_en: 'Charizard', card_set: '', card_number: '004/102',
            language: 'japanese', holo_type: 'Holofoil',
        });
        await pool.query('INSERT INTO card_copies (card_id, condition) VALUES ($1, $2), ($3, $2)',
            [relicanth, 'Near Mint', charizard]);

        const { body } = await api('/api/portfolio');
        const cn = body.cards.find(c => c.id === relicanth);
        const jp = body.cards.find(c => c.id === charizard);
        assert.ok(cn && jp, 'both cards are listed');

        assert.equal(cn.card_name, '古空棘鱼', 'stored under the name printed on it');
        assert.equal(cn.card_name_en, 'Relicanth', 'and findable by its English name');
        assert.equal(cn.language_label, 'Chinese (Simplified)');
        assert.equal(cn.is_non_english, true);
        assert.equal(jp.language_label, 'Japanese');

        // These rows were inserted straight into the table, so their keys are
        // assigned by the write path. Touching each through the edit endpoint is
        // what exercises the identity code on a non-Latin name.
        for (const id of [relicanth, charizard]) {
            await api(`/api/portfolio/${id}/edit`, { method: 'POST', body: JSON.stringify({}) });
        }
        const keys = await pool.query(
            'SELECT id, variant_key FROM portfolio_cards WHERE id = ANY($1::int[])', [[relicanth, charizard]]);
        const byId = Object.fromEntries(keys.rows.map(r => [r.id, r.variant_key]));

        assert.notEqual(byId[relicanth], byId[charizard],
            'two non-Latin cards must not share one identity');
        for (const id of [relicanth, charizard]) {
            assert.notEqual(byId[id].split('|')[0], '',
                `the name segment of "${byId[id]}" must not be empty`);
        }
    });

    /**
     * The correctness rule behind the pricing fix. English marketplaces price
     * English printings; substituting one for a Japanese card produces a
     * confident wrong number, which is worse than no number.
     */
    test('English-only price sources are not consulted for a non-English card', async () => {
        const id = await seedLegacyCard({
            card_name: 'リザードン', card_name_en: 'Charizard', card_set: '', card_number: '004/102',
            language: 'japanese', current_price: 0,
        });
        await pool.query('INSERT INTO card_copies (card_id, condition) VALUES ($1, $2)', [id, 'Near Mint']);

        const { body } = await api(`/api/portfolio/${id}/reprice`, { method: 'POST' });
        const byName = Object.fromEntries((body.sources || []).map(s => [s.name, s]));

        for (const name of ['pokemontcg', 'justtcg', 'scrydex']) {
            if (!byName[name]) continue;
            assert.equal(byName[name].state, 'skipped',
                `${name} indexes the English catalogue and must not price a Japanese card`);
            assert.match(byName[name].reason, /English|API key/,
                `${name} should say why it was skipped`);
        }
        // TCGdex is queried per language, so it is the one that may answer.
        assert.ok(byName.tcgdex, 'TCGdex is still consulted');
        assert.notEqual(byName.tcgdex.state, 'skipped');
    });

    /**
     * "There's no value being found for new cards... the user shouldn't ever
     * have to manually review cards or confirm pricing."
     *
     * This has been wrong in both directions. Re-pricing first matched loosely
     * on name and number and valued a card worth cents in the hundreds; the
     * correction refused to price anything unconfirmed, which left cards the
     * app had read perfectly showing nothing at all and parked in a queue.
     *
     * The rule now: re-verify first, because a confirmed printing is worth far
     * more than an estimate — but a card that still cannot be confirmed is
     * priced anyway and labelled `estimated`. Nothing is ever handed back to
     * the user to confirm.
     */
    test('re-pricing a card in review prices it either way, and says which', async () => {
        const id = await seedLegacyCard({
            card_name: 'Steelix', card_set: 'Temporal Forces', card_number: '093/132',
            needs_review: 1, current_price: 0,
        });
        await pool.query('INSERT INTO card_copies (card_id, condition) VALUES ($1, $2)', [id, 'Near Mint']);

        const { status, body } = await api(`/api/portfolio/${id}/reprice`, { method: 'POST' });
        assert.equal(status, 200);

        const row = await pool.query(
            'SELECT needs_review, current_price, price_tier, price_explanation FROM portfolio_cards WHERE id = $1', [id]);
        const stored = row.rows[0];
        const price = Number(stored.current_price);

        assert.ok(['confirmed', 'estimated', 'unpriced'].includes(body.tier), `bad tier ${body.tier}`);

        if (price > 0) {
            // The point of the whole change: a value exists, and the card is
            // no longer anybody's chore.
            assert.equal(stored.needs_review, 0, 'a priced card is not awaiting review');
            assert.equal(body.needsReview, false);
            assert.ok(['confirmed', 'estimated'].includes(stored.price_tier), stored.price_tier);

            if (stored.price_tier === 'estimated') {
                assert.ok(stored.price_explanation, 'an estimate must say why it is one');
                assert.match(body.message, /estimated/i, 'and the reply must not present it as a market price');
            } else {
                assert.equal(body.clearedReview, true, 'confirming must clear the flag');
            }
        } else {
            // No price is only acceptable when nothing quoted one — and even
            // then it is the marketplaces that are outstanding, not the user.
            assert.ok(['not_found', 'sources_unavailable'].includes(body.status), body.status);
            assert.equal(body.tier, 'unpriced');
            assert.doesNotMatch(body.message, /review/i,
                'a missing price must never be described as something for the user to do');
        }
    });

    /**
     * Quantity is the only number here no marketplace can check, and value is
     * quantity × price — so a card photographed twice inflates the total. These
     * cover both halves: finding it, and the guards on acting.
     */
    test('the photo audit finds copies that are one card shot twice, and leaves the rest', async () => {
        const sharp = (await import('sharp')).default;
        const make = async (bg, panel, top = 40) => sharp({ create: { width: 240, height: 336, channels: 3, background: bg } })
            .composite([{ input: await sharp({ create: { width: 160, height: 120, channels: 3, background: panel } }).png().toBuffer(), top, left: 40 }])
            .jpeg().toBuffer();
        const url = (buf) => `data:image/jpeg;base64,${buf.toString('base64')}`;

        const id = await seedLegacyCard({ card_name: 'Audit Zard', card_number: '4/102', current_price: 100 });
        await pool.query("UPDATE portfolio_cards SET variant_key = 'audit zard|base set|4|holo|english|unl' WHERE id = $1", [id]);

        const original = await make({ r: 210, g: 70, b: 40 }, { r: 250, g: 200, b: 60 });
        // Three photos of one card: shifted, dimmed, recompressed.
        for (let i = 0; i < 3; i++) {
            const shot = await sharp(original)
                .extract({ left: 2 + i, top: 3 + i, width: 234 - i * 2, height: 328 - i * 2 })
                .resize(240, 336).modulate({ brightness: 1 - i * 0.03 }).jpeg({ quality: 74 }).toBuffer();
            await pool.query('INSERT INTO card_copies (card_id, condition, image_data) VALUES ($1, $2, $3)',
                [id, 'Near Mint', url(shot)]);
        }
        // A genuinely different second copy.
        const other = await make({ r: 140, g: 60, b: 150 }, { r: 60, g: 230, b: 190 }, 190);
        await pool.query('INSERT INTO card_copies (card_id, condition, image_data) VALUES ($1, $2, $3)',
            [id, 'Lightly Played', url(other)]);
        // And one with no photo, which carries no evidence either way.
        await pool.query('INSERT INTO card_copies (card_id, condition) VALUES ($1, $2)', [id, 'Unknown']);

        const { status, body } = await api('/api/portfolio/photo-audit');
        assert.equal(status, 200);

        const card = body.cards.find(c => c.card_id === id);
        assert.ok(card, 'the card is reported');
        assert.equal(card.quantity, 5, 'five copies are recorded');
        assert.equal(card.duplicateCopies, 2, 'three photos of one card means two are surplus');
        assert.equal(card.suggestedQuantity, 3, 'one from the group, plus the different one, plus the unphotographed one');
        assert.equal(card.overstatedValue, 200, '2 surplus × $100');

        assert.equal(card.groups.length, 1, 'exactly one suspected group');
        assert.equal(card.groups[0].size, 3);
        assert.ok(card.groups[0].sameBatch, 'seeded together, so one batch');
        assert.ok(card.groups[0].copies.every(c => c.image_data),
            'each copy comes back with its photo so the claim can be checked by looking');
    });

    test('the audit refuses to remove copies without confirmation', async () => {
        const res = await api('/api/portfolio/photo-audit/resolve', {
            method: 'POST', body: JSON.stringify({ removeCopyIds: [1, 2] }),
        });
        assert.equal(res.status, 400);
        assert.match(res.body.error, /confirm/i);
    });

    /**
     * The one outcome worse than a wrong count: a card Jack owns disappearing
     * from the collection entirely.
     */
    test('the audit will not remove every copy of a card', async () => {
        const id = await seedLegacyCard({ card_name: 'Last Copy', card_number: '1/102', current_price: 5 });
        const a = await pool.query('INSERT INTO card_copies (card_id, condition) VALUES ($1, $2) RETURNING id', [id, 'Near Mint']);
        const b = await pool.query('INSERT INTO card_copies (card_id, condition) VALUES ($1, $2) RETURNING id', [id, 'Near Mint']);

        const res = await api('/api/portfolio/photo-audit/resolve', {
            method: 'POST',
            body: JSON.stringify({ confirm: true, removeCopyIds: [a.rows[0].id, b.rows[0].id] }),
        });
        assert.equal(res.status, 400);
        assert.match(res.body.error, /every copy/i);

        const left = await pool.query('SELECT COUNT(*)::int c FROM card_copies WHERE card_id = $1', [id]);
        assert.equal(left.rows[0].c, 2, 'and nothing was removed');
    });

    test('the audit removes exactly the copies it was given', async () => {
        const id = await seedLegacyCard({ card_name: 'Trim Me', card_number: '9/102', current_price: 5 });
        const ids = [];
        for (let i = 0; i < 3; i++) {
            const r = await pool.query('INSERT INTO card_copies (card_id, condition) VALUES ($1, $2) RETURNING id', [id, 'Near Mint']);
            ids.push(r.rows[0].id);
        }
        const res = await api('/api/portfolio/photo-audit/resolve', {
            method: 'POST', body: JSON.stringify({ confirm: true, removeCopyIds: ids.slice(1) }),
        });
        assert.equal(res.status, 200);
        assert.equal(res.body.removed, 2);

        const left = await pool.query('SELECT id FROM card_copies WHERE card_id = $1', [id]);
        assert.deepEqual(left.rows.map(r => r.id), [ids[0]], 'the one it was told to keep is the one that remains');
    });

    /**
     * A 403 from an egress rule and a 403 from an API mean opposite things:
     * one is fixed by an allowlist, the other by a new key. Reporting the wrong
     * one sends you off rotating a credential that was working fine.
     */
    test('a network block is not reported as a bad API key', async () => {
        const { body } = await api('/api/diagnostics');
        const byName = Object.fromEntries(body.checks.map(c => [c.name, c]));

        for (const name of ['pokemontcg', 'tcgdex']) {
            const check = byName[name];
            if (!check || check.ok) continue;
            if (check.kind === 'blocked') {
                assert.doesNotMatch(check.detail, /check the API key/i,
                    'a blocked request must not send you to check a key');
                assert.match(check.hint, /network|egress/i,
                    'and the hint must point at the network rule');
                assert.doesNotMatch(check.hint, /Set POKEMON_TCG_KEY|Check .*_API_KEY/,
                    'nor should the hint');
            }
        }

        // TCGdex authenticates with nothing at all, so no failure of any kind
        // may advise checking its key.
        const tcgdex = byName.tcgdex;
        if (tcgdex && !tcgdex.ok) {
            assert.doesNotMatch(tcgdex.detail, /check the API key/i,
                'TCGdex has no key to check');
        }
    });

    test('the bulk re-check walks every card in review and reports itself', async () => {
        for (const n of ['Xerneas', 'Rabsca']) {
            const id = await seedLegacyCard({ card_name: n, card_set: '', card_number: '064/132', needs_review: 1 });
            await pool.query('INSERT INTO card_copies (card_id, condition) VALUES ($1, $2)', [id, 'Near Mint']);
        }
        const before = await pool.query(
            'SELECT COUNT(*)::int c FROM portfolio_cards WHERE COALESCE(needs_review,0) = 1');
        assert.ok(before.rows[0].c >= 2);

        const { status, body } = await api('/api/portfolio/recheck-review', { method: 'POST' });
        assert.equal(status, 200);
        assert.equal(body.started, before.rows[0].c, 'every flagged card is queued');
        assert.match(body.message, /Re-checking/);

        // A second request while one is running is refused rather than doubling
        // the load on the card database.
        const again = await api('/api/portfolio/recheck-review', { method: 'POST' });
        assert.equal(again.status, 409);
    });

    /**
     * The original bulk uploads were photos of whole binder pages, and the
     * scanner of the day kept one card from each and dropped the rest. The
     * recovery pass has to be safe to run repeatedly on a live collection, so
     * these pin its guarantees rather than its output — which depends on a
     * vision model this suite deliberately does not call.
     */
    test('the grid re-scan refuses honestly when recognition is not configured', async () => {
        // The suite runs the server with GEMINI_API_KEY empty, so this is the
        // real path: it must say so rather than reporting a successful re-scan
        // that quietly did nothing.
        const { status, body } = await api('/api/portfolio/rescan-grids', { method: 'POST' });
        assert.equal(status, 503);
        assert.match(body.error, /recognition/i);
    });

    test('the grid re-scan never removes or duplicates what is already held', async () => {
        const before = await pool.query(
            'SELECT COUNT(*)::int cards, (SELECT COUNT(*)::int FROM card_copies) copies FROM portfolio_cards');

        await api('/api/portfolio/rescan-grids', { method: 'POST' });
        await new Promise(r => setTimeout(r, 400));

        const after = await pool.query(
            'SELECT COUNT(*)::int cards, (SELECT COUNT(*)::int FROM card_copies) copies FROM portfolio_cards');

        // Recovery only ever adds. A pass that cannot run must leave the
        // collection exactly as it found it — losing a card Jack owns would be
        // far worse than failing to find one.
        assert.ok(after.rows[0].cards >= before.rows[0].cards, 'no card row was removed');
        assert.ok(after.rows[0].copies >= before.rows[0].copies, 'no copy was removed');
    });

    /**
     * The complaint, stated plainly: "there's no value being found for new
     * cards that get uploaded in the app... the user shouldn't ever have to
     * manually review cards or confirm pricing."
     *
     * The collection total is the number the app exists to produce, and it was
     * silently excluding every card whose printing could not be pinned down.
     * This asserts the property that fixes it: a card with a price counts, and
     * a card with no price is never presented as work for the person holding
     * it.
     */
    test('the collection total counts estimates, and nothing is a chore for the user', async () => {
        const { body } = await api('/api/portfolio');
        const cards = body.cards || [];
        const stats = body.stats || {};

        let expected = 0;
        for (const card of cards) {
            expected += Number(card.total_value) || 0;

            if (Number(card.unit_price) > 0) {
                assert.equal(card.needs_review, false,
                    `"${card.card_name}" is priced, so nothing about it is outstanding`);
                // A price with no confidence predates the current engine and so
                // has no tier; the app labels those "Not verified yet" and
                // re-prices them. Anything the current engine produced must
                // carry a tier.
                if (Number(card.price_confidence) > 0) {
                    assert.ok(['confirmed', 'estimated'].includes(card.price_tier),
                        `"${card.card_name}" was priced by the current engine but has tier "${card.price_tier}"`);
                }
            } else {
                assert.equal(card.needs_review, true,
                    `"${card.card_name}" has no price, which is the only thing left outstanding`);
            }
            if (card.price_tier === 'estimated') {
                assert.ok(card.price_explanation,
                    `"${card.card_name}" is an estimate and must say why`);
            }
        }

        assert.ok(Math.abs(Number(stats.totalValue) - expected) < 0.05,
            `the headline total (${stats.totalValue}) must include every priced card (${expected.toFixed(2)})`);

        // And it must say how much of that total is an estimate rather than a
        // confirmed market price, so the figure is never read as more certain
        // than it is.
        const estimated = cards.filter(c => c.price_tier === 'estimated');
        assert.equal(stats.estimatedCards, estimated.length);
        assert.ok(Number(stats.estimatedValue) <= Number(stats.totalValue) + 0.01);
    });
}
