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
     * tabs are evenly distributed and identically sized in every state.
     */
    test('tab bar: tabs stay evenly spaced whichever one is selected', async () => {
        const phone = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true });
        const p = await phone.newPage();
        await p.goto(BASE, { waitUntil: 'networkidle' });
        await p.waitForSelector('.tabbar');

        const measure = () => p.$$eval('.tabbar .tab', (tabs) =>
            tabs.map((t) => { const r = t.getBoundingClientRect(); return { w: Math.round(r.width), cx: Math.round(r.left + r.width / 2) }; }));

        const before = await measure();
        assert.equal(before.length, 4, 'four destinations');

        const widths = new Set(before.map((t) => t.w));
        assert.equal(widths.size, 1, `all tabs equal width, got ${[...widths]}`);

        await p.click('.tab[data-view="review"]');
        await p.waitForTimeout(300);
        const after = await measure();

        assert.deepEqual(after, before, 'selecting a tab must not move or resize any tab');
        await phone.close();
    });

    test('tab bar: the scan action is centred and is not a destination', async () => {
        const phone = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true });
        const p = await phone.newPage();
        await p.goto(BASE, { waitUntil: 'networkidle' });
        await p.waitForSelector('.tabbar');

        const lens = await p.$eval('.lens', (n) => {
            const r = n.getBoundingClientRect();
            return { cx: r.left + r.width / 2, hasViewAttr: n.hasAttribute('data-view'), label: n.getAttribute('aria-label') };
        });
        const barWidth = await p.$eval('.tabbar', (n) => n.getBoundingClientRect().width);

        assert.ok(Math.abs(lens.cx - barWidth / 2) < 2, `lens should be centred, off by ${Math.abs(lens.cx - barWidth / 2)}px`);
        assert.equal(lens.hasViewAttr, false, 'the action must not be wired as a navigation destination');
        assert.ok(lens.label, 'the icon-only action needs an accessible name');

        // Two destinations either side of it.
        const order = await p.$$eval('.tabbar > *', (ns) => ns.map((n) => (n.classList.contains('lens') ? 'lens' : 'tab')));
        assert.deepEqual(order, ['tab', 'tab', 'lens', 'tab', 'tab']);
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
}
