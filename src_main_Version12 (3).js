// Playwright-based Patreon Tier Value Scraper (Playwright + credentials placeholder)
// Note: Patreon frequently changes UI and login flows. Test & adapt selectors before running at scale.
// Legal: Respect Patreon Terms of Service and creator content usage rights. Store credentials as secrets (env) when running on Cloud.

import { Actor } from 'apify';
import { PlaywrightCrawler, Dataset, RequestList } from 'crawlee';
import fetch from 'node-fetch';
import path from 'path';

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    startUrls = ['https://www.patreon.com/creator-name'],
    authMethod = 'credentials', // you requested credentials (3)
    username = '',
    password = '',
    downloadImages = true,
    maxRequestsPerCrawl = 100,
    scrollIterations = 4,
} = input;

// Proxy configuration (recommended for scale)
const proxyConfiguration = await Actor.createProxyConfiguration();

// RequestList
const requestList = await RequestList.open('start-urls', startUrls);

// Key-Value store for images and other artifacts
const kvStore = await Actor.openKeyValueStore();

function normalizeCreatorSlug(url) {
    try {
        const u = new URL(url);
        return u.pathname.replace(/^\/|\/$/g, '');
    } catch {
        return url.replace(/https?:\/\//, '').replace(/[\/#?].*$/, '');
    }
}

async function tryLogin(page, log) {
    // This is a placeholder login flow. Patreon may use a modal / OAuth redirects / reCAPTCHA.
    // Inspect Patreon login flow and adapt selectors for your account.
    log.info('Attempting credentials-based login (placeholder).');
    try {
        await page.goto('https://www.patreon.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
        // Wait for typical login inputs - adjust selectors if Patreon updated them
        await page.waitForTimeout(1000);
        const emailSel = 'input[type="email"], input#email';
        const passSel = 'input[type="password"], input#password';
        if (username && password) {
            if (await page.$(emailSel)) {
                await page.fill(emailSel, username);
            }
            if (await page.$(passSel)) {
                await page.fill(passSel, password);
            }
            // Try submit - look for button
            const btn = await page.$('button[type="submit"], button:has-text("Log in"), button:has-text("Sign in")');
            if (btn) {
                await btn.click();
                // Wait for navigation or user element
                await page.waitForTimeout(3000);
                // Check for logged-in marker
                // (this is heuristic — adjust to Patreon UI)
                const loggedIn = await page.$('nav [aria-label="User menu"], button:has-text("Creator")').catch(() => null);
                if (loggedIn) {
                    log.info('Login seems successful (heuristic).');
                    return true;
                } else {
                    log.warning('Login did not detect user menu — you may need to adapt the login flow or use cookie auth.');
                    return false;
                }
            } else {
                log.warning('Login button not found — adapt selectors.');
                return false;
            }
        } else {
            log.warning('Username or password not provided.');
            return false;
        }
    } catch (e) {
        log.warning('Login attempt failed', { error: e.message });
        return false;
    }
}

async function extractTiersFromCreatorPage(page, creatorUrl, log) {
    // Heuristic extraction: look for sections that contain price currency symbols and benefit lists
    // Patreon DOM varies across creators; refine selectors per target creators.
    const creatorSlug = normalizeCreatorSlug(creatorUrl);
    // Scroll a bit to load content
    for (let i = 0; i < scrollIterations; i++) {
        await page.evaluate(() => window.scrollBy(0, window.innerHeight));
        await page.waitForTimeout(600 + Math.random() * 800);
    }

    // Try to select visible tier cards
    const tiers = await page.$$eval('[data-testid*="tier"], [data-type="tier"], .creator__tiers .tier, .tier', (nodes) => {
        function textOf(el, selector) {
            const s = selector ? el.querySelector(selector) : null;
            return s ? (s.textContent || '').trim() : null;
        }
        return nodes.map((node, idx) => {
            // Name candidates
            const name =
                textOf(node, '.tier__title') ||
                textOf(node, '.tier-title') ||
                textOf(node, 'h3') ||
                textOf(node, '[data-test="tier-name"]') ||
                null;

            // Price candidates - look for $ or other currency signs
            let price = null;
            const priceEl = node.querySelector('.tier__price, .tier-price, .price, [data-test="tier-price"]');
            if (priceEl) price = priceEl.textContent.trim();

            // Benefits: list items
            const benefitEls = Array.from(node.querySelectorAll('li, .benefit, .perk, [data-test="benefit"]'));
            const benefits = benefitEls.map(b => (b.textContent || '').trim()).filter(Boolean);
            // Images in tier card
            const imgEls = Array.from(node.querySelectorAll('img')).map(i => i.src).filter(Boolean);
            return { name, price, benefits, imageUrls: imgEls, nodeIndex: idx };
        }).filter(t => t.name || (t.benefits && t.benefits.length));
    }).catch(() => []);

    // Fallback: try to parse sections containing currency symbols
    if ((!tiers || tiers.length === 0)) {
        const fallback = await page.$$eval('section, div', (nodes) => {
            const results = [];
            nodes.forEach((n, idx) => {
                const text = n.innerText || '';
                if (/[£$€]\s*\d+/.test(text) && text.length < 4000) {
                    const nameMatch = (n.querySelector('h3, h2, h4') || {}).textContent;
                    const benefits = Array.from(n.querySelectorAll('li')).map(l => l.textContent.trim());
                    const images = Array.from(n.querySelectorAll('img')).map(i => i.src);
                    results.push({ name: nameMatch ? nameMatch.trim() : null, price: (text.match(/[£$€]\s*\d+[,.]?\d*/) || [null])[0], benefits, imageUrls: images, nodeIndex: idx });
                }
            });
            return results;
        }).catch(() => []);
        if (fallback && fallback.length) {
            return fallback;
        }
    }

    return tiers || [];
}

async function downloadAndSaveImage(kvStore, keyPrefix, url) {
    try {
        const res = await fetch(url, { timeout: 20000 });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const ab = await res.arrayBuffer();
        const buffer = Buffer.from(ab);
        // Derive extension
        const extMatch = (new URL(url).pathname.match(/\.([a-z0-9]{3,4})(?:[?#]|$)/i) || [])[1] || 'jpg';
        const key = `${keyPrefix}.${extMatch}`;
        await kvStore.setValue(key, buffer);
        return key;
    } catch (e) {
        // Return null on failure
        return null;
    }
}

const crawler = new PlaywrightCrawler({
    requestList,
    proxyConfiguration,
    maxRequestsPerCrawl,
    launchContext: {
        launchOptions: { headless: true },
    },
    async preNavigationHooks({ page, request, log }) {
        // If credentials-based auth requested, attempt login once on first navigation (to patreon.com)
        if (authMethod === 'credentials' && username && password && request.url.includes('patreon.com')) {
            // Try login; it's safe to call even if on creator page, attempt login first
            await tryLogin(page, log);
        }
    },
    async requestHandler({ page, request, log }) {
        const creatorUrl = request.url;
        log.info('Visiting creator page', { url: creatorUrl });

        await page.goto(creatorUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
        // Wait briefly for dynamic content
        await page.waitForTimeout(1500);

        const creatorSlug = normalizeCreatorSlug(creatorUrl);

        // Extract tiers (heuristic)
        const tiers = await extractTiersFromCreatorPage(page, creatorUrl, log);
        log.info('Found tiers count (heuristic)', { count: tiers.length, url: creatorUrl });

        for (let i = 0; i < tiers.length; i++) {
            const t = tiers[i];
            const tierId = `${creatorSlug}-tier-${t.nodeIndex || i}-${Date.now()}`;
            const imageKvKeys = [];

            if (downloadImages && t.imageUrls && t.imageUrls.length) {
                for (let j = 0; j < t.imageUrls.length; j++) {
                    const imgUrl = t.imageUrls[j];
                    if (!imgUrl) continue;
                    const safePrefix = `images/${creatorSlug}/${tierId}-${j}`;
                    const kvKey = await downloadAndSaveImage(kvStore, safePrefix, imgUrl);
                    if (kvKey) imageKvKeys.push(kvKey);
                }
            }

            const item = {
                creatorUrl,
                creatorSlug,
                tierId,
                tierName: t.name || null,
                price: t.price || null,
                benefits: t.benefits || [],
                imageUrls: t.imageUrls || [],
                imageKvKeys,
                crawledAt: new Date().toISOString(),
            };

            await Dataset.pushData(item);
            log.info('Pushed tier item', { creatorSlug, tierId, tierName: t.name, price: t.price });
        }
    },
    failedRequestHandler: async ({ request, log }) => {
        log.error('Request failed', { url: request.url });
    }
});

await crawler.run();
await Actor.exit();