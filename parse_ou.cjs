const fs = require('fs');
const cheerio = require('cheerio');
const html = fs.readFileSync('/tmp/offerup_full.html', 'utf8');
const $ = cheerio.load(html);
const nextData = $('script#__NEXT_DATA__').html();
if (nextData) {
    fs.writeFileSync('ou_json.json', nextData);
    console.log('Wrote JSON to ou_json.json');
} else {
    console.log('No NEXT_DATA match');
}
