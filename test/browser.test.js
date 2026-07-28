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
        await p.waitForSelector('.stat');
        assert.deepEqual(errors, []);
        await p.close();
    });
}
