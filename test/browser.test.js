/**
 * Browser-side tests. Skipped unless TEST_BASE_URL points at a running server
 * and Playwright is installed, so `npm test` works without either.
 *
 * These cover the capture geometry, which is the one piece of client logic
 * where being wrong is invisible: a mis-mapped crop still produces a photo,
 * just of the wrong part of the frame.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.TEST_BASE_URL;
let chromium = null;
try { ({ chromium } = await import('playwright')); } catch { /* not installed */ }

if (!BASE || !chromium) {
    test('browser tests (skipped: set TEST_BASE_URL and install playwright)', { skip: true }, () => {});
} else {
    let browser;
    let page;

    const mapGuide = (args) => page.evaluate((a) => window.__test.mapGuideToSource(a), args);

    test.before(async () => {
        browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
        page = await browser.newPage();
        await page.goto(BASE, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => window.__test);
    });

    test.after(async () => { await browser?.close(); });

    test('crop geometry: a landscape sensor shown in a portrait stage maps the guide correctly', async () => {
        // 1920x1080 sensor in a 400x800 stage. `cover` scales by height
        // (800/1080 = 0.7407) so the sensor is 1422 wide on screen and is
        // cropped horizontally — the naive mapping gets this wrong.
        const geo = await mapGuide({
            videoW: 1920, videoH: 1080,
            stage: { left: 0, top: 0, width: 400, height: 800 },
            frame: { left: 100, top: 200, width: 200, height: 280 },
            pad: 0,
        });
        const scale = 800 / 1080;
        assert.ok(Math.abs(geo.sw - 200 / scale) < 0.5, `width ${geo.sw}`);
        assert.ok(Math.abs(geo.sh - 280 / scale) < 0.5, `height ${geo.sh}`);
        // The guide starts 100px from the left of a stage showing a 1422px-wide
        // image centred on 1920 sensor pixels.
        const offsetX = (400 - 1920 * scale) / 2;
        assert.ok(Math.abs(geo.sx - (100 - offsetX) / scale) < 0.5, `x ${geo.sx}`);
    });

    test('crop geometry: a centred guide maps to a centred crop', async () => {
        const geo = await mapGuide({
            videoW: 1000, videoH: 1000,
            stage: { left: 0, top: 0, width: 500, height: 500 },
            frame: { left: 150, top: 150, width: 200, height: 200 },
            pad: 0,
        });
        assert.equal(geo.sx, 300);
        assert.equal(geo.sy, 300);
        assert.equal(geo.sw, 400);
        assert.equal(geo.sh, 400);
        // and its centre matches the sensor centre
        assert.equal(geo.sx + geo.sw / 2, 500);
    });

    test('crop geometry: padding widens the crop symmetrically', async () => {
        const base = { videoW: 1000, videoH: 1000, stage: { left: 0, top: 0, width: 500, height: 500 }, frame: { left: 150, top: 150, width: 200, height: 200 } };
        const tight = await mapGuide({ ...base, pad: 0 });
        const padded = await mapGuide({ ...base, pad: 0.1 });
        assert.ok(padded.sw > tight.sw);
        assert.equal(padded.sx + padded.sw / 2, tight.sx + tight.sw / 2, 'padding must not shift the centre');
    });

    test('crop geometry: never reads outside the sensor', async () => {
        const geo = await mapGuide({
            videoW: 640, videoH: 480,
            stage: { left: 0, top: 0, width: 640, height: 480 },
            frame: { left: -50, top: -50, width: 900, height: 900 },
            pad: 0.2,
        });
        assert.ok(geo.sx >= 0 && geo.sy >= 0);
        assert.ok(geo.sx + geo.sw <= 640.001, `right edge ${geo.sx + geo.sw}`);
        assert.ok(geo.sy + geo.sh <= 480.001, `bottom edge ${geo.sy + geo.sh}`);
    });

    test('crop geometry: output is upscaled for legibility but bounded', async () => {
        const small = await mapGuide({
            videoW: 1000, videoH: 1000,
            stage: { left: 0, top: 0, width: 1000, height: 1000 },
            frame: { left: 400, top: 400, width: 100, height: 140 },
            pad: 0,
        });
        assert.ok(small.outH > small.sh, 'a small crop is upscaled');
        assert.ok(Math.max(small.outW, small.outH) <= 1600, 'but never beyond 1600px');

        const large = await mapGuide({
            videoW: 4000, videoH: 4000,
            stage: { left: 0, top: 0, width: 1000, height: 1000 },
            frame: { left: 0, top: 0, width: 1000, height: 1000 },
            pad: 0,
        });
        assert.ok(Math.max(large.outW, large.outH) <= 1600, 'large crops are downscaled to the cap');
    });

    test('crop geometry: returns null before the camera reports a size', async () => {
        const geo = await mapGuide({
            videoW: 0, videoH: 0,
            stage: { left: 0, top: 0, width: 400, height: 800 },
            frame: { left: 0, top: 0, width: 100, height: 100 },
        });
        assert.equal(geo, null);
    });

    test('the collection renders without console errors', async () => {
        const errors = [];
        const p = await browser.newPage();
        p.on('pageerror', (e) => errors.push(e.message));
        p.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('ERR_')) errors.push(m.text()); });
        await p.goto(BASE, { waitUntil: 'networkidle' });
        await p.waitForSelector('.hero-value');
        assert.deepEqual(errors, []);
        await p.close();
    });

    /**
     * The tab bar previously appeared to change spacing as the selection moved,
     * because the active state altered each tab's footprint. These pin the fix:
     * five identical cells, and the selection is a separate element that slides
     * between them without touching their geometry.
     */
    test('tab bar: cells stay put whichever one is selected', async () => {
        const phone = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true });
        const p = await phone.newPage();
        await p.goto(BASE, { waitUntil: 'networkidle' });
        await p.waitForSelector('.tabbar');

        const measure = () => p.$$eval('.tabbar .tab', (tabs) =>
            tabs.map((t) => {
                const r = t.getBoundingClientRect();
                return { w: r.width, h: r.height, cx: r.left + r.width / 2, top: r.top };
            }));

        const before = await measure();
        assert.equal(before.length, 5, 'four destinations plus the scan action');

        // A fractional bar width cannot divide into five whole pixels, so the
        // invariant is that no cell differs from another by a visible amount.
        const spread = (values) => Math.max(...values) - Math.min(...values);
        assert.ok(spread(before.map((t) => t.w)) < 1.5, `all cells the same width, spread ${spread(before.map(t => t.w))}`);
        assert.ok(spread(before.map((t) => t.h)) < 0.5, `all cells the same height, spread ${spread(before.map(t => t.h))}`);

        // Evenly distributed: the gap between consecutive centres is constant.
        const gaps = before.slice(1).map((t, i) => t.cx - before[i].cx);
        assert.ok(spread(gaps) < 1.5, `cells evenly spaced, gaps ${gaps.map(g => g.toFixed(2))}`);

        await p.click('.tab[data-view="review"]');
        await p.waitForTimeout(500);
        assert.deepEqual(await measure(), before, 'selecting a tab must not move or resize any cell');
        await phone.close();
    });

    test('tab bar: nothing floats out of the bar, and Scan is not a destination', async () => {
        const phone = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true });
        const p = await phone.newPage();
        await p.goto(BASE, { waitUntil: 'networkidle' });
        await p.waitForSelector('.tabbar');

        const bar = await p.$eval('.tabbar', (n) => {
            const r = n.getBoundingClientRect();
            return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width };
        });

        // Every cell is contained by the bar. A raised circular button — the
        // thing that was explicitly not wanted — would break this.
        const cells = await p.$$eval('.tabbar .tab', (ns) => ns.map((n) => {
            const r = n.getBoundingClientRect();
            return { label: n.textContent.trim(), top: r.top, bottom: r.bottom, left: r.left, right: r.right, cx: r.left + r.width / 2 };
        }));
        for (const c of cells) {
            assert.ok(c.top >= bar.top - 0.5 && c.bottom <= bar.bottom + 0.5, `${c.label} escapes the bar vertically`);
            assert.ok(c.left >= bar.left - 0.5 && c.right <= bar.right + 0.5, `${c.label} escapes the bar horizontally`);
        }

        // The bar itself floats clear of the screen edges — the Liquid Glass
        // capsule, not an edge-to-edge slab.
        assert.ok(bar.left > 0 && bar.right < 393, 'the bar is inset from the screen edges');

        const scan = await p.$eval('.tab-scan', (n) => ({
            cx: n.getBoundingClientRect().left + n.getBoundingClientRect().width / 2,
            hasViewAttr: n.hasAttribute('data-view'),
            label: n.getAttribute('aria-label'),
        }));
        assert.ok(Math.abs(scan.cx - (bar.left + bar.width / 2)) < 2, 'Scan sits in the middle cell');
        assert.equal(scan.hasViewAttr, false, 'the action must not be wired as a navigation destination');
        assert.ok(scan.label, 'the action needs an accessible name');

        // Tapping it opens the scanner rather than switching view.
        await p.click('.tab-scan');
        await p.waitForTimeout(250);
        assert.ok(await p.$eval('#scanner', (n) => n.classList.contains('open')), 'Scan opens the scanner');
        assert.equal(await p.$eval('.tab-scan', (n) => n.classList.contains('active')), false,
            'an action never takes the selected state');
        await phone.close();
    });

    test('tab bar: the selection indicator lands on the selected cell', async () => {
        const phone = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true });
        const p = await phone.newPage();
        await p.goto(BASE, { waitUntil: 'networkidle' });
        await p.waitForSelector('.tab-pill');

        const centres = async () => ({
            pill: await p.$eval('.tab-pill', (n) => { const r = n.getBoundingClientRect(); return r.left + r.width / 2; }),
            tab: await p.$eval('.tab.active', (n) => { const r = n.getBoundingClientRect(); return r.left + r.width / 2; }),
        });

        let c = await centres();
        assert.ok(Math.abs(c.pill - c.tab) < 2, `indicator starts on the active tab (off by ${Math.abs(c.pill - c.tab)})`);

        await p.click('.tab[data-view="settings"]');
        await p.waitForTimeout(600);
        c = await centres();
        assert.ok(Math.abs(c.pill - c.tab) < 2, `indicator follows the selection (off by ${Math.abs(c.pill - c.tab)})`);
        await phone.close();
    });

    /**
     * A browser holding a cached script.js from one build while loading
     * index.html from another produced a half-updated app that died on
     * startup. Asset URLs carry the build id so a cache, which is keyed by
     * exact URL, can never satisfy the new HTML with the old file.
     */
    test('asset URLs are build-stamped so a cache cannot mix builds', async () => {
        const p = await browser.newPage();
        await p.goto(BASE, { waitUntil: 'domcontentloaded' });

        const build = await p.getAttribute('meta[name="app-build"]', 'content');
        assert.match(build || '', /^[a-f0-9]{8}$/, 'the page declares which build it is');

        const assets = await p.$$eval('link[rel="stylesheet"], script[src]',
            (ns) => ns.map((n) => n.getAttribute('href') || n.getAttribute('src')));
        const local = assets.filter((u) => u && !u.startsWith('http'));
        assert.ok(local.length >= 2, 'stylesheet and script are both linked');
        for (const url of local) {
            assert.ok(url.includes(`v=${build}`), `${url} must carry the build id`);
        }
        await p.close();
    });

    test('a stale cached copy of the old script is never served to new markup', async () => {
        const p = await browser.newPage();
        let staleServed = 0;

        // An HTTP cache can only answer the exact URL it stored — the plain
        // path, with no query. Requests carrying ?v= miss it entirely.
        await p.route((u) => {
            const url = new URL(u);
            return (url.pathname === '/script.js' || url.pathname === '/styles.css') && !url.search;
        }, (route) => {
            staleServed++;
            route.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.__STALE__ = true;' });
        });

        const errors = [];
        p.on('pageerror', (e) => errors.push(e.message));
        await p.goto(BASE, { waitUntil: 'networkidle' });
        await p.waitForSelector('.hero-value');

        assert.equal(staleServed, 0, 'nothing requested the unversioned path');
        assert.equal(await p.evaluate(() => window.__STALE__), undefined, 'the stale file never executed');
        assert.deepEqual(errors, []);
        await p.close();
    });

    test('a page from an older build reloads itself once', async () => {
        const p = await browser.newPage();
        let loads = 0;

        await p.route((u) => new URL(u).pathname === '/', async (route) => {
            loads++;
            const res = await route.fetch();
            let body = await res.text();
            // First load claims a build the server does not have.
            if (loads === 1) body = body.replace(/content="[a-f0-9]{8}"/, 'content="deadbeef"');
            route.fulfill({ status: 200, contentType: 'text/html; charset=UTF-8', body });
        });

        await p.goto(BASE, { waitUntil: 'networkidle' });
        await p.waitForTimeout(2200);

        assert.equal(loads, 2, 'the mismatch triggered exactly one reload');
        const build = await p.getAttribute('meta[name="app-build"]', 'content');
        assert.notEqual(build, 'deadbeef', 'the page is now on the served build');
        await p.close();
    });

    test('the sets view groups the collection and totals each set', async () => {
        const p = await browser.newPage();
        await p.goto(BASE, { waitUntil: 'networkidle' });
        await p.waitForSelector('.hero-value');
        await p.click('.nav-item[data-view="sets"]');
        await p.waitForSelector('.set');

        const sets = await p.$$eval('.set', (ns) => ns.map((n) => ({
            name: n.querySelector('.set-name').textContent,
            value: n.querySelector('.set-value').textContent,
        })));
        assert.ok(sets.length > 0, 'sets are listed');
        assert.ok(sets.every((s) => /^\$/.test(s.value)), 'every set shows a total');

        // Sorted by value, most valuable first.
        const numbers = sets.map((s) => Number(s.value.replace(/[^0-9.]/g, '')));
        assert.deepEqual(numbers, [...numbers].sort((a, b) => b - a));
        await p.close();
    });

    /**
     * Tapping a set used to apply a search and jump to the Collection view,
     * which threw you to the top of a different page with a filter you had not
     * asked for. A set is a container: it opens where it stands.
     */
    test('tapping a set expands it in place and stays on the sets view', async () => {
        const p = await browser.newPage();
        await p.goto(BASE, { waitUntil: 'networkidle' });
        await p.waitForSelector('.hero-value');
        await p.click('.nav-item[data-view="sets"]');
        await p.waitForSelector('.set');

        const before = await p.$eval('.set-group', (n) => {
            const r = n.getBoundingClientRect();
            return { top: Math.round(r.top), name: n.querySelector('.set-name').textContent };
        });
        assert.ok(await p.$eval('.set-group .set-cards', (n) => n.hidden), 'sets start closed');

        await p.click('.set');
        await p.waitForTimeout(350);

        assert.ok(await p.$eval('#view-sets', (n) => n.classList.contains('active')), 'still on the sets view');
        assert.equal(await p.$eval('#searchInput', (n) => n.value), '', 'no search was applied on your behalf');
        assert.ok(await p.$eval('.set-group .set-cards', (n) => !n.hidden), 'the set opened');
        assert.ok(await p.$eval('.set-group .set-cards .card, .set-group .set-cards .row', (n) => !!n),
            'the set shows its cards');

        const after = await p.$eval('.set-group', (n) => Math.round(n.getBoundingClientRect().top));
        assert.equal(after, before.top, 'the header you tapped did not move');
        assert.equal(await p.$eval('.set', (n) => n.getAttribute('aria-expanded')), 'true');

        // And it closes again.
        await p.click('.set');
        await p.waitForTimeout(250);
        assert.ok(await p.$eval('.set-group .set-cards', (n) => n.hidden), 'tapping again closes it');
        await p.close();
    });

    /**
     * Types is the second cut of the same collection. The arithmetic is the
     * subtle part: a dual-type card counts under both types, so the per-type
     * counts deliberately exceed the card count — and the view has to say so,
     * or it reads as a bug.
     */
    test('the types view groups the collection and explains its own arithmetic', async () => {
        const p = await browser.newPage();
        const errors = [];
        p.on('pageerror', (e) => errors.push(e.message));
        await p.goto(BASE, { waitUntil: 'networkidle' });
        await p.waitForSelector('.card');
        await p.click('.nav-item[data-view="sets"]');
        await p.click('[data-group="types"]');
        await p.waitForSelector('.type-chart');

        assert.deepEqual(errors, []);
        assert.equal(await p.textContent('#viewTitle'), 'Types', 'the heading follows the grouping');

        const types = await p.$$eval('.set-group', (ns) => ns.map((n) => ({
            name: n.querySelector('.set-name').textContent,
            value: n.querySelector('.set-value').textContent,
            meta: n.querySelector('.set-meta').textContent,
            chip: n.querySelector('.type-chip')?.textContent || '',
        })));
        assert.ok(types.length > 0, 'types are listed');
        assert.ok(types.every((t) => /^\$/.test(t.value)), 'every type shows a total');
        assert.ok(types.every((t) => /^[A-Z]{2}$/.test(t.chip)), 'every type has its colour chip');

        // Sorted by how many cards are held, most first.
        const held = types.map((t) => Number(t.meta.match(/(\d+) cards? held/)?.[1] || 0));
        assert.deepEqual(held, [...held].sort((a, b) => b - a));

        // The bar is the data, not decoration: one segment per type.
        const segments = await p.$$eval('.type-bar-seg', (ns) => ns.map((n) => Number(n.style.flexGrow)));
        assert.equal(segments.length, types.length);
        assert.deepEqual(segments, held, 'each segment is grown by that type\'s card count');

        const note = await p.textContent('.type-chart-note');
        const totalHeld = held.reduce((a, b) => a + b, 0);
        const cardCount = Number(note.match(/(\d+) cards?/)?.[1] || 0);
        if (totalHeld > cardCount) {
            assert.match(note, /dual-type/i,
                'when the counts exceed the card count, the view must say why');
        }
        await p.close();
    });

    test('a type expands in place, like a set', async () => {
        const p = await browser.newPage();
        await p.goto(BASE, { waitUntil: 'networkidle' });
        await p.waitForSelector('.card');
        await p.click('.nav-item[data-view="sets"]');
        await p.click('[data-group="types"]');
        await p.waitForSelector('.set-group');

        assert.ok(await p.$eval('.set-group .set-cards', (n) => n.hidden), 'types start closed');
        const before = await p.$eval('.set-group', (n) => Math.round(n.getBoundingClientRect().top));

        await p.click('.set-group .set');
        await p.waitForTimeout(350);

        assert.ok(await p.$eval('#view-sets', (n) => n.classList.contains('active')), 'still on the same view');
        assert.ok(await p.$eval('.set-group .set-cards', (n) => !n.hidden), 'the type opened');
        assert.ok(await p.$eval('.set-group .set-cards .card, .set-group .set-cards .row', (n) => !!n),
            'and shows its cards');
        assert.equal(await p.$eval('.set-group', (n) => Math.round(n.getBoundingClientRect().top)), before,
            'the header you tapped did not move');
        await p.close();
    });

    test('the grouping choice survives a reload', async () => {
        const p = await browser.newPage();
        await p.goto(BASE, { waitUntil: 'networkidle' });
        await p.waitForSelector('.card');
        await p.click('.nav-item[data-view="sets"]');
        await p.click('[data-group="types"]');
        await p.waitForSelector('.type-chart');

        await p.reload({ waitUntil: 'networkidle' });
        await p.click('.nav-item[data-view="sets"]');
        await p.waitForTimeout(300);
        assert.ok(await p.$('.type-chart'), 'it came back on Types, not Sets');
        await p.close();
    });

    /**
     * The scan panel must only ever report work the server said it did. This
     * feeds it synthetic progress events and checks each one becomes a line.
     */
    test('the analysis panel narrates the stages it is told about', async () => {
        const p = await browser.newPage();
        await p.goto(BASE, { waitUntil: 'networkidle' });
        await p.waitForFunction(() => window.__test && window.__test.analysis);

        const lines = await p.evaluate(() => {
            const t = window.__test.analysis;
            t.reset('probe', '');
            const send = (stage, extra = {}) => t.progress({ type: 'scan_progress', scanId: 'probe', stage, ...extra });
            send('start', { photos: 1 });
            send('identifying');
            send('identified', { card: { card_name: 'Charizard', card_set: 'Base', card_number: '4/102', confidence: 0.94 } });
            send('verifying');
            send('verified', { card: { card_name: 'Charizard', card_set: 'Base', card_number: '4', rarity: 'Rare Holo' } });
            send('pricing');
            send('price_source', { name: 'pokemontcg', label: 'Pokémon TCG API', state: 'answered', quotes: 3 });
            send('price_source', { name: 'justtcg', label: 'JustTCG', state: 'skipped', reason: 'no API key' });
            send('price_source', { name: 'tcgdex', label: 'TCGdex', state: 'failed', reason: 'Rate limited' });
            send('priced', { price: 412.5, quotesUsed: 3, quotesSeen: 4, confidence: 0.9 });
            return {
                steps: [...document.querySelectorAll('#analysisSteps .step')]
                    .map((n) => ({ state: n.className.replace('step ', ''), text: n.querySelector('.step-text').textContent })),
                name: document.getElementById('analysisName').textContent,
                price: document.getElementById('analysisPrice').textContent,
                shown: document.getElementById('analysis').classList.contains('show'),
            };
        });

        assert.ok(lines.shown, 'the panel is visible while a scan runs');
        assert.equal(lines.name, 'Charizard');
        assert.match(lines.price, /412/);

        const text = lines.steps.map((s) => s.text).join(' | ');
        assert.match(text, /Charizard/, 'reports what the AI read');
        assert.match(text, /Confirmed/, 'reports the database confirmation');
        assert.match(text, /Pokémon TCG API/, 'names each source it asked');
        assert.match(text, /JustTCG/);
        assert.match(text, /TCGdex/);

        // A failed source is marked as failed, not merely quiet — that
        // distinction is the whole point of listing them.
        const failed = lines.steps.find((s) => s.text.includes('TCGdex'));
        assert.equal(failed.state, 'fail');
        const skipped = lines.steps.find((s) => s.text.includes('JustTCG'));
        assert.equal(skipped.state, 'skip');

        // The price it settled on reads after the sources it came from, not
        // above them — a conclusion belongs below its evidence.
        const priceRow = lines.steps.findIndex((s) => s.text.includes('median of'));
        const lastSource = Math.max(...['Pokémon TCG API', 'JustTCG', 'TCGdex']
            .map((n) => lines.steps.findIndex((s) => s.text.includes(n))));
        assert.ok(priceRow > lastSource, 'the resolved price is listed after the sources');

        // Nothing is left spinning once the last stage has landed.
        assert.equal(lines.steps.filter((s) => s.state === 'live').length, 0);
        await p.close();
    });

    /**
     * A non-English card must be visibly a non-English card. Two tiles that
     * look identical while being worth different money in different markets is
     * the failure mode worth guarding against.
     */
    test('a non-English card is labelled with its language and English name', async () => {
        const p = await browser.newPage();
        await p.goto(BASE, { waitUntil: 'networkidle' });
        await p.waitForSelector('.card');

        const cards = await p.$$eval('.card', (ns) => ns.map((n) => {
            const badge = n.querySelector('.flag-lang');
            return {
                name: n.querySelector('.card-name')?.textContent || '',
                meta: n.querySelector('.card-meta')?.textContent || '',
                lang: badge ? { text: badge.textContent, title: badge.getAttribute('title') } : null,
            };
        }));

        const nonLatin = cards.filter((c) =>
            /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}|\p{Script=Cyrillic}/u.test(c.name));
        if (!nonLatin.length) return; // collection happens to be all-English

        for (const card of nonLatin) {
            assert.ok(card.lang, `"${card.name}" should carry a language badge`);
            // Compact on the tile, unambiguous on hover: "Chinese (Simplified)"
            // spelled out is wider than the card art it would sit on.
            assert.match(card.lang.text, /^[A-Z]{2}$/, `badge should be a two-letter code, got "${card.lang.text}"`);
            assert.ok(card.lang.title && card.lang.title.length > 2,
                `"${card.name}" badge should name the language in full, got "${card.lang.title}"`);
            assert.match(card.meta, /[A-Za-z]{3,}/,
                `"${card.name}" should show its English name so the grid is readable`);
        }
        await p.close();
    });

    test('the analysis panel narrates a non-English card in both names', async () => {
        const p = await browser.newPage();
        await p.goto(BASE, { waitUntil: 'networkidle' });
        await p.waitForFunction(() => window.__test && window.__test.analysis);

        const out = await p.evaluate(() => {
            const t = window.__test.analysis;
            t.reset('cjk', '');
            const s = (stage, extra = {}) => t.progress({ type: 'scan_progress', scanId: 'cjk', stage, ...extra });
            s('start', { photos: 1 });
            s('identifying');
            s('identified', {
                card: {
                    card_name: '古空棘鱼', card_name_en: 'Relicanth', card_number: '014/131',
                    set_code: 'csb6C', language: 'Chinese (Simplified)', is_non_english: true, confidence: 1,
                },
            });
            s('verifying_language', { language: 'Chinese (Simplified)', message: 'Looking this up as a Chinese (Simplified) printing' });
            s('verified', {
                card: { card_name: '古空棘鱼', card_name_en: 'Relicanth', card_set: 'Super Electric Breaker', card_number: '014/131', language: 'Chinese (Simplified)', is_non_english: true },
                via: 'tcgdex_zh-cn',
            });
            s('pricing');
            s('price_source', { name: 'pokemontcg', label: 'Pokémon TCG API', state: 'skipped', reason: 'English-only catalogue — cannot price a Chinese (Simplified) printing' });
            s('price_source', { name: 'tcgdex', label: 'TCGdex', state: 'empty' });
            s('unpriced', { message: 'No marketplace quotes a price for this printing.' });
            return {
                steps: [...document.querySelectorAll('#analysisSteps .step')]
                    .map((n) => ({ state: n.className.replace('step ', ''), text: n.querySelector('.step-text').textContent, note: n.querySelector('.step-note').textContent })),
                name: document.getElementById('analysisName').textContent,
                meta: document.getElementById('analysisMeta').textContent,
                price: document.getElementById('analysisPrice').textContent,
            };
        });

        const text = out.steps.map((s) => s.text).join(' | ');
        assert.match(text, /古空棘鱼/, 'reports the name as printed');
        assert.match(text, /Relicanth/, 'and the English name that makes it findable');
        assert.match(text, /Chinese \(Simplified\)/, 'and says which language it read');
        assert.equal(out.name, '古空棘鱼', 'the card is titled as printed, not translated');
        assert.match(out.meta, /Chinese \(Simplified\)/);

        // The crucial one: an English-only source is shown as deliberately
        // skipped, and no price is asserted for a printing nothing quoted.
        const skipped = out.steps.find((s) => s.text.includes('Pokémon TCG API'));
        assert.match(skipped.state, /\bskip\b/, `expected a skipped step, got "${skipped.state}"`);
        assert.match(skipped.note, /English-only/, 'and it says why it was skipped');
        // A reason that long gets its own line rather than crushing the label
        // into one character per row.
        assert.match(skipped.state, /stacked/, 'a sentence-length note stacks under the label');
        assert.equal(out.price, '', 'a card with no quote shows no price');
        await p.close();
    });

    test('the analysis panel ignores progress from a different scan', async () => {
        const p = await browser.newPage();
        await p.goto(BASE, { waitUntil: 'networkidle' });
        await p.waitForFunction(() => window.__test && window.__test.analysis);

        const count = await p.evaluate(() => {
            const t = window.__test.analysis;
            t.reset('mine', '');
            t.progress({ type: 'scan_progress', scanId: 'theirs', stage: 'identified', card: { card_name: 'Mewtwo' } });
            return {
                steps: document.querySelectorAll('#analysisSteps .step').length,
                name: document.getElementById('analysisName').textContent,
            };
        });
        assert.equal(count.steps, 0, 'another phone\'s scan must not write into this panel');
        assert.ok(!count.name.includes('Mewtwo'));
        await p.close();
    });
}
