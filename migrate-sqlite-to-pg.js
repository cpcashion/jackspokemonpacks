import 'dotenv/config';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import Database from 'better-sqlite3';
import pkg from 'pg';
const { Pool } = pkg;
import bcrypt from 'bcrypt';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_URL = process.env.DATABASE_URL || 'postgres://localhost:5432/pokesniper';

console.log('🔄 Starting Migration from SQLite to PostgreSQL...');
console.log('🔗 Target DB:', DB_URL.split('@').pop());

const sqlite = new Database(join(__dirname, 'data', 'pokesniper.db'));
const pg = new Pool({
    connectionString: DB_URL,
    ssl: DB_URL.includes('localhost') ? false : { rejectUnauthorized: false }
});

async function migrate() {
    try {
        console.log('\\n[1/4] Ensuring PostgreSQL schema exists...');
        await pg.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS portfolio_cards (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                card_name TEXT NOT NULL,
                card_set TEXT DEFAULT '',
                card_number TEXT DEFAULT '',
                rarity TEXT DEFAULT 'Unknown',
                condition TEXT DEFAULT 'Unknown',
                is_holo INTEGER DEFAULT 0,
                is_first_edition INTEGER DEFAULT 0,
                confidence REAL DEFAULT 0,
                image_data TEXT DEFAULT '',
                image_url TEXT DEFAULT '',
                notes TEXT DEFAULT '',
                year INTEGER DEFAULT 0,
                language TEXT DEFAULT 'English',
                holo_type TEXT DEFAULT 'Unknown',
                added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS price_history (
                id SERIAL PRIMARY KEY,
                card_id INTEGER REFERENCES portfolio_cards(id) ON DELETE CASCADE,
                price REAL NOT NULL,
                source TEXT DEFAULT 'market',
                recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        console.log('\\n[2/4] Setting up Admin User (jack)...');
        let userResult = await pg.query('SELECT id FROM users WHERE username = $1', ['jack']);
        let userId;

        if (userResult.rows.length === 0) {
            const hash = await bcrypt.hash('password', 10);
            const insertUser = await pg.query(
                'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id',
                ['jack', hash]
            );
            userId = insertUser.rows[0].id;
            console.log('✅ Created user "jack".');
        } else {
            userId = userResult.rows[0].id;
            console.log('✅ User "jack" already exists.');
        }

        console.log('\\n[3/4] Migrating Portfolio Cards...');
        const oldCards = sqlite.prepare('SELECT * FROM portfolio_cards').all();
        console.log(`Found ${oldCards.length} cards in SQLite...`);

        // Map old SQLite ID -> new Postgres ID
        const idMap = new Map();

        let cardCount = 0;
        for (const c of oldCards) {
            const insertCard = await pg.query(`
                INSERT INTO portfolio_cards (
                    user_id, card_name, card_set, card_number, rarity, condition,
                    is_holo, is_first_edition, confidence, image_data, image_url,
                    notes, year, language, holo_type, added_at
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
                RETURNING id;
            `, [
                userId, c.card_name, c.card_set, c.card_number, c.rarity, c.condition,
                c.is_holo, c.is_first_edition, c.confidence, c.image_data, c.image_url,
                c.notes, c.year, c.language, c.holo_type, c.added_at
            ]);
            
            idMap.set(c.id, insertCard.rows[0].id);
            cardCount++;
            if (cardCount % 100 === 0) console.log(`  ... migrated ${cardCount} cards`);
        }
        console.log(`✅ Migrated ${cardCount} cards!`);

        console.log('\\n[4/4] Migrating Price History...');
        const oldPrices = sqlite.prepare('SELECT * FROM price_history').all();
        console.log(`Found ${oldPrices.length} historical price rows in SQLite...`);

        let priceCount = 0;
        for (const p of oldPrices) {
            const newCardId = idMap.get(p.card_id);
            if (!newCardId) continue; // safety check

            await pg.query(`
                INSERT INTO price_history (card_id, price, source, recorded_at)
                VALUES ($1, $2, $3, $4)
            `, [newCardId, p.price, p.source, p.recorded_at]);
            
            priceCount++;
            if (priceCount % 500 === 0) console.log(`  ... migrated ${priceCount} prices`);
        }
        console.log(`✅ Migrated ${priceCount} pricing rows!`);

        console.log('\\n🎉 MIGRATION COMPLETE! YOUR DATA IS SAFE IN POSTGRESQL.');

    } catch (err) {
        console.error('❌ MIGRATION FAILED:', err);
    } finally {
        sqlite.close();
        await pg.end();
        process.exit(0);
    }
}

migrate();
