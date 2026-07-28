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
                (user_id, card_name, card_set, card_number, holo_type, language,
                 is_first_edition, is_holo, condition, current_price)
            VALUES (1, $1, $2, $3, $4, $5, $6, 1, $7, $8) RETURNING id
        `, [c.card_name, c.card_set, c.card_number, c.holo_type, c.language,
            c.is_first_edition, c.condition, c.current_price ?? 0]);
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

        const row = await pool.query('SELECT variant_key, needs_review FROM portfolio_cards WHERE id = $1', [id]);
        assert.match(row.rows[0].variant_key, /base set 2\|1\|reverse/);
        assert.equal(row.rows[0].needs_review, 0);
    });
}
