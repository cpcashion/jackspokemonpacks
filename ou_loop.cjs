const axios = require('axios');
async function test() {
    for (const term of ['pokemon card psa', 'pokemon card collection', 'pokemon card rare']) {
        try {
            const url = 'https://offerup.com/search/?q=' + encodeURIComponent(term) + '&sort=-posted';
            const resp = await axios.get(url, { headers: {'User-Agent': 'Mozilla/5.0'}, timeout: 15000 });
            console.log(term, '=>', resp.status, resp.data.length, 'bytes');
        } catch(e) {
            console.error(term, '=> ERROR', e.message);
        }
        await new Promise(r => setTimeout(r, 15000));
    }
}
test();
