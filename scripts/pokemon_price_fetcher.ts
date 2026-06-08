import axios from 'axios';

/**
 * Lightweight Pokemon TCG Price Fetcher
 * This script pulls card data and prices from the free Pokemon TCG API (pokemontcg.io).
 * It is intended as a cost-effective replacement for custom scraping/AI extraction.
 */

interface CardPrice {
  market: number | null;
  low: number | null;
  mid: number | null;
  high: number | null;
}

interface PokemonCard {
  id: string;
  name: string;
  set: {
    name: string;
    series: string;
  };
  tcgplayer?: {
    url: string;
    updatedAt: string;
    prices?: {
      holofoil?: CardPrice;
      reverseHolofoil?: CardPrice;
      normal?: CardPrice;
    };
  };
}

async function fetchCardPrice(cardName: string) {
  const API_URL = 'https://api.pokemontcg.io/v2/cards';
  
  try {
    console.log(\`Searching for card: \${cardName}...\`);
    const response = await axios.get(API_URL, {
      params: {
        q: \`name:"\${cardName}"\`,
        pageSize: 5
      }
    });

    const cards: PokemonCard[] = response.data.data;

    if (cards.length === 0) {
      console.log('No cards found matching that name.');
      return;
    }

    cards.forEach((card) => {
      console.log(\`\\n--- \${card.name} (\${card.set.name}) ---\`);
      console.log(\`ID: \${card.id}\`);
      
      if (card.tcgplayer && card.tcgplayer.prices) {
        const prices = card.tcgplayer.prices;
        if (prices.holofoil) {
          console.log(\`Holofoil Market Price: $\${prices.holofoil.market ?? 'N/A'}\`);
        }
        if (prices.normal) {
          console.log(\`Normal Market Price: $\${prices.normal.market ?? 'N/A'}\`);
        }
        console.log(\`TCGPlayer Link: \${card.tcgplayer.url}\`);
      } else {
        console.log('No pricing data available via TCGPlayer for this card.');
      }
    });

  } catch (error) {
    if (axios.isAxiosError(error)) {
      console.error('Error fetching data from Pokemon TCG API:', error.message);
    } else {
      console.error('An unexpected error occurred:', error);
    }
  }
}

// Example usage: fetch price for "Maushold ex"
// You can call this with any card name.
const query = process.argv[2] || 'Maushold ex';
fetchCardPrice(query);
