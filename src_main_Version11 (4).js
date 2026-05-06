// Playwright-based Twitch Streamer Engagement Stats sampler (no credentials)
// Samples viewer count and chat message rate (messages per minute) and stores time-series to Dataset.
// Limitations: public scraping only. For robust real-time analysis use Twitch Helix API + IRC (recommended).

import { Actor } from 'apify';
import { PlaywrightCrawler, Dataset, RequestList } from 'crawlee';

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    startUrls = ['https://www.twitch.tv/ninja'],
    samplingIntervalSeconds = 10,
    durationSeconds = 300,
    maxRequestsPerCrawl = 50,
    chatSelectors = [
        'div.chat-line__message',
        "div[data-a-target='chat-line-message']",
        "[data-a-target='chat-message-text']"
    ],
    viewerSelectors = [
        "p[data-a-target='animated-channel-viewers-count']",
        "div[data-a-target='stream-view-count']",
        "span[data-a-target='stream-count']"
    ],
    useProxy = true,
    dedupe = true,
} = input;

// Proxy configuration
const proxyConfiguration = useProxy ? await Actor.createProxyConfiguration() : undefined;

// Prepare RequestList
const requestList = await RequestList.open('start-urls', startUrls);

// Key-Value store for optional dedupe/summary
const kvStore = await Actor.openKeyValueStore();
let seenSummaryKeys = (await kvStore.getValue('seenSummaryKeys')) || [];
const seenSet = new Set(seenSummaryKeys);

// Helper to parse numbers from strings like "1,234 viewers"
function extractNumberFromText(text) {
    if (!text) return null;
    const m = text.replace(/\u00A0/g, ' ').match(/([\d.,\s]+)/);
    if (!m) return null;
    const digits = m[1].replace(/[,\s]/g, '').replace(/\./g, '');
    const n = parseInt(digits, 10);
    return Number.isFinite(n) ? n : null;
}

// Try multiple selectors and fallbacks to determine viewer count
async function getViewerCount(page) {
    for (const sel of viewerSelectors) {
        try {
            const v = await page.$eval(sel, el => el.textContent && el.textContent.trim()).catch(() => null);
            if (v) {
                const n = extractNumberFromText(v);
                if (n !== null) return n;
            }
        } catch (e) {
            // continue to next selector
        }
    }

    // Fallback: search for elements containing "viewers" or "watching"
    const candidate = await page.evaluate(() => {
        const nodes = Array.from(document.querySelectorAll('p,span,div'));
        for (const n of nodes) {
            const t = n.innerText || '';
            if (/viewers|watching|view/gi.test(t) && /[\d,.\s]+/.test(t)) return t.trim();
        }
        return null;
    });
    if (candidate) {
        const n = extractNumberFromText(candidate);
        if (n !== null) return n;
    }
    return null;
}

// Count visible chat message elements using selectors
async function getChatMessageCount(page) {
    let total = 0;
    for (const sel of chatSelectors) {
        try {
            const count = await page.$$eval(sel, els => els.length).catch(() => 0);
            if (count && count > total) total = count;
        } catch (e) {
            // ignore
        }
    }
    // If no selector matched, attempt broad heuristic
    if (total === 0) {
        const heuristic = await page.$$eval('div', els => els.filter(e => e.innerText && e.innerText.length < 400 && e.innerText.split('\\n').length < 5).length).catch(() => 0);
        if (heuristic > total) total = heuristic;
    }
    return total;
}

// Run a sampling session per channel (request)
async function runSamplingSession(page, request, log) {
    const channelUrl = request.url;
    const channelMatch = channelUrl.match(/twitch\.tv\/([\w-]+)/i);
    const channel = channelMatch ? channelMatch[1] : channelUrl;

    log.info('Starting sampling session', { channel, url: channelUrl });

    // Go to channel page (allow navigation)
    await page.goto(channelUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
    // Wait a bit to let dynamic elements load
    await page.waitForTimeout(3000);

    // initial chat count baseline
    let prevChatCount = await getChatMessageCount(page);
    const start = Date.now();
    const endTime = durationSeconds > 0 ? start + durationSeconds * 1000 : Number.MAX_SAFE_INTEGER;

    while (Date.now() < endTime) {
        // sample viewer count and chat messages
        const sampledAt = new Date().toISOString();
        const viewerCount = await getViewerCount(page);
        const chatCount = await getChatMessageCount(page);
        const messagesDelta = (typeof chatCount === 'number' && typeof prevChatCount === 'number') ? Math.max(0, chatCount - prevChatCount) : null;
        prevChatCount = chatCount !== null ? chatCount : prevChatCount;

        // compute chat rate per minute from delta and interval
        const interval = samplingIntervalSeconds;
        const chatRatePerMinute = messagesDelta !== null ? (messagesDelta * (60 / Math.max(1, interval))) : null;

        // compute viewer-to-chat ratio (viewers per chat message per minute)
        const viewerToChatRatio = (viewerCount && chatRatePerMinute) ? (viewerCount / chatRatePerMinute) : null;

        const sample = {
            channel,
            url: channelUrl,
            sampledAt,
            viewerCount,
            chatCount,
            messagesDelta,
            samplingIntervalSeconds: interval,
            chatRatePerMinute,
            viewerToChatRatio,
        };

        // Build a summary key for dedupe if needed
        const summaryKey = `summary:${channel}:${sampledAt}`;

        // Persist sample to dataset
        await Dataset.pushData(sample);

        // Optionally persist a short summary to KV (dedupe)
        if (dedupe) {
            try {
                await kvStore.setValue(summaryKey, sample);
                seenSet.add(summaryKey);
            } catch (e) {
                log.warning('Failed to persist sample summary to KV', { error: e.message });
            }
        }

        log.info('Sampled', { channel, viewerCount, messagesDelta, chatRatePerMinute, viewerToChatRatio });

        // Wait for next interval, but also slightly scroll the page to keep dynamic loading active
        await page.evaluate(() => window.scrollBy(0, Math.random() * 200 - 100)).catch(() => null);
        await page.waitForTimeout(interval * 1000);
    }

    log.info('Finished sampling session', { channel });
}

const crawler = new PlaywrightCrawler({
    requestList,
    proxyConfiguration,
    maxRequestsPerCrawl,
    launchContext: {
        launchOptions: { headless: true }
    },
    async requestHandler({ page, request, log }) {
        await runSamplingSession(page, request, log);
    },
    failedRequestHandler: async ({ request, log }) => {
        log.error('Request failed', { url: request.url });
    }
});

await crawler.run();

// Persist seen keys (best-effort)
if (seenSet.size) {
    await kvStore.setValue('seenSummaryKeys', Array.from(seenSet)).catch(() => null);
}

await Actor.exit();