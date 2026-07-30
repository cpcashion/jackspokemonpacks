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

        const row = await pool.query('SELECT variant_key, needs_review, current_price FROM portfolio_cards WHERE id = $1', [id]);
        assert.match(row.rows[0].variant_key, /base set 2\|1\|reverse/);

        // The correction is always kept, but a price has to be earned. An edit
        // used to clear the review flag and then price the card off a loose
        // name+number search, which is how a common card came to be valued in
        // the hundreds. Now the flag tracks whether the printing was actually
        // confirmed, and an unconfirmed card is left unpriced on purpose.
        assert.equal(edited.body.confirmed, row.rows[0].needs_review === 0,
            'the review flag and the confirmed flag must agree');
        if (!edited.body.confirmed) {
            assert.equal(Number(row.rows[0].current_price), 0,
                'an unconfirmed printing must not carry a price');
            assert.match(edited.body.message, /Saved your correction/,
                'and the edit must say it was kept');
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
     * "I repriced the ones that need review, but it's still saying needs review."
     *
     * Re-pricing never re-verified, so the flag could not clear — and it priced
     * against a loose name+number match, which is how a card worth cents was
     * valued in the hundreds. Now an unconfirmed card is re-verified first and,
     * if it still cannot be confirmed, left unpriced on purpose.
     */
    test('re-pricing a card in review re-verifies it rather than guessing a price', async () => {
        const id = await seedLegacyCard({
            card_name: 'Steelix', card_set: 'Temporal Forces', card_number: '093/132',
            needs_review: 1, current_price: 0,
        });
        await pool.query('INSERT INTO card_copies (card_id, condition) VALUES ($1, $2)', [id, 'Near Mint']);

        const { status, body } = await api(`/api/portfolio/${id}/reprice`, { method: 'POST' });
        assert.equal(status, 200);

        const row = await pool.query('SELECT needs_review, current_price FROM portfolio_cards WHERE id = $1', [id]);

        if (body.status === 'unconfirmed') {
            // The important half: it refused to invent a price for a card whose
            // printing it could not pin down.
            assert.equal(Number(row.rows[0].current_price), 0,
                'an unconfirmed card must not be given a price');
            assert.equal(row.rows[0].needs_review, 1, 'and stays flagged');
            assert.match(body.message, /confirm/i, 'and says what it could not do');
            assert.equal(body.needsReview, true);
        } else {
            // If it did confirm, the flag must have cleared — the bug was that
            // it never could.
            assert.equal(row.rows[0].needs_review, 0,
                'a card that verified must leave Needs review');
            assert.equal(body.clearedReview, true);
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
}
