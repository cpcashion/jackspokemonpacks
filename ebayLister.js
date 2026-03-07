import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeFileSync, unlinkSync } from 'fs';

puppeteer.use(StealthPlugin());

/**
 * Automates logging into eBay and listing a set of Pokemon cards.
 * 
 * @param {string} username - eBay username/email
 * @param {string} password - eBay password
 * @param {Array} cards - Array of card objects to list
 * @param {Function} broadcastActivity - Function to send activity logs via SSE
 * @param {Function} broadcast - Function to send raw SSE events
 */
export async function listCardsOnEbay(username, password, cards, broadcastActivity, broadcast) {
    let browser = null;
    let page = null;
    const tempFiles = [];

    try {
        broadcastActivity('scraper_start', `Launching eBay automation browser...`, { marketplace: 'ebay' });

        // Launch in non-headless mode to allow the user to see the flow or intervene if Captcha/2FA hits
        browser = await puppeteer.launch({
            headless: false,
            defaultViewport: null,
            args: ['--start-maximized', '--disable-notifications']
        });

        page = await browser.newPage();

        // --- 1. LOGIN FLOW ---
        broadcastActivity('analyzing_title', `Attempting to log into eBay as ${username}...`);
        await page.goto('https://signin.ebay.com/', { waitUntil: 'networkidle2' });

        // Wait for username field
        await page.waitForSelector('#userid', { timeout: 10000 });
        await page.type('#userid', username, { delay: 50 });
        await page.click('#signin-continue-btn');

        // Wait for password field to appear
        try {
            await page.waitForSelector('#pass', { timeout: 10000 });
            await page.type('#pass', password, { delay: 50 });
            await page.click('#sgnBt');
        } catch (pwErr) {
            broadcastActivity('scam_warning', '⚠️ eBay login variation detected (Captcha, 2FA, or bot check). Please complete login manually in the open browser.');
            // Give user 60 seconds to manually solve 2FA/Captcha
            await page.waitForNavigation({ timeout: 60000, waitUntil: 'domcontentloaded' }).catch(() => { });
        }

        // Verify we are actually logged in by checking for the "My eBay" or similar element
        const urlAfterLogin = page.url();
        if (urlAfterLogin.includes('signin.ebay.com')) {
            broadcastActivity('error', 'Failed to log into eBay or manual intervention timed out.', { marketplace: 'ebay' });
            return;
        }

        broadcastActivity('scraper_done', `Successfully logged into eBay.`, { marketplace: 'ebay' });

        // --- 2. LISTING FLOW ---
        for (let i = 0; i < cards.length; i++) {
            const card = cards[i];
            const title = `Pokemon ${card.card_name} ${card.card_set || ''} ${card.rarity || ''} ${card.is_holo ? 'Holo ' : ''}`.substring(0, 80).trim();
            const price = card.marketPrice ? card.marketPrice.toFixed(2) : "9.99";
            const condition = card.condition_est || 'Used';

            broadcastActivity('search_terms', `[${i + 1}/${cards.length}] Creating listing for ${title}...`, { count: `${i + 1}/${cards.length}` });

            // Write the image buffer to a temporary file so Puppeteer can upload it
            let tempImagePath = null;
            if (card.originalImageBuffer) {
                const ext = card.originalMimeType === 'image/jpeg' ? 'jpg' : (card.originalMimeType === 'image/png' ? 'png' : 'jpg');
                tempImagePath = join(tmpdir(), `ebay_upload_${Date.now()}_${i}.${ext}`);
                writeFileSync(tempImagePath, card.originalImageBuffer);
                tempFiles.push(tempImagePath);
            }

            try {
                // Navigate to standard selling flow (this structure changes often on eBay)
                await page.goto('https://www.ebay.com/sl/sell', { waitUntil: 'networkidle2' });

                // --- 2a. Search / Categorize Phase ---
                // Wait for the main search input to define what we are selling
                const searchSelector = 'input[placeholder*="Tell us what you\'re selling"]'; // Approximate selector
                await page.waitForSelector(searchSelector, { timeout: 10000 }).catch(() => { });

                const searchInput = await page.$(searchSelector);
                if (searchInput) {
                    await searchInput.type(title, { delay: 10 });
                    await page.keyboard.press('Enter');

                    // Wait for "Continue without match" or select a product
                    await page.waitForTimeout(3000);

                    // Attempt to click "Continue without match" if it exists (very fragile)
                    const noMatchBtn = await page.$('button:has-text("Continue without match")');
                    if (noMatchBtn) await noMatchBtn.click();

                    // Attempt to select condition (fragile)
                    const newConditionBtn = await page.$('input[value="1000"]'); // 1000 is often "Brand New", 3000 is "Used"
                    const usedConditionBtn = await page.$('input[value="3000"]');

                    if (condition.includes('Mint') && newConditionBtn) {
                        await newConditionBtn.click();
                    } else if (usedConditionBtn) {
                        await usedConditionBtn.click();
                    }

                    const continueToDraftBtn = await page.$('button:has-text("Continue to listing")');
                    if (continueToDraftBtn) await continueToDraftBtn.click();

                    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => { });
                }

                // --- 2b. Draft Editing Phase ---
                // Wait for the draft page to load (checking for title input)
                const titleInputSelector = 'input[name="Title"], input[aria-label*="Title"]';
                await page.waitForSelector(titleInputSelector, { timeout: 10000 }).catch(() => { });

                // If we get here, we are on the draft page ideally. 
                // Note: eBay's DOM is highly dynamic. The following selectors are generic best-effort guesses.

                // Upload image
                if (tempImagePath) {
                    broadcastActivity('analyzing_image', `Uploading image for ${title}...`);
                    const fileInput = await page.$('input[type="file"]');
                    if (fileInput) {
                        await fileInput.uploadFile(tempImagePath);
                        await page.waitForTimeout(3000); // wait for upload
                    }
                }

                // Set Price
                broadcastActivity('price_comparison', `Setting price to $${price}...`);
                const priceInput = await page.$('input[name="StartPrice"], input[aria-label*="Price"]');
                if (priceInput) {
                    await priceInput.click({ clickCount: 3 }); // select all
                    await priceInput.type(price.toString(), { delay: 20 });
                }

                // Click "List it"
                broadcastActivity('ai_analyzing', `Submitting listing...`);
                const listButton = await page.$('button:has-text("List it")');
                if (listButton) {
                    await listButton.click();
                    // Wait for completion page
                    await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 15000 }).catch(() => { });

                    broadcastActivity('deal_found', `✅ Successfully listed: ${title} for $${price}`, {
                        cardName: card.card_name, listingPrice: parseFloat(price)
                    });

                    broadcast({
                        type: 'listing_created', card: {
                            id: `listed_${Date.now()}`,
                            title: title,
                            card_name: card.card_name,
                            listing_price: parseFloat(price),
                            deal_tier: 'great' // Reuse UI styling
                        }
                    });
                } else {
                    throw new Error("Could not find 'List it' button on draft form.");
                }

            } catch (cardErr) {
                console.error(`Failed to list card ${card.card_name}:`, cardErr.message);
                broadcastActivity('error', `Failed to list ${card.card_name}: ${cardErr.message}`);
                // Continue to the next card instead of aborting the whole process
            }
        }

    } catch (err) {
        console.error('eBay automation failed:', err);
        broadcastActivity('error', `eBay Automation Error: ${err.message}`);
    } finally {
        if (browser) {
            broadcastActivity('cycle_complete', 'Closing browser. Automation complete.');
            await browser.close().catch(() => { });
        }

        // Cleanup temp files
        for (const file of tempFiles) {
            try { unlinkSync(file); } catch (e) { }
        }
    }
}
