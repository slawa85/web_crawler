import { type DomainInfo } from '../db/frontier.js';
/**
 * Ensure domain_info is populated and fresh.
 * Fetches robots.txt if missing or older than 24 hours.
 * On fetch failure: fails open (allowed=true, default delay).
 */
export declare function ensureDomainInfo(domain: string): Promise<DomainInfo>;
/**
 * Check whether a specific URL is allowed by the domain's robots.txt.
 */
export declare function isUrlAllowed(url: string, domainInfo: DomainInfo): boolean;
/**
 * Calculate next_fetch_at for a domain to enforce crawl delay.
 * Returns now() + crawlDelayMs.
 */
export declare function getNextFetchAt(_domain: string, crawlDelayMs: number): Date;
//# sourceMappingURL=politeness.d.ts.map