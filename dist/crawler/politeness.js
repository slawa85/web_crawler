import robotsParserImport from 'robots-parser';
const robotsParser = robotsParserImport;
import { fetch } from 'undici';
import { getDomainInfo, saveDomainInfo } from '../db/frontier.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
const USER_AGENT = 'IPFabricCrawler/1.0 (+https://ipfabric.io)';
const ROBOTS_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const ROBOTS_FETCH_TIMEOUT_MS = 10_000;
// In-memory cache of parsed robots.txt objects, keyed by domain.
// Avoids re-parsing the same robots.txt text on every URL check.
const parsedRobotsCache = new Map();
/**
 * Ensure domain_info is populated and fresh.
 * Fetches robots.txt if missing or older than 24 hours.
 * On fetch failure: fails open (allowed=true, default delay).
 */
export async function ensureDomainInfo(domain) {
    const cached = await getDomainInfo(domain);
    if (cached !== null) {
        const ageMs = Date.now() - cached.fetchedAt.getTime();
        if (ageMs < ROBOTS_CACHE_TTL_MS) {
            return cached;
        }
    }
    // Fetch fresh robots.txt
    const robotsUrl = `https://${domain}/robots.txt`;
    let robotsTxt = null;
    let crawlDelayMs = config.crawlDelayMs;
    let isAllowed = true;
    try {
        const response = await fetch(robotsUrl, {
            headers: { 'User-Agent': USER_AGENT },
            signal: AbortSignal.timeout(ROBOTS_FETCH_TIMEOUT_MS),
        });
        if (response.ok) {
            robotsTxt = await response.text();
        }
        else {
            // Non-200: treat as no robots.txt — fail open
            logger.debug({ domain, status: response.status }, 'robots.txt returned non-200, assuming allowed');
            await response.body?.cancel();
        }
    }
    catch (err) {
        logger.warn({ domain, err }, 'robots.txt fetch failed — assuming allowed, default delay');
        // Fall through: isAllowed=true, crawlDelayMs=config.crawlDelayMs
    }
    if (robotsTxt !== null) {
        try {
            const robots = robotsParser(robotsUrl, robotsTxt);
            // Extract crawl delay for our user agent (or wildcard)
            const delay = robots.getCrawlDelay(USER_AGENT);
            if (delay !== undefined && delay !== null) {
                // robots.txt Crawl-delay is in seconds
                crawlDelayMs = Math.max(delay * 1000, config.crawlDelayMs);
            }
            isAllowed = true; // We check per-URL allowance in isUrlAllowed()
        }
        catch (err) {
            logger.warn({ domain, err }, 'robots.txt parse error — assuming allowed');
        }
    }
    const info = {
        domain,
        robotsTxt,
        crawlDelayMs,
        isAllowed,
        fetchedAt: new Date(),
    };
    await saveDomainInfo(info);
    // Evict stale parsed entry so isUrlAllowed re-parses the fresh robots.txt
    parsedRobotsCache.delete(domain);
    return info;
}
/**
 * Check whether a specific URL is allowed by the domain's robots.txt.
 */
export function isUrlAllowed(url, domainInfo) {
    if (!domainInfo.isAllowed)
        return false;
    if (domainInfo.robotsTxt === null)
        return true;
    const robotsUrl = `https://${domainInfo.domain}/robots.txt`;
    try {
        let robots = parsedRobotsCache.get(domainInfo.domain);
        if (robots === undefined) {
            robots = robotsParser(robotsUrl, domainInfo.robotsTxt);
            parsedRobotsCache.set(domainInfo.domain, robots);
        }
        return robots.isAllowed(url, USER_AGENT) ?? true;
    }
    catch (err) {
        logger.warn({ url, err }, 'robots.txt check error — assuming allowed');
        return true;
    }
}
/**
 * Calculate next_fetch_at for a domain to enforce crawl delay.
 * Returns now() + crawlDelayMs.
 */
export function getNextFetchAt(_domain, crawlDelayMs) {
    return new Date(Date.now() + crawlDelayMs);
}
//# sourceMappingURL=politeness.js.map