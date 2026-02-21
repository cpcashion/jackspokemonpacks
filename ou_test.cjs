const axios = require('axios');
const cheerio = require('cheerio');

async function test() {
    const url = 'https://offerup.com/search/?q=' + encodeURIComponent('pokemon card collection') + '&sort=-posted';
    const resp = await axios.get(url, { headers: {'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'}, timeout: 15000 });
    const $ = cheerio.load(resp.data);
    const nextData = $('script#__NEXT_DATA__').text();
    let count = 0;
    if (nextData) {
        const parsed = JSON.parse(nextData);
        function findListings(obj) {
            if (!obj || typeof obj !== 'object') return;
            if (obj.__typename === 'ModularFeedListing' && obj.listingId) count++;
            for (const key in obj) findListings(obj[key]);
        }
        findListings(parsed);
    }
    console.log('Found listings for pokemon card collection:', count);
}
test().catch(console.error);
