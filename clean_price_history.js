import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.development.local' });

const { Pool } = pg;
const pool = new Pool({
    connectionString: process.env.DATABASE_URL || process.env.POSTGRES_URL,
    ssl: { rejectUnauthorized: false }
});

async function run() {
    console.log("Cleaning price history anomalies...");
    // 1. Get all cards that have price history
    const res = await pool.query('SELECT DISTINCT card_id FROM price_history');
    let deletedCount = 0;

    for (const row of res.rows) {
        const cardId = row.card_id;
        // 2. Get all prices for this card sorted by time
        const historyRes = await pool.query('SELECT id, price, recorded_at FROM price_history WHERE card_id = $1 ORDER BY recorded_at ASC', [cardId]);
        if (historyRes.rows.length === 0) continue;

        let lastPrice = null;
        let lastTime = null;

        for (const item of historyRes.rows) {
            const currentPrice = Number(item.price);
            const currentTime = new Date(item.recorded_at).getTime();

            if (lastPrice !== null && lastTime !== null) {
                // If price is exactly the same and it hasn't been 24 hours, delete the newer one
                const ageHours = (currentTime - lastTime) / (1000 * 60 * 60);
                if (currentPrice === lastPrice && ageHours < 24) {
                    await pool.query('DELETE FROM price_history WHERE id = $1', [item.id]);
                    deletedCount++;
                    continue; // Skip updating lastTime so we keep checking against the original point
                }
            }
            lastPrice = currentPrice;
            lastTime = currentTime;
        }
    }

    console.log(`Successfully deleted ${deletedCount} redundant price points from the history table.`);
    process.exit(0);
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
