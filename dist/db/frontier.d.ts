export type UrlRecord = {
    url: string;
    depth: number;
    parentUrl: string | null;
};
export type QueuedUrl = {
    id: bigint;
    url: string;
    domain: string;
    depth: number;
    parentUrl: string | null;
};
export type FrontierStats = {
    pending: number;
    inProgress: number;
    done: number;
    failed: number;
    maxDepth: number;
    http2xx: number;
    http3xx: number;
    http4xx: number;
    http5xx: number;
    httpErrors: number;
};
export type DomainInfo = {
    domain: string;
    robotsTxt: string | null;
    crawlDelayMs: number;
    isAllowed: boolean;
    fetchedAt: Date;
};
/**
 * Bulk-insert URLs into the frontier.
 * Respects maxDepth and maxPages limits.
 * Returns the count of rows actually inserted.
 */
export declare function enqueueUrls(urls: UrlRecord[], maxDepth: number, maxPages: number): Promise<number>;
/**
 * Domain-aware dequeue.
 * Only picks a URL from a domain with no in_progress rows, preventing
 * concurrent workers from hammering the same domain.
 * Returns null if no eligible URL exists.
 */
export declare function dequeueUrl(): Promise<QueuedUrl | null>;
/**
 * Mark a URL as successfully fetched.
 */
export declare function markDone(id: bigint, httpStatus: number, contentHash: string): Promise<void>;
/**
 * Mark a URL as failed with an error message.
 */
export declare function markFailed(id: bigint, error: string): Promise<void>;
/**
 * Advance next_fetch_at for all pending URLs on a domain
 * to enforce per-domain crawl delay.
 */
export declare function updateNextFetch(domain: string, nextFetchAt: Date): Promise<void>;
/**
 * Reset stalled in_progress rows (older than timeoutMinutes) back to pending.
 * Protects against dead workers that never called markDone/markFailed.
 * Returns count of requeued rows.
 */
export declare function requeueStalled(timeoutMinutes: number): Promise<number>;
/**
 * Return aggregate counts and HTTP status breakdown.
 * Used for termination polling and the final summary report.
 */
export declare function getFrontierStats(): Promise<FrontierStats>;
/**
 * Upsert domain info (robots.txt cache).
 */
export declare function saveDomainInfo(info: DomainInfo): Promise<void>;
/**
 * Load cached domain info. Returns null if domain is not in the table.
 */
export declare function getDomainInfo(domain: string): Promise<DomainInfo | null>;
//# sourceMappingURL=frontier.d.ts.map