import pg from 'pg';
const { Pool } = pg;
const pool = new Pool({
  connectionString: 'postgresql://neondb_owner:npg_geTVUN3JICA8@ep-quiet-leaf-amfgh56b-pooler.c-5.us-east-1.aws.neon.tech/neondb?sslmode=require'
});

async function run() {
  console.log("Deleting hallucinated prices from scrapers...");
  const badSources = ['pricecharting', 'cardmavin', 'coolstuffinc', 'trollandtoad', 'tcgfish'];
  const res = await pool.query(`DELETE FROM price_history WHERE source = ANY($1) RETURNING id`, [badSources]);
  console.log(`Deleted ${res.rowCount} bad price history records.`);
  
  console.log("Fixing current_prices on portfolio_cards...");
  // Now we need to recalculate current_price for cards that were infected.
  const updateRes = await pool.query(`
    UPDATE portfolio_cards pc
    SET current_price = sub.price,
        price_source = sub.source,
        price_source_url = sub.source_url
    FROM (
        SELECT DISTINCT ON (card_id) card_id, price, source, source_url 
        FROM price_history 
        ORDER BY card_id, recorded_at DESC
    ) sub
    WHERE pc.id = sub.card_id AND pc.price_source = ANY($1)
  `, [badSources]);
  
  console.log(`Updated current_price for ${updateRes.rowCount} infected cards.`);
  process.exit(0);
}
run();
